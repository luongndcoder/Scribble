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


# ── Streaming (online) Vietnamese ASR — hynt Zipformer-30M RNNT ───────────────
# Powers realtime offline recording (no API key, no network). Bundled because
# the primary use case IS live meetings; ~50MB fp16. License: cc-by-nc-nd-4.0
# (non-commercial, no-derivatives) — owner confirmed the app is free, so this
# is accepted, same basis as the hynt speaker-embedding model.
STREAMING_MODEL_ID = "sherpa-onnx-zipformer-vi-streaming-30M"
STREAMING_MODEL_FILES = (
    "tokens.txt",
    "encoder.fp16.onnx",
    "decoder.fp16.onnx",
    "joiner.fp16.onnx",
)
STREAMING_MODEL_URL = (
    "https://huggingface.co/hynt/Zipformer-30M-RNNT-Streaming-6000h/resolve/main"
)
# Per-file sha256 (HF lfs). Empty = not yet pinned; download still verified by
# size + successful recognizer load.
STREAMING_MODEL_SHA256: dict[str, str] = {}


def _local_models_base() -> Path:
    """Directory holding bundled `models/local/<model_id>` dirs."""
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass) / "models" / "local"
    return Path(__file__).resolve().parent.parent / "models" / "local"


def streaming_model_dir() -> Path | None:
    """Resolve the streaming Zipformer dir: bundled first, then user cache."""
    candidates = [
        _local_models_base() / STREAMING_MODEL_ID,
        _download_base() / STREAMING_MODEL_ID,
    ]
    for d in candidates:
        if d.is_dir() and all((d / f).is_file() for f in STREAMING_MODEL_FILES):
            return d
    return None


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


# ── Speaker embedding models (hynt/Speaker-Embedding-30M-Low-Quality-Speech) ──
# Used by the on-device diarizer for every non-Soniox path (Nvidia realtime /
# upload, local provider). Soniox paths keep SDK-side diarization.
#
# Layout differs from STT tiers: single .onnx file, not a model dir.
# Resolution order: bundled (src-python/models/) → user download cache
# (~/.voicescribe/models/<model_id>/). ResNet34 ships with the app;
# ResNet293 (114MB) is fetched on demand — see ensure_speaker_model().
_HF_SPK_REPO = "https://huggingface.co/hynt/Speaker-Embedding-30M-Low-Quality-Speech/resolve/main"


@dataclass(frozen=True)
class SpeakerModelSpec:
    """Describes one speaker-embedding ONNX artifact."""

    model_id: str  # "resnet34" | "resnet293" — also the DIARIZE_MODEL value
    version: str
    filename: str  # single .onnx file that MUST exist
    url: str
    sha256: str
    size_bytes: int
    embedding_dim: int = 256


SPEAKER_MODEL_SPECS: dict[str, SpeakerModelSpec] = {
    "resnet34": SpeakerModelSpec(
        model_id="resnet34",
        version="1.0",
        filename="speaker_embedding_resnet34.onnx",
        url=f"{_HF_SPK_REPO}/speaker_embedding_resnet34.onnx",
        sha256="a459ed9bda5f32bb5b06ba5f3f9e261e73ac009d14e640d804ca728b2b8dd8a1",
        size_bytes=26542125,
    ),
    "resnet293": SpeakerModelSpec(
        model_id="resnet293",
        version="1.0",
        filename="speaker_embedding_resnet293.onnx",
        url=f"{_HF_SPK_REPO}/speaker_embedding_resnet293.onnx",
        sha256="00c2a1dcbb7e5e5b1339d5db51c905361fd1bf00ca3bf8383e5fd062910894db",
        size_bytes=114393064,
    ),
}

# Legacy CAM++ model (pre-hynt). Kept as an explicit opt-in fallback
# (DIARIZE_MODEL=campplus-legacy) for rollback; NOT bundled anymore.
CAMPPLUS_LEGACY_FILENAME = "speech_campplus_sv_zh-cn_16k-common.onnx"


def _speaker_bundled_base() -> Path:
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass) / "models"
    return Path(__file__).resolve().parent.parent / "models"


def speaker_model_path_or_none(spec: SpeakerModelSpec) -> Path | None:
    """Resolve a usable speaker .onnx: bundled first, then download cache."""
    bundled = _speaker_bundled_base() / spec.filename
    if bundled.is_file():
        return bundled
    cached = _download_base() / spec.model_id / spec.filename
    if not cached.is_file():
        return None
    marker = cached.parent / ".version"
    if not marker.is_file() or marker.read_text(encoding="utf-8").strip() != spec.version:
        return None
    return cached


def ensure_speaker_model(model_id: str) -> Path | None:
    """Resolve a speaker model, downloading it on demand if missing.

    Used for ResNet293 (too big to bundle). Verifies sha256 before accepting.
    Returns the .onnx path, or None on any failure (caller falls back).
    """
    import hashlib
    import urllib.request

    spec = SPEAKER_MODEL_SPECS.get(model_id)
    if spec is None:
        return None
    hit = speaker_model_path_or_none(spec)
    if hit is not None:
        return hit
    dest_dir = _download_base() / spec.model_id
    dest = dest_dir / spec.filename
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".onnx.downloading")
        log.info("[models] downloading speaker model %s (%.1f MB)...",
                 model_id, spec.size_bytes / 1024 / 1024)
        urllib.request.urlretrieve(spec.url, tmp)
        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
        if digest != spec.sha256:
            log.warning("[models] sha256 mismatch for %s — discarding", model_id)
            tmp.unlink(missing_ok=True)
            return None
        tmp.rename(dest)
        (dest_dir / ".version").write_text(spec.version, encoding="utf-8")
        log.info("[models] speaker model %s ready at %s", model_id, dest)
        return dest
    except Exception as exc:
        log.warning("[models] download failed for %s: %s", model_id, exc)
        return None
