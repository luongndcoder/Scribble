# Spike result: Rust diarizer via `sherpa-onnx` crate — NOT VIABLE (2026-10-09)

## Question
Can we drop the Python `onnxruntime` (64MB) + `scipy` (29MB) from the sidecar
bundle by moving speaker-embedding extraction to the Rust `sherpa-onnx` crate
(v1.13.8) already available on crates.io?

## Answer: No — blocked by the model artifact, not by our code.

## What was tested (real build, not documentation reading)

Probe crate `/tmp/spk_probe` (sherpa-onnx v1.13.8, `static` feature) that
loads the exact production model
`src-python/models/speaker_embedding_resnet34.onnx`.

Results:

| Attempt | Outcome |
| --- | --- |
| Load model as-is | `GetModelType:69 No model_type in the metadata!` |
| + `model_type=wespeaker` | `GetModelType:83 Unsupported model_type: pytorch` (framework key collides) |
| + `model_type=wespeaker`, no framework | back to "No model_type" — key ordering/validation rejects the combo |
| + `model_type=3d-speaker` / `nemo` (with/without `framework=onnx`) | same failures |

Binary string analysis of the compiled crate confirms the accepted set:

```
Expect a NeMo model, given: %s
Expect a wespeaker or a 3d-speaker model, given: %s
Unknown model type for speaker embedding extractor!
```

So the crate supports exactly: **wespeaker, 3d-speaker, nemo** (plus CAM++
via wespeaker tooling). The hynt model is a **custom WeSpeaker-style ResNet34
export** with a `(cos + 1) / 2` scoring convention and a `seg_1` projection
Gemm + mean-subtraction tail:

```
ReduceMean(axes=-1,keepdims=0)  → mean over time   ┐
ReduceMean(axes=-1,keepdims=1)  → std over time    ├─ statistics pooling
Flatten ×2 → Concat(axis=1)                        ┘
Gemm(transB=1, alpha=0, beta=0) on model.seg_1.*  → projection
Sub(..., mean_vec) → embs                          ← custom tail
```

That tail does not match the WeSpeaker/3D-Speaker/NeMo graph shapes the crate
validates, even after metadata is patched in.

## Consequence if we forced it anyway
We would have to **discard the hynt model** — the one calibrated on the user's
real Vietnamese meeting audio on 2026-10-09 (same-speaker p25 0.50 / diff max
0.51 → MATCH 0.50, batch distance 0.45), and revert to a generic WeSpeaker
model with ~2.3x worse EER on low-quality Vietnamese speech. That is a
functional regression to save 29MB (scipy) — and onnxruntime (64MB) would
still be needed for nothing else removed.

## What WOULD be viable — OPTION 1 DONE 2026-10-09
1. **Replace scipy with numpy** inside the existing Python diarizer.
   COMPLETED. All 4 call sites reimplemented in numpy:
     - `scipy.spatial.distance.pdist(metric="cosine")` → `_cosine_distance_matrix`
     - `scipy.cluster.hierarchy.linkage(method="average")` → `_average_linkage`
       (Lance-Williams UPGMA update, scipy label convention)
     - `scipy.cluster.hierarchy.fcluster(criterion="distance")` → `_fcluster_distance`
       (union-find cut at threshold)
     - `scipy.signal.resample` → `diarize.resample_fft` (same rfft/irfft algo)
   Verification against scipy's real output before removal:
     - 192 real meeting embeddings × 4 thresholds: partitions **ALL MATCH**
     - FFT resample vs scipy: maxdiff **1.2e-7** (float noise)
     - embeddings recomputed after scipy uninstall: **bit-identical**
     - built bundle boots + diarizer warm-up OK with scipy excluded
   Result: `scipy` removed from requirements + excluded from the bundle.
   Bundle: scipy directory gone (29MB → 0). New tests:
   `tests/test_diarizer_clustering.py` (17 parity/property tests) +
   a guard in `tests/test_bundle_excludes.py` that fails if any source file
   imports scipy again.
2. **Retrain/re-export the hynt model** with sherpa-onnx-compatible metadata
   AND a WeSpeaker-compatible tail. Out of scope — requires model ownership.
3. Accept the bundle size. onnxruntime is the unavoidable cost of on-device
   neural diarization.

## Artifacts
- Probe: `/tmp/spk_probe` (throwaway; not part of the repo)
- API correction learned: crate types are `SpeakerEmbeddingExtractor`
  (`::create`, not `::new`), `SpeakerEmbeddingExtractorConfig`,
  `SpeakerEmbeddingManager::create(dim)`; `compute()` returns
  `Option<Vec<f32>>` already owned.
