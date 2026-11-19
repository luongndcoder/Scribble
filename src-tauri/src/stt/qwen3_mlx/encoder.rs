//! Qwen3-ASR audio encoder: Conv2d ×3 stride-2 front end, 24 transformer
//! layers with block attention, projector to the LLM width.
//!
//! Port of `AudioEncoder` in `mlx_audio/stt/models/qwen3_asr/qwen3_asr.py`.
//! Activations run in float32 exactly like the reference (float32 features
//! meet bf16 weights, MLX promotes to float32); the weights are cast to
//! float32 ONCE at load, which is numerically identical but avoids a per-matmul
//! cast of every weight matrix.

use mlx_rs::error::Result;
use mlx_rs::ops::{self, indexing::IndexOp};
use mlx_rs::{fast, Array, Dtype};

use super::config::AudioConfig;
use super::weights::{gelu, LayerNorm, Linear, Weights};

const F32: Dtype = Dtype::Float32;

struct Conv2d {
    w: Array,
    b: Array,
}

impl Conv2d {
    fn load(w: &Weights, p: &str) -> Result<Self> {
        Ok(Self { w: w.get_as(&format!("{p}.weight"), F32)?, b: w.get_as(&format!("{p}.bias"), F32)? })
    }

    fn forward(&self, x: &Array) -> Result<Array> {
        ops::conv2d(x, &self.w, (2, 2), (1, 1), (1, 1), 1)?.add(&self.b)
    }
}

struct Layer {
    ln1: LayerNorm,
    q: Linear,
    k: Linear,
    v: Linear,
    out: Linear,
    ln2: LayerNorm,
    fc1: Linear,
    fc2: Linear,
}

impl Layer {
    fn load(w: &Weights, i: usize) -> Result<Self> {
        let p = format!("audio_tower.layers.{i}");
        let lin = |n: &str| Linear::load(w, &format!("{p}.{n}"), F32);
        Ok(Self {
            ln1: LayerNorm::load(w, &format!("{p}.self_attn_layer_norm"), F32)?,
            q: lin("self_attn.q_proj")?,
            k: lin("self_attn.k_proj")?,
            v: lin("self_attn.v_proj")?,
            out: lin("self_attn.out_proj")?,
            ln2: LayerNorm::load(w, &format!("{p}.final_layer_norm"), F32)?,
            fc1: lin("fc1")?,
            fc2: lin("fc2")?,
        })
    }

    fn forward(&self, x: &Array, mask: &Array, heads: i32) -> Result<Array> {
        let h = self.ln1.forward(x)?;
        let (b, s, d) = (h.dim(0), h.dim(1), h.dim(2));
        let hd = d / heads;
        let scale = Array::from_f32((hd as f32).powf(-0.5));
        let split = |t: Array| t.reshape(&[b, s, heads, hd])?.transpose_axes(&[0, 2, 1, 3]);
        let q = split(self.q.forward(&h)?.multiply(&scale)?)?;
        let k = split(self.k.forward(&h)?)?;
        let v = split(self.v.forward(&h)?)?;
        let a = fast::scaled_dot_product_attention(&q, &k, &v, 1.0, mask, None)?;
        let a = a.transpose_axes(&[0, 2, 1, 3])?.reshape(&[b, s, d])?;
        let x = x.add(self.out.forward(&a)?)?;
        let f = self.fc2.forward(&gelu(&self.fc1.forward(&self.ln2.forward(&x)?)?)?)?;
        x.add(f)
    }
}

pub struct AudioEncoder {
    cfg: AudioConfig,
    convs: [Conv2d; 3],
    conv_out: Linear,
    pos_emb: Array, // (max_source_positions, d_model)
    layers: Vec<Layer>,
    ln_post: LayerNorm,
    proj1: Linear,
    proj2: Linear,
}

/// `_get_feat_extract_output_lengths`: frames after the three stride-2 convs.
pub fn conv_output_len(n: i64) -> i64 {
    let leave = n.rem_euclid(100);
    let feat = (leave - 1).div_euclid(2) + 1;
    ((feat - 1).div_euclid(2) + 1 - 1).div_euclid(2) + 1 + (n / 100) * 13
}

fn sinusoidal_positions(length: usize, channels: usize) -> Array {
    let half = channels / 2;
    let inc = (10_000f32).ln() / (half as f32 - 1.0);
    let inv: Vec<f32> = (0..half).map(|i| (-inc * i as f32).exp()).collect();
    let mut table = vec![0f32; length * channels];
    for p in 0..length {
        for (i, &f) in inv.iter().enumerate() {
            let a = p as f32 * f;
            table[p * channels + i] = a.sin();
            table[p * channels + half + i] = a.cos();
        }
    }
    Array::from_slice(&table, &[length as i32, channels as i32])
}

impl AudioEncoder {
    pub fn load(w: &Weights, cfg: &AudioConfig) -> Result<Self> {
        let conv = |n: &str| Conv2d::load(w, &format!("audio_tower.{n}"));
        Ok(Self {
            cfg: cfg.clone(),
            convs: [conv("conv2d1")?, conv("conv2d2")?, conv("conv2d3")?],
            conv_out: Linear::load(w, "audio_tower.conv_out", F32)?,
            pos_emb: sinusoidal_positions(cfg.max_source_positions, cfg.d_model as usize),
            layers: (0..cfg.layers).map(|i| Layer::load(w, i)).collect::<Result<_>>()?,
            ln_post: LayerNorm::load(w, "audio_tower.ln_post", F32)?,
            proj1: Linear::load(w, "audio_tower.proj1", F32)?,
            proj2: Linear::load(w, "audio_tower.proj2", F32)?,
        })
    }

    /// `(n_mels, T)` features → `(S, output_dim)` float32 audio embeddings,
    /// `S = conv_output_len(T)`.
    pub fn forward(&self, feats: &Array) -> Result<Array> {
        let t_total = feats.dim(1) as i64;
        let chunk = (self.cfg.n_window * 2) as i64;
        // 100-frame chunks, the last one holds the remainder; zero-pad to equal width.
        let n_chunks = (t_total + chunk - 1) / chunk;
        let lens: Vec<i64> = (0..n_chunks)
            .map(|j| if j == n_chunks - 1 && t_total % chunk != 0 { t_total % chunk } else { chunk })
            .collect();
        let max_len = *lens.iter().max().unwrap_or(&chunk);
        let mut parts = Vec::with_capacity(lens.len());
        let mut pos = 0i64;
        for &l in &lens {
            let c = feats.index((.., pos as i32..(pos + l) as i32));
            parts.push(if l < max_len { ops::pad(&c, &[(0, 0), (0, (max_len - l) as i32)], None, None)? } else { c });
            pos += l;
        }
        let refs: Vec<&Array> = parts.iter().collect();
        let mut x = ops::stack(&refs, 0)?.expand_dims(-1)?; // (N, mel, T, 1)
        for c in &self.convs {
            x = gelu(&c.forward(&x)?)?;
        }
        let (n, f, t, c) = (x.dim(0), x.dim(1), x.dim(2), x.dim(3));
        x = x.transpose_axes(&[0, 2, 3, 1])?.reshape(&[n, t, c * f])?;
        x = self.conv_out.forward(&x)?;
        x = x.add(self.pos_emb.index((..t, ..)).expand_dims(0)?)?;

        // Keep only the valid (un-padded) frames of every chunk.
        let valid: Vec<i64> = lens.iter().map(|&l| conv_output_len(l)).collect();
        let rows: Vec<Array> = valid.iter().enumerate().map(|(i, &v)| x.index((i as i32, ..v as i32, ..))).collect();
        let refs: Vec<&Array> = rows.iter().collect();
        let hidden = ops::concatenate(&refs, 0)?;
        let seq = hidden.dim(0);

        // Block-diagonal attention: windows of `max_valid * (n_window_infer / chunk)` frames.
        let max_valid = *valid.iter().max().unwrap_or(&0);
        let window = max_valid * (self.cfg.n_window_infer as i64 / chunk);
        let total = conv_output_len(t_total);
        let mut bounds = vec![0i64];
        for _ in 0..(total / window.max(1)) {
            bounds.push(bounds.last().unwrap() + window);
        }
        if window > 0 && total % window != 0 {
            bounds.push(bounds.last().unwrap() + total % window);
        }
        let mut mask = vec![-1e9f32; (seq * seq) as usize];
        for w in bounds.windows(2) {
            for r in w[0]..w[1] {
                mask[(r * seq as i64 + w[0]) as usize..(r * seq as i64 + w[1]) as usize].fill(0.0);
            }
        }
        let mask = Array::from_slice(&mask, &[1, 1, seq, seq]);

        let mut h = hidden.expand_dims(0)?;
        for l in &self.layers {
            h = l.forward(&h, &mask, self.cfg.heads)?;
        }
        let h = self.ln_post.forward(&h.index(0))?;
        self.proj2.forward(&gelu(&self.proj1.forward(&h)?)?)
    }
}
