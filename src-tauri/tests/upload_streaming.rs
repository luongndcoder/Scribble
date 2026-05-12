//! Integration tests for the upload streaming logic.
//!
//! Spins up a tiny TCP server that speaks just enough HTTP/1.1 to receive the
//! multipart upload, then verifies:
//!   - the streamed bytes equal the file content
//!   - progress callback fires monotonically up to the file size
//!   - cancellation aborts the stream mid-send and the server sees the connection close
//!
//! The server returns a canned {"job_id": "...", "meeting_id": 42} so the
//! client-side parsing path is exercised end-to-end.
//!
//! No Tauri runtime or real sidecar required — this isolates the Rust streaming
//! mechanics from the Python pipeline.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use voicescribe_lib::upload::{stream_upload_to_url, SidecarUploadResponse};

/// Spawn a mock HTTP/1.1 server. Returns (url, join_handle) where the handle
/// resolves to the bytes received after the request header.
async fn spawn_mock_server(
    response_status: u16,
    response_body: &'static str,
) -> (String, tokio::task::JoinHandle<MockResult>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("http://{addr}/meetings/upload-audio");

    let handle = tokio::spawn(async move {
        let (mut sock, _peer) = listener.accept().await.unwrap();

        // Read until we see the end of headers (\r\n\r\n)
        let mut buf: Vec<u8> = Vec::new();
        let mut tmp = [0u8; 8192];
        let headers_end;
        loop {
            let n = match sock.read(&mut tmp).await {
                Ok(0) | Err(_) => return MockResult::client_closed(buf),
                Ok(n) => n,
            };
            buf.extend_from_slice(&tmp[..n]);
            if let Some(idx) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                headers_end = idx + 4;
                break;
            }
            if buf.len() > 64 * 1024 {
                return MockResult::client_closed(buf);
            }
        }

        // Parse Content-Length so we know how much body to read
        let headers = String::from_utf8_lossy(&buf[..headers_end]);
        let content_length: usize = headers
            .lines()
            .find_map(|line| {
                let lower = line.to_ascii_lowercase();
                lower
                    .strip_prefix("content-length:")
                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
            })
            .unwrap_or(0);

        let mut body = buf[headers_end..].to_vec();
        while body.len() < content_length {
            let n = match sock.read(&mut tmp).await {
                Ok(0) | Err(_) => break, // client closed mid-stream (cancel)
                Ok(n) => n,
            };
            body.extend_from_slice(&tmp[..n]);
        }

        let bytes_received_after_headers = body.len();
        let fully_received = body.len() >= content_length && content_length > 0;

        let response = format!(
            "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
            status = response_status,
            len = response_body.len(),
            body = response_body,
        );
        let _ = sock.write_all(response.as_bytes()).await;
        let _ = sock.shutdown().await;

        MockResult {
            content_length,
            bytes_received_after_headers,
            fully_received,
            request_headers: headers.into_owned(),
            request_body: body,
        }
    });

    (url, handle)
}

#[derive(Debug)]
struct MockResult {
    content_length: usize,
    bytes_received_after_headers: usize,
    fully_received: bool,
    request_headers: String,
    request_body: Vec<u8>,
}

impl MockResult {
    fn client_closed(buf: Vec<u8>) -> Self {
        Self {
            content_length: 0,
            bytes_received_after_headers: 0,
            fully_received: false,
            request_headers: String::from_utf8_lossy(&buf).into_owned(),
            request_body: buf,
        }
    }
}

fn write_temp_file(name: &str, payload: &[u8]) -> PathBuf {
    let dir = tempdir_unique();
    let path = dir.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(&path, payload).unwrap();
    path
}

fn tempdir_unique() -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "scribble-upload-test-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    p
}

#[tokio::test]
async fn streams_full_file_and_parses_response() {
    let payload: Vec<u8> = (0..256u32).flat_map(|n| (n as u32).to_le_bytes()).collect();
    let payload_len = payload.len();
    let file_path = write_temp_file("audio.mp3", &payload);

    let (url, server_handle) =
        spawn_mock_server(200, "{\"job_id\":\"job-abc\",\"meeting_id\":42}").await;

    let progress_log: Arc<Mutex<Vec<(u64, u64)>>> = Arc::new(Mutex::new(Vec::new()));
    let progress_log_cb = progress_log.clone();

    let cancel = Arc::new(AtomicBool::new(false));
    let result: Result<SidecarUploadResponse, String> = stream_upload_to_url(
        &url,
        &file_path,
        Some("Phase 1.5 smoke"),
        "vi",
        cancel,
        move |sent, total| {
            progress_log_cb.lock().unwrap().push((sent, total));
        },
    )
    .await;

    let server_result = server_handle.await.unwrap();
    let _ = std::fs::remove_file(&file_path);

    let parsed = result.expect("stream_upload_to_url should succeed");
    assert_eq!(parsed.job_id, "job-abc");
    assert_eq!(parsed.meeting_id, 42);

    // Server received the whole request body
    assert!(
        server_result.fully_received,
        "server should have received full body; content_length={} got={}",
        server_result.content_length, server_result.bytes_received_after_headers
    );
    assert!(
        server_result
            .request_headers
            .to_ascii_lowercase()
            .contains("content-type: multipart/form-data"),
        "missing multipart Content-Type header: {}",
        server_result.request_headers
    );

    // Multipart body must contain the file bytes verbatim
    assert!(
        contains_window(&server_result.request_body, &payload),
        "raw file bytes should appear in multipart body"
    );

    // Progress callback fired monotonically and reached file size
    let log = progress_log.lock().unwrap();
    assert!(!log.is_empty(), "progress callback should fire at least once");
    let mut last = 0u64;
    for (sent, total) in log.iter() {
        assert!(*sent >= last, "progress should be monotonic non-decreasing");
        assert_eq!(*total as usize, payload_len, "total should match file size");
        last = *sent;
    }
    assert_eq!(
        last as usize, payload_len,
        "final progress should equal file size"
    );
}

#[tokio::test]
async fn cancel_aborts_before_stream() {
    // Verifies the cancel flag is honored: pre-set the flag, the first chunk read
    // returns an Interrupted error, reqwest aborts the request before sending
    // the full body, and stream_upload_to_url returns Err.
    // (Mid-stream cancel relies on the same code path — it just requires file
    // big enough / network slow enough to race the cancel signal, which is
    // unreliable to assert deterministically over loopback.)
    let payload: Vec<u8> = vec![0xCDu8; 8 * 1024 * 1024];
    let file_path = write_temp_file("cancel.wav", &payload);

    let (url, server_handle) =
        spawn_mock_server(200, "{\"job_id\":\"unused\",\"meeting_id\":0}").await;

    let cancel = Arc::new(AtomicBool::new(true)); // pre-cancelled

    let progress_log: Arc<Mutex<Vec<(u64, u64)>>> = Arc::new(Mutex::new(Vec::new()));
    let progress_log_cb = progress_log.clone();

    let result = stream_upload_to_url(
        &url,
        &file_path,
        None,
        "vi",
        cancel,
        move |sent, total| {
            progress_log_cb.lock().unwrap().push((sent, total));
        },
    )
    .await;

    // Race: the mock server may have accepted the conn already or be still
    // listening. Either way we abort the join after a short window to avoid hangs.
    let server_outcome = tokio::time::timeout(Duration::from_secs(2), server_handle).await;
    let _ = std::fs::remove_file(&file_path);

    let err = result.expect_err("pre-cancelled upload should error");
    assert!(
        err.to_lowercase().contains("cancel") || err.to_lowercase().contains("upload"),
        "error should mention cancel/upload: {err}"
    );

    // No progress should have been emitted (cancel hit on first chunk read).
    assert!(
        progress_log.lock().unwrap().is_empty(),
        "no progress callbacks expected when pre-cancelled"
    );

    // If server task finished, body must not be fully received.
    if let Ok(Ok(mock)) = server_outcome {
        assert!(
            !mock.fully_received,
            "server should NOT have a full body when cancelled"
        );
    }
}

#[tokio::test]
async fn missing_file_returns_error() {
    let cancel = Arc::new(AtomicBool::new(false));
    let result = stream_upload_to_url(
        "http://127.0.0.1:1/does-not-matter",
        std::path::Path::new("/tmp/this-file-does-not-exist-scribble-upload-test"),
        None,
        "vi",
        cancel,
        |_, _| {},
    )
    .await;
    let err = result.expect_err("should error on missing file");
    assert!(
        err.contains("does not exist"),
        "error should mention missing file: {err}"
    );
}

#[tokio::test]
async fn empty_file_returns_error() {
    let file_path = write_temp_file("empty.wav", b"");
    let cancel = Arc::new(AtomicBool::new(false));
    let result = stream_upload_to_url(
        "http://127.0.0.1:1/does-not-matter",
        &file_path,
        None,
        "vi",
        cancel,
        |_, _| {},
    )
    .await;
    let _ = std::fs::remove_file(&file_path);
    let err = result.expect_err("should error on empty file");
    assert!(err.contains("empty"), "error should mention empty: {err}");
}

fn contains_window(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}
