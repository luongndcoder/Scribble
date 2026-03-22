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


# ─── Nvidia Riva Client Cache (per function_id) ───
_riva_asr_cache: dict = {}  # function_id -> ASRService


def _get_riva_asr(api_key: str, function_id: str):
    """Get or create cached Nvidia Riva ASR service for a specific model."""
    global _riva_asr_cache
    if function_id in _riva_asr_cache:
        return _riva_asr_cache[function_id]
    
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
    _riva_asr_cache[function_id] = asr
    return asr


def _reset_riva_asr(function_id: str = None):
    """Reset cached ASR service (e.g. after connection error)."""
    global _riva_asr_cache
    if function_id:
        _riva_asr_cache.pop(function_id, None)
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
    wav_path = file_path + "_riva.wav"
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", file_path, "-ar", "16000", "-ac", "1", "-f", "wav", wav_path],
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

    def __init__(self, api_key: str, language_hints: list[str] | None = None, translate_lang: str = ""):
        self._api_key = api_key
        self._language_hints = language_hints or ["vi"]
        self._translate_lang = translate_lang
        self._stopped = False
        self._session = None
        self._client = None
        self._audio_queue = None
        log.info("[stt:soniox-stream] language_hints=%s, translate_lang='%s'", self._language_hints, translate_lang)

    def _audio_iter(self):
        """Yield audio chunks from the queue as an iterator (for send_bytes)."""
        import queue
        while not self._stopped:
            try:
                chunk = self._audio_queue.get(timeout=0.5)
                if chunk is None:
                    break
                yield chunk
            except queue.Empty:
                continue

    def start(self):
        """Initialize Soniox client and open a real-time session."""
        import queue
        from soniox import SonioxClient
        from soniox.types import RealtimeSTTConfig, TranslationConfig
        from soniox.utils import start_audio_thread

        self._audio_queue = queue.Queue(maxsize=500)
        self._stopped = False

        self._client = SonioxClient(api_key=self._api_key)
        config = RealtimeSTTConfig(
            model="stt-rt-v4",
            audio_format="pcm_s16le",
            sample_rate=16000,
            num_channels=1,
            enable_endpoint_detection=True,
            enable_speaker_diarization=True,
            language_hints=self._language_hints,
        )

        # Enable Soniox native real-time translation
        if self._translate_lang:
            config.translation = TranslationConfig(
                type="one_way",
                target_language=self._translate_lang,
            )
            log.info("[stt:soniox-stream] Translation enabled: one_way -> %s", self._translate_lang)

        self._session = self._client.realtime.stt.connect(config=config)
        self._session.__enter__()
        log.info("[stt:soniox-stream] Session opened")

        # Use SDK's official start_audio_thread with our queue-based iterator
        # finish=False so it doesn't send FINISH when the iterator ends
        start_audio_thread(self._session, self._audio_iter())
        log.info("[stt:soniox-stream] Audio thread started")

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

        Uses chunk_id-based replace-in-place strategy:
        - Accumulates final tokens globally
        - Each event: yields (final + non-final) text with same chunk_id
        - Frontend replaceLastPartText updates in-place -> smooth real-time
        - Speaker change -> new chunk_id -> new transcript block
        """
        if not self._session:
            return

        import time
        from uuid import uuid4

        # Running accumulator of ALL final token texts for current segment
        accumulated_final = []
        accumulated_translation = []  # Translation tokens for current segment
        current_speaker = 0
        current_chunk_id = f"soniox-{int(time.time() * 1000)}-{uuid4().hex[:6]}"

        event_count = 0
        try:
            for event in self._session.receive_events():
                if self._stopped:
                    return

                event_count += 1
                # Check for server errors (e.g. 402 balance exhausted)
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

                # Separate final and non-final tokens from this event
                new_final = []
                non_final = []
                new_translation = []  # Translation tokens from this event
                non_final_translation = []  # Non-final translation tokens
                final_speaker = None  # Track speaker from final tokens only

                for token in event.tokens:
                    speaker_id = int(getattr(token, "speaker", 0) or 0)
                    token_text = str(token.text) if token.text is not None else ""
                    if token_text in ("<end>", ""):
                        continue

                    # Separate translation tokens from STT tokens
                    translation_status = getattr(token, "translation_status", "none") or "none"
                    if translation_status == "translation":
                        if token.is_final:
                            new_translation.append(token_text)
                        else:
                            non_final_translation.append(token_text)
                        continue

                    # STT tokens (translation_status: "none" or "original")
                    if token.is_final:
                        # Speaker changed — flush current segment, start new
                        if accumulated_final and speaker_id != current_speaker:
                            full_text = "".join(accumulated_final).strip()
                            if full_text:
                                log.info("[stt:soniox-stream] Speaker change: S%d -> S%d, flushing: '%s...'", current_speaker+1, speaker_id+1, full_text[:50])
                                result = {
                                    "text": full_text,
                                    "is_final": True,
                                    "chunk_id": current_chunk_id,
                                    "speaker": f"Speaker {current_speaker + 1}",
                                    "speaker_id": current_speaker,
                                }
                                # Attach accumulated translation
                                tl_text = "".join(accumulated_translation).strip()
                                if tl_text:
                                    result["translation"] = tl_text
                                yield result
                            # Start new segment
                            accumulated_final = []
                            accumulated_translation = []
                            current_chunk_id = f"soniox-{int(time.time() * 1000)}-{uuid4().hex[:6]}"

                        new_final.append(token_text)
                        final_speaker = speaker_id
                    else:
                        non_final.append(token_text)

                # Add new tokens to accumulators
                accumulated_final.extend(new_final)
                accumulated_translation.extend(new_translation)
                if final_speaker is not None:
                    current_speaker = final_speaker

                # Build display text: all final so far + current non-final
                display_text = "".join(accumulated_final + non_final).strip()
                if not display_text:
                    continue

                # Build translation text
                translation_text = "".join(accumulated_translation + non_final_translation).strip()

                # Yield with same chunk_id -> frontend replaceLastPartText
                result = {
                    "text": display_text,
                    "is_final": True,
                    "chunk_id": current_chunk_id,
                    "speaker": f"Speaker {current_speaker + 1}",
                    "speaker_id": current_speaker,
                }
                # Only include translation when it has actually changed (reduce frontend re-renders)
                if translation_text:
                    result["translation"] = translation_text
                yield result

            # Stream ended — flush remaining
            if accumulated_final:
                full_text = "".join(accumulated_final).strip()
                if full_text:
                    result = {
                        "text": full_text,
                        "is_final": True,
                        "chunk_id": current_chunk_id,
                        "speaker": f"Speaker {current_speaker + 1}",
                        "speaker_id": current_speaker,
                    }
                    tl_text = "".join(accumulated_translation).strip()
                    if tl_text:
                        result["translation"] = tl_text
                    yield result

        except Exception as e:
            if self._stopped:
                return
            import traceback
            log.error("[stt:soniox-stream] Error: %s", e, exc_info=True)


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


# Common Vietnamese words that Riva often incorrectly capitalizes
_COMMON_VI_WORDS = {
    # Pronouns
    "tôi", "tao", "mình", "ta", "chúng", "bọn", "họ", "nó", "hắn", "cô", "ông", "bà",
    "anh", "chị", "em", "con", "cháu", "bạn", "các", "những", "mấy", "vài",
    # Common verbs
    "là", "có", "được", "làm", "đi", "đến", "nói", "bảo", "biết", "thấy", "muốn",
    "cần", "phải", "nên", "cho", "lấy", "đem", "mang", "đưa", "gửi", "nhận",
    "hiểu", "nghĩ", "tưởng", "xem", "nghe", "đọc", "viết", "học", "dạy",
    "ăn", "uống", "ngủ", "chơi", "hỏi", "trả", "lời", "gọi", "chạy", "bay",
    "sống", "chết", "yêu", "ghét", "sợ", "tin", "mua", "bán", "giúp", "tìm",
    # Common adjectives / adverbs
    "rất", "lắm", "quá", "hơi", "khá", "cực", "siêu", "tốt", "xấu", "đẹp",
    "lớn", "nhỏ", "cao", "thấp", "dài", "ngắn", "nhanh", "chậm", "mới", "cũ",
    "nhiều", "ít", "đủ", "thêm", "bớt", "cùng", "khác", "giống", "đúng", "sai",
    # Conjunctions / Prepositions / Particles
    "và", "với", "hay", "hoặc", "nhưng", "mà", "vì", "nên", "do", "bởi",
    "nếu", "thì", "khi", "lúc", "sau", "trước", "trong", "ngoài", "trên", "dưới",
    "của", "về", "từ", "đã", "đang", "sẽ", "rồi", "xong", "hết", "còn",
    "ở", "tại", "bên", "cạnh", "giữa", "qua", "lại", "ra", "vào", "lên", "xuống",
    "theo", "bằng", "như", "để", "mà", "thế", "vậy", "đây", "đó", "kia", "này",
    "gì", "nào", "sao", "tại", "thôi", "nhé", "ạ", "à", "ơi", "hả",
    # Time words
    "hôm", "nay", "ngày", "tháng", "năm", "tuần", "giờ", "phút", "sáng", "chiều",
    "tối", "đêm", "mai", "qua", "kia",
    # Misc common words
    "không", "chưa", "chẳng", "đừng", "hãy", "thì", "cũng", "vẫn", "luôn",
    "người", "việc", "điều", "cái", "con", "chiếc", "bài", "câu", "phần",
    "nhà", "đường", "nước", "đất", "trời", "biển", "sông", "núi",
    "tiền", "công", "việc", "cuộc", "họp", "dự", "án", "kế", "hoạch",
}


def is_likely_proper_noun(words: list, idx: int) -> bool:
    """Strict heuristic for Vietnamese proper nouns.
    
    Only preserves capitalization for:
    - Acronyms (all-caps, 2-5 chars): AI, CNTT, ASEAN
    - Words NOT in common Vietnamese word list that are capitalized
      (likely names of people, places, organizations)
    """
    word = words[idx]
    if not word or not word[0].isupper():
        return False
    
    # Acronyms: all-caps, 2-5 chars
    if word.isupper() and 2 <= len(word) <= 5:
        return True
    
    # If it's a common Vietnamese word, it's NOT a proper noun
    if word.lower() in _COMMON_VI_WORDS:
        return False
    
    # Short words (1-2 chars) that are capitalized are usually not proper nouns
    if len(word) <= 2:
        return False
    
    # Otherwise, keep capitalization (likely a name or foreign word)
    return True
