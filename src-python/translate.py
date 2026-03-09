"""
Translation module — Nvidia Riva NMT (Neural Machine Translation)
Uses riva-translate-1.6b model via gRPC through NVCF.
"""

import os
import json
from typing import Generator

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
    """Resolve frontend language code to Nvidia NMT code."""
    return _LANG_MAP.get(code, code)


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

        if translated:
            # Send as single token for SSE compat
            yield f"data: {json.dumps({'token': translated})}\n\n"

        yield f"event: done\ndata: {json.dumps({})}\n\n"

    except Exception as e:
        error_msg = str(e)
        print(f"[nmt] Translation error: {error_msg}")
        # Reset cache on auth/connection errors
        if "Unauthenticated" in error_msg or "Unavailable" in error_msg:
            _nmt_client_cache.clear()
        yield f"event: error\ndata: {json.dumps({'error': f'NMT translation failed: {error_msg}'})}\n\n"
