"""Phase 1 (RED) — loader + node-name introspection for the CAM++ zh-cn-common
200k swap.

These tests pin the contract of the NEW embedding model:
  - diarizer loads the 200k model (embedding dim 192, NOT voxceleb's 512)
  - ONNX input/output node names are introspected (not hardcoded 'feats'/'embs')
  - batch_diarizer.extract_embedding honors the introspected names + 192 dim
  - resolves the zh-cn 200k model (legacy voxceleb removed)

Synthetic deterministic audio is used — these verify load/dim/determinism, NOT
speaker discrimination (that is the manual acceptance gate in phase-03).
"""

import os
import wave

import numpy as np
import pytest

from diarize import SpeakerDiarizer

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models")
NEW_MODEL = os.path.join(MODELS_DIR, "speech_campplus_sv_zh-cn_16k-common.onnx")
EXPECTED_DIM = 192


@pytest.fixture
def sample_audio() -> np.ndarray:
    """Deterministic 2.5s 16kHz mono float32 (two-tone sine mix)."""
    sr = 16000
    t = np.arange(int(2.5 * sr)) / sr
    sig = 0.3 * np.sin(2 * np.pi * 180 * t) + 0.2 * np.sin(2 * np.pi * 320 * t)
    return sig.astype(np.float32)


@pytest.fixture
def sample_wav(tmp_path, sample_audio) -> str:
    path = str(tmp_path / "sample_16k.wav")
    pcm = (sample_audio * 32767).clip(-32768, 32767).astype(np.int16)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(pcm.tobytes())
    return path


@pytest.fixture
def diarizer() -> SpeakerDiarizer:
    d = SpeakerDiarizer()
    d._init_model()
    if not getattr(d, "_session", None):
        pytest.skip("no ONNX diarizer session available")
    return d


@pytest.mark.skipif(not os.path.exists(NEW_MODEL), reason="new model asset missing")
def test_model_loads(diarizer):
    assert diarizer._session is not None
    assert diarizer._model_loaded is True


@pytest.mark.skipif(not os.path.exists(NEW_MODEL), reason="new model asset missing")
def test_node_names_introspected(diarizer):
    # Must be discovered from the session, not hardcoded.
    assert getattr(diarizer, "_in_name", None), "missing introspected input node name"
    assert getattr(diarizer, "_out_name", None), "missing introspected output node name"
    sess_in = {i.name for i in diarizer._session.get_inputs()}
    sess_out = {o.name for o in diarizer._session.get_outputs()}
    assert diarizer._in_name in sess_in
    assert diarizer._out_name in sess_out


@pytest.mark.skipif(not os.path.exists(NEW_MODEL), reason="new model asset missing")
def test_embedding_dim_is_192(diarizer, sample_audio):
    res = diarizer.identify_speaker_from_samples(sample_audio, 16000, update_profiles=False)
    emb = res.get("embedding")
    assert emb is not None
    assert emb.shape == (EXPECTED_DIM,), f"expected {EXPECTED_DIM}-dim, got {emb.shape}"


@pytest.mark.skipif(not os.path.exists(NEW_MODEL), reason="new model asset missing")
def test_embedding_l2_normalized(diarizer, sample_audio):
    res = diarizer.identify_speaker_from_samples(sample_audio, 16000, update_profiles=False)
    emb = res["embedding"]
    assert abs(np.linalg.norm(emb) - 1.0) < 1e-3


@pytest.mark.skipif(not os.path.exists(NEW_MODEL), reason="new model asset missing")
def test_embedding_deterministic(diarizer, sample_audio):
    e1 = diarizer.identify_speaker_from_samples(sample_audio, 16000, update_profiles=False)["embedding"]
    e2 = diarizer.identify_speaker_from_samples(sample_audio, 16000, update_profiles=False)["embedding"]
    assert np.allclose(e1, e2, atol=1e-5)


@pytest.mark.skipif(not os.path.exists(NEW_MODEL), reason="new model asset missing")
def test_batch_extract_embedding_dim_192(diarizer, sample_wav):
    from services.batch_diarizer import extract_embedding
    emb = extract_embedding(diarizer, sample_wav)
    assert emb is not None
    assert np.asarray(emb).shape[-1] == EXPECTED_DIM


@pytest.mark.skipif(not os.path.exists(NEW_MODEL), reason="new model asset missing")
def test_extract_embedding_lazy_inits_uninitialized_diarizer(sample_wav):
    """Regression: the upload pipeline imports a SECOND `main` module under
    PyInstaller whose diarizer never had _init_model() called (_session=None).
    extract_embedding must lazy-init it instead of silently returning None
    (which collapsed every speaker to 1)."""
    from services.batch_diarizer import extract_embedding
    d = SpeakerDiarizer()  # deliberately NOT initialized
    assert d._session is None
    emb = extract_embedding(d, sample_wav)
    assert d._session is not None, "extract_embedding must lazy-init the model"
    assert emb is not None and np.asarray(emb).shape[-1] == EXPECTED_DIM


def test_model_filenames_is_zh_cn_200k():
    """Loader resolves the CAM++ zh-cn 200k model. The legacy voxceleb model
    was removed (useless for Vietnamese), so it must NOT be referenced."""
    import diarize
    names = getattr(diarize, "MODEL_FILENAMES", None)
    assert names, "MODEL_FILENAMES list missing"
    assert names[0] == "speech_campplus_sv_zh-cn_16k-common.onnx"
    assert not any("voxceleb" in n for n in names)
