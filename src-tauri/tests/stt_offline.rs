//! Offline (whole-file) transcription verification for the Rust port.
//!
//! Exercises `stt::SherpaOfflineEngine` (the upload path) against the bundled
//! int8 model and compares to the Python `SherpaOnnxEngine` output.
//!
//! Run: cargo test --test stt_offline -- --nocapture --ignored

use voicescribe_lib::stt;

const WAV: &str = "/tmp/sale_campaign.wav";
/// First N seconds only — the offline engine takes the whole buffer at once.
const SECONDS: usize = 30;

#[test]
#[ignore = "needs the bundled offline model + /tmp/sale_campaign.wav"]
fn offline_engine_transcribes_real_audio() {
    let dir = match stt::offline_model_dir() {
        Some(d) => d,
        None => {
            eprintln!("SKIP: bundled offline model not found");
            return;
        }
    };
    eprintln!("offline model dir: {}", dir.display());

    let engine = match stt::SherpaOfflineEngine::new(&dir) {
        Some(e) => e,
        None => panic!("OfflineRecognizer::create returned None"),
    };

    let bytes = std::fs::read(WAV).expect("read wav");
    let pcm = stt::strip_wav_header(&bytes);
    let samples = stt::pcm_i16_to_f32(&pcm);
    let clip = &samples[..(SECONDS * 16000).min(samples.len())];

    let t0 = std::time::Instant::now();
    let text = engine.transcribe_pcm(clip, "vi");
    let elapsed = t0.elapsed().as_secs_f32();
    eprintln!(
        "OFFLINE RUST ({SECONDS}s audio in {elapsed:.2}s, {:.1}x realtime):",
        SECONDS as f32 / elapsed
    );
    eprintln!("  {text}");
    std::fs::write("/tmp/rust_offline_30s.txt", format!("{text}\n")).ok();

    assert!(!text.is_empty(), "offline engine produced no text");
}

/// The upload path (`transcribe_wav_file`) now runs on the bundled STREAMING
/// Zipformer — the offline Zipformer is no longer shipped.
#[test]
#[ignore = "real-audio check (~15s); needs /tmp/sale_campaign.wav"]
fn upload_path_transcribes_with_streaming_model() {
    let wav = std::path::Path::new("/tmp/sale_campaign.wav");
    if !wav.exists() {
        eprintln!("SKIP: {} not present", wav.display());
        return;
    }
    let text = voicescribe_lib::stt::transcribe_wav_file(wav, "vi").expect("transcribe");
    eprintln!("chars={} head={:?}", text.chars().count(), text.chars().take(120).collect::<String>());
    assert!(text.chars().count() > 1500, "upload transcript suspiciously short");
}
