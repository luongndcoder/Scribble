# Plan — Local/Offline STT Provider (Option B) — Scribble

> Date: 2026-06-06 · Mode: `--hard` · Lane: normal-with-strong-validation (desktop app, no merchant_id/Kafka/Mongo) · Brainstorm: `./brainstorm.md`

## Chosen Approach: Option B — on-demand download, opt-in 3-tier local STT

Thêm provider STT thứ 3 `"local"` cạnh `nvidia` (Riva) + `soniox`. Cloud vẫn default. Model **không bundle** — tải on-demand khi user bật, cache theo version ở `~/.voicescribe/models/<tier>/`. Device-detect 3 tier. Reversible, additive.

**Realtime Tier C (đã chốt — 4b-2 KISS):** local chỉ phục vụ **batch upload**; khi **recording realtime trên máy CPU-only** → fallback cloud (Riva/Soniox theo key đã cấu hình). Không làm near-realtime VAD ở Phase 1.

**Rollout:** Phase 1 = **Tier C cross-platform** (PhoWhisper-base ONNX qua onnxruntime — đã là dependency). Phase 2 = Tier A (MLX, macOS arm). Phase 3 = Tier B (nemotron→ONNX + CUDA). Plan này chi tiết **Phase 1**; Phase 2/3 chỉ outline.

## Verified facts (research)

- `nemotron-3.5-asr-streaming-0.6b`: ✅ hỗ trợ tiếng Việt (vi-VN), RNNT + Cache-Aware FastConformer, 16kHz mono, license OpenMDW-1.1 (commercial OK), MLX 8-bit 756MB. **Không có diarization** → giữ CAM++ song song.
- PhoWhisper-base (vinai): WER tiếng Việt 16–19, ~140MB, batch (Whisper-class).
- `onnxruntime>=1.17.0` đã có trong `requirements.txt`. `extract_tar_zst` + version-keyed cache đã có trong `lib.rs`.

## Architecture (Phase 1)

### Modules mới (Python)
- `src-python/local/__init__.py`
- `src-python/local/device_detect.py` — `detect_tier() -> "A"|"B"|"C"` + `DeviceInfo{tier, os, arch, has_cuda, reason}`. Override qua setting `local_model_tier` (`auto|A|B|C`). Tier B detect = `"CUDAExecutionProvider" in onnxruntime.get_available_providers()`.
- `src-python/local/model_registry.py` — `MODEL_REGISTRY` dict (tier → `ModelSpec{model_id, version, url, sha256, size_bytes, archive}`), `resolve(tier, override)`, `model_path_or_none(spec) -> Path|None` (đọc cache, không tải).
- `src-python/local_stt.py` — `LocalSTTEngine` (base) + `PhoWhisperOnnxEngine` (load onnxruntime session, `transcribe_pcm(pcm, lang) -> str`) + `transcribe_local_file(path, language) -> str` (batch contract, không cần api_key). **KHÔNG có `LocalStreamingSTT` ở Phase 1** (4b-2). Tái dùng `filter_hallucinations` / `normalize_vietnamese_text` từ `stt.py`.

### Download/cache — đặt ở Rust `lib.rs`
Lý do: sidecar không thể tự phục vụ STT khi model chưa có; tái dùng `reqwest` + `extract_tar_zst` + version-cache pattern; progress/resume/retry là first-class ở Rust; path cross-OS chuẩn hóa sẵn (`dirs::home_dir`).
- Cache: `~/.voicescribe/models/<tier>/<model_id>/` + `.version` (key `model_id-version`), đối xứng `~/.voicescribe/sidecar/`.
- Tauri commands mới: `ensure_local_model(tier) -> ModelStatus` (download → sha256 verify → extract → emit `local-model-progress`), `local_model_status(tier) -> ModelStatus{installed, downloading, progress, version, path}`.
- Python chỉ **đọc** path; thiếu → trả lỗi rõ ràng "model chưa tải".

### Tích hợp (KHÔNG đổi WS payload contract)
- **Batch** `services/upload_pipeline.py` `:457` và `:1465-1467`: mở validation `{nvidia, soniox}` → `{nvidia, soniox, local}`; branch `local` → `transcribe_local_file` (no key). CAM++ diarization (`:1524`) giữ nguyên chạy song song.
- **Realtime** `main.py` quanh `:339`: nếu `stt_provider=="local"` → **fallback cloud** (dùng provider cloud đã cấu hình, default nvidia). Guard nhỏ, không thêm streaming class.

### Settings / schema
SQLite key-value, **additive, no migration**. Keys mới (default-on-read): `stt_provider` (+value `local`), `local_model_tier`=`auto`, `local_stt_language`=`vi`.
- `api/settings.py`: thêm `GET /api/local/device-info` (trả `detect_tier()` + status). Save loop generic giữ nguyên.
- `src/components/SettingsPanel.tsx`: tab provider thứ 3 "Local (offline)", **không có API key field**, hiển thị detected tier + nút "Tải model" + progress bar + trạng thái + retry; lắng event `local-model-progress`.
- i18n: label + trạng thái download.

## Test Plan

### Test Strategy
- Unit (pytest) cho module Python mới + 1 integration smoke (engine load + transcribe wav fixture, `skipif` khi model absent). Rust: 1 unit cho sha256/cache-key (manual cho download).
- Coverage target: **60%** module mới.
- Runner: pytest (Python), vitest (frontend nếu có).

### Test Cases (outline)
| # | Module/Fn | Scenario | Expected | Pri |
|---|---|---|---|---|
| 1 | `detect_tier()` | macOS arm64 | "A" | P0 |
| 2 | `detect_tier()` | CUDA available | "B" | P0 |
| 3 | `detect_tier()` | else | "C" | P0 |
| 4 | `detect_tier(override='C')` | override thắng auto | "C" | P1 |
| 5 | `resolve("C")` | ModelSpec hợp lệ | id/url/sha256 set | P0 |
| 6 | `model_path_or_none` | cache thiếu | None (không raise) | P0 |
| 7 | `transcribe_local_file` | model chưa tải | raise lỗi rõ ràng "model chưa tải" | P0 |
| 8 | `PhoWhisperOnnxEngine.transcribe_pcm` | wav fixture vi | text non-empty, hallucination filtered | P0 |
| 9 | upload_pipeline routing | `stt_provider=local` | gọi local, không đòi API key | P0 |
| 10 | upload_pipeline routing | provider lạ | fallback nvidia (giữ nguyên) | P1 |
| 11 | main.py realtime | `stt_provider=local` | dùng cloud fallback, không crash | P0 |
| 12 | Rust cache-key | version đổi | needs_extract=true | P1 |
| 13 | sha256 mismatch | verify fail | xóa file + báo lỗi, không extract | P0 |

### Mock Dependencies
- `onnxruntime.InferenceSession` → mock (spec=True), trả tensor giả (tránh tải model thật trong CI).
- `platform.system/machine` + `onnxruntime.get_available_providers` → monkeypatch.
- Download/path → `tmp_path`; 1 wav fixture ~2s 16kHz mono cho smoke (`skipif` nếu model absent).

### Prerequisites
- `conftest.py`: fixtures `fake_model_dir(tmp_path)`, `fake_settings_db`, factory PCM giả.

## Phases (TDD triplet per slice — 5 slices, 15 phases)

| Phase | File | blockedBy |
|---|---|---|
| 01 ✅ | `phase-01-test-device-detect.md` (13 tests RED) | — |
| 02 ✅ | `phase-02-test-review-device-detect.md` (approved) | 01 |
| 03 ✅ | `phase-03-impl-device-detect.md` (GREEN 13/13) | 02 |
| 04 | `phase-04-test-model-registry.md` | 03 |
| 05 | `phase-05-test-review-model-registry.md` | 04 |
| 06 | `phase-06-impl-model-registry.md` | 05 |
| 07 | `phase-07-test-local-engine.md` | 06 |
| 08 | `phase-08-test-review-local-engine.md` | 07 |
| 09 | `phase-09-impl-local-engine.md` | 08 |
| 10 | `phase-10-test-routing.md` | 09 |
| 11 | `phase-11-test-review-routing.md` | 10 |
| 12 | `phase-12-impl-routing.md` | 11 |
| 13 | `phase-13-test-settings.md` | 12 |
| 14 | `phase-14-test-review-settings.md` | 13 |
| 15 | `phase-15-impl-settings.md` | 14 |

**Deploy order:** A→B→C→D→E. Release model artifact (`phowhisper-base-onnx.tar.zst` + sha256) lên GitHub Release `local-models-v1` **trước** khi ship build có UI download.

## Evaluation Rubric

rubric: general-code
rubric_version: 1
notes: |
  Desktop app — bỏ qua tenant-isolation. Trọng tâm: (1) WS payload contract bất biến;
  (2) reversibility (gỡ "local" = sạch); (3) sha256 verify TRƯỚC extract; (4) lỗi rõ ràng
  khi model absent; (5) coverage engine + routing ≥60%; (6) không thêm dep Python mới.

## Success Criteria

- [ ] Settings → "Local (offline)" → detect Tier C → tải model → sha256 verify → cache `~/.voicescribe/models/C/`.
- [ ] Upload file `stt_provider=local` → transcript không cần API key; CAM++ diarization chạy song song.
- [ ] Recording realtime khi provider=local trên CPU → fallback cloud đúng, không crash.
- [ ] Download fail → fallback cloud + UI retry, sidecar không chết.
- [ ] Set provider về nvidia/soniox → app như cũ 100% (reversibility).
- [ ] pytest pass, coverage module mới ≥60%; hallucination filter áp dụng cho local output.

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Download/verify lỗi → model hỏng | High | Med | sha256 verify trước extract; xóa file lỗi; (resume HTTP Range optional); fallback cloud |
| WS payload contract vô tình đổi | High | Low | Batch-only Phase 1; test #11 lock realtime fallback; rubric criterion |
| PhoWhisper WER thấp hơn cloud | Med | Med | Định vị "offline tradeoff"; UI nói rõ; cloud vẫn default |
| Thêm dep Python ngoài ý muốn | Med | Low | Chỉ dùng onnxruntime (đã có); download ở Rust (reqwest đã có) |
| PhoWhisper ONNX artifact/license chưa rõ | Med | Med | **Unresolved Q2** — xác nhận nguồn ONNX (tự export bằng optimum vs HF có sẵn) trước Slice C impl |
| **[RED-TEAM] Hand-roll Whisper ONNX decode phức tạp (mel + encoder + autoregressive decoder + KV cache + tokenizer)** — ~220 LOC là LẠC QUAN | High | High | **Đánh giá runtime đóng gói sẵn TRƯỚC Slice C**: `sherpa-onnx` (Python API, decode nội bộ, có sẵn Whisper + model riêng) hoặc `faster-whisper` (CTranslate2). Tránh tự viết decode loop. Nếu dùng sherpa-onnx → giảm mạnh LOC + rủi ro; đổi lại thêm 1 dep (cân nhắc vs onnxruntime thuần). Chốt ở Phase 05/08 review. |
| **[RED-TEAM] Privacy leak — local + realtime fallback cloud** | High | Med | User chọn "local/offline" vì PRIVACY; 4b-2 fallback recording sang cloud = **âm thầm gửi audio lên cloud, trái mục tiêu**. Mitigation BẮT BUỘC: (1) nếu provider=local + recording realtime → UI cảnh báo rõ "recording dùng cloud, audio rời máy"; (2) nếu KHÔNG có cloud key → **disable realtime**, hướng dẫn dùng upload file; KHÔNG bao giờ gửi cloud im lặng. Đưa vào Phase 12 + 15. |

## Rollback Strategy

Additive → rollback = ẩn tab "Local" + revert validation set về `{nvidia, soniox}` (2 chỗ `upload_pipeline.py`) + revert guard `main.py`. Data `~/.voicescribe/models/` để lại vô hại. Không migration để revert.

## Build/CI Impact (Phase 1)

Chỉ thêm bước release artifact `phowhisper-base-onnx.tar.zst` + sha256 lên GitHub Release `local-models-v1`. `onnxruntime` đã có. PyInstaller spec **không đổi** (model không bundle).

## Phase 2 / 3 — Outline

- **Phase 2 (Tier A MLX):** `MlxAudioEngine` (mlx-audio), registry spec A (nemotron MLX 756MB), realtime native streaming (nemotron Cache-Aware → `LocalStreamingSTT` thật), PyInstaller spec thêm mlx-audio (chỉ macOS arm). Risk: mlx-audio chưa lên PyPI (git install), bundling chưa test.
- **Phase 3 (Tier B CUDA/ONNX):** build-time export nemotron→ONNX (CI job riêng, KHÔNG bundle torch), `onnxruntime-gpu` build variant, host ONNX artifact, CUDA EP detection, streaming qua ONNX cache-aware. Risk: export pipeline phức tạp nhất; onnxruntime-gpu vs CPU packaging xung đột.

## Unresolved Questions

1. PhoWhisper-base ONNX: dùng artifact có sẵn (HF repo nào?) hay tự export build-time bằng `optimum`/onnx? Cần xác nhận nguồn + license trước Slice C impl.
2. Local hỗ trợ ngôn ngữ ngoài vi/en ở Phase 1? (PhoWhisper tối ưu vi → đề xuất Phase 1 chỉ vi + en).
3. Resume download (HTTP Range) bắt buộc Phase 1 hay defer (retry-from-scratch đủ cho ~140MB)?
