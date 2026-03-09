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
| 🍎 **macOS** | Apple Silicon (M1/M2/M3/M4) | `Scribble_1.1.0_aarch64.dmg` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.1.0_aarch64.dmg) |
| 🪟 **Windows** | 64-bit | `Scribble_1.1.0_x64-setup.exe` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.1.0_x64-setup.exe) |

> **⚠️ Lưu ý macOS:** Lần đầu mở app nếu gặp cảnh báo **"Scribble Not Opened"**, mở Terminal và chạy:
> ```bash
> xattr -cr /Applications/Scribble.app
> ```
> Hoặc vào **System Settings → Privacy & Security → scroll xuống → Allow Anyway**.

## ✨ Tính năng chính

| Tính năng | Mô tả |
|-----------|-------|
| 🎙️ **Ghi âm realtime** | Voice Activity Detection (VAD) — tự cắt chunk theo silence |
| 📝 **Phiên dịch tự động** | Nvidia Riva STT — streaming gRPC, đa ngôn ngữ |
| 👥 **Nhận diện người nói** | Speaker diarization realtime — tự phân biệt giọng nói |
| 🌐 **Dịch cabin realtime** | Nvidia NMT — dịch 10+ ngôn ngữ, realtime |
| 📋 **Biên bản AI** | Tóm tắt: tiêu đề, key points, action items, decisions, risks, next steps |
| 📦 **Export đa định dạng** | Markdown (.md) và Word (.docx) |
| 💾 **Lưu nháp tự động** | Auto-save transcript vào DB, khôi phục khi crash |
| ✏️ **Sửa/Xóa transcript** | Inline edit từng dòng, auto-sync |
| 🔊 **Lưu file ghi âm** | Download audio từ meeting history |
| 🛡️ **Lọc hallucination** | Loại bỏ hallucination tự động |

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
pip install -r requirements.txt
python main.py  # → http://127.0.0.1:8765

# Chạy Tauri dev (tab khác)
cd ..
pnpm tauri dev
```

## 🔧 STT Backends

| Backend | Đặc điểm | Yêu cầu |
|---------|----------|---------|
| ☁️ **Nvidia Riva** | Streaming gRPC, đa ngôn ngữ, speaker diarization | API key từ [build.nvidia.com](https://build.nvidia.com) |
| ⚡ **Groq Whisper** | Siêu nhanh, đa ngôn ngữ, **~1.000 VNĐ/giờ** | API key từ [console.groq.com](https://console.groq.com/keys) |

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

**Ngôn ngữ:** 🇬🇧 English · 🇯🇵 Nhật · 🇰🇷 Hàn · 🇨🇳 Trung · 🇫🇷 Pháp · 🇩🇪 Đức · 🇪🇸 TBN · 🇹🇭 Thái · 🇮🇩 Indo · 🇷🇺 Nga · 🇸🇦 Ả Rập · 🇮🇳 Hindi

---

# 🇬🇧 English

## 📥 Download

| OS | Architecture | Installer | Link |
|----|-------------|-----------|------|
| 🍎 **macOS** | Apple Silicon (M1/M2/M3/M4) | `Scribble_1.1.0_aarch64.dmg` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.1.0_aarch64.dmg) |
| 🪟 **Windows** | 64-bit | `Scribble_1.1.0_x64-setup.exe` | [⬇ Download](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.1.0_x64-setup.exe) |

> **⚠️ macOS note:** If you see **"Scribble Not Opened"** on first launch, open Terminal and run:
> ```bash
> xattr -cr /Applications/Scribble.app
> ```
> Or go to **System Settings → Privacy & Security → scroll down → Allow Anyway**.

## ✨ Key Features

| Feature | Description |
|---------|-------------|
| 🎙️ **Real-time Recording** | Voice Activity Detection (VAD) — auto-splits chunks on silence |
| 📝 **Auto Transcription** | Nvidia Riva STT — streaming gRPC, multilingual |
| 👥 **Speaker Diarization** | Real-time speaker identification — auto-detects voice changes |
| 🌐 **Cabin Translation** | Nvidia NMT — 10+ languages, real-time streaming |
| 📋 **AI Minutes** | Auto-summarize: title, key points, action items, decisions, risks, next steps |
| 📦 **Multi-format Export** | Markdown (.md) and Word (.docx) |
| 💾 **Auto-save Drafts** | Transcript saved to DB incrementally, resilient to crashes |
| ✏️ **Edit/Delete Transcript** | Inline edit per line, auto-sync |
| 🔊 **Audio Recording** | Download audio from meeting history |
| 🛡️ **Hallucination Filter** | Auto-removes STT hallucinations |

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
pip install -r requirements.txt
python main.py  # → http://127.0.0.1:8765

# Run Tauri dev (another tab)
cd ..
pnpm tauri dev
```

## 🔧 STT Backends

| Backend | Highlights | Requirements |
|---------|------------|-------------|
| ☁️ **Nvidia Riva** | Streaming gRPC, multilingual, speaker diarization | API key from [build.nvidia.com](https://build.nvidia.com) |
| ⚡ **Groq Whisper** | Ultra-fast, multilingual, **~$0.04 USD/hour** | API key from [console.groq.com](https://console.groq.com/keys) |

> 🔒 **Privacy:** Your API keys are stored **entirely on your local machine**. We never collect, transmit, or use your API keys for any purpose.

## 🤖 LLM Configuration

Configure via Settings → **🤖 LLM Configuration**:

| Field | Example | Description |
|-------|---------|-------------|
| API Key | `sk-xxx` | LLM provider API key |
| Base URL | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| Model | `gpt-4o` | LLM model name |

Supports any OpenAI-compatible provider: OpenAI, Azure, Groq, Together, local Ollama, etc.

## 🌐 Cabin Translation

1. Go to **Recording** tab → enable **"Cabin Translation"** toggle → select target language
2. Start recording → translations stream in real-time below each transcript line

**Languages:** 🇬🇧 English · 🇯🇵 Japanese · 🇰🇷 Korean · 🇨🇳 Chinese · 🇫🇷 French · 🇩🇪 German · 🇪🇸 Spanish · 🇹🇭 Thai · 🇮🇩 Indonesian · 🇷🇺 Russian · 🇸🇦 Arabic · 🇮🇳 Hindi

---

## 📁 Project Structure

```
Scribble/
├── src/                   # React + TypeScript frontend
│   ├── components/        # UI components
│   ├── stores/            # Zustand state management
│   └── lib/               # API, SSE, sidecar utilities
├── src-python/            # Python FastAPI sidecar
│   ├── main.py            # FastAPI server (STT, diarize, translate, summarize)
│   ├── diarize.py         # Speaker diarization (WeSpeaker)
│   ├── translate.py       # Nvidia NMT translation
│   ├── summarize.py       # LLM summarization
│   └── stt.py             # STT service
├── src-tauri/             # Tauri Rust shell
│   ├── tauri.conf.json    # App config, icons, bundle settings
│   └── binaries/          # Platform sidecar binaries
├── package.json
├── vite.config.ts
├── build.sh               # macOS/Linux build script
├── build-windows.bat      # Windows build script
└── .github/workflows/     # CI/CD (manual dispatch)
```

---

## 🙏 Acknowledgments

This project was inspired by and incorporates ideas from:

- **[Meetily](https://github.com/Zackriya-Solutions/meetily)** by [Zackriya Solutions](https://github.com/Zackriya-Solutions) — UI/UX design patterns, summarization prompt engineering techniques, and chunking strategies for long transcripts.

## 📄 License

MIT
