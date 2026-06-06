"""Shared pytest fixtures for the Scribble sidecar test suite.

Phase 01 (Slice A) only needs lightweight monkeypatch helpers for device
detection; richer fixtures (fake_model_dir, fake_settings_db) are added in
later slices (Phase 04+).
"""

import pytest


@pytest.fixture
def patch_platform(monkeypatch):
    """Return a setter that patches platform.system()/machine() on the
    device_detect module under test.

    Usage:
        patch_platform(system="Darwin", machine="arm64")
    """

    def _set(system: str, machine: str):
        from local import device_detect

        monkeypatch.setattr(device_detect.platform, "system", lambda: system)
        monkeypatch.setattr(device_detect.platform, "machine", lambda: machine)

    return _set


@pytest.fixture
def patch_providers(monkeypatch):
    """Patch onnxruntime.get_available_providers() as seen by device_detect.

    Usage:
        patch_providers(["CUDAExecutionProvider", "CPUExecutionProvider"])
    """

    def _set(providers: list[str]):
        from local import device_detect

        monkeypatch.setattr(
            device_detect.ort, "get_available_providers", lambda: list(providers)
        )

    return _set
