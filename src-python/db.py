"""
Database module — SQLite via Python stdlib
"""

import os
import json
import sqlite3
import time
from pathlib import Path
from threading import Lock


class Database:
    _instance = None
    _lock = Lock()

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
        self._initialized = True
        print(f"[db] SQLite: {db_path}")

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        return conn

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
        conn.close()

    # ─── Meetings ───
    def create_meeting(self, title: str, transcript: str, summary: str,
                       audio_duration: float, language: str, status: str = "saved") -> int:
        conn = self._conn()
        cur = conn.execute(
            "INSERT INTO meetings (title, transcript, summary, audio_duration, language, status) VALUES (?, ?, ?, ?, ?, ?)",
            (title, transcript, summary, audio_duration, language, status),
        )
        conn.commit()
        mid = cur.lastrowid
        conn.close()
        return mid

    def get_meeting(self, mid: int) -> dict | None:
        conn = self._conn()
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (mid,)).fetchone()
        conn.close()
        if row:
            return dict(row)
        return None

    def get_all_meetings(self) -> list[dict]:
        conn = self._conn()
        rows = conn.execute("SELECT * FROM meetings ORDER BY created_at DESC").fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def update_meeting(self, mid: int, **kwargs):
        conn = self._conn()
        sets = ", ".join(f"{k} = ?" for k in kwargs)
        vals = list(kwargs.values()) + [mid]
        conn.execute(f"UPDATE meetings SET {sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?", vals)
        conn.commit()
        conn.close()

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
        conn.close()
        return updated

    def delete_meeting(self, mid: int):
        conn = self._conn()
        conn.execute("DELETE FROM meetings WHERE id = ?", (mid,))
        conn.commit()
        conn.close()

    # ─── Settings ───
    def get_setting(self, key: str) -> str | None:
        conn = self._conn()
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        conn.close()
        return row["value"] if row else None

    def set_setting(self, key: str, value: str):
        conn = self._conn()
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
        conn.commit()
        conn.close()

    def get_all_settings(self) -> dict:
        conn = self._conn()
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        conn.close()
        return {r["key"]: r["value"] for r in rows}
