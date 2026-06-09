# Phase 1 (TEST): Loader + node-name introspection (RED)

**Depends:** phase-00 (ONNX file đã có + verified).
**Goal:** Viết unit tests (fail trước) cho việc load model mới + introspect node names + embedding dim/determinism + fallback. CHỈ tests, chưa impl.

## Test file: `src-python/tests/test_diarize_loader.py`

Fixtures (conftest): `diarizer_real` — instance `SpeakerDiarizer`, gọi `_init_model()`; skip nếu model file không tồn tại (`pytest.mark.skipif`).

### Cases
1. `test_model_loads`: sau `_init_model()`, `_session is not None`, `_model_loaded is True`.
2. `test_node_names_introspected`: `diarizer._in_name` và `_out_name` là string non-empty, lấy từ `session.get_inputs()/get_outputs()` (KHÔNG hardcode `feats`/`embs`). Assert dùng được để run.
3. `test_embedding_dim_512`: `identify_speaker_from_samples(samples)` (hoặc trực tiếp `_identify_campplus`) → `embedding` shape (512,).
4. `test_embedding_l2_normalized`: `np.linalg.norm(embedding) ≈ 1.0` (tol 1e-3).
5. `test_embedding_deterministic`: cùng samples 2 lần → embedding giống (allclose), `update_profiles=False`.
6. `test_batch_extract_embedding_uses_introspected_names`: `extract_embedding(diarizer, wav_path)` trả vector 512-dim, không `KeyError`/`InvalidArgument` về tên node.
7. `test_fallback_to_voxceleb_when_primary_missing`: monkeypatch candidate paths để model mới "thiếu" nhưng voxceleb còn → load voxceleb, không crash, `_session` not None.

### Test data
- `tests/fixtures/sample_16k.wav` — 1 đoạn ~2s 16kHz mono (determinism + dim). Không cần đa speaker.

## Expected: tất cả FAIL/ERROR (chưa có `_in_name`/`_out_name`, batch vẫn hardcode, chưa có path model mới).

## Acceptance
- [ ] 7 test viết xong, chạy ra RED đúng lý do (thiếu impl), không phải lỗi import/fixture.
