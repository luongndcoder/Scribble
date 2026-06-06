# Brainstorm — Tích hợp Local STT (nemotron-3.5-asr) vào Scribble

> Date: 2026-06-06 · Skill: be-brainstorm · Status: chờ User Review Gate

## Vấn đề + yêu cầu

Tích hợp một backend STT **local/offline** vào Scribble (Tauri + Python FastAPI sidecar) dựa trên `nemotron-3.5-asr-streaming-0.6b`. Mục tiêu user (đã chốt): **privacy/offline cho mọi user trên cả 3 OS** (Windows, macOS, Ubuntu). Ngôn ngữ chính: tiếng Việt.

Ràng buộc đã chốt qua clarify:
- **Device-detection 3 tier** (không phải 1 model cho mọi nơi):
  - Tier A — macOS Apple Silicon → MLX 8-bit
  - Tier B — Win/Linux + NVIDIA CUDA → NeMo gốc
  - Tier C — CPU-only (Win/Ubuntu iGPU, Mac Intel) → model ONNX nhẹ qua onnxruntime
- **Bổ sung** backend thứ 3 "Local/Offline" — giữ Riva + Soniox, user tự chọn trong Settings (reversible).
- Giữ giá trị **zero-manual-setup**: cài là chạy, không script/flag ẩn.

## Stack context

- Sidecar Python FastAPI port 8765, đóng gói PyInstaller onedir, nén tar.zst, giải nén vào `~/.voicescribe/sidecar/` (cache theo app_version + mtime).
- STT hiện 100% cloud (`src-python/stt.py`):
  - Batch: `transcribe_nvidia_streaming`, `transcribe_soniox_file` (+ phase A/B file_id).
  - Realtime: class `NvidiaStreamingSTT`, `SonioxStreamingSTT` — interface chung `start()/feed_audio(pcm)/stop()/results()` yield `{text, is_final, chunk_id, speaker, start_ms, end_ms, translation?}`.
- Diarization: Soniox built-in HOẶC CAM++ ONNX (`diarize.py`, `services/batch_diarizer.py`) + onnxruntime đã bundle sẵn.
- Pipeline upload: `services/upload_pipeline.py` (normalize → split 22s → STT 3 chunk song song → diarize → summarize), resumable per-chunk.
- Settings provider qua `api/settings.py`.

## Existing code liên quan

- **Tái dùng được**: interface streaming STT (`start/feed_audio/stop/results`) — local engine chỉ cần implement đúng contract này là cắm thẳng vào WS handler + upload pipeline mà không sửa frontend.
- **Tái dùng được**: CAM++ ONNX diarization chạy song song (nemotron không có speaker label) — không cần thiết kế lại.
- **Tái dùng được**: cơ chế extract + cache artifact theo version (lib.rs) — áp dụng cho model download/cache.
- **Cần thêm**: lớp `local_stt.py` + device-detection + model resolver + (tùy approach) downloader.

## Findings

| # | Câu hỏi | Answer | Status | Source |
|---|---------|--------|--------|--------|
| 1 | Mục tiêu local STT | Privacy/offline cho mọi user, cả 3 OS | user-confirmed | clarify Q1 |
| 2 | Máy CPU-only xử lý sao | Dùng model nhẹ hơn cho CPU (3 tier) | user-confirmed | clarify Q3 |
| 3 | Thay thế hay bổ sung | Bổ sung — backend thứ 3, giữ cloud | user-confirmed | clarify Q4 |
| 4 | nemotron-3.5-asr hỗ trợ tiếng Việt? | ✅ Có (vi-VN, transcription-ready tier, 40 locale) | verified-by-source | HF model card [T1] |
| 5 | Kiến trúc model | RNNT + Cache-Aware FastConformer, 600M, 16kHz mono, license OpenMDW-1.1 (commercial OK) | verified-by-source | HF model card [T1] |
| 6 | MLX runtime Tier A | mlx-audio lib, streaming qua att_context_size, 8-bit 756MB. PyInstaller bundling CHƯA test; mlx-audio chưa lên PyPI | verified-by-source (medium) | mlx-community card [T1], mlx-audio repo [T2] |
| 7 | NeMo Tier B footprint | torch+CUDA ~6GB (unbundleable). ONNX pre-export lúc build → ~500MB bundleable; export cần nemo-toolkit + GPU | verified-by-source | NeMo export docs [T1], PyInstaller torch [T2] |
| 8 | CPU tier (Tier C) | PhoWhisper-base WER 16–19 ~140MB batch-only (an toàn); sherpa-onnx Zipformer-VN streaming nhưng chưa có WER | verified-by-source (medium) | PhoWhisper paper [T1], sherpa-onnx [T2] |
| 9 | Diarization | nemotron KHÔNG có speaker label → giữ CAM++ song song | verified-by-source | NeMo diarization docs [T1] |
| 10 | Size FP32 bản gốc | NVIDIA không công bố (~2.4GB ước tính) | deferred (cần đo thực tế) | — |

## 2-3 approaches

### Option A — Bundle-all 3 tier (eager, nhồi model vào installer)
Đóng cả 3 artifact model vào installer theo từng platform: macOS DMG nhồi MLX (~1GB), Win/Linux nhồi nemotron-ONNX (~500MB) + PhoWhisper-ONNX (~150MB) cho CPU fallback.
- Cài xong chạy ngay, không cần mạng lần đầu.
- Installer phình to: DMG +1GB, Win/Linux +650MB. Mọi user gánh dung lượng kể cả không dùng offline.
- Build pipeline phải làm pre-export ONNX cho nemotron (cần GPU ở CI/máy build) + thử nghiệm MLX bundling chưa ai làm.

### Option B — On-demand download per tier, opt-in (RECOMMEND)
Installer giữ nguyên lean (không nhồi model). Khi user chọn "Local (offline)" trong Settings → app detect device tier → tải đúng artifact model về `~/.voicescribe/models/<tier>/`, cache theo version (tái dùng pattern extract+cache của lib.rs). Lần sau dùng cache.
- Không phình installer; user không dùng offline thì không tốn gì → đúng tinh thần "bổ sung backend thứ 3".
- "Auto-download khi bật toggle" ≠ manual setup (vẫn 1 click, tự động) → vẫn giữ zero-manual-setup ở mức chấp nhận được.
- Phụ thuộc mạng lần đầu bật (download 0.5–1GB) — cần UI progress + resume + checksum verify.
- Vẫn cần pre-export nemotron-ONNX ở build time (host trên GitHub Release asset / HF).

### Option C — Single cross-platform engine (KISS challenge)
Bỏ split MLX/CUDA/nemotron. Dùng **một** engine offline cross-platform cho cả 3 OS qua onnxruntime đã bundle sẵn — vd PhoWhisper-ONNX (tiếng Việt tốt) hoặc sherpa-onnx Zipformer-VN (streaming).
- Đơn giản nhất: 1 model, 1 runtime, 1 codepath, không đụng MLX/torch/CUDA bundling → tránh toàn bộ rủi ro nặng nhất.
- Footprint <500MB, bundle được luôn.
- **Đánh đổi**: bỏ chất lượng cao của nemotron trên Mac/CUDA; trần chất lượng = whisper-class. Không tận dụng được 2 link bạn đưa.

## Trade-off matrix

| Criterion        | A (Bundle-all 3 tier) | B (On-demand 3 tier) | C (Single engine) |
|------------------|-----------------------|----------------------|-------------------|
| Performance      | Cao (model tối ưu/tier) | Cao (model tối ưu/tier) | Trung bình (whisper-class) |
| Complexity       | Cao (3 codepath + bundling) | Cao (3 codepath + downloader) | Thấp (1 codepath) |
| Tenant safety    | N/A (app desktop, không multi-tenant) | N/A | N/A |
| Maintenance      | Nặng (3 build pipeline) | Nặng (3 build + host model) | Nhẹ |
| Migration risk   | Cao (MLX/torch bundling chưa test) | Trung bình (download có thể fail) | Thấp |
| Team skill fit   | Cần học MLX + NeMo export | Cần học MLX + NeMo export + downloader | Vừa (onnxruntime đã quen) |
| Installer size   | ❌ phình lớn | ✅ lean | ✅ lean |
| Zero-manual-setup| ✅ tốt nhất | ⚠️ ổn (auto-download 1 click) | ✅ tốt nhất |
| Time to deliver  | Lâu | Lâu | Nhanh |

## Hướng đề xuất + caveats

**Đề xuất: Option B (on-demand download, opt-in 3-tier) + rollout theo phase.**

Lý do: cân bằng đúng các ràng buộc bạn đã chốt — 3 tier để tận dụng phần cứng từng OS (đúng ý 2 link), nhưng không hi sinh installer size / zero-setup cho user không cần offline. Bổ sung backend thứ 3 reversible → rủi ro thấp nếu phải rút lui.

**Rollout phase để giảm rủi ro (đừng làm cả 3 tier cùng lúc):**
1. **Phase 1 — Tier C trước (cross-platform, confidence cao nhất):** PhoWhisper-ONNX qua onnxruntime đã bundle. Chạy được NGAY trên cả 3 OS, validate được luồng "Local backend" end-to-end (Settings → resolver → WS/upload → CAM++ diarization) mà không đụng MLX/torch.
2. **Phase 2 — Tier A (Mac MLX):** spike test PyInstaller + mlx-audio TRƯỚC khi commit; validate WER tiếng Việt + latency streaming trên audio thật.
3. **Phase 3 — Tier B (CUDA):** pre-export nemotron→ONNX ở build time, bundle onnxruntime (KHÔNG bundle torch). Làm cuối vì pipeline phức tạp nhất.

**Điều kiện áp dụng:** chọn B khi vẫn muốn giữ chất lượng nemotron trên Mac/CUDA. Nếu sau spike thấy MLX bundling quá đau hoặc nemotron không hơn whisper đáng kể trên tiếng Việt → **rút về Option C** (single engine) cho gọn.

**Khi nào chọn khác:**
- Chọn A nếu offline là tính năng bắt buộc chạy ngay không mạng cho mọi user (kiosk/air-gapped) — chấp nhận installer to.
- Chọn C nếu ưu tiên ship nhanh + maintenance nhẹ hơn là trần chất lượng.

## Self-review inline

- Tenant isolation: N/A — desktop app, SQLite local, không multi-tenant `merchant_id`.
- Schema/index: thêm field `stt_provider="local"` + `local_model_tier` vào settings (SQLite migration nhẹ, additive).
- Event schema: WS result payload GIỮ NGUYÊN contract hiện tại (`text/is_final/chunk_id/speaker/start_ms/end_ms`) → frontend không đổi.
- Breaking change: KHÔNG — additive backend, cloud vẫn default.
- PII/NĐ13: local STT cải thiện privacy (audio không rời máy) — điểm cộng; không có flow PII mới.
- Observability: tái dùng logger `mobio_log`-style hiện có; thêm prefix `STARTED:/COMPLETED:/FAILED:` cho model load + inference.
- YAGNI/KISS/DRY: Option C là phương án KISS đã được nêu để bạn cân nhắc; Option B chấp nhận thêm complexity có chủ đích để đạt mục tiêu 3-tier.

## Rủi ro + mitigation

| Rủi ro | Mức | Mitigation |
|--------|-----|------------|
| MLX + PyInstaller bundling chưa ai test | Cao | Spike nhỏ ở Phase 2 trước khi commit; nếu fail → Tier A fallback về Tier C trên Mac Intel/Apple đều dùng PhoWhisper |
| Size FP32 nemotron không rõ | Trung bình | Tải model đo thực tế NGAY ở đầu Phase 2/3 trước khi chốt bundle/download size |
| sherpa-onnx Zipformer-VN không có WER công bố | Trung bình | Dùng PhoWhisper-base (có WER 16–19) làm mặc định Tier C; sherpa chỉ khi cần streaming + đã tự benchmark |
| NeMo ONNX export cache-aware fail | Thấp | NVIDIA docs xác nhận có; có script mẫu; làm ở Phase 3 nên không chặn Phase 1-2 |
| Download model lần đầu fail (mạng) | Trung bình | Resume + checksum (sha256) + retry; fallback cloud nếu download lỗi |
| nemotron không hơn whisper đáng kể cho tiếng Việt | Trung bình | Validate WER ở Phase 2 trước khi đầu tư Tier A/B; nếu vậy → Option C |

## Tiêu chí thành công + cách verify

- [ ] Phase 1: chọn "Local (offline)" trong Settings → ghi âm + upload file tiếng Việt → ra transcript đúng, KHÔNG cần mạng/API key, trên cả 3 OS. Verify: chạy thử trên macOS + Win + Ubuntu, ngắt mạng.
- [ ] Diarization vẫn hoạt động (CAM++) khi dùng local STT. Verify: file 2 người nói → ≥2 speaker.
- [ ] WS payload contract không đổi → frontend render bình thường. Verify: diff payload shape.
- [ ] Installer size không tăng (Option B). Verify: so sánh size DMG/exe/AppImage trước-sau.
- [ ] WER tiếng Việt local ≤ ngưỡng chấp nhận (đặt mốc cụ thể ở Phase 2, vd ≤ 20%). Verify: benchmark trên bộ audio mẫu có ground-truth.

## Quyết định chưa chốt

1. **Tier C model**: PhoWhisper-base (batch, WER tốt) vs sherpa-onnx Zipformer-VN (streaming, chưa có WER) — chốt sau khi benchmark Phase 1.
2. **Size thực FP32 nemotron** — cần tải đo, ảnh hưởng quyết định bundle-vs-download cho Tier B.
3. **Realtime trên Tier C**: PhoWhisper batch-only → realtime recording trên CPU-only sẽ chạy chế độ "near-realtime theo chunk" hay fallback cloud? (đào ở /be-plan)
4. **Host model artifact ở đâu** (GitHub Release asset vs HF) cho Option B.

## Bước tiếp theo

- Approve brainstorm → `/be-plan` (khuyến nghị `--hard` vì cross-platform + build pipeline phức tạp), bắt đầu từ Phase 1 (Tier C cross-platform).
- Trước Phase 2/3: spike MLX bundling + tải nemotron đo size + benchmark WER tiếng Việt.

---

**Sources:** HF model card nvidia/nemotron-3.5-asr-streaming-0.6b [T1]; mlx-community 8-bit [T1]; mlx-audio GitHub [T2]; NeMo export/diarization docs [T1]; PhoWhisper paper arXiv:2406.02555 [T1]; sherpa-onnx [T2]; PyInstaller+torch discussions [T2]. Research artifact: be-researcher (session).
