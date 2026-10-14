//! In-memory job registry for the upload-audio pipeline.
//!
//! Port of `src-python/services/job_registry.py`.
//!
//! Lifecycle: pending → normalizing → transcribing → finalizing → done
//!                                                     ↓
//!                                                  failed | cancelled
//!
//! State is in-memory only, matching Python's decision (D7 in
//! docs/upload-feature/00-overview.md): a job does not survive a restart. The
//! DB row is what persists; a resumed run creates a NEW job.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::broadcast;

/// Job lifecycle states — the exact strings the frontend's `JobStatus` union uses.
pub const PENDING: &str = "pending";
pub const NORMALIZING: &str = "normalizing";
pub const TRANSCRIBING: &str = "transcribing";
pub const FINALIZING: &str = "finalizing";
pub const DONE: &str = "done";
pub const FAILED: &str = "failed";
pub const CANCELLED: &str = "cancelled";

/// States after which no further transition is honoured.
pub fn is_terminal(status: &str) -> bool {
    matches!(status, DONE | FAILED | CANCELLED)
}

/// One pipeline job.
#[derive(Debug, Clone)]
pub struct JobState {
    pub job_id: String,
    pub meeting_id: i64,
    pub status: String,
    pub progress: f64,
    pub message: String,
    pub error: Option<String>,
    pub total_chunks: usize,
    pub processed_chunks: usize,
    /// Set when the LLM summarize step was skipped (no API key) or failed. The
    /// job still ends in `done` with a saved transcript, and the modal shows a
    /// friendly "configure AI key" hint instead of an error.
    pub summary_skipped: bool,
    pub summary_skip_reason: String,
    /// The user's upload-form choice. When false the pipeline skips
    /// auto-summarize entirely and finishes as soon as the transcript is saved,
    /// so nobody waits on the LLM for minutes they did not ask for.
    pub generate_summary: bool,
    /// True once the transcript JSON reached the DB. Lets the UI offer
    /// "Open meeting" even if the job later FAILS, so a downstream crash never
    /// loses transcription work the user already paid for in time.
    pub transcript_saved: bool,
    pub created_at: f64,
    pub updated_at: f64,
    pub cancelled: bool,
}

impl JobState {
    /// Serializable form — field set and order mirror Python's `to_dict()`.
    pub fn to_dict(&self) -> Value {
        json!({
            "job_id": self.job_id,
            "meeting_id": self.meeting_id,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "error": self.error,
            "total_chunks": self.total_chunks,
            "processed_chunks": self.processed_chunks,
            "summary_skipped": self.summary_skipped,
            "summary_skip_reason": self.summary_skip_reason,
            "generate_summary": self.generate_summary,
            "transcript_saved": self.transcript_saved,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        })
    }
}

/// Process-wide job registry.
#[derive(Default)]
pub struct JobRegistry {
    jobs: Mutex<HashMap<String, Arc<Mutex<JobState>>>>,
    /// Broadcast senders, kept separate from `jobs` so emitting an update never
    /// needs the state lock held across the send.
    senders: Mutex<HashMap<String, broadcast::Sender<Value>>>,
}

/// Broadcast channel capacity per job.
///
/// Python used an `asyncio.Queue(maxsize=500)` and dropped the oldest event on
/// overflow. `broadcast` instead reports `Lagged`, so the SSE loop can skip
/// ahead rather than dropping the *newest* status — losing an intermediate
/// progress tick is fine, losing the terminal `done` frame is not.
const JOB_EVENT_CAPACITY: usize = 500;

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a job and return its handle.
    pub fn create(
        &self,
        meeting_id: i64,
        generate_summary: bool,
    ) -> (Arc<Mutex<JobState>>, broadcast::Receiver<Value>) {
        let job_id = uuid::Uuid::new_v4().simple().to_string();
        let now = now_secs();
        let state = JobState {
            job_id,
            meeting_id,
            status: PENDING.to_string(),
            progress: 0.0,
            message: String::new(),
            error: None,
            total_chunks: 0,
            processed_chunks: 0,
            summary_skipped: false,
            summary_skip_reason: String::new(),
            generate_summary,
            transcript_saved: false,
            created_at: now,
            updated_at: now,
            cancelled: false,
        };
        let (tx, rx) = broadcast::channel(JOB_EVENT_CAPACITY);
        let handle = Arc::new(Mutex::new(state));
        let id = handle.lock().unwrap_or_else(|e| e.into_inner()).job_id.clone();
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.clone(), handle.clone());
        self.senders
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);
        (handle, rx)
    }

    /// Look up a job by id.
    pub fn get(&self, job_id: &str) -> Option<Arc<Mutex<JobState>>> {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(job_id)
            .cloned()
    }

    /// Subscribe to a job's update stream.
    pub fn subscribe(&self, job_id: &str) -> Option<broadcast::Receiver<Value>> {
        self.senders
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(job_id)
            .map(|tx| tx.subscribe())
    }

    /// Apply updates and broadcast a `{"type":"status", ...}` frame.
    pub fn update<F>(&self, job_id: &str, mutate: F)
    where
        F: FnOnce(&mut JobState),
    {
        let Some(handle) = self.get(job_id) else { return };
        let payload = {
            let mut state = handle.lock().unwrap_or_else(|e| e.into_inner());
            mutate(&mut state);
            state.updated_at = now_secs();
            let mut v = state.to_dict();
            // Python emitted `{"type": "status", **job.to_dict()}` — type first.
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
        self.broadcast(job_id, payload);
    }

    /// Broadcast a `{"type":"chunk", ...}` frame as a chunk finishes.
    pub fn emit_chunk(&self, job_id: &str, chunk: Value) {
        let mut payload = json!({ "type": "chunk" });
        if let (Some(dst), Some(src)) = (payload.as_object_mut(), chunk.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
        self.broadcast(job_id, payload);
    }

    fn broadcast(&self, job_id: &str, payload: Value) {
        if let Some(tx) = self
            .senders
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(job_id)
        {
            // Err just means nobody is listening yet — the SSE handler always
            // sends the current state first, so a missed early frame is fine.
            let _ = tx.send(payload);
        }
    }

    /// Request cancellation. Returns false when unknown or already finished.
    pub fn cancel(&self, job_id: &str) -> bool {
        let Some(handle) = self.get(job_id) else {
            return false;
        };
        let mut state = handle.lock().unwrap_or_else(|e| e.into_inner());
        if is_terminal(&state.status) {
            return false;
        }
        state.cancelled = true;
        true
    }

    /// True when a cancel was requested; the pipeline polls this between chunks.
    pub fn is_cancelled(&self, job_id: &str) -> bool {
        self.get(job_id)
            .map(|h| h.lock().unwrap_or_else(|e| e.into_inner()).cancelled)
            .unwrap_or(false)
    }

    /// Drop finished jobs older than `max_age_seconds`.
    pub fn cleanup_stale(&self, max_age_seconds: f64) -> usize {
        let now = now_secs();
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        let stale: Vec<String> = jobs
            .iter()
            .filter(|(_, h)| {
                let s = h.lock().unwrap_or_else(|e| e.into_inner());
                is_terminal(&s.status) && (now - s.updated_at) > max_age_seconds
            })
            .map(|(k, _)| k.clone())
            .collect();
        for id in &stale {
            jobs.remove(id);
        }
        let n = stale.len();
        drop(jobs);
        let mut senders = self.senders.lock().unwrap_or_else(|e| e.into_inner());
        for id in &stale {
            senders.remove(id);
        }
        n
    }
}

/// Wall-clock seconds since the epoch, as a float (Python's `time.time()`).
fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_states_are_recognised() {
        assert!(is_terminal("done"));
        assert!(is_terminal("failed"));
        assert!(is_terminal("cancelled"));
        assert!(!is_terminal("pending"));
        assert!(!is_terminal("transcribing"));
    }

    #[test]
    fn create_and_get_roundtrip() {
        let reg = JobRegistry::new();
        let (handle, _rx) = reg.create(42, true);
        let id = handle.lock().unwrap().job_id.clone();
        assert_eq!(id.len(), 32, "uuid4 hex, like Python's uuid4().hex");
        assert!(reg.get(&id).is_some());
        assert!(reg.get("nope").is_none());
    }

    #[test]
    fn update_emits_a_status_frame_with_the_python_field_set() {
        let reg = JobRegistry::new();
        let (handle, mut rx) = reg.create(7, true);
        let id = handle.lock().unwrap().job_id.clone();

        reg.update(&id, |s| {
            s.status = TRANSCRIBING.to_string();
            s.progress = 0.5;
            s.total_chunks = 10;
        });

        let frame = rx.try_recv().expect("a status frame");
        assert_eq!(frame["type"], "status");
        assert_eq!(frame["status"], "transcribing");
        assert_eq!(frame["meeting_id"], 7);
        assert_eq!(frame["total_chunks"], 10);
        // Fields the modal reads must always be present, even when defaulted.
        for key in [
            "job_id",
            "progress",
            "message",
            "error",
            "processed_chunks",
            "summary_skipped",
            "summary_skip_reason",
            "generate_summary",
            "transcript_saved",
            "created_at",
            "updated_at",
        ] {
            assert!(frame.get(key).is_some(), "missing field {key} in {frame}");
        }
    }

    #[test]
    fn chunk_frames_are_tagged_type_chunk() {
        let reg = JobRegistry::new();
        let (handle, mut rx) = reg.create(1, false);
        let id = handle.lock().unwrap().job_id.clone();
        reg.emit_chunk(&id, json!({ "idx": 3, "text": "xin chào" }));
        let frame = rx.try_recv().unwrap();
        assert_eq!(frame["type"], "chunk");
        assert_eq!(frame["idx"], 3);
        assert_eq!(frame["text"], "xin chào");
    }

    #[test]
    fn cancel_flips_the_flag_and_refuses_after_terminal() {
        let reg = JobRegistry::new();
        let (handle, _rx) = reg.create(1, true);
        let id = handle.lock().unwrap().job_id.clone();

        assert!(reg.cancel(&id));
        assert!(reg.is_cancelled(&id));
        // A second cancel on a non-terminal job is still accepted (idempotent).
        assert!(reg.cancel(&id));

        reg.update(&id, |s| s.status = DONE.to_string());
        assert!(!reg.cancel(&id), "cancel must be refused once terminal");
        assert!(!reg.cancel("unknown-job"));
    }

    #[test]
    fn cleanup_removes_only_old_finished_jobs() {
        let reg = JobRegistry::new();
        let (h1, _) = reg.create(1, true);
        let (h2, _) = reg.create(2, true);
        let id1 = h1.lock().unwrap().job_id.clone();
        let id2 = h2.lock().unwrap().job_id.clone();

        reg.update(&id1, |s| s.status = DONE.to_string());
        // id2 stays pending, so it must survive the sweep.
        assert_eq!(reg.cleanup_stale(-1.0), 1);
        assert!(reg.get(&id1).is_none());
        assert!(reg.get(&id2).is_some());
    }
}
