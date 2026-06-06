# Phase 12 — IMPL: Provider routing (local)

**Slice D · green.** blockedBy: 11

## Files
- MODIFY `src-python/services/upload_pipeline.py` (~40 LOC):
  - `:457` và `:1465-1467`: validation set `{nvidia, soniox}` → `{nvidia, soniox, local}`.
  - Thêm branch `if stt_provider == "local":` quanh `:1516-1522` → `transcribe_local_file(chunk.path, language)` (no key). CAM++ emb_task (`:1524`) giữ nguyên.
- MODIFY `src-python/main.py` (~30 LOC):
  - Quanh `:339`: nếu `stt_provider == "local"` → fallback provider cloud đã cấu hình (default nvidia) cho realtime; log `STATUS: realtime fallback cloud (local batch-only)`.
  - **[RED-TEAM privacy] BẮT BUỘC:** nếu provider=local + KHÔNG có cloud API key → **KHÔNG fallback im lặng**. Trả lỗi/sự kiện rõ "Realtime offline chưa hỗ trợ trên máy này (CPU). Dùng Upload file, hoặc cấu hình cloud key." Không gửi audio lên cloud khi user chưa biết.

## Notes
- KHÔNG đổi WS payload shape. KHÔNG thêm streaming class.
- Surgical edits — chỉ chạm dòng cần thiết.

## Done when
Test Phase 10 pass; test cloud cũ (nếu có) vẫn pass (no regression).

## Rubric: general-code
