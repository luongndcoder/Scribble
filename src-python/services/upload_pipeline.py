"""End-to-end pipeline for an uploaded audio file.

Lifecycle owned by job_registry; runs as a single asyncio task:

  normalize (ffmpeg → 16kHz mono WAV)
    → split (silencedetect + chunk_NNNN.wav)
    → for each chunk in parallel (semaphore-bounded):
        STT (Nvidia Riva offline_recognize) + embedding extraction
        emit `chunk` SSE event with text
    → global speaker clustering (scipy)
    → assemble realtime-format transcript JSON, persist
    → auto-summarize (drain summarize_stream into markdown)
    → mark job done

Cancellation: cancel_event is polled at every coarse boundary plus per-chunk;
in-flight Riva calls finish naturally (gRPC can't be interrupted cleanly).
Cleanup of the tmp working dir is unconditional in `finally`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

from db import Database
from services.audio import find_ffmpeg
from services.batch_diarizer import cluster_speakers, extract_embedding
from services.job_registry import JobState, JobStatus, registry
from services.vad_splitter import AudioChunk, split_into_chunks
from stt import (
    HALLUCINATION_PATTERNS,
    get_language_code,
    transcribe_nvidia_streaming,
    transcribe_soniox_file,
)

log = logging.getLogger(__name__)

db = Database()

# Riva offline_recognize quota: 3 concurrent is comfortable for free-tier keys.
# Exposed via setting `upload_stt_concurrency` for power users.
DEFAULT_STT_CONCURRENCY = 3
# 24h is a sanity ceiling against runaway uploads — NOT a true product limit.
# The pipeline handles any duration: Nvidia path chunks via VAD (<2min/chunk),
# Soniox path auto-splits at SONIOX_CHUNK_MAX_SEC when needed. Adjust via
# setting `upload_max_duration_hours` if a user has legit >24h needs.
DEFAULT_MAX_DURATION_HOURS = 24

# Soniox stt-async-v4 has an ~5h cap per submission. We split at 3.5h to
# leave a 30% safety buffer for network slowness, peak-load queueing, and
# Soniox-side variance. Files ≤ 3.5h take the single-shot path (preserves
# globally-consistent speaker diarization across the whole file).
SONIOX_CHUNK_MAX_SEC = 3.5 * 3600  # 12600s

# Progress band split: upload completes at 0.0 (Phase 1 took it past upload);
# this pipeline goes 0.05 → 1.0.
P_NORMALIZE = 0.10
P_SPLIT = 0.18
P_TRANSCRIBE_START = 0.20
P_TRANSCRIBE_END = 0.85
P_FINALIZE = 0.88
P_CLUSTER_DONE = 0.92
P_SUMMARIZE = 0.95


def _filter_hallucinations(text: str) -> str:
    """Drop common STT artifacts (intro stings, "Thanks for watching", etc.).

    Mirrors api.transcription.filter_hallucinations to avoid importing the
    FastAPI router module (which would pull in app state we don't need here).
    """
    if not text:
        return ""
    for pattern in HALLUCINATION_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            return ""
    if len(text.strip()) <= 3:
        return ""
    return text


def _stt_concurrency() -> int:
    raw = db.get_setting("upload_stt_concurrency") or ""
    try:
        n = int(raw)
        return max(1, min(n, 8))
    except ValueError:
        return DEFAULT_STT_CONCURRENCY


def _max_duration_seconds() -> float:
    raw = db.get_setting("upload_max_duration_hours") or ""
    try:
        h = float(raw)
        return max(0.5, h) * 3600
    except ValueError:
        return DEFAULT_MAX_DURATION_HOURS * 3600


def _is_cancelled(job: JobState) -> bool:
    return job.cancel_event.is_set()


async def run_pipeline(job_id: str) -> None:
    """Public entry: kick off the full pipeline for an existing job + meeting."""
    job = registry.get(job_id)
    if not job:
        log.error("[pipeline] unknown job %s", job_id)
        return

    meeting = db.get_meeting(job.meeting_id)
    if not meeting:
        await registry.update(
            job_id, status=JobStatus.FAILED, error="Meeting record missing"
        )
        return

    source_path = Path(meeting.get("audio_path") or "")
    if not source_path.is_file():
        await registry.update(
            job_id, status=JobStatus.FAILED, error="Uploaded audio file missing on disk"
        )
        return

    tmp_root = Path(tempfile.mkdtemp(prefix=f"scribble-pipeline-{job_id[:8]}-"))
    try:
        await _execute(job, meeting, source_path, tmp_root)
    except asyncio.CancelledError:
        # Same cleanup logic as the failure path: if nothing was saved yet,
        # delete the empty meeting + audio so it doesn't clutter the list
        # AND doesn't poison the duplicate-detect lookup for the user's
        # next upload attempt of the same file.
        meeting_now = db.get_meeting(job.meeting_id) or {}
        has_partial_transcript = bool(
            (meeting_now.get("transcript") or "").strip().strip("[]")
        )
        await registry.update(
            job_id,
            status=JobStatus.CANCELLED,
            error="Cancelled",
            transcript_saved=has_partial_transcript,
        )
        if has_partial_transcript:
            db.update_meeting(job.meeting_id, status="cancelled")
        else:
            audio_path_raw = meeting_now.get("audio_path") or ""
            if audio_path_raw:
                try:
                    Path(audio_path_raw).unlink(missing_ok=True)
                except Exception:
                    pass
            try:
                db.delete_meeting(job.meeting_id)
            except Exception:
                pass
        raise
    except Exception as exc:
        log.exception("[pipeline] failed job=%s", job_id)
        # Three outcomes here, depending on how far we got before crashing:
        #
        # (a) Some transcript already committed (per-chunk persist or final
        #     pass landed) → KEEP the meeting as 'saved'. The job state
        #     reports FAILED so the modal shows error UI, but transcript_saved
        #     tells the frontend "you can still open this".
        # (b) Nothing saved AND the file is uploaded → DELETE the meeting
        #     row + audio file. Don't leave a useless empty row cluttering
        #     the meeting list — and more importantly, don't leave its
        #     file_hash in the DB to mis-trigger duplicate detection on the
        #     user's next upload of the same file.
        #
        # (b) is the bug fix for "upload fails → empty meeting created →
        #     re-upload says duplicate" reported in v1.2.11.
        meeting_now = db.get_meeting(job.meeting_id) or {}
        has_partial_transcript = bool(
            (meeting_now.get("transcript") or "").strip().strip("[]")
        )
        await registry.update(
            job_id,
            status=JobStatus.FAILED,
            error=str(exc),
            transcript_saved=has_partial_transcript,
        )
        if has_partial_transcript:
            # Path (a): keep the partial — don't overwrite status='saved'.
            pass
        else:
            # Path (b): rollback the empty meeting + its audio file. This
            # MUST happen before the SSE handler emits the failure event so
            # the frontend can't race-navigate to a meeting that we're
            # about to delete.
            audio_path_raw = meeting_now.get("audio_path") or ""
            if audio_path_raw:
                try:
                    Path(audio_path_raw).unlink(missing_ok=True)
                except Exception as cleanup_exc:
                    log.warning(
                        "[pipeline] failed to unlink audio %s: %s",
                        audio_path_raw, cleanup_exc,
                    )
            try:
                db.delete_meeting(job.meeting_id)
                log.info(
                    "[pipeline] deleted empty failed meeting %s (no transcript saved)",
                    job.meeting_id,
                )
            except Exception as del_exc:
                log.warning(
                    "[pipeline] failed to delete empty meeting %s: %s",
                    job.meeting_id, del_exc,
                )
                # Best-effort fallback so it doesn't show as a fresh draft.
                try:
                    db.update_meeting(job.meeting_id, status="failed")
                except Exception:
                    pass
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


async def _execute(
    job: JobState, meeting: dict, source_path: Path, tmp_root: Path
) -> None:
    job_id = job.job_id
    meeting_id = job.meeting_id

    # ── Probe duration ─────────────────────────────────────────────────────
    await registry.update(
        job_id,
        status=JobStatus.NORMALIZING,
        progress=0.05,
        message="Đang phân tích audio",
    )
    duration_sec = await asyncio.to_thread(_ffprobe_duration, source_path)
    max_sec = _max_duration_seconds()
    if duration_sec <= 0:
        raise ValueError("Không xác định được thời lượng audio")
    if duration_sec > max_sec:
        raise ValueError(
            f"File quá dài ({duration_sec / 3600:.1f}h, "
            f"giới hạn {max_sec / 3600:.1f}h)"
        )
    db.update_meeting(meeting_id, audio_duration=duration_sec)
    if _is_cancelled(job):
        return

    # ── Normalize → WAV 16kHz mono ─────────────────────────────────────────
    wav_path = tmp_root / "normalized.wav"
    await registry.update(
        job_id, progress=P_NORMALIZE, message="Chuẩn hoá audio"
    )
    await asyncio.to_thread(_normalize_to_wav, source_path, wav_path)
    if _is_cancelled(job):
        return

    # ── Provider dispatch ──────────────────────────────────────────────────
    # Soniox's async API handles files up to ~5h per submission. For shorter
    # files we send the whole WAV in 1 call so speaker IDs stay globally
    # consistent (Soniox's diarization, no CAM++ pass). For files > 3.5h we
    # auto-split into chunks and stitch results back together with offset.
    # Nvidia path always chunks via VAD because Riva caps audio length per
    # call and chunking gives parallel STT speedup + per-chunk resume.
    stt_provider = (db.get_setting("stt_provider") or "nvidia").strip().lower()
    if stt_provider == "soniox":
        transcript_parts = await _run_soniox_pipeline(
            job, meeting_id, wav_path, duration_sec, tmp_root,
        )
        # v1.2.13: When all Soniox chunks failed AND we have no salvageable
        # transcript at all, raise so the outer handler treats it as full
        # failure (deletes empty meeting + audio per v1.2.11 cleanup). The
        # partial-failure case (some chunks done, some failed) stays in the
        # success branch — UI shows the retry banner inside the meeting.
        if not transcript_parts:
            failed_count = int(
                (db.get_meeting(meeting_id) or {}).get("failed_chunks_count") or 0
            )
            if failed_count > 0:
                raise RuntimeError(
                    f"Tất cả {failed_count} phần Soniox đều thất bại — "
                    "vui lòng kiểm tra Soniox API key, mạng, hoặc upload lại file."
                )
    else:
        transcript_parts = await _run_nvidia_chunked_pipeline(
            job, meeting, meeting_id, wav_path, tmp_root,
        )

    if _is_cancelled(job):
        return

    # ── Build transcript + persist (final pass) ────────────────────────────
    transcript_json = json.dumps(transcript_parts, ensure_ascii=False)
    db.update_meeting(meeting_id, transcript=transcript_json, status="saved")
    # Flag the transcript as committed so the UI knows the meeting is openable
    # even if downstream summarize step fails. This is the safety net that
    # prevents "STT thành công cốc" when LLM key is missing.
    await registry.update(job_id, transcript_saved=True)
    if _is_cancelled(job):
        return

    # Bridge message between "transcribing done" and "summary running" — without
    # this jump the modal sits at 90% "Phân loại người nói" for the whole length
    # of the LLM call and the user can't tell what's happening next.
    await registry.update(
        job_id,
        progress=P_CLUSTER_DONE,
        message="Hoàn tất phiên âm — chuẩn bị biên bản",
    )

    # ── Auto-summarize (best-effort, NEVER fails the job) ──────────────────
    # The user often configures STT only (no LLM key). In that case we must
    # NOT throw away the transcript. Behavior matrix:
    #   - LLM key present + summary succeeds → save summary, DONE
    #   - LLM key present + summary fails    → log, DONE with summary_skipped
    #   - LLM key absent                      → skip step entirely, DONE
    #                                            with summary_skipped + reason
    # In every case the job ends in DONE so the upload modal can navigate
    # the user to their (saved) transcript.
    llm_key = (db.get_setting("llm_api_key") or os.environ.get("LLM_API_KEY", "")).strip()
    if not llm_key:
        log.info("[pipeline] LLM key not configured — skipping auto-summarize")
        await registry.update(
            job_id,
            progress=P_SUMMARIZE,
            message="Bỏ qua biên bản (chưa cấu hình AI key)",
            summary_skipped=True,
            summary_skip_reason="llm_api_key_missing",
        )
    else:
        await registry.update(
            job_id,
            progress=P_SUMMARIZE,
            message="Đang tạo biên bản (có thể mất vài phút)",
        )
        try:
            summary_md = await asyncio.to_thread(
                _summarize_blocking, transcript_parts,
                meeting.get("language") or "vi", meeting_id,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Belt + suspenders: _summarize_blocking already returns "" on
            # error, but if anything unexpected leaks through we MUST NOT
            # let it propagate up and fail the job (and trash the transcript
            # the user just paid for in time + STT credits).
            log.exception("[pipeline] summarize step crashed — treating as skipped")
            summary_md = ""
            await registry.update(
                job_id,
                summary_skipped=True,
                summary_skip_reason=f"summarize_error: {exc}",
            )

        if summary_md:
            db.update_meeting(meeting_id, summary=summary_md)
        elif not registry.get(job_id) or not registry.get(job_id).summary_skipped:
            # _summarize_blocking returned empty without raising — means
            # the SSE stream yielded an error event (e.g. LLM 401, network
            # blip). Mark as skipped so the UI shows the right message.
            log.warning("[pipeline] summarize returned empty — marking skipped")
            await registry.update(
                job_id,
                summary_skipped=True,
                summary_skip_reason="summarize_empty",
            )

    final_message = "Hoàn thành"
    job_state = registry.get(job_id)
    if job_state and job_state.summary_skipped:
        final_message = "Hoàn thành (transcript đã lưu, chưa tạo biên bản)"

    await registry.update(
        job_id,
        status=JobStatus.DONE,
        progress=1.0,
        message=final_message,
    )


def _format_eta_vi(eta_sec: float) -> str:
    """Format ETA in Vietnamese: '45s', '12 phút', '1h 23 phút', '2h 15 phút'.

    Granularity:
      - < 60s → '{X}s'
      - < 60 min → '{X} phút' (ceil so '0 phút' never shows)
      - ≥ 60 min → '{H}h' or '{H}h {M} phút' (drop ' 0 phút' for clean output)
    """
    import math
    if eta_sec < 60:
        return f"{max(1, int(eta_sec))}s"
    total_min = math.ceil(eta_sec / 60.0)
    if total_min < 60:
        return f"{total_min} phút"
    hours = total_min // 60
    mins = total_min % 60
    if mins == 0:
        return f"{hours}h"
    return f"{hours}h {mins} phút"


def _format_duration_vi(dur_sec: float) -> str:
    """Format audio duration for display: '45s', '12 phút', '1h 30 phút'."""
    if dur_sec < 60:
        return f"{int(dur_sec)}s"
    total_min = int(dur_sec / 60)
    if total_min < 60:
        return f"{total_min} phút"
    hours = total_min // 60
    mins = total_min % 60
    if mins == 0:
        return f"{hours}h"
    return f"{hours}h {mins} phút"


async def _run_soniox_pipeline(
    job: JobState, meeting_id: int, wav_path: Path,
    duration_sec: float, tmp_root: Path,
) -> list[dict]:
    """Soniox STT pipeline. Auto-splits files > 3.5h into chunks because
    Soniox stt-async-v4 caps at ~5h per submission.

    Returns transcript_parts ready for ``db.update_meeting(transcript=...)``.
      - File ≤ 3.5h: single-shot — Soniox does globally-consistent diarization
        across the whole file (best speaker accuracy).
      - File > 3.5h: chunked — ffmpeg-split into ≤3.5h pieces, each Soniox-
        transcribed sequentially, then concatenated with chunk-time offset
        applied to start_ms/end_ms. Speaker IDs are offset per chunk so they
        stay unique; users can merge same-person-different-chunk labels via
        the existing "Đổi tên speaker (áp dụng toàn bộ)" UI.
    """
    job_id = job.job_id

    soniox_key = (
        db.get_setting("soniox_api_key")
        or os.environ.get("SONIOX_API_KEY", "")
    )
    if not soniox_key:
        raise RuntimeError(
            "Soniox API key chưa được cấu hình. Vào Settings → Soniox API Key."
        )
    hints_raw = db.get_setting("soniox_language_hints") or "vi"
    hints = [h.strip() for h in hints_raw.split(",") if h.strip()] or ["vi"]

    if duration_sec <= SONIOX_CHUNK_MAX_SEC:
        log.info(
            "[pipeline] Soniox single-shot (%.1f min)",
            duration_sec / 60.0,
        )
        segments = await _soniox_transcribe_single(
            job, wav_path, soniox_key, hints,
        )
    else:
        n_chunks = -(-int(duration_sec) // int(SONIOX_CHUNK_MAX_SEC))  # ceil
        log.info(
            "[pipeline] Soniox chunked: %.1f min → %d chunks (Soniox ~5h cap)",
            duration_sec / 60.0, n_chunks,
        )
        segments = await _soniox_transcribe_chunked(
            job, wav_path, duration_sec, tmp_root, soniox_key, hints, n_chunks,
        )

    await registry.update(
        job_id,
        status=JobStatus.FINALIZING,
        progress=P_FINALIZE,
        message="Phân loại người nói",
    )

    if not segments:
        log.warning("[pipeline] Soniox returned no segments")
        return []

    # Build chunk_results + speaker_map directly from Soniox segments.
    # Speaker IDs from Soniox are 1-based strings ("1", "2") — convert to
    # 0-based ints to match Nvidia path output.
    chunk_results: list[dict] = []
    speaker_map: dict[int, int] = {}
    for i, seg in enumerate(segments):
        chunk_results.append({
            "idx": i,
            "text": seg["text"],
            "embedding": None,
            "start_ms": int(seg["start_ms"]),
            "end_ms": int(seg["end_ms"]),
        })
        raw = str(seg.get("speaker") or "1")
        try:
            sp_id = max(0, int(raw) - 1)
        except (ValueError, TypeError):
            sp_id = 0
        speaker_map[i] = sp_id

    return _build_transcript_parts(chunk_results, speaker_map)


def _make_soniox_progress_cb(
    job: JobState,
    loop: asyncio.AbstractEventLoop,
    chunk_idx: int = 0,
    n_chunks: int = 1,
):
    """Build a progress callback that maps Soniox's per-chunk progress (0..1)
    into the pipeline's TRANSCRIBE band, with optional chunk indicator.

    For single-shot: chunk_idx=0, n_chunks=1 → progress fills the full band,
    ETA is per-file directly.
    For chunked: each chunk gets an equal slice of the band. The displayed
    ETA is the TOTAL remaining time across all chunks (current chunk's ETA
    + estimate for the upcoming chunks), not just this chunk's ETA. Users
    care about total wait, not per-chunk granularity.
    """
    job_id = job.job_id
    cancel_event = job.cancel_event
    # Same conservative throughput we use in stt.py for ETA estimation.
    SONIOX_THROUGHPUT_X = 10.0

    def _cb(
        p: float,
        audio_dur_sec: float | None = None,
        eta_remaining_sec: float | None = None,
    ) -> None:
        # Cooperative cancel: raise from the polling thread so the SDK
        # call unwinds and the pipeline can mark itself cancelled.
        if cancel_event.is_set():
            raise RuntimeError("Cancelled")

        # Slice the transcribe band evenly across chunks.
        band = P_TRANSCRIBE_END - P_TRANSCRIBE_START
        global_p = (chunk_idx + min(1.0, max(0.0, p))) / n_chunks
        mapped = P_TRANSCRIBE_START + global_p * band

        chunk_label = f"phần {chunk_idx + 1}/{n_chunks}" if n_chunks > 1 else ""

        # Aggregate ETA: this chunk's remaining + future chunks' projection.
        # If we know audio_dur_sec of current chunk, assume future chunks
        # are similar size (true with our even-split).
        if eta_remaining_sec is not None and audio_dur_sec is not None and n_chunks > 1:
            future_chunks = n_chunks - chunk_idx - 1
            projected_future_sec = future_chunks * (audio_dur_sec / SONIOX_THROUGHPUT_X)
            total_eta_sec = eta_remaining_sec + projected_future_sec
        else:
            total_eta_sec = eta_remaining_sec

        # Build a status message:
        #   1. `queued` (audio_dur_sec is None) — Soniox hasn't started yet.
        #   2. `processing` (we know audio length + ETA) — show remaining.
        #   3. Near-done (p >= 0.95 in this chunk) — fetching tokens / cleanup.
        if audio_dur_sec is None and eta_remaining_sec is None and p < 0.10:
            if chunk_label:
                msg = f"Đang gửi {chunk_label} lên Soniox..."
            else:
                msg = "Đang gửi file lên Soniox..."
        elif total_eta_sec is not None and audio_dur_sec is not None and p < 0.95:
            eta_label = _format_eta_vi(total_eta_sec)
            if n_chunks > 1:
                msg = f"Đang phiên âm {chunk_label} — còn ~{eta_label}"
            else:
                dur_label = _format_duration_vi(audio_dur_sec)
                msg = f"Đang phiên âm (Soniox) — còn ~{eta_label} (file {dur_label})"
        elif p < 0.95:
            if n_chunks > 1:
                msg = f"Đang phiên âm {chunk_label} (Soniox)"
            else:
                msg = "Đang phiên âm (Soniox)"
        else:
            if n_chunks > 1 and chunk_idx < n_chunks - 1:
                msg = f"Hoàn tất {chunk_label}, chuẩn bị phần tiếp theo..."
            else:
                msg = "Đang xử lý kết quả"

        try:
            asyncio.run_coroutine_threadsafe(
                registry.update(job_id, progress=mapped, message=msg),
                loop,
            )
        except Exception:
            pass

    return _cb


async def _soniox_transcribe_single(
    job: JobState, wav_path: Path,
    soniox_key: str, hints: list[str],
) -> list[dict]:
    """Single Soniox transcription pass over the whole WAV. Used for files
    that fit Soniox's per-submission limit (≤ 3.5h). Preserves globally-
    consistent speaker diarization."""
    job_id = job.job_id
    await registry.update(
        job_id,
        status=JobStatus.TRANSCRIBING,
        progress=P_TRANSCRIBE_START,
        message="Đang gửi file lên Soniox...",
    )
    loop = asyncio.get_running_loop()
    cb = _make_soniox_progress_cb(job, loop, chunk_idx=0, n_chunks=1)
    return await asyncio.to_thread(
        transcribe_soniox_file, str(wav_path), soniox_key, hints,
        progress_cb=cb,
    )


async def _soniox_transcribe_chunked(
    job: JobState, wav_path: Path,
    duration_sec: float, tmp_root: Path,
    soniox_key: str, hints: list[str], n_chunks: int,
) -> list[dict]:
    """Split a long WAV into ≤3.5h chunks via ffmpeg, transcribe each via
    Soniox sequentially, then concatenate the segments with chunk-time
    offset applied so the timeline stays continuous.

    Per-chunk persistence (v1.2.13):
      - The chunk plan (idx, start_ms, end_ms) is upserted to DB upfront so
        retry semantics work even if the sidecar crashes mid-job.
      - Each successful chunk's segments_json + status='done' is written to
        upload_chunks IMMEDIATELY after Soniox returns — the user can open
        the meeting and read what's been transcribed so far while later
        chunks are still processing.
      - On chunk failure: status='failed' + error_message is saved, and the
        loop CONTINUES with the next chunk (no re-raise). After the loop
        finishes, the outer pipeline can detect failed_chunks_count > 0 and
        prompt the user to retry just the failed chunks.
      - On resume (sidecar restart, or retry-failed-chunks endpoint call):
        chunks where status='done' are LOADED from DB instead of re-
        transcribed. This makes retries idempotent and free of duplicate
        Soniox cost.

    Speaker IDs are offset by `chunk_idx * 100` per chunk so they stay
    unique across chunks. Users merge same-person labels via the existing
    rename-speaker UI.
    """
    job_id = job.job_id
    meeting_id = job.meeting_id

    # ── Step 1: split WAV + persist chunk plan ───────────────────────────
    # Plan is persisted BEFORE any transcription so retries can identify
    # what was already done vs what still needs work.
    await registry.update(
        job_id,
        status=JobStatus.TRANSCRIBING,
        progress=P_TRANSCRIBE_START,
        message=f"Đang cắt file thành {n_chunks} phần (file dài {_format_duration_vi(duration_sec)})",
    )
    chunks_dir = tmp_root / "soniox_chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    chunk_paths = await asyncio.to_thread(
        _split_wav_for_soniox, wav_path, duration_sec, chunks_dir, n_chunks,
    )

    # Build plan (idx, start_ms, end_ms) and upsert to DB. INSERT OR IGNORE
    # semantics so existing rows (from a previous run) are preserved.
    chunk_dur_ms = int(duration_sec * 1000 / n_chunks)
    plan = []
    for idx, (_, off_ms) in enumerate(chunk_paths):
        end_ms = off_ms + chunk_dur_ms if idx < n_chunks - 1 else int(duration_sec * 1000)
        plan.append((idx, off_ms, end_ms))
    await asyncio.to_thread(db.upsert_chunk_plan, meeting_id, plan)

    if _is_cancelled(job):
        raise RuntimeError("Cancelled")

    # ── Step 2: load existing chunk states (resume support) ──────────────
    # When sidecar restarts mid-pipeline, OR when the user invokes the
    # retry-failed-chunks endpoint, we want to skip work that's already
    # been done. Loaded segments_json strings are decoded back into the
    # final all_segments list so the per-chunk persist below stays an
    # append-only operation.
    existing = await asyncio.to_thread(db.get_upload_chunks, meeting_id)
    existing_by_idx = {c["chunk_idx"]: c for c in existing}

    loop = asyncio.get_running_loop()
    all_segments: list[dict] = []

    for idx, (chunk_path, chunk_offset_ms) in enumerate(chunk_paths):
        if _is_cancelled(job):
            raise RuntimeError("Cancelled")

        # Skip chunks already marked done — load their segments from DB.
        existing_chunk = existing_by_idx.get(idx)
        if existing_chunk and existing_chunk.get("status") == "done" and existing_chunk.get("segments_json"):
            try:
                cached_segs = json.loads(existing_chunk["segments_json"])
                all_segments.extend(cached_segs)
                log.info(
                    "[pipeline] Soniox chunk %d/%d already done — loaded %d segments from DB",
                    idx + 1, n_chunks, len(cached_segs),
                )
                continue
            except (json.JSONDecodeError, TypeError):
                log.warning(
                    "[pipeline] Bad segments_json for chunk %d — re-transcribing",
                    idx,
                )

        cb = _make_soniox_progress_cb(job, loop, chunk_idx=idx, n_chunks=n_chunks)

        try:
            chunk_segments = await asyncio.to_thread(
                transcribe_soniox_file, str(chunk_path), soniox_key, hints,
                progress_cb=cb,
            )
        except Exception as exc:
            # Continue-on-fail: don't trash previously-completed chunks.
            # Persist the failure so the user can retry just THIS chunk
            # via POST /meetings/{id}/retry-failed-chunks.
            log.error(
                "[pipeline] Soniox chunk %d/%d failed: %s",
                idx + 1, n_chunks, exc,
            )
            await asyncio.to_thread(
                db.save_soniox_chunk_failed, meeting_id, idx, str(exc),
            )
            continue

        # Apply offset to start_ms/end_ms so the timeline stays continuous
        # across chunks. Apply speaker offset so IDs from different chunks
        # don't collide (different chunks' "Speaker 1" become Speaker 1 and
        # Speaker 101, which the rename UI lets users merge if same person).
        speaker_offset = idx * 100
        for seg in chunk_segments:
            seg["start_ms"] = int(seg["start_ms"]) + chunk_offset_ms
            seg["end_ms"] = int(seg["end_ms"]) + chunk_offset_ms
            try:
                sp = int(seg.get("speaker", "1"))
                seg["speaker"] = str(sp + speaker_offset)
            except (TypeError, ValueError):
                seg["speaker"] = str(1 + speaker_offset)

        # Persist this chunk's segments_json IMMEDIATELY so the rebuild-
        # from-DB transcript (next step) sees it. Also enables partial
        # recovery if the pipeline crashes between here and pipeline end.
        await asyncio.to_thread(
            db.save_soniox_chunk_done,
            meeting_id, idx, json.dumps(chunk_segments, ensure_ascii=False),
        )
        all_segments.extend(chunk_segments)

        # Rebuild + persist full transcript from DB (sorted by chunk_idx)
        # so the user can open the meeting and read what's been transcribed
        # while later chunks are still processing. Sort guarantees that
        # late-completing chunks (e.g., retry of chunk 2 after chunks 1+3
        # are done) land at the correct time position in the transcript.
        await _rebuild_soniox_transcript_from_db(meeting_id)

        log.info(
            "[pipeline] Soniox chunk %d/%d done: %d segments, offset=%d ms",
            idx + 1, n_chunks, len(chunk_segments), chunk_offset_ms,
        )

    return all_segments


async def _rebuild_soniox_transcript_from_db(meeting_id: int) -> None:
    """Read all status='done' Soniox chunks from DB (ordered by chunk_idx),
    concat their segments_json, and write the merged transcript back to the
    meeting record.

    This is the single source of truth for the Soniox-chunked transcript —
    called after each chunk completes during initial run AND after each
    retry succeeds. Always reads DB in chunk_idx order, so chunks completed
    out-of-order (retry case) still land at the correct time position.
    """
    rows = await asyncio.to_thread(db.get_upload_chunks, meeting_id)
    if not rows:
        return

    all_segments: list[dict] = []
    for c in rows:  # already ORDER BY chunk_idx from SQL
        if c.get("status") != "done":
            continue
        segments_json = c.get("segments_json")
        if not segments_json:
            continue
        try:
            chunk_segs = json.loads(segments_json)
            if isinstance(chunk_segs, list):
                all_segments.extend(chunk_segs)
        except (json.JSONDecodeError, TypeError):
            log.warning(
                "[pipeline] Bad segments_json for meeting %d chunk %d — skipping",
                meeting_id, c.get("chunk_idx"),
            )

    if not all_segments:
        return

    # Build chunk_results + speaker_map (same shape as the regular Soniox
    # build path so _build_transcript_parts works unchanged).
    chunk_results = []
    speaker_map: dict[int, int] = {}
    for i, seg in enumerate(all_segments):
        chunk_results.append({
            "idx": i,
            "text": seg["text"],
            "embedding": None,
            "start_ms": int(seg["start_ms"]),
            "end_ms": int(seg["end_ms"]),
        })
        try:
            sp_id = max(0, int(seg.get("speaker", "1")) - 1)
        except (ValueError, TypeError):
            sp_id = 0
        speaker_map[i] = sp_id

    parts = _build_transcript_parts(chunk_results, speaker_map)
    transcript_json = json.dumps(parts, ensure_ascii=False)
    await asyncio.to_thread(
        db.update_meeting, meeting_id,
        transcript=transcript_json, status="saved",
    )


def _split_wav_for_soniox(
    wav_path: Path, duration_sec: float, chunks_dir: Path, n_chunks: int,
) -> list[tuple[Path, int]]:
    """Split a PCM 16kHz mono WAV evenly into N chunks via ffmpeg. Returns
    [(chunk_path, offset_ms), ...] for each chunk in time order.

    Even-split (vs fixed 3.5h with short tail) keeps ETA per chunk roughly
    equal — avoids the UX of "chunk 3/3" being a 5-minute leftover that
    makes the progress bar lurch.

    Uses `-c copy` since the source is already canonical PCM WAV (no
    re-encode needed). ffmpeg's `-ss` seek is sample-accurate on PCM.
    """
    ffmpeg = find_ffmpeg()
    chunk_dur = duration_sec / n_chunks
    out: list[tuple[Path, int]] = []

    for idx in range(n_chunks):
        start_sec = idx * chunk_dur
        # Last chunk: -t omitted so ffmpeg reads to EOF (avoids floating-
        # point rounding losing the final fraction of a second).
        chunk_path = chunks_dir / f"soniox_chunk_{idx:02d}.wav"
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-ss", f"{start_sec:.3f}",
            "-i", str(wav_path),
        ]
        if idx < n_chunks - 1:
            cmd += ["-t", f"{chunk_dur:.3f}"]
        cmd += ["-c", "copy", str(chunk_path)]

        popen_kwargs: dict = {"capture_output": True, "timeout": 300}
        if sys.platform == "win32":
            popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        result = subprocess.run(cmd, **popen_kwargs)
        if result.returncode != 0 or not chunk_path.is_file():
            raise RuntimeError(
                f"ffmpeg split chunk {idx} failed: "
                f"{result.stderr.decode(errors='replace')[:300]}"
            )
        offset_ms = int(start_sec * 1000)
        out.append((chunk_path, offset_ms))

    return out


async def _run_nvidia_chunked_pipeline(
    job: JobState, meeting: dict, meeting_id: int, wav_path: Path, tmp_root: Path,
) -> list[dict]:
    """Existing chunked pipeline — VAD split → parallel STT → CAM++ → cluster.

    Used for Nvidia Riva because: (a) Riva has per-call duration caps, (b) we
    get parallel STT speedup, (c) per-chunk persist gives perfect resume.
    """
    job_id = job.job_id

    # ── VAD-aware splitting (or restore plan from DB if resuming) ─────────
    await registry.update(
        job_id, progress=P_SPLIT, message="Phát hiện đoạn nói"
    )
    chunks_dir = tmp_root / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)

    saved_chunks = {c["chunk_idx"]: c for c in db.get_upload_chunks(meeting_id)}
    if saved_chunks:
        # Resume mode: reuse the previously computed plan so chunk boundaries
        # stay consistent with already-saved transcripts.
        log.info(
            "[pipeline] resuming meeting %s: %d chunks already in DB",
            meeting_id, len(saved_chunks),
        )
        chunks = _chunks_from_db_plan(saved_chunks, wav_path, chunks_dir)
    else:
        chunks = await asyncio.to_thread(split_into_chunks, wav_path, chunks_dir)
        if not chunks:
            raise ValueError("Không phát hiện được giọng nói trong file")
        # Persist the plan so a future resume can use the same boundaries.
        db.upsert_chunk_plan(
            meeting_id,
            [(c.idx, c.start_ms, c.end_ms) for c in chunks],
        )

    await registry.update(job_id, total_chunks=len(chunks))
    if _is_cancelled(job):
        return []

    # Re-extract WAV files for chunks that don't have STT text saved yet
    # (saved chunks have their text/embedding in DB — no need to redo).
    pending_chunks = [
        c for c in chunks
        if not (saved_chunks.get(c.idx) and saved_chunks[c.idx].get("text"))
    ]
    if saved_chunks:
        # Materialize the pending chunks' WAV files on disk (extract from
        # normalized.wav using the stored boundaries).
        await asyncio.to_thread(_extract_pending_chunk_files, wav_path, pending_chunks)

    # ── Parallel STT + embedding (only for chunks that need it) ───────────
    await registry.update(
        job_id,
        status=JobStatus.TRANSCRIBING,
        progress=P_TRANSCRIBE_START,
        message=(
            f"Phiên âm {len(saved_chunks)}/{len(chunks)} (resume)"
            if saved_chunks
            else f"Phiên âm ({len(chunks)} chunks)"
        ),
    )
    new_results = await _process_chunks_parallel(
        job, pending_chunks, meeting_id=meeting_id, total_chunks=len(chunks),
        already_done=sum(1 for sc in saved_chunks.values() if sc.get("text")),
    )
    if _is_cancelled(job):
        return []

    # Merge saved + newly processed results into chunk_results
    chunk_results = _merge_saved_and_new_results(saved_chunks, new_results, chunks)

    # ── Global speaker clustering ──────────────────────────────────────────
    await registry.update(
        job_id,
        status=JobStatus.FINALIZING,
        progress=P_FINALIZE,
        message="Phân loại người nói",
    )
    embeddings = [
        (r["idx"], r["embedding"]) for r in chunk_results if r["embedding"] is not None
    ]
    speaker_map = await asyncio.to_thread(cluster_speakers, embeddings)
    if _is_cancelled(job):
        return []

    return _build_transcript_parts(chunk_results, speaker_map)


# ─── Sub-stages ────────────────────────────────────────────────────────────


def _ffprobe_duration(path: Path) -> float:
    """Probe audio/video duration in seconds.

    Used to live off a separate ffprobe binary. Since v1.2.11 we ship ffmpeg
    via imageio-ffmpeg's wheel (zero manual setup for end users) — but
    imageio-ffmpeg does NOT include ffprobe. We parse the "Duration:" line
    that ffmpeg writes to stderr while reading metadata, then terminate
    early so we don't actually decode the whole 4-hour file just for a
    duration probe.
    """
    ffmpeg = find_ffmpeg()
    # Trigger ffmpeg in "read metadata then decode to null" mode. ffmpeg
    # emits the Duration line right after it parses the container header,
    # so we kill the process as soon as we see it (typically <100ms).
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-i", str(path),
        "-f", "null",
        "-",
    ]
    popen_kwargs: dict = {
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.PIPE,
        "text": True,
        "errors": "replace",
    }
    if sys.platform == "win32":
        popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

    try:
        proc = subprocess.Popen(cmd, **popen_kwargs)
    except FileNotFoundError:
        raise RuntimeError(f"ffmpeg binary missing or unreadable: {ffmpeg}")

    duration_seconds: float | None = None
    collected_err: list[str] = []
    duration_pattern = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")

    try:
        assert proc.stderr is not None
        # 30s hard ceiling on metadata read — should normally finish in ms.
        start = time.monotonic()
        for line in proc.stderr:
            collected_err.append(line)
            m = duration_pattern.search(line)
            if m:
                h, m_, s = m.groups()
                try:
                    duration_seconds = int(h) * 3600 + int(m_) * 60 + float(s)
                except (TypeError, ValueError):
                    duration_seconds = None
                break
            if time.monotonic() - start > 30:
                break
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    if duration_seconds is None or duration_seconds <= 0:
        # Show the user the actual ffmpeg complaint instead of a generic
        # error. ffmpeg's error lines are usually self-explanatory ("Invalid
        # data found", "moov atom not found", etc.).
        snippet = "".join(collected_err)[-400:]
        raise RuntimeError(f"Could not read audio duration: {snippet.strip() or 'unknown error'}")

    return duration_seconds


def _normalize_to_wav(source: Path, target: Path) -> None:
    ffmpeg = find_ffmpeg()
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-vn",  # drop any video stream (mp4/mov)
        "-ar",
        "16000",
        "-ac",
        "1",
        "-acodec",
        "pcm_s16le",
        "-f",
        "wav",
        str(target),
    ]
    # 10 minute cap for a 4h source — covers slow disks comfortably.
    kwargs: dict = {"capture_output": True, "timeout": 600}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    result = subprocess.run(cmd, **kwargs)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg normalize failed: "
            f"{result.stderr.decode(errors='replace')[:300]}"
        )


async def _process_chunks_parallel(
    job: JobState,
    chunks: list[AudioChunk],
    *,
    meeting_id: int,
    total_chunks: int,
    already_done: int = 0,
) -> list[dict]:
    """STT + embedding for every chunk concurrently, bounded by a semaphore.

    Each chunk's result is persisted to ``upload_chunks`` immediately and the
    partial transcript JSON is written to ``meetings.transcript`` after every
    chunk. This means:
      - Sidecar restart mid-pipeline → resume picks up where we left off
      - User opens meeting while pipeline runs → sees text filling in live
      - App crash → still have whatever was processed up to that point
    """
    if not chunks:
        return []

    # ── STT provider routing ────────────────────────────────────────────
    # Earlier this hardcoded Nvidia and ignored the user's Settings choice
    # — uploading on a Soniox-configured app still ran Riva, producing
    # "[stt:nvidia-stream-batch] Parakeet …" in the log no matter what.
    stt_provider = (db.get_setting("stt_provider") or "nvidia").strip().lower()
    if stt_provider not in ("nvidia", "soniox"):
        stt_provider = "nvidia"

    if stt_provider == "nvidia":
        nvidia_key = (
            db.get_setting("nvidia_api_key")
            or os.environ.get("NVIDIA_API_KEY", "")
        )
        if not nvidia_key:
            raise RuntimeError(
                "Nvidia API key chưa được cấu hình. Vào Settings → Nvidia API Key."
            )
        stt_lang = db.get_setting("stt_language") or "vi"
        riva_lang = get_language_code(stt_lang)
        soniox_key = ""
        soniox_hints: list[str] = []
    else:
        soniox_key = (
            db.get_setting("soniox_api_key")
            or os.environ.get("SONIOX_API_KEY", "")
        )
        if not soniox_key:
            raise RuntimeError(
                "Soniox API key chưa được cấu hình. Vào Settings → Soniox API Key."
            )
        hints_raw = db.get_setting("soniox_language_hints") or "vi"
        soniox_hints = [h.strip() for h in hints_raw.split(",") if h.strip()] or ["vi"]
        nvidia_key = ""
        riva_lang = ""
    log.info("[pipeline] STT provider: %s", stt_provider)

    diarizer = None
    try:
        from main import diarizer as _diarizer
        diarizer = _diarizer
    except Exception:
        log.warning("[pipeline] global diarizer not available — single-speaker output")

    semaphore = asyncio.Semaphore(_stt_concurrency())
    results: dict[int, dict] = {}
    lock = asyncio.Lock()

    async def _process_one(chunk: AudioChunk):
        async with semaphore:
            if _is_cancelled(job):
                return

            # Dispatch to the configured provider. Nvidia uses streaming gRPC
            # (offline_recognize unavailable for vi/zh). Soniox uses the
            # async file API (stt-async-v4) with auto-cleanup.
            if stt_provider == "nvidia":
                stt_task = asyncio.to_thread(
                    transcribe_nvidia_streaming, str(chunk.path), nvidia_key, riva_lang
                )
            else:
                stt_task = asyncio.to_thread(
                    transcribe_soniox_file, str(chunk.path), soniox_key, soniox_hints
                )
            emb_task = (
                asyncio.to_thread(extract_embedding, diarizer, chunk.path)
                if diarizer is not None
                else asyncio.sleep(0, result=None)
            )
            text_raw, emb_raw = await asyncio.gather(
                stt_task, emb_task, return_exceptions=True
            )

            text = ""
            if isinstance(text_raw, Exception):
                log.warning("[pipeline] STT failed chunk %d: %s", chunk.idx, text_raw)
            elif text_raw:
                text = str(text_raw)

            embedding = None
            if isinstance(emb_raw, Exception):
                log.warning("[pipeline] embed failed chunk %d: %s", chunk.idx, emb_raw)
            else:
                embedding = emb_raw

            text_clean = _filter_hallucinations(text or "").strip()

            # Persist this chunk's result so we can resume after a crash and
            # so the user sees live updates if they open the meeting now.
            embedding_blob = embedding.tobytes() if embedding is not None else None
            await asyncio.to_thread(
                db.save_chunk_result, meeting_id, chunk.idx, text_clean, embedding_blob,
            )

            async with lock:
                results[chunk.idx] = {
                    "idx": chunk.idx,
                    "text": text_clean,
                    "embedding": embedding,
                    "start_ms": chunk.start_ms,
                    "end_ms": chunk.end_ms,
                }
                # Refresh meetings.transcript with everything we have so far.
                await asyncio.to_thread(
                    _flush_partial_transcript, meeting_id,
                )

                done_now = already_done + len(results)

            # Stream this chunk to any live SSE listeners.
            await registry.emit_chunk(
                job.job_id,
                {
                    "idx": chunk.idx,
                    "text": text_clean,
                    "start_ms": chunk.start_ms,
                    "end_ms": chunk.end_ms,
                },
            )

            progress = (
                P_TRANSCRIBE_START
                + (done_now / max(1, total_chunks))
                * (P_TRANSCRIBE_END - P_TRANSCRIBE_START)
            )
            await registry.update(
                job.job_id,
                progress=progress,
                processed_chunks=done_now,
                message=f"Phiên âm {done_now}/{total_chunks}",
            )

    await asyncio.gather(*(_process_one(c) for c in chunks))
    return list(results.values())


def _chunks_from_db_plan(
    saved_chunks: dict[int, dict], wav_path: Path, chunks_dir: Path
) -> list[AudioChunk]:
    """Rebuild AudioChunk list from the chunk plan persisted in DB (resume)."""
    out: list[AudioChunk] = []
    for idx in sorted(saved_chunks.keys()):
        row = saved_chunks[idx]
        chunk_path = chunks_dir / f"chunk_{idx:04d}.wav"
        out.append(AudioChunk(
            idx=idx,
            start_ms=int(row["start_ms"]),
            end_ms=int(row["end_ms"]),
            path=chunk_path,
        ))
    return out


def _extract_pending_chunk_files(wav_path: Path, pending: list[AudioChunk]) -> None:
    """Re-extract WAV slices for chunks whose tmp files are gone after restart."""
    from services.vad_splitter import _extract_chunk_with_ffmpeg
    for c in pending:
        if c.path.exists():
            continue
        c.path.parent.mkdir(parents=True, exist_ok=True)
        duration = max(0, c.end_ms - c.start_ms)
        if duration <= 0:
            continue
        _extract_chunk_with_ffmpeg(wav_path, c.path, c.start_ms, duration)


def _merge_saved_and_new_results(
    saved_chunks: dict[int, dict],
    new_results: list[dict],
    chunks: list[AudioChunk],
) -> list[dict]:
    """Combine DB-persisted chunk results with freshly processed ones.

    Newly-processed (in-memory) results take precedence — they have the
    embedding as an np.ndarray. DB rows store embedding as bytes; deserialize
    here so the clustering step sees a uniform shape.
    """
    import numpy as np

    new_by_idx = {r["idx"]: r for r in new_results}
    chunk_boundaries = {c.idx: (c.start_ms, c.end_ms) for c in chunks}

    out: list[dict] = []
    for idx in sorted({*saved_chunks.keys(), *new_by_idx.keys()}):
        if idx in new_by_idx:
            out.append(new_by_idx[idx])
            continue
        row = saved_chunks[idx]
        emb_bytes = row.get("embedding")
        embedding = None
        if emb_bytes:
            try:
                embedding = np.frombuffer(emb_bytes, dtype=np.float32).copy()
            except Exception as exc:
                log.warning("[pipeline] failed to decode saved embedding %d: %s", idx, exc)
        start_ms, end_ms = chunk_boundaries.get(
            idx, (int(row["start_ms"]), int(row["end_ms"])),
        )
        out.append({
            "idx": idx,
            "text": row.get("text") or "",
            "embedding": embedding,
            "start_ms": start_ms,
            "end_ms": end_ms,
        })
    return out


def _flush_partial_transcript(meeting_id: int) -> None:
    """Write a fresh transcript JSON from all currently saved chunks.

    Speakers are not yet clustered at this stage (clustering needs ALL chunks
    done), so every chunk goes in as Speaker 1. The final pass after
    clustering overwrites this with the correct speaker assignments.
    """
    rows = db.get_upload_chunks(meeting_id)
    if not rows:
        return
    fake_speaker_map = {r["chunk_idx"]: 0 for r in rows}
    interim_results = []
    for r in rows:
        if not (r.get("text") or "").strip():
            continue
        interim_results.append({
            "idx": int(r["chunk_idx"]),
            "text": r["text"],
            "embedding": None,
            "start_ms": int(r["start_ms"]),
            "end_ms": int(r["end_ms"]),
        })
    if not interim_results:
        return
    parts = _build_transcript_parts(interim_results, fake_speaker_map)
    db.update_meeting(
        meeting_id,
        transcript=json.dumps(parts, ensure_ascii=False),
    )


def _ms_to_seconds_str(ms: int | None) -> str:
    """Frontend's fmtSec parses parseFloat(v); emit seconds as a string."""
    if ms is None:
        return "0"
    return f"{ms / 1000:.2f}"


def _build_transcript_parts(
    chunk_results: list[dict], speaker_map: dict[int, int]
) -> list[dict]:
    """Assemble realtime-format transcript JSON — ONE PART PER CHUNK.

    Why no same-speaker merging here (unlike main.py realtime):
      Without a working diarizer every chunk gets speakerId=0 → merging
      collapses a 60-minute meeting into a single block with no per-chunk
      timestamps. Keeping chunks separate guarantees the user sees per-22s
      time badges ("1:24 – 1:46") regardless of whether CAM++ is loaded.

    Overlap text from VAD splitting (1.5s) is de-duplicated against the
    previous chunk's tail so the displayed text doesn't repeat at boundaries.

    Emits `startTime`/`endTime` as seconds strings parseable by the frontend
    fmtSec helper.
    """
    parts: list[dict] = []
    prev_tail = ""

    for r in sorted(chunk_results, key=lambda x: x["idx"]):
        text = (r["text"] or "").strip()
        if not text:
            continue
        if prev_tail:
            text = _strip_overlap_prefix(prev_tail, text)
            if not text:
                continue

        speaker_id = speaker_map.get(r["idx"], 0)
        speaker = f"Speaker {speaker_id + 1}"
        chunk_id = f"upload-{r['idx']:04d}-{uuid4().hex[:8]}"
        start_ms = int(r.get("start_ms") or 0)
        end_ms = int(r.get("end_ms") or 0)

        parts.append(
            {
                "text": text,
                "speaker": speaker,
                "speakerId": speaker_id,
                "chunkId": chunk_id,
                "chunkIds": [chunk_id],
                "chunkData": {chunk_id: text},
                # Frontend fmtSec parses parseFloat — seconds as string.
                "startTime": _ms_to_seconds_str(start_ms),
                "endTime": _ms_to_seconds_str(end_ms),
                "timestamp": "",
                "translation": "",
            }
        )

        prev_tail = text[-120:]

    return parts


def _strip_overlap_prefix(prev_tail: str, current: str) -> str:
    """Remove the longest prefix of `current` that appears as a suffix of prev_tail.

    Cheap O(n) dedup that recovers most word-boundary collisions caused by
    the 1.5s VAD overlap. We don't need perfect — STT itself adds noise.
    """
    max_window = min(len(prev_tail), len(current), 120)
    for k in range(max_window, 5, -1):
        if current[:k] == prev_tail[-k:]:
            return current[k:].lstrip()
    return current


def _summarize_blocking(parts: list[dict], language: str, meeting_id: int) -> str:
    """Drain summarize_stream into a single markdown string.

    Best-effort: returns empty string on any failure so the job still ends
    in `done` (user can retry via the existing /summarize button).
    """
    if not parts:
        return ""
    try:
        from summarize import summarize_stream
    except Exception as exc:
        log.warning("[pipeline] summarize import failed: %s", exc)
        return ""

    lines: list[str] = []
    for p in parts:
        text = (p.get("text") or "").strip()
        if not text:
            continue
        lines.append(f"{p.get('speaker', 'Speaker')}: {text}")
    if not lines:
        return ""
    flat_transcript = "\n".join(lines)

    tokens: list[str] = []
    try:
        for raw_event in summarize_stream(flat_transcript, language, db, meeting_id=meeting_id):
            # Each yielded string is one SSE block: "data: {...}\n\n" or
            # "event: progress\ndata: {...}\n\n" — we only collect token data.
            for line in raw_event.splitlines():
                if not line.startswith("data: "):
                    continue
                try:
                    payload = json.loads(line[6:])
                except json.JSONDecodeError:
                    continue
                tok = payload.get("token")
                if isinstance(tok, str):
                    tokens.append(tok)
    except Exception as exc:
        log.warning("[pipeline] summarize_stream failed: %s", exc)
        return ""

    return "".join(tokens).strip()
