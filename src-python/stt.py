"""
STT module — Nvidia Riva multi-language transcription

Models:
  - Vietnamese (vi-VN): Parakeet CTC 0.6B Vietnamese
  - Chinese (zh-CN): Parakeet CTC 0.6B Chinese  
  - All others: Parakeet 1.1B RNNT Multilingual
"""

import os
import re
import subprocess
import time
from pathlib import Path

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
    print(f"[stt:nvidia] Connecting to {riva_url} with function-id {function_id}")
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
    print(f"[stt:nvidia] Using {model['name']} for {language}")

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
        print(f"[stt:nvidia-stream] Using {self._model['name']} for {language}")

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
                        if is_final:
                            if self._language.startswith("vi"):
                                transcript = normalize_vietnamese_text(transcript)
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
                print(f"[stt:nvidia-stream] Error: {err_msg}")
                print(f"[stt:nvidia-stream] Model: {self._model['name']}, Lang: {self._language}, FuncID: {self._model['function_id']}")
                _reset_riva_asr(self._model["function_id"])

                if retries > max_retries:
                    print("[stt:nvidia-stream] Max reconnect retries reached, stopping stream")
                    return

                backoff = min(1.0 * retries, 3.0)
                print(f"[stt:nvidia-stream] Reconnecting in {backoff:.1f}s ({retries}/{max_retries})...")
                time.sleep(backoff)

                try:
                    self._response_gen = self._create_response_generator()
                    print("[stt:nvidia-stream] Reconnected")
                except Exception as reconnect_err:
                    print(f"[stt:nvidia-stream] Reconnect failed: {reconnect_err}")


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
    """Fix Whisper's incorrect capitalization for Vietnamese."""
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
            if i == 0:
                normalized.append(word[0].upper() + word[1:] if word else word)
            elif is_likely_proper_noun(words, i):
                normalized.append(word)
            else:
                normalized.append(word.lower())
        
        result.append(' '.join(normalized))
    
    return ' '.join(result)


def is_likely_proper_noun(words: list, idx: int) -> bool:
    """Heuristic: a word is a proper noun if it's part of a capitalized sequence
    of 2+ words, or if it's an acronym (all-caps, 2-5 chars).
    """
    word = words[idx]
    if not word or not word[0].isupper():
        return False
    
    if word.isupper() and 2 <= len(word) <= 5:
        return True
    
    prev_cap = idx > 0 and words[idx - 1][0].isupper() if idx > 0 and words[idx - 1] else False
    next_cap = idx < len(words) - 1 and words[idx + 1][0].isupper() if idx < len(words) - 1 and words[idx + 1] else False
    
    if prev_cap or next_cap:
        return True
    
    return False
