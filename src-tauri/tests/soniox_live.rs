//! Live Soniox realtime verification (needs a real API key).
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

fn read_key() -> Option<String> {
    let db = dirs::home_dir()?.join(".voicescribe").join("voicescribe.db");
    let conn = rusqlite::Connection::open(db).ok()?;
    conn.query_row(
        "select value from settings where key='soniox_api_key'",
        [],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .filter(|s| !s.is_empty())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn soniox_live_stream() {
    let key = match read_key() {
        Some(k) => k,
        None => {
            eprintln!("SKIP: no soniox_api_key in settings");
            return;
        }
    };
    let app = voicescribe_lib::stt::router();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { let _ = axum::serve(listener, app).await; });

    let url = format!("ws://{addr}/ws/soniox-stream?api_key={key}&lang=vi");
    let (ws, _) = tokio_tungstenite::connect_async(&url).await.expect("connect");
    let (mut sink, mut stream) = ws.split();

    let bytes = std::fs::read("/tmp/sale_campaign.wav").unwrap();
    let pcm = voicescribe_lib::stt::strip_wav_header(&bytes);
    let chunk = 3200 * 2; // 200ms
    let (fin_tx, mut fin_rx) = tokio::sync::oneshot::channel::<()>();
    let sender = tokio::spawn(async move {
        for c in pcm.chunks(chunk).take(300) { // ~60s
            if sink.send(Message::Binary(c.to_vec().into())).await.is_err() { break; }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        let _ = sink.send(Message::Binary(Vec::new().into())).await;
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        let _ = sink.close().await;
        let _ = fin_tx.send(());
    });

    let mut segs: Vec<String> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        if rem.is_zero() { break; }
        match tokio::time::timeout(rem, stream.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => { segs.push(t.to_string()); }
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) => break,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => { eprintln!("ws err: {e}"); break; }
            Err(_) => break,
        }
    }
    let _ = sender.await;
    let _ = fin_rx.try_recv();
    eprintln!("=== SONIOX SEGMENTS: {} ===", segs.len());
    for s in segs.iter().take(8) { eprintln!("  {}", &s[..s.len().min(240)]); }
    std::fs::write("/tmp/rust_soniox_segments.jsonl", segs.join("\n")).ok();
    assert!(!segs.is_empty(), "no segments from Soniox");
}
