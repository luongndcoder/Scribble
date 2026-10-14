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

if TYPE_CHECKING:
    from diarize import SpeakerDiarizer

log = logging.getLogger(__name__)

import os

# Cosine-distance threshold below which embeddings count as the same speaker.
#
# NOTE: this Python path is no longer the shipped implementation — the Rust
# diarizer is. These values are kept in sync with src-tauri/src/diarize.rs so
# the two do not silently disagree for anyone still running the Python path.
# Current Rust model: 3D-Speaker ERes2Net-base (Apache-2.0), thresholds
# re-derived 2026-10-09 (distance 0.55, match 0.42, strong 0.65, self-sim 0.35).
#
# Earlier calibration (hynt ResNet34, distance 0.45) is superseded.
# Override via DIARIZE_DISTANCE_THRESHOLD.
# Must run on FINE (~2s) windows — 20s STT chunks blend speakers so every
# chunk looks alike.
DEFAULT_DISTANCE_THRESHOLD = float(os.getenv("DIARIZE_DISTANCE_THRESHOLD", "0.55"))
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
    """fbank → embedding model → L2-normalized embedding. Assumes session is loaded."""
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
    """Run embedding inference on a chunk WAV → L2-normalized embedding (or None).

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


def _cosine_distance_matrix(matrix: np.ndarray) -> np.ndarray:
    """Pairwise cosine distance, scipy.spatial.distance.pdist(metric='cosine').

    scipy defines cosine distance as 1 - u·v/(|u||v|). Embeddings here are
    already L2-normalised, but we normalise defensively so the helper is safe
    for un-normalised input too (matching scipy's behaviour).
    """
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms = np.where(norms == 0, 1.0, norms)
    unit = matrix / norms
    sim = unit @ unit.T
    d = 1.0 - sim
    # Clip tiny negatives from float error; scipy does not clamp, so keep the
    # values as-is apart from the diagonal/mirror handling.
    d = np.clip(d, 0.0, 2.0)
    np.fill_diagonal(d, 0.0)
    return d


def _average_linkage(dist: np.ndarray) -> np.ndarray:
    """Agglomerative average-linkage merge sequence (scipy linkage, method='average').

    Returns an (n-1, 4) matrix [cluster_a, cluster_b, distance, size] using the
    same label convention scipy uses: original observations are 0..n-1 and each
    merge i creates cluster n+i. Nearest-neighbour chain would change tie
    ordering, so we use the straightforward "pick global minimum each step"
    (O(n^3) worst case, but n is the number of 2s windows — hundreds, not
    millions — and this runs once per upload).
    """
    n = dist.shape[0]
    # Working copy: distances between active clusters (float64 for stability).
    d = dist.astype(np.float64).copy()
    sizes = np.ones(n, dtype=np.int64)
    active = np.ones(n, dtype=bool)
    merges = np.zeros((max(n - 1, 0), 4), dtype=np.float64)

    for step in range(n - 1):
        # Mask inactive rows/cols AND the diagonal: scipy only merges distinct
        # clusters, and a zeroed diagonal would otherwise always win argmin.
        masked = np.where(active[:, None] & active[None, :], d, np.inf)
        np.fill_diagonal(masked, np.inf)
        flat = int(np.argmin(masked))
        i, j = divmod(flat, n)
        if i > j:
            i, j = j, i
        merge_dist = float(masked[i, j])
        merges[step] = (float(i), float(j), merge_dist, float(sizes[i] + sizes[j]))

        # Lance-Williams update for average linkage (UPGMA):
        #   d(new, k) = (n_i*d(i,k) + n_j*d(j,k)) / (n_i + n_j)
        ni, nj = sizes[i], sizes[j]
        total = ni + nj
        new_d = (ni * d[i] + nj * d[j]) / total
        d[i] = new_d
        d[:, i] = new_d
        d[i, i] = 0.0
        sizes[i] = total
        active[j] = False
        # Park inactive j behind +inf for both directions.
        d[j, :] = np.inf
        d[:, j] = np.inf

    return merges


def _fcluster_distance(merges: np.ndarray, n: int, threshold: float) -> np.ndarray:
    """Flat clusters from a linkage matrix (scipy fcluster, criterion='distance').

    scipy's rule: cut at `threshold` — observations joined by a merge whose
    distance is <= threshold belong to the same flat cluster. Labels are
    returned 1..k in the order clusters are discovered by scipy (we only need
    a partition, and callers renumber by first appearance anyway).
    """
    if n == 0:
        return np.zeros(0, dtype=np.int64)
    if n == 1:
        return np.ones(1, dtype=np.int64)

    # Union-Find over observations, applying every merge under the threshold.
    parent = list(range(n))

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    for a, b, dist, _size in merges:
        if dist <= threshold:
            union(int(a), int(b))

    # Renumber roots to contiguous 1..k (matching fcluster's return type).
    root_to_label: dict[int, int] = {}
    labels = np.zeros(n, dtype=np.int64)
    for i in range(n):
        r = find(i)
        if r not in root_to_label:
            root_to_label[r] = len(root_to_label) + 1
        labels[i] = root_to_label[r]
    return labels


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
    # NOTE: implemented in numpy (no scipy) — identical results to
    # scipy.cluster.hierarchy.linkage(method="average") + fcluster(
    # criterion="distance"); pinned by tests/test_diarizer_clustering.py.
    dist = _cosine_distance_matrix(matrix)
    merges = _average_linkage(dist)
    raw_labels = _fcluster_distance(merges, len(chunk_indices), distance_threshold)

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
    embeds each speech window, clusters them, and returns a timeline
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
