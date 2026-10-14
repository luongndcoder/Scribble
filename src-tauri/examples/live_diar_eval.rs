//! End-to-end live diarization score for `/ws/local-stream`.
//!
//! Streams a labelled real recording through the REAL axum route at realtime
//! pace and scores what a user would see:
//!
//! * **attribution accuracy** — share of final-segment time (overlapping real
//!   speech) labelled with the right speaker, after mapping hypothesis ids to
//!   reference speakers one-to-one by maximum overlap;
//! * **mixed finals** — finals whose time span covers two reference speakers
//!   (the minority side > 30%), i.e. text of two people glued together;
//! * **switch latency** — for every speaker change, delay from the real change
//!   until the first event (partial or final) shows the new speaker. Measured
//!   on the stream clock, so it is what the UI experiences.
//!
//! Labels: plain text, one turn per line — `start end speaker`, times as
//! `mm:ss[.f]` or seconds. Blank lines and `#` comments are ignored.
//!   00:00 00:12 Hung
//!   00:12 00:15.5 Lan
//!
//! Run (audio must be 16 kHz mono s16le WAV):
//!   ffmpeg -i meeting.m4a -ac 1 -ar 16000 -sample_fmt s16 /tmp/meeting.wav
//!   cargo run --release --example live_diar_eval -- /tmp/meeting.wav labels.txt
//! Env: `DIAR_SPEED` (default 1.0 = realtime), `DIAR_VERBOSE` (dump finals).
use std::collections::HashMap;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

const FRAME: usize = 1_600; // 100 ms

#[derive(Debug, Clone)]
struct Turn {
    speaker: String,
    start: i64,
    end: i64,
}

#[derive(Debug, Clone)]
struct Event {
    arrival_ms: i64,
    is_final: bool,
    speaker_id: Option<i64>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    text: String,
}

/// `mm:ss[.f]`, `hh:mm:ss[.f]` or plain seconds → milliseconds.
fn parse_time_ms(s: &str) -> Option<i64> {
    let mut secs = 0f64;
    for part in s.split(':') {
        secs = secs * 60.0 + part.trim().parse::<f64>().ok()?;
    }
    Some((secs * 1000.0).round() as i64)
}

fn parse_labels(text: &str) -> Vec<Turn> {
    let mut turns: Vec<Turn> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let start = parse_time_ms(it.next()?)?;
            let end = parse_time_ms(it.next()?)?;
            let speaker = it.collect::<Vec<_>>().join(" ");
            (end > start && !speaker.is_empty()).then_some(Turn { speaker, start, end })
        })
        .collect();
    turns.sort_by_key(|t| t.start);
    turns
}

fn overlap(a0: i64, a1: i64, b0: i64, b1: i64) -> i64 {
    (a1.min(b1) - a0.max(b0)).max(0)
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (Some(wav), Some(labels)) = (args.get(1).cloned(), args.get(2).cloned()) else {
        eprintln!("usage: live_diar_eval <audio-16k-mono.wav> <labels.txt>");
        std::process::exit(2);
    };
    let speed: f64 = std::env::var("DIAR_SPEED").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0);

    let turns = parse_labels(&std::fs::read_to_string(&labels).expect("read labels"));
    let n_ref = turns.iter().map(|t| t.speaker.as_str()).collect::<std::collections::BTreeSet<_>>().len();
    assert!(!turns.is_empty(), "no turns parsed from {labels}");
    let pcm = voicescribe_lib::stt::strip_wav_header(&std::fs::read(&wav).expect("wav"));

    // Fresh speaker session, exactly like the frontend does at record start.
    voicescribe_lib::stt::live_diarize::reset_session();

    let app = voicescribe_lib::stt::router();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    // LOCAL_MODEL_DIR selects another engine (e.g. the Nemotron package).
    let lang = std::env::var("LOCAL_LANG").unwrap_or_else(|_| "vi".into());
    let model_q = std::env::var("LOCAL_MODEL_DIR")
        .map(|d| format!("&model_dir={d}"))
        .unwrap_or_default();
    let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws/local-stream?lang={lang}{model_q}"))
        .await
        .expect("connect");
    let (mut sink, mut stream) = ws.split();

    let t0 = Instant::now();
    let frames = pcm.len() / (FRAME * 2);
    let sender = tokio::spawn(async move {
        for i in 0..frames {
            let due = Duration::from_secs_f64(i as f64 * 0.1 / speed);
            if let Some(wait) = due.checked_sub(t0.elapsed()) {
                tokio::time::sleep(wait).await;
            }
            let s = i * FRAME * 2;
            if sink.send(Message::Binary(pcm[s..s + FRAME * 2].to_vec().into())).await.is_err() {
                return;
            }
        }
        let _ = sink.send(Message::Text(r#"{"type":"stop"}"#.into())).await;
        tokio::time::sleep(Duration::from_secs(30)).await;
    });

    let mut events: Vec<Event> = Vec::new();
    while let Ok(Some(Ok(msg))) = tokio::time::timeout(Duration::from_secs(60), stream.next()).await {
        let Message::Text(t) = msg else {
            if matches!(msg, Message::Close(_)) { break; }
            continue;
        };
        let v: serde_json::Value = match serde_json::from_str(&t) { Ok(v) => v, Err(_) => continue };
        let text = v["text"].as_str().unwrap_or("").to_string();
        if text.is_empty() { continue; }
        events.push(Event {
            arrival_ms: (t0.elapsed().as_secs_f64() * 1000.0 * speed) as i64,
            is_final: v["is_final"].as_bool().unwrap_or(false),
            speaker_id: v["speaker_id"].as_i64(),
            start_ms: v["start_ms"].as_i64(),
            end_ms: v["end_ms"].as_i64(),
            text,
        });
    }
    sender.abort();
    voicescribe_lib::stt::shutdown_stt_workers();

    let finals: Vec<&Event> = events.iter().filter(|e| e.is_final).collect();

    // ── Map hypothesis ids → reference speakers (greedy one-to-one by overlap).
    let mut ov: HashMap<(i64, String), i64> = HashMap::new();
    for f in &finals {
        let (Some(s), Some(e), Some(id)) = (f.start_ms, f.end_ms, f.speaker_id) else { continue };
        for t in &turns {
            *ov.entry((id, t.speaker.clone())).or_default() += overlap(s, e, t.start, t.end);
        }
    }
    let mut pairs: Vec<((i64, String), i64)> = ov.clone().into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1));
    let mut map: HashMap<i64, String> = HashMap::new();
    let mut used: Vec<String> = Vec::new();
    for ((id, spk), v) in pairs {
        if v == 0 || map.contains_key(&id) || used.contains(&spk) { continue; }
        map.insert(id, spk.clone());
        used.push(spk);
    }

    // ── Attribution accuracy + mixed finals.
    let (mut total, mut correct, mut mixed) = (0i64, 0i64, 0usize);
    for f in &finals {
        let (Some(s), Some(e), Some(id)) = (f.start_ms, f.end_ms, f.speaker_id) else { continue };
        let mut by_spk: HashMap<&str, i64> = HashMap::new();
        for t in &turns {
            let o = overlap(s, e, t.start, t.end);
            if o > 0 { *by_spk.entry(t.speaker.as_str()).or_default() += o; }
        }
        let sum: i64 = by_spk.values().sum();
        total += sum;
        if let Some(ref_spk) = map.get(&id) {
            correct += by_spk.get(ref_spk.as_str()).copied().unwrap_or(0);
        }
        let mut v: Vec<i64> = by_spk.values().copied().collect();
        v.sort_unstable_by(|a, b| b.cmp(a));
        if v.len() >= 2 && sum > 0 && v[1] as f64 / sum as f64 > 0.3 { mixed += 1; }
    }

    // ── Switch latency (only into turns long enough to be visible: ≥ 1.5 s).
    let mut lat: Vec<i64> = Vec::new();
    let mut missed = 0usize;
    for w in turns.windows(2) {
        let (prev, cur) = (&w[0], &w[1]);
        if prev.speaker == cur.speaker || cur.end - cur.start < 1500 { continue; }
        let hit = events.iter().find(|e| {
            e.arrival_ms >= cur.start
                && e.arrival_ms <= cur.end + 2500
                && e.speaker_id.and_then(|id| map.get(&id)).map(|s| s == &cur.speaker).unwrap_or(false)
        });
        match hit {
            Some(e) => lat.push(e.arrival_ms - cur.start),
            None => missed += 1,
        }
    }
    lat.sort_unstable();
    let med = lat.get(lat.len() / 2).copied().unwrap_or(-1);
    let p90 = lat.get(lat.len() * 9 / 10).copied().unwrap_or(-1);

    let hyp_ids: std::collections::BTreeSet<i64> = finals.iter().filter_map(|f| f.speaker_id).collect();
    println!("file: {wav}");
    println!("finals={} partials={} hyp_speakers={:?} ref_speakers={n_ref} map={:?}",
        finals.len(), events.len() - finals.len(), hyp_ids, map);
    println!("ATTRIBUTION accuracy = {:.1}%  ({} / {} ms)",
        100.0 * correct as f64 / total.max(1) as f64, correct, total);
    println!("MIXED finals = {} / {}", mixed, finals.len());
    println!("SWITCH latency median = {med} ms, p90 = {p90} ms, detected {}/{} (missed {missed})",
        lat.len(), lat.len() + missed);
    if std::env::var("DIAR_VERBOSE").is_ok() {
        for f in &finals {
            println!("  [{:>6}-{:>6}] S{:?} {}", f.start_ms.unwrap_or(-1), f.end_ms.unwrap_or(-1),
                f.speaker_id, f.text);
        }
    }
}
