//! Smoke/speed probe for a local streaming model dir — Zipformer / Nemotron
//! ONNX (sherpa) or Nemotron MLX (build with `--features mlx`).
//!
//! Streams a WAV in 100 ms chunks through the same engine the app uses
//! (`get_stream_engine`), prints every final, the real-time factor, and the
//! first tokens with timestamps (the speaker tracker needs per-token times).
//!
//! Run:
//!   cargo run --release [--features mlx] --example nemotron_probe -- <model_dir> <16k-mono.wav> [lang] [max_secs]
use voicescribe_lib::stt::local::get_stream_engine;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = std::path::PathBuf::from(&args[1]);
    let wav = &args[2];
    let lang = args.get(3).cloned().unwrap_or_else(|| "vi".into());
    let max_secs: f64 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(f64::MAX);

    let t_load = std::time::Instant::now();
    // NEMOTRON_THREAD=1: load on one thread, decode on another (the app does).
    let eng = if std::env::var("NEMOTRON_THREAD").is_ok() {
        let d = dir.clone();
        std::thread::spawn(move || get_stream_engine(&d)).join().unwrap().expect("engine")
    } else {
        get_stream_engine(&dir).expect("engine")
    };
    eng.reset_stream();
    eng.set_language(&lang);
    println!("load={:.1}s", t_load.elapsed().as_secs_f64());

    let pcm = voicescribe_lib::stt::strip_wav_header(&std::fs::read(wav).expect("wav"));
    let mut x = voicescribe_lib::stt::live_diarize::pcm16_to_f32(&pcm);
    x.truncate(((max_secs * 16_000.0) as usize).min(x.len()));
    // A little trailing silence so the last endpoint fires.
    x.extend(std::iter::repeat(0.0).take(16_000 * 2));

    let t0 = std::time::Instant::now();
    let mut printed_tokens = false;
    for chunk in x.chunks(1600) {
        eng.accept(chunk);
        if !printed_tokens {
            let (toks, ts) = eng.tokens();
            if toks.len() >= 8 {
                println!("tokens: {:?}", &toks[..8]);
                println!("times : {:?}", &ts[..ts.len().min(8)]);
                printed_tokens = true;
            }
        }
        if eng.is_endpoint() {
            let t = eng.finalize(&lang);
            if !t.is_empty() {
                println!("FINAL: {t}");
            }
        }
    }
    eng.flush();
    let t = eng.finalize(&lang);
    if !t.is_empty() {
        println!("FINAL: {t}");
    }
    let audio = x.len() as f64 / 16_000.0;
    let took = t0.elapsed().as_secs_f64();
    println!("audio={audio:.1}s decode={took:.1}s RTF={:.3} ({:.1}x realtime)", took / audio, audio / took);
}
