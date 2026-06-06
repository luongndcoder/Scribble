"""Local STT model download manager (Tier A — nemotron MLX).

Tier C (sherpa) is bundled, so it never needs downloading. Tier A nemotron MLX
(~756MB) is pulled from HuggingFace on demand. This module exposes:

  - active_local_model(): which engine/model the current device will actually
    use + whether it needs a download and is already cached.
  - is_mlx_cached(): True when the nemotron MLX snapshot is fully in the HF cache.
  - start_mlx_download() / download_state(): kick off a background download and
    poll its progress (progress estimated from on-disk cache bytes / total).

All huggingface_hub imports are lazy so non-macOS builds (no mlx stack) never
import it.
"""

import threading

from logger import get_logger

log = get_logger(__name__)

# Approx total on-disk size of the 8-bit MLX nemotron snapshot (~721-756MB).
MLX_TOTAL_BYTES = 760_000_000

_state: dict = {"status": "idle", "progress": 0.0, "error": None}
_lock = threading.Lock()
_thread: threading.Thread | None = None


def _mlx_repo() -> str:
    from local_stt import MLX_REPO

    return MLX_REPO


def _repo_cache_dir():
    """Path to the HF hub cache folder for the nemotron repo (may not exist)."""
    from pathlib import Path

    from huggingface_hub import constants

    folder = "models--" + _mlx_repo().replace("/", "--")
    return Path(constants.HF_HUB_CACHE) / folder


def is_mlx_cached() -> bool:
    """True when the full nemotron MLX snapshot is present in the HF cache."""
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(_mlx_repo(), local_files_only=True)
        return True
    except Exception:
        return False


def _cache_bytes() -> int:
    d = _repo_cache_dir()
    if not d.exists():
        return 0
    total = 0
    for p in d.rglob("*"):
        try:
            if p.is_file() and not p.is_symlink():
                total += p.stat().st_size
        except OSError:
            pass
    return total


def active_local_model() -> dict:
    """Describe the engine/model the current device will actually use."""
    from local_stt import MLX_REPO, _active_tier, _mlx_available

    if _active_tier() == "A" and _mlx_available():
        return {
            "engine": "mlx",
            "model_id": MLX_REPO,
            "display_name": "Nemotron 3.5 ASR (MLX 8-bit)",
            "needs_download": True,
            "cached": is_mlx_cached(),
            "size_mb": round(MLX_TOTAL_BYTES / 1_000_000),
        }
    # Tier C (or MLX unavailable) → bundled sherpa, always ready.
    return {
        "engine": "sherpa",
        "model_id": "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09",
        "display_name": "Sherpa Zipformer VN (30M, int8)",
        "needs_download": False,
        "cached": True,
        "size_mb": 32,
    }


def download_state() -> dict:
    """Current download status; progress is estimated live while downloading."""
    with _lock:
        st = dict(_state)
    if st["status"] == "downloading":
        st["progress"] = min(0.99, _cache_bytes() / MLX_TOTAL_BYTES)
    elif st["status"] == "done":
        st["progress"] = 1.0
    return st


def _run_download():
    global _state
    try:
        from huggingface_hub import snapshot_download

        log.info("STARTED: nemotron MLX download")
        snapshot_download(_mlx_repo())
        with _lock:
            _state = {"status": "done", "progress": 1.0, "error": None}
        log.info("COMPLETED: nemotron MLX download")
    except Exception as exc:  # network / disk failure
        log.warning("FAILED: nemotron MLX download: %s", exc)
        with _lock:
            _state = {"status": "error", "progress": 0.0, "error": str(exc)[:200]}


def start_mlx_download() -> dict:
    """Kick off the background download (idempotent). Returns current state."""
    global _thread, _state
    if is_mlx_cached():
        with _lock:
            _state = {"status": "done", "progress": 1.0, "error": None}
        return download_state()
    with _lock:
        if _state["status"] == "downloading" and _thread and _thread.is_alive():
            return dict(_state)
        _state = {"status": "downloading", "progress": 0.0, "error": None}
        _thread = threading.Thread(target=_run_download, daemon=True)
        _thread.start()
    return download_state()
