# 🎤 Scribble — AI Meeting Minutes

> Ứng dụng ghi chú cuộc họp thông minh — ghi âm, phiên dịch realtime, dịch cabin đa ngôn ngữ và tạo biên bản tự động bằng AI.
>
> Smart meeting notes app — record, real-time transcription, multi-language cabin translation, and AI-powered meeting minutes generation.

![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

**🇻🇳 [Tiếng Việt](#-tiếng-việt)** · **🇬🇧 [English](#-english)**

### 🎬 Demo

<p align="center">
  <img src="public/demo.gif" alt="Scribble Demo" width="800">
</p>

---

# 🇻🇳 Tiếng Việt

## 📥 Tải ứng dụng

| Hệ điều hành | Chip / Kiến trúc | File cài đặt | Link |
|---------------|-------------------|---------------|------|
| 🍎 **macOS** | Apple Silicon (M1/M2/M3/M4) | `Scribble_1.1.4_aarch64.dmg` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.1.4_aarch64.dmg) |
| 🪟 **Windows** | 64-bit | `Scribble_1.1.4_x64-setup.exe` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.1.4_x64-setup.exe) |
| 🐧 **Linux** | 64-bit (AppImage) | `Scribble_1.1.4_amd64.AppImage` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.1.4_amd64.AppImage) |
| 🐧 **Linux** | 64-bit (deb) | `scribble_1.1.4_amd64.deb` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/scribble_1.1.4_amd64.deb) |

> **⚠️ Lưu ý macOS:** Lần đầu mở app nếu gặp cảnh báo **"Scribble Not Opened"**, mở Terminal và chạy:
> ```bash
> xattr -cr /Applications/Scribble.app
> ```
> Hoặc vào **System Settings → Privacy & Security → scroll xuống → Allow Anyway**.

## ✨ Tính năng chính

| Tính năng | Mô tả |
|-----------|-------|
| 🎙️ **Ghi âm realtime** | Voice Activity Detection — tự cắt chunk theo silence |
| 📤 **Upload file ghi âm** | Tải lên m4a/mp3/wav/mp4 có sẵn → phiên âm + biên bản tự động. Resume khi pipeline bị gián đoạn, lưu transcript theo từng chunk (timestamps mỗi 22s) |
| 📝 **Phiên dịch tự động** | Nvidia Riva STT (streaming gRPC, 13+ ngôn ngữ) hoặc Soniox (chất lượng cao, ~$0.12/giờ) |
| 👥 **Nhận diện người nói** | Speaker diarization realtime (ONNX Runtime + CAM++) — tự phân biệt giọng nói |
| 🌐 **Dịch cabin realtime** | Nvidia NMT — dịch 10+ ngôn ngữ, realtime |
| 📋 **Biên bản AI** | Tóm tắt: tiêu đề, key points, action items, decisions, risks, next steps. Hỗ trợ template MoM / Deep / Summary / Bullets / Custom |
| 📎 **Tài liệu tham khảo** | Attach file .md / .txt vào meeting làm context cho AI — agenda, brief, glossary, prior decisions. Tối đa 1MB/file, 2MB tổng |
| 📦 **Export đa định dạng** | Markdown (.md) và Word (.docx) |
| 💾 **Lưu nháp tự động** | Auto-save transcript vào DB, khôi phục khi crash |
| ✏️ **Sửa/Xóa transcript** | Inline edit từng dòng, auto-sync |
| 🔊 **Lưu file ghi âm** | Download audio từ meeting history |
| 🛡️ **Lọc hallucination** | Loại bỏ hallucination tự động |
| ⚡ **Zero manual setup** | Cài là chạy ngay — chỉ cần nhập API key + tên model trong Settings, không có script SQL/flag ẩn |

## 🚀 Khởi chạy (Development)

### Yêu cầu

- **Node.js** 20+ & **pnpm**
- **Python** 3.10+
- **Rust** (cài từ [rustup.rs](https://rustup.rs))

### Cài đặt & Chạy

```bash
git clone https://github.com/luongndcoder/Scribble.git
cd Scribble
pnpm install

# Chạy Python sidecar
cd src-python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py  # → http://127.0.0.1:8765

# Chạy Tauri dev (tab khác)
cd ..
pnpm tauri dev
```

### 🐳 Docker Compose (Web)

```bash
git clone https://github.com/luongndcoder/Scribble.git
cd Scribble
docker-compose up --build
# → http://localhost:3000
```

> Dữ liệu SQLite lưu trong `./data/`. API key nhập từ giao diện Settings.


### 🔨 Build từ source

#### macOS (Apple Silicon)

```bash
# 1. Build sidecar
cd src-python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m PyInstaller scribble-sidecar.spec --noconfirm --clean

# 2. Copy sidecar vào Tauri
cp dist/scribble-sidecar ../src-tauri/binaries/scribble-sidecar-aarch64-apple-darwin

# 3. Build DMG
cd ..
pnpm install
npx tauri build -b dmg
# → src-tauri/target/release/bundle/dmg/Scribble_*.dmg
```

#### Windows (64-bit)

```bash
# 1. Build sidecar
cd src-python
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
python -m PyInstaller scribble-sidecar.spec --noconfirm --clean

# 2. Copy sidecar vào Tauri
copy dist\scribble-sidecar.exe ..\src-tauri\binaries\scribble-sidecar-x86_64-pc-windows-msvc.exe

# 3. Build NSIS installer
cd ..
pnpm install
npx tauri build -b nsis --target x86_64-pc-windows-msvc
# → src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
```

#### Linux (Ubuntu/Debian)

```bash
# 1. Build sidecar
cd src-python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m PyInstaller scribble-sidecar.spec --noconfirm --clean

# 2. Copy sidecar vào Tauri
cp dist/scribble-sidecar ../src-tauri/binaries/scribble-sidecar-x86_64-unknown-linux-gnu

# 3. Build AppImage + deb
cd ..
pnpm install
npx tauri build
# → src-tauri/target/release/bundle/appimage/*.AppImage
# → src-tauri/target/release/bundle/deb/*.deb
```

> **💡 CI/CD:** Windows và Linux build tự động qua GitHub Actions, trigger bằng `workflow_dispatch`.

## 🔧 STT Backends

| Backend | Đặc điểm | Yêu cầu | Chi phí |
|---------|----------|---------|---------|
| ☁️ **Nvidia Riva** | Streaming gRPC, 13+ ngôn ngữ, speaker diarization, Parakeet CTC 0.6B cho tiếng Việt | API key từ [build.nvidia.com](https://build.nvidia.com) | Free tier hào phóng |
| 🎯 **Soniox** | Chất lượng tốt nhất, đa ngôn ngữ trong cùng 1 audio, diarization tích hợp | API key từ [soniox.com](https://soniox.com) | ~$0.12/giờ |

> 🔒 **Bảo mật:** API key của bạn được lưu trữ **hoàn toàn trên máy tính của bạn**. Chúng tôi không thu thập, gửi đi hay sử dụng API key của bạn cho bất kỳ mục đích nào.

## 🤖 LLM Configuration

Cấu hình qua Settings — UI 2 cột (STT bên trái, AI bên phải) — không phải scroll:

| Field | Ví dụ | Mô tả |
|-------|-------|-------|
| Provider | OpenAI / DeepSeek / Mistral / Groq / Gemini / OpenRouter / Compatible | Chọn nhà cung cấp |
| API Key | `sk-xxx` | API key LLM |
| Base URL | `https://api.openai.com/v1` | Chỉ cần cho "Tương thích OpenAI" |
| Model | `gpt-4o-mini` / `deepseek-chat` / ... | Tên model — click dropdown để tải danh sách model khả dụng |

Hỗ trợ mọi provider OpenAI-compatible: OpenAI, DeepSeek, Mistral, Groq, Gemini, OpenRouter, Together, Ollama local, ...

## 🌐 Dịch Cabin

1. Tab **Recording** → bật **"Dịch cabin"** → chọn ngôn ngữ
2. Ghi âm → bản dịch stream realtime dưới mỗi dòng transcript

**Ngôn ngữ:** 🇬🇧 English · 🇯🇵 Nhật · 🇰🇷 Hàn · 🇨🇳 Trung · 🇫🇷 Pháp · 🇩🇪 Đức · 🇪🇸 TBN · 🇹🇭 Thái · 🇮🇩 Indo · 🇷🇺 Nga · 🇸🇦 Ả Rập · 🇮🇳 Hindi

## 📤 Upload file ghi âm

Có sẵn file audio/video → không cần ghi âm lại. Pipeline tự xử lý:

1. Trang **Cuộc họp** → bấm **"Upload file"** (góc phải)
2. Chọn file (m4a / mp3 / wav / mp4 / mkv / webm — tối đa 2GB), tiêu đề, ngôn ngữ
3. Pipeline chạy tự động:
   - **Normalize** → 16kHz mono WAV
   - **Split** → cắt chunk theo silence (ffmpeg silencedetect, target 22s)
   - **Transcribe** → STT song song 3 chunks/lần (Nvidia Riva streaming)
   - **Diarize** → CAM++ ONNX + clustering toàn cuộc họp
   - **Summarize** → LLM tự sinh biên bản
4. Tiến độ stream qua SSE — đóng app vẫn tiếp tục, mở lại meeting để **Resume** từ chunk dở dang

**Đặc điểm**:
- Mỗi chunk lưu transcript + embedding ngay khi xong → crash recovery hoàn hảo
- Timestamps mỗi 22s trong transcript (vd `1:24 – 1:46`)
- Idempotent: upload file trùng (cùng SHA-256) → tự redirect về meeting cũ
- Cross-platform: m4a/mp4 đều OK trên Windows / Linux / macOS

## 📎 Tài liệu tham khảo (Reference Materials)

Cho AI thêm context khi tạo biên bản — agenda, project brief, glossary, prior decisions:

1. Mở meeting → tab **Biên bản** → mục **"Tài liệu tham khảo"**
2. Bấm **"+ Thêm tài liệu"** → chọn file `.md` / `.txt` (tối đa **1 MB/file**, **2 MB tổng/meeting**, 10 file)
3. Bấm **"Tạo biên bản"** (regenerate) — AI dùng tài liệu này làm context

**AI sẽ**:
- Dùng tên/thuật ngữ trong tài liệu làm source of truth (sửa lỗi STT mistranscribe tên riêng)
- Cross-reference cuộc họp với agenda — mục nào đã thảo luận, mục nào skip
- Call out khi decision khác với đề xuất trong brief
- Liệt kê tài liệu đã dùng ở cuối biên bản

> ⚠️ **Cảnh báo token**: khi total > 400KB, UI hiện warning vì model 128k context (vd gpt-4o-mini) có thể bị cắt — cân nhắc dùng Claude/Gemini context lớn hơn.

---

# 🇬🇧 English

## 📥 Download

| OS | Architecture | Installer | Link |
|----|-------------|-----------|------|
| 🍎 **macOS** | Apple Silicon (M1/M2/M3/M4) | `Scribble_1.1.4_aarch64.dmg` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.1.4_aarch64.dmg) |
| 🪟 **Windows** | 64-bit | `Scribble_1.1.4_x64-setup.exe` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.1.4_x64-setup.exe) |
| 🐧 **Linux** | 64-bit (AppImage) | `Scribble_1.1.4_amd64.AppImage` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.1.4_amd64.AppImage) |
| 🐧 **Linux** | 64-bit (deb) | `scribble_1.1.4_amd64.deb` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/scribble_1.1.4_amd64.deb) |

> **⚠️ macOS note:** If you see **"Scribble Not Opened"** on first launch, open Terminal and run:
> ```bash
> xattr -cr /Applications/Scribble.app
> ```
> Or go to **System Settings → Privacy & Security → scroll down → Allow Anyway**.

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🎙️ **Real-time Recording** | Voice Activity Detection — auto-splits chunks on silence |
| 📤 **Upload Audio Files** | Upload existing m4a/mp3/wav/mp4 → automatic transcription + minutes. Resumable pipeline (survives app restart), per-chunk timestamps (every ~22s) |
| 📝 **Auto Transcription** | Nvidia Riva STT (streaming gRPC, 13+ languages) or Soniox (premium quality, ~$0.12/hr) |
| 👥 **Speaker Diarization** | Real-time speaker identification (ONNX Runtime + CAM++) — auto-detects voice changes |
| 🌐 **Cabin Translation** | Nvidia NMT — 10+ languages, real-time streaming |
| 📋 **AI Minutes** | Auto-summarize: title, key points, action items, decisions, risks, next steps. Templates: MoM / Deep / Summary / Bullets / Custom |
| 📎 **Reference Materials** | Attach .md / .txt docs to a meeting as AI context — agendas, briefs, glossaries, prior decisions. Max 1MB/file, 2MB/meeting total |
| 📦 **Multi-format Export** | Markdown (.md) and Word (.docx) |
| 💾 **Auto-save Drafts** | Transcript saved to DB incrementally, resilient to crashes |
| ✏️ **Edit/Delete Transcript** | Inline edit per line, auto-sync |
| 🔊 **Audio Recording** | Download audio from meeting history |
| 🛡️ **Hallucination Filter** | Auto-removes STT hallucinations |
| ⚡ **Zero Manual Setup** | Install and go — only API keys + model names in Settings. No SQL scripts, no hidden flags |

## 🚀 Quick Start (Development)

### Prerequisites

- **Node.js** 20+ & **pnpm**
- **Python** 3.10+
- **Rust** (install from [rustup.rs](https://rustup.rs))

### Install & Run

```bash
git clone https://github.com/luongndcoder/Scribble.git
cd Scribble
pnpm install

# Run Python sidecar
cd src-python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py  # → http://127.0.0.1:8765

# Run Tauri dev (another tab)
cd ..
pnpm tauri dev
```

### 🐳 Docker Compose (Web)

```bash
git clone https://github.com/luongndcoder/Scribble.git
cd Scribble
docker-compose up --build
# → http://localhost:3000
```

> SQLite data stored in `./data/`. API keys configured via Settings UI.


### 🔨 Build from Source

#### macOS (Apple Silicon)

```bash
# 1. Build sidecar
cd src-python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m PyInstaller scribble-sidecar.spec --noconfirm --clean

# 2. Copy sidecar to Tauri
cp dist/scribble-sidecar ../src-tauri/binaries/scribble-sidecar-aarch64-apple-darwin

# 3. Build DMG
cd ..
pnpm install
npx tauri build -b dmg
# → src-tauri/target/release/bundle/dmg/Scribble_*.dmg
```

#### Windows (64-bit)

```bash
# 1. Build sidecar
cd src-python
python -m venv .venv && .venv\Scripts\activate
pip install -r requirements.txt
python -m PyInstaller scribble-sidecar.spec --noconfirm --clean

# 2. Copy sidecar to Tauri
copy dist\scribble-sidecar.exe ..\src-tauri\binaries\scribble-sidecar-x86_64-pc-windows-msvc.exe

# 3. Build NSIS installer
cd ..
pnpm install
npx tauri build -b nsis --target x86_64-pc-windows-msvc
# → src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
```

#### Linux (Ubuntu/Debian)

```bash
# 1. Build sidecar
cd src-python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m PyInstaller scribble-sidecar.spec --noconfirm --clean

# 2. Copy sidecar to Tauri
cp dist/scribble-sidecar ../src-tauri/binaries/scribble-sidecar-x86_64-unknown-linux-gnu

# 3. Build AppImage + deb
cd ..
pnpm install
npx tauri build
# → src-tauri/target/release/bundle/appimage/*.AppImage
# → src-tauri/target/release/bundle/deb/*.deb
```

> **💡 CI/CD:** Windows and Linux builds run automatically via GitHub Actions, triggered by `workflow_dispatch`.

## 🔧 STT Backends

| Backend | Highlights | Requirements | Cost |
|---------|------------|--------------|------|
| ☁️ **Nvidia Riva** | Streaming gRPC, 13+ languages, speaker diarization, Parakeet CTC 0.6B for Vietnamese | API key from [build.nvidia.com](https://build.nvidia.com) | Generous free tier |
| 🎯 **Soniox** | Best-in-class accuracy, multi-lang mixed audio, built-in diarization | API key from [soniox.com](https://soniox.com) | ~$0.12/hr |

> 🔒 **Privacy:** Your API keys are stored **entirely on your local machine**. We never collect, transmit, or use your API keys for any purpose.

## 🤖 LLM Configuration

Configure via Settings — 2-column layout (STT left, AI right) — no scrolling:

| Field | Example | Description |
|-------|---------|-------------|
| Provider | OpenAI / DeepSeek / Mistral / Groq / Gemini / OpenRouter / Compatible | Pick a provider |
| API Key | `sk-xxx` | LLM provider API key |
| Base URL | `https://api.openai.com/v1` | Only for "OpenAI Compatible" |
| Model | `gpt-4o-mini` / `deepseek-chat` / ... | Click the dropdown to fetch available models |

Supports any OpenAI-compatible provider: OpenAI, DeepSeek, Mistral, Groq, Gemini, OpenRouter, Together, local Ollama, etc.

## 🌐 Cabin Translation

1. Go to **Recording** tab → enable **"Cabin Translation"** toggle → select target language
2. Start recording → translations stream in real-time below each transcript line

**Languages:** 🇬🇧 English · 🇯🇵 Japanese · 🇰🇷 Korean · 🇨🇳 Chinese · 🇫🇷 French · 🇩🇪 German · 🇪🇸 Spanish · 🇹🇭 Thai · 🇮🇩 Indonesian · 🇷🇺 Russian · 🇸🇦 Arabic · 🇮🇳 Hindi

## 📤 Upload Audio File

Have an existing audio/video file? Skip live recording — the pipeline handles it:

1. **Meetings** page → click **"Upload file"** (top right)
2. Pick file (m4a / mp3 / wav / mp4 / mkv / webm — up to 2GB), title, language
3. Pipeline runs automatically:
   - **Normalize** → 16kHz mono WAV
   - **Split** → silence-aligned chunks (ffmpeg silencedetect, ~22s target)
   - **Transcribe** → 3 concurrent STT calls (Nvidia Riva streaming)
   - **Diarize** → CAM++ ONNX + global clustering
   - **Summarize** → LLM auto-generates minutes
4. Progress streams via SSE — closing the app is fine, reopen the meeting and **Resume** picks up where it left off

**Highlights**:
- Per-chunk save (transcript + embedding) → perfect crash recovery
- Per-chunk timestamps in transcript (e.g. `1:24 – 1:46`)
- Idempotent: re-uploading the same file (matching SHA-256) redirects to the existing meeting
- Cross-platform: m4a/mp4 work on Windows / Linux / macOS

## 📎 Reference Materials

Give the AI extra context when generating minutes — agendas, project briefs, glossaries, prior decisions:

1. Open a meeting → **Minutes** tab → **"Reference materials"** section
2. Click **"+ Add file"** → pick a `.md` / `.txt` (max **1 MB/file**, **2 MB total/meeting**, 10 files)
3. Click **"Create Minutes"** (regenerate) — AI now uses these as context

**The AI will**:
- Treat names/terminology from your docs as source of truth (correcting STT mistranscriptions of proper nouns)
- Cross-reference the meeting against the agenda — note what was covered vs. skipped
- Call out when a decision diverges from what the brief proposed
- List which reference files it used at the bottom of the minutes

> ⚠️ **Token warning**: past 400KB total, the UI surfaces a warning — 128k-context models (e.g. gpt-4o-mini) may truncate. Consider larger-context models (Claude, Gemini).

---

## 📁 Project Structure

```
Scribble/
├── src/                       # React + TypeScript frontend
│   ├── components/
│   │   ├── MeetingList.tsx        # Meeting history + Upload button
│   │   ├── MeetingDetail.tsx      # Compact toolbar (back + tabs + actions)
│   │   ├── MeetingAttachments.tsx # Reference materials (collapsible)
│   │   ├── UploadAudioModal.tsx   # File picker + pipeline progress SSE
│   │   ├── RecordingBar.tsx       # Slim merged rec + translation bar
│   │   ├── StartupStatusBar.tsx   # Bottom-dock startup status strip
│   │   ├── SettingsPanel.tsx      # 2-column STT | AI settings
│   │   └── TranscriptView.tsx     # Per-chunk transcript w/ timestamps
│   ├── stores/appStore.ts         # Zustand state (incl. backendOnline)
│   └── lib/
│       ├── attachments.ts         # Reference materials client
│       ├── upload-audio.ts        # Audio upload + SSE bridge
│       └── sidecar.ts             # Sidecar HTTP/WS helpers
├── src-python/                # Python FastAPI sidecar
│   ├── main.py                # FastAPI server, lifecycle, WS handlers
│   ├── db.py                  # SQLite singleton + migrations
│   ├── stt.py                 # STT (Nvidia Riva streaming, Soniox)
│   ├── diarize.py             # Realtime speaker ID (CAM++ ONNX)
│   ├── translate.py           # Nvidia NMT
│   ├── summarize.py           # LLM minutes (MoM/Deep/Summary, MapReduce)
│   ├── api/
│   │   ├── upload.py          # /meetings/upload-audio, SSE job events
│   │   ├── attachments.py     # /meetings/{id}/attachments CRUD
│   │   ├── transcription.py   # /summarize, /translate
│   │   ├── settings.py        # Settings CRUD + provider URLs
│   │   ├── meetings.py        # Meetings CRUD + audio download
│   │   └── diagnose.py        # /test-stt, /test-llm
│   ├── services/
│   │   ├── upload_pipeline.py # Normalize → split → STT → diarize → summarize
│   │   ├── vad_splitter.py    # ffmpeg silencedetect chunker (22s target)
│   │   ├── batch_diarizer.py  # scipy clustering on CAM++ embeddings
│   │   ├── job_registry.py    # In-memory job state + SSE queue
│   │   ├── upload_storage.py  # Streaming write + sha256 + sanitize
│   │   └── audio.py           # find_ffmpeg helper (cross-platform)
│   ├── models/                # ONNX model files (voxceleb_CAM++)
│   └── scribble-sidecar.spec  # PyInstaller build spec (onedir)
├── src-tauri/                 # Tauri Rust shell
│   ├── src/
│   │   ├── lib.rs             # App entrypoint, sidecar extraction
│   │   └── upload.rs          # Streaming multipart upload to sidecar
│   ├── tauri.conf.json        # App config, icons, bundle settings
│   └── binaries/              # Platform sidecar binaries (tar.gz onedir)
├── .github/workflows/         # CI/CD (Windows + Linux builds)
└── package.json
```

---

## 🙏 Acknowledgments

This project was inspired by and incorporates ideas from:

- **[Meetily](https://github.com/Zackriya-Solutions/meetily)** by [Zackriya Solutions](https://github.com/Zackriya-Solutions) — UI/UX design patterns, summarization prompt engineering techniques, and chunking strategies for long transcripts.

## 📄 License

MIT
