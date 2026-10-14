//! Meeting audio + minutes export routes.
//!
//! Port of the export half of `src-python/api/meetings.py`:
//!   GET /meetings/{id}/minutes        — markdown or docx minutes download
//!   GET /meetings/{id}/audio          — audio download, transcoded to the
//!                                       requested container
//!   GET /meetings/{id}/audio/stream   — in-app playback with Range support
//!
//! The CRUD half lives in `api/meetings.rs`.
//!
//! Why Range matters: the player is an `<audio>` element. Without
//! `206 Partial Content` + `Accept-Ranges` the webview cannot seek and has to
//! buffer the whole file before playback starts, which on a long meeting looks
//! like a hang.

use std::path::{Path, PathBuf};

use axum::{
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::meetings::not_found;
use super::transcription::{audio_media_type, header_value, parse_range, resolve_audio_source};
use super::AppState;

/// `GET /meetings/{id}/minutes?format=md|docx`
pub async fn download_minutes(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let meeting = match state.db().get_meeting(id) {
        Ok(Some(m)) => m,
        Ok(None) => return not_found("Not found"),
        Err(e) => return super::meetings::internal_error(&e),
    };

    let summary = meeting
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if summary.is_empty() {
        return not_found("Minutes not found");
    }

    let language = meeting
        .get("language")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("vi");
    let markdown = normalize_minutes_markdown(&summary, language);
    if markdown.is_empty() {
        return not_found("Minutes not found");
    }

    let format = q
        .get("format")
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "md".to_string());
    if format != "md" && format != "docx" {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "format must be md or docx" })),
        )
            .into_response();
    }

    let raw_title = meeting
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("meeting-{id}"));
    // Python stripped the characters Windows/OS file dialogs reject.
    let safe_title: String = raw_title
        .trim()
        .chars()
        .filter(|c| !"\\/:*?\"<>|".contains(*c))
        .collect();
    let safe_title = if safe_title.trim().is_empty() {
        format!("meeting-{id}")
    } else {
        safe_title.trim().to_string()
    };

    if format == "md" {
        let filename = format!("{safe_title}-minutes.md");
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/markdown; charset=utf-8")
            .header(
                header::CONTENT_DISPOSITION,
                header_value(&format!("attachment; filename=\"{filename}\"")),
            )
            .body(Body::from(markdown.into_bytes()))
            .unwrap();
    }

    // DOCX export. Python used python-docx; there is no Rust docx writer in
    // this crate, so `write_minutes_docx` builds the minimal OOXML package by
    // hand (see the module comment there for the scope of what it emits).
    match super::docx::render_docx(&markdown) {
        Ok(bytes) => {
            let filename = format!("{safe_title}-minutes.docx");
            Response::builder()
                .status(StatusCode::OK)
                .header(
                    header::CONTENT_TYPE,
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
                .header(
                    header::CONTENT_DISPOSITION,
                    header_value(&format!("attachment; filename=\"{filename}\"")),
                )
                .body(Body::from(bytes))
                .unwrap()
        }
        Err(e) => {
            log::error!("[meetings] DOCX export failed: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({ "error": "minutes export failed" })),
            )
                .into_response()
        }
    }
}

/// `GET /meetings/{id}/audio/stream` — playback with HTTP Range support.
///
/// Web-playable containers are streamed directly. Raw PCM has no container, so
/// it is wrapped into a cached WAV once (the Python version used the stdlib
/// `wave` module to avoid needing ffmpeg; this port writes the 44-byte RIFF
/// header itself, which is the same thing).
pub async fn stream_audio(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<i64>,
    headers: HeaderMap,
) -> Response {
    // System + mic of a finished "both" recording → one mixed file.
    crate::audio_archive::finalize_mix(id).await;
    let source = match resolve_audio_source(&state, id) {
        Ok(Some(p)) => p,
        Ok(None) => return not_found("Audio not found"),
        Err(e) => return super::meetings::internal_error(&e),
    };

    let ext = source
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    if ext == "pcm" {
        let cache_dir = state.db().data_dir().join("audio").join("cache");
        if let Err(e) = tokio::fs::create_dir_all(&cache_dir).await {
            log::warn!("[meetings] could not create audio cache dir: {e}");
        }
        let wav_path = cache_dir.join(format!("play_{id}.wav"));
        let stale = match (tokio::fs::metadata(&wav_path).await, tokio::fs::metadata(&source).await)
        {
            (Ok(w), Ok(s)) => match (w.modified(), s.modified()) {
                (Ok(wm), Ok(sm)) => wm < sm,
                _ => true,
            },
            _ => true,
        };
        if stale {
            if let Err(e) = pcm_to_wav(&source, &wav_path).await {
                log::warn!("[meetings] stream pcm->wav failed: {e}");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(json!({ "error": "Cannot prepare audio" })),
                )
                    .into_response();
            }
        }
        return serve_file(&wav_path, "audio/wav", &headers, None).await;
    }

    let media = audio_media_type(&format!(".{ext}"));
    serve_file(&source, media, &headers, None).await
}

/// `GET /meetings/{id}/audio?format=wav|mp3|mp4` — download/export.
///
/// Transcodes with ffmpeg when the stored container differs from the requested
/// one. If ffmpeg is unavailable the Python code refused to serve bytes under a
/// mismatched extension (an `.mp3` the OS player rejects) and fell back to the
/// TRUE extension — that behaviour is preserved here.
pub async fn download_audio(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<i64>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Response {
    crate::audio_archive::finalize_mix(id).await;
    let source = match resolve_audio_source(&state, id) {
        Ok(Some(p)) => p,
        Ok(None) => return not_found("Audio not found"),
        Err(e) => return super::meetings::internal_error(&e),
    };

    let export_format = q
        .get("format")
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "mp3".to_string());
    if !matches!(export_format.as_str(), "wav" | "mp3" | "mp4") {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "format must be wav, mp3, or mp4" })),
        )
            .into_response();
    }

    let source_ext = source
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let mut actual_ext = source_ext.clone();
    let mut export_path = source.clone();
    let mut temp_cleanup: Option<PathBuf> = None;

    if source_ext != export_format {
        if source_ext == "pcm" && export_format == "wav" {
            // Fast path with no ffmpeg: wrap PCM16 in a WAV container.
            match temp_wav_path(id) {
                Ok(tmp) => match pcm_to_wav(&source, &tmp).await {
                    Ok(()) => {
                        export_path = tmp.clone();
                        actual_ext = "wav".to_string();
                        temp_cleanup = Some(tmp);
                    }
                    Err(e) => log::warn!("[meetings] PCM to WAV failed, serving original: {e}"),
                },
                Err(e) => log::warn!("[meetings] PCM to WAV temp file failed: {e}"),
            }
        } else {
            match transcode_for_export(&source, &export_format).await {
                Ok(tmp) => {
                    export_path = tmp.clone();
                    actual_ext = export_format.clone();
                    temp_cleanup = Some(tmp);
                }
                Err(e) => {
                    log::warn!(
                        "[meetings] Transcode to {export_format} failed ({e}); using safe fallback"
                    );
                    if source_ext == "pcm" {
                        if let Ok(tmp) = temp_wav_path(id) {
                            if pcm_to_wav(&source, &tmp).await.is_ok() {
                                export_path = tmp.clone();
                                actual_ext = "wav".to_string();
                                temp_cleanup = Some(tmp);
                            }
                        }
                    }
                }
            }
        }
    }

    let media = audio_media_type(&format!(".{actual_ext}"));
    let filename = format!("meeting_{id}.{actual_ext}");
    let response = serve_file(&export_path, media, &HeaderMap::new(), Some(&filename)).await;

    // Python cleaned the temp file up in a BackgroundTask after the response
    // finished. Delay the unlink until the body has been read out.
    if let Some(tmp) = temp_cleanup {
        tokio::spawn(async move {
            // A short grace period is enough for the local write to finish;
            // download speed is not latency-critical here.
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let _ = tokio::fs::remove_file(&tmp).await;
        });
    }
    response
}

/// Serve a file, honouring a `Range` header.
///
/// `Accept-Ranges: bytes` is always advertised so the webview's player knows it
/// may seek. A range request answers `206` with `Content-Range`; an
/// unsatisfiable one answers `416`; anything else gets the whole file.
async fn serve_file(
    path: &Path,
    media_type: &str,
    req_headers: &HeaderMap,
    download_name: Option<&str>,
) -> Response {
    let meta = match tokio::fs::metadata(path).await {
        Ok(m) => m,
        Err(e) => {
            log::warn!("[meetings] stat {} failed: {e}", path.display());
            return not_found("Audio not found");
        }
    };
    let len = meta.len();
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) => {
            log::warn!("[meetings] open {} failed: {e}", path.display());
            return not_found("Audio not found");
        }
    };

    // Builds the response head for a byte range. Kept as a closure so the 200,
    // 206 and 416 paths cannot drift apart in their headers.
    let head = |status: StatusCode, start: u64, end: u64| -> axum::http::response::Builder {
        let mut b = Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, media_type)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, (end - start + 1).to_string());
        if status == StatusCode::PARTIAL_CONTENT {
            b = b.header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{len}"),
            );
        }
        if let Some(name) = download_name {
            b = b.header(
                header::CONTENT_DISPOSITION,
                header_value(&format!("attachment; filename=\"{name}\"")),
            );
        }
        b
    };

    match parse_range(req_headers, len) {
        Some(Ok((start, end))) => {
            if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
                return not_found("Audio not found");
            }
            let stream = tokio_util::io::ReaderStream::new(file.take(end - start + 1));
            head(StatusCode::PARTIAL_CONTENT, start, end)
                .body(Body::from_stream(stream))
                .unwrap_or_else(|_| not_found("Audio not found"))
        }
        Some(Err(())) => Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{len}"))
            .header(header::ACCEPT_RANGES, "bytes")
            .body(Body::empty())
            .unwrap(),
        None => {
            let stream = tokio_util::io::ReaderStream::new(file);
            head(StatusCode::OK, 0, len.saturating_sub(1))
                .body(Body::from_stream(stream))
                .unwrap_or_else(|_| not_found("Audio not found"))
        }
    }
}

/// Wrap raw PCM16 (16 kHz mono) into a WAV container.
///
/// Equivalent to Python's `wave.open(...).setnchannels(1).setsampwidth(2)
/// .setframerate(16000).writeframes(pcm)`.
async fn pcm_to_wav(source: &Path, dest: &Path) -> Result<(), String> {
    let pcm = tokio::fs::read(source)
        .await
        .map_err(|e| format!("read pcm: {e}"))?;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(&wav_header(pcm.len() as u32));
    out.extend_from_slice(&pcm);
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir: {e}"))?;
    }
    tokio::fs::write(dest, out)
        .await
        .map_err(|e| format!("write wav: {e}"))?;
    Ok(())
}

/// Canonical 44-byte RIFF/WAVE header for mono 16-bit 16 kHz PCM.
fn wav_header(data_len: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    let byte_rate: u32 = 16000 * 1 * 2;
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // format = PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // channels
    h[24..28].copy_from_slice(&16000u32.to_le_bytes()); // sample rate
    h[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    h[32..34].copy_from_slice(&2u16.to_le_bytes()); // block align
    h[34..36].copy_from_slice(&16u16.to_le_bytes()); // bits per sample
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}

fn temp_wav_path(id: i64) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir();
    Ok(dir.join(format!("voicescribe_pcm_{id}_{}.wav", std::process::id())))
}

/// Transcode with ffmpeg, mirroring `services/audio.py::transcode_audio_for_export`.
pub(crate) async fn transcode_for_export(source: &Path, fmt: &str) -> Result<PathBuf, String> {
    let ffmpeg = find_ffmpeg()?;
    let tmp = std::env::temp_dir().join(format!(
        "voicescribe_export_{}_{}.{fmt}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));

    let mut cmd = tokio::process::Command::new(ffmpeg);
    cmd.arg("-y");
    if source
        .extension()
        .map(|e| e.eq_ignore_ascii_case("pcm"))
        .unwrap_or(false)
    {
        cmd.args(["-f", "s16le", "-ar", "16000", "-ac", "1"]);
    }
    cmd.arg("-i").arg(source);
    cmd.arg("-vn");
    match fmt {
        "wav" => {
            cmd.args(["-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1"]);
        }
        "mp3" => {
            // 96 kbps mono ≈ 43 MB/hour vs ~115 MB/hour for WAV, at good
            // speech quality.
            cmd.args(["-acodec", "libmp3lame", "-b:a", "96k", "-ar", "16000", "-ac", "1"]);
        }
        _ => {
            cmd.args(["-acodec", "aac", "-b:a", "192k"]);
        }
    }
    cmd.arg(&tmp);

    let out = match tokio::time::timeout(std::time::Duration::from_secs(120), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("ffmpeg spawn: {e}")),
        Err(_) => return Err("ffmpeg timed out after 120s".to_string()),
    };
    if !out.status.success() {
        let _ = tokio::fs::remove_file(&tmp).await;
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(stderr.chars().take(300).collect());
    }
    Ok(tmp)
}

/// Resolve an ffmpeg binary: the bundled sidecar first, then PATH, then the
/// common per-OS locations (dev machines).
///
/// The app ships a static ffmpeg as the Tauri sidecar `scribble-ffmpeg`
/// (`scripts/fetch-build-deps.sh`), which Tauri places next to the main
/// executable. User machines usually have no ffmpeg, and a Tauri-launched app
/// inherits a stripped PATH that excludes /opt/homebrew/bin anyway.
pub(crate) fn find_ffmpeg() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("FFMPEG_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
    }
    let sidecar = if cfg!(windows) { "scribble-ffmpeg.exe" } else { "scribble-ffmpeg" };
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(PathBuf::from)) {
        let p = dir.join(sidecar);
        if p.is_file() {
            return Ok(p);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    let fallbacks: &[&str] = if cfg!(windows) {
        &[]
    } else {
        &["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]
    };
    for c in fallbacks {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err("ffmpeg binary not found".to_string())
}

// ─── Minutes normalisation (port of services/minutes.py) ───

/// Strip a ``` fence and parse the legacy JSON minutes payload, if present.
fn parse_legacy_minutes_payload(raw: &str) -> Option<serde_json::Value> {
    let mut text = raw.trim().to_string();
    if text.is_empty() {
        return None;
    }
    if text.starts_with("```") {
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() >= 2 && lines[0].starts_with("```") && lines[lines.len() - 1].trim() == "```" {
            text = lines[1..lines.len() - 1].join("\n").trim().to_string();
        }
    }
    if !(text.starts_with('{') && text.ends_with('}')) {
        return None;
    }
    let data: serde_json::Value = serde_json::from_str(&text).ok()?;
    let obj = data.as_object()?;
    const KEYS: [&str; 6] = [
        "title",
        "attendees",
        "keyPoints",
        "decisions",
        "actionItems",
        "summary",
    ];
    if !KEYS.iter().any(|k| obj.contains_key(*k)) {
        return None;
    }
    Some(data)
}

/// Convert a legacy minutes JSON payload to Markdown (`legacy_minutes_to_markdown`).
fn legacy_minutes_to_markdown(data: &serde_json::Value, lang: &str) -> String {
    let vi = lang == "vi";
    let obj = match data.as_object() {
        Some(o) => o,
        None => return String::new(),
    };
    let str_list = |key: &str| -> Vec<String> {
        obj.get(key)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };

    let title = obj
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if vi { "Biên bản cuộc họp".to_string() } else { "Meeting Minutes".to_string() }
        });

    let attendees = str_list("attendees");
    let key_points = str_list("keyPoints");
    let decisions = str_list("decisions");
    let summary = obj
        .get("summary")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    struct ActionRow {
        task: String,
        assignee: String,
        deadline: String,
    }
    let mut action_rows: Vec<ActionRow> = Vec::new();
    if let Some(items) = obj.get("actionItems").and_then(|v| v.as_array()) {
        for item in items {
            let Some(o) = item.as_object() else { continue };
            let task = o
                .get("task")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            if task.is_empty() {
                continue;
            }
            action_rows.push(ActionRow {
                task,
                assignee: o
                    .get("assignee")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                deadline: o
                    .get("deadline")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
            });
        }
    }

    let missing = if vi { "Chưa có dữ liệu" } else { "Missing data" };
    let unknown = if vi { "Chưa rõ" } else { "TBD" };
    let bullet_block = |items: &[String]| -> String {
        if items.is_empty() {
            format!("- {missing}")
        } else {
            items.iter().map(|x| format!("- {x}")).collect::<Vec<_>>().join("\n")
        }
    };

    let mut blocks = vec![
        format!("# {title}"),
        format!(
            "## {}\n{}",
            if vi { "Thành phần tham gia" } else { "Attendees" },
            bullet_block(&attendees)
        ),
        format!(
            "## {}\n{}",
            if vi { "Nội dung trao đổi chính" } else { "Key Discussion" },
            bullet_block(&key_points)
        ),
        format!(
            "## {}\n{}",
            if vi { "Quyết định quan trọng" } else { "Key Decisions" },
            bullet_block(&decisions)
        ),
    ];

    let action_header = if vi {
        "Action items (What - Who - When)"
    } else {
        "Action Items (What - Who - When)"
    };
    if action_rows.is_empty() {
        blocks.push(format!("## {action_header}\n- {missing}"));
    } else {
        let lines: Vec<String> = action_rows
            .iter()
            .enumerate()
            .map(|(i, row)| {
                format!(
                    "{}. **What:** {}\n   **Who:** {}\n   **When:** {}",
                    i + 1,
                    row.task,
                    if row.assignee.is_empty() { unknown } else { &row.assignee },
                    if row.deadline.is_empty() { unknown } else { &row.deadline }
                )
            })
            .collect();
        blocks.push(format!("## {action_header}\n{}", lines.join("\n")));
    }

    if !summary.is_empty() {
        blocks.push(format!(
            "## {}\n{summary}",
            if vi { "Tóm tắt" } else { "Summary" }
        ));
    }

    blocks.join("\n\n").trim().to_string()
}

/// `normalize_minutes_markdown` — handles both Markdown and legacy JSON.
pub(crate) fn normalize_minutes_markdown(raw: &str, lang: &str) -> String {
    let text = raw.trim();
    if text.is_empty() {
        return String::new();
    }
    match parse_legacy_minutes_payload(text) {
        Some(legacy) => legacy_minutes_to_markdown(&legacy, lang),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_markdown_passes_through() {
        assert_eq!(normalize_minutes_markdown("Hello **world**", "vi"), "Hello **world**");
    }

    #[test]
    fn empty_stays_empty() {
        assert_eq!(normalize_minutes_markdown("   ", "vi"), "");
    }

    /// A fenced legacy payload is unwrapped and rendered into headings.
    #[test]
    fn fenced_legacy_payload_becomes_markdown() {
        let raw = "```\n{\"title\":\"Họp tuần\",\"attendees\":[\"An\"],\"decisions\":[\"Chốt A\"]}\n```";
        let md = normalize_minutes_markdown(raw, "vi");
        assert!(md.starts_with("# Họp tuần"), "got: {md}");
        assert!(md.contains("## Thành phần tham gia\n- An"));
        assert!(md.contains("## Quyết định quan trọng\n- Chốt A"));
        // Missing sections are filled with the Vietnamese placeholder.
        assert!(md.contains("Chưa có dữ liệu"));
    }

    /// JSON that lacks every known key is NOT treated as legacy minutes.
    #[test]
    fn unrelated_json_is_not_legacy_minutes() {
        let raw = r#"{"foo":"bar"}"#;
        assert_eq!(normalize_minutes_markdown(raw, "vi"), raw);
    }

    #[test]
    fn legacy_action_items_render_what_who_when() {
        let raw = r#"{"title":"T","actionItems":[{"task":"Ship API","assignee":"Bình","deadline":""}]}"#;
        let md = normalize_minutes_markdown(raw, "vi");
        assert!(md.contains("1. **What:** Ship API"));
        assert!(md.contains("**Who:** Bình"));
        // Missing deadline falls back to "Chưa rõ".
        assert!(md.contains("**When:** Chưa rõ"));
    }

    /// The RIFF header must be exactly what a WAV parser expects.
    #[test]
    fn wav_header_is_a_valid_riff_container() {
        let h = wav_header(1000);
        assert_eq!(&h[0..4], b"RIFF");
        assert_eq!(&h[8..12], b"WAVE");
        assert_eq!(&h[36..40], b"data");
        assert_eq!(u32::from_le_bytes([h[4], h[5], h[6], h[7]]), 36 + 1000);
        assert_eq!(u32::from_le_bytes([h[40], h[41], h[42], h[43]]), 1000);
        assert_eq!(u32::from_le_bytes([h[24], h[25], h[26], h[27]]), 16000);
        assert_eq!(u16::from_le_bytes([h[22], h[23]]), 1); // mono
        assert_eq!(u16::from_le_bytes([h[34], h[35]]), 16); // 16-bit
    }
}
