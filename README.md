# 🎤 Scribble — AI Meeting Minutes

> Ứng dụng ghi chú cuộc họp thông minh — ghi âm, phiên dịch realtime, dịch cabin đa ngôn ngữ và tạo biên bản tự động bằng AI.
>
> Smart meeting notes app — record, real-time transcription, multi-language cabin translation, and AI-powered meeting minutes generation.

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-35-47848F?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

**🇻🇳 [Tiếng Việt](#-tiếng-việt)** · **🇬🇧 [English](#-english)**

---

# 🇻🇳 Tiếng Việt

## 📥 Tải ứng dụng

| Hệ điều hành | Chip / Kiến trúc | File cài đặt | Link |
|---------------|-------------------|---------------|------|
| 🍎 **macOS** | Apple Silicon (M1/M2/M3/M4) | `Scribble-1.0.0-arm64.dmg` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble-1.0.0-arm64.dmg) |
| 🍎 **macOS** | Intel | `Scribble-1.0.0-x64.dmg` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble-1.0.0-x64.dmg) |
| 🪟 **Windows** | 64-bit | `Scribble-Setup-1.0.0.exe` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble-Setup-1.0.0.exe) |

> **Lưu ý macOS:** Lần đầu mở app, nếu gặp cảnh báo "unidentified developer", click chuột phải → Open → Open.

## ✨ Tính năng chính

| Tính năng | Mô tả |
|-----------|-------|
| 🎙️ **Ghi âm realtime** | Voice Activity Detection (VAD) — tự cắt chunk theo silence |
| 📝 **Phiên dịch tự động** | 3 backend STT: Local Parakeet, Nvidia Cloud, Groq Whisper |
| 🌐 **Dịch cabin realtime** | SSE streaming qua LLM — 10 ngôn ngữ, bật/tắt tùy cuộc họp |
| 📋 **Biên bản AI** | Tóm tắt: tiêu đề, key points, action items, decisions, risks, next steps, parking lot |
| 📦 **Export đa định dạng** | Markdown (.md) và Word (.docx) |
| 💾 **Lưu nháp tự động** | Auto-save transcript vào DB, khôi phục khi crash |
| ✏️ **Sửa/Xóa transcript** | Inline edit từng dòng, auto-sync server |
| 🔊 **Lưu file ghi âm** | Upload WAV, download từ meeting history |
| 📋 **Copy VTT** | Xuất transcript chuẩn WebVTT |
| 🛡️ **Lọc hallucination** | Loại bỏ Whisper hallucination tự động |

## 🚀 Khởi chạy nhanh

### Yêu cầu

- **Node.js** 18+
- **ffmpeg** (xử lý audio)
- **Python 3.10+** (chỉ khi dùng Local Parakeet)

### Cài đặt & Chạy

```bash
git clone <repo-url>
cd meeting-minutes
npm install
npm start
# → http://localhost:3001
```

Cấu hình qua **Settings** (⚙️) trong app — không cần file `.env`.


## 🐳 Docker

```bash
# ☁️ Cloud (Groq/Nvidia STT)
docker compose up app

# 💻 Local (+ Parakeet STT on-device)
docker compose --profile local up --build
```

| Service | Port | Mô tả |
|---------|------|-------|
| `app` | 3001 | Node.js server |
| `stt` | 5555 | Parakeet STT (profile: local) |

## 🔧 STT Backends

| Backend | Đặc điểm | Yêu cầu |
|---------|----------|---------|
| 💻 **Local Parakeet** | Offline, miễn phí, tiếng Việt | Python 3.10+, ~4GB RAM |
| ☁️ **Nvidia Cloud** | 40 req/min miễn phí, **chỉ hỗ trợ tiếng Việt** | API key từ [build.nvidia.com](https://build.nvidia.com/nvidia/parakeet-ctc-0_6b-vi) |
| ⚡ **Groq Whisper** | Siêu nhanh, đa ngôn ngữ, **~1.000 VNĐ/giờ transcript** | API key từ [console.groq.com](https://console.groq.com/keys) |

> 🔒 **Bảo mật:** API key của bạn được lưu trữ **hoàn toàn trên máy tính của bạn**. Chúng tôi không thu thập, gửi đi hay sử dụng API key của bạn cho bất kỳ mục đích nào.

## 🤖 LLM Configuration

Cấu hình qua Settings → **🤖 LLM Configuration**:

| Field | Ví dụ | Mô tả |
|-------|-------|-------|
| API Key | `sk-xxx` | API key LLM |
| Base URL | `https://api.openai.com/v1` | Endpoint tương thích OpenAI |
| Model | `gpt-4o` | Tên model |

Hỗ trợ: OpenAI, Azure, Groq, Together, Ollama, ...

## 🌐 Dịch Cabin

1. Tab **Recording** → bật **"Dịch cabin"** → chọn ngôn ngữ
2. Ghi âm → bản dịch stream realtime dưới mỗi dòng transcript

**Ngôn ngữ:** 🇬🇧 English · 🇯🇵 Nhật · 🇰🇷 Hàn · 🇨🇳 Trung · 🇫🇷 Pháp · 🇩🇪 Đức · 🇪🇸 TBN · 🇹🇭 Thái · 🇮🇩 Indo · 🇷🇺 Nga

---

# 🇬🇧 English

## 📥 Download

| OS | Architecture | Installer | Link |
|----|-------------|-----------|------|
| 🍎 **macOS** | Apple Silicon (M1/M2/M3/M4) | `Scribble-1.0.0-arm64.dmg` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble-1.0.0-arm64.dmg) |
| 🍎 **macOS** | Intel | `Scribble-1.0.0-x64.dmg` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble-1.0.0-x64.dmg) |
| 🪟 **Windows** | 64-bit | `Scribble-Setup-1.0.0.exe` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble-Setup-1.0.0.exe) |

> **macOS note:** On first launch, if you see "unidentified developer" warning, right-click → Open → Open.

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🎙️ **Real-time Recording** | Voice Activity Detection (VAD) — auto-splits chunks on silence |
| 📝 **Auto Transcription** | 3 STT backends: Local Parakeet, Nvidia Cloud, Groq Whisper |
| 🌐 **Cabin Translation** | LLM SSE streaming — 10 languages, toggle per meeting |
| 📋 **AI Minutes** | Auto-summarize: title, key points, action items, decisions, risks, next steps, parking lot |
| 📦 **Multi-format Export** | Markdown (.md) and Word (.docx) |
| 💾 **Auto-save Drafts** | Transcript saved to DB incrementally, resilient to crashes |
| ✏️ **Edit/Delete Transcript** | Inline edit per line, auto-sync to server |
| 🔊 **Audio Recording** | Upload WAV, download from meeting history |
| 📋 **Copy VTT** | Export transcript in WebVTT format |
| 🛡️ **Hallucination Filter** | Auto-removes Whisper hallucinations |

## 📥 Download

Download the Scribble desktop app for your operating system:

| OS | Architecture | Installer | Link |
|----|-------------|-----------|------|
| 🍎 **macOS** | Apple Silicon (M1/M2/M3/M4) | `Scribble-1.0.0-arm64.dmg` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble-1.0.0-arm64.dmg) |
| 🍎 **macOS** | Intel | `Scribble-1.0.0-x64.dmg` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble-1.0.0-x64.dmg) |
| 🪟 **Windows** | 64-bit | `Scribble-Setup-1.0.0.exe` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble-Setup-1.0.0.exe) |

> **macOS note:** On first launch, if you see "unidentified developer" warning, right-click → Open → Open.

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+
- **ffmpeg** (audio processing)
- **Python 3.10+** (only for Local Parakeet STT)

### Install & Run

```bash
git clone <repo-url>
cd meeting-minutes
npm install
npm start
# → http://localhost:3001
```

All configuration via **Settings** (⚙️) in the app — no `.env` file required.


## 🐳 Docker

```bash
# ☁️ Cloud mode (Groq/Nvidia STT)
docker compose up app

# 💻 Local mode (+ Parakeet STT on-device)
docker compose --profile local up --build
```

| Service | Port | Description |
|---------|------|-------------|
| `app` | 3001 | Node.js main server |
| `stt` | 5555 | Parakeet STT (profile: local) |

> ⚠️ Local mode requires ~4GB RAM. Model (~600MB) downloads on first start.

## 🔧 STT Backends

| Backend | Highlights | Requirements |
|---------|------------|--------------|
| 💻 **Local Parakeet** | Offline, free, Vietnamese-optimized | Python 3.10+, ~4GB RAM |
| ☁️ **Nvidia Cloud** | 40 req/min free tier, **Vietnamese only** | API key from [build.nvidia.com](https://build.nvidia.com/nvidia/parakeet-ctc-0_6b-vi) |
| ⚡ **Groq Whisper** | Ultra-fast, multilingual, **~$0.04 USD/hour** of transcript | API key from [console.groq.com](https://console.groq.com/keys) |

> 🔒 **Privacy:** Your API keys are stored **entirely on your local machine**. We never collect, transmit, or use your API keys for any purpose.

## 🤖 LLM Configuration

Configure via Settings → **🤖 LLM Configuration**:

| Field | Example | Description |
|-------|---------|-------------|
| API Key | `sk-xxx` | LLM provider API key |
| Base URL | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| Model | `gpt-5.2` | LLM model name |

Supports any OpenAI-compatible provider: OpenAI, Azure, Groq, Together, local Ollama, etc.

## 🌐 Cabin Translation

1. Go to **Recording** tab → enable **"Cabin Translation"** toggle → select target language
2. Start recording → translations stream in real-time below each transcript line

**Languages:** 🇬🇧 English · 🇯🇵 Japanese · 🇰🇷 Korean · 🇨🇳 Chinese · 🇫🇷 French · 🇩🇪 German · 🇪🇸 Spanish · 🇹🇭 Thai · 🇮🇩 Indonesian · 🇷🇺 Russian

---

## 📁 Project Structure

```
meeting-minutes/
├── server.js              # Node.js Express server
├── db.js                  # SQLite database (better-sqlite3)
├── stt_service.py         # Python Parakeet STT microservice
├── package.json
├── electron-builder.yml   # Electron build config
├── requirements.txt       # Python dependencies
├── Dockerfile             # Node.js app image
├── Dockerfile.stt         # Parakeet STT image
├── docker-compose.yml     # Local + Cloud profiles
├── build/                 # Electron build resources (icons, entitlements)
└── public/
    ├── index.html         # Single-page app UI
    ├── app.js             # Client-side logic
    ├── i18n.js            # Internationalization
    └── style.css          # Styles
```

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/transcribe` | Upload audio → transcript |
| POST | `/api/transcribe-chunk` | Real-time chunk transcription |
| POST | `/api/summarize` | SSE streaming meeting summary (by meetingId) |
| POST | `/api/translate` | SSE streaming translation |
| GET | `/api/settings` | Get current config |
| POST | `/api/stt-config` | Save STT + LLM settings |
| GET | `/api/meetings` | List meetings |
| POST | `/api/meetings` | Create meeting |
| PUT | `/api/meetings/:id` | Update meeting |
| DELETE | `/api/meetings/:id` | Delete meeting |
| POST | `/api/meetings/:id/export` | Export as Markdown |
| POST | `/api/meetings/:id/export-docx` | Export as DOCX |
| POST | `/api/meetings/:id/audio` | Upload audio recording |
| GET | `/api/meetings/:id/audio` | Download audio recording |
| POST | `/api/drafts` | Create draft (auto-save) |
| PATCH | `/api/drafts/:id` | Append text to draft |
| GET | `/api/drafts/active` | Get active draft |

---

## 🙏 Acknowledgments

This project was inspired by and incorporates ideas from:

- **[Meetily](https://github.com/Zackriya-Solutions/meetily)** by [Zackriya Solutions](https://github.com/Zackriya-Solutions) — UI/UX design patterns, summarization prompt engineering techniques, and chunking strategies for long transcripts. Meetily is an open-source AI meeting assistant.

## 📄 License

MIT
