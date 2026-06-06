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
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from local.model_registry import model_path_or_none, resolve
from logger import get_logger
# Reuse cloud-path text helpers so local output matches existing post-processing.
from stt import _strip_wav_header, filter_hallucinations, get_language_code, normalize_vietnamese_text

log = get_logger(__name__)


def _pcm_int16_to_float32(pcm_bytes: bytes) -> np.ndarray:
    """Convert raw little-endian 16-bit PCM to float32 samples in [-1, 1)."""
    ints = np.frombuffer(pcm_bytes, dtype="<i2")
    return (ints.astype(np.float32) / 32768.0).copy()


def _rms_int16(frame: bytes) -> float:
    """Root-mean-square amplitude of a 16-bit PCM frame (0..32768)."""
    a = np.frombuffer(frame, dtype="<i2").astype(np.float32)
    if a.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(a * a)))


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
        # nemotron is multilingual (39 locales). "" / "auto" → let it auto-detect;
        # otherwise pin the locale (e.g. "vi" → "vi-VN") for best accuracy.
        locale = None if (not language or language == "auto") else get_language_code(language)
        result = self._model.generate(wav_path, language=locale)
        text = (getattr(result, "text", "") or "").strip()
        # nemotron already emits proper case + punctuation → only filter.
        return filter_hallucinations(text)

    def transcribe_pcm(self, pcm_float32: np.ndarray, language: str = "vi") -> str:
        """Transcribe an in-memory float32 PCM segment (16kHz mono)."""
        import mlx.core as mx

        locale = None if (not language or language == "auto") else get_language_code(language)
        result = self._model.generate(mx.array(pcm_float32), language=locale)
        text = (getattr(result, "text", "") or "").strip()
        return filter_hallucinations(text)


_mlx_engine: MlxNemotronEngine | None = None

# MLX Metal streams are THREAD-LOCAL: the model must be created and every
# generate() must run on the SAME thread, or mx.eval raises "There is no
# Stream(gpu, N) in current thread". The upload pipeline runs STT chunks on a
# multi-thread pool, so we funnel all MLX work onto one dedicated worker thread.
_MLX_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx-stt")


def get_mlx_engine() -> MlxNemotronEngine:
    global _mlx_engine
    if _mlx_engine is None:
        _mlx_engine = MlxNemotronEngine()
    return _mlx_engine


class LocalStreamingSTT:
    """Near-realtime offline STT for live recording (Tier A nemotron MLX).

    Buffers incoming 16kHz mono PCM, uses energy-based VAD to cut a segment when
    a speech run is followed by enough trailing silence (or hits the max length),
    then transcribes each segment with nemotron on the dedicated MLX thread.
    Emits final-only results (no per-token interim). Matches the
    start()/feed_audio()/stop()/results() interface the WS handler expects.
    """

    SAMPLE_RATE = 16000
    _FRAME_SAMPLES = 320            # 20ms @ 16kHz
    _FRAME_BYTES = _FRAME_SAMPLES * 2
    _FRAME_MS = 20.0
    _SILENCE_RMS = 380.0           # below → treat frame as silence
    _SILENCE_HANG_MS = 700.0       # trailing silence that closes a segment
    _MIN_SEG_MS = 800.0            # ignore shorter blips
    _MAX_SEG_MS = 18000.0          # force-cut long monologue

    def __init__(self, language: str = "vi"):
        import queue

        self._language = language
        self._in: "queue.Queue" = queue.Queue()
        self._out: "queue.Queue" = queue.Queue()
        self._stopped = False
        self._worker: threading.Thread | None = None
        self._seg = bytearray()      # current speech segment (PCM bytes)
        self._tail = bytearray()     # leftover partial frame
        self._silence_ms = 0.0
        self._has_speech = False

    # — lifecycle —
    def start(self) -> None:
        self._stopped = False
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()
        log.info("STARTED: local realtime STT (nemotron MLX, lang=%s)", self._language)

    def _run(self) -> None:
        while True:
            seg = self._in.get()
            if seg is None:
                break
            samples = _pcm_int16_to_float32(seg)
            try:
                fut = _MLX_EXECUTOR.submit(
                    lambda s=samples: get_mlx_engine().transcribe_pcm(s, self._language)
                )
                text = fut.result()
            except Exception as exc:
                log.warning("FAILED: local realtime transcribe: %s", exc)
                text = ""
            if text:
                self._out.put({"text": text, "is_final": True})
        self._out.put(None)

    # — feed/segment —
    def feed_audio(self, pcm_bytes: bytes) -> None:
        if self._stopped or not pcm_bytes:
            return
        self._tail.extend(pcm_bytes)
        n = len(self._tail) - (len(self._tail) % self._FRAME_BYTES)
        if n <= 0:
            return
        frames = self._tail[:n]
        self._tail = self._tail[n:]
        for i in range(0, len(frames), self._FRAME_BYTES):
            frame = bytes(frames[i : i + self._FRAME_BYTES])
            self._seg.extend(frame)
            if _rms_int16(frame) < self._SILENCE_RMS:
                self._silence_ms += self._FRAME_MS
            else:
                self._silence_ms = 0.0
                self._has_speech = True
            seg_ms = (len(self._seg) / 2) / self.SAMPLE_RATE * 1000.0
            if self._has_speech and (
                (self._silence_ms >= self._SILENCE_HANG_MS and seg_ms >= self._MIN_SEG_MS)
                or seg_ms >= self._MAX_SEG_MS
            ):
                self._flush_segment()
            elif not self._has_speech and seg_ms >= 2000.0:
                # Pure-silence buffer — discard to bound memory, keep a short tail.
                self._seg.clear()
                self._silence_ms = 0.0

    def _flush_segment(self) -> None:
        seg = bytes(self._seg)
        self._seg.clear()
        self._silence_ms = 0.0
        had_speech = self._has_speech
        self._has_speech = False
        if had_speech and (len(seg) / 2) / self.SAMPLE_RATE * 1000.0 >= self._MIN_SEG_MS:
            self._in.put(seg)

    def stop(self) -> None:
        self._stopped = True
        if self._seg:
            self._flush_segment()
        self._in.put(None)

    def results(self):
        while True:
            r = self._out.get()
            if r is None:
                return
            yield r


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
        # Run model load + generate on the single dedicated MLX thread so all
        # Metal stream ops stay on one thread (avoids cross-thread Stream error
        # when the pipeline transcribes chunks in parallel).
        future = _MLX_EXECUTOR.submit(
            lambda: get_mlx_engine().transcribe_file(wav_path, language)
        )
        return future.result()
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
