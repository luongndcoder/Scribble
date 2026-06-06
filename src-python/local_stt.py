"""Local/offline STT engine (Tier C) — sherpa-onnx Vietnamese transducer.

Phase 1 wraps sherpa-onnx's OfflineRecognizer around the bundled Vietnamese
Zipformer model. It implements the same *batch* contract the upload pipeline
already uses for cloud providers:

    transcribe_local_file(path, language) -> str

No streaming class in Phase 1 (sherpa has no Vietnamese online model); realtime
recording falls back to cloud (see main.py routing).

Tier A (MLX) / Tier B (CUDA-ONNX) engines arrive in Phase 2/3; until then every
platform uses this bundled Tier C model.
"""

import subprocess
import sys
from pathlib import Path

import numpy as np

from local.model_registry import model_path_or_none, resolve
from logger import get_logger
# Reuse cloud-path text helpers so local output matches existing post-processing.
from stt import _strip_wav_header, filter_hallucinations, normalize_vietnamese_text

log = get_logger(__name__)


def _pcm_int16_to_float32(pcm_bytes: bytes) -> np.ndarray:
    """Convert raw little-endian 16-bit PCM to float32 samples in [-1, 1)."""
    ints = np.frombuffer(pcm_bytes, dtype="<i2")
    return (ints.astype(np.float32) / 32768.0).copy()


def _maybe_lowercase_allcaps(text: str) -> str:
    """The sherpa Vietnamese model emits ALL-CAPS, no punctuation. Lowercase it
    first so the downstream Vietnamese normalizer can capitalize sentence starts
    instead of mistaking every short word for an acronym (RỒI/CŨNG/HỖ → kept).

    Mixed-case input (e.g. cloud providers) is left untouched.
    """
    alpha = [c for c in text if c.isalpha()]
    if alpha and sum(c.isupper() for c in alpha) / len(alpha) > 0.7:
        return text.lower()
    return text


class LocalSTTEngine:
    """Base interface for a local STT engine."""

    def transcribe_pcm(self, pcm_float32: np.ndarray, language: str) -> str:
        raise NotImplementedError

    def close(self) -> None:
        pass


class SherpaOnnxEngine(LocalSTTEngine):
    """sherpa-onnx offline transducer recognizer (Vietnamese)."""

    def __init__(self, model_dir: Path):
        # Lazy import: sherpa_onnx is a heavy native dep, only needed when the
        # local provider is actually used (keeps test/import paths light).
        import sherpa_onnx

        model_dir = Path(model_dir)
        self._recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            tokens=str(model_dir / "tokens.txt"),
            encoder=str(model_dir / "encoder.int8.onnx"),
            decoder=str(model_dir / "decoder.onnx"),
            joiner=str(model_dir / "joiner.int8.onnx"),
            num_threads=4,
            sample_rate=16000,
            feature_dim=80,
            decoding_method="greedy_search",
        )
        log.info("LOADED: local STT engine sherpa-onnx from %s", model_dir.name)

    def transcribe_pcm(self, pcm_float32: np.ndarray, language: str) -> str:
        stream = self._recognizer.create_stream()
        stream.accept_waveform(16000, pcm_float32)
        self._recognizer.decode_stream(stream)
        text = _maybe_lowercase_allcaps((stream.result.text or "").strip())
        if language.startswith("vi"):
            text = normalize_vietnamese_text(text)
        return filter_hallucinations(text)


# Engine cache — building a recognizer is expensive (loads ONNX sessions); reuse
# one per model dir across chunks/requests.
_ENGINE_CACHE: dict[str, SherpaOnnxEngine] = {}


def get_engine(model_dir: Path) -> SherpaOnnxEngine:
    key = str(model_dir)
    engine = _ENGINE_CACHE.get(key)
    if engine is None:
        engine = SherpaOnnxEngine(model_dir)
        _ENGINE_CACHE[key] = engine
    return engine


def _normalize_to_pcm16(file_path: str) -> bytes:
    """Decode any audio file to raw 16kHz mono 16-bit PCM via bundled ffmpeg."""
    from services.audio import find_ffmpeg

    wav_path = file_path + "_local.wav"
    ffmpeg_bin = find_ffmpeg()
    kwargs: dict = {"capture_output": True, "timeout": 60}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        result = subprocess.run(
            [ffmpeg_bin, "-y", "-i", file_path, "-ar", "16000", "-ac", "1", "-f", "wav", wav_path],
            **kwargs,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr.decode(errors='replace')[:200]}")
        with open(wav_path, "rb") as f:
            wav_bytes = f.read()
    finally:
        try:
            Path(wav_path).unlink()
        except OSError:
            pass
    return _strip_wav_header(wav_bytes)


def transcribe_local_file(file_path: str, language: str = "vi") -> str:
    """Transcribe an audio file fully offline using the bundled Tier C model.

    Phase 1 always uses the Tier C sherpa model (the only engine shipped); tier
    dispatch (MLX / CUDA) is added in Phase 2/3.

    Raises:
        RuntimeError: when the local model is not available on disk.
    """
    spec = resolve("C")
    model_dir = model_path_or_none(spec)
    if model_dir is None:
        raise RuntimeError(
            "Model local chưa sẵn sàng — cài lại app hoặc tải model offline."
        )

    pcm = _normalize_to_pcm16(file_path)
    if not pcm:
        return ""
    engine = get_engine(model_dir)
    return engine.transcribe_pcm(_pcm_int16_to_float32(pcm), language)
