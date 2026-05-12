// Upload audio bridge — native file picker + streaming POST to sidecar.
//
// Why Rust streams the file (not the webview):
//   - WebKitGTK on Linux OOMs at ~500MB+ FormData. Tauri's <input type="file">
//     would also need to read the whole file into JS heap → unacceptable for
//     2GB files.
//   - reqwest streams the file from disk in 4MB chunks; memory stays flat.
//   - Tauri events report bytes_sent progress to the frontend so the UI can
//     show a real progress bar during the upload phase (before sidecar's SSE
//     takes over for the pipeline phase).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

const SIDECAR_BASE: &str = "http://127.0.0.1:8765";
const UPLOAD_PROGRESS_EVENT: &str = "upload-audio-progress";
const UPLOAD_CHUNK_BYTES: usize = 4 * 1024 * 1024; // 4MB
const UPLOAD_TIMEOUT_SECS: u64 = 60 * 60; // 1h for huge files on slow disks

const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "wav", "m4a", "webm", "ogg", "oga", "flac", "aac", "opus", "wma",
];
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "mkv"];

#[derive(Default)]
pub struct UploadState {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl UploadState {
    pub fn new() -> Self {
        Self::default()
    }

    fn register(&self, upload_id: &str, flag: Arc<AtomicBool>) {
        if let Ok(mut guard) = self.cancels.lock() {
            guard.insert(upload_id.to_string(), flag);
        }
    }

    fn unregister(&self, upload_id: &str) {
        if let Ok(mut guard) = self.cancels.lock() {
            guard.remove(upload_id);
        }
    }

    fn signal_cancel(&self, upload_id: &str) -> bool {
        if let Ok(guard) = self.cancels.lock() {
            if let Some(flag) = guard.get(upload_id) {
                flag.store(true, Ordering::SeqCst);
                return true;
            }
        }
        false
    }
}

#[derive(Serialize, Clone)]
struct UploadProgressPayload {
    upload_id: String,
    bytes_sent: u64,
    total_bytes: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UploadResult {
    pub upload_id: String,
    pub job_id: String,
    pub meeting_id: i64,
}

#[derive(Deserialize, Debug)]
pub struct SidecarUploadResponse {
    pub job_id: String,
    pub meeting_id: i64,
}

// ─── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn pick_audio_file(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut all_ext: Vec<&str> = AUDIO_EXTENSIONS.to_vec();
    all_ext.extend_from_slice(VIDEO_EXTENSIONS);

    app.dialog()
        .file()
        .add_filter("Audio / Video", &all_ext)
        .add_filter("Audio only", AUDIO_EXTENSIONS)
        .add_filter("Video only", VIDEO_EXTENSIONS)
        .pick_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    let picked = rx
        .await
        .map_err(|e| format!("Dialog channel closed: {e}"))?;

    Ok(picked.and_then(|fp| {
        // Tauri 2 FilePath: on desktop this is always a real path.
        fp.into_path()
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }))
}

#[tauri::command]
pub async fn upload_audio_to_sidecar(
    app: AppHandle,
    file_path: String,
    title: Option<String>,
    language: Option<String>,
    state: State<'_, UploadState>,
) -> Result<UploadResult, String> {
    let upload_id = uuid::Uuid::new_v4().simple().to_string();
    let cancel_flag = Arc::new(AtomicBool::new(false));
    state.register(&upload_id, cancel_flag.clone());

    let result = do_upload(
        app.clone(),
        upload_id.clone(),
        file_path,
        title,
        language,
        cancel_flag,
    )
    .await;

    state.unregister(&upload_id);
    result
}

#[tauri::command]
pub fn cancel_audio_upload(
    upload_id: String,
    state: State<'_, UploadState>,
) -> Result<bool, String> {
    Ok(state.signal_cancel(&upload_id))
}

// ─── Internals ──────────────────────────────────────────────────────────────

async fn do_upload(
    app: AppHandle,
    upload_id: String,
    file_path: String,
    title: Option<String>,
    language: Option<String>,
    cancel_flag: Arc<AtomicBool>,
) -> Result<UploadResult, String> {
    let app_for_progress = app.clone();
    let upload_id_for_progress = upload_id.clone();
    let on_progress = move |bytes_sent: u64, total_bytes: u64| {
        let _ = app_for_progress.emit(
            UPLOAD_PROGRESS_EVENT,
            UploadProgressPayload {
                upload_id: upload_id_for_progress.clone(),
                bytes_sent,
                total_bytes,
            },
        );
    };

    let url = format!("{SIDECAR_BASE}/meetings/upload-audio");
    let parsed = stream_upload_to_url(
        &url,
        Path::new(&file_path),
        title.as_deref(),
        language.as_deref().unwrap_or("vi"),
        cancel_flag,
        on_progress,
    )
    .await?;

    Ok(UploadResult {
        upload_id,
        job_id: parsed.job_id,
        meeting_id: parsed.meeting_id,
    })
}

/// Stream a local file via multipart POST. Pure async — no AppHandle/Tauri deps,
/// callable from integration tests against a mock HTTP server.
pub async fn stream_upload_to_url(
    url: &str,
    file_path: &Path,
    title: Option<&str>,
    language: &str,
    cancel_flag: Arc<AtomicBool>,
    on_progress: impl Fn(u64, u64) + Send + Sync + 'static,
) -> Result<SidecarUploadResponse, String> {
    if !file_path.is_file() {
        return Err(format!(
            "File does not exist or is not a file: {}",
            file_path.display()
        ));
    }

    let metadata = tokio::fs::metadata(file_path)
        .await
        .map_err(|e| format!("Stat file: {e}"))?;
    let total_bytes = metadata.len();
    if total_bytes == 0 {
        return Err("File is empty".to_string());
    }

    let file_name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "upload.bin".to_string());
    let mime = guess_mime(file_path);

    let file = File::open(file_path)
        .await
        .map_err(|e| format!("Open file: {e}"))?;
    let reader_stream = ReaderStream::with_capacity(file, UPLOAD_CHUNK_BYTES);

    let cancel_for_stream = cancel_flag.clone();
    let mut bytes_sent: u64 = 0;

    let progress_stream = reader_stream.map(move |result| {
        if cancel_for_stream.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "Upload cancelled by user",
            ));
        }
        if let Ok(ref bytes) = result {
            bytes_sent += bytes.len() as u64;
            on_progress(bytes_sent, total_bytes);
        }
        result
    });

    let body = reqwest::Body::wrap_stream(progress_stream);
    let part = reqwest::multipart::Part::stream_with_length(body, total_bytes)
        .file_name(file_name)
        .mime_str(&mime)
        .map_err(|e| format!("Invalid mime '{mime}': {e}"))?;

    let mut form = reqwest::multipart::Form::new().part("audio", part);
    if let Some(t) = title {
        let trimmed = t.trim();
        if !trimmed.is_empty() {
            form = form.text("title", trimmed.to_string());
        }
    }
    form = form.text("language", language.to_string());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(UPLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    let resp = client.post(url).multipart(form).send().await.map_err(|e| {
        if cancel_flag.load(Ordering::SeqCst) {
            "Upload cancelled".to_string()
        } else {
            format!("Upload request failed: {e}")
        }
    })?;

    let status = resp.status();
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("Read response body: {e}"))?;

    if !status.is_success() {
        return Err(format!("Sidecar HTTP {status}: {body_text}"));
    }

    serde_json::from_str(&body_text)
        .map_err(|e| format!("Parse sidecar response ({e}): {body_text}"))
}

fn guess_mime(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());
    match ext.as_deref() {
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("m4a") | Some("aac") => "audio/mp4",
        Some("webm") => "audio/webm",
        Some("ogg") | Some("oga") => "audio/ogg",
        Some("opus") => "audio/opus",
        Some("flac") => "audio/flac",
        Some("wma") => "audio/x-ms-wma",
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("mkv") => "video/x-matroska",
        _ => "application/octet-stream",
    }
    .to_string()
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn mime_known_audio() {
        assert_eq!(guess_mime(Path::new("a.mp3")), "audio/mpeg");
        assert_eq!(guess_mime(Path::new("a.WAV")), "audio/wav");
        assert_eq!(guess_mime(Path::new("a.m4a")), "audio/mp4");
        assert_eq!(guess_mime(Path::new("a.opus")), "audio/opus");
        assert_eq!(guess_mime(Path::new("a.mp4")), "video/mp4");
    }

    #[test]
    fn mime_unknown_falls_back() {
        assert_eq!(guess_mime(Path::new("a.xyz")), "application/octet-stream");
        assert_eq!(guess_mime(Path::new("noext")), "application/octet-stream");
    }

    #[test]
    fn state_register_unregister_cancel() {
        let state = UploadState::new();
        let flag = Arc::new(AtomicBool::new(false));
        state.register("u1", flag.clone());

        assert!(state.signal_cancel("u1"), "should find and signal");
        assert!(flag.load(Ordering::SeqCst), "flag should be set");

        state.unregister("u1");
        assert!(!state.signal_cancel("u1"), "after unregister, no longer findable");
    }

    #[test]
    fn signal_cancel_unknown_returns_false() {
        let state = UploadState::new();
        assert!(!state.signal_cancel("does-not-exist"));
    }
}
