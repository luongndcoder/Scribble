//! Whisper log-mel frontend (`transformers.WhisperFeatureExtractor`, as used
//! by Qwen3-ASR): 16 kHz, n_fft 400, hop 160, 128 Slaney mels, periodic Hann,
//! centre-reflect STFT, last frame dropped, `log10`, floor at `max-8`,
//! `(x+4)/4`. Called with `padding=True, truncation=False`, so the audio is
//! NOT padded to 30 s: the output has exactly `len/160` frames.

use mlx_rs::error::Result;
use mlx_rs::{Array, Dtype};

pub const SAMPLE_RATE: usize = 16_000;
const N_FFT: usize = 400;
const HOP: usize = 160;
const MEL_FLOOR: f32 = 1e-10;

/// Periodic Hann window (`np.hanning(N+1)[:-1]`).
fn hann_periodic() -> Vec<f32> {
    (0..N_FFT)
        .map(|n| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / N_FFT as f64).cos()) as f32)
        .collect()
}

/// Slaney-scale, Slaney-normalised filterbank, row-major `(n_freqs, n_mels)`
/// — HF `mel_filter_bank(norm="slaney", mel_scale="slaney")`.
fn mel_filters(n_mels: usize) -> Vec<f32> {
    let n_freqs = N_FFT / 2 + 1;
    let sr = SAMPLE_RATE as f64;
    let (f_sp, min_log_hz) = (200.0 / 3.0, 1000.0f64);
    let min_log_mel = min_log_hz / f_sp;
    let logstep = 6.4f64.ln() / 27.0;
    let hz_to_mel = |f: f64| if f >= min_log_hz { min_log_mel + (f / min_log_hz).ln() / logstep } else { f / f_sp };
    let mel_to_hz = |m: f64| if m >= min_log_mel { min_log_hz * (logstep * (m - min_log_mel)).exp() } else { f_sp * m };

    let (m_min, m_max) = (hz_to_mel(0.0), hz_to_mel(sr / 2.0));
    let f_pts: Vec<f64> = (0..n_mels + 2)
        .map(|i| mel_to_hz(m_min + (m_max - m_min) * i as f64 / (n_mels + 1) as f64))
        .collect();
    let mut fb = vec![0f32; n_freqs * n_mels];
    for m in 0..n_mels {
        let enorm = 2.0 / (f_pts[m + 2] - f_pts[m]);
        for k in 0..n_freqs {
            let f = k as f64 * (sr / 2.0) / (n_freqs - 1) as f64;
            let down = (f - f_pts[m]) / (f_pts[m + 1] - f_pts[m]);
            let up = (f_pts[m + 2] - f) / (f_pts[m + 2] - f_pts[m + 1]);
            fb[k * n_mels + m] = (down.min(up).max(0.0) * enorm) as f32;
        }
    }
    fb
}

pub struct LogMel {
    window: Array,  // (N_FFT,)
    filters: Array, // (n_freqs, n_mels)
    n_mels: usize,
}

impl LogMel {
    pub fn new(n_mels: usize) -> Self {
        Self {
            window: Array::from_slice(&hann_periodic(), &[N_FFT as i32]),
            filters: Array::from_slice(&mel_filters(n_mels), &[(N_FFT / 2 + 1) as i32, n_mels as i32]),
            n_mels,
        }
    }

    /// `(n_mels, T)` float32 features with `T = len / 160`.
    pub fn compute(&self, pcm: &[f32]) -> Result<Array> {
        let n_frames = pcm.len() / HOP;
        if n_frames == 0 {
            return Err(mlx_rs::error::Exception::custom("audio shorter than one mel frame"));
        }
        // Centre padding: reflect `N_FFT/2` samples on both sides.
        let half = N_FFT / 2;
        let len = pcm.len();
        let reflect = |i: isize| -> f32 {
            let mut j = i;
            if j < 0 {
                j = -j;
            }
            if j >= len as isize {
                j = 2 * (len as isize - 1) - j;
            }
            pcm[j.clamp(0, len as isize - 1) as usize]
        };
        let mut framed = Vec::with_capacity(n_frames * N_FFT);
        for t in 0..n_frames {
            let start = (t * HOP) as isize - half as isize;
            framed.extend((0..N_FFT as isize).map(|k| reflect(start + k)));
        }
        let frames = Array::from_slice(&framed, &[n_frames as i32, N_FFT as i32]);
        let spec = mlx_rs::fft::rfft(&frames.multiply(&self.window)?, N_FFT as i32, -1)?;
        let power = mlx_rs::ops::abs(&spec)?.square()?; // (T, 201)
        let mel = power.matmul(&self.filters)?; // (T, n_mels)
        let floor = Array::from_f32(MEL_FLOOR);
        let log = mlx_rs::ops::maximum(&mel, &floor)?.log10()?;
        let lo = log.max(None)?.subtract(Array::from_f32(8.0))?;
        let norm = mlx_rs::ops::maximum(&log, &lo)?
            .add(Array::from_f32(4.0))?
            .divide(Array::from_f32(4.0))?;
        debug_assert_eq!(norm.dtype(), Dtype::Float32);
        norm.transpose_axes(&[1, 0]) // (n_mels, T)
    }

    pub fn n_mels(&self) -> usize {
        self.n_mels
    }
}
