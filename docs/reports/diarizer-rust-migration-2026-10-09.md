# Rust diarizer migration — calibration and quality report (task-3)

Date: 2026-10-09
Audio: `/tmp/sale_campaign.wav` — real Vietnamese meeting, 401.6 s, 16 kHz mono,
6424917 samples, 200 non-overlapping 2 s windows (192 non-silent).

## What changed

The Rust path (`src-tauri/src/diarize.rs`, `src-tauri/src/diarize/`) replaces
`src-python/diarize.py`'s ONNX embedding path and
`src-python/services/batch_diarizer.py` entirely, removing the Python
`onnxruntime` and `scipy` dependencies.

The embedding model had to change. The previously bundled hynt
`speaker_embedding_resnet34.onnx` cannot be loaded by the `sherpa-onnx` crate:
the loader requires a `model_type` metadata field naming `wespeaker` /
`3d-speaker` / `nemo`, and that file declares no model type. Loading it fails at
`GetModelType`. The crate also owns the mel-filterbank front end, so the
hand-rolled Kaldi fbank in `diarize._compute_fbank` is no longer used.

**Every number below is therefore measured in a new embedding space. The old
thresholds do not transfer, even where the literal value is unchanged.**

## 1. Clustering port parity — EXACT

The Rust clustering was checked against the numpy reference
(`batch_diarizer._cosine_distance_matrix` / `_average_linkage` /
`_fcluster_distance`) on the *identical* 192 real embeddings.

Linkage matrix (191 merges) comparison:

| quantity | result |
|---|---|
| merge indices (`[a, b]` for all 191 merges) | **identical** |
| cluster sizes (column 4) | **identical** |
| max absolute distance difference | **3.24e-07** |

Flat partitions at 9 cut distances (0.25 → 0.65): **all 9 match exactly.**

This means the port is a faithful drop-in: any behavioural difference observed
below comes from the embedding change, not from the clustering code.

Rust unit tests (`src-tauri/src/diarize/clustering_tests.rs`): **26 passed**,
covering the same properties the Python suite documents (cosine definition and
normalisation, `n-1` monotonic merges, size growth, threshold monotonicity,
singleton/all-in-one cuts, planted-cluster recovery, temporal ID ordering,
`max_speakers` cap, degenerate inputs).

## 2. Embedding comparison

### 2a. Same model file, two runtimes — they do NOT agree

The new zh model run through Python/onnxruntime versus Rust/sherpa-onnx, same
192 windows, per-window cosine:

| | min | p25 | p50 | p75 | max |
|---|---|---|---|---|---|
| zh model, python vs sherpa | 0.168 | 0.509 | **0.556** | 0.598 | 0.678 |

The two runtimes disagree substantially on identical weights — the front ends
(fbank framing / CMN / input scaling) are not equivalent. This is a property of
the migration, not a defect in the port, and it means Python-measured
thresholds cannot be reused as-is.

### 2b. Different models

| model | dim | clusters at best cut | same p50 | diff p50 | diff p95 | diff max | sep gap | diff>same_p10 |
|---|---|---|---|---|---|---|---|---|
| hynt resnet34 (OLD, python) | 256 | 8 (capped) | 0.589 | 0.273 | 0.446 | 0.618 | 0.304 | — |
| zh cnceleb resnet34 (python) | 256 | 8 (capped) | 0.641 | 0.347 | 0.559 | 0.727 | 0.278 | — |
| **zh cnceleb resnet34 (sherpa)** | **256** | **6** | **0.722** | **0.436** | **0.627** | **0.750** | **0.279** | **0.078** |
| 3dspeaker eres2net base (sherpa) | 512 | 8 | 0.443 | 0.165 | 0.377 | 0.586 | 0.263 | 0.150 |
| wespeaker en voxceleb resnet34 (sherpa) | 256 | 2 | 0.824 | 0.590 | 0.847 | 0.934 | 0.222 | 0.290 |

`diff>same_p10` is the fraction of different-speaker pairs that score above the
same-speaker 10th percentile — lower is better. **The Chinese cnceleb ResNet34
wins on this Vietnamese audio** (0.078), and is the shipped default. The English
voxceleb model is unusable here: it collapses the meeting to 2 clusters and its
different-speaker p95 (0.847) exceeds its own same-speaker p50.

## 3. HONEST QUALITY ASSESSMENT — there is a regression

This is **not** a clean win. On this meeting the new path under-segments.

Uncapped cluster counts (no `max_speakers` cap):

| cut | hynt/python | zh/python | zh/sherpa (new) |
|---|---|---|---|
| 0.35 | 82 | 52 | 18 |
| 0.40 | 58 | 39 | 10 |
| 0.45 | 40 | 20 | **6** |
| 0.50 | 25 | 11 | 3 |
| 0.55 | 17 | 7 | 3 |

Largest single cluster at cut 0.45: **hynt 116/192**, zh/python 130/192,
**zh/sherpa 142/192 (74% of all speech windows)**.

The production entry point at the calibrated default (cut 0.45, cap 8):

| | speakers | structure |
|---|---|---|
| Python, hynt (OLD) | 8 | spk2 116 win / spk7 66 win + 6 small |
| Python, zh model | 8 | more fragmented |
| **Rust, zh/sherpa (NEW)** | **6** | spk0 **142 win (284 s)** + 5 small (1–26 win) |

Segment boundaries differ sharply. The Rust timeline holds speaker 0 for the
first 68 s straight; Python switches within the first 10 s:

```
rust  (zh/sherpa): [(0,0), (68,1), (70,2), (72,3), (74,0), (78,4), (80,0), ...]
python(hynt)     : [(0,0), (2,1), (4,2), (6,1), (8,2), (22,3), (24,2), ...]
python(zh)       : [(0,0), (28,1), (30,0), (68,2), (70,3), (72,4), ...]
```

**Interpretation.** At 2 s windows on conversational Vietnamese, the sherpa
front end produces embeddings that are mutually similar enough that 74% of the
meeting merges into one cluster at the cut where separation is otherwise
widest. Both Python variants resist this at the same cut. The task brief said
honest downgrade reporting is required — this is a downgrade in
speaker-resolution on this audio.

What is **not** claimed: that the four speakers are "really" four. The
uncapped counts (hynt 40 clusters, zh/python 20, sherpa 6, at cut 0.45) show
none of the three is producing a clean 2–5 speaker answer at that cut; the
Python numbers are also over-segmented. There is no ground-truth transcript for
this file in the repo, so the true speaker count for this meeting is **not
established by this report** and none of the three should be treated as correct
without listening.

## 4. Recalibrated thresholds (shipped in `diarize.rs`)

Measured on the sherpa/zh distribution above:

| constant | old (python/hynt) | new (sherpa/zh) | basis |
|---|---|---|---|
| `DEFAULT_DISTANCE_THRESHOLD` | 0.45 | **0.45** | just below the 0.50 collapse (6→3 clusters); widest separation (gap 0.279) |
| `MATCH_THRESHOLD` | 0.50 | **0.60** | same-speaker p10 0.605; excludes ~95% of different pairs (p95 0.627) |
| `STRONG_MATCH_THRESHOLD` | 0.70 | **0.75** | above different-speaker max 0.750 and same-speaker p50 0.722 |
| `MERGE_SIM_THRESHOLD` | 0.80 | **0.85** | space shifted upward; 0.80 would merge distinct speakers |
| `NEW_SPEAKER_SELF_SIM` | 0.55 | **0.65** | tracks same-speaker p25 0.665, above the 0.55 debris floor |
| `CONFIDENT_GAP` | 0.08 | **0.10** | widest observed different-speaker spread |

The cut distance is numerically unchanged but is a *different operating point*:
it was chosen from the new sweep, not inherited.

## 5. Performance

| step | time |
|---|---|
| 192-window diarization incl. embedding (Apple Silicon, 2 threads) | 29.8 s total |
| clustering only (192 embeddings → 191 merges) | 0.016 s |

Embedding dominates; the O(n³) agglomerative step is negligible at meeting scale.

## 6. Reproduction

```bash
# Rust (harness compiles the in-tree diarize module directly)
cd /tmp/diarharness && cargo build --release
./target/release/diarharness /tmp/sale_campaign.wav \
  /Users/luongcoder/Documents/AI/meeting-minutes/src-tauri/models/wespeaker_zh_cnceleb_resnet34.onnx \
  /tmp/diarout/rs_final.json

# Python baseline (old hynt model)
cd src-python && .venv/bin/python _tmp_baseline.py \
  /tmp/sale_campaign.wav /tmp/diarout/py_hynt.json

# Python baseline (new zh model — isolates model change from runtime change)
cd src-python && .venv/bin/python _tmp_baseline.py \
  /tmp/sale_campaign.wav /tmp/diarout/py_zh.json /tmp/spk2/zh_resnet34.onnx

# Port parity + distributions
cd /tmp/diarout && src-python/.venv/bin/python verify.py
```

Model shipped at `src-tauri/models/wespeaker_zh_cnceleb_resnet34.onnx` (26 MB,
dim 256, wespeaker zh-cn cnceleb ResNet34, `normalize_samples=0`). Override with
`DIARIZE_SPEAKER_MODEL=/path/to.onnx`.

## 7. Not verified / open items

1. **No ground truth.** Speaker counts are compared between implementations,
   not against a hand-labelled transcript. The "correct" number of speakers in
   this meeting is unknown to this report.
2. **No listening check** of the 142-window speaker-0 run — it may be genuine
   one-person dominance or a genuine under-segmentation error.
3. **Root cause of the front-end divergence** (cos 0.556 on identical weights)
   is not isolated to a specific stage (framing vs CMN vs scaling). Worth
   investigating, since fixing it might recover the Python-level separation
   without changing models.
4. **Other audio not tested.** All numbers are from this one 6.7-minute file.
5. **`src-tauri/src/lib.rs` not touched** (outside write scope). `cargo check
   --lib` currently fails on a teammate's in-flight `db.rs`/`rusqlite` work, so
   the module is not yet compiled into the Tauri lib. It must be wired in with
   `pub mod diarize;` by whoever owns `lib.rs`.
6. **Identification path** (`identify_speaker_from_samples`) is implemented and
   unit-tested for scoring logic, but not exercised end-to-end against real
   enrolment audio.

---

## 4. REGRESSION FIXED — model swap to CAM++ (lead, same day)

The report above shipped `wespeaker_zh_cnceleb_resnet34` and reported an honest
regression (6 speakers, 74% of windows in one cluster). That model has now been
replaced after direct measurement of four candidates on the same audio.

### Model comparison (2s windows, cut-distance sweep)

| model | dim | .30 | .40 | .50 | .60 | largest cluster @ .30/.40/.50 |
|---|---|---|---|---|---|---|
| zh_cnceleb_resnet34 | 256 | 12 | 2 | 1 | 1 | 95% / 100% / 100% |
| **CAM++ (CHOSEN)** | **192** | **67** | **19** | **7** | **1** | **61% / 89% / 93%** |
| eres2net_large | 512 | 161 | 67 | 24 | 8 | 13% / 58% / 87% |

- `zh_cnceleb` collapses to a single cluster at every usable cut — this IS the
  under-segmentation failure.
- `eres2net_large` separates better at low cuts but is **10x slower**
  (13.9s vs 1.4s for 60 windows) and over-fragments.
- CAM++ is the balance and is the fastest model tested.

### Final result on /tmp/sale_campaign.wav (shipped defaults)

| implementation | speakers | largest cluster | first speaker change |
|---|---|---|---|
| Python/hynt (old) | 8 | 116/192 = 60% | 2s |
| Rust/zh_cnceleb | 6 | 142/192 = 74% | 68s |
| **Rust/CAM++ (new)** | **8** | **96/192 = 50%** | **2s** |

Diarization runs in **4.4s** for the 6.7-minute meeting.

### Thresholds re-derived for CAM++ (sweep, 201 windows)

```
 cut   speakers  largest
 0.25     112       41%
 0.30      67       61%
 0.35      34       71%   <- chosen (DEFAULT_DISTANCE_THRESHOLD)
 0.45      11       92%
 0.55       2      100%   <- total collapse
```

`MATCH 0.55`, `STRONG 0.72`, `MERGE 0.80`, `NEW_SPEAKER_SELF_SIM 0.58`.

### Dead end recorded so nobody repeats it

Feeding **int16-scaled** samples to the sherpa extractor (mirroring the Python
Kaldi front end) makes things WORSE, not better. Measured on 40 real 2s windows,
consecutive-window cosine:

| input scale | mean | std |
|---|---|---|
| [-1, 1] (current) | 0.703 | **0.108** |
| int16-scale | 0.841 | 0.079 |

Higher mean and lower spread = embeddings more alike = more collapse. So the
Rust path deliberately feeds normalised audio; the Python path's int16 scaling
belonged to the hynt model, not to sherpa's front end.

### Still not verified

There is **no hand-labelled ground truth** for this meeting. The true speaker
count is unknown; 8 is plausible, not proven. Nobody has listened to the
segments. Treat the thresholds as a working default derived from one file.
