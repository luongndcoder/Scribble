"""Phase 01 (Slice A) — RED tests for local STT device-tier detection.

Contract under test (to be implemented in Phase 03, src-python/local/device_detect.py):

    detect_tier(override: str | None = None) -> str   # "A" | "B" | "C"
    get_device_info(override: str | None = None) -> DeviceInfo
    DeviceInfo: {tier, os, arch, has_cuda, reason}

Tier rules:
    A = macOS Apple Silicon (Darwin + arm64)        -> MLX
    B = NVIDIA CUDA available (onnxruntime CUDA EP)  -> NeMo/ONNX-CUDA
    C = everything else (Win/Ubuntu iGPU, Mac Intel) -> PhoWhisper ONNX CPU

These tests fail (ImportError) until Phase 03 implements the module — that is
the expected RED state.
"""

import pytest


# ── #1-#3 auto-detect ───────────────────────────────────────────────────────


def test_tier_a_macos_apple_silicon(patch_platform, patch_providers):
    """#1 macOS arm64 → Tier A (MLX)."""
    from local.device_detect import detect_tier

    patch_platform(system="Darwin", machine="arm64")
    patch_providers(["CPUExecutionProvider"])  # no CUDA on Apple
    assert detect_tier() == "A"


def test_tier_b_cuda_available(patch_platform, patch_providers):
    """#2 CUDA execution provider present → Tier B."""
    from local.device_detect import detect_tier

    patch_platform(system="Linux", machine="x86_64")
    patch_providers(["CUDAExecutionProvider", "CPUExecutionProvider"])
    assert detect_tier() == "B"


@pytest.mark.parametrize(
    "system,machine,providers",
    [
        ("Windows", "AMD64", ["CPUExecutionProvider"]),   # Win iGPU
        ("Linux", "x86_64", ["CPUExecutionProvider"]),    # Ubuntu no GPU
        ("Darwin", "x86_64", ["CPUExecutionProvider"]),   # Mac Intel
    ],
)
def test_tier_c_cpu_only(patch_platform, patch_providers, system, machine, providers):
    """#3 No CUDA and not Apple Silicon → Tier C (CPU)."""
    from local.device_detect import detect_tier

    patch_platform(system=system, machine=machine)
    patch_providers(providers)
    assert detect_tier() == "C"


def test_apple_silicon_does_not_leak_to_b_even_with_cuda_string(
    patch_platform, patch_providers
):
    """Guard: Apple Silicon must resolve to A even if a stray CUDA EP string
    appears (CoreML/MPS builds can list odd providers). A takes precedence."""
    from local.device_detect import detect_tier

    patch_platform(system="Darwin", machine="arm64")
    patch_providers(["CUDAExecutionProvider", "CPUExecutionProvider"])
    assert detect_tier() == "A"


# ── #4 override ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("forced", ["A", "B", "C"])
def test_override_wins_over_autodetect(patch_platform, patch_providers, forced):
    """#4 Explicit override beats auto-detection."""
    from local.device_detect import detect_tier

    patch_platform(system="Linux", machine="x86_64")
    patch_providers(["CPUExecutionProvider"])  # would auto-detect C
    assert detect_tier(override=forced) == forced


def test_override_auto_falls_back_to_autodetect(patch_platform, patch_providers):
    """override='auto' (or None) → behave as auto-detect."""
    from local.device_detect import detect_tier

    patch_platform(system="Darwin", machine="arm64")
    patch_providers(["CPUExecutionProvider"])
    assert detect_tier(override="auto") == "A"


def test_invalid_override_falls_back_to_autodetect(patch_platform, patch_providers):
    """Garbage override must not crash — fall back to auto-detect."""
    from local.device_detect import detect_tier

    patch_platform(system="Linux", machine="x86_64")
    patch_providers(["CPUExecutionProvider"])
    assert detect_tier(override="Z") == "C"


# ── DeviceInfo shape ─────────────────────────────────────────────────────────


def test_device_info_has_all_fields(patch_platform, patch_providers):
    """get_device_info() returns the full shape the Settings UI needs."""
    from local.device_detect import get_device_info

    patch_platform(system="Darwin", machine="arm64")
    patch_providers(["CPUExecutionProvider"])
    info = get_device_info()

    assert info.tier == "A"
    assert info.os == "Darwin"
    assert info.arch == "arm64"
    assert info.has_cuda is False
    assert isinstance(info.reason, str) and info.reason  # non-empty explanation


def test_device_info_reports_cuda_true_for_tier_b(patch_platform, patch_providers):
    from local.device_detect import get_device_info

    patch_platform(system="Linux", machine="x86_64")
    patch_providers(["CUDAExecutionProvider", "CPUExecutionProvider"])
    info = get_device_info()

    assert info.tier == "B"
    assert info.has_cuda is True
