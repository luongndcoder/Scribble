"""Calibrate diarization thresholds for the hynt ResNet embedding models.

Usage:
    cd src-python
    python3 calibrate_diarize.py meeting.wav [--labels labels.json]
                                            [--window-ms 2000]
                                            [--model resnet34]

labels.json: [{"start_ms": 0, "end_ms": 45000, "speaker": "A"}, ...]
(speaker = arbitrary label; only equality matters)

Without --labels: prints embedding stats + adjacent-window similarity
summary (sanity check that the model separates at all).

With --labels: prints same-speaker vs different-speaker cosine-similarity
distributions (percentiles) + suggested thresholds for:
  - DIARIZE_MATCH_THRESHOLD (streaming, diarize.py)
  - DIARIZE_DISTANCE_THRESHOLD (batch clustering, services/batch_diarizer.py)

Audio must be 16kHz mono WAV (use ffmpeg to convert: ffmpeg -i in.m4a
-ar 16000 -ac 1 out.wav). Windows are 2s non-overlapping; near-silence
windows are skipped (same RMS gate as the batch diarizer).
"""

from __future__ import annotations

import argparse
import json
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from diarize import SpeakerDiarizer, resample_fft  # noqa: E402
from services.batch_diarizer import _embed_samples, _ensure_session  # noqa: E402
from services.batch_diarizer import FINE_SILENCE_RMS  # noqa: E402


def load_wav_16k_mono(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        nch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sw == 2:
        pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        pcm = (np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0)
    else:
        raise ValueError(f"unsupported sampwidth {sw} (need 16/32-bit WAV)")
    if nch > 1:
        pcm = pcm.reshape(-1, nch).mean(axis=1)
    if sr != 16000:
        pcm = resample_fft(pcm, int(len(pcm) * 16000 / sr))
    # DC removal + peak normalize to [-1, 1] (same contract as _compute_fbank input)
    pcm = pcm - np.mean(pcm)
    peak = float(np.max(np.abs(pcm)))
    if peak > 0:
        pcm = (pcm / peak * 0.95).astype(np.float32)
    return pcm


def embed_windows(diarizer: SpeakerDiarizer, samples: np.ndarray, window_ms: int):
    sr = 16000
    win = int(window_ms / 1000.0 * sr)
    out: list[tuple[int, int, np.ndarray]] = []
    for start in range(0, len(samples) - win + 1, win):
        seg = samples[start:start + win]
        if float(np.sqrt(np.mean(seg ** 2))) < FINE_SILENCE_RMS:
            continue
        emb = _embed_samples(diarizer, seg)
        if emb is None:
            continue
        out.append((int(start / sr * 1000), int((start + win) / sr * 1000), emb))
    return out


def window_speaker(start_ms: int, end_ms: int, labels) -> str | None:
    best, best_ov = None, 0
    for lab in labels:
        ov = min(lab["end_ms"], end_ms) - max(lab["start_ms"], start_ms)
        if ov > best_ov:
            best, best_ov = lab["speaker"], ov
    return best


def pct(a: np.ndarray, qs=(5, 25, 50, 75, 95)):
    return {f"p{q}": round(float(np.percentile(a, q)), 4) for q in qs}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav", type=Path)
    ap.add_argument("--labels", type=Path, default=None)
    ap.add_argument("--window-ms", type=int, default=2000)
    ap.add_argument("--model", default="resnet34")
    args = ap.parse_args()

    import os
    os.environ["DIARIZE_MODEL"] = args.model

    diarizer = SpeakerDiarizer()
    if not _ensure_session(diarizer):
        print("ERROR: could not load embedding model", file=sys.stderr)
        return 1
    print(f"model={diarizer._model_id} dim={diarizer._emb_dim} "
          f"in={diarizer._in_name} out={diarizer._out_name}")

    samples = load_wav_16k_mono(args.wav)
    print(f"audio={args.wav} duration={len(samples) / 16000:.1f}s")
    windows = embed_windows(diarizer, samples, args.window_ms)
    print(f"speech windows: {len(windows)} x {args.window_ms}ms")
    if len(windows) < 2:
        print("not enough speech windows", file=sys.stderr)
        return 1

    mat = np.stack([w[2] for w in windows])
    # Adjacent-window similarities (sanity: speech continuity signal)
    adj = [float(mat[i] @ mat[i + 1]) for i in range(len(mat) - 1)]
    adj = np.array(adj)
    print("adjacent-window cosine sim: "
          f"mean={adj.mean():.4f} std={adj.std():.4f} "
          f"min={adj.min():.4f} max={adj.max():.4f}")

    if args.labels is None:
        print("tip: re-run with --labels labels.json for threshold suggestions")
        return 0

    labels = json.loads(args.labels.read_text(encoding="utf-8"))
    tagged = [(s, e, window_speaker(s, e, labels), emb) for s, e, emb in windows]
    tagged = [t for t in tagged if t[2] is not None]
    speakers = sorted({t[2] for t in tagged})
    print(f"labeled windows: {len(tagged)} speakers: {speakers}")
    if len(speakers) < 2:
        print("need >= 2 distinct speakers in labels", file=sys.stderr)
        return 1

    same, diff = [], []
    for i in range(len(tagged)):
        for j in range(i + 1, len(tagged)):
            sim = float(tagged[i][3] @ tagged[j][3])
            (same if tagged[i][2] == tagged[j][2] else diff).append(sim)
    same, diff = np.array(same), np.array(diff)
    print(f"pairs: same={len(same)} diff={len(diff)}")
    print("same-speaker sim:", pct(same))
    print("different-speaker sim:", pct(diff))

    # Suggested thresholds: MATCH sits between the bulk of the two
    # distributions; batch distance mirrors it (distance = 1 - sim).
    lo = float(np.percentile(same, 10))
    hi = float(np.percentile(diff, 90))
    if lo > hi:
        match = round((lo + hi) / 2, 3)
        print(f"SUGGEST DIARIZE_MATCH_THRESHOLD={match} "
              f"(same p10={lo:.3f} / diff p90={hi:.3f})")
        print(f"SUGGEST DIARIZE_DISTANCE_THRESHOLD={round(1 - match, 3)}")
        print(f"SUGGEST MERGE check: same p50={float(np.percentile(same, 50)):.3f} "
              f"(compare with current DIARIZE_MERGE_SIM_THRESHOLD)")
    else:
        print("WARNING: distributions overlap (same p10 <= diff p90) — "
              "model/thresholds cannot separate these speakers cleanly; "
              "collect more audio or check label quality")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
