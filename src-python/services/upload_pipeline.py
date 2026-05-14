"""End-to-end pipeline for an uploaded audio file.

Lifecycle owned by job_registry; runs as a single asyncio task:

  normalize (ffmpeg → 16kHz mono WAV)
    → split (silencedetect + chunk_NNNN.wav)
    → for each chunk in parallel (semaphore-bounded):
        STT (Nvidia Riva offline_recognize) + embedding extraction
        emit `chunk` SSE event with text
    → global speaker clustering (scipy)
    → assemble realtime-format transcript JSON, persist
    → auto-summarize (drain summarize_stream into markdown)
    → mark job done

Cancellation: cancel_event is polled at every coarse boundary plus per-chunk;
in-flight Riva calls finish naturally (gRPC can't be interrupted cleanly).
Cleanup of the tmp working dir is unconditional in `finally`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from uuid import uuid4

from db import Database
from services.audio import find_ffmpeg
from services.batch_diarizer import cluster_speakers, extract_embedding
from services.job_registry import JobState, JobStatus, registry
from services.vad_splitter import AudioChunk, split_into_chunks
from stt import (
    HALLUCINATION_PATTERNS,
    get_language_code,
    transcribe_nvidia_streaming,
    transcribe_soniox_file,
)

log = logging.getLogger(__name__)

db = Database()

# Riva offline_recognize quota: 3 concurrent is comfortable for free-tier keys.
# Exposed via setting `upload_stt_concurrency` for power users.
DEFAULT_STT_CONCURRENCY = 3
DEFAULT_MAX_DURATION_HOURS = 4

# Progress band split: upload completes at 0.0 (Phase 1 took it past upload);
# this pipeline goes 0.05 → 1.0.
P_NORMALIZE = 0.10
P_SPLIT = 0.18
P_TRANSCRIBE_START = 0.20
P_TRANSCRIBE_END = 0.85
P_FINALIZE = 0.88
P_CLUSTER_DONE = 0.92
P_SUMMARIZE = 0.95


def _filter_hallucinations(text: str) -> str:
    """Drop common STT artifacts (intro stings, "Thanks for watching", etc.).

    Mirrors api.transcription.filter_hallucinations to avoid importing the
    FastAPI router module (which would pull in app state we don't need here).
    """
    if not text:
        return ""
    for pattern in HALLUCINATION_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return ""
    if len(text.strip()) <= 3:
        return ""
    return text


def _stt_concurrency() -> int:
    raw = db.get_setting("upload_stt_concurrency") or ""
    try:
        n = int(raw)
        return max(1, min(n, 8))
    except ValueError:
        return DEFAULT_STT_CONCURRENCY


def _max_duration_seconds() -> float:
    raw = db.get_setting("upload_max_duration_hours") or ""
    try:
        h = float(raw)
        return max(0.5, h) * 3600
    except ValueError:
        return DEFAULT_MAX_DURATION_HOURS * 3600


def _is_cancelled(job: JobState) -> bool:
    return job.cancel_event.is_set()


async def run_pipeline(job_id: str) -> None:
    """Public entry: kick off the full pipeline for an existing job + meeting."""
    job = registry.get(job_id)
    if not job:
        log.error("[pipeline] unknown job %s", job_id)
        return

    meeting = db.get_meeting(job.meeting_id)
    if not meeting:
        await registry.update(
            job_id, status=JobStatus.FAILED, error="Meeting record missing"
        )
        return

    source_path = Path(meeting.get("audio_path") or "")
    if not source_path.is_file():
        await registry.update(
            job_id, status=JobStatus.FAILED, error="Uploaded audio file missing on disk"
        )
        return

    tmp_root = Path(tempfile.mkdtemp(prefix=f"scribble-pipeline-{job_id[:8]}-"))
    try:
        await _execute(job, meeting, source_path, tmp_root)
    except asyncio.CancelledError:
        await registry.update(
            job_id, status=JobStatus.CANCELLED, error="Cancelled"
        )
        db.update_meeting(job.meeting_id, status="cancelled")
        raise
    except Exception as exc:
        log.exception("[pipeline] failed job=%s", job_id)
        await registry.update(job_id, status=JobStatus.FAILED, error=str(exc))
        db.update_meeting(job.meeting_id, status="failed")
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


async def _execute(
    job: JobState, meeting: dict, source_path: Path, tmp_root: Path
) -> None:
    job_id = job.job_id
    meeting_id = job.meeting_id

    # ── Probe duration ─────────────────────────────────────────────────────
    await registry.update(
        job_id,
        status=JobStatus.NORMALIZING,
        progress=0.05,
        message="Đang phân tích audio",
    )
    duration_sec = await asyncio.to_thread(_ffprobe_duration, source_path)
    max_sec = _max_duration_seconds()
    if duration_sec <= 0:
        raise ValueError("Không xác định được thời lượng audio")
    if duration_sec > max_sec:
        raise ValueError(
            f"File quá dài ({duration_sec / 3600:.1f}h, "
            f"giới hạn {max_sec / 3600:.1f}h)"
        )
    db.update_meeting(meeting_id, audio_duration=duration_sec)
    if _is_cancelled(job):
        return

    # ── Normalize → WAV 16kHz mono ─────────────────────────────────────────
    wav_path = tmp_root / "normalized.wav"
    await registry.update(
        job_id, progress=P_NORMALIZE, message="Chuẩn hoá audio"
    )
    await asyncio.to_thread(_normalize_to_wav, source_path, wav_path)
    if _is_cancelled(job):
        return

    # ── VAD-aware splitting (or restore plan from DB if resuming) ─────────
    await registry.update(
        job_id, progress=P_SPLIT, message="Phát hiện đoạn nói"
    )
    chunks_dir = tmp_root / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)

    saved_chunks = {c["chunk_idx"]: c for c in db.get_upload_chunks(meeting_id)}
    if saved_chunks:
        # Resume mode: reuse the previously computed plan so chunk boundaries
        # stay consistent with already-saved transcripts.
        log.info(
            "[pipeline] resuming meeting %s: %d chunks already in DB",
            meeting_id, len(saved_chunks),
        )
        chunks = _chunks_from_db_plan(saved_chunks, wav_path, chunks_dir)
    else:
        chunks = await asyncio.to_thread(split_into_chunks, wav_path, chunks_dir)
        if not chunks:
            raise ValueError("Không phát hiện được giọng nói trong file")
        # Persist the plan so a future resume can use the same boundaries.
        db.upsert_chunk_plan(
            meeting_id,
            [(c.idx, c.start_ms, c.end_ms) for c in chunks],
        )

    await registry.update(job_id, total_chunks=len(chunks))
    if _is_cancelled(job):
        return

    # Re-extract WAV files for chunks that don't have STT text saved yet
    # (saved chunks have their text/embedding in DB — no need to redo).
    pending_chunks = [
        c for c in chunks
        if not (saved_chunks.get(c.idx) and saved_chunks[c.idx].get("text"))
    ]
    if saved_chunks:
        # Materialize the pending chunks' WAV files on disk (extract from
        # normalized.wav using the stored boundaries).
        await asyncio.to_thread(_extract_pending_chunk_files, wav_path, pending_chunks)

    # ── Parallel STT + embedding (only for chunks that need it) ───────────
    await registry.update(
        job_id,
        status=JobStatus.TRANSCRIBING,
        progress=P_TRANSCRIBE_START,
        message=(
            f"Phiên âm {len(saved_chunks)}/{len(chunks)} (resume)"
            if saved_chunks
            else f"Phiên âm ({len(chunks)} chunks)"
        ),
    )
    new_results = await _process_chunks_parallel(
        job, pending_chunks, meeting_id=meeting_id, total_chunks=len(chunks),
        already_done=sum(1 for sc in saved_chunks.values() if sc.get("text")),
    )
    if _is_cancelled(job):
        return

    # Merge saved + newly processed results into chunk_results
    chunk_results = _merge_saved_and_new_results(saved_chunks, new_results, chunks)

    # ── Global speaker clustering ──────────────────────────────────────────
    await registry.update(
        job_id,
        status=JobStatus.FINALIZING,
        progress=P_FINALIZE,
        message="Phân loại người nói",
    )
    embeddings = [
        (r["idx"], r["embedding"]) for r in chunk_results if r["embedding"] is not None
    ]
    speaker_map = await asyncio.to_thread(cluster_speakers, embeddings)
    if _is_cancelled(job):
        return

    # ── Build transcript + persist (final pass) ────────────────────────────
    transcript_parts = _build_transcript_parts(chunk_results, speaker_map)
    transcript_json = json.dumps(transcript_parts, ensure_ascii=False)
    db.update_meeting(meeting_id, transcript=transcript_json, status="saved")
    if _is_cancelled(job):
        return

    # Bridge message between "transcribing done" and "summary running" — without
    # this jump the modal sits at 90% "Phân loại người nói" for the whole length
    # of the LLM call and the user can't tell what's happening next.
    await registry.update(
        job_id,
        progress=P_CLUSTER_DONE,
        message="Hoàn tất phiên âm — chuẩn bị biên bản",
    )

    # ── Auto-summarize (best-effort) ───────────────────────────────────────
    await registry.update(
        job_id,
        progress=P_SUMMARIZE,
        message="Đang tạo biên bản (có thể mất vài phút)",
    )
    summary_md = await asyncio.to_thread(
        _summarize_blocking, transcript_parts, meeting.get("language") or "vi", meeting_id,
    )
    if summary_md:
        db.update_meeting(meeting_id, summary=summary_md)

    await registry.update(
        job_id,
        status=JobStatus.DONE,
        progress=1.0,
        message="Hoàn thành",
    )


# ─── Sub-stages ────────────────────────────────────────────────────────────


def _ffprobe_duration(path: Path) -> float:
    ffmpeg = find_ffmpeg()
    # Derive ffprobe path from ffmpeg (same package on every platform).
    ffprobe = ffmpeg.replace("ffmpeg.exe", "ffprobe.exe").replace("ffmpeg", "ffprobe")
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    kwargs: dict = {"capture_output": True, "timeout": 30}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        result = subprocess.run(cmd, **kwargs)
    except FileNotFoundError:
        raise RuntimeError(f"ffprobe not found alongside ffmpeg ({ffmpeg})")
    if result.returncode != 0:
        raise RuntimeError(
            f"ffprobe failed: {result.stderr.decode(errors='replace')[:200]}"
        )
    return float(result.stdout.decode().strip() or "0")


def _normalize_to_wav(source: Path, target: Path) -> None:
    ffmpeg = find_ffmpeg()
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-vn",  # drop any video stream (mp4/mov)
        "-ar",
        "16000",
        "-ac",
        "1",
        "-acodec",
        "pcm_s16le",
        "-f",
        "wav",
        str(target),
    ]
    # 10 minute cap for a 4h source — covers slow disks comfortably.
    kwargs: dict = {"capture_output": True, "timeout": 600}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    result = subprocess.run(cmd, **kwargs)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg normalize failed: "
            f"{result.stderr.decode(errors='replace')[:300]}"
        )


async def _process_chunks_parallel(
    job: JobState,
    chunks: list[AudioChunk],
    *,
    meeting_id: int,
    total_chunks: int,
    already_done: int = 0,
) -> list[dict]:
    """STT + embedding for every chunk concurrently, bounded by a semaphore.

    Each chunk's result is persisted to ``upload_chunks`` immediately and the
    partial transcript JSON is written to ``meetings.transcript`` after every
    chunk. This means:
      - Sidecar restart mid-pipeline → resume picks up where we left off
      - User opens meeting while pipeline runs → sees text filling in live
      - App crash → still have whatever was processed up to that point
    """
    if not chunks:
        return []

    # ── STT provider routing ────────────────────────────────────────────
    # Earlier this hardcoded Nvidia and ignored the user's Settings choice
    # — uploading on a Soniox-configured app still ran Riva, producing
    # "[stt:nvidia-stream-batch] Parakeet …" in the log no matter what.
    stt_provider = (db.get_setting("stt_provider") or "nvidia").strip().lower()
    if stt_provider not in ("nvidia", "soniox"):
        stt_provider = "nvidia"

    if stt_provider == "nvidia":
        nvidia_key = (
            db.get_setting("nvidia_api_key")
            or os.environ.get("NVIDIA_API_KEY", "")
        )
        if not nvidia_key:
            raise RuntimeError(
                "Nvidia API key chưa được cấu hình. Vào Settings → Nvidia API Key."
            )
        stt_lang = db.get_setting("stt_language") or "vi"
        riva_lang = get_language_code(stt_lang)
        soniox_key = ""
        soniox_hints: list[str] = []
    else:
        soniox_key = (
            db.get_setting("soniox_api_key")
            or os.environ.get("SONIOX_API_KEY", "")
        )
        if not soniox_key:
            raise RuntimeError(
                "Soniox API key chưa được cấu hình. Vào Settings → Soniox API Key."
            )
        hints_raw = db.get_setting("soniox_language_hints") or "vi"
        soniox_hints = [h.strip() for h in hints_raw.split(",") if h.strip()] or ["vi"]
        nvidia_key = ""
        riva_lang = ""
    log.info("[pipeline] STT provider: %s", stt_provider)

    diarizer = None
    try:
        from main import diarizer as _diarizer
        diarizer = _diarizer
    except Exception:
        log.warning("[pipeline] global diarizer not available — single-speaker output")

    semaphore = asyncio.Semaphore(_stt_concurrency())
    results: dict[int, dict] = {}
    lock = asyncio.Lock()

    async def _process_one(chunk: AudioChunk):
        async with semaphore:
            if _is_cancelled(job):
                return

            # Dispatch to the configured provider. Nvidia uses streaming gRPC
            # (offline_recognize unavailable for vi/zh). Soniox uses the
            # async file API (stt-async-v4) with auto-cleanup.
            if stt_provider == "nvidia":
                stt_task = asyncio.to_thread(
                    transcribe_nvidia_streaming, str(chunk.path), nvidia_key, riva_lang
                )
            else:
                stt_task = asyncio.to_thread(
                    transcribe_soniox_file, str(chunk.path), soniox_key, soniox_hints
                )
            emb_task = (
                asyncio.to_thread(extract_embedding, diarizer, chunk.path)
                if diarizer is not None
                else asyncio.sleep(0, result=None)
            )
            text_raw, emb_raw = await asyncio.gather(
                stt_task, emb_task, return_exceptions=True
            )

            text = ""
            if isinstance(text_raw, Exception):
                log.warning("[pipeline] STT failed chunk %d: %s", chunk.idx, text_raw)
            elif text_raw:
                text = str(text_raw)

            embedding = None
            if isinstance(emb_raw, Exception):
                log.warning("[pipeline] embed failed chunk %d: %s", chunk.idx, emb_raw)
            else:
                embedding = emb_raw

            text_clean = _filter_hallucinations(text or "").strip()

            # Persist this chunk's result so we can resume after a crash and
            # so the user sees live updates if they open the meeting now.
            embedding_blob = embedding.tobytes() if embedding is not None else None
            await asyncio.to_thread(
                db.save_chunk_result, meeting_id, chunk.idx, text_clean, embedding_blob,
            )

            async with lock:
                results[chunk.idx] = {
                    "idx": chunk.idx,
                    "text": text_clean,
                    "embedding": embedding,
                    "start_ms": chunk.start_ms,
                    "end_ms": chunk.end_ms,
                }
                # Refresh meetings.transcript with everything we have so far.
                await asyncio.to_thread(
                    _flush_partial_transcript, meeting_id,
                )

                done_now = already_done + len(results)

            # Stream this chunk to any live SSE listeners.
            await registry.emit_chunk(
                job.job_id,
                {
                    "idx": chunk.idx,
                    "text": text_clean,
                    "start_ms": chunk.start_ms,
                    "end_ms": chunk.end_ms,
                },
            )

            progress = (
                P_TRANSCRIBE_START
                + (done_now / max(1, total_chunks))
                * (P_TRANSCRIBE_END - P_TRANSCRIBE_START)
            )
            await registry.update(
                job.job_id,
                progress=progress,
                processed_chunks=done_now,
                message=f"Phiên âm {done_now}/{total_chunks}",
            )

    await asyncio.gather(*(_process_one(c) for c in chunks))
    return list(results.values())


def _chunks_from_db_plan(
    saved_chunks: dict[int, dict], wav_path: Path, chunks_dir: Path
) -> list[AudioChunk]:
    """Rebuild AudioChunk list from the chunk plan persisted in DB (resume)."""
    out: list[AudioChunk] = []
    for idx in sorted(saved_chunks.keys()):
        row = saved_chunks[idx]
        chunk_path = chunks_dir / f"chunk_{idx:04d}.wav"
        out.append(AudioChunk(
            idx=idx,
            start_ms=int(row["start_ms"]),
            end_ms=int(row["end_ms"]),
            path=chunk_path,
        ))
    return out


def _extract_pending_chunk_files(wav_path: Path, pending: list[AudioChunk]) -> None:
    """Re-extract WAV slices for chunks whose tmp files are gone after restart."""
    from services.vad_splitter import _extract_chunk_with_ffmpeg
    for c in pending:
        if c.path.exists():
            continue
        c.path.parent.mkdir(parents=True, exist_ok=True)
        duration = max(0, c.end_ms - c.start_ms)
        if duration <= 0:
            continue
        _extract_chunk_with_ffmpeg(wav_path, c.path, c.start_ms, duration)


def _merge_saved_and_new_results(
    saved_chunks: dict[int, dict],
    new_results: list[dict],
    chunks: list[AudioChunk],
) -> list[dict]:
    """Combine DB-persisted chunk results with freshly processed ones.

    Newly-processed (in-memory) results take precedence — they have the
    embedding as an np.ndarray. DB rows store embedding as bytes; deserialize
    here so the clustering step sees a uniform shape.
    """
    import numpy as np

    new_by_idx = {r["idx"]: r for r in new_results}
    chunk_boundaries = {c.idx: (c.start_ms, c.end_ms) for c in chunks}

    out: list[dict] = []
    for idx in sorted({*saved_chunks.keys(), *new_by_idx.keys()}):
        if idx in new_by_idx:
            out.append(new_by_idx[idx])
            continue
        row = saved_chunks[idx]
        emb_bytes = row.get("embedding")
        embedding = None
        if emb_bytes:
            try:
                embedding = np.frombuffer(emb_bytes, dtype=np.float32).copy()
            except Exception as exc:
                log.warning("[pipeline] failed to decode saved embedding %d: %s", idx, exc)
        start_ms, end_ms = chunk_boundaries.get(
            idx, (int(row["start_ms"]), int(row["end_ms"])),
        )
        out.append({
            "idx": idx,
            "text": row.get("text") or "",
            "embedding": embedding,
            "start_ms": start_ms,
            "end_ms": end_ms,
        })
    return out


def _flush_partial_transcript(meeting_id: int) -> None:
    """Write a fresh transcript JSON from all currently saved chunks.

    Speakers are not yet clustered at this stage (clustering needs ALL chunks
    done), so every chunk goes in as Speaker 1. The final pass after
    clustering overwrites this with the correct speaker assignments.
    """
    rows = db.get_upload_chunks(meeting_id)
    if not rows:
        return
    fake_speaker_map = {r["chunk_idx"]: 0 for r in rows}
    interim_results = []
    for r in rows:
        if not (r.get("text") or "").strip():
            continue
        interim_results.append({
            "idx": int(r["chunk_idx"]),
            "text": r["text"],
            "embedding": None,
            "start_ms": int(r["start_ms"]),
            "end_ms": int(r["end_ms"]),
        })
    if not interim_results:
        return
    parts = _build_transcript_parts(interim_results, fake_speaker_map)
    db.update_meeting(
        meeting_id,
        transcript=json.dumps(parts, ensure_ascii=False),
    )


def _ms_to_seconds_str(ms: int | None) -> str:
    """Frontend's fmtSec parses parseFloat(v); emit seconds as a string."""
    if ms is None:
        return "0"
    return f"{ms / 1000:.2f}"


def _build_transcript_parts(
    chunk_results: list[dict], speaker_map: dict[int, int]
) -> list[dict]:
    """Assemble realtime-format transcript JSON — ONE PART PER CHUNK.

    Why no same-speaker merging here (unlike main.py realtime):
      Without a working diarizer every chunk gets speakerId=0 → merging
      collapses a 60-minute meeting into a single block with no per-chunk
      timestamps. Keeping chunks separate guarantees the user sees per-22s
      time badges ("1:24 – 1:46") regardless of whether CAM++ is loaded.

    Overlap text from VAD splitting (1.5s) is de-duplicated against the
    previous chunk's tail so the displayed text doesn't repeat at boundaries.

    Emits `startTime`/`endTime` as seconds strings parseable by the frontend
    fmtSec helper.
    """
    parts: list[dict] = []
    prev_tail = ""

    for r in sorted(chunk_results, key=lambda x: x["idx"]):
        text = (r["text"] or "").strip()
        if not text:
            continue
        if prev_tail:
            text = _strip_overlap_prefix(prev_tail, text)
            if not text:
                continue

        speaker_id = speaker_map.get(r["idx"], 0)
        speaker = f"Speaker {speaker_id + 1}"
        chunk_id = f"upload-{r['idx']:04d}-{uuid4().hex[:8]}"
        start_ms = int(r.get("start_ms") or 0)
        end_ms = int(r.get("end_ms") or 0)

        parts.append(
            {
                "text": text,
                "speaker": speaker,
                "speakerId": speaker_id,
                "chunkId": chunk_id,
                "chunkIds": [chunk_id],
                "chunkData": {chunk_id: text},
                # Frontend fmtSec parses parseFloat — seconds as string.
                "startTime": _ms_to_seconds_str(start_ms),
                "endTime": _ms_to_seconds_str(end_ms),
                "timestamp": "",
                "translation": "",
            }
        )

        prev_tail = text[-120:]

    return parts


def _strip_overlap_prefix(prev_tail: str, current: str) -> str:
    """Remove the longest prefix of `current` that appears as a suffix of prev_tail.

    Cheap O(n) dedup that recovers most word-boundary collisions caused by
    the 1.5s VAD overlap. We don't need perfect — STT itself adds noise.
    """
    max_window = min(len(prev_tail), len(current), 120)
    for k in range(max_window, 5, -1):
        if current[:k] == prev_tail[-k:]:
            return current[k:].lstrip()
    return current


def _summarize_blocking(parts: list[dict], language: str, meeting_id: int) -> str:
    """Drain summarize_stream into a single markdown string.

    Best-effort: returns empty string on any failure so the job still ends
    in `done` (user can retry via the existing /summarize button).
    """
    if not parts:
        return ""
    try:
        from summarize import summarize_stream
    except Exception as exc:
        log.warning("[pipeline] summarize import failed: %s", exc)
        return ""

    lines: list[str] = []
    for p in parts:
        text = (p.get("text") or "").strip()
        if not text:
            continue
        lines.append(f"{p.get('speaker', 'Speaker')}: {text}")
    if not lines:
        return ""
    flat_transcript = "\n".join(lines)

    tokens: list[str] = []
    try:
        for raw_event in summarize_stream(flat_transcript, language, db, meeting_id=meeting_id):
            # Each yielded string is one SSE block: "data: {...}\n\n" or
            # "event: progress\ndata: {...}\n\n" — we only collect token data.
            for line in raw_event.splitlines():
                if not line.startswith("data: "):
                    continue
                try:
                    payload = json.loads(line[6:])
                except json.JSONDecodeError:
                    continue
                tok = payload.get("token")
                if isinstance(tok, str):
                    tokens.append(tok)
    except Exception as exc:
        log.warning("[pipeline] summarize_stream failed: %s", exc)
        return ""

    return "".join(tokens).strip()
