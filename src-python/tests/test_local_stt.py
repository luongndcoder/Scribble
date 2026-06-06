"""Phase 07 (Slice C) — RED tests for the sherpa-onnx local STT engine.

Contract (implemented in Phase 09, src-python/local_stt.py):

    _pcm_int16_to_float32(pcm_bytes) -> np.ndarray   # [-1, 1)
    class SherpaOnnxEngine(LocalSTTEngine):
        __init__(model_dir): build OfflineRecognizer.from_transducer(...)
        transcribe_pcm(pcm_float32, lang) -> str
    get_engine(model_dir) -> SherpaOnnxEngine        # singleton per dir
    transcribe_local_file(path, language) -> str      # batch contract

sherpa_onnx is NOT installed in CI, so tests inject a fake module into
sys.modules before importing local_stt.
"""

import sys
import types

import numpy as np
import pytest


@pytest.fixture
def fake_sherpa(monkeypatch):
    """Install a fake ``sherpa_onnx`` module. Returns a dict to inspect calls
    and set the text the recognizer should 'transcribe'."""
    state = {"from_transducer_calls": 0, "text": "xin chào mọi người"}

    class _FakeStream:
        def __init__(self, outer):
            self._outer = outer

        def accept_waveform(self, sample_rate, samples):
            self._outer._fed = (sample_rate, samples)

        @property
        def result(self):
            return types.SimpleNamespace(text=self._outer._text)

    class _FakeRecognizer:
        def __init__(self, text):
            self._text = text
            self._fed = None

        def create_stream(self):
            return _FakeStream(self)

        def decode_stream(self, stream):
            pass

    def _from_transducer(**kwargs):
        state["from_transducer_calls"] += 1
        state["last_kwargs"] = kwargs
        return _FakeRecognizer(state["text"])

    fake_mod = types.ModuleType("sherpa_onnx")
    fake_mod.OfflineRecognizer = types.SimpleNamespace(from_transducer=_from_transducer)
    monkeypatch.setitem(sys.modules, "sherpa_onnx", fake_mod)
    return state


# ── PCM conversion ───────────────────────────────────────────────────────────


def test_pcm_int16_to_float32_normalizes():
    from local_stt import _pcm_int16_to_float32

    # int16 min (-32768) -> -1.0 ; 0 -> 0.0
    pcm = (-32768).to_bytes(2, "little", signed=True) + (0).to_bytes(2, "little", signed=True)
    out = _pcm_int16_to_float32(pcm)
    assert out.dtype == np.float32
    assert out[0] == pytest.approx(-1.0, abs=1e-4)
    assert out[1] == pytest.approx(0.0, abs=1e-4)


# ── engine ───────────────────────────────────────────────────────────────────


def test_transcribe_pcm_returns_recognizer_text(fake_sherpa, tmp_path):
    from local_stt import SherpaOnnxEngine

    eng = SherpaOnnxEngine(tmp_path)
    samples = np.zeros(1600, dtype=np.float32)
    # vi post-processing capitalizes the sentence start (normalize_vietnamese_text)
    assert eng.transcribe_pcm(samples, "vi") == "Xin chào mọi người"


def test_allcaps_model_output_is_proper_cased(fake_sherpa, tmp_path):
    """ALL-CAPS sherpa output → lowercased + sentence-capitalized, not kept as
    a wall of acronyms."""
    from local_stt import SherpaOnnxEngine

    fake_sherpa["text"] = "RỒI CŨNG HỖ TRỢ CHO LÂU LÂU"
    eng = SherpaOnnxEngine(tmp_path)
    out = eng.transcribe_pcm(np.zeros(160, dtype=np.float32), "vi")
    assert out == "Rồi cũng hỗ trợ cho lâu lâu"


def test_maybe_lowercase_allcaps_leaves_mixed_case():
    from local_stt import _maybe_lowercase_allcaps

    assert _maybe_lowercase_allcaps("Xin chào mọi người") == "Xin chào mọi người"
    assert _maybe_lowercase_allcaps("ÂM LƯỢNG TV GIẢM") == "âm lượng tv giảm"


def test_transcribe_pcm_filters_hallucination(fake_sherpa, tmp_path):
    from local_stt import SherpaOnnxEngine

    fake_sherpa["text"] = "hãy subscribe cho kênh"  # in HALLUCINATION_PATTERNS
    eng = SherpaOnnxEngine(tmp_path)
    assert eng.transcribe_pcm(np.zeros(160, dtype=np.float32), "vi") == ""


def test_engine_singleton_per_model_dir(fake_sherpa, tmp_path):
    from local_stt import get_engine

    e1 = get_engine(tmp_path)
    e2 = get_engine(tmp_path)
    assert e1 is e2
    assert fake_sherpa["from_transducer_calls"] == 1  # built once


# ── transcribe_local_file: model availability ────────────────────────────────


def test_transcribe_local_file_raises_when_model_missing(monkeypatch, tmp_path):
    import local_stt

    monkeypatch.setattr(local_stt, "_active_tier", lambda: "C")
    monkeypatch.setattr(local_stt, "model_path_or_none", lambda spec: None)
    with pytest.raises(RuntimeError, match="chưa sẵn sàng"):
        local_stt.transcribe_local_file(str(tmp_path / "a.wav"), "vi")


# ── Tier A (MLX nemotron) dispatch ───────────────────────────────────────────


def test_tier_a_dispatches_to_mlx(monkeypatch, tmp_path):
    """On Apple Silicon with MLX available, transcribe routes to the MLX engine."""
    import local_stt

    class _FakeMlx:
        def transcribe_file(self, wav_path, language="vi"):
            return "Xin chào, đây là nemotron."

    monkeypatch.setattr(local_stt, "_active_tier", lambda: "A")
    monkeypatch.setattr(local_stt, "_mlx_available", lambda: True)
    monkeypatch.setattr(local_stt, "get_mlx_engine", lambda: _FakeMlx())
    monkeypatch.setattr(local_stt, "_ffmpeg_to_wav16", lambda p: str(tmp_path / "x.wav"))

    out = local_stt.transcribe_local_file(str(tmp_path / "a.m4a"), "vi")
    assert out == "Xin chào, đây là nemotron."


def test_tier_a_falls_back_to_sherpa_when_mlx_missing(monkeypatch, tmp_path):
    """Apple Silicon but MLX not importable → Tier C sherpa path (not MLX)."""
    import local_stt

    monkeypatch.setattr(local_stt, "_active_tier", lambda: "A")
    monkeypatch.setattr(local_stt, "_mlx_available", lambda: False)
    monkeypatch.setattr(local_stt, "model_path_or_none", lambda spec: None)
    # Reaching the sherpa "missing model" RuntimeError proves it did NOT take MLX.
    with pytest.raises(RuntimeError, match="chưa sẵn sàng"):
        local_stt.transcribe_local_file(str(tmp_path / "a.wav"), "vi")
