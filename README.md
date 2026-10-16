# Scribble

> AI-powered meeting assistant for real-time transcription, speaker diarization, live cabin translation, and automated meeting minutes.

[![Tauri 2.0](https://img.shields.io/badge/Tauri-2.0-blue.svg)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-1.75+-orange.svg)](https://www.rust-lang.org/)
[![React 19](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![Version](https://img.shields.io/badge/Release-v1.3.5-green.svg)](https://github.com/luongndcoder/Scribble/releases/tag/v1.3.5)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Tiếng Việt](#tiếng-việt) | [English](#english)

---

<p align="center">
  <img src="public/demo.gif" alt="Scribble Demo" width="800">
</p>

---

# Tiếng Việt

Scribble là ứng dụng trợ lý cuộc họp mã nguồn mở, hoạt động trực tiếp trên máy người dùng (on-device). Ứng dụng hỗ trợ ghi âm micro và âm thanh hệ thống (system audio loopback), phiên âm thời gian thực, nhận diện từng người nói (speaker diarization), dịch cabin đa ngôn ngữ và tạo biên bản cuộc họp chi tiết thông qua các mô hình ngôn ngữ lớn (LLM).

Từ phiên bản 1.3, toàn bộ backend đã được chuyển đổi hoàn toàn sang **Rust native (in-process Axum server)**. Ứng dụng chạy dưới dạng một gói binary duy nhất, không yêu cầu cài đặt môi trường Python hay runtime bên ngoài.

---

## Tải ứng dụng (v1.3.5)

| Hệ điều hành | Kiến trúc | Định dạng | Tải về |
|---|---|---|---|
| macOS | Apple Silicon (M1/M2/M3/M4) | DMG | [Scribble_1.3.5_aarch64.dmg](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.3.5_aarch64.dmg) |
| Windows | 64-bit (x64) | Setup EXE | [Scribble_1.3.5_x64-setup.exe](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.3.5_x64-setup.exe) |
| Linux | 64-bit (x64) | AppImage | [Scribble_1.3.5_amd64.AppImage](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.3.5_amd64.AppImage) |
| Linux | 64-bit (x64) | Debian Package | [scribble_1.3.5_amd64.deb](https://github.com/luongndcoder/Scribble/releases/latest/download/scribble_1.3.5_amd64.deb) |

### Lưu ý khi cài đặt trên macOS

Do ứng dụng chưa đăng ký chứng chỉ trả phí từ Apple Developer, lần đầu mở ứng dụng macOS có thể hiển thị cảnh báo "Scribble cannot be opened because the developer cannot be verified". 

Để mở app:
1. Mở **System Settings** -> **Privacy & Security** -> cuộn xuống mục Security và chọn **Open Anyway**.
2. Hoặc mở Terminal và chạy lệnh gỡ thuộc tính cách ly:
   ```bash
   xattr -cr /Applications/Scribble.app
   ```

---

## Kiến trúc hệ thống

Scribble được thiết kế theo mô hình desktop app hiệu năng cao và bảo mật dữ liệu tuyệt đối:

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Zustand quản lý trạng thái, Lucide icons.
- **Desktop Shell & Backend**: Tauri v2 kết hợp máy chủ HTTP & WebSocket Axum nhúng trực tiếp trong tiến trình Rust.
- **Cơ sở dữ liệu cục bộ**: SQLite nhúng thông qua `rusqlite`, lưu trữ toàn bộ lịch sử cuộc họp, transcript và cài đặt trên máy người dùng.
- **Ghi âm âm thanh hệ thống**:
  - macOS: CoreAudio process tap qua thư viện `cidre`.
  - Windows: WASAPI loopback capture trực tiếp từ card âm thanh.
- **Công cụ Speech-to-Text (STT)**:
  - Cloud: Nvidia Riva streaming gRPC (hỗ trợ mô hình tiếng Việt Parakeet CTC 0.6B) và Soniox WebSocket.
  - Offline / Local: Mô hình Zipformer 30M tiếng Việt chạy qua `sherpa-onnx`, và mô hình Nemotron 3.5 ASR tăng tốc phần cứng Apple Silicon GPU qua `mlx-rs`.
- **Nhận diện người nói (Speaker Diarization)**: Chạy mô hình ResNet34 / CAM++ ONNX cục bộ qua `ort` và `kaldi-native-fbank`, phân tách giọng nói theo cửa sổ thời gian thực.
- **Tự động cập nhật**: Tích hợp `tauri-plugin-updater` hỗ trợ kiểm tra phiên bản mới, xác thực chữ ký số và cập nhật in-place.

---

## Tính năng chính

### 1. Ghi âm & Thu âm thanh hệ thống
Thu âm song song từ micro ngoài và âm thanh cuộc họp (Zoom, Google Meet, Microsoft Teams) mà không cần cài thêm driver âm thanh ảo. Voice Activity Detection (VAD) tự động phân tách câu theo khoảng lặng.

### 2. Phiên âm thời gian thực & Dịch cabin
- Hiển thị văn bản tức thời khi người nói cất lời với độ trễ thấp (< 1s).
- Hỗ trợ dịch cabin trực tiếp (Nvidia NMT): Bản dịch tiếng Anh, Nhật, Hàn, Trung, Pháp, Đức, v.v. xuất hiện ngay dưới từng dòng hội thoại.
- Chế độ Offline hoàn toàn: Không gửi dữ liệu qua mạng khi chọn backend Local.

### 3. Nhận diện người nói tự động (Diarization)
Phân loại chính xác các lượt phát biểu ("Người nói 1", "Người nói 2", v.v.) và cho phép đổi tên người nói trực tiếp trên giao diện.

### 4. Xử lý file ghi âm có sẵn (Audio Upload Pipeline)
- Hỗ trợ các định dạng: `.mp3`, `.m4a`, `.wav`, `.mp4`, `.mkv`, `.webm` (dung lượng tối đa 2GB).
- Pipeline tự động: Chuẩn hoá audio 16kHz mono -> Cắt lát VAD bằng FFmpeg -> Phiên âm song song đa luồng -> Gán nhãn người nói.
- Cơ chế khôi phục (Resume): Lưu dữ liệu theo từng chunk vào SQLite; nếu tắt ứng dụng giữa chừng, tiến trình có thể tiếp tục ngay từ điểm dừng mà không cần xử lý lại từ đầu.

### 5. Tạo biên bản cuộc họp thông minh bằng AI
- Tự động trích xuất: Tiêu đề, Tóm tắt điều hành, Các điểm thảo luận cốt lõi, Nhiệm vụ cần thực hiện (Action Items kèm người phụ trách/hạn chót), Quyết định đã thông qua, và Rủi ro/Kế hoạch tiếp theo.
- Cung cấp sẵn các mẫu biên bản: Phân tích chi tiết, MoM tiêu chuẩn, Tóm tắt ngắn, Gạch đầu dòng, hoặc Tuỳ chỉnh prompt theo ý muốn.
- **Tài liệu tham khảo (Reference Materials)**: Đính kèm tài liệu `.md` / `.txt` (agenda cuộc họp, brief dự án, bảng thuật ngữ) để AI đối chiếu, sửa lỗi nhận diện tên riêng và đánh dấu các nội dung bị bỏ sót so với lịch trình.

### 6. Xuất dữ liệu & Nghe lại đồng bộ
- Trình phát âm thanh đồng bộ: Bấm vào bất kỳ mốc thời gian nào trong transcript để phát lại chính xác đoạn âm thanh tương ứng.
- Xuất biên bản ra định dạng Microsoft Word (`.docx`) hoặc Markdown (`.md`).
- Tự động lưu nháp liên tục, hạn chế tối đa rủi ro mất dữ liệu khi mất điện hoặc tắt app đột ngột.

---

## Cấu hình dịch vụ AI

Mọi thông tin cấu hình và API key đều được lưu trữ hoàn toàn trong cơ sở dữ liệu SQLite cục bộ trên máy của bạn.

### Cấu hình Speech-to-Text (STT)

| Backend | Loại | Đặc điểm | Yêu cầu |
|---|---|---|---|
| Nvidia Riva | Cloud | Tốc độ cao, độ trễ thấp, hỗ trợ tiếng Việt chất lượng cao (Parakeet 0.6B) | API Key từ [build.nvidia.com](https://build.nvidia.com) |
| Soniox | Cloud | Độ chính xác cao, tự động nhận diện ngôn ngữ trộn lẫn | API Key từ [soniox.com](https://soniox.com) |
| Local (Offline) | Trên máy | Hoàn toàn riêng tư, không cần mạng hay API key | Tích hợp sẵn (sherpa-onnx) hoặc tải thêm model MLX trên macOS |

### Cấu hình LLM tạo biên bản

Scribble hỗ trợ giao thức chuẩn OpenAI API, cho phép kết nối tới hầu hết các nhà cung cấp:
- OpenAI (`gpt-4o`, `gpt-4o-mini`)
- DeepSeek (`deepseek-chat`)
- Anthropic Claude (qua OpenRouter)
- Groq / Mistral / Google Gemini API
- Local LLM: Ollama, vLLM hoặc LM Studio qua cổng Base URL cục bộ (`http://localhost:11434/v1`)

---

## Hướng dẫn phát triển (Development)

### Yêu cầu môi trường
- Node.js 20+ và `pnpm`
- Rust 1.75+ (cài đặt qua [rustup.rs](https://rustup.rs))
- CMake và C++ Build Tools (cho việc biên dịch các thư viện ONNX/Sherpa)
- macOS: Xcode Command Line Tools
- Linux: `libwebkit2gtk-4.1-dev`, `libasound2-dev`, `libssl-dev`

### Chạy ứng dụng ở chế độ phát triển

```bash
# 1. Clone repository
git clone https://github.com/luongndcoder/Scribble.git
cd Scribble

# 2. Cài đặt dependencies frontend
pnpm install

# 3. Khởi chạy ứng dụng Tauri (Rust backend + Vite frontend)
pnpm tauri dev
```

### Đóng gói ứng dụng từ mã nguồn

```bash
# macOS (DMG Apple Silicon)
pnpm tauri build -b dmg

# Windows (NSIS Installer x64)
pnpm tauri build -b nsis

# Linux (AppImage & deb)
pnpm tauri build
```

---

# English

Scribble is an open-source, on-device AI meeting assistant. It captures microphone and system audio loopback, performs real-time speech-to-text, identifies speakers with diarization, provides live cabin translation, and generates structured meeting minutes using large language models.

From version 1.3 onward, the backend has been completely rewritten into **native Rust (in-process Axum server)**. The desktop application runs as a self-contained binary bundle with zero Python or external runtime dependencies.

---

## Downloads (v1.3.5)

| Platform | Architecture | Package Format | Download |
|---|---|---|---|
| macOS | Apple Silicon (M1/M2/M3/M4) | DMG | [Scribble_1.3.5_aarch64.dmg](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.3.5_aarch64.dmg) |
| Windows | 64-bit (x64) | Setup EXE | [Scribble_1.3.5_x64-setup.exe](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.3.5_x64-setup.exe) |
| Linux | 64-bit (x64) | AppImage | [Scribble_1.3.5_amd64.AppImage](https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble_1.3.5_amd64.AppImage) |
| Linux | 64-bit (x64) | Debian Package | [scribble_1.3.5_amd64.deb](https://github.com/luongndcoder/Scribble/releases/latest/download/scribble_1.3.5_amd64.deb) |

### macOS Security Gatekeeper Note

If macOS displays "Scribble cannot be opened because the developer cannot be verified" on first launch:
1. Go to **System Settings** -> **Privacy & Security**, scroll down to the Security section, and click **Open Anyway**.
2. Alternatively, remove the quarantine attribute via Terminal:
   ```bash
   xattr -cr /Applications/Scribble.app
   ```

---

## Technical Architecture

- **User Interface**: React 19, TypeScript, Tailwind CSS v4, Zustand store, Lucide icons.
- **Application Shell & Engine**: Tauri v2 embedding an in-process Axum HTTP and WebSocket server.
- **Local Database**: Embedded SQLite via `rusqlite`, keeping all meetings, transcripts, and preferences strictly on your disk.
- **Native Audio Capture**:
  - macOS: CoreAudio process tap via `cidre`.
  - Windows: Direct WASAPI loopback capture.
- **Speech Recognition Engines**:
  - Cloud: Nvidia Riva streaming gRPC and Soniox streaming WebSocket.
  - Offline / Local: Bundled Vietnamese Zipformer 30M via `sherpa-onnx`, and multilingual Nemotron 3.5 ASR running on Apple Silicon GPU via `mlx-rs`.
- **Speaker Diarization**: ResNet34 / CAM++ ONNX model running locally via `ort` and `kaldi-native-fbank`.
- **Integrated Auto-Updater**: Built-in update checker and in-place installer backed by `tauri-plugin-updater` and cryptographic signatures.

---

## Key Capabilities

- **System Audio & Microphone Recording**: Capture sound from conferencing tools (Zoom, Google Meet, Teams) and microphones simultaneously.
- **Real-Time Streaming STT**: Low-latency transcription as you speak, with support for offline processing.
- **Live Cabin Translation**: Simultaneous multi-language translation (English, Japanese, Korean, Chinese, French, German, Spanish, etc.) displayed alongside the transcript.
- **Speaker Diarization**: Automatic speaker segmentation and labeling, with full inline editing.
- **Audio File Upload Pipeline**: Transcribe pre-recorded files (`.mp3`, `.m4a`, `.wav`, `.mp4`, `.mkv`, `.webm`) using silence-aware VAD chunking and parallel transcription with incremental resume support.
- **AI Minutes & Reference Materials**: Generate executive summaries, key decisions, action items, and risks. Attach reference files (`.md` or `.txt`) such as agendas and briefs to provide grounding context for LLM generation.
- **Interactive Audio Playback**: Click any transcript timestamp to jump to the exact moment in the recorded audio.
- **Document Export**: Export meeting minutes directly to Microsoft Word (`.docx`) or Markdown (`.md`).

---

## Project Structure

```
Scribble/
├── src/                       # Frontend application (React 19 + TypeScript + Vite)
│   ├── components/            # UI components (Meeting detail, Upload modal, Settings, etc.)
│   ├── stores/                # Zustand client state stores
│   └── lib/                   # API clients, audio utilities, updater helpers
├── src-tauri/                 # Native desktop application (Tauri v2 + Rust)
│   ├── src/
│   │   ├── api/               # In-process Axum REST & WebSocket endpoints
│   │   ├── diarize/           # ONNX speaker embedding & clustering
│   │   ├── pipeline/          # Upload audio processing & VAD chunking pipeline
│   │   ├── stt/               # Speech-to-text drivers (Riva, Soniox, Sherpa, MLX)
│   │   ├── db.rs              # Embedded SQLite database schema & migrations
│   │   ├── llm.rs             # LLM minutes summarization engine
│   │   └── lib.rs             # Tauri application setup and lifecycle hooks
│   ├── Cargo.toml             # Rust dependencies and platform configuration
│   └── tauri.conf.json        # Tauri window, updater, and bundle configuration
├── landing/                   # Product landing website
└── package.json               # Frontend dependencies and build scripts
```

---

## Development Setup

### Prerequisites
- Node.js 20+ and `pnpm`
- Rust 1.75+ (`rustup`)
- CMake and C++ build toolchain

### Running in Development

```bash
# Install frontend dependencies
pnpm install

# Run application in development mode
pnpm tauri dev
```

### Building Release Binaries

```bash
# macOS
pnpm tauri build -b dmg

# Windows
pnpm tauri build -b nsis

# Linux
pnpm tauri build
```

---

## Acknowledgments & Attributions

- **[Meetily](https://github.com/Zackriya-Solutions/meetily)**: UX patterns, audio capture architectures, and summarization prompt engineering inspiration.
- **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)**: On-device speech recognition runtime (Apache-2.0).
- **[hynt/Zipformer-30M-RNNT-6000h](https://huggingface.co/hynt/Zipformer-30M-RNNT-6000h)**: Offline Vietnamese speech recognition model (licensed under CC BY-NC-ND 4.0).
- **CAM++ / VoxCeleb**: Speaker recognition models for neural speaker diarization.

---

## License

This project is open-source under the [MIT License](LICENSE).
