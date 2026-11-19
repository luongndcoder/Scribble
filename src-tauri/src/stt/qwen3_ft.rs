//! Settings glue for the fine-tuned Qwen3-ASR local engine (`local_engine =
//! "qwen3ft"`). Un-gated so Settings, diagnose and the live/upload paths can
//! report "model missing" / "not in this build" without the `mlx` feature.

use std::path::{Path, PathBuf};

/// Where the user's fine-tune lives when `qwen3ft_model_dir` is unset.
pub const DEFAULT_MODEL_DIR: &str = "~/tz-asr-bench/models-mac/qwen3-asr-ft-r2";
pub const ENGINE_ID: &str = "qwen3ft";

/// This build contains the native MLX engine (macOS + `--features mlx`).
pub const fn compiled_in() -> bool {
    cfg!(all(target_os = "macos", feature = "mlx"))
}

fn expand_home(raw: &str) -> PathBuf {
    match raw.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => PathBuf::from(raw),
    }
}

/// Configured checkpoint dir: setting `qwen3ft_model_dir`, else the default.
pub fn configured_model_dir() -> PathBuf {
    let custom = crate::db::Database::get()
        .and_then(|db| db.get_setting("qwen3ft_model_dir").ok().flatten())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    expand_home(custom.as_deref().unwrap_or(DEFAULT_MODEL_DIR))
}

/// A usable checkpoint: Qwen3-ASR `config.json` + `model.safetensors` + `tokenizer.json`.
pub fn is_qwen3_dir(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join("config.json")).is_ok_and(|c| c.contains("\"qwen3_asr\""))
        && dir.join("model.safetensors").is_file()
        && dir.join("tokenizer.json").is_file()
}

/// The configured dir when it holds a usable checkpoint.
pub fn model_dir() -> Option<PathBuf> {
    Some(configured_model_dir()).filter(|d| is_qwen3_dir(d))
}

/// `local_engine` setting says Qwen3 fine-tune.
pub fn selected() -> bool {
    crate::db::Database::get()
        .and_then(|db| db.get_setting("local_engine").ok().flatten())
        .is_some_and(|v| v.trim() == ENGINE_ID)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_prefix_is_expanded() {
        assert_eq!(expand_home("/abs/dir"), PathBuf::from("/abs/dir"));
        assert!(!expand_home("~/x").starts_with("~"));
    }

    #[test]
    fn empty_dir_is_not_a_checkpoint() {
        assert!(!is_qwen3_dir(Path::new("/nonexistent/qwen3")));
    }
}
