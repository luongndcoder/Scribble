//! Meeting attachments — reference materials (md/markdown/txt) for the summary.
//!
//! Port of `src-python/api/attachments.py`.
//!
//! Plain-text only. The content is stored in the DB and injected into the
//! summary prompt as "REFERENCE MATERIALS" so the minutes can use
//! project-specific terminology and cross-check what was discussed against
//! what was planned.
//!
//! Limits are deliberately the same as Python's:
//!   - 1 MB per file            — covers most specs and long PRDs
//!   - 2 MB per meeting total   — room for 2-3 large docs
//!   - 400 KB soft warn         — past this a 128k-context model may truncate
//!   - 10 files per meeting
//!   - `.md`, `.markdown`, `.txt`, UTF-8 only

use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use super::meetings::internal_error;
use super::AppState;

const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_BYTES_PER_MEETING: i64 = 2 * 1024 * 1024;
const WARN_TOTAL_BYTES: i64 = 400 * 1024;
const MAX_FILES_PER_MEETING: usize = 10;
const ALLOWED_EXTENSIONS: [&str; 3] = [".md", ".markdown", ".txt"];
/// Read cap a hair above the limit so the size check can fire instead of the
/// body being silently truncated.
const READ_CAP: usize = MAX_FILE_BYTES + 4096;

/// Debug-shaped error body. Python used FastAPI's `HTTPException(detail=...)`,
/// which renders as `{"detail": "..."}` — and the frontend's `readResponseError`
/// reads `.error` first, then falls back to `.detail`.
fn detail_error(status: StatusCode, detail: &str) -> Response {
    (status, Json(json!({ "detail": detail }))).into_response()
}

/// NFC-normalise, strip path components and cap length.
///
/// Mirrors `upload_storage.sanitize_filename` so audio and attachment uploads
/// behave identically. Path separators are dropped because a filename like
/// `../../etc/passwd` must never influence where anything is written.
fn sanitize_filename(name: Option<&str>) -> String {
    let base = name
        .unwrap_or("untitled")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("untitled")
        .trim();
    // Drop control characters; keep everything else.
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim();
    let out = if cleaned.is_empty() { "untitled" } else { cleaned };
    // Cap by characters (Python sliced the str, not the bytes).
    out.chars().take(200).collect()
}

fn validate_extension(name: &str) -> Result<String, String> {
    let ext = name
        .rfind('.')
        .map(|i| name[i..].to_ascii_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        let shown = if ext.is_empty() { "không có" } else { &ext };
        // Python built this with `', '.join(sorted(ALLOWED_EXTENSIONS))`, so
        // the list is ALPHABETICAL (".markdown, .md, .txt"), not declaration
        // order. The string is shown verbatim to the user, so the ordering is
        // part of the observable contract.
        let mut sorted = ALLOWED_EXTENSIONS;
        sorted.sort_unstable();
        return Err(format!(
            "Định dạng không hỗ trợ ({shown}). Chỉ chấp nhận: {}",
            sorted.join(", ")
        ));
    }
    Ok(ext)
}

/// `POST /meetings/{id}/attachments` — multipart upload of one text file.
pub async fn upload_attachment(
    State(state): State<AppState>,
    Path(meeting_id): Path<i64>,
    mut multipart: Multipart,
) -> Response {
    match state.db().get_meeting(meeting_id) {
        Ok(Some(_)) => {}
        Ok(None) => return detail_error(StatusCode::NOT_FOUND, "Meeting not found"),
        Err(e) => return internal_error(&e),
    }

    let existing = match state.db().list_attachments(meeting_id) {
        Ok(v) => v,
        Err(e) => return internal_error(&e),
    };
    if existing.len() >= MAX_FILES_PER_MEETING {
        return detail_error(
            StatusCode::CONFLICT,
            &format!("Đã đạt giới hạn {MAX_FILES_PER_MEETING} tài liệu cho mỗi cuộc họp"),
        );
    }

    // Locate the file part. Python's FastAPI field name was `file`; accept the
    // first part carrying a filename so a renamed field still works.
    let mut filename: Option<String> = None;
    let mut raw: Vec<u8> = Vec::new();
    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.file_name().map(str::to_string);
                if name.is_none() && filename.is_some() {
                    continue;
                }
                match field.bytes().await {
                    Ok(bytes) => {
                        if name.is_some() {
                            filename = name;
                        }
                        raw = bytes.to_vec();
                        if raw.len() > READ_CAP {
                            raw.truncate(READ_CAP);
                        }
                        break;
                    }
                    Err(e) => return detail_error(StatusCode::BAD_REQUEST, &format!("multipart read: {e}")),
                }
            }
            Ok(None) => break,
            Err(e) => return detail_error(StatusCode::BAD_REQUEST, &format!("multipart: {e}")),
        }
    }

    let safe_name = sanitize_filename(filename.as_deref());
    if let Err(msg) = validate_extension(&safe_name) {
        return detail_error(StatusCode::BAD_REQUEST, &msg);
    }

    if raw.len() > MAX_FILE_BYTES {
        return detail_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!("File quá lớn (giới hạn {} MB / file)", MAX_FILE_BYTES / (1024 * 1024)),
        );
    }

    let total_existing: i64 = existing
        .iter()
        .map(|a| a.get("size_bytes").and_then(|v| v.as_i64()).unwrap_or(0))
        .sum();
    if total_existing + raw.len() as i64 > MAX_TOTAL_BYTES_PER_MEETING {
        return detail_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!(
                "Tổng dung lượng tài liệu vượt giới hạn {} MB cho mỗi cuộc họp",
                MAX_TOTAL_BYTES_PER_MEETING / (1024 * 1024)
            ),
        );
    }

    // UTF-8 only. A BOM is tolerated; undecodable bytes mean the file was
    // mis-extensioned (e.g. a .docx renamed to .txt).
    let text = match String::from_utf8(raw.clone()) {
        Ok(t) => t,
        Err(_) => match String::from_utf8(strip_bom(&raw)) {
            Ok(t) => t,
            Err(_) => {
                return detail_error(
                    StatusCode::BAD_REQUEST,
                    "File không phải UTF-8. Vui lòng lưu lại dưới định dạng UTF-8.",
                )
            }
        },
    };

    if text.trim().is_empty() {
        return detail_error(StatusCode::BAD_REQUEST, "File rỗng");
    }

    let lower = safe_name.to_ascii_lowercase();
    let mime = if lower.ends_with(".md") || lower.ends_with(".markdown") {
        "text/markdown"
    } else {
        "text/plain"
    };

    match state
        .db()
        .add_attachment(meeting_id, &safe_name, mime, raw.len() as i64, &text)
    {
        Ok(id) => {
            log::info!(
                "[attachments] added {safe_name} ({} bytes) to meeting {meeting_id}",
                raw.len()
            );
            Json(json!({
                "id": id,
                "meeting_id": meeting_id,
                "filename": safe_name,
                "mime_type": mime,
                "size_bytes": raw.len(),
                // The existing summary predates this file; the UI should offer
                // to regenerate so the new material is actually used.
                "regenerate_required": true,
            }))
            .into_response()
        }
        Err(e) => internal_error(&e),
    }
}

fn strip_bom(raw: &[u8]) -> Vec<u8> {
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        raw[3..].to_vec()
    } else {
        raw.to_vec()
    }
}

/// `GET /meetings/{id}/attachments` — metadata list plus the limit envelope.
pub async fn list_attachments(State(state): State<AppState>, Path(meeting_id): Path<i64>) -> Response {
    match state.db().get_meeting(meeting_id) {
        Ok(Some(_)) => {}
        Ok(None) => return detail_error(StatusCode::NOT_FOUND, "Meeting not found"),
        Err(e) => return internal_error(&e),
    }

    let items = match state.db().list_attachments(meeting_id) {
        Ok(v) => v,
        Err(e) => return internal_error(&e),
    };
    let total_bytes: i64 = items
        .iter()
        .map(|a| a.get("size_bytes").and_then(|v| v.as_i64()).unwrap_or(0))
        .sum();

    Json(json!({
        "items": items,
        "total_bytes": total_bytes,
        "max_total_bytes": MAX_TOTAL_BYTES_PER_MEETING,
        "warn_total_bytes": WARN_TOTAL_BYTES,
        "max_files": MAX_FILES_PER_MEETING,
        "max_file_bytes": MAX_FILE_BYTES,
    }))
    .into_response()
}

/// `GET /meetings/{id}/attachments/{aid}` — full text of one attachment.
pub async fn get_attachment(
    State(state): State<AppState>,
    Path((meeting_id, attachment_id)): Path<(i64, i64)>,
) -> Response {
    match state.db().get_meeting(meeting_id) {
        Ok(Some(_)) => {}
        Ok(None) => return detail_error(StatusCode::NOT_FOUND, "Meeting not found"),
        Err(e) => return internal_error(&e),
    }

    match state.db().get_attachment(attachment_id) {
        Ok(Some(att)) => {
            // An id from another meeting must not leak through this path.
            if att.get("meeting_id").and_then(|v| v.as_i64()) != Some(meeting_id) {
                return detail_error(StatusCode::NOT_FOUND, "Attachment not found");
            }
            Json(att).into_response()
        }
        Ok(None) => detail_error(StatusCode::NOT_FOUND, "Attachment not found"),
        Err(e) => internal_error(&e),
    }
}

/// `DELETE /meetings/{id}/attachments/{aid}`
pub async fn delete_attachment(
    State(state): State<AppState>,
    Path((meeting_id, attachment_id)): Path<(i64, i64)>,
) -> Response {
    match state.db().get_meeting(meeting_id) {
        Ok(Some(_)) => {}
        Ok(None) => return detail_error(StatusCode::NOT_FOUND, "Meeting not found"),
        Err(e) => return internal_error(&e),
    }

    match state.db().delete_attachment(attachment_id, meeting_id) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => detail_error(StatusCode::NOT_FOUND, "Attachment not found"),
        Err(e) => internal_error(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_path_components() {
        assert_eq!(sanitize_filename(Some("../../etc/passwd")), "passwd");
        assert_eq!(sanitize_filename(Some("C:\\docs\\spec.md")), "spec.md");
        assert_eq!(sanitize_filename(Some("  spec.md  ")), "spec.md");
        assert_eq!(sanitize_filename(None), "untitled");
        assert_eq!(sanitize_filename(Some("")), "untitled");
    }

    #[test]
    fn sanitize_drops_control_characters() {
        assert_eq!(sanitize_filename(Some("sp\u{0}ec.md")), "spec.md");
    }

    #[test]
    fn sanitize_caps_length_at_200_chars() {
        let long = format!("{}.md", "a".repeat(500));
        assert_eq!(sanitize_filename(Some(&long)).chars().count(), 200);
    }

    #[test]
    fn extension_validation_is_case_insensitive_and_message_matches_python() {
        assert_eq!(validate_extension("Spec.MD").unwrap(), ".md");
        assert_eq!(validate_extension("notes.markdown").unwrap(), ".markdown");
        assert_eq!(validate_extension("a.txt").unwrap(), ".txt");
        let err = validate_extension("report.pdf").unwrap_err();
        assert!(err.contains(".pdf"), "got: {err}");
        // Python sorted the allowed list, so ".markdown" precedes ".md".
        assert!(
            err.contains(".markdown, .md, .txt"),
            "allowed list must be alphabetical to match Python, got: {err}"
        );
        // No extension prints the Vietnamese "không có" placeholder.
        let err = validate_extension("noext").unwrap_err();
        assert!(err.contains("không có"), "got: {err}");
    }

    #[test]
    fn bom_is_stripped() {
        let with_bom = b"\xEF\xBB\xBF# Title".to_vec();
        assert_eq!(String::from_utf8(strip_bom(&with_bom)).unwrap(), "# Title");
        let plain = b"# Title".to_vec();
        assert_eq!(strip_bom(&plain), plain);
    }
}
