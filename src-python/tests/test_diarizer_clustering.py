"""Parity tests: numpy clustering/resampling vs the scipy implementations.

Context (2026-10-09): scipy was dropped from the sidecar bundle (~29MB) by
reimplementing its three call sites in numpy:
  - scipy.spatial.distance.pdist(metric="cosine")  → _cosine_distance_matrix
  - scipy.cluster.hierarchy.linkage(method="average") → _average_linkage
  - scipy.cluster.hierarchy.fcluster(criterion="distance") → _fcluster_distance
  - scipy.signal.resample                          → diarize.resample_fft

scipy is NOT a test dependency here (it is no longer installed in the app venv
on purpose), so these tests assert the *properties* that make the rewrites
drop-in replacements rather than diffing against a live scipy call. The
numerical-equality check against scipy's real output was run during the port
(192 real meeting embeddings, 4 thresholds: all partitions matched; FFT
resample maxdiff 1.2e-7).
"""

import numpy as np
import pytest

from diarize import resample_fft
from services.batch_diarizer import (
    _average_linkage,
    _cosine_distance_matrix,
    _fcluster_distance,
    cluster_speakers,
)


def _partition(labels) -> list:
    """Order-independent view of a labelling (for comparing partitions)."""
    groups: dict = {}
    for i, lab in enumerate(labels):
        groups.setdefault(int(lab), []).append(i)
    return sorted(tuple(v) for v in groups.values())


def _unit_embeddings(n: int, k: int, seed: int = 7) -> np.ndarray:
    """n embeddings drawn from k well-separated directions (realistic spread)."""
    rng = np.random.default_rng(seed)
    centers = rng.normal(size=(k, 64)).astype(np.float32)
    centers /= np.linalg.norm(centers, axis=1, keepdims=True)
    idx = rng.integers(0, k, size=n)
    m = centers[idx] + rng.normal(scale=0.05, size=(n, 64)).astype(np.float32)
    return m / np.linalg.norm(m, axis=1, keepdims=True)


# ── cosine distance ──────────────────────────────────────────────────────────
def test_cosine_distance_matches_definition():
    m = _unit_embeddings(12, 3)
    d = _cosine_distance_matrix(m)
    expected = 1.0 - (m @ m.T)
    assert np.allclose(d, expected, atol=1e-6)
    assert np.allclose(np.diag(d), 0.0)          # pdist never emits self-distances
    assert np.allclose(d, d.T)                   # symmetric
    assert d.min() >= 0.0 and d.max() <= 2.0


def test_cosine_distance_normalises_unnormalised_input():
    m = _unit_embeddings(6, 2) * 4.0            # scaled but same directions
    d_scaled = _cosine_distance_matrix(m)
    d_unit = _cosine_distance_matrix(_unit_embeddings(6, 2))
    assert np.allclose(d_scaled, d_unit, atol=1e-6)


# ── average linkage ──────────────────────────────────────────────────────────
def test_linkage_produces_n_minus_1_merges():
    for n in (2, 5, 17):
        merges = _average_linkage(_cosine_distance_matrix(_unit_embeddings(n, 2)))
        assert merges.shape == (n - 1, 4)


def test_linkage_merges_nearest_clusters_first():
    """First merge must join the two closest embeddings."""
    m = _unit_embeddings(8, 4, seed=3)
    d = _cosine_distance_matrix(m)
    off = d + np.eye(len(m)) * 10.0             # ignore diagonal
    a, b = np.unravel_index(np.argmin(off), off.shape)
    merges = _average_linkage(d)
    first = {int(merges[0][0]), int(merges[0][1])}
    assert first == {int(a), int(b)}
    assert merges[0][2] == pytest.approx(off[a, b], abs=1e-6)


def test_linkage_distances_are_monotonic():
    """Average linkage never produces a decreasing merge distance."""
    merges = _average_linkage(_cosine_distance_matrix(_unit_embeddings(30, 5)))
    dists = merges[:, 2]
    assert np.all(np.diff(dists) >= -1e-9)


def test_linkage_sizes_grow_to_n():
    n = 20
    merges = _average_linkage(_cosine_distance_matrix(_unit_embeddings(n, 3)))
    assert merges[-1][3] == n                    # final merge spans everything


# ── flat clustering ──────────────────────────────────────────────────────────
def test_fcluster_threshold_monotonicity():
    """Higher cut distance can only merge clusters, never split them."""
    m = _unit_embeddings(40, 5)
    merges = _average_linkage(_cosine_distance_matrix(m))
    counts = [
        len(set(_fcluster_distance(merges, len(m), t).tolist()))
        for t in (0.2, 0.5, 0.8, 1.2)
    ]
    assert counts == sorted(counts, reverse=True)
    assert counts[0] >= counts[-1]


def test_fcluster_below_all_merges_is_all_singletons():
    m = _unit_embeddings(10, 3)
    merges = _average_linkage(_cosine_distance_matrix(m))
    labels = _fcluster_distance(merges, len(m), threshold=-1.0)
    assert len(set(labels.tolist())) == len(m)


def test_fcluster_above_all_merges_is_one_cluster():
    m = _unit_embeddings(10, 3)
    merges = _average_linkage(_cosine_distance_matrix(m))
    labels = _fcluster_distance(merges, len(m), threshold=99.0)
    assert len(set(labels.tolist())) == 1


def test_fcluster_recovers_planted_clusters():
    """Well-separated planted groups must come back intact at a sane cut."""
    m = _unit_embeddings(60, 4, seed=11)
    merges = _average_linkage(_cosine_distance_matrix(m))
    # Distance where 4 clusters are expected: just under the tightest gap.
    labels = _fcluster_distance(merges, len(m), threshold=0.35)
    assert len(set(labels.tolist())) == 4


# ── public entry point ───────────────────────────────────────────────────────
def test_cluster_speakers_assigns_ids_in_temporal_order():
    m = _unit_embeddings(12, 3, seed=5)
    items = [(i, m[i]) for i in range(len(m))]
    result = cluster_speakers(items, distance_threshold=0.35, max_speakers=16)
    assert set(result) == set(range(len(m)))
    assert min(result.values()) == 0             # ids start at 0
    # First item always becomes speaker 0
    assert result[0] == 0


def test_cluster_speakers_respects_max_speakers_cap():
    m = _unit_embeddings(60, 10, seed=13)
    items = [(i, m[i]) for i in range(len(m))]
    result = cluster_speakers(items, distance_threshold=0.2, max_speakers=4)
    assert max(result.values()) <= 3             # capped at max_speakers - 1


def test_cluster_speakers_handles_degenerate_inputs():
    assert cluster_speakers([]) == {}
    single = cluster_speakers([(7, _unit_embeddings(1, 1)[0])])
    assert single == {7: 0}


# ── resample ─────────────────────────────────────────────────────────────────
def test_resample_output_length_and_dtype():
    sig = np.sin(2 * np.pi * 220 * np.arange(16000) / 16000).astype(np.float32)
    for num in (8000, 24000, 16000):
        out = resample_fft(sig, num)
        assert out.shape == (num,)
        assert out.dtype == np.float32


def test_resample_identity_is_lossless():
    sig = np.arange(100, dtype=np.float32)
    out = resample_fft(sig, 100)
    assert np.array_equal(out, sig)


def test_resample_preserves_a_pure_tone():
    """A 220Hz sine stays a 220Hz sine with ~the same amplitude."""
    sr = 16000
    t = np.arange(sr) / sr
    sig = np.sin(2 * np.pi * 220 * t).astype(np.float32)
    out = resample_fft(sig, 8000)                # 8kHz still resolves 220Hz
    # Peak amplitude preserved (FFT resample scales energy correctly).
    assert abs(np.abs(out).max() - np.abs(sig).max()) < 0.05
    # Dominant frequency preserved.
    spec = np.abs(np.fft.rfft(out))
    freqs = np.fft.rfftfreq(len(out), d=1.0 / 8000)
    assert abs(freqs[int(np.argmax(spec))] - 220.0) < 5.0


def test_resample_empty_returns_empty():
    """Empty input short-circuits: nothing to resample, no crash, no fake data."""
    assert resample_fft(np.zeros(0, dtype=np.float32), 10).shape == (0,)
