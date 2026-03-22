"""
Diagnose API router — health-check for STT and LLM providers, diarizer status.
"""

import asyncio
import os

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from db import Database
from i18n import t
from logger import get_logger

log = get_logger(__name__)
router = APIRouter()
db = Database()

# Shared diarizer — injected during app startup via set_diarizer()
_diarizer = None


def set_diarizer(d) -> None:
    global _diarizer
    _diarizer = d


@router.get("/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}


@router.get("/diarizer-status")
async def diarizer_status():
    if _diarizer is None:
        return JSONResponse({"error": "Diarizer not initialized"}, status_code=503)
    return {
        "model_loaded": _diarizer._model_loaded,
        "model_ok": _diarizer._session is not None,
        "source": _diarizer._source,
        "profile_count": len(_diarizer._profiles),
        "config": {
            "match_threshold": _diarizer.cfg("match_threshold"),
            "pitch_penalty_factor": _diarizer.cfg("pitch_penalty_factor"),
            "switch_confirm_hits": _diarizer.cfg("switch_confirm_hits"),
            "same_zone_pitch_diff_male": _diarizer.cfg("same_zone_weak_pitch_diff_male"),
            "same_zone_pitch_diff_female": _diarizer.cfg("same_zone_weak_pitch_diff_female"),
        },
    }


@router.post("/diarize-reset")
async def diarize_reset():
    if _diarizer:
        _diarizer.reset()
    return {"ok": True}


@router.get("/diagnose")
async def diagnose(lang: str = "vi"):
    import httpx
    results = {"stt": {"status": "unknown", "message": ""}, "llm": {"status": "unknown", "message": ""}}
    loop = asyncio.get_event_loop()

    stt_provider = db.get_setting("stt_provider") or "nvidia"

    if stt_provider == "soniox":
        soniox_key = db.get_setting("soniox_api_key") or os.getenv("SONIOX_API_KEY", "")
        if not soniox_key:
            results["stt"] = {"status": "warning", "message": t("soniox_key_missing", lang)}
        else:
            def _test_soniox():
                from soniox import SonioxClient
                client = SonioxClient(api_key=soniox_key)
                client.models.list()

            try:
                await loop.run_in_executor(None, _test_soniox)
                results["stt"] = {"status": "ok", "message": t("soniox_connected", lang)}
            except Exception as e:
                results["stt"] = {"status": "error", "message": f"{t('soniox_connect_fail', lang)}: {str(e)[:80]}"}
    else:
        nvidia_key = db.get_setting("nvidia_api_key") or os.getenv("NVIDIA_API_KEY", "")
        if not nvidia_key:
            results["stt"] = {"status": "warning", "message": t("nvidia_key_missing", lang)}
        else:
            def _test_riva():
                from stt import _get_riva_asr, _reset_riva_asr, get_nvidia_model
                from concurrent.futures import ThreadPoolExecutor
                stt_lang_diag = db.get_setting("stt_language") or "vi"
                from stt import get_language_code
                lang_code = get_language_code(stt_lang_diag)
                model = get_nvidia_model(lang_code)
                _reset_riva_asr(model["function_id"])
                executor = ThreadPoolExecutor(max_workers=1)
                future = executor.submit(_get_riva_asr, nvidia_key, model["function_id"])
                try:
                    future.result(timeout=10)
                finally:
                    executor.shutdown(wait=False, cancel_futures=True)

            try:
                await loop.run_in_executor(None, _test_riva)
                results["stt"] = {"status": "ok", "message": t("nvidia_connected", lang)}
            except Exception as e:
                err_str = str(e)
                if "TimeoutError" in type(e).__name__ or "timed out" in err_str.lower():
                    results["stt"] = {"status": "error", "message": t("nvidia_connect_fail", lang) + ": Connection timed out (10s)"}
                else:
                    results["stt"] = {"status": "error", "message": f"{t('nvidia_connect_fail', lang)}: {err_str[:80]}"}

    llm_key = db.get_setting("llm_api_key") or os.getenv("LLM_API_KEY", "")
    llm_provider = db.get_setting("llm_provider") or "openai"
    llm_url = db.get_setting("llm_base_url") or os.getenv("LLM_BASE_URL", "")

    from api.settings import _PROVIDER_URLS
    
    # 1) Resolve actual base URL depending on provider
    if llm_provider == "compatible":
        base = llm_url.rstrip("/") if llm_url else ""
    else:
        base = _PROVIDER_URLS.get(llm_provider, "").rstrip("/")

    # 2) Check if key or base missing
    if not llm_key and llm_provider not in ("gemini", "compatible"):
        results["llm"] = {"status": "warning", "message": t("llm_key_missing", lang)}
    elif not base:
        results["llm"] = {"status": "error", "message": "Base URL missing"}
    else:
        try:
            async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
                r = await client.get(f"{base}/models", headers={"Authorization": f"Bearer {llm_key}"})
                if r.status_code == 200:
                    results["llm"] = {"status": "ok", "message": t("llm_connected", lang)}
                else:
                    results["llm"] = {"status": "error", "message": t("llm_key_invalid", lang)}
        except Exception:
            results["llm"] = {"status": "error", "message": t("llm_connect_fail", lang)}

    results["backend"] = stt_provider
    return results
