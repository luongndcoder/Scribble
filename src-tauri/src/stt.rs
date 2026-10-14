//! STT module — Soniox (cloud, WebSocket) + Local (offline, sherpa-onnx).
//!
//! Rust port of the Python sidecar's STT layer:
//!   - `src-python/stt.py`       → [`soniox`] (Soniox realtime client) + [`text`]
//!   - `src-python/local_stt.py` → [`local`] (sherpa-onnx streaming/offline)
//!
//! Nvidia/Riva is intentionally NOT ported — it was removed from the product.
//! The only two providers are **Soniox** (cloud) and **Local** (bundled
//! sherpa-onnx model), matching the frontend's provider selector.
//!
//! WebSocket routes (mounted by the axum server in `lib.rs`):
//!   - `GET /ws/local-stream`   — client sends binary PCM s16le (16kHz mono),
//!     server replies with `{text, is_final}` JSON.
//!   - `GET /ws/soniox-stream`  — query params `api_key`, `lang`, `translate`;
//!     binary PCM in, segment JSON out.
//!
//! # Verification status (2026-10-09)
//!
//! Measured against the Python sidecar on the real 6.7-minute Vietnamese
//! meeting recording `/tmp/sale_campaign.wav`:
//!
//! | Path | Result |
//! |---|---|
//! | `/ws/local-stream` | 30 finals, **byte-identical** to Python; 0 bytes lost on the wire |
//! | `text` pipeline | 41/41 cases byte-identical to Python |
//! | `SherpaOfflineEngine` | byte-identical to Python, ~83x realtime |
//! | `/ws/soniox-stream` | live API: speaker histogram matches Python, text identical at all 239 shared timestamp ticks |
//!
//! Reproduction:
//! ```text
//! cargo test --test stt_text_parity                        # offline parity
//! cargo test --test stt_local_stream -- --ignored          # real audio over WS
//! cargo test --test stt_offline      -- --ignored          # offline file path
//! cargo test --test soniox_live      -- --ignored          # live Soniox (needs API key)
//! ```
//!
//! # Two traps this module had to work around
//!
//! 1. **Never drop an event from the local-stream worker.** The recognizer runs
//!    with `enable_endpoint = true`, so the event most likely to be dropped by a
//!    non-blocking send is an utterance FINAL — after which the worker resets and
//!    that utterance is unrecoverable. A `try_send` revision of this file emitted
//!    4 of Python's 30 finals. See [`handle_local_stream`].
//! 2. **Soniox sends `"speaker"` as a JSON string.** `serde_json`'s `as_i64()`
//!    returns `None` for `"1"`, which silently pins every token to speaker 0 and
//!    destroys speaker-change detection. See [`soniox::parse_speaker_id`].

pub mod live_diarize;
pub mod speaker_segments;
pub mod speaker_tracker;
pub mod local;
pub mod model_download;
#[cfg(all(target_os = "macos", feature = "mlx"))]
pub mod nemotron_mlx;
pub mod soniox;
pub mod soniox_async;
pub mod text;

pub use local::{
    clear_engine_caches, get_offline_engine, get_stream_engine, offline_model_dir,
    streaming_model_dir, transcribe_wav_file, LocalStreamingStt, SherpaOfflineEngine,
    StreamingZipformerEngine, FRAME_BYTES, FRAME_SAMPLES,
};
pub use soniox::{run_soniox_session, SonioxConfig, SonioxSegment, SONIOX_RT_URL};
pub use text::*;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

pub const SAMPLE_RATE: i32 = 16000;

/// Bytes of PCM that reached the `/ws/local-stream` handler in this process.
/// Instrumentation for the real-audio verification harness.
pub static STT_WS_STATS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Result payload for the local streaming path (matches the Python `_out` dict
/// shape used by the frontend: `{"text": ..., "is_final": ...}`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SttEvent {
    pub text: String,
    pub is_final: bool,
    /// Speaker label (`Speaker 1`, ...). The frontend renders this in the
    /// transcript and groups consecutive segments by `speaker_id`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker_id: Option<i64>,
    /// Stable id of one utterance (finals only). Lets the frontend target a
    /// segment later (speaker correction, translation) like Soniox chunks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_id: Option<String>,
    /// Utterance offsets from stream start, so transcript timestamps are the
    /// audio truth instead of the UI timer minus a guess.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<i64>,
    /// Present only on fatal errors (`{"type":"error","message":...}`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub msg_type: Option<String>,
    /// Error text in the field the frontend actually checks (`data.error`).
    /// `message`/`type` alone were invisible to it, so a failed model load
    /// left the UI stuck on "connecting" with no explanation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Fatal: the stream is dead, the frontend must stop recording.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<bool>,
}

impl SttEvent {
    pub fn partial(text: String) -> Self {
        Self {
            text,
            is_final: false,
            ..Default::default()
        }
    }
    pub fn final_text(text: String) -> Self {
        Self {
            text,
            is_final: true,
            ..Default::default()
        }
    }
    /// A final segment carrying the diarizer's verdict.
    pub fn final_with_speaker(text: String, speaker: String, speaker_id: i64) -> Self {
        Self {
            text,
            is_final: true,
            speaker: Some(speaker),
            speaker_id: Some(speaker_id),
            ..Default::default()
        }
    }
    /// Emitted when the diarizer confirms a new speaker, right BEFORE that
    /// speaker's final, so the UI starts a new paragraph at the right place.
    pub fn speaker_split(speaker: String, speaker_id: i64) -> Self {
        Self {
            speaker: Some(speaker),
            speaker_id: Some(speaker_id),
            msg_type: Some("speaker_split".to_string()),
            ..Default::default()
        }
    }
    pub fn error(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            is_final: true,
            error: Some(message.clone()),
            terminal: Some(true),
            message: Some(message),
            msg_type: Some("error".to_string()),
            ..Default::default()
        }
    }
}

/// Mount the STT WebSocket routes.
pub fn router() -> Router {
    Router::new()
        .route("/ws/local-stream", get(ws_local_stream))
        .route("/ws/soniox-stream", get(ws_soniox_stream))
}

// ── /ws/local-stream ─────────────────────────────────────────────────────────

/// `GET /ws/local-stream[?lang=vi]`
///
/// The client streams raw 16-bit little-endian PCM (16kHz, mono) as binary
/// frames; the server streams back `{text, is_final}` JSON. Endpointing is done
/// by sherpa's `OnlineRecognizer`, so a final is emitted on each detected
/// endpoint, plus one last flush when the client stops.
pub async fn ws_local_stream(
    ws: WebSocketUpgrade,
    Query(params): Query<LocalStreamParams>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_local_stream(socket, params))
}

#[derive(Debug, Deserialize, Default)]
pub struct LocalStreamParams {
    /// Language hint, e.g. `vi`. Defaults to `vi` like the Python sidecar.
    #[serde(default)]
    pub lang: Option<String>,
    /// Target language for the live bilingual column (e.g. `en`). Empty = off.
    ///
    /// ACCEPTED BUT NOT ACTED ON — Local mode does not translate yet.
    ///
    /// History: the Python sidecar translated live text with Nvidia Riva NMT.
    /// That went away with Riva, so this param has no implementation. Two
    /// replacements were evaluated and both set aside by the user:
    ///   - LLM per segment: ~200 requests per meeting (large token cost) at
    ///     1-3s each, falling further behind the longer someone talks.
    ///   - Google's unofficial endpoint: technically free and fast, but it is
    ///     undocumented, can be blocked or IP-limited without notice, and its
    ///     use breaches Google's terms — not shippable in a distributed app.
    /// The right answer when this is picked up again is an offline NMT model
    /// (e.g. Helsinki-NLP/opus-mt-vi-en, Apache-2.0) via ONNX, mirroring how
    /// STT and speaker embedding already work. Declared now so the query the
    /// frontend sends is not silently dropped.
    #[serde(default, alias = "translate")]
    pub translate_lang: Option<String>,
    /// Explicit model dir override (packaged builds).
    #[serde(default)]
    pub model_dir: Option<String>,
    /// `system` for native system-audio capture (Tauri). With `meeting_id`
    /// the received PCM is archived as the meeting's audio (`audio_archive`).
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub meeting_id: Option<i64>,
}

async fn handle_local_stream(socket: WebSocket, params: LocalStreamParams) {
    let (params_source, params_meeting_id) = (params.source.clone(), params.meeting_id);
    // Engine choice (Settings → Local): bundled Zipformer (Vietnamese) or the
    // downloadable multilingual Nemotron. Nemotron also honours the saved
    // recognition language (`auto` = its own language detection).
    let use_nemotron = db_setting("local_engine").as_deref() == Some("nemotron");
    let language = params.lang.unwrap_or_else(|| {
        if use_nemotron {
            db_setting("stt_language").unwrap_or_else(|| "vi".to_string())
        } else {
            "vi".to_string()
        }
    });
    // Live translation target (empty = off).
    //
    // NOT YET IMPLEMENTED for Local mode. The param is accepted so the query
    // string the frontend already sends is not silently dropped, and so the
    // eventual implementation has somewhere to read it from — but no
    // translation is produced.
    //
    // DO NOT implement this with an LLM call per segment. That was tried and
    // rejected: a 1-hour meeting is ~200 segments, so it means ~200 requests
    // carrying the full system prompt each (huge token cost) with 1-3s latency
    // per call, which falls further behind as the speaker keeps talking. The
    // Python sidecar used Riva NMT — a dedicated translation model — for
    // exactly this reason. The correct replacement is an offline NMT model
    // (e.g. Helsinki-NLP/opus-mt-vi-en, Apache-2.0) run through ONNX, the same
    // way STT and speaker embedding already work.
    let _translate_lang = params
        .translate_lang
        .as_deref()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let (mut sink, mut stream) = socket.split();

    let resolved = match params.model_dir {
        Some(dir) => Some(std::path::PathBuf::from(dir)),
        None if use_nemotron => model_download::nemotron_model_dir(),
        None => streaming_model_dir(),
    };
    let model_dir = match resolved {
        Some(dir) => dir,
        None => {
            let msg = if use_nemotron {
                "Model Nemotron chưa được tải — vào Cài đặt → Giọng nói → Local để tải, hoặc chọn Zipformer."
            } else {
                "Model local chưa sẵn sàng — cài lại app hoặc tải model offline."
            };
            let _ = sink
                .send(Message::Text(
                    serde_json::to_string(&SttEvent::error(msg)).unwrap_or_default().into(),
                ))
                .await;
            return;
        }
    };

    // Bridge the engine's worker thread (sync callback) to the async WS sink.
    //
    // IMPORTANT (regression found 2026-10-09): this must be a BLOCKING send.
    // With `try_send` on a bounded channel the worker thread *drops* events
    // whenever the async writer is momentarily behind — and because the
    // recognizer is opened with `enable_endpoint = true`, the drop that matters
    // is an endpoint FINAL: the worker then resets the stream and that whole
    // utterance is gone forever. A try_send run over the 6.7min meeting stopped
    // after 4 of the 30 finals Python produced. The recognizer lives inside the
    // worker thread, so blocking it is exactly the backpressure we want.
    //
    // Live speaker tracking runs beside the recognizer on its own thread and
    // publishes a `sample -> speaker` timeline; the STT worker labels every
    // token from it (per-token, like Soniox). `None` = no speaker model, all
    // text is "Speaker 1".
    live_diarize::warm_up();
    let tracker = speaker_tracker::SpeakerTracker::start(live_diarize::session_profiles());
    let timeline = tracker.as_ref().map(|t| t.timeline());

    let (evt_tx, mut evt_rx) = mpsc::channel::<SttEvent>(8);
    let engine = {
        let lang = language.clone();
        // Loading the model is CPU-bound (~1s) — keep it off the async runtime.
        // The engine + its worker thread are joined before this handler returns
        // (see `run_join` below): sherpa/onnxruntime sessions must not be
        // destroyed from an arbitrary runtime thread at process exit, which
        // aborts the process ("Rust cannot catch foreign exceptions").
        let dir = model_dir.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let run_join = std::thread::Builder::new()
            .name("local-stt-run".to_string())
            .spawn(move || {
                let engine = LocalStreamingStt::start(&dir, &lang, timeline, move |evt| {
                    let _ = evt_tx.blocking_send(evt);
                });
                let _ = ready_tx.send(engine);
            })
            .ok();
        let engine = ready_rx.await.ok().flatten();
        match (&engine, run_join) {
            // Success: park the thread so `shutdown_stt_workers()` can join it
            // at teardown (never drop the ONNX session on a runtime thread).
            (Some(_), Some(h)) => park_engine_thread(h),
            // Model load failed: the worker exits on its own.
            (_, Some(h)) => {
                let _ = h.join();
            }
            _ => {}
        }
        engine
    };

    let Some(engine) = engine else {
        let _ = sink
            .send(Message::Text(
                serde_json::to_string(&SttEvent::error(
                    "Không khởi tạo được sherpa-onnx OnlineRecognizer cho model local.",
                ))
                .unwrap_or_default()
                .into(),
            ))
            .await;
        return;
    };

    // Writer task: forward engine events (already speaker-labelled by the
    // worker) to the socket.
    //
    // It ends on its own once the engine worker has drained and dropped its
    // sender — that is what lets a stop deliver the last utterance. (A
    // separate close signal used to race the drain inside `select!` and could
    // discard finals still queued at teardown.)
    //
    // History: speaker verdicts used to be computed HERE, once per utterance
    // at its endpoint, which made every final wait up to 2.5s and could not
    // see a speaker change inside an utterance. See `speaker_tracker`.
    let writer = tokio::spawn(async move {
        while let Some(e) = evt_rx.recv().await {
            let payload = serde_json::to_string(&e).unwrap_or_default();
            if sink.send(Message::Text(payload.into())).await.is_err() {
                return;
            }
        }
        // Engine fully drained — tell the client the stream is complete so a
        // stopping frontend can stop waiting instead of hitting its timeout.
        let _ = sink.send(Message::Close(None)).await;
    });

    // Instrumentation: count what actually reached the handler so a
    // sender/receiver accounting mismatch is visible instead of silent.
    let fed_frames = std::sync::atomic::AtomicUsize::new(0);
    let fed_bytes = std::sync::atomic::AtomicUsize::new(0);

    let mut archive = open_system_archive(params_source.as_deref(), params_meeting_id);

    // Reader loop: PCM in. An empty binary frame means "flush/finish".
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Binary(bytes) => {
                if bytes.is_empty() {
                    break;
                }
                fed_frames.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                fed_bytes.fetch_add(bytes.len(), std::sync::atomic::Ordering::Relaxed);
                // Feed the speaker tracker FIRST so speaker-turn / silence-valley
                // analysis runs ahead of STT token grouping.
                if let Some(t) = &tracker {
                    t.feed(live_diarize::pcm16_to_f32(&bytes));
                }
                if let Some(a) = archive.as_mut() {
                    a.write(&bytes);
                }
                engine.feed_audio(&bytes);
            }
            Message::Text(t) => {
                // JSON control frame: {"type":"stop"} ends the stream.
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
                    if ty == "stop" || ty == "flush" {
                        break;
                    }
                }
            }
            Message::Close(_) => {
                break;
            }
            _ => {}
        }
    }

    // Teardown. `engine.stop()` is idempotent (it sends the flush marker and the
    // `None` sentinel only once — see `LocalStreamingStt::stop`), and the worker
    // drains every already-queued 20ms frame plus the flush before it breaks.
    //
    // Regression found 2026-10-09: an earlier revision waited a fixed 400ms and
    // then aborted the writer, so whenever the decoder was behind (fast-paced
    // feeds) the remaining audio was discarded and the run ended mid-transcript
    // (4-26 of the 30 finals the Python engine yields). We now wait for the
    // writer to finish naturally, which only happens once the worker has dropped
    // the sender — i.e. the engine is fully drained.
    //
    // Settle the speaker timeline BEFORE the engine's final flush, so the last
    // words are labelled from all the audio rather than from a provisional
    // guess. `finish` joins an OS thread, so keep it off the async runtime.
    if let Some(t) = tracker {
        let _ = tokio::task::spawn_blocking(move || t.finish()).await;
    }
    engine.stop();
    // Bounded safety net in case the worker never drains.
    let mut writer = writer;
    if tokio::time::timeout(std::time::Duration::from_secs(10), &mut writer)
        .await
        .is_err()
    {
        writer.abort();
    }

    let fed_frames = fed_frames.load(std::sync::atomic::Ordering::Relaxed);
    let fed_bytes = fed_bytes.load(std::sync::atomic::Ordering::Relaxed);
    eprintln!("[local-stream] ws_frames_in={fed_frames} ws_bytes_in={fed_bytes}");
    STT_WS_STATS.store(fed_bytes, std::sync::atomic::Ordering::Relaxed);
}

/// A model-owning worker thread that must be joined before the process exits.
///
/// onnxruntime aborts the process ("Rust cannot catch foreign exceptions") if a
/// session is destroyed from a thread it does not like — e.g. a tokio runtime
/// worker at process teardown. Idle threads are collected here by joining them,
/// which also guarantees the session is dropped on a plain OS thread.
static IDLE_ENGINE_THREADS: std::sync::Mutex<Vec<std::thread::JoinHandle<()>>> =
    std::sync::Mutex::new(Vec::new());

/// Park a finished model-owning thread; its next caller joins it and takes the
/// recognizer with it. Bounded so a long-lived server cannot leak handles.
pub(crate) fn park_engine_thread(handle: std::thread::JoinHandle<()>) {
    let mut g = match IDLE_ENGINE_THREADS.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    g.push(handle);
    // Keep at most one recognizer parked (sherpa caches per model dir anyway).
    while g.len() > 1 {
        if let Some(old) = g.pop() {
            let _ = old.join();
        }
    }
}

/// Join every parked model-owning thread. Call once during shutdown.
pub fn shutdown_stt_workers() {
    let handles: Vec<std::thread::JoinHandle<()>> = match IDLE_ENGINE_THREADS.lock() {
        Ok(mut g) => std::mem::take(&mut *g),
        Err(p) => std::mem::take(&mut p.into_inner()),
    };
    for h in handles {
        let _ = h.join();
    }
    // Sessions are released here, on the calling thread, while it is still safe
    // to do so — not by a static destructor at process exit.
    local::clear_engine_caches();
}

// ── /ws/soniox-stream ────────────────────────────────────────────────────────

/// `GET /ws/soniox-stream?api_key=...&lang=vi&translate=en`
///
/// The client streams raw PCM s16le (16kHz, mono) as binary frames; the server
/// forwards segments (with speaker + timing) as JSON. An empty binary frame or
/// `{"type":"stop"}` ends the session.
pub async fn ws_soniox_stream(
    ws: WebSocketUpgrade,
    Query(params): Query<SonioxStreamParams>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_soniox_stream(socket, params))
}

#[derive(Debug, Deserialize, Default)]
pub struct SonioxStreamParams {
    #[serde(default)]
    pub api_key: Option<String>,
    /// Space or comma separated language hints, e.g. `vi` or `vi,en`.
    #[serde(default)]
    pub lang: Option<String>,
    /// The frontend and the system-audio client send `translate_lang` (the
    /// Python contract); accept both spellings so cabin translation is not
    /// silently dropped.
    #[serde(default, alias = "translate_lang")]
    pub translate: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// `system` for native system-audio capture (Tauri). With `meeting_id`
    /// the received PCM is archived as the meeting's audio (`audio_archive`).
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub meeting_id: Option<i64>,
}

/// System-audio streams for a meeting archive their PCM as its audio.
fn open_system_archive(source: Option<&str>, meeting_id: Option<i64>) -> Option<crate::audio_archive::SystemArchive> {
    match (source, meeting_id) {
        (Some("system"), Some(id)) => crate::audio_archive::SystemArchive::open(id),
        _ => None,
    }
}

/// Read a non-empty setting from the app database, if it is initialised.
fn db_setting(key: &str) -> Option<String> {
    crate::db::Database::get()
        .and_then(|db| db.get_setting(key).ok().flatten())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn parse_language_hints(raw: Option<&str>) -> Vec<String> {
    let hints: Vec<String> = raw
        .unwrap_or("vi")
        .split([',', ' '])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if hints.is_empty() {
        vec!["vi".to_string()]
    } else {
        hints
    }
}

async fn handle_soniox_stream(socket: WebSocket, params: SonioxStreamParams) {
    let (mut sink, mut stream) = socket.split();

    // The key normally comes from Settings, exactly like the Python sidecar
    // (`db.get_setting("soniox_api_key")`). The frontend never put it in the
    // URL, so requiring the query param made live Soniox fail on every start.
    let api_key = params
        .api_key
        .clone()
        .filter(|k| !k.trim().is_empty())
        .or_else(|| db_setting("soniox_api_key"))
        .or_else(|| std::env::var("SONIOX_API_KEY").ok().filter(|k| !k.trim().is_empty()));
    let api_key = match api_key {
        Some(k) => k,
        None => {
            let _ = sink
                .send(Message::Text(
                    serde_json::to_string(&soniox_error_payload(
                        "Thiếu Soniox API key — vào Cài đặt để nhập key.",
                    ))
                    .unwrap_or_default()
                    .into(),
                ))
                .await;
            return;
        }
    };

    let mut config = SonioxConfig::new(api_key);
    let hints_raw = params.lang.clone().or_else(|| db_setting("soniox_language_hints"));
    config.language_hints = parse_language_hints(hints_raw.as_deref());
    if let Some(t) = params.translate.as_deref() {
        config.translate_lang = t.trim().to_string();
    }
    if let Some(m) = params.model.as_deref() {
        if !m.trim().is_empty() {
            config.model = m.trim().to_string();
        }
    }

    let (audio_tx, audio_rx) = mpsc::channel::<Option<Vec<u8>>>(500);
    let (seg_tx, mut seg_rx) = mpsc::channel::<SonioxSegment>(256);

    let session = tokio::spawn(run_soniox_session(config, audio_rx, seg_tx));

    // Writer: segments → socket.
    let writer = tokio::spawn(async move {
        while let Some(seg) = seg_rx.recv().await {
            let payload = serde_json::to_string(&seg).unwrap_or_default();
            if sink.send(Message::Text(payload.into())).await.is_err() {
                return;
            }
        }
        // Session finished — signal completion to a stopping client.
        let _ = sink.send(Message::Close(None)).await;
    });

    let mut archive = open_system_archive(params.source.as_deref(), params.meeting_id);

    // Reader: client PCM → session queue. Queue full drops the frame, exactly
    // like Python's `put_nowait` + `except: pass`.
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Binary(bytes) => {
                if bytes.is_empty() {
                    let _ = audio_tx.try_send(None);
                    break;
                }
                if let Some(a) = archive.as_mut() {
                    a.write(&bytes);
                }
                let _ = audio_tx.try_send(Some(bytes.to_vec()));
            }
            Message::Text(t) => {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
                    if v.get("type").and_then(|x| x.as_str()) == Some("stop") {
                        let _ = audio_tx.try_send(None);
                        break;
                    }
                }
            }
            Message::Close(_) => {
                let _ = audio_tx.try_send(None);
                break;
            }
            _ => {}
        }
    }

    let _ = audio_tx.send(None).await;
    // Let Soniox finalize: after end-of-audio it returns the last tokens and
    // closes. Aborting right away (as before) threw away the final words.
    let mut session = session;
    if tokio::time::timeout(std::time::Duration::from_secs(6), &mut session)
        .await
        .is_err()
    {
        session.abort();
    }
    let _ = writer.await;
}

fn soniox_error_payload(message: &str) -> serde_json::Value {
    serde_json::json!({
        "text": message,
        "is_final": true,
        "speaker": "System",
        "speaker_id": -1,
        "error": true,
        "terminal": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_hints_parse() {
        assert_eq!(parse_language_hints(None), vec!["vi"]);
        assert_eq!(parse_language_hints(Some("")), vec!["vi"]);
        assert_eq!(parse_language_hints(Some("vi")), vec!["vi"]);
        assert_eq!(parse_language_hints(Some("vi,en")), vec!["vi", "en"]);
        assert_eq!(parse_language_hints(Some("vi en")), vec!["vi", "en"]);
    }

    #[test]
    fn stt_event_json_shape() {
        let payload = serde_json::to_string(&SttEvent::final_text("Xin chào".into())).unwrap();
        assert_eq!(payload, r#"{"text":"Xin chào","is_final":true}"#);
        let payload = serde_json::to_string(&SttEvent::partial("Xin".into())).unwrap();
        assert_eq!(payload, r#"{"text":"Xin","is_final":false}"#);
    }

    /// The frontend detects errors via `data.error` (+ `terminal`); before,
    /// local errors only had `type`/`message` and were silently ignored.
    #[test]
    fn stt_error_event_is_visible_to_frontend() {
        let v = serde_json::to_value(SttEvent::error("model missing")).unwrap();
        assert_eq!(v["error"], "model missing");
        assert_eq!(v["terminal"], true);
        assert_eq!(v["type"], "error");
        assert_eq!(v["message"], "model missing");
    }

    #[test]
    fn soniox_params_accept_frontend_translate_lang() {
        let p: SonioxStreamParams =
            serde_json::from_value(serde_json::json!({"translate_lang": "en"})).unwrap();
        assert_eq!(p.translate.as_deref(), Some("en"));
    }
}
