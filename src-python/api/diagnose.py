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
    """Deduped probe for the poll loop — skips if another probe is in-flight.

    Use for /health (high-frequency, fine to coalesce). For an explicit
    re-check that MUST return a fresh value, call _do_probe() directly."""
    if _network_cache["checking"]:
        return
    await _do_probe()


async def _do_probe() -> None:
    """Single TCP connect → 1.1.1.1:443 — writes result into _network_cache.

    Always runs a real probe (no dedup guard). Concurrent calls are safe: the
    cache writes are idempotent and last-write-wins is acceptable for a
    reachability flag."""
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
    """Force a fresh network probe (bypass cache AND the in-flight dedup
    guard) — used when the frontend explicitly wants to re-check after a
    suspected outage (e.g. an upload chunk just failed). NEVER call from
    polling loops; use /health for that.

    Calls _do_probe() directly so the result is GUARANTEED fresh even if a
    /health background probe happens to be running at the same moment —
    otherwise _probe_network_once() would early-return on the `checking`
    guard and we'd hand back a stale `online: true`."""
    await _do_probe()
    return await _get_network_status()


# ─── Error classification ──────────────────────────────────────────────────
# When the machine is offline, provider SDKs raise raw DNS/socket errors like
# "[Errno 8] nodename nor servname provided, or not known" (macOS),
# "[Errno -2] Name or service not known" (Linux), or "getaddrinfo failed"
# (Windows). Leaking these into the UI is noise — the real cause is "no
# internet". Detect that class so /diagnose can show a clean offline message.
_NETWORK_ERROR_MARKERS = (
    "nodename nor servname",      # macOS getaddrinfo EAI_NONAME
    "name or service not known",  # Linux EAI_NONAME
    "getaddrinfo failed",         # Windows
    "temporary failure in name resolution",
    "errno 8",                    # EAI_NONAME numeric (macOS)
    "errno -2",                   # EAI_NONAME numeric (Linux)
    "errno -3",                   # EAI_AGAIN (DNS temp fail)
    "11001",                      # Windows WSAHOST_NOT_FOUND
    "failed to establish a new connection",
    "max retries exceeded",
    "connection refused",
    "network is unreachable",
    "no route to host",
    "name resolution",
)


def _is_network_error(exc: Exception) -> bool:
    """True if `exc` looks like an offline / DNS-resolution / unreachable error
    rather than an auth or server-side problem."""
    import socket
    # socket.gaierror is the canonical DNS resolution failure.
    if isinstance(exc, (socket.gaierror, ConnectionError)):
        return True
    msg = str(exc).lower()
    return any(marker in msg for marker in _NETWORK_ERROR_MARKERS)


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
    stt_is_local = stt_provider == "local"

    # Local STT runs entirely on-device — no API key, no network. Its readiness
    # depends only on whether the model is available (bundled sherpa = always;
    # nemotron MLX = needs prior download). Compute once and reuse below.
    def _local_stt_block() -> dict:
        try:
            from local.model_download import active_local_model
            info = active_local_model()
            if info.get("needs_download") and not info.get("cached"):
                return {"status": "warning", "message": t("local_model_needs_download", lang)}
        except Exception:
            pass  # On any introspection failure, assume bundled/ready.
        return {"status": "ok", "message": t("local_stt_ready", lang)}

    # ── Offline short-circuit ──────────────────────────────────────────────
    # Probe the network FIRST (force-fresh via _do_probe, not cached). If the
    # machine is offline, the cloud provider checks below would just raise a raw
    # DNS error. Local STT still works offline, so only flag it when it actually
    # needs a (network-dependent) model download; LLM always needs network.
    await _do_probe()
    if _network_cache["online"] is False:
        offline_msg = t("network_offline", lang)
        log.info("STATUS: diagnose short-circuit — network offline")
        return {
            "stt": _local_stt_block() if stt_is_local
            else {"status": "error", "message": offline_msg, "offline": True},
            "llm": {"status": "error", "message": offline_msg, "offline": True},
            "backend": stt_provider,
            "network": {"online": False},
        }

    if stt_is_local:
        results["stt"] = _local_stt_block()
    elif stt_provider == "soniox":
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
                if _is_network_error(e):
                    results["stt"] = {"status": "error", "message": t("network_offline", lang), "offline": True}
                else:
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
                if _is_network_error(e):
                    results["stt"] = {"status": "error", "message": t("network_offline", lang), "offline": True}
                elif "TimeoutError" in type(e).__name__ or "timed out" in err_str.lower():
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
        except Exception as e:
            if _is_network_error(e):
                results["llm"] = {"status": "error", "message": t("network_offline", lang), "offline": True}
            else:
                results["llm"] = {"status": "error", "message": t("llm_connect_fail", lang)}

    results["backend"] = stt_provider
    results["network"] = {"online": True}
    return results
