const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const fs = require('fs');

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const DB_PATH = path.join(dataDir, 'meetings.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

function initTables() {
  const conn = getDb();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      transcript TEXT,
      summary TEXT,
      audio_duration REAL DEFAULT 0,
      language TEXT DEFAULT 'vi',
      status TEXT DEFAULT 'complete',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  // Migration: add status column if missing (existing DBs)
  try { conn.exec(`ALTER TABLE meetings ADD COLUMN status TEXT DEFAULT 'complete'`); } catch (e) { /* already exists */ }
  try { conn.exec(`ALTER TABLE meetings ADD COLUMN audio_path TEXT DEFAULT ''`); } catch (e) { /* already exists */ }
  conn.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function createMeeting({ title, transcript, summary, audioDuration, language }) {
  const conn = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  conn.prepare(`
    INSERT INTO meetings (id, title, transcript, summary, audio_duration, language, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, transcript || '', summary || '', audioDuration || 0, language || 'vi', now, now);
  return id;
}

function getAllMeetings() {
  const conn = getDb();
  return conn.prepare(`
    SELECT id, title, audio_duration, language, status, audio_path, created_at, updated_at
    FROM meetings ORDER BY created_at DESC
  `).all();
}

function getActiveDraft() {
  const conn = getDb();
  return conn.prepare(`SELECT * FROM meetings WHERE status = 'draft' ORDER BY updated_at DESC LIMIT 1`).get() || null;
}

function getMeeting(id) {
  const conn = getDb();
  return conn.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
}

function updateMeeting(id, fields) {
  const conn = getDb();
  const sets = [];
  const values = [];
  for (const [key, val] of Object.entries(fields)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    sets.push(`${col} = ?`);
    values.push(val);
  }
  sets.push("updated_at = datetime('now')");
  values.push(id);
  conn.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

function deleteMeeting(id) {
  const conn = getDb();
  const result = conn.prepare('DELETE FROM meetings WHERE id = ?').run(id);
  return result.changes > 0;
}

function getSetting(key, defaultVal = null) {
  const conn = getDb();
  const row = conn.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultVal;
}

function setSetting(key, value) {
  const conn = getDb();
  conn.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}

function getAllSettings() {
  const conn = getDb();
  const rows = conn.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}

module.exports = { getDb, createMeeting, getAllMeetings, getMeeting, updateMeeting, deleteMeeting, getActiveDraft, getSetting, setSetting, getAllSettings };
