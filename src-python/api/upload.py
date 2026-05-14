"""Upload audio file endpoints — Phase 1 skeleton.

Routes:
  POST /meetings/upload-audio       — receive file, create meeting + job
  GET  /jobs/{job_id}               — poll job status (REST fallback)
  GET  /jobs/{job_id}/events        — SSE stream of job updates
  POST /jobs/{job_id}/cancel        — request cooperative cancellation

Phase 1 stops at "uploaded + persisted to disk + meeting record created".
Phase 2 will wire the audio pipeline (normalize → VAD → STT → diarize → summarize).
"""

import asyncio
import json
import logging
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from db import Database
from services.job_registry import JobStatus, registry
# Eagerly import the pipeline module at top-level (NOT inside the handler).
# Lazy-importing it on first upload triggered `db = Database()` at the
# pipeline module's load time — which used to reset the DB singleton's
# state and crash subsequent requests. The Database singleton is now
# idempotent, but keeping this import at module-load time is also the
# right default (no first-request import cost, no surprise side effects).
from services.upload_pipeline import run_pipeline
from services.upload_storage import (
    MAX_FILE_BYTES,
    sanitize_filename,
    stream_to_disk,
    validate_extension,
)

log = logging.getLogger(__name__)
router = APIRouter()

db = Database()

UPLOAD_FEATURE_FLAG_KEY = "feature_upload_audio_enabled"
SSE_HEARTBEAT_SECONDS = 25.0
DUPLICATE_ERROR_PREFIX = "DUPLICATE:"


def _feature_enabled() -> bool:
    # Default ON: shipped feature must work right after install (zero-setup
    # principle). The setting exists only as a dev/QA opt-out — set it to
    # "false"/"0"/"off"/"no" to disable.
    val = (db.get_setting(UPLOAD_FEATURE_FLAG_KEY) or "").strip().lower()
    return val not in ("0", "false", "no", "off")


def _upload_audio_dir() -> Path:
    from main import _voicescribe_data_dir

    target = _voicescribe_data_dir() / "audio" / "uploads"
    target.mkdir(parents=True, exist_ok=True)
    return target


@router.post("/meetings/upload-audio")
async def upload_audio(
    audio: UploadFile = File(...),
    title: str | None = Form(None),
    language: str = Form("vi"),
):
    """Receive audio/video upload, persist to disk synchronously, return job ref.

    Why synchronous (not background task): FastAPI cleans up UploadFile after
    the handler returns; reading from it in an asyncio.create_task() task is a
    use-after-free that surfaces as "I/O operation on closed file". The upload
    itself is local I/O — fast on localhost — so blocking the response until
    bytes hit disk is acceptable. Heavy pipeline work (normalize/STT/diarize)
    is the part that runs async via the job runner (Phase 2).
    """
    if not _feature_enabled():
        raise HTTPException(status_code=503, detail="Upload feature disabled")

    safe_name = sanitize_filename(audio.filename)
    try:
        ext = validate_extension(safe_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    meeting_title = (title or Path(safe_name).stem or "Uploaded audio").strip()
    meeting_id = db.create_meeting(
        title=meeting_title,
        transcript="",
        summary="",
        audio_duration=0.0,
        language=language,
        status="uploading",
    )
    db.update_meeting(meeting_id, source_type="upload", source_filename=safe_name)

    target_path = _upload_audio_dir() / f"upload_{meeting_id}{ext}"

    try:
        size, sha256 = await stream_to_disk(audio, target_path)
    except ValueError as exc:
        # 2GB cap exceeded — return 413 + rollback the half-created meeting
        target_path.unlink(missing_ok=True)
        db.delete_meeting(meeting_id)
        raise HTTPException(status_code=413, detail=str(exc))
    except Exception as exc:
        log.exception("[upload] streaming failed for meeting %s", meeting_id)
        target_path.unlink(missing_ok=True)
        db.delete_meeting(meeting_id)
        raise HTTPException(status_code=500, detail=f"Upload failed: {exc}")

    existing_id = db.find_meeting_by_hash(sha256)
    if existing_id and existing_id != meeting_id:
        # Idempotent: rollback the just-created blank meeting, create a job that
        # points to the EXISTING meeting and is immediately marked failed with
        # a DUPLICATE: marker so the frontend's SSE handler can redirect there.
        target_path.unlink(missing_ok=True)
        db.delete_meeting(meeting_id)
        job = registry.create(meeting_id=existing_id)
        await registry.update(
            job.job_id,
            status=JobStatus.FAILED,
            error=f"{DUPLICATE_ERROR_PREFIX}{existing_id}",
            message=f"File đã tồn tại trong meeting #{existing_id}",
        )
        return {"job_id": job.job_id, "meeting_id": existing_id}

    db.update_meeting(
        meeting_id,
        audio_path=str(target_path),
        file_hash=sha256,
    )

    job = registry.create(meeting_id=meeting_id)
    await registry.update(
        job.job_id,
        status=JobStatus.PENDING,
        message=f"Uploaded {size} bytes — bắt đầu xử lý",
    )

    # Pipeline reads from disk (target_path), not the UploadFile → no race
    # with FastAPI's request-scope cleanup. Safe to spawn after we return.
    asyncio.create_task(run_pipeline(job.job_id))

    return {"job_id": job.job_id, "meeting_id": meeting_id}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    job = registry.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict()


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str):
    """SSE stream of job updates. Closes when the job reaches a terminal state."""
    job = registry.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_gen():
        initial = {"type": "status", **job.to_dict()}
        yield f"data: {json.dumps(initial, ensure_ascii=False)}\n\n"

        terminal = {
            JobStatus.DONE.value,
            JobStatus.FAILED.value,
            JobStatus.CANCELLED.value,
        }
        if initial.get("status") in terminal:
            return

        while True:
            try:
                event = await asyncio.wait_for(
                    job.update_queue.get(), timeout=SSE_HEARTBEAT_SECONDS
                )
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event.get("type") == "status" and event.get("status") in terminal:
                    break
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
            except asyncio.CancelledError:
                break

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    ok = registry.cancel(job_id)
    if not ok:
        raise HTTPException(
            status_code=404, detail="Job not found or already finished"
        )
    return {"ok": True}


@router.post("/meetings/{meeting_id}/resume")
async def resume_upload(meeting_id: int):
    """Re-run the upload pipeline for a meeting that didn't finish.

    Use when a previous run was interrupted (sidecar restart, app quit,
    cancel, or transient STT failure). Persisted chunks in ``upload_chunks``
    are reused — only missing/empty chunks get re-transcribed.

    Returns {job_id, meeting_id} so the frontend can subscribe to the SSE
    progress stream the same way it does for a fresh upload.
    """
    meeting = db.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if (meeting.get("source_type") or "realtime") != "upload":
        raise HTTPException(
            status_code=400, detail="Only upload meetings can be resumed",
        )
    audio_path = (meeting.get("audio_path") or "").strip()
    if not audio_path or not Path(audio_path).is_file():
        raise HTTPException(
            status_code=410, detail="Original audio file missing on disk",
        )

    job = registry.create(meeting_id=meeting_id)
    await registry.update(
        job.job_id,
        status=JobStatus.PENDING,
        message="Tiếp tục xử lý",
    )
    asyncio.create_task(run_pipeline(job.job_id))

    return {"job_id": job.job_id, "meeting_id": meeting_id}
