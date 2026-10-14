"""Config + migration for the hynt ResNet swap (CAM++ 192-d → ResNet 256-d).

- min audio per embedding stays 1.5s (matches the hynt enrollment spec:
  min 1500ms net speech; sub-second segments yield noisy embeddings).
- Absolute MATCH/switch/merge thresholds are NOT pinned here — they were tuned
  for CAM++ score ranges and are being re-calibrated on real Vietnamese
  meeting audio. This file pins only the ordering invariants + env override.
- reset() must fully clear state so legacy (192-d) profiles never bleed into a
  256-d session (the loader also guards this via dim mismatch).
"""

import importlib

import numpy as np


def test_diarize_min_bytes_is_1_5s():
    import diarize
    importlib.reload(diarize)
    # 1.5s @ 16kHz, 16-bit mono = 16000 * 2 * 1.5 bytes
    assert diarize.DIARIZE_MIN_BYTES == int(16000 * 2 * 1.5)


def test_threshold_invariants_hold_pending_calibration():
    import diarize
    importlib.reload(diarize)
    # Ordering invariants that any calibrated set must satisfy. Absolute
    # values come from the calibration step (real meeting audio) — do NOT
    # pin CAM++-era bands here.
    assert 0.0 < diarize.MATCH_THRESHOLD < diarize.STRONG_MATCH_THRESHOLD <= 1.0
    assert diarize.MAX_SPEAKERS >= 6, diarize.MAX_SPEAKERS


def test_calibrated_defaults_for_hynt_resnet():
    """Regression pin for the 2026-10-09 calibration on real VI meeting audio
    (see docs/reports/calibration-2026-10-09-hynt-resnet34-tts.md).
    Change deliberately + update the report, never by accident."""
    import diarize
    importlib.reload(diarize)
    assert diarize.MATCH_THRESHOLD == 0.50
    assert diarize.STRONG_MATCH_THRESHOLD == 0.70
    assert diarize.MERGE_SIM_THRESHOLD == 0.80
    assert diarize.NEW_SPEAKER_SELF_SIM == 0.55
    import services.batch_diarizer as bd
    importlib.reload(bd)
    assert bd.DEFAULT_DISTANCE_THRESHOLD == 0.45


def test_thresholds_env_overridable(monkeypatch):
    monkeypatch.setenv("DIARIZE_MATCH_THRESHOLD", "0.42")
    import diarize
    importlib.reload(diarize)
    assert abs(diarize.MATCH_THRESHOLD - 0.42) < 1e-9
    # cleanup: reload without override so other tests see defaults
    monkeypatch.delenv("DIARIZE_MATCH_THRESHOLD", raising=False)
    importlib.reload(diarize)


def test_batch_distance_threshold_env_overridable(monkeypatch):
    monkeypatch.setenv("DIARIZE_DISTANCE_THRESHOLD", "0.35")
    import importlib as _il
    import services.batch_diarizer as bd
    _il.reload(bd)
    assert abs(bd.DEFAULT_DISTANCE_THRESHOLD - 0.35) < 1e-9
    monkeypatch.delenv("DIARIZE_DISTANCE_THRESHOLD", raising=False)
    _il.reload(bd)


def test_reset_clears_all_state():
    import diarize
    importlib.reload(diarize)
    d = diarize.SpeakerDiarizer()
    # Seed fake state (simulate a prior session, possibly old-model profiles).
    d._profiles = [{"id": 0, "embedding": np.zeros(256, dtype=np.float32), "count": 3}]
    d._next_id = 1
    d._last_speaker_id = 0
    d._last_speaker_time = 123.0
    d._pending_new_emb = np.zeros(256, dtype=np.float32)
    d.reset()
    assert d._profiles == []
    assert d._next_id == 0
    assert d._last_speaker_id is None
    assert d._pending_new_emb is None
