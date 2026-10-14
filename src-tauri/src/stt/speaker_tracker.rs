//! Realtime speaker tracking for the local streaming engine.
//!
//! # Why this replaced the per-utterance verdict
//!
//! The previous live diarizer labelled a whole recognizer *utterance* once, at
//! its endpoint. Sherpa only closes an utterance after 1.2s+ of silence, so in
//! a lively meeting one "utterance" spans 10-20s and several people — they all
//! got one label, and the label only appeared after everyone stopped talking.
//! Soniox instead labels every token as it streams.
//!
//! This tracker does the same for the local engine: it embeds a sliding
//! window of the live audio every [`TrackerParams::hop`] and maintains a
//! timeline `sample -> speaker`. The STT worker labels each decoded token by
//! its timestamp, so text splits at the moment the voice changes.
//!
//! # Decision rules (hysteresis)
//!
//! Each speech window is compared to every speaker CENTROID (a running mean of
//! that speaker's window embeddings — far more stable than one window):
//!   - matches the current speaker → stay, refine the centroid;
//!   - a different known speaker wins clearly → candidate switch;
//!   - unlike everyone → candidate NEW speaker.
//! A candidate must hold for [`TrackerParams::confirm`] consecutive windows
//! (one window when the evidence is strong), and a new speaker's windows must
//! resemble EACH OTHER (self-similarity) — a cough or a door slam embeds
//! erratically and fails that test. The confirmed switch is back-dated to the
//! quietest point where the new voice entered, so the text boundary lands
//! between words, not a second late.
//!
//! Everything after the last confirmed decision is *provisional*
//! ([`SpeakerTimeline::stable_until`]): the STT worker keeps those tokens in
//! the interim text until the tracker commits, exactly like Soniox's
//! non-final tokens.

use std::sync::{Arc, Mutex};

use crate::diarize::{cosine_similarity, embedding, FINE_SILENCE_RMS};

const SR: u64 = 16_000;

/// Tunables. Defaults were chosen for ERes2Net embeddings on 1.5s windows;
/// each can be overridden with an env var (`LIVE_DIAR_*`) to calibrate
/// against labelled audio (`examples/live_diar_eval.rs`) without rebuilding.
#[derive(Debug, Clone)]
pub struct TrackerParams {
    /// Window length in samples.
    pub window: usize,
    /// Hop between windows in samples (decision cadence).
    pub hop: usize,
    /// Minimum share of 20ms frames above the silence floor for a window to
    /// count as speech.
    pub min_speech_ratio: f32,
    /// Similarity to a centroid that counts as "this speaker".
    pub match_sim: f32,
    /// Similarity that is unambiguous on its own (allows a 1-window switch).
    pub strong_sim: f32,
    /// How much a rival must beat the current speaker by to start a switch.
    pub switch_gap: f32,
    /// Below this against EVERY centroid → candidate new speaker.
    pub new_max_sim: f32,
    /// Candidate windows of a new speaker must be at least this similar to
    /// each other (rejects coughs/noise as phantom speakers).
    pub self_sim: f32,
    /// Consecutive windows needed to confirm a switch to a KNOWN speaker.
    pub confirm: usize,
    /// Consecutive windows needed before enrolling a NEW speaker. Higher than
    /// `confirm`: short-window embeddings are noisy, and a false enrolment
    /// splits one person into two for the rest of the meeting.
    pub confirm_new: usize,
    /// Only windows at least this close refine the centroid.
    pub update_min_sim: f32,
    /// Below this similarity to the current TURN's recent windows, a window
    /// counts as evidence of a speaker change.
    pub change_sim: f32,
}

impl Default for TrackerParams {
    fn default() -> Self {
        Self {
            window: 24_000, // 1.5s
            hop: 8_000,     // 0.5s
            // Calibrated 2026-10-10 for hynt ResNet34 on a 28-min, 8-speaker
            // Vietnamese podcast (examples/tracker_eval.rs, boundary F1 vs
            // Soniox). Window-to-own-centroid median ≈ 0.50, to-others ≈ 0.25.
            min_speech_ratio: 0.5,
            match_sim: 0.45,
            strong_sim: 0.65,
            switch_gap: 0.08,
            new_max_sim: 0.15,
            self_sim: 0.35,
            confirm: 2,
            confirm_new: 3,
            update_min_sim: 0.45,
            change_sim: 0.50,
        }
    }
}

impl TrackerParams {
    pub fn from_env() -> Self {
        let mut p = Self::default();
        let f = |k: &str, d: f32| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let u = |k: &str, d: usize| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        p.window = (f("LIVE_DIAR_WINDOW_S", 1.5) * SR as f32) as usize;
        p.hop = (f("LIVE_DIAR_HOP_S", 0.5) * SR as f32) as usize;
        p.match_sim = f("LIVE_DIAR_MATCH", p.match_sim);
        p.strong_sim = f("LIVE_DIAR_STRONG", p.strong_sim);
        p.switch_gap = f("LIVE_DIAR_GAP", p.switch_gap);
        p.new_max_sim = f("LIVE_DIAR_NEW_MAX", p.new_max_sim);
        p.self_sim = f("LIVE_DIAR_SELF", p.self_sim);
        p.confirm = u("LIVE_DIAR_CONFIRM", p.confirm).max(1);
        p.confirm_new = u("LIVE_DIAR_CONFIRM_NEW", p.confirm_new).max(2);
        p.update_min_sim = f("LIVE_DIAR_UPDATE_MIN", p.update_min_sim);
        p.change_sim = f("LIVE_DIAR_CHANGE", p.change_sim);        p
    }
}

/// One speaker's running centroid (L2-normalised mean of window embeddings).
#[derive(Debug, Clone)]
pub struct Centroid {
    mean: Vec<f32>,
    count: u32,
    unit: Vec<f32>,
}

/// Cap on how many windows a centroid "remembers"; beyond this the mean turns
/// into an exponential moving average so it can follow a voice that drifts
/// (mic distance, tiredness) instead of freezing on the first minute.
const CENTROID_MEMORY: f32 = 30.0;

impl Centroid {
    fn new(emb: &[f32]) -> Self {
        Self { mean: emb.to_vec(), count: 1, unit: emb.to_vec() }
    }
    fn add(&mut self, emb: &[f32]) {
        self.count += 1;
        let alpha = 1.0 / (self.count as f32).min(CENTROID_MEMORY);
        for (m, e) in self.mean.iter_mut().zip(emb) {
            *m += alpha * (e - *m);
        }
        self.unit = embedding::l2_normalize(&self.mean);
    }
    fn sim(&self, emb: &[f32]) -> f32 {
        cosine_similarity(&self.unit, emb)
    }
}

/// Speaker profiles for the current meeting, shared by every live stream
/// (mic + system audio) and cleared by `live_diarize::reset_session`.
pub type SharedProfiles = Arc<Mutex<Vec<Centroid>>>;

/// `sample -> speaker` map produced by the tracker, read by the STT worker.
#[derive(Debug, Clone)]
pub struct SpeakerTimeline {
    /// Confirmed turns: (first sample, speaker id), ascending.
    turns: Vec<(u64, i64)>,
    /// Assignments before this sample are final; after it, provisional.
    stable_until: u64,
}

impl Default for SpeakerTimeline {
    fn default() -> Self {
        Self { turns: vec![(0, 0)], stable_until: 0 }
    }
}

impl SpeakerTimeline {
    /// Speaker at stream sample `t` (provisional past `stable_until`).
    pub fn speaker_at(&self, t: u64) -> i64 {
        self.turns
            .iter()
            .rev()
            .find(|(start, _)| *start <= t)
            .map(|(_, id)| *id)
            .unwrap_or(0)
    }
    pub fn stable_until(&self) -> u64 {
        self.stable_until
    }
    /// Confirmed turns `(first sample, speaker id)`, ascending.
    pub fn turns(&self) -> &[(u64, i64)] {
        &self.turns
    }
}

pub fn speaker_label(id: i64) -> String {
    format!("Speaker {}", id + 1)
}

/// What one candidate window points at.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Candidate {
    Known(usize),
    New,
}

struct PendingWindow {
    start: u64,
    emb: Vec<f32>,
    cand: Candidate,
}

/// Pure decision logic (no threads, injectable embedder) — unit-testable.
pub struct TrackerCore<E: FnMut(&[f32]) -> Option<Vec<f32>>> {
    params: TrackerParams,
    embed: E,
    profiles: SharedProfiles,
    timeline: Arc<Mutex<SpeakerTimeline>>,
    /// Recent audio, ring-trimmed to one window + one hop.
    buf: Vec<f32>,
    /// Stream sample index of `buf[0]`.
    buf_start: u64,
    /// Stream sample index where the next window ends.
    next_window_end: u64,
    current: Option<usize>,
    pending: Vec<PendingWindow>,
    /// Last few window embeddings of the CURRENT turn. Within one turn the
    /// voice and channel are steady, so a drop against this local reference
    /// reveals a speaker change that the long-lived global centroid (which
    /// blurs over the whole meeting) misses.
    turn: std::collections::VecDeque<Vec<f32>>,
    /// Recent 20ms frame RMS values `(frame_start_sample, rms)` used to snap
    /// confirmed speaker transitions to the quietest pause between words/sentences.
    frame_rms: std::collections::VecDeque<(u64, f32)>,
    next_rms_sample: u64,
}

/// Windows kept in the turn-local reference.
const TURN_MEMORY: usize = 6;
/// Keep ~8s of 20ms frame RMS history for back-dating speaker switches to pauses.
const RMS_HISTORY_FRAMES: usize = 400;

fn mean_unit(embs: &std::collections::VecDeque<Vec<f32>>) -> Option<Vec<f32>> {
    let first = embs.front()?;
    let mut acc = vec![0f32; first.len()];
    for e in embs {
        for (a, x) in acc.iter_mut().zip(e) {
            *a += x;
        }
    }
    Some(embedding::l2_normalize(&acc))
}

impl<E: FnMut(&[f32]) -> Option<Vec<f32>>> TrackerCore<E> {
    pub fn new(params: TrackerParams, embed: E, profiles: SharedProfiles) -> Self {
        let next_window_end = params.window as u64;
        Self {
            params,
            embed,
            profiles,
            timeline: Arc::new(Mutex::new(SpeakerTimeline::default())),
            buf: Vec::new(),
            buf_start: 0,
            next_window_end,
            current: None,
            pending: Vec::new(),
            turn: std::collections::VecDeque::new(),
            frame_rms: std::collections::VecDeque::new(),
            next_rms_sample: 0,
        }
    }

    fn remember_in_turn(&mut self, emb: &[f32]) {
        self.turn.push_back(emb.to_vec());
        while self.turn.len() > TURN_MEMORY {
            self.turn.pop_front();
        }
    }

    pub fn timeline(&self) -> Arc<Mutex<SpeakerTimeline>> {
        Arc::clone(&self.timeline)
    }

    /// Feed audio; runs every window that became complete.
    pub fn push(&mut self, samples: &[f32]) {
        self.buf.extend_from_slice(samples);
        let buf_end = self.buf_start + self.buf.len() as u64;
        // Record 20ms (320-sample) frame RMS values for silence-valley snapping.
        while self.next_rms_sample + 320 <= buf_end {
            if self.next_rms_sample >= self.buf_start {
                let lo = (self.next_rms_sample - self.buf_start) as usize;
                let hi = lo + 320;
                if hi <= self.buf.len() {
                    let r = crate::diarize::rms(&self.buf[lo..hi]);
                    self.frame_rms.push_back((self.next_rms_sample, r));
                    while self.frame_rms.len() > RMS_HISTORY_FRAMES {
                        self.frame_rms.pop_front();
                    }
                }
            }
            self.next_rms_sample += 320;
        }
        while self.next_window_end <= buf_end {
            let end = self.next_window_end;
            let start = end - self.params.window as u64;
            let lo = (start - self.buf_start) as usize;
            let hi = (end - self.buf_start) as usize;
            let window = self.buf[lo..hi].to_vec();
            self.process_window(start, &window);
            self.next_window_end += self.params.hop as u64;
        }
        // Keep only what the next window still needs.
        let keep_from = self.next_window_end.saturating_sub(self.params.window as u64);
        if keep_from > self.buf_start {
            let drop = ((keep_from - self.buf_start) as usize).min(self.buf.len());
            self.buf.drain(..drop);
            self.buf_start += drop as u64;
        }
    }

    /// Find the quietest 60ms valley inside `[lo_sample, hi_sample]`. Falls
    /// back to `fallback` when energy is flat (e.g. synthetic constant-tone tests).
    fn quietest_sample_in_range(&self, lo_sample: u64, hi_sample: u64, fallback: u64) -> u64 {
        let in_range: Vec<(u64, f32)> = self
            .frame_rms
            .iter()
            .copied()
            .filter(|&(s, _)| s >= lo_sample && s <= hi_sample)
            .collect();
        if in_range.len() < 3 {
            return fallback;
        }
        let mean_rms: f32 = in_range.iter().map(|(_, r)| *r).sum::<f32>() / in_range.len() as f32;
        if mean_rms <= 1e-6 {
            return fallback;
        }
        let mut best_sample = fallback;
        let mut best_rms = f32::MAX;
        for w in in_range.windows(3) {
            let avg = (w[0].1 + w[1].1 + w[2].1) / 3.0;
            if avg < best_rms {
                best_rms = avg;
                best_sample = w[1].0 + 160;
            }
        }
        if best_rms < mean_rms * 0.85 {
            best_sample
        } else {
            fallback
        }
    }

    /// End of stream: whatever is pending stays provisional, but every sample
    /// fed so far is now as final as it will ever be.
    pub fn flush(&mut self) {
        let end = self.buf_start + self.buf.len() as u64;
        if let Ok(mut tl) = self.timeline.lock() {
            tl.stable_until = end;
        }
    }

    fn speech_ratio(window: &[f32]) -> f32 {
        let frames: Vec<&[f32]> = window.chunks(320).collect();
        if frames.is_empty() {
            return 0.0;
        }
        let voiced = frames.iter().filter(|f| crate::diarize::rms(f) > FINE_SILENCE_RMS).count();
        voiced as f32 / frames.len() as f32
    }

    /// How far a window "vouches" for its verdict: its centre. A change can
    /// hide in a window's second half (the voice that dominates the window
    /// is not the voice at its very end), so only the first half is safe.
    fn settle_point(&self, start: u64) -> u64 {
        start + self.params.window as u64 / 2
    }

    /// Advance `stable_until` past this window unless a switch is pending
    /// (its back-dated boundary may still land earlier).
    fn settle(&mut self, start: u64) {
        if self.pending.is_empty() {
            let p = self.settle_point(start);
            self.set_stable(p);
        }
    }

    fn process_window(&mut self, start: u64, window: &[f32]) {
        let is_speech = Self::speech_ratio(window) >= self.params.min_speech_ratio;
        let emb = if is_speech { (self.embed)(window) } else { None };
        let Some(emb) = emb else {
            // Silence/noise: nothing to learn. Decisions up to here stand.
            self.settle(start);
            return;
        };

        let mut profiles = match self.profiles.lock() {
            Ok(p) => p,
            Err(p) => p.into_inner(),
        };

        // First voice of the meeting.
        if profiles.is_empty() {
            drop(profiles);
            self.pending.push(PendingWindow { start, emb, cand: Candidate::New });
            self.try_confirm();
            return;
        }

        let sims: Vec<f32> = profiles.iter().map(|c| c.sim(&emb)).collect();
        let (best, best_sim) = sims
            .iter()
            .copied()
            .enumerate()
            .fold((0, f32::MIN), |acc, (i, s)| if s > acc.1 { (i, s) } else { acc });
        let cur_sim = self.current.map(|c| sims[c]).unwrap_or(f32::MIN);
        // Local evidence: does this window still sound like the current turn?
        let turn_sim = if self.turn.len() >= 2 {
            mean_unit(&self.turn).map(|t| cosine_similarity(&t, &emb))
        } else {
            None
        };
        let local_change = turn_sim.map(|s| s < self.params.change_sim).unwrap_or(false);

        let cand = if !local_change && Some(best) == self.current && best_sim >= self.params.match_sim {
            None // confirmed current speaker
        } else if !local_change && turn_sim.is_some() && self.current.is_some() && best_sim < self.params.match_sim {
            // Still sounds like this turn even though the global centroid is
            // unsure — keep the speaker (do not learn from it).
            drop(profiles);
            self.settle(start);
            return;
        } else if Some(best) != self.current
            && best_sim >= self.params.match_sim
            && best_sim - cur_sim >= self.params.switch_gap
        {
            Some(Candidate::Known(best))
        } else if best_sim < self.params.new_max_sim
            || (local_change && best_sim < self.params.match_sim)
        {
            // Unlike everyone, or clearly not the current turn's voice and
            // not matching any known speaker → maybe a new person (confirmed
            // over `confirm_new` windows + coherence + average check).
            Some(Candidate::New)
        } else {
            // Ambiguous: not clearly anyone. Skip it — neither evidence for
            // the current speaker nor against a pending switch. (Clearing the
            // pending run here meant a new voice, whose noisy windows
            // alternate "new"/"ambiguous", could never collect enough
            // consecutive windows: ~20 switches found in a 28-min, 8-speaker
            // recording.)
            drop(profiles);
            self.settle(start);
            return;
        };

        match cand {
            None => {
                if let Some(c) = self.current {
                    if best_sim >= self.params.update_min_sim {
                        profiles[c].add(&emb);
                    }
                }
                drop(profiles);
                self.remember_in_turn(&emb);
                self.pending.clear();
                self.settle(start);
            }
            Some(cand) => {
                drop(profiles);
                // A run of candidates must agree with each other.
                if let Some(first) = self.pending.first() {
                    let agrees = match (first.cand, cand) {
                        (Candidate::Known(a), Candidate::Known(b)) => a == b,
                        (Candidate::New, Candidate::New) => true,
                        _ => false,
                    };
                    if !agrees {
                        self.pending.clear();
                    }
                }
                let strong = matches!(cand, Candidate::Known(_)) && best_sim >= self.params.strong_sim;
                self.pending.push(PendingWindow { start, emb, cand });
                let needed = match cand {
                    Candidate::Known(_) => self.params.confirm,
                    Candidate::New => self.params.confirm_new,
                };
                if strong || self.pending.len() >= needed {
                    self.try_confirm();
                }
            }
        }
    }

    /// Commit the pending candidate run if it holds up.
    fn try_confirm(&mut self) {
        let Some(first) = self.pending.first() else { return };
        let first_start = first.start;
        let cand = first.cand;

        let mut profiles = match self.profiles.lock() {
            Ok(p) => p,
            Err(p) => p.into_inner(),
        };

        let id = match cand {
            Candidate::Known(i) => {
                for w in &self.pending {
                    profiles[i].add(&w.emb);
                }
                i
            }
            Candidate::New => {
                let first_ever = profiles.is_empty();
                // Need a second window to judge self-similarity — except for
                // the very first voice, where there is nobody to confuse it with.
                if self.pending.len() < 2 && !first_ever {
                    return;
                }
                let coherent = self.pending.windows(2).all(|p| {
                    cosine_similarity(&p[0].emb, &p[1].emb) >= self.params.self_sim
                });
                if !coherent {
                    // Erratic windows (noise, crosstalk) — not a person. Drop
                    // the oldest and keep watching.
                    self.pending.remove(0);
                    return;
                }
                // Judge the run by its AVERAGE: single windows are noisy, so a
                // known voice can look "new" window by window while their mean
                // clearly matches. Then it is that speaker, not a new one.
                let mut mean = Centroid::new(&self.pending[0].emb);
                for w in &self.pending[1..] {
                    mean.add(&w.emb);
                }
                let closest = profiles
                    .iter()
                    .enumerate()
                    .map(|(i, c)| (i, c.sim(&mean.unit)))
                    .fold((usize::MAX, f32::MIN), |a, b| if b.1 > a.1 { b } else { a });
                if closest.0 != usize::MAX && closest.1 >= self.params.match_sim {
                    let i = closest.0;
                    for w in &self.pending {
                        profiles[i].add(&w.emb);
                    }
                    drop(profiles);
                    let target = i;
                    return self.commit(target, first_start);
                }
                // No speaker cap: the model decides how many people there are
                // (a cap folded every extra person onto the last id).
                let mut c = Centroid::new(&self.pending[0].emb);
                for w in &self.pending[1..] {
                    c.add(&w.emb);
                }
                profiles.push(c);
                log::info!("[speaker-tracker] new speaker {}", profiles.len());
                profiles.len() - 1
            }
        };
        drop(profiles);
        self.commit(id, first_start);
    }

    /// Make `id` the current speaker from the pending run onwards.
    fn commit(&mut self, id: usize, first_start: u64) {
        let first_speaker = self.current.is_none();
        let changed = self.current != Some(id);
        self.current = Some(id);
        let last_start = self.pending.last().map(|w| w.start).unwrap_or(first_start);
        if changed {
            // New turn: its local reference starts from the confirming windows.
            self.turn.clear();
        }
        let confirming: Vec<Vec<f32>> = self.pending.iter().map(|w| w.emb.clone()).collect();
        for e in &confirming {
            self.remember_in_turn(e);
        }
        self.pending.clear();
        let settled = self.settle_point(last_start);

        if let Ok(mut tl) = self.timeline.lock() {
            if first_speaker {
                // Everything before the first identified voice belongs to it.
                tl.turns = vec![(0, id as i64)];
            } else if changed {
                // Window [s, s+W) is the first the new voice dominated and the
                // previous window [s-H, s-H+W) was still the old voice, so the
                // change lies in [s, s + W - H]: snap to the quietest 60ms
                // silence valley in that span (or fall back to the midpoint) so
                // the speaker boundary lands naturally between sentences/words.
                let span = (self.params.window.saturating_sub(self.params.hop)) as u64;
                let midpoint = first_start + span / 2;
                let valley = self.quietest_sample_in_range(first_start, first_start + span, midpoint);
                let at = valley.max(tl.stable_until);
                tl.turns.retain(|(s, _)| *s < at);
                tl.turns.push((at, id as i64));
            }
            tl.stable_until = tl.stable_until.max(settled);
        }
    }

    fn set_stable(&mut self, upto: u64) {
        if let Ok(mut tl) = self.timeline.lock() {
            // Never move backwards: earlier commitments were already emitted.
            tl.stable_until = tl.stable_until.max(upto);
        }
    }
}

/// Thread wrapper: owns a [`TrackerCore`] on a dedicated OS thread (ONNX
/// inference must not run on the async runtime) and exposes the timeline.
pub struct SpeakerTracker {
    tx: std::sync::mpsc::Sender<Option<Vec<f32>>>,
    timeline: Arc<Mutex<SpeakerTimeline>>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl SpeakerTracker {
    /// Start a tracker for one stream. `None` when no speaker model exists —
    /// the caller then labels everything "Speaker 1".
    pub fn start(profiles: SharedProfiles) -> Option<Self> {
        let model = crate::diarize::embedding::resolve_live_model_path()?;
        let params = TrackerParams::from_env();
        let core = TrackerCore::new(
            params,
            move |w: &[f32]| embedding::embed_samples(&model, w, crate::diarize::NUM_THREADS),
            profiles,
        );
        let timeline = core.timeline();
        let (tx, rx) = std::sync::mpsc::channel::<Option<Vec<f32>>>();
        let join = std::thread::Builder::new()
            .name("speaker-tracker".to_string())
            .spawn(move || {
                let mut core = core;
                let mut stopping = false;
                while !stopping {
                    let Ok(Some(mut chunk)) = rx.recv() else { break };
                    // Coalesce a backlog so a slow embed never snowballs —
                    // but never swallow the stop sentinel while doing so
                    // (that deadlocked `finish`, which joins this thread).
                    loop {
                        match rx.try_recv() {
                            Ok(Some(more)) => chunk.extend_from_slice(&more),
                            Ok(None) => {
                                stopping = true;
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    core.push(&chunk);
                }
                core.flush();
            })
            .ok()?;
        Some(Self { tx, timeline, join: Some(join) })
    }

    pub fn feed(&self, samples: Vec<f32>) {
        let _ = self.tx.send(Some(samples));
    }

    pub fn timeline(&self) -> Arc<Mutex<SpeakerTimeline>> {
        Arc::clone(&self.timeline)
    }

    /// Stop after processing everything fed so far.
    pub fn finish(mut self) {
        let _ = self.tx.send(None);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for SpeakerTracker {
    fn drop(&mut self) {
        let _ = self.tx.send(None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fake embedder: the window's mean amplitude picks a fixed "voice".
    /// Voice A ≈ 0.2 amplitude, B ≈ 0.5, C ≈ 0.8 — orthogonal unit vectors.
    fn fake_embed(w: &[f32]) -> Option<Vec<f32>> {
        let m = w.iter().map(|x| x.abs()).sum::<f32>() / w.len() as f32;
        let v = if m < 0.35 { vec![1.0, 0.0, 0.0] } else if m < 0.65 { vec![0.0, 1.0, 0.0] } else { vec![0.0, 0.0, 1.0] };
        Some(v)
    }

    fn voice(amp: f32, secs: f32) -> Vec<f32> {
        vec![amp; (secs * SR as f32) as usize]
    }

    fn run(segments: &[(f32, f32)]) -> (SpeakerTimeline, usize) {
        let profiles: SharedProfiles = Arc::new(Mutex::new(Vec::new()));
        let mut core = TrackerCore::new(TrackerParams::default(), fake_embed, Arc::clone(&profiles));
        for &(amp, secs) in segments {
            for chunk in voice(amp, secs).chunks(1600) {
                core.push(chunk);
            }
        }
        core.flush();
        let tl = core.timeline().lock().unwrap().clone();
        let n = profiles.lock().unwrap().len();
        (tl, n)
    }

    #[test]
    fn two_speakers_back_to_back_switch_inside_one_utterance() {
        // A talks 4s, B answers 4s with NO pause — the per-utterance diarizer
        // could never split this.
        let (tl, n) = run(&[(0.2, 4.0), (0.5, 4.0)]);
        assert_eq!(n, 2);
        assert_eq!(tl.speaker_at(SR), 0);
        assert_eq!(tl.speaker_at(7 * SR), 1);
        // Boundary lands within ±1s of the real change at 4.0s.
        let change = tl.turns.iter().find(|(_, id)| *id == 1).unwrap().0;
        assert!((change as i64 - 4 * SR as i64).abs() <= SR as i64, "change at {change}");
    }

    #[test]
    fn returning_speaker_reuses_their_id() {
        let (tl, n) = run(&[(0.2, 3.0), (0.5, 3.0), (0.2, 3.0)]);
        assert_eq!(n, 2, "A must be recognised again, not enrolled twice");
        assert_eq!(tl.speaker_at((8.5 * SR as f32) as u64), 0);
    }

    #[test]
    fn single_noisy_window_does_not_switch() {
        // 0.3s burst of another "voice" inside A's speech: shorter than the
        // confirmation run, so no phantom speaker.
        let (tl, n) = run(&[(0.2, 3.0), (0.8, 0.3), (0.2, 3.0)]);
        assert_eq!(n, 1);
        assert!(tl.turns.iter().all(|(_, id)| *id == 0));
    }

    #[test]
    fn silence_produces_no_speaker() {
        let (_, n) = run(&[(0.0, 5.0)]);
        assert_eq!(n, 0);
    }

    #[test]
    fn stable_until_never_passes_pending_candidate() {
        let profiles: SharedProfiles = Arc::new(Mutex::new(Vec::new()));
        let mut core = TrackerCore::new(TrackerParams::default(), fake_embed, profiles);
        for c in voice(0.2, 3.0).chunks(1600) {
            core.push(c);
        }
        // One window of B: candidate pending, not yet confirmed.
        for c in voice(0.5, 1.0).chunks(1600) {
            core.push(c);
        }
        let tl = core.timeline().lock().unwrap().clone();
        assert!(tl.stable_until() <= 3 * SR + SR, "stable_until {} ran past the pending switch", tl.stable_until());
    }
}
