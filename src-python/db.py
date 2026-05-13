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
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        self._db_path = None
        self._initialized = False

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
