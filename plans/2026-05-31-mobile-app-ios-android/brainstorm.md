# Brainstorm — Scribble Mobile App (iOS + Android)

> Ngày: 2026-05-31 · Loại: kiến trúc / hướng phát triển sản phẩm mới
> Trạng thái: chờ User Review Gate → handoff `/be-plan` + `/frontend-design`

## Vấn đề + yêu cầu

Phát triển Scribble (hiện là desktop app: Tauri + React + Python sidecar) thêm **mobile app iOS & Android**.
Yêu cầu chốt qua clarify:

- Mobile = **capture + cloud-process**: điện thoại lo phần thu, việc nặng đẩy ra ngoài, KHÔNG chạy pipeline nặng (ffmpeg/ONNX) trên máy.
- **Cloud-direct, BYO key**: app gọi thẳng Soniox/LLM bằng key lưu trên máy, **không dựng server riêng** → giữ nguyên privacy "key ở máy người dùng".
- Stack: **React Native + Expo** (ưu tiên độ tin cậy ghi âm nền + tái dùng logic TS).
- v1: **record-to-file** (không live caption), tách shared-core sẵn để cắm realtime sau.

## Stack context (hiện tại)

| Layer | Desktop hiện tại | Có lên mobile được không? |
| --- | --- | --- |
| UI | React 19 + TS trong Tauri webview | Logic/types/i18n: reuse được. DOM components: phải dựng lại bằng RN primitives |
| "Bộ não" | Python FastAPI sidecar (PyInstaller binary, `127.0.0.1:8765`) | **KHÔNG** — iOS cấm spawn subprocess. Loại bỏ hoàn toàn ở mobile |
| STT | Soniox (WS streaming, có diarization tích hợp) / Nvidia Riva (gRPC) | Soniox: gọi cloud-direct được. Riva gRPC trên RN khó → ưu tiên Soniox cho mobile |
| Diarization | CAM++ ONNX **chạy local** trong sidecar | Bỏ ở mobile — dùng diarization tích hợp của Soniox |
| Translate | Nvidia NMT (cloud) | Cloud-direct được (defer khỏi v1) |
| Summarize | LLM OpenAI-compatible (cloud) | Cloud-direct được |
| Audio pipeline | ffmpeg normalize + VAD split + batch diarize (sidecar) | Bỏ — thay bằng Soniox async file API |
| Storage | SQLite local + audio archive `.pcm` | `expo-sqlite`/`op-sqlite` (schema tương đương) |

**Insight chính:** việc nặng (STT/NMT/LLM) **đã ở cloud sẵn**. Sidecar Python chủ yếu là orchestrator + ffmpeg + diarization local. Với cloud-direct + Soniox built-in diarization + Soniox async file API → **bỏ được toàn bộ ffmpeg + ONNX + Python**. Phần còn lại trên mobile chỉ là: thu audio → gọi cloud → lưu local → render. Đây là lý do RN+Expo khả thi mà không cần native nặng.

## Findings

| # | Câu hỏi | Answer | Status | Source |
|---|---------|--------|--------|--------|
| 1 | Mobile để làm gì? | Capture + cloud-process | user-confirmed | clarify Q1 |
| 2 | Xử lý đi qua đâu? | Cloud-direct, BYO key (no server) | user-confirmed | clarify Q2 |
| 3 | Tech stack mobile? | React Native + Expo | user-confirmed | clarify Q3 |
| 4 | Audio v1? | Record-to-file MVP, core tách sẵn | user-confirmed | clarify Q4 |
| 5 | Desktop thu mic kiểu gì? | webview getUserMedia + AudioContext/AudioWorklet → PCM 16kHz | verified-by-source | RecordingBar.tsx:451,472 / RecordingPanel.tsx:104 |
| 6 | System audio thu kiểu gì? | native Rust cidre/core_audio (macOS only) | verified-by-source | src-tauri/src/lib.rs:112-286 |
| 7 | Sidecar có port mobile được? | Không (iOS cấm subprocess), loại bỏ | verified-by-source | README "Project Structure" + scope decision |
| 8 | Format audio Soniox/Riva? | PCM LINEAR_PCM 16kHz mono 16-bit | verified-by-source | stt.py:213-214, main.py:204 |
| 9 | Cross-device sync (phone↔desktop)? | Deferred — mâu thuẫn no-server, để sau | deferred | — |

## Kiến trúc đề xuất (cloud-direct RN + Expo)

```
┌─────────────────────────── Expo RN App (iOS + Android) ───────────────────────────┐
│  UI layer (RN primitives + frontend-design)                                        │
│    Screens: MeetingList · Recording · MeetingDetail(transcript/minutes) · Settings │
│  ── gọi xuống ──                                                                   │
│  @scribble/core  (shared TS, framework-agnostic — REUSE từ desktop)                │
│    • soniox-client       (async file transcribe + [phase2] WS streaming)           │
│    • llm-client          (OpenAI-compatible summarize, templates MoM/Deep/...)     │
│    • transcript-model    (parts, pagination, chunk anchors)                        │
│    • i18n (vi/en) · types · prompt builders                                        │
│  ── platform adapters (RN-specific) ──                                             │
│    • audio: expo-audio record-to-file (.m4a/.wav) + background mode                │
│    • storage: expo-sqlite (schema ~ desktop) + expo-file-system (audio)            │
│    • secrets: expo-secure-store (Keychain / Keystore) cho API key                  │
└────────────────────────────────────────────────────────────────────────────────┘
        │ HTTPS / WS (BYO key, trực tiếp)
        ▼
   Soniox API (STT async file + diarization)      LLM provider (summarize)
```

**Luồng v1 (record-to-file):**
1. Tap record → `expo-audio` thu ra file (background audio mode iOS / foreground service Android).
2. Stop → upload file lên **Soniox async transcription API** → poll status.
3. Nhận transcript + speaker labels (Soniox diarization) → lưu `expo-sqlite`.
4. "Tạo biên bản" → `llm-client` gọi LLM provider (key từ secure-store) → minutes.
5. Toàn bộ data nằm trên máy (local-first, giữ privacy).

**Phase 2 (realtime live caption):** thêm native audio module stream PCM 16kHz → Soniox WS, tái dùng `soniox-client` đã tách → cắm vào UI có sẵn, không viết lại.

## 2-3 approaches đã cân (decision record)

### Trục 1 — Backend topology

| Criterion | A. Cloud-direct (CHỌN) | B. Hosted Python backend | C. Hybrid |
|---|---|---|---|
| Code reuse Python | thấp (rebuild orchestration mỏng bằng TS) | ~100% | trung bình |
| Privacy ("key ở máy") | **giữ nguyên** | đổi (audio/key qua server bạn) | một phần |
| Chi phí hạ tầng | **0** | server + scale + auth + multi-tenant | cao |
| Vận hành | đơn giản | nặng | nặng nhất (2 path) |
| Cross-device sync | không (cần thêm backend sau) | có sẵn | có |

→ **Chọn A** vì khớp privacy model hiện có + 0 cost + việc nặng vốn đã ở cloud.

### Trục 2 — Mobile stack

| Criterion | RN + Expo (CHỌN) | Tauri 2 Mobile | Native (Swift+Kotlin) |
|---|---|---|---|
| Reuse UI | thấp (dựng lại RN primitives) | **cao** (React as-is) | 0 |
| Reuse business logic TS | **cao** (shared-core) | cao | 0 |
| Ghi âm nền dài (sống còn) | **tốt** (background mode/foreground service) | rủi ro (getUserMedia dừng khi background) | **tốt nhất** |
| Secure key storage | tốt (secure-store) | trung bình | tốt nhất |
| 1 codebase iOS+Android | có | có | không (2) |
| Effort / time-to-deliver | trung bình | thấp-trung (nhưng audio risk kéo lùi) | cao nhất |

→ **Chọn RN+Expo**: Tauri Mobile reuse UI tốt nhất NHƯNG đúng chỗ chí mạng (ghi âm nền webview) là yếu nhất → sẽ phải tự viết native plugin, xói mòn lợi thế reuse. RN cân bằng tốt nhất giữa reuse logic + native audio tin cậy.

## Self-review inline

- **Tenant isolation:** N/A — app local-first single-user, không có `merchant_id`/multi-tenant (vì no-server). Nếu sau này thêm hosted sync → phải áp tenant isolation.
- **Schema/migration:** `expo-sqlite` schema mới (mirror desktop) — cần migration plan ở `/be-plan`, không đụng DB desktop.
- **Event schema:** N/A (không event-driven).
- **Breaking change:** không — repo/codebase mobile tách riêng, desktop không đổi.
- **PII / privacy (NĐ 13 / GDPR):** audio + transcript là PII. Cloud-direct giữ data trên máy + gửi thẳng provider → **không qua server bạn** ⇒ giảm trách nhiệm xử lý PII. Vẫn cần: (a) review ToS/DPA của Soniox & LLM provider về audio retention; (b) secure-store cho key; (c) thông báo rõ data gửi đi đâu (giữ đúng cam kết privacy hiện tại).
- **Observability:** RN app cần log client-side (Sentry/expo) + trace per recording session. Không có `Mobio-Trace-ID` vì không có backend riêng.
- **YAGNI/KISS/DRY:** ✓ bỏ ffmpeg/ONNX/Python; ✓ Soniox async thay batch pipeline; ✓ shared-core tránh lặp logic; defer realtime + translate + sync.

## Rủi ro + mitigation

| # | Rủi ro | Mức | Mitigation |
|---|---|---|---|
| 1 | **Background recording** bị OS kill (đặc biệt iOS, meeting dài) | Cao | Spike sớm: iOS `UIBackgroundModes: audio` + AVAudioSession; Android foreground service + wake lock. Verify trước khi build UI |
| 2 | **Soniox async file API** giả định (max size, cost, ngôn ngữ, diarization trên async) chưa xác minh | Cao | **Spike đầu /be-plan**: đọc Soniox async docs + test 1 file thật. Nếu async không có diarization/giới hạn xấu → cân nhắc fallback live-WS sớm. (chạy `/be-research` nếu cần đối chiếu spec) |
| 3 | App Store / Play review: BYO-key, mic background, audio privacy | Trung | Privacy manifest (iOS), khai báo mic + background audio đúng mục đích; mô tả rõ data flow |
| 4 | Không cross-device sync (data kẹt trên máy) | Trung | Chấp nhận ở v1 (đúng no-server). Surface là known limitation. Roadmap: thêm hosted sync (E2E-encrypted) nếu user cần |
| 5 | Interruption (call đến), route change (Bluetooth/tai nghe), audio session conflict | Trung | Dùng lib audio trưởng thành, handle interruption events; test ma trận thiết bị |
| 6 | Chi phí Soniox tăng theo phút (BYO key — user trả) | Thấp | Giống desktop; hiển thị cảnh báo/ước lượng phút như hiện tại |
| 7 | LLM context limit khi transcript dài (đã có trên desktop) | Thấp | Reuse MapReduce/template logic trong shared-core |

## Tiêu chí thành công + cách verify

- [ ] Ghi âm 1 cuộc họp **dài ≥ 60 phút, màn hình khoá**, không mất audio (verify: record nền + so độ dài file).
- [ ] File → Soniox async → transcript + speaker labels hiển thị đúng (verify: 1 file mẫu đa người nói).
- [ ] "Tạo biên bản" ra minutes đúng template (verify: so với desktop cùng input).
- [ ] API key lưu trong Keychain/Keystore, không lộ plaintext (verify: inspect storage).
- [ ] Chạy được cả iOS + Android từ 1 codebase Expo (verify: build 2 platform).
- [ ] `@scribble/core` không import RN/DOM API → cắm realtime phase 2 không sửa core (verify: build core độc lập).

## Quyết định chưa chốt (cần làm rõ ở /be-plan, KHÔNG tự quyết)

1. **Cross-device sync** phone↔desktop: defer hay là requirement? (nếu có → buộc thêm hosted backend + đổi privacy model).
2. **File-upload từ thư viện** (ngoài record trực tiếp) có vào v1 không? (map sang Soniox async, effort thấp).
3. **Dịch cabin realtime** trên mobile: defer (gắn với realtime phase 2).
4. **Monorepo vs repo tách riêng**: đặt `@scribble/core` chung repo desktop (pnpm workspace) hay repo mobile độc lập?
5. **STT provider mobile**: chỉ Soniox, hay vẫn support Riva? (Riva gRPC trên RN khó → đề xuất chỉ Soniox v1).

## Bước tiếp theo

1. `/frontend-design` — thiết kế lại UI mobile-native (record screen, transcript reader, minutes, settings) cho RN — UX mobile khác desktop, làm song song.
2. Spike de-risk (rủi ro #1, #2) — background audio + Soniox async file API — TRƯỚC khi `/be-plan` chốt chi tiết.
3. `/be-plan` — bóc tách shared-core, schema `expo-sqlite`, phasing v1→v2, file mapping.
