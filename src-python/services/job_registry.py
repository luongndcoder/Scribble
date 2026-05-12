"""In-memory job registry for upload audio pipeline.

Lifecycle: pending → uploading → normalizing → transcribing → finalizing → done
                                                                          ↓
                                                                       failed | cancelled

Job state lives only in memory. Persistence across sidecar restart is intentionally
deferred (see docs/upload-feature/00-overview.md decision D7).
"""

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class JobStatus(str, Enum):
    PENDING = "pending"
    UPLOADING = "uploading"
    NORMALIZING = "normalizing"
    TRANSCRIBING = "transcribing"
    FINALIZING = "finalizing"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


_TERMINAL_STATES = {JobStatus.DONE, JobStatus.FAILED, JobStatus.CANCELLED}


@dataclass
class JobState:
    job_id: str
    meeting_id: int
    status: JobStatus = JobStatus.PENDING
    progress: float = 0.0  # 0.0 → 1.0
    message: str = ""
    error: str | None = None
    total_chunks: int = 0
    processed_chunks: int = 0
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    update_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=500))

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "meeting_id": self.meeting_id,
            "status": self.status.value,
            "progress": self.progress,
            "message": self.message,
            "error": self.error,
            "total_chunks": self.total_chunks,
            "processed_chunks": self.processed_chunks,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class JobRegistry:
    def __init__(self):
        self._jobs: dict[str, JobState] = {}
        self._lock = asyncio.Lock()

    def create(self, meeting_id: int) -> JobState:
        job_id = uuid.uuid4().hex
        job = JobState(job_id=job_id, meeting_id=meeting_id)
        self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> JobState | None:
        return self._jobs.get(job_id)

    async def update(self, job_id: str, **fields):
        async with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            for key, value in fields.items():
                if not hasattr(job, key):
                    continue
                if key == "status" and isinstance(value, str):
                    value = JobStatus(value)
                setattr(job, key, value)
            job.updated_at = time.time()
            payload = {"type": "status", **job.to_dict()}
            self._safe_emit(job, payload)

    async def emit_chunk(self, job_id: str, chunk_payload: dict[str, Any]):
        """Stream a transcribed chunk to SSE listeners (used by pipeline in Phase 2)."""
        job = self._jobs.get(job_id)
        if not job:
            return
        payload = {"type": "chunk", **chunk_payload}
        self._safe_emit(job, payload)

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job:
            return False
        if job.status in _TERMINAL_STATES:
            return False
        job.cancel_event.set()
        return True

    def cleanup_stale(self, max_age_seconds: int = 24 * 3600) -> int:
        """Drop finished jobs older than max_age_seconds. Returns count removed."""
        now = time.time()
        stale = [
            jid for jid, job in self._jobs.items()
            if job.status in _TERMINAL_STATES and (now - job.updated_at) > max_age_seconds
        ]
        for jid in stale:
            del self._jobs[jid]
        return len(stale)

    @staticmethod
    def _safe_emit(job: JobState, payload: dict[str, Any]):
        """Best-effort enqueue. If queue full, drop oldest non-status events."""
        try:
            job.update_queue.put_nowait(payload)
        except asyncio.QueueFull:
            try:
                _ = job.update_queue.get_nowait()
                job.update_queue.put_nowait(payload)
            except Exception:
                pass


registry = JobRegistry()
