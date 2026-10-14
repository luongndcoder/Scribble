//! Audio pipeline for file-upload transcription.
//!
//! Port of `src-python/services/vad_splitter.py`, the ffmpeg helpers in
//! `services/audio.py`, plus the chunked orchestration that
//! `services/upload_pipeline.py` performs for a local (non-Soniox) run:
//!
//!   ffmpeg normalize → silencedetect VAD split → sherpa STT per chunk
//!   → diarize windows → map speakers onto chunks → build transcript parts
//!
//! The Python pipeline is 1874 lines because it supports four STT providers
//! (Soniox websocket, Nvidia Riva, local sherpa, and a resume-from-DB path)
//! with a job registry and SSE progress. The Rust port keeps two: Soniox Async
//! (whole file, Soniox's own diarization — `crate::stt::soniox_async`, see
//! [`soniox_transcript_parts`]) and the VAD-chunked local path here, chosen by
//! the `stt_provider` setting in `api::upload::run_pipeline`.
//!
//! Chunking exists because the sherpa offline recognizer is fed one bounded
//! utterance at a time; a 60-minute meeting is not a single utterance.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::{json, Value};

/// Chunk sizing — same tunables as the Python VAD splitter.
pub const CHUNK_TARGET_MS: u64 = 22_000;
pub const CHUNK_MAX_MS: u64 = 28_000;
pub const CHUNK_MIN_MS: u64 = 8_000;
pub const OVERLAP_MS: u64 = 1_500;
const SILENCE_NOISE_DB: i32 = -30;
const SILENCE_MIN_DURATION_S: f32 = 0.3;
pub const SAMPLE_RATE: u32 = 16_000;

/// One VAD-derived chunk on disk.
#[derive(Debug, Clone)]
pub struct AudioChunk {
    pub idx: usize,
    pub start_ms: u64,
    pub end_ms: u64,
    pub path: PathBuf,
}

/// Resolve ffmpeg. Delegates to the same lookup the export routes use so a
/// Tauri-launched app with a stripped PATH behaves identically everywhere.
fn ffmpeg() -> Result<PathBuf, String> {
    crate::api::audio::find_ffmpeg()
}

/// Parse `silence_start` / `silence_end` values out of ffmpeg's stderr.
///
/// Extracted as a pure function so the parsing (the part that is easy to get
/// subtly wrong) is unit-testable without spawning ffmpeg.
pub fn parse_silence_boundaries(stderr: &str, total_ms: u64) -> Vec<u64> {
    let num = |line: &str, key: &str| -> Option<f64> {
        let idx = line.find(key)?;
        let rest = &line[idx + key.len()..];
        let rest = rest.trim_start_matches([':', ' ']);
        let end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(rest.len());
        rest[..end].parse::<f64>().ok()
    };

    let mut starts: Vec<f64> = Vec::new();
    let mut ends: Vec<f64> = Vec::new();
    for line in stderr.lines() {
        if let Some(v) = num(line, "silence_start") {
            starts.push(v);
        } else if let Some(v) = num(line, "silence_end") {
            ends.push(v);
        }
    }

    let mut boundaries: Vec<u64> = Vec::new();
    for (i, end) in ends.iter().enumerate() {
        // A silence still open at EOF has no `silence_end`; fall back to the
        // start value so the midpoint is at least inside the region.
        let start = starts.get(i).copied().unwrap_or(*end);
        let midpoint_ms = (((start + end) / 2.0) * 1000.0) as u64;
        if midpoint_ms > 0 && midpoint_ms < total_ms {
            boundaries.push(midpoint_ms);
        }
    }
    // The tail is always a valid cut point.
    boundaries.push(total_ms);
    boundaries.sort_unstable();
    boundaries
}

/// Pick the silence boundary closest to the target inside [min, max].
///
/// Falls back to a hard cut at `max_ms` when continuous speech offers no pause.
pub fn find_best_cut(boundaries: &[u64], min_ms: u64, target_ms: u64, max_ms: u64) -> u64 {
    boundaries
        .iter()
        .filter(|b| **b >= min_ms && **b <= max_ms)
        .min_by_key(|b| b.abs_diff(target_ms))
        .copied()
        .unwrap_or(max_ms)
}

/// Read duration in ms from a WAV file's header.
pub fn wav_total_ms(path: &Path) -> Result<u64, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read wav: {e}"))?;
    parse_wav_total_ms(&bytes)
}

/// Parse the WAV `fmt ` + `data` chunks to compute duration.
///
/// Walked properly rather than assuming a 44-byte header, because ffmpeg
/// inserts a `LIST`/`fact` chunk often enough that a fixed offset silently
/// reads the wrong sample rate.
pub fn parse_wav_total_ms(bytes: &[u8]) -> Result<u64, String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".to_string());
    }
    let mut pos = 12usize;
    let mut rate: u32 = 0;
    let mut channels: u16 = 0;
    let mut bits: u16 = 0;
    let mut data_len: Option<u32> = None;

    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            channels = u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]);
            rate = u32::from_le_bytes([
                bytes[body + 4],
                bytes[body + 5],
                bytes[body + 6],
                bytes[body + 7],
            ]);
            bits = u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]);
        } else if id == b"data" {
            data_len = Some(size as u32);
            break;
        }
        // Chunks are word-aligned.
        pos = body + size + (size & 1);
    }

    let data_len = data_len.ok_or("no data chunk")?;
    if rate == 0 || channels == 0 || bits == 0 {
        return Err("incomplete fmt chunk".to_string());
    }
    let bytes_per_frame = (bits as u64 / 8) * channels as u64;
    if bytes_per_frame == 0 {
        return Err("zero frame size".to_string());
    }
    let frames = data_len as u64 / bytes_per_frame;
    Ok(frames * 1000 / rate as u64)
}

/// Run ffmpeg silencedetect and return candidate cut points plus `total_ms`.
pub async fn detect_silence_boundaries(wav_path: &Path, total_ms: u64) -> Vec<u64> {
    let Ok(ff) = ffmpeg() else {
        return vec![total_ms];
    };
    let filter = format!(
        "silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_DURATION_S}"
    );
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(300),
        tokio::process::Command::new(ff)
            .args(["-hide_banner", "-nostats", "-i"])
            .arg(wav_path)
            .args(["-af", &filter, "-f", "null", "-"])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output(),
    )
    .await;

    match out {
        Ok(Ok(o)) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            parse_silence_boundaries(&stderr, total_ms)
        }
        _ => {
            // A VAD failure must not fail the whole upload — fall back to
            // time-based splitting, exactly as Python did on timeout.
            log::warn!("[vad] silencedetect failed, using time-based splits only");
            vec![total_ms]
        }
    }
}

/// Extract `[start_ms, start_ms+duration_ms]` from `src` into a 16 kHz mono WAV.
pub async fn extract_chunk(
    src: &Path,
    dst: &Path,
    start_ms: u64,
    duration_ms: u64,
) -> Result<(), String> {
    let ff = ffmpeg()?;
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        tokio::process::Command::new(ff)
            .args(["-y", "-hide_banner", "-loglevel", "error", "-ss"])
            .arg(format!("{:.3}", start_ms as f64 / 1000.0))
            .arg("-t")
            .arg(format!("{:.3}", duration_ms as f64 / 1000.0))
            .arg("-i")
            .arg(src)
            .args([
                "-ar",
                "16000",
                "-ac",
                "1",
                "-acodec",
                "pcm_s16le",
                "-f",
                "wav",
            ])
            .arg(dst)
            .output(),
    )
    .await
    .map_err(|_| "ffmpeg extract timed out".to_string())?
    .map_err(|e| format!("ffmpeg spawn: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "ffmpeg extract failed (rc={:?}): {}",
            out.status.code(),
            stderr.chars().take(300).collect::<String>()
        ));
    }
    Ok(())
}

/// Split a normalized WAV into overlapping chunks.
///
/// Mirrors `split_into_chunks`: chunks are ≤ CHUNK_MAX_MS, cut preferably at a
/// silence midpoint, and each successive chunk starts OVERLAP_MS before the
/// previous one ended so boundary words survive (the overlap is de-duplicated
/// when the transcript is assembled).
pub async fn split_into_chunks(wav_path: &Path, out_dir: &Path) -> Result<Vec<AudioChunk>, String> {
    tokio::fs::create_dir_all(out_dir)
        .await
        .map_err(|e| format!("mkdir chunks: {e}"))?;

    let total_ms = wav_total_ms(wav_path)?;
    if total_ms == 0 {
        return Ok(Vec::new());
    }
    if total_ms < CHUNK_MIN_MS {
        // Too short to chunk — one chunk covering everything.
        let chunk_path = out_dir.join("chunk_0000.wav");
        extract_chunk(wav_path, &chunk_path, 0, total_ms).await?;
        return Ok(vec![AudioChunk {
            idx: 0,
            start_ms: 0,
            end_ms: total_ms,
            path: chunk_path,
        }]);
    }

    let boundaries = detect_silence_boundaries(wav_path, total_ms).await;

    let mut chunks: Vec<AudioChunk> = Vec::new();
    let mut cursor_ms: u64 = 0;
    let mut chunk_idx = 0usize;

    while cursor_ms < total_ms {
        let remaining = total_ms - cursor_ms;
        let end_ms = if remaining <= CHUNK_MAX_MS {
            total_ms
        } else {
            find_best_cut(
                &boundaries,
                cursor_ms + CHUNK_MIN_MS,
                cursor_ms + CHUNK_TARGET_MS,
                cursor_ms + CHUNK_MAX_MS,
            )
        };

        if end_ms <= cursor_ms {
            break;
        }

        let chunk_path = out_dir.join(format!("chunk_{chunk_idx:04}.wav"));
        extract_chunk(wav_path, &chunk_path, cursor_ms, end_ms - cursor_ms).await?;
        chunks.push(AudioChunk {
            idx: chunk_idx,
            start_ms: cursor_ms,
            end_ms,
            path: chunk_path,
        });

        if end_ms >= total_ms {
            break;
        }
        cursor_ms = (end_ms - OVERLAP_MS).max(cursor_ms + 1);
        chunk_idx += 1;
    }

    log::info!(
        "[vad] split {total_ms}ms into {} chunks (overlap {OVERLAP_MS}ms)",
        chunks.len()
    );
    Ok(chunks)
}

/// Normalize any input to 16 kHz mono PCM WAV.
///
/// Mirrors `_normalize_to_wav`. Inputs already in that exact format are copied
/// rather than re-encoded, so a WAV upload does not lose a generation.
pub async fn normalize_to_wav(source: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir normalize target: {e}"))?;
    }

    if is_target_format(source).await {
        tokio::fs::copy(source, target)
            .await
            .map_err(|e| format!("copy normalized wav: {e}"))?;
        return Ok(());
    }

    let ff = ffmpeg()?;
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(600),
        tokio::process::Command::new(ff)
            .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
            .arg(source)
            .args([
                "-vn",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-acodec",
                "pcm_s16le",
                "-f",
                "wav",
            ])
            .arg(target)
            .output(),
    )
    .await
    .map_err(|_| "ffmpeg normalize timed out".to_string())?
    .map_err(|e| format!("ffmpeg spawn: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "ffmpeg normalize failed: {}",
            stderr.chars().take(300).collect::<String>()
        ));
    }
    Ok(())
}

/// True when the file already is 16 kHz mono 16-bit PCM WAV.
async fn is_target_format(path: &Path) -> bool {
    let Ok(bytes) = tokio::fs::read(path).await else {
        return false;
    };
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return false;
    }
    let mut pos = 12usize;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            let fmt = u16::from_le_bytes([bytes[body], bytes[body + 1]]);
            let channels = u16::from_le_bytes([bytes[body + 2], bytes[body + 3]]);
            let rate =
                u32::from_le_bytes([bytes[body + 4], bytes[body + 5], bytes[body + 6], bytes[body + 7]]);
            let bits = u16::from_le_bytes([bytes[body + 14], bytes[body + 15]]);
            return fmt == 1 && channels == 1 && rate == SAMPLE_RATE && bits == 16;
        }
        pos = body + size + (size & 1);
    }
    false
}

/// Probe media duration in seconds via ffprobe, falling back to a WAV header read.
pub async fn probe_duration_seconds(path: &Path) -> f64 {
    let ffprobe = ffmpeg()
        .ok()
        .and_then(|p| {
            let cand = p.with_file_name(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
            cand.is_file().then_some(cand)
        });

    if let Some(probe) = ffprobe {
        if let Ok(Ok(out)) = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            tokio::process::Command::new(probe)
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                ])
                .arg(path)
                .output(),
        )
        .await
        {
            if out.status.success() {
                if let Ok(d) = String::from_utf8_lossy(&out.stdout).trim().parse::<f64>() {
                    if d > 0.0 {
                        return d;
                    }
                }
            }
        }
    }

    // Fallback: a WAV header is readable without ffprobe.
    match wav_total_ms(path) {
        Ok(ms) => ms as f64 / 1000.0,
        Err(_) => 0.0,
    }
}

// ─── Transcript assembly (port of upload_pipeline.py) ───

/// Strip the longest prefix of `current` that repeats the tail of `prev_tail`.
///
/// Recovers most word-boundary collisions created by the VAD overlap. O(n) and
/// deliberately approximate — STT output has its own noise floor.
pub fn strip_overlap_prefix(prev_tail: &str, current: &str) -> String {
    let max_window = prev_tail.len().min(current.len()).min(120);
    // Vietnamese is multi-byte, so a byte offset is only usable when BOTH
    // strings have a char boundary there. Walk down until one is found.
    let mut k = max_window;
    while k > 5 {
        // Both slices must start on a char boundary; Vietnamese text is
        // multi-byte, so a raw byte offset is usually invalid mid-character.
        if current.is_char_boundary(k) && prev_tail.is_char_boundary(prev_tail.len() - k) {
            if current[..k] == prev_tail[prev_tail.len() - k..] {
                return current[k..].trim_start().to_string();
            }
        }
        k -= 1;
    }
    current.to_string()
}

/// Format milliseconds as the frontend's `parseFloat`-parseable seconds string.
fn ms_to_seconds_str(ms: u64) -> String {
    format!("{:.2}", ms as f64 / 1000.0)
}

/// One chunk's transcription result.
pub struct ChunkResult {
    pub idx: usize,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// Assemble transcript parts in the realtime JSON format.
///
/// ONE PART PER CHUNK, deliberately not merged by speaker: without a working
/// diarizer every chunk gets speakerId 0, and merging would collapse a
/// 60-minute meeting into a single block with no per-chunk timestamps. Keeping
/// chunks separate guarantees the per-chunk time badges ("1:24 – 1:46") are
/// visible regardless of whether the diarizer loaded.
pub fn build_transcript_parts(
    chunk_results: &[ChunkResult],
    speaker_map: &std::collections::HashMap<usize, usize>,
) -> Vec<Value> {
    let mut sorted: Vec<&ChunkResult> = chunk_results.iter().collect();
    sorted.sort_by_key(|r| r.idx);

    let mut parts: Vec<Value> = Vec::new();
    let mut prev_tail = String::new();
    let mut prev_end_ms: u64 = 0;

    for r in sorted {
        let mut text = r.text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        if !prev_tail.is_empty() && r.start_ms < prev_end_ms {
            text = strip_overlap_prefix(&prev_tail, &text);
            if text.is_empty() {
                continue;
            }
        }

        let speaker_id = speaker_map.get(&r.idx).copied().unwrap_or(0);
        let speaker = format!("Speaker {}", speaker_id + 1);
        let chunk_id = format!("upload-{:04}-{}", r.idx, &uuid::Uuid::new_v4().simple().to_string()[..8]);

        let mut chunk_data = serde_json::Map::new();
        chunk_data.insert(chunk_id.clone(), Value::String(text.clone()));

        parts.push(json!({
            "text": text,
            "speaker": speaker,
            "speakerId": speaker_id,
            "chunkId": chunk_id,
            "chunkIds": [chunk_id],
            "chunkData": Value::Object(chunk_data),
            "startTime": ms_to_seconds_str(r.start_ms),
            "endTime": ms_to_seconds_str(r.end_ms),
            "timestamp": "",
            "translation": "",
        }));

        // Tail used for the next chunk's overlap dedup.
        prev_tail = text
            .chars()
            .rev()
            .take(120)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        prev_end_ms = r.end_ms;
    }
    parts
}

/// Plan natural chunks from a diarization timeline + silence boundaries.
///
/// Why diarize BEFORE chunking for STT:
///   1. Each chunk contains a single speaker's turn instead of blending 2–3
///      speakers inside an arbitrary 22s window.
///   2. Every speaker transition is snapped to the nearest silence midpoint
///      within ±1500ms, so cuts land cleanly between sentences rather than on
///      fixed 2000ms window edges.
///   3. Long single-speaker monologues (> `CHUNK_MAX_MS`) are split at natural
///      silence pauses with 0ms overlap (falling back to `OVERLAP_MS` only
///      when no pause exists in the window).
pub fn plan_speaker_turn_chunks(
    timeline: &[crate::diarize::DiarSegment],
    silence_boundaries: &[u64],
    total_ms: u64,
) -> Vec<(u64, u64, usize)> {
    if timeline.is_empty() || total_ms == 0 {
        return Vec::new();
    }

    // 1. Merge consecutive fine windows of the same speaker into raw turns.
    let mut turns: Vec<(u64, u64, usize)> = Vec::new();
    for seg in timeline {
        let s = seg.start_ms.min(total_ms);
        let e = seg.end_ms.min(total_ms);
        if e <= s {
            continue;
        }
        match turns.last_mut() {
            Some(last) if last.2 == seg.speaker_id => {
                last.1 = last.1.max(e);
            }
            _ => turns.push((s, e, seg.speaker_id)),
        }
    }
    if turns.is_empty() {
        return Vec::new();
    }

    // Smooth isolated 1-window blips (A -> short B -> A) so a cough or brief
    // backchannel doesn't slice Speaker A's sentence in half.
    if turns.len() >= 3 {
        let mut smoothed: Vec<(u64, u64, usize)> = Vec::with_capacity(turns.len());
        let mut i = 0;
        while i < turns.len() {
            if i + 2 < turns.len()
                && turns[i].2 == turns[i + 2].2
                && turns[i + 1].1.saturating_sub(turns[i + 1].0) <= crate::diarize::FINE_WINDOW_MS
            {
                let merged_end = turns[i + 2].1;
                let spk = turns[i].2;
                let start = turns[i].0;
                smoothed.push((start, merged_end, spk));
                i += 3;
            } else {
                smoothed.push(turns[i]);
                i += 1;
            }
        }
        // Re-merge any adjacent turns that now share a speaker.
        let mut collapsed: Vec<(u64, u64, usize)> = Vec::with_capacity(smoothed.len());
        for t in smoothed {
            match collapsed.last_mut() {
                Some(last) if last.2 == t.2 => last.1 = last.1.max(t.1),
                _ => collapsed.push(t),
            }
        }
        turns = collapsed;
    }

    // 2. Compute contiguous turn boundaries covering [0, total_ms], snapping
    // each speaker change to the nearest silence pause within ±1500ms.
    const SNAP_WINDOW_MS: u64 = 1_500;
    const MIN_TURN_MS: u64 = 1_200;
    let mut cut_points: Vec<u64> = Vec::with_capacity(turns.len() + 1);
    cut_points.push(0);
    for pair in turns.windows(2) {
        let prev_cut = *cut_points.last().unwrap_or(&0);
        let raw_mid = (pair[0].1 + pair[1].0) / 2;
        let snapped = silence_boundaries
            .iter()
            .copied()
            .filter(|&b| {
                b > prev_cut + MIN_TURN_MS
                    && b + MIN_TURN_MS < total_ms
                    && b.abs_diff(raw_mid) <= SNAP_WINDOW_MS
            })
            .min_by_key(|&b| b.abs_diff(raw_mid))
            .unwrap_or(raw_mid)
            .clamp((prev_cut + 500).min(total_ms), total_ms);
        cut_points.push(snapped);
    }
    cut_points.push(total_ms);

    // 3. Renumber speakers in order of first appearance (0, 1, 2, ...) and
    // split any long single-speaker turn (> CHUNK_MAX_MS) at natural pauses.
    let mut seen_speakers: std::collections::HashMap<usize, usize> =
        std::collections::HashMap::new();
    let mut out: Vec<(u64, u64, usize)> = Vec::new();

    for (idx, &(_, _, raw_spk)) in turns.iter().enumerate() {
        let next_id = seen_speakers.len();
        let spk = *seen_speakers.entry(raw_spk).or_insert(next_id);
        let turn_start = cut_points[idx];
        let turn_end = cut_points[idx + 1];
        if turn_end <= turn_start {
            continue;
        }

        let mut cursor = turn_start;
        while cursor < turn_end {
            let rem = turn_end - cursor;
            if rem <= CHUNK_MAX_MS {
                out.push((cursor, turn_end, spk));
                break;
            }
            // Look for a silence boundary inside this speaker's monologue.
            let min_b = cursor + CHUNK_MIN_MS;
            let target_b = cursor + CHUNK_TARGET_MS;
            let max_b = (cursor + CHUNK_MAX_MS).min(turn_end);
            let silence_cut = silence_boundaries
                .iter()
                .copied()
                .filter(|&b| b >= min_b && b <= max_b && b + 1000 < turn_end)
                .min_by_key(|&b| b.abs_diff(target_b));

            if let Some(cut) = silence_cut {
                out.push((cursor, cut, spk));
                // Clean silence pause -> no overlap needed.
                cursor = cut;
            } else {
                out.push((cursor, max_b, spk));
                cursor = (max_b - OVERLAP_MS).max(cursor + 1);
            }
        }
    }

    out
}

/// Diarize the normalized WAV FIRST, then split into natural speaker-turn +
/// silence-snapped chunks ready for STT.
///
/// Falls back to VAD-only `split_into_chunks` when the speaker model is absent
/// or the recording is too short to cluster.
pub async fn diarize_and_split_into_chunks(
    wav_path: &Path,
    out_dir: &Path,
) -> Result<(Vec<AudioChunk>, std::collections::HashMap<usize, usize>), String> {
    tokio::fs::create_dir_all(out_dir)
        .await
        .map_err(|e| format!("mkdir chunks: {e}"))?;

    let total_ms = wav_total_ms(wav_path)?;
    if total_ms == 0 {
        return Ok((Vec::new(), std::collections::HashMap::new()));
    }

    // Run silence detection and fine-window speaker diarization concurrently.
    let wav_for_diar = wav_path.to_path_buf();
    let diar_fut = tokio::task::spawn_blocking(move || {
        let model = crate::diarize::default_model_path()?;
        crate::diarize::diarize_fine_windows(
            &wav_for_diar,
            &model,
            crate::diarize::FINE_WINDOW_MS,
            crate::diarize::DEFAULT_DISTANCE_THRESHOLD,
            crate::diarize::FINE_SILENCE_RMS,
        )
        .ok()
    });
    let silence_fut = detect_silence_boundaries(wav_path, total_ms);
    let (diar_res, silence_boundaries) = tokio::join!(diar_fut, silence_fut);
    let timeline = diar_res
        .ok()
        .flatten()
        .map(|d| d.timeline)
        .unwrap_or_default();

    let planned = plan_speaker_turn_chunks(&timeline, &silence_boundaries, total_ms);
    if planned.is_empty() {
        let chunks = split_into_chunks(wav_path, out_dir).await?;
        return Ok((chunks, std::collections::HashMap::new()));
    }

    let mut chunks = Vec::with_capacity(planned.len());
    let mut speaker_map = std::collections::HashMap::with_capacity(planned.len());
    for (idx, (start_ms, end_ms, spk)) in planned.into_iter().enumerate() {
        let chunk_path = out_dir.join(format!("chunk_{idx:04}.wav"));
        extract_chunk(wav_path, &chunk_path, start_ms, end_ms - start_ms).await?;
        chunks.push(AudioChunk {
            idx,
            start_ms,
            end_ms,
            path: chunk_path,
        });
        speaker_map.insert(idx, spk);
    }

    log::info!(
        "[pipeline] diarized first → split {total_ms}ms into {} natural speaker-turn chunks",
        chunks.len()
    );
    Ok((chunks, speaker_map))
}

/// Transcript parts from Soniox Async segments (same shape as
/// [`build_transcript_parts`]). Soniox labels speakers "1", "2", …; they are
/// renumbered by first appearance so the UI shows Speaker 1, 2, … in order.
pub fn soniox_transcript_parts(segments: &[crate::stt::soniox_async::Segment]) -> Vec<Value> {
    let mut order: Vec<&str> = Vec::new();
    segments
        .iter()
        .enumerate()
        .map(|(i, seg)| {
            let speaker_id = match order.iter().position(|s| *s == seg.speaker) {
                Some(p) => p,
                None => {
                    order.push(&seg.speaker);
                    order.len() - 1
                }
            };
            let chunk_id = format!("upload-{:04}-{}", i, &uuid::Uuid::new_v4().simple().to_string()[..8]);
            let mut chunk_data = serde_json::Map::new();
            chunk_data.insert(chunk_id.clone(), Value::String(seg.text.clone()));
            json!({
                "text": seg.text,
                "speaker": format!("Speaker {}", speaker_id + 1),
                "speakerId": speaker_id,
                "chunkId": chunk_id,
                "chunkIds": [chunk_id],
                "chunkData": Value::Object(chunk_data),
                "startTime": ms_to_seconds_str(seg.start_ms.max(0) as u64),
                "endTime": ms_to_seconds_str(seg.end_ms.max(0) as u64),
                "timestamp": "",
                "translation": "",
            })
        })
        .collect()
}

/// Diarize the whole normalized file and map speakers onto VAD chunks.
///
/// Best-effort by design: without a diarizer model, or if diarization fails,
/// every chunk maps to speaker 0 and the transcript still gets written. The
/// Python pipeline behaved the same way — a diarizer problem must not cost the
/// user their transcript.
pub fn chunk_speaker_map(
    wav_path: &Path,
    chunks: &[AudioChunk],
) -> std::collections::HashMap<usize, usize> {
    let Some(model) = crate::diarize::default_model_path() else {
        log::warn!("[pipeline] diarizer model unavailable — all chunks get speaker 0");
        return std::collections::HashMap::new();
    };

    let timeline = match crate::diarize::diarize_fine_windows(
        wav_path,
        &model,
        crate::diarize::FINE_WINDOW_MS,
        crate::diarize::DEFAULT_DISTANCE_THRESHOLD,
        crate::diarize::FINE_SILENCE_RMS,
    ) {
        Ok(d) => d.timeline,
        Err(e) => {
            log::warn!("[pipeline] diarization failed ({e}) — all chunks get speaker 0");
            return std::collections::HashMap::new();
        }
    };

    let bounds: Vec<(usize, u64, u64)> = chunks
        .iter()
        .map(|c| (c.idx, c.start_ms, c.end_ms))
        .collect();
    crate::diarize::chunk_speaker_map_from_timeline(&timeline, &bounds)
}

/// Flatten transcript parts into `"Speaker: text"` lines for the summarizer.
pub fn flatten_parts(parts: &[Value]) -> String {    let mut lines: Vec<String> = Vec::new();
    for p in parts {
        let text = p.get("text").and_then(Value::as_str).unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        let speaker = p
            .get("speaker")
            .and_then(Value::as_str)
            .unwrap_or("Speaker");
        lines.push(format!("{speaker}: {text}"));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_boundaries_pair_starts_and_ends() {
        let stderr = "\
[silencedetect @ 0x1] silence_start: 5.0
[silencedetect @ 0x1] silence_end: 7.0 | silence_duration: 2.0
[silencedetect @ 0x1] silence_start: 20.0
[silencedetect @ 0x1] silence_end: 22.0 | silence_duration: 2.0";
        let b = parse_silence_boundaries(stderr, 60_000);
        // Midpoints 6000 and 21000, plus the total tail.
        assert_eq!(b, vec![6_000, 21_000, 60_000]);
    }

    #[test]
    fn silence_boundary_at_or_past_total_is_dropped() {
        let stderr = "silence_start: 59.0\nsilence_end: 61.0";
        let b = parse_silence_boundaries(stderr, 60_000);
        assert_eq!(b, vec![60_000]);
    }

    #[test]
    fn unterminated_silence_uses_its_start_as_midpoint_source() {
        // No silence_end (still silent at EOF) -> no midpoint emitted.
        let b = parse_silence_boundaries("silence_start: 5.0", 60_000);
        assert_eq!(b, vec![60_000]);
    }

    #[test]
    fn best_cut_prefers_boundary_nearest_target() {
        let b = vec![10_000, 20_000, 23_000, 30_000, 60_000];
        // target 22s, window [8s, 28s] -> 23s is nearest.
        assert_eq!(find_best_cut(&b, 8_000, 22_000, 28_000), 23_000);
        // No candidate in window -> hard cut at max.
        assert_eq!(find_best_cut(&[1_000], 8_000, 22_000, 28_000), 28_000);
    }

    #[test]
    fn wav_duration_parses_riff_with_extra_chunks() {
        // RIFF/WAVE, a LIST chunk, then fmt + data. A naive 44-byte-offset
        // parser reads the wrong rate here.
        let mut b: Vec<u8> = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"LIST");
        b.extend_from_slice(&4u32.to_le_bytes());
        b.extend_from_slice(b"INFO");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&1u16.to_le_bytes()); // mono
        b.extend_from_slice(&16_000u32.to_le_bytes());
        b.extend_from_slice(&32_000u32.to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        // 16000 frames * 2 bytes = 1 second.
        b.extend_from_slice(&32_000u32.to_le_bytes());
        assert_eq!(parse_wav_total_ms(&b).unwrap(), 1_000);
    }

    #[test]
    fn wav_duration_rejects_non_wav() {
        assert!(parse_wav_total_ms(b"not a wav file at all").is_err());
    }

    #[test]
    fn overlap_prefix_is_stripped() {
        let prev = "xin chào các bạn hôm nay";
        let cur = "các bạn hôm nay chúng ta bắt đầu";
        assert_eq!(strip_overlap_prefix(prev, cur), "chúng ta bắt đầu");
    }

    #[test]
    fn overlap_strip_leaves_unrelated_text_alone() {
        let prev = "xin chào các bạn";
        let cur = "hoàn toàn khác biệt";
        assert_eq!(strip_overlap_prefix(prev, cur), cur);
    }

    /// Vietnamese is multi-byte: overlap stripping must not split a char.
    #[test]
    fn overlap_strip_handles_multibyte_text() {
        let prev = "chúng ta cần thống nhất kế hoạch";
        let cur = "thống nhất kế hoạch cho tuần sau";
        let out = strip_overlap_prefix(prev, cur);
        assert_eq!(out, "cho tuần sau");
    }

    #[test]
    fn transcript_parts_carry_the_realtime_shape() {
        let results = vec![
            ChunkResult { idx: 0, start_ms: 0, end_ms: 22_000, text: "câu một".into() },
            ChunkResult { idx: 1, start_ms: 20_500, end_ms: 45_000, text: "câu hai".into() },
        ];
        let mut map = std::collections::HashMap::new();
        map.insert(0usize, 0usize);
        map.insert(1usize, 1usize);
        let parts = build_transcript_parts(&results, &map);

        assert_eq!(parts.len(), 2);
        let p0 = &parts[0];
        assert_eq!(p0["speaker"], "Speaker 1");
        assert_eq!(p0["speakerId"], 0);
        assert_eq!(p0["startTime"], "0.00");
        assert_eq!(p0["endTime"], "22.00");
        assert_eq!(p0["translation"], "");
        assert!(p0["chunkId"].as_str().unwrap().starts_with("upload-0000-"));
        assert_eq!(p0["chunkIds"].as_array().unwrap().len(), 1);
        // chunkData maps the chunkId to its text.
        let cid = p0["chunkId"].as_str().unwrap();
        assert_eq!(p0["chunkData"][cid], "câu một");
        assert_eq!(parts[1]["speaker"], "Speaker 2");
        assert_eq!(parts[1]["startTime"], "20.50");
    }

    #[test]
    fn empty_chunk_text_is_skipped() {
        let results = vec![
            ChunkResult { idx: 0, start_ms: 0, end_ms: 1000, text: "  ".into() },
            ChunkResult { idx: 1, start_ms: 1000, end_ms: 2000, text: "thật".into() },
        ];
        let parts = build_transcript_parts(&results, &std::collections::HashMap::new());
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["text"], "thật");
        // No diarizer -> speaker 0 -> "Speaker 1".
        assert_eq!(parts[0]["speaker"], "Speaker 1");
    }

    #[test]
    fn flatten_parts_builds_speaker_lines() {
        let parts = vec![
            json!({"speaker": "Speaker 1", "text": "a"}),
            json!({"speaker": "Speaker 2", "text": "b"}),
            json!({"speaker": "Speaker 2", "text": "  "}),
        ];
        assert_eq!(flatten_parts(&parts), "Speaker 1: a\nSpeaker 2: b");
    }

    #[test]
    fn plan_speaker_turn_chunks_snaps_to_silence_and_smooths_blips() {
        use crate::diarize::DiarSegment;
        // Speaker 5 talks 0..6s (with a 1-window blip of speaker 9 at 2..4s),
        // then Speaker 2 talks 6..12s. A silence boundary sits at 6350ms.
        let timeline = vec![
            DiarSegment { start_ms: 0, end_ms: 2_000, speaker_id: 5 },
            DiarSegment { start_ms: 2_000, end_ms: 4_000, speaker_id: 9 },
            DiarSegment { start_ms: 4_000, end_ms: 6_000, speaker_id: 5 },
            DiarSegment { start_ms: 6_000, end_ms: 10_000, speaker_id: 2 },
            DiarSegment { start_ms: 10_000, end_ms: 12_000, speaker_id: 2 },
        ];
        let silence = vec![6_350, 12_000];
        let planned = plan_speaker_turn_chunks(&timeline, &silence, 12_000);
        // Blip at 2..4s smoothed into Speaker 5 (renumbered -> 0); transition
        // around 6000ms snapped to the 6350ms silence pause; Speaker 2 -> 1.
        assert_eq!(planned, vec![(0, 6_350, 0), (6_350, 12_000, 1)]);
    }
}
