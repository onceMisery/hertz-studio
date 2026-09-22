// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! SQLite persistence.
//!
//! Queries are **runtime-checked** (`sqlx::query_as`) rather than
//! compile-time-checked (`sqlx::query!`). That is a deliberate trade: it costs
//! a little safety at compile time but means the crate builds without a live
//! database and without committing `.sqlx/` metadata, which keeps CI and
//! offline builds simple. Every statement is still exercised by the
//! integration tests in `tests/`.

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{FromRow, SqlitePool};
use vmusic_core::{Playlist, PlaylistId, StoreError, Track, TrackId, TrackSource};

pub mod favorites;
pub mod playlists;
pub mod settings;

#[derive(Debug, Clone, FromRow)]
pub struct TrackRow {
    pub id: String,
    pub path: String,
    pub source: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
    pub bitrate: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub has_cover: i32,
    pub cover_key: Option<String>,
    pub file_mtime: Option<i64>,
    pub file_size: Option<i64>,
    pub added_at: i64,
}

impl From<TrackRow> for Track {
    fn from(r: TrackRow) -> Self {
        Track {
            id: r.id,
            path: r.path,
            source: match r.source.as_str() {
                "remote" => TrackSource::Remote,
                _ => TrackSource::Local,
            },
            title: r.title,
            artist: r.artist,
            album: r.album,
            duration_ms: r.duration_ms.map(|v| v.max(0) as u64),
            bitrate: r.bitrate.map(|v| v.max(0) as u32),
            sample_rate: r.sample_rate.map(|v| v.max(0) as u32),
            channels: r.channels.map(|v| v.clamp(0, 255) as u8),
            has_cover: r.has_cover != 0,
            file_mtime: r.file_mtime,
            file_size: r.file_size,
            added_at: r.added_at,
        }
    }
}

pub async fn open(data_dir: &Path) -> Result<SqlitePool, StoreError> {
    tokio::fs::create_dir_all(data_dir)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    let db_path = data_dir.join("vmusic.db");
    let url = format!("sqlite://{}", db_path.display());

    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

    sqlx::migrate!("../../migrations")
        .run(&pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

    tracing::debug!("database ready at {url}");
    Ok(pool)
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

pub async fn upsert_track(pool: &SqlitePool, track: &Track) -> Result<(), StoreError> {
    let now = now_ms();
    sqlx::query(
        r#"INSERT INTO tracks
             (id, path, source, title, artist, album, duration_ms, bitrate,
              sample_rate, channels, has_cover, cover_key, file_mtime, file_size,
              added_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
           ON CONFLICT(path) DO UPDATE SET
             source = excluded.source, title = excluded.title,
             artist = excluded.artist, album = excluded.album,
             duration_ms = excluded.duration_ms, bitrate = excluded.bitrate,
             sample_rate = excluded.sample_rate, channels = excluded.channels,
             has_cover = excluded.has_cover, cover_key = excluded.cover_key,
             file_mtime = excluded.file_mtime, file_size = excluded.file_size,
             updated_at = excluded.updated_at"#,
    )
    .bind(&track.id)
    .bind(&track.path)
    .bind(match track.source {
        TrackSource::Local => "local",
        TrackSource::Remote => "remote",
    })
    .bind(&track.title)
    .bind(&track.artist)
    .bind(&track.album)
    .bind(track.duration_ms.map(|v| v as i64))
    .bind(track.bitrate.map(|v| v as i64))
    .bind(track.sample_rate.map(|v| v as i64))
    .bind(track.channels.map(|v| v as i64))
    .bind(track.has_cover as i32)
    .bind(Option::<String>::None)
    .bind(track.file_mtime)
    .bind(track.file_size)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// Returns the existing track id for a file path, if that file was scanned
/// before. The scan loop uses it to keep track identity stable across
/// re-scans: freshly-minted ids would orphan cached covers and break the
/// playlist references that point at the old id.
pub async fn get_track_id_by_path(
    pool: &SqlitePool,
    path: &str,
) -> Result<Option<String>, StoreError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT id FROM tracks WHERE path = ?1")
        .bind(path)
        .fetch_optional(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(row.map(|(id,)| id))
}

pub async fn get_track(pool: &SqlitePool, id: &TrackId) -> Result<Option<Track>, StoreError> {
    let row = sqlx::query_as::<_, TrackRow>("SELECT * FROM tracks WHERE id = ?1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(row.map(Into::into))
}

pub async fn list_tracks(
    pool: &SqlitePool,
    query: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Track>, StoreError> {
    let rows = match query {
        Some(q) if !q.trim().is_empty() => {
            let like = format!("%{}%", q.trim());
            sqlx::query_as::<_, TrackRow>(
                r#"SELECT * FROM tracks
                   WHERE title LIKE ?1 OR artist LIKE ?1 OR album LIKE ?1
                   ORDER BY title COLLATE NOCASE LIMIT ?2 OFFSET ?3"#,
            )
            .bind(like)
            .bind(limit)
            .bind(offset)
            .fetch_all(pool)
            .await
        }
        _ => {
            sqlx::query_as::<_, TrackRow>(
                "SELECT * FROM tracks ORDER BY title COLLATE NOCASE LIMIT ?1 OFFSET ?2",
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(pool)
            .await
        }
    }
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn count_tracks(pool: &SqlitePool, query: Option<&str>) -> Result<i64, StoreError> {
    #[derive(FromRow)]
    struct CountRow {
        n: i64,
    }
    let row = match query {
        Some(q) if !q.trim().is_empty() => {
            let like = format!("%{}%", q.trim());
            sqlx::query_as::<_, CountRow>(
                "SELECT COUNT(*) AS n FROM tracks WHERE title LIKE ?1 OR artist LIKE ?1 OR album LIKE ?1",
            )
            .bind(like)
            .fetch_one(pool)
            .await
        }
        _ => {
            sqlx::query_as::<_, CountRow>("SELECT COUNT(*) AS n FROM tracks")
                .fetch_one(pool)
                .await
        }
    }
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(row.n)
}

/// Deletes rows whose path is not in `keep`. Used at the end of a scan so
/// files moved or deleted outside the app disappear from the library.
pub async fn delete_tracks_not_in(pool: &SqlitePool, keep: &[String]) -> Result<u64, StoreError> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    let mut removed = 0u64;

    let paths: Vec<String> = sqlx::query_scalar::<_, String>("SELECT path FROM tracks")
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

    for path in paths {
        if keep.contains(&path) {
            continue;
        }
        let result = sqlx::query("DELETE FROM tracks WHERE path = ?1")
            .bind(&path)
            .execute(&mut *tx)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        removed += result.rows_affected();
    }

    tx.commit()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(removed)
}

/// Removes rows under `root` that a fresh scan did not see again.
///
/// Scoped to one root so scanning a second directory cannot delete the
/// library built from the first one.
pub async fn delete_stale_under_root(
    pool: &SqlitePool,
    root: &str,
    keep: &[String],
) -> Result<u64, StoreError> {
    let like = format!("{}%", root.trim_end_matches(['/', '\\']));
    let paths: Vec<String> =
        sqlx::query_scalar::<_, String>("SELECT path FROM tracks WHERE path LIKE ?1")
            .bind(like)
            .fetch_all(pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;

    let mut removed = 0u64;
    for path in paths {
        if keep.contains(&path) {
            continue;
        }
        let result = sqlx::query("DELETE FROM tracks WHERE path = ?1")
            .bind(&path)
            .execute(pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        removed += result.rows_affected();
    }
    Ok(removed)
}

pub async fn get_playlist_track_ids(
    pool: &SqlitePool,
    id: &PlaylistId,
) -> Result<Vec<TrackId>, StoreError> {
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(rows)
}

pub async fn list_playlists(pool: &SqlitePool) -> Result<Vec<Playlist>, StoreError> {
    #[derive(FromRow)]
    struct Row {
        id: String,
        name: String,
        created_at: i64,
        updated_at: i64,
        track_count: i64,
    }
    let rows = sqlx::query_as::<_, Row>(
        r#"SELECT p.id, p.name, p.created_at, p.updated_at,
                  COUNT(pt.track_id) AS track_count
           FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
           GROUP BY p.id ORDER BY p.created_at"#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(rows
        .into_iter()
        .map(|r| Playlist {
            id: r.id,
            name: r.name,
            created_at: r.created_at,
            updated_at: r.updated_at,
            track_count: r.track_count,
        })
        .collect())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(path: &str, title: &str) -> Track {
        Track {
            id: uuid::Uuid::new_v4().to_string(),
            path: path.to_string(),
            source: TrackSource::Local,
            title: title.to_string(),
            artist: Some("Artist".into()),
            album: Some("Album".into()),
            duration_ms: Some(210_000),
            bitrate: Some(320),
            sample_rate: Some(44_100),
            channels: Some(2),
            has_cover: false,
            file_mtime: Some(1),
            file_size: Some(2),
            added_at: 0,
        }
    }

    async fn pool() -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("vmusic-store-test-{}", uuid::Uuid::new_v4()));
        open(&dir).await.expect("open in-memory-ish db")
    }

    #[tokio::test]
    async fn upsert_is_idempotent_on_path() {
        let db = pool().await;
        let t = sample("/music/a.mp3", "A");
        upsert_track(&db, &t).await.unwrap();

        let mut again = t.clone();
        again.title = "A (remaster)".into();
        upsert_track(&db, &again).await.unwrap();

        assert_eq!(count_tracks(&db, None).await.unwrap(), 1);
        let stored = list_tracks(&db, None, 10, 0).await.unwrap();
        assert_eq!(stored[0].title, "A (remaster)");
    }

    #[tokio::test]
    async fn search_and_pagination_work() {
        let db = pool().await;
        for (i, title) in ["Alpha", "Beta", "Gamma"].iter().enumerate() {
            upsert_track(&db, &sample(&format!("/m/{i}.mp3"), title))
                .await
                .unwrap();
        }
        assert_eq!(list_tracks(&db, None, 2, 0).await.unwrap().len(), 2);
        assert_eq!(list_tracks(&db, None, 2, 2).await.unwrap().len(), 1);
        assert_eq!(
            list_tracks(&db, Some("beta"), 10, 0).await.unwrap().len(),
            1
        );
        // The search is a case-insensitive substring match, so "a" hits all
        // three titles (Alpha, Beta, Gamma) — a narrower term discriminates.
        assert_eq!(count_tracks(&db, Some("a")).await.unwrap(), 3);
        assert_eq!(count_tracks(&db, Some("alph")).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn delete_tracks_not_in_removes_stale_rows() {
        let db = pool().await;
        upsert_track(&db, &sample("/m/a.mp3", "A")).await.unwrap();
        upsert_track(&db, &sample("/m/b.mp3", "B")).await.unwrap();

        let removed = delete_tracks_not_in(&db, &["/m/a.mp3".to_string()])
            .await
            .unwrap();
        assert_eq!(removed, 1);
        assert_eq!(count_tracks(&db, None).await.unwrap(), 1);
    }
}
