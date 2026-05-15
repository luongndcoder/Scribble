"""
VoiceScribe Python Sidecar — FastAPI server
Runs as a local HTTP server spawned by Tauri.
Handles: STT (Nvidia Riva / Soniox), Speaker Diarization, Translation, Summarization
"""

# ── Windows PyInstaller: must be first ──
import multiprocessing
import sys
import os
multiprocessing.freeze_support()

import asyncio
import json
import tempfile
import time
import wave
import collections
import logging
import threading

import numpy as np
import queue as _queue
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware

from db import Database
from diarize import SpeakerDiarizer
from i18n import t
from stt import NvidiaStreamingSTT, SonioxStreamingSTT, get_language_code
from logger import get_logger

log = get_logger(__name__)

# ─── Log Ring Buffer (for SSE /logs endpoint) ───
MAX_LOG_LINES = 500
_log_buffer: collections.deque = collections.deque(maxlen=MAX_LOG_LINES)
_log_subscribers: list[_queue.Queue] = []
_log_lock = threading.Lock()


class _LogInterceptor:
    """Intercepts stdout/stderr writes and copies them to the SSE log buffer."""
    def __init__(self, original):
        self._original = original

    def write(self, msg):
        try:
            self._original.write(msg)
        except (UnicodeEncodeError, OSError):
            try:
                self._original.write(msg.encode("ascii", "replace").decode("ascii"))
            except Exception:
                pass
        if msg and msg.strip():
            ts = time.strftime("%H:%M:%S")
            line = f"[{ts}] {msg.rstrip()}"
            with _log_lock:
                _log_buffer.append(line)
                for q in list(_log_subscribers):
                    try:
                        q.put_nowait(line)
                    except _queue.Full:
                        pass

    def flush(self):
        try:
            self._original.flush()
        except Exception:
            pass

    def fileno(self):
        return self._original.fileno()

    def isatty(self):
        return False


# Windows headless (CREATE_NO_WINDOW): stdout/stderr may be None
if sys.stdout is None or sys.stderr is None or (sys.platform == "win32" and getattr(sys.stdout, "encoding", "utf-8") != "utf-8"):
    _data = Path(os.environ.get("VOICESCRIBE_DATA", Path.home() / ".voicescribe"))
    _data.mkdir(parents=True, exist_ok=True)
    _fallback_log = open(_data / "sidecar-output.log", "a", encoding="utf-8", buffering=1)
    if sys.stdout is None or sys.platform == "win32":
        sys.stdout = _fallback_log
    if sys.stderr is None or sys.platform == "win32":
        sys.stderr = _fallback_log

sys.stdout = _LogInterceptor(sys.stdout)
sys.stderr = _LogInterceptor(sys.stderr)

# ─── Globals ───
db = Database()
diarizer = SpeakerDiarizer()


def _voicescribe_data_dir() -> Path:
    env_dir = os.getenv("VOICESCRIBE_DATA")
    if env_dir:
        return Path(env_dir)
    db_path = getattr(db, "_db_path", None)
    if db_path:
        return Path(db_path).parent
    return Path.home() / ".voicescribe"


def _safe_unlink(path: str):
    try:
        p = Path(path)
        if p.exists() and p.is_file():
            p.unlink()
    except Exception:
        pass


# ─── Upload Size Limit Middleware ───
MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50MB

# Paths exempt from the small-upload cap (their own size limit applies).
# Upload audio: 2GB cap enforced in services/upload_storage.py.
_LARGE_UPLOAD_PATH_PREFIXES = ("/meetings/upload-audio",)


class _LimitUploadSizeMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH"):
            path = request.url.path
            if not any(path.startswith(p) for p in _LARGE_UPLOAD_PATH_PREFIXES):
                content_length = request.headers.get("content-length")
                if content_length and int(content_length) > MAX_UPLOAD_SIZE:
                    return JSONResponse({"error": "File too large (max 50MB)"}, status_code=413)
        return await call_next(request)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    db.init()
    lang = db.get_setting("app_language") or "vi"
    log.info(t("starting", lang))

    # ── Diarizer model init (load model only — warm-up in background) ──
    log.info("[main] Loading diarizer model...")
    try:
        with diarizer._lock:
            diarizer._init_model()
        if diarizer._session:
            log.info("[main] [OK] Diarizer CAM++ model loaded")
        else:
            log.warning("[main] Diarizer ONNX model not loaded — pitch-only fallback active")
    except Exception as e:
        log.warning("[main] Diarizer model init failed: %s — pitch-only fallback active", e)

    # Inject diarizer into routers that need it
    from api import transcription as _transcription_router
    from api import diagnose as _diagnose_router
    _transcription_router.set_diarizer(diarizer)
    _diagnose_router.set_diarizer(diarizer)

    # ── Background warm-ups (don't block startup) ──
    def _warmup_diarizer():
        """First ONNX inference triggers JIT compilation. Run in background."""
        try:
            warmup_samples = np.zeros(16000, dtype=np.float32)
            diarizer.identify_speaker_from_samples(warmup_samples, 16000, update_profiles=False)
            log.info("[main] [OK] Diarizer warm-up complete")
        except Exception as e:
            log.warning("[main] Diarizer warm-up failed (non-critical): %s", e)

    if diarizer._session:
        threading.Thread(target=_warmup_diarizer, daemon=True).start()

    def _warmup_riva():
        try:
            nvidia_key = db.get_setting("nvidia_api_key") or os.environ.get("NVIDIA_API_KEY", "")
            if nvidia_key:
                from stt import _get_riva_asr, get_nvidia_model
                stt_lang_warmup = db.get_setting("stt_language") or "vi"
                lang_code = get_language_code(stt_lang_warmup)
                model = get_nvidia_model(lang_code)
                _get_riva_asr(nvidia_key, model["function_id"])
                log.info(t("riva_connected", lang))
        except Exception as e:
            log.warning("%s: %s", t("riva_warmup_fail", lang), e)

    threading.Thread(target=_warmup_riva, daemon=True).start()

    yield
    log.info(t("shutting_down", lang))


# ─── App setup ───
app = FastAPI(title="VoiceScribe Sidecar", lifespan=lifespan)

app.add_middleware(_LimitUploadSizeMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:1420",
        "http://127.0.0.1:1420",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Include routers ───
from api import settings, meetings, drafts, diagnose, transcription, upload, attachments

app.include_router(settings.router)
app.include_router(meetings.router)
app.include_router(drafts.router)
app.include_router(diagnose.router)
app.include_router(transcription.router)
app.include_router(upload.router)
app.include_router(attachments.router)


# ─── Live Log Stream (SSE) ───
@app.get("/logs")
async def logs_stream():
    async def event_gen():
        q: _queue.Queue = _queue.Queue(maxsize=200)
        with _log_lock:
            _log_subscribers.append(q)
            for line in _log_buffer:
                yield f"data: {line}\n\n"
        try:
            while True:
                try:
                    line = q.get_nowait()
                    yield f"data: {line}\n\n"
                except _queue.Empty:
                    await asyncio.sleep(0.3)
        except asyncio.CancelledError:
            pass
        finally:
            with _log_lock:
                if q in _log_subscribers:
                    _log_subscribers.remove(q)

    return StreamingResponse(event_gen(), media_type="text/event-stream")


# ─── Nvidia Streaming WebSocket ───
@app.websocket("/ws/nvidia-stream")
async def nvidia_stream_ws(websocket: WebSocket):
    """WebSocket for real-time Nvidia Riva streaming STT."""
    await websocket.accept()

    # Reset diarizer for new session
    diarizer.reset()
    source = websocket.query_params.get("source", "web")
    diarizer.set_source(source)
    max_sp = db.get_setting("max_speakers")
    if max_sp:
        try:
            diarizer.set_max_speakers(int(max_sp))
        except (ValueError, TypeError):
            pass

    meeting_id_raw = websocket.query_params.get("meeting_id")
    archive_fh = None
    if meeting_id_raw:
        try:
            meeting_id = int(meeting_id_raw)
            meeting = db.get_meeting(meeting_id)
            if meeting:
                audio_dir = _voicescribe_data_dir() / "audio"
                audio_dir.mkdir(parents=True, exist_ok=True)
                archive_path = audio_dir / f"meeting_{meeting_id}.pcm"
                archive_fh = archive_path.open("ab")
                db.update_meeting(meeting_id, audio_path=str(archive_path))
        except Exception as e:
            log.warning("[ws:nvidia-stream] archive setup failed: %s", e)

    nvidia_key = db.get_setting("nvidia_api_key") or os.environ.get("NVIDIA_API_KEY", "")
    stt_lang = db.get_setting("stt_language") or "vi"
    riva_lang = get_language_code(stt_lang)
    translation_tasks = set()

    def _close_archive():
        nonlocal archive_fh
        if archive_fh is not None:
            try:
                archive_fh.close()
            except Exception:
                pass
            archive_fh = None

    if not nvidia_key:
        _close_archive()
        await websocket.send_json({"error": "NVIDIA_API_KEY not set"})
        await websocket.close()
        return

    streamer = NvidiaStreamingSTT(nvidia_key, riva_lang)
    loop = asyncio.get_running_loop()

    try:
        await loop.run_in_executor(None, streamer.start)
    except Exception as e:
        _close_archive()
        await websocket.send_json({"error": str(e)})
        await websocket.close()
        return

    result_queue = asyncio.Queue()
    last_final_chunk_id = ""

    # Audio buffer for speaker diarization
    diarize_buf = bytearray()
    diarize_buf_lock = threading.Lock()
    DIARIZE_MIN_BYTES = 16000 * 2  # 0.5s at 16kHz 16-bit mono

    def _read_results():
        for result in streamer.results():
            asyncio.run_coroutine_threadsafe(result_queue.put(result), loop)
        asyncio.run_coroutine_threadsafe(result_queue.put(None), loop)

    result_thread = threading.Thread(target=_read_results, daemon=True)
    result_thread.start()



    async def _send_results():
        nonlocal last_final_chunk_id

        current_chunk_id = f"chunk-{int(time.time() * 1000)}-{uuid4().hex[:8]}"
        from translate import translate_instant
        ws_translate_lang = websocket.query_params.get("translate_lang", "")
        translate_state = {"lang": ws_translate_lang}
        log.debug("[ws:nvidia] translate_lang from query: '%s'", ws_translate_lang)

        transcript_parts: list[dict] = []
        last_save_at = time.time()
        SAVE_INTERVAL = 10.0
        MAX_PARTS_IN_MEMORY = 500  # Flush to DB and trim old chunkData to limit memory

        def _accumulate_part(text: str, speaker: str, speaker_id: int, chunk_id: str, is_final: bool):
            nonlocal last_save_at
            if not text.strip():
                return
            for i in range(len(transcript_parts) - 1, -1, -1):
                p = transcript_parts[i]
                if chunk_id and chunk_id in (p.get("chunkIds") or [p.get("chunkId")]):
                    if "chunkData" not in p:
                        p["chunkData"] = {p.get("chunkId"): p.get("text", "")}
                    p["chunkData"][chunk_id] = text
                    ordered_texts = [p["chunkData"][cid] for cid in p.get("chunkIds", []) if p.get("chunkData", {}).get(cid)]
                    p["text"] = " ".join(ordered_texts)
                    p["speaker"] = speaker
                    p["speakerId"] = speaker_id
                    return
            
            if transcript_parts and transcript_parts[-1].get("speakerId") == speaker_id:
                p = transcript_parts[-1]
                ids = p.get("chunkIds") or []
                if chunk_id and chunk_id not in ids:
                    ids.append(chunk_id)
                p["chunkIds"] = ids
                
                if "chunkData" not in p:
                    p["chunkData"] = {p.get("chunkId"): p.get("text", "")}
                p["chunkData"][chunk_id] = text
                ordered_texts = [p["chunkData"][cid] for cid in p.get("chunkIds", []) if p.get("chunkData", {}).get(cid)]
                p["text"] = " ".join(ordered_texts)
            else:
                transcript_parts.append({
                    "text": text, "speaker": speaker, "speakerId": speaker_id,
                    "chunkId": chunk_id, "chunkIds": [chunk_id] if chunk_id else [],
                    "chunkData": {chunk_id: text} if chunk_id else {}
                })

        def _flush_to_db():
            nonlocal last_save_at
            if not meeting_id_raw or not transcript_parts:
                return
            try:
                mid = int(meeting_id_raw)
                db.update_meeting(mid, transcript=json.dumps(transcript_parts, ensure_ascii=False))
                last_save_at = time.time()
                # Trim chunkData from older parts to limit memory growth
                if len(transcript_parts) > MAX_PARTS_IN_MEMORY:
                    trim_count = len(transcript_parts) - MAX_PARTS_IN_MEMORY
                    for p in transcript_parts[:trim_count]:
                        p.pop("chunkData", None)
            except Exception as e:
                log.warning("[ws:auto-save] error: %s", e)

        last_speaker = "Speaker 1"
        last_speaker_id = 0

        while True:
            result = await result_queue.get()
            if result is None:
                break
            try:
                msg = {
                    "text": result["text"], "is_final": True,
                    "speaker": last_speaker, "speaker_id": last_speaker_id, "chunk_id": current_chunk_id,
                }

                if not result["is_final"]:
                    await websocket.send_json(msg)
                    _accumulate_part(msg["text"], msg["speaker"], msg["speaker_id"], current_chunk_id, False)
                else:
                    # Diarize on final result
                    with diarize_buf_lock:
                        buf_bytes = bytes(diarize_buf)
                        diarize_buf.clear()
                    if len(buf_bytes) >= DIARIZE_MIN_BYTES:
                        try:
                            samples = np.frombuffer(buf_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                            speaker_info = await loop.run_in_executor(
                                None, diarizer.identify_speaker_from_samples, samples, 16000
                            )
                            msg["speaker"] = speaker_info.get("speaker", last_speaker)
                            msg["speaker_id"] = speaker_info.get("speaker_id", last_speaker_id)
                            last_speaker = msg["speaker"]
                            last_speaker_id = msg["speaker_id"]
                        except Exception as e:
                            log.warning("[ws:nvidia] diarize error: %s", e)

                    # Send transcript immediately (don't wait for translation)
                    await websocket.send_json(msg)

                    final_chunk_id = current_chunk_id
                    if result["text"]:
                        last_final_chunk_id = current_chunk_id
                    current_chunk_id = f"chunk-{int(time.time() * 1000)}-{uuid4().hex[:8]}"
                    _accumulate_part(msg["text"], msg["speaker"], msg["speaker_id"], last_final_chunk_id or final_chunk_id, True)

                    # ── Per-chunk translation with chunk_id (like Soniox) ──
                    # Each final result gets its own translation task.
                    # chunk_id ensures translation targets the CORRECT part.
                    if msg["text"].strip() and translate_state["lang"]:
                        _text = msg["text"]
                        _cid = msg["chunk_id"]
                        _lang = translate_state["lang"]
                        _src = stt_lang

                        async def _do_translate(text=_text, cid=_cid, lang=_lang, src=_src):
                            import re
                            if not text or not lang:
                                return
                            if not re.sub(r'[^\w\s]', '', text).strip():
                                return
                            try:
                                translated = await loop.run_in_executor(
                                    None, translate_instant, text, lang, db, src
                                )
                                if translated:
                                    await websocket.send_json({
                                        "type": "translation",
                                        "translation": translated,
                                        "chunk_id": cid,
                                        "append": True,
                                    })
                            except Exception as e:
                                log.warning("[ws:nvidia-trans] error: %s", e)

                        t = asyncio.create_task(_do_translate())
                        translation_tasks.add(t)
                        t.add_done_callback(translation_tasks.discard)

                if time.time() - last_save_at >= SAVE_INTERVAL:
                    _flush_to_db()

            except WebSocketDisconnect:
                break

        _flush_to_db()

    send_task = asyncio.create_task(_send_results())

    try:
        while True:
            data = await websocket.receive()
            if data.get("type") == "websocket.disconnect":
                break
            if "bytes" in data:
                audio_bytes = data["bytes"]
                streamer.feed_audio(audio_bytes)
                with diarize_buf_lock:
                    diarize_buf.extend(audio_bytes)
                if archive_fh is not None:
                    try:
                        archive_fh.write(audio_bytes)
                    except Exception as e:
                        log.warning("[ws:nvidia-stream] archive write failed: %s", e)
            elif "text" in data:
                txt = data["text"]
                if txt == "STOP":
                    break
                if txt.startswith("TRANSLATE:"):
                    lang_cmd = txt[len("TRANSLATE:"):].strip()
                    if lang_cmd.lower() == "off":
                        translate_state["lang"] = ""
                        log.info("[ws:nvidia] Translation disabled mid-session")
                    else:
                        translate_state["lang"] = lang_cmd
                        log.info("[ws:nvidia] Translation enabled mid-session: lang=%s", lang_cmd)
    except WebSocketDisconnect:
        pass
    finally:
        streamer.stop()
        result_thread.join(timeout=5)
        
        # Give send_task time to consume the final result_queue item (which spawns final translation)
        try:
            await asyncio.wait_for(send_task, timeout=3.0)
        except asyncio.TimeoutError:
            send_task.cancel()
            

            
        # Give translation_tasks time to finish and send over websocket
        if translation_tasks:
            await asyncio.wait(translation_tasks, timeout=5.0)

        _close_archive()
        try:
            await websocket.close()
        except Exception:
            pass


# ─── Soniox Streaming WebSocket ───
@app.websocket("/ws/soniox-stream")
async def soniox_stream_ws(websocket: WebSocket):
    """WebSocket for real-time Soniox streaming STT."""
    await websocket.accept()

    # Reset diarizer for new session (Soniox uses SDK diarization but clear stale state)
    diarizer.reset()
    max_sp = db.get_setting("max_speakers")
    if max_sp:
        try:
            diarizer.set_max_speakers(int(max_sp))
        except (ValueError, TypeError):
            pass

    meeting_id_raw = websocket.query_params.get("meeting_id")
    archive_fh = None
    if meeting_id_raw:
        try:
            meeting_id = int(meeting_id_raw)
            meeting = db.get_meeting(meeting_id)
            if meeting:
                audio_dir = _voicescribe_data_dir() / "audio"
                audio_dir.mkdir(parents=True, exist_ok=True)
                archive_path = audio_dir / f"meeting_{meeting_id}.pcm"
                archive_fh = archive_path.open("ab")
                db.update_meeting(meeting_id, audio_path=str(archive_path))
        except Exception as e:
            log.warning("[ws:soniox-stream] archive setup failed: %s", e)

    soniox_key = db.get_setting("soniox_api_key") or os.environ.get("SONIOX_API_KEY", "")
    hints_raw = db.get_setting("soniox_language_hints") or "vi"
    language_hints = [h.strip() for h in hints_raw.split(",") if h.strip()] or ["vi"]

    def _close_archive():
        nonlocal archive_fh
        if archive_fh is not None:
            try:
                archive_fh.close()
            except Exception:
                pass
            archive_fh = None

    if not soniox_key:
        _close_archive()
        await websocket.send_json({"error": "SONIOX_API_KEY not set"})
        await websocket.close()
        return

    ws_translate_lang = websocket.query_params.get("translate_lang", "")
    log.info("[ws:soniox] translate_lang from query: '%s'", ws_translate_lang or '(none - translation disabled)')

    streamer = SonioxStreamingSTT(soniox_key, language_hints=language_hints, translate_lang=ws_translate_lang)
    loop = asyncio.get_running_loop()

    try:
        await loop.run_in_executor(None, streamer.start)
    except Exception as e:
        # Previously this was silent — the client got `{error: "..."}` over the
        # WebSocket but the server log showed nothing, making realtime Soniox
        # failures impossible to diagnose. Log with full traceback now.
        log.error("[ws:soniox-stream] streamer.start failed: %s", e, exc_info=True)
        try:
            await websocket.send_json({"error": str(e)})
        except Exception:
            pass
        await websocket.close()
        return

    result_queue = asyncio.Queue()

    def _read_results():
        for result in streamer.results():
            asyncio.run_coroutine_threadsafe(result_queue.put(result), loop)
        asyncio.run_coroutine_threadsafe(result_queue.put(None), loop)

    result_thread = threading.Thread(target=_read_results, daemon=True)
    result_thread.start()

    async def _send_results():
        last_speaker_id = None
        last_translation = ""
        last_translation_time = 0.0
        pending_translation = ""  # Buffer for throttled translation

        while True:
            result = await result_queue.get()
            if result is None:
                # Stream ended — flush any pending translation
                break
            try:
                msg = {
                    "text": result["text"],
                    "is_final": result["is_final"],
                    "speaker": result.get("speaker", "Speaker 1"),
                    "speaker_id": result.get("speaker_id", 0),
                }
                if result["is_final"] and result["text"]:
                    chunk_id = result.get("chunk_id") or f"chunk-{int(time.time() * 1000)}-{uuid4().hex[:8]}"
                    msg["chunk_id"] = chunk_id
                    new_speaker_id = msg["speaker_id"]
                    if last_speaker_id is not None and new_speaker_id != last_speaker_id:
                        # Speaker changed — flush pending translation before split
                        if pending_translation and pending_translation != last_translation:
                            pass  # Will be sent with this message below
                        try:
                            await websocket.send_json({
                                "type": "speaker_split",
                                "speaker": msg["speaker"],
                                "speaker_id": new_speaker_id,
                            })
                        except Exception:
                            pass
                        last_translation = ""
                        pending_translation = ""
                        last_translation_time = 0.0
                    last_speaker_id = new_speaker_id

                # Throttle translation: send at most every 1.5s or on significant change (>30 chars)
                translation = result.get("translation", "")
                if translation and translation != last_translation:
                    now = time.time()
                    pending_translation = translation
                    significant_change = len(translation) - len(last_translation) >= 30
                    time_elapsed = now - last_translation_time >= 1.5
                    if significant_change or time_elapsed or last_translation_time == 0.0:
                        msg["translation"] = translation
                        last_translation = translation
                        pending_translation = ""
                        last_translation_time = now

                await websocket.send_json(msg)
            except WebSocketDisconnect:
                break

    send_task = asyncio.create_task(_send_results())

    try:
        while True:
            data = await websocket.receive()
            if data.get("type") == "websocket.disconnect":
                break
            if "bytes" in data:
                streamer.feed_audio(data["bytes"])
                if archive_fh is not None:
                    try:
                        archive_fh.write(data["bytes"])
                    except Exception as e:
                        log.warning("[ws:soniox-stream] archive write failed: %s", e)
            elif "text" in data and data["text"] == "STOP":
                break
    except WebSocketDisconnect:
        pass
    finally:
        streamer.stop()
        result_thread.join(timeout=5)
        send_task.cancel()
        _close_archive()
        try:
            await websocket.close()
        except Exception:
            pass


if __name__ == "__main__":
    import traceback

    def _crash_log_path():
        data_dir = os.getenv("VOICESCRIBE_DATA", os.path.join(os.path.expanduser("~"), ".voicescribe"))
        os.makedirs(data_dir, exist_ok=True)
        return os.path.join(data_dir, "sidecar-crash.log")

    try:
        log_path = _crash_log_path()
        with open(log_path, "w") as f:
            f.write(f"[startup] frozen={getattr(sys, 'frozen', False)}\n")
            f.write(f"[startup] _MEIPASS={getattr(sys, '_MEIPASS', 'N/A')}\n")
            f.write(f"[startup] executable={sys.executable}\n")
            f.write(f"[startup] cwd={os.getcwd()}\n")
            f.write(f"[startup] platform={sys.platform}\n")
            f.write(f"[startup] Starting uvicorn...\n")

        port = int(os.getenv("SIDECAR_PORT", "8765"))
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
    except Exception as e:
        tb = traceback.format_exc()
        log.critical("[CRASH] %s\n%s", e, tb)
        try:
            with open(_crash_log_path(), "a") as f:
                f.write(f"\n[CRASH] {e}\n{tb}\n")
        except Exception:
            pass
        sys.exit(1)
