# Phase 1 — Backend Skeleton (Sidecar)

> Mục tiêu: Hạ tầng tối thiểu để nhận upload, track job, expose progress qua SSE. **Chưa** có pipeline xử lý audio (Phase 2).

**Thời gian:** 1.5 ngày
**Output:** API endpoints + job runner + DB migration + feature flag, **không động** file cũ ngoài 1 dòng register router.

## File cần tạo mới

```
src-python/
  api/
    upload.py              # POST /meetings/upload-audio, GET /jobs/{id}, SSE, cancel
  services/
    job_registry.py        # in-memory job state + cancel events
    upload_storage.py      # streaming write to disk, sha256 hash, size validation
```

## File cần sửa (CHỈ thêm dòng, không sửa logic cũ)

| File | Thay đổi | Dòng |
|------|---------|------|
| `src-python/main.py` | Import + register router upload | +2 dòng |
| `src-python/db.py` | Migration thêm 3 column nullable | +1 method |

## 1. DB migration (thêm vào `db.py`)

**Quy tắc**: Chỉ `ADD COLUMN` với DEFAULT, không alter type, không drop. Test mở meeting cũ vẫn được sau migration.

```python
# Thêm vào class Database, gọi từ init() sau _create_tables()
def _migrate_v2(self):
    """Idempotent migration: thêm column cho upload feature.

    Safe to run multiple times — SQLite ignores duplicate ADD COLUMN
    nhờ try/except.
    """
    conn = self._conn()
    migrations = [
        "ALTER TABLE meetings ADD COLUMN source_type TEXT DEFAULT 'realtime'",
        "ALTER TABLE meetings ADD COLUMN file_hash TEXT DEFAULT NULL",
        "ALTER TABLE meetings ADD COLUMN source_filename TEXT DEFAULT NULL",
    ]
    for sql in migrations:
        try:
            conn.execute(sql)
        except Exception as e:
            # Column đã tồn tại → bỏ qua
            if "duplicate column" not in str(e).lower():
                log.warning("Migration skipped: %s", e)
    conn.commit()
```

**Sửa `init()`**:
```python
def init(self, db_path: str | None = None):
    if self._initialized:
        return
    # ... code cũ ...
    self._create_tables()
    self._migrate_v2()  # ← thêm dòng này
    self._initialized = True
```

**Test sau migration**:
- [ ] Mở app với DB v1.1.4 → migration chạy → mở meeting cũ → `source_type` = `'realtime'`
- [ ] Restart app → migration không lặp (idempotent)
- [ ] Tạo meeting mới (realtime) → `source_type` vẫn `'realtime'`

## 2. Job registry (`services/job_registry.py`)

In-memory, không persist. Một job đại diện cho một file upload đang xử lý.

```python
"""In-memory job registry cho upload pipeline.

Job lifecycle:
  pending → uploading → normalizing → transcribing → finalizing → done
                                                                 ↓
                                                              failed | cancelled
"""
import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class JobStatus(str, Enum):
    PENDING = "pending"
    UPLOADING = "uploading"
    NORMALIZING = "normalizing"
    TRANSCRIBING = "transcribing"
    FINALIZING = "finalizing"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class JobState:
    job_id: str
    meeting_id: int
    status: JobStatus = JobStatus.PENDING
    progress: float = 0.0  # 0.0 → 1.0
    message: str = ""
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    # Concurrency primitives — không serialize
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    update_queue: asyncio.Queue = field(default_factory=asyncio.Queue)  # cho SSE

    # Chunk-level progress (Phase 2 emit)
    total_chunks: int = 0
    processed_chunks: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "meeting_id": self.meeting_id,
            "status": self.status.value,
            "progress": self.progress,
            "message": self.message,
            "error": self.error,
            "total_chunks": self.total_chunks,
            "processed_chunks": self.processed_chunks,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class JobRegistry:
    def __init__(self):
        self._jobs: dict[str, JobState] = {}
        self._lock = asyncio.Lock()

    def create(self, meeting_id: int) -> JobState:
        job_id = uuid.uuid4().hex
        job = JobState(job_id=job_id, meeting_id=meeting_id)
        self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> JobState | None:
        return self._jobs.get(job_id)

    async def update(self, job_id: str, **fields):
        async with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            for k, v in fields.items():
                if hasattr(job, k):
                    setattr(job, k, v)
            job.updated_at = time.time()
            # Push event vào queue cho SSE listener
            await job.update_queue.put(job.to_dict())

    async def emit_chunk(self, job_id: str, chunk_data: dict):
        """Phase 2 dùng để stream transcript từng chunk ra UI."""
        job = self._jobs.get(job_id)
        if not job:
            return
        await job.update_queue.put({"type": "chunk", **chunk_data})

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job:
            return False
        if job.status in (JobStatus.DONE, JobStatus.FAILED, JobStatus.CANCELLED):
            return False
        job.cancel_event.set()
        return True

    def cleanup_stale(self, max_age_seconds: int = 3600 * 24):
        """Xoá job đã kết thúc lâu hơn 24h khỏi memory."""
        now = time.time()
        to_delete = [
            jid for jid, j in self._jobs.items()
            if j.status in (JobStatus.DONE, JobStatus.FAILED, JobStatus.CANCELLED)
            and (now - j.updated_at) > max_age_seconds
        ]
        for jid in to_delete:
            del self._jobs[jid]


# Singleton — import từ chỗ khác
registry = JobRegistry()
```

## 3. Upload storage (`services/upload_storage.py`)

Streaming write file lên disk, hash, validate. Không load toàn bộ file vào RAM.

```python
"""Receive uploaded audio file as multipart stream → write to disk.

Cross-platform considerations:
  - Filename: normalize NFC, sanitize control chars + Windows-reserved chars
  - Path: pathlib.Path
  - I/O: chunked write (4MB), không load full file vào RAM
"""
import hashlib
import re
import unicodedata
from pathlib import Path
from fastapi import UploadFile

CHUNK_SIZE = 4 * 1024 * 1024  # 4MB
MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024  # 2GB
ALLOWED_EXTS = {
    ".mp3", ".wav", ".m4a", ".webm", ".ogg", ".oga", ".flac", ".aac",
    ".mp4", ".mov", ".mkv", ".wma", ".opus",
}


def sanitize_filename(original: str | None) -> str:
    """NFC normalize + remove dangerous chars + truncate."""
    if not original:
        return "upload.bin"
    name = unicodedata.normalize("NFC", original)
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    name = name.strip(". ")  # Windows không cho file kết thúc bằng . hoặc space
    if len(name) > 200:
        p = Path(name)
        stem = p.stem[: 200 - len(p.suffix)]
        name = stem + p.suffix
    return name or "upload.bin"


def validate_extension(filename: str) -> str:
    """Trả về extension nếu hợp lệ, raise ValueError nếu không."""
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTS:
        raise ValueError(f"Unsupported format: {ext}. Allowed: {sorted(ALLOWED_EXTS)}")
    return ext


async def stream_to_disk(
    upload: UploadFile,
    target_path: Path,
    on_progress=None,
) -> tuple[int, str]:
    """Stream upload xuống disk, trả về (size_bytes, sha256_hex).

    Args:
        upload: FastAPI UploadFile (đã được multipart parser xử lý)
        target_path: Path đích
        on_progress: optional async callback(bytes_written, total_bytes_so_far)

    Raises:
        ValueError: file quá lớn
    """
    target_path.parent.mkdir(parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    total = 0

    with target_path.open("wb") as f:
        while True:
            chunk = await upload.read(CHUNK_SIZE)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_FILE_SIZE:
                f.close()
                target_path.unlink(missing_ok=True)
                raise ValueError(f"File exceeds {MAX_FILE_SIZE} bytes limit")
            hasher.update(chunk)
            f.write(chunk)
            if on_progress:
                await on_progress(len(chunk), total)

    return total, hasher.hexdigest()
```

## 4. API endpoints (`api/upload.py`)

```python
"""Upload audio file endpoints — Phase 1 skeleton.

Phase 2 sẽ wire vào pipeline thật. Hiện tại job chỉ track upload progress,
sau khi upload xong thì mark 'done' (placeholder).
"""
import asyncio
import json
import logging
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse

from db import db
from services.job_registry import registry, JobStatus
from services.upload_storage import (
    stream_to_disk, sanitize_filename, validate_extension,
)

log = logging.getLogger(__name__)
router = APIRouter()


def _feature_enabled() -> bool:
    """Feature flag check."""
    val = db.get_setting("feature_upload_audio_enabled") or ""
    return val.lower() in ("1", "true", "yes", "on")


def _upload_audio_dir() -> Path:
    from main import _voicescribe_data_dir
    d = _voicescribe_data_dir() / "audio" / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.post("/meetings/upload-audio")
async def upload_audio(
    audio: UploadFile = File(...),
    title: str | None = Form(None),
    language: str = Form("vi"),
):
    """Receive uploaded audio file, create meeting + job, return IDs.

    Phase 1: chỉ upload + lưu disk + tạo meeting record. Pipeline xử lý
    sẽ thêm ở Phase 2.
    """
    if not _feature_enabled():
        raise HTTPException(status_code=503, detail="Upload feature disabled")

    # Sanitize filename + validate extension
    safe_name = sanitize_filename(audio.filename)
    try:
        ext = validate_extension(safe_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Tạo meeting record (status='uploading' để UI phân biệt)
    meeting_title = title or Path(safe_name).stem
    meeting_id = db.create_meeting(
        title=meeting_title,
        language=language,
    )
    db.update_meeting(
        meeting_id,
        status="uploading",
        # Phase 1: source_type + source_filename chưa wire vì update_meeting cũ
        # chưa biết 2 column này. Phase 1 sẽ mở rộng update_meeting() để accept.
    )

    # Create job
    job = registry.create(meeting_id=meeting_id)
    target_path = _upload_audio_dir() / f"upload_{meeting_id}{ext}"

    # Run upload trong background task (không block response)
    async def _do_upload():
        await registry.update(job.job_id, status=JobStatus.UPLOADING, message="Receiving file")
        try:
            async def _progress(chunk_size: int, total: int):
                # Progress chiếm 0% → 20% trong tổng pipeline
                pct = min(0.2, (total / (2 * 1024 * 1024 * 1024)) * 0.2)
                await registry.update(job.job_id, progress=pct)

            size, sha256 = await stream_to_disk(audio, target_path, on_progress=_progress)

            # Idempotency check
            existing_id = db.find_meeting_by_hash(sha256)
            if existing_id and existing_id != meeting_id:
                # Đã upload trước → xoá meeting mới + file, trả lỗi đặc biệt
                target_path.unlink(missing_ok=True)
                db.delete_meeting(meeting_id)
                await registry.update(
                    job.job_id,
                    status=JobStatus.FAILED,
                    error=f"DUPLICATE:{existing_id}",
                    message=f"File đã tồn tại trong meeting #{existing_id}",
                )
                return

            db.update_meeting(
                meeting_id,
                audio_path=str(target_path),
                source_type="upload",
                source_filename=safe_name,
                file_hash=sha256,
            )
            # Phase 1 stub: mark done ngay sau upload (Phase 2 sẽ wire pipeline)
            await registry.update(
                job.job_id,
                status=JobStatus.DONE,
                progress=1.0,
                message=f"Uploaded {size} bytes (pipeline pending Phase 2)",
            )
        except Exception as e:
            log.exception("Upload failed for job %s", job.job_id)
            target_path.unlink(missing_ok=True)
            await registry.update(
                job.job_id,
                status=JobStatus.FAILED,
                error=str(e),
            )

    asyncio.create_task(_do_upload())

    return {
        "job_id": job.job_id,
        "meeting_id": meeting_id,
    }


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    """Poll job status (alternative to SSE)."""
    job = registry.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict()


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str):
    """SSE stream: emit job updates real-time."""
    job = registry.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_gen():
        # Emit current state ngay
        yield f"data: {json.dumps(job.to_dict())}\n\n"
        # Stream updates from queue
        while True:
            try:
                event = await asyncio.wait_for(job.update_queue.get(), timeout=30)
                yield f"data: {json.dumps(event)}\n\n"
                # Đóng stream khi job kết thúc
                if event.get("status") in ("done", "failed", "cancelled"):
                    break
            except asyncio.TimeoutError:
                # Heartbeat để giữ connection
                yield ": heartbeat\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    """Request cancel — pipeline sẽ check cancel_event và abort gracefully."""
    ok = registry.cancel(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Job not found or already finished")
    return {"ok": True}
```

## 5. DB helper methods cần thêm vào `db.py`

```python
# Thêm vào class Database
def find_meeting_by_hash(self, file_hash: str) -> int | None:
    """Idempotency check — trả về meeting_id nếu đã có file hash này."""
    if not file_hash:
        return None
    conn = self._conn()
    cur = conn.execute(
        "SELECT id FROM meetings WHERE file_hash = ? LIMIT 1",
        (file_hash,),
    )
    row = cur.fetchone()
    return row[0] if row else None

def delete_meeting(self, meeting_id: int) -> None:
    """Xoá meeting + chunks (cho rollback khi idempotency match)."""
    conn = self._conn()
    conn.execute("DELETE FROM chunks WHERE meeting_id = ?", (meeting_id,))
    conn.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
    conn.commit()
```

**Mở rộng `update_meeting`** để accept `source_type`, `source_filename`, `file_hash`:
- Hiện tại đã dùng `**kwargs` style (xem source) → có thể chỉ cần verify column whitelist không loại bỏ các field mới.

## 6. Register router (sửa `main.py`)

```python
# Tìm chỗ đang register routers (giống meetings, drafts, settings, transcription, diagnose)
# Thêm 2 dòng:
from api.upload import router as upload_router
app.include_router(upload_router, tags=["upload"])
```

## 7. Feature flag default

Khi sidecar khởi động lần đầu, KHÔNG set `feature_upload_audio_enabled`. User phải bật thủ công qua Settings hoặc dev mode set DB.

Để bật cho dev test:
```bash
sqlite3 ~/.voicescribe/voicescribe.db \
  "INSERT OR REPLACE INTO settings (key, value) VALUES ('feature_upload_audio_enabled', 'true')"
```

## 8. Test sau Phase 1

### Unit / Manual smoke
- [ ] Curl upload file mp3 5MB → trả `{job_id, meeting_id}`
- [ ] `GET /jobs/{job_id}` → status progress từ `uploading` → `done`
- [ ] SSE `GET /jobs/{job_id}/events` → nhận stream events đến `done`
- [ ] Cancel job đang upload → status `cancelled`
- [ ] Upload cùng file 2 lần → lần 2 trả `error=DUPLICATE:<old_id>`
- [ ] File >2GB → trả error 400 hoặc cancel job
- [ ] File extension không hợp lệ (.txt) → trả 400
- [ ] Filename tiếng Việt có dấu → lưu disk NFC, không vỡ
- [ ] Feature flag off → endpoint trả 503

### Regression (chạy [02-regression-checklist.md](./02-regression-checklist.md))
- [ ] Section A toàn bộ pass (realtime recording không vỡ)
- [ ] Section B B1, B2 pass (meeting history mở meeting cũ + meeting upload mới đều OK)

### Cross-platform
- [ ] macOS dev: smoke test pass
- [ ] Trigger CI Windows + Linux build → green
- [ ] Install installer Windows + Linux trong VM → curl smoke test pass

## 9. Acceptance criteria Phase 1

- [ ] Tất cả file mới được tạo, không file cũ bị sửa logic
- [ ] DB migration idempotent, không phá DB v1.1.4
- [ ] Feature flag default OFF
- [ ] Regression checklist Section A + B pass
- [ ] 3 OS smoke test pass
- [ ] PR ≤500 dòng net new code
- [ ] Tag commit cuối phase: `phase-1-complete-upload`
