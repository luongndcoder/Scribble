"""hynt swap: fbank frontend contract + model selection.

Pins the frontend the hynt ResNet models REQUIRE (from their config.json):
  - 16kHz mono → 80-dim fbank, 25ms window / 10ms shift
  - int16-scale samples (floats in [-1, 1] are scaled by 2^15 first)
  - DC removal + pre-emphasis 0.97 (torchaudio kaldi defaults, dither=0)
  - per-utterance CMN

Plus: ResNet34 resolves from the bundled repo models dir.
"""

import os

import numpy as np

from diarize import SpeakerDiarizer

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models")


def _sine(seconds=2.0, freq=220.0, amp=0.3) -> np.ndarray:
    sr = 16000
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def test_fbank_shape_80_bins_10ms_shift():
    d = SpeakerDiarizer()
    feat = d._compute_fbank(_sine(2.0), sr=16000)
    # 2.0s → frames = 1 + (32000 - 400) / 160 = 198
    assert feat.shape == (198, 80), feat.shape
    assert feat.dtype == np.float32
    assert np.all(np.isfinite(feat))


def _two_tone() -> np.ndarray:
    """1s 220Hz + 1s 3000Hz — non-stationary, survives CMN (a stationary
    sine is identical every frame, so CMN zeroes it and any argmax is noise)."""
    sr = 16000
    t = np.arange(sr) / sr
    first = 0.3 * np.sin(2 * np.pi * 220.0 * t)
    second = 0.3 * np.sin(2 * np.pi * 3000.0 * t)
    return np.concatenate([first, second]).astype(np.float32)


def test_fbank_dc_removal_and_cmn():
    """A large DC offset must not change features: with DC removal, two-tone
    +DC and plain two-tone give identical features (without removal the
    offset compresses log contrast). CMN keeps per-bin mean ~0."""
    d = SpeakerDiarizer()
    sig = _two_tone()
    feat = d._compute_fbank(sig, sr=16000)
    feat_dc = d._compute_fbank((sig + 0.5).astype(np.float32), sr=16000)
    assert np.allclose(feat, feat_dc, atol=1e-2)  # residual is float32 noise (max ~1.3e-3 vs feature std ~3.4)
    assert np.all(np.abs(feat.mean(axis=0)) < 0.5)


def test_fbank_frequency_selective():
    """The mel filterbank must resolve frequency: an early frame (220Hz
    region) peaks in low mel bins, a late frame (3000Hz region) peaks much
    higher (proves the filterbank + FFT path is live)."""
    d = SpeakerDiarizer()
    feat = d._compute_fbank(_two_tone(), sr=16000)
    assert feat.shape[1] == 80
    peak_early = int(np.argmax(feat[50]))    # ~0.5s → 220Hz
    peak_late = int(np.argmax(feat[150]))    # ~1.5s → 3000Hz
    assert peak_early < 20, peak_early
    assert peak_late > peak_early + 20, (peak_late, peak_early)


def test_resnet34_bundled_and_resolves():
    from local.model_registry import SPEAKER_MODEL_SPECS, speaker_model_path_or_none
    spec = SPEAKER_MODEL_SPECS["resnet34"]
    assert os.path.isfile(os.path.join(MODELS_DIR, spec.filename))
    hit = speaker_model_path_or_none(spec)
    assert hit is not None and hit.is_file()


def test_resnet293_spec_has_sha_and_url():
    from local.model_registry import SPEAKER_MODEL_SPECS
    spec = SPEAKER_MODEL_SPECS["resnet293"]
    assert len(spec.sha256) == 64
    assert spec.url.startswith("https://huggingface.co/hynt/")
    assert spec.size_bytes > 100 * 1024 * 1024
