#!/usr/bin/env python3
"""
Script test diarization offline.
Usage:
  python test_diarize.py                          # test mặc định 5s chunks, 90s
  python test_diarize.py --chunk 3                # test 3s chunks  
  python test_diarize.py --chunk 5 --max 120      # 5s chunks, 120s audio
  python test_diarize.py --wav /path/to/file.wav  # test file khác
"""
import argparse, wave, tempfile, os, time
from diarize import SpeakerDiarizer

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav", default=None, help="Path to WAV file")
    parser.add_argument("--chunk", type=int, default=5, help="Chunk size in seconds (default: 5)")
    parser.add_argument("--max", type=int, default=90, help="Max seconds to test (default: 90)")
    args = parser.parse_args()

    # Find WAV file
    wav = args.wav
    if not wav:
        for p in [
            "../test2222.wav",
            "../../test2222.wav",
            "../file_test.wav",
        ]:
            if os.path.exists(p):
                wav = p
                break
    if not wav or not os.path.exists(wav):
        print("❌ WAV file not found. Use --wav /path/to/file.wav")
        return

    print(f"📁 File: {wav}")
    print(f"⏱️  Chunk: {args.chunk}s | Max: {args.max}s")
    print()

    d = SpeakerDiarizer()
    with wave.open(wav, "rb") as wf:
        sr, ch, sw = wf.getframerate(), wf.getnchannels(), wf.getsampwidth()
        frames = wf.readframes(wf.getnframes())

    chunk_bytes = args.chunk * sr * ch * sw
    total = min(len(frames), args.max * sr * ch * sw)
    speakers_seen = set()
    results = []

    for i in range(0, total, chunk_bytes):
        chunk = frames[i : i + chunk_bytes]
        if len(chunk) < sr * ch * sw:
            break
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        with wave.open(tmp.name, "wb") as out:
            out.setnchannels(ch)
            out.setsampwidth(sw)
            out.setframerate(sr)
            out.writeframes(chunk)
        t0 = time.time()
        info = d.identify_speaker(tmp.name, update_profiles=True)
        dt = time.time() - t0
        os.unlink(tmp.name)

        s_start = (i // chunk_bytes) * args.chunk
        s_end = s_start + args.chunk
        speakers_seen.add(info["speaker_id"])
        results.append((s_start, s_end, info["speaker"], dt))

    print("=" * 50)
    print(f"{'Time':>10}  {'Speaker':>12}  {'Latency':>8}")
    print("-" * 50)
    for s, e, spk, dt in results:
        print(f"  {s:3d}s-{e:3d}s  {spk:>12}  {dt*1000:6.0f}ms")
    print("=" * 50)
    print(f"Total speakers: {len(speakers_seen)}")

if __name__ == "__main__":
    main()
