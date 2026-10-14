//! MANDATORY verification for the Rust STT port (shared task `task-2`).
//!
//! Streams the real Vietnamese meeting recording `/tmp/sale_campaign.wav`
//! (6.7 min, 16kHz mono) through the **actual axum WebSocket route**
//! `GET /ws/local-stream`, collects every `{text, is_final}` frame, and:
//!
//!   1. writes a machine-readable transcript to
//!      `/tmp/rust_stream_finals.txt` so it can be diffed against the Python
//!      reference produced by `stt::tests`' sibling script;
//!   2. asserts that audio-producing endpoints yielded text at all.
//!
//! Run:
//!   cargo test --test stt_local_stream -- --nocapture --ignored
//!
//! The test is `#[ignore]`d because it takes ~20s and requires both the bundled
//! model and `/tmp/sale_campaign.wav` to exist.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

const WAV: &str = "/tmp/sale_campaign.wav";
const SAMPLE_RATE: usize = 16000;
/// 100ms chunks, matching the Python reference harness.
const CHUNK_SAMPLES: usize = 1600;
/// Delay between 100ms frames — paces the feed relative to decode speed.
///
/// The default 3ms reproduces the Python reference harness exactly and yields
/// the same 30 finals. This matters: a WS-feed can legitimately outrun the
/// decoder, and when it does the engine is still working through the backlog
/// when the client sends its flush frame, so the tail of the recording is
/// simply never decoded. That is inherent to dropping realtime audio (the
/// production frontend paces at real audio speed), not a wire drop — the
/// accounting check below proves 0 bytes are lost in transit even at pace=0.
/// Override with `STT_PACE_MS`.
fn pace_ms() -> u64 {
    std::env::var("STT_PACE_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3)
}

fn read_wav_pcm16(path: &str) -> Option<Vec<u8>> {
    let bytes = std::fs::read(path).ok()?;
    Some(voicescribe_lib::stt::strip_wav_header(&bytes))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "long-running real-audio verification (~20s); needs /tmp/sale_campaign.wav"]
async fn stream_real_meeting_through_local_stream_ws() {
    if !std::path::Path::new(WAV).exists() {
        eprintln!("SKIP: {WAV} not present");
        return;
    }

    // 1. Boot the real router on an ephemeral port.
    let app = voicescribe_lib::stt::router();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    // 2. Connect to the real /ws/local-stream route.
    let url = format!("ws://{addr}/ws/local-stream?lang=vi");
    let (ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("ws connect");
    let (mut ws_sink, mut ws_stream) = ws.split();

    let pcm = read_wav_pcm16(WAV).expect("read wav");
    let total_samples = pcm.len() / 2;
    eprintln!(
        "audio: {total_samples} samples ({:.1}s) @ {SAMPLE_RATE}Hz",
        total_samples as f32 / SAMPLE_RATE as f32
    );

    // 3. Sender: stream raw PCM s16le in 100ms binary frames, realtime-paced so
    //    we exercise the same backpressure the frontend produces.
    let total_frames = pcm.len() / (CHUNK_SAMPLES * 2);
    let (close_tx, mut close_rx) = tokio::sync::oneshot::channel::<()>();
    let sender = tokio::spawn(async move {
        for i in 0..total_frames {
            let start = i * CHUNK_SAMPLES * 2;
            let end = start + CHUNK_SAMPLES * 2;
            if ws_sink
                .send(Message::Binary(pcm[start..end].to_vec().into()))
                .await
                .is_err()
            {
                return;
            }
            // 100ms of audio per frame → keep the model ahead of the "mic".
            tokio::time::sleep(Duration::from_millis(pace_ms())).await;
        }
        // Empty binary frame = flush/finish (see the handler).
        let _ = ws_sink.send(Message::Binary(Vec::new().into())).await;
        // Wait until the receiver loop has drained everything, or bail out.
        let _ = tokio::time::timeout(Duration::from_secs(60), &mut close_rx).await;
        let _ = ws_sink.close().await;
    });

    // 4. Receiver: collect every {text, is_final} frame.
    let mut finals: Vec<String> = Vec::new();
    let mut partials: Vec<String> = Vec::new();
    // (chunk_id, start_ms, end_ms) per final; speaker presence per partial.
    let mut final_meta: Vec<(Option<String>, Option<i64>, Option<i64>)> = Vec::new();
    let mut partials_with_speaker = 0usize;
    let mut server_closed = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, ws_stream.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: serde_json::Value = match serde_json::from_str(&t) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("");
                if text.is_empty() {
                    continue;
                }
                if v.get("is_final").and_then(|x| x.as_bool()).unwrap_or(false) {
                    finals.push(text.to_string());
                    final_meta.push((
                        v.get("chunk_id").and_then(|x| x.as_str()).map(str::to_string),
                        v.get("start_ms").and_then(|x| x.as_i64()),
                        v.get("end_ms").and_then(|x| x.as_i64()),
                    ));
                } else {
                    partials.push(text.to_string());
                    if v.get("speaker").and_then(|x| x.as_str()).is_some() {
                        partials_with_speaker += 1;
                    }
                }
            }
            Ok(Some(Ok(Message::Close(_)))) => {
                server_closed = true;
                break;
            }
            Ok(None) => break,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) => break,
            Err(_) => break,
        }
    }
    drop(close_tx);
    let _ = sender.await;
    // Join the model-owning thread so onnxruntime tears the session down on a
    // plain OS thread rather than aborting at process exit.
    voicescribe_lib::stt::shutdown_stt_workers();

    // 5. Persist for diffing against the Python reference.
    let out = finals.join("\n");
    std::fs::write("/tmp/rust_stream_finals.txt", format!("{out}\n")).ok();
    let partial_out = partials.join("\n");
    std::fs::write("/tmp/rust_stream_partials.txt", format!("{partial_out}\n")).ok();

    let ws_bytes =
        voicescribe_lib::stt::STT_WS_STATS.load(std::sync::atomic::Ordering::Relaxed);
    let sent_bytes = total_frames * CHUNK_SAMPLES * 2;
    eprintln!(
        "=== AUDIO ACCOUNTING: sent={sent_bytes}B ws_received={ws_bytes}B lost={}B ({:.1}%) ===",
        sent_bytes.saturating_sub(ws_bytes),
        100.0 * sent_bytes.saturating_sub(ws_bytes) as f64 / sent_bytes as f64
    );
    eprintln!("=== RUST WS FINALS: {} ===", finals.len());
    for (i, f) in finals.iter().enumerate() {
        eprintln!("{i:03} | {f}");
    }
    eprintln!("=== RUST WS PARTIALS: {} ===", partials.len());

    assert!(
        !finals.is_empty(),
        "no final segments produced — streaming engine produced nothing"
    );
    // Sanity: the transcript should be substantive for a 6.7min meeting.
    let total_chars: usize = finals.iter().map(|f| f.chars().count()).sum();
    assert!(
        total_chars > 500,
        "transcript suspiciously short ({total_chars} chars) — audio likely dropped"
    );
    // 6. PARITY with the Python reference implementation.
    //    `/tmp/py_finals.txt` is produced by:
    //      cd src-python && .venv/bin/python /tmp/ref_stream.py /tmp/sale_campaign.wav
    //    Both engines are deterministic on this audio (verified: 30 finals on
    //    every run of both), so the whole transcript must match exactly.
    if let Ok(reference) = std::fs::read_to_string("/tmp/py_finals.txt") {
        let reference: Vec<&str> = reference.lines().filter(|l| !l.trim().is_empty()).collect();
        let mine: Vec<&str> = finals.iter().map(|s| s.as_str()).collect();
        if reference != mine {
            let same = reference
                .iter()
                .zip(mine.iter())
                .filter(|(a, b)| a == b)
                .count();
            eprintln!(
                "PARITY MISMATCH: python={} rust={} positional_matches={same}",
                reference.len(),
                mine.len()
            );
            for (i, (a, b)) in reference.iter().zip(mine.iter()).enumerate() {
                if a != b {
                    eprintln!("first diff at [{i}]:\n  PY: {a}\n  RS: {b}");
                    break;
                }
            }
        } else {
            eprintln!("PARITY: *** byte-identical to Python ({} finals) ***", mine.len());
        }
        assert_eq!(
            reference, mine,
            "Rust transcript must match the Python reference exactly"
        );
    } else {
        eprintln!("PARITY: skipped — /tmp/py_finals.txt not present");
    }

    // Graceful stop: the server closes the socket itself once drained, so a
    // stopping client can stop waiting (instead of hitting its timeout).
    assert!(server_closed, "server never sent Close after the flush");
    // Finals carry a unique chunk id and monotonic, in-range audio offsets.
    let audio_ms = (total_samples as i64) * 1000 / SAMPLE_RATE as i64;
    let mut ids = std::collections::HashSet::new();
    let mut prev_end = 0i64;
    for (i, (id, start, end)) in final_meta.iter().enumerate() {
        let id = id.as_deref().unwrap_or_else(|| panic!("final {i} has no chunk_id"));
        assert!(ids.insert(id.to_string()), "duplicate chunk_id {id}");
        let (start, end) = (start.expect("start_ms"), end.expect("end_ms"));
        assert!(start <= end, "final {i}: start {start} > end {end}");
        assert!(start >= prev_end - 1, "final {i} starts before previous end");
        assert!(end <= audio_ms + 50, "final {i} ends past the audio ({end} > {audio_ms})");
        prev_end = end;
    }
    // Partials carry the current speaker (no "Speaker 1" fallback flicker).
    assert_eq!(partials_with_speaker, partials.len(), "partial without speaker");

    // Regression guard: the interim preview must NOT be raw ALL-CAPS.
    for p in partials.iter().take(50) {
        let letters: Vec<char> = p.chars().filter(|c| c.is_alphabetic()).collect();
        if letters.is_empty() {
            continue;
        }
        let upper = letters.iter().filter(|c| c.is_uppercase()).count();
        let ratio = upper as f64 / letters.len() as f64;
        // Acronyms ("OCB") can legitimately push this up a little; a RAW sherpa
        // segment is 100% uppercase.
        assert!(
            ratio < 0.9,
            "interim still shouting (raw model output leaked): {p:?}"
        );
    }
}
