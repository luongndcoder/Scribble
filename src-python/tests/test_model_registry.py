"""Phase 04 (Slice B) — RED tests for the local STT model registry.

Contract (implemented in Phase 06, src-python/local/model_registry.py):

    ModelSpec{model_id, version, files, url, sha256, size_bytes, archive, license}
    MODEL_REGISTRY: dict[str, ModelSpec]          # keys "A" | "B" | "C"
    resolve(tier: str) -> ModelSpec               # unknown tier -> Tier C
    _bundled_base() -> Path                       # dir holding bundled models
    bundled_model_dir(spec) -> Path | None        # present + complete -> Path
    download_cache_dir(spec) -> Path | None        # ~/.voicescribe cache (Tier A/B)
    model_path_or_none(spec) -> Path | None        # bundled -> cache -> None

Tier C (Phase 1) ships bundled, so model_path_or_none resolves the bundled dir.
"""

import pytest

TIER_C_FILES = ("tokens.txt", "encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx")


# ── resolve / registry shape ─────────────────────────────────────────────────


def test_resolve_tier_c_returns_vietnamese_zipformer_spec():
    from local.model_registry import resolve

    spec = resolve("C")
    assert "zipformer-vi-30M-int8" in spec.model_id
    assert spec.license == "cc-by-nc-nd-4.0"
    assert spec.archive in ("tar.bz2", "tar.zst")
    # required sherpa transducer files
    for f in TIER_C_FILES:
        assert f in spec.files


def test_resolve_tier_c_url_points_to_k2fsa_release():
    from local.model_registry import resolve

    spec = resolve("C")
    assert spec.url.startswith("https://")
    assert "k2-fsa" in spec.url
    assert spec.url.endswith((".tar.bz2", ".tar.zst"))


def test_resolve_unknown_tier_falls_back_to_c():
    from local.model_registry import resolve

    assert resolve("Z").model_id == resolve("C").model_id


@pytest.mark.parametrize("tier", ["A", "B"])
def test_resolve_ab_specs_exist_without_raising(tier):
    from local.model_registry import resolve

    spec = resolve(tier)
    assert spec.model_id  # placeholder ok, just must not raise


# ── bundled resolution ───────────────────────────────────────────────────────


@pytest.fixture
def fake_bundle(tmp_path, monkeypatch):
    """Point _bundled_base() at tmp_path and return a helper to create a
    (complete or partial) bundled model dir for a spec."""
    from local import model_registry

    monkeypatch.setattr(model_registry, "_bundled_base", lambda: tmp_path)

    def _make(spec, *, complete=True):
        d = tmp_path / spec.model_id
        d.mkdir(parents=True, exist_ok=True)
        files = spec.files if complete else spec.files[:-1]  # drop one if partial
        for f in files:
            (d / f).write_bytes(b"x")
        return d

    return _make


def test_bundled_model_dir_found_when_complete(fake_bundle):
    from local.model_registry import resolve, bundled_model_dir

    spec = resolve("C")
    expected = fake_bundle(spec, complete=True)
    assert bundled_model_dir(spec) == expected


def test_bundled_model_dir_none_when_incomplete(fake_bundle):
    from local.model_registry import resolve, bundled_model_dir

    spec = resolve("C")
    fake_bundle(spec, complete=False)  # missing one required file
    assert bundled_model_dir(spec) is None


def test_bundled_model_dir_none_when_absent(tmp_path, monkeypatch):
    from local import model_registry
    from local.model_registry import resolve, bundled_model_dir

    monkeypatch.setattr(model_registry, "_bundled_base", lambda: tmp_path)
    assert bundled_model_dir(resolve("C")) is None


# ── model_path_or_none precedence ────────────────────────────────────────────


def test_model_path_prefers_bundled(fake_bundle):
    from local.model_registry import resolve, model_path_or_none

    spec = resolve("C")
    expected = fake_bundle(spec, complete=True)
    assert model_path_or_none(spec) == expected


def test_model_path_none_when_nothing_available(tmp_path, monkeypatch):
    from local import model_registry
    from local.model_registry import resolve, model_path_or_none

    # No bundle, no download cache.
    monkeypatch.setattr(model_registry, "_bundled_base", lambda: tmp_path)
    monkeypatch.setattr(model_registry, "_download_base", lambda: tmp_path / "dl")
    assert model_path_or_none(resolve("C")) is None
