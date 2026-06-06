# Plan — Scribble Mobile (iOS + Android) v1

> Ngày: 2026-05-31 · Lane: normal (intake.md missing → fallback) · Mode: --auto (hard-ish, greenfield)
> Inputs: `brainstorm.md` (approach + risks) · `mobile-ui-mockup.html` (9 màn, design system kế thừa app PC)

## Chosen Approach

**RN + Expo · cloud-direct (no server) · record-to-file v1 · Soniox built-in diarization · local-first (expo-sqlite + expo-secure-store).**

Quyết định đã chốt với user (clarify trong be-plan):
| # | Quyết định | Chốt |
|---|-----------|------|
| 1 | Cross-device sync | **Defer** — v1 local-only, giữ no-server/privacy. Sync = roadmap sau (sẽ cần hosted backend → brainstorm lại). |
| 2 | Tổ chức code | **Repo mobile riêng**; `@scribble/core` là package nội bộ (ranh giới rõ để sau tách workspace). KHÔNG đụng repo desktop. |
| 3 | v1 scope | **Full 9 màn**: record-to-file + file-upload + dịch transcript post-process. |
| 4 | STT provider | **Soniox-only** v1 (Riva gRPC trên RN khó). |
| 5 | Dịch cabin realtime | **Phase 2** (v1 chỉ dịch transcript đã có). |

## Phát hiện chốt từ codebase (ảnh hưởng kiến trúc)

- Frontend desktop (`src/lib/api.ts`) gọi **sidecar Python local qua HTTP** — KHÔNG gọi thẳng Soniox/LLM. Toàn bộ orchestration provider nằm ở **Python** (`src-python/stt.py`, `summarize.py`, `translate.py`, `upload_pipeline.py`).
- ⇒ `@scribble/core` (soniox-client, llm-client, translate-client) phải **viết mới bằng TS**, **port logic** từ Python. Reuse trực tiếp chỉ là: types (`src/types/stt.ts`), i18n (`src/i18n.ts`), transcript-model + sliding-window (`src/stores/appStore.ts`), prompt templates (`summarize.py` TEMPLATES: MOM/SUMMARY/BULLETS/DEEP/custom), network-error classifier (`src/lib/api.ts` `looksLikeNetworkError`).
- Schema desktop (`src-python/db.py`): `meetings` (id, title, transcript TEXT-JSON, summary, translations TEXT-JSON, audio_path, audio_duration, language, status, source_type `realtime|upload`, file_hash, source_filename, created/updated_at), `settings` (key/value), `upload_chunks` (crash-recovery cho ffmpeg-split pipeline desktop).
- ⇒ expo-sqlite **bỏ `upload_chunks`** (Soniox async xử lý nguyên file, không cần client-side chunking). Thêm `soniox_job_id` để resume polling.

## Scope Challenge (YAGNI)

- KHÔNG port ffmpeg/VAD-splitter/CAM++ ONNX (Soniox async + built-in diarization thay thế) → bỏ ~3 service Python nặng nhất.
- KHÔNG dựng sync/backend/auth (local-only).
- KHÔNG làm realtime PCM streaming v1 (record-to-file).
- Blast radius: repo MỚI, hoàn toàn isolate — desktop không đổi 1 dòng.

## Kiến trúc

### Folder structure (repo `scribble-mobile`)

```
scribble-mobile/
├── app/                          # expo-router (file-based)
│   ├── (tabs)/index.tsx          # 03 Cuộc họp (list)
│   ├── (tabs)/settings.tsx       # 07 Cài đặt
│   ├── record.tsx                # 01 Ghi âm (full-screen)
│   ├── processing/[id].tsx       # 02 Đang phiên âm
│   ├── meeting/[id].tsx          # 04/05 Chi tiết: Transcript | Biên bản
│   └── upload.tsx                # 08 Tải file lên
├── src/
│   ├── components/               # RecordButton, Waveform, MeetingCard, TranscriptReader,
│   │                             #   MinutesView, CreateMinutesSheet(06), SettingRow, NetChip…
│   ├── features/{recording,meetings,upload,translation,settings}/   # orchestrators (state machines)
│   ├── theme/                    # tokens port từ src/index.css (colors/radius/shadow), system font, icons (lucide-react-native)
│   ├── store/                    # zustand (port src/stores/appStore.ts)
│   └── db/                       # expo-sqlite schema + repositories (port src-python/db.py)
├── packages/core/                # @scribble/core (internal package, pure TS, framework-agnostic)
│   ├── soniox-client/            # async file transcribe: submit → poll → parse → TranscriptPart[] (port stt.py soniox)
│   ├── llm-client/               # summarize streaming + mapreduce (port summarize.py)
│   ├── translate-client/         # dịch transcript post-process (port translate.py)
│   ├── transcript-model/         # TranscriptPart + sliding-window pagination (port appStore)
│   ├── prompts/                  # MOM/SUMMARY/BULLETS/DEEP/custom (port summarize.py TEMPLATES)
│   ├── net/                      # network-error classifier (port api.ts)
│   ├── i18n/  · types/           # port src/i18n.ts + src/types/stt.ts
├── app.config.ts                 # Expo: iOS UIBackgroundModes:[audio] + mic usage desc; Android foregroundService + RECORD_AUDIO
├── eas.json · package.json
```

### Dependencies (đề xuất, chốt sau Spike A)
`expo-router`, `expo-sqlite`, `expo-secure-store`, `expo-document-picker`, `expo-crypto` (sha256), `expo-file-system`, `zustand`, `lucide-react-native`.
Audio (record-to-file + background): **chốt ở Spike A** — candidate `expo-audio` + config plugin foreground-service (Android), fallback `react-native-audio-recorder-player` / `react-native-nitro-sound`.
Streaming LLM (SSE): `expo/fetch` streaming hoặc `react-native-sse`.

### expo-sqlite schema (mirror db.py, đã tinh gọn)

```sql
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'Untitled',
  transcript TEXT DEFAULT '',          -- JSON TranscriptPart[]
  summary TEXT DEFAULT '',
  translations TEXT DEFAULT '',         -- JSON {lang: parts[]}
  audio_path TEXT DEFAULT '',           -- file:// trong sandbox app
  audio_duration REAL DEFAULT 0,
  language TEXT DEFAULT 'vi',
  status TEXT DEFAULT 'recorded',       -- recorded|uploading|transcribing|transcribed|summarizing|done|failed
  source_type TEXT DEFAULT 'realtime',  -- realtime|upload
  file_hash TEXT,                        -- sha256 idempotency (upload)
  source_filename TEXT,
  soniox_job_id TEXT,                    -- handle để resume polling async
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_meetings_hash ON meetings(file_hash);
```
- **API keys (Soniox/LLM) KHÔNG vào bảng settings** → `expo-secure-store` (Keychain/Keystore). `settings` chỉ giữ non-sensitive (provider, model, stt_language, app_language, translationLang, toggles).
- Migration: versioned (PRAGMA user_version), idempotent — giống cách `db.py` chạy ADD COLUMN lặp an toàn.

## Risks + Mitigation (kế thừa brainstorm)

| # | Risk | Mức | Mitigation |
|---|------|-----|-----------|
| 1 | Background recording bị OS kill (meeting dài, khoá màn hình) | Cao | **Spike A** trước build. iOS `UIBackgroundModes:[audio]`+AVAudioSession; Android foreground service + wake lock |
| 2 | ✅ **DE-RISKED** (Spike 01): Soniox async + diarization + timestamps xác nhận (docs + code desktop `stt.py`), ~$0.10/giờ, REST contract đầy đủ. Không pivot | Thấp | Xem `phase-01-spike-soniox-async-result.md`. Còn smoke-test RN multipart (Phase 04, không chặn) |
| 3 | SSE/streaming LLM trên RN (fetch streaming hạn chế) | Trung | Spike nhỏ trong Phase 05; fallback non-stream (chờ full response) |
| 4 | App Store / Play review: mic background + BYO-key + privacy | Trung | iOS privacy manifest + purpose strings; Android foreground-service type `microphone`; mô tả rõ data flow |
| 5 | Interruption (call), route change (Bluetooth/headset) | Trung | Handle audio-session interruption events; test ma trận thiết bị |
| 6 | Không cross-device sync (data kẹt trên máy) | Trung (chấp nhận v1) | Surface là known limitation; roadmap sync E2E sau |

## Test Plan

### Test Strategy
- **Test type**: Unit (trọng tâm `@scribble/core` — pure TS, mock `fetch`) + component (RN Testing Library cho component chính) + manual QA matrix (audio/background/store).
- **Coverage target**: **60%** tổng; **≥75%** riêng `packages/core` (logic thuần, ROI cao). UI/native thấp hơn (khó unit-test) → bù bằng component test + manual.
- **Test runner**: `jest` + `@testing-library/react-native` (jest-expo preset). Core có thể test bằng `vitest`/`jest` thuần (không cần RN).

### Test Cases (outline — trọng tâm core)
| # | Module | Scenario | Expected | Priority |
|---|--------|----------|----------|----------|
| 1 | soniox-client.submit | file hợp lệ + key | trả job_id | P0 |
| 2 | soniox-client.poll | job done | TranscriptPart[] có speaker labels | P0 |
| 3 | soniox-client.poll | job failed / 402 budget | throw terminal error phân loại đúng | P0 |
| 4 | soniox-client.parse | tokens đa người nói | gộp đúng turn theo speaker + timestamp | P0 |
| 5 | net.looksLikeNetworkError | DNS/offline markers | true; lỗi nghiệp vụ → false | P0 |
| 6 | llm-client.selectPrompt | template mom/summary/bullets/deep/custom | đúng prompt; custom dùng user prompt | P0 |
| 7 | llm-client.mapReduce | transcript > ngưỡng token | chunk + reduce, output 1 biên bản | P0 |
| 8 | llm-client.summarize | lang=vi/en | output đúng ngôn ngữ (system prompt enforce) | P1 |
| 9 | transcript-model.window | parts > PAGE_SIZE, cuộn | window trượt đúng, anchor chunkId | P0 |
| 10 | translate-client | dịch N dòng → target lang | mỗi dòng có bản dịch; lỗi 1 dòng không vỡ cả | P1 |
| 11 | db repo | insert/update/get meeting; idempotency theo file_hash | redirect meeting cũ khi hash trùng | P0 |
| 12 | settings + secure-store | save/read key; model auto-disable khi chưa có key | đúng trạng thái enable/disable | P1 |
| 13 | recording orchestrator | stop → save → transcribe → persist (mock) | state machine đúng; lỗi → status=failed, transcript vẫn lưu | P0 |

### Mock Dependencies
- `fetch` (Soniox/LLM HTTP) → mock per case (msw / jest mock).
- `expo-sqlite` → in-memory DB hoặc mock repo.
- `expo-secure-store` → in-memory mock.
- Audio native module → mock (orchestrator test không chạy native).

### Prerequisites
- jest-expo config + babel; `packages/core` test config riêng (không phụ thuộc RN).
- Fixtures: sample Soniox async response (multi-speaker), sample LLM stream chunks, sample transcript JSON.

## Phasing — v1 roadmap (TDD: test → review → impl mỗi slice logic)

> Spikes chạy TRƯỚC build nặng. Phase 02–10 chi tiết hoá thành phase-file SAU khi spike chốt (Phase 04+ phụ thuộc kết quả Spike B). TDD triplet áp cho slice có logic thuần (04,05,06,07,08,09).

| Phase | Nội dung | TDD | Màn | blockedBy |
|-------|----------|-----|-----|-----------|
| **00 Spike** | Background recording (iOS bg-audio + Android foreground-service): record ≥60' khoá màn hình, đo mất audio | n/a (throwaway) | — | — |
| **01 Spike** | Soniox **async file API**: size limit, cost, diarization-on-async, ngôn ngữ, response shape (test 1 file đa người nói thật). **DECISION GATE** | n/a | — | — |
| **02 Scaffold** | 🟡 *Một phần xong:* repo `scribble-mobile` (pnpm workspace) + `@scribble/core` package (vitest/tsconfig) + `types`. Còn lại: Expo app init, expo-router nav, theme tokens, system font, lucide icons, `i18n`, expo-sqlite schema | test: types/i18n/db-schema | — | 00,01 |
| **03 Settings** | BYO key UI (Soniox+LLM provider/key/baseURL/model), app lang, model auto-disable; expo-secure-store wrapper; test-connection | test→review→impl | 07 | 02 |
| **04 Soniox core** | ✅ **DONE (logic):** `soniox-client` (submit→poll→parse→TranscriptPart[]) + `net` classifier + `transcript-model` (group by speaker/gap/cap). **24 unit test pass, typecheck sạch.** Còn: smoke-test RN multipart upload (cần device, Phase 06) | ✅ test→impl | — | 02 (gate 01) |
| **05 LLM core** | `llm-client`: summarize stream + prompts (MOM/…/custom) + mapreduce + fetch models | test→review→impl | — | 02 |
| **06 Recording** | Audio module record-to-file + background (Spike A); orchestrator stop→save→transcribe→persist→auto-summarize; màn ghi âm + processing | test (orchestrator)→review→impl | 01,02 | 04,05,03 |
| **07 Meetings** | List + detail Transcript reader (content-first, sliding-window) + Minutes + create-minutes sheet; transcript-model + pagination | test (model/pagination)→review→impl | 03,04,05,06 | 06 |
| **08 Upload** | File picker + sha256 idempotency + submit Soniox async (reuse soniox-client) + reuse processing | test→review→impl | 08 | 04,07 |
| **09 Translation** | `translate-client` post-process; toggle + target lang; bilingual render; "Tải bản dịch" (chỉ hiện khi bật) | test→review→impl | 09 | 05,07 |
| **10 Polish/Release** | Network chip online/offline; error states (Soniox 402/terminal, offline) + localized vi/en; onboarding nhập key lần đầu; app icon/splash; iOS privacy manifest + Android perms; EAS build; manual QA matrix | component + manual | tất cả | 06–09 |

### Deferred — v2 (KHÔNG trong plan này)
- Realtime live caption: native PCM module → Soniox WS (mở rộng `soniox-client`, UI đã sẵn).
- Dịch cabin realtime (gắn live caption).
- Cross-device sync (cần hosted backend + auth → brainstorm topology lại).

## Evaluation Rubric

rubric: general-code
rubric_version: 1
notes: |
  App mobile greenfield (RN/TS), không phải Mobio backend → dùng general-code.
  Nhấn mạnh: (1) coverage core ≥75% logic thuần; (2) secure-store cho key (không plaintext/log);
  (3) tenant isolation N/A (single-user local) — nhưng nếu Phase v2 thêm sync phải áp lại;
  (4) error states + i18n vi/en đầy đủ; (5) background-audio reliability (manual QA bắt buộc trước release).

## File/folder mapping desktop → mobile (port reference)

| Desktop source | Mobile target | Loại |
|----------------|---------------|------|
| `src/types/stt.ts` | `packages/core/types` | reuse trực tiếp |
| `src/i18n.ts` + `src-python/i18n.py` | `packages/core/i18n` | reuse + merge BE strings |
| `src/stores/appStore.ts` (TranscriptPart, sliding-window, reducers) | `packages/core/transcript-model` + `src/store` | port logic |
| `src-python/stt.py` (Soniox) | `packages/core/soniox-client` | **port → TS mới** |
| `src-python/summarize.py` (TEMPLATES, mapreduce, stream) | `packages/core/llm-client` + `prompts` | **port → TS mới** |
| `src-python/translate.py` | `packages/core/translate-client` | **port → TS mới** |
| `src/lib/api.ts` (`looksLikeNetworkError`, error shape) | `packages/core/net` | port |
| `src-python/db.py` (schema) | `src/db` (expo-sqlite) | port schema (bỏ upload_chunks) |
| `src/index.css` (:root tokens) | `src/theme` | port tokens |
| `mobile-ui-mockup.html` (9 màn) | `app/` + `src/components` | impl RN |

## Unresolved (cần khi tới phase tương ứng)
- Audio lib chính xác cho background record — **chốt Spike A (cần device thật, dev tự chạy)**. ⟵ blocker duy nhất còn lại.
- ✅ Soniox async — PASS (xem `phase-01-spike-soniox-async-result.md`). Còn smoke-test RN multipart upload (Phase 04, không chặn).
- Cơ chế SSE streaming LLM trên RN (chốt đầu Phase 05; fallback non-stream nếu khó).
