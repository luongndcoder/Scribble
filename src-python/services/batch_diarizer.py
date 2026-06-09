"""Batch speaker diarization via global clustering.

Streaming reconciliation (BackgroundReconciler) is the right algorithm for
realtime — it commits a speaker decision as audio arrives. For an uploaded
file we have the whole audio up front, so we extract embeddings for every
chunk and cluster them globally. This gives stable speaker IDs across an
entire 2-hour meeting and avoids the singleton diarizer's profile registry
(which would leak state between jobs / pollute realtime).

Clustering uses scipy (already in requirements). sklearn is intentionally
excluded from the PyInstaller bundle, so do NOT import it here.
"""
from __future__ import annotations

import logging
import wave
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import pdist

if TYPE_CHECKING:
    from diarize import SpeakerDiarizer

log = logging.getLogger(__name__)

import os

# Cosine-distance threshold below which embeddings count as the same speaker.
# Validated on CAM++ zh-cn 200k: at 0.40 a 60-min Vietnamese meeting clusters
# into 4 distinct speakers (window sizes 499/461/326/215). Must run on FINE
# (~2s) windows — 20s STT chunks blend speakers so every chunk looks alike.
DEFAULT_DISTANCE_THRESHOLD = float(os.getenv("DIARIZE_DISTANCE_THRESHOLD", "0.4"))
DEFAULT_MAX_SPEAKERS = 8

# Fine-grained diarization windowing (independent of the 20s STT chunks).
FINE_WINDOW_MS = int(os.getenv("DIARIZE_FINE_WINDOW_MS", "2000"))
FINE_SILENCE_RMS = float(os.getenv("DIARIZE_FINE_SILENCE_RMS", "0.01"))


def _load_wav_samples(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        n = w.getnframes()
        frames = w.readframes(n)
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def _ensure_session(diarizer: "SpeakerDiarizer") -> bool:
    """Make sure the diarizer's ONNX model is loaded. Returns True if usable.

    PyInstaller quirk: the entry runs as `__main__` and loads the diarizer
    there, but `from main import diarizer` (in the upload pipeline) imports a
    SECOND `main` module with its own un-initialized diarizer (_session=None).
    Lazy-init here so the batch path always has a loaded model. _init_model is
    idempotent; the lock guards concurrent chunk workers.
    """
    if getattr(diarizer, "_session", None):
        return True
    try:
        with diarizer._lock:
            diarizer._init_model()
    except Exception as exc:
        log.warning("[batch-diarize] init_model failed: %s", exc)
    return bool(getattr(diarizer, "_session", None))


def _embed_samples(diarizer: "SpeakerDiarizer", samples: np.ndarray) -> np.ndarray | None:
    """fbank → CAM++ → L2-normalized embedding. Assumes session is loaded."""
    if len(samples) == 0:
        return None
    try:
        fbank = diarizer._compute_fbank(samples, sr=16000)
        fbank_input = fbank[np.newaxis, :, :].astype(np.float32)
        # Introspected node names (set in _init_model), not hardcoded.
        in_name = getattr(diarizer, "_in_name", None) or "feats"
        out_name = getattr(diarizer, "_out_name", None) or "embs"
        outputs = diarizer._session.run([out_name], {in_name: fbank_input})
    except Exception as exc:
        log.warning("[batch-diarize] embed FAILED: %s", exc)
        return None
    emb = outputs[0].flatten().astype(np.float32)
    norm = np.linalg.norm(emb)
    if norm < 1e-8:
        return None
    return emb / norm


def extract_embedding(
    diarizer: "SpeakerDiarizer", wav_path: Path
) -> np.ndarray | None:
    """Run CAM++ inference on a chunk WAV → L2-normalized embedding (or None).

    Kept for the per-chunk path; fine-grained diarization uses _embed_samples
    directly. Bypasses identify_speaker_from_samples() so the singleton's
    profile registry stays untouched (realtime uses the same instance).
    """
    name = getattr(wav_path, "name", str(wav_path))
    if not _ensure_session(diarizer):
        log.warning("[batch-diarize] extract skip %s: no ONNX session", name)
        return None
    samples = _load_wav_samples(wav_path)
    if len(samples) == 0:
        log.warning("[batch-diarize] extract skip %s: 0 samples (wav header issue?)", name)
        return None
    return _embed_samples(diarizer, samples)


def cluster_speakers(
    embeddings: list[tuple[int, np.ndarray]],
    *,
    distance_threshold: float = DEFAULT_DISTANCE_THRESHOLD,
    max_speakers: int = DEFAULT_MAX_SPEAKERS,
) -> dict[int, int]:
    """Cluster chunk embeddings → {chunk_idx: stable_speaker_id}.

    Speaker IDs are assigned in temporal order: whoever speaks first becomes
    speaker 0, the next NEW voice becomes speaker 1, etc.

    Args:
        embeddings: list of (chunk_idx, embedding) tuples in temporal order.
        distance_threshold: cosine-distance threshold for "same speaker".
        max_speakers: cap clusters; over-segmentation gets merged into the
            highest cluster. Set high if you expect many distinct voices.
    """
    if not embeddings:
        return {}
    if len(embeddings) == 1:
        return {embeddings[0][0]: 0}

    chunk_indices = [e[0] for e in embeddings]
    matrix = np.stack([e[1] for e in embeddings])

    # Agglomerative clustering on cosine distance, average linkage.
    condensed = pdist(matrix, metric="cosine")
    if len(condensed) == 0:
        return {chunk_indices[0]: 0}
    z = linkage(condensed, method="average")
    raw_labels = fcluster(z, t=distance_threshold, criterion="distance")

    # Map raw cluster IDs to 0-indexed speaker IDs in temporal order.
    seen: dict[int, int] = {}
    result: dict[int, int] = {}
    for chunk_idx, raw in zip(chunk_indices, raw_labels):
        raw = int(raw)
        if raw not in seen:
            seen[raw] = len(seen)
        speaker_id = seen[raw]
        if speaker_id >= max_speakers:
            speaker_id = max_speakers - 1
        result[chunk_idx] = speaker_id

    log.info(
        "[batch-diarize] clustered %d chunks into %d speakers (threshold=%.2f)",
        len(embeddings),
        min(len(seen), max_speakers),
        distance_threshold,
    )
    return result


def diarize_fine_windows(
    diarizer: "SpeakerDiarizer",
    wav_path: Path,
    *,
    window_ms: int = FINE_WINDOW_MS,
    distance_threshold: float = DEFAULT_DISTANCE_THRESHOLD,
    max_speakers: int = DEFAULT_MAX_SPEAKERS,
    silence_rms: float = FINE_SILENCE_RMS,
) -> list[tuple[int, int, int]]:
    """Fine-grained diarization timeline for a whole normalized WAV.

    Slices the audio into non-overlapping ~`window_ms` windows (default 2s),
    embeds each speech window with CAM++, clusters them, and returns a timeline
    of (start_ms, end_ms, speaker_id). Fine windows are single-speaker far more
    often than the 20s STT chunks (which blend speakers and collapse to one
    cluster), so this is what actually separates speakers.

    Returns [] when the model is unavailable or there are too few speech windows.
    """
    if not _ensure_session(diarizer):
        log.warning("[batch-diarize] fine: no ONNX session")
        return []
    samples = _load_wav_samples(wav_path)
    sr = 16000
    win = int(window_ms / 1000.0 * sr)
    if win <= 0 or len(samples) < win:
        return []

    embeddings: list[tuple[int, np.ndarray]] = []
    spans: list[tuple[int, int]] = []
    for start in range(0, len(samples) - win + 1, win):
        seg = samples[start:start + win]
        if float(np.sqrt(np.mean(seg ** 2))) < silence_rms:
            continue  # skip near-silence so it doesn't pollute clustering
        emb = _embed_samples(diarizer, seg)
        if emb is None:
            continue
        start_ms = int(start / sr * 1000)
        end_ms = int((start + win) / sr * 1000)
        embeddings.append((len(embeddings), emb))
        spans.append((start_ms, end_ms))

    if len(embeddings) < 2:
        log.info("[batch-diarize] fine: only %d speech windows — skipping", len(embeddings))
        return []

    labels = cluster_speakers(
        embeddings, distance_threshold=distance_threshold, max_speakers=max_speakers
    )
    timeline = [
        (spans[i][0], spans[i][1], labels.get(i, 0)) for i in range(len(spans))
    ]
    n_spk = len({spk for _, _, spk in timeline})
    log.info(
        "[batch-diarize] fine: %d windows (%dms) → %d speakers",
        len(timeline), window_ms, n_spk,
    )
    return timeline


def chunk_speaker_map_from_timeline(
    timeline: list[tuple[int, int, int]],
    chunk_bounds: list[tuple[int, int, int]],
) -> dict[int, int]:
    """Assign each STT chunk the speaker with the most temporal overlap.

    Args:
        timeline: fine windows [(start_ms, end_ms, speaker_id)].
        chunk_bounds: STT chunks [(chunk_idx, start_ms, end_ms)] in temporal order.

    Returns {chunk_idx: speaker_id}, with speaker IDs renumbered in temporal
    order of the chunks (first speaker heard → 0).
    """
    if not timeline:
        return {}
    raw_map: dict[int, int] = {}
    for c_idx, c_start, c_end in chunk_bounds:
        votes: dict[int, int] = {}
        for w_start, w_end, spk in timeline:
            overlap = min(w_end, c_end) - max(w_start, c_start)
            if overlap > 0:
                votes[spk] = votes.get(spk, 0) + overlap
        if votes:
            raw_map[c_idx] = max(votes, key=votes.get)

    # Renumber so the first chunk's speaker is 0, etc. (stable display order).
    seen: dict[int, int] = {}
    result: dict[int, int] = {}
    for c_idx, _, _ in chunk_bounds:
        if c_idx not in raw_map:
            continue
        raw = raw_map[c_idx]
        if raw not in seen:
            seen[raw] = len(seen)
        result[c_idx] = seen[raw]
    return result
