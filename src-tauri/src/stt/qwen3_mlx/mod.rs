//! Fine-tuned Qwen3-ASR-1.7B on Apple's MLX (macOS only).
//!
//! Native Rust port of `mlx-audio`'s Qwen3-ASR (MIT, Blaizzy/mlx-audio): Whisper
//! log-mel → audio encoder → Qwen3 LLM decoder, greedy with repetition penalty.
//! The model is NOT streaming; live recording runs it per VAD utterance
//! (see [`engine`]) and uploads reuse the same engine.

pub mod chunking;
pub mod config;
pub mod decoder;
pub mod encoder;
pub mod engine;
pub mod generate;
pub mod mel;
pub mod model;
pub mod weights;

pub use generate::DecodeOptions;
pub use model::Qwen3Model;
