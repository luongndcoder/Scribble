# Upload Audio File → Generate Minutes — Tổng quan

> Tính năng cho phép user upload file ghi âm có sẵn (mp3/wav/m4a/mp4/...) để tạo biên bản, song song với flow ghi âm realtime đã có.

## Quyết định kiến trúc đã chốt

| # | Quyết định | Lý do |
|---|-----------|-------|
| D1 | **Endpoint upload chuyên dụng** ở backend, KHÔNG tái dùng `/transcribe-diarize` | Endpoint cũ có contract realtime (chunk ≤30s), sửa là vỡ flow đang chạy |
| D2 | **Tauri Rust stream upload** thay vì browser FormData | WebKitGTK trên Linux dễ OOM với file >500MB. Rust stream block 4MB an toàn 3 OS |
| D3 | **Một meeting = một nguồn** (realtime XOR upload) | Đơn giản state management, không phát sinh feature `merge meetings` |
| D4 | **UI mutex**: không cho mở upload khi đang record và ngược lại | Tránh diarizer profile ô nhiễm, tránh sidecar overload |
| D5 | **BatchDiarizer riêng**, không reuse `BackgroundReconciler` | Algorithm khác (global clustering tốt hơn streaming cho batch) |
| D6 | **Feature flag default ON** (`feature_upload_audio_enabled`) — opt-out duy nhất cho dev/QA, end user không phải làm gì | Nguyên tắc zero-manual-setup: cài app là dùng được ngay (chỉ API key/model mới cần user nhập). |
| D7 | **Job persist in-memory** ở v1, defer SQLite job state | YAGNI — chỉ làm khi telemetry cho thấy sidecar hay crash |
| D8 | **scipy** cho clustering, KHÔNG sklearn | sklearn đã trong PyInstaller excludes (tăng installer ~50MB); scipy đã có sẵn |

## Tính năng bao gồm

### v1 (must-have)
- Upload 1 file audio/video → tạo meeting mới
- Format: `.mp3 .wav .m4a .webm .ogg .flac .mp4 .mov` (extract audio nếu là video)
- Streaming progress qua SSE (upload% → transcribe per-chunk → diarize → summarize)
- Cancel job giữa chừng
- Idempotency hash check (cùng file → hỏi mở lại meeting cũ)
- Edit transcript inline trước khi summarize (tái dùng UI cũ)
- Cross-platform: Windows + macOS + Linux

### v1 KHÔNG bao gồm (defer)
- Multi-file upload queue (drop 5 file một lúc)
- Resume on sidecar crash (cần SQLite job state)
- Drag-and-drop file (WebKitGTK buggy)
- Cabin translation cho upload
- Auto language detection
- Merge meetings (gộp realtime + upload thành 1 meeting)

## Cấu trúc 4 phase (~8.5 ngày)

| Phase | Thời gian | Output |
|-------|----------|--------|
| **Phase 0** | 0.5 ngày | Pre-flight: ffmpeg verify, regression checklist, baseline tag |
| **Phase 1** | 1.5 ngày | Backend skeleton + job runner + feature flag + DB migration |
| **Phase 1.5** | 1 ngày | Tauri upload bridge (Rust + plugin-dialog + reqwest stream) |
| **Phase 2** | 2.5 ngày | Pipeline (normalize → VAD split → STT/diarize parallel → BatchDiarizer + global clustering + chunk overlap) |
| **Phase 3** | 1.5 ngày | Frontend UI (upload page, progress, pre-flight estimate, streaming transcript) |
| **Phase 4** | 2 ngày | Cross-platform test matrix (9 cells), idempotency hash, polish |

## File mới được tạo (không sửa file cũ trừ register)

```
src-python/
  api/
    upload.py              # POST /meetings/upload-audio, GET /jobs/{id}, /jobs/{id}/events
  services/
    upload_pipeline.py     # orchestrator: normalize → split → STT → diarize → save
    batch_diarizer.py      # global clustering version (scipy)
    vad_splitter.py        # silero/silence-based splitting với overlap

src-tauri/src/
  upload.rs                # tauri commands: pick_file, stream_upload, cancel

src/components/upload/
  UploadAudioPage.tsx
  UploadProgress.tsx
  use-upload.ts
  upload-api.ts

docs/upload-feature/       # ← bạn đang ở đây
```

## Tham chiếu các file plan

- [01-cross-platform-rules.md](./01-cross-platform-rules.md) — nguyên tắc lock-in cho 3 OS
- [02-regression-checklist.md](./02-regression-checklist.md) — happy path phải pass sau mỗi phase
- [03-phase-1-backend-skeleton.md](./03-phase-1-backend-skeleton.md) — API contract + job runner
- [04-phase-2-pipeline.md](./04-phase-2-pipeline.md) — pipeline xử lý file dài

## Pre-flight findings (Phase 0)

### ✅ ffmpeg
- `find_ffmpeg()` đã cover macOS/Linux/Windows với fallback paths phong phú
- Windows CI bundle `ffmpeg.exe` vào `src-tauri/binaries/` (verify nó có vào installer NSIS không — task cho Phase 4)
- Linux CI install ffmpeg vào build env, end user phải có system ffmpeg (deb có thể declare dep)
- macOS user phải `brew install ffmpeg` (đã document trong README)
- **Kết luận**: pre-existing fragility, KHÔNG block tính năng upload. Cải thiện bundle ffmpeg → backlog riêng.

### ✅ Tauri plugins
- `reqwest 0.12` với feature `multipart` đã có trong [Cargo.toml](../../src-tauri/Cargo.toml) → stream upload OK
- **THIẾU `tauri-plugin-dialog`** → phải thêm trong Phase 1.5
- Capabilities hiện tại ([default.json](../../src-tauri/capabilities/default.json)) chưa có `dialog:*` permission → cần thêm

### ✅ CI workflows
- `build.yml` (Windows) + `build-linux.yml` đã có `workflow_dispatch`
- Cả 2 install `ffmpeg` trong build env
- Có thể trigger build cross-platform sau mỗi phase để smoke test

### ✅ Baseline
- Tag `v1.1.4` đã tồn tại → có điểm rollback rõ ràng

## Rủi ro & mitigation

| Rủi ro | Severity | Mitigation |
|--------|---------|-----------|
| Vỡ realtime recording flow | High | Code mới ở file riêng, không patch file cũ. Regression checklist sau mỗi phase |
| `BackgroundReconciler` ô nhiễm | High → Low | BatchDiarizer riêng, UI mutex chặn concurrent recording+upload |
| WebKitGTK Linux OOM với file lớn | High → Low | Rust streaming, không qua JS heap |
| ffmpeg không có trên Linux/Windows end user | Medium | Inherit existing behavior, document rõ, Phase 4 cải thiện bundle |
| Riva concurrency limit | Medium | `asyncio.Semaphore(3)` mặc định, expose ra settings |
| Speaker ID không nhất quán xuyên file dài | High → Low | Global clustering với scipy, không streaming |
| Sidecar crash giữa file 2h | Medium | v1 mark job failed khi restart; v2 persist state ra SQLite |
| Unicode filename (tiếng Việt NFD/NFC) | Medium | `unicodedata.normalize('NFC')` ngay tại upload entry point |
