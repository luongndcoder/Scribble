"""
Audio services — ffmpeg utilities, PCM conversion, media type helpers.
"""

import os
import subprocess
import tempfile
from pathlib import Path

from logger import get_logger

log = get_logger(__name__)


_FFMPEG_CACHE: str | None = None


def find_ffmpeg() -> str:
    """Resolve an ffmpeg binary path, preferring the bundled one.

    Resolution order (first hit wins):
      1. imageio-ffmpeg's bundled static binary — ships in the Python wheel
         and is picked up by PyInstaller via `collect_all('imageio_ffmpeg')`.
         This is the path end users hit in a packaged install (no homebrew /
         choco required — zero manual setup).
      2. ffmpeg sitting next to the sidecar executable — Windows CI copies
         the build-host's ffmpeg.exe here as a legacy fallback.
      3. System PATH (`shutil.which`).
      4. Common per-OS install locations (Homebrew prefix, ProgramFiles,
         Scoop, etc.) for dev environments that have ffmpeg installed but
         not in the inherited PATH (Tauri-launched apps on macOS get a
         stripped PATH that excludes /opt/homebrew/bin).

    Cached after first lookup so we don't subprocess-spawn ffmpeg dozens of
    times for the import-resolution side effect on every audio call.
    """
    global _FFMPEG_CACHE
    if _FFMPEG_CACHE and os.path.isfile(_FFMPEG_CACHE):
        return _FFMPEG_CACHE

    import shutil
    import sys as _sys

    # 1. Prefer the bundled static binary from imageio-ffmpeg. This is the
    # path that makes the app actually self-contained for end users.
    try:
        import imageio_ffmpeg
        bundled = imageio_ffmpeg.get_ffmpeg_exe()
        if bundled and os.path.isfile(bundled):
            # Defensive: ensure exec bit (PyInstaller _MEIPASS preserves it
            # but the static-binary may land in a tarball-extracted dir
            # without +x on Linux).
            if not _sys.platform == "win32":
                try:
                    os.chmod(bundled, 0o755)
                except OSError:
                    pass
            _FFMPEG_CACHE = bundled
            log.info("[ffmpeg] Using bundled imageio-ffmpeg binary: %s", bundled)
            return bundled
    except Exception as e:
        log.warning("[ffmpeg] imageio-ffmpeg not available, falling back to system search: %s", e)

    # 2. Next to the sidecar executable (CI bundling path for Windows).
    exe_dir = Path(_sys.executable).parent
    for name in ("ffmpeg.exe", "ffmpeg"):
        candidate = exe_dir / name
        if candidate.is_file():
            _FFMPEG_CACHE = str(candidate)
            return _FFMPEG_CACHE

    # 3. System PATH.
    found = shutil.which("ffmpeg")
    if found:
        _FFMPEG_CACHE = found
        return found

    # 4. Common install locations (dev fallback).
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
                    _FFMPEG_CACHE = str(c)
                    return _FFMPEG_CACHE
            except Exception:
                pass
        raise FileNotFoundError(
            "ffmpeg binary not found in the app bundle (this should never happen — "
            "imageio-ffmpeg ships it with the sidecar). Reinstall Scribble from "
            "https://scribble-rho.vercel.app or contact support."
        )
    else:
        for candidate in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]:
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                _FFMPEG_CACHE = candidate
                return candidate
        raise FileNotFoundError(
            "ffmpeg binary not found in the app bundle (this should never happen — "
            "imageio-ffmpeg ships it with the sidecar). Reinstall Scribble from "
            "https://scribble-rho.vercel.app or contact support."
        )


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
    elif fmt == "mp3":
        # 96 kbps mono → ~43MB/hour (vs WAV ~115MB/hour). Good speech-quality
        # at this rate. libmp3lame ships with the standard ffmpeg build.
        cmd = [
            ffmpeg, "-y", *input_args, "-vn",
            "-acodec", "libmp3lame", "-b:a", "96k", "-ar", "16000", "-ac", "1",
            str(tmp_path),
        ]
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
    mapping = {".wav": "audio/wav", ".mp4": "audio/mp4", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".webm": "audio/webm", ".pcm": "application/octet-stream"}
    return mapping.get(ext_l, "application/octet-stream")


def safe_unlink(path: str) -> None:
    """Delete a file silently — ignores errors."""
    try:
        p = Path(path)
        if p.exists() and p.is_file():
            p.unlink()
    except Exception:
        pass
