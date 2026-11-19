//! `config.json` of a Qwen3-ASR checkpoint (HF layout: values nested under
//! `thinker_config`, or flat for the mlx-community conversion).
//!
//! Mirrors `mlx_audio/stt/models/qwen3_asr/config.py` defaults.

use std::path::Path;

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct AudioConfig {
    pub num_mel_bins: i32,
    pub layers: usize,
    pub heads: i32,
    pub ffn_dim: i32,
    pub d_model: i32,
    pub n_window: i32,
    pub n_window_infer: i32,
    pub max_source_positions: usize,
    pub output_dim: i32,
    pub downsample_hidden: i32,
}

#[derive(Debug, Clone)]
pub struct TextConfig {
    pub vocab_size: i32,
    pub hidden: i32,
    pub layers: usize,
    pub heads: i32,
    pub kv_heads: i32,
    pub head_dim: i32,
    pub rms_eps: f32,
    pub rope_theta: f32,
    pub tie_embeddings: bool,
}

#[derive(Debug, Clone)]
pub struct Qwen3Config {
    pub audio: AudioConfig,
    pub text: TextConfig,
    pub audio_token_id: u32,
    pub support_languages: Vec<String>,
}

fn int(v: &Value, key: &str, default: i64) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(default)
}

impl Qwen3Config {
    pub fn load(dir: &Path) -> Result<Self, String> {
        let raw = std::fs::read_to_string(dir.join("config.json")).map_err(|e| e.to_string())?;
        let root: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let thinker = root.get("thinker_config").unwrap_or(&root);
        let (a, t) = (&thinker["audio_config"], &thinker["text_config"]);
        let support_languages = root["support_languages"]
            .as_array()
            .map(|l| l.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        Ok(Self {
            audio: AudioConfig {
                num_mel_bins: int(a, "num_mel_bins", 128) as i32,
                layers: int(a, "encoder_layers", 24) as usize,
                heads: int(a, "encoder_attention_heads", 16) as i32,
                ffn_dim: int(a, "encoder_ffn_dim", 4096) as i32,
                d_model: int(a, "d_model", 1024) as i32,
                n_window: int(a, "n_window", 50) as i32,
                n_window_infer: int(a, "n_window_infer", 800) as i32,
                max_source_positions: int(a, "max_source_positions", 1500) as usize,
                output_dim: int(a, "output_dim", 2048) as i32,
                downsample_hidden: int(a, "downsample_hidden_size", 480) as i32,
            },
            text: TextConfig {
                vocab_size: int(t, "vocab_size", 151936) as i32,
                hidden: int(t, "hidden_size", 2048) as i32,
                layers: int(t, "num_hidden_layers", 28) as usize,
                heads: int(t, "num_attention_heads", 16) as i32,
                kv_heads: int(t, "num_key_value_heads", 8) as i32,
                head_dim: int(t, "head_dim", 128) as i32,
                rms_eps: t.get("rms_norm_eps").and_then(Value::as_f64).unwrap_or(1e-6) as f32,
                rope_theta: t.get("rope_theta").and_then(Value::as_f64).unwrap_or(1e6) as f32,
                tie_embeddings: t.get("tie_word_embeddings").and_then(Value::as_bool).unwrap_or(true),
            },
            audio_token_id: int(thinker, "audio_token_id", 151676) as u32,
            support_languages,
        })
    }

    /// Resolve an app language code (`vi`, `en`, …) or name to the checkpoint's
    /// language name (`Vietnamese`). `None` = auto-detect (no forced prefix).
    pub fn language_name(&self, lang: &str) -> Option<String> {
        let l = lang.trim();
        let name = match l.to_ascii_lowercase().as_str() {
            "" | "auto" => return None,
            "vi" => "Vietnamese",
            "en" => "English",
            "zh" => "Chinese",
            "ja" => "Japanese",
            "ko" => "Korean",
            "fr" => "French",
            "de" => "German",
            "es" => "Spanish",
            "th" => "Thai",
            "id" => "Indonesian",
            _ => l,
        };
        Some(
            self.support_languages
                .iter()
                .find(|s| s.eq_ignore_ascii_case(name))
                .cloned()
                .unwrap_or_else(|| name.to_string()),
        )
    }
}
