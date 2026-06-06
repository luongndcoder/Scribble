"""Phase 13 (Slice E) — RED tests for the local STT device-info endpoint helper.

Contract (Phase 15, api/settings.py):
    build_local_device_info(override: str | None) -> dict
      keys: tier, os, arch, has_cuda, reason, model_available,
            model_id, license, supported_languages
"""

import types

import pytest


@pytest.fixture
def patch_settings(monkeypatch):
    """Patch device detection + model resolution as seen by api.settings."""
    from api import settings as settings_mod

    def _set(*, tier="C", has_cuda=False, model_available=True):
        info = types.SimpleNamespace(
            tier=tier, os="Linux", arch="x86_64", has_cuda=has_cuda,
            reason="test reason",
        )
        monkeypatch.setattr(settings_mod, "get_device_info", lambda override=None: info)
        monkeypatch.setattr(
            settings_mod, "model_path_or_none",
            lambda spec: ("/fake/model" if model_available else None),
        )

    return _set


def test_device_info_has_required_keys(patch_settings):
    from api.settings import build_local_device_info

    patch_settings()
    out = build_local_device_info("auto")
    for k in ("tier", "os", "arch", "has_cuda", "reason",
              "model_available", "model_id", "license", "supported_languages"):
        assert k in out


def test_model_available_true_when_resolved(patch_settings):
    from api.settings import build_local_device_info

    patch_settings(model_available=True)
    assert build_local_device_info("auto")["model_available"] is True


def test_model_available_false_when_missing(patch_settings):
    from api.settings import build_local_device_info

    patch_settings(model_available=False)
    assert build_local_device_info("auto")["model_available"] is False


def test_tier_c_is_vietnamese_only(patch_settings):
    from api.settings import build_local_device_info

    patch_settings(tier="C")
    assert build_local_device_info("auto")["supported_languages"] == ["vi"]
