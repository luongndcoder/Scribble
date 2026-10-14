//! How long from "first audio byte" to "first text on screen"?
use std::path::Path;
use std::time::Instant;
use voicescribe_lib::stt::local::{get_stream_engine, streaming_model_dir};

fn main() {
    let dir = streaming_model_dir().expect("model dir");
    println!("model dir: {}", dir.display());

    // 1) Cold engine load (what happens on the FIRST record of an app run).
    let t = Instant::now();
    let engine = get_stream_engine(&dir).expect("engine");
    println!("COLD engine load: {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);

    // 2) Warm load (cached) — second recording in the same run.
    let t = Instant::now();
    let _ = get_stream_engine(&dir).unwrap();
    println!("WARM engine load: {:.0} ms", t.elapsed().as_secs_f64() * 1000.0);

    // 3) Time from first audio to first non-empty partial, feeding realtime
    //    pace (100ms chunks) over real speech.
    let mut r = hound::WavReader::open("/tmp/sale_campaign.wav").unwrap();
    let all: Vec<f32> = r.samples::<i16>().filter_map(|s| s.ok())
        .map(|s| s as f32 / 32768.0).skip(16000 * 10).take(16000 * 20).collect();

    let engine = get_stream_engine(&dir).expect("engine");
    let chunk = 1600usize; // 100ms
    let start = Instant::now();
    let mut first_text_ms: Option<f64> = None;
    let mut frames = 0usize;
    for c in all.chunks(chunk) {
        engine.accept(c);
        frames += 1;
        let txt = engine.partial_text("vi");
        if first_text_ms.is_none() && !txt.trim().is_empty() {
            first_text_ms = Some(start.elapsed().as_secs_f64() * 1000.0);
            println!("first non-empty partial after: {:.0} ms ({} ms of audio fed)",
                first_text_ms.unwrap(), frames * 100);
            println!("  text: {:?}", txt.chars().take(60).collect::<String>());
            break;
        }
    }
    if first_text_ms.is_none() {
        println!("NO partial produced in {:.0} ms", start.elapsed().as_secs_f64() * 1000.0);
    }
}
