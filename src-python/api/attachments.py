"""Reference materials (knowledge) attached to a meeting.

Plain-text only — .md / .markdown / .txt. The content is fed to the LLM as
"Reference materials" alongside the transcript so the summary can cite
project-specific terminology, names, decisions from prior docs.

Routes:
  POST   /meetings/{meeting_id}/attachments         — upload one file
  GET    /meetings/{meeting_id}/attachments         — list (metadata only)
  GET    /meetings/{meeting_id}/attachments/{id}    — fetch full text
  DELETE /meetings/{meeting_id}/attachments/{id}    — remove

Limits (chosen to keep summary token-budget sane):
  - per-file:   200 KB (~50k tokens worst case)
  - per-meeting total: 800 KB across all attachments
  - allowed extensions: .md, .markdown, .txt
  - UTF-8 required (binary files rejected)
"""
from __future__ import annotations

import logging
import unicodedata
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from db import Database

log = logging.getLogger(__name__)
router = APIRouter()
db = Database()

MAX_FILE_BYTES = 200 * 1024            # 200 KB per file
MAX_TOTAL_BYTES_PER_MEETING = 800 * 1024  # 800 KB combined across attachments
MAX_FILES_PER_MEETING = 10
ALLOWED_EXTENSIONS = {".md", ".markdown", ".txt"}
# Pin a conservative read cap a hair above MAX_FILE_BYTES so the size check
# can still fire instead of silently truncating.
_READ_CAP = MAX_FILE_BYTES + 1024


def _sanitize_filename(name: str | None) -> str:
    """NFC normalize + strip path components + cap length.

    Mirrors upload_storage.sanitize_filename's contract so behaviour is
    consistent across audio + attachment uploads.
    """
    base = Path(name or "untitled").name.strip() or "untitled"
    nfc = unicodedata.normalize("NFC", base)
    # Drop control chars; SQLite is fine with the rest.
    cleaned = "".join(c for c in nfc if c.isprintable())
    return (cleaned or "untitled")[:200]


def _validate_extension(name: str) -> str:
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise ValueError(
            f"Định dạng không hỗ trợ ({ext or 'không có'}). "
            f"Chỉ chấp nhận: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )
    return ext


def _ensure_meeting(meeting_id: int) -> dict:
    meeting = db.get_meeting(meeting_id)
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return meeting


@router.post("/meetings/{meeting_id}/attachments")
async def upload_attachment(meeting_id: int, file: UploadFile = File(...)):
    _ensure_meeting(meeting_id)

    existing = db.list_attachments(meeting_id)
    if len(existing) >= MAX_FILES_PER_MEETING:
        raise HTTPException(
            status_code=409,
            detail=f"Đã đạt giới hạn {MAX_FILES_PER_MEETING} tài liệu cho mỗi cuộc họp",
        )

    safe_name = _sanitize_filename(file.filename)
    try:
        _validate_extension(safe_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Read with a hard cap so we can return 413 instead of OOMing on a huge file.
    raw = await file.read(_READ_CAP)
    if len(raw) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File quá lớn (giới hạn {MAX_FILE_BYTES // 1024} KB)",
        )

    total_existing = sum(int(a.get("size_bytes") or 0) for a in existing)
    if total_existing + len(raw) > MAX_TOTAL_BYTES_PER_MEETING:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Tổng dung lượng tài liệu vượt giới hạn "
                f"{MAX_TOTAL_BYTES_PER_MEETING // 1024} KB cho mỗi cuộc họp"
            ),
        )

    # UTF-8 only — md/txt are text formats; bytes that don't decode are a sign
    # of a wrongly-extensioned binary (e.g. .docx renamed to .txt).
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = raw.decode("utf-8-sig")  # tolerate BOM-prefixed files
        except UnicodeDecodeError:
            raise HTTPException(
                status_code=400,
                detail="File không phải UTF-8. Vui lòng lưu lại dưới định dạng UTF-8.",
            )

    if not text.strip():
        raise HTTPException(status_code=400, detail="File rỗng")

    mime = "text/markdown" if safe_name.lower().endswith((".md", ".markdown")) else "text/plain"

    attachment_id = db.add_attachment(
        meeting_id=meeting_id,
        filename=safe_name,
        mime_type=mime,
        size_bytes=len(raw),
        content_text=text,
    )
    log.info(
        "[attachments] added %s (%d bytes) to meeting %s",
        safe_name, len(raw), meeting_id,
    )
    return {
        "id": attachment_id,
        "meeting_id": meeting_id,
        "filename": safe_name,
        "mime_type": mime,
        "size_bytes": len(raw),
    }


@router.get("/meetings/{meeting_id}/attachments")
async def list_attachments(meeting_id: int):
    _ensure_meeting(meeting_id)
    items = db.list_attachments(meeting_id)
    total_bytes = sum(int(a.get("size_bytes") or 0) for a in items)
    return {
        "items": items,
        "total_bytes": total_bytes,
        "max_total_bytes": MAX_TOTAL_BYTES_PER_MEETING,
        "max_files": MAX_FILES_PER_MEETING,
        "max_file_bytes": MAX_FILE_BYTES,
    }


@router.get("/meetings/{meeting_id}/attachments/{attachment_id}")
async def get_attachment(meeting_id: int, attachment_id: int):
    _ensure_meeting(meeting_id)
    att = db.get_attachment(attachment_id)
    if not att or att["meeting_id"] != meeting_id:
        raise HTTPException(status_code=404, detail="Attachment not found")
    return att


@router.delete("/meetings/{meeting_id}/attachments/{attachment_id}")
async def delete_attachment(meeting_id: int, attachment_id: int):
    _ensure_meeting(meeting_id)
    ok = db.delete_attachment(attachment_id, meeting_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Attachment not found")
    return {"ok": True}
