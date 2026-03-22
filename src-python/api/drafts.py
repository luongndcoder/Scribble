"""
Drafts API router — draft meeting creation and incremental transcript append.
"""

import json
from pathlib import Path

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import JSONResponse

from db import Database
from logger import get_logger

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
    return Path.home() / ".voicescribe"


@router.post("/drafts")
async def create_draft(request: Request):
    body = await request.json()
    mid = db.create_meeting(
        title=body.get("title", "Draft"),
        transcript="",
        summary="",
        audio_duration=0,
        language="vi",
        status="draft",
    )
    return {"id": mid}


@router.patch("/drafts/{draft_id}")
async def append_draft(draft_id: int, request: Request):
    body = await request.json()
    duration = body.get("audioDuration", 0)
    m = db.get_meeting(draft_id)
    if not m:
        return JSONResponse({"error": "Draft not found"}, status_code=404)

    part = body.get("part")
    append_text = body.get("appendText", "")

    current = m.get("transcript", "") or ""
    if part:
        try:
            parts = json.loads(current) if current.startswith("[") else []
        except Exception:
            parts = []

        replaced = False
        if parts and isinstance(parts[-1], dict):
            last = parts[-1]
            same_speaker = (
                str(last.get("speakerId", "")) == str(part.get("speakerId", ""))
                or str(last.get("speaker", "")) == str(part.get("speaker", ""))
            )
            same_start = str(last.get("startTime", "")) == str(part.get("startTime", ""))
            if same_speaker and same_start:
                merged = dict(last)
                merged.update(part)
                if isinstance(last.get("chunkIds"), list) and isinstance(part.get("chunkIds"), list):
                    ids = []
                    for cid in [*last.get("chunkIds", []), *part.get("chunkIds", [])]:
                        if isinstance(cid, str) and cid and cid not in ids:
                            ids.append(cid)
                    if ids:
                        merged["chunkIds"] = ids
                parts[-1] = merged
                replaced = True

        if not replaced:
            parts.append(part)
        db.update_meeting(draft_id, transcript=json.dumps(parts, ensure_ascii=False), audio_duration=duration)
    elif append_text:
        db.update_meeting(draft_id, transcript=current + "\n" + append_text, audio_duration=duration)
    return {"ok": True}


@router.patch("/drafts/{draft_id}/audio")
async def append_draft_audio(draft_id: int, audio: UploadFile = File(...)):
    m = db.get_meeting(draft_id)
    if not m:
        return JSONResponse({"error": "Draft not found"}, status_code=404)

    payload = await audio.read()
    if not payload:
        return {"ok": True, "bytes": 0}

    audio_path = (m.get("audio_path") or "").strip()
    if audio_path:
        existing_ext = Path(audio_path).suffix.lower()
        upload_ext = Path(audio.filename or "").suffix.lower() or ".webm"
        if existing_ext == ".pcm" and upload_ext != ".pcm":
            return {"ok": True, "bytes": 0, "skipped": "pcm_active"}
        target = Path(audio_path)
        target.parent.mkdir(parents=True, exist_ok=True)
    else:
        audio_dir = _voicescribe_data_dir() / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(audio.filename or "").suffix.lower() or ".webm"
        target = audio_dir / f"meeting_{draft_id}{suffix}"
        db.update_meeting(draft_id, audio_path=str(target))

    with target.open("ab") as f:
        f.write(payload)

    return {"ok": True, "bytes": len(payload), "audioPath": str(target)}
