# Speaker embedding model swap — measurement report

Date: 2026-10-09. Scope: fix "2 người nam thành 1" (two male speakers collapsed
into one) on the user's real meeting `/tmp/sale_campaign.wav`.
Status: model swapped, thresholds re-derived. **Improvement is real but partial —
this does not fully solve the reported problem.** Read "Honest limits" below.

## 1. The measurement problem with the original numbers

The lead's baseline harness (`examples/spk_separation.rs`, old version) labelled
each window with the cluster id produced by `diarize_fine_windows` — i.e. by the
model under test — then compared "within cluster" vs "across cluster"
similarity. That is circular. A model that merges everything yields almost no
within-cluster pairs, so ~100% of across-pairs exceed the within-p05 and the
model looks broken for a reason unrelated to its quality. The number tracks the
clustering threshold, not the model.

**This report uses a label-free protocol.** Ground truth is temporal proximity:

* `NEAR` — windows 2 positions (4 s) apart, essentially always the same speaker.
* `FAR`  — windows ≥ 30 s apart, much more likely a different speaker.

A model with genuine speaker discrimination must score NEAR well above FAR.
The metric is `OVERLAP` = share of FAR pairs scoring above the NEAR p05; lower is
better. `d'` = (mean_near − mean_far) / pooled sd; higher is better.

The harness was rewritten (`examples/spk_separation.rs`) and now takes model
paths as arguments, so every candidate is measured identically in one process.
All numbers below were produced by the **shipped Rust pipeline**, and
cross-checked against an independent Python/onnxruntime implementation
(agreement within 0.1 percentage points).

## 2. Candidate table — measured on the real meeting, 192 windows

All four candidates were downloaded, run through the same Rust front end, and
timed on the same machine. `top-2 medoid sim` is the medoid similarity of the two
largest clusters — the metric the user's complaint is about (baseline 0.732).

| model | licence | OVERLAP ↓ | d' ↑ | top-2 medoid sim ↓ | ms/emb | size |
|---|---|---|---|---|---|---|
| **3D-Speaker ERes2Net-base (chosen)** | **Apache-2.0** | **82.2%** | **+0.705** | **0.536** | 79 | 38 MB |
| 3D-Speaker CAM++ | Apache-2.0 | 86.4% | +0.582 | 0.745 | 31 | 28 MB |
| hynt ResNet34 (was shipped) | unclear | 88.6% | +0.527 | 0.691 | 73 | 25 MB |
| WeSpeaker voxceleb ResNet34-LM | cc-by-4.0 | 90.0% | +0.458 | 0.740 | 72 | 25 MB |
| Orange Speaker-wavLM-pro | cc-by-sa-3.0 | 91.7% | +0.151 | 0.916 | 476 | 1267 MB |

Reproduce:

```bash
cd src-tauri
cargo run --release --example spk_separation            # bundled model
cargo run --release --example spk_separation -- <model.onnx> ...
```

### What each result means

* **ERes2Net wins on every axis** and is Apache-2.0. Overlap improves 6.4 points
  and d' improves 34% over the shipped hynt model, at comparable speed.
* **CAM++** is 2.5× faster and also Apache-2.0, but separates worse than
  ERes2Net. The lead's earlier rejection of CAM++ ("under-segmentation") was on
  a different metric; re-measured properly it is second-best, not best.
* **WeSpeaker ResNet34-LM** is the same architecture family as hynt and performs
  the same or slightly worse. Architecture was not the differentiator.
* **WavLM-pro was the worst model tested** (d' +0.151, medoid 0.916 — embeddings
  nearly collapsed) *and* 1.27 GB and 6× slower. It was eliminated on evidence,
  not on licence. **The 1.27 GB ONNX export was deleted from the repo.** Its
  licence is also cc-by-sa-3.0 (share-alike), which would have been a separate
  problem: share-alike is viral for a distributed app and would oblige us to
  license derivative work under the same terms. Not shipped.
* `yfyeung/wavlm-large-speaker-verification` was **dropped without measuring**:
  its HuggingFace repo declares **no licence at all**, which means all rights
  reserved by default. It is not redistributable, so it cannot be bundled
  regardless of quality.

## 3. Licensing position

| item | licence | shippable? |
|---|---|---|
| 3D-Speaker ERes2Net-base | **Apache-2.0** (confirmed on both the ModelScope model page and the `modelscope/3D-Speaker` GitHub repo) | **Yes**, attribution only |
| 3D-Speaker CAM++ | Apache-2.0 | Yes |
| pyannote/wespeaker-voxceleb-resnet34-LM | cc-by-4.0 | Yes, attribution |
| hynt ResNet34 (previously shipped) | **none declared** | **Already a latent problem** |
| Orange/Speaker-wavLM-pro | cc-by-sa-3.0 | Share-alike — avoided |
| yfyeung/wavlm-large-speaker-verification | **none** | **No** |

Note the swap also *improves* the licensing position: the previously shipped
hynt model declares no licence either, so the app was already redistributing a
model with no granted rights. ERes2Net removes that risk.

## 4. Honest limits — this is an improvement, not a fix

**Do not describe this to the user as "fixed".** The measured facts:

* At 82.2% overlap, the same-speaker and different-speaker similarity
  distributions still overlap almost completely. A working speaker-verification
  model on clean meeting audio lands under ~10% on this metric. There is no
  threshold that cleanly separates these two voices.
* The pairwise AUC between the largest speech segments is only **0.62**
  (ERes2Net) vs **0.59** (hynt) — 0.5 is chance. No model tested exceeded 0.62.
* At the new cut the meeting splits into **[100, 81]** windows instead of
  collapsing to one dominant cluster. That is the user-visible improvement, and
  it is why 0.55 was chosen — but the two clusters are not guaranteed to
  correspond to the two actual people.

The audio itself is the limiting factor: 402 s of near-continuous Vietnamese
speech, 96% of 2-second windows containing speech, and both dominant speakers
have f0 medians of ~117 Hz and ~125 Hz — barely distinguishable by pitch. With
~2 s of far-field audio per decision, this is close to the information limit for
speaker embedding.

Independent acoustic analysis (autocorrelation f0 + spectral centroid, no
embeddings) confirms both dominant segments occupy the same pitch band.

## 5. Changes made

| file | change |
|---|---|
| `src-tauri/models/speaker_eres2net_base.onnx` | new shipped model (Apache-2.0, 38 MB) |
| `src-tauri/src/diarize/embedding.rs` | `ModelSpec` abstraction (per-model tensor names, scaling, dim); metadata-driven fallback; per-path embedder cache |
| `src-tauri/src/diarize.rs` | thresholds re-derived for the new space |
| `src-tauri/examples/spk_separation.rs` | rewritten to the label-free protocol, multi-model |
| `src-tauri/tauri.conf.json` | bundle the new model |
| `build.sh` | require/verify the new model |
| `src-python/convert_spk_embedding_onnx.py` | conversion script for the PyTorch candidates (kept for reproducibility) |

### Bugs found and fixed along the way

1. **Embedder cache was keyed on nothing.** A single `OnceLock` meant whichever
   model loaded first won forever — pointing `DIARIZE_SPEAKER_MODEL` at a second
   model silently returned the *first* model's embeddings. Caught by comparing
   two models in one process; now keyed by `(path, threads)`.
2. **CAM++ was loaded as ERes2Net.** File-name-only matching sent a renamed
   3D-Speaker CAM++ export through the 512-d ERes2Net spec, so every window
   failed to embed. Now the ONNX `output_dim` / `normalize_samples` metadata is
   read, with a regression test.
3. **A documented "trap" was wrong.** `embedding.rs` claimed un-scaled input
   makes embeddings collapse to the log floor. True for *raw* fbank, but
   utterance CMN cancels the int16 scale exactly
   (`log(k·x) − mean(log(k·x)) = log(x) − mean(log(x))`); measured difference
   **7.6e-06**. The doc and a test now state the correct invariant.

## 6. Threshold derivation

Re-derived for the ERes2Net space (the old values were fit to hynt and, applied
unchanged, merged 184/192 windows into one speaker):

| constant | old (hynt) | new | basis |
|---|---|---|---|
| `DEFAULT_DISTANCE_THRESHOLD` | 0.45 | **0.55** | loosest cut still yielding two balanced clusters: 0.40 → [184,2,1…]; 0.55 → [100,81,3,3,2,1,1,1] |
| `MATCH_THRESHOLD` | 0.50 | **0.42** | just under same-speaker p50 (0.453), below different-speaker p95 (0.568) |
| `STRONG_MATCH_THRESHOLD` | 0.70 | **0.65** | above different-speaker max (0.727); lowered because this space compresses similarities (same p95 = 0.649) |
| `NEW_SPEAKER_SELF_SIM` | 0.55 | **0.35** | ~same-speaker p25 (0.313); 0.55 was above this space's same-speaker *median* and stranded new speakers |
| `MERGE_SIM_THRESHOLD` | 0.80 | 0.80 | unchanged — already above different-speaker max (0.727) |

The balance curve (near-kept vs far-merged) is essentially flat across
0.56–0.70, confirming there is no clean error minimum to fit; the values above
are documented judgement calls, not optima.

## 7. Verification

* `cargo test --lib` → **142 passed, 0 failed** (4 new tests in `embedding.rs`).
* `cargo build --release` and `--examples` clean.
* Rust vs Python parity on the same audio window: max absolute difference
  ~1e-6 across all 8 leading embedding components.
* Speed measured on the same machine, same 192 windows, same thread count.

## 8. Not verified / open items

* **No hand-labelled speaker turns exist for this file.** Every number here rests
  on the near/far temporal proxy. Silence-gap segmentation yields 194 "turns" of
  1–2 s — intra-sentence pauses, not speaker changes — so it could not supply
  real labels either. A ground truth would need manual annotation.
* **Python and frontend constants were NOT updated.** `src-python/diarize.py`
  (`MATCH_THRESHOLD` 0.50, `STRONG_MATCH_THRESHOLD` 0.70),
  `src-python/services/batch_diarizer.py` (`DEFAULT_DISTANCE_THRESHOLD` 0.45) and
  `src-python/local/model_registry.py` (still fetches
  `speaker_embedding_resnet34.onnx`) all still describe the old model. They are
  outside this task's write scope. `src-tauri/src/api/mod.rs` reads the Rust
  constants directly and is therefore already consistent.
* **Single meeting, single language.** One 6.7-minute Vietnamese recording. The
  ranking is solid for this failure mode; it is not a general benchmark.
* **WavLM was measured at 250-d**, the model's native output. No fine-tuning or
  pooling variants were explored.
* The threshold values are validated by cluster structure, not by confirmed
  speaker identity — they produce the expected two-cluster split but that split
  has not been checked against who actually spoke.
