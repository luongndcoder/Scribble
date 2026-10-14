//! System-audio archive end to end, through the real routes:
//!
//!   1. `/ws/local-stream?source=system&meeting_id=N` → PCM lands in
//!      `audio/meeting_N.pcm`, which becomes the meeting's `audio_path`;
//!   2. `PATCH /drafts/N/audio` (mic webm, "both" mode) → kept beside it as
//!      `meeting_N_mic.webm` instead of being dropped;
//!   3. first `GET /meetings/N/audio/stream` → ffmpeg mixes both into
//!      `meeting_N_mix.m4a` and the parts are removed.
//!
//! Needs ffmpeg: the bundled sidecar (`scripts/fetch-build-deps.sh`) or one on
//! PATH; skipped otherwise.

use std::path::PathBuf;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

fn ffmpeg() -> Option<PathBuf> {
    let triple = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(windows) {
        "x86_64-pc-windows-msvc.exe"
    } else {
        "x86_64-unknown-linux-gnu"
    };
    let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("binaries/scribble-ffmpeg-{triple}"));
    if bundled.is_file() {
        return Some(bundled);
    }
    std::env::var_os("PATH")
        .and_then(|p| std::env::split_paths(&p).map(|d| d.join("ffmpeg")).find(|f| f.is_file()))
}

/// 2 s of a 440 Hz tone, PCM16 16 kHz mono.
fn tone_pcm(secs: f32) -> Vec<u8> {
    let n = (16000.0 * secs) as usize;
    (0..n)
        .flat_map(|i| {
            let s = (i as f32 * 440.0 * std::f32::consts::TAU / 16000.0).sin() * 8000.0;
            (s as i16).to_le_bytes()
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn system_pcm_and_mic_companion_are_mixed_on_playback() {
    let Some(ff) = ffmpeg() else {
        eprintln!("SKIP: no ffmpeg");
        return;
    };
    std::env::set_var("FFMPEG_BIN", &ff);

    let dir = std::env::temp_dir().join(format!("scribble-archive-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let app = voicescribe_lib::api::build_router_at(dir.join("voicescribe.db"))
        .unwrap()
        .merge(voicescribe_lib::stt::router());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let http = reqwest::Client::new();
    let base = format!("http://{addr}");

    // Draft meeting.
    let id = http
        .post(format!("{base}/drafts"))
        .json(&serde_json::json!({"title": "archive test"}))
        .send()
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap()["id"]
        .as_i64()
        .unwrap();

    // 1. System audio over the live WS.
    let pcm = tone_pcm(2.0);
    let url = format!("ws://{addr}/ws/local-stream?lang=vi&source=system&meeting_id={id}");
    let (ws, _) = tokio_tungstenite::connect_async(&url).await.expect("ws connect");
    let (mut tx, mut rx) = ws.split();
    for chunk in pcm.chunks(3200) {
        tx.send(Message::Binary(chunk.to_vec().into())).await.unwrap();
    }
    tx.send(Message::Text(r#"{"type":"stop"}"#.into())).await.unwrap();
    while let Some(Ok(msg)) = rx.next().await {
        if matches!(msg, Message::Close(_)) {
            break;
        }
    }
    // The handler drops the archive after the engine drains; give it a beat.
    for _ in 0..50 {
        if !voicescribe_lib::audio_archive::is_active(id) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let audio = dir.join("audio");
    let pcm_file = audio.join(format!("meeting_{id}.pcm"));
    assert_eq!(std::fs::metadata(&pcm_file).unwrap().len(), pcm.len() as u64);

    // 2. Mic webm chunk → companion, not dropped.
    let webm = dir.join("mic.webm");
    let ok = std::process::Command::new(&ff)
        .args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=2"])
        .arg(&webm)
        .status()
        .unwrap()
        .success();
    assert!(ok, "ffmpeg could not make the mic webm");
    let part = reqwest::multipart::Part::bytes(std::fs::read(&webm).unwrap()).file_name("meeting.webm");
    let res: serde_json::Value = http
        .patch(format!("{base}/drafts/{id}/audio"))
        .multipart(reqwest::multipart::Form::new().part("audio", part))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(res.get("skipped").is_none(), "{res}");
    assert!(audio.join(format!("meeting_{id}_mic.webm")).is_file());

    // 3. Playback mixes both into one file.
    let resp = http.get(format!("{base}/meetings/{id}/audio/stream")).send().await.unwrap();
    assert!(resp.status().is_success(), "{}", resp.status());
    let body = resp.bytes().await.unwrap();
    assert!(body.len() > 1000);
    assert!(audio.join(format!("meeting_{id}_mix.m4a")).is_file());
    assert!(!pcm_file.exists() && !audio.join(format!("meeting_{id}_mic.webm")).exists());
    let meeting: serde_json::Value =
        http.get(format!("{base}/meetings/{id}")).send().await.unwrap().json().await.unwrap();
    let path = meeting["audio_path"].as_str().unwrap_or_default().to_string();
    assert!(path.ends_with("_mix.m4a"), "{meeting}");

    let _ = std::fs::remove_dir_all(&dir);
}
