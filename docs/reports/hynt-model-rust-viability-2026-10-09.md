# hynt speaker model on Rust — VIABLE after all (2026-10-09)

## Correction to the earlier spike

The earlier report (`spike-2026-10-09-rust-diarizer-sherpa-crate.md`) concluded the
hynt `speaker_embedding_resnet34.onnx` could not run in Rust and that the model
had to be swapped. **That conclusion was wrong — it was true only for the
`sherpa-onnx` crate, not for Rust in general.**

The mistake was treating "sherpa-onnx rejects it" as "Rust rejects it". sherpa
validates `model_type` metadata before loading; ONNX Runtime does no such thing.

## What actually works

Two crates replace sherpa's role for this model:

| Layer | Crate | Notes |
|---|---|---|
| Feature front end | `kaldi-native-fbank` 0.1.0 | Rust port of Kaldi's fbank, has `OnlineFeature` (handles striding) |
| Inference | `ort` (ONNX Runtime 1.28 bindings) | Loads ANY valid ONNX graph; no metadata requirement |

### Verified numbers

**fbank parity** — Rust `kaldi-native-fbank` vs Python `diarize._compute_fbank`
(both on the same 2s speech window, int16-scaled input, utterance CMN):

| metric | value |
|---|---|
| frames x dim | 198 x 80 (identical) |
| first frame (first 6 bins) | identical to 4 decimals |
| max abs diff | **0.000049** |
| mean abs diff | **0.000004** |

**Embedding parity** — full pipeline, same 2s window at t=10s:

| | Python (onnxruntime) | Rust (ort) |
|---|---|---|
| pre-L2 norm | 2.7899 | **2.7899** |
| dim | 256 | 256 |
| output | L2-normalised | raw (ratios match exactly) |

`0.314 / 0.1124 = 2.7899` — the same vector, Rust simply had not normalised yet.

**Performance**: 36 ms per embedding (fbank + inference), 10 embeddings in 0.36s.

### Two traps that cost real time — do not repeat

1. **Input must be int16-scaled.** The hynt model expects Kaldi convention
   (`samples * 32768`), not `[-1, 1]`. Feeding normalised audio produced
   all-`-46.05` (the log floor) because the frames were effectively silent.
2. **Compare on a speech region.** The first 2 seconds of `/tmp/sale_campaign.wav`
   are silence, so an early comparison produced meaningless agreement on the
   log floor. Use `skip(16000*10)` when comparing fbank implementations.

## Consequence

The CAM++ swap (and the threshold recalibration that came with it) is **not
required**. We can keep the hynt model that was already calibrated against this
user's audio (MATCH 0.50 / distance 0.45, same-speaker p25 0.499 vs
different-speaker max 0.510), and still delete Python + onnxruntime-python.

Trade-off: `ort` bundles ONNX Runtime (~15-20MB) instead of sherpa-onnx
(~64MB), so the bundle gets smaller either way, and the calibrated model stays.
