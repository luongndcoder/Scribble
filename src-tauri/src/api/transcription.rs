//! Transcription API — `/summarize` and the file-upload transcribe pipeline.
//!
//! Port of `src-python/api/transcription.py`, `api/upload.py` and the
//! `services/upload_pipeline.py` entry point.
//!
//! `/summarize` is a thin SSE wrapper: the whole LLM client already lives in
//! `crate::llm` (verified against the real DeepSeek API), so this module only
//! has to do what the Python router did — resolve the transcript, pick the LLM
//! settings out of the DB, and pump `SseEvent`s into the response body.
//!
//! The streaming body is built as a `futures_util::stream::Stream` rather than
//! an axum `Sse` response so the bytes on the wire are exactly `SseEvent::
//! to_wire()` (`event: x\ndata: {...}\n\n`) with no axum-added framing.

use std::convert::Infallible;

use axum::{
    body::Body,
    extract::{Multipart, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::stream;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::meetings::internal_error;
use super::AppState;
use crate::llm::{self, LlmConfig, SseEvent};

// ─── SSE response plumbing ───

/// Build a `text/event-stream` response from a channel of already-framed frames.
///
/// Backpressure is bounded (`SSE_CHANNEL_CAPACITY`): a slow client applies
/// backpressure to the handler task instead of buffering the whole summary in
/// memory. When the receiver is dropped (client disconnected) `send` fails and
/// the producer stops early rather than generating tokens nobody will read.
const SSE_CHANNEL_CAPACITY: usize = 64;

fn sse_response(mut rx: mpsc::Receiver<Result<String, Infallible>>) -> Response {
    let body_stream = stream::poll_fn(move |cx| rx.poll_recv(cx));
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        // Mirror the Python headers; also stops proxy/webview buffering.
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(body_stream))
        .unwrap_or_else(|e| internal_error(&format!("sse response: {e}")))
}

/// Create an SSE response driven by a spawned task that receives the `Sender`.
///
/// `producer` runs on its own task so the handler can return the response
/// immediately — that is what makes the frontend's `onToken` fire incrementally
/// instead of only after the full summary has been generated.
fn spawn_sse<F>(producer: F) -> Response
where
    F: FnOnce(mpsc::Sender<Result<String, Infallible>>) -> futures_util::future::BoxFuture<'static, ()>
        + Send
        + 'static,
{
    let (tx, rx) = mpsc::channel::<Result<String, Infallible>>(SSE_CHANNEL_CAPACITY);
    tokio::spawn(producer(tx));
    sse_response(rx)
}

/// SSE response carrying exactly one frame — used for the pre-stream failures
/// Python emitted from inside the generator (so the status was already 200).
fn sse_single(ev: SseEvent) -> Response {
    spawn_sse(move |tx| {
        Box::pin(async move {
            let _ = tx.send(Ok(ev.to_wire())).await;
        })
    })
}

/// SSE response that carries a single `error` frame, matching Python's
/// `{"error": ...}` 400/404 JSON bodies for the pre-stream validation failures.
///
/// Python returned real JSON (not SSE) with a non-200 status for these, and the
/// frontend's `consumeSseResponse` throws `readResponseError(res)` on `!res.ok`
/// before it ever parses frames — so a JSON body is the faithful shape.
fn json_error(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

// ─── POST /summarize ───

/// Request body for `POST /summarize`.
#[derive(Debug, Default)]
struct SummarizeRequest {
    meeting_id: Option<i64>,
    language: String,
    transcript: Option<String>,
    start_time: String,
    end_time: String,
    template: String,
    custom_prompt: String,
}

impl SummarizeRequest {
    fn from_json(body: &Value) -> Self {
        let s = |k: &str| -> Option<String> { body.get(k).and_then(Value::as_str).map(str::to_string) };
        Self {
            // `meetingId` arrives as a number in practice, but Python did
            // `int(meeting_id)` on whatever the body held, so accept both a
            // JSON number and a numeric string.
            meeting_id: body.get("meetingId").and_then(|v| match v {
                Value::Number(n) => n.as_i64(),
                Value::String(s) => s.trim().parse::<i64>().ok(),
                _ => None,
            }),
            language: s("language").unwrap_or_else(|| "vi".to_string()),
            transcript: s("transcript"),
            start_time: s("startTime").unwrap_or_default(),
            end_time: s("endTime").unwrap_or_default(),
            template: s("template").unwrap_or_else(|| "mom".to_string()),
            custom_prompt: s("customPrompt").unwrap_or_default(),
        }
    }
}

/// Flatten a structured transcript (JSON array of parts) into
/// `"Speaker: text"` lines — mirrors the inline block in
/// `api/transcription.py::summarize`.
///
/// Python only attempted the parse when the text started with `[` and silently
/// kept the original string on any failure; the same tolerance is kept here so
/// a malformed transcript still reaches the model verbatim.
fn flatten_transcript(transcript: &str) -> String {
    let trimmed = transcript.trim();
    if !trimmed.starts_with('[') {
        return trimmed.to_string();
    }
    let Ok(Value::Array(parts)) = serde_json::from_str::<Value>(trimmed) else {
        return trimmed.to_string();
    };

    let mut lines: Vec<String> = Vec::new();
    for p in &parts {
        let Some(obj) = p.as_object() else { continue };
        let speaker = obj
            .get("speaker")
            .and_then(Value::as_str)
            .unwrap_or("Speaker");
        let text = obj
            .get("text")
            .map(scalar_to_string)
            .unwrap_or_default();
        let text = text.trim();
        if !text.is_empty() {
            lines.push(format!("{speaker}: {text}"));
        }
    }
    // Python kept the raw string when no line survived the filter.
    if lines.is_empty() {
        trimmed.to_string()
    } else {
        lines.join("\n")
    }
}

/// `str(value)` for the transcript text field.
fn scalar_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "None".to_string(),
        other => other.to_string(),
    }
}

/// Build the `LlmConfig` from DB settings, mirroring the resolution order in
/// `summarize.py::summarize_stream` (DB setting first, then env, then default).
fn resolve_llm_config(state: &AppState) -> Result<LlmConfig, String> {
    let db = state.db();
    let setting = |k: &str| -> Option<String> {
        db.get_setting(k).ok().flatten().filter(|s| !s.trim().is_empty())
    };

    let api_key = setting("llm_api_key")
        .or_else(|| std::env::var("LLM_API_KEY").ok().filter(|s| !s.is_empty()))
        .unwrap_or_default();
    let model = setting("llm_model")
        .or_else(|| std::env::var("LLM_MODEL").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "gpt-4o-mini".to_string());

    // `compatible` means the user supplied an explicit base URL; every other
    // provider maps through the shared provider table.
    let provider = setting("llm_provider").unwrap_or_else(|| "openai".to_string());
    let mut base_url = if provider == "compatible" {
        setting("llm_base_url")
            .or_else(|| std::env::var("LLM_BASE_URL").ok().filter(|s| !s.is_empty()))
            .unwrap_or_default()
    } else {
        llm::provider_base_url(&provider).to_string()
    };
    base_url = base_url.trim_end_matches('/').to_string();
    if base_url.is_empty() {
        base_url = "https://api.openai.com/v1".to_string();
    }

    Ok(LlmConfig { api_key, model, base_url })
}

/// `POST /summarize` — stream meeting minutes as SSE.
///
/// Mirrors `api/transcription.py::summarize`:
///   1. `transcript` from the body, else loaded from the meeting row.
///   2. Flatten a JSON-array transcript into `Speaker: text` lines.
///   3. Stream `progress` / `chunk` / `done` / `error` frames.
///
/// Validation failures return Python's exact JSON error bodies (400/404)
/// rather than an SSE `error` frame, because Python raised them before the
/// StreamingResponse was constructed.
pub async fn summarize(State(state): State<AppState>, body: Option<Json<Value>>) -> Response {
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let req = SummarizeRequest::from_json(&body);

    // Resolve the transcript: explicit body value wins, else the stored one.
    let transcript = match req.transcript.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => {
            let Some(mid) = req.meeting_id else {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "No meetingId or transcript provided",
                );
            };
            match state.db().get_meeting(mid) {
                Ok(Some(m)) => m
                    .get("transcript")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                Ok(None) => return json_error(StatusCode::NOT_FOUND, "Meeting not found"),
                Err(e) => return internal_error(&e),
            }
        }
    };

    if transcript.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Transcript is empty");
    }

    let transcript = flatten_transcript(&transcript);

    let cfg = match resolve_llm_config(&state) {
        Ok(c) => c,
        Err(e) => return internal_error(&e),
    };

    // No key: Python emitted this as an SSE `error` frame from inside the
    // generator (so the status was already 200). Keep that shape — the
    // frontend's onErrorEvent shows it as "Cannot create minutes: ...".
    if cfg.api_key.is_empty() {
        return sse_single(SseEvent::new("error", json!({ "error": "LLM API key not set" })));
    }

    let reference_context = load_reference_context(&state, req.meeting_id);
    let time_context = build_time_context(&req.start_time, &req.end_time);

    // Python raised attachment importance at the SYSTEM level too, because the
    // user-content block alone was not enough — the model treated it as
    // conversational data and skimmed it. Only added when attachments exist.
    let reference_system_note = reference_system_note(&reference_context);

    let ctx = llm::SummaryContext {
        time_context,
        reference_context,
        reference_system_note,
    };

    spawn_sse(move |tx| {
        Box::pin(async move {
            // `emit` must stay synchronous (llm::summarize_stream takes
            // `FnMut`). It pushes onto an unbounded relay — never blocks, keeps
            // order — and a forwarder task feeds the bounded SSE channel with
            // `send().await`. (The old `blocking_send` fallback panics: this
            // closure runs on an async worker thread.)
            let closed_emit = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let closed_emit_inner = closed_emit.clone();
            let err_tx = tx.clone();
            let (relay_tx, mut relay_rx) = mpsc::unbounded_channel::<String>();
            let closed_fwd = closed_emit.clone();
            let forwarder = tokio::spawn(async move {
                while let Some(wire) = relay_rx.recv().await {
                    if tx.send(Ok(wire)).await.is_err() {
                        closed_fwd.store(true, std::sync::atomic::Ordering::Relaxed);
                        break;
                    }
                }
            });

            let emit = move |ev: SseEvent| {
                if closed_emit_inner.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                if relay_tx.send(ev.to_wire()).is_err() {
                    closed_emit_inner.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            };

            // `llm::summarize_stream_with_context` emits chunk/progress/done/
            // error itself and injects the time + reference blocks around the
            // transcript. A transport-level failure is reported as an `error`
            // frame so the UI shows the reason instead of an empty summary.
            let result = llm::summarize_stream_with_context(
                &cfg,
                &transcript,
                &req.language,
                &req.template,
                &req.custom_prompt,
                ctx,
                emit,
            )
            .await;
            // `emit` (the relay sender) is gone now: flush the queue first so
            // an error frame lands after the last token.
            let _ = forwarder.await;
            if let Err(e) = result {
                log::error!("[summarize] stream failed: {e}");
                let _ = err_tx
                    .send(Ok(SseEvent::new("error", json!({ "error": e })).to_wire()))
                    .await;
            }
        })
    })
}

/// System-level reminder that attachments are authoritative, or "" when there
/// is no reference block. Shared with the upload pipeline's auto-summary.
pub(crate) fn reference_system_note(reference_context: &str) -> String {
    if reference_context.is_empty() {
        return String::new();
    }
    "\n\nCRITICAL: The user attached REFERENCE MATERIALS (documents) \
     to this meeting. Those documents are authoritative context — \
     use them to correct mistranscribed names, ground the minutes \
     in project-specific terminology, and cross-check what was \
     discussed vs. what was planned. Treat them with at least the \
     same weight as the transcript when they contradict it."
        .to_string()
}

/// Build the reference-materials block from stored attachments.
///
/// Mirrors `summarize.py`: the block is injected at the user-content layer with
/// strongly action-oriented framing (an earlier softer wording made the model
/// skim the documents and produce minutes identical to a run without them).
pub(crate) fn load_reference_context(state: &AppState, meeting_id: Option<i64>) -> String {
    let Some(mid) = meeting_id else {
        return String::new();
    };
    let combined = match state.db().get_attachments_combined_text(mid) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("[summarize] failed to load attachments for {mid}: {e}");
            return String::new();
        }
    };
    if combined.trim().is_empty() {
        return String::new();
    }
    log::info!(
        "[summarize] including {} chars of reference materials for meeting {mid}",
        combined.len()
    );
    format!(
        "\n\n=== REFERENCE MATERIALS (USE THESE) ===\n\
         The user attached the following document(s) as REQUIRED CONTEXT for \
         this meeting. You MUST:\n\
         \x20 1. Use names, titles, terminology, project codes from these docs \
         as the source of truth (transcripts often mistranscribe proper nouns).\n\
         \x20 2. Cross-reference the meeting against agendas / briefs / specs — \
         note which items WERE covered and which were SKIPPED.\n\
         \x20 3. When the meeting decision differs from what the doc proposed, \
         call it out explicitly (e.g. 'agenda đề xuất X, cuộc họp chốt Y').\n\
         \x20 4. Pull in background details (deadlines, prior decisions, \
         stakeholders) that clarify what was said in the meeting.\n\
         \x20 5. At the END of the minutes, add a short section \
         '## Tài liệu tham khảo / Reference Materials' listing the file \
         names you used.\n\n\
         Do NOT copy long passages verbatim, but DO weave the information \
         throughout the minutes wherever it adds value.\n\n\
         {combined}\n\
         === END REFERENCE MATERIALS ===\n"
    )
}

/// `--- Meeting Time Info ---` block, verbatim from `summarize.py`.
fn build_time_context(start_time: &str, end_time: &str) -> String {
    if start_time.is_empty() && end_time.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n\n--- Meeting Time Info ---\n");
    if !start_time.is_empty() {
        out.push_str(&format!("Recording started: {start_time}\n"));
    }
    if !end_time.is_empty() {
        out.push_str(&format!("Recording ended: {end_time}\n"));
    }
    out.push_str("---\n");
    out
}

// ─── POST /transcribe-diarize ───

/// `POST /transcribe-diarize` — transcribe an uploaded audio chunk and assign
/// it one stable speaker.
///
/// Port of `api/transcription.py::transcribe_diarize`. NOTE the Python version
/// decoded ONLY from the upload (sherpa offline on the whole file, plus
/// `identify_speaker`) — the ffmpeg/VAD chunking lives in the upload *pipeline*
/// (`/meetings/upload-audio`), not here. This route is the low-latency
/// per-chunk path the recorder uses, so it stays a single decode of the posted
/// bytes with no chunk splitting.
///
/// Ollama/local-model notes: the response shape is the frontend contract —
/// `{text, chunk_id, segments[], speakers}` — and an empty transcript returns
/// `{"text":"","segments":[],"speakers":N}` rather than an error, so the
/// recorder simply appends nothing.
pub async fn transcribe_diarize(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Response {
    // Read the uploaded chunk. Python accepted a single `audio` UploadFile and
    // sniffed RIFF vs webm from the first four bytes.
    let mut payload: Vec<u8> = Vec::new();
    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => match field.bytes().await {
                Ok(b) => {
                    payload = b.to_vec();
                    break;
                }
                Err(e) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({ "error": format!("multipart read: {e}") })),
                    )
                        .into_response()
                }
            },
            Ok(None) => break,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("multipart: {e}") })),
                )
                    .into_response()
            }
        }
    }

    if payload.is_empty() {
        return Json(json!({ "text": "", "segments": [], "speakers": 0 })).into_response();
    }

    let suffix = if payload.starts_with(b"RIFF") { "wav" } else { "webm" };
    let tmp_dir = std::env::temp_dir();
    let tmp_path = tmp_dir.join(format!(
        "voicescribe_chunk_{}_{}.{suffix}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    if let Err(e) = tokio::fs::write(&tmp_path, &payload).await {
        return internal_error(&format!("write temp chunk: {e}"));
    }

    let language = state
        .db()
        .get_setting("stt_language")
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "vi".to_string());

    // STT + diarize both read the same temp file. The Rust engines are
    // synchronous and share global model caches, so they run on a blocking
    // thread to keep the async runtime free.
    let stt_path = tmp_path.clone();
    let diar_path = tmp_path.clone();
    let stt_lang = language.clone();

    let text = match tokio::task::spawn_blocking(move || {
        transcribe_chunk_file(&stt_path, &stt_lang)
    })
    .await
    {
        Ok(Ok(t)) => t,
        Ok(Err(e)) => {
            log::warn!("[transcribe-diarize] STT error: {e}");
            String::new()
        }
        Err(e) => {
            log::warn!("[transcribe-diarize] STT task panicked: {e}");
            String::new()
        }
    };

    let identify = tokio::task::spawn_blocking(move || identify_speaker(&diar_path)).await;
    let (speaker, speaker_id, speaker_count) = match identify {
        Ok(Ok(info)) => info,
        Ok(Err(e)) => {
            log::warn!("[transcribe-diarize] diarize error: {e}");
            ("Speaker 1".to_string(), 0usize, 0usize)
        }
        Err(e) => {
            log::warn!("[transcribe-diarize] diarize task panicked: {e}");
            ("Speaker 1".to_string(), 0usize, 0usize)
        }
    };

    let _ = tokio::fs::remove_file(&tmp_path).await;

    let text = filter_hallucinations(&text);
    if text.trim().is_empty() {
        return Json(json!({
            "text": "",
            "segments": [],
            "speakers": speaker_count,
        }))
        .into_response();
    }

    let text = text.trim().to_string();
    let chunk_id = format!(
        "chunk-{}-{}",
        chrono_millis(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );

    Json(json!({
        "text": text,
        "chunk_id": chunk_id,
        "segments": [{
            "speaker": speaker,
            "speaker_id": speaker_id,
            "chunk_id": chunk_id,
            "text": text,
        }],
        "speakers": speaker_count,
    }))
    .into_response()
}

/// Unix milliseconds, matching Python's `int(time.time() * 1000)`.
fn chrono_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Transcribe a chunk file. WAV goes through the offline engine directly;
/// webm/opus is decoded to WAV with ffmpeg first (the engine takes PCM).
fn transcribe_chunk_file(path: &std::path::Path, language: &str) -> Result<String, String> {
    let is_wav = path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("wav"))
        .unwrap_or(false);
    if is_wav {
        return crate::stt::local::transcribe_wav_file(path, language);
    }
    let wav = path.with_extension("decoded.wav");
    let rt = tokio::runtime::Handle::current();
    rt.block_on(async {
        crate::pipeline::normalize_to_wav(path, &wav).await?;
        let out = crate::stt::local::transcribe_wav_file(&wav, language);
        let _ = tokio::fs::remove_file(&wav).await;
        out
    })
}

/// Identify the dominant speaker in a chunk.
///
/// The Rust diarizer is stateless — there are no accumulated profiles to count,
/// unlike Python's `_diarizer._profiles` — so the reported speaker count is the
/// number of distinct speakers found in THIS chunk (0 or 1). The frontend only
/// uses it as a "how many voices so far" hint, and the recorder's own
/// transcript parts are what actually carry speaker identity.
fn identify_speaker(path: &std::path::Path) -> Result<(String, usize, usize), String> {
    let Some(model) = crate::diarize::default_model_path() else {
        return Err("diarizer model not available".to_string());
    };
    // Diarization needs 16 kHz mono; decode anything else first.
    let wav = if crate::pipeline::wav_total_ms(path).is_ok() {
        path.to_path_buf()
    } else {
        let target = path.with_extension("diar.wav");
        let rt = tokio::runtime::Handle::current();
        rt.block_on(crate::pipeline::normalize_to_wav(path, &target))?;
        target
    };

    let result = crate::diarize::diarize_fine_windows(
        &wav,
        &model,
        crate::diarize::FINE_WINDOW_MS,
        crate::diarize::DEFAULT_DISTANCE_THRESHOLD,
        crate::diarize::FINE_SILENCE_RMS,
    )?;

    let distinct: std::collections::HashSet<usize> =
        result.timeline.iter().map(|s| s.speaker_id).collect();
    Ok(("Speaker 1".to_string(), 0, distinct.len()))
}

/// Drop known STT hallucination artefacts and sub-4-character noise.
///
/// Mirrors `api/transcription.py::filter_hallucinations`, which tested each
/// pattern from `stt.HALLUCINATION_PATTERNS` case-insensitively and then
/// rejected anything of 3 characters or fewer (breath noise the model
/// transcribes as a stray syllable).
fn filter_hallucinations(text: &str) -> String {
    for pattern in crate::stt::text::HALLUCINATION_PATTERNS {
        if let Ok(re) = regex::Regex::new(&format!("(?i){pattern}")) {
            if re.is_match(text) {
                return String::new();
            }
        }
    }
    if text.trim().chars().count() <= 3 {
        return String::new();
    }
    text.to_string()
}

// ─── Audio serving helpers (shared with meetings.rs) ───

/// Resolve the stored audio file for a meeting.
///
/// Mirrors `api/meetings.py::_resolve_audio_source`: the `audio_path` column
/// wins when it points at a real file, otherwise fall back to the legacy
/// `audio/meeting_{id}.<ext>` layout, and heal `audio_path` when the fallback
/// hits so later requests skip the scan.
pub(crate) fn resolve_audio_source(
    state: &AppState,
    meeting_id: i64,
) -> Result<Option<std::path::PathBuf>, String> {
    let meeting = state.db().get_meeting(meeting_id)?;
    let audio_path = meeting
        .as_ref()
        .and_then(|m| m.get("audio_path"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if !audio_path.is_empty() {
        let p = std::path::PathBuf::from(&audio_path);
        if p.is_file() {
            return Ok(Some(p));
        }
    }

    let audio_dir = state.db().data_dir().join("audio");
    for ext in [".wav", ".mp4", ".m4a", ".mp3", ".webm", ".pcm"] {
        let candidate = audio_dir.join(format!("meeting_{meeting_id}{ext}"));
        if candidate.is_file() {
            if meeting.is_some() {
                let mut upd = serde_json::Map::new();
                upd.insert(
                    "audio_path".to_string(),
                    Value::String(candidate.to_string_lossy().to_string()),
                );
                if let Err(e) = state.db().update_meeting(meeting_id, &upd) {
                    log::warn!("[meetings] could not persist audio_path for {meeting_id}: {e}");
                }
            }
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// MIME type for an audio extension — mirrors `services/audio.py::audio_media_type`.
pub(crate) fn audio_media_type(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        ".wav" => "audio/wav",
        ".mp4" => "audio/mp4",
        ".mp3" => "audio/mpeg",
        ".m4a" => "audio/mp4",
        ".webm" => "audio/webm",
        ".pcm" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

/// Wrap raw header value creation so an odd filename cannot abort a response.
pub(crate) fn header_value(s: &str) -> HeaderValue {
    HeaderValue::from_str(s).unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

/// Extract a byte range from a `Range: bytes=start-end` header.
///
/// Returns `None` for an absent or unparseable header (caller serves 200 with
/// the whole body, which is what FileResponse did). Returns `Some(Err(()))`
/// for a syntactically valid but unsatisfiable range so the caller can answer
/// 416, matching Starlette's FileResponse behaviour.
pub(crate) fn parse_range(headers: &HeaderMap, len: u64) -> Option<Result<(u64, u64), ()>> {
    let raw = headers.get(header::RANGE)?.to_str().ok()?;
    let spec = raw.strip_prefix("bytes=")?.trim();
    // Only a single range is supported — that is all an <audio> element sends.
    let (start_s, end_s) = spec.split_once('-')?;

    let (start, end) = if start_s.is_empty() {
        // Suffix form: `bytes=-N` => last N bytes.
        let n: u64 = end_s.trim().parse().ok()?;
        if n == 0 {
            return Some(Err(()));
        }
        (len.saturating_sub(n), len.saturating_sub(1))
    } else {
        let start: u64 = start_s.trim().parse().ok()?;
        let end = if end_s.trim().is_empty() {
            len.saturating_sub(1)
        } else {
            end_s.trim().parse::<u64>().ok()?.min(len.saturating_sub(1))
        };
        (start, end)
    };

    if len == 0 || start > end || start >= len {
        return Some(Err(()));
    }
    Some(Ok((start, end)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flatten_structured_transcript_to_speaker_lines() {
        let raw = r#"[{"speaker":"Speaker 1","text":"xin chào"},{"speaker":"Speaker 2","text":"chào bạn"}]"#;
        assert_eq!(
            flatten_transcript(raw),
            "Speaker 1: xin chào\nSpeaker 2: chào bạn"
        );
    }

    #[test]
    fn flatten_keeps_plain_text_untouched() {
        assert_eq!(flatten_transcript("  dòng một\ndòng hai  "), "dòng một\ndòng hai");
    }

    /// A JSON array whose parts carry no usable text must survive verbatim —
    /// Python fell through to the original string rather than sending "".
    #[test]
    fn flatten_keeps_original_when_no_text_survives() {
        let raw = r#"[{"speaker":"Speaker 1","text":"   "}]"#;
        assert_eq!(flatten_transcript(raw), raw);
    }

    /// Malformed JSON behind a leading `[` must not panic or empty the prompt.
    #[test]
    fn flatten_tolerates_malformed_json() {
        let raw = "[not json at all";
        assert_eq!(flatten_transcript(raw), raw);
    }

    #[test]
    fn time_context_matches_python_layout() {
        let ctx = build_time_context("2026-01-01 10:00", "2026-01-01 11:00");
        assert_eq!(
            ctx,
            "\n\n--- Meeting Time Info ---\nRecording started: 2026-01-01 10:00\nRecording ended: 2026-01-01 11:00\n---\n"
        );
        assert_eq!(build_time_context("", ""), "");
    }

    #[test]
    fn audio_media_types_match_python_table() {
        assert_eq!(audio_media_type(".wav"), "audio/wav");
        assert_eq!(audio_media_type(".M4A"), "audio/mp4");
        assert_eq!(audio_media_type(".pcm"), "application/octet-stream");
        assert_eq!(audio_media_type(".unknown"), "application/octet-stream");
    }

    #[test]
    fn range_parsing_covers_the_shapes_an_audio_element_sends() {
        let mk = |v: &str| {
            let mut h = HeaderMap::new();
            h.insert(header::RANGE, HeaderValue::from_str(v).unwrap());
            h
        };
        assert_eq!(parse_range(&mk("bytes=0-99"), 1000), Some(Ok((0, 99))));
        assert_eq!(parse_range(&mk("bytes=500-"), 1000), Some(Ok((500, 999))));
        assert_eq!(parse_range(&mk("bytes=-100"), 1000), Some(Ok((900, 999))));
        // End past EOF clamps to the last byte.
        assert_eq!(parse_range(&mk("bytes=0-99999"), 1000), Some(Ok((0, 999))));
        // Unsatisfiable start.
        assert_eq!(parse_range(&mk("bytes=1000-"), 1000), Some(Err(())));
        // No header at all -> whole body.
        assert_eq!(parse_range(&HeaderMap::new(), 1000), None);
    }
}
