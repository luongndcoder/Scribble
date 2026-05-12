# Phase 2 — Audio Processing Pipeline

> Mục tiêu: Hoàn thiện pipeline xử lý file audio dài: normalize → VAD split → parallel STT → batch diarization (global clustering) → save chunks → trigger summarize.

**Thời gian:** 2.5 ngày
**Output:** `upload_pipeline.py`, `vad_splitter.py`, `batch_diarizer.py` — wire vào job upload từ Phase 1.

## Tổng quan flow

```
File uploaded (Phase 1)
    ↓
[1] ffprobe → lấy duration, validate audio stream
    ↓
[2] ffmpeg normalize → WAV PCM 16kHz mono (file tạm)
    ↓
[3] VAD split → list of (start_ms, end_ms, chunk_wav_path)
    Mỗi chunk 15-28s, overlap 1.5s với chunk trước
    ↓
[4] Parallel processing (Semaphore=3):
    ┌─── transcribe_nvidia(chunk) → text
    └─── extract_embedding(chunk) → vector 512-dim
    Emit SSE {type: 'chunk', text, idx} ngay khi mỗi chunk xong
    ↓
[5] Global speaker clustering (scipy AgglomerativeClustering):
    embeddings → labels [0, 1, 0, 2, 1, ...] → speaker_id
    ↓
[6] Merge chunk overlap → text final
    Dedupe phần overlap dùng longest-common-suffix
    ↓
[7] Persist vào DB:
    - meetings.transcript = full text
    - chunks: từng row (start_ms, end_ms, text, speaker_id)
    ↓
[8] Auto-summarize (gọi /summarize internally)
    ↓
Done → SSE emit {status: 'done'}
```

## File cần tạo mới

```
src-python/services/
  upload_pipeline.py     # Orchestrator (~300 dòng)
  vad_splitter.py        # Silero VAD wrapper for batch (~150 dòng)
  batch_diarizer.py      # Embedding extraction + global clustering (~200 dòng)
```

## 1. `vad_splitter.py` — VAD splitting với overlap

```python
"""Split long audio file into chunks using Silero VAD with overlap.

Khác với realtime VAD (stream-based), batch version:
  - Load full audio array vào memory (file 4h = ~460MB raw PCM, OK)
  - Tìm tất cả silence regions
  - Tạo chunks 15-28s, cố gắng cắt tại silence boundary
  - Overlap 1.5s với chunk trước → tránh mất chữ ở biên
"""
import wave
import numpy as np
from pathlib import Path
from dataclasses import dataclass

# Silero VAD đã load sẵn từ diarize module — KHÔNG load lại
# Hoặc lấy reference qua dependency injection

@dataclass
class AudioChunk:
    idx: int
    start_ms: int
    end_ms: int
    path: Path  # tmp WAV file path

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


# Tunable constants
CHUNK_TARGET_MS = 22_000   # 22s mục tiêu
CHUNK_MAX_MS = 28_000      # 28s tối đa (Riva offline limit ~30s)
CHUNK_MIN_MS = 8_000       # 8s tối thiểu (tránh chunk quá ngắn)
OVERLAP_MS = 1_500         # 1.5s overlap mỗi chunk
SILENCE_THRESHOLD_MS = 300 # 300ms silence được coi là boundary


def load_wav_mono16k(path: Path) -> tuple[np.ndarray, int]:
    """Load WAV PCM 16kHz mono → numpy array int16."""
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == 16000, f"Expected 16kHz, got {w.getframerate()}"
        assert w.getnchannels() == 1, f"Expected mono, got {w.getnchannels()}ch"
        frames = w.readframes(w.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16)
    return samples, 16000


def detect_voice_activity(
    samples: np.ndarray,
    sample_rate: int = 16000,
) -> list[tuple[int, int]]:
    """Detect voice regions using Silero VAD.

    Returns: list of (start_ms, end_ms) voice regions.
    """
    # Sử dụng silero VAD model — đã có trong project (xem stream_pipeline.py / diarize.py)
    # TODO Phase 2 implementation: gọi silero process_audio() trên batch
    # Tạm placeholder, để concrete impl trong code:
    raise NotImplementedError("Implement using existing silero VAD instance")


def split_into_chunks(
    wav_path: Path,
    tmp_dir: Path,
) -> list[AudioChunk]:
    """Main entry point: split file thành chunks với overlap.

    Strategy:
        1. Detect voice regions via VAD
        2. Walk through voice regions, accumulate đến CHUNK_TARGET_MS
        3. Khi accumulator >= CHUNK_TARGET_MS, tìm silence gần nhất để cắt
        4. Tạo overlap với chunk trước
        5. Write từng chunk ra file WAV riêng

    Note: nếu file toàn tiếng nói liên tục (không silence trong 28s):
        cắt cứng ở CHUNK_MAX_MS (chấp nhận có thể mất 1 từ biên)
    """
    samples, sr = load_wav_mono16k(wav_path)
    total_ms = len(samples) * 1000 // sr

    voice_regions = detect_voice_activity(samples, sr)
    if not voice_regions:
        # File toàn silence — return 1 chunk rỗng
        return []

    chunks: list[AudioChunk] = []
    current_start_ms = max(0, voice_regions[0][0] - 100)  # padding 100ms đầu
    cursor_ms = current_start_ms
    chunk_idx = 0

    # Build silence boundary index
    silence_points = _compute_silence_boundaries(voice_regions, total_ms)

    while cursor_ms < total_ms:
        target_end = cursor_ms + CHUNK_TARGET_MS
        max_end = min(cursor_ms + CHUNK_MAX_MS, total_ms)

        # Tìm silence boundary gần target_end (trong khoảng [cursor+MIN, max_end])
        cut_ms = _find_best_cut(
            silence_points,
            min_ms=cursor_ms + CHUNK_MIN_MS,
            target_ms=target_end,
            max_ms=max_end,
        )

        chunk_path = tmp_dir / f"chunk_{chunk_idx:04d}.wav"
        _write_wav_segment(samples, sr, cursor_ms, cut_ms, chunk_path)
        chunks.append(AudioChunk(
            idx=chunk_idx,
            start_ms=cursor_ms,
            end_ms=cut_ms,
            path=chunk_path,
        ))

        # Next chunk bắt đầu với overlap về phía trước
        cursor_ms = max(cursor_ms + 1, cut_ms - OVERLAP_MS)
        chunk_idx += 1

        if cut_ms >= total_ms - 500:
            break

    return chunks


def _compute_silence_boundaries(voice_regions, total_ms) -> list[int]:
    """Tính các milestone (ms) là midpoint của các đoạn silence."""
    boundaries = []
    prev_end = 0
    for start, end in voice_regions:
        silence_duration = start - prev_end
        if silence_duration >= SILENCE_THRESHOLD_MS:
            boundaries.append((prev_end + start) // 2)
        prev_end = end
    boundaries.append(total_ms)  # cuối file luôn là boundary
    return boundaries


def _find_best_cut(boundaries, min_ms, target_ms, max_ms) -> int:
    """Tìm boundary trong [min_ms, max_ms] gần target_ms nhất.

    Nếu không có boundary trong range → cut cứng tại max_ms.
    """
    candidates = [b for b in boundaries if min_ms <= b <= max_ms]
    if not candidates:
        return max_ms
    return min(candidates, key=lambda b: abs(b - target_ms))


def _write_wav_segment(samples, sr, start_ms, end_ms, out_path: Path):
    """Write slice của samples ra file WAV."""
    start = (start_ms * sr) // 1000
    end = (end_ms * sr) // 1000
    segment = samples[start:end]
    with wave.open(str(out_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(segment.tobytes())
```

## 2. `batch_diarizer.py` — Global speaker clustering

```python
"""Batch speaker diarization via global clustering.

Khác với BackgroundReconciler (streaming):
  - Extract embedding từng chunk → vector 512-dim
  - Sau khi xong toàn bộ file: cluster tất cả embeddings cùng lúc
  - Mỗi cluster = 1 speaker → assign global speaker_id
  - Speaker_id ổn định xuyên file, không bị "drift"

Dependencies:
  - scipy.cluster.hierarchy (đã có trong requirements)
  - ONNX CAM++ model (đã có trong project)
"""
import numpy as np
import onnxruntime as ort
from pathlib import Path
from dataclasses import dataclass
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.spatial.distance import cosine

# KHÔNG import sklearn — đã trong PyInstaller excludes


@dataclass
class SpeakerEmbedding:
    chunk_idx: int
    embedding: np.ndarray  # shape (512,)


class BatchDiarizer:
    """Stateless diarizer cho 1 job upload.

    Tạo instance mới mỗi job → không ô nhiễm state giữa các upload,
    không đụng vào BackgroundReconciler singleton của realtime flow.
    """

    def __init__(self, onnx_model_path: Path):
        # Load model RIÊNG cho job này — hoặc share session nhưng KHÔNG share state
        # CAM++ model nhẹ (~30MB) nên load mỗi job cũng OK
        self._session = ort.InferenceSession(
            str(onnx_model_path),
            providers=["CPUExecutionProvider"],
        )

    def extract_embedding(self, chunk_wav_path: Path) -> np.ndarray:
        """Extract 512-dim speaker embedding từ WAV chunk.

        Reuse logic _compute_fbank() pattern từ diarize.py nhưng đơn giản hơn:
        không cần realtime windowing.
        """
        # Tái dùng helper từ diarize module nếu có, hoặc duplicate logic
        # fbank features → onnx run → embedding
        from diarize import _compute_fbank_features_for_path  # cần expose helper
        fbank = _compute_fbank_features_for_path(chunk_wav_path)
        outputs = self._session.run(None, {"feats": fbank.astype(np.float32)})
        embedding = outputs[0].squeeze()
        # L2 normalize
        embedding = embedding / (np.linalg.norm(embedding) + 1e-9)
        return embedding

    def cluster_speakers(
        self,
        embeddings: list[SpeakerEmbedding],
        max_speakers: int = 8,
        distance_threshold: float = 0.4,
    ) -> dict[int, int]:
        """Cluster embeddings → {chunk_idx: speaker_id}.

        Dùng Agglomerative Clustering với cosine distance:
          - Distance < 0.4 → cùng speaker
          - Cap số speaker tối đa = 8 (heuristic chống over-segmentation)
        """
        if len(embeddings) == 0:
            return {}
        if len(embeddings) == 1:
            return {embeddings[0].chunk_idx: 0}

        # Build distance matrix
        X = np.stack([e.embedding for e in embeddings])
        # scipy linkage cần condensed distance matrix
        from scipy.spatial.distance import pdist
        dists = pdist(X, metric="cosine")
        Z = linkage(dists, method="average")
        labels = fcluster(Z, t=distance_threshold, criterion="distance")

        # Map cluster_id → ordered speaker_id (0, 1, 2, ...)
        # Speaker 0 = xuất hiện đầu tiên trong timeline
        seen: dict[int, int] = {}
        result: dict[int, int] = {}
        for emb, label in zip(embeddings, labels):
            if label not in seen:
                seen[label] = len(seen)
            speaker_id = seen[label]
            # Cap max speakers
            if speaker_id >= max_speakers:
                # Merge vào cluster gần nhất (rare case)
                speaker_id = max_speakers - 1
            result[emb.chunk_idx] = speaker_id

        return result
```

## 3. `upload_pipeline.py` — Orchestrator

```python
"""Pipeline xử lý file upload — wire vào job runner từ Phase 1.

Cancellation: check job.cancel_event ở mỗi giai đoạn lớn + giữa mỗi chunk.
Cleanup: tmp files xoá trong finally, kể cả khi cancel/fail.
"""
import asyncio
import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from db import db
from services.audio import find_ffmpeg
from services.job_registry import registry, JobStatus, JobState
from services.vad_splitter import split_into_chunks, AudioChunk
from services.batch_diarizer import BatchDiarizer, SpeakerEmbedding
from stt import transcribe_nvidia, get_language_code
from utils.text import filter_hallucinations  # nếu tách module

log = logging.getLogger(__name__)

# Concurrency cho STT call (Riva rate limit) — expose ra settings
STT_CONCURRENCY = 3

# Path tới ONNX model — reuse từ project
CAMPP_MODEL_PATH = Path(__file__).parent.parent / "models" / "voxceleb_CAM++.onnx"


async def run_pipeline(job_id: str):
    """Main pipeline. Gọi từ /meetings/upload-audio sau khi upload xong."""
    job = registry.get(job_id)
    if not job:
        log.error("Pipeline started for unknown job %s", job_id)
        return

    meeting = db.get_meeting(job.meeting_id)
    if not meeting:
        await registry.update(job_id, status=JobStatus.FAILED, error="Meeting not found")
        return

    source_path = Path(meeting["audio_path"])
    if not source_path.exists():
        await registry.update(job_id, status=JobStatus.FAILED, error="Audio file missing")
        return

    tmp_root = Path(tempfile.mkdtemp(prefix=f"upload_{job_id}_"))
    wav_path = tmp_root / "normalized.wav"
    chunks_dir = tmp_root / "chunks"
    chunks_dir.mkdir(exist_ok=True)

    try:
        # ── [1] ffprobe — validate + duration ──
        await registry.update(job_id, status=JobStatus.NORMALIZING, progress=0.05,
                              message="Đang phân tích file")
        duration_sec = await _ffprobe_duration(source_path)
        if duration_sec <= 0:
            raise ValueError("Invalid audio file")
        if duration_sec > 4 * 3600:
            raise ValueError(f"File too long ({duration_sec/3600:.1f}h), max 4h")
        db.update_meeting(job.meeting_id, audio_duration=duration_sec)

        # ── [2] Normalize ──
        if _check_cancel(job):
            return
        await registry.update(job_id, progress=0.1, message="Chuẩn hoá audio")
        await _normalize_audio(source_path, wav_path)

        # ── [3] VAD split ──
        if _check_cancel(job):
            return
        await registry.update(job_id, progress=0.15, message="Phát hiện đoạn nói")
        chunks = await asyncio.to_thread(split_into_chunks, wav_path, chunks_dir)
        if not chunks:
            raise ValueError("Không phát hiện được giọng nói trong file")
        await registry.update(job_id, total_chunks=len(chunks))

        # ── [4] Parallel STT + embedding ──
        await registry.update(job_id, status=JobStatus.TRANSCRIBING,
                              message=f"Phiên âm ({len(chunks)} chunks)")
        diarizer = BatchDiarizer(CAMPP_MODEL_PATH)
        chunk_results = await _process_chunks_parallel(job, chunks, diarizer)

        # ── [5] Global speaker clustering ──
        if _check_cancel(job):
            return
        await registry.update(job_id, status=JobStatus.FINALIZING, progress=0.85,
                              message="Phân loại người nói")
        embeddings = [
            SpeakerEmbedding(chunk_idx=r["idx"], embedding=r["embedding"])
            for r in chunk_results if r["embedding"] is not None
        ]
        speaker_map = await asyncio.to_thread(diarizer.cluster_speakers, embeddings)

        # ── [6] Merge overlap + persist ──
        if _check_cancel(job):
            return
        await registry.update(job_id, progress=0.92, message="Hoàn thiện transcript")
        merged = _merge_chunk_results(chunks, chunk_results, speaker_map)
        await _persist_to_db(job.meeting_id, merged, chunks, speaker_map)

        # ── [7] Auto-summarize ──
        await registry.update(job_id, progress=0.95, message="Tạo biên bản")
        try:
            await _auto_summarize(job.meeting_id)
        except Exception as e:
            log.warning("Auto-summarize failed for job %s: %s", job_id, e)
            # Không fail toàn job — user có thể bấm summarize lại từ UI

        # ── [8] Done ──
        db.update_meeting(job.meeting_id, status="saved")
        await registry.update(job_id, status=JobStatus.DONE, progress=1.0,
                              message="Hoàn thành")

    except asyncio.CancelledError:
        await registry.update(job_id, status=JobStatus.CANCELLED, error="Cancelled by user")
        db.update_meeting(job.meeting_id, status="cancelled")
        raise
    except Exception as e:
        log.exception("Pipeline failed for job %s", job_id)
        await registry.update(job_id, status=JobStatus.FAILED, error=str(e))
        db.update_meeting(job.meeting_id, status="failed")
    finally:
        # Cleanup tmp files
        import shutil
        shutil.rmtree(tmp_root, ignore_errors=True)


def _check_cancel(job: JobState) -> bool:
    """Trả True nếu job đã bị cancel."""
    if job.cancel_event.is_set():
        return True
    return False


async def _ffprobe_duration(path: Path) -> float:
    ffmpeg = find_ffmpeg()
    # Try ffprobe (thường cùng package với ffmpeg)
    ffprobe = ffmpeg.replace("ffmpeg.exe", "ffprobe.exe").replace("ffmpeg", "ffprobe")
    cmd = [ffprobe, "-v", "error", "-show_entries", "format=duration",
           "-of", "default=noprint_wrappers=1:nokey=1", str(path)]
    kwargs = {"capture_output": True, "timeout": 30}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    result = await asyncio.to_thread(subprocess.run, cmd, **kwargs)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.decode(errors='replace')[:200]}")
    return float(result.stdout.decode().strip() or "0")


async def _normalize_audio(source: Path, target: Path):
    """ffmpeg → WAV PCM 16kHz mono. Stream từ disk, không qua RAM."""
    ffmpeg = find_ffmpeg()
    cmd = [ffmpeg, "-y", "-i", str(source),
           "-vn",                # bỏ video stream (nếu là mp4)
           "-ar", "16000",
           "-ac", "1",
           "-f", "wav",
           str(target)]
    kwargs = {"capture_output": True, "timeout": 600}  # 10 phút cap cho file 4h
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    result = await asyncio.to_thread(subprocess.run, cmd, **kwargs)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode(errors='replace')[:300]}")


async def _process_chunks_parallel(
    job: JobState,
    chunks: list[AudioChunk],
    diarizer: BatchDiarizer,
) -> list[dict]:
    """Process chunks song song với semaphore.

    Mỗi chunk:
      - Gọi transcribe_nvidia() (block, run in thread)
      - Extract embedding (block, run in thread)
      - Emit SSE event {type: 'chunk', idx, text, start_ms, end_ms}
      - Update job.processed_chunks + progress (0.15 → 0.85)
    """
    sem = asyncio.Semaphore(STT_CONCURRENCY)
    nvidia_key = db.get_setting("nvidia_api_key") or os.environ.get("NVIDIA_API_KEY", "")
    stt_lang = db.get_setting("stt_language") or "vi"
    riva_lang = get_language_code(stt_lang)
    if not nvidia_key:
        raise RuntimeError("Nvidia API key chưa cấu hình")

    results: list[dict | None] = [None] * len(chunks)

    async def _process_one(chunk: AudioChunk):
        async with sem:
            if _check_cancel(job):
                return
            # STT + embedding song song trong threadpool
            stt_task = asyncio.to_thread(
                transcribe_nvidia, str(chunk.path), nvidia_key, riva_lang)
            emb_task = asyncio.to_thread(diarizer.extract_embedding, chunk.path)
            text, embedding = await asyncio.gather(stt_task, emb_task,
                                                    return_exceptions=True)

            text_ok = text if isinstance(text, str) else ""
            emb_ok = embedding if not isinstance(embedding, Exception) else None
            if isinstance(text, Exception):
                log.warning("STT failed chunk %d: %s", chunk.idx, text)
            if isinstance(embedding, Exception):
                log.warning("Embedding failed chunk %d: %s", chunk.idx, embedding)

            text_clean = filter_hallucinations(text_ok).strip()
            results[chunk.idx] = {
                "idx": chunk.idx,
                "text": text_clean,
                "embedding": emb_ok,
                "start_ms": chunk.start_ms,
                "end_ms": chunk.end_ms,
            }

            # Stream chunk text ra UI ngay
            await registry.emit_chunk(job.job_id, {
                "idx": chunk.idx,
                "text": text_clean,
                "start_ms": chunk.start_ms,
                "end_ms": chunk.end_ms,
            })

            # Update progress (0.15 → 0.85 range)
            done = sum(1 for r in results if r is not None)
            pct = 0.15 + (done / len(chunks)) * 0.7
            await registry.update(job.job_id, progress=pct,
                                  processed_chunks=done)

    await asyncio.gather(*[_process_one(c) for c in chunks])

    return [r for r in results if r is not None]


def _merge_chunk_results(
    chunks: list[AudioChunk],
    results: list[dict],
    speaker_map: dict[int, int],
) -> list[dict]:
    """Merge chunk results, dedupe overlap region.

    Algorithm:
      - Với mỗi cặp (chunk_i, chunk_i+1) overlap 1.5s
      - Tìm longest common substring giữa cuối text_i và đầu text_i+1
      - Cắt phần overlap khỏi text_i+1
    """
    merged = []
    prev_tail = ""
    for r in sorted(results, key=lambda x: x["idx"]):
        text = r["text"]
        if prev_tail and text:
            text = _strip_overlap(prev_tail, text)
        merged.append({
            "idx": r["idx"],
            "start_ms": r["start_ms"],
            "end_ms": r["end_ms"],
            "text": text,
            "speaker_id": speaker_map.get(r["idx"], 0),
        })
        prev_tail = text[-100:]  # giữ 100 ký tự cuối để check overlap với chunk sau
    return merged


def _strip_overlap(prev_tail: str, current: str) -> str:
    """Loại bỏ phần đầu của current trùng với prev_tail.

    Dùng longest common prefix between prev_tail's suffix và current's prefix.
    """
    max_check = min(len(prev_tail), len(current), 80)
    for k in range(max_check, 5, -1):
        if current[:k] == prev_tail[-k:]:
            return current[k:].lstrip()
    return current


async def _persist_to_db(meeting_id: int, merged: list[dict], chunks, speaker_map):
    """Lưu transcript đầy đủ vào DB.

    Format giống realtime để UI không cần biết source.
    """
    full_text = "\n".join(m["text"] for m in merged if m["text"])
    db.update_meeting(meeting_id, transcript=full_text)
    # Insert chunks row by row (cho UI edit/delete inline)
    for m in merged:
        if not m["text"]:
            continue
        db.insert_chunk(
            meeting_id=meeting_id,
            chunk_id=f"upload-{meeting_id}-{m['idx']}",
            text=m["text"],
            speaker_id=m["speaker_id"],
            speaker=f"Speaker {m['speaker_id'] + 1}",
            start_ms=m["start_ms"],
            end_ms=m["end_ms"],
        )


async def _auto_summarize(meeting_id: int):
    """Gọi summarize endpoint internally."""
    from api.transcription import summarize as summarize_handler
    from fastapi import Request
    # Hoặc gọi trực tiếp summarize_text() từ summarize.py
    from summarize import summarize_text
    meeting = db.get_meeting(meeting_id)
    if not meeting or not meeting.get("transcript"):
        return
    summary = await asyncio.to_thread(summarize_text, meeting["transcript"])
    db.update_meeting(meeting_id, summary=summary)
```

## 4. Wire vào Phase 1 endpoint

Sửa `api/upload.py` — sau khi upload xong gọi pipeline:

```python
# Thay placeholder "mark done" trong _do_upload() bằng:
await registry.update(job.job_id, message="Bắt đầu xử lý")
asyncio.create_task(run_pipeline(job.job_id))
```

`run_pipeline()` tự update status `done`/`failed`/`cancelled` khi xong.

## 5. Helper cần expose từ `diarize.py`

Để không patch logic cũ, thêm 1 helper public (chỉ thêm function mới):

```python
# Thêm vào diarize.py — không sửa class hiện có
def _compute_fbank_features_for_path(wav_path: Path) -> np.ndarray:
    """Public helper: load WAV → compute fbank features cho ONNX inference.

    Tách logic _compute_fbank() ra dạng standalone để BatchDiarizer reuse,
    không cần instantiate SpeakerDiarizer (tránh load duplicate ONNX session).
    """
    # Move logic từ SpeakerDiarizer._compute_fbank() ra đây
    # Hoặc wrap: tạo instance tạm, gọi method, trả features
    ...
```

## 6. Settings cần expose

Thêm vào Settings UI (Phase 3):

| Key | Default | Mô tả |
|-----|---------|-------|
| `feature_upload_audio_enabled` | `false` | Master switch |
| `upload_stt_concurrency` | `3` | Riva parallel calls |
| `upload_max_speakers` | `8` | Cap số speaker cluster |
| `upload_speaker_distance_threshold` | `0.4` | Cosine cluster threshold |

## 7. Cancellation strategy

- `cancel_event` set bởi `POST /jobs/{id}/cancel`
- Pipeline check ở mỗi step boundary (`_check_cancel`)
- Trong loop `_process_chunks_parallel`: check trước khi acquire semaphore
- Cleanup tmp_root trong `finally` đảm bảo không leak disk
- Riva gRPC call đang trong-flight: timeout 30s sẽ tự return, không kill được — chấp nhận chunk cuối chạy hết

## 8. Cross-platform considerations Phase 2

| Concern | Mitigation |
|---------|-----------|
| ffmpeg/ffprobe path khác nhau | `find_ffmpeg()`, derive `ffprobe` từ cùng dir |
| `subprocess.CREATE_NO_WINDOW` Windows | Đã có pattern, áp dụng cho tất cả call ffmpeg/ffprobe |
| Tmp dir | `tempfile.mkdtemp()` đã cross-platform |
| Path separator | `Path(...)` everywhere |
| File lock Windows (chunks_dir) | Đóng file handles trước khi cleanup → `shutil.rmtree(ignore_errors=True)` |
| ONNX runtime CPU provider | Đã dùng provider mặc định, không cần CUDA |

## 9. Acceptance criteria Phase 2

### Functional
- [ ] Upload mp3 5 phút → transcript đầy đủ, đúng tiếng Việt
- [ ] Upload mp4 30 phút (video) → audio được extract, transcript đầy đủ
- [ ] File 2 speaker → diarize đúng, không bị "drift"
- [ ] Stream SSE: text xuất hiện theo từng chunk, không phải chờ hết file
- [ ] Cancel giữa chừng → tmp files xoá hết, job status `cancelled`
- [ ] Lỗi STT 1 chunk → các chunk khác vẫn process, transcript thiếu chunk đó chứ không fail toàn job
- [ ] Auto-summarize chạy sau khi transcript xong → minutes hiển thị

### Cross-platform
- [ ] Test matrix 9 cells ([01-cross-platform-rules.md](./01-cross-platform-rules.md) §13)
- [ ] Trigger CI Windows + Linux build → green
- [ ] Install installer Windows + Linux → smoke test pass

### Regression
- [ ] Section A realtime recording vẫn pass 100%
- [ ] Section D sidecar lifecycle vẫn pass (BackgroundReconciler không bị ảnh hưởng)

### Performance
- [ ] File 1h trên macOS M2: tổng pipeline ≤8 phút (target 6 phút)
- [ ] File 1h trên Windows i5: ≤12 phút
- [ ] Memory peak <2GB suốt pipeline

### Code quality
- [ ] Không sửa logic file cũ ngoài (a) helper `_compute_fbank_features_for_path` thêm vào diarize.py, (b) register router
- [ ] Tất cả file mới ≤300 dòng (modularization)
- [ ] PR ≤700 dòng net new code
- [ ] Tag commit cuối phase: `phase-2-complete-upload`

## 10. Rủi ro phát hiện trong Phase 2 — verify sớm

1. **`scipy.cluster.hierarchy` có trong PyInstaller bundle?** Kiểm bằng `python -c "from scipy.cluster.hierarchy import linkage"` trong sidecar dist. Nếu thiếu, thêm `hiddenimports` vào spec.
2. **Silero VAD model API trong batch mode**: hiện tại đang dùng streaming. Verify model accept full waveform input.
3. **`_compute_fbank` của SpeakerDiarizer có thread-safe không?** Nếu không thread-safe → BatchDiarizer phải có lock hoặc copy logic ra hẳn.
4. **Riva offline rate limit thực tế**: 3 concurrent OK hay 429? Verify với key của user ngay đầu Phase 2.
