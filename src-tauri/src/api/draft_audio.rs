//! Draft audio append — `PATCH /drafts/{id}/audio`.
//!
//! Port of `api/drafts.py::append_draft_audio`. The frontend streams recorded
//! chunks here as they are captured and PATCHes them onto the end of the
//! draft's audio file, so the file grows in place across a long recording.
//!
//! Two guards matter for correctness:
//!   - system-PCM archive: once the draft records system audio as raw PCM, a
//!     webm/m4a mic chunk must NOT be appended to that file (it would corrupt
//!     it); it goes to the `meeting_N_mic.<ext>` companion instead and is
//!     mixed in later — see `crate::audio_archive`.
//!   - `size_limit`: stop growing past 500 MB so a runaway recording cannot
//!     fill the disk.

use std::path::PathBuf;

use axum::{
    extract::{Multipart, Path, State},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use super::meetings::{internal_error, not_found};
use super::AppState;

/// Draft audio cap — 500 MB, same as Python.
const MAX_DRAFT_AUDIO_BYTES: u64 = 500 * 1024 * 1024;

/// `PATCH /drafts/{id}/audio` — append an uploaded chunk to the draft's file.
pub async fn append_draft_audio(
    State(state): State<AppState>,
    Path(draft_id): Path<i64>,
    mut multipart: Multipart,
) -> Response {
    let meeting = match state.db().get_meeting(draft_id) {
        Ok(Some(m)) => m,
        Ok(None) => return not_found("Draft not found"),
        Err(e) => return internal_error(&e),
    };

    // Pull the first part that carries a filename.
    let mut upload_ext = String::new();
    let mut payload: Vec<u8> = Vec::new();
    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                if let Some(name) = field.file_name().map(str::to_string) {
                    upload_ext = extension_of(&name);
                    match field.bytes().await {
                        Ok(b) => payload = b.to_vec(),
                        Err(e) => {
                            return (
                                axum::http::StatusCode::BAD_REQUEST,
                                Json(json!({ "error": format!("multipart read: {e}") })),
                            )
                                .into_response()
                        }
                    }
                    break;
                }
            }
            Ok(None) => break,
            Err(e) => {
                return (
                    axum::http::StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("multipart: {e}") })),
                )
                    .into_response()
            }
        }
    }
    // Python: `Path(audio.filename or "").suffix.lower() or ".webm"`.
    if upload_ext.is_empty() {
        upload_ext = ".webm".to_string();
    }

    if payload.is_empty() {
        return Json(json!({ "ok": true, "bytes": 0 })).into_response();
    }

    let existing_audio_path = meeting
        .get("audio_path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let target: PathBuf = if let Some(mic) =
        crate::audio_archive::mic_target_if_system(draft_id, &existing_audio_path, &upload_ext)
    {
        // "Both" mode: the meeting's audio is the system-PCM archive (or one
        // is starting). A compressed chunk can never be appended to raw PCM,
        // so the mic goes to its companion file and is mixed in after the
        // recording (`audio_archive::finalize_mix`). Python dropped it.
        mic
    } else if !existing_audio_path.is_empty() {
        PathBuf::from(&existing_audio_path)
    } else {
        let audio_dir = state.db().data_dir().join("audio");
        if let Err(e) = std::fs::create_dir_all(&audio_dir) {
            return internal_error(&format!("create audio dir: {e}"));
        }
        let p = audio_dir.join(format!("meeting_{draft_id}{upload_ext}"));
        let mut upd = serde_json::Map::new();
        upd.insert(
            "audio_path".to_string(),
            serde_json::Value::String(p.to_string_lossy().to_string()),
        );
        if let Err(e) = state.db().update_meeting(draft_id, &upd) {
            return internal_error(&e);
        }
        p
    };

    if let Some(parent) = target.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return internal_error(&format!("create parent dir: {e}"));
        }
    }

    if let Ok(meta) = std::fs::metadata(&target) {
        if meta.len() >= MAX_DRAFT_AUDIO_BYTES {
            return Json(json!({ "ok": true, "bytes": 0, "skipped": "size_limit" })).into_response();
        }
    }

    // Append. Opened with `append(true)` + create so a first chunk works too.
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
    {
        Ok(mut f) => {
            use std::io::Write;
            if let Err(e) = f.write_all(&payload) {
                return internal_error(&format!("append audio: {e}"));
            }
        }
        Err(e) => return internal_error(&format!("open audio for append: {e}")),
    }

    Json(json!({
        "ok": true,
        "bytes": payload.len(),
        "audioPath": target.to_string_lossy(),
    }))
    .into_response()
}

/// Lowercase extension INCLUDING the dot, or "" when there is none.
fn extension_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if !name[i..].contains(['/', '\\']) => name[i..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_extraction_matches_pathlib_suffix() {
        assert_eq!(extension_of("chunk.webm"), ".webm");
        assert_eq!(extension_of("chunk.WEBM"), ".webm");
        assert_eq!(extension_of("/tmp/a/b.m4a"), ".m4a");
        assert_eq!(extension_of("noext"), "");
    }
}
