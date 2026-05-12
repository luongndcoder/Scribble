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
    val = (db.get_setting(UPLOAD_FEATURE_FLAG_KEY) or "").strip().lower()
    return val in ("1", "true", "yes", "on")


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
    """Accept an audio/video file, create a draft meeting + job, kick off async upload.

    Returns immediately with {job_id, meeting_id}. Progress is tracked via the
    /jobs endpoints. Phase 2 will continue the pipeline after the upload completes.
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

    job = registry.create(meeting_id=meeting_id)
    target_path = _upload_audio_dir() / f"upload_{meeting_id}{ext}"

    asyncio.create_task(_run_upload(job.job_id, meeting_id, audio, target_path, safe_name))

    return {"job_id": job.job_id, "meeting_id": meeting_id}


async def _run_upload(
    job_id: str,
    meeting_id: int,
    upload: UploadFile,
    target_path: Path,
    original_filename: str,
):
    """Background coroutine — stream upload to disk, validate, hash, persist."""
    await registry.update(
        job_id,
        status=JobStatus.UPLOADING,
        message="Receiving file",
    )

    async def _progress(_chunk_bytes: int, total: int):
        pct = min(0.2, (total / MAX_FILE_BYTES) * 0.2)
        await registry.update(job_id, progress=pct)

    try:
        size, sha256 = await stream_to_disk(upload, target_path, on_progress=_progress)
    except ValueError as exc:
        log.warning("[upload] size limit exceeded for job %s: %s", job_id, exc)
        target_path.unlink(missing_ok=True)
        db.delete_meeting(meeting_id)
        await registry.update(job_id, status=JobStatus.FAILED, error=str(exc))
        return
    except Exception as exc:
        log.exception("[upload] streaming failed for job %s", job_id)
        target_path.unlink(missing_ok=True)
        db.delete_meeting(meeting_id)
        await registry.update(job_id, status=JobStatus.FAILED, error=str(exc))
        return

    existing_id = db.find_meeting_by_hash(sha256)
    if existing_id and existing_id != meeting_id:
        target_path.unlink(missing_ok=True)
        db.delete_meeting(meeting_id)
        await registry.update(
            job_id,
            status=JobStatus.FAILED,
            error=f"{DUPLICATE_ERROR_PREFIX}{existing_id}",
            message=f"File đã tồn tại trong meeting #{existing_id}",
        )
        return

    db.update_meeting(
        meeting_id,
        audio_path=str(target_path),
        source_type="upload",
        source_filename=original_filename,
        file_hash=sha256,
    )

    # Phase 1 placeholder — Phase 2 will replace this with run_pipeline(job_id)
    await registry.update(
        job_id,
        status=JobStatus.DONE,
        progress=1.0,
        message=f"Uploaded {size} bytes (pipeline pending Phase 2)",
    )


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
