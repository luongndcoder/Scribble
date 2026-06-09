"""Phase 2 (RED) — config + migration for the CAM++ 200k swap.

- min audio per embedding bumped 0.5s → 1.0s (CAM++ needs >=1s for a stable
  embedding; sub-second segments yield noisy embeddings that mis-merge).
- thresholds re-tuned for the new cosine scale: voxceleb returned 0.87–0.98 for
  ALL Vietnamese voices; zh-cn-200k spreads 0.14–0.69 (spike data). Keeping
  MATCH_THRESHOLD=0.68 would put it at the TOP of the new range → severe
  over-split. Default must drop to the ~0.45–0.55 band.
- reset() must fully clear state so voxceleb (512) profiles never bleed into a
  zh-cn (192) session.
"""

import importlib

import numpy as np


def test_diarize_min_bytes_is_1_5s():
    import diarize
    importlib.reload(diarize)
    # 1.5s @ 16kHz, 16-bit mono = 16000 * 2 * 1.5 bytes
    assert diarize.DIARIZE_MIN_BYTES == int(16000 * 2 * 1.5)


def test_default_match_threshold_tuned_for_192_online():
    import diarize
    importlib.reload(diarize)
    # Online realtime path: utterance-granularity same-speaker cosine ~0.7–0.9,
    # different ~0.5–0.65 → threshold must sit ~0.6–0.7 (0.50 collapsed to one
    # speaker). MAX_SPEAKERS raised from 4 for real meetings.
    assert 0.60 <= diarize.MATCH_THRESHOLD <= 0.72, diarize.MATCH_THRESHOLD
    assert diarize.MATCH_THRESHOLD < diarize.STRONG_MATCH_THRESHOLD
    assert diarize.MAX_SPEAKERS >= 6, diarize.MAX_SPEAKERS


def test_thresholds_env_overridable(monkeypatch):
    monkeypatch.setenv("DIARIZE_MATCH_THRESHOLD", "0.42")
    import diarize
    importlib.reload(diarize)
    assert abs(diarize.MATCH_THRESHOLD - 0.42) < 1e-9
    # cleanup: reload without override so other tests see defaults
    monkeypatch.delenv("DIARIZE_MATCH_THRESHOLD", raising=False)
    importlib.reload(diarize)


def test_reset_clears_all_state():
    import diarize
    importlib.reload(diarize)
    d = diarize.SpeakerDiarizer()
    # Seed fake state (simulate a prior session, possibly old-model profiles).
    d._profiles = [{"id": 0, "embedding": np.zeros(192, dtype=np.float32), "count": 3}]
    d._next_id = 1
    d._last_speaker_id = 0
    d._last_speaker_time = 123.0
    d._pending_new_emb = np.zeros(192, dtype=np.float32)
    d.reset()
    assert d._profiles == []
    assert d._next_id == 0
    assert d._last_speaker_id is None
    assert d._pending_new_emb is None
