//! `split_audio_into_chunks` from `mlx_audio/stt/models/qwen3_asr/qwen3_asr.py`:
//! audio longer than `chunk_duration` is cut at the lowest-energy 100 ms window
//! within ±5 s of each nominal cut, no overlap. NOTE: like the reference, a
//! chunk may therefore run up to `chunk_duration + 5 s`.

use super::mel::SAMPLE_RATE;

pub const CHUNK_SEC: f64 = 30.0;
pub const MIN_CHUNK_SEC: f64 = 1.0;
const SEARCH_EXPAND_SEC: f64 = 5.0;
const MIN_WINDOW_MS: f64 = 100.0;

/// Zero-pad `chunk` to at least `min_len` samples.
fn pad_min(mut chunk: Vec<f32>, min_len: usize) -> Vec<f32> {
    if chunk.len() < min_len {
        chunk.resize(min_len, 0.0);
    }
    chunk
}

/// Index of the minimum of the moving average of `x²` over `win` samples
/// (`np.argmin(np.convolve(x**2, ones(win)/win, "valid"))`, first minimum).
/// Zero-energy windows are tracked exactly (non-zero counter) so silent runs tie
/// like numpy's exact zeros instead of drifting with running-sum noise.
fn argmin_window_energy(x: &[f32], win: usize) -> usize {
    let sq: Vec<f64> = x.iter().map(|&v| (v * v) as f64).collect();
    let n_out = sq.len() - win + 1;
    let mut sum: f64 = sq[..win].iter().sum();
    let mut nonzero = sq[..win].iter().filter(|&&v| v != 0.0).count();
    let (mut best, mut best_val) = (0usize, if nonzero == 0 { 0.0 } else { sum });
    for i in 1..n_out {
        let (out, inc) = (sq[i - 1], sq[i + win - 1]);
        sum += inc - out;
        nonzero = nonzero + usize::from(inc != 0.0) - usize::from(out != 0.0);
        let val = if nonzero == 0 { 0.0 } else { sum.max(0.0) };
        if val < best_val {
            best = i;
            best_val = val;
        }
    }
    best
}

/// Split into `(chunk, offset_seconds)` pairs.
pub fn split_audio_into_chunks(wav: &[f32], chunk_sec: f64, min_chunk_sec: f64) -> Vec<(Vec<f32>, f64)> {
    let sr = SAMPLE_RATE;
    let total = wav.len();
    let min_len = (min_chunk_sec * sr as f64) as usize;
    if total as f64 / sr as f64 <= chunk_sec {
        return vec![(pad_min(wav.to_vec(), min_len), 0.0)];
    }
    let max_chunk = (chunk_sec * sr as f64) as usize;
    let search = (SEARCH_EXPAND_SEC * sr as f64) as usize;
    let min_window = (MIN_WINDOW_MS * sr as f64 / 1000.0) as usize;

    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < total {
        let end = (start + max_chunk).min(total);
        if end >= total {
            chunks.push((pad_min(wav[start..].to_vec(), min_len), start as f64 / sr as f64));
            break;
        }
        let s0 = start.max(end.saturating_sub(search));
        let s1 = total.min(end + search);
        let region = &wav[s0..s1];
        let cut = if region.len() > min_window {
            s0 + argmin_window_energy(region, min_window) + min_window / 2
        } else {
            end
        };
        let cut = cut.max(start + sr); // always advance at least 1 s
        chunks.push((pad_min(wav[start..cut].to_vec(), min_len), start as f64 / sr as f64));
        start = cut;
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_audio_is_one_padded_chunk() {
        let c = split_audio_into_chunks(&vec![0.1; 8000], CHUNK_SEC, MIN_CHUNK_SEC);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].0.len(), SAMPLE_RATE);
    }

    #[test]
    fn long_audio_cuts_in_the_quiet_gap() {
        // 70 s of tone with a 0.5 s silence at 31 s: the first cut must land in it.
        let mut wav: Vec<f32> = (0..70 * SAMPLE_RATE).map(|i| 0.3 * ((i as f32) * 0.05).sin()).collect();
        wav[31 * SAMPLE_RATE..31 * SAMPLE_RATE + 8000].fill(0.0);
        let c = split_audio_into_chunks(&wav, CHUNK_SEC, MIN_CHUNK_SEC);
        assert!(c.len() >= 3);
        let cut = c[1].1 * SAMPLE_RATE as f64;
        assert!((31.0 * SAMPLE_RATE as f64..31.5 * SAMPLE_RATE as f64).contains(&cut), "cut at {cut}");
        assert_eq!(c.iter().map(|(w, _)| w.len()).sum::<usize>(), wav.len());
    }
}
