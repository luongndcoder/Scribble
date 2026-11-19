//! Safetensors loading + `Qwen3ASRModel.sanitize` key mapping, and the tiny
//! layer primitives (linear / norms / gelu) shared by encoder and decoder.

use std::collections::HashMap;
use std::path::Path;

use mlx_rs::error::{Exception, Result};
use mlx_rs::{fast, Array, Dtype};

/// Named tensors after `sanitize`: `thinker.` prefix dropped, tied
/// `lm_head.weight` skipped, HF conv2d weights `(O,I,H,W)` → MLX `(O,H,W,I)`.
pub struct Weights(HashMap<String, Array>);

impl Weights {
    pub fn load(dir: &Path) -> std::result::Result<Self, String> {
        let raw = Array::load_safetensors(dir.join("model.safetensors")).map_err(|e| format!("{e:?}"))?;
        // Already-converted checkpoints (mlx-community) have no `thinker.` prefix
        // and channels-last convs.
        let hf_layout = raw.keys().any(|k| k.starts_with("thinker."));
        let mut out = HashMap::with_capacity(raw.len());
        for (k, v) in raw {
            let k = k.strip_prefix("thinker.").unwrap_or(&k).to_string();
            if k == "lm_head.weight" {
                continue;
            }
            let v = if hf_layout && k.contains("conv2d") && k.contains("weight") && v.ndim() == 4 {
                v.transpose_axes(&[0, 2, 3, 1]).map_err(|e| format!("{e:?}"))?
            } else {
                v
            };
            out.insert(k, v);
        }
        Ok(Self(out))
    }

    pub fn get(&self, name: &str) -> Result<Array> {
        self.0.get(name).cloned().ok_or_else(|| Exception::custom(format!("missing weight {name}")))
    }

    pub fn opt(&self, name: &str) -> Option<Array> {
        self.0.get(name).cloned()
    }

    /// `name` cast to `dtype` (e.g. encoder weights to float32, once).
    pub fn get_as(&self, name: &str, dtype: Dtype) -> Result<Array> {
        self.get(name)?.as_dtype(dtype)
    }
}

/// `y = x @ W^T (+ b)`.
pub struct Linear {
    w: Array,
    b: Option<Array>,
}

impl Linear {
    /// Load `<p>.weight` (+ `<p>.bias` when present) cast to `dtype`.
    pub fn load(w: &Weights, p: &str, dtype: Dtype) -> Result<Self> {
        Ok(Self {
            w: w.get_as(&format!("{p}.weight"), dtype)?.transpose_axes(&[1, 0])?,
            b: w.opt(&format!("{p}.bias")).map(|b| b.as_dtype(dtype)).transpose()?,
        })
    }

    pub fn forward(&self, x: &Array) -> Result<Array> {
        let y = x.matmul(&self.w)?;
        match &self.b {
            Some(b) => y.add(b),
            None => Ok(y),
        }
    }
}

pub struct LayerNorm {
    w: Array,
    b: Array,
}

impl LayerNorm {
    pub fn load(w: &Weights, p: &str, dtype: Dtype) -> Result<Self> {
        Ok(Self { w: w.get_as(&format!("{p}.weight"), dtype)?, b: w.get_as(&format!("{p}.bias"), dtype)? })
    }

    pub fn forward(&self, x: &Array) -> Result<Array> {
        fast::layer_norm(x, &self.w, &self.b, 1e-5)
    }
}

/// Exact (erf) GELU, `nn.gelu`: `x * (1 + erf(x / sqrt 2)) / 2`, scalars in
/// `x`'s dtype so bf16 stays bf16.
pub fn gelu(x: &Array) -> Result<Array> {
    let dt = x.dtype();
    let c = |v: f32| Array::from_f32(v).as_dtype(dt);
    let inner = mlx_rs::ops::erf(&x.divide(c(std::f32::consts::SQRT_2)?)?)?;
    x.multiply(c(1.0)?.add(inner)?)?.divide(c(2.0)?)
}

/// SiLU (`x * sigmoid(x)`).
pub fn silu(x: &Array) -> Result<Array> {
    x.multiply(mlx_rs::ops::sigmoid(x)?)
}
