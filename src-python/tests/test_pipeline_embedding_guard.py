"""Stale embedding-dim guard in the upload-pipeline resume path.

Model upgrades change the embedding dim (CAM++ 192 → hynt 256). Rows saved
by the older model must be discarded when merging (re-embedded downstream),
never mixed into cosine comparisons.
"""

import sys
import types

import numpy as np
import pytest


def _chunks():
    from types import SimpleNamespace
    return [SimpleNamespace(idx=0, start_ms=0, end_ms=2000)]


def _saved(dim: int) -> dict:
    return {
        0: {
            "chunk_idx": 0,
            "start_ms": 0,
            "end_ms": 2000,
            "text": "hello",
            "embedding": np.zeros(dim, dtype=np.float32).tobytes(),
        }
    }


def test_matching_dim_embedding_kept(monkeypatch):
    from services import upload_pipeline as up
    import main

    monkeypatch.setattr(main.diarizer, "_emb_dim", 256, raising=False)
    out = up._merge_saved_and_new_results(_saved(256), [], _chunks())
    assert out[0]["embedding"] is not None
    assert np.asarray(out[0]["embedding"]).shape == (256,)


def test_stale_dim_embedding_dropped(monkeypatch):
    from services import upload_pipeline as up
    import main

    monkeypatch.setattr(main.diarizer, "_emb_dim", 256, raising=False)
    out = up._merge_saved_and_new_results(_saved(192), [], _chunks())
    assert out[0]["embedding"] is None  # dropped → re-embedded downstream
    assert out[0]["text"] == "hello"  # transcript text is preserved


def test_guard_skipped_when_diarizer_uninitialized(monkeypatch):
    from services import upload_pipeline as up
    import main

    monkeypatch.setattr(main.diarizer, "_emb_dim", None, raising=False)
    out = up._merge_saved_and_new_results(_saved(192), [], _chunks())
    assert out[0]["embedding"] is not None  # no dim info → keep old behavior
