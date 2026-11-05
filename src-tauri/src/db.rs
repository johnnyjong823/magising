// SQLite：歌詞快取與每首歌的偏好（偏移、手動綁定）。只存在本機（data\karaoke.db）
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

static DB: Mutex<Option<Connection>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
    let mut g = DB.lock().unwrap();
    if g.is_none() {
        let c = Connection::open(crate::paths::file("karaoke.db")).map_err(|e| e.to_string())?;
        c.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS lyrics_cache (
               track_key    TEXT PRIMARY KEY,
               provider     TEXT NOT NULL,
               provider_id  TEXT,
               format       TEXT NOT NULL,           -- lrc | yrc | krc | plain
               raw_content  TEXT NOT NULL,
               translation  TEXT,
               confidence   REAL,
               matched      TEXT,                    -- 對到的「歌手 - 歌名」，顯示用
               fetched_at   INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS track_pref (
               track_key    TEXT PRIMARY KEY,
               offset_ms    INTEGER NOT NULL DEFAULT 0,
               pinned       INTEGER NOT NULL DEFAULT 0   -- 1 = 手動綁定，不自動覆蓋
             );",
        )
        .map_err(|e| e.to_string())?;
        // v0.3 新增：羅馬拼音。舊資料庫補欄位，已經有了會失敗，忽略
        let _ = c.execute("ALTER TABLE lyrics_cache ADD COLUMN romaji TEXT", []);
        *g = Some(c);
    }
    f(g.as_ref().unwrap()).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LyricsRow {
    track_key: String,
    provider: String,
    provider_id: Option<String>,
    format: String,
    raw_content: String,
    translation: Option<String>,
    #[serde(default)]
    romaji: Option<String>,
    confidence: Option<f64>,
    matched: Option<String>,
    #[serde(default)]
    fetched_at: i64,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Pref {
    offset_ms: i64,
    pinned: bool,
}

#[tauri::command]
pub fn db_lyrics_get(track_key: String) -> Result<Option<LyricsRow>, String> {
    with(|c| {
        c.query_row(
            "SELECT track_key, provider, provider_id, format, raw_content, translation, confidence, matched, fetched_at, romaji
             FROM lyrics_cache WHERE track_key = ?1",
            params![track_key],
            |r| {
                Ok(LyricsRow {
                    track_key: r.get(0)?,
                    provider: r.get(1)?,
                    provider_id: r.get(2)?,
                    format: r.get(3)?,
                    raw_content: r.get(4)?,
                    translation: r.get(5)?,
                    confidence: r.get(6)?,
                    matched: r.get(7)?,
                    fetched_at: r.get(8)?,
                    romaji: r.get(9)?,
                })
            },
        )
        .optional()
    })
}

#[tauri::command]
pub fn db_lyrics_put(mut row: LyricsRow) -> Result<(), String> {
    row.fetched_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    with(|c| {
        c.execute(
            "INSERT OR REPLACE INTO lyrics_cache
             (track_key, provider, provider_id, format, raw_content, translation, confidence, matched, fetched_at, romaji)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                row.track_key,
                row.provider,
                row.provider_id,
                row.format,
                row.raw_content,
                row.translation,
                row.confidence,
                row.matched,
                row.fetched_at,
                row.romaji
            ],
        )
        .map(|_| ())
    })
}

#[tauri::command]
pub fn db_lyrics_delete(track_key: String) -> Result<(), String> {
    with(|c| c.execute("DELETE FROM lyrics_cache WHERE track_key = ?1", params![track_key]).map(|_| ()))
}

#[tauri::command]
pub fn db_pref_get(track_key: String) -> Result<Pref, String> {
    with(|c| {
        c.query_row("SELECT offset_ms, pinned FROM track_pref WHERE track_key = ?1", params![track_key], |r| {
            Ok(Pref { offset_ms: r.get(0)?, pinned: r.get::<_, i64>(1)? != 0 })
        })
        .optional()
        .map(|p| p.unwrap_or_default())
    })
}

#[tauri::command]
pub fn db_pref_set(track_key: String, offset_ms: Option<i64>, pinned: Option<bool>) -> Result<(), String> {
    with(|c| {
        c.execute("INSERT OR IGNORE INTO track_pref (track_key) VALUES (?1)", params![track_key])?;
        if let Some(o) = offset_ms {
            c.execute("UPDATE track_pref SET offset_ms = ?2 WHERE track_key = ?1", params![track_key, o])?;
        }
        if let Some(p) = pinned {
            c.execute("UPDATE track_pref SET pinned = ?2 WHERE track_key = ?1", params![track_key, p as i64])?;
        }
        Ok(())
    })
}
