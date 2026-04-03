"""
Translation module — Nvidia Riva NMT (Neural Machine Translation)
Uses riva-translate-1.6b model via gRPC through NVCF.
"""

import os
import json
from typing import Generator

from logger import get_logger

log = get_logger(__name__)

# Nvidia NMT function ID
NMT_FUNCTION_ID = "0778f2eb-b64d-45e7-acae-7dd9b9b35b4d"
NMT_MODEL = ""  # NVCF infers model from function-id

# Map frontend language codes to Nvidia NMT language codes
_LANG_MAP = {
    "en": "en",
    "vi": "vi",
    "zh": "zh-CN",
    "zh-CN": "zh-CN",
    "zh-TW": "zh-TW",
    "ja": "ja",
    "ko": "ko",
    "de": "de",
    "fr": "fr",
    "es": "es-ES",
    "it": "it",
    "pt": "pt-BR",
    "ru": "ru",
    "ar": "ar",
    "th": "th",
    "id": "id",
    "hi": "hi",
    "tr": "tr",
    "nl": "nl",
    "pl": "pl",
    "sv": "sv",
    "da": "da",
    "no": "no",
    "fi": "fi",
    "cs": "cs",
    "hu": "hu",
    "ro": "ro",
    "bg": "bg",
    "uk": "uk",
    "hr": "hr",
    "sk": "sk",
    "el": "el",
    "lt": "lt",
    "lv": "lv",
    "et": "et",
    "sl": "sl",
}

# Cache NMT client per API key
_nmt_client_cache = {}


def _get_nmt_client(api_key: str):
    """Get or create cached NMT gRPC client."""
    cache_key = api_key[:16]
    if cache_key in _nmt_client_cache:
        return _nmt_client_cache[cache_key]

    from riva.client import NeuralMachineTranslationClient, Auth

    riva_url = os.getenv("NVIDIA_RIVA_URL", "grpc.nvcf.nvidia.com:443")
    auth = Auth(
        use_ssl=True,
        uri=riva_url,
        metadata_args=[
            ["function-id", NMT_FUNCTION_ID],
            ["authorization", f"Bearer {api_key}"],
        ],
    )
    client = NeuralMachineTranslationClient(auth)
    _nmt_client_cache[cache_key] = client
    return client


def _resolve_nmt_lang(code: str) -> str:
    """Resolve frontend language code to Nvidia NMT code.
    
    Handles both short codes (vi, en) and full locale codes (vi-VN, en-US).
    """
    if code in _LANG_MAP:
        return _LANG_MAP[code]
    # Try short prefix for full locale codes like vi-VN -> vi
    short = code.split("-")[0] if "-" in code else code
    return _LANG_MAP.get(short, short)


def detect_source_language(text: str, target_lang: str, stt_lang: str) -> str:
    """Detect source language based on STT language and target.
    
    If the STT language is the same as the target, assume we're translating
    from the speech language. Otherwise, use the STT language as source.
    """
    src = _resolve_nmt_lang(stt_lang)
    tgt = _resolve_nmt_lang(target_lang)
    # If source and target are the same, try English as source
    if src == tgt:
        return "en" if tgt != "en" else "vi"
    return src


def translate_stream(text: str, target_lang: str, db) -> Generator[str, None, None]:
    """Translate text using Nvidia Riva NMT. Returns SSE stream for frontend compat."""
    api_key = db.get_setting("nvidia_api_key") or os.getenv("NVIDIA_API_KEY", "")
    stt_lang = db.get_setting("stt_language") or "vi"

    if not api_key:
        yield f"event: error\ndata: {json.dumps({'error': 'NVIDIA_API_KEY not set'})}\n\n"
        return

    tgt = _resolve_nmt_lang(target_lang)
    src = detect_source_language(text, target_lang, stt_lang)
    log.info("[nmt] Translating: src=%s -> tgt=%s, text='%s...'" , src, tgt, text[:80])

    if src == tgt:
        log.info("[nmt] Source and target are same (%s), skipping translation", src)
        yield f"data: {json.dumps({'token': text})}\n\n"
        yield f"event: done\ndata: {json.dumps({})}\n\n"
        return

    try:
        client = _get_nmt_client(api_key)
        response = client.translate(
            texts=[text],
            model=NMT_MODEL,
            source_language=src,
            target_language=tgt,
        )

        # NMT returns full translation at once
        translated = ""
        if response.translations:
            translated = response.translations[0].text

        log.info("[nmt] Result: '%s...'", translated[:80])

        if translated:
            # Send as single token for SSE compat
            yield f"data: {json.dumps({'token': translated})}\n\n"

        yield f"event: done\ndata: {json.dumps({})}\n\n"

    except Exception as e:
        error_msg = str(e)
        log.warning("[nmt] Translation error (src=%s -> tgt=%s): %s", src, tgt, error_msg)
        # Reset cache on auth/connection errors
        if "Unauthenticated" in error_msg or "Unavailable" in error_msg:
            _nmt_client_cache.clear()
        yield f"event: error\ndata: {json.dumps({'error': f'NMT translation failed: {error_msg}'})}\n\n"


def translate_instant(text: str, target_lang: str, db, source_lang: str = "") -> str:
    """Translate text instantly (non-streaming). Returns translated string or empty on error.
    Used for cabin-style inline translation in WebSocket pipeline.
    source_lang: if provided, overrides the stt_language setting from DB."""
    import re
    if not text or not target_lang:
        return ""
    if not re.sub(r'[^\w\s]', '', text).strip():
        return ""

    api_key = db.get_setting("nvidia_api_key") or os.getenv("NVIDIA_API_KEY", "")

    if not api_key:
        return ""

    tgt = _resolve_nmt_lang(target_lang)
    stt_lang = source_lang or db.get_setting("stt_language") or "vi"
    src = detect_source_language(text, target_lang, stt_lang)

    if src == tgt:
        return text

    try:
        client = _get_nmt_client(api_key)
        
        import re
        max_words_per_chunk = 40
        words = text.split()
        if len(words) <= max_words_per_chunk:
            texts_to_translate = [text]
        else:
            texts_to_translate = []
            sentences = re.split(r'(?<=[.!?,\n])\s+', text)
            current_chunk = []
            current_len = 0
            for sentence in sentences:
                sen_words = sentence.split()
                if current_len + len(sen_words) > max_words_per_chunk and current_chunk:
                    texts_to_translate.append(" ".join(current_chunk))
                    current_chunk = sen_words
                    current_len = len(sen_words)
                else:
                    current_chunk.extend(sen_words)
                    current_len += len(sen_words)
                    
                while len(current_chunk) > max_words_per_chunk * 1.5:
                    texts_to_translate.append(" ".join(current_chunk[:max_words_per_chunk]))
                    current_chunk = current_chunk[max_words_per_chunk:]
                    current_len = len(current_chunk)
                    
            if current_chunk:
                texts_to_translate.append(" ".join(current_chunk))
                
        log.info("[nmt] Translating: src=%s -> tgt=%s, %d chunks, total text='%s...' (%d chars)", src, tgt, len(texts_to_translate), text[:80], len(text))
        
        translated_chunks = []
        for i in range(0, len(texts_to_translate), 4):
            batch = texts_to_translate[i:i+4]
            response = client.translate(
                texts=batch,
                model=NMT_MODEL,
                source_language=src,
                target_language=tgt,
            )
            for t in response.translations:
                translated_chunks.append(t.text)
                
        result = " ".join(translated_chunks)
        
        if result:
            log.info("[nmt] Result (%d chars): '%s...'", len(result), result[:80])
            # Truncate NMT hallucinations: if translation is much longer than source,
            # trim to last complete sentence within expected length
            max_len = int(len(text) * 1.8)
            if len(result) > max_len and max_len > 20:
                truncated = result[:max_len]
                # Find last sentence boundary
                for sep in ['. ', '.\n', '! ', '? ']:
                    last_sep = truncated.rfind(sep)
                    if last_sep > max_len * 0.5:
                        truncated = truncated[:last_sep + 1]
                        break
                log.debug("[nmt] Truncated hallucination: %d -> %d chars", len(result), len(truncated))
                return truncated.strip()
            return result
        return ""
    except Exception as e:
        log.warning("[nmt] Inline translate error: %s", e)
        if "Unauthenticated" in str(e) or "Unavailable" in str(e):
            _nmt_client_cache.clear()
        return ""
