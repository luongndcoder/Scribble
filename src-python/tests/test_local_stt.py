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


# ── LocalStreamingSTT streaming feed (no model needed) ───────────────────────
# The class no longer does its own VAD segmentation: it streams PCM straight
# into the sherpa OnlineRecognizer, which owns endpointing. These tests pin the
# FEED contract (frame quantization + stop flush), not decode behaviour.

import numpy as _np


def test_streaming_feed_queues_whole_frame_batch():
    from local_stt import LocalStreamingSTT

    s = LocalStreamingSTT("vi")
    # 100ms at 20ms frames → one queued job carrying all 5 whole frames.
    s.feed_audio((_np.full(1600, 5000, dtype=_np.int16)).tobytes())
    assert s._in.qsize() == 1
    pcm_bytes, is_flush = s._in.get_nowait()
    assert is_flush is False
    assert len(pcm_bytes) == 1600 * 2  # 5 frames * 320 samples * 2 bytes


def test_streaming_feed_keeps_partial_frame_as_tail():
    from local_stt import LocalStreamingSTT

    s = LocalStreamingSTT("vi")
    # Half a frame (10ms) is held back until the rest arrives.
    s.feed_audio((_np.full(160, 5000, dtype=_np.int16)).tobytes())
    assert s._in.empty()
    assert len(s._tail) == 320  # 160 samples * 2 bytes
    s.feed_audio((_np.full(160, 5000, dtype=_np.int16)).tobytes())
    assert s._in.qsize() == 1  # completed frame flushed


def test_streaming_stop_flushes_tail_and_sentinel():
    from local_stt import LocalStreamingSTT

    s = LocalStreamingSTT("vi")
    s.feed_audio((_np.full(16000, 6000, dtype=_np.int16)).tobytes())  # 1s speech
    s.stop()
    # Last queued item is the None sentinel; at least one audio job precedes it.
    items = []
    while not s._in.empty():
        items.append(s._in.get_nowait())
    assert items[-1] is None
    assert any(it is not None for it in items)


def test_streaming_feed_after_stop_only_queues_sentinel():
    from local_stt import LocalStreamingSTT

    s = LocalStreamingSTT("vi")
    s.stop()
    s.feed_audio((_np.full(1600, 5000, dtype=_np.int16)).tobytes())
    # stop() put the sentinel; the post-stop feed must add nothing on top.
    assert s._in.qsize() == 1
    assert s._in.get_nowait() is None


# ── Short-utterance regression (streaming emits each reply as its own segment) ─
def test_streaming_keeps_short_vietnamese_replies():
    """Regression 2026-10-09: filter_hallucinations dropped every text <=3
    chars, so streaming segments like 'OK' / 'Vâng' / 'Dạ' vanished from the
    transcript. The streaming path must keep them; the cloud path keeps the
    noise guard via filter_hallucinations_min_chars."""
    from stt import filter_hallucinations, filter_hallucinations_min_chars

    for reply in ("OK", "Vâng", "Dạ", "Ừ", "Đúng"):
        assert filter_hallucinations(reply) == reply
    # Cloud path still suppresses 1-3 char noise blips.
    assert filter_hallucinations_min_chars("OK") == ""
    # Real hallucination patterns are dropped on BOTH paths.
    for path in (filter_hallucinations, filter_hallucinations_min_chars):
        assert path("hãy subscribe cho kênh") == ""


def test_mixed_case_segment_is_normalised():
    """Regression 2026-10-09: the >70%-uppercase rule missed mixed segments
    from the streaming model ("POPPY vào trong"), leaving shouted tokens in
    the transcript. Any 2+ uppercase run means the model emitted this segment.
    """
    from local_stt import _maybe_lowercase_allcaps

    assert _maybe_lowercase_allcaps("POPPY vào trong") == "poppy vào trong"
    assert _maybe_lowercase_allcaps("NHƯNG TUY NHIÊN Ở OCB") == "nhưng tuy nhiên ở ocb"
    # Already-proper text (cloud providers) is left alone.
    assert _maybe_lowercase_allcaps("Poppy vào trong") == "Poppy vào trong"
    assert _maybe_lowercase_allcaps("Chạy lí từ các đối tác") == "Chạy lí từ các đối tác"


# ── Repeat-stall guard (streaming transducer can loop on long audio) ─────────
def test_collapse_repeats_kills_phrase_stall():
    """Reported bug 2026-10-09: a long unbroken segment made the streaming
    model emit the same phrase over and over, flooding the transcript."""
    from local_stt import _collapse_repeats

    spam = " ".join(["Poppy vào trong cái capid đó"] * 8)
    assert _collapse_repeats(spam) == "Poppy vào trong cái capid đó"
    assert _collapse_repeats("đúng rồi " * 5) == "đúng rồi"


def test_collapse_repeats_caps_token_stall_at_two():
    from local_stt import _collapse_repeats

    assert _collapse_repeats("nó nó nó nó nó nó") == "nó nó"
    assert _collapse_repeats("là là là là") == "là là"


def test_collapse_repeats_preserves_vietnamese_reduplication():
    """Two identical words in a row is normal Vietnamese (từ láy) — kept."""
    from local_stt import _collapse_repeats

    for natural in ("rất rất thích", "từ từ đã", "nó nó"):
        assert _collapse_repeats(natural) == natural


def test_collapse_repeats_leaves_ordinary_speech_untouched():
    from local_stt import _collapse_repeats

    sentence = "Poppy vào trong cái capid đó đúng không thì cái đấy nó là một cái tình huống"
    assert _collapse_repeats(sentence) == sentence


def test_interim_preview_is_normalised_like_final():
    """Regression 2026-10-09: the interim preview showed RAW recognizer output
    (unpunctuated ALL-CAPS) while committed finals were normalised — the live
    row looked broken next to finished rows."""
    from local_stt import _postprocess_local

    raw = "À MẤY CÁI ÔNG GIÁO SƯ ĐẠI HỌC ÔNG LÀM CÁI GÌ"
    shown = _postprocess_local(raw, "vi")

    assert shown != raw, "interim text must go through post-processing"
    letters = [c for c in shown if c.isalpha()]
    upper_ratio = sum(c.isupper() for c in letters) / len(letters)
    assert upper_ratio < 0.3, f"interim still shouting: {shown!r}"
    assert shown.startswith("À"), "sentence case restored"
