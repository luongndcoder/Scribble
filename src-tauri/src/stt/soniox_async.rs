//! Soniox Async (file) transcription for uploads — port of the Python
//! `stt.py` async path (`upload_soniox_file` → `transcribe_soniox_file_id` →
//! `_parse_soniox_segments`).
//!
//!   A   POST /v1/files                      (multipart upload) → file_id
//!   B.1 POST /v1/transcriptions             {model, file_id, diarization}
//!   B.2 GET  /v1/transcriptions/{id}        (poll; tolerates network blips)
//!   B.3 GET  /v1/transcriptions/{id}/transcript → tokens with speakers
//!   cleanup: DELETE transcription + file (best effort)
//!
//! Speakers come from Soniox's own diarization, so the local diarizer is not
//! used on this path.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const API: &str = "https://api.soniox.com/v1";
const MODEL: &str = "stt-async-v5";
/// Consecutive poll network errors tolerated before giving up.
const MAX_POLL_NET_ERRORS: u32 = 8;
/// Segment splitting, same as Python: a 2 s pause or 60 s of one speaker
/// starts a new segment even when Soniox keeps the same speaker.
const SEGMENT_GAP_SPLIT_MS: i64 = 2_000;
const SEGMENT_MAX_DURATION_MS: i64 = 60_000;

/// One speaker-homogeneous transcript segment.
#[derive(Debug, Clone)]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    /// Soniox speaker label ("1", "2", …).
    pub speaker: String,
}

/// Transcribe `path` with Soniox Async. `progress(fraction, message)` is called
/// as the job advances (0.0–1.0); `cancelled()` aborts between steps.
pub async fn transcribe_file(
    api_key: &str,
    path: &Path,
    language_hints: &[String],
    progress: impl Fn(f64, &str),
    cancelled: impl Fn() -> bool,
) -> Result<Vec<Segment>, String> {
    if api_key.trim().is_empty() {
        return Err("Soniox API key chưa được cấu hình".into());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let auth = format!("Bearer {}", api_key.trim());

    // ── A: upload ──
    progress(0.0, "Đang tải audio lên Soniox");
    let file_id = upload_with_retry(&client, &auth, path, &cancelled).await?;

    let result = transcribe_file_id(&client, &auth, &file_id, language_hints, &progress, &cancelled).await;

    // Best-effort cleanup — never masks the real outcome.
    let _ = client.delete(format!("{API}/files/{file_id}")).header("Authorization", &auth).send().await;
    result
}

/// Upload attempts for transient failures (network, 5xx, 429), backing off
/// 2 s → 4 s → 8 s like Python's chunk retry.
const UPLOAD_ATTEMPTS: u32 = 4;

/// `POST /v1/files`, streaming the file from disk (a 3 h WAV is ~345 MB; it is
/// never held in RAM) and retrying transient failures.
async fn upload_with_retry(
    client: &reqwest::Client,
    auth: &str,
    path: &Path,
    cancelled: &impl Fn() -> bool,
) -> Result<String, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "audio.wav".into());
    let mut attempt = 0;
    loop {
        attempt += 1;
        let file = tokio::fs::File::open(path).await.map_err(|e| format!("open {path:?}: {e}"))?;
        let len = file.metadata().await.map_err(|e| e.to_string())?.len();
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));
        let part = reqwest::multipart::Part::stream_with_length(body, len).file_name(name.clone());
        let form = reqwest::multipart::Form::new().part("file", part);
        let res = client
            .post(format!("{API}/files"))
            .header("Authorization", auth)
            .multipart(form)
            .send()
            .await
            .and_then(|r| r.error_for_status());
        let err = match res {
            Ok(r) => {
                let v: Value = r.json().await.map_err(|e| format!("Soniox upload response: {e}"))?;
                return v["id"].as_str().map(str::to_string).ok_or_else(|| "Soniox upload: no file id".into());
            }
            Err(e) => e,
        };
        let permanent = err.status().is_some_and(|s| s.is_client_error() && s.as_u16() != 429);
        if permanent || attempt >= UPLOAD_ATTEMPTS || cancelled() {
            return Err(format!("Soniox upload failed: {err}"));
        }
        log::warn!("[soniox-async] FAILED: upload attempt {attempt}/{UPLOAD_ATTEMPTS}: {err}");
        tokio::time::sleep(Duration::from_secs(2u64 << (attempt - 1))).await;
    }
}

/// Soniox Async accepts up to ~5 h per file; longer audio is split into parts
/// of this length (Python: 3.5 h threshold) and the results concatenated.
pub const MAX_PART_SECS: f64 = 3.5 * 3600.0;
/// Hard cap, same as Python: refuse absurdly long uploads up front.
pub const MAX_TOTAL_SECS: f64 = 24.0 * 3600.0;

/// Like [`transcribe_file`] but splits audio longer than [`MAX_PART_SECS`]
/// into parts (16 kHz mono WAV, cut with ffmpeg into `work_dir`) and offsets
/// each part's timestamps. Speaker labels are per part — Soniox cannot match
/// voices across separate files — so a later part's labels get a `pN-` prefix
/// to keep them from merging with earlier speakers by accident.
pub async fn transcribe_file_split(
    api_key: &str,
    wav: &Path,
    duration_secs: f64,
    work_dir: &Path,
    language_hints: &[String],
    progress: impl Fn(f64, &str),
    cancelled: impl Fn() -> bool,
) -> Result<Vec<Segment>, String> {
    if duration_secs > MAX_TOTAL_SECS {
        return Err(format!(
            "File quá dài ({:.1} giờ) — tối đa {} giờ",
            duration_secs / 3600.0,
            MAX_TOTAL_SECS / 3600.0
        ));
    }
    if duration_secs <= MAX_PART_SECS {
        return transcribe_file(api_key, wav, language_hints, progress, cancelled).await;
    }
    let ff = crate::api::audio::find_ffmpeg()?;
    let n = (duration_secs / MAX_PART_SECS).ceil() as usize;
    let part_secs = duration_secs / n as f64;
    tokio::fs::create_dir_all(work_dir).await.map_err(|e| e.to_string())?;
    let mut all = Vec::new();
    for i in 0..n {
        if cancelled() {
            return Err("cancelled".into());
        }
        let start = i as f64 * part_secs;
        let part = work_dir.join(format!("soniox_part_{i}.wav"));
        let out = tokio::process::Command::new(&ff)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", &format!("{start:.3}"), "-t"])
            .arg(format!("{part_secs:.3}"))
            .arg("-i")
            .arg(wav)
            .args(["-c", "copy"])
            .arg(&part)
            .output()
            .await
            .map_err(|e| format!("ffmpeg split: {e}"))?;
        if !out.status.success() {
            return Err(format!("ffmpeg split: {}", String::from_utf8_lossy(&out.stderr).chars().take(200).collect::<String>()));
        }
        let label = format!("Phần {}/{n}", i + 1);
        let segs = transcribe_file(
            api_key,
            &part,
            language_hints,
            |f, m| progress((i as f64 + f) / n as f64, &format!("{label}: {m}")),
            &cancelled,
        )
        .await;
        let _ = tokio::fs::remove_file(&part).await;
        let offset_ms = (start * 1000.0) as i64;
        all.extend(segs?.into_iter().map(|mut s| {
            s.start_ms += offset_ms;
            s.end_ms += offset_ms;
            if i > 0 {
                s.speaker = format!("p{}-{}", i + 1, s.speaker);
            }
            s
        }));
    }
    Ok(all)
}

async fn transcribe_file_id(
    client: &reqwest::Client,
    auth: &str,
    file_id: &str,
    language_hints: &[String],
    progress: &impl Fn(f64, &str),
    cancelled: &impl Fn() -> bool,
) -> Result<Vec<Segment>, String> {
    // ── B.1: create job ──
    let hints: Vec<String> = if language_hints.is_empty() { vec!["vi".into()] } else { language_hints.to_vec() };
    let job: Value = client
        .post(format!("{API}/transcriptions"))
        .header("Authorization", auth)
        .json(&json!({
            "model": MODEL,
            "file_id": file_id,
            "language_hints": hints,
            "enable_speaker_diarization": true,
            "enable_language_identification": false,
        }))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Soniox create job failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Soniox create job response: {e}"))?;
    let tid = job["id"].as_str().ok_or("Soniox create job: no id")?.to_string();
    progress(0.1, "Soniox đang nhận dạng");

    // ── B.2: poll ──
    let started = Instant::now();
    let mut deadline = Duration::from_secs(1800);
    let mut net_errors = 0u32;
    loop {
        if cancelled() {
            let _ = client.delete(format!("{API}/transcriptions/{tid}")).header("Authorization", auth).send().await;
            return Err("cancelled".into());
        }
        if started.elapsed() > deadline {
            return Err(format!("Soniox polling deadline exceeded (>{}s)", deadline.as_secs()));
        }
        let res = client
            .get(format!("{API}/transcriptions/{tid}"))
            .header("Authorization", auth)
            .send()
            .await
            .and_then(|r| r.error_for_status());
        let t: Value = match res {
            Ok(r) => match r.json().await {
                Ok(v) => v,
                Err(e) => return Err(format!("Soniox poll response: {e}")),
            },
            Err(e) if e.status().map(|s| s.is_client_error() && s.as_u16() != 429).unwrap_or(false) => {
                return Err(format!("Soniox poll failed: {e}"));
            }
            Err(e) => {
                // Network blip / 5xx / 429: back off and keep polling.
                net_errors += 1;
                if net_errors > MAX_POLL_NET_ERRORS {
                    return Err(format!("Soniox poll failed after {net_errors} network errors: {e}"));
                }
                tokio::time::sleep(Duration::from_secs((2u64 << net_errors.min(4)).min(30))).await;
                continue;
            }
        };
        net_errors = 0;
        match t["status"].as_str().unwrap_or("") {
            "completed" => break,
            "error" => {
                return Err(t["error_message"].as_str().unwrap_or("Soniox transcription failed").to_string());
            }
            _ => {}
        }
        // Long files: extend the deadline once the audio length is known
        // (same rule as Python: duration/5 + 30 min, at least 30 min).
        if let Some(ms) = t["audio_duration_ms"].as_i64().filter(|&ms| ms > 0) {
            let secs = ms as f64 / 1000.0;
            deadline = Duration::from_secs_f64((secs / 5.0 + 1800.0).max(1800.0));
            let expected = (secs / 30.0).max(1.0); // ~30x realtime throughput
            let frac = (started.elapsed().as_secs_f64() / expected).min(0.95);
            progress(0.1 + frac * 0.85, "Soniox đang nhận dạng");
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }

    // ── B.3: transcript ──
    let tr: Value = client
        .get(format!("{API}/transcriptions/{tid}/transcript"))
        .header("Authorization", auth)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Soniox get transcript failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Soniox transcript response: {e}"))?;
    let _ = client.delete(format!("{API}/transcriptions/{tid}")).header("Authorization", auth).send().await;
    progress(1.0, "Soniox đã nhận dạng xong");
    Ok(parse_segments(&tr))
}

/// Group consecutive same-speaker tokens into segments (Python
/// `_parse_soniox_segments`): split on speaker change, a ≥2 s gap, or ≥60 s.
pub fn parse_segments(transcript: &Value) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    let mut cur: Option<Segment> = None;
    let flush = |seg: Option<Segment>, out: &mut Vec<Segment>| {
        if let Some(mut s) = seg {
            s.text = super::text::filter_hallucinations_min_chars(s.text.trim(), 2);
            if !s.text.is_empty() {
                out.push(s);
            }
        }
    };
    for tok in transcript["tokens"].as_array().into_iter().flatten() {
        let text = tok["text"].as_str().unwrap_or("");
        if text.is_empty() || text == "<end>" {
            continue;
        }
        let (Some(start), Some(end)) = (tok["start_ms"].as_i64(), tok["end_ms"].as_i64()) else {
            continue;
        };
        let speaker = match &tok["speaker"] {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => "1".to_string(),
        };
        let split = match &cur {
            None => true,
            Some(c) => {
                c.speaker != speaker
                    || start - c.end_ms >= SEGMENT_GAP_SPLIT_MS
                    || end - c.start_ms >= SEGMENT_MAX_DURATION_MS
            }
        };
        if split {
            flush(cur.take(), &mut out);
            cur = Some(Segment { start_ms: start, end_ms: end, text: text.to_string(), speaker });
        } else if let Some(c) = cur.as_mut() {
            c.text.push_str(text);
            c.end_ms = end;
        }
    }
    flush(cur, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_split_on_speaker_gap_and_length() {
        let t = json!({"tokens": [
            {"text": "Xin", "start_ms": 0, "end_ms": 200, "speaker": "1"},
            {"text": " chào", "start_ms": 200, "end_ms": 400, "speaker": "1"},
            {"text": "Vâng", "start_ms": 500, "end_ms": 700, "speaker": "2"},
            {"text": " ạ nhé", "start_ms": 3000, "end_ms": 3200, "speaker": "2"},
            {"text": "<end>", "start_ms": 3200, "end_ms": 3200, "speaker": "2"}
        ]});
        let s = parse_segments(&t);
        assert_eq!(s.len(), 3, "{s:?}");
        assert_eq!(s[0].text, "Xin chào");
        assert_eq!((s[1].speaker.as_str(), s[1].text.as_str()), ("2", "Vâng"));
        // 2.3 s pause → new segment even for the same speaker.
        assert_eq!(s[2].start_ms, 3000);
    }
}
