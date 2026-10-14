//! Upper bound of what the speaker-embedding model can do on a recording.
//!
//! Takes windows lying entirely inside one reference speaker's turn, builds
//! each speaker's centroid from EVEN-numbered turns (oracle enrolment), then
//! classifies windows from ODD-numbered turns by nearest centroid. If this
//! "cheating" setup is weak, no live-tracker threshold can fix it.
//!
//! Run:
//!   cargo run --release --example speaker_oracle -- <16k-mono.wav> <labels.txt> [window_s ...]
//! Model: `DIARIZE_SPEAKER_MODEL=<path.onnx>` (default: bundled).
use std::collections::BTreeMap;

use voicescribe_lib::diarize::{self, cosine_similarity, embedding};

fn parse_time(s: &str) -> Option<f64> {
    let mut secs = 0f64;
    for p in s.split(':') {
        secs = secs * 60.0 + p.trim().parse::<f64>().ok()?;
    }
    Some(secs)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(wav), Some(labels)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: speaker_oracle <wav> <labels.txt> [window_s ...]");
        std::process::exit(2);
    };
    let wins: Vec<f64> = args[3..].iter().filter_map(|s| s.parse().ok()).collect();
    let wins = if wins.is_empty() { vec![1.5, 3.0, 5.0] } else { wins };

    let turns: Vec<(f64, f64, String)> = std::fs::read_to_string(labels)
        .expect("labels")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some((parse_time(it.next()?)?, parse_time(it.next()?)?, it.collect::<Vec<_>>().join(" ")))
        })
        .collect();
    let pcm = voicescribe_lib::stt::strip_wav_header(&std::fs::read(wav).expect("wav"));
    let x = voicescribe_lib::stt::live_diarize::pcm16_to_f32(&pcm);
    let model = diarize::default_model_path().expect("model");
    println!("model: {}", model.display());

    for w in wins {
        let wn = (w * 16_000.0) as usize;
        // (turn index, speaker, embedding)
        let mut items: Vec<(usize, String, Vec<f32>)> = Vec::new();
        for (ti, (s, e, spk)) in turns.iter().enumerate() {
            let (s, e) = ((s * 16_000.0) as usize + 4_000, (e * 16_000.0) as usize - 4_000);
            let mut p = s;
            while p + wn <= e.min(x.len()) {
                let seg = &x[p..p + wn];
                if diarize::rms(seg) > 0.01 {
                    if let Some(v) = embedding::embed_samples(&model, seg, diarize::NUM_THREADS) {
                        items.push((ti, spk.clone(), v));
                    }
                }
                p += wn.max(16_000);
            }
        }
        let mut cent: BTreeMap<String, (Vec<f32>, usize)> = BTreeMap::new();
        for (ti, spk, v) in &items {
            if ti % 2 == 0 {
                let c = cent.entry(spk.clone()).or_insert((vec![0.0; v.len()], 0));
                for (a, b) in c.0.iter_mut().zip(v) {
                    *a += b;
                }
                c.1 += 1;
            }
        }
        let (mut ok, mut n) = (0, 0);
        let (mut same, mut diff) = (Vec::new(), Vec::new());
        let mut confusion: BTreeMap<(String, String), usize> = BTreeMap::new();
        // Centroid-to-centroid similarity: two reference "speakers" whose
        // centroids are very close may be one person split by the reference.
        let names: Vec<&String> = cent.keys().collect();
        for i in 0..names.len() {
            for j in i + 1..names.len() {
                let s = cosine_similarity(&cent[names[i]].0, &cent[names[j]].0);
                println!("  centroid sim {} vs {}: {s:.3}", names[i], names[j]);
            }
        }
        for (ti, spk, v) in &items {
            if ti % 2 == 0 {
                continue;
            }
            let best = cent
                .iter()
                .map(|(k, (c, _))| (k, cosine_similarity(c, v)))
                .inspect(|(k, s)| if *k == spk { same.push(*s) } else { diff.push(*s) })
                .fold((String::new(), f32::MIN), |a, (k, s)| if s > a.1 { (k.clone(), s) } else { a });
            n += 1;
            if &best.0 == spk {
                ok += 1;
            }
            *confusion.entry((spk.clone(), best.0.clone())).or_default() += 1;
        }
        for ((r, h), c) in &confusion {
            println!("  ref {r} -> predicted {h}: {c}");
        }
        let med = |v: &mut Vec<f32>| {
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v.get(v.len() / 2).copied().unwrap_or(f32::NAN)
        };
        println!(
            "window {w:>4.1}s: oracle acc {:5.1}% ({ok}/{n})  sim-to-own-centroid med {:.3}  sim-to-other med {:.3}",
            100.0 * ok as f64 / n.max(1) as f64,
            med(&mut same),
            med(&mut diff)
        );
    }
}
