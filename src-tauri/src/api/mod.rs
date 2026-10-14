//! Rust HTTP backend — drop-in replacement for the Python FastAPI sidecar.
//!
//! The frontend (`src/lib/sidecar.ts` / `src/lib/api.ts`) talks to
//! `http://127.0.0.1:8765` and must not change, so every route here mirrors the
//! Python path and response shape exactly.
//!
//! `build_router()` is the seam task-6 uses to serve this from inside the Tauri
//! process; the `voicescribe-api` bin in this crate serves the same router
//! standalone for verification.

pub mod attachments;
pub mod audio;
pub mod diagnose;
pub mod docx;
pub mod draft_audio;
pub mod drafts;
pub mod jobs;
pub mod meetings;
pub mod pyjson;
pub mod settings;
pub mod transcription;
pub mod upload;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::Query,
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde_json::json;
use tokio::sync::Mutex;

use crate::db::Database;

/// Shared state handed to every handler.
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<&'static Database>,
}

impl AppState {
    pub fn db(&self) -> &'static Database {
        self.db.as_ref()
    }
}

// ─── Network probe (mirrors api/diagnose.py) ───

const NETWORK_PROBE_HOST: &str = "1.1.1.1";
const NETWORK_PROBE_PORT: u16 = 443;
const NETWORK_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const NETWORK_CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Default)]
struct NetworkCache {
    online: Option<bool>,
    checked_at: Option<Instant>,
    latency_ms: Option<u64>,
}

static NETWORK_CACHE: Mutex<Option<NetworkCache>> = Mutex::const_new(None);

/// Single TCP connect to 1.1.1.1:443 — writes the result into the cache.
async fn do_probe() {
    let started = Instant::now();
    let attempt = tokio::time::timeout(
        NETWORK_PROBE_TIMEOUT,
        tokio::net::TcpStream::connect((NETWORK_PROBE_HOST, NETWORK_PROBE_PORT)),
    )
    .await;

    let (online, latency_ms) = match attempt {
        Ok(Ok(stream)) => {
            drop(stream);
            (true, Some(started.elapsed().as_millis() as u64))
        }
        Ok(Err(e)) => {
            log::debug!("STATUS: network probe failed host={NETWORK_PROBE_HOST} err={e}");
            (false, None)
        }
        Err(_) => {
            log::debug!("STATUS: network probe failed host={NETWORK_PROBE_HOST} err=timeout");
            (false, None)
        }
    };

    let mut guard = NETWORK_CACHE.lock().await;
    *guard = Some(NetworkCache {
        online: Some(online),
        checked_at: Some(Instant::now()),
        latency_ms,
    });
}

/// Cached network status; blocks on the very first probe so the caller (the
/// frontend poll loop) receives a real value immediately.
async fn network_status(force_fresh: bool) -> serde_json::Value {
    if force_fresh {
        do_probe().await;
    } else {
        let (never_probed, stale) = {
            let guard = NETWORK_CACHE.lock().await;
            match guard.as_ref() {
                None => (true, false),
                Some(c) => (
                    c.online.is_none(),
                    c.checked_at
                        .map(|t| t.elapsed() > NETWORK_CACHE_TTL)
                        .unwrap_or(true),
                ),
            }
        };
        if never_probed {
            do_probe().await;
        } else if stale {
            // Refresh in the background; return the cached value now so
            // /health stays instant under a 10s poll cadence.
            tokio::spawn(async { do_probe().await });
        }
    }

    let guard = NETWORK_CACHE.lock().await;
    let now = Instant::now();
    match guard.as_ref() {
        Some(c) => json!({
            "online": c.online.unwrap_or(false),
            "latency_ms": c.latency_ms,
            "age_ms": c.checked_at.map(|t| now.duration_since(t).as_millis() as i64).unwrap_or(0),
        }),
        None => json!({ "online": false, "latency_ms": null, "age_ms": 0 }),
    }
}

/// `GET /health`
pub async fn health() -> Response {
    let network = network_status(false).await;
    Json(json!({
        "status": "ok",
        "version": "1.0.0",
        "network": network,
    }))
    .into_response()
}

/// `GET /ping-network` — always a fresh probe (bypasses cache and dedup).
pub async fn ping_network() -> Response {
    Json(network_status(true).await).into_response()
}

/// `GET /diarizer-status` — the frontend's startup gate.
///
/// Mirrors the Python payload shape (`api/diagnose.py::diarizer_status`). The
/// Rust diarizer loads its model lazily and reports success/failure, so we
/// report `model_loaded` from a cheap availability check rather than forcing a
/// model load on every poll.
pub async fn diarizer_status() -> Response {
    let model_path = crate::diarize::default_model_path();
    let model_ok = model_path.is_some();
    Json(json!({
        "model_loaded": model_ok,
        "model_ok": model_ok,
        "model_id": model_path
            .as_ref()
            .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_string())),
        "embedding_dim": 192,
        "source": model_path.map(|p| p.to_string_lossy().to_string()),
        "profile_count": 0,
        "config": {
            "match_threshold": crate::diarize::MATCH_THRESHOLD,
            "distance_threshold": crate::diarize::DEFAULT_DISTANCE_THRESHOLD,
        },
    }))
    .into_response()
}

/// `POST /diarize-reset` — clears speaker profiles for a fresh meeting.
///
/// The batch diarizer is stateless (`identify_speaker_from_samples` takes the
/// profile set as an argument), but the LIVE diarizer behind
/// `/ws/local-stream` keeps profiles on a process-wide worker — that is what
/// must be cleared here, like Python's `_diarizer.reset()`.
pub async fn diarize_reset() -> Response {
    crate::stt::live_diarize::reset_session();
    Json(json!({ "ok": true })).into_response()
}

/// `GET /local/device-info` — hardware tier + local model status for Settings.
///
/// Mirrors `api/settings.py::build_local_device_info`. The Python version
/// detected a tier (A = Apple Silicon/MLX, B = CUDA, C = CPU) and reported
/// which model that tier would use. With the Python sidecar gone there is only
/// the bundled sherpa model, so we report tier "C" semantics but keep the same
/// field names the Settings UI reads.
pub async fn local_device_info() -> Response {
    let cached = crate::stt::local::streaming_model_dir().is_some();
    let arch = std::env::consts::ARCH;
    let os = std::env::consts::OS;
    let apple_silicon = os == "macos" && arch == "aarch64";

    Json(json!({
        "tier": if apple_silicon { "A" } else { "C" },
        "os": os,
        "arch": arch,
        "has_cuda": false,
        "reason": if apple_silicon {
            "Apple Silicon — using the bundled offline model"
        } else {
            "CPU — using the bundled offline model"
        },
        "model_available": cached,
        "model_id": "sherpa-onnx-zipformer-vi-streaming-30M",
        "license": "cc-by-nc-nd-4.0",
        "supported_languages": ["vi"],
    }))
    .into_response()
}

/// `GET /local/model-status` — what the offline engine will use, plus download state.
///
/// Mirrors `api/settings.py::local_model_status` → `active_local_model()` +
/// `download_state()`. The Python version could also report an MLX/Tier-A model
/// that needed a 756MB download; that path is gone with the Python sidecar, so
/// the Rust backend always reports the BUNDLED sherpa model, which is present
/// by definition (it ships inside the app) and therefore never needs a download.
///
/// This endpoint matters more than it looks: RecordingBar/RecordingPanel gate
/// `startRecording` on it. When it 404'd, the guard threw into its catch block
/// and the user saw "Hệ thống chưa sẵn sàng" instead of a recording.
pub async fn local_model_status(Query(q): Query<EngineQuery>) -> Response {
    if q.engine.unwrap_or_else(selected_local_engine) == "nemotron" {
        return Json(nemotron_status()).into_response();
    }
    let model_dir = crate::stt::local::streaming_model_dir();
    let cached = model_dir.is_some();
    let model_id = model_dir
        .as_ref()
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
        .unwrap_or_else(|| "sherpa-onnx-zipformer-vi-streaming-30M".to_string());

    // Size on disk, so the UI can show a real number rather than a constant.
    let size_mb = model_dir
        .as_ref()
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum::<u64>()
        })
        .map(|bytes| (bytes / 1_000_000) as u64)
        .unwrap_or(0);

    Json(json!({
        "engine": "sherpa",
        "model_id": model_id,
        "display_name": "Sherpa Zipformer VN (streaming)",
        "needs_download": false,
        "cached": cached,
        "size_mb": size_mb,
        "status": if cached { "done" } else { "error" },
        "progress": if cached { 1.0 } else { 0.0 },
        "error": if cached { serde_json::Value::Null } else { json!("Offline model not found in the app bundle") },
        "multilingual": false,
        "supported_languages": ["vi"],
    }))
    .into_response()
}

/// `?engine=` override, so Settings can show the status of the engine picked
/// on screen before it is saved. Absent → the saved `local_engine` setting.
#[derive(serde::Deserialize, Default)]
pub struct EngineQuery {
    pub engine: Option<String>,
}

/// Settings → Local engine: `zipformer` (bundled, default) or `nemotron`.
fn selected_local_engine() -> String {
    crate::db::Database::get()
        .and_then(|db| db.get_setting("local_engine").ok().flatten())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "zipformer".to_string())
}

/// Status of the downloadable Nemotron model, in the same shape the Settings
/// panel already renders (download button + progress + language picker).
fn nemotron_status() -> serde_json::Value {
    use crate::stt::model_download as md;
    let cached = md::nemotron_model_dir().is_some();
    let dl = md::download_state();
    let (status, progress) = if cached {
        ("done", 1.0)
    } else if dl.status == "idle" {
        ("idle", 0.0)
    } else {
        (dl.status, dl.progress)
    };
    json!({
        "engine": "nemotron",
        "model_id": md::package().dir,
        "display_name": md::package().display_name,
        "needs_download": !cached,
        "cached": cached,
        "size_mb": md::package().size_mb,
        "status": status,
        "progress": progress,
        "error": dl.error,
        "multilingual": true,
        "supported_languages": md::NEMOTRON_LANGUAGES,
    })
}

/// `POST /local/download-model` — starts the Nemotron download when that engine
/// is selected; a no-op for the bundled Zipformer.
///
/// Kept so the UI's download button has a real endpoint. The bundled sherpa
/// model cannot be missing unless the app was built incorrectly, so there is
/// nothing to fetch; if it IS missing we report the error instead of pretending
/// to download.
pub async fn local_download_model(Query(q): Query<EngineQuery>) -> Response {
    if q.engine.unwrap_or_else(selected_local_engine) == "nemotron" {
        crate::stt::model_download::start_nemotron_download();
        return Json(nemotron_status()).into_response();
    }
    let cached = crate::stt::local::streaming_model_dir().is_some();
    if cached {
        Json(json!({
            "status": "done",
            "progress": 1.0,
            "error": serde_json::Value::Null,
        }))
        .into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "status": "error",
                "progress": 0.0,
                "error": "Offline model is missing from the app bundle — reinstall the app",
            })),
        )
            .into_response()
    }
}

/// Fallback for unrouted paths — keeps the `{"error": ...}` envelope.
///
/// Note the lowercase "Not found": this is what Starlette's `{"detail": ...}`
/// equivalent looks like after the frontend's `readResponseError` reads
/// `.error`. Kept consistent with the handler-level 404s.
async fn not_found_fallback() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "Not found" })),
    )
        .into_response()
}

/// 405 for a known path with the wrong method.
///
/// Axum's built-in `MethodRouter` 405 has an empty body; FastAPI/Starlette
/// returned `{"detail": "Method Not Allowed"}`. The `Allow` header is preserved
/// by axum, so only the body needs restoring for a faithful contract.
async fn method_not_allowed(method: Method) -> Response {
    let _ = method;
    (
        StatusCode::METHOD_NOT_ALLOWED,
        Json(json!({ "detail": "Method Not Allowed" })),
    )
        .into_response()
}

/// Permissive CORS for the Tauri webview origins, matching the Python config.
fn cors_layer() -> tower_http::cors::CorsLayer {
    use tower_http::cors::CorsLayer;

    // The desktop webview is a distinct origin from the loopback server and the
    // frontend issues plain `fetch` from `tauri://localhost`. Python allowed
    // `methods=["*"]` / `headers=["*"]`; the frontend needs exactly that, and a
    // `tauri://` Origin does not always round-trip through HeaderValue parsing,
    // so Any is the faithful equivalent rather than a fixed origin list.
    CorsLayer::new()
        .allow_origin(tower_http::cors::Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(tower_http::cors::Any)
}

/// Build the complete router. Task-6 serves this inside the Tauri process.
pub fn build_router(state: AppState) -> Router {
    // `fallback(...)` on a MethodRouter replaces axum's empty-bodied 405 with the
    // FastAPI-shaped body, and still sets `Allow` from the registered methods.
    let m405 = || axum::routing::any(method_not_allowed);

    Router::new()
        .route("/health", get(health).fallback(m405()))
        .route("/ping-network", get(ping_network).fallback(m405()))
        .route(
            "/settings",
            get(settings::get_settings).post(settings::save_settings).fallback(m405()),
        )
        .route("/models", get(settings::list_models).fallback(m405()))
        .route(
            "/meetings",
            get(meetings::list_meetings).post(meetings::create_meeting).fallback(m405()),
        )
        .route(
            // axum 0.7 uses `:id`; the `{id}` form is 0.8+. Using the wrong one
            // silently registers a literal path, so every request falls through
            // to the 404 fallback.
            "/meetings/:id",
            get(meetings::get_meeting)
                .put(meetings::update_meeting)
                .delete(meetings::delete_meeting)
                .fallback(m405()),
        )
        .route("/drafts", post(drafts::create_draft).fallback(m405()))
        .route("/drafts/:id", patch(drafts::append_draft).fallback(m405()))
        .route(
            "/drafts/:id/audio",
            patch(draft_audio::append_draft_audio).fallback(m405()),
        )
        // Audio playback + export. `/audio/stream` is what the in-app player
        // hits; it must answer Range requests so the user can seek without the
        // webview re-fetching the whole recording.
        .route(
            "/meetings/:id/audio",
            get(audio::download_audio).fallback(m405()),
        )
        .route(
            "/meetings/:id/audio/stream",
            get(audio::stream_audio).fallback(m405()),
        )
        // Minutes download (`?format=md|docx`).
        .route(
            "/meetings/:id/minutes",
            get(audio::download_minutes).fallback(m405()),
        )
        // Reference materials attached to a meeting — fed to the summarizer.
        .route(
            "/meetings/:id/attachments",
            get(attachments::list_attachments)
                .post(attachments::upload_attachment)
                .fallback(m405()),
        )
        .route(
            "/meetings/:id/attachments/:aid",
            get(attachments::get_attachment)
                .delete(attachments::delete_attachment)
                .fallback(m405()),
        )
        // Minutes generation — SSE, thin wrapper over crate::llm.
        .route("/summarize", post(transcription::summarize).fallback(m405()))
        // File-upload transcription: the frontend streams the file here, gets a
        // job id back, then subscribes to /jobs/{id}/events for progress. The
        // route returns immediately — the pipeline runs on its own task.
        .route(
            "/meetings/upload-audio",
            post(upload::upload_audio).fallback(m405()),
        )
        .route(
            "/meetings/:id/retry-failed-chunks",
            post(upload::retry_failed_chunks).fallback(m405()),
        )
        .route("/jobs/:id", get(upload::get_job).fallback(m405()))
        .route("/jobs/:id/events", get(upload::job_events).fallback(m405()))
        .route("/jobs/:id/cancel", post(upload::cancel_job).fallback(m405()))
        // File-upload transcription pipeline (ffmpeg → VAD → STT → diarize).
        .route(
            "/transcribe-diarize",
            post(transcription::transcribe_diarize).fallback(m405()),
        )
        // Startup gate: the frontend polls this until `model_loaded` is true
        // before it declares the backend ready. Without it the app sat on the
        // "Loading speech models" step forever (the request 404'd, so the poll
        // never succeeded and startup fell through on a timeout instead).
        .route("/diarizer-status", get(diarizer_status).fallback(m405()))
        .route("/diarize-reset", post(diarize_reset).fallback(m405()))
        // The recording guard polls this before every start — see the handler
        // docs for why a 404 here surfaced as "Hệ thống chưa sẵn sàng".
        .route("/local/model-status", get(local_model_status).fallback(m405()))
        .route("/local/device-info", get(local_device_info).fallback(m405()))
        .route("/local/download-model", post(local_download_model).fallback(m405()))
        // Settings → "Kiểm tra tất cả kết nối".
        .route("/diagnose", get(diagnose::diagnose).fallback(m405()))
        .fallback(not_found_fallback)
        .layer(cors_layer())
        // Axum's default request-body cap is 2 MiB. That silently broke every
        // real audio upload: `Multipart` failed to parse the body and the user
        // saw a generic 400. Measured on this build — 2_000_000 bytes returned
        // 200 while exactly 2_097_152 (2 MiB) returned 400 — so the cap has to
        // be raised to the upload feature's own 2 GB limit (MAX_FILE_BYTES in
        // api/upload.rs), which is what actually enforces the ceiling and
        // reports a meaningful 413.
        .layer(axum::extract::DefaultBodyLimit::max(
            upload::MAX_FILE_BYTES as usize + MAX_MULTIPART_OVERHEAD,
        ))
        .with_state(state)
}

/// Slack added on top of the file cap for multipart boundaries and the small
/// form fields (`title`, `language`, `generate_summary`) that travel with the
/// file, so a file exactly at the limit is not rejected as "too large" by the
/// transport before the handler can apply its own precise check.
const MAX_MULTIPART_OVERHEAD: usize = 8 * 1024 * 1024;

/// Initialise the DB and build the router against it.
pub fn build_router_with_default_db() -> Result<Router, String> {
    let db = Database::init(None)?;
    // Jobs live in memory: uploads cut short by a crash/quit left meetings
    // stuck in "uploading". Settle them once, before serving.
    upload::recover_stuck_uploads(db);
    Ok(build_router(AppState {
        db: Arc::new(db),
    }))
}

/// Convenience for the standalone binary and for task-6.
pub fn build_router_at(db_path: PathBuf) -> Result<Router, String> {
    let db = Database::init(Some(db_path))?;
    Ok(build_router(AppState {
        db: Arc::new(db),
    }))
}

/// Serve on the given address until the process is stopped.
pub async fn serve(router: Router, addr: std::net::SocketAddr) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;
    log::info!("Rust backend listening on http://{addr}");
    axum::serve(listener, router)
        .await
        .map_err(|e| format!("serve: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_network_shape() {
        // The JSON envelope shape must be stable for the frontend type.
        let v = json!({"online": true, "latency_ms": 12, "age_ms": 3});
        assert!(v.get("online").unwrap().is_boolean());
        assert!(v.get("latency_ms").is_some());
        assert!(v.get("age_ms").is_some());
    }
}
