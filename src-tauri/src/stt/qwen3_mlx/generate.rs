//! Greedy decoding with repetition penalty, chunked transcription and text
//! post-processing — port of `_generate_one` / `generate_step` in
//! `mlx_audio` (qwen3_asr + lm/generate), with the exact numerics of the
//! reference call (`repetition_penalty=1.05`, context 20, bf16 logits).

use mlx_rs::error::Result;
use mlx_rs::ops::{self, indexing::IndexOp};
use mlx_rs::transforms::async_eval;
use mlx_rs::{Array, Dtype};

use super::chunking::{split_audio_into_chunks, CHUNK_SEC, MIN_CHUNK_SEC};
use super::model::{Prefill, Qwen3Model};

/// Decoding knobs. Defaults are the measured configuration
/// (`--tokens-per-sec 8 --rp 1.05`, language forced to Vietnamese).
#[derive(Debug, Clone)]
pub struct DecodeOptions {
    /// Language code/name; `None` or `auto` = let the model detect it.
    pub language: Option<String>,
    pub repetition_penalty: f32,
    pub repetition_context: usize,
    /// Anti-loop cap: `ceil(chunk_seconds * rate) + 32` tokens per chunk.
    pub tokens_per_sec: f64,
}

impl Default for DecodeOptions {
    fn default() -> Self {
        Self { language: Some("vi".into()), repetition_penalty: 1.05, repetition_context: 20, tokens_per_sec: 8.0 }
    }
}

/// `make_repetition_penalty` on bf16 logits `(1, V)`: tokens in `ctx` get
/// `x / p` (x ≥ 0) or `x * p` (x < 0), with `p` rounded to bf16 like MLX's
/// weak Python scalar.
fn penalize(logits: &Array, ctx: &Array, penalty: &Array) -> Result<Array> {
    let idx = ctx.reshape(&[1, -1])?;
    let sel = logits.take_along_axis(&idx, -1)?;
    let neg = sel.lt(Array::from_f32(0.0).as_dtype(Dtype::Bfloat16)?)?;
    let adj = ops::select(&neg, sel.multiply(penalty)?, sel.divide(penalty)?)?;
    logits.put_along_axis(&idx, &adj, -1)
}

/// `argmax(logits - logsumexp(logits))` in the logits' dtype → `(1,)` token id.
fn pick(logits: &Array) -> Result<Array> {
    let lp = logits.subtract(logits.logsumexp(true)?)?;
    ops::indexing::argmax_axis(&lp, -1, None)
}

/// Last `n` entries of `ctx ++ y` (`tokens[-context_size:]`).
fn push_ctx(ctx: &Array, y: &Array, n: usize) -> Result<Array> {
    let all = ops::concatenate(&[ctx, &y.as_dtype(Dtype::Int32)?], 0)?;
    let len = all.dim(0);
    Ok(if len as usize > n { all.index((len - n as i32)..) } else { all })
}

impl Qwen3Model {
    /// Greedy-decode one chunk (≤ ~35 s) into token ids, EOS excluded.
    pub fn generate_chunk(&self, chunk: &[f32], opts: &DecodeOptions, max_tokens: usize) -> Result<Vec<u32>> {
        let lang = opts.language.as_deref().and_then(|l| self.cfg.language_name(l));
        let Prefill { prompt_ids, mut cache, logits, .. } = self.prefill(chunk, lang.as_deref())?;
        let apply = opts.repetition_penalty != 0.0;
        let pen = Array::from_f32(opts.repetition_penalty).as_dtype(Dtype::Bfloat16)?;
        let n = opts.repetition_context;

        let tail = &prompt_ids[prompt_ids.len().saturating_sub(n)..];
        let mut ctx = Array::from_slice(&tail.iter().map(|&t| t as i32).collect::<Vec<_>>(), &[tail.len() as i32]);
        let first = if apply { penalize(&logits, &ctx, &pen)? } else { logits };
        let mut cur = pick(&first)?;
        async_eval([&cur])?;

        let mut out = Vec::new();
        for _ in 0..max_tokens {
            // Queue the next step before reading the current token so the GPU
            // works while the host inspects it (same overlap as `generate_step`).
            let emb = self.decoder().embed_tokens(&cur.as_dtype(Dtype::Int32)?)?.expand_dims(0)?;
            let h = self.decoder().forward(&emb, &mut cache)?;
            let mut lg = self.decoder().logits(&h)?.reshape(&[1, -1])?;
            if apply {
                ctx = push_ctx(&ctx, &cur, n)?;
                lg = penalize(&lg, &ctx, &pen)?;
            }
            let next = pick(&lg)?;
            async_eval([&next])?;

            let tok = cur.item_exact::<u32>();
            if self.eos.contains(&tok) {
                break;
            }
            out.push(tok);
            cur = next;
        }
        Ok(out)
    }

    /// Transcribe a whole 16 kHz mono buffer: ≤30 s low-energy chunking, one
    /// greedy decode per chunk, chunk texts joined with a space and
    /// whitespace-normalised.
    pub fn transcribe(&self, pcm: &[f32], opts: &DecodeOptions) -> Result<String> {
        let mut texts = Vec::new();
        for (chunk, _offset) in split_audio_into_chunks(pcm, CHUNK_SEC, MIN_CHUNK_SEC) {
            let secs = chunk.len() as f64 / super::mel::SAMPLE_RATE as f64;
            let max_tokens = (secs * opts.tokens_per_sec).ceil() as usize + 32;
            let ids = self.generate_chunk(&chunk, opts, max_tokens)?;
            let text = self.decode_text(&ids)?;
            texts.push(strip_language_prefix(&text, opts.language.is_none()));
            let _ = mlx_rs::memory::clear_cache();
        }
        Ok(normalize_ws(&texts.join(" ")))
    }
}

/// `extract_language`: with auto-detect the model emits
/// `language X<asr_text>text`; keep only `text`.
fn strip_language_prefix(text: &str, auto: bool) -> String {
    if auto || text.contains("<asr_text>") {
        if let (true, Some(i)) = (text.starts_with("language "), text.find("<asr_text>")) {
            return text[i + "<asr_text>".len()..].to_string();
        }
    }
    text.to_string()
}

/// `re.sub(r"\s+", " ", s).strip()`.
fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_detected_language_prefix() {
        assert_eq!(strip_language_prefix("language Vietnamese<asr_text>xin chào", true), "xin chào");
        assert_eq!(strip_language_prefix("xin chào", false), "xin chào");
    }

    #[test]
    fn whitespace_is_collapsed() {
        assert_eq!(normalize_ws(" a \n b\t c "), "a b c");
    }
}
