//! Live speaker session for the local streaming engine.
//!
//! Speaker identification itself lives in [`super::speaker_tracker`], which
//! labels the live audio continuously (per token, like Soniox). This module
//! owns what outlives a single WebSocket:
//!
//! * the meeting's speaker profiles — shared by every live stream (mic and
//!   system audio, plus a reconnect) so a returning voice keeps its id, and
//!   cleared by `POST /diarize-reset` when a new recording starts;
//! * the one-time warm-up of the embedding model.
//!
//! History: this used to hold `LiveDiarizer`, which judged a whole recognizer
//! utterance at its endpoint. Utterances run 10-20s in a lively meeting, so
//! speaker changes inside them were never seen, and its new-speaker gate
//! compared a candidate against the KNOWN profiles instead of against itself,
//! rejecting exactly the voices that were most different.

use std::sync::{Arc, Mutex, OnceLock};

use super::speaker_tracker::SharedProfiles;
use crate::diarize::{self, embedding};

static PROFILES: OnceLock<SharedProfiles> = OnceLock::new();
static WARMED: OnceLock<()> = OnceLock::new();

/// The current meeting's speaker profiles.
pub fn session_profiles() -> SharedProfiles {
    Arc::clone(PROFILES.get_or_init(|| Arc::new(Mutex::new(Vec::new()))))
}

/// Start a fresh speaker session (called from `POST /diarize-reset` when a
/// recording starts) and warm the embedding model.
pub fn reset_session() {
    if let Ok(mut p) = session_profiles().lock() {
        p.clear();
    }
    warm_up();
}

/// Load the embedding model on a dedicated OS thread, once per process, so the
/// first window of the first recording does not pay ~1-2s of model load.
/// (ONNX Runtime sessions must not be created on a tokio worker thread — that
/// aborted the process with `__rust_foreign_exception`.)
pub fn warm_up() {
    WARMED.get_or_init(|| {
        let _ = std::thread::Builder::new()
            .name("speaker-embed-warmup".to_string())
            .spawn(|| {
                if let Some(model) = embedding::resolve_live_model_path() {
                    let _ = embedding::embedder_for(&model, diarize::NUM_THREADS);
                }
            });
    });
}

/// Convert raw little-endian PCM16 bytes to f32 in [-1, 1] for embedding.
pub fn pcm16_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm16_conversion_is_signed_and_scaled() {
        // 0, +32767, -32768 little-endian
        let bytes = [0u8, 0, 0xFF, 0x7F, 0x00, 0x80];
        let out = pcm16_to_f32(&bytes);
        assert_eq!(out.len(), 3);
        assert!((out[0]).abs() < 1e-6);
        assert!((out[1] - 0.99997).abs() < 1e-3);
        assert!((out[2] + 1.0).abs() < 1e-6);
    }

    #[test]
    fn reset_clears_profiles() {
        reset_session();
        assert!(session_profiles().lock().unwrap().is_empty());
    }
}
