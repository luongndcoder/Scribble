# Cross-Platform Rules — Windows + macOS + Linux

> Quy tắc bắt buộc tuân thủ cho mọi code mới trong tính năng upload audio. Check trước khi mở PR.

## Áp dụng cho ai

- **Mọi file mới** trong: `src-python/api/upload.py`, `src-python/services/upload_pipeline.py`, `src-python/services/batch_diarizer.py`, `src-python/services/vad_splitter.py`, `src-tauri/src/upload.rs`, `src/components/upload/*`
- **Không áp dụng** cho file đã có (không sửa file cũ — xem [00-overview.md](./00-overview.md) D-rules)

## 1. Path handling

### Python
```python
# ✅ ĐÚNG — dùng pathlib
from pathlib import Path
audio_path = Path(data_dir) / "audio" / f"upload_{meeting_id}{ext}"
audio_path.parent.mkdir(parents=True, exist_ok=True)
audio_path.write_bytes(payload)

# ❌ SAI — os.path.join trộn separator trên Windows
import os
audio_path = os.path.join(data_dir, "audio", f"upload_{meeting_id}{ext}")

# ❌ SAI — string concat
audio_path = data_dir + "/audio/" + f"upload_{meeting_id}{ext}"
```

### Rust
```rust
// ✅ ĐÚNG — PathBuf + push
use std::path::PathBuf;
let mut audio_path = PathBuf::from(&data_dir);
audio_path.push("audio");
audio_path.push(format!("upload_{}.{}", meeting_id, ext));

// ❌ SAI — format! với "/" hardcode
let audio_path = format!("{}/audio/upload_{}.{}", data_dir, meeting_id, ext);
```

## 2. Filename normalization

Tiếng Việt trên macOS lưu NFD (`o` + dấu mũ tách rời), trên Windows/Linux thường NFC (`ô` 1 ký tự). Database mix sẽ vỡ.

```python
# ✅ Bắt buộc tại upload entry point
import unicodedata
safe_name = unicodedata.normalize("NFC", original_filename)
# Sanitize ký tự nguy hiểm Windows (< > : " / \ | ? *)
safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", safe_name)
# Truncate ≤200 ký tự (Windows MAX_PATH 260, để chỗ cho parent dir)
if len(safe_name) > 200:
    stem, ext = os.path.splitext(safe_name)
    safe_name = stem[:200 - len(ext)] + ext
```

## 3. Subprocess (ffmpeg, ffprobe)

```python
import subprocess
import sys

# ✅ Windows: ẩn console window khi spawn subprocess
kwargs = {"capture_output": True, "timeout": 120}
if sys.platform == "win32":
    kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
result = subprocess.run([ffmpeg, ...], **kwargs)

# ✅ Encoding errors='replace' khi decode stderr (Windows hay latin-1)
stderr = result.stderr.decode("utf-8", errors="replace")
```

## 4. File I/O encoding

```python
# ✅ Luôn explicit utf-8
with open(path, "r", encoding="utf-8") as f:
    data = f.read()

# ❌ SAI — Windows default cp1252, sẽ vỡ với tiếng Việt
with open(path, "r") as f:
    data = f.read()
```

## 5. Storage directories

Đã có helper `_voicescribe_data_dir()`. Dùng nó, đừng hardcode:

```python
# ✅ ĐÚNG
from main import _voicescribe_data_dir
audio_dir = _voicescribe_data_dir() / "audio"

# ❌ SAI
audio_dir = Path.home() / ".scribble" / "audio"  # macOS sandbox sẽ fail
audio_dir = Path("/var/lib/scribble")            # Windows không có
```

Expected paths:
- macOS: `~/Library/Application Support/Scribble/audio/`
- Windows: `%APPDATA%\Scribble\audio\`
- Linux: `~/.local/share/scribble/audio/`

## 6. ffmpeg discovery

```python
# ✅ Dùng helper, không gọi "ffmpeg" trực tiếp
from services.audio import find_ffmpeg
ffmpeg = find_ffmpeg()  # raises FileNotFoundError với guide cài đặt
result = subprocess.run([ffmpeg, "-i", input_path, ...], **kwargs)

# ❌ SAI — fail trên Windows nếu không có trong PATH
result = subprocess.run(["ffmpeg", "-i", input_path], ...)
```

## 7. Tauri Rust commands

```rust
// ✅ Conditional compile chỉ khi cần (Windows kill stale PID, macOS launchd, etc.)
#[cfg(target_os = "windows")]
fn kill_stale_sidecar() { ... }

#[cfg(not(target_os = "windows"))]
fn kill_stale_sidecar() { ... }

// ✅ Async file I/O với tokio
use tokio::fs::File;
use tokio::io::{AsyncReadExt, BufReader};
let file = File::open(&path).await?;
let mut reader = BufReader::with_capacity(4 * 1024 * 1024, file);  // 4MB buffer

// ✅ reqwest multipart streaming (không load file vào RAM)
use reqwest::Body;
use tokio_util::io::ReaderStream;
let stream = ReaderStream::new(file);
let body = Body::wrap_stream(stream);
let form = reqwest::multipart::Form::new()
    .part("audio", reqwest::multipart::Part::stream(body).file_name(filename));
```

## 8. CSP (tauri.conf.json)

Sidecar HTTP đã được whitelist trong [tauri.conf.json:25](../../src-tauri/tauri.conf.json:25):
```
connect-src 'self' http://localhost:8765 http://127.0.0.1:8765 ws://localhost:8765 ws://127.0.0.1:8765
```

**Không cần đổi**. Rust→sidecar HTTP không qua webview CSP. Frontend chỉ gọi Tauri command, không gọi sidecar trực tiếp cho upload.

## 9. Tauri capabilities

Phải thêm vào [capabilities/default.json](../../src-tauri/capabilities/default.json):

```json
{
  "permissions": [
    "...existing...",
    "dialog:allow-open",
    "dialog:default"
  ]
}
```

Và trong [Cargo.toml](../../src-tauri/Cargo.toml):
```toml
tauri-plugin-dialog = "2"
tokio = { version = "1", features = ["rt", "time", "macros", "fs", "io-util"] }
tokio-util = { version = "0.7", features = ["io"] }
```

## 10. CORS (sidecar)

Sidecar đã cho phép `tauri://localhost` + `http://tauri.localhost` (Windows). Upload endpoint nằm cùng FastAPI app → tự động kế thừa CORS. **Không cần config thêm**.

## 11. Subprocess flags cho Windows (sidecar lifecycle)

Khi Rust spawn sidecar, đảm bảo:
```rust
#[cfg(target_os = "windows")]
{
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
}
```

Đã có trong `start_sidecar` hiện tại — verify Phase 1.5 không phá pattern này.

## 12. File picker dialog UX

```rust
// ✅ Dùng tauri-plugin-dialog, không tự gọi native API
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
async fn pick_audio_file(app: AppHandle) -> Option<PathBuf> {
    app.dialog()
        .file()
        .add_filter("Audio/Video", &["mp3", "wav", "m4a", "webm", "ogg", "flac", "mp4", "mov", "aac", "wma"])
        .blocking_pick_file()
        .map(|fp| fp.into_path().ok())
        .flatten()
}
```

Tauri plugin tự xử lý native dialog cho từng OS (Cocoa, WinUI, GTK).

## 13. Test matrix BẮT BUỘC trước mỗi release

Không được merge nếu thiếu kết quả từ bất kỳ ô nào.

| Test case | macOS arm64 | Windows x64 | Ubuntu 22.04 |
|-----------|:-----------:|:-----------:|:------------:|
| Upload mp3 5 phút → minutes | ☐ | ☐ | ☐ |
| Upload mp4 30 phút (video extract) | ☐ | ☐ | ☐ |
| Upload file 1GB+ (stress) | ☐ | ☐ | ☐ |
| Filename tiếng Việt có dấu | ☐ | ☐ | ☐ |
| Cancel job giữa chừng | ☐ | ☐ | ☐ |
| Quit app khi job đang chạy → mở lại | ☐ | ☐ | ☐ |
| Format đặc thù (m4a / wma / opus) | m4a | mp3 | opus |
| Duplicate upload → idempotency dialog | ☐ | ☐ | ☐ |
| Recording realtime vẫn OK (regression) | ☐ | ☐ | ☐ |

Mỗi cell verify: upload xong, transcript đúng, speaker đúng, summarize OK, file phát lại được trong meeting detail.

## 14. CI/CD usage

Sau mỗi phase, trigger build cross-platform để smoke test:

```bash
# Windows
gh workflow run build.yml --ref claude/gracious-ishizaka-d8f436

# Linux
gh workflow run build-linux.yml --ref claude/gracious-ishizaka-d8f436

# Đợi xong, tải artifact, install thử trong VM
```

## 15. Checklist trước khi mở PR

- [ ] Đã `unicodedata.normalize("NFC", ...)` cho mọi filename từ user
- [ ] Đã dùng `pathlib.Path` / `PathBuf`, không string concat
- [ ] Subprocess Python có `CREATE_NO_WINDOW` trên Windows
- [ ] File open có `encoding="utf-8"` explicit
- [ ] Không gọi `ffmpeg` trực tiếp, qua `find_ffmpeg()`
- [ ] Test matrix cross-platform: ít nhất 1 OS đã test smoke path
- [ ] Regression checklist ([02](./02-regression-checklist.md)) đã pass trên dev machine
- [ ] CI Windows + Linux build green (trigger workflow_dispatch)
