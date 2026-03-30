# Scout Report: Soniox STT Full Codebase

**Date:** 2026-03-30
**Scope:** src/ (React frontend), src-python/ (Python backend), src-tauri/ (Rust/Tauri)
**Agents:** 3 parallel scouts
**Branch:** feature/add-soniox-stt

## Architecture Overview

Scribble = Tauri 2.0 desktop app + React 19 frontend + Python FastAPI sidecar (port 8765)

**Data Flow:**
```
Audio Source (Mic/System) → WebSocket → Python Sidecar (STT + Diarization) → WebSocket → React UI
                                                      ↓
                                              SQLite DB (meetings, settings)
```

**STT Providers:** Nvidia Riva (gRPC, free) | Soniox (WebSocket, paid, better accuracy)

---

## Layer 1: React Frontend (src/)

### File Map (22 files)

| File | Purpose |
|------|---------|
| `App.tsx` | Main app, health check, language toggle, routing |
| `main.tsx` | React entry point |
| `index.css` | Global styles, Soniox language chips |
| `stores/appStore.ts` | Zustand store: recording, transcript, translation, meetings, summary |
| `lib/api.ts` | FastAPI HTTP client (transcribe, meetings CRUD, settings, downloads) |
| `lib/sidecar.ts` | Connectivity layer: Tauri (127.0.0.1:8765) vs Web (/api) |
| `lib/sse.ts` | SSE parser for streaming translation/summarization |
| `lib/transcriptUtils.ts` | Text splitting, proportional translation mapping |
| `lib/i18n.ts` | i18n helper |
| `components/RecordingBar.tsx` | **Core** - Dual STT streaming (Nvidia/Soniox), audio source selection, VAD, waveform |
| `components/RecordingPanel.tsx` | VAD-based chunked recording (fallback mode) |
| `components/TranscriptView.tsx` | Transcript display, inline translations, speaker colors |
| `components/SettingsPanel.tsx` | STT provider toggle, API keys, Soniox language hints, LLM config |
| `components/MeetingList.tsx` | Meeting list, search, CRUD |
| `components/MeetingDetail.tsx` | Meeting detail, transcript editing, export |
| `components/SummaryView.tsx` | AI summary generation via SSE |
| `components/ConfirmDialog.tsx` | Modal confirmations |
| `components/Toast.tsx` | Toast notifications |
| `components/CustomSelect.tsx` | Multi-select dropdown (Soniox language hints) |

### Soniox Frontend Integration

- **Provider toggle:** `stt_provider` = "nvidia" | "soniox" in SettingsPanel
- **WebSocket routing:** `/ws/soniox-stream` vs `/ws/nvidia-stream` (RecordingBar.tsx:65)
- **Language hints:** Multi-select UI for 38 languages (SettingsPanel.tsx:141-178)
- **Translation:** Requires WS reconnection for mid-session toggle (unlike Nvidia)
- **API key:** Stored masked, validated via /diagnose endpoint

---

## Layer 2: Python Backend (src-python/)

### File Map (~3,400 LOC)

| File | Lines | Purpose |
|------|-------|---------|
| `main.py` | 652 | FastAPI app, WS handlers (/ws/nvidia-stream, /ws/soniox-stream), lifespan |
| `stt.py` | 715 | STT providers: NvidiaStreamingSTT (gRPC), SonioxStreamingSTT (WebSocket SDK) |
| `translate.py` | 252 | Nvidia NMT translation (gRPC), streaming + instant modes |
| `summarize.py` | 301 | LLM summarization (OpenAI-compatible), MapReduce for long texts |
| `diarize.py` | ~300 | Speaker diarization: WeSpeaker CAM++ (ONNX), pitch fallback |
| `db.py` | 212 | SQLite (WAL mode, thread-local), meetings + settings tables |
| `logger.py` | 69 | Rotating file handler (10MB x 3) |
| `i18n.py` | 67 | Vietnamese/English translations |
| `api/transcription.py` | 159 | /transcribe-diarize, /translate (SSE), /summarize (SSE) |
| `api/meetings.py` | 211 | Meetings CRUD, audio/minutes download (WAV/MP4/DOCX) |
| `api/settings.py` | 106 | Settings CRUD, LLM model listing, API key masking |
| `api/diagnose.py` | 142 | Health check, STT/LLM connectivity test |
| `api/drafts.py` | 120 | Draft creation, incremental transcript/audio append |
| `services/audio.py` | 101 | ffmpeg wrapper, audio transcoding |
| `services/minutes.py` | 126 | Markdown/DOCX conversion |

### Soniox Backend Integration

- **SonioxStreamingSTT** (stt.py:365-606): SDK-based, built-in diarization, native translation via TranslationConfig
- **WS handler** (main.py:482-620): Audio archiving, speaker_split events, translation throttling (1.5s + 30-char delta)
- **Diagnose** (api/diagnose.py:67-81): Tests Soniox connection via `SonioxClient.models.list()`
- **Settings keys:** `soniox_api_key`, `soniox_language_hints`

### Key Technical Patterns

- Thread safety: SQLite thread-local + queue-based WS communication
- Hallucination filtering: removes YouTube/meeting chatter patterns
- Translation throttling: prevents flooding (1-1.5s intervals)
- Riva retry: exponential backoff (max 3)

---

## Layer 3: Tauri/Rust (src-tauri/)

### File Map

| File | Lines | Purpose |
|------|-------|---------|
| `src/lib.rs` | 1104 | Main backend: system audio capture, WS loop, sidecar management |
| `src/main.rs` | 6 | Entry point |
| `build.rs` | 11 | Framework links (CoreAudio, AudioToolbox) |
| `Cargo.toml` | - | Dependencies: tauri 2, tokio-tungstenite, hound, cidre (macOS), windows (Win) |
| `capabilities/default.json` | - | Permissions: core, opener, shell (spawn/execute/kill) |

### Tauri Commands (9 total)

| Command | Purpose |
|---------|---------|
| `request_screen_access()` | macOS screen recording permission |
| `check_screen_access()` | Check screen access status |
| `start_system_audio(stt_provider, translate_lang)` | Start system audio capture → WS stream |
| `stop_system_audio()` | Stop capture |
| `start_sidecar()` | Launch Python sidecar binary |
| `stop_sidecar()` | Stop sidecar |
| `save_audio_file(bytes, filename)` | Save audio to Downloads |
| `download_and_save_file(url, filename)` | HTTP download to Downloads |
| `check_sidecar()` | Health check (GET /health) |

### System Audio Capture

- **macOS:** CoreAudio Process Tap via `cidre` crate (global mono tap)
- **Windows:** WASAPI Loopback (COM, multi-channel → mono downsampling)
- **Audio Pipeline:** Capture → Ring buffer → Hanning sinc resample to 16kHz → PCM16 → WebSocket

### Soniox in Tauri

- `lib.rs:661`: Routes to `/ws/soniox-stream` when `stt_provider == "soniox"`
- Translation lang forwarded as query param

---

## Cross-Layer Soniox Integration Summary

```
[SettingsPanel] → stt_provider="soniox" + soniox_api_key + language_hints
       ↓
[RecordingBar] → WS connect to /ws/soniox-stream?translate_lang=X
  OR
[Tauri lib.rs] → system_audio_ws_loop → ws://127.0.0.1:8765/ws/soniox-stream
       ↓
[main.py WS handler] → SonioxStreamingSTT(api_key, language_hints)
       ↓
[stt.py] → Soniox SDK WebSocket → STT + diarization + translation
       ↓
[WS response] → { text, speaker, speaker_id, chunk_id, translation }
       ↓
[RecordingBar/Tauri] → appStore.addTranscriptPart() → TranscriptView
```

## Patterns Observed

- Dual STT provider architecture cleanly separated at WS endpoint level
- Soniox has native diarization (Python diarizer used only for Nvidia)
- Translation: Soniox = native (set at connection), Nvidia = Riva NMT (toggle mid-stream)
- Audio format: PCM 16kHz mono for both providers
- RecordingBar.tsx is the largest component (650+ lines) — candidate for modularization

## Unresolved Questions

- No unit tests found for STT streaming logic
- Soniox error handling for network interruptions (SDK-level only, no app retry)
- RecordingBar.tsx exceeds 200-line modularization threshold significantly
