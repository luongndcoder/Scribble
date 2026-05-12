"""Split long audio into STT-sized chunks using ffmpeg silencedetect.

Why ffmpeg, not Silero VAD: the project ships with ffmpeg, and silencedetect
gives accurate silence boundaries for sentence-aligned cuts. Adding a Silero
ONNX model just for VAD would inflate the installer with no quality win.

Output chunks satisfy:
  - duration ≤ 28s (Nvidia Riva offline_recognize cap)
  - duration ≥ ~8s (avoid wasteful short STT calls)
  - 1.5s overlap with previous chunk (de-duped at merge time)
  - cuts prefer silence boundaries to keep words intact
"""
from __future__ import annotations

import logging
import re
import subprocess
import sys
import wave
from dataclasses import dataclass
from pathlib import Path

from services.audio import find_ffmpeg

log = logging.getLogger(__name__)

# Tunables — measured against Nvidia Riva offline cap of 30s and typical
# speech rate; overlap chosen empirically to recover most boundary-cut words.
CHUNK_TARGET_MS = 22_000
CHUNK_MAX_MS = 28_000
CHUNK_MIN_MS = 8_000
OVERLAP_MS = 1_500
# ffmpeg silencedetect thresholds — -30dB / 300ms is conservative (catches real
# pauses, not breath noise). Tuned for room-quality recordings.
SILENCE_NOISE_DB = -30
SILENCE_MIN_DURATION_S = 0.3
SAMPLE_RATE = 16_000


@dataclass(frozen=True)
class AudioChunk:
    idx: int
    start_ms: int
    end_ms: int
    path: Path

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


_SILENCE_END_RE = re.compile(r"silence_end:\s*([0-9.]+)")
_SILENCE_START_RE = re.compile(r"silence_start:\s*([0-9.]+)")


def detect_silence_boundaries(wav_path: Path, total_ms: int) -> list[int]:
    """Run ffmpeg silencedetect and return midpoints (ms) of silence regions.

    Always includes total_ms as the last boundary so the splitter can cut
    the tail without needing a trailing silence.
    """
    ffmpeg = find_ffmpeg()
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-nostats",
        "-i",
        str(wav_path),
        "-af",
        f"silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_DURATION_S}",
        "-f",
        "null",
        "-",
    ]
    kwargs: dict = {"capture_output": True, "timeout": 300}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    try:
        result = subprocess.run(cmd, **kwargs)
    except subprocess.TimeoutExpired:
        log.warning("[vad] silencedetect timed out, using time-based splits only")
        return [total_ms]

    stderr = result.stderr.decode("utf-8", errors="replace")

    # Pair up silence_start / silence_end into (start, end) ms regions; take midpoint.
    starts_s: list[float] = []
    ends_s: list[float] = []
    for line in stderr.splitlines():
        m = _SILENCE_START_RE.search(line)
        if m:
            starts_s.append(float(m.group(1)))
            continue
        m = _SILENCE_END_RE.search(line)
        if m:
            ends_s.append(float(m.group(1)))

    boundaries: list[int] = []
    for i, end in enumerate(ends_s):
        start = starts_s[i] if i < len(starts_s) else end
        midpoint_ms = int(((start + end) / 2.0) * 1000)
        if 0 < midpoint_ms < total_ms:
            boundaries.append(midpoint_ms)
    boundaries.append(total_ms)
    boundaries.sort()
    return boundaries


def _find_best_cut(
    boundaries: list[int], min_ms: int, target_ms: int, max_ms: int
) -> int:
    """Pick silence boundary closest to target_ms within [min_ms, max_ms].

    Falls back to max_ms (hard cut) when no boundary qualifies — happens for
    continuous speech with no detectable pauses.
    """
    candidates = [b for b in boundaries if min_ms <= b <= max_ms]
    if not candidates:
        return max_ms
    return min(candidates, key=lambda b: abs(b - target_ms))


def _wav_total_ms(wav_path: Path) -> int:
    with wave.open(str(wav_path), "rb") as w:
        n_frames = w.getnframes()
        rate = w.getframerate()
        return int(n_frames * 1000 / rate)


def _extract_chunk_with_ffmpeg(
    src: Path, dst: Path, start_ms: int, duration_ms: int
) -> None:
    """Copy a slice [start, start+duration] from src WAV to dst WAV.

    Uses ffmpeg (not direct WAV slicing) so we always produce a properly
    framed 16kHz mono PCM WAV regardless of any quirks in the source.
    """
    ffmpeg = find_ffmpeg()
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{start_ms / 1000.0:.3f}",
        "-t",
        f"{duration_ms / 1000.0:.3f}",
        "-i",
        str(src),
        "-ar",
        str(SAMPLE_RATE),
        "-ac",
        "1",
        "-acodec",
        "pcm_s16le",
        "-f",
        "wav",
        str(dst),
    ]
    kwargs: dict = {"capture_output": True, "timeout": 60}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    result = subprocess.run(cmd, **kwargs)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg extract failed (rc={result.returncode}): "
            f"{result.stderr.decode(errors='replace')[:300]}"
        )


def split_into_chunks(wav_path: Path, out_dir: Path) -> list[AudioChunk]:
    """Split a normalized WAV into AudioChunks with overlap.

    Args:
        wav_path: 16kHz mono PCM WAV (output of pipeline.normalize_audio).
        out_dir: directory to write chunk_NNNN.wav files into.

    Returns: list of AudioChunk in temporal order.
    """
    out_dir.mkdir(parents=True, exist_ok=True)

    total_ms = _wav_total_ms(wav_path)
    if total_ms < CHUNK_MIN_MS:
        # File too short to chunk — single chunk covering the whole thing.
        if total_ms <= 0:
            return []
        chunk_path = out_dir / "chunk_0000.wav"
        _extract_chunk_with_ffmpeg(wav_path, chunk_path, 0, total_ms)
        return [AudioChunk(idx=0, start_ms=0, end_ms=total_ms, path=chunk_path)]

    boundaries = detect_silence_boundaries(wav_path, total_ms)

    chunks: list[AudioChunk] = []
    cursor_ms = 0
    chunk_idx = 0

    while cursor_ms < total_ms:
        remaining = total_ms - cursor_ms
        # Final chunk: just take everything remaining if it fits.
        if remaining <= CHUNK_MAX_MS:
            end_ms = total_ms
        else:
            target = cursor_ms + CHUNK_TARGET_MS
            max_end = cursor_ms + CHUNK_MAX_MS
            min_end = cursor_ms + CHUNK_MIN_MS
            end_ms = _find_best_cut(boundaries, min_end, target, max_end)

        duration = end_ms - cursor_ms
        if duration <= 0:
            break

        chunk_path = out_dir / f"chunk_{chunk_idx:04d}.wav"
        _extract_chunk_with_ffmpeg(wav_path, chunk_path, cursor_ms, duration)
        chunks.append(
            AudioChunk(
                idx=chunk_idx,
                start_ms=cursor_ms,
                end_ms=end_ms,
                path=chunk_path,
            )
        )

        # Step cursor forward leaving an overlap behind us (so the NEXT chunk
        # picks up OVERLAP_MS earlier — used by transcript merge dedupe).
        if end_ms >= total_ms:
            break
        cursor_ms = max(cursor_ms + 1, end_ms - OVERLAP_MS)
        chunk_idx += 1

    log.info(
        "[vad] split %dms into %d chunks (avg %dms, overlap %dms)",
        total_ms,
        len(chunks),
        (total_ms // max(1, len(chunks))),
        OVERLAP_MS,
    )
    return chunks
