"""
Audio services — ffmpeg utilities, PCM conversion, media type helpers.
"""

import os
import subprocess
import tempfile
from pathlib import Path

from logger import get_logger

log = get_logger(__name__)


def find_ffmpeg() -> str:
    """Find ffmpeg binary, searching common locations on macOS/Linux/Windows."""
    import shutil
    import sys as _sys

    found = shutil.which("ffmpeg")
    if found:
        return found

    # Check next to the running sidecar executable (PyInstaller bundle)
    exe_dir = Path(_sys.executable).parent
    for name in ("ffmpeg.exe", "ffmpeg"):
        candidate = exe_dir / name
        if candidate.is_file():
            return str(candidate)

    if _sys.platform == "win32":
        win_candidates = [
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "ffmpeg" / "bin" / "ffmpeg.exe",
            Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "ffmpeg" / "bin" / "ffmpeg.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "ffmpeg" / "bin" / "ffmpeg.exe",
            Path(r"C:\ProgramData\chocolatey\bin\ffmpeg.exe"),
            Path.home() / "scoop" / "apps" / "ffmpeg" / "current" / "bin" / "ffmpeg.exe",
            Path.home() / "scoop" / "shims" / "ffmpeg.exe",
        ]
        for c in win_candidates:
            try:
                if c.is_file():
                    return str(c)
            except Exception:
                pass
        raise FileNotFoundError(
            "ffmpeg not found. Install via: choco install ffmpeg  OR  "
            "scoop install ffmpeg  OR  download from https://ffmpeg.org"
        )
    else:
        for candidate in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]:
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return candidate
        raise FileNotFoundError("ffmpeg not found. Install via: brew install ffmpeg")


def transcode_audio_for_export(source: Path, fmt: str) -> Path:
    """Transcode audio to the desired export format using ffmpeg.

    Returns a temp file path — caller is responsible for cleanup via _safe_unlink().
    """
    ffmpeg = find_ffmpeg()
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=f".{fmt}")
    tmp_path = Path(tmp.name)
    tmp.close()

    # Internal system-audio archive may be raw PCM16 (16kHz mono)
    if source.suffix.lower() == ".pcm":
        input_args = ["-f", "s16le", "-ar", "16000", "-ac", "1", "-i", str(source)]
    else:
        input_args = ["-i", str(source)]

    if fmt == "wav":
        cmd = [ffmpeg, "-y", *input_args, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", str(tmp_path)]
    else:  # mp4
        cmd = [ffmpeg, "-y", *input_args, "-vn", "-acodec", "aac", "-b:a", "192k", str(tmp_path)]

    result = subprocess.run(cmd, capture_output=True, timeout=120)
    if result.returncode != 0:
        safe_unlink(str(tmp_path))
        stderr = result.stderr.decode(errors="replace")[:300]
        raise RuntimeError(stderr or "ffmpeg convert failed")
    return tmp_path


def audio_media_type(ext: str) -> str:
    """Return MIME type for a given audio file extension."""
    ext_l = ext.lower()
    mapping = {".wav": "audio/wav", ".mp4": "audio/mp4", ".mp3": "audio/mpeg", ".m4a": "audio/mp4"}
    return mapping.get(ext_l, "application/octet-stream")


def safe_unlink(path: str) -> None:
    """Delete a file silently — ignores errors."""
    try:
        p = Path(path)
        if p.exists() and p.is_file():
            p.unlink()
    except Exception:
        pass
