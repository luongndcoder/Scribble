# Calibration report — hynt ResNet34 speaker embedding (interim, TTS-based)

Date: 2026-10-09. Status: INTERIM — final gate is calibration on real
Vietnamese meeting audio (user-provided). Code defaults UNCHANGED pending that.

## What changed before measuring

`SpeakerDiarizer._compute_fbank` rewritten to mirror `torchaudio kaldi.fbank`
operation-for-operation (per-frame DC removal → per-frame pre-emphasis 0.97
with replicate edge → symmetric Hamming → power spectrum → Kaldi-layout
triangular mel excluding Nyquist → log floor at float32 eps → utterance CMN).
Cross-validated against torchaudio 2.7.1 on real meeting audio:
**embedding cosine ours-vs-Kaldi = 0.9965** (was 0.8864 before the rewrite).

## Method (this report)

- 4 macOS TTS voices (Samantha, Daniel, Karen, Moira) × 3 utterances (~5s each)
- Conditions: clean + degraded (bandpass 300–3400Hz + brown noise, approximating
  the author's low-quality protocol)
- Embeddings via production path (`_embed_samples`); stats at utterance level
  AND at runtime 2s-window granularity

## Results (2s windows — runtime granularity)

| Condition | Same-speaker (cos sim) | Different-speaker (cos sim) |
|-----------|------------------------|------------------------------|
| clean | min 0.713, p10 0.749, p50 0.811 | p50 0.247, p90 0.489, max 0.605 |
| degraded | min 0.719, p10 0.747, p50 0.802 | p50 0.242, p90 0.523, max 0.649 |

Separable with a clear gap (diff max ~0.65 vs same min ~0.71).

## Real meeting audio (repo `data/audio/`, unlabeled)

- meeting_1 (457s): 228 windows; adjacent-window sim mean 0.60 vs random-pair
  mean 0.30 (continuity signal ✓); clustering settles into 1 dominant speaker
  (monologue-style content, not balanced conversation).
- meeting_3/4: same pattern (long single-speaker tail after busy intro).
- Conclusion: repo audio has no balanced multi-speaker conversation → cannot
  yield same/diff distributions without manual speaker-turn labels.

## Interim recommendation (to confirm on VI meeting audio)

- `DIARIZE_MATCH_THRESHOLD`: ~0.68 (midpoint of TTS gap; current default 0.65
  sits at the degraded diff-max edge — plausible but tight)
- `DIARIZE_DISTANCE_THRESHOLD` (batch): ~0.32–0.35, i.e. sim 0.65–0.68
- `STRONG_MATCH_THRESHOLD` 0.80: consistent with TTS same-min 0.71–0.88 ✓ keep
- Run: `python3 calibrate_diarize.py meeting.wav --labels labels.json`

## FINAL calibration — real VI meeting audio (2026-10-09)

Source: user-provided "Nghiep vu Sale Campaign" (6.7min, m4a → 16k mono).
Method: 4s-window clustering found 1 dominant speaker (pitch ~133–151Hz, 48
windows over 6min) + 1 secondary speaker cluster (10 windows, pitch ~155Hz,
centroid sim to dominant 0.401) → pseudo-labels A (dominant) / B (secondary).

Distributions (ResNet34, Kaldi-exact frontend):

| Granularity | Same-speaker cos sim | Different-speaker cos sim |
|-------------|----------------------|---------------------------|
| 4s windows | min 0.470, p10 0.628, p50 0.718 | p50 0.294, p90 0.383, max 0.478 |
| 2s windows (= runtime) | min -0.04, p10 0.395, p25 0.499, p50 0.574 | p50 0.236, p90 0.344, p95 0.376, max 0.510 |

Applied to code (defaults, all still env-overridable):

| Constant | Old (CAM++) | New | Evidence |
|----------|-------------|-----|----------|
| `DIARIZE_MATCH_THRESHOLD` | 0.65 | **0.50** | same p25 → ~75% first-shot match; diff p95 0.376 stays below |
| `STRONG_MATCH_THRESHOLD` | 0.80 | **0.70** | above diff max 0.51 with margin; top same-speaker band |
| `MERGE_SIM_THRESHOLD` | 0.94 | **0.80** | 0.94 never fired on hynt scores; 0.80 still ≫ diff max |
| `NEW_SPEAKER_SELF_SIM` | 0.70 | **0.55** | consecutive same-speaker 2s wins avg ~0.53; 0.70 stranded new speakers |
| `DIARIZE_DISTANCE_THRESHOLD` (batch) | 0.40 | **0.45** | = sim 0.55 ≈ same median, full diff range below |

Left untouched: switch/instant/gap margins (relative mechanics — need
behavioral A/B, not single-shot mapping), pitch/mouthprint/tone heuristics
(model-agnostic), `EMA_UPDATE_MIN_SIM` 0.50 (~75% update acceptance on data).

## Open items

1. Labeled VI meeting audio (user) → confirm/adjust the three values above.
2. ~~Model license: HF repo lists no explicit license — confirm with author (hynt)
   before public release containing the 27MB bundled ONNX.~~ RESOLVED
   2026-10-09: owner confirmed the app is free/non-commercial — risk accepted.
3. ~~ResNet293 on-demand path (`ensure_speaker_model`) — implemented, not yet
   exercised (needs GPU machine + 114MB download).~~ VERIFIED 2026-10-09:
   `ensure_speaker_model('resnet293')` downloaded 109MB, sha256 matched,
   session loads (feats/embs, 256-d), inference OK; `DIARIZE_MODEL=resnet293`
   and `campplus-legacy` (192-d rollback) both resolve. GPU-provider selection
   still untested (no CUDA machine).
