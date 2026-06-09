# Phase 1 (IMPL): Loader + node-name introspection (GREEN)

**blockedBy:** phase-01-test-review-loader (approved).
**Goal:** Làm 7 test xanh. Tối thiểu, surgical.

## Changes

### `src-python/diarize.py` — `_init_model`
1. Thêm model mới vào candidate filenames, ưu tiên trước voxceleb:
   ```python
   MODEL_FILENAMES = ["speech_campplus_sv_zh-cn_16k-common.onnx", "voxceleb_CAM++.onnx"]
   ```
   Lặp candidates dir × filenames; lấy file đầu tiên tồn tại (ưu tiên model mới). Giữ nguyên logic resolve dir (`_MEIPASS/models`, exe_dir, Resources, file_dir).
2. Sau khi tạo `InferenceSession`, introspect:
   ```python
   self._in_name  = self._session.get_inputs()[0].name
   self._out_name = self._session.get_outputs()[0].name
   self._emb_dim  = self._session.get_outputs()[0].shape[-1]  # expect 512
   ```
   Init `self._in_name=None/_out_name=None` trong `__init__`.
3. Log model nào được load (`[diarize] loaded model: <filename>`).
4. Dim check hiện tại `!= 512`: giữ, hoặc dùng `self._emb_dim` nếu spike báo khác.

### `src-python/diarize.py` — `_identify_campplus`
- Đổi `self._session.run(['embs'], {'feats': fbank_input})` →
  `self._session.run([self._out_name], {self._in_name: fbank_input})`.

### `src-python/services/batch_diarizer.py` — `extract_embedding`
- Đổi `diarizer._session.run(["embs"], {"feats": fbank_input})` →
  `diarizer._session.run([diarizer._out_name], {diarizer._in_name: fbank_input})`.
- Guard: nếu `_in_name` None (model chưa load) → gọi `diarizer._init_model()` trước (đã có guard `_session`).

### Model asset
- Đặt `speech_campplus_sv_zh-cn_16k-common.onnx` vào `src-python/models/` (từ phase-00).

## Verify
- `pytest tests/test_diarize_loader.py` → 7 xanh.
- Full suite không regress.

## Acceptance
- [ ] 7 test xanh; node names introspected; batch dùng tên introspected; fallback hoạt động; full suite pass.
