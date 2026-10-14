//! Upload-audio API — file upload, job status, SSE progress, cancellation.
//!
//! Port of `src-python/api/upload.py` + `services/upload_storage.py`.
//!
//! Routes:
//!   POST /meetings/upload-audio       — receive the file, create meeting + job
//!   GET  /jobs/{job_id}               — poll job status (REST fallback)
//!   GET  /jobs/{job_id}/events        — SSE stream of job updates
//!   POST /jobs/{job_id}/cancel        — cooperative cancellation
//!
//! The frontend (`src/lib/upload-audio.ts`) fetches the file in Rust and streams
//! it here, then subscribes to `/jobs/{id}/events` for the rest of the pipeline.
//! A `{"type":"status", ...}` frame carries the `JobState` the modal renders; a
//! `{"type":"chunk", ...}` frame carries each transcribed chunk.

use std::convert::Infallible;
use std::path::PathBuf;

use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::stream;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc;

use super::jobs::{self, JobRegistry};
use super::meetings::internal_error;
use super::AppState;

/// 2 GB hard cap, matching Python's `MAX_FILE_BYTES`.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// SSE heartbeat cadence, matching Python's `SSE_HEARTBEAT_SECONDS`.
const SSE_HEARTBEAT_SECONDS: u64 = 25;
/// How long a terminal job is retained before the sweeper may drop it.
const JOB_RETENTION_SECONDS: f64 = 24.0 * 3600.0;

const DUPLICATE_ERROR_PREFIX: &str = "DUPLICATE:";

/// Accepted audio/video containers — same set as `upload_storage.ALLOWED_EXTENSIONS`.
const ALLOWED_EXTENSIONS: [&str; 13] = [
    ".aac", ".flac", ".m4a", ".mkv", ".mov", ".mp3", ".mp4", ".oga", ".ogg", ".opus", ".wav",
    ".webm", ".wma",
];

/// Process-wide registry. Mirrors Python's module-level `registry` singleton.
static REGISTRY: std::sync::OnceLock<JobRegistry> = std::sync::OnceLock::new();

pub fn registry() -> &'static JobRegistry {
    REGISTRY.get_or_init(JobRegistry::new)
}

/// NFC-normalise, replace Windows-reserved characters, truncate to 200 chars.
///
/// Mirrors `upload_storage.sanitize_filename`. Never returns empty.
fn sanitize_filename(original: Option<&str>) -> String {
    let Some(original) = original.filter(|s| !s.is_empty()) else {
        return "upload.bin".to_string();
    };
    // Keep only the basename so a crafted filename cannot escape the target dir.
    let base = original.rsplit(['/', '\\']).next().unwrap_or(original);
    let replaced: String = base
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = replaced.trim_matches(|c: char| c == '.' || c == ' ' || c == '\t');
    if trimmed.is_empty() {
        return "upload.bin".to_string();
    }
    if trimmed.chars().count() > 200 {
        // Preserve the extension (capped at 20 chars) and trim the stem, as
        // Python did with `p.stem[:200 - len(suffix)]`.
        let (stem, suffix) = match trimmed.rfind('.') {
            Some(i) => (&trimmed[..i], &trimmed[i..]),
            None => (trimmed, ""),
        };
        let suffix: String = suffix.chars().take(20).collect();
        let keep = 200usize.saturating_sub(suffix.chars().count());
        let stem: String = stem.chars().take(keep).collect();
        return format!("{stem}{suffix}");
    }
    trimmed.to_string()
}

fn validate_extension(filename: &str) -> Result<String, String> {
    let ext = filename
        .rfind('.')
        .map(|i| filename[i..].to_ascii_lowercase())
        .unwrap_or_default();
    if ext.is_empty() || !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        let shown = if ext.is_empty() { "(none)" } else { &ext };
        let mut sorted = ALLOWED_EXTENSIONS;
        sorted.sort_unstable();
        return Err(format!(
            "Unsupported audio/video format: '{shown}'. Allowed: {}",
            sorted.join(", ")
        ));
    }
    Ok(ext)
}

/// `POST /meetings/upload-audio` — multipart upload, creates meeting + job.
pub async fn upload_audio(State(state): State<AppState>, mut multipart: Multipart) -> Response {
    // Collect the multipart parts. `title`/`language`/`generate_summary` are
    // form fields; the file comes last (FastAPI's UploadFile + Form() order).
    let mut filename: Option<String> = None;
    let mut title: Option<String> = None;
    let mut language = "vi".to_string();
    let mut generate_summary = true;
    let mut target_staging: Option<PathBuf> = None;
    let mut total_bytes: u64 = 0;
    let mut hasher = Sha256::new();

    // Stage the upload into the data dir before we know the meeting id; renamed
    // to the canonical `upload_{id}{ext}` once the row exists.
    let staging = state
        .db()
        .data_dir()
        .join("audio")
        .join("uploads")
        .join(format!("staging_{}.part", uuid::Uuid::new_v4().simple()));
    if let Some(parent) = staging.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return internal_error(&format!("create upload dir: {e}"));
        }
    }

    loop {
        let field = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                let _ = tokio::fs::remove_file(&staging).await;
                return detail_error(StatusCode::BAD_REQUEST, &format!("multipart: {e}"));
            }
        };

        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "title" => title = Some(field.text().await.unwrap_or_default()),
            "language" => {
                let v = field.text().await.unwrap_or_default();
                if !v.trim().is_empty() {
                    language = v.trim().to_string();
                }
            }
            "generate_summary" => {
                let v = field.text().await.unwrap_or_default();
                generate_summary = !matches!(
                    v.trim().to_ascii_lowercase().as_str(),
                    "false" | "0" | "no" | "off"
                );
            }
            _ => {
                // The file part (named `audio` by the frontend). Stream it to
                // disk in bounded chunks so a 2 GB upload never sits in RAM.
                let Some(fname) = field.file_name().map(str::to_string) else {
                    continue;
                };
                filename = Some(fname);

                let mut field = field;
                let mut file = match tokio::fs::File::create(&staging).await {
                    Ok(f) => f,
                    Err(e) => return internal_error(&format!("create upload file: {e}")),
                };
                use tokio::io::AsyncWriteExt;
                loop {
                    match field.chunk().await {
                        Ok(Some(bytes)) => {
                            total_bytes += bytes.len() as u64;
                            if total_bytes > MAX_FILE_BYTES {
                                drop(file);
                                let _ = tokio::fs::remove_file(&staging).await;
                                return detail_error(
                                    StatusCode::PAYLOAD_TOO_LARGE,
                                    &format!(
                                        "Uploaded file exceeds the {}MB limit",
                                        MAX_FILE_BYTES / (1024 * 1024)
                                    ),
                                );
                            }
                            hasher.update(&bytes);
                            if let Err(e) = file.write_all(&bytes).await {
                                drop(file);
                                let _ = tokio::fs::remove_file(&staging).await;
                                return internal_error(&format!("write upload: {e}"));
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            drop(file);
                            let _ = tokio::fs::remove_file(&staging).await;
                            return detail_error(
                                StatusCode::BAD_REQUEST,
                                &format!("read upload: {e}"),
                            );
                        }
                    }
                }
                if let Err(e) = file.flush().await {
                    return internal_error(&format!("flush upload: {e}"));
                }
                target_staging = Some(staging.clone());
            }
        }
    }

    let Some(_) = target_staging else {
        let _ = tokio::fs::remove_file(&staging).await;
        return detail_error(StatusCode::BAD_REQUEST, "audio file is required");
    };

    let safe_name = sanitize_filename(filename.as_deref());
    let ext = match validate_extension(&safe_name) {
        Ok(e) => e,
        Err(msg) => {
            let _ = tokio::fs::remove_file(&staging).await;
            return detail_error(StatusCode::BAD_REQUEST, &msg);
        }
    };

    let meeting_title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| {
            let stem = safe_name.rsplit_once('.').map(|(s, _)| s).unwrap_or(&safe_name);
            if stem.trim().is_empty() {
                "Uploaded audio".to_string()
            } else {
                stem.trim().to_string()
            }
        });

    let meeting_id = match state
        .db()
        .create_meeting(&meeting_title, "", "", 0.0, &language, "uploading")
    {
        Ok(id) => id,
        Err(e) => {
            let _ = tokio::fs::remove_file(&staging).await;
            return internal_error(&e);
        }
    };

    let mut upd = serde_json::Map::new();
    upd.insert("source_type".to_string(), json!("upload"));
    upd.insert("source_filename".to_string(), json!(safe_name));
    if let Err(e) = state.db().update_meeting(meeting_id, &upd) {
        log::warn!("[upload] could not set source metadata for {meeting_id}: {e}");
    }

    let target_path = state
        .db()
        .data_dir()
        .join("audio")
        .join("uploads")
        .join(format!("upload_{meeting_id}{ext}"));
    if let Some(parent) = target_path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if let Err(e) = tokio::fs::rename(&staging, &target_path).await {
        let _ = tokio::fs::remove_file(&staging).await;
        let _ = state.db().delete_meeting(meeting_id);
        return internal_error(&format!("finalize upload: {e}"));
    }

    let sha256 = format!("{:x}", hasher.finalize());

    // Duplicate detection: an identical file already transcribed is reused
    // rather than re-run, and the frontend redirects to that meeting. The
    // marker prefix is the contract (`DUPLICATE_ERROR_PREFIX` in the TS).
    if let Ok(Some(existing_id)) = state.db().find_meeting_by_hash(&sha256) {
        if existing_id != meeting_id {
            let _ = tokio::fs::remove_file(&target_path).await;
            let _ = state.db().delete_meeting(meeting_id);
            let (handle, _rx) = registry().create(existing_id, generate_summary);
            let job_id = handle.lock().unwrap().job_id.clone();
            registry().update(&job_id, |s| {
                s.status = jobs::FAILED.to_string();
                s.error = Some(format!("{DUPLICATE_ERROR_PREFIX}{existing_id}"));
                s.message = format!("File đã tồn tại trong meeting #{existing_id}");
            });
            return Json(json!({ "job_id": job_id, "meeting_id": existing_id })).into_response();
        }
    }

    let mut upd = serde_json::Map::new();
    upd.insert(
        "audio_path".to_string(),
        json!(target_path.to_string_lossy()),
    );
    // Persist the hash, not just compute it: `find_meeting_by_hash` above reads
    // this column, so without the write the duplicate check can never match and
    // every re-upload of the same file is transcribed again from scratch.
    upd.insert("file_hash".to_string(), json!(sha256));
    if let Err(e) = state.db().update_meeting(meeting_id, &upd) {
        log::warn!("[upload] could not persist audio_path/file_hash for {meeting_id}: {e}");
    }

    let (handle, _rx) = registry().create(meeting_id, generate_summary);
    let job_id = handle.lock().unwrap().job_id.clone();
    registry().update(&job_id, |s| {
        s.message = format!("Uploaded {total_bytes} bytes — bắt đầu xử lý");
    });

    // The pipeline reads from disk, so spawning after the response is safe.
    let job_for_task = job_id.clone();
    let st = state.clone();
    let lang = language.clone();
    tokio::spawn(async move {
        run_pipeline(st, job_for_task, meeting_id, target_path, lang, generate_summary).await;
    });

    Json(json!({
        "upload_id": job_id,
        "job_id": job_id,
        "meeting_id": meeting_id,
    }))
    .into_response()
}

fn detail_error(status: StatusCode, detail: &str) -> Response {
    (status, Json(json!({ "detail": detail }))).into_response()
}

/// `GET /jobs/{job_id}` — one-shot status poll.
pub async fn get_job(Path(job_id): Path<String>) -> Response {
    match registry().get(&job_id) {
        Some(handle) => {
            let state = handle.lock().unwrap();
            Json(state.to_dict()).into_response()
        }
        None => detail_error(StatusCode::NOT_FOUND, "Job not found"),
    }
}

/// `GET /jobs/{job_id}/events` — SSE stream of job updates.
///
/// Sends the current state immediately (so a late subscriber is never blind),
/// then live updates until the job reaches a terminal state. Heartbeat comments
/// keep intermediaries from closing an idle connection during a long STT step.
pub async fn job_events(Path(job_id): Path<String>) -> Response {
    let Some(handle) = registry().get(&job_id) else {
        return detail_error(StatusCode::NOT_FOUND, "Job not found");
    };
    let Some(mut rx) = registry().subscribe(&job_id) else {
        return detail_error(StatusCode::NOT_FOUND, "Job not found");
    };

    let (tx, mut out_rx) = mpsc::channel::<Result<String, Infallible>>(64);

    tokio::spawn(async move {
        // Initial snapshot.
        let initial = {
            let state = handle.lock().unwrap();
            let mut v = state.to_dict();
            if let Some(obj) = v.as_object_mut() {
                let mut out = serde_json::Map::new();
                out.insert("type".to_string(), json!("status"));
                for (k, val) in obj.iter() {
                    out.insert(k.clone(), val.clone());
                }
                v = Value::Object(out);
            }
            v
        };
        if tx
            .send(Ok(format!(
                "data: {}\n\n",
                super::pyjson::dumps(&initial)
            )))
            .await
            .is_err()
        {
            return;
        }

        let terminal = initial
            .get("status")
            .and_then(Value::as_str)
            .map(jobs::is_terminal)
            .unwrap_or(false);
        if terminal {
            return;
        }

        let heartbeat = std::time::Duration::from_secs(SSE_HEARTBEAT_SECONDS);
        loop {
            match tokio::time::timeout(heartbeat, rx.recv()).await {
                Ok(Ok(event)) => {
                    let done = event.get("type").and_then(Value::as_str) == Some("status")
                        && event
                            .get("status")
                            .and_then(Value::as_str)
                            .map(jobs::is_terminal)
                            .unwrap_or(false);
                    if tx
                        .send(Ok(format!("data: {}\n\n", super::pyjson::dumps(&event))))
                        .await
                        .is_err()
                    {
                        break; // client disconnected
                    }
                    if done {
                        break;
                    }
                }
                // Lagged: this subscriber missed events. Keep the newest rather
                // than dropping it — losing a progress tick is fine, losing the
                // terminal frame is not.
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break,
                Err(_) => {
                    if tx.send(Ok(": heartbeat\n\n".to_string())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let body = stream::poll_fn(move |cx| out_rx.poll_recv(cx));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("X-Accel-Buffering", "no")
        .body(Body::from_stream(body))
        .unwrap_or_else(|_| internal_error("sse response"))
}

/// `POST /jobs/{job_id}/cancel` — cooperative cancellation.
pub async fn cancel_job(Path(job_id): Path<String>) -> Response {
    if registry().cancel(&job_id) {
        Json(json!({ "ok": true })).into_response()
    } else {
        detail_error(
            StatusCode::NOT_FOUND,
            "Job not found or already finished",
        )
    }
}

/// Run the upload pipeline for a job: normalize → VAD split → STT → diarize
/// → save transcript → optional summarize.
///
/// Port of `services/upload_pipeline.py::run_pipeline` for the local engine.
/// Progress is reported through the job so the modal's stepper advances.
async fn run_pipeline(
    state: AppState,
    job_id: String,
    meeting_id: i64,
    audio_path: PathBuf,
    language: String,
    generate_summary: bool,
) {
    let reg = registry();

    // Work dir for the normalized WAV and chunk files, cleaned up at the end.
    let work_dir = state
        .db()
        .data_dir()
        .join("audio")
        .join("work")
        .join(format!("meeting_{meeting_id}"));
    let normalized = work_dir.join("normalized.wav");
    let chunks_dir = work_dir.join("chunks");

    // Cloned into the closure so the surrounding scope keeps ownership of
    // `work_dir` for the success-path cleanup.
    let fail_work_dir = work_dir.clone();
    let fail_job_id = job_id.clone();
    let fail_state = state.clone();
    let fail = move |msg: String| {
        let job_id = fail_job_id.clone();
        let work_dir = fail_work_dir.clone();
        let state = fail_state.clone();
        async move {
            registry().update(&job_id, |s| {
                s.status = jobs::FAILED.to_string();
                s.error = Some(msg.clone());
                s.message = "Xử lý thất bại".to_string();
            });
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            // Nothing transcribed → remove the half-created meeting and its
            // audio, otherwise it stays "uploading" forever and its file_hash
            // keeps tripping duplicate detection (Python did the same). A
            // meeting that already has a transcript (retry of a saved one) is
            // left exactly as it was.
            discard_if_empty(&state, meeting_id).await;
        }
    };

    // Cooperative cancellation is checked at EVERY stage boundary, not just in
    // the chunk loop. The diarize step on a long meeting runs for minutes and
    // used to ignore a cancel entirely, leaving the job stuck in
    // `transcribing` forever while the UI waited on a terminal state.
    //
    // Cleanup mirrors `run_pipeline`'s CancelledError branch: when nothing was
    // saved yet, the half-created meeting and its audio are deleted so the list
    // stays clean AND the orphaned row cannot poison duplicate detection for the
    // user's next upload of the same file. If a transcript WAS already saved we
    // keep everything and mark the meeting 'cancelled' instead — losing an
    // already-transcribed meeting would be worse than a stray row.
    macro_rules! bail_if_cancelled {
        () => {
            if reg.is_cancelled(&job_id) {
                let has_partial = state
                    .db()
                    .get_meeting(meeting_id)
                    .ok()
                    .flatten()
                    .and_then(|m| {
                        m.get("transcript")
                            .and_then(Value::as_str)
                            .map(|t| !t.trim().trim_matches(['[', ']']).is_empty())
                    })
                    .unwrap_or(false);

                reg.update(&job_id, |s| {
                    s.status = jobs::CANCELLED.to_string();
                    s.message = "Đã huỷ".to_string();
                    s.error = Some("Cancelled".to_string());
                    s.transcript_saved = has_partial;
                });

                if has_partial {
                    let mut upd = serde_json::Map::new();
                    upd.insert("status".to_string(), json!("cancelled"));
                    let _ = state.db().update_meeting(meeting_id, &upd);
                } else {
                    let _ = tokio::fs::remove_file(&audio_path).await;
                    let _ = state.db().delete_meeting(meeting_id);
                }
                let _ = tokio::fs::remove_dir_all(&work_dir).await;
                return;
            }
        };
    }

    // ── Normalize ──
    reg.update(&job_id, |s| {
        s.status = jobs::NORMALIZING.to_string();
        s.progress = 0.05;
        s.message = "Đang chuẩn hoá audio".to_string();
    });

    if let Err(e) = crate::pipeline::normalize_to_wav(&audio_path, &normalized).await {
        fail(format!("Chuẩn hoá audio thất bại: {e}")).await;
        return;
    }

    // Duration from the normalized file, so the UI has a real number.
    let duration = crate::pipeline::probe_duration_seconds(&normalized).await;
    if duration > 0.0 {
        let mut upd = serde_json::Map::new();
        upd.insert("audio_duration".to_string(), json!(duration));
        let _ = state.db().update_meeting(meeting_id, &upd);
    }

    // ── Provider (Settings → STT) ──
    // Soniox: the cloud does STT + speaker diarization on the whole file, so
    // the VAD split and the local diarizer are skipped. Anything else runs the
    // local engine picked in Settings (`local_engine`).
    let setting = |k: &str| {
        state.db().get_setting(k).ok().flatten().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
    };
    let use_soniox = setting("stt_provider").is_some_and(|p| p.eq_ignore_ascii_case("soniox"));

    let parts: Vec<Value> = if use_soniox {
        bail_if_cancelled!();
        reg.update(&job_id, |s| {
            s.status = jobs::TRANSCRIBING.to_string();
            s.progress = 0.15;
            s.message = "Đang tải audio lên Soniox".to_string();
        });
        // The upload's chosen language goes first; Settings hints add others.
        let mut hints: Vec<String> = Vec::new();
        if !language.is_empty() && language != "auto" {
            hints.push(language.clone());
        }
        for h in setting("soniox_language_hints").unwrap_or_default().split([',', ' ']) {
            let h = h.trim().to_string();
            if !h.is_empty() && !hints.contains(&h) {
                hints.push(h);
            }
        }
        let api_key = setting("soniox_api_key").unwrap_or_default();
        let segments = crate::stt::soniox_async::transcribe_file_split(
            &api_key,
            &normalized,
            duration,
            &work_dir,
            &hints,
            |frac, msg| {
                reg.update(&job_id, |s| {
                    s.progress = 0.15 + frac * 0.65;
                    s.message = msg.to_string();
                })
            },
            || reg.is_cancelled(&job_id),
        )
        .await;
        bail_if_cancelled!();
        let segments = match segments {
            Ok(s) => s,
            Err(e) => {
                fail(format!("Soniox nhận dạng thất bại: {e}")).await;
                return;
            }
        };
        for (i, seg) in segments.iter().enumerate() {
            reg.emit_chunk(
                &job_id,
                json!({"idx": i, "text": seg.text, "start_ms": seg.start_ms, "end_ms": seg.end_ms}),
            );
        }
        crate::pipeline::soniox_transcript_parts(&segments)
    } else {
        // ── Step 1: Diarize + Silence VAD FIRST to cut along natural speaker turns ──
        bail_if_cancelled!();
        reg.update(&job_id, |s| {
            s.status = jobs::TRANSCRIBING.to_string();
            s.progress = 0.12;
            s.message = "Đang phân tích người nói & ngắt đoạn tự nhiên".to_string();
        });

        let (chunks, speaker_map) =
            match crate::pipeline::diarize_and_split_into_chunks(&normalized, &chunks_dir).await {
                Ok(v) => v,
                Err(e) => {
                    fail(format!("Chia đoạn audio thất bại: {e}")).await;
                    return;
                }
            };
        if chunks.is_empty() {
            reg.update(&job_id, |s| {
                s.status = jobs::DONE.to_string();
                s.progress = 1.0;
                s.message = "Audio rỗng".to_string();
                s.transcript_saved = true;
            });
            let mut upd = serde_json::Map::new();
            upd.insert("status".to_string(), json!("saved"));
            let _ = state.db().update_meeting(meeting_id, &upd);
            let _ = tokio::fs::remove_dir_all(&work_dir).await;
            return;
        }

        // ── Step 2: Run STT on each speaker-turn chunk ──
        reg.update(&job_id, |s| {
            s.status = jobs::TRANSCRIBING.to_string();
            s.progress = 0.25;
            s.total_chunks = chunks.len();
            s.message = format!("Đang nhận dạng {} đoạn theo lượt lời", chunks.len());
        });

        let mut results: Vec<crate::pipeline::ChunkResult> = Vec::new();
        for (i, chunk) in chunks.iter().enumerate() {
            bail_if_cancelled!();

            let path = chunk.path.clone();
            let lang = language.clone();
            let text = tokio::task::spawn_blocking(move || {
                crate::stt::local::transcribe_wav_file(&path, &lang)
            })
            .await
            .unwrap_or_else(|e| Err(format!("stt task: {e}")))
            .unwrap_or_default();

            if !text.trim().is_empty() {
                let spk_id = speaker_map.get(&chunk.idx).copied().unwrap_or(0);
                reg.emit_chunk(
                    &job_id,
                    json!({
                        "idx": chunk.idx,
                        "text": text.trim(),
                        "speaker": format!("Speaker {}", spk_id + 1),
                        "speaker_id": spk_id,
                        "start_ms": chunk.start_ms,
                        "end_ms": chunk.end_ms,
                    }),
                );
            }
            results.push(crate::pipeline::ChunkResult {
                idx: chunk.idx,
                start_ms: chunk.start_ms,
                end_ms: chunk.end_ms,
                text,
            });

            let frac = (i + 1) as f64 / chunks.len() as f64;
            reg.update(&job_id, |s| {
                s.processed_chunks = i + 1;
                s.progress = 0.25 + frac * 0.58;
                s.message = format!("Đã xử lý {}/{} đoạn", i + 1, chunks.len());
            });
        }

        // ── Step 3: Build the transcript ──
        bail_if_cancelled!();
        crate::pipeline::build_transcript_parts(&results, &speaker_map)
    };

    // ── Save the transcript ──
    bail_if_cancelled!();
    reg.update(&job_id, |s| {
        s.status = jobs::FINALIZING.to_string();
        s.progress = 0.85;
        s.message = "Đang lưu bản ghi".to_string();
    });

    let transcript_json = super::pyjson::dumps(&Value::Array(parts.clone()));
    let mut upd = serde_json::Map::new();
    upd.insert("transcript".to_string(), json!(transcript_json));
    // A full re-run (retry-failed-chunks) leaves no failed chunk behind.
    upd.insert("failed_chunks_count".to_string(), json!(0));
    upd.insert("status".to_string(), json!("saved"));
    if let Err(e) = state.db().update_meeting(meeting_id, &upd) {
        fail(format!("Lưu bản ghi thất bại: {e}")).await;
        return;
    }
    // From here the meeting is openable even if a later step fails.
    reg.update(&job_id, |s| s.transcript_saved = true);

    let _ = tokio::fs::remove_dir_all(&work_dir).await;

    // ── Optional auto-summarize ──
    bail_if_cancelled!();
    if generate_summary && !parts.is_empty() {
        reg.update(&job_id, |s| {
            s.progress = 0.9;
            s.message = "Đang tạo biên bản".to_string();
        });
        match summarize_transcript(&state, meeting_id, &parts, &language).await {
            Ok(Some(summary)) if !summary.trim().is_empty() => {
                let mut upd = serde_json::Map::new();
                upd.insert("summary".to_string(), json!(summary));
                if let Err(e) = state.db().update_meeting(meeting_id, &upd) {
                    log::warn!("[upload] save summary failed for {meeting_id}: {e}");
                }
            }
            Ok(_) => {
                // Skipped (no key) or empty — the job still succeeds.
                reg.update(&job_id, |s| {
                    s.summary_skipped = true;
                    s.summary_skip_reason = "LLM API key not set".to_string();
                });
            }
            Err(e) => {
                log::warn!("[upload] summarize failed for {meeting_id}: {e}");
                reg.update(&job_id, |s| {
                    s.summary_skipped = true;
                    s.summary_skip_reason = e.clone();
                });
            }
        }
    } else if !generate_summary {
        reg.update(&job_id, |s| {
            s.summary_skipped = true;
            s.summary_skip_reason = "user_opted_out".to_string();
        });
    }

    reg.update(&job_id, |s| {
        s.status = jobs::DONE.to_string();
        s.progress = 1.0;
        s.message = "Hoàn tất".to_string();
    });
}

/// Does the meeting already hold a non-empty transcript?
fn has_transcript(meeting: &Value) -> bool {
    meeting
        .get("transcript")
        .and_then(Value::as_str)
        .map(|t| !t.trim().trim_matches(['[', ']']).trim().is_empty())
        .unwrap_or(false)
}

/// Delete a meeting (and its audio) that never got a transcript.
async fn discard_if_empty(state: &AppState, meeting_id: i64) {
    let Ok(Some(m)) = state.db().get_meeting(meeting_id) else { return };
    if has_transcript(&m) {
        return;
    }
    if let Some(p) = m.get("audio_path").and_then(Value::as_str).filter(|p| !p.is_empty()) {
        let _ = tokio::fs::remove_file(p).await;
    }
    let _ = state.db().delete_meeting(meeting_id);
    log::info!("[upload] COMPLETED: discarded empty failed upload meeting={meeting_id}");
}

/// Boot-time cleanup of meetings left in `uploading` by a crash or quit
/// (port of Python `resurrect_stuck_meetings_on_boot`). The Rust pipeline keeps
/// no per-chunk state, so: a saved transcript → `saved`; none → delete the
/// meeting and its audio, so its file_hash cannot block a re-upload.
pub fn recover_stuck_uploads(db: &crate::db::Database) {
    let Ok(all) = db.get_all_meetings() else { return };
    for m in all.iter().filter(|m| m.get("status").and_then(Value::as_str) == Some("uploading")) {
        let Some(id) = m.get("id").and_then(Value::as_i64) else { continue };
        if has_transcript(m) {
            let mut upd = serde_json::Map::new();
            upd.insert("status".to_string(), json!("saved"));
            let _ = db.update_meeting(id, &upd);
            log::info!("[upload] RESOLVED: stuck upload meeting={id} -> saved");
        } else {
            if let Some(p) = m.get("audio_path").and_then(Value::as_str).filter(|p| !p.is_empty()) {
                let _ = std::fs::remove_file(p);
            }
            let _ = db.delete_meeting(id);
            log::info!("[upload] RESOLVED: stuck empty upload meeting={id} -> deleted");
        }
    }
}

/// `POST /meetings/{id}/retry-failed-chunks` — re-transcribe the meeting's
/// audio with the current STT settings.
///
/// Python retried only the chunks marked failed. The Rust pipeline keeps no
/// per-chunk state, so the whole file is processed again (same provider
/// matrix as an upload) and the transcript is replaced on success; on failure
/// the existing transcript is kept. Response shape is unchanged.
pub async fn retry_failed_chunks(State(state): State<AppState>, Path(meeting_id): Path<i64>) -> Response {
    let meeting = match state.db().get_meeting(meeting_id) {
        Ok(Some(m)) => m,
        Ok(None) => return detail_error(StatusCode::NOT_FOUND, "Meeting not found"),
        Err(e) => return detail_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    let audio_path = match super::transcription::resolve_audio_source(&state, meeting_id) {
        Ok(Some(p)) => p,
        _ => return detail_error(StatusCode::NOT_FOUND, "Không tìm thấy file audio của cuộc họp"),
    };
    let retry_chunks = meeting.get("failed_chunks_count").and_then(Value::as_i64).unwrap_or(0);
    let language = meeting
        .get("language")
        .and_then(Value::as_str)
        .filter(|l| !l.is_empty())
        .unwrap_or("vi")
        .to_string();

    let (handle, _rx) = registry().create(meeting_id, false);
    let job_id = handle.lock().unwrap().job_id.clone();
    let job_for_task = job_id.clone();
    let st = state.clone();
    tokio::spawn(async move {
        run_pipeline(st, job_for_task, meeting_id, audio_path, language, false).await;
    });
    Json(json!({ "job_id": job_id, "meeting_id": meeting_id, "retry_chunks": retry_chunks })).into_response()
}

/// Drain the summarizer into a single markdown string.
///
/// `Ok(None)` means "intentionally skipped" (no API key) rather than an error —
/// the job still ends in `done` with a saved transcript, matching the Python
/// pipeline's best-effort behaviour.
async fn summarize_transcript(
    state: &AppState,
    meeting_id: i64,
    parts: &[Value],
    language: &str,
) -> Result<Option<String>, String> {
    let transcript = crate::pipeline::flatten_parts(parts);
    if transcript.trim().is_empty() {
        return Ok(None);
    }

    let db = state.db();
    let setting = |k: &str| -> Option<String> {
        db.get_setting(k).ok().flatten().filter(|s| !s.trim().is_empty())
    };
    let api_key = setting("llm_api_key")
        .or_else(|| std::env::var("LLM_API_KEY").ok().filter(|s| !s.is_empty()))
        .unwrap_or_default();
    if api_key.is_empty() {
        return Ok(None);
    }
    let model = setting("llm_model")
        .or_else(|| std::env::var("LLM_MODEL").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "gpt-4o-mini".to_string());
    let provider = setting("llm_provider").unwrap_or_else(|| "openai".to_string());
    let base_url = if provider == "compatible" {
        setting("llm_base_url").unwrap_or_default()
    } else {
        crate::llm::provider_base_url(&provider).to_string()
    };

    let cfg = crate::llm::LlmConfig {
        api_key,
        model,
        base_url: base_url.trim_end_matches('/').to_string(),
    };

    // Same framed block + system note as `/summarize` (Python passed
    // `meeting_id` into the shared summarize_stream). Raw attachment text with
    // no framing was pasted ahead of the transcript and read as part of it.
    let reference_context =
        super::transcription::load_reference_context(state, Some(meeting_id));
    let ctx = crate::llm::SummaryContext {
        time_context: String::new(),
        reference_system_note: super::transcription::reference_system_note(&reference_context),
        reference_context,
    };

    let tokens = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let sink = tokens.clone();
    // The stream reports provider failures (401, network…) as an `error`
    // EVENT and still returns Ok — capture it so the job shows the real cause
    // instead of "LLM API key not set" (Python: `summarize_error: …`).
    let failure = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let failure_sink = failure.clone();
    crate::llm::summarize_stream_with_context(
        &cfg,
        &transcript,
        language,
        "mom",
        "",
        ctx,
        move |ev: crate::llm::SseEvent| {
            if ev.event == "chunk" {
                if let Some(t) = ev.data.get("token").and_then(Value::as_str) {
                    if let Ok(mut acc) = sink.lock() {
                        acc.push_str(t);
                    }
                }
            } else if ev.event == "error" {
                if let Ok(mut f) = failure_sink.lock() {
                    *f = Some(ev.data.get("error").and_then(Value::as_str).unwrap_or("unknown").to_string());
                }
            }
        },
    )
    .await?;

    if let Some(e) = failure.lock().ok().and_then(|f| f.clone()) {
        return Err(format!("summarize_error: {e}"));
    }
    let out = tokens.lock().map(|s| s.clone()).unwrap_or_default();
    if out.trim().is_empty() {
        return Err("summarize_empty".to_string());
    }
    Ok(Some(out.trim().to_string()))
}

/// Drop terminal jobs older than the retention window. Called opportunistically.
pub fn cleanup_stale_jobs() -> usize {
    registry().cleanup_stale(JOB_RETENTION_SECONDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_matches_python_rules() {
        assert_eq!(sanitize_filename(Some("recording.mp3")), "recording.mp3");
        // Windows-reserved characters become underscores.
        assert_eq!(sanitize_filename(Some("a<b>c:d.mp3")), "a_b_c_d.mp3");
        // Path components are stripped (no escape from the target dir).
        assert_eq!(sanitize_filename(Some("../../etc/passwd.mp3")), "passwd.mp3");
        assert_eq!(sanitize_filename(None), "upload.bin");
        assert_eq!(sanitize_filename(Some("")), "upload.bin");
    }

    #[test]
    fn sanitize_truncates_but_keeps_the_extension() {
        let long = format!("{}.mp3", "x".repeat(400));
        let out = sanitize_filename(Some(&long));
        assert_eq!(out.chars().count(), 200);
        assert!(out.ends_with(".mp3"), "got {out}");
    }

    #[test]
    fn extension_validation_rejects_unknown_and_lists_sorted() {
        assert_eq!(validate_extension("a.MP3").unwrap(), ".mp3");
        assert_eq!(validate_extension("b.m4a").unwrap(), ".m4a");
        let err = validate_extension("doc.pdf").unwrap_err();
        assert!(err.contains(".pdf"));
        // Sorted, matching Python's `sorted(ALLOWED_EXTENSIONS)`.
        assert!(err.contains(".aac, .flac, .m4a"), "got {err}");
        let err = validate_extension("noext").unwrap_err();
        assert!(err.contains("(none)"), "got {err}");
    }

    #[test]
    fn duplicate_marker_is_parseable_by_the_frontend() {
        let err = format!("{DUPLICATE_ERROR_PREFIX}42");
        // Mirrors isDuplicateError() in src/lib/upload-audio.ts.
        assert!(err.starts_with("DUPLICATE:"));
        assert_eq!(err.trim_start_matches("DUPLICATE:").parse::<i64>().unwrap(), 42);
    }
}
