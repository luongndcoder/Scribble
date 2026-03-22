"""
Meetings API router — CRUD for meetings, audio download, minutes export.
"""

import json
import tempfile
import wave as _wave
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, FileResponse, Response
from starlette.background import BackgroundTask

from db import Database
from logger import get_logger
from services.audio import transcode_audio_for_export, audio_media_type, safe_unlink
from services.minutes import normalize_minutes_markdown, markdown_to_docx

log = get_logger(__name__)
router = APIRouter()
db = Database()


def _voicescribe_data_dir() -> Path:
    import os
    env_dir = os.getenv("VOICESCRIBE_DATA")
    if env_dir:
        return Path(env_dir)
    db_path = getattr(db, "_db_path", None)
    if db_path:
        return Path(db_path).parent
    from pathlib import Path as _P
    return _P.home() / ".voicescribe"


@router.get("/meetings")
async def list_meetings():
    return db.get_all_meetings()


@router.post("/meetings")
async def create_meeting(request: Request):
    body = await request.json()
    mid = db.create_meeting(
        title=body.get("title", "Untitled"),
        transcript=json.dumps(body.get("transcript", [])) if isinstance(body.get("transcript"), list) else body.get("transcript", ""),
        summary=body.get("summary", ""),
        audio_duration=body.get("audioDuration", 0),
        language=body.get("language", "vi"),
    )
    return {"id": mid}


@router.get("/meetings/{meeting_id}")
async def get_meeting(meeting_id: int):
    m = db.get_meeting(meeting_id)
    if not m:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return m


@router.put("/meetings/{meeting_id}")
async def update_meeting(meeting_id: int, request: Request):
    body = await request.json()
    m = db.get_meeting(meeting_id)
    if not m:
        return JSONResponse({"error": "Not found"}, status_code=404)
    key_map = {
        "title": "title", "transcript": "transcript", "summary": "summary",
        "translations": "translations", "audioDuration": "audio_duration",
        "language": "language", "status": "status", "audioPath": "audio_path",
    }
    updates = {}
    for js_key, db_key in key_map.items():
        if js_key in body:
            val = body[js_key]
            if isinstance(val, list):
                val = json.dumps(val)
            updates[db_key] = val
    if updates:
        db.update_meeting(meeting_id, **updates)
    return {"ok": True}


@router.delete("/meetings/{meeting_id}")
async def delete_meeting(meeting_id: int):
    db.delete_meeting(meeting_id)
    return {"ok": True}


@router.get("/meetings/{meeting_id}/audio")
async def download_meeting_audio(meeting_id: int, format: str = "wav"):
    m = db.get_meeting(meeting_id)
    audio_path = (m.get("audio_path") or "") if m else ""
    source_path = Path(audio_path) if audio_path else None

    if source_path is None or not source_path.exists() or not source_path.is_file():
        audio_dir = _voicescribe_data_dir() / "audio"
        for ext in (".wav", ".mp4", ".m4a", ".mp3", ".webm", ".pcm"):
            candidate = audio_dir / f"meeting_{meeting_id}{ext}"
            if candidate.exists() and candidate.is_file():
                source_path = candidate
                if m:
                    try:
                        db.update_meeting(meeting_id, audio_path=str(candidate))
                    except Exception:
                        pass
                break

    if source_path is None or not source_path.exists() or not source_path.is_file():
        return JSONResponse({"error": "Audio not found"}, status_code=404)

    export_format = (format or "wav").strip().lower()
    if export_format not in {"wav", "mp4"}:
        return JSONResponse({"error": "format must be wav or mp4"}, status_code=400)

    export_path = source_path
    cleanup_task = None

    if source_path.suffix.lower() != f".{export_format}":
        # Fast path: PCM -> WAV using Python wave module (no ffmpeg)
        if source_path.suffix.lower() == ".pcm" and export_format == "wav":
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
            tmp_path = Path(tmp.name)
            tmp.close()
            try:
                pcm_data = source_path.read_bytes()
                with _wave.open(str(tmp_path), "wb") as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(16000)
                    wf.writeframes(pcm_data)
                export_path = tmp_path
                cleanup_task = BackgroundTask(safe_unlink, str(export_path))
            except Exception as e:
                safe_unlink(str(tmp_path))
                return JSONResponse({"error": f"PCM to WAV conversion failed: {e}"}, status_code=500)
        else:
            try:
                import asyncio
                export_path = await asyncio.to_thread(transcode_audio_for_export, source_path, export_format)
                cleanup_task = BackgroundTask(safe_unlink, str(export_path))
            except Exception as e:
                log.error("[meetings] Audio transcode failed: %s", e)
                return JSONResponse({"error": f"Audio convert to {export_format} failed"}, status_code=500)

    media_type = audio_media_type(export_path.suffix)
    return FileResponse(
        str(export_path),
        media_type=media_type,
        filename=f"meeting_{meeting_id}.{export_format}",
        background=cleanup_task,
    )


@router.get("/meetings/{meeting_id}/minutes")
async def download_meeting_minutes(meeting_id: int, format: str = "md"):
    m = db.get_meeting(meeting_id)
    if not m:
        return JSONResponse({"error": "Not found"}, status_code=404)

    summary = str(m.get("summary") or "").strip()
    if not summary:
        return JSONResponse({"error": "Minutes not found"}, status_code=404)

    language = str(m.get("language") or "vi")
    markdown = normalize_minutes_markdown(summary, language)
    if not markdown:
        return JSONResponse({"error": "Minutes not found"}, status_code=404)

    export_format = (format or "md").strip().lower()
    if export_format not in {"md", "docx"}:
        return JSONResponse({"error": "format must be md or docx"}, status_code=400)

    raw_title = str(m.get("title") or f"meeting-{meeting_id}").strip()
    safe_title = "".join(ch for ch in raw_title if ch not in '\\/:*?"<>|').strip() or f"meeting-{meeting_id}"

    if export_format == "md":
        return Response(
            content=markdown.encode("utf-8"),
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{safe_title}-minutes.md"'},
        )

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".docx")
    tmp_path = Path(tmp.name)
    tmp.close()
    try:
        markdown_to_docx(markdown, tmp_path)
    except ModuleNotFoundError:
        safe_unlink(str(tmp_path))
        return JSONResponse({"error": "python-docx is not installed"}, status_code=500)
    except Exception as e:
        safe_unlink(str(tmp_path))
        log.error("[meetings] DOCX export failed: %s", e)
        return JSONResponse({"error": "minutes export failed"}, status_code=500)

    return FileResponse(
        str(tmp_path),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=f"{safe_title}-minutes.docx",
        background=BackgroundTask(safe_unlink, str(tmp_path)),
    )
