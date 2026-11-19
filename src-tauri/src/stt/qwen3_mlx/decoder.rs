//! Qwen3 text decoder (28 layers, GQA 16/8 heads, per-head q/k RMSNorm, RoPE,
//! SwiGLU) with a growing KV cache. bf16 weights and activations, like the
//! reference. Port of `TextModel` in `mlx_audio/stt/models/qwen3_asr/qwen3_asr.py`.

use mlx_rs::error::Result;
use mlx_rs::fast::{self, ScaledDotProductAttentionMask};
use mlx_rs::ops;
use mlx_rs::{Array, Dtype};

use super::config::TextConfig;
use super::weights::{silu, Linear, Weights};

const BF16: Dtype = Dtype::Bfloat16;

struct Layer {
    attn_norm: Array,
    q: Linear,
    k: Linear,
    v: Linear,
    o: Linear,
    q_norm: Array,
    k_norm: Array,
    mlp_norm: Array,
    gate: Linear,
    up: Linear,
    down: Linear,
}

impl Layer {
    fn load(w: &Weights, i: usize) -> Result<Self> {
        let p = format!("model.layers.{i}");
        let lin = |n: &str| Linear::load(w, &format!("{p}.{n}"), BF16);
        let vec = |n: &str| w.get_as(&format!("{p}.{n}.weight"), BF16);
        Ok(Self {
            attn_norm: vec("input_layernorm")?,
            q: lin("self_attn.q_proj")?,
            k: lin("self_attn.k_proj")?,
            v: lin("self_attn.v_proj")?,
            o: lin("self_attn.o_proj")?,
            q_norm: vec("self_attn.q_norm")?,
            k_norm: vec("self_attn.k_norm")?,
            mlp_norm: vec("post_attention_layernorm")?,
            gate: lin("mlp.gate_proj")?,
            up: lin("mlp.up_proj")?,
            down: lin("mlp.down_proj")?,
        })
    }
}

/// Per-sequence key/value cache, one `(K, V)` pair `(1, kv_heads, T, head_dim)` per layer.
pub struct KvCache {
    layers: Vec<Option<(Array, Array)>>,
}

impl KvCache {
    pub fn offset(&self) -> i32 {
        self.layers[0].as_ref().map(|(k, _)| k.dim(2)).unwrap_or(0)
    }

    /// Force evaluation of all cached tensors (prefill barrier).
    pub fn eval(&self) -> Result<()> {
        for (k, v) in self.layers.iter().flatten() {
            k.eval()?;
            v.eval()?;
        }
        Ok(())
    }
}

pub struct TextDecoder {
    cfg: TextConfig,
    embed: Array,   // (vocab, hidden) bf16
    embed_t: Array, // (hidden, vocab) view, for the tied lm_head
    layers: Vec<Layer>,
    norm: Array,
}

impl TextDecoder {
    pub fn load(w: &Weights, cfg: &TextConfig) -> Result<Self> {
        let embed = w.get_as("model.embed_tokens.weight", BF16)?;
        Ok(Self {
            cfg: cfg.clone(),
            embed_t: embed.transpose_axes(&[1, 0])?,
            embed,
            layers: (0..cfg.layers).map(|i| Layer::load(w, i)).collect::<Result<_>>()?,
            norm: w.get_as("model.norm.weight", BF16)?,
        })
    }

    pub fn new_cache(&self) -> KvCache {
        KvCache { layers: (0..self.cfg.layers).map(|_| None).collect() }
    }

    /// Token ids `(n,)` int32 → embeddings `(n, hidden)`.
    pub fn embed_tokens(&self, ids: &Array) -> Result<Array> {
        self.embed.take_axis(ids, 0)
    }

    /// Tied lm_head: `(B, L, hidden)` → `(B, L, vocab)`.
    pub fn logits(&self, hidden: &Array) -> Result<Array> {
        hidden.matmul(&self.embed_t)
    }

    /// Run `(1, L, hidden)` embeddings through the stack, extending `cache`.
    /// Returns the final-norm hidden states `(1, L, hidden)`.
    pub fn forward(&self, embeds: &Array, cache: &mut KvCache) -> Result<Array> {
        let c = &self.cfg;
        let (b, l) = (embeds.dim(0), embeds.dim(1));
        let offset = cache.offset();
        let mut x = embeds.clone();
        for (i, layer) in self.layers.iter().enumerate() {
            let h = fast::rms_norm(&x, Some(&layer.attn_norm), c.rms_eps)?;
            let split = |t: Array, heads: i32| t.reshape(&[b, l, heads, c.head_dim]);
            let q = split(layer.q.forward(&h)?, c.heads)?;
            let k = split(layer.k.forward(&h)?, c.kv_heads)?;
            let v = split(layer.v.forward(&h)?, c.kv_heads)?;
            let q = fast::rms_norm(&q, Some(&layer.q_norm), c.rms_eps)?.transpose_axes(&[0, 2, 1, 3])?;
            let k = fast::rms_norm(&k, Some(&layer.k_norm), c.rms_eps)?.transpose_axes(&[0, 2, 1, 3])?;
            let v = v.transpose_axes(&[0, 2, 1, 3])?;
            let rope = |t: &Array| fast::rope(t, c.head_dim, false, c.rope_theta, 1.0, offset, None::<&Array>);
            let (q, k) = (rope(&q)?, rope(&k)?);
            let (k, v) = match cache.layers[i].take() {
                Some((pk, pv)) => (ops::concatenate(&[&pk, &k], 2)?, ops::concatenate(&[&pv, &v], 2)?),
                None => (k, v),
            };
            cache.layers[i] = Some((k.clone(), v.clone()));
            let mask = (l > 1).then_some(ScaledDotProductAttentionMask::Causal);
            let scale = (c.head_dim as f32).powf(-0.5);
            let a = fast::scaled_dot_product_attention(&q, &k, &v, scale, mask, None)?;
            let a = a.transpose_axes(&[0, 2, 1, 3])?.reshape(&[b, l, -1])?;
            x = x.add(layer.o.forward(&a)?)?;

            let h = fast::rms_norm(&x, Some(&layer.mlp_norm), c.rms_eps)?;
            let m = layer.down.forward(&silu(&layer.gate.forward(&h)?)?.multiply(layer.up.forward(&h)?)?)?;
            x = x.add(m)?;
        }
        fast::rms_norm(&x, Some(&self.norm), c.rms_eps)
    }
}
