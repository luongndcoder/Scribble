//! Nemotron 3.5 ASR Streaming on Apple's MLX (macOS only).
//!
//! Runs `mlx-community/nemotron-3.5-asr-streaming-0.6b` natively from Rust via
//! `mlx-rs` — a port of the MIT-licensed `mlx-audio` implementation (see
//! [`model`] and [`mel`]). On Apple Silicon this uses the GPU (Metal) instead
//! of the CPU-bound ONNX path, so long meetings stay cool and the CPU free.
//!
//! [`NemotronMlxEngine`] implements the same [`StreamingAsr`] surface as the
//! sherpa engine, so live recording, partials, endpoints and the per-token
//! speaker tracker work unchanged.

pub mod mel;
pub mod model;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use self::mel::StreamingLogMel;
use self::model::{DecodedToken, NemotronModel, StreamState};
use super::local::StreamingAsr;
use super::text::postprocess_local;

/// 560 ms chunks: right context 6 → (6+1) encoder frames × 80 ms.
pub const RIGHT_CONTEXT: usize = 6;
/// Encoder frame duration (8x subsampling of 10 ms mel hops).
const FRAME_SEC: f32 = 0.08;
/// Endpoint after this much decoded audio with no new token (≈ sherpa rule 2).
const ENDPOINT_SILENCE_SEC: f32 = 1.2;
/// …or after this much with no token at all (≈ sherpa rule 1).
const ENDPOINT_EMPTY_SEC: f32 = 2.4;

/// `<data dir>/models/nemotron-3.5-mlx` when the MLX checkpoint is present.
pub fn mlx_model_dir() -> Option<PathBuf> {
    let dir = crate::db::default_data_dir().join("models").join(MLX_DIR);
    is_mlx_dir(&dir).then_some(dir)
}

pub const MLX_DIR: &str = "nemotron-3.5-mlx";

pub fn is_mlx_dir(dir: &Path) -> bool {
    dir.join("model.safetensors").is_file() && dir.join("config.json").is_file()
}

struct Inner {
    model: NemotronModel,
    mel: StreamingLogMel,
    st: StreamState,
    /// Tokens of the current utterance.
    utt: Vec<DecodedToken>,
    /// Stream samples fed so far, and at the start of the current utterance.
    samples: usize,
    utt_origin_samples: usize,
    /// Encoder frame of the last emitted token (endpoint timing).
    last_token_frame: Option<usize>,
    /// Encoder frame at the start of the current utterance.
    utt_start_frame: usize,
    /// Profiling: cumulative (encoder, decoder) seconds (`NEMOTRON_PROFILE`).
    prof: (f64, f64),
}

/// Work item executed on the engine's MLX thread.
type Job = Box<dyn FnOnce(&mut Inner) + Send>;

/// Actor: ONE OS thread owns the model and all MLX state; methods ship
/// closures to it and wait for the result.
///
/// MLX streams are thread-local — arrays (weights included) created on one
/// thread fail on another with "There is no Stream(cpu, 0) in current
/// thread". The app loads the engine on one thread and decodes on another, so
/// every MLX call must be funnelled through the owning thread.
pub struct NemotronMlxEngine {
    tx: Mutex<std::sync::mpsc::Sender<Job>>,
}

/// Point MLX at the Metal shader library shipped inside the app bundle.
///
/// mlx-sys compiles `mlx.metallib` at BUILD time into a build-machine path
/// (`~/.mlx/lib/<hash>/`) and bakes that path in — on a user's Mac it does not
/// exist. The library (~174 MB) is NOT shipped in the app: it is attached to
/// each version's GitHub Release and downloaded together with the MLX model
/// (see `model_download`). This must run before the first Metal
/// initialisation (it is process-global).
fn use_bundled_metallib() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let Some(exe_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) else {
            return;
        };
        // Bundled (if a build ships it) → downloaded next to the MLX checkpoint
        // (normal case: fetched with the model) → beside the executable.
        let downloaded = crate::stt::model_download::nemotron_target_dir().join("mlx.metallib");
        for candidate in [exe_dir.join("../Resources/mlx.metallib"), downloaded, exe_dir.join("mlx.metallib")] {
            if candidate.is_file() {
                let path = candidate.canonicalize().unwrap_or(candidate);
                match mlx_rs::metal::set_metallib_path(path.to_string_lossy()) {
                    Ok(()) => log::info!("[nemotron-mlx] LOADED: metallib {}", path.display()),
                    Err(e) => log::warn!("[nemotron-mlx] FAILED: set metallib path: {e:?}"),
                }
                return;
            }
        }
        // Dev builds (`cargo run`) fall back to the build-machine path.
    });
}

impl NemotronMlxEngine {
    pub fn new(dir: &Path) -> Option<Self> {
        let dir = dir.to_path_buf();
        let (tx, rx) = std::sync::mpsc::channel::<Job>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<bool>();
        std::thread::Builder::new()
            .name("nemotron-mlx".to_string())
            .spawn(move || {
                use_bundled_metallib();
                let model = match NemotronModel::load(&dir, RIGHT_CONTEXT) {
                    Ok(m) => m,
                    Err(e) => {
                        log::warn!("[nemotron-mlx] FAILED: load {}: {e}", dir.display());
                        let _ = ready_tx.send(false);
                        return;
                    }
                };
                let st = model.new_state("auto");
                log::info!("[nemotron-mlx] LOADED: {}", dir.display());
                let mut inner = Inner {
                    model,
                    mel: StreamingLogMel::new(),
                    st,
                    utt: Vec::new(),
                    samples: 0,
                    utt_origin_samples: 0,
                    last_token_frame: None,
                    utt_start_frame: 0,
                    prof: (0.0, 0.0),
                };
                let _ = ready_tx.send(true);
                while let Ok(job) = rx.recv() {
                    job(&mut inner);
                }
            })
            .ok()?;
        ready_rx.recv().ok()?.then(|| Self { tx: Mutex::new(tx) })
    }

    /// Run `f` on the MLX thread and return its result.
    fn with<R: Send + 'static>(&self, f: impl FnOnce(&mut Inner) -> R + Send + 'static) -> R
    where
        R: Default,
    {
        let (rtx, rrx) = std::sync::mpsc::channel();
        let job: Job = Box::new(move |inner| {
            let _ = rtx.send(f(inner));
        });
        let sent = self
            .tx
            .lock()
            .map(|tx| tx.send(job).is_ok())
            .unwrap_or(false);
        if !sent {
            return R::default();
        }
        rrx.recv().unwrap_or_default()
    }

    fn run(inner: &mut Inner, pcm: &[f32], final_: bool) {
        let result = (|| -> mlx_rs::error::Result<()> {
            let mel = inner.mel.push(pcm, final_)?;
            let chunks = inner.model.push_mel(mel, final_, &mut inner.st)?;
            for enc in chunks {
                let t0 = std::time::Instant::now();
                let prompted = inner.model.apply_prompt(&enc, inner.st_prompt())?;
                prompted.eval()?;
                let t1 = std::time::Instant::now();
                let toks = inner.model.decode(&prompted, &mut inner.st)?;
                inner.prof.0 += (t1 - t0).as_secs_f64();
                inner.prof.1 += t1.elapsed().as_secs_f64();
                if let Some(last) = toks.last() {
                    inner.last_token_frame = Some(last.frame);
                }
                inner.utt.extend(toks);
            }
            Ok(())
        })();
        if let Err(e) = result {
            if std::env::var("NEMOTRON_PROFILE").is_ok() {
                eprintln!("[nemotron-mlx] FAILED: decode step: {e:?}");
            }
            log::warn!("[nemotron-mlx] FAILED: decode step: {e:?}");
        }
    }
}

impl Inner {
    fn st_prompt(&self) -> i32 {
        self.st.prompt()
    }
    fn text(&self) -> String {
        self.utt.iter().map(|t| t.text.as_str()).collect::<String>().trim().to_string()
    }
}

impl StreamingAsr for NemotronMlxEngine {
    fn accept(&self, pcm: &[f32]) {
        let pcm = pcm.to_vec();
        self.with(move |g| {
            g.samples += pcm.len();
            Self::run(g, &pcm, false);
        })
    }

    fn flush(&self) {
        // Emit the tail (partial chunk) — the stream is ending.
        self.with(|g| {
            Self::run(g, &[], true);
            if std::env::var("NEMOTRON_PROFILE").is_ok() {
                eprintln!(
                    "[nemotron-mlx] device={:?} encoder {:.2}s, decoder {:.2}s",
                    mlx_rs::Device::try_default().and_then(|d| d.get_type()),
                    g.prof.0,
                    g.prof.1
                );
            }
        })
    }

    fn is_endpoint(&self) -> bool {
        self.with(|g| {
            let now = g.st.enc_frames;
            match g.last_token_frame {
                Some(f) if !g.utt.is_empty() => {
                    (now.saturating_sub(f)) as f32 * FRAME_SEC >= ENDPOINT_SILENCE_SEC
                }
                _ => (now.saturating_sub(g.utt_start_frame)) as f32 * FRAME_SEC >= ENDPOINT_EMPTY_SEC,
            }
        })
    }

    fn tokens(&self) -> (Vec<String>, Vec<f32>) {
        self.with(|g| {
            let origin = g.utt_origin_samples as f32 / mel::SAMPLE_RATE as f32;
            let toks = g.utt.iter().map(|t| t.text.clone()).collect();
            let times = g.utt.iter().map(|t| (t.frame as f32 * FRAME_SEC - origin).max(0.0)).collect();
            (toks, times)
        })
    }

    fn partial_text(&self, language: &str) -> String {
        let language = language.to_string();
        self.with(move |g| postprocess_local(&g.text(), &language))
    }

    fn finalize(&self, language: &str) -> String {
        let language = language.to_string();
        self.with(move |g| {
            let text = postprocess_local(&g.text(), &language);
            // Cache-aware streaming is continuous: only the utterance
            // bookkeeping resets, the encoder/decoder state carries on.
            g.utt.clear();
            g.utt_origin_samples = g.samples;
            g.utt_start_frame = g.st.enc_frames;
            g.last_token_frame = None;
            text
        })
    }

    fn set_language(&self, language: &str) {
        let language = language.to_string();
        self.with(move |g| {
            let Inner { model, st, .. } = g;
            model.set_language(st, &language);
        })
    }

    fn reset_stream(&self) {
        // A new recording: fresh audio clock, encoder caches and decoder state.
        self.with(|g| {
            let keep_prompt = g.st.prompt();
            g.st = g.model.new_state("");
            g.st.set_prompt(keep_prompt);
            g.mel = StreamingLogMel::new();
            g.utt.clear();
            g.samples = 0;
            g.utt_origin_samples = 0;
            g.utt_start_frame = 0;
            g.last_token_frame = None;
        })
    }
}
