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

import re
import subprocess
import sys
import threading
import time
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
    """Lowercase sherpa output so the VI normalizer can re-capitalize properly.

    Both bundled sherpa Vietnamese models (offline Zipformer + streaming
    Zipformer) emit unpunctuated ALL-CAPS text. Mixed-case input from cloud
    providers is left untouched.

    The old rule required >70% of letters to be uppercase, which missed
    real streaming segments that mix cases — e.g. "POPPY vào trong" (capital
    letters are only 5/16). A segment counts as model output when it has NO
    lowercase-only word that is already properly capitalized... in practice
    the reliable signal is: any run of 2+ consecutive uppercase letters means
    the model shouted this segment and it should be normalized.
    """
    alpha = [c for c in text if c.isalpha()]
    if not alpha:
        return text
    upper_ratio = sum(c.isupper() for c in alpha) / len(alpha)
    if upper_ratio > 0.7:
        return text.lower()
    # Partial-shout case: the model emitted an uppercase token inside a
    # lowercase sentence ("POPPY vào trong"). Two or more consecutive
    # uppercase letters is not normal Vietnamese prose, so normalize the whole
    # segment (the normalizer restores sentence-case afterwards).
    if re.search(r"[A-ZĐÂĂÊÔƠƯÁÀẢÃẠẤẦẨẪẬẮẰẲẴẶÉÈẺẼẸẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌỐỒỔỖỘỚỜỞỠỢÚÙỦŨỤỨỪỬỮỰÝỲỶỸỴ]{2,}", text):
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


class StreamingZipformerEngine(LocalSTTEngine):
    """sherpa-onnx ONLINE (streaming) transducer — Vietnamese Zipformer-30M RNNT.

    Unlike SherpaOnnxEngine (offline, one-shot per segment), this keeps
    decode state across feed() calls, so recognition starts while the speaker
    is still talking. ~33x realtime on CPU (measured on a 6.7min VI meeting).
    """

    SAMPLE_RATE = 16000

    def __init__(self, model_dir: Path):
        import sherpa_onnx

        model_dir = Path(model_dir)
        self._recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=str(model_dir / "tokens.txt"),
            encoder=str(model_dir / "encoder.fp16.onnx"),
            decoder=str(model_dir / "decoder.fp16.onnx"),
            joiner=str(model_dir / "joiner.fp16.onnx"),
            num_threads=2,
            sample_rate=self.SAMPLE_RATE,
            feature_dim=80,
            # Endpoint rules: close an utterance after 2.4s trailing silence,
            # or 1.2s when the decoder already produced something decodable,
            # or force-cut a 300-frame monologue. Tuned for meeting speech.
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=2.4,
            rule2_min_trailing_silence=1.2,
            rule3_min_utterance_length=300,
            decoding_method="greedy_search",
        )
        self._stream = self._recognizer.create_stream()
        log.info("LOADED: streaming Zipformer (online) from %s", model_dir.name)

    def accept(self, pcm_float32: np.ndarray) -> None:
        self._stream.accept_waveform(self.SAMPLE_RATE, pcm_float32)
        while self._recognizer.is_ready(self._stream):
            self._recognizer.decode_stream(self._stream)

    def is_endpoint(self) -> bool:
        return self._recognizer.is_endpoint(self._stream)

    def partial_text(self, language: str = "vi") -> str:
        """Interim text for the live preview — post-processed like a final.

        Regression 2026-10-09: this returned the RAW recognizer output, so the
        interim row on screen was unpunctuated ALL-CAPS ("À MẤY CÁI ÔNG GIÁO
        SƯ…") while committed finals looked normal. The interim preview must go
        through the same cleanup (lowercase → VI normalize → repeat collapse).
        """
        raw = (self._recognizer.get_result(self._stream) or "").strip()
        return _postprocess_local(raw, language)

    def finalize(self, language: str = "vi") -> str:
        """Return the finished utterance text and reset for the next one."""
        text = self.partial_text(language)
        self._recognizer.reset(self._stream)
        return text

    def transcribe_pcm(self, pcm_float32: np.ndarray, language: str = "vi") -> str:
        """Whole-buffer convenience path (one utterance, then reset)."""
        self.accept(pcm_float32)
        return self.finalize(language)


def _collapse_repeats(text: str) -> str:
    """Collapse runaway repetition from the streaming transducer.

    RNNT models occasionally enter a repeat loop on long/unclear audio. Two
    shapes were observed in the wild:
      - single-token stall:  "nó nó nó nó nó …"
      - phrase stall:        "Poppy vào trong cái capid đó Poppy vào trong …"
    We collapse immediate repeats of the same token to at most 2 (keeping
    natural Vietnamese reduplication like "rất rất", "từ từ") and cut a
    repeated multi-word cycle down to a single occurrence. Consecutive
    identical sentences are dropped too.
    """
    if not text:
        return text

    tokens = text.split()

    # 1) Collapse an immediate repeating CYCLE of length 2..12 (phrase stall).
    #    A cycle of length 1 is deliberately NOT collapsed here: a single word
    #    said twice is normal Vietnamese reduplication ("rất rất", "từ từ",
    #    "nó nó"), while 3+ identical words is a stall — handled in step 2.
    if len(tokens) >= 4:
        collapsed: list[str] = []
        i = 0
        while i < len(tokens):
            found = False
            # Longest cycle first so a 6-word phrase wins over a shorter match
            # inside it.
            for size in range(min(12, len(collapsed), len(tokens) - i), 1, -1):
                prev = [t.lower() for t in collapsed[-size:]]
                nxt = [t.lower() for t in tokens[i : i + size]]
                if len(nxt) == size and prev == nxt:
                    i += size          # skip the duplicated cycle
                    found = True
                    break
            if not found:
                collapsed.append(tokens[i])
                i += 1
        tokens = collapsed

    # 2) Cap a single token repeated 3+ times in a row at 2 occurrences
    #    (keeps "rất rất", kills "nó nó nó nó").
    if len(tokens) >= 3:
        capped: list[str] = []
        for tok in tokens:
            if (
                len(capped) >= 2
                and capped[-1].lower() == tok.lower()
                and capped[-2].lower() == tok.lower()
            ):
                continue
            capped.append(tok)
        tokens = capped

    text = " ".join(tokens)

    # 2) Sentence-level: drop consecutive identical sentences.
    parts = re.split(r"(?<=[.!?…])\s+", text)
    if len(parts) > 1:
        deduped: list[str] = []
        for s in parts:
            if deduped and s.strip().lower() == deduped[-1].strip().lower():
                continue
            deduped.append(s)
        text = " ".join(deduped)

    return text


def _postprocess_local(text: str, language: str = "vi") -> str:
    """Shared text cleanup for local engines (case + VI normalization)."""
    if not text:
        return ""
    text = _collapse_repeats(text)
    text = _maybe_lowercase_allcaps(text)
    if language.startswith("vi"):
        text = normalize_vietnamese_text(text)
    return filter_hallucinations(text)


# Streaming engine cache (one recognizer per model dir — load is expensive).
_STREAM_ENGINE_CACHE: dict[str, StreamingZipformerEngine] = {}


def get_stream_engine(model_dir: Path) -> StreamingZipformerEngine:
    key = str(model_dir)
    engine = _STREAM_ENGINE_CACHE.get(key)
    if engine is None:
        engine = StreamingZipformerEngine(model_dir)
        _STREAM_ENGINE_CACHE[key] = engine
    return engine


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
    _SILENCE_RMS = 380.0           # below → treat frame as silence
    # Partial results are pushed at most this often (interim UI preview).
    _PARTIAL_INTERVAL_S = 0.8

    def __init__(self, language: str = "vi"):
        import queue

        self._language = language
        self._in: "queue.Queue" = queue.Queue()
        self._out: "queue.Queue" = queue.Queue()
        self._stopped = False
        self._worker: threading.Thread | None = None
        self._tail = bytearray()     # leftover partial frame
        self._engine: StreamingZipformerEngine | None = None
        self._model_dir: Path | None = None
        self._last_partial = ""
        self._last_partial_at = 0.0

    # — lifecycle —
    def start(self) -> None:
        """Load the model FIRST, then start consuming audio.

        Regression 2026-10-09: the worker used to load the model asynchronously
        (~2s) while `feed_audio` already queued PCM. Every queued chunk that
        arrived before the load finished hit `if self._engine is None: continue`
        and was DROPPED — the first seconds of every recording vanished (and a
        short recording could lose all of it, producing an empty transcript).
        Loading synchronously here means once start() returns, no audio is lost.
        """
        self._stopped = False
        self._model_dir = self._resolve_model_dir()
        if self._model_dir is not None:
            try:
                self._engine = get_stream_engine(self._model_dir)
            except Exception as exc:
                log.warning("FAILED: streaming Zipformer init: %s", exc)
                self._engine = None
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()
        log.info("STARTED: local realtime STT (streaming Zipformer, lang=%s)", self._language)

    def _resolve_model_dir(self) -> Path | None:
        """Streaming Zipformer dir, bundled first (see model_registry)."""
        from local.model_registry import streaming_model_dir

        hit = streaming_model_dir()
        if hit is None:
            log.warning("FAILED: streaming Zipformer model not found (bundled or cache)")
        return hit

    def _run(self) -> None:
        while True:
            item = self._in.get()
            if item is None:
                break
            pcm_bytes, is_final_flush = item
            if self._engine is None:
                # start() loads synchronously, so this only happens if the model
                # was genuinely unavailable — nothing we can transcribe with.
                continue
            try:
                self._engine.accept(_pcm_int16_to_float32(pcm_bytes))
                endpoint = self._engine.is_endpoint()
                if endpoint:
                    text = self._engine.finalize(self._language)
                    if text:
                        self._out.put({"text": text, "is_final": True})
                    self._last_partial = ""
                else:
                    partial = self._engine.partial_text(self._language)
                    now = time.time()
                    if (
                        partial
                        and partial != self._last_partial
                        and now - self._last_partial_at >= self._PARTIAL_INTERVAL_S
                    ):
                        self._last_partial = partial
                        self._last_partial_at = now
                        self._out.put({"text": partial, "is_final": False})
                if is_final_flush:
                    # Stream closing — emit whatever is decoded so nothing is lost.
                    text = self._engine.finalize(self._language)
                    if text:
                        self._out.put({"text": text, "is_final": True})
            except Exception as exc:
                log.warning("FAILED: local realtime transcribe: %s", exc)
        self._out.put(None)

    # — feed —
    def feed_audio(self, pcm_bytes: bytes) -> None:
        """Queue PCM at frame granularity; the worker streams it to the model."""
        if self._stopped or not pcm_bytes:
            return
        self._tail.extend(pcm_bytes)
        n = len(self._tail) - (len(self._tail) % self._FRAME_BYTES)
        if n <= 0:
            return
        frames = bytes(self._tail[:n])
        self._tail = self._tail[n:]
        self._in.put((frames, False))

    def stop(self) -> None:
        self._stopped = True
        if self._tail:
            self._in.put((bytes(self._tail), True))
            self._tail.clear()
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
