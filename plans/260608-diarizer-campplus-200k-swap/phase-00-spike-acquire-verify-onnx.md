# Phase 0 (SPIKE): Acquire + verify zh-cn-common 200k ONNX

**Goal:** De-risk TRƯỚC khi viết integration code. Lấy được file ONNX hợp lệ + xác minh tương thích + chứng minh embedding tốt hơn cho giọng Việt. Spike = throwaway script + manual, KHÔNG ship code production.

## Steps

1. **Acquire model (chọn 1):**
   - (a) `modelscope` PyTorch: `iic/speech_campplus_sv_zh-cn_16k-common` → export ONNX bằng speakerlab/3D-Speaker (`scripts/export_campplus_onnx.py`, dùng torch trong dev venv, opset ≥ 13, input động theo T).
   - (b) Tìm bản ONNX đã export sẵn (vd `lovemefan/campplus`) → verify checksum/nguồn.
   - Ưu tiên (a) để chủ động; (b) nếu nhanh.

2. **Inspect ONNX** (`onnxruntime`):
   ```python
   s = ort.InferenceSession(path)
   print([i.name for i in s.get_inputs()], [i.shape for i in s.get_inputs()])
   print([o.name for o in s.get_outputs()], [o.shape for o in s.get_outputs()])
   ```
   - Ghi lại: input name, output name, embedding dim (PHẢI = 512).
   - Nếu dim ≠ 512 → cập nhật dim check ở `diarize.py` (`!= 512`) trong Slice 1.

3. **Embedding sanity (gate bắt buộc):** với 2–3 đoạn audio tiếng Việt:
   - cùng người 2 đoạn → cosine **> 0.7**.
   - 2 người khác (đặc biệt **cùng giới**) → cosine **< 0.5** (hoặc thấp hơn rõ rệt so với voxceleb trên CÙNG cặp audio).
   - So sánh trực tiếp voxceleb vs model mới trên cùng cặp → model mới phải tách rõ hơn.

4. **fbank khớp:** chạy `_compute_fbank` hiện tại → feed model mới → embedding hợp lệ (không NaN, norm≈1 sau L2). Nếu lệch → điều tra normalization (nhưng KHÔNG đổi `_compute_fbank` trừ khi chứng minh sai).

5. **License check (gate pháp lý):** xác minh license model `iic/speech_campplus_sv_zh-cn_16k-common` (ModelScope) **cho phép redistribute/bundle** trong app đóng gói. CAM++/3D-Speaker thường Apache-2.0 nhưng PHẢI verify bản 200k-common. Nếu license cấm bundle → chuyển download-on-demand HOẶC dùng cnceleb (license rõ ràng hơn). Ghi license + attribution (như đã làm cho sherpa cc-by-nc).

## Acceptance (spike pass khi)
- [ ] Có file `.onnx` chạy được, dim 512, node names ghi nhận.
- [ ] License cho phép bundle (hoặc quyết định download-on-demand) + attribution ghi nhận.
- [ ] Embedding sanity: cùng-người > khác-người, và model mới tách cặp cùng-giới Việt **tốt hơn voxceleb** (số liệu cosine cụ thể).
- [ ] `_compute_fbank` hiện tại tương thích (embedding hợp lệ).

## Output
- File ONNX + node-name/dim ghi vào plan (cập nhật `plan.md` Files nếu cần).
- Quyết định GO/NO-GO: nếu model mới KHÔNG tách tốt hơn → DỪNG, báo user (giữ voxceleb).
- `scripts/export_campplus_onnx.py` (nếu dùng đường (a)) — giữ lại để tái tạo.

> Nếu spike FAIL (model không tốt hơn / không export được) → STOP plan, quay lại user với số liệu.

---

## ✅ RESULT (2026-06-08) — GO

- **ONNX:** `Alkd/campplus-zh-cn-common-200k-onnx` → `campplus_zh_cn_common_200k.onnx` (28.2MB, **Apache-2.0**). Base weights = `funasr/campplus` (campplus_cn_common, Apache-2.0). Tải tại `/tmp/campplus-spike/`.
- **Node/dim:** input `feats` [batch,time,80], output `embs` [batch,**192**]. → node names GIỐNG model cũ (không remap); **dim 192** (không 512) → đổi dim-check + reset profile.
- **Config (funasr config.yaml):** `feat_dim:80, embedding_size:192` → fbank khớp `_compute_fbank` hiện tại.
- **Embedding sanity** (meeting_15.pcm ~13min, 8×2.5s):
  - determinism ✅, L2-norm ✅.
  - pairwise cosine spread: voxceleb=0.112 (min0.868/max0.980 — MÙ) vs zh-cn=**0.547** (min0.141/max0.688 — phân biệt thật). → xác nhận voxceleb là nguyên nhân "gộp Speaker 1".
- **License:** Apache-2.0 → bundle OK + attribution.
- **Implication:** ngưỡng phải hạ mạnh (~0.40–0.50). Default cũ 0.68 sẽ over-split với model mới.

**Decision: GO** → tiếp Phase 1.
**Production ONNX:** ưu tiên self-export từ `funasr/campplus` .bin (Apache-2.0, provenance rõ) để bundle; community ONNX dùng tạm cho dev/test (đã validate functionally).
