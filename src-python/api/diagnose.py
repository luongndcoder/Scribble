"""
Diagnose API router — health-check for STT and LLM providers, diarizer status.
"""

import asyncio
import os
import time

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


# ─── Network connectivity probe (v1.2.14) ──────────────────────────────────
# Frontend polls /health every ~10s; we piggyback a lightweight TCP probe so
# UI can show "Mất mạng" banner during long Soniox uploads instead of letting
# the user discover it only when the upload finally fails.
#
# Why TCP-connect to 1.1.1.1:443 (Cloudflare):
#   - No DNS dependency — bypasses ISP DNS hijack scenarios.
#   - No HTTP round-trip — just SYN/ACK, ~30ms when online, ~2s timeout when down.
#   - No payload — zero bandwidth cost across many polls.
#
# Cache 5s + background refresh: health endpoint must stay ~instant; first
# call awaits once so the UI gets a real value, subsequent calls return the
# cached snapshot and refresh asynchronously.
_NETWORK_PROBE_HOST = "1.1.1.1"
_NETWORK_PROBE_PORT = 443
_NETWORK_PROBE_TIMEOUT = 2.0
_NETWORK_CACHE_TTL = 5.0  # seconds

_network_cache: dict = {
    "online": None,        # None = never probed, True/False otherwise
    "checked_at": 0.0,     # monotonic timestamp of last successful probe write
    "latency_ms": None,    # last probe latency for debugging
    "checking": False,     # in-flight guard so concurrent /health calls don't probe twice
}


async def _probe_network_once() -> None:
    """Single TCP connect → 1.1.1.1:443 — writes result into _network_cache."""
    if _network_cache["checking"]:
        return
    _network_cache["checking"] = True
    started = time.monotonic()
    try:
        try:
            fut = asyncio.open_connection(_NETWORK_PROBE_HOST, _NETWORK_PROBE_PORT)
            reader, writer = await asyncio.wait_for(fut, timeout=_NETWORK_PROBE_TIMEOUT)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass  # OS may already have torn down — non-fatal
            _network_cache["online"] = True
            _network_cache["latency_ms"] = int((time.monotonic() - started) * 1000)
        except (asyncio.TimeoutError, OSError) as e:
            _network_cache["online"] = False
            _network_cache["latency_ms"] = None
            log.debug(f"STATUS: network probe failed host={_NETWORK_PROBE_HOST} err={type(e).__name__}")
        _network_cache["checked_at"] = time.monotonic()
    finally:
        _network_cache["checking"] = False


async def _get_network_status() -> dict:
    """Return cached status; await first probe, refresh stale in background."""
    now = time.monotonic()
    age = now - _network_cache["checked_at"]
    if _network_cache["online"] is None:
        # First call ever — block so frontend gets a real answer immediately
        await _probe_network_once()
    elif age > _NETWORK_CACHE_TTL and not _network_cache["checking"]:
        # Stale — refresh in background, return cached value now
        asyncio.create_task(_probe_network_once())

    online = _network_cache["online"]
    return {
        "online": bool(online) if online is not None else False,
        "latency_ms": _network_cache["latency_ms"],
        "age_ms": int((now - _network_cache["checked_at"]) * 1000),
    }


@router.get("/health")
async def health():
    """Lightweight health endpoint — also reports network reachability so the
    frontend can detect offline state without burning extra polls."""
    network = await _get_network_status()
    return {
        "status": "ok",
        "version": "1.0.0",
        "network": network,
    }


@router.get("/ping-network")
async def ping_network():
    """Force a fresh network probe (bypass cache) — used when the frontend
    explicitly wants to re-check after a suspected outage. NEVER call from
    polling loops; use /health for that."""
    await _probe_network_once()
    return await _get_network_status()


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
