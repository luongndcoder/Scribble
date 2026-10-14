//! Local (offline) STT engines built on sherpa-onnx.
//!
//! Ported from `src-python/local_stt.py`:
//!   - [`StreamingZipformerEngine`] ← `StreamingZipformerEngine` (online RNNT)
//!   - [`SherpaOfflineEngine`]      ← `SherpaOnnxEngine` (offline transducer)
//!   - [`LocalStreamingStt`]        ← `LocalStreamingSTT` (frame quantizer + worker)
//!
//! Tier A (MLX nemotron) from the Python module is deliberately NOT ported — it
//! is Apple-only Python and the Rust backend uses the bundled sherpa-onnx model
//! on every platform.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use sherpa_onnx::{
    OfflineModelConfig, OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig,
    OnlineModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineStream,
    OnlineTransducerModelConfig,
};

use super::speaker_segments::{group_by_speaker, tokens_text, TokenGroup};
use super::speaker_tracker::{speaker_label, SpeakerTimeline};
use super::text::{pcm_i16_to_f32, postprocess_local};

pub const SAMPLE_RATE: i32 = 16000;

/// Relative location of the bundled streaming model inside the repo.
pub const STREAMING_MODEL_SUBDIR: &str =
    "src-python/models/local/sherpa-onnx-zipformer-vi-streaming-30M";
/// Relative location of the bundled offline (int8) model inside the repo.
pub const OFFLINE_MODEL_SUBDIR: &str =
    "src-python/models/local/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09";

/// Repo root, derived from this crate's manifest dir (`<repo>/src-tauri`).
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}


/// macOS/Linux packaged layout: Tauri puts `resources/**` under
/// `<exe dir>/../Resources/` on macOS and next to the exe on Linux/Windows.
/// We keep the `resources/` prefix because the config lists
/// `resources/models/**/*`.
fn packaged_resource_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(exe) = std::env::current_exe() else { return out };
    let Some(dir) = exe.parent() else { return out };
    // macOS: Scribble.app/Contents/MacOS/Scribble -> Contents/Resources/
    out.push(dir.join("../Resources/resources"));
    out.push(dir.join("../Resources"));
    // Linux/Windows: alongside the executable
    out.push(dir.join("resources"));
    out.push(dir.to_path_buf());
    out
}

/// Resolve the streaming model directory.
///
/// Order: `VOICESCRIBE_STT_MODEL_DIR` override → repo-relative bundled dir →
/// `<exe dir>/models/...` (packaged app layout).
pub fn streaming_model_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("VOICESCRIBE_STT_MODEL_DIR") {
        let p = PathBuf::from(p);
        if p.join("tokens.txt").is_file() {
            return Some(p);
        }
    }
    let bundled = repo_root().join(STREAMING_MODEL_SUBDIR);
    if bundled.join("tokens.txt").is_file() {
        return Some(bundled);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("models/local/sherpa-onnx-zipformer-vi-streaming-30M");
            if p.join("tokens.txt").is_file() {
                return Some(p);
            }
        }
    }
    // Packaged Tauri bundle: Contents/Resources/resources/models/local/...
    for base in packaged_resource_dirs() {
        let p = base.join("models/local/sherpa-onnx-zipformer-vi-streaming-30M");
        if p.join("tokens.txt").is_file() {
            return Some(p);
        }
    }
    None
}

/// Resolve the offline model directory (same search order as streaming).
pub fn offline_model_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("VOICESCRIBE_STT_OFFLINE_MODEL_DIR") {
        let p = PathBuf::from(p);
        if p.join("tokens.txt").is_file() {
            return Some(p);
        }
    }
    let bundled = repo_root().join(OFFLINE_MODEL_SUBDIR);
    if bundled.join("tokens.txt").is_file() {
        return Some(bundled);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("models/local/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09");
            if p.join("tokens.txt").is_file() {
                return Some(p);
            }
        }
    }
    for base in packaged_resource_dirs() {
        let p = base.join("models/local/sherpa-onnx-zipformer-vi-30M-int8-2026-02-09");
        if p.join("tokens.txt").is_file() {
            return Some(p);
        }
    }
    None
}

// ── Streaming (online) Zipformer ─────────────────────────────────────────────

/// What the live worker needs from a streaming recogniser. Implemented by the
/// sherpa-onnx engine (Zipformer / Nemotron ONNX) and, on macOS, by the MLX
/// Nemotron engine — so endpoints, partials and per-token speaker labelling
/// are engine-agnostic.
pub trait StreamingAsr: Send + Sync {
    /// Feed 16 kHz mono f32 PCM and decode whatever is ready.
    fn accept(&self, pcm: &[f32]);
    /// Stream is ending: decode buffered audio that waits for more context.
    fn flush(&self) {}
    fn is_endpoint(&self) -> bool;
    /// Tokens of the current utterance with times (s) from the utterance start.
    fn tokens(&self) -> (Vec<String>, Vec<f32>);
    fn partial_text(&self, language: &str) -> String;
    /// Return the finished utterance text and start a new utterance.
    fn finalize(&self, language: &str) -> String;
    fn set_language(&self, language: &str);
    /// A new recording starts on this (cached, shared) engine.
    fn reset_stream(&self) {}
}

/// Which streaming transducer a model directory holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamingModelKind {
    /// Bundled Vietnamese Zipformer-30M (fp16, raw ALL-CAPS output).
    Zipformer,
    /// NVIDIA Nemotron 3.5 ASR Streaming 0.6B, sherpa-onnx int8 export
    /// (multilingual, cased + punctuated output, per-stream language prompt).
    Nemotron,
}

impl StreamingModelKind {
    /// Tell the two packages apart by their files: Zipformer ships fp16
    /// graphs, the Nemotron sherpa package ships int8 graphs.
    pub fn detect(model_dir: &Path) -> Self {
        if model_dir.join("encoder.int8.onnx").is_file()
            && !model_dir.join("encoder.fp16.onnx").is_file()
        {
            Self::Nemotron
        } else {
            Self::Zipformer
        }
    }
}

/// sherpa-onnx ONLINE (streaming) transducer — Vietnamese Zipformer-30M RNNT,
/// or Nemotron 3.5 (see [`StreamingModelKind`]).
///
/// Unlike the offline engine (one-shot per segment), this keeps decode state
/// across `accept()` calls, so recognition starts while the speaker is still
/// talking (~25-37x realtime on CPU, measured on a 6.7min VI meeting).
///
/// Zipformer: `model_type` MUST be `"zipformer2"`. The exporter wrote
/// `zipformer2` metadata; asking sherpa for plain `"zipformer"` fails with
/// `'attention_dims' does not exist in the metadata`. Nemotron: sherpa reads
/// the NeMo cache-aware layout and prompt dictionary from the encoder
/// metadata, so `model_type` is left unset.
pub struct StreamingZipformerEngine {
    recognizer: OnlineRecognizer,
    stream: OnlineStream,
    kind: StreamingModelKind,
}

impl StreamingZipformerEngine {
    pub fn new(model_dir: &Path) -> Option<Self> {
        let kind = StreamingModelKind::detect(model_dir);
        let file = |name: &str| Some(model_dir.join(name).to_string_lossy().into_owned());
        let mut cfg = OnlineRecognizerConfig::default();
        cfg.feat_config.sample_rate = SAMPLE_RATE;
        cfg.model_config = match kind {
            StreamingModelKind::Zipformer => {
                cfg.feat_config.feature_dim = 80;
                OnlineModelConfig {
                    transducer: OnlineTransducerModelConfig {
                        encoder: file("encoder.fp16.onnx"),
                        decoder: file("decoder.fp16.onnx"),
                        joiner: file("joiner.fp16.onnx"),
                    },
                    tokens: file("tokens.txt"),
                    num_threads: 2,
                    model_type: Some("zipformer2".to_string()),
                    ..Default::default()
                }
            }
            StreamingModelKind::Nemotron => {
                // Nemotron's NeMo preprocessor uses 128 mel bins.
                cfg.feat_config.feature_dim = 128;
                OnlineModelConfig {
                    transducer: OnlineTransducerModelConfig {
                        encoder: file("encoder.int8.onnx"),
                        decoder: file("decoder.int8.onnx"),
                        joiner: file("joiner.int8.onnx"),
                    },
                    tokens: file("tokens.txt"),
                    // 0.6B parameters: give it more cores than the 30M model.
                    num_threads: 4,
                    ..Default::default()
                }
            }
        };
        cfg.decoding_method = Some("greedy_search".to_string());
        // Endpoint rules: close an utterance after 2.0s trailing silence, or
        // 0.85s when the decoder already produced something decodable, or
        // after 20s of continuous speech on the next breath pause. Tuned for
        // natural Vietnamese sentence breaks.
        cfg.enable_endpoint = true;
        cfg.rule1_min_trailing_silence = 2.0;
        cfg.rule2_min_trailing_silence = 0.85;
        cfg.rule3_min_utterance_length = 20.0;

        let recognizer = OnlineRecognizer::create(&cfg)?;
        let stream = recognizer.create_stream();
        Some(Self { recognizer, stream, kind })
    }

    pub fn kind(&self) -> StreamingModelKind {
        self.kind
    }

    /// Nemotron only: per-stream language prompt (`vi`, `en`, …; `auto` or
    /// empty = the model's auto-detect prompt). A no-op for Zipformer, which
    /// is Vietnamese-only.
    pub fn set_language(&self, language: &str) {
        if self.kind == StreamingModelKind::Nemotron {
            let lang = if language.trim().is_empty() { "auto" } else { language.trim() };
            self.stream.set_option("language", lang);
        }
    }

    /// Feed f32 PCM and decode every ready frame.
    pub fn accept(&self, pcm_f32: &[f32]) {
        self.stream.accept_waveform(SAMPLE_RATE, pcm_f32);
        while self.recognizer.is_ready(&self.stream) {
            self.recognizer.decode(&self.stream);
        }
    }

    pub fn is_endpoint(&self) -> bool {
        self.recognizer.is_endpoint(&self.stream)
    }

    /// Raw recognizer text (unprocessed).
    pub fn raw_text(&self) -> String {
        self.recognizer
            .get_result(&self.stream)
            .map(|r| r.text.trim().to_string())
            .unwrap_or_default()
    }

    /// Decoded BPE tokens of the current utterance with their timestamps
    /// (seconds, as reported by sherpa). Greedy search only ever appends
    /// tokens, so an index into this list stays valid until `finalize`.
    pub fn tokens(&self) -> (Vec<String>, Vec<f32>) {
        match self.recognizer.get_result(&self.stream) {
            Some(r) => {
                let ts = r.timestamps.unwrap_or_default();
                (r.tokens, ts)
            }
            None => (Vec::new(), Vec::new()),
        }
    }

    /// Interim text for the live preview — post-processed like a final.
    ///
    /// Regression 2026-10-09: this used to return the RAW recognizer output, so
    /// the interim row on screen was unpunctuated ALL-CAPS while committed
    /// finals looked normal. The interim preview MUST go through the same
    /// cleanup (lowercase → VI normalize → repeat collapse).
    pub fn partial_text(&self, language: &str) -> String {
        postprocess_local(&self.raw_text(), language)
    }

    /// Return the finished utterance text and reset for the next one.
    pub fn finalize(&self, language: &str) -> String {
        let text = self.partial_text(language);
        self.recognizer.reset(&self.stream);
        text
    }

    /// Whole-buffer convenience path (one utterance, then reset).
    pub fn transcribe_pcm(&self, pcm_f32: &[f32], language: &str) -> String {
        self.accept(pcm_f32);
        self.finalize(language)
    }

    /// Mark end-of-input and drain the decoder (used by the file smoke test).
    pub fn input_finished(&self) {
        self.stream.input_finished();
        while self.recognizer.is_ready(&self.stream) {
            self.recognizer.decode(&self.stream);
        }
    }
}

// ── Offline (whole-file) Zipformer ───────────────────────────────────────────

/// sherpa-onnx offline transducer recognizer (Vietnamese).
pub struct SherpaOfflineEngine {
    recognizer: OfflineRecognizer,
}

impl SherpaOfflineEngine {
    pub fn new(model_dir: &Path) -> Option<Self> {
        let mut cfg = OfflineRecognizerConfig::default();
        cfg.feat_config.sample_rate = SAMPLE_RATE;
        cfg.feat_config.feature_dim = 80;
        cfg.model_config = OfflineModelConfig {
            transducer: OfflineTransducerModelConfig {
                encoder: Some(model_dir.join("encoder.int8.onnx").to_string_lossy().into_owned()),
                decoder: Some(model_dir.join("decoder.onnx").to_string_lossy().into_owned()),
                joiner: Some(model_dir.join("joiner.int8.onnx").to_string_lossy().into_owned()),
            },
            tokens: Some(model_dir.join("tokens.txt").to_string_lossy().into_owned()),
            num_threads: 4,
            model_type: None,
            ..Default::default()
        };
        cfg.decoding_method = Some("greedy_search".to_string());

        let recognizer = OfflineRecognizer::create(&cfg)?;
        Some(Self { recognizer })
    }

    /// Decode one PCM buffer and run the shared local post-processing.
    pub fn transcribe_pcm(&self, pcm_f32: &[f32], language: &str) -> String {
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(SAMPLE_RATE, pcm_f32);
        self.recognizer.decode(&stream);
        let raw = stream
            .get_result()
            .map(|r| r.text.trim().to_string())
            .unwrap_or_default();
        postprocess_local(&raw, language)
    }
}

// ── Engine caches (local_stt.py get_stream_engine / get_engine) ──────────────

/// One recognizer per model dir — building one loads ONNX sessions (expensive).
///
/// NOTE: these are process-lifetime caches, so the recognizer is destroyed by
/// Rust's static destructor at exit. onnxruntime aborts the process if a session
/// is torn down from a thread it rejects, so call [`clear_engine_caches`] during
/// an orderly shutdown to drop the sessions while the caller is still alive.
static STREAM_CACHE: OnceLock<Mutex<std::collections::HashMap<String, Arc<dyn StreamingAsr>>>> =
    OnceLock::new();
static OFFLINE_CACHE: OnceLock<Mutex<std::collections::HashMap<String, Arc<SherpaOfflineEngine>>>> =
    OnceLock::new();

/// Drop every cached recognizer. Call at shutdown (after all streams ended) so
/// the ONNX sessions are released deterministically instead of at process exit.
pub fn clear_engine_caches() {
    if let Some(c) = STREAM_CACHE.get() {
        let mut g = match c.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        g.clear();
    }
    if let Some(c) = OFFLINE_CACHE.get() {
        let mut g = match c.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        g.clear();
    }
}

/// Build the right engine for a model dir: the MLX Nemotron checkpoint on
/// macOS (`model.safetensors` + `config.json`), otherwise sherpa-onnx.
fn build_stream_engine(model_dir: &Path) -> Option<Arc<dyn StreamingAsr>> {
    #[cfg(all(target_os = "macos", feature = "mlx"))]
    if super::nemotron_mlx::is_mlx_dir(model_dir) {
        return super::nemotron_mlx::NemotronMlxEngine::new(model_dir)
            .map(|e| Arc::new(e) as Arc<dyn StreamingAsr>);
    }
    StreamingZipformerEngine::new(model_dir).map(|e| Arc::new(e) as Arc<dyn StreamingAsr>)
}

impl StreamingAsr for StreamingZipformerEngine {
    fn accept(&self, pcm: &[f32]) {
        StreamingZipformerEngine::accept(self, pcm)
    }
    fn is_endpoint(&self) -> bool {
        StreamingZipformerEngine::is_endpoint(self)
    }
    fn tokens(&self) -> (Vec<String>, Vec<f32>) {
        StreamingZipformerEngine::tokens(self)
    }
    fn partial_text(&self, language: &str) -> String {
        StreamingZipformerEngine::partial_text(self, language)
    }
    fn finalize(&self, language: &str) -> String {
        StreamingZipformerEngine::finalize(self, language)
    }
    fn set_language(&self, language: &str) {
        StreamingZipformerEngine::set_language(self, language)
    }
}

/// Shared streaming engine for a model dir (built once, reused across requests).
pub fn get_stream_engine(model_dir: &Path) -> Option<Arc<dyn StreamingAsr>> {
    let key = model_dir.to_string_lossy().into_owned();
    let cache = STREAM_CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some(e) = map.get(&key) {
            return Some(e.clone());
        }
    }
    let engine = build_stream_engine(model_dir)?;
    if let Ok(mut map) = cache.lock() {
        map.insert(key, engine.clone());
    }
    Some(engine)
}

/// Shared offline engine for a model dir.
pub fn get_offline_engine(model_dir: &Path) -> Option<Arc<SherpaOfflineEngine>> {
    let key = model_dir.to_string_lossy().into_owned();
    let cache = OFFLINE_CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some(e) = map.get(&key) {
            return Some(e.clone());
        }
    }
    let engine = Arc::new(SherpaOfflineEngine::new(model_dir)?);
    if let Ok(mut map) = cache.lock() {
        map.insert(key, engine.clone());
    }
    Some(engine)
}

// ── LocalStreamingSTT (frame quantizer + worker thread) ──────────────────────

/// Near-realtime offline STT for live recording.
///
/// Streams incoming 16kHz mono PCM straight into the sherpa `OnlineRecognizer`,
/// which owns endpointing. Emits `{text, is_final}` results. Mirrors the Python
/// `LocalStreamingSTT` feed contract exactly: 20ms frame quantization with a
/// leftover tail, a stop-flush of the tail, and no audio accepted after stop.
pub struct LocalStreamingStt {
    language: String,
    frame_bytes: usize,
    tail: Mutex<Vec<u8>>,
    stopped: std::sync::atomic::AtomicBool,
    /// Quantized audio jobs + optional flush marker + `None` sentinel on stop.
    tx: std::sync::mpsc::Sender<Option<(Vec<u8>, bool)>>,
}

/// 20ms @ 16kHz, 16-bit mono.
pub const FRAME_SAMPLES: usize = 320;
pub const FRAME_BYTES: usize = FRAME_SAMPLES * 2;

impl LocalStreamingStt {
    /// Load the model FIRST, then start consuming audio.
    ///
    /// Regression 2026-10-09: the Python worker used to load the model
    /// asynchronously (~2s) while `feed_audio` already queued PCM. Every queued
    /// chunk that arrived before the load finished was DROPPED — the first
    /// seconds of every recording vanished (and a short recording could lose
    /// all of it, producing an empty transcript). Loading synchronously here
    /// means once this constructor returns, no audio is lost.
    ///
    /// `timeline` (from a running `SpeakerTracker`) labels each token with its
    /// speaker; `None` labels everything "Speaker 1".
    pub fn start(
        model_dir: &Path,
        language: &str,
        timeline: Option<Arc<Mutex<SpeakerTimeline>>>,
        on_event: impl Fn(super::SttEvent) + Send + 'static,
    ) -> Option<Self> {
        let engine = get_stream_engine(model_dir)?;
        // The engine is cached and shared across recordings, so the language
        // prompt must be (re)applied per session.
        engine.reset_stream();
        engine.set_language(language);
        let (tx, rx) = std::sync::mpsc::channel::<Option<(Vec<u8>, bool)>>();
        let language_owned = language.to_string();
        let language_for_worker = language_owned.clone();

        std::thread::Builder::new()
            .name("local-stt-worker".to_string())
            .spawn(move || {
                run_local_worker(rx, engine, language_for_worker, timeline, on_event);
            })
            .ok()?;

        Some(Self {
            language: language_owned,
            frame_bytes: FRAME_BYTES,
            tail: Mutex::new(Vec::new()),
            stopped: std::sync::atomic::AtomicBool::new(false),
            tx,
        })
    }

    /// Queue PCM at frame granularity; the worker streams it to the model.
    pub fn feed_audio(&self, pcm: &[u8]) {
        use std::sync::atomic::Ordering;
        if self.stopped.load(Ordering::SeqCst) || pcm.is_empty() {
            return;
        }
        let frames = {
            let mut tail = match self.tail.lock() {
                Ok(t) => t,
                Err(p) => p.into_inner(),
            };
            tail.extend_from_slice(pcm);
            let n = tail.len() - (tail.len() % self.frame_bytes);
            if n == 0 {
                return;
            }
            let frames = tail[..n].to_vec();
            tail.drain(..n);
            frames
        };
        let _ = self.tx.send(Some((frames, false)));
    }

    /// Flush the partial-frame tail and stop the worker.
    pub fn stop(&self) {
        use std::sync::atomic::Ordering;
        self.stopped.store(true, Ordering::SeqCst);
        let tail = {
            let mut t = match self.tail.lock() {
                Ok(t) => t,
                Err(p) => p.into_inner(),
            };
            std::mem::take(&mut *t)
        };
        if !tail.is_empty() {
            let _ = self.tx.send(Some((tail, true)));
        }
        let _ = self.tx.send(None);
    }

    pub fn language(&self) -> &str {
        &self.language
    }
}

/// Emit partials at most this often (interim UI preview).
///
/// Python used 800ms; at that rate the live line visibly jumped a few words at
/// a time. `partial_text` is decoded on every frame batch anyway, so emitting
/// more often only costs a small JSON message.
pub const PARTIAL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);

fn samples_to_ms(samples: u64) -> i64 {
    (samples * 1000 / SAMPLE_RATE as u64) as i64
}

fn with_speaker(mut evt: super::SttEvent, speaker: i64) -> super::SttEvent {
    evt.speaker = Some(speaker_label(speaker));
    evt.speaker_id = Some(speaker);
    evt
}

/// Per-stream state of the speaker-aware worker.
struct LiveUtterance {
    language: String,
    timeline: Option<Arc<Mutex<SpeakerTimeline>>>,
    session_tag: u128,
    seg_index: u64,
    /// Samples fed so far (stream clock).
    total_samples: u64,
    /// Stream sample where the current recognizer utterance began (token
    /// timestamps are relative to it — verified on real audio).
    origin: u64,
    /// Tokens of the current utterance already emitted as finals.
    committed: usize,
    /// First batch in which the utterance produced text (trims leading
    /// silence off the first final's start offset).
    utt_start: Option<u64>,
    last_partial: String,
    last_partial_at: std::time::Instant,
}

impl LiveUtterance {
    fn next_chunk_id(&mut self) -> String {
        self.seg_index += 1;
        format!("local-{}-{}", self.session_tag, self.seg_index)
    }

    fn speaker_at(&self, t: u64) -> i64 {
        self.timeline
            .as_ref()
            .and_then(|tl| tl.lock().ok().map(|tl| tl.speaker_at(t)))
            .unwrap_or(0)
    }

    fn stable_until(&self) -> u64 {
        match &self.timeline {
            Some(tl) => tl.lock().map(|tl| tl.stable_until()).unwrap_or(0),
            // No tracker: one speaker, so every token is settled.
            None => u64::MAX,
        }
    }

    fn token_times(&self, ts: &[f32]) -> Vec<u64> {
        ts.iter().map(|s| self.origin + (s.max(0.0) * SAMPLE_RATE as f32) as u64).collect()
    }

    /// Emit `groups` as finals. `end_of_last` closes the last group's span.
    fn emit_groups(
        &mut self,
        tokens: &[String],
        times: &[u64],
        groups: &[TokenGroup],
        end_of_last: u64,
        on_event: &impl Fn(super::SttEvent),
    ) {
        for (gi, g) in groups.iter().enumerate() {
            let text = postprocess_local(&tokens_text(tokens, g.start, g.end), &self.language);
            let start = if g.start == 0 {
                self.utt_start.unwrap_or(times[0]).min(times[0])
            } else {
                times[g.start]
            };
            let end = groups.get(gi + 1).map(|n| times[n.start]).unwrap_or(end_of_last);
            if !text.is_empty() {
                let id = self.next_chunk_id();
                on_event(with_speaker(timed_final(text, id, start, end), g.speaker));
            }
        }
    }

    /// Endpoint / stream end: emit every remaining token, then reset.
    fn finish_utterance(&mut self, engine: &dyn StreamingAsr, on_event: &impl Fn(super::SttEvent)) {
        let (tokens, ts) = engine.tokens();
        let times = self.token_times(&ts);
        let whole_text = engine.finalize(&self.language);
        if !tokens.is_empty() && times.len() == tokens.len() {
            let groups = group_by_speaker(&tokens, &times, self.committed, tokens.len(), |t| self.speaker_at(t));
            if self.committed == 0 && groups.len() == 1 {
                // Single speaker, nothing emitted early: use the engine's own
                // text so output stays byte-identical to the reference.
                if !whole_text.is_empty() {
                    let start = self.utt_start.unwrap_or(times[0]).min(times[0]);
                    let id = self.next_chunk_id();
                    on_event(with_speaker(timed_final(whole_text, id, start, self.total_samples), groups[0].speaker));
                }
            } else {
                let end = self.total_samples;
                self.emit_groups(&tokens, &times, &groups, end, on_event);
            }
        } else if !whole_text.is_empty() {
            let start = self.utt_start.unwrap_or(self.origin);
            let id = self.next_chunk_id();
            let spk = self.speaker_at(start);
            on_event(with_speaker(timed_final(whole_text, id, start, self.total_samples), spk));
        }
        self.origin = self.total_samples;
        self.committed = 0;
        self.utt_start = None;
        self.last_partial.clear();
    }

    /// Mid-utterance: commit settled speaker runs early, then refresh the
    /// partial (the not-yet-settled tail, labelled with its current guess).
    fn update(&mut self, engine: &dyn StreamingAsr, batch_start: u64, on_event: &impl Fn(super::SttEvent)) {
        let (tokens, ts) = engine.tokens();
        if tokens.is_empty() || ts.len() != tokens.len() {
            return;
        }
        if self.utt_start.is_none() {
            self.utt_start = Some(batch_start);
        }
        let times = self.token_times(&ts);
        let mut force_partial = false;

        // Settled tokens are those before the tracker's stable point. A run
        // can be committed only once a LATER settled run belongs to someone
        // else — that is a confirmed speaker change.
        let stable = self.stable_until();
        let settled = self.committed + times[self.committed..].iter().take_while(|&&t| t < stable).count();
        let groups = group_by_speaker(&tokens, &times, self.committed, settled, |t| self.speaker_at(t));
        if groups.len() >= 2 {
            let done = &groups[..groups.len() - 1];
            let next_start = groups[groups.len() - 1].start;
            let end = times[next_start];
            self.emit_groups(&tokens, &times, done, end, on_event);
            self.committed = next_start;
            force_partial = true;
        }

        let raw = tokens_text(&tokens, self.committed, tokens.len());
        let partial = postprocess_local(&raw, &self.language);
        let now = std::time::Instant::now();
        if !partial.is_empty()
            && (force_partial
                || (partial != self.last_partial
                    && now.duration_since(self.last_partial_at) >= PARTIAL_INTERVAL))
        {
            let spk = self.speaker_at(times[self.committed.min(times.len() - 1)]);
            self.last_partial = partial.clone();
            self.last_partial_at = now;
            on_event(with_speaker(super::SttEvent::partial(partial), spk));
        }
    }
}

/// A final with a stable chunk id and its audio offsets.
fn timed_final(text: String, chunk_id: String, start: u64, end: u64) -> super::SttEvent {
    let mut evt = super::SttEvent::final_text(text);
    evt.chunk_id = Some(chunk_id);
    evt.start_ms = Some(samples_to_ms(start));
    evt.end_ms = Some(samples_to_ms(end.max(start)));
    evt
}

fn run_local_worker(
    rx: std::sync::mpsc::Receiver<Option<(Vec<u8>, bool)>>,
    engine: Arc<dyn StreamingAsr>,
    language: String,
    timeline: Option<Arc<Mutex<SpeakerTimeline>>>,
    on_event: impl Fn(super::SttEvent),
) {
    let mut u = LiveUtterance {
        language,
        timeline,
        session_tag: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        seg_index: 0,
        total_samples: 0,
        origin: 0,
        committed: 0,
        utt_start: None,
        last_partial: String::new(),
        last_partial_at: std::time::Instant::now() - PARTIAL_INTERVAL,
    };

    while let Ok(item) = rx.recv() {
        let (pcm_bytes, is_final_flush) = match item {
            Some(v) => v,
            None => break,
        };
        let samples = pcm_i16_to_f32(&pcm_bytes);
        let batch_start = u.total_samples;
        u.total_samples += samples.len() as u64;
        engine.accept(&samples);
        if is_final_flush {
            engine.flush();
        }

        if engine.is_endpoint() || is_final_flush {
            // Endpoint, or stream closing — emit everything decoded.
            u.finish_utterance(engine.as_ref(), &on_event);
        } else {
            u.update(engine.as_ref(), batch_start, &on_event);
        }
    }
}

// ── Offline file transcription ───────────────────────────────────────────────

/// Dedicated streaming recognizer for uploads — separate from the live one
/// (which is shared with an ongoing recording) and serialised by the mutex.
/// Keyed by model dir so switching Zipformer ↔ Nemotron rebuilds it.
static UPLOAD_ENGINE: OnceLock<Mutex<Option<(PathBuf, Arc<dyn StreamingAsr>)>>> = OnceLock::new();

/// Model dir for uploads: the engine picked in Settings → Local
/// (`local_engine`). Nemotron falls back to the bundled Zipformer while it is
/// not downloaded, so an upload never fails just because of that choice.
fn upload_model_dir() -> Option<PathBuf> {
    let use_nemotron = crate::db::Database::get()
        .and_then(|db| db.get_setting("local_engine").ok().flatten())
        .is_some_and(|v| v.trim() == "nemotron");
    if use_nemotron {
        if let Some(dir) = super::model_download::nemotron_model_dir() {
            return Some(dir);
        }
        log::warn!("[local-stt] FAILED: nemotron selected but not downloaded, upload uses zipformer");
    }
    streaming_model_dir()
}

/// Transcribe a 16kHz mono WAV file fully offline with the selected local
/// engine (bundled streaming Zipformer or the downloaded Nemotron).
///
/// The app no longer ships the separate offline Zipformer (−26 MB,
/// 2026-10-10): the whole file is fed through the streaming recognizer and
/// every endpoint's text is joined.
pub fn transcribe_wav_file(path: &Path, language: &str) -> Result<String, String> {
    let model_dir = upload_model_dir().ok_or_else(|| {
        "Model local chưa sẵn sàng — cài lại app hoặc tải model offline.".to_string()
    })?;
    let bytes = std::fs::read(path).map_err(|e| format!("read {path:?}: {e}"))?;
    let pcm = super::text::strip_wav_header(&bytes);
    if pcm.is_empty() {
        return Ok(String::new());
    }
    let cell = UPLOAD_ENGINE.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap_or_else(|p| p.into_inner());
    if guard.as_ref().map(|(dir, _)| dir != &model_dir).unwrap_or(true) {
        *guard = None; // drop the old engine before loading another model
        *guard = build_stream_engine(&model_dir).map(|e| (model_dir.clone(), e));
    }
    let engine = guard
        .as_ref()
        .map(|(_, e)| e.clone())
        .ok_or_else(|| "Không khởi tạo được streaming recognizer".to_string())?;
    // Each file is an independent stream: fresh clock + caches (Nemotron).
    engine.reset_stream();
    engine.set_language(language);

    let mut samples = pcm_i16_to_f32(&pcm);
    // Trailing silence lets the last endpoint fire before the final flush.
    samples.extend(std::iter::repeat(0.0).take(SAMPLE_RATE as usize));
    let mut parts: Vec<String> = Vec::new();
    for chunk in samples.chunks(1600) {
        engine.accept(chunk);
        if engine.is_endpoint() {
            let t = engine.finalize(language);
            if !t.is_empty() {
                parts.push(t);
            }
        }
    }
    engine.flush();
    let t = engine.finalize(language);
    if !t.is_empty() {
        parts.push(t);
    }
    Ok(parts.join(" "))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_model_dir_is_resolvable() {
        let dir = streaming_model_dir();
        assert!(dir.is_some(), "bundled streaming model not found");
        let dir = dir.unwrap();
        assert!(dir.join("encoder.fp16.onnx").is_file());
    }

    /// Frame quantization contract, mirroring the Python tests
    /// `test_streaming_feed_queues_whole_frame_batch` / `_keeps_partial_frame_as_tail`.
    #[test]
    fn frame_quantizer_holds_back_partial_frame() {
        let s = LocalStreamingStt {
            language: "vi".into(),
            frame_bytes: FRAME_BYTES,
            tail: Mutex::new(Vec::new()),
            stopped: std::sync::atomic::AtomicBool::new(false),
            tx: {
                let (tx, _rx) = std::sync::mpsc::channel();
                tx
            },
        };
        // Half a frame (10ms = 160 samples = 320 bytes) is held back.
        s.feed_audio(&vec![0u8; 320]);
        assert_eq!(s.tail.lock().unwrap().len(), 320);
        // Completing the frame flushes 640 bytes.
        s.feed_audio(&vec![0u8; 320]);
        assert!(s.tail.lock().unwrap().is_empty());
    }

    #[test]
    fn feed_after_stop_is_ignored() {
        let (tx, rx) = std::sync::mpsc::channel();
        let s = LocalStreamingStt {
            language: "vi".into(),
            frame_bytes: FRAME_BYTES,
            tail: Mutex::new(Vec::new()),
            stopped: std::sync::atomic::AtomicBool::new(false),
            tx,
        };
        s.stop();
        s.feed_audio(&vec![0u8; 1600]);
        // Only the stop sentinel is queued.
        assert!(matches!(rx.recv().unwrap(), None));
        assert!(rx.try_recv().is_err());
    }
}
