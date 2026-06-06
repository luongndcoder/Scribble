"""Local STT device-tier detection.

Picks which local STT runtime/model tier fits the current machine so the app
can download the right artifact (see model_registry):

    A = macOS Apple Silicon (Darwin + arm64)        -> MLX 8-bit
    B = NVIDIA CUDA available (onnxruntime CUDA EP)  -> NeMo / ONNX-CUDA
    C = everything else (Win/Ubuntu iGPU, Mac Intel) -> PhoWhisper ONNX (CPU)

Precedence is A > B > C: an Apple-Silicon Mac always resolves to MLX even if a
stray CUDA execution provider is listed (some onnxruntime builds advertise odd
providers). Auto-detection can be overridden by the user setting
``local_model_tier`` (``auto`` | ``A`` | ``B`` | ``C``).
"""

import platform
from dataclasses import dataclass

import onnxruntime as ort

from logger import get_logger

log = get_logger(__name__)

_VALID_TIERS = ("A", "B", "C")


@dataclass(frozen=True)
class DeviceInfo:
    """Detected device profile, surfaced to the Settings UI."""

    tier: str
    os: str
    arch: str
    has_cuda: bool
    reason: str


def _has_cuda() -> bool:
    """True when onnxruntime exposes the CUDA execution provider."""
    try:
        return "CUDAExecutionProvider" in ort.get_available_providers()
    except Exception as exc:  # onnxruntime missing/broken — degrade to CPU tier
        log.warning("STATUS: CUDA provider probe failed, assuming none: %s", exc)
        return False


def _is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine().lower() in (
        "arm64",
        "aarch64",
    )


def detect_tier(override: str | None = None) -> str:
    """Resolve the local STT tier ("A" | "B" | "C").

    Args:
        override: Force a tier. ``"A"``/``"B"``/``"C"`` win over auto-detection;
            ``"auto"``, ``None`` or any invalid value fall back to auto-detect.

    Returns:
        Tier code. A > B > C precedence on auto-detect.
    """
    if override in _VALID_TIERS:
        return override

    if _is_apple_silicon():
        return "A"
    if _has_cuda():
        return "B"
    return "C"


def get_device_info(override: str | None = None) -> DeviceInfo:
    """Build the full device profile for the resolved tier."""
    tier = detect_tier(override)
    has_cuda = _has_cuda()
    os_name = platform.system()
    arch = platform.machine()

    reasons = {
        "A": "macOS Apple Silicon — dùng MLX (Metal/ANE)",
        "B": "Phát hiện NVIDIA CUDA — dùng ONNX-CUDA",
        "C": "Không có Apple Silicon / CUDA — dùng PhoWhisper ONNX (CPU)",
    }
    reason = reasons[tier]
    if override in _VALID_TIERS:
        reason = f"Override thủ công tier {override}. {reason}"

    return DeviceInfo(
        tier=tier,
        os=os_name,
        arch=arch,
        has_cuda=has_cuda,
        reason=reason,
    )
