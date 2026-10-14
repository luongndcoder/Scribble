//! Fast calibration of the live speaker tracker against reference labels.
//!
//! Embedding is the only expensive step and it does not depend on the decision
//! thresholds, so window embeddings are computed ONCE (cached to
//! `<wav>.emb-cache`) and the tracker's decision logic is then replayed for a
//! grid of parameter sets in seconds.
//!
//! Scores per parameter set (reference = labels file, e.g. from
//! `soniox_labels.rs`):
//!   * acc   — share of reference speech time labelled with the right speaker
//!             (hypothesis ids mapped one-to-one by overlap);
//!   * spk   — number of speakers the tracker created;
//!   * lat   — median delay between a real speaker change (into a turn ≥ 2 s)
//!             and the moment the tracker committed it (stream clock);
//!   * miss  — such changes never committed.
//!
//! Run:
//!   cargo run --release --example tracker_eval -- <16k-mono.wav> <labels.txt> [--grid]
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

use voicescribe_lib::diarize::{self, embedding};
use voicescribe_lib::stt::speaker_tracker::{SharedProfiles, TrackerCore, TrackerParams};

const SR: i64 = 16_000;

struct Turn {
    speaker: String,
    start: i64, // samples
    end: i64,
}

fn parse_time(s: &str) -> Option<f64> {
    let mut secs = 0f64;
    for p in s.split(':') {
        secs = secs * 60.0 + p.trim().parse::<f64>().ok()?;
    }
    Some(secs)
}

fn parse_labels(text: &str) -> Vec<Turn> {
    let mut v: Vec<Turn> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let s = parse_time(it.next()?)?;
            let e = parse_time(it.next()?)?;
            let spk = it.collect::<Vec<_>>().join(" ");
            (e > s).then(|| Turn { speaker: spk, start: (s * SR as f64) as i64, end: (e * SR as f64) as i64 })
        })
        .collect();
    v.sort_by_key(|t| t.start);
    v
}

fn window_key(w: &[f32]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    w.len().hash(&mut h);
    for x in w.iter().step_by(97) {
        x.to_bits().hash(&mut h);
    }
    h.finish()
}

fn load_cache(path: &str) -> HashMap<u64, Vec<f32>> {
    let mut m = HashMap::new();
    let Ok(bytes) = std::fs::read(path) else { return m };
    let mut i = 0;
    while i + 12 <= bytes.len() {
        let key = u64::from_le_bytes(bytes[i..i + 8].try_into().unwrap());
        let n = u32::from_le_bytes(bytes[i + 8..i + 12].try_into().unwrap()) as usize;
        i += 12;
        let v: Vec<f32> = bytes[i..i + n * 4].chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
        i += n * 4;
        m.insert(key, v);
    }
    m
}

fn save_cache(path: &str, m: &HashMap<u64, Vec<f32>>) {
    let mut out = Vec::new();
    for (k, v) in m {
        out.extend_from_slice(&k.to_le_bytes());
        out.extend_from_slice(&(v.len() as u32).to_le_bytes());
        for x in v {
            out.extend_from_slice(&x.to_le_bytes());
        }
    }
    let _ = std::fs::write(path, out);
}

struct Score {
    acc: f64,
    speakers: usize,
    turns: usize,
    lat_med_ms: i64,
    detected: usize,
    missed: usize,
    /// Identity-free boundary scores (±1.5 s): share of reference changes the
    /// tracker also marked, and share of tracker changes the reference has.
    b_recall: f64,
    b_precision: f64,
}

impl Score {
    fn b_f1(&self) -> f64 {
        let (p, r) = (self.b_precision, self.b_recall);
        if p + r == 0.0 { 0.0 } else { 2.0 * p * r / (p + r) }
    }
}

fn run(samples: &[f32], turns: &[Turn], params: TrackerParams, cache: &Arc<Mutex<HashMap<u64, Vec<f32>>>>, model: &std::path::Path) -> Score {
    let profiles: SharedProfiles = Arc::new(Mutex::new(Vec::new()));
    let c2 = Arc::clone(cache);
    let model = model.to_path_buf();
    let embed = move |w: &[f32]| -> Option<Vec<f32>> {
        let k = window_key(w);
        if let Some(v) = c2.lock().unwrap().get(&k) {
            return Some(v.clone());
        }
        let v = embedding::embed_samples(&model, w, diarize::NUM_THREADS)?;
        c2.lock().unwrap().insert(k, v.clone());
        Some(v)
    };
    let mut core = TrackerCore::new(params, embed, Arc::clone(&profiles));
    let tl = core.timeline();

    // Feed in 100 ms chunks; record when each committed turn first appeared.
    let mut first_seen: HashMap<(u64, i64), i64> = HashMap::new();
    let mut pos = 0i64;
    for chunk in samples.chunks(1600) {
        core.push(chunk);
        pos += chunk.len() as i64;
        let t = tl.lock().unwrap();
        for turn in t.turns() {
            first_seen.entry(*turn).or_insert(pos);
        }
    }
    core.flush();
    let timeline = tl.lock().unwrap().clone();

    // Frame-level (10 ms) overlap matrix, reference speech only.
    let step = (SR / 100) as usize;
    let mut ov: HashMap<(i64, String), i64> = HashMap::new();
    let mut frames: Vec<(i64, &str)> = Vec::new();
    for t in turns {
        let mut s = t.start;
        while s < t.end {
            let h = timeline.speaker_at(s as u64);
            *ov.entry((h, t.speaker.clone())).or_default() += 1;
            frames.push((h, t.speaker.as_str()));
            s += step as i64;
        }
    }
    let mut pairs: Vec<_> = ov.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1));
    let mut map: HashMap<i64, String> = HashMap::new();
    let mut used: Vec<String> = Vec::new();
    for ((h, r), _) in pairs {
        if map.contains_key(&h) || used.contains(&r) {
            continue;
        }
        map.insert(h, r.clone());
        used.push(r);
    }
    let correct = frames.iter().filter(|(h, r)| map.get(h).map(|m| m == r).unwrap_or(false)).count();

    // Switch latency into turns ≥ 2 s.
    let mut lat = Vec::new();
    let mut missed = 0;
    for w in turns.windows(2) {
        if w[0].speaker == w[1].speaker || w[1].end - w[1].start < 2 * SR {
            continue;
        }
        let target = &w[1].speaker;
        let hit = timeline
            .turns()
            .iter()
            .filter(|(s, id)| {
                map.get(id).map(|m| m == target).unwrap_or(false)
                    && (*s as i64) > w[1].start - SR
                    && (*s as i64) < w[1].end
            })
            .filter_map(|k| first_seen.get(k))
            .min()
            .copied();
        match hit {
            Some(at) => lat.push((at - w[1].start) * 1000 / SR),
            None => missed += 1,
        }
    }
    lat.sort_unstable();
    let speakers = profiles.lock().unwrap().len();
    if std::env::var("TRACKER_TALK_TIME").is_ok() {
        // Talk time per tracker speaker (over the whole file, 100 ms grid).
        let mut talk: std::collections::BTreeMap<i64, i64> = Default::default();
        let mut t = 0u64;
        while (t as usize) < samples.len() {
            let w = &samples[t as usize..(t as usize + 1600).min(samples.len())];
            if diarize::rms(w) > 0.01 {
                *talk.entry(timeline.speaker_at(t)).or_default() += 1;
            }
            t += 1600;
        }
        let turns_n = timeline.turns().len();
        println!("  tracker: {speakers} speakers, {turns_n} turns; voiced talk time:");
        for (id, n) in talk {
            println!("    Speaker {}: {:.0}s", id + 1, n as f64 / 10.0);
        }
    }
    // Identity-free boundary match (±1.5 s).
    let tol = (1.5 * SR as f64) as i64;
    let ref_b: Vec<i64> = turns.windows(2).filter(|w| w[0].speaker != w[1].speaker).map(|w| w[1].start).collect();
    let hyp_b: Vec<i64> = timeline.turns().iter().skip(1).map(|(s, _)| *s as i64).collect();
    let near = |x: i64, set: &[i64]| set.iter().any(|y| (x - y).abs() <= tol);
    let b_recall = ref_b.iter().filter(|&&b| near(b, &hyp_b)).count() as f64 / ref_b.len().max(1) as f64;
    let b_precision = hyp_b.iter().filter(|&&b| near(b, &ref_b)).count() as f64 / hyp_b.len().max(1) as f64;
    Score {
        acc: correct as f64 / frames.len().max(1) as f64,
        speakers,
        turns: timeline.turns().len(),
        lat_med_ms: lat.get(lat.len() / 2).copied().unwrap_or(-1),
        detected: lat.len(),
        missed,
        b_recall,
        b_precision,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(wav), Some(labels)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: tracker_eval <16k-mono.wav> <labels.txt> [--grid]");
        std::process::exit(2);
    };
    let grid = args.iter().any(|a| a == "--grid");
    let turns = parse_labels(&std::fs::read_to_string(labels).expect("labels"));
    let pcm = voicescribe_lib::stt::strip_wav_header(&std::fs::read(wav).expect("wav"));
    let samples = voicescribe_lib::stt::live_diarize::pcm16_to_f32(&pcm);
    let model = diarize::default_model_path().expect("speaker model");
    // One cache per model: embeddings of different models are not comparable.
    let model_tag = model.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let cache_path = format!("{wav}.{model_tag}.emb-cache");
    println!("model: {}", model.display());
    let cache = Arc::new(Mutex::new(load_cache(&cache_path)));
    let ref_spk: std::collections::BTreeSet<&str> = turns.iter().map(|t| t.speaker.as_str()).collect();
    println!("ref: {} turns, {} speakers {:?}", turns.len(), ref_spk.len(), ref_spk);

    // "default" honours LIVE_DIAR_* env overrides, so a candidate setting can
    // be inspected without editing the grid.
    let mut sets: Vec<(String, TrackerParams)> = vec![("default".into(), TrackerParams::from_env())];
    if grid {
        for &m in &[0.40f32, 0.45, 0.50] {
            for &nm in &[0.15f32, 0.20] {
                for &ch in &[0.0f32, 0.30, 0.35, 0.40, 0.45, 0.50] {
                    for &c in &[2usize, 3] {
                        for &cn in &[3usize, 4] {
                            let mut p = TrackerParams::from_env();
                            p.match_sim = m;
                            p.new_max_sim = nm.min(m - 0.02);
                            p.change_sim = ch;
                            p.confirm = c;
                            p.confirm_new = cn;
                            sets.push((format!("match={m} new<{nm} change<{ch} confirm={c} confirm_new={cn}"), p));
                        }
                    }
                }
            }
        }
    }
    let t0 = std::time::Instant::now();
    let mut results: Vec<(String, Score)> = Vec::new();
    for (name, p) in sets {
        let s = run(&samples, &turns, p, &cache, &model);
        if results.is_empty() {
            save_cache(&cache_path, &cache.lock().unwrap());
            eprintln!("(embeddings cached in {:.0}s)", t0.elapsed().as_secs_f64());
        }
        results.push((name, s));
    }
    // Rank by boundary F1: identity accuracy vs a reference that merges
    // speakers (Soniox found 3 of 8 people on the calibration clip) is not
    // meaningful, but the moments someone else starts talking still are.
    results.sort_by(|a, b| b.1.b_f1().partial_cmp(&a.1.b_f1()).unwrap());
    for (name, s) in results.iter().take(15) {
        println!(
            "bF1={:4.2} (R={:4.2} P={:4.2}) acc={:5.1}% spk={} turns={:>3} lat_med={:>5}ms  {name}",
            s.b_f1(), s.b_recall, s.b_precision, s.acc * 100.0, s.speakers, s.turns, s.lat_med_ms
        );
    }
    if let Some((_, d)) = results.iter().find(|(n, _)| n == "default") {
        println!("DEFAULT: acc={:.1}% spk={} lat_med={}ms detected={}/{}",
            d.acc * 100.0, d.speakers, d.lat_med_ms, d.detected, d.detected + d.missed);
    }
}
