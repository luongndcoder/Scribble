"""Phase 2 — RED tests for the local model download manager (Tier A nemotron)."""

import pytest


@pytest.fixture
def patch_tier(monkeypatch):
    import local_stt

    def _set(tier, mlx):
        monkeypatch.setattr(local_stt, "_active_tier", lambda: tier)
        monkeypatch.setattr(local_stt, "_mlx_available", lambda: mlx)

    return _set


def test_active_model_tier_a_is_nemotron(patch_tier, monkeypatch):
    from local import model_download

    patch_tier("A", True)
    monkeypatch.setattr(model_download, "is_mlx_cached", lambda: False)
    info = model_download.active_local_model()
    assert info["engine"] == "mlx"
    assert "nemotron" in info["model_id"]
    assert info["needs_download"] is True
    assert info["cached"] is False


def test_active_model_tier_a_cached(patch_tier, monkeypatch):
    from local import model_download

    patch_tier("A", True)
    monkeypatch.setattr(model_download, "is_mlx_cached", lambda: True)
    assert model_download.active_local_model()["cached"] is True


def test_active_model_tier_c_is_sherpa_bundled(patch_tier):
    from local import model_download

    patch_tier("C", False)
    info = model_download.active_local_model()
    assert info["engine"] == "sherpa"
    assert info["needs_download"] is False
    assert info["cached"] is True


def test_active_model_apple_silicon_without_mlx_falls_back_to_sherpa(patch_tier):
    from local import model_download

    patch_tier("A", False)  # Apple Silicon but mlx not importable
    assert model_download.active_local_model()["engine"] == "sherpa"


def test_start_download_when_cached_is_done(monkeypatch):
    from local import model_download

    monkeypatch.setattr(model_download, "is_mlx_cached", lambda: True)
    st = model_download.start_mlx_download()
    assert st["status"] == "done"
    assert st["progress"] == 1.0


def test_is_mlx_cached_false_while_blob_incomplete(monkeypatch, tmp_path):
    """Regression: snapshot_download(local_files_only=True) resolves the instant
    the tiny config/tokenizer files land, but the 720MB model.safetensors may
    still be streaming as a `*.incomplete` blob. is_mlx_cached() must report
    False until that incomplete blob is renamed — otherwise the UI flips to
    'ready' mid-download."""
    from local import model_download

    repo = tmp_path / "models--mlx-community--nemotron"
    (repo / "blobs").mkdir(parents=True)
    (repo / "blobs" / "abc123.incomplete").write_bytes(b"partial")

    # snapshot ref resolves fine (small files present) ...
    monkeypatch.setattr(
        "huggingface_hub.snapshot_download", lambda *a, **k: str(repo)
    )
    monkeypatch.setattr(model_download, "_repo_cache_dir", lambda: repo)
    assert model_download.is_mlx_cached() is False

    # ... once the incomplete blob is renamed (download done), reports True.
    (repo / "blobs" / "abc123.incomplete").rename(repo / "blobs" / "abc123")
    assert model_download.is_mlx_cached() is True
