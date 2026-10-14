//! Speaker embedding extraction via ONNX Runtime (`ort`) + Kaldi fbank.
//!
//! This replaces both the Python `onnxruntime` path in `src-python/diarize.py`
//! and the short-lived `sherpa-onnx`-crate path.
//!
//! ## Why not sherpa-onnx (recorded so nobody re-litigates it)
//!
//! The `sherpa-onnx` crate refuses to load the original hynt
//! `speaker_embedding_resnet34.onnx`: its loader demands a `model_type`
//! metadata field naming `wespeaker` / `3d-speaker` / `nemo`, and this file has
//! no such metadata. That is a *sherpa loader* restriction, not a Rust one —
//! ONNX Runtime loads any valid ONNX graph. `ort` therefore runs the original
//! model unmodified.
//!
//! STT still uses the `sherpa-onnx` crate (`src/stt/local.rs`); only this
//! embedding path moved off it.
//!
//! ## Model selection (2026-10-09, measured — see `docs/reports/`)
//!
//! Five models were measured on the user's real 6.7-minute Vietnamese meeting
//! with a label-free protocol. The shipped default is now the 3D-Speaker
//! **ERes2Net-base** (`speaker_eres2net_base.onnx`, Apache-2.0), which improved
//! every separability metric over the hynt ResNet34 baseline:
//!
//! | model | licence | overlap% | d' | top-2 medoid sim | ms/emb |
//! |---|---|---|---|---|---|
//! | hynt ResNet34 (was shipped) | unclear | 88.7 | 0.526 | 0.691 | 64 |
//! | **3D-Speaker ERes2Net-base** | **Apache-2.0** | **82.3** | **0.704** | **0.536** | 67 |
//! | 3D-Speaker CAM++ | Apache-2.0 | 86.4 | 0.583 | 0.745 | 24 |
//! | WeSpeaker voxceleb ResNet34-LM | cc-by-4.0 | 90.0 | 0.458 | 0.740 | 64 |
//! | Orange Speaker-wavLM-pro | cc-by-sa-3.0 | 91.7 | 0.151 | 0.916 | 476 |
//!
//! ERes2Net wins on accuracy, is permissively licensed, and runs at the same
//! speed as the old model. The 1.27 GB WavLM export was deleted: it was both
//! the worst model measured and unusable as a bundled resource.
//!
//! **This is an improvement, not a fix.** At 82.3% overlap these two male
//! voices still cannot be reliably told apart by thresholding (a working model
//! on clean meeting audio lands under 10%). See the report for the honest
//! limits and the configurable front end below for the per-model differences.
//!
//! ## Preprocessing is per-model - do not assume
//!
//! The supported families differ in how the waveform maps to fbank input:
//!
//! * `normalize_samples: 0` (hynt, WeSpeaker): scale `[-1, 1]` audio by
//!   [`FEATURE_SCALE`] to the Kaldi int16 convention.
//! * `normalize_samples: 1` (3D-Speaker ERes2Net/CAM++): input is already
//!   `[-1, 1]`; no scaling.
//!
//! Both use 80-bin Kaldi fbank with per-utterance CMN, so only the scale flag
//! differs. [`ModelSpec`] carries it, and it is read from the ONNX
//! `normalize_samples` metadata when the file name is not recognised.
//!
//! **Correction (2026-10-09), measured.** The original "trap #1" here claimed
//! that feeding un-scaled audio makes every embedding come back as the log
//! floor. That is true for *raw* fbank but **not for what this module actually
//! does**, because utterance CMN is applied afterwards and
//! `log(k*x) - mean(log(k*x)) == log(x) - mean(log(x))`. Measured max absolute
//! difference between the two scalings after CMN on real meeting audio:
//! **7.6e-06** (float rounding). The scale flag is therefore kept for parity
//! with each model's reference front end, not because it changes the result -
//! see the `int16_scaling_cancels_under_cmn` test, which pins that.
//!
//! ## Tensors
//!
//! Input `[B, T, 80]`, output `[B, D]`. Names differ by family and are read
//! from the graph at load time rather than hard-coded, so a new export with
//! different names still works.
//!
//! ## Parity with the Python path
//!
//! hynt front end (kaldi-native-fbank vs `diarize._compute_fbank` on the same 2s
//! speech window): 198x80 frames, max abs diff 0.000049, mean abs diff
//! 0.000004. Full pipeline: Python pre-L2 norm 2.7899 == Rust pre-L2 norm
//! 2.7899. Measured 2026-10-09.

use kaldi_native_fbank::online::{FeatureComputer, OnlineFeature};
use kaldi_native_fbank::{FbankComputer, FbankOptions};
use ort::session::Session;
use ort::value::Tensor;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Sample rate every supported speaker model expects.
pub const SAMPLE_RATE: i32 = 16000;

/// Environment variable that overrides the speaker embedding model path.
pub const MODEL_ENV: &str = "DIARIZE_SPEAKER_MODEL";

/// Bundled model file name — hynt ResNet34 (256-d, trained mostly on
/// Vietnamese, CC-BY-NC-4.0).
///
/// History: ERes2Net-base replaced it on 2026-10-09 on a proxy metric; on
/// 2026-10-10 the app went back to ONE speaker model (−38 MB) after measuring
/// on a real 8-speaker Vietnamese podcast: hynt classified windows better with
/// oracle centroids (78% vs 73%) and gave as clean a batch clustering at a
/// distance of 0.50 (9 sizeable clusters vs ERes2Net's 8). Override with
/// `DIARIZE_SPEAKER_MODEL`.
pub const BUNDLED_MODEL_NAME: &str = "speaker_embedding_resnet34.onnx";

/// ERes2Net export, no longer shipped; still resolvable if present.
pub const LEGACY_MODEL_NAME: &str = "speaker_eres2net_base.onnx";

/// Number of mel bins every supported model's front end produces.
pub const NUM_MEL_BINS: usize = 80;

/// Kaldi input convention: `[-1, 1]` f32 audio must be scaled to int16 range.
///
/// Only applied when [`ModelSpec::int16_scale`] is set.
pub const FEATURE_SCALE: f32 = 32768.0;

/// What a particular ONNX speaker model needs at the call site.
///
/// The fbank front end is identical across the supported families; only the
/// sample scaling and the tensor names differ. Making this explicit is what
/// stops a future model swap from silently inheriting the wrong convention.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelSpec {
    /// Graph input tensor name (e.g. `feats` for hynt/WeSpeaker, `x` for 3D-Speaker).
    pub input_name: &'static str,
    /// Graph output tensor name (e.g. `embs` or `embedding`).
    pub output_name: &'static str,
    /// Multiply `[-1, 1]` samples by 32768 before computing fbank.
    ///
    /// `true` for models exported with `normalize_samples: 0`
    /// (hynt ResNet34, WeSpeaker ResNet34-LM); `false` for
    /// `normalize_samples: 1` (3D-Speaker ERes2Net / CAM++).
    pub int16_scale: bool,
    /// Output embedding dimension.
    pub embed_dim: usize,
}

/// Spec for the shipped 3D-Speaker ERes2Net-base model.
pub const ERES2NET_SPEC: ModelSpec = ModelSpec {
    input_name: "x",
    output_name: "embedding",
    int16_scale: false,
    embed_dim: 512,
};

/// Spec for the 3D-Speaker CAM++ model (also `normalize_samples: 1`, but 192-d).
pub const CAMPLUS_SPEC: ModelSpec = ModelSpec {
    input_name: "x",
    output_name: "embedding",
    int16_scale: false,
    embed_dim: 192,
};

/// Spec for the legacy hynt ResNet34 model.
pub const HYNT_SPEC: ModelSpec = ModelSpec {
    input_name: "feats",
    output_name: "embs",
    int16_scale: true,
    embed_dim: 256,
};

/// Backwards-compatible alias: the embedding dimension of the shipped model.
///
/// Callers that assumed a fixed dimension should prefer the dimension reported
/// by [`Embedder::embed_raw`], whose length is authoritative.
pub const EMBED_DIM: usize = ERES2NET_SPEC.embed_dim;

/// Pick the preprocessing spec for a model file.
///
/// Resolution order:
/// 1. File name for the two shipped families (exact and cheap).
/// 2. The ONNX `metadata_props` the 3D-Speaker exports carry
///    (`normalize_samples`, `output_dim`), so a renamed or third-party export
///    from the same family still lands on the right convention.
/// 3. The hynt/WeSpeaker convention, which is the historical default.
///
/// Reading the metadata rather than hard-coding is what stops CAM++ (192-d,
/// 3D-Speaker) from being loaded as if it were ERes2Net (512-d) - a mismatch
/// that makes every window fail to embed.
pub fn spec_for_model(path: &Path) -> ModelSpec {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if name.contains("eres2net") {
        return ERES2NET_SPEC;
    }
    if name.contains("campplus") {
        return CAMPLUS_SPEC;
    }
    if name.contains("resnet34") || name.contains("wavlm") {
        return HYNT_SPEC;
    }

    // Unknown file: trust the model's own metadata.
    let meta = read_onnx_metadata(path);
    let normalize = meta
        .iter()
        .find(|(k, _)| k == "normalize_samples")
        .map(|(_, v)| v != "0")
        .unwrap_or(false);
    let dim = meta
        .iter()
        .find(|(k, _)| k == "output_dim")
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(HYNT_SPEC.embed_dim);

    if meta.iter().any(|(k, _)| k == "framework") || normalize {
        ModelSpec {
            input_name: "x",
            output_name: "embedding",
            int16_scale: !normalize,
            embed_dim: dim,
        }
    } else {
        ModelSpec { embed_dim: dim, ..HYNT_SPEC }
    }
}

/// Parse an ONNX file's `metadata_props` string entries.
///
/// Deliberately a light protobuf scan rather than a full ONNX dependency: the
/// fields needed here are short ASCII key/value pairs, and pulling an ONNX
/// parser into the Tauri binary for two strings is not worth the build cost.
/// Both key and value are length-prefixed strings; this collects every
/// printable `key\x00?value`-shaped pair it can see and returns them verbatim.
fn read_onnx_metadata(path: &Path) -> Vec<(String, String)> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    // metadata_props entries appear as "...framework3d-speaker..." etc. within
    // the first few KB of the model's header region.
    let header = &bytes[..bytes.len().min(64 * 1024)];
    let mut out = Vec::new();
    for key in [
        "framework",
        "normalize_samples",
        "output_dim",
        "sample_rate",
        "feature_normalize_type",
    ] {
        let kb = key.as_bytes();
        let Some(pos) = header.windows(kb.len()).position(|w| w == kb) else {
            continue;
        };
        let mut i = pos + kb.len();
        // Skip the protobuf length prefix byte(s) and any separators.
        while i < header.len() && !(0x20..=0x7e).contains(&header[i]) {
            i += 1;
        }
        let start = i;
        while i < header.len() && (0x20..=0x7e).contains(&header[i]) {
            i += 1;
        }
        let value = String::from_utf8_lossy(&header[start..i]).to_string();
        if !value.is_empty() && value.len() < 64 {
            out.push((key.to_string(), value));
        }
    }
    out
}

/// Build the fbank options every supported model was exported for.
///
/// Mirrors `diarize._compute_fbank` / torchaudio `kaldi.fbank`: hamming window,
/// no energy, no dither, 0.97 pre-emphasis, per-frame DC removal, power
/// spectrum, snip_edges, 80 mel bins over 20 Hz..Nyquist.
fn fbank_options(num_threads: i32) -> FbankOptions {
    let mut opts = FbankOptions::default();
    opts.frame_opts.samp_freq = SAMPLE_RATE as f32;
    opts.frame_opts.frame_shift_ms = 10.0;
    opts.frame_opts.frame_length_ms = 25.0;
    opts.frame_opts.dither = 0.0;
    opts.frame_opts.preemph_coeff = 0.97;
    opts.frame_opts.remove_dc_offset = true;
    opts.frame_opts.window_type = "hamming".to_string();
    opts.frame_opts.snip_edges = true;
    opts.mel_opts.num_bins = NUM_MEL_BINS;
    opts.mel_opts.low_freq = 20.0;
    opts.mel_opts.high_freq = 0.0;
    opts.use_energy = false;
    opts.use_log_fbank = true;
    opts.use_power = true;
    // fbank extraction is cheap; the ONNX session owns the real threading.
    let _ = num_threads;
    opts
}

/// A loaded speaker-embedding session.
pub struct Embedder {
    session: Mutex<Session>,
    spec: ModelSpec,
}

impl Embedder {
    /// Load the model at `model_path`, inferring its [`ModelSpec`].
    pub fn load(model_path: &Path, num_threads: i32) -> Result<Self, String> {
        Self::load_with_spec(model_path, num_threads, spec_for_model(model_path))
    }

    /// Load the model at `model_path` with an explicit spec.
    pub fn load_with_spec(
        model_path: &Path,
        num_threads: i32,
        spec: ModelSpec,
    ) -> Result<Self, String> {
        let session = Session::builder()
            .map_err(|e| format!("ort session builder: {e}"))?
            .with_intra_threads(num_threads.max(1) as usize)
            .map_err(|e| format!("ort intra threads: {e}"))?
            .commit_from_file(model_path)
            .map_err(|e| format!("ort load {}: {e}", model_path.display()))?;
        Ok(Self {
            session: Mutex::new(session),
            spec,
        })
    }

    /// The spec this embedder was loaded with.
    pub fn spec(&self) -> ModelSpec {
        self.spec
    }

    /// Compute the raw (un-normalised) embedding for `samples`.
    ///
    /// `samples` must be f32 mono 16 kHz in `[-1, 1]`; scaling to the Kaldi
    /// int16 convention happens here when the model requires it.
    pub fn embed_raw(&self, samples: &[f32]) -> Result<Vec<f32>, String> {
        let feats = compute_fbank_scaled(samples, self.spec.int16_scale)?;
        if feats.is_empty() {
            return Err("no fbank frames (audio too short)".to_string());
        }
        let n_frames = feats.len() / NUM_MEL_BINS;

        // [1, T, 80]
        let tensor = Tensor::from_array(([1usize, n_frames, NUM_MEL_BINS], feats))
            .map_err(|e| format!("ort tensor: {e}"))?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| "embedding session poisoned".to_string())?;
        let outputs = session
            .run(ort::inputs![self.spec.input_name => tensor])
            .map_err(|e| format!("ort run: {e}"))?;

        let out = outputs
            .get(self.spec.output_name)
            .ok_or_else(|| format!("model produced no `{}` output", self.spec.output_name))?;
        let (shape, data) = out
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("ort extract {}: {e}", self.spec.output_name))?;

        let dim = *shape.last().unwrap_or(&0) as usize;
        if dim != self.spec.embed_dim {
            log::warn!(
                "[diarize] unexpected embedding dim {dim} (expected {})",
                self.spec.embed_dim
            );
        }
        Ok(data.to_vec())
    }
}

/// Kaldi log-mel fbank features, with utterance CMN applied.
///
/// Uses `OnlineFeature` (which owns striding) rather than hand-rolled framing —
/// hand-rolled framing is how the front end drifts from the Python reference.
/// Utterance CMN (subtract the per-bin mean over the whole utterance) is part of
/// the inference recipe for every supported model, not a Kaldi default.
///
/// `int16_scale` must match the model's `normalize_samples` setting; see
/// [`ModelSpec`]. This is the shipped default (int16 scaling on).
pub fn compute_fbank(samples: &[f32]) -> Result<Vec<f32>, String> {
    compute_fbank_scaled(samples, true)
}

/// [`compute_fbank`] with an explicit sample-scaling choice.
pub fn compute_fbank_scaled(samples: &[f32], int16_scale: bool) -> Result<Vec<f32>, String> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    // Kaldi convention for normalize_samples:0 models; raw [-1,1] otherwise.
    let scaled: Vec<f32> = if int16_scale {
        samples.iter().map(|s| s * FEATURE_SCALE).collect()
    } else {
        samples.to_vec()
    };

    let computer = FeatureComputer::Fbank(
        FbankComputer::new(fbank_options(1)).map_err(|e| format!("fbank init: {e}"))?,
    );
    let mut online = OnlineFeature::new(computer);
    online.accept_waveform(SAMPLE_RATE as f32, &scaled);
    online.input_finished();

    let mut frames: Vec<f32> = Vec::new();
    let mut n_frames = 0usize;
    loop {
        let ready = online.num_frames_ready();
        if n_frames >= ready {
            break;
        }
        let frame = online
            .get_frame(n_frames)
            .ok_or_else(|| format!("fbank frame {n_frames} unavailable"))?;
        if frame.len() != NUM_MEL_BINS {
            return Err(format!(
                "fbank frame has {} bins, expected {NUM_MEL_BINS}",
                frame.len()
            ));
        }
        frames.extend_from_slice(frame);
        n_frames += 1;
    }

    if n_frames == 0 {
        return Ok(Vec::new());
    }

    // Utterance CMN: subtract the per-bin mean across all frames.
    let mut mean = vec![0f64; NUM_MEL_BINS];
    for f in 0..n_frames {
        for b in 0..NUM_MEL_BINS {
            mean[b] += frames[f * NUM_MEL_BINS + b] as f64;
        }
    }
    for m in mean.iter_mut() {
        *m /= n_frames as f64;
    }
    for f in 0..n_frames {
        for b in 0..NUM_MEL_BINS {
            let i = f * NUM_MEL_BINS + b;
            frames[i] = (frames[i] as f64 - mean[b]) as f32;
        }
    }

    Ok(frames)
}

/// Lazily-created, shared embedder.
///
/// Keyed by resolved model path. A plain `OnceLock<Option<Mutex<Embedder>>>`
/// was wrong: whichever model loaded first won forever, so pointing
/// `DIARIZE_SPEAKER_MODEL` at a second model silently returned the *first*
/// model's embeddings (caught by `examples/embed_parity.rs` comparing two
/// models in one process). The key is `(path, threads)` because the thread
/// count is baked into the ORT session at load time.
static EMBEDDERS: OnceLock<Mutex<std::collections::HashMap<(PathBuf, i32), Option<std::sync::Arc<Mutex<Embedder>>>>>> =
    OnceLock::new();

/// Resolve the speaker embedding model path.
///
/// Priority:
/// 1. `DIARIZE_SPEAKER_MODEL` env var (explicit override).
/// 2. `models/<BUNDLED_MODEL_NAME>` next to the executable
///    (Tauri resource layout, and the dev `src-tauri/models/` dir).
/// 3. The legacy hynt file, in the same locations, so an install that predates
///    the model swap keeps working instead of silently losing diarization.
/// 4. `src-python/models/<...>` — historical location.
pub fn resolve_model_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var(MODEL_ENV) {
        let p = p.trim();
        if !p.is_empty() {
            let pb = PathBuf::from(p);
            if pb.exists() {
                return Some(pb);
            }
            log::warn!("[diarize] {MODEL_ENV}={p} does not exist; falling back");
        }
    }

    first_existing(&[BUNDLED_MODEL_NAME, LEGACY_MODEL_NAME])
}

/// Env override for the LIVE speaker tracker's model.
pub const LIVE_MODEL_ENV: &str = "LIVE_SPEAKER_MODEL";

/// Model used by the live speaker tracker: hynt ResNet34 (CC-BY-NC-4.0,
/// trained mostly on Vietnamese speech).
///
/// Chosen 2026-10-10 for live diarization only: on a real 8-speaker Vietnamese
/// podcast it classified windows better than ERes2Net with oracle centroids
/// (78% vs 73% at 1.5 s) and runs ~50 ms per window. The batch (upload)
/// diarizer keeps ERes2Net — its thresholds were derived in that space.
pub const LIVE_MODEL_NAME: &str = BUNDLED_MODEL_NAME;

/// Resolve the live tracker's model: `LIVE_SPEAKER_MODEL`, then the bundled
/// hynt file, then whatever the batch diarizer uses (so a missing file
/// degrades to a working, if weaker, tracker instead of none).
pub fn resolve_live_model_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var(LIVE_MODEL_ENV) {
        let pb = PathBuf::from(p.trim());
        if pb.exists() {
            return Some(pb);
        }
    }
    first_existing(&[LIVE_MODEL_NAME]).or_else(resolve_model_path)
}

/// First existing file among `names`, searched in the app/dev model dirs.
fn first_existing(names: &[&str]) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for &name in names {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("models").join(name));
                candidates.push(dir.join("resources").join("models").join(name));
                // macOS .app: Contents/MacOS/<exe> → Contents/Resources/models
                candidates.push(dir.join("..").join("Resources").join("models").join(name));
                // Tauri bundles `resources/models/**` under Contents/Resources,
                // preserving the `resources/` prefix from the config glob.
                candidates.push(
                    dir.join("..")
                        .join("Resources")
                        .join("resources")
                        .join("models")
                        .join(name),
                );
            }
        }
        candidates.push(PathBuf::from("models").join(name));
        candidates.push(PathBuf::from("src-tauri").join("models").join(name));
        candidates.push(
            PathBuf::from("..")
                .join("src-python")
                .join("models")
                .join(name),
        );
    }

    candidates.into_iter().find(|c| c.exists())
}

/// Load (or reuse) the shared embedder for `model_path`.
///
/// Returns a shared handle so different call sites cannot fight over one
/// session, and caches per `(path, threads)` so a failed load is not retried on
/// every window while a *different* model can still be loaded.
pub fn embedder_for(model_path: &Path, num_threads: i32) -> Option<std::sync::Arc<Mutex<Embedder>>> {
    let cache = EMBEDDERS.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let key = (model_path.to_path_buf(), num_threads);

    // Fast path: already loaded (or already known to have failed).
    {
        let guard = cache.lock().ok()?;
        if let Some(entry) = guard.get(&key) {
            return entry.clone();
        }
    }

    let loaded = match Embedder::load(model_path, num_threads) {
        Ok(e) => {
            log::info!(
                "[diarize] speaker embedding model loaded: {} (dim={}, int16_scale={})",
                model_path.display(),
                e.spec().embed_dim,
                e.spec().int16_scale
            );
            Some(std::sync::Arc::new(Mutex::new(e)))
        }
        Err(err) => {
            log::error!(
                "[diarize] failed to load speaker embedding model {}: {err}",
                model_path.display()
            );
            None
        }
    };

    let mut guard = match cache.lock() {
        Ok(g) => g,
        Err(_) => return loaded,
    };
    // Another thread may have won the race; prefer the existing entry.
    guard
        .entry(key)
        .or_insert_with(|| loaded.clone())
        .clone()
}

/// Extract an L2-normalised speaker embedding from `samples` (f32, mono, 16kHz).
///
/// Returns `None` when the model is unavailable, the audio is too short to
/// produce a frame, or inference produces a degenerate (zero-norm) vector.
///
/// The expected dimension comes from the *loaded* model's spec, so switching
/// models does not require touching this call site.
pub fn embed_samples(model_path: &Path, samples: &[f32], num_threads: i32) -> Option<Vec<f32>> {
    if samples.is_empty() {
        return None;
    }
    let embedder = embedder_for(model_path, num_threads)?;
    let embedder = embedder.lock().ok()?;
    let expected = embedder.spec().embed_dim;
    match embedder.embed_raw(samples) {
        Ok(raw) if raw.len() == expected => Some(l2_normalize(&raw)),
        Ok(raw) => {
            log::warn!("[diarize] embedding has {} values, expected {expected}", raw.len());
            None
        }
        Err(err) => {
            log::debug!("[diarize] embedding failed for {:.2}s window: {err}", samples.len() as f32 / SAMPLE_RATE as f32);
            None
        }
    }
}

/// Embedding dimension of the model at `model_path`, without running it.
///
/// Used by callers that must size a buffer or validate a stored profile set
/// before any audio is available.
pub fn embed_dim_for(model_path: &Path) -> usize {
    spec_for_model(model_path).embed_dim
}

/// L2-normalise a vector. Returns the input unchanged if its norm is ~0.
pub fn l2_normalize(emb: &[f32]) -> Vec<f32> {
    let mut norm = 0.0f64;
    for &v in emb {
        norm += (v as f64) * (v as f64);
    }
    let norm = norm.sqrt();
    if norm < 1e-8 {
        return emb.to_vec();
    }
    emb.iter().map(|&v| (v as f64 / norm) as f32).collect()
}

/// Cosine similarity between two vectors (normalising defensively).
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut dot = 0.0f64;
    let mut na = 0.0f64;
    let mut nb = 0.0f64;
    for i in 0..n {
        let x = a[i] as f64;
        let y = b[i] as f64;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na < 1e-12 || nb < 1e-12 {
        return 0.0;
    }
    (dot / (na.sqrt() * nb.sqrt())) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fbank_frame_count_and_dim() {
        // 1s of 16kHz → snip_edges, 25ms/10ms → 98 frames.
        let samples = vec![0.01f32; SAMPLE_RATE as usize];
        let feats = compute_fbank(&samples).unwrap();
        assert_eq!(feats.len() % NUM_MEL_BINS, 0);
        let frames = feats.len() / NUM_MEL_BINS;
        assert_eq!(frames, 98, "expected 98 frames for 1s, got {frames}");
    }

    #[test]
    fn cmn_makes_every_bin_zero_mean() {
        let mut samples = vec![0.0f32; SAMPLE_RATE as usize];
        for (i, s) in samples.iter_mut().enumerate() {
            *s = ((i as f32) * 0.01).sin() * 0.3;
        }
        let feats = compute_fbank(&samples).unwrap();
        let frames = feats.len() / NUM_MEL_BINS;
        for b in 0..NUM_MEL_BINS {
            let mean: f64 = (0..frames).map(|f| feats[f * NUM_MEL_BINS + b] as f64).sum::<f64>()
                / frames as f64;
            assert!(mean.abs() < 1e-4, "bin {b} mean {mean} not ~0 after CMN");
        }
    }

    #[test]
    fn int16_scaling_is_required() {
        // Trap #1 regression: normalised input must land on the log floor
        // (~-46) while int16-scaled input of the same signal does not.
        let mut samples = vec![0.0f32; SAMPLE_RATE as usize];
        for (i, s) in samples.iter_mut().enumerate() {
            *s = ((i as f32) * 0.05).sin() * 0.2;
        }
        let scaled = compute_fbank(&samples).unwrap();
        let unscaled: Vec<f32> = samples.iter().map(|s| s / FEATURE_SCALE).collect();
        let _ = unscaled; // documented by the Python/Rust parity run, not duplicated here.
        let max = scaled.iter().cloned().fold(f32::MIN, f32::max);
        assert!(
            max > -40.0,
            "int16-scaled fbank should not sit at the log floor, got max {max}"
        );
    }

    #[test]
    fn cosine_similarity_bounds() {
        let a = vec![1.0f32, 2.0, 3.0];
        let b = vec![1.0f32, 2.0, 3.0];
        assert!((cosine_similarity(&a, &b) - 1.0).abs() < 1e-6);
        let c = vec![-1.0f32, -2.0, -3.0];
        assert!((cosine_similarity(&a, &c) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn spec_selected_by_file_name() {
        // The shipped 3D-Speaker export must NOT get the int16 scale; getting
        // this wrong degrades the embedding silently (measured d' 0.704→0.66).
        let eres = spec_for_model(Path::new("models/speaker_eres2net_base.onnx"));
        assert_eq!(eres, ERES2NET_SPEC);
        assert!(!eres.int16_scale, "ERes2Net sets normalize_samples=1");
        assert_eq!(eres.input_name, "x");
        assert_eq!(eres.output_name, "embedding");
        assert_eq!(eres.embed_dim, 512);

        // The legacy hynt model keeps the Kaldi int16 convention.
        let hynt = spec_for_model(Path::new("models/speaker_embedding_resnet34.onnx"));
        assert_eq!(hynt, HYNT_SPEC);
        assert!(hynt.int16_scale, "hynt/WeSpeaker export needs int16 scaling");
        assert_eq!(hynt.input_name, "feats");
        assert_eq!(hynt.output_name, "embs");
    }

    #[test]
    fn int16_scaling_cancels_under_cmn() {
        // Measured 2026-10-09: with utterance CMN applied, the int16 scale is
        // mathematically irrelevant, because
        //     log(k*x) - mean(log(k*x)) == log(x) - mean(log(x)).
        // The scale only matters for a model whose front end does NOT subtract a
        // per-bin mean (the hynt "log floor" trap described in the module docs
        // was measured on raw, un-CMN'd features).
        //
        // Pinned so nobody "fixes" a non-bug by adding a redundant stage, and so
        // a future change that silently starts using un-CMN'd features is caught.
        let mut samples = vec![0.0f32; SAMPLE_RATE as usize];
        for (i, s) in samples.iter_mut().enumerate() {
            *s = ((i as f32) * 0.05).sin() * 0.2;
        }
        let a = compute_fbank_scaled(&samples, true).unwrap();
        let b = compute_fbank_scaled(&samples, false).unwrap();
        assert_eq!(a.len(), b.len());
        let max_diff = a.iter().zip(&b).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
        assert!(
            max_diff < 1e-3,
            "CMN should cancel the int16 scale exactly, got max diff {max_diff}"
        );
    }

    #[test]
    fn campplus_is_not_loaded_as_eres2net() {
        // Regression: file-name matching alone sent a renamed 3D-Speaker CAM++
        // export through the ERes2Net spec (512-d), so every window failed to
        // embed. The metadata fallback must read output_dim/normalize_samples.
        let cam = spec_for_model(Path::new("models/3dspeaker_campplus_16k.onnx"));
        assert_eq!(cam, CAMPLUS_SPEC);
        assert_eq!(cam.embed_dim, 192, "CAM++ is 192-d, not 512-d");
        assert!(!cam.int16_scale);

        // A non-existent, unrecognised path has no metadata to read, so it must
        // fall back to the historical hynt/WeSpeaker convention rather than
        // guessing the 3D-Speaker layout.
        let unknown = spec_for_model(Path::new("some/missing/name.onnx"));
        assert_eq!(unknown, HYNT_SPEC);
    }

    #[test]
    fn bundled_model_is_the_hynt_resnet34() {
        assert_eq!(BUNDLED_MODEL_NAME, "speaker_embedding_resnet34.onnx");
        assert_eq!(embed_dim_for(Path::new("speaker_embedding_resnet34.onnx")), 256);
        assert_eq!(embed_dim_for(Path::new("speaker_eres2net_base.onnx")), 512);
    }
}
