"""
Database module — SQLite via Python stdlib.
Uses thread-local connections for concurrency safety and WAL mode for performance.
"""

import json
import os
import sqlite3
import threading
from pathlib import Path

from logger import get_logger

log = get_logger(__name__)


class Database:
    _instance = None
    _lock = threading.Lock()
    _local = threading.local()  # Thread-local storage for connections

    def __new__(cls):
        if cls._instance is None:
            inst = super().__new__(cls)
            # One-time init lives in __new__ so subsequent `Database()` calls
            # from any module (e.g. lazy imports during a request) don't blow
            # away the already-initialised _db_path. Previously __init__ ran
            # every time, resetting state and producing the classic crash
            # "expected str, bytes or os.PathLike object, not NoneType" the
            # next time anything called db.get_setting()/get_meeting().
            inst._db_path = None
            inst._initialized = False
            cls._instance = inst
        return cls._instance

    def __init__(self):
        # Intentionally a no-op. State is set in __new__ once; later
        # `Database()` calls return the same singleton without resetting.
        pass

    def init(self, db_path: str | None = None):
        if self._initialized:
            return

        if db_path is None:
            data_dir = os.getenv("VOICESCRIBE_DATA", os.path.join(os.path.expanduser("~"), ".voicescribe"))
            os.makedirs(data_dir, exist_ok=True)
            db_path = os.path.join(data_dir, "voicescribe.db")

        self._db_path = db_path
        self._create_tables()
        self._migrate_v2()
        self._initialized = True
        log.info("SQLite: %s", db_path)

    def _conn(self) -> sqlite3.Connection:
        """Return a thread-local SQLite connection (creates one if needed)."""
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self._db_path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            # WAL mode: allows concurrent readers while writing
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA cache_size=-8000")  # 8MB cache
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.conn = conn
            log.debug("New SQLite connection for thread %s", threading.current_thread().name)
        return conn

    def close_thread_connection(self):
        """Close and remove the thread-local connection (call from thread cleanup)."""
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            self._local.conn = None

    def _create_tables(self):
        conn = self._conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS meetings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT 'Untitled',
                transcript TEXT DEFAULT '',
                summary TEXT DEFAULT '',
                translations TEXT DEFAULT '',
                audio_path TEXT DEFAULT '',
                audio_duration REAL DEFAULT 0,
                language TEXT DEFAULT 'vi',
                status TEXT DEFAULT 'saved',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT DEFAULT ''
            );
        """)
        conn.commit()

    def _migrate_v2(self):
        """Idempotent migration: add columns for upload audio feature.

        Safe to run repeatedly — duplicate ADD COLUMN errors are ignored.
        Existing rows get default values; realtime flow unaffected.
        """
        conn = self._conn()
        migrations = [
            "ALTER TABLE meetings ADD COLUMN source_type TEXT DEFAULT 'realtime'",
            "ALTER TABLE meetings ADD COLUMN file_hash TEXT DEFAULT NULL",
            "ALTER TABLE meetings ADD COLUMN source_filename TEXT DEFAULT NULL",
            "CREATE INDEX IF NOT EXISTS idx_meetings_file_hash ON meetings(file_hash)",
        ]
        for sql in migrations:
            try:
                conn.execute(sql)
            except sqlite3.OperationalError as e:
                if "duplicate column" not in str(e).lower():
                    log.warning("Migration skipped (%s): %s", sql[:60], e)

        # ── Per-chunk progress (upload pipeline resume) ──
        # text IS NULL until STT completes; embedding BLOB is the raw 512×f32
        # vector from CAM++ (or NULL when diarizer disabled).
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS upload_chunks (
                meeting_id INTEGER NOT NULL,
                chunk_idx INTEGER NOT NULL,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                text TEXT DEFAULT NULL,
                embedding BLOB DEFAULT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (meeting_id, chunk_idx)
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_upload_chunks_meeting ON upload_chunks(meeting_id)"
        )

        # ── Reference materials attached to a meeting ──
        # Plain-text only (md / txt). Content lives directly in the DB row —
        # md/txt are tiny so the simpler model wins over disk+DB hybrid.
        # FK with CASCADE so deleting a meeting also drops its attachments.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meeting_attachments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                mime_type TEXT DEFAULT 'text/plain',
                size_bytes INTEGER NOT NULL,
                content_text TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_attachments_meeting ON meeting_attachments(meeting_id)"
        )
        conn.commit()

    # ─── Upload chunks (resume support) ───
    def upsert_chunk_plan(self, meeting_id: int, plan: list[tuple[int, int, int]]) -> None:
        """Persist the chunk plan (idx, start_ms, end_ms). Idempotent — won't
        overwrite text/embedding of chunks already processed.
        """
        if not plan:
            return
        conn = self._conn()
        conn.executemany(
            "INSERT OR IGNORE INTO upload_chunks (meeting_id, chunk_idx, start_ms, end_ms) "
            "VALUES (?, ?, ?, ?)",
            [(meeting_id, idx, s, e) for (idx, s, e) in plan],
        )
        conn.commit()

    def save_chunk_result(
        self,
        meeting_id: int,
        chunk_idx: int,
        text: str,
        embedding: bytes | None,
    ) -> None:
        """Persist STT result + embedding for one chunk. Upsert semantics."""
        conn = self._conn()
        conn.execute(
            """
            INSERT INTO upload_chunks (meeting_id, chunk_idx, start_ms, end_ms, text, embedding, updated_at)
            VALUES (?, ?, 0, 0, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(meeting_id, chunk_idx) DO UPDATE SET
                text = excluded.text,
                embedding = excluded.embedding,
                updated_at = CURRENT_TIMESTAMP
            """,
            (meeting_id, chunk_idx, text, embedding),
        )
        conn.commit()

    def get_upload_chunks(self, meeting_id: int) -> list[dict]:
        """Return all upload_chunks rows for a meeting, ordered by chunk_idx."""
        conn = self._conn()
        rows = conn.execute(
            "SELECT chunk_idx, start_ms, end_ms, text, embedding "
            "FROM upload_chunks WHERE meeting_id = ? ORDER BY chunk_idx",
            (meeting_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def delete_upload_chunks(self, meeting_id: int) -> None:
        conn = self._conn()
        conn.execute("DELETE FROM upload_chunks WHERE meeting_id = ?", (meeting_id,))
        conn.commit()

    # ─── Meeting attachments (reference materials for LLM summary) ───
    def add_attachment(
        self,
        meeting_id: int,
        filename: str,
        mime_type: str,
        size_bytes: int,
        content_text: str,
    ) -> int:
        conn = self._conn()
        cur = conn.execute(
            "INSERT INTO meeting_attachments "
            "(meeting_id, filename, mime_type, size_bytes, content_text) "
            "VALUES (?, ?, ?, ?, ?)",
            (meeting_id, filename, mime_type, size_bytes, content_text),
        )
        conn.commit()
        return cur.lastrowid

    def list_attachments(self, meeting_id: int) -> list[dict]:
        """Return attachment metadata (without content_text — that can be huge).

        Use ``get_attachment(id)`` to fetch full text for display/preview.
        """
        conn = self._conn()
        rows = conn.execute(
            "SELECT id, meeting_id, filename, mime_type, size_bytes, created_at "
            "FROM meeting_attachments WHERE meeting_id = ? ORDER BY created_at ASC",
            (meeting_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_attachment(self, attachment_id: int) -> dict | None:
        conn = self._conn()
        row = conn.execute(
            "SELECT id, meeting_id, filename, mime_type, size_bytes, content_text, created_at "
            "FROM meeting_attachments WHERE id = ?",
            (attachment_id,),
        ).fetchone()
        return dict(row) if row else None

    def delete_attachment(self, attachment_id: int, meeting_id: int) -> bool:
        """Delete a single attachment, scoped to its meeting (defence-in-depth).

        Returns True if a row was actually removed.
        """
        conn = self._conn()
        cur = conn.execute(
            "DELETE FROM meeting_attachments WHERE id = ? AND meeting_id = ?",
            (attachment_id, meeting_id),
        )
        conn.commit()
        return cur.rowcount > 0

    def get_attachments_combined_text(self, meeting_id: int) -> str:
        """Concatenate all attachments for a meeting into a single string.

        Used by ``summarize_stream`` to inject reference context. Each block is
        delimited with the filename so the LLM can cite if needed.
        """
        conn = self._conn()
        rows = conn.execute(
            "SELECT filename, content_text FROM meeting_attachments "
            "WHERE meeting_id = ? ORDER BY created_at ASC",
            (meeting_id,),
        ).fetchall()
        if not rows:
            return ""
        blocks = [
            f"### {r['filename']}\n{r['content_text']}".strip()
            for r in rows if (r["content_text"] or "").strip()
        ]
        return "\n\n---\n\n".join(blocks)

    # ─── Meetings ───
    def create_meeting(self, title: str, transcript: str, summary: str,
                       audio_duration: float, language: str, status: str = "saved") -> int:
        conn = self._conn()
        cur = conn.execute(
            "INSERT INTO meetings (title, transcript, summary, audio_duration, language, status) VALUES (?, ?, ?, ?, ?, ?)",
            (title, transcript, summary, audio_duration, language, status),
        )
        conn.commit()
        return cur.lastrowid

    def get_meeting(self, mid: int) -> dict | None:
        conn = self._conn()
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (mid,)).fetchone()
        return dict(row) if row else None

    def get_all_meetings(self) -> list[dict]:
        conn = self._conn()
        rows = conn.execute("SELECT * FROM meetings ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]

    # Allowed column names for update (whitelist against SQL injection)
    _ALLOWED_UPDATE_COLS = frozenset({
        "title", "transcript", "summary", "translations", "audio_path",
        "audio_duration", "language", "status",
        "source_type", "source_filename", "file_hash",
    })

    def update_meeting(self, mid: int, **kwargs):
        # Validate column names against whitelist
        invalid = set(kwargs) - self._ALLOWED_UPDATE_COLS
        if invalid:
            raise ValueError(f"Invalid column(s) for update: {invalid}")
        conn = self._conn()
        sets = ", ".join(f"{k} = ?" for k in kwargs)
        vals = list(kwargs.values()) + [mid]
        conn.execute(f"UPDATE meetings SET {sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?", vals)
        conn.commit()

    def update_chunk_speaker(self, chunk_id: str, new_speaker_id: int) -> int:
        """Update speakerId by chunkId in transcript JSON arrays.

        Returns number of meetings updated.
        """
        if not chunk_id:
            return 0

        conn = self._conn()
        rows = conn.execute(
            "SELECT id, transcript FROM meetings WHERE transcript LIKE ?",
            (f"%{chunk_id}%",),
        ).fetchall()

        updated = 0
        for row in rows:
            transcript = row["transcript"] or ""
            if not transcript or not transcript.lstrip().startswith("["):
                continue
            try:
                parts = json.loads(transcript)
            except Exception:
                continue
            if not isinstance(parts, list):
                continue

            changed = False
            for part in parts:
                if not isinstance(part, dict):
                    continue
                ids = set()
                cid = part.get("chunkId")
                if isinstance(cid, str) and cid:
                    ids.add(cid)
                cid_snake = part.get("chunk_id")
                if isinstance(cid_snake, str) and cid_snake:
                    ids.add(cid_snake)
                cids = part.get("chunkIds")
                if isinstance(cids, list):
                    for item in cids:
                        if isinstance(item, str) and item:
                            ids.add(item)

                if chunk_id not in ids:
                    continue

                part["speakerId"] = int(new_speaker_id)
                part["speaker"] = f"Speaker {int(new_speaker_id) + 1}"
                changed = True

            if changed:
                conn.execute(
                    "UPDATE meetings SET transcript = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (json.dumps(parts, ensure_ascii=False), row["id"]),
                )
                updated += 1

        conn.commit()
        return updated

    def delete_meeting(self, mid: int):
        conn = self._conn()
        conn.execute("DELETE FROM meetings WHERE id = ?", (mid,))
        conn.commit()

    def find_meeting_by_hash(self, file_hash: str) -> int | None:
        """Idempotency lookup for uploaded files. Returns meeting_id if exists, else None."""
        if not file_hash:
            return None
        conn = self._conn()
        row = conn.execute(
            "SELECT id FROM meetings WHERE file_hash = ? LIMIT 1",
            (file_hash,),
        ).fetchone()
        return row["id"] if row else None

    # ─── Settings ───
    def get_setting(self, key: str) -> str | None:
        conn = self._conn()
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_setting(self, key: str, value: str):
        conn = self._conn()
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
        conn.commit()

    def get_all_settings(self) -> dict:
        conn = self._conn()
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}
