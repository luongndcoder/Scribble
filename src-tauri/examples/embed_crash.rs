//! Isolate: does embedding real audio crash?
use voicescribe_lib::diarize::{self, embedding};
fn main() {
    let model = diarize::default_model_path().expect("model");
    let mut r = hound::WavReader::open("/tmp/sale_campaign.wav").unwrap();
    let all: Vec<f32> = r.samples::<i16>().filter_map(|s| s.ok())
        .map(|s| s as f32 / 32768.0).collect();
    println!("total samples: {}", all.len());

    // Exactly what the WS layer feeds: up to 10s of the most recent audio.
    for secs in [1usize, 2, 3, 5, 10] {
        let n = 16_000 * secs;
        let seg = &all[16_000 * 10..16_000 * 10 + n];
        print!("embed {secs}s ({} samples)... ", seg.len());
        use std::io::Write; std::io::stdout().flush().unwrap();
        match embedding::embed_samples(&model, seg, 2) {
            Some(e) => println!("OK dim={}", e.len()),
            None => println!("returned None"),
        }
    }
    // Odd lengths too
    for n in [16_001usize, 16_007, 33_333, 160_000] {
        let seg = &all[16_000 * 10..16_000 * 10 + n.min(all.len() - 16_000 * 10)];
        print!("embed {} samples... ", seg.len());
        use std::io::Write; std::io::stdout().flush().unwrap();
        match embedding::embed_samples(&model, seg, 2) {
            Some(e) => println!("OK dim={}", e.len()),
            None => println!("None"),
        }
    }
    println!("NO CRASH");
}
