//! End-to-end checks for the fine-tuned Qwen3-ASR engine (`local_engine =
//! "qwen3ft"`) through the SAME surface the app uses: `get_stream_engine` →
//! VAD-wrapped offline decoding (`StreamingAsr`), fed with the live worker's
//! 100 ms cadence and the upload path's end-of-stream flush.
//!
//! Run (needs the checkpoint + test audio from the ASR bench):
//!   cargo test --release --features mlx --test stt_qwen3_mlx -- --nocapture --ignored
#![cfg(all(target_os = "macos", feature = "mlx"))]

use std::collections::HashSet;
use std::path::PathBuf;

use voicescribe_lib::stt;

fn bench(rel: &str) -> PathBuf {
    dirs::home_dir().unwrap().join("tz-asr-bench").join(rel)
}

fn read_wav(path: &PathBuf) -> Vec<f32> {
    let mut r = hound::WavReader::open(path).expect("open wav");
    r.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect()
}

fn words(s: &str) -> HashSet<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

#[test]
#[ignore = "needs ~/tz-asr-bench checkpoint + gtseg wavs (loads a 4 GB model)"]
fn qwen3_vad_engine_streams_utterances_like_the_app() {
    let model = bench("models-mac/qwen3-asr-ft-r2");
    let names = ["gtseg-lieu-t3-seg00", "gtseg-media-seg07"];
    if !model.is_dir() || names.iter().any(|n| !bench(&format!("data/{n}.wav")).exists()) {
        eprintln!("SKIP: bench assets missing");
        return;
    }
    assert!(stt::qwen3_ft::is_qwen3_dir(&model));
    let engine = stt::get_stream_engine(&model).expect("qwen3 engine");
    engine.reset_stream();
    engine.set_language("vi");

    // Two clips separated by 1.5 s of silence → at least two VAD endpoints
    // (a clip with an inner pause may close earlier).
    let silence = vec![0.0f32; 24_000];
    let mut pcm = Vec::new();
    let mut expected = String::new();
    for n in names {
        pcm.extend(read_wav(&bench(&format!("data/{n}.wav"))));
        pcm.extend(&silence);
        expected += &std::fs::read_to_string(bench(&format!("results/ft-r2-mac-cap8rp105/{n}.txt"))).unwrap_or_default();
        expected.push(' ');
    }

    let mut finals: Vec<String> = Vec::new();
    for chunk in pcm.chunks(1600) {
        engine.accept(chunk);
        if engine.is_endpoint() {
            let t = engine.finalize("vi");
            if !t.is_empty() {
                finals.push(t);
            }
        }
    }
    engine.flush();
    let tail = engine.finalize("vi");
    if !tail.is_empty() {
        finals.push(tail);
    }
    eprintln!("finals: {finals:#?}");
    assert!(finals.len() >= 2, "VAD closed only {} utterance(s)", finals.len());

    // Per-token times (speaker labelling) exist for a closed utterance.
    let (tokens, times) = engine.tokens();
    assert_eq!(tokens.len(), times.len());

    if !expected.trim().is_empty() {
        let (got, want) = (words(&finals.join(" ")), words(&expected));
        let overlap = got.intersection(&want).count() as f32 / want.len() as f32;
        eprintln!("word overlap with Python baseline: {overlap:.2}");
        assert!(overlap > 0.8, "transcript diverges from the reference run ({overlap:.2})");
    }
}

/// The model is loaded once and shared: building a second engine for the same
/// dir (the upload path does) must not load another 4 GB.
#[test]
#[ignore = "needs ~/tz-asr-bench checkpoint (loads a 4 GB model)"]
fn qwen3_model_is_shared_between_engines() {
    let model = bench("models-mac/qwen3-asr-ft-r2");
    if !model.is_dir() {
        eprintln!("SKIP: checkpoint missing");
        return;
    }
    let t0 = std::time::Instant::now();
    let a = stt::qwen3_mlx::engine::shared(&model).expect("load");
    let load = t0.elapsed();
    let b = stt::qwen3_mlx::engine::shared(&model).expect("shared");
    assert!(std::sync::Arc::ptr_eq(&a, &b), "second request loaded a second model");
    assert!(t0.elapsed() < load * 2);
}
