"""Local STT model registry + on-disk resolution.

Maps a device tier (see device_detect) to a model artifact spec and resolves
where that model lives on disk:

    bundled (shipped inside the sidecar)  →  download cache (~/.voicescribe)  →  None

Phase 1 ships the Tier C Vietnamese model bundled, so Tier C always resolves to
the bundled dir. Tier A/B specs are placeholders whose artifacts are downloaded
on demand (implemented in Phase 2/3 via the Rust side).
"""

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from logger import get_logger

log = get_logger(__name__)


@dataclass(frozen=True)
class ModelSpec:
    """Describes one local STT model artifact."""

    model_id: str
    version: str
    files: tuple[str, ...]  # files that MUST exist for the model dir to be usable
    url: str
    sha256: str
    size_bytes: int
    archive: str  # "tar.bz2" | "tar.zst"
    license: str


# Required files for a sherpa-onnx offline transducer model dir.
_SHERPA_TRANSDUCER_FILES = (
    "tokens.txt",
    "encoder.int8.onnx",
    "decoder.onnx",
    "joiner.int8.onnx",
)

MODEL_REGISTRY: dict[str, ModelSpec] = {
    # Tier C — CPU, cross-platform. Bundled into the installer (Phase 1).
    "C": ModelSpec(
        model_id="sherpa-onnx-zipformer-vi-30M-int8-2026-02-09",
        version="2026-02-09",
        files=_SHERPA_TRANSDUCER_FILES,
        url=(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
            "sherpa-onnx-zipformer-vi-30M-int8-2026-02-09.tar.bz2"
        ),
        sha256="",  # filled at build time when the artifact is fetched/hosted
        size_bytes=32 * 1024 * 1024,
        archive="tar.bz2",
        license="cc-by-nc-nd-4.0",
    ),
    # Tier A — macOS Apple Silicon (MLX). Placeholder; downloaded in Phase 2.
    "A": ModelSpec(
        model_id="nemotron-3.5-asr-streaming-0.6b-8bit-mlx",
        version="1",
        files=(),
        url="",
        sha256="",
        size_bytes=756 * 1024 * 1024,
        archive="tar.zst",
        license="OpenMDW-1.1",
    ),
    # Tier B — NVIDIA CUDA (nemotron ONNX). Placeholder; downloaded in Phase 3.
    "B": ModelSpec(
        model_id="nemotron-3.5-asr-streaming-0.6b-onnx",
        version="1",
        files=(),
        url="",
        sha256="",
        size_bytes=0,
        archive="tar.zst",
        license="OpenMDW-1.1",
    ),
}


def resolve(tier: str) -> ModelSpec:
    """Return the ModelSpec for a tier. Unknown tier falls back to Tier C."""
    return MODEL_REGISTRY.get(tier, MODEL_REGISTRY["C"])


def _bundled_base() -> Path:
    """Directory that holds models shipped inside the sidecar.

    PyInstaller onedir extracts data to ``sys._MEIPASS``; in dev we read from
    ``src-python/models/local`` next to this package.
    """
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass) / "models" / "local"
    return Path(__file__).resolve().parent.parent / "models" / "local"


def _download_base() -> Path:
    """User-writable cache for on-demand downloaded models (Tier A/B / override)."""
    home = Path(os.path.expanduser("~"))
    return home / ".voicescribe" / "models"


def _dir_has_all_files(d: Path, spec: ModelSpec) -> bool:
    return d.is_dir() and all((d / f).is_file() for f in spec.files)


def bundled_model_dir(spec: ModelSpec) -> Path | None:
    """Path to the bundled model dir if present and complete, else None."""
    if not spec.files:
        return None
    d = _bundled_base() / spec.model_id
    return d if _dir_has_all_files(d, spec) else None


def download_cache_dir(spec: ModelSpec) -> Path | None:
    """Path to a downloaded+verified model dir in the user cache, else None.

    Tier-keyed layout mirrors the sidecar cache: ~/.voicescribe/models/<id>/.
    A ``.version`` marker file gates staleness.
    """
    if not spec.files:
        return None
    d = _download_base() / spec.model_id
    version_marker = d / ".version"
    if not _dir_has_all_files(d, spec):
        return None
    if not version_marker.is_file():
        return None
    if version_marker.read_text(encoding="utf-8").strip() != spec.version:
        return None
    return d


def model_path_or_none(spec: ModelSpec) -> Path | None:
    """Resolve the usable model dir: bundled first, then download cache."""
    return bundled_model_dir(spec) or download_cache_dir(spec)
