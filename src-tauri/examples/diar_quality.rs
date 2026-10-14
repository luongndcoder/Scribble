//! Does the diarizer actually identify the SAME person consistently?
//!
//! Counting clusters is a proxy; this measures the thing that matters:
//! hold out part of a speaker's audio, build a profile from the rest, and
//! check whether the held-out windows come back to the right speaker.
use std::path::Path;
use voicescribe_lib::diarize::{self, embedding, SpeakerProfile,
    DEFAULT_DISTANCE_THRESHOLD, FINE_SILENCE_RMS, FINE_WINDOW_MS};

fn mean_profile(model: &Path, wins: &[Vec<f32>]) -> Option<Vec<f32>> {
    let mut acc: Option<Vec<f32>> = None;
    let mut n = 0usize;
    for w in wins {
        if let Some(e) = embedding::embed_samples(model, w, 2) {
            let a = acc.get_or_insert_with(|| vec![0f32; e.len()]);
            for (i, x) in e.iter().enumerate() { a[i] += x; }
            n += 1;
        }
    }
    let mut a = acc?;
    if n == 0 { return None; }
    for x in a.iter_mut() { *x /= n as f32; }
    let norm: f32 = a.iter().map(|x| x*x).sum::<f32>().sqrt();
    if norm > 1e-8 { for x in a.iter_mut() { *x /= norm; } }
    Some(a)
}

fn main() {
    let model = diarize::default_model_path().expect("model");
    let wav = Path::new("/tmp/sale_campaign.wav");
    let d = diarize::diarize_fine_windows(wav, &model, FINE_WINDOW_MS,
             DEFAULT_DISTANCE_THRESHOLD, FINE_SILENCE_RMS).unwrap();

    let mut counts = std::collections::HashMap::new();
    for s in &d.timeline { *counts.entry(s.speaker_id).or_insert(0usize) += 1; }
    let mut order: Vec<_> = counts.iter().map(|(k, v)| (*k, *v)).collect();
    order.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    println!("=== clustering at cut {} ===", DEFAULT_DISTANCE_THRESHOLD);
    for (id, n) in &order { println!("  spk{id}: {n} windows ({:.0}s)", *n as f32 * 2.0); }

    let (samples, _) = diarize::load_wav_samples(wav).unwrap();
    let win = 32000usize;
    let mut by_cluster: std::collections::HashMap<usize, Vec<Vec<f32>>> = Default::default();
    for (i, s) in d.timeline.iter().enumerate() {
        let start = i * win;
        if start + win <= samples.len() {
            by_cluster.entry(s.speaker_id).or_default().push(samples[start..start+win].to_vec());
        }
    }

    println!("\n=== held-out identification accuracy per speaker ===");
    println!("(profile from first half of that speaker's windows; test on second half)");
    let mut profiles: Vec<SpeakerProfile> = Vec::new();
    let mut held: Vec<(String, Vec<Vec<f32>>)> = Vec::new();
    for (id, _) in order.iter().take(4) {
        let list = &by_cluster[id];
        if list.len() < 4 { continue; }
        let half = list.len() / 2;
        let name = format!("spk{id}");
        if let Some(emb) = mean_profile(&model, &list[..half]) {
            profiles.push(SpeakerProfile { name: name.clone(), embedding: emb });
            held.push((name, list[half..].to_vec()));
        }
    }

    let mut grand_correct = 0usize; let mut grand_total = 0usize;
    for (name, wins) in &held {
        let mut c = 0; let mut t = 0;
        for w in wins {
            if let Some(id) = diarize::identify_speaker_from_samples(&model, w, 16000, &profiles) {
                t += 1;
                if id.name.as_deref() == Some(name.as_str()) { c += 1; }
            }
        }
        grand_correct += c; grand_total += t;
        println!("  {name:8} {c:3}/{t:3} correct ({:5.1}%)", c as f32 / t.max(1) as f32 * 100.0);
    }
    println!("\n  OVERALL {grand_correct}/{grand_total} = {:.1}%",
        grand_correct as f32 / grand_total.max(1) as f32 * 100.0);

    println!("\n=== churn ===");
    let mut sw = 0;
    for w in d.timeline.windows(2) { if w[0].speaker_id != w[1].speaker_id { sw += 1; } }
    println!("  {} segments, {sw} speaker changes, avg {:.1}s per segment",
        d.timeline.len(), 402.0 / (sw + 1) as f32);
}
