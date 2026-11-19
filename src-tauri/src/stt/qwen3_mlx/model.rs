//! Qwen3-ASR model: weights, tokenizer, prompt construction and the
//! audio → embeddings → KV-cache prefill. Decoding lives in [`super::generate`].

use std::path::Path;

use mlx_rs::error::Result;
use mlx_rs::ops::{self, indexing::IndexOp};
use mlx_rs::{Array, Dtype};
use tokenizers::Tokenizer;

use super::config::Qwen3Config;
use super::decoder::{KvCache, TextDecoder};
use super::encoder::AudioEncoder;
use super::mel::LogMel;
use super::weights::Weights;

pub struct Qwen3Model {
    pub cfg: Qwen3Config,
    pub(super) mel: LogMel,
    pub(super) encoder: AudioEncoder,
    pub(super) decoder: TextDecoder,
    pub(super) tokenizer: Tokenizer,
    /// `<|im_end|>` / `<|endoftext|>` ids.
    pub(super) eos: Vec<u32>,
}

/// Result of encoding the audio and running the prompt through the LLM.
pub struct Prefill {
    /// `(S, 2048)` float32 encoder output.
    pub audio: Array,
    pub prompt_ids: Vec<u32>,
    pub cache: KvCache,
    /// `(1, vocab)` bf16 logits for the first generated token.
    pub logits: Array,
}

fn err(e: impl std::fmt::Display) -> mlx_rs::error::Exception {
    mlx_rs::error::Exception::custom(e.to_string())
}

impl Qwen3Model {
    pub fn load(dir: &Path) -> std::result::Result<Self, String> {
        let cfg = Qwen3Config::load(dir)?;
        let w = Weights::load(dir)?;
        let m = |e: mlx_rs::error::Exception| format!("{e:?}");
        let encoder = AudioEncoder::load(&w, &cfg.audio).map_err(m)?;
        let decoder = TextDecoder::load(&w, &cfg.text).map_err(m)?;
        let tokenizer = Tokenizer::from_file(dir.join("tokenizer.json")).map_err(|e| e.to_string())?;
        let eos = ["<|im_end|>", "<|endoftext|>"].iter().filter_map(|t| tokenizer.token_to_id(t)).collect();
        Ok(Self { mel: LogMel::new(cfg.audio.num_mel_bins as usize), cfg, encoder, decoder, tokenizer, eos })
    }

    /// Chat prompt with `n_audio` `<|audio_pad|>` slots; the assistant turn is
    /// pre-filled with `language <Name><asr_text>` when a language is forced.
    pub fn prompt_ids(&self, n_audio: usize, language: Option<&str>) -> Result<Vec<u32>> {
        let prefix = language.map(|l| format!("language {l}<asr_text>")).unwrap_or_default();
        let prompt = format!(
            "<|im_start|>system\n<|im_end|>\n<|im_start|>user\n<|audio_start|>{}<|audio_end|><|im_end|>\n<|im_start|>assistant\n{prefix}",
            "<|audio_pad|>".repeat(n_audio)
        );
        Ok(self.tokenizer.encode(prompt, false).map_err(err)?.get_ids().to_vec())
    }

    pub fn decode_text(&self, ids: &[u32]) -> Result<String> {
        self.tokenizer.decode(ids, true).map_err(err)
    }

    /// Embeddings `(L, hidden)` for the prompt with the audio slots replaced by `audio` (bf16).
    fn merge_embeds(&self, ids: &[u32], audio: &Array) -> Result<Array> {
        let id_arr = Array::from_slice(&ids.iter().map(|&i| i as i32).collect::<Vec<_>>(), &[ids.len() as i32]);
        let emb = self.decoder.embed_tokens(&id_arr)?;
        let slots: Vec<usize> =
            ids.iter().enumerate().filter(|(_, &t)| t == self.cfg.audio_token_id).map(|(i, _)| i).collect();
        let (first, n) = (slots.first().copied().unwrap_or(0), slots.len());
        if n != audio.dim(0) as usize {
            return Err(err(format!("audio slots {n} != encoder frames {}", audio.dim(0))));
        }
        let tail = (first + n) as i32;
        ops::concatenate(&[&emb.index(..first as i32), audio, &emb.index(tail..)], 0)
    }

    /// Encode one ≤35 s chunk and prefill the prompt (all but the last prompt
    /// token in one pass, then the last token alone — same split as
    /// `generate_step`, so the first logits match the reference).
    pub fn prefill(&self, chunk: &[f32], language: Option<&str>) -> Result<Prefill> {
        let audio = self.encoder.forward(&self.mel.compute(chunk)?)?;
        self.prefill_audio(audio, language)
    }

    /// [`Self::prefill`] from already-encoded `(S, 2048)` audio embeddings.
    pub fn prefill_audio(&self, audio: Array, language: Option<&str>) -> Result<Prefill> {
        let prompt_ids = self.prompt_ids(audio.dim(0) as usize, language)?;
        let embeds = self.merge_embeds(&prompt_ids, &audio.as_dtype(Dtype::Bfloat16)?)?;
        let l = embeds.dim(0);
        let mut cache = self.decoder.new_cache();
        if l > 1 {
            self.decoder.forward(&embeds.index(..l - 1).expand_dims(0)?, &mut cache)?;
            cache.eval()?;
        }
        let h = self.decoder.forward(&embeds.index((l - 1)..).expand_dims(0)?, &mut cache)?;
        let logits = self.decoder.logits(&h)?.reshape(&[1, -1])?;
        Ok(Prefill { audio, prompt_ids, cache, logits })
    }

    /// `(n_mels, T)` Whisper log-mel features of `pcm` (parity tooling).
    pub fn log_mel(&self, pcm: &[f32]) -> Result<Array> {
        self.mel.compute(pcm)
    }

    pub(super) fn decoder(&self) -> &TextDecoder {
        &self.decoder
    }
}
