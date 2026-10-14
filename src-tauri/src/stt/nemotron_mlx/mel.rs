//! Streaming log-mel frontend for Nemotron (NeMo `AudioToMelSpectrogramPreprocessor`).
//!
//! Port of `mlx_audio/stt/models/nemotron_asr/audio.py` (MIT) —
//! `StreamingLogMelSpectrogram` + `log_mel_spectrogram_frames`:
//! preemphasis 0.97, symmetric Hann(400) centred in n_fft 512, reflect padding
//! at the stream start, power spectrum, Slaney mel filterbank (128 bins),
//! `log(x + 2^-24)`, no normalisation (`normalize: NA`), no dither.
//!
//! Frames are emitted only once their full centred window is available, so
//! concatenating every output equals the offline spectrogram of the whole
//! stream (same contract as the reference implementation).

use mlx_rs::Array;

pub const SAMPLE_RATE: usize = 16_000;
pub const N_FFT: usize = 512;
pub const WIN: usize = 400;
pub const HOP: usize = 160;
pub const N_MELS: usize = 128;
const PREEMPH: f32 = 0.97;
const LOG_GUARD: f32 = 5.960_464_5e-8; // 2^-24

/// Symmetric Hann window of `WIN` samples, zero-padded (centred) to `N_FFT`.
fn padded_window() -> Vec<f32> {
    let mut w = vec![0f32; N_FFT];
    let left = (N_FFT - WIN) / 2;
    for n in 0..WIN {
        w[left + n] =
            (0.5 * (1.0 - (2.0 * std::f64::consts::PI * n as f64 / (WIN - 1) as f64).cos())) as f32;
    }
    w
}

/// Slaney-scale, Slaney-normalised triangular filterbank, row-major
/// `(N_MELS, N_FFT/2+1)` — same formula as `mlx_audio.dsp.mel_filters`.
fn mel_filters() -> Vec<f32> {
    let sr = SAMPLE_RATE as f64;
    let n_freqs = N_FFT / 2 + 1;
    let (f_sp, min_log_hz) = (200.0 / 3.0, 1000.0f64);
    let min_log_mel = min_log_hz / f_sp;
    let logstep = (6.4f64).ln() / 27.0;
    let hz_to_mel = |f: f64| if f >= min_log_hz { min_log_mel + (f / min_log_hz).ln() / logstep } else { f / f_sp };
    let mel_to_hz = |m: f64| if m >= min_log_mel { min_log_hz * (logstep * (m - min_log_mel)).exp() } else { f_sp * m };

    let all_freqs: Vec<f64> = (0..n_freqs).map(|i| i as f64 * (sr / 2.0) / (n_freqs - 1) as f64).collect();
    let (m_min, m_max) = (hz_to_mel(0.0), hz_to_mel(sr / 2.0));
    let f_pts: Vec<f64> = (0..N_MELS + 2)
        .map(|i| mel_to_hz(m_min + (m_max - m_min) * i as f64 / (N_MELS + 1) as f64))
        .collect();
    let mut fb = vec![0f32; N_MELS * n_freqs];
    for m in 0..N_MELS {
        let enorm = 2.0 / (f_pts[m + 2] - f_pts[m]);
        for (k, &f) in all_freqs.iter().enumerate() {
            let down = (f - f_pts[m]) / (f_pts[m + 1] - f_pts[m]);
            let up = (f_pts[m + 2] - f) / (f_pts[m + 2] - f_pts[m + 1]);
            fb[m * n_freqs + k] = (down.min(up).max(0.0) * enorm) as f32;
        }
    }
    fb
}

/// Incremental centred log-mel frontend with bounded sample state.
pub struct StreamingLogMel {
    window: Array,  // (N_FFT,)
    filters: Array, // (N_MELS, N_FFT/2+1)
    /// Raw (not pre-emphasised) samples from `buffer_start` on.
    samples: Vec<f32>,
    buffer_start: usize,
    total: usize,
    next_frame: usize,
    lookbehind_frames: usize,
}

impl Default for StreamingLogMel {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamingLogMel {
    pub fn new() -> Self {
        Self {
            window: Array::from_slice(&padded_window(), &[N_FFT as i32]),
            filters: Array::from_slice(&mel_filters(), &[N_MELS as i32, (N_FFT / 2 + 1) as i32]),
            samples: Vec::new(),
            buffer_start: 0,
            total: 0,
            next_frame: 0,
            lookbehind_frames: (N_FFT / 2 + 1).div_ceil(HOP),
        }
    }

    /// Append mono 16 kHz PCM; return newly available `(1, T, 128)` frames
    /// (None when no new frame is complete). `final` emits the tail.
    pub fn push(&mut self, pcm: &[f32], final_: bool) -> mlx_rs::error::Result<Option<Array>> {
        self.samples.extend_from_slice(pcm);
        self.total += pcm.len();
        let lookahead = N_FFT / 2;
        let mut frame_end = if self.total >= lookahead { (self.total - lookahead) / HOP + 1 } else { 0 };
        if final_ {
            frame_end = self.total / HOP + 1;
        }
        if frame_end <= self.next_frame {
            return Ok(None);
        }
        let out = self.frames(self.next_frame, frame_end)?;
        self.next_frame = frame_end;

        // Keep only what the next centred window (+ preemphasis sample) needs.
        let keep_frame = self.next_frame.saturating_sub(self.lookbehind_frames);
        let keep_sample = keep_frame * HOP;
        if keep_sample > self.buffer_start {
            let trim = (keep_sample - self.buffer_start).min(self.samples.len());
            self.samples.drain(..trim);
            self.buffer_start += trim;
        }
        Ok(Some(out))
    }

    /// Log-mel for absolute frames `[start, end)` from the retained buffer.
    fn frames(&self, start: usize, end: usize) -> mlx_rs::error::Result<Array> {
        let n = end - start;
        let half = (N_FFT / 2) as i64;
        let seg_start = start as i64 * HOP as i64 - half; // absolute sample index
        let len = (n - 1) * HOP + N_FFT;
        let total = self.total as i64;
        // Absolute sample (with preemphasis applied against the previous one).
        let pre = |abs: i64| -> f32 {
            let x = |i: i64| self.samples[(i - self.buffer_start as i64) as usize];
            if abs == 0 { x(0) } else { x(abs) - PREEMPH * x(abs - 1) }
        };
        let mut seg = Vec::with_capacity(len);
        for j in 0..len as i64 {
            let mut abs = seg_start + j;
            // Reflect padding around the stream edges (centred STFT).
            if abs < 0 {
                abs = -abs;
            }
            if abs >= total {
                let r = 2 * (total - 1) - abs;
                if r < 0 || r < self.buffer_start as i64 {
                    seg.push(0.0);
                    continue;
                }
                abs = r;
            }
            seg.push(pre(abs));
        }
        let mut framed = Vec::with_capacity(n * N_FFT);
        for f in 0..n {
            framed.extend_from_slice(&seg[f * HOP..f * HOP + N_FFT]);
        }
        let frames = Array::from_slice(&framed, &[n as i32, N_FFT as i32]);
        let spec = mlx_rs::fft::rfft(&frames.multiply(&self.window)?, N_FFT as i32, -1)?;
        let power = mlx_rs::ops::abs(&spec)?.square()?; // (n, 257)
        let mel = self.filters.matmul(&power.transpose_axes(&[1, 0])?)?; // (128, n)
        let logmel = mlx_rs::ops::log(&mel.add(mlx_rs::array!(LOG_GUARD))?)?;
        logmel.transpose_axes(&[1, 0])?.expand_dims(0)
    }
}
