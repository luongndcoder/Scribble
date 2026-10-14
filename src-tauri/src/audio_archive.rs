//! Meeting audio archive for system-audio recordings (Tauri capture).
//!
//! System audio is captured natively and streamed to `/ws/*-stream` with
//! `?source=system&meeting_id=N`. The handler appends that raw PCM16 (16 kHz
//! mono) to `audio/meeting_N.pcm` and points the meeting's `audio_path` at it —
//! the Python sidecar did the same. In "both" mode the webview also archives
//! the MICROPHONE as webm via `PATCH /drafts/N/audio`; that file can't be
//! appended to raw PCM, so it is kept beside it as `meeting_N_mic.<ext>`.
//!
//! Once nobody is recording into the meeting, [`finalize_mix`] (run lazily on
//! first playback/export) mixes system + mic into `meeting_N_mix.m4a` with
//! ffmpeg, so the archive holds both sides of the call.
//!
//! Resuming a draft that was already mixed: the mixed file is moved aside as
//! `meeting_N_prev.m4a` and prepended at the next mix.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Meetings with a live system-audio archive writer (never mix these).
static ACTIVE: Mutex<Option<HashSet<i64>>> = Mutex::new(None);

pub fn is_active(meeting_id: i64) -> bool {
    ACTIVE.lock().map(|g| g.as_ref().is_some_and(|s| s.contains(&meeting_id))).unwrap_or(false)
}

fn set_active(meeting_id: i64, on: bool) {
    if let Ok(mut g) = ACTIVE.lock() {
        let s = g.get_or_insert_with(HashSet::new);
        if on {
            s.insert(meeting_id);
        } else {
            s.remove(&meeting_id);
        }
    }
}

fn audio_dir() -> Option<PathBuf> {
    crate::db::Database::get().map(|db| db.data_dir().join("audio"))
}

pub fn pcm_path(dir: &Path, id: i64) -> PathBuf {
    dir.join(format!("meeting_{id}.pcm"))
}

fn mix_path(dir: &Path, id: i64) -> PathBuf {
    dir.join(format!("meeting_{id}_mix.m4a"))
}

fn prev_path(dir: &Path, id: i64) -> PathBuf {
    dir.join(format!("meeting_{id}_prev.m4a"))
}

/// Mic companion for `ext` (".webm", ".m4a", …).
pub fn mic_path(dir: &Path, id: i64, ext: &str) -> PathBuf {
    dir.join(format!("meeting_{id}_mic{ext}"))
}

/// The existing mic companion, whatever its extension.
fn find_mic(dir: &Path, id: i64) -> Option<PathBuf> {
    [".webm", ".m4a", ".mp4", ".ogg", ".wav"]
        .iter()
        .map(|ext| mic_path(dir, id, ext))
        .find(|p| p.is_file())
}

fn set_audio_path(id: i64, path: &Path) {
    if let Some(db) = crate::db::Database::get() {
        let mut upd = serde_json::Map::new();
        upd.insert("audio_path".into(), serde_json::Value::String(path.to_string_lossy().into_owned()));
        if let Err(e) = db.update_meeting(id, &upd) {
            log::warn!("[audio-archive] FAILED: set audio_path meeting={id}: {e}");
        }
    }
}

fn current_audio_path(id: i64) -> Option<PathBuf> {
    let db = crate::db::Database::get()?;
    let m = db.get_meeting(id).ok().flatten()?;
    m.get("audio_path")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

/// Appends system-audio PCM for one meeting while a stream is open.
pub struct SystemArchive {
    id: i64,
    file: std::fs::File,
}

impl SystemArchive {
    /// Open (or continue) `meeting_N.pcm` and make it the meeting's audio.
    pub fn open(id: i64) -> Option<Self> {
        let dir = audio_dir()?;
        std::fs::create_dir_all(&dir).ok()?;
        let pcm = pcm_path(&dir, id);
        // Whatever the meeting already holds is preserved, never overwritten:
        //   - a mixed file from an earlier session → `_prev.m4a` (prepended at
        //     the next mix);
        //   - a mic archive that started before the first system frame →
        //     becomes the mic companion.
        if let Some(existing) = current_audio_path(id).filter(|p| p != &pcm && p.is_file()) {
            let target = if existing == mix_path(&dir, id) {
                prev_path(&dir, id)
            } else {
                let ext = existing.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
                mic_path(&dir, id, &ext)
            };
            if !target.exists() {
                if let Err(e) = std::fs::rename(&existing, &target) {
                    log::warn!("[audio-archive] FAILED: move {} aside: {e}", existing.display());
                }
            }
        }
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&pcm).ok()?;
        set_audio_path(id, &pcm);
        set_active(id, true);
        log::info!("[audio-archive] STARTED: system archive meeting={id}");
        Some(Self { id, file })
    }

    pub fn write(&mut self, pcm16: &[u8]) {
        if let Err(e) = self.file.write_all(pcm16) {
            log::warn!("[audio-archive] FAILED: append meeting={}: {e}", self.id);
        }
    }
}

impl Drop for SystemArchive {
    fn drop(&mut self) {
        let _ = self.file.flush();
        set_active(self.id, false);
        log::info!("[audio-archive] COMPLETED: system archive meeting={}", self.id);
    }
}

/// Where a mic chunk for meeting `id` must go while the meeting's audio is a
/// system PCM archive (or one is starting): the mic companion file.
pub fn mic_target_if_system(id: i64, audio_path: &str, upload_ext: &str) -> Option<PathBuf> {
    let pcm_active = audio_path.to_ascii_lowercase().ends_with(".pcm");
    if !(pcm_active || is_active(id)) || upload_ext == ".pcm" {
        return None;
    }
    let dir = audio_dir()?;
    Some(find_mic(&dir, id).unwrap_or_else(|| mic_path(&dir, id, upload_ext)))
}

/// Mix system PCM + mic companion (+ an earlier mixed session) into
/// `meeting_N_mix.m4a` once recording has ended. No-op when there is nothing
/// to mix. Best effort: on failure the separate files stay and playback falls
/// back to the system PCM.
pub async fn finalize_mix(id: i64) {
    if is_active(id) {
        return;
    }
    let Some(dir) = audio_dir() else { return };
    let pcm = pcm_path(&dir, id);
    let mic = find_mic(&dir, id);
    let prev = Some(prev_path(&dir, id)).filter(|p| p.is_file());
    if !pcm.is_file() || (mic.is_none() && prev.is_none()) {
        return;
    }
    let Ok(ff) = crate::api::audio::find_ffmpeg() else {
        log::warn!("[audio-archive] FAILED: mix meeting={id}: ffmpeg not found");
        return;
    };
    let out = mix_path(&dir, id);
    let tmp = dir.join(format!("meeting_{id}_mix.part.m4a"));

    let mut cmd = tokio::process::Command::new(ff);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    cmd.args(["-f", "s16le", "-ar", "16000", "-ac", "1", "-i"]).arg(&pcm);
    let mut graph = String::from("[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[sys];");
    let mut next = 1;
    let current = if let Some(m) = &mic {
        cmd.arg("-i").arg(m);
        // normalize=0 keeps both sides at their own level (no halving).
        graph.push_str(&format!("[{next}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[mic];[sys][mic]amix=inputs=2:duration=longest:normalize=0[cur];"));
        next += 1;
        "[cur]"
    } else {
        "[sys]"
    };
    if let Some(p) = &prev {
        cmd.arg("-i").arg(p);
        graph.push_str(&format!("[{next}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono[prev];[prev]{current}concat=n=2:v=0:a=1[out]"));
    } else {
        graph.push_str(&format!("{current}anull[out]"));
    }
    cmd.args(["-filter_complex", &graph, "-map", "[out]", "-ac", "1", "-c:a", "aac", "-b:a", "64k"]);
    cmd.arg(&tmp);

    match cmd.output().await {
        Ok(o) if o.status.success() => {
            if let Err(e) = std::fs::rename(&tmp, &out) {
                log::warn!("[audio-archive] FAILED: finalize mix meeting={id}: {e}");
                return;
            }
            set_audio_path(id, &out);
            for p in [Some(pcm), mic, prev].into_iter().flatten() {
                let _ = std::fs::remove_file(p);
            }
            let _ = std::fs::remove_file(dir.join("cache").join(format!("play_{id}.wav")));
            log::info!("[audio-archive] COMPLETED: mixed system+mic meeting={id}");
        }
        Ok(o) => {
            let _ = std::fs::remove_file(&tmp);
            let err: String = String::from_utf8_lossy(&o.stderr).chars().take(200).collect();
            log::warn!("[audio-archive] FAILED: mix meeting={id}: {err}");
        }
        Err(e) => log::warn!("[audio-archive] FAILED: spawn ffmpeg meeting={id}: {e}"),
    }
}

/// Remove every archive file of a deleted meeting (pcm, mic, mix, prev).
pub fn remove_all(id: i64) {
    let Some(dir) = audio_dir() else { return };
    let mut paths = vec![pcm_path(&dir, id), mix_path(&dir, id), prev_path(&dir, id)];
    paths.extend(find_mic(&dir, id));
    for p in paths {
        let _ = std::fs::remove_file(p);
    }
}
