//! End-to-end diarization on the real meeting, using the shipped defaults.
use std::path::Path;
use voicescribe_lib::diarize::{self, DEFAULT_DISTANCE_THRESHOLD,
                               FINE_SILENCE_RMS, FINE_WINDOW_MS};

fn main() {
    let model = diarize::default_model_path().expect("model not found");
    println!("model: {}", model.display());
    let args: Vec<String> = std::env::args().collect();
    let wav_arg = args.get(1).cloned().unwrap_or_else(|| "/tmp/sale_campaign.wav".into());
    let wav = Path::new(&wav_arg);
    let threshold: f64 = std::env::var("DIAR_DIST").ok().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_DISTANCE_THRESHOLD);
    let t0 = std::time::Instant::now();
    let d = diarize::diarize_fine_windows(
        wav, &model, FINE_WINDOW_MS, threshold, FINE_SILENCE_RMS,
    ).expect("diarize failed");
    println!("elapsed: {:.1}s", t0.elapsed().as_secs_f32());
    println!("segments: {}", d.timeline.len());
    let mut counts = std::collections::HashMap::new();
    for s in &d.timeline { *counts.entry(s.speaker_id).or_insert(0usize) += 1; }
    let mut v: Vec<_> = counts.into_iter().collect();
    v.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
    println!("speakers: {}", v.len());
    for (id, n) in &v { println!("  speaker {id}: {n} windows ({:.0}s)", *n as f32 * 2.0); }
    println!("\nfirst 16 boundaries:");
    for s in d.timeline.iter().take(16) {
        println!("  {:>6.1}s - {:>6.1}s  spk{}", s.start_ms as f32/1000.0, s.end_ms as f32/1000.0, s.speaker_id);
    }
}
