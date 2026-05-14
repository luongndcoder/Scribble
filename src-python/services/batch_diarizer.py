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

# Cosine-distance threshold below which embeddings count as the same speaker.
# Calibrated for CAM++ embeddings on VoxCeleb (the model in use).
DEFAULT_DISTANCE_THRESHOLD = 0.4
DEFAULT_MAX_SPEAKERS = 8


def _load_wav_samples(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        n = w.getnframes()
        frames = w.readframes(n)
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def extract_embedding(
    diarizer: "SpeakerDiarizer", wav_path: Path
) -> np.ndarray | None:
    """Run CAM++ inference on a chunk and return the L2-normalized 512-dim vector.

    Reuses the global diarizer's ONNX session and fbank helper. We deliberately
    bypass identify_speaker_from_samples() so the singleton's profile state
    stays untouched — important because realtime recording uses the same
    instance.

    Returns None when the ONNX model isn't loaded (pitch-only fallback active);
    caller should assign a default speaker_id in that case.
    """
    if not getattr(diarizer, "_session", None):
        return None

    samples = _load_wav_samples(wav_path)
    if len(samples) == 0:
        return None

    # _compute_fbank uses self._mel_basis (lazy cache). It's a numpy-only
    # transform after init, so calling from a worker thread is safe.
    fbank = diarizer._compute_fbank(samples, sr=16000)
    fbank_input = fbank[np.newaxis, :, :].astype(np.float32)
    outputs = diarizer._session.run(["embs"], {"feats": fbank_input})
    emb = outputs[0].flatten().astype(np.float32)
    norm = np.linalg.norm(emb)
    if norm < 1e-8:
        return None
    return emb / norm


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
