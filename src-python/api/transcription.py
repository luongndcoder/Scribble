"""
Transcription API router — transcribe-diarize, translate, summarize endpoints.
"""

import asyncio
import json
import os
import tempfile
import time
from uuid import uuid4

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from db import Database
from logger import get_logger
from stt import transcribe_nvidia, get_language_code, HALLUCINATION_PATTERNS
import re

log = get_logger(__name__)
router = APIRouter()
db = Database()

# Shared diarizer — injected via set_diarizer()
_diarizer = None


def set_diarizer(d) -> None:
    global _diarizer
    _diarizer = d


def filter_hallucinations(text: str) -> str:
    for pattern in HALLUCINATION_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return ""
    if len(text.strip()) <= 3:
        return ""
    return text


@router.post("/transcribe-diarize")
async def transcribe_diarize(audio: UploadFile = File(...)):
    """Process audio chunk: transcribe and assign one stable speaker per chunk."""
    content = await audio.read()

    suffix = ".wav" if content[:4] == b"RIFF" else ".webm"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp_path = tmp.name
    try:
        tmp.write(content)
        tmp.flush()
        tmp.close()

        loop = asyncio.get_event_loop()
        stt_lang = db.get_setting("stt_language") or "vi"
        nvidia_key = db.get_setting("nvidia_api_key") or os.environ.get("NVIDIA_API_KEY", "")
        riva_lang = get_language_code(stt_lang)
        transcribe_task = loop.run_in_executor(None, transcribe_nvidia, tmp_path, nvidia_key, riva_lang)
        diarize_task = loop.run_in_executor(None, _diarizer.identify_speaker, tmp_path)

        results = await asyncio.gather(transcribe_task, diarize_task, return_exceptions=True)

        text = ""
        if isinstance(results[0], Exception):
            log.warning("[transcribe-diarize] STT error: %s", results[0])
        else:
            text = results[0] or ""

        if isinstance(results[1], Exception):
            log.warning("[transcribe-diarize] diarize error: %s", results[1])
            speaker_info = {"speaker": "Speaker 1", "speaker_id": 0}
        else:
            speaker_info = results[1]

        text = filter_hallucinations(text)
        if not text.strip():
            return {"text": "", "segments": [], "speakers": len(_diarizer._profiles)}

        speaker = speaker_info.get("speaker", "Speaker 1")
        speaker_id = speaker_info.get("speaker_id", 0)
        chunk_id = f"chunk-{int(time.time() * 1000)}-{uuid4().hex[:8]}"
        text = text.strip()

        return {
            "text": text,
            "chunk_id": chunk_id,
            "segments": [{"speaker": speaker, "speaker_id": speaker_id, "chunk_id": chunk_id, "text": text}],
            "speakers": len(_diarizer._profiles),
        }
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


@router.post("/translate")
async def translate(request: Request):
    body = await request.json()
    text = body.get("text", "")
    target_lang = body.get("targetLang", "en")

    if not text:
        return JSONResponse({"error": "No text"}, status_code=400)

    from translate import translate_stream
    return StreamingResponse(
        translate_stream(text, target_lang, db),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@router.post("/summarize")
async def summarize(request: Request):
    body = await request.json()
    meeting_id = body.get("meetingId")
    language = body.get("language", "vi")
    transcript = body.get("transcript")
    start_time = body.get("startTime", "")
    end_time = body.get("endTime", "")
    template = body.get("template", "mom")
    custom_prompt = body.get("customPrompt", "")

    if not transcript:
        if not meeting_id:
            return JSONResponse({"error": "No meetingId or transcript provided"}, status_code=400)
        meeting = db.get_meeting(meeting_id)
        if not meeting:
            return JSONResponse({"error": "Meeting not found"}, status_code=404)
        transcript = meeting["transcript"]

    if not transcript or not str(transcript).strip():
        return JSONResponse({"error": "Transcript is empty"}, status_code=400)

    transcript_str = str(transcript).strip()
    if transcript_str.startswith("["):
        try:
            parts = json.loads(transcript_str)
            lines = []
            for p in parts:
                if isinstance(p, dict):
                    speaker = p.get("speaker", "Speaker")
                    text_content = str(p.get("text", "")).strip()
                    if text_content:
                        lines.append(f"{speaker}: {text_content}")
            if lines:
                transcript_str = "\n".join(lines)
        except Exception:
            pass

    from summarize import summarize_stream
    return StreamingResponse(
        summarize_stream(transcript_str, language, db, start_time=start_time, end_time=end_time, template=template, custom_prompt=custom_prompt),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )
