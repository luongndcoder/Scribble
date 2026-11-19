//! Engine-level verification for [`VadOfflineZipformerEngine`] — the VAD
//! wrapper that lets an OFFLINE transducer package (bilingual VI–EN NghiASR
//! exp7, no streaming graphs published) power the live streaming surface.
//!
//! Feeds the 33 s VI/EN code-switch sample through the exact cadence the live
//! worker uses (100 ms batches → accept → endpoint? finalize : partial) and
//! asserts the utterance lifecycle works: endpoints fire, finals carry text,
//! partials appear before finals, nothing is lost at end-of-stream.
//!
//! Run: cargo test --test stt_vad_offline -- --nocapture --ignored
//! Needs /tmp/sale_campaign.wav + the NghiASR trial model dir in the repo.

use std::path::PathBuf;

use voicescribe_lib::stt::{self, StreamingAsr, VadOfflineZipformerEngine};

const WAV: &str = "/tmp/sale_campaign.wav";

fn repo_model_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src-python/models/local/nghiasr-vi-en-codeswitch-streaming")
}

#[test]
#[ignore = "needs the NghiASR trial model + /tmp/sale_campaign.wav"]
fn vad_offline_engine_streams_code_switch_sample() {
    if !std::path::Path::new(WAV).exists() {
        eprintln!("SKIP: {WAV} not present");
        return;
    }
    let dir = repo_model_dir();
    assert!(
        dir.join("encoder.int8.onnx").is_file(),
        "NghiASR trial model missing: {}",
        dir.display()
    );

    let engine = VadOfflineZipformerEngine::new(&dir).expect("engine init");
    let bytes = std::fs::read(WAV).expect("read wav");
    let pcm = stt::strip_wav_header(&bytes);
    let samples = stt::pcm_i16_to_f32(&pcm);

    let t0 = std::time::Instant::now();
    let mut finals: Vec<String> = Vec::new();
    let mut partial_batches = 0usize;
    for chunk in samples.chunks(1600) {
        engine.accept(chunk);
        if engine.is_endpoint() {
            let t = engine.finalize("vi");
            if !t.is_empty() {
                finals.push(t);
            }
        } else if !engine.partial_text("vi").is_empty() {
            partial_batches += 1;
        }
    }
    engine.flush();
    let tail = engine.finalize("vi");
    if !tail.is_empty() {
        finals.push(tail);
    }
    let elapsed = t0.elapsed().as_secs_f32();

    let total_chars: usize = finals.iter().map(|f| f.chars().count()).sum();
    eprintln!(
        "VAD-offline: {} finals, {} chars, {} partial batches, {elapsed:.1}s ({:.0}x RT)",
        finals.len(),
        total_chars,
        partial_batches,
        (samples.len() as f32 / 16000.0) / elapsed
    );
    for (i, f) in finals.iter().enumerate() {
        eprintln!("{i:02} | {f}");
    }

    assert!(!finals.is_empty(), "no utterance closed — VAD never fired");
    assert!(total_chars > 200, "transcript suspiciously short ({total_chars} chars)");
    assert!(partial_batches > 0, "no interim partial produced before finals");
    // The sample is one continuous VI passage with EN terms — VAD must not
    // shred it into micro-utterances either.
    assert!(finals.len() <= 10, "too many endpoints ({}) — VAD too twitchy", finals.len());
    let joined = finals.join(" ").to_lowercase();
    for term in ["team", "marketing", "deadline"] {
        assert!(
            joined.contains(term),
            "code-switch term '{term}' missing — wrong model or mangled feed: {joined}"
        );
    }
}

/// Real-meeting E2E via the production upload path (`transcribe_wav_file`),
/// which routes through `build_stream_engine` → the VAD-wrapped offline
/// engine when `VOICESCRIBE_STT_MODEL_DIR` points at an offline transducer
/// dir. Unlike the WS harness this has no wall-clock deadline, so a 39-min
/// recording is fine here.
///
/// Run:
///   VOICESCRIBE_STT_MODEL_DIR=../src-python/models/local/nghiasr-vi-en-codeswitch-streaming \
///   cargo test --test stt_vad_offline vad_offline_upload_path_real_meeting -- --nocapture --ignored
#[test]
#[ignore = "long-running (~1-3 min debug); needs a real recording"]
fn vad_offline_upload_path_real_meeting() {
    let wav = std::env::var("VAD_REAL_WAV").unwrap_or_else(|_| "/tmp/sale_campaign.wav".to_string());
    if !std::path::Path::new(&wav).exists() {
        eprintln!("SKIP: {wav} not present");
        return;
    }
    let t0 = std::time::Instant::now();
    let text = stt::transcribe_wav_file(std::path::Path::new(&wav), "vi")
        .expect("transcribe via upload path");
    let elapsed = t0.elapsed().as_secs_f32();
    let lower = text.to_lowercase();
    let count = |t: &str| lower.split_whitespace().filter(|w| *w == t).count();
    eprintln!(
        "upload-path VAD-offline: {} chars in {elapsed:.0}s | private={} resource={} api={} media={} file={}",
        text.chars().count(),
        count("private"),
        count("resource"),
        count("api"),
        count("media"),
        count("file"),
    );
    eprintln!("head: {}", &text.chars().take(300).collect::<String>());
    std::fs::write("/tmp/real_nghiasr_vad_rust.txt", &text).ok();
    assert!(text.chars().count() > 1500, "upload transcript suspiciously short");
}
