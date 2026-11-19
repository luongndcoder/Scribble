//! Offline CLI for the native Qwen3-ASR (MLX) engine: transcribes WAV files
//! with the production decode path (≤30 s chunking, greedy, repetition penalty)
//! and writes one `<stem>.txt` per file. Used for parity / WER / RTF runs.
//!
//! Run:
//!   cargo run --release --features mlx --example qwen3_asr_cli -- \
//!       [--model DIR] [--out DIR] [--dump DIR] [--lang vi] <16k-mono.wav>...
//!
//! `--dump DIR` additionally writes, for the FIRST wav, `.npy` tensors for the
//! Python parity gates: `mel`, `enc` (encoder output), `prompt_ids`, `logits0`
//! (first-step logits, float32), `tokens` (generated ids).
#[cfg(all(target_os = "macos", feature = "mlx"))]
fn main() {
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use voicescribe_lib::stt::qwen3_mlx::{DecodeOptions, Qwen3Model};

    fn read_wav(path: &Path) -> Vec<f32> {
        let mut r = hound::WavReader::open(path).expect("open wav");
        let spec = r.spec();
        assert_eq!(spec.sample_rate, 16_000, "{path:?}: expected 16 kHz");
        let ch = spec.channels as usize;
        let mono: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Int => r.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect(),
            hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap()).collect(),
        };
        if ch == 1 { mono } else { mono.chunks(ch).map(|f| f.iter().sum::<f32>() / ch as f32).collect() }
    }

    fn write_npy(path: &Path, shape: &[usize], data: &[f32]) {
        let dims = shape.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(", ");
        let dims = if shape.len() == 1 { format!("{dims},") } else { dims };
        let mut header = format!("{{'descr': '<f4', 'fortran_order': False, 'shape': ({dims}), }}");
        while (10 + header.len() + 1) % 64 != 0 {
            header.push(' ');
        }
        header.push('\n');
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"\x93NUMPY\x01\x00").unwrap();
        f.write_all(&(header.len() as u16).to_le_bytes()).unwrap();
        f.write_all(header.as_bytes()).unwrap();
        for v in data {
            f.write_all(&v.to_le_bytes()).unwrap();
        }
    }

    let mut args = std::env::args().skip(1);
    let (mut model, mut out, mut dump, mut lang) =
        (PathBuf::from(shellexpand_home("~/tz-asr-bench/models-mac/qwen3-asr-ft-r2")), None, None, "vi".to_string());
    let mut wavs: Vec<PathBuf> = Vec::new();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--model" => model = PathBuf::from(args.next().unwrap()),
            "--out" => out = Some(PathBuf::from(args.next().unwrap())),
            "--dump" => dump = Some(PathBuf::from(args.next().unwrap())),
            "--lang" => lang = args.next().unwrap(),
            _ => wavs.push(PathBuf::from(a)),
        }
    }
    fn shellexpand_home(p: &str) -> String {
        p.replacen('~', &dirs::home_dir().unwrap().to_string_lossy(), 1)
    }

    let t0 = std::time::Instant::now();
    let m = Qwen3Model::load(&model).expect("load model");
    println!("load={:.1}s", t0.elapsed().as_secs_f64());
    let opts = DecodeOptions { language: Some(lang), ..DecodeOptions::default() };

    if let (Some(dir), Some(first)) = (&dump, wavs.first()) {
        std::fs::create_dir_all(dir).unwrap();
        let pcm = read_wav(first);
        let f32s = |a: &mlx_rs::Array| -> (Vec<usize>, Vec<f32>) {
            let shape = a.shape().iter().map(|&d| d as usize).collect();
            // reshape copies a strided (transposed) view into a dense buffer.
            let flat = a.as_dtype(mlx_rs::Dtype::Float32).unwrap().reshape(&[-1]).unwrap();
            flat.eval().unwrap();
            (shape, flat.as_slice::<f32>().to_vec())
        };
        let mel = m.log_mel(&pcm).unwrap();
        let (s, d) = f32s(&mel);
        write_npy(&dir.join("mel.npy"), &s, &d);
        let chunk = &voicescribe_lib::stt::qwen3_mlx::chunking::split_audio_into_chunks(&pcm, 30.0, 1.0)[0].0;
        let pf = m.prefill(chunk, Some("Vietnamese")).unwrap();
        let (s, d) = f32s(&pf.audio);
        write_npy(&dir.join("enc.npy"), &s, &d);
        let (s, d) = f32s(&pf.logits);
        write_npy(&dir.join("logits0.npy"), &s, &d);
        let ids: Vec<f32> = pf.prompt_ids.iter().map(|&i| i as f32).collect();
        write_npy(&dir.join("prompt_ids.npy"), &[ids.len()], &ids);
        let toks = m.generate_chunk(chunk, &opts, (chunk.len() / 16_000 * 8) + 32).unwrap();
        let t: Vec<f32> = toks.iter().map(|&i| i as f32).collect();
        write_npy(&dir.join("tokens.npy"), &[t.len()], &t);
        println!("dumped parity tensors to {}", dir.display());
    }

    let (mut audio_s, mut wall_s) = (0.0, 0.0);
    for w in &wavs {
        let pcm = read_wav(w);
        let secs = pcm.len() as f64 / 16_000.0;
        let t = std::time::Instant::now();
        let text = m.transcribe(&pcm, &opts).expect("transcribe");
        let el = t.elapsed().as_secs_f64();
        audio_s += secs;
        wall_s += el;
        let name = w.file_stem().unwrap().to_string_lossy().to_string();
        println!("{name}: dur={secs:.1}s time={el:.2}s RTF={:.3}", el / secs);
        if let Some(dir) = &out {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(format!("{name}.txt")), format!("{text}\n")).unwrap();
        } else {
            println!("  {text}");
        }
    }
    if audio_s > 0.0 {
        println!("TOTAL audio={audio_s:.1}s wall={wall_s:.1}s RTF={:.3}", wall_s / audio_s);
    }
}

#[cfg(not(all(target_os = "macos", feature = "mlx")))]
fn main() {
    eprintln!("qwen3_asr_cli needs macOS and `--features mlx`");
}
