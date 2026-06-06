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


# ── Tier A — MLX nemotron (macOS Apple Silicon) ──────────────────────────────
MLX_REPO = "mlx-community/nemotron-3.5-asr-streaming-0.6b-8bit"

_mlx_available_cache: bool | None = None


def _mlx_available() -> bool:
    """True if mlx-audio is importable (Apple Silicon only). Cached."""
    global _mlx_available_cache
    if _mlx_available_cache is None:
        try:
            import mlx_audio.stt  # noqa: F401

            _mlx_available_cache = True
        except Exception:
            _mlx_available_cache = False
    return _mlx_available_cache


class MlxNemotronEngine(LocalSTTEngine):
    """nemotron-3.5-asr via mlx-audio (Apple Silicon). The model auto-downloads
    from HuggingFace on first use and caches under ~/.cache/huggingface."""

    def __init__(self, repo: str = MLX_REPO):
        from mlx_audio.stt import load

        self._model = load(repo)
        log.info("LOADED: local STT engine MLX nemotron (%s)", repo)

    def transcribe_file(self, wav_path: str, language: str = "vi") -> str:
        result = self._model.generate(wav_path)
        text = (getattr(result, "text", "") or "").strip()
        # nemotron already emits proper case + punctuation → only filter.
        return filter_hallucinations(text)

    def transcribe_pcm(self, pcm_float32: np.ndarray, language: str = "vi") -> str:
        raise NotImplementedError("MLX engine transcribes via file; use transcribe_file")


_mlx_engine: MlxNemotronEngine | None = None


def get_mlx_engine() -> MlxNemotronEngine:
    global _mlx_engine
    if _mlx_engine is None:
        _mlx_engine = MlxNemotronEngine()
    return _mlx_engine


# ── audio normalization ──────────────────────────────────────────────────────
def _ffmpeg_to_wav16(file_path: str) -> str:
    """Decode any audio file to a temp 16kHz mono WAV. Caller deletes the file."""
    from services.audio import find_ffmpeg

    wav_path = file_path + "_local.wav"
    ffmpeg_bin = find_ffmpeg()
    kwargs: dict = {"capture_output": True, "timeout": 60}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    result = subprocess.run(
        [ffmpeg_bin, "-y", "-i", file_path, "-ar", "16000", "-ac", "1", "-f", "wav", wav_path],
        **kwargs,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode(errors='replace')[:200]}")
    return wav_path


def _normalize_to_pcm16(file_path: str) -> bytes:
    """Decode any audio file to raw 16kHz mono 16-bit PCM via bundled ffmpeg."""
    wav_path = _ffmpeg_to_wav16(file_path)
    try:
        with open(wav_path, "rb") as f:
            wav_bytes = f.read()
    finally:
        try:
            Path(wav_path).unlink()
        except OSError:
            pass
    return _strip_wav_header(wav_bytes)


def _active_tier() -> str:
    """Device tier used to select the local engine. Separated for testability."""
    from local.device_detect import detect_tier

    return detect_tier()


def _transcribe_tier_a(file_path: str, language: str) -> str:
    wav_path = _ffmpeg_to_wav16(file_path)
    try:
        return get_mlx_engine().transcribe_file(wav_path, language)
    finally:
        try:
            Path(wav_path).unlink()
        except OSError:
            pass


def transcribe_local_file(file_path: str, language: str = "vi") -> str:
    """Transcribe an audio file fully offline, picking the engine by device tier.

    Tier A (macOS Apple Silicon + MLX available) → nemotron MLX (auto-downloads).
    Otherwise → bundled Tier C sherpa-onnx (also the fallback when MLX missing).

    Raises:
        RuntimeError: when no local engine/model is available.
    """
    if _active_tier() == "A" and _mlx_available():
        return _transcribe_tier_a(file_path, language)

    spec = resolve("C")
    model_dir = model_path_or_none(spec)
    if model_dir is None:
        raise RuntimeError(
            "Model local chưa sẵn sàng — cài lại app hoặc tải model offline."
        )
    pcm = _normalize_to_pcm16(file_path)
    if not pcm:
        return ""
    return get_engine(model_dir).transcribe_pcm(_pcm_int16_to_float32(pcm), language)
