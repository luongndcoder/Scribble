//! Nemotron 3.5 ASR Streaming (0.6B) forward pass on MLX.
//!
//! Port of `mlx_audio/stt/models/nemotron_asr/{conformer,attention,streaming,rnnt}.py`
//! (MIT, Blaizzy/mlx-audio) for the `mlx-community/nemotron-3.5-asr-streaming-0.6b`
//! checkpoint (weights already in MLX layout: channels-last convs, `Wx/Wh/bias`
//! LSTMs). Only the cache-aware STREAMING path is ported — it is what live
//! recording needs, and the reference shows it is token-equivalent to the
//! offline chunked-limited encoder at the native chunk size.

use std::collections::HashMap;
use std::path::Path;

use mlx_rs::error::Result;
use mlx_rs::ops::{self, concatenate};
use mlx_rs::{fast, Array};

/// Model hyper-parameters (from `config.json`, Nemotron 3.5 values as defaults).
#[derive(Debug, Clone)]
pub struct NemotronConfig {
    pub d_model: i32,
    pub n_heads: i32,
    pub n_layers: usize,
    pub conv_kernel: i32,
    pub sub_channels: i32,
    pub subsampling: usize,
    pub left_context: usize,
    pub right_context: usize,
    pub num_prompts: i32,
    pub prompt_dictionary: HashMap<String, i32>,
    pub pred_hidden: i32,
    pub pred_layers: usize,
    pub blank_id: i32,
    pub max_symbols: usize,
    pub vocabulary: Vec<String>,
}

impl NemotronConfig {
    pub fn load(dir: &Path, right_context: usize) -> std::result::Result<Self, String> {
        let raw = std::fs::read_to_string(dir.join("config.json")).map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let enc = &v["encoder"];
        let int = |x: &serde_json::Value, d: i64| x.as_i64().unwrap_or(d);
        let vocabulary: Vec<String> = v["vocabulary"]
            .as_array()
            .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        if vocabulary.is_empty() {
            return Err("config.json has no vocabulary".into());
        }
        let prompt_dictionary = v["prompt"]["prompt_dictionary"]
            .as_object()
            .map(|m| m.iter().filter_map(|(k, x)| x.as_i64().map(|i| (k.clone(), i as i32))).collect())
            .unwrap_or_default();
        let vocab_size = int(&v["decoder"]["vocab_size"], vocabulary.len() as i64) as i32;
        Ok(Self {
            d_model: int(&enc["d_model"], 1024) as i32,
            n_heads: int(&enc["n_heads"], 8) as i32,
            n_layers: int(&enc["n_layers"], 24) as usize,
            conv_kernel: int(&enc["conv_kernel_size"], 9) as i32,
            sub_channels: int(&enc["subsampling_conv_channels"], 256) as i32,
            subsampling: int(&enc["subsampling_factor"], 8) as usize,
            left_context: 56,
            right_context,
            num_prompts: int(&v["prompt"]["num_prompts"], 128) as i32,
            prompt_dictionary,
            pred_hidden: int(&v["decoder"]["pred_hidden"], 640) as i32,
            pred_layers: int(&v["decoder"]["pred_rnn_layers"], 2) as usize,
            blank_id: vocab_size,
            max_symbols: int(&v["max_symbols"], 10) as usize,
            vocabulary,
        })
    }

    pub fn prompt_index(&self, language: &str) -> i32 {
        let lang = language.trim();
        let candidates = [lang.to_string(), short_to_locale(lang).to_string(), "auto".to_string()];
        candidates
            .iter()
            .find_map(|k| self.prompt_dictionary.get(k).copied())
            .unwrap_or(0)
    }
}

/// App language codes → Nemotron prompt keys where the short code is not a key.
fn short_to_locale(lang: &str) -> &str {
    match lang {
        "vi" => "vi-VN",
        "zh" => "zh-CN",
        "th" => "th-TH",
        "id" => "id-ID",
        "ja" => "ja-JP",
        "" => "auto",
        other => other,
    }
}

/// Slice `[start, end)` along `axis` (gather-based; inputs here are small).
fn sl(x: &Array, axis: i32, start: i32, end: i32) -> Result<Array> {
    let idx: Vec<i32> = (start..end).collect();
    x.take_axis(&Array::from_slice(&idx, &[idx.len() as i32]), axis)
}

pub struct Weights(HashMap<String, Array>);

impl Weights {
    pub fn load(dir: &Path) -> std::result::Result<Self, String> {
        let map = Array::load_safetensors(dir.join("model.safetensors")).map_err(|e| format!("{e:?}"))?;
        Ok(Self(map))
    }
    fn get(&self, name: &str) -> Result<&Array> {
        self.0.get(name).ok_or_else(|| {
            mlx_rs::error::Exception::custom(format!("missing weight {name}"))
        })
    }
    fn opt(&self, name: &str) -> Option<&Array> {
        self.0.get(name)
    }
    /// `x @ W^T (+ b)` for `<p>.weight` / `<p>.bias`.
    fn linear(&self, p: &str, x: &Array) -> Result<Array> {
        let y = x.matmul(&self.get(&format!("{p}.weight"))?.transpose_axes(&[1, 0])?)?;
        match self.opt(&format!("{p}.bias")) {
            Some(b) => y.add(b),
            None => Ok(y),
        }
    }
    fn layer_norm(&self, p: &str, x: &Array) -> Result<Array> {
        fast::layer_norm(
            x,
            Some(self.get(&format!("{p}.weight"))?),
            self.opt(&format!("{p}.bias")),
            1e-5,
        )
    }
    fn conv2d(&self, p: &str, x: &Array, stride: i32, groups: i32) -> Result<Array> {
        let y = ops::conv2d(x, self.get(&format!("{p}.weight"))?, (stride, stride), (0, 0), (1, 1), groups)?;
        match self.opt(&format!("{p}.bias")) {
            Some(b) => y.add(b),
            None => Ok(y),
        }
    }
    fn conv1d(&self, p: &str, x: &Array, groups: i32) -> Result<Array> {
        let y = ops::conv1d(x, self.get(&format!("{p}.weight"))?, 1, 0, 1, groups)?;
        match self.opt(&format!("{p}.bias")) {
            Some(b) => y.add(b),
            None => Ok(y),
        }
    }
}

fn relu(x: &Array) -> Result<Array> {
    ops::maximum(x, mlx_rs::array!(0.0f32))
}
fn silu(x: &Array) -> Result<Array> {
    x.multiply(&ops::sigmoid(x)?)
}
/// GLU over the last axis: first half * sigmoid(second half).
fn glu(x: &Array) -> Result<Array> {
    let d = x.dim(-1) / 2;
    sl(x, -1, 0, d)?.multiply(&ops::sigmoid(&sl(x, -1, d, 2 * d)?)?)
}

/// Relative positional embedding for a key window of `len` frames:
/// rows for positions `len-1 … -(len-1)` (2·len−1, d_model), NeMo/Transformer-XL.
fn rel_pos_emb(len: usize, d_model: usize) -> Array {
    let rows = 2 * len - 1;
    let mut pe = vec![0f32; rows * d_model];
    for r in 0..rows {
        let pos = (len as f64 - 1.0) - r as f64;
        for i in (0..d_model).step_by(2) {
            let div = (-(10000f64).ln() * i as f64 / d_model as f64).exp();
            pe[r * d_model + i] = (pos * div).sin() as f32;
            pe[r * d_model + i + 1] = (pos * div).cos() as f32;
        }
    }
    Array::from_slice(&pe, &[1, rows as i32, d_model as i32])
}

/// Transformer-XL relative shift: (B,H,Tq,P) → (B,H,Tq,P).
fn rel_shift(x: &Array) -> Result<Array> {
    let s = x.shape().to_vec();
    let (b, h, tq, p) = (s[0], s[1], s[2], s[3]);
    let x = ops::pad(x, &[(0, 0), (0, 0), (0, 0), (1, 0)], None, None)?;
    let x = x.reshape(&[b, h, p + 1, tq])?;
    let x = sl(&x, 2, 1, p + 1)?;
    x.reshape(&[b, h, tq, p])
}

/// The full model: weights + config + positional-embedding cache.
pub struct NemotronModel {
    pub cfg: NemotronConfig,
    w: Weights,
    pos_cache: std::sync::Mutex<HashMap<usize, Array>>,
}

/// Per-stream encoder + decoder state.
pub struct StreamState {
    attn_cache: Vec<Option<Array>>,
    conv_cache: Vec<Option<Array>>,
    mel_cache: Option<Array>,
    pending: Option<Array>,
    emitted: usize,
    consumed: usize,
    /// Encoder frames decoded so far (global clock for token timestamps).
    pub enc_frames: usize,
    last_token: i32,
    hidden: Option<(Array, Array)>,
    prediction: Option<(Array, (Array, Array))>,
    prompt: i32,
}

/// A decoded token: vocabulary id, its text piece, and its encoder frame.
#[derive(Debug, Clone)]
pub struct DecodedToken {
    pub id: i32,
    pub text: String,
    pub frame: usize,
}

const PRE_ENCODE_MEL_CACHE: i32 = 16;

impl NemotronModel {
    pub fn load(dir: &Path, right_context: usize) -> std::result::Result<Self, String> {
        let cfg = NemotronConfig::load(dir, right_context)?;
        let w = Weights::load(dir)?;
        Ok(Self { cfg, w, pos_cache: std::sync::Mutex::new(HashMap::new()) })
    }

    pub fn new_state(&self, language: &str) -> StreamState {
        StreamState {
            attn_cache: vec![None; self.cfg.n_layers],
            conv_cache: vec![None; self.cfg.n_layers],
            mel_cache: None,
            pending: None,
            emitted: 0,
            consumed: 0,
            enc_frames: 0,
            last_token: self.cfg.blank_id,
            hidden: None,
            prediction: None,
            prompt: self.cfg.prompt_index(language),
        }
    }

    pub fn set_language(&self, st: &mut StreamState, language: &str) {
        st.prompt = self.cfg.prompt_index(language);
    }

    fn pos_emb(&self, len: usize) -> Array {
        let mut c = self.pos_cache.lock().unwrap_or_else(|p| p.into_inner());
        c.entry(len).or_insert_with(|| rel_pos_emb(len, self.cfg.d_model as usize)).clone()
    }

    fn chunk_mel(&self) -> usize {
        (self.cfg.right_context + 1) * self.cfg.subsampling
    }

    // ── Pre-encode: causal depthwise-striding conv subsampling (8x) ──────────
    fn pre_encode(&self, mel: &Array) -> Result<Array> {
        // (1, T, F) → (1, T, F, 1) channels-last.
        // Run activations in the weights' dtype (bf16): with f32 activations MLX
        // up-casts every weight matrix on every matmul, which dominated runtime.
        let mut x = mel.as_dtype(self.compute_dtype())?.expand_dims(-1)?;
        let causal = |x: &Array| ops::pad(x, &[(0, 0), (2, 1), (2, 1), (0, 0)], None, None);
        x = relu(&self.w.conv2d("encoder.pre_encode.conv.0", &causal(&x)?, 2, 1)?)?;
        let ch = self.cfg.sub_channels;
        for (dw, pw) in [(2, 3), (5, 6)] {
            x = self.w.conv2d(&format!("encoder.pre_encode.conv.{dw}"), &causal(&x)?, 2, ch)?;
            x = relu(&self.w.conv2d(&format!("encoder.pre_encode.conv.{pw}"), &x, 1, 1)?)?;
        }
        // (1, T', F', C) → (1, T', C·F') channel-major (matches NeMo).
        let s = x.shape().to_vec();
        let x = x.transpose_axes(&[0, 1, 3, 2])?.reshape(&[s[0], s[1], s[3] * s[2]])?;
        self.w.linear("encoder.pre_encode.out", &x)
    }

    // ── One conformer block, cache-aware ─────────────────────────────────────
    fn stream_block(&self, li: usize, x: &Array, st: &mut StreamState) -> Result<Array> {
        let p = format!("encoder.layers.{li}");
        let w = &self.w;
        let ff = |name: &str, x: &Array| -> Result<Array> {
            let h = silu(&w.linear(&format!("{p}.{name}.linear1"), x)?)?;
            w.linear(&format!("{p}.{name}.linear2"), &h)
        };
        let half = mlx_rs::array!(0.5f32);

        let mut res = x.add(&ff("feed_forward1", &w.layer_norm(&format!("{p}.norm_feed_forward1"), x)?)?.multiply(&half)?)?;

        // Self-attention: Q = chunk, K/V = [cache ++ chunk].
        let xn = w.layer_norm(&format!("{p}.norm_self_att"), &res)?;
        let kv = match &st.attn_cache[li] {
            Some(c) => concatenate(&[c, &xn], 1)?,
            None => xn.clone(),
        };
        res = res.add(&self.attention(&p, &xn, &kv)?)?;
        let klen = kv.dim(1);
        let keep = self.cfg.left_context as i32;
        st.attn_cache[li] = Some(if klen > keep { sl(&kv, 1, klen - keep, klen)? } else { kv });

        // Causal conv module: prepend conv cache instead of zero padding.
        let xc = w.layer_norm(&format!("{p}.norm_conv"), &res)?;
        let g = glu(&w.conv1d(&format!("{p}.conv.pointwise_conv1"), &xc, 1)?)?;
        let conv_left = self.cfg.conv_kernel - 1;
        let cache = match &st.conv_cache[li] {
            Some(c) => c.clone(),
            None => ops::zeros_dtype(&[g.dim(0), conv_left, g.dim(2)], g.dtype())?,
        };
        let din = concatenate(&[&cache, &g], 1)?;
        let dw = w.conv1d(&format!("{p}.conv.depthwise_conv"), &din, self.cfg.d_model)?;
        let dlen = din.dim(1);
        st.conv_cache[li] = Some(sl(&din, 1, dlen - conv_left, dlen)?);
        let y = silu(&w.layer_norm(&format!("{p}.conv.batch_norm"), &dw)?)?;
        res = res.add(&w.conv1d(&format!("{p}.conv.pointwise_conv2"), &y, 1)?)?;

        res = res.add(&ff("feed_forward2", &w.layer_norm(&format!("{p}.norm_feed_forward2"), &res)?)?.multiply(&half)?)?;
        w.layer_norm(&format!("{p}.norm_out"), &res)
    }

    /// Relative-position MHA, streaming form (no mask: the K window IS the context).
    fn attention(&self, p: &str, q_in: &Array, kv_in: &Array) -> Result<Array> {
        let w = &self.w;
        let a = format!("{p}.self_attn");
        let (h, d) = (self.cfg.n_heads, self.cfg.d_model / self.cfg.n_heads);
        let (b, c, ksz) = (q_in.dim(0), q_in.dim(1), kv_in.dim(1));
        let pos = self.pos_emb(ksz as usize);
        let q = w.linear(&format!("{a}.linear_q"), q_in)?.reshape(&[b, c, h, d])?;
        let k = w.linear(&format!("{a}.linear_k"), kv_in)?.reshape(&[b, ksz, h, d])?.transpose_axes(&[0, 2, 1, 3])?;
        let v = w.linear(&format!("{a}.linear_v"), kv_in)?.reshape(&[b, ksz, h, d])?.transpose_axes(&[0, 2, 1, 3])?;
        let pl = pos.dim(1);
        let pp = w.linear(&format!("{a}.linear_pos"), &pos)?.reshape(&[1, pl, h, d])?.transpose_axes(&[0, 2, 1, 3])?;
        let q_u = q.add(w.get(&format!("{a}.pos_bias_u"))?)?.transpose_axes(&[0, 2, 1, 3])?;
        let q_v = q.add(w.get(&format!("{a}.pos_bias_v"))?)?.transpose_axes(&[0, 2, 1, 3])?;
        let scale = (d as f32).powf(-0.5);
        let bd = q_v.matmul(&pp.swap_axes(-2, -1)?)?;
        let bd = sl(&rel_shift(&bd)?, 3, 0, ksz)?.multiply(mlx_rs::array!(scale))?;
        let o = fast::scaled_dot_product_attention(&q_u, &k, &v, scale, &bd, None)?;
        let o = o.transpose_axes(&[0, 2, 1, 3])?.reshape(&[b, c, self.cfg.d_model])?;
        w.linear(&format!("{a}.linear_out"), &o)
    }

    /// Encode one mel chunk through pre-encode + all layers (streaming).
    fn encode_mel_chunk(&self, m: &Array, include_boundary: bool, st: &mut StreamState) -> Result<Option<Array>> {
        let sub = self.cfg.subsampling;
        let cache_len = st.mel_cache.as_ref().map(|c| c.dim(1) as usize).unwrap_or(0);
        let win = match &st.mel_cache {
            Some(c) => concatenate(&[c, m], 1)?,
            None => m.clone(),
        };
        let s = self.pre_encode(&win)?;
        let end = st.consumed + m.dim(1) as usize;
        let base = (st.consumed as i64 - cache_len as i64).div_euclid(sub as i64);
        let lo = st.emitted as i64 - base;
        let hi = if include_boundary { s.dim(1) as i64 } else { (end / sub) as i64 - base };
        st.consumed = end;
        let wl = win.dim(1);
        st.mel_cache = Some(sl(&win, 1, (wl - PRE_ENCODE_MEL_CACHE).max(0), wl)?);
        if hi <= lo {
            st.emitted = (base + lo.max(hi)) as usize;
            return Ok(None);
        }
        st.emitted = (base + hi) as usize;
        let mut h = sl(&s, 1, lo as i32, hi as i32)?;
        for li in 0..self.cfg.n_layers {
            h = self.stream_block(li, &h, st)?;
        }
        Ok(Some(h))
    }

    /// Push mel frames; return newly encoded chunks (each (1, c, d_model)).
    pub fn push_mel(&self, mel: Option<Array>, final_: bool, st: &mut StreamState) -> Result<Vec<Array>> {
        if let Some(m) = mel {
            if m.dim(1) > 0 {
                st.pending = Some(match &st.pending {
                    Some(p) => concatenate(&[p, &m], 1)?,
                    None => m,
                });
            }
        }
        let chunk = self.chunk_mel() as i32;
        let mut out = Vec::new();
        while let Some(p) = st.pending.clone() {
            let plen = p.dim(1);
            if plen == 0 {
                break;
            }
            if plen < chunk && !final_ {
                break;
            }
            let take = if final_ && plen <= chunk { plen } else { chunk.min(plen) };
            let m = sl(&p, 1, 0, take)?;
            st.pending = Some(sl(&p, 1, take, plen)?);
            let boundary = final_ && plen - take == 0;
            if let Some(h) = self.encode_mel_chunk(&m, boundary, st)? {
                out.push(h);
            }
        }
        Ok(out)
    }

    /// Concatenate the one-hot language prompt and project back to d_model.
    pub fn apply_prompt(&self, enc: &Array, prompt: i32) -> Result<Array> {
        if self.w.opt("prompt_kernel.0.weight").is_none() {
            return Ok(enc.clone());
        }
        let (b, t) = (enc.dim(0), enc.dim(1));
        let n = self.cfg.num_prompts;
        let mut one = vec![0f32; n as usize];
        if (0..n).contains(&prompt) {
            one[prompt as usize] = 1.0;
        }
        let one = ops::broadcast_to(&Array::from_slice(&one, &[1, 1, n]), &[b, t, n])?.as_dtype(enc.dtype())?;
        let x = concatenate(&[enc, &one], -1)?;
        let x = relu(&self.w.linear("prompt_kernel.0", &x)?)?;
        self.w.linear("prompt_kernel.2", &x)
    }

    // ── RNN-T prediction + joint, greedy ─────────────────────────────────────
    fn predict(&self, token: Option<i32>, hidden: &Option<(Array, Array)>) -> Result<(Array, (Array, Array))> {
        let ph = self.cfg.pred_hidden;
        let mut x = match token {
            Some(t) => self
                .w
                .get("decoder.prediction.embed.weight")?
                .take_axis(&Array::from_slice(&[t], &[1]), 0)?
                .reshape(&[1, ph])?,
            None => ops::zeros_dtype(&[1, ph], self.compute_dtype())?,
        };
        let mut hs = Vec::new();
        let mut cs = Vec::new();
        for l in 0..self.cfg.pred_layers {
            let p = format!("decoder.prediction.dec_rnn.lstm.{l}");
            let mut gates = x
                .matmul(&self.w.get(&format!("{p}.Wx"))?.transpose_axes(&[1, 0])?)?
                .add(self.w.get(&format!("{p}.bias"))?)?;
            let prev = hidden.as_ref().map(|(h, c)| -> Result<(Array, Array)> {
                Ok((sl(h, 0, l as i32, l as i32 + 1)?.reshape(&[1, ph])?, sl(c, 0, l as i32, l as i32 + 1)?.reshape(&[1, ph])?))
            });
            let prev = match prev {
                Some(r) => Some(r?),
                None => None,
            };
            if let Some((h, _)) = &prev {
                gates = gates.add(&h.matmul(&self.w.get(&format!("{p}.Wh"))?.transpose_axes(&[1, 0])?)?)?;
            }
            let i = ops::sigmoid(&sl(&gates, -1, 0, ph)?)?;
            let f = ops::sigmoid(&sl(&gates, -1, ph, 2 * ph)?)?;
            let g = ops::tanh(&sl(&gates, -1, 2 * ph, 3 * ph)?)?;
            let o = ops::sigmoid(&sl(&gates, -1, 3 * ph, 4 * ph)?)?;
            let c = match &prev {
                Some((_, c)) => f.multiply(c)?.add(&i.multiply(&g)?)?,
                None => i.multiply(&g)?,
            };
            let h = o.multiply(&ops::tanh(&c)?)?;
            x = h.clone();
            hs.push(h);
            cs.push(c);
        }
        let h = ops::stack(&hs, 0)?; // (L, 1, ph)
        let c = ops::stack(&cs, 0)?;
        Ok((x, (h, c)))
    }

    fn joint(&self, enc_frame: &Array, pred: &Array) -> Result<Array> {
        let e = self.w.linear("joint.enc", enc_frame)?;
        let p = self.w.linear("joint.pred", pred)?;
        let x = relu(&e.add(&p)?)?;
        self.w.linear("joint.joint_net.2", &x)
    }

    /// Greedy-decode prompted encoder frames (1, T, d) into new tokens.
    pub fn decode(&self, enc: &Array, st: &mut StreamState) -> Result<Vec<DecodedToken>> {
        let t_len = enc.dim(1);
        let mut out = Vec::new();
        for t in 0..t_len {
            let frame = sl(enc, 1, t, t + 1)?.reshape(&[1, self.cfg.d_model])?;
            let mut symbols = 0;
            loop {
                if st.prediction.is_none() {
                    let tok = (st.last_token != self.cfg.blank_id).then_some(st.last_token);
                    st.prediction = Some(self.predict(tok, &st.hidden)?);
                }
                let (pred, hc) = st.prediction.clone().expect("prediction set above");
                let logits = self.joint(&frame, &pred)?;
                let token: i32 = ops::indexing::argmax(&logits, None)?.item_exact::<u32>() as i32;
                if token == self.cfg.blank_id {
                    break;
                }
                st.last_token = token;
                st.hidden = Some(hc);
                st.prediction = None;
                let piece = self.cfg.vocabulary.get(token as usize).cloned().unwrap_or_default();
                if !is_special_piece(&piece) {
                    out.push(DecodedToken { id: token, text: piece.replace('▁', " "), frame: st.enc_frames + t as usize });
                }
                symbols += 1;
                if symbols >= self.cfg.max_symbols {
                    break;
                }
            }
        }
        st.enc_frames += t_len as usize;
        if let Some((h, c)) = &st.hidden {
            mlx_rs::transforms::eval([h, c])?;
        }
        Ok(out)
    }
}

/// `<unk>`, `<pad>`, `<s>`, `</s>` and language tags like `<vi-VN>`.
pub fn is_special_piece(p: &str) -> bool {
    matches!(p, "<unk>" | "<pad>" | "<s>" | "</s>")
        || (p.starts_with('<') && p.ends_with('>') && p.contains('-') && p.len() <= 12)
}

impl StreamState {
    pub fn prompt(&self) -> i32 {
        self.prompt
    }
    pub fn set_prompt(&mut self, prompt: i32) {
        self.prompt = prompt;
    }
}

impl NemotronModel {
    /// Activation dtype = the checkpoint's weight dtype (bf16 for the MLX
    /// community release). Matching it avoids per-op weight up-casts.
    fn compute_dtype(&self) -> mlx_rs::Dtype {
        self.w
            .opt("joint.enc.weight")
            .map(|w| w.dtype())
            .unwrap_or(mlx_rs::Dtype::Float32)
    }
}
