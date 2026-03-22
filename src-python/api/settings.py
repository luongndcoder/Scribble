"""
Settings API router — GET/POST /settings, GET /models
"""

from fastapi import APIRouter, Request, Query
import httpx

from db import Database
from logger import get_logger

log = get_logger(__name__)
router = APIRouter()
db = Database()

# Keys that should be masked in GET /settings response
_SENSITIVE_KEYS = frozenset({"nvidia_api_key", "llm_api_key", "soniox_api_key"})

# Provider → base URL mapping
_PROVIDER_URLS: dict[str, str] = {
    "openai":     "https://api.openai.com/v1",
    "mistral":    "https://api.mistral.ai/v1",
    "groq":       "https://api.groq.com/openai/v1",
    "deepseek":   "https://api.deepseek.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "gemini":     "https://generativelanguage.googleapis.com/v1beta/openai",
}


def _mask_value(key: str, value: str) -> str:
    """Mask sensitive API key values, keeping first 4 and last 4 chars."""
    if key not in _SENSITIVE_KEYS or not value or len(value) < 8:
        return value
    return value[:4] + "***" + value[-4:]


@router.get("/settings")
async def get_settings():
    raw = db.get_all_settings()
    return {k: _mask_value(k, v) for k, v in raw.items()}


@router.post("/settings")
async def save_settings(request: Request):
    body = await request.json()
    old_lang = db.get_setting("stt_language") or ""
    for key, value in body.items():
        db.set_setting(key, str(value))
    new_lang = body.get("stt_language", old_lang)
    if new_lang != old_lang or "nvidia_api_key" in body:
        try:
            from stt import _reset_riva_asr
            _reset_riva_asr()
            log.info("[settings] ASR cache cleared (language: %s -> %s)", old_lang, new_lang)
        except Exception as e:
            log.warning("[settings] ASR cache reset failed: %s", e)
    return {"ok": True}


@router.get("/models")
async def list_models(
    provider: str = Query(...),
    api_key: str = Query(default=""),
    base_url: str = Query(default=""),
):
    """Fetch available models from the selected LLM provider."""
    # Resolve base URL
    if provider == "compatible":
        url = base_url.rstrip("/")
        if not url:
            return {"error": "base_url required for compatible provider", "models": []}
    else:
        url = _PROVIDER_URLS.get(provider, "").rstrip("/")
        if not url:
            return {"error": f"Unknown provider: {provider}", "models": []}

    # Use saved key from DB if caller didn't supply a new (unmasked) key
    resolved_key = api_key if (api_key and "\u2022" not in api_key) else (db.get_setting("llm_api_key") or "")
    if not resolved_key:
        return {"error": "API key required", "models": []}

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(
                f"{url}/models",
                headers={"Authorization": f"Bearer {resolved_key}"},
            )
        if resp.status_code != 200:
            return {"error": f"Provider returned {resp.status_code}", "models": []}

        data = resp.json()
        # OpenAI-compatible: {"data": [{"id": "...", ...}]}
        if "data" in data:
            ids = [m.get("id", "") for m in data["data"] if m.get("id")]
        # Gemini: {"models": [{"name": "models/gemini-...", ...}]}
        elif "models" in data:
            ids = [m.get("name", "").replace("models/", "") for m in data["models"] if m.get("name")]
        else:
            ids = []

        ids.sort()
        log.info("[models] %s: %d models fetched", provider, len(ids))
        return {"models": ids}
    except Exception as e:
        log.warning("[models] fetch failed: %s", e)
        return {"error": str(e), "models": []}
