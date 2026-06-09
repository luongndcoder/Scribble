# Phase 3: Packaging + manual validation + threshold re-tune

**blockedBy:** phase-02-impl.
**Goal:** Bundle model, build, đo trên audio thật, chốt ngưỡng, validate cả 2 path.

## Steps

1. **Bundle** (`scribble-sidecar.spec`): thêm `('models/speech_campplus_sv_zh-cn_16k-common.onnx', 'models')` vào `datas`. Giữ `voxceleb_CAM++.onnx` (fallback). Build sidecar → verify cả 2 file trong `_internal/models/`.

2. **Build** sidecar (PyInstaller) + tar.zst (COPYFILE_DISABLE, AppleDouble=0) + app (`tauri build --bundles app`), cài `/Applications`.

3. **Đo + re-tune ngưỡng** (cần audio tiếng Việt ≥2 người **cùng giới**):
   - Ghi/upload → đọc `~/.voicescribe/sidecar.log` dòng `[diarize] sims=[...]`.
   - Xem cosine giữa 2 người cùng giới: nếu vẫn > `MATCH_THRESHOLD` (gộp) → hạ `DIARIZE_MATCH_THRESHOLD` hoặc tăng `DIARIZE_NEW_SPEAKER_CONFIRM_HITS` linh hoạt; nếu over-split (1 người thành nhiều) → ngược lại.
   - Tune qua **env trước** (không rebuild) để hội tụ nhanh, rồi chốt vào default trong `diarize.py` + cập nhật `test_diarize_migration.py` case 4.

4. **Manual acceptance (gate cuối):**
   - [ ] Realtime (nvidia) meeting ≥2 người cùng giới → tách đúng ≥2 speaker.
   - [ ] Upload file tương tự → tách đúng (offline clustering).
   - [ ] 1 người nói dài → KHÔNG over-split.
   - [ ] A/B với voxceleb: model mới tách tốt hơn rõ rệt (log số liệu).

5. **Doc delta:** cập nhật `docs/context/*` nếu có ghi diarizer model; ghi `docs/decisions/2026-06-08-diarizer-campplus-200k.md` (vì đổi model asset core — architectural decision).

## Acceptance
- [ ] 2 model trong bundle; build sạch (AppleDouble=0); app chạy.
- [ ] Manual gate pass cả realtime + upload; A/B chứng minh cải thiện.
- [ ] Default thresholds chốt + test case 4 xanh.
- [ ] Decision doc ghi lại.

> Nếu manual gate FAIL (không cải thiện thật) → rollback (đổi ưu tiên path về voxceleb + revert constants), báo user.
