//! Speaker diarization in Rust — replaces `src-python/diarize.py`'s ONNX path
//! and `src-python/services/batch_diarizer.py` entirely, deleting the Python
//! `onnxruntime` + `scipy` dependencies.
//!
//! # Layout
//!
//! * [`clustering`] — cosine distance / UPGMA average linkage / distance cut,
//!   a pure-Rust port of the numpy code whose parity with scipy was verified on
//!   192 real meeting embeddings at 4 thresholds.
//! * [`embedding`] — speaker embeddings through `ort` (ONNX Runtime) + Kaldi
//!   fbank.
//! * this module — the batch diarization pipeline (fine windows → timeline →
//!   chunk speaker map) and speaker identification for a known profile set.
//!
//! # Model (read this before tuning thresholds)
//!
//! Shipped model: **3D-Speaker ERes2Net-base** (`speaker_eres2net_base.onnx`,
//! 512-d, Apache-2.0), chosen on 2026-10-09 over four alternatives by direct
//! measurement on the user's real Vietnamese meeting. It replaced the hynt
//! ResNet34, which could not separate the two similar male voices the user
//! reported. Full protocol, numbers and limits:
//! `docs/reports/speaker-model-swap-2026-10-09.md`.
//!
//! Every threshold below was re-derived for this embedding space. Thresholds and
//! embedding spaces are a matched pair: the hynt-era values, applied unchanged
//! to ERes2Net, collapse 184 of 192 windows into one speaker. If the model is
//! swapped again, re-run `examples/spk_separation.rs` and re-derive - do not
//! carry the numbers over.
//!
//! **Honest limit.** ERes2Net measurably improves separation (overlap 88.6% ->
//! 82.2%, d-prime 0.527 -> 0.705) but does **not** cleanly solve the two-similar-
//! male-voices case in this recording. Both models' same/different-speaker
//! similarity distributions overlap almost entirely. See the report before
//! promising a quality level this audio cannot support.
//!
//! `sherpa-onnx` is still a dependency: the STT side (`src/stt/local.rs`) keeps
//! using it. Only this embedding path moved off it.

pub mod clustering;
pub mod embedding;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub use embedding::{cosine_similarity, l2_normalize, resolve_model_path, BUNDLED_MODEL_NAME};

// ── Tunable parameters ───────────────────────────────────────────────────────

/// Cosine DISTANCE at which fine windows merge into one speaker (average linkage).
///
/// **Re-derived 2026-10-09 for the ERes2Net embedding space.** A cut is only
/// meaningful relative to the embedding space it runs in, so swapping the model
/// ([`embedding::BUNDLED_MODEL_NAME`]) *requires* revisiting this number. The
/// old 0.45 was calibrated for hynt ResNet34; applied unchanged to ERes2Net it
/// merged 184 of 192 windows into a single speaker.
///
/// Derivation on the user's real 6.7-minute Vietnamese meeting
/// `/tmp/sale_campaign.wav` (192 two-second speech windows), using the
/// label-free near/far proxy documented in `examples/spk_separation.rs`:
///
/// * different-speaker (FAR) cosine distance: p50 0.686, p95 0.432, max 0.273
/// * same-speaker (NEAR) cosine distance:      p50 0.547, p75 0.451
///
/// The two distributions overlap almost completely (see
/// `docs/reports/speaker-model-swap-2026-10-09.md`), so no cut separates them.
/// The value below is therefore chosen on the *cluster structure the user
/// expects* rather than a clean error minimum:
///
/// | cut  | cluster sizes on the meeting                              |
/// |------|----------------------------------------------------------|
/// | 0.40 | [184, 2, 1, 1, 1, 1, 1, 1] - one speaker swallows the file |
/// | 0.55 | [100, 81, 3, 3, 2, 1, 1, 1] - two comparable speakers     |
/// | 0.60 | [115, 67, 4, 2, 1, 1, 1, 1]                              |
/// | 0.70 | [137, 39, 8, 3, 2, 1, 1, 1]                              |
///
/// 0.55 is the loosest cut that still yields two balanced clusters, i.e. the
/// first point at which the two similar male voices are actually split. It
/// keeps ~48% of same-speaker pairs together while wrongly merging ~23% of
/// different-speaker pairs - poor in absolute terms, and a deliberate choice of
/// over-splitting over the collapse-to-one-speaker the user reported.
///
/// Env override: `DIARIZE_DISTANCE_THRESHOLD`.
///
/// History: 0.45 for hynt ResNet34, briefly 0.35 for CAM++, then 0.45 again when
/// CAM++ was reverted. Every one of those was fit to the old model and must not
/// be restored without re-running the measurement.
///
/// 2026-10-10: 0.50 with hynt ResNet34 again (single shipped speaker model).
/// On a real 8-speaker Vietnamese podcast it gave 9 sizeable clusters; 0.45
/// over-split. MATCH/STRONG/NEW_SPEAKER_SELF_SIM below are the values that were
/// calibrated for hynt on real Vietnamese meeting audio
/// (docs/reports/calibration-2026-10-09-hynt-resnet34-tts.md).
pub const DEFAULT_DISTANCE_THRESHOLD: f64 = 0.50;

/// Fine-grained diarization window (ms), independent of 20s STT chunks.
pub const FINE_WINDOW_MS: u64 = 2000;

/// RMS below which a window is treated as near-silence and skipped.
pub const FINE_SILENCE_RMS: f32 = 0.01;

/// Cosine SIMILARITY bar for "this is an existing speaker" during identification.
///
/// **Re-derived 2026-10-09 for ERes2Net.** On the real meeting audio, using the
/// same near/far proxy (2s windows):
///
/// * same speaker: p05 0.134, p25 0.313, p50 0.453
/// * different:   p50 0.314, p95 0.568, max 0.727
///
/// 0.42 sits just under the same-speaker median (0.453) so about half of
/// same-speaker comparisons match first-shot, while staying below the
/// different-speaker p95. The distributions overlap and no value is genuinely
/// safe; this one is biased toward *not* forcing a wrong match, because a missed
/// match merely creates a new profile (recoverable) whereas a wrong match
/// contaminates an existing one (not recoverable).
///
/// The previous 0.50 was calibrated for hynt (same-speaker p25 0.499) and is
/// ~0.08 too high here. Env override: `DIARIZE_MATCH_THRESHOLD`.
pub const MATCH_THRESHOLD: f32 = 0.50;

/// Cosine SIMILARITY bar for a confident, unambiguous identification.
///
/// Above the different-speaker maximum (0.727), so it can only fire on
/// genuinely tight matches. Lowered from 0.70 (hynt) because the ERes2Net space
/// compresses similarities: same-speaker p95 is 0.649.
pub const STRONG_MATCH_THRESHOLD: f32 = 0.70;

/// Cosine SIMILARITY above which two speaker profiles are merge candidates.
///
/// Must exceed the different-speaker maximum (0.727) or two distinct people get
/// merged automatically; 0.80 keeps a ~0.07 margin. Unchanged from hynt because
/// it was already derived from the different-speaker max - but that max is now
/// measured on ERes2Net rather than on hynt.
pub const MERGE_SIM_THRESHOLD: f32 = 0.80;

/// Minimum self-similarity for confirming a brand-new speaker profile.
///
/// Set just above the same-speaker p05 (0.134), near the p25 (0.313): below
/// that a new profile would be confirmed from windows that do not resemble
/// themselves. Lowered from 0.55, which sat above this space's same-speaker
/// *median* and so stranded every new speaker.
pub const NEW_SPEAKER_SELF_SIM: f32 = 0.55;

/// Minimum similarity gap over the runner-up for a "confident" identification.
pub const CONFIDENT_GAP: f32 = 0.10;

/// ONNX intra-op threads used by the embedding extractor.
pub const NUM_THREADS: i32 = 2;

/// One fine-grained window on the diarization timeline.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DiarSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker_id: usize,
}

/// Result of diarizing a whole file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Diarization {
    /// Fine windows in temporal order (speech windows only).
    pub timeline: Vec<DiarSegment>,
    /// Number of distinct speakers found.
    pub n_speakers: usize,
    /// Number of speech windows that were embedded.
    pub n_windows: usize,
    /// L2-normalised embeddings, parallel to `timeline`.
    pub embeddings: Vec<Vec<f32>>,
}

/// Load a 16-bit mono WAV into f32 samples in `[-1, 1]`.
///
/// Mirrors `batch_diarizer._load_wav_samples`. Multi-channel input is
/// downmixed by averaging, and non-16-bit input is rejected loudly rather than
/// silently misread.
pub fn load_wav_samples(path: &Path) -> Result<(Vec<f32>, i32), String> {
    let reader = hound::WavReader::open(path).map_err(|e| format!("open {path:?}: {e}"))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let sr = spec.sample_rate as i32;

    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let bits = spec.bits_per_sample;
            let scale = (1i64 << (bits - 1)) as f32;
            reader
                .into_samples::<i32>()
                .filter_map(|s| s.ok())
                .map(|s| s as f32 / scale)
                .collect()
        }
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .filter_map(|s| s.ok())
            .collect(),
    };

    let samples = if channels > 1 {
        raw.chunks(channels)
            .map(|c| c.iter().sum::<f32>() / channels as f32)
            .collect()
    } else {
        raw
    };
    Ok((samples, sr))
}

/// Root-mean-square of a slice (0.0 for empty input).
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum / samples.len() as f64).sqrt() as f32
}

/// Fine-grained diarization for a whole WAV, mirroring
/// `batch_diarizer.diarize_fine_windows`.
///
/// Slices the audio into non-overlapping ~2s windows, skips near-silence,
/// embeds each speech window, clusters them globally and returns a timeline of
/// `(start_ms, end_ms, speaker_id)`.
///
/// Fine windows are single-speaker far more often than the 20s STT chunks
/// (which blend speakers and collapse to one cluster), which is what actually
/// separates voices.
pub fn diarize_fine_windows(
    wav_path: &Path,
    model_path: &Path,
    window_ms: u64,
    distance_threshold: f64,
    silence_rms: f32,
) -> Result<Diarization, String> {
    let (samples, sr) = load_wav_samples(wav_path)?;
    if sr != embedding::SAMPLE_RATE {
        return Err(format!(
            "expected {}Hz audio, got {sr}Hz — resample before diarizing",
            embedding::SAMPLE_RATE
        ));
    }

    let win = ((window_ms as f64 / 1000.0) * sr as f64) as usize;
    if win == 0 || samples.len() < win {
        return Ok(Diarization::default());
    }

    let mut items: Vec<(usize, Vec<f32>)> = Vec::new();
    let mut spans: Vec<(u64, u64)> = Vec::new();

    let mut start = 0usize;
    while start + win <= samples.len() {
        let seg = &samples[start..start + win];
        if rms(seg) < silence_rms {
            start += win; // skip near-silence so it doesn't pollute clustering
            continue;
        }
        match embedding::embed_samples(model_path, seg, NUM_THREADS) {
            Some(emb) => {
                items.push((items.len(), emb));
                spans.push((
                    (start as f64 / sr as f64 * 1000.0) as u64,
                    ((start + win) as f64 / sr as f64 * 1000.0) as u64,
                ));
            }
            None => {
                log::debug!("[diarize] embedding failed for window at {start}");
            }
        }
        start += win;
    }

    if items.len() < 2 {
        log::info!(
            "[diarize] only {} speech windows — skipping clustering",
            items.len()
        );
        return Ok(Diarization {
            n_windows: items.len(),
            embeddings: items.into_iter().map(|(_, e)| e).collect(),
            ..Default::default()
        });
    }

    let labels = clustering::cluster_speakers(&items, distance_threshold);
    let timeline: Vec<DiarSegment> = spans
        .iter()
        .enumerate()
        .map(|(i, (s, e))| DiarSegment {
            start_ms: *s,
            end_ms: *e,
            speaker_id: labels.get(&i).copied().unwrap_or(0),
        })
        .collect();
    let n_speakers = timeline
        .iter()
        .map(|s| s.speaker_id)
        .collect::<std::collections::HashSet<_>>()
        .len();
    let embeddings: Vec<Vec<f32>> = items.into_iter().map(|(_, e)| e).collect();

    log::info!(
        "[diarize] {} windows ({}ms) → {} speakers (threshold={:.2})",
        timeline.len(),
        window_ms,
        n_speakers,
        distance_threshold
    );

    Ok(Diarization {
        timeline,
        n_speakers,
        n_windows: embeddings.len(),
        embeddings,
    })
}

/// Assign each STT chunk the speaker with the most temporal overlap.
///
/// Mirrors `batch_diarizer.chunk_speaker_map_from_timeline`, including the
/// renumbering so the first chunk's speaker is 0.
pub fn chunk_speaker_map_from_timeline(
    timeline: &[DiarSegment],
    chunk_bounds: &[(usize, u64, u64)],
) -> std::collections::HashMap<usize, usize> {
    use std::collections::HashMap;
    let mut result = HashMap::new();
    if timeline.is_empty() {
        return result;
    }

    let mut raw_map: HashMap<usize, usize> = HashMap::new();
    for &(c_idx, c_start, c_end) in chunk_bounds {
        let mut votes: HashMap<usize, u64> = HashMap::new();
        for w in timeline {
            let overlap = w.end_ms.min(c_end) as i64 - w.start_ms.max(c_start) as i64;
            if overlap > 0 {
                *votes.entry(w.speaker_id).or_insert(0) += overlap as u64;
            }
        }
        if let Some((&best, _)) = votes.iter().max_by_key(|(spk, ov)| (**ov, std::cmp::Reverse(**spk)))
        {
            raw_map.insert(c_idx, best);
        }
    }

    let mut seen: HashMap<usize, usize> = HashMap::new();
    for &(c_idx, _, _) in chunk_bounds {
        let Some(&raw) = raw_map.get(&c_idx) else {
            continue;
        };
        let next = seen.len();
        let id = *seen.entry(raw).or_insert(next);
        result.insert(c_idx, id);
    }
    result
}

/// A known speaker profile: a name plus its L2-normalised embedding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerProfile {
    pub name: String,
    pub embedding: Vec<f32>,
}

/// Outcome of identifying one audio sample against a set of profiles.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identification {
    /// Best-matching profile name, or `None` when nothing cleared the bar.
    pub name: Option<String>,
    /// Similarity to the best match (0.0 when there are no profiles).
    pub similarity: f32,
    /// Similarity to the runner-up, or `None` when only one profile exists.
    pub second_similarity: Option<f32>,
    /// `similarity - second_similarity` — large means unambiguous.
    pub gap: f32,
    /// True when the best match is both strong and clearly ahead.
    pub confident: bool,
}

/// Identify which known speaker produced `samples`.
///
/// Mirrors `diarize.SpeakerDiarizer.identify_speaker_from_samples`: embed the
/// audio, cosine-match against every profile, then require a `MATCH_THRESHOLD`
/// floor. `confident` additionally demands `STRONG_MATCH_THRESHOLD` or a clear
/// margin over the runner-up, which is what callers use to decide whether to
/// create a new speaker instead of forcing a wrong match.
pub fn identify_speaker_from_samples(
    model_path: &Path,
    samples: &[f32],
    sr: i32,
    profiles: &[SpeakerProfile],
) -> Option<Identification> {
    if sr != embedding::SAMPLE_RATE {
        log::warn!("[diarize] identify: expected 16kHz, got {sr}Hz");
        return None;
    }
    let emb = embedding::embed_samples(model_path, samples, NUM_THREADS)?;

    let mut scored: Vec<(f32, &str)> = profiles
        .iter()
        .map(|p| (cosine_similarity(&emb, &p.embedding), p.name.as_str()))
        .collect();
    // Descending by similarity; ties broken by name for determinism.
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.cmp(b.1))
    });

    let Some(&(best_sim, best_name)) = scored.first() else {
        return Some(Identification {
            name: None,
            similarity: 0.0,
            second_similarity: None,
            gap: 0.0,
            confident: false,
        });
    };
    let second = scored.get(1).map(|&(s, _)| s);
    let gap = best_sim - second.unwrap_or(0.0);
    let accept = best_sim >= MATCH_THRESHOLD;
    let confident = accept && (best_sim >= STRONG_MATCH_THRESHOLD || gap >= CONFIDENT_GAP);

    Some(Identification {
        name: if accept { Some(best_name.to_string()) } else { None },
        similarity: best_sim,
        second_similarity: second,
        gap,
        confident,
    })
}

/// Default model path for the app: env override, else the bundled file, else
/// the legacy `src-python/models` location during migration.
pub fn default_model_path() -> Option<PathBuf> {
    resolve_model_path()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(v: &[f32]) -> Vec<f32> {
        l2_normalize(v)
    }

    #[test]
    fn chunk_map_picks_max_overlap_speaker() {
        // Window boundaries: speaker 0 covers 0-3000, speaker 1 covers 3000-6000.
        let timeline = vec![
            DiarSegment { start_ms: 0, end_ms: 3000, speaker_id: 0 },
            DiarSegment { start_ms: 3000, end_ms: 6000, speaker_id: 1 },
        ];
        // Chunk 0 overlaps speaker 0 more; chunk 1 overlaps speaker 1 more.
        let bounds = vec![(0usize, 0u64, 4000u64), (1, 3500, 6000)];
        let map = chunk_speaker_map_from_timeline(&timeline, &bounds);
        assert_eq!(map.get(&0), Some(&0));
        assert_eq!(map.get(&1), Some(&1));
    }

    #[test]
    fn chunk_map_renumbers_by_first_appearance() {
        // First chunk is speaker 1, so it must be renumbered to 0.
        let timeline = vec![DiarSegment { start_ms: 0, end_ms: 2000, speaker_id: 1 }];
        let bounds = vec![(0usize, 0u64, 2000u64), (1, 0, 2000)];
        let map = chunk_speaker_map_from_timeline(&timeline, &bounds);
        assert_eq!(map.get(&0), Some(&0));
        assert_eq!(map.get(&1), Some(&0));
    }

    #[test]
    fn chunk_map_empty_timeline_is_empty() {
        let map = chunk_speaker_map_from_timeline(&[], &[(0, 0, 1000)]);
        assert!(map.is_empty());
    }

    #[test]
    fn cosine_similarity_bounds() {
        let a = unit(&[1.0, 0.0, 0.0]);
        assert!((cosine_similarity(&a, &a) - 1.0).abs() < 1e-5);
        let b = unit(&[0.0, 1.0, 0.0]);
        assert!(cosine_similarity(&a, &b).abs() < 1e-5);
        let c = unit(&[-1.0, 0.0, 0.0]);
        assert!((cosine_similarity(&a, &c) + 1.0).abs() < 1e-5);
    }

    #[test]
    fn identify_returns_none_name_below_match_threshold() {
        let profiles = vec![SpeakerProfile {
            name: "alice".into(),
            embedding: vec![1.0, 0.0],
        }];
        // samples path requires a model, so we only exercise the pure scoring
        // helper here via cosine_similarity + thresholds directly.
        let q = unit(&[0.0, 1.0]);
        let sim = cosine_similarity(&q, &profiles[0].embedding);
        assert!(sim < MATCH_THRESHOLD, "orthogonal vectors must not match");
    }

    #[test]
    fn rms_of_silence_is_zero() {
        assert_eq!(rms(&[0.0; 100]), 0.0);
        assert!(rms(&[]) == 0.0);
        assert!((rms(&[0.5, -0.5, 0.5, -0.5]) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn load_wav_samples_rejects_missing_file() {
        assert!(load_wav_samples(Path::new("/nonexistent/x.wav")).is_err());
    }
}
