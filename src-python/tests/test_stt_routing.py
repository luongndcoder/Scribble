"""Phase 10 (Slice D) — RED tests for STT provider routing.

Realtime WS routing is endpoint-based (frontend picks /ws/nvidia-stream vs
soniox), so backend routing for the new "local" provider lives in the batch
upload pipeline. We extract a small normalizer used at both validation sites.

Contract (Phase 12, services/upload_pipeline.py):
    _normalize_stt_provider(raw: str | None) -> str   # nvidia | soniox | local
    (unknown / empty -> "nvidia"; case-insensitive; trims)
"""

import pytest


@pytest.mark.parametrize(
    "raw,expected",
    [
        (None, "nvidia"),
        ("", "nvidia"),
        ("nvidia", "nvidia"),
        ("soniox", "soniox"),
        ("local", "local"),
        ("LOCAL", "local"),
        ("  Soniox  ", "soniox"),
        ("garbage", "nvidia"),
    ],
)
def test_normalize_stt_provider(raw, expected):
    from services.upload_pipeline import _normalize_stt_provider

    assert _normalize_stt_provider(raw) == expected


def test_local_transcriber_is_importable_for_pipeline():
    """The pipeline must be able to dispatch to the local engine."""
    from services.upload_pipeline import transcribe_local_file

    assert callable(transcribe_local_file)
