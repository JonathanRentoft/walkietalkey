//! History (spec 6.12) on top of Handy's `transcription_history` table. What
//! Handy's table lacks (the source, and what went to a cloud provider for
//! DESK-85) lives in our own `wt_history_meta` table, created idempotently so
//! Handy's numbered migrations stay untouched. Retention is ours (DESK-91):
//! Handy's own cleanup is off, and ours runs at start, every hour and after
//! each save. Audio is never kept unless "Gem lyd til fejlfinding" is on, and
//! then for at most 7 days (DESK-92).

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use log::{debug, info, warn};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use specta::Type;

use super::settings::HistoryRetention;

/// Debugging audio is deleted after this long (DESK-92).
pub const AUDIO_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// What a cloud cleanup call sent, for "Vis hvad der blev sendt" (DESK-85).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct CleanupRecord {
    pub provider: String,
    /// The exact text sent.
    pub sent_text: String,
    pub duration_ms: u64,
}

/// One history item as the history screen shows it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct HistoryItem {
    pub id: i64,
    /// Unix seconds.
    pub timestamp: i64,
    /// "tast" or the phone's name.
    pub source: String,
    pub text: String,
    /// Whether AI cleanup changed this text.
    pub cleaned: bool,
    pub cleanup: Option<CleanupRecord>,
    /// Debugging audio exists for this item.
    pub has_audio: bool,
}

pub fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS wt_history_meta (
            entry_id INTEGER PRIMARY KEY,
            source TEXT NOT NULL,
            cleanup_provider TEXT,
            cleanup_sent_text TEXT,
            cleanup_ms INTEGER
        );",
    )?;
    Ok(())
}

/// Records the source and cleanup details of a saved entry.
pub fn save_meta(
    conn: &Connection,
    entry_id: i64,
    source: &str,
    cleanup: Option<&CleanupRecord>,
) -> Result<()> {
    ensure_schema(conn)?;
    conn.execute(
        "INSERT OR REPLACE INTO wt_history_meta
            (entry_id, source, cleanup_provider, cleanup_sent_text, cleanup_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            entry_id,
            source,
            cleanup.map(|c| c.provider.as_str()),
            cleanup.map(|c| c.sent_text.as_str()),
            cleanup.map(|c| c.duration_ms as i64),
        ],
    )?;
    Ok(())
}

/// History items, newest first, filtered by `query` (case-insensitive, in
/// the text or the source) when given (DESK-93).
pub fn list(conn: &Connection, query: Option<&str>, limit: usize) -> Result<Vec<HistoryItem>> {
    ensure_schema(conn)?;
    let pattern = query
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(|q| format!("%{}%", q.replace('%', "\\%").replace('_', "\\_")));
    let mut stmt = conn.prepare(
        "SELECT h.id, h.timestamp, h.file_name,
                COALESCE(h.post_processed_text, h.transcription_text) AS text,
                h.post_processed_text IS NOT NULL AS cleaned,
                COALESCE(m.source, 'tast') AS source,
                m.cleanup_provider, m.cleanup_sent_text, m.cleanup_ms
         FROM transcription_history h
         LEFT JOIN wt_history_meta m ON m.entry_id = h.id
         WHERE ?1 IS NULL
            OR COALESCE(h.post_processed_text, h.transcription_text) LIKE ?1 ESCAPE '\\'
            OR COALESCE(m.source, 'tast') LIKE ?1 ESCAPE '\\'
         ORDER BY h.timestamp DESC, h.id DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![pattern, limit as i64], |row| {
        let provider: Option<String> = row.get("cleanup_provider")?;
        let sent: Option<String> = row.get("cleanup_sent_text")?;
        let ms: Option<i64> = row.get("cleanup_ms")?;
        let file_name: String = row.get("file_name")?;
        Ok(HistoryItem {
            id: row.get("id")?,
            timestamp: row.get("timestamp")?,
            source: row.get("source")?,
            text: row.get("text")?,
            cleaned: row.get("cleaned")?,
            cleanup: match (provider, sent) {
                (Some(provider), Some(sent_text)) => Some(CleanupRecord {
                    provider,
                    sent_text,
                    duration_ms: ms.unwrap_or(0).max(0) as u64,
                }),
                _ => None,
            },
            has_audio: !file_name.is_empty(),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// The text of one item, for copying.
pub fn text_of(conn: &Connection, id: i64) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT COALESCE(post_processed_text, transcription_text)
             FROM transcription_history WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?)
}

/// Deletes items (and their audio files); `None` deletes everything
/// ("Slet al historik").
pub fn delete(conn: &Connection, recordings_dir: &Path, ids: Option<&[i64]>) -> Result<usize> {
    ensure_schema(conn)?;
    let targets: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, file_name FROM transcription_history")?;
        let all = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<(i64, String)>>>()?;
        match ids {
            None => all,
            Some(ids) => all.into_iter().filter(|(id, _)| ids.contains(id)).collect(),
        }
    };
    for (id, file_name) in &targets {
        conn.execute(
            "DELETE FROM transcription_history WHERE id = ?1",
            params![id],
        )?;
        conn.execute(
            "DELETE FROM wt_history_meta WHERE entry_id = ?1",
            params![id],
        )?;
        remove_audio(recordings_dir, file_name);
    }
    Ok(targets.len())
}

fn remove_audio(recordings_dir: &Path, file_name: &str) {
    if file_name.is_empty() || file_name.contains(['/', '\\']) {
        return;
    }
    let path = recordings_dir.join(file_name);
    if path.is_file() {
        if let Err(e) = std::fs::remove_file(&path) {
            warn!("Could not delete audio {}: {e}", path.display());
        }
    }
}

/// Deletes items older than the retention period (DESK-91) and debugging
/// audio older than 7 days (DESK-92). Returns how many items went.
pub fn apply_retention(
    conn: &Connection,
    recordings_dir: &Path,
    retention: HistoryRetention,
    now: i64,
) -> Result<usize> {
    ensure_schema(conn)?;
    let deleted = match retention.days() {
        None => 0,
        Some(days) => {
            let cutoff = now - i64::from(days) * 24 * 60 * 60;
            let ids: Vec<i64> = {
                let mut stmt = conn.prepare(
                    "SELECT id FROM transcription_history WHERE timestamp < ?1 OR ?2 = 0",
                )?;
                let rows = stmt.query_map(params![cutoff, days], |row| row.get(0))?;
                rows.collect::<rusqlite::Result<Vec<i64>>>()?
            };
            if ids.is_empty() {
                0
            } else {
                delete(conn, recordings_dir, Some(&ids))?
            }
        }
    };
    // Audio kept for debugging goes after 7 days even when the text stays.
    let audio_cutoff = now - AUDIO_MAX_AGE.as_secs() as i64;
    let old_audio: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, file_name FROM transcription_history
             WHERE file_name != '' AND timestamp < ?1",
        )?;
        let rows = stmt.query_map(params![audio_cutoff], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, file_name) in old_audio {
        remove_audio(recordings_dir, &file_name);
        conn.execute(
            "UPDATE transcription_history SET file_name = '' WHERE id = ?1",
            params![id],
        )?;
    }
    sweep_audio(conn, recordings_dir, now)?;
    if deleted > 0 {
        info!("History retention removed {deleted} item(s)");
    }
    Ok(deleted)
}

/// A recording no history item points to is kept this long at most: long
/// enough for the dictation that wrote it to save its item.
const UNREFERENCED_AUDIO_GRACE: Duration = Duration::from_secs(10 * 60);

/// Deletes audio files that no item refers to (a dictation that heard
/// nothing, was cancelled, or ran under "Gem ikke") once they are past the
/// grace period, and any file older than 7 days (DESK-92).
fn sweep_audio(conn: &Connection, recordings_dir: &Path, now: i64) -> Result<()> {
    let Ok(dir) = std::fs::read_dir(recordings_dir) else {
        return Ok(());
    };
    let referenced: std::collections::HashSet<String> = {
        let mut stmt =
            conn.prepare("SELECT file_name FROM transcription_history WHERE file_name != ''")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for entry in dir.flatten() {
        let path = entry.path();
        let (Some(name), Ok(meta)) = (
            path.file_name()
                .and_then(|n| n.to_str())
                .map(str::to_string),
            entry.metadata(),
        ) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let age = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|m| now.saturating_sub(m.as_secs() as i64).max(0) as u64)
            .unwrap_or(0);
        let expired = age > AUDIO_MAX_AGE.as_secs();
        let orphaned = !referenced.contains(&name) && age > UNREFERENCED_AUDIO_GRACE.as_secs();
        if expired || orphaned {
            remove_audio(recordings_dir, &name);
        }
    }
    Ok(())
}

/// The history database and recordings folder in the app data folder.
pub fn paths(app_data_dir: &Path) -> (PathBuf, PathBuf) {
    (
        app_data_dir.join("history.db"),
        app_data_dir.join("recordings"),
    )
}

/// Opens the history database (Handy's file; SQLite handles the second
/// connection) and makes sure our table exists.
pub fn open(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    ensure_schema(&conn)?;
    debug!("Opened history database {}", db_path.display());
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Handy's table, as its migrations leave it.
    fn handy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE transcription_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_name TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                saved BOOLEAN NOT NULL DEFAULT 0,
                title TEXT NOT NULL,
                transcription_text TEXT NOT NULL,
                post_processed_text TEXT,
                post_process_prompt TEXT,
                post_process_requested BOOLEAN NOT NULL DEFAULT 0
            );",
        )
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, ts: i64, text: &str, cleaned: Option<&str>, file: &str) -> i64 {
        conn.execute(
            "INSERT INTO transcription_history
                (file_name, timestamp, title, transcription_text, post_processed_text)
             VALUES (?1, ?2, 't', ?3, ?4)",
            params![file, ts, text, cleaned],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    const DAY: i64 = 24 * 60 * 60;

    #[test]
    fn items_carry_source_and_what_was_sent() {
        let conn = handy_db();
        let key = insert(&conn, 100, "fra tasten", None, "");
        let phone = insert(&conn, 200, "rå tekst", Some("Renset tekst."), "");
        save_meta(&conn, key, "tast", None).unwrap();
        let record = CleanupRecord {
            provider: "openai".into(),
            sent_text: "rå tekst".into(),
            duration_ms: 420,
        };
        save_meta(&conn, phone, "Jonathans iPhone", Some(&record)).unwrap();

        let items = list(&conn, None, 50).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].id, phone, "newest first");
        assert_eq!(items[0].text, "Renset tekst.");
        assert!(items[0].cleaned);
        assert_eq!(items[0].source, "Jonathans iPhone");
        assert_eq!(items[0].cleanup, Some(record));
        assert_eq!(items[1].source, "tast");
        assert!(!items[1].has_audio);
    }

    #[test]
    fn search_matches_text_and_source() {
        let conn = handy_db();
        let a = insert(&conn, 1, "Møde om budgettet", None, "");
        let b = insert(&conn, 2, "Noget andet", None, "");
        save_meta(&conn, a, "tast", None).unwrap();
        save_meta(&conn, b, "Pixel", None).unwrap();
        assert_eq!(list(&conn, Some("budget"), 50).unwrap().len(), 1);
        assert_eq!(list(&conn, Some("PIXEL"), 50).unwrap()[0].id, b);
        assert_eq!(list(&conn, Some("100%"), 50).unwrap().len(), 0);
    }

    #[test]
    fn retention_deletes_old_items_and_old_audio() {
        let dir = tempfile::tempdir().unwrap();
        let conn = handy_db();
        let now = 1_000 * DAY;
        std::fs::write(dir.path().join("old.wav"), b"x").unwrap();
        let old = insert(&conn, now - 20 * DAY, "gammel", None, "old.wav");
        let recent = insert(&conn, now - 2 * DAY, "ny", None, "");
        let removed = apply_retention(&conn, dir.path(), HistoryRetention::TwoWeeks, now).unwrap();
        assert_eq!(removed, 1);
        let ids: Vec<i64> = list(&conn, None, 50)
            .unwrap()
            .iter()
            .map(|i| i.id)
            .collect();
        assert_eq!(ids, vec![recent]);
        assert!(!dir.path().join("old.wav").exists());
        assert!(old != recent);
    }

    #[test]
    fn debugging_audio_goes_after_seven_days_even_when_text_stays() {
        let dir = tempfile::tempdir().unwrap();
        let conn = handy_db();
        let now = 1_000 * DAY;
        std::fs::write(dir.path().join("a.wav"), b"x").unwrap();
        insert(&conn, now - 8 * DAY, "tekst", None, "a.wav");
        apply_retention(&conn, dir.path(), HistoryRetention::Forever, now).unwrap();
        let items = list(&conn, None, 50).unwrap();
        assert_eq!(items.len(), 1, "Altid keeps the text");
        assert!(!items[0].has_audio);
        assert!(!dir.path().join("a.wav").exists());
    }

    #[test]
    fn dont_keep_clears_everything() {
        let dir = tempfile::tempdir().unwrap();
        let conn = handy_db();
        insert(&conn, 1_000 * DAY, "lige nu", None, "");
        apply_retention(&conn, dir.path(), HistoryRetention::DontKeep, 1_000 * DAY).unwrap();
        assert!(list(&conn, None, 50).unwrap().is_empty());
    }

    #[test]
    fn delete_one_or_all() {
        let dir = tempfile::tempdir().unwrap();
        let conn = handy_db();
        let a = insert(&conn, 1, "a", None, "");
        insert(&conn, 2, "b", None, "");
        assert_eq!(delete(&conn, dir.path(), Some(&[a])).unwrap(), 1);
        assert_eq!(list(&conn, None, 50).unwrap().len(), 1);
        assert_eq!(text_of(&conn, a).unwrap(), None);
        assert_eq!(delete(&conn, dir.path(), None).unwrap(), 1);
        assert!(list(&conn, None, 50).unwrap().is_empty());
    }
}
