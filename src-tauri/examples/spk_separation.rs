//! Measure how separable speakers actually are with a given embedding model.
//!
//! # Why this harness was rewritten (2026-10-09)
//!
//! The first version labelled windows with the cluster id produced by
//! [`diarize::diarize_fine_windows`] — i.e. by the very model being measured —
//! and then compared "within cluster" against "across cluster" similarity.
//! That is circular: a model that merges everything reports almost no
//! within-pairs, so ~100% of across-pairs land above the within-p05 and the
//! model looks broken for a reason that has nothing to do with its quality.
//! The number moved with the clustering threshold, not with the model.
//!
//! # What it does now
//!
//! Ground truth is **temporal proximity**, which needs no model and no labels:
//!
//! * `NEAR` pairs — windows `NEAR_GAP` apart. A speaker does not alternate every
//!   2 seconds, so these are almost always the same voice.
//! * `FAR` pairs — windows at least `FAR_GAP` apart, which are much more likely
//!   to be a different voice or at least a different acoustic state.
//!
//! A model with real speaker discrimination must score NEAR clearly above FAR.
//! This is model-independent, so two models can be compared directly, and it is
//! the property the user actually cares about ("can it tell these two people
//! apart?"). It is *not* a substitute for hand-labelled speaker turns — that
//! limitation is printed with the results.
//!
//! Usage:
//! ```text
//! cargo run --release --example spk_separation -- [model.onnx] [more.onnx ...]
//! ```
//! With no arguments it measures the bundled model.

use std::path::{Path, PathBuf};
use voicescribe_lib::diarize::{self, embedding, FINE_WINDOW_MS, FINE_SILENCE_RMS};

/// Windows this many positions apart are treated as the same speaker.
const NEAR_GAP: usize = 2;
/// Windows at least this many seconds apart are treated as likely-different.
const FAR_SECS: usize = 30;

fn cos(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn pct(v: &mut [f32], p: f32) -> f32 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() {
        return f32::NAN;
    }
    v[(((v.len() - 1) as f32) * p / 100.0).round() as usize]
}

/// Embed every 2s speech window with `model`, returning embeddings in order.
fn embed_windows(model: &Path, samples: &[f32], win: usize) -> (Vec<Vec<f32>>, f64) {
    let mut embs = Vec::new();
    let mut elapsed_ms = 0.0f64;
    let mut start = 0usize;
    while start + win <= samples.len() {
        let seg = &samples[start..start + win];
        if diarize::rms(seg) >= FINE_SILENCE_RMS {
            let t0 = std::time::Instant::now();
            if let Some(e) = embedding::embed_samples(model, seg, diarize::NUM_THREADS) {
                elapsed_ms += t0.elapsed().as_secs_f64() * 1000.0;
                embs.push(e);
            }
        }
        start += win;
    }
    let per = if embs.is_empty() {
        f64::NAN
    } else {
        elapsed_ms / embs.len() as f64
    };
    (embs, per)
}

fn report(name: &str, embs: &[Vec<f32>], ms_per: f64) {
    let n = embs.len();
    let mut near = Vec::new();
    let mut far = Vec::new();
    for i in 0..n {
        for j in (i + 1)..n {
            let c = cos(&embs[i], &embs[j]);
            let gap = j - i;
            if gap <= NEAR_GAP {
                near.push(c);
            } else if gap * (FINE_WINDOW_MS as usize / 1000) >= FAR_SECS {
                far.push(c);
            }
        }
    }
    if near.is_empty() || far.is_empty() {
        println!("{name}: not enough windows ({n}) for a near/far split");
        return;
    }

    let near_p05 = pct(&mut near.clone(), 5.0);
    let overlap = far.iter().filter(|&&c| c > near_p05).count() as f32 / far.len() as f32 * 100.0;
    let (nm, fm) = (
        near.iter().sum::<f32>() / near.len() as f32,
        far.iter().sum::<f32>() / far.len() as f32,
    );
    let (nv, fv) = (
        near.iter().map(|c| (c - nm).powi(2)).sum::<f32>() / near.len() as f32,
        far.iter().map(|c| (c - fm).powi(2)).sum::<f32>() / far.len() as f32,
    );
    let dprime = (nm - fm) / ((nv + fv) / 2.0).sqrt();

    let near_p50 = pct(&mut near.clone(), 50.0);
    let far_p50 = pct(&mut far.clone(), 50.0);
    let far_max = far.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    println!("\n=== {} (n={} windows) ===", name, n);
    println!(
        "  NEAR (same speaker, {} apart) p05={:.3} p50={:.3} mean={:.3}",
        NEAR_GAP, near_p05, near_p50, nm
    );
    println!(
        "  FAR  (likely different, >={}s) p50={:.3} max={:.3} mean={:.3}",
        FAR_SECS, far_p50, far_max, fm
    );
    println!(
        "  OVERLAP (FAR above NEAR-p05): {:.1}%   <- lower is better",
        overlap
    );
    println!(
        "  d-prime (near vs far):        {:+.3}       <- higher is better",
        dprime
    );
    println!("  speed:                        {:.1} ms/embedding", ms_per);
}

fn main() {
    let wav = PathBuf::from("/tmp/sale_campaign.wav");
    let (samples, sr) = diarize::load_wav_samples(&wav).expect("load wav");
    assert_eq!(sr, 16000, "expected 16 kHz audio");
    let win = (FINE_WINDOW_MS as usize * sr as usize) / 1000;

    let models: Vec<PathBuf> = {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.is_empty() {
            vec![diarize::default_model_path().expect("bundled model")]
        } else {
            args.into_iter().map(PathBuf::from).collect()
        }
    };

    println!("audio: {} ({:.0}s)", wav.display(), samples.len() as f64 / sr as f64);
    println!(
        "protocol: NEAR = windows <=2 apart; FAR = windows >=30s apart.\n\
         Ground truth is temporal proximity, NOT cluster labels — see the module docs.\n\
         This proxies speaker turns; it cannot replace hand-labelled speaker turns."
    );

    for m in &models {
        if !m.exists() {
            println!("\n=== {} — MISSING, skipped", m.display());
            continue;
        }
        let (embs, ms_per) = embed_windows(m, &samples, win);
        let label = m.file_name().and_then(|s| s.to_str()).unwrap_or("model");
        report(label, &embs, ms_per);
    }
}
