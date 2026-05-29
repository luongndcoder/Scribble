"""
STT module — Multi-provider speech-to-text

Providers:
  - Nvidia Riva (gRPC streaming)
  - Soniox (WebSocket streaming, built-in speaker diarization)

Nvidia Models:
  - Vietnamese (vi-VN): Parakeet CTC 0.6B Vietnamese
  - Chinese (zh-CN): Parakeet CTC 0.6B Chinese  
  - All others: Parakeet 1.1B RNNT Multilingual
"""

import os
import re
import subprocess
import sys
import time
from pathlib import Path

from logger import get_logger

log = get_logger(__name__)

# Hallucination patterns
HALLUCINATION_PATTERNS = [
    r"hãy subscribe cho kênh",
    r"ghiền mì gõ",
    r"để không bỏ lỡ nh[uư]ng video hấp dẫn",
    r"đừng quên like và subscribe",
    r"nhấn nút đăng ký",
    r"cảm ơn các bạn đã theo dõi",
    r"hãy đăng ký kênh",
    r"xin chào các bạn.*kênh",
    r"hẹn gặp lại.*video",
    r"like.*share.*subscribe",
    r"thank you for watching",
    r"please subscribe",
    r"like and subscribe",
    r"don'?t forget to subscribe",
    r"hit the bell",
    r"©.*all rights reserved",
    r"subtitles? by",
    r"www\.\w+\.\w+",
    r"^meeting\.?$",
    r"^meeting discussion\.?$",
    r"^cuộc họp công việc\.?$",
    r"^\.+$",
    r"^,+$",
]


# ─── Nvidia Model Routing ───
NVIDIA_MODELS = {
    "vi-VN": {
        "function_id": "f3dff2bb-99f9-403d-a5f1-f574a757deb0",
        "name": "Parakeet CTC 0.6B Vietnamese",
    },
    "zh-CN": {
        "function_id": "9add5ef7-322e-47e0-ad7a-5653fb8d259b",
        "name": "Parakeet CTC 0.6B Chinese",
    },
}
NVIDIA_MULTILINGUAL = {
    "function_id": "71203149-d3b7-4460-8231-1be2543a1fca",
    "name": "Parakeet 1.1B RNNT Multilingual",
}

# Supported languages for the multilingual model
MULTILINGUAL_LANGUAGES = {
    "en-US", "en-GB", "es-ES", "es-US", "ar-AR",
    "pt-BR", "pt-PT", "fr-FR", "fr-CA", "de-DE",
    "it-IT", "ja-JP", "ko-KR", "ru-RU", "hi-IN",
    "he-IL", "nb-NO", "nn-NO", "nl-NL", "cs-CZ",
    "da-DK", "pl-PL", "sv-SE", "th-TH", "tr-TR",
}


def get_nvidia_model(language: str) -> dict:
    """Get the correct Nvidia model config for a language code."""
    if language in NVIDIA_MODELS:
        return NVIDIA_MODELS[language]
    return NVIDIA_MULTILINGUAL


def get_language_code(stt_language: str) -> str:
    """Convert user-facing language setting to Riva language code.
    
    Input may be: 'vi', 'en', 'ja', 'vi-VN', 'en-US', etc.
    """
    if not stt_language:
        return "vi-VN"  # Default
    
    # Already in full format
    if "-" in stt_language and len(stt_language) >= 4:
        return stt_language
    
    # Map short codes to full codes
    SHORT_TO_FULL = {
        "vi": "vi-VN",
        "en": "en-US",
        "ja": "ja-JP",
        "ko": "ko-KR",
        "zh": "zh-CN",
        "fr": "fr-FR",
        "de": "de-DE",
        "es": "es-ES",
        "th": "th-TH",
        "pt": "pt-BR",
        "it": "it-IT",
        "ru": "ru-RU",
        "hi": "hi-IN",
        "he": "he-IL",
        "nb": "nb-NO",
        "nn": "nn-NO",
        "nl": "nl-NL",
        "cs": "cs-CZ",
        "da": "da-DK",
        "pl": "pl-PL",
        "sv": "sv-SE",
        "tr": "tr-TR",
        "ar": "ar-AR",
    }
    return SHORT_TO_FULL.get(stt_language, "vi-VN")


# ─── Nvidia Riva Client Cache (per function_id + api_key prefix) ───
_riva_asr_cache: dict = {}


def _make_cache_key(api_key: str, function_id: str) -> str:
    return f"{function_id}:{api_key[:8]}"


def _get_riva_asr(api_key: str, function_id: str):
    """Get or create cached Nvidia Riva ASR service for a specific model."""
    global _riva_asr_cache
    cache_key = _make_cache_key(api_key, function_id)
    if cache_key in _riva_asr_cache:
        return _riva_asr_cache[cache_key]

    from riva.client import ASRService, Auth

    riva_url = os.getenv("NVIDIA_RIVA_URL", "grpc.nvcf.nvidia.com:443")
    log.info("[stt:nvidia] Connecting to %s with function-id %s", riva_url, function_id)
    auth = Auth(
        use_ssl=True,
        uri=riva_url,
        metadata_args=[
            ["function-id", function_id],
            ["authorization", f"Bearer {api_key}"],
        ],
    )
    asr = ASRService(auth)
    _riva_asr_cache[cache_key] = asr
    return asr


def _reset_riva_asr(function_id: str = None):
    """Reset cached ASR service (e.g. after connection error or API key change)."""
    global _riva_asr_cache
    if function_id:
        # Remove all cache entries matching this function_id prefix
        keys_to_remove = [k for k in _riva_asr_cache if k.startswith(function_id)]
        for k in keys_to_remove:
            _riva_asr_cache.pop(k, None)
    else:
        _riva_asr_cache.clear()


def transcribe_nvidia(file_path: str, api_key: str, language: str = "vi-VN") -> str:
    """Transcribe via Nvidia Riva Cloud gRPC.
    
    Automatically selects the correct model based on language.
    Audio max 30s, converted to WAV PCM 16kHz mono.
    """
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY not set")

    model = get_nvidia_model(language)
    log.info("[stt:nvidia] Using %s for %s", model['name'], language)

    # Convert to WAV PCM 16kHz mono (Riva requires this format)
    # Use find_ffmpeg() not bare "ffmpeg" — when launched from Finder the
    # bundled app inherits a stripped PATH that excludes /opt/homebrew/bin.
    from services.audio import find_ffmpeg
    wav_path = file_path + "_riva.wav"
    ffmpeg_bin = find_ffmpeg()
    try:
        result = subprocess.run(
            [ffmpeg_bin, "-y", "-i", file_path, "-ar", "16000", "-ac", "1", "-f", "wav", wav_path],
            capture_output=True, timeout=10,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {result.stderr.decode(errors='replace')[:200]}")
    except FileNotFoundError:
        raise RuntimeError("ffmpeg not found — install ffmpeg")

    try:
        with open(wav_path, "rb") as f:
            audio_data = f.read()
    finally:
        try:
            os.unlink(wav_path)
        except Exception:
            pass

    asr = _get_riva_asr(api_key, model["function_id"])

    # Build recognition config
    from riva.client import RecognitionConfig, AudioEncoding
    config = RecognitionConfig()
    config.encoding = AudioEncoding.LINEAR_PCM
    config.sample_rate_hertz = 16000
    config.language_code = language
    config.max_alternatives = 1
    config.enable_automatic_punctuation = True
    config.audio_channel_count = 1

    try:
        response = asr.offline_recognize(audio_data, config)
    except Exception as e:
        _reset_riva_asr(model["function_id"])
        raise

    text = ""
    for r in response.results:
        if r.alternatives:
            text += r.alternatives[0].transcript + " "
    text = text.strip()

    if language.startswith("vi"):
        text = normalize_vietnamese_text(text)
    text = filter_hallucinations(text)
    return text


def transcribe_nvidia_streaming(file_path: str, api_key: str, language: str = "vi-VN") -> str:
    """Transcribe a finite audio file via Nvidia Riva STREAMING gRPC.

    Why this exists alongside transcribe_nvidia (offline_recognize):
      Riva Cloud does not expose the Vietnamese / Chinese Parakeet models in
      offline mode — they return INVALID_ARGUMENT
      "Unavailable model … type=offline". Streaming mode works for those
      languages, so the batch upload pipeline drives the same gRPC stream
      realtime recording uses, just fed from a file instead of a mic.

    Audio is normalized to WAV PCM 16kHz mono, the RIFF header is stripped,
    and the raw PCM is yielded in ~320ms chunks through
    streaming_response_generator. Final results are concatenated.
    """
    if not api_key:
        raise RuntimeError("NVIDIA_API_KEY not set")

    model = get_nvidia_model(language)
    log.info("[stt:nvidia-stream-batch] %s for %s", model["name"], language)

    # Normalize to 16kHz mono PCM WAV (Riva contract).
    # find_ffmpeg() not bare "ffmpeg" — bundled app launch path lacks
    # /opt/homebrew/bin so subprocess.run(["ffmpeg", ...]) returns
    # FileNotFoundError every chunk and the whole pipeline silently
    # produces an empty transcript. (Hit by user during testing.)
    from services.audio import find_ffmpeg
    wav_path = file_path + "_riva_stream.wav"
    ffmpeg_bin = find_ffmpeg()
    kwargs: dict = {"capture_output": True, "timeout": 30}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        result = subprocess.run(
            [ffmpeg_bin, "-y", "-i", file_path, "-ar", "16000", "-ac", "1", "-f", "wav", wav_path],
            **kwargs,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg failed: {result.stderr.decode(errors='replace')[:200]}"
            )
    except FileNotFoundError:
        raise RuntimeError("ffmpeg not found — install ffmpeg")

    try:
        with open(wav_path, "rb") as f:
            wav_bytes = f.read()
    finally:
        try:
            os.unlink(wav_path)
        except Exception:
            pass

    pcm = _strip_wav_header(wav_bytes)
    if not pcm:
        return ""

    asr = _get_riva_asr(api_key, model["function_id"])

    from riva.client import (
        AudioEncoding,
        RecognitionConfig,
        StreamingRecognitionConfig,
    )

    config = RecognitionConfig()
    config.encoding = AudioEncoding.LINEAR_PCM
    config.sample_rate_hertz = 16000
    config.language_code = language
    config.max_alternatives = 1
    config.enable_automatic_punctuation = True
    config.audio_channel_count = 1

    streaming_config = StreamingRecognitionConfig()
    streaming_config.config.CopyFrom(config)
    streaming_config.interim_results = False  # batch — finals only

    # 320ms of 16kHz mono 16-bit PCM = 16000 * 0.32 * 2 = 10_240 bytes
    CHUNK_BYTES = 10_240

    def _audio_iter():
        for i in range(0, len(pcm), CHUNK_BYTES):
            yield pcm[i : i + CHUNK_BYTES]

    try:
        responses = asr.streaming_response_generator(
            audio_chunks=_audio_iter(),
            streaming_config=streaming_config,
        )
        pieces: list[str] = []
        for response in responses:
            if not response.results:
                continue
            for r in response.results:
                if not r.is_final or not r.alternatives:
                    continue
                t = (r.alternatives[0].transcript or "").strip()
                if t:
                    pieces.append(t)
    except Exception:
        # Reset cached ASR so a stale stream/auth doesn't poison the next call.
        _reset_riva_asr(model["function_id"])
        raise

    text = " ".join(pieces).strip()
    if language.startswith("vi"):
        text = normalize_vietnamese_text(text)
    text = filter_hallucinations(text)
    return text


# ── Soniox 2-step upload pattern (v1.2.14) ───────────────────────────────
# Splits the old single-call transcribe_soniox_file into 3 distinct phases:
#   A) upload_soniox_file(path) → file_id      [POST /v1/files, multipart]
#   B) transcribe_soniox_file_id(file_id, ...) → segments
#         B.1 POST /v1/transcriptions {file_id, config} [cheap JSON ~1KB]
#         B.2 GET /v1/transcriptions/{id}   (poll loop, in-poll retry)
#         B.3 GET /v1/transcriptions/{id}/transcript
#   delete_soniox_file(file_id)                [DELETE /v1/files/{id}]
#
# Why split: a 5xx during create-job or poll no longer forces re-upload of
# 200MB. The retry loop in upload_pipeline.py caches file_id across attempts,
# so transient errors after Phase A only cost a ~1KB JSON retry.
#
# Phase-specific exceptions let the chunk retry loop decide:
#   - SonioxUploadError → reset cached_file_id, redo Phase A on next attempt
#   - SonioxJobError / SonioxPollError → keep file_id, retry only Phase B
# Outer caller is responsible for calling delete_soniox_file() once the
# retry loop ends (success OR exhausted) so no orphan files on Soniox.


class SonioxUploadError(Exception):
    """Phase A failure — file upload to Soniox failed. Retry will re-upload."""
    pass


class SonioxJobError(Exception):
    """Phase B.1 failure — Soniox refused to create transcription job. file_id
    still valid; retry only needs to re-POST the JSON create request."""
    pass


class SonioxPollError(Exception):
    """Phase B.2 failure — exhausted in-poll retries while polling for
    completion. file_id + transcription_id still valid (the job MAY still be
    running on Soniox side); a fresh transcription create with the same
    file_id can resume work without re-upload."""
    pass


# In-poll resilience: tolerate N consecutive network errors before bubbling
# up as SonioxPollError. Each retry backs off linearly (3s, 6s, 9s, 12s, 15s)
# capped so a brief wifi outage during the poll window doesn't kill the job.
_POLL_MAX_CONSECUTIVE_NETWORK_ERRORS = 5
_POLL_BACKOFF_BASE_SEC = 3.0
_POLL_BACKOFF_CAP_SEC = 30.0


def upload_soniox_file(
    file_path: str,
    api_key: str,
    *,
    progress_cb=None,
) -> str:
    """Phase A — upload audio file to Soniox Files API, return file_id.

    Caller is responsible for cleanup via delete_soniox_file() once the
    file_id is no longer needed (after successful transcribe + parse, OR
    after the retry loop finally exhausts).

    Raises SonioxUploadError on any failure. The retry loop in
    upload_pipeline.py catches this and forces a re-upload on next attempt.
    """
    if not api_key:
        raise SonioxUploadError("Soniox API key chưa được cấu hình")

    from pathlib import Path

    from soniox import SonioxClient

    filename = Path(file_path).name
    log.info("[stt:soniox-async] Phase A — uploading %s", filename)
    client = SonioxClient(api_key=api_key)

    if progress_cb is not None:
        try: progress_cb(0.0, None, None, stage="upload")
        except Exception: pass

    try:
        uploaded = client.files.upload(file_path, filename=filename)
        file_id = uploaded.id
    except Exception as exc:
        # Wrap so caller can distinguish upload failure from job/poll failure.
        log.warning("[stt:soniox-async] Phase A upload failed: %s", exc)
        raise SonioxUploadError(f"Upload failed: {exc}") from exc

    if progress_cb is not None:
        try: progress_cb(0.10, None, None, stage="upload_done")
        except Exception: pass

    log.info("[stt:soniox-async] Phase A done — file_id=%s", file_id)
    return file_id


def delete_soniox_file(api_key: str, file_id: str) -> None:
    """Best-effort delete of an uploaded Soniox file. Errors are logged but
    never raised — cleanup failure must not mask the real outcome of the
    transcription pipeline."""
    if not file_id or not api_key:
        return
    try:
        from soniox import SonioxClient
        client = SonioxClient(api_key=api_key)
        client.files.delete(file_id)
        log.info("[stt:soniox-async] deleted file_id=%s", file_id)
    except Exception as exc:
        log.warning("[stt:soniox-async] file delete failed (non-fatal): %s", exc)


def _classify_poll_error(exc: BaseException) -> bool:
    """Return True if a poll-time exception is a transient network blip
    (worth retrying in-place) vs a hard error (bubble up immediately)."""
    type_name = type(exc).__name__.lower()
    msg = str(exc).lower()
    if any(s in type_name for s in (
        "timeout", "connection", "network", "dns", "socket",
        "readerror", "connecterror", "connecttimeout", "readtimeout",
    )):
        return True
    if any(s in msg for s in (
        "connection", "timeout", "timed out", "network", "unreachable",
        "reset by peer", "broken pipe", "ssl", "handshake",
    )):
        return True
    # 5xx + 429 are transient; 4xx auth/format are hard.
    if any(code in msg for code in ("429", "500", "502", "503", "504")):
        return True
    return False


def transcribe_soniox_file_id(
    file_id: str,
    api_key: str,
    language_hints: list[str] | None = None,
    *,
    progress_cb=None,
) -> list[dict]:
    """Phase B — create transcription job + poll for completion + parse
    segments, using an EXISTING uploaded file_id. Does NOT upload, does NOT
    delete the file. Caller manages file_id lifecycle.

    Raises:
      - SonioxJobError: failed to create the transcription job (Phase B.1).
        file_id still valid; caller may retry with same file_id.
      - SonioxPollError: poll loop exhausted consecutive network errors OR
        polling deadline busted. file_id + transcription_id still valid.
      - RuntimeError: Soniox reported status=error (transcription itself
        failed semantically — bad audio, internal error). file_id valid but
        retrying will likely fail the same way.
    """
    if not api_key:
        raise SonioxJobError("Soniox API key chưa được cấu hình")
    if not file_id:
        raise SonioxJobError("Missing file_id — Phase A must run first")

    from soniox import SonioxClient
    from soniox.types import CreateTranscriptionConfig

    hints = language_hints or ["vi"]
    log.info(
        "[stt:soniox-async] Phase B — file_id=%s, language_hints=%s, diarization=ON",
        file_id, hints,
    )
    client = SonioxClient(api_key=api_key)
    config = CreateTranscriptionConfig(
        model="stt-async-v4",
        language_hints=hints,
        enable_speaker_diarization=True,
        enable_language_identification=False,
    )

    # ── Phase B.1: CREATE JOB (cheap JSON POST) ─────────────────────────
    try:
        transcription = client.stt.transcribe(file_id=file_id, config=config)
    except Exception as exc:
        log.warning("[stt:soniox-async] Phase B.1 create-job failed: %s", exc)
        raise SonioxJobError(f"Create transcription failed: {exc}") from exc

    transcription_id = transcription.id
    log.info("[stt:soniox-async] Phase B.1 done — transcription_id=%s", transcription_id)

    # ── Phase B.2: POLL with in-poll retry ──────────────────────────────
    # Adaptive polling deadline same as before — extends once Soniox reveals
    # audio_duration_ms. SONIOX_THROUGHPUT_X = 10x conservative.
    import time as _time

    SONIOX_THROUGHPUT_X = 10.0
    job_start_time = _time.time()
    deadline = job_start_time + 1800.0
    deadline_extended = False
    last_progress = 0.0
    consecutive_network_errors = 0

    while _time.time() < deadline:
        try:
            t = client.stt.get(transcription_id)
            consecutive_network_errors = 0  # reset on successful poll
        except Exception as exc:
            # In-poll retry: tolerate brief network blips without killing the
            # job. The job stays alive on Soniox side regardless of our poll
            # connectivity, so a 30s wifi outage shouldn't lose 200MB upload.
            if not _classify_poll_error(exc):
                # Hard error — bubble up immediately (e.g. 401 from key
                # rotation, 404 if Soniox somehow lost the job).
                log.warning("[stt:soniox-async] Phase B.2 poll HARD-failed: %s", exc)
                raise SonioxPollError(f"Poll failed: {exc}") from exc

            consecutive_network_errors += 1
            if consecutive_network_errors >= _POLL_MAX_CONSECUTIVE_NETWORK_ERRORS:
                log.warning(
                    "[stt:soniox-async] Phase B.2 exhausted %d consecutive poll errors — bubbling up",
                    _POLL_MAX_CONSECUTIVE_NETWORK_ERRORS,
                )
                raise SonioxPollError(
                    f"Poll exhausted {_POLL_MAX_CONSECUTIVE_NETWORK_ERRORS} retries: {exc}"
                ) from exc

            # Linear backoff capped at 30s (3s → 6s → 9s → 12s → 15s).
            backoff = min(
                _POLL_BACKOFF_BASE_SEC * consecutive_network_errors,
                _POLL_BACKOFF_CAP_SEC,
            )
            log.info(
                "[stt:soniox-async] Phase B.2 poll blip %d/%d, backing off %.0fs: %s",
                consecutive_network_errors, _POLL_MAX_CONSECUTIVE_NETWORK_ERRORS,
                backoff, exc,
            )
            _time.sleep(backoff)
            continue

        status_str = str(getattr(t, "status", None))
        if status_str.endswith("completed") or status_str == "completed":
            transcription = t
            break
        if status_str.endswith("error") or status_str == "error":
            err = getattr(t, "error_message", None) or "Soniox transcription failed"
            # Soniox-side hard failure (bad audio, model error) — NOT a network
            # issue, retry won't help. Raise plain RuntimeError so classifier
            # picks it up as 'hard' and skips retries.
            raise RuntimeError(err)

        audio_ms = getattr(t, "audio_duration_ms", None) or 0
        audio_dur_sec = audio_ms / 1000.0 if audio_ms > 0 else None

        if audio_dur_sec is not None and not deadline_extended:
            deadline = job_start_time + max(1800.0, audio_dur_sec / 5.0 + 1800.0)
            deadline_extended = True

        if progress_cb is not None:
            # Phase B maps to 0.10-0.95 of the overall progress range so
            # the UI can keep its "upload 0-10% → transcribe 10-95% → done
            # 100%" mental model.
            if audio_dur_sec is not None:
                expected_total_sec = max(audio_dur_sec / SONIOX_THROUGHPUT_X, 1.0)
                elapsed = _time.time() - job_start_time
                local_p = min(0.95, elapsed / expected_total_sec)
                eta_remaining_sec = max(0.0, expected_total_sec - elapsed)
                # Re-scale to 0.10-0.95 band of the outer progress.
                progress = 0.10 + local_p * (0.95 - 0.10)
            else:
                # Still queued — inch up slowly inside the 0.10-0.15 band.
                progress = min(0.15, last_progress + 0.005)
                eta_remaining_sec = None

            last_progress = progress
            try:
                progress_cb(progress, audio_dur_sec, eta_remaining_sec, stage="transcribe")
            except Exception:
                pass
        _time.sleep(3.0)
    else:
        raise SonioxPollError(f"Polling deadline exceeded (>{int(deadline - job_start_time)}s)")

    # ── Phase B.3: FETCH TRANSCRIPT ─────────────────────────────────────
    try:
        result = client.stt.get_transcript(transcription_id)
    except Exception as exc:
        # Final fetch failed — treat as poll-stage error so caller may retry
        # with same file_id (fresh job will produce same transcript).
        log.warning("[stt:soniox-async] Phase B.3 get_transcript failed: %s", exc)
        raise SonioxPollError(f"Get transcript failed: {exc}") from exc

    if progress_cb is not None:
        try: progress_cb(1.0, None, 0.0, stage="done")
        except Exception: pass

    # Best-effort cleanup of transcription record (NOT the file — caller owns).
    try:
        client.stt.delete(transcription_id)
    except Exception as cleanup_exc:
        log.warning("[stt:soniox-async] transcription cleanup failed (non-fatal): %s", cleanup_exc)

    return _parse_soniox_segments(result)


# Segment-split thresholds — defensive measure khi Soniox diarization fail
# (toàn bộ chunk gán cùng 1 speaker → segment khổng lồ vài chục phút).
# Chia theo natural pause (gap) + hard cap duration để UI render được.
_SEGMENT_GAP_SPLIT_MS = 2000       # 2s silence = natural turn/sentence break
_SEGMENT_MAX_DURATION_MS = 60_000  # 1 phút — hard cap kể cả speaker liên tục


def _parse_soniox_segments(result) -> list[dict]:
    """Group consecutive same-speaker tokens into segments.

    Result format: [{"start_ms", "end_ms", "text", "speaker"}, ...]
    Hallucination filter applied per segment.

    Splits on:
      1. Speaker change (primary)
      2. Gap ≥ 2s giữa 2 tokens kế tiếp (natural pause — defensive against
         Soniox diarization fail khi gán cùng speaker cho toàn chunk)
      3. Segment duration ≥ 60s (hard UI cap — speaker nói liên tục không
         nghỉ vẫn phải break để UI render + scroll được)
    """
    tokens = list(result.tokens or [])
    segments: list[dict] = []
    cur_speaker: str | None = None
    cur_start: int | None = None
    cur_end: int | None = None
    cur_pieces: list[str] = []

    def _flush():
        if cur_pieces and cur_start is not None and cur_end is not None:
            text = "".join(cur_pieces).strip()
            text = filter_hallucinations(text)
            if text:
                segments.append({
                    "start_ms": int(cur_start),
                    "end_ms": int(cur_end),
                    "text": text,
                    "speaker": str(cur_speaker or "1"),
                })

    for token in tokens:
        text_piece = getattr(token, "text", "") or ""
        if text_piece in ("<end>", ""):
            continue
        speaker = getattr(token, "speaker", None)
        speaker = str(speaker) if speaker is not None else "1"
        start_ms = getattr(token, "start_ms", None)
        end_ms = getattr(token, "end_ms", None)
        if start_ms is None or end_ms is None:
            continue

        if cur_speaker is None:
            cur_speaker = speaker
            cur_start = start_ms
            cur_end = end_ms
            cur_pieces = [text_piece]
            continue

        # Compute gap from previous token end → this token start, and current
        # segment duration if extended. Both are NON-NEGATIVE in practice
        # (Soniox tokens are time-sorted) but clamp to 0 to be safe.
        gap_ms = max(0, start_ms - cur_end) if cur_end is not None else 0
        seg_dur_ms = max(0, end_ms - cur_start) if cur_start is not None else 0

        should_split = (
            speaker != cur_speaker
            or gap_ms >= _SEGMENT_GAP_SPLIT_MS
            or seg_dur_ms >= _SEGMENT_MAX_DURATION_MS
        )

        if should_split:
            _flush()
            cur_speaker = speaker
            cur_start = start_ms
            cur_end = end_ms
            cur_pieces = [text_piece]
        else:
            cur_pieces.append(text_piece)
            cur_end = end_ms

    _flush()
    log.info(
        "[stt:soniox-async] parsed %d segments from %d tokens (%d distinct speakers)",
        len(segments), len(tokens),
        len({s["speaker"] for s in segments}),
    )
    return segments


def transcribe_soniox_file(
    file_path: str,
    api_key: str,
    language_hints: list[str] | None = None,
    *,
    progress_cb=None,
) -> list[dict]:
    """Convenience wrapper: upload + transcribe + cleanup in one call.
    No retry-friendly file_id reuse — callers that need that should call
    upload_soniox_file() and transcribe_soniox_file_id() separately.
    """
    file_id = upload_soniox_file(file_path, api_key, progress_cb=progress_cb)
    try:
        return transcribe_soniox_file_id(file_id, api_key, language_hints, progress_cb=progress_cb)
    finally:
        delete_soniox_file(api_key, file_id)


def _strip_wav_header(wav_bytes: bytes) -> bytes:
    """Return raw PCM payload of a RIFF/WAVE buffer.

    Falls back to a fixed 44-byte skip (or the full buffer) when the RIFF
    structure is malformed.
    """
    if len(wav_bytes) < 44 or wav_bytes[:4] != b"RIFF":
        return wav_bytes
    idx = wav_bytes.find(b"data", 12)
    if idx < 0 or idx + 8 > len(wav_bytes):
        return wav_bytes[44:]
    try:
        size = int.from_bytes(wav_bytes[idx + 4 : idx + 8], "little")
    except Exception:
        return wav_bytes[idx + 8 :]
    start = idx + 8
    end = min(start + size, len(wav_bytes))
    return wav_bytes[start:end]


class NvidiaStreamingSTT:
    """Real-time streaming STT via Nvidia Riva gRPC.

    Frontend sends raw PCM 16kHz mono audio chunks via WebSocket.
    This class feeds them to Riva streaming gRPC and yields partial/final results.
    Automatically selects model based on language.
    """

    def __init__(self, api_key: str, language: str = "vi-VN"):
        self._api_key = api_key
        self._language = language
        self._model = get_nvidia_model(language)
        self._audio_queue = None
        self._stopped = False
        self._response_gen = None
        self._streaming_config = None
        log.info("[stt:nvidia-stream] Using %s for %s", self._model['name'], language)

    def _audio_generator(self):
        import queue as q
        while True:
            try:
                chunk = self._audio_queue.get(timeout=0.5)
                if chunk is None:
                    break
                yield chunk
            except q.Empty:
                if self._stopped:
                    break

    def start(self):
        import queue
        from riva.client import StreamingRecognitionConfig, RecognitionConfig, AudioEncoding

        self._audio_queue = queue.Queue()
        self._stopped = False

        asr = _get_riva_asr(self._api_key, self._model["function_id"])

        config = RecognitionConfig()
        config.encoding = AudioEncoding.LINEAR_PCM
        config.sample_rate_hertz = 16000
        config.language_code = self._language
        config.max_alternatives = 1
        config.enable_automatic_punctuation = True
        config.audio_channel_count = 1

        streaming_config = StreamingRecognitionConfig()
        streaming_config.config.CopyFrom(config)
        streaming_config.interim_results = True
        self._streaming_config = streaming_config

        self._response_gen = self._create_response_generator()

    def _create_response_generator(self):
        asr = _get_riva_asr(self._api_key, self._model["function_id"])
        if self._streaming_config is None:
            raise RuntimeError("Nvidia streaming config not initialized")
        return asr.streaming_response_generator(
            audio_chunks=self._audio_generator(),
            streaming_config=self._streaming_config,
        )

    def feed_audio(self, pcm_bytes: bytes):
        if self._audio_queue and not self._stopped:
            self._audio_queue.put(pcm_bytes)

    def stop(self):
        self._stopped = True
        if self._audio_queue:
            self._audio_queue.put(None)

    def results(self):
        if not self._response_gen:
            return
        retries = 0
        max_retries = 3

        while not self._stopped:
            try:
                for response in self._response_gen:
                    retries = 0
                    if not response.results:
                        continue
                    for result in response.results:
                        if not result.alternatives:
                            continue
                        transcript = result.alternatives[0].transcript.strip()
                        if not transcript:
                            continue
                        is_final = result.is_final
                        # Always normalize Vietnamese (fixes Riva's random capitalization)
                        if self._language.startswith("vi"):
                            transcript = normalize_vietnamese_text(transcript)
                        if is_final:
                            transcript = filter_hallucinations(transcript)
                            if not transcript:
                                continue
                        yield {"text": transcript, "is_final": is_final}

                if self._stopped:
                    return
                raise RuntimeError("Nvidia stream ended unexpectedly")
            except Exception as e:
                if self._stopped:
                    return

                retries += 1
                # Extract detailed gRPC error info
                err_msg = str(e)
                try:
                    import grpc
                    if isinstance(e, grpc.RpcError):
                        err_msg = f"code={e.code()}, details={e.details()}"
                except Exception:
                    pass
                log.warning("[stt:nvidia-stream] Error: %s", err_msg)
                log.warning("[stt:nvidia-stream] Model: %s, Lang: %s, FuncID: %s", self._model['name'], self._language, self._model['function_id'])
                _reset_riva_asr(self._model["function_id"])

                if retries > max_retries:
                    log.info("[stt:nvidia-stream] Max reconnect retries reached, stopping stream")
                    return

                backoff = min(1.0 * retries, 3.0)
                log.info("[stt:nvidia-stream] Reconnecting in %.1fs (%d/%d)...", backoff, retries, max_retries)
                time.sleep(backoff)

                try:
                    self._response_gen = self._create_response_generator()
                    log.info("[stt:nvidia-stream] Reconnected")
                except Exception as reconnect_err:
                    log.warning("[stt:nvidia-stream] Reconnect failed: %s", reconnect_err)


# ─── Soniox Language Hints ───
# Soniox accepts ISO language codes like 'vi', 'en', 'zh', etc.
# No mapping needed — pass codes directly.


class SonioxStreamingSTT:
    """Real-time streaming STT via Soniox WebSocket.

    Follows official Soniox SDK pattern:
    - Audio queued via feed_audio() and exposed as an iterator
    - start_audio_thread(session, iterator) sends audio on background thread
    - receive_events() runs on the calling thread (results generator)
    """

    # Soniox stt-rt-v4 has a server-side session duration cap (default ~1h
    # depending on plan). When the cap fires, the server closes the WS and our
    # event iterator just exits silently. We auto-reconnect up to this many
    # times before surfacing a hard error to the user.
    MAX_RECONNECT_ATTEMPTS = 8

    def __init__(self, api_key: str, language_hints: list[str] | None = None, translate_lang: str = ""):
        self._api_key = api_key
        self._language_hints = language_hints or ["vi"]
        self._translate_lang = translate_lang
        self._stopped = False
        self._session = None
        self._client = None
        self._audio_queue = None
        # Cumulative ms of audio processed across ALL completed sessions in
        # this stream. Added to every yielded start_ms / end_ms so the timeline
        # the frontend sees stays continuous across auto-reconnects.
        self._cumulative_offset_ms = 0
        log.info("[stt:soniox-stream] language_hints=%s, translate_lang='%s'", self._language_hints, translate_lang)

    def _audio_iter(self):
        """Yield audio chunks from the queue as an iterator (for send_bytes).

        Each call returns a FRESH generator — when a session reconnects we
        start a new audio thread bound to a new generator. The old generator
        is GC'd after its thread dies.
        """
        import queue
        while not self._stopped:
            try:
                chunk = self._audio_queue.get(timeout=0.5)
                if chunk is None:
                    break
                yield chunk
            except queue.Empty:
                continue

    def _open_session(self):
        """Open a Soniox real-time session and start a fresh audio thread.

        Idempotent w.r.t. the audio queue — the queue is created once in
        start() and reused across reconnects so frames already buffered from
        the frontend during a server-side close get drained into the new WS
        instead of dropped.
        """
        from soniox.types import RealtimeSTTConfig, TranslationConfig
        from soniox.utils import start_audio_thread

        config = RealtimeSTTConfig(
            model="stt-rt-v4",
            audio_format="pcm_s16le",
            sample_rate=16000,
            num_channels=1,
            enable_endpoint_detection=True,
            enable_speaker_diarization=True,
            language_hints=self._language_hints,
        )
        if self._translate_lang:
            config.translation = TranslationConfig(
                type="one_way",
                target_language=self._translate_lang,
            )

        self._session = self._client.realtime.stt.connect(config=config)
        self._session.__enter__()
        # Start a NEW audio thread per session — previous one died when the
        # old WS closed (send_byte_chunk raised SonioxRealtimeError). A fresh
        # thread re-reads from the same queue so buffered audio is preserved.
        start_audio_thread(self._session, self._audio_iter())

    def _close_session(self):
        """Best-effort close of the current Soniox session."""
        if self._session is None:
            return
        try:
            self._session.__exit__(None, None, None)
        except Exception:
            pass
        self._session = None

    def start(self):
        """Initialize Soniox client and open the first real-time session."""
        import queue
        from soniox import SonioxClient

        self._audio_queue = queue.Queue(maxsize=500)
        self._stopped = False
        self._cumulative_offset_ms = 0

        self._client = SonioxClient(api_key=self._api_key)

        if self._translate_lang:
            log.info("[stt:soniox-stream] Translation enabled: one_way -> %s", self._translate_lang)

        self._open_session()
        log.info("[stt:soniox-stream] Session opened (audio thread started)")

    def feed_audio(self, pcm_bytes: bytes):
        """Enqueue raw PCM audio for sending to Soniox (thread-safe)."""
        if self._audio_queue and not self._stopped:
            try:
                self._audio_queue.put_nowait(pcm_bytes)
            except Exception:
                pass  # Queue full — drop frame

    def stop(self):
        """Signal stop and close the session."""
        self._stopped = True
        if self._audio_queue:
            try:
                self._audio_queue.put_nowait(None)  # Signal iterator to stop
            except Exception:
                pass
        if self._session:
            try:
                self._session.__exit__(None, None, None)
            except Exception:
                pass
            self._session = None

    def results(self):
        """Blocking generator that yields transcript results from Soniox.

        Per-token streaming with proper speaker-change handling AND
        automatic session reconnect for long meetings:
        - Process each token sequentially; current_speaker updates IMMEDIATELY
          when a final token from a new speaker arrives (the previous version
          only updated current_speaker at end-of-event, so tokens mid-event
          from a different speaker got mis-attributed to the last speaker).
        - On speaker change, flush the accumulated segment (yielding its full
          text under the OLD speaker) and start a fresh chunk_id for the new
          one. Frontend `sameChunk` then produces a new transcript block.
        - Each segment carries its own `start_ms` / `end_ms` (from the actual
          Soniox token offsets, plus the cumulative offset across reconnects)
          so the UI shows accurate time ranges instead of falling back to the
          recording-timer's current second.
        - Each event also re-yields the in-progress segment so non-final
          tokens flow into the UI live (frontend `replaceLastPartText`).
        - When Soniox's server-side session-duration cap fires (default ~1h
          per plan), the WS closes silently. We detect this, flush whatever
          was accumulated under the old session, emit an `info` heartbeat so
          the frontend knows we're reconnecting, then open a fresh session
          and continue. `_cumulative_offset_ms` is incremented by the prior
          session's processed-audio length so the timeline stays continuous.
        """
        if not self._session:
            return

        import time
        from uuid import uuid4

        reconnect_attempts = 0
        # Outer loop = one iteration per Soniox session (we auto-reconnect on
        # server-side close as long as the user hasn't stopped recording).
        while not self._stopped:
            # Per-session state — reset on every (re)connect.
            accumulated_final = []
            accumulated_translation = []
            current_speaker = -1
            current_chunk_id = f"soniox-{int(time.time() * 1000)}-{uuid4().hex[:6]}"
            segment_start_ms = None
            segment_end_ms = None
            # Highest `total_audio_proc_ms` we saw from Soniox in THIS session.
            # When the session ends, this is added to _cumulative_offset_ms so
            # the next session's token offsets are shifted into a continuous
            # timeline.
            session_max_total_ms = 0
            event_count = 0

            try:
                for event in self._session.receive_events():
                    if self._stopped:
                        return

                    event_count += 1
                    # Track furthest audio Soniox has processed so we can
                    # correctly offset the next session if we reconnect.
                    tot = getattr(event, 'total_audio_proc_ms', None)
                    if tot is not None:
                        try:
                            session_max_total_ms = max(session_max_total_ms, int(tot))
                        except (TypeError, ValueError):
                            pass

                    # Check for server errors (e.g. 402 balance exhausted,
                    # auth failure). These are TERMINAL — don't reconnect.
                    err_code = getattr(event, 'error_code', None)
                    if err_code:
                        error_msg = f"Soniox error {err_code}: {getattr(event, 'error_message', '')}"
                        log.warning("[stt:soniox-stream] %s", error_msg)
                        yield {
                            "text": error_msg,
                            "is_final": True,
                            "speaker": "System",
                            "speaker_id": -1,
                            "error": True,
                        }
                        return

                    n_tokens = len(event.tokens) if event.tokens else 0
                    finished = getattr(event, 'finished', False)
                    if event_count <= 5 or event_count % 50 == 0:
                        log.debug("[stt:soniox-stream] event#%d tokens=%d finished=%s", event_count, n_tokens, finished)

                    if not event.tokens:
                        continue

                    non_final = []
                    non_final_translation = []
                    # Track the latest end_ms across non-final tokens so the
                    # live display reflects the running edge of the segment.
                    latest_non_final_end_ms = None

                    for token in event.tokens:
                        speaker_id = int(getattr(token, "speaker", 0) or 0)
                        token_text = str(token.text) if token.text is not None else ""
                        if token_text in ("<end>", ""):
                            continue

                        # Separate translation tokens from STT tokens
                        translation_status = getattr(token, "translation_status", "none") or "none"
                        if translation_status == "translation":
                            if token.is_final:
                                accumulated_translation.append(token_text)
                            else:
                                non_final_translation.append(token_text)
                            continue

                        # STT tokens (translation_status: "none" or "original")
                        tok_start = getattr(token, "start_ms", None)
                        tok_end = getattr(token, "end_ms", None)
                        if tok_start is not None:
                            tok_start = int(tok_start)
                        if tok_end is not None:
                            tok_end = int(tok_end)

                        if token.is_final:
                            # First-ever final token: just adopt its speaker.
                            if current_speaker == -1:
                                current_speaker = speaker_id

                            # Speaker change INSIDE the event: flush whatever's
                            # been accumulated under the OLD speaker before we
                            # touch the new token. Without this, tokens from
                            # S1 and S2 within the same event used to collapse
                            # onto whichever speaker happened to be last.
                            elif speaker_id != current_speaker and accumulated_final:
                                full_text = "".join(accumulated_final).strip()
                                if full_text:
                                    log.info(
                                        "[stt:soniox-stream] Speaker change mid-event: S%d -> S%d, flushing: '%s...'",
                                        current_speaker + 1, speaker_id + 1, full_text[:50],
                                    )
                                    result = self._build_segment_result(
                                        full_text, current_chunk_id, current_speaker,
                                        segment_start_ms, segment_end_ms,
                                        accumulated_translation,
                                    )
                                    yield result

                                # Reset for the new speaker's segment
                                accumulated_final = []
                                accumulated_translation = []
                                segment_start_ms = None
                                segment_end_ms = None
                                current_chunk_id = f"soniox-{int(time.time() * 1000)}-{uuid4().hex[:6]}"
                                current_speaker = speaker_id

                            # Update current_speaker even when no flush
                            # happened (token's speaker_id matches existing,
                            # or we just initialized from -1).
                            current_speaker = speaker_id

                            # Track segment time range from actual token offsets
                            if tok_start is not None and segment_start_ms is None:
                                segment_start_ms = tok_start
                            if tok_end is not None:
                                segment_end_ms = tok_end

                            accumulated_final.append(token_text)
                        else:
                            non_final.append(token_text)
                            if tok_end is not None:
                                latest_non_final_end_ms = tok_end

                    # Build display text: all final so far + current non-final
                    display_text = "".join(accumulated_final + non_final).strip()
                    if not display_text:
                        continue

                    translation_text = "".join(accumulated_translation + non_final_translation).strip()

                    # Resolve display end_ms: prefer the live non-final token's
                    # offset so the time range grows in real time while the
                    # user is still speaking. Fall back to the latest final
                    # token's end_ms otherwise.
                    display_end_ms = (
                        latest_non_final_end_ms if latest_non_final_end_ms is not None
                        else segment_end_ms
                    )

                    # Yield with same chunk_id -> frontend replaceLastPartText
                    yield self._build_segment_result(
                        display_text, current_chunk_id, current_speaker,
                        segment_start_ms, display_end_ms,
                        accumulated_translation, extra_translation=non_final_translation,
                    )

                # Inner for-loop ended naturally — server closed the WS.
                # Flush whatever was still accumulating under this session
                # BEFORE we decide to reconnect (so partial text isn't lost).
                if accumulated_final:
                    full_text = "".join(accumulated_final).strip()
                    if full_text:
                        yield self._build_segment_result(
                            full_text, current_chunk_id, current_speaker,
                            segment_start_ms, segment_end_ms,
                            accumulated_translation,
                        )

                # Session is over. Reconnect or terminate?
                if self._stopped:
                    return

                # Soniox closed the WS unexpectedly (likely session-duration
                # cap, occasionally network blip). Auto-reconnect with the
                # cumulative time offset so the timeline stays continuous.
                reconnect_attempts += 1
                if reconnect_attempts > self.MAX_RECONNECT_ATTEMPTS:
                    log.error(
                        "[stt:soniox-stream] Exceeded %d reconnect attempts, giving up",
                        self.MAX_RECONNECT_ATTEMPTS,
                    )
                    yield {
                        "text": (
                            f"Soniox reconnect failed sau {self.MAX_RECONNECT_ATTEMPTS} lần. "
                            "Vui lòng dừng và bắt đầu ghi âm lại."
                        ),
                        "is_final": True,
                        "speaker": "System",
                        "speaker_id": -1,
                        "error": True,
                    }
                    return

                self._cumulative_offset_ms += session_max_total_ms
                log.warning(
                    "[stt:soniox-stream] Session closed by server after %d ms processed (cumulative=%.1f min). Reconnecting (%d/%d)...",
                    session_max_total_ms,
                    self._cumulative_offset_ms / 60000.0,
                    reconnect_attempts,
                    self.MAX_RECONNECT_ATTEMPTS,
                )

                # Heartbeat to the frontend so the UI can show "reconnecting"
                # state instead of looking frozen.
                yield {
                    "type": "info",
                    "text": "Soniox session reconnecting...",
                    "is_final": False,
                    "speaker": "System",
                    "speaker_id": -1,
                    "info": True,
                }

                self._close_session()
                # Exponential backoff capped at 5s — usually reconnects on
                # the first try because the server-side close is intentional.
                backoff = min(0.5 * (2 ** (reconnect_attempts - 1)), 5.0)
                time.sleep(backoff)

                if self._stopped:
                    return

                try:
                    self._open_session()
                    log.info("[stt:soniox-stream] Reconnected successfully (attempt %d)", reconnect_attempts)
                except Exception as reopen_exc:
                    log.error("[stt:soniox-stream] Reopen failed (attempt %d): %s", reconnect_attempts, reopen_exc, exc_info=True)
                    # Loop continues — next iteration of outer while will
                    # call receive_events() on a None session and fall
                    # through to the reconnect path again until we hit cap.
                    self._session = None
                    continue

            except Exception as e:
                if self._stopped:
                    return
                log.error("[stt:soniox-stream] Unexpected error in event loop: %s", e, exc_info=True)
                # Treat as a closed session — try to reconnect rather than
                # leaving the stream dead.
                reconnect_attempts += 1
                if reconnect_attempts > self.MAX_RECONNECT_ATTEMPTS:
                    yield {
                        "text": f"Soniox error after {self.MAX_RECONNECT_ATTEMPTS} retries: {e}",
                        "is_final": True,
                        "speaker": "System",
                        "speaker_id": -1,
                        "error": True,
                    }
                    return
                self._cumulative_offset_ms += session_max_total_ms
                self._close_session()
                time.sleep(min(0.5 * (2 ** (reconnect_attempts - 1)), 5.0))
                if self._stopped:
                    return
                try:
                    self._open_session()
                except Exception:
                    self._session = None
                    continue

    def _build_segment_result(
        self,
        text: str,
        chunk_id: str,
        speaker_id: int,
        start_ms,
        end_ms,
        accumulated_translation: list,
        extra_translation: list | None = None,
    ) -> dict:
        """Pack a segment into the WS payload shape, applying the cumulative
        cross-session time offset so timestamps remain continuous after a
        reconnect."""
        speaker_label = (
            f"Speaker {speaker_id + 1}" if speaker_id >= 0 else "Speaker 1"
        )
        result = {
            "text": text,
            "is_final": True,
            "chunk_id": chunk_id,
            "speaker": speaker_label,
            "speaker_id": max(0, speaker_id),
        }
        if start_ms is not None:
            result["start_ms"] = int(start_ms) + self._cumulative_offset_ms
        if end_ms is not None:
            result["end_ms"] = int(end_ms) + self._cumulative_offset_ms
        tl_parts = list(accumulated_translation)
        if extra_translation:
            tl_parts = tl_parts + list(extra_translation)
        tl_text = "".join(tl_parts).strip()
        if tl_text:
            result["translation"] = tl_text
        return result


def filter_hallucinations(text: str) -> str:
    """Filter out hallucinated text from STT output."""
    if not text:
        return ""
    for pattern in HALLUCINATION_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return ""
    if len(text) <= 3:
        return ""
    return text


def normalize_vietnamese_text(text: str) -> str:
    """Fix Nvidia Riva's incorrect capitalization for Vietnamese.
    
    Strategy: lowercase everything, only capitalize first word of each sentence.
    Keep acronyms (all-caps 2-5 chars) like AI, CNTT, ASEAN.
    """
    if not text:
        return text
    
    sentences = re.split(r'(?<=[.!?])\s+', text)
    result = []
    
    for sentence in sentences:
        if not sentence:
            continue
        
        words = sentence.split()
        if not words:
            continue
        
        normalized = []
        for i, word in enumerate(words):
            # Keep acronyms (all-caps, 2-5 chars)
            if word.isupper() and 2 <= len(word) <= 5:
                normalized.append(word)
            elif i == 0:
                # Capitalize first word of sentence
                normalized.append(word[0].upper() + word[1:].lower() if len(word) > 1 else word.upper())
            else:
                normalized.append(word.lower())
        
        result.append(' '.join(normalized))
    
    return ' '.join(result)

