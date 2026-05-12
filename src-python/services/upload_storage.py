"""Streaming write of uploaded audio file to disk + sha256 hash.

Cross-platform considerations:
  - Filename: NFC normalize, sanitize Windows-reserved chars, truncate ≤200 chars
  - Path: pathlib.Path everywhere (no os.path.join)
  - I/O: chunked 4MB writes — file ≤2GB never fully loaded into RAM
"""

import hashlib
import re
import unicodedata
from pathlib import Path
from typing import Awaitable, Callable

from fastapi import UploadFile


CHUNK_SIZE = 4 * 1024 * 1024  # 4MB
MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024  # 2GB

ALLOWED_EXTENSIONS: frozenset[str] = frozenset({
    ".mp3", ".wav", ".m4a", ".webm", ".ogg", ".oga",
    ".flac", ".aac", ".opus", ".wma",
    ".mp4", ".mov", ".mkv",
})

_WINDOWS_RESERVED_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitize_filename(original: str | None) -> str:
    """NFC normalize + strip dangerous chars + truncate. Never returns empty."""
    if not original:
        return "upload.bin"
    name = unicodedata.normalize("NFC", original)
    name = _WINDOWS_RESERVED_RE.sub("_", name)
    name = name.strip(". \t")
    if len(name) > 200:
        p = Path(name)
        suffix = p.suffix[:20]
        stem = p.stem[: 200 - len(suffix)]
        name = stem + suffix
    return name or "upload.bin"


def validate_extension(filename: str) -> str:
    """Return lowercased extension if supported; raise ValueError otherwise."""
    ext = Path(filename).suffix.lower()
    if not ext or ext not in ALLOWED_EXTENSIONS:
        raise ValueError(
            f"Unsupported audio/video format: '{ext or '(none)'}'. "
            f"Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )
    return ext


ProgressCallback = Callable[[int, int], Awaitable[None]]


async def stream_to_disk(
    upload: UploadFile,
    target_path: Path,
    on_progress: ProgressCallback | None = None,
    max_bytes: int = MAX_FILE_BYTES,
) -> tuple[int, str]:
    """Stream the uploaded file to disk while computing sha256.

    Args:
        upload: FastAPI UploadFile (multipart already parsed).
        target_path: Destination path. Parent directory will be created.
        on_progress: Optional async callback(chunk_bytes_written, total_bytes_so_far).
        max_bytes: Hard cap; raises ValueError when exceeded (file is cleaned up).

    Returns:
        (total_bytes_written, sha256_hex)

    Raises:
        ValueError: when the upload exceeds max_bytes.
    """
    target_path.parent.mkdir(parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    total = 0

    file_handle = target_path.open("wb")
    try:
        while True:
            chunk = await upload.read(CHUNK_SIZE)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ValueError(
                    f"Uploaded file exceeds the {max_bytes // (1024 * 1024)}MB limit"
                )
            hasher.update(chunk)
            file_handle.write(chunk)
            if on_progress:
                await on_progress(len(chunk), total)
    except Exception:
        file_handle.close()
        target_path.unlink(missing_ok=True)
        raise
    else:
        file_handle.close()

    return total, hasher.hexdigest()
