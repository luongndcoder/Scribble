//! Database module — SQLite via rusqlite (bundled).
//!
//! Rust port of `src-python/db.py`. The on-disk schema is owned by the existing
//! `voicescribe.db`; every statement here is byte-compatible with the Python
//! implementation so an existing database opens unchanged.
//!
//! Concurrency: the Python side used a thread-local connection per thread. The
//! Rust side keeps a single `Mutex<Connection>` — server traffic on this local
//! single-user sidecar is low-volume, and a mutex removes the whole class of
//! cross-connection locking bugs. WAL is enabled so external readers (e.g. a
//! still-running Python sidecar during migration) are unaffected.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use rusqlite::{params, Connection, OptionalExtension, Row};

/// Column whitelist for `update_meeting` — mirrors `_ALLOWED_UPDATE_COLS`.
/// Guards against SQL injection through dynamically-built SET clauses.
const ALLOWED_UPDATE_COLS: &[&str] = &[
    "title",
    "transcript",
    "summary",
    "translations",
    "audio_path",
    "audio_duration",
    "language",
    "status",
    "source_type",
    "source_filename",
    "file_hash",
    "failed_chunks_count",
];

/// The 15 `meetings` columns, in schema order. Used for `SELECT` so the JSON
/// field order matches `SELECT *` from the Python driver.
pub const MEETING_COLS: &str = "id, title, transcript, summary, translations, \
audio_path, audio_duration, language, status, created_at, updated_at, \
source_type, file_hash, source_filename, failed_chunks_count";

static DB: OnceLock<Database> = OnceLock::new();

/// Process-wide database handle.
pub struct Database {
    conn: Mutex<Connection>,
    path: PathBuf,
    data_dir: PathBuf,
}

impl Database {
    /// Initialise the process-wide singleton and run idempotent migrations.
    ///
    /// `db_path` defaults to `$VOICESCRIBE_DATA/voicescribe.db`, falling back to
    /// `~/.voicescribe/voicescribe.db` — identical to `Database.init()`.
    pub fn init(db_path: Option<PathBuf>) -> Result<&'static Database, String> {
        if let Some(db) = DB.get() {
            return Ok(db);
        }

        let path = match db_path {
            Some(p) => p,
            None => {
                let dir = default_data_dir();
                std::fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
                dir.join("voicescribe.db")
            }
        };

        let data_dir = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(default_data_dir);

        let conn = Connection::open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;

        // Pragmas — mirror db.py _conn().
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA cache_size=-8000;
             PRAGMA foreign_keys=ON;",
        )
        .map_err(|e| format!("pragma: {e}"))?;

        let db = Database {
            conn: Mutex::new(conn),
            path,
            data_dir,
        };
        db.create_tables()?;
        db.migrate_v2()?;

        log::info!("SQLite (rust): {}", db.path.display());
        // A racing initialiser loses the set, but both instances are equivalent
        // and the loser is dropped; the winner is what every caller receives.
        let _ = DB.set(db);
        Ok(DB.get().expect("database initialised above"))
    }

    /// Already-initialised handle, if any.
    pub fn get() -> Option<&'static Database> {
        DB.get()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Data directory — `VOICESCRIBE_DATA` when set, else the DB's parent.
    /// Mirrors `_voicescribe_data_dir()` in api/meetings.py + api/drafts.py.
    pub fn data_dir(&self) -> PathBuf {
        if let Ok(env_dir) = std::env::var("VOICESCRIBE_DATA") {
            if !env_dir.is_empty() {
                return PathBuf::from(env_dir);
            }
        }
        self.data_dir.clone()
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        // A poisoned mutex only means some earlier request panicked mid-query.
        // The connection itself stays usable, so recover rather than abort
        // every subsequent request.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ─── Schema ───

    fn create_tables(&self) -> Result<(), String> {
        self.lock()
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS meetings (
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
                );",
            )
            .map_err(|e| format!("create tables: {e}"))
    }

    /// Idempotent migration adding the upload/v1.2.13 columns.
    ///
    /// Child tables are created FIRST (see db.py for why), then ALTERs run and
    /// "duplicate column" is swallowed so re-running is safe.
    fn migrate_v2(&self) -> Result<(), String> {
        let conn = self.lock();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS upload_chunks (
                meeting_id INTEGER NOT NULL,
                chunk_idx INTEGER NOT NULL,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                text TEXT DEFAULT NULL,
                embedding BLOB DEFAULT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT NULL,
                error_message TEXT DEFAULT NULL,
                segments_json TEXT DEFAULT NULL,
                PRIMARY KEY (meeting_id, chunk_idx)
            );
            CREATE INDEX IF NOT EXISTS idx_upload_chunks_meeting ON upload_chunks(meeting_id);

            CREATE TABLE IF NOT EXISTS meeting_attachments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                mime_type TEXT DEFAULT 'text/plain',
                size_bytes INTEGER NOT NULL,
                content_text TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_attachments_meeting ON meeting_attachments(meeting_id);",
        )
        .map_err(|e| format!("create child tables: {e}"))?;

        let migrations = [
            "ALTER TABLE meetings ADD COLUMN source_type TEXT DEFAULT 'realtime'",
            "ALTER TABLE meetings ADD COLUMN file_hash TEXT DEFAULT NULL",
            "ALTER TABLE meetings ADD COLUMN source_filename TEXT DEFAULT NULL",
            "CREATE INDEX IF NOT EXISTS idx_meetings_file_hash ON meetings(file_hash)",
            "ALTER TABLE meetings ADD COLUMN failed_chunks_count INTEGER DEFAULT 0",
            "ALTER TABLE upload_chunks ADD COLUMN status TEXT DEFAULT NULL",
            "ALTER TABLE upload_chunks ADD COLUMN error_message TEXT DEFAULT NULL",
            "ALTER TABLE upload_chunks ADD COLUMN segments_json TEXT DEFAULT NULL",
        ];
        for sql in migrations {
            if let Err(e) = conn.execute(sql, []) {
                let msg = e.to_string().to_lowercase();
                if !msg.contains("duplicate column") {
                    log::warn!("Migration skipped ({}): {}", &sql[..sql.len().min(60)], e);
                }
            }
        }
        Ok(())
    }

    // ─── Meetings ───

    /// Insert a meeting. Returns the new rowid.
    pub fn create_meeting(
        &self,
        title: &str,
        transcript: &str,
        summary: &str,
        audio_duration: f64,
        language: &str,
        status: &str,
    ) -> Result<i64, String> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO meetings (title, transcript, summary, audio_duration, language, status) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![title, transcript, summary, audio_duration, language, status],
        )
        .map_err(|e| format!("create_meeting: {e}"))?;
        Ok(conn.last_insert_rowid())
    }

    fn row_to_meeting(row: &Row<'_>) -> rusqlite::Result<serde_json::Value> {
        use serde_json::{Map, Value};
        let mut m = Map::new();
        m.insert("id".into(), Value::from(row.get::<_, i64>(0)?));
        m.insert("title".into(), str_or_empty(row.get::<_, Option<String>>(1)?));
        m.insert(
            "transcript".into(),
            str_or_empty(row.get::<_, Option<String>>(2)?),
        );
        m.insert("summary".into(), str_or_empty(row.get::<_, Option<String>>(3)?));
        m.insert(
            "translations".into(),
            str_or_empty(row.get::<_, Option<String>>(4)?),
        );
        m.insert(
            "audio_path".into(),
            str_or_empty(row.get::<_, Option<String>>(5)?),
        );
        let dur: Option<f64> = row.get(6)?;
        m.insert("audio_duration".into(), Value::from(dur.unwrap_or(0.0)));
        m.insert("language".into(), str_or_empty(row.get::<_, Option<String>>(7)?));
        m.insert("status".into(), str_or_empty(row.get::<_, Option<String>>(8)?));
        m.insert(
            "created_at".into(),
            str_or_empty(row.get::<_, Option<String>>(9)?),
        );
        m.insert(
            "updated_at".into(),
            str_or_empty(row.get::<_, Option<String>>(10)?),
        );
        m.insert(
            "source_type".into(),
            str_or_empty(row.get::<_, Option<String>>(11)?),
        );
        // file_hash / source_filename are genuinely NULL-able and the frontend
        // distinguishes null from "" — keep them as null.
        m.insert(
            "file_hash".into(),
            opt_string(row.get::<_, Option<String>>(12)?),
        );
        m.insert(
            "source_filename".into(),
            opt_string(row.get::<_, Option<String>>(13)?),
        );
        let failed: Option<i64> = row.get(14)?;
        m.insert("failed_chunks_count".into(), Value::from(failed.unwrap_or(0)));
        Ok(Value::Object(m))
    }

    pub fn get_meeting(&self, mid: i64) -> Result<Option<serde_json::Value>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(&format!("SELECT {MEETING_COLS} FROM meetings WHERE id = ?1"))
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![mid]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(r) => Ok(Some(Self::row_to_meeting(r).map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    pub fn get_all_meetings(&self) -> Result<Vec<serde_json::Value>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {MEETING_COLS} FROM meetings ORDER BY created_at DESC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], Self::row_to_meeting)
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    /// Update whitelisted columns and bump `updated_at`.
    ///
    /// `updates` values are JSON — strings bind as TEXT, numbers/bools as their
    /// SQLite scalar. Mirrors `db.update_meeting(mid, **kwargs)`.
    pub fn update_meeting(
        &self,
        mid: i64,
        updates: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        if updates.is_empty() {
            return Ok(());
        }
        for k in updates.keys() {
            if !ALLOWED_UPDATE_COLS.contains(&k.as_str()) {
                return Err(format!("Invalid column(s) for update: {{{k}}}"));
            }
        }

        let mut sets = Vec::new();
        let mut vals: Vec<rusqlite::types::Value> = Vec::new();
        for (k, v) in updates {
            sets.push(format!("{k} = ?{}", vals.len() + 1));
            vals.push(json_to_sql(v));
        }
        vals.push(rusqlite::types::Value::Integer(mid));

        let sql = format!(
            "UPDATE meetings SET {}, updated_at = CURRENT_TIMESTAMP WHERE id = ?{}",
            sets.join(", "),
            vals.len()
        );
        self.lock()
            .execute(&sql, rusqlite::params_from_iter(vals))
            .map_err(|e| format!("update_meeting: {e}"))?;
        Ok(())
    }

    pub fn delete_meeting(&self, mid: i64) -> Result<(), String> {
        self.lock()
            .execute("DELETE FROM meetings WHERE id = ?1", params![mid])
            .map_err(|e| format!("delete_meeting: {e}"))?;
        Ok(())
    }

    // ─── Settings ───

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        self.lock()
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .map(|o| o.flatten())
            .map_err(|e| e.to_string())
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.lock()
            .execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                params![key, value],
            )
            .map_err(|e| format!("set_setting: {e}"))?;
        Ok(())
    }

    /// All settings as a JSON object, preserving `SELECT` (rowid) order like
    /// the Python dict comprehension did.
    pub fn get_all_settings(&self) -> Result<serde_json::Map<String, serde_json::Value>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = serde_json::Map::new();
        for row in rows {
            let (k, v) = row.map_err(|e| e.to_string())?;
            out.insert(k, serde_json::Value::String(v));
        }
        Ok(out)
    }
}

/// Meeting attachments — reference materials (md/txt/PDF-extracted text) that
/// the summary prompt cites.
///
/// Added as a second `impl` block so the attachment work stays additive: the
/// table itself is already created by `migrate_v2()`, but no methods existed.
/// Straight port of `src-python/db.py::add_attachment` and friends, including
/// the `ORDER BY created_at ASC` ordering the summarizer depends on.
impl Database {
    /// Insert one attachment. Returns the new rowid.
    pub fn add_attachment(
        &self,
        meeting_id: i64,
        filename: &str,
        mime_type: &str,
        size_bytes: i64,
        content_text: &str,
    ) -> Result<i64, String> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO meeting_attachments \
             (meeting_id, filename, mime_type, size_bytes, content_text) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![meeting_id, filename, mime_type, size_bytes, content_text],
        )
        .map_err(|e| format!("add_attachment: {e}"))?;
        Ok(conn.last_insert_rowid())
    }

    /// Attachment metadata for a meeting, WITHOUT `content_text`.
    ///
    /// The text can be megabytes; the list route only needs sizes and names.
    /// Mirrors `list_attachments`, which deliberately selected a column subset.
    pub fn list_attachments(&self, meeting_id: i64) -> Result<Vec<serde_json::Value>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, meeting_id, filename, mime_type, size_bytes, created_at \
                 FROM meeting_attachments WHERE meeting_id = ?1 ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![meeting_id], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "meeting_id": r.get::<_, i64>(1)?,
                    "filename": r.get::<_, String>(2)?,
                    "mime_type": r.get::<_, Option<String>>(3)?.unwrap_or_else(|| "text/plain".into()),
                    "size_bytes": r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    "created_at": r.get::<_, Option<String>>(5)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    /// One attachment INCLUDING its full text. `None` when the id is unknown.
    pub fn get_attachment(&self, attachment_id: i64) -> Result<Option<serde_json::Value>, String> {
        let conn = self.lock();
        conn.query_row(
            "SELECT id, meeting_id, filename, mime_type, size_bytes, content_text, created_at \
             FROM meeting_attachments WHERE id = ?1",
            params![attachment_id],
            |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, i64>(0)?,
                    "meeting_id": r.get::<_, i64>(1)?,
                    "filename": r.get::<_, String>(2)?,
                    "mime_type": r.get::<_, Option<String>>(3)?.unwrap_or_else(|| "text/plain".into()),
                    "size_bytes": r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    "content_text": r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    "created_at": r.get::<_, Option<String>>(6)?,
                }))
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// Delete an attachment scoped to its meeting (defence in depth).
    ///
    /// Returns false when no row matched — the caller turns that into a 404.
    pub fn delete_attachment(&self, attachment_id: i64, meeting_id: i64) -> Result<bool, String> {
        let conn = self.lock();
        let n = conn
            .execute(
                "DELETE FROM meeting_attachments WHERE id = ?1 AND meeting_id = ?2",
                params![attachment_id, meeting_id],
            )
            .map_err(|e| format!("delete_attachment: {e}"))?;
        Ok(n > 0)
    }

    /// Concatenate every attachment's text for the summary prompt.
    ///
    /// The exact joined format matters: it is injected verbatim into the LLM
    /// prompt, and `summarize.py` produced `### {filename}\n{text}` blocks
    /// separated by `\n\n---\n\n`. Blocks whose text is blank are skipped.
    pub fn get_attachments_combined_text(&self, meeting_id: i64) -> Result<String, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT filename, content_text FROM meeting_attachments \
                 WHERE meeting_id = ?1 ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![meeting_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut blocks: Vec<String> = Vec::new();
        for row in rows {
            let (filename, text) = row.map_err(|e| e.to_string())?;
            if text.trim().is_empty() {
                continue;
            }
            blocks.push(format!("### {filename}\n{text}").trim().to_string());
        }
        Ok(blocks.join("\n\n---\n\n"))
    }

    /// Find a meeting whose upload produced the same file hash.
    ///
    /// Idempotency lookup for re-uploads. Deliberately only matches meetings
    /// that produced a REAL transcript: a previously failed or empty upload must
    /// not block the user from retrying. Empty results are `''` or `'[]'`. This
    /// is belt-and-suspenders alongside the pipeline's failure cleanup, so users
    /// upgrading from older versions are not blocked by leftover empty rows.
    pub fn find_meeting_by_hash(&self, file_hash: &str) -> Result<Option<i64>, String> {
        if file_hash.is_empty() {
            return Ok(None);
        }
        let conn = self.lock();
        conn.query_row(
            "SELECT id FROM meetings \
             WHERE file_hash = ?1 \
               AND transcript IS NOT NULL \
               AND TRIM(transcript) NOT IN ('', '[]') \
             ORDER BY id DESC LIMIT 1",
            params![file_hash],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }
}

// ─── Helpers ───

/// `$VOICESCRIBE_DATA` else `~/.voicescribe`.
pub fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("VOICESCRIBE_DATA") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".voicescribe")
}

fn str_or_empty(v: Option<String>) -> serde_json::Value {
    serde_json::Value::String(v.unwrap_or_default())
}

fn opt_string(v: Option<String>) -> serde_json::Value {
    match v {
        Some(s) => serde_json::Value::String(s),
        None => serde_json::Value::Null,
    }
}

fn json_to_sql(v: &serde_json::Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as V;
    match v {
        serde_json::Value::Null => V::Null,
        serde_json::Value::Bool(b) => V::Integer(i64::from(*b)),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                V::Integer(i)
            } else {
                V::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => V::Text(s.clone()),
        // Objects/arrays are stored as their JSON text, matching Python's
        // behaviour when a caller passes a non-scalar straight to sqlite3.
        other => V::Text(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_db(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vs-db-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("voicescribe.db")
    }

    #[test]
    fn schema_has_15_meeting_columns() {
        let path = temp_db("schema");
        let db = Database {
            conn: Mutex::new(Connection::open(&path).unwrap()),
            path: path.clone(),
            data_dir: path.parent().unwrap().to_path_buf(),
        };
        db.create_tables().unwrap();
        db.migrate_v2().unwrap();
        // Running migrations twice must be a no-op (duplicate-column swallow).
        db.migrate_v2().unwrap();

        let conn = db.lock();
        let mut stmt = conn.prepare("PRAGMA table_info(meetings)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(cols.len(), 15, "columns: {cols:?}");
        assert_eq!(
            cols,
            vec![
                "id",
                "title",
                "transcript",
                "summary",
                "translations",
                "audio_path",
                "audio_duration",
                "language",
                "status",
                "created_at",
                "updated_at",
                "source_type",
                "file_hash",
                "source_filename",
                "failed_chunks_count"
            ]
        );

        for (t, n) in [
            ("settings", 2),
            ("upload_chunks", 10),
            ("meeting_attachments", 7),
        ] {
            let mut s = conn
                .prepare(&format!("PRAGMA table_info({t})"))
                .unwrap();
            let c = s.query_map([], |r| r.get::<_, String>(1)).unwrap().count();
            assert_eq!(c, n, "table {t} column count");
        }
    }

    #[test]
    fn settings_roundtrip_and_replace() {
        let path = temp_db("settings");
        let db = Database {
            conn: Mutex::new(Connection::open(&path).unwrap()),
            path: path.clone(),
            data_dir: path.parent().unwrap().to_path_buf(),
        };
        db.create_tables().unwrap();
        db.set_setting("llm_api_key", "sk-abcdefghijklmnop").unwrap();
        assert_eq!(
            db.get_setting("llm_api_key").unwrap().as_deref(),
            Some("sk-abcdefghijklmnop")
        );
        // INSERT OR REPLACE, not a duplicate-row error.
        db.set_setting("llm_api_key", "sk-second").unwrap();
        assert_eq!(
            db.get_setting("llm_api_key").unwrap().as_deref(),
            Some("sk-second")
        );
        assert_eq!(db.get_setting("absent").unwrap(), None);
        assert_eq!(db.get_all_settings().unwrap().len(), 1);
    }

    #[test]
    fn meeting_crud_and_null_columns() {
        let path = temp_db("crud");
        let db = Database {
            conn: Mutex::new(Connection::open(&path).unwrap()),
            path: path.clone(),
            data_dir: path.parent().unwrap().to_path_buf(),
        };
        db.create_tables().unwrap();
        db.migrate_v2().unwrap();

        let id = db
            .create_meeting("T", "[]", "", 12.5, "vi", "saved")
            .unwrap();
        let m = db.get_meeting(id).unwrap().unwrap();
        assert_eq!(m["title"], "T");
        assert_eq!(m["audio_duration"], json!(12.5));
        assert_eq!(m["status"], "saved");
        assert_eq!(m["source_type"], "realtime");
        assert!(m["file_hash"].is_null(), "file_hash must stay null");
        assert!(m["source_filename"].is_null());
        assert_eq!(m["failed_chunks_count"], json!(0));

        let mut upd = serde_json::Map::new();
        upd.insert("title".into(), json!("T2"));
        upd.insert("audio_duration".into(), json!(99.0));
        upd.insert("status".into(), json!("draft"));
        db.update_meeting(id, &upd).unwrap();
        let m = db.get_meeting(id).unwrap().unwrap();
        assert_eq!(m["title"], "T2");
        assert_eq!(m["audio_duration"], json!(99.0));
        assert_eq!(m["status"], "draft");

        // Non-whitelisted column must be rejected, not silently ignored.
        let mut bad = serde_json::Map::new();
        bad.insert("id".into(), json!(1));
        assert!(db.update_meeting(id, &bad).is_err());

        // created_at DESC ordering. NOTE: CURRENT_TIMESTAMP has 1-second
        // resolution, so rows created in the same second tie and SQLite returns
        // them in rowid order — identical to the Python implementation (verified
        // against Python's sqlite3). Assert set membership + the DESC contract
        // rather than a tie order that neither backend guarantees.
        let id2 = db.create_meeting("T3", "", "", 0.0, "vi", "saved").unwrap();
        let all = db.get_all_meetings().unwrap();
        assert_eq!(all.len(), 2);
        let ids: Vec<i64> = all.iter().map(|m| m["id"].as_i64().unwrap()).collect();
        assert!(ids.contains(&id) && ids.contains(&id2));
        let stamps: Vec<&str> = all
            .iter()
            .map(|m| m["created_at"].as_str().unwrap())
            .collect();
        assert!(
            stamps[0] >= stamps[1],
            "created_at must be non-increasing (DESC): {stamps:?}"
        );

        db.delete_meeting(id).unwrap();
        assert!(db.get_meeting(id).unwrap().is_none());
    }
}
