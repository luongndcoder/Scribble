"""
Centralized logging configuration for VoiceScribe sidecar.

Usage:
    from logger import get_logger
    log = get_logger(__name__)
    log.info("Something happened")
    log.warning("Watch out")
    log.error("Something failed: %s", err)
"""

import logging
import logging.handlers
import os
import sys
from pathlib import Path


def _get_log_file() -> Path:
    data_dir = Path(os.getenv("VOICESCRIBE_DATA", Path.home() / ".voicescribe"))
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "sidecar.log"


def _setup_root_logger() -> None:
    """Configure the root logger once at import time."""
    root = logging.getLogger()
    if root.handlers:
        return  # Already configured

    root.setLevel(logging.DEBUG)

    fmt = logging.Formatter(
        fmt="%(asctime)s  %(levelname)-7s  %(message)s",
        datefmt="%H:%M:%S",
    )

    # ── File handler (rotation: 10MB × 3 backups) ──
    try:
        fh = logging.handlers.RotatingFileHandler(
            _get_log_file(),
            maxBytes=10 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(fmt)
        root.addHandler(fh)
    except Exception as e:
        print(f"[logger] Could not create log file handler: {e}", file=sys.stderr)

    # ── Stream handler → stdout (caught by _LogInterceptor for SSE /logs) ──
    sh = logging.StreamHandler(sys.stdout)
    sh.setLevel(logging.INFO)
    sh.setFormatter(fmt)
    root.addHandler(sh)

    # Silence noisy third-party loggers
    for noisy in ("uvicorn.access", "httpx", "httpcore", "grpc"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


_setup_root_logger()


def get_logger(name: str) -> logging.Logger:
    """Get a named logger. Always use module __name__ as the name."""
    return logging.getLogger(name)
