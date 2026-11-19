//! App integration of the Qwen3-ASR engine: one actor thread owns the (~4 GB)
//! model and every MLX array — MLX streams are thread-local, so all inference
//! is funnelled through it — and a VAD wrapper turns it into the
//! [`StreamingAsr`] surface (live recording + upload both use that).
//!
//! The model is loaded ONCE per process per checkpoint dir ([`shared`]); the
//! live engine and the upload engine only own their cheap VAD state.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, OnceLock};

use super::generate::DecodeOptions;
use super::mel::SAMPLE_RATE;
use super::model::Qwen3Model;
use crate::stt::local::{UtteranceDecoder, VadOfflineEngine};

type Job = Box<dyn FnOnce(&Qwen3Model) + Send>;

/// Handle to the inference thread. Dropping the last handle ends the thread
/// (and frees the model on the thread that created it).
pub struct Qwen3Asr {
    tx: Mutex<mpsc::Sender<Job>>,
}

impl Qwen3Asr {
    pub fn load(dir: &Path) -> Option<Self> {
        let dir = dir.to_path_buf();
        let (tx, rx) = mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = mpsc::channel::<bool>();
        std::thread::Builder::new()
            .name("qwen3-mlx".to_string())
            .spawn(move || {
                crate::stt::nemotron_mlx::use_bundled_metallib();
                let started = std::time::Instant::now();
                let model = match Qwen3Model::load(&dir) {
                    Ok(m) => m,
                    Err(e) => {
                        log::warn!("[qwen3-mlx] FAILED: load {}: {e}", dir.display());
                        let _ = ready_tx.send(false);
                        return;
                    }
                };
                log::info!("[qwen3-mlx] LOADED: {} in {:.1}s", dir.display(), started.elapsed().as_secs_f32());
                let _ = ready_tx.send(true);
                while let Ok(job) = rx.recv() {
                    job(&model);
                }
            })
            .ok()?;
        ready_rx.recv().ok()?.then(|| Self { tx: Mutex::new(tx) })
    }

    /// Transcribe 16 kHz mono PCM (any length: ≤30 s chunking inside).
    /// `None` when the inference thread is gone or decoding failed.
    pub fn transcribe(&self, pcm: Vec<f32>, language: &str) -> Option<String> {
        let (rtx, rrx) = mpsc::channel();
        let opts = DecodeOptions { language: Some(language.to_string()), ..DecodeOptions::default() };
        let job: Job = Box::new(move |m| {
            let started = std::time::Instant::now();
            let secs = pcm.len() as f32 / SAMPLE_RATE as f32;
            let out = m.transcribe(&pcm, &opts);
            match &out {
                Ok(_) => log::debug!("[qwen3-mlx] decoded {secs:.1}s audio in {:.2}s", started.elapsed().as_secs_f32()),
                Err(e) => log::warn!("[qwen3-mlx] FAILED: decode {secs:.1}s audio: {e:?}"),
            }
            let _ = rtx.send(out.ok());
        });
        self.tx.lock().ok()?.send(job).ok()?;
        rrx.recv().ok().flatten()
    }
}

static SHARED: OnceLock<Mutex<HashMap<PathBuf, Arc<Qwen3Asr>>>> = OnceLock::new();

/// The process-wide model for `dir`, loading it on first use.
pub fn shared(dir: &Path) -> Option<Arc<Qwen3Asr>> {
    let cache = SHARED.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = cache.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(m) = map.get(dir) {
        return Some(m.clone());
    }
    let m = Arc::new(Qwen3Asr::load(dir)?);
    map.insert(dir.to_path_buf(), m.clone());
    Some(m)
}

/// Release the model(s) at shutdown (after the VAD engines are dropped).
pub fn clear_shared() {
    if let Some(c) = SHARED.get() {
        c.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }
}

/// [`UtteranceDecoder`] over the shared model.
pub struct Qwen3UtteranceDecoder {
    asr: Arc<Qwen3Asr>,
}

/// Qwen3-ASR is offline: it yields no token timing, so words are spread over
/// the utterance in proportion to their length (enough for per-token speaker
/// labelling; exact only at the utterance edges).
fn word_tokens(text: &str, seconds: f32) -> (Vec<String>, Vec<f32>) {
    let words: Vec<&str> = text.split_whitespace().collect();
    let total: usize = words.iter().map(|w| w.chars().count() + 1).sum();
    let (mut tokens, mut times, mut before) = (Vec::new(), Vec::new(), 0usize);
    for w in words {
        tokens.push(format!(" {w}"));
        times.push(seconds * before as f32 / total.max(1) as f32);
        before += w.chars().count() + 1;
    }
    (tokens, times)
}

impl UtteranceDecoder for Qwen3UtteranceDecoder {
    fn decode_utterance(&self, pcm: &[f32], language: &str) -> (String, Vec<String>, Vec<f32>) {
        let lang = if language.is_empty() { "vi" } else { language };
        let text = self.asr.transcribe(pcm.to_vec(), lang).unwrap_or_default();
        let (tokens, times) = word_tokens(&text, pcm.len() as f32 / SAMPLE_RATE as f32);
        (text, tokens, times)
    }
}

pub type Qwen3VadEngine = VadOfflineEngine<Qwen3UtteranceDecoder>;

/// Streaming-surface engine over the shared model (cheap: VAD state only).
pub fn new_stream_engine(dir: &Path) -> Option<Qwen3VadEngine> {
    Some(VadOfflineEngine::with_decoder(Qwen3UtteranceDecoder { asr: shared(dir)? }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_get_monotonic_times_inside_the_utterance() {
        let (t, ts) = word_tokens("xin chào các bạn", 4.0);
        assert_eq!(t[0], " xin");
        assert_eq!(ts.len(), 4);
        assert_eq!(ts[0], 0.0);
        assert!(ts.windows(2).all(|w| w[0] < w[1]) && ts[3] < 4.0);
    }

    #[test]
    fn empty_text_has_no_tokens() {
        assert_eq!(word_tokens("  ", 1.0), (vec![], vec![]));
    }
}
