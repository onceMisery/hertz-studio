// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! SQLite persistence.
//!
//! Queries are **runtime-checked** (`sqlx::query_as`) rather than
//! compile-time-checked (`sqlx::query!`). That is a deliberate trade: it costs
//! a little safety at compile time but means the crate builds without a live
//! database and without committing `.sqlx/` metadata, which keeps CI and
//! offline builds simple. Every statement is still exercised by the
//! integration tests in `tests/`.

use std::path::{Component, Path, PathBuf};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{FromRow, SqliteConnection, SqlitePool};
use vmusic_core::{Playlist, PlaylistId, StoreError, Track, TrackId, TrackSource};

pub mod backup;
pub mod favorites;
pub mod lyrics;
pub mod no_auto_match;
pub mod playlists;
pub mod remote_roots;
pub mod scan_roots;
pub mod settings;
pub mod track_edits;

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

/// 用户编辑覆盖层的展示表达式：空串/空白归一为无值后盖在扫描值上。
pub const TRACK_COALESCE_COLS: &str =
    "COALESCE(NULLIF(TRIM(e.title), ''), t.title) AS title,      COALESCE(NULLIF(TRIM(e.artist), ''), t.artist) AS artist,      COALESCE(NULLIF(TRIM(e.album), ''), t.album) AS album";

pub async fn get_track(pool: &SqlitePool, id: &TrackId) -> Result<Option<Track>, StoreError> {
    let sql = format!(
        "SELECT t.id, t.path, t.source, {TRACK_COALESCE_COLS}, t.duration_ms, t.bitrate,          t.sample_rate, t.channels, t.has_cover, t.cover_key, t.file_mtime, t.file_size, t.added_at          FROM tracks t LEFT JOIN track_edits e ON e.track_id = t.id WHERE t.id = ?1"
    );
    let row = sqlx::query_as::<_, TrackRow>(&sql)
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
    list_tracks_sorted(pool, query, TrackSort::Title, limit, offset).await
}

/// One ordering contract for paged browsing and the complete playback queue.
/// SQL fragments only come from this enum, never from a request string.
#[derive(Debug, Clone, Copy, Default)]
pub enum TrackSort {
    #[default]
    Title,
    Artist,
    Album,
    Added,
}

impl TrackSort {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "title" => Some(Self::Title),
            "artist" => Some(Self::Artist),
            "album" => Some(Self::Album),
            "added" => Some(Self::Added),
            _ => None,
        }
    }

    /// 排序键用覆盖列的完整表达式（裸别名在 ORDER BY 表达式里与表列同名会
    /// 引发歧义），保证专辑/歌手视图里的排序跟显示一致。
    fn sql(self) -> &'static str {
        match self {
            Self::Title => "COALESCE(NULLIF(TRIM(e.title), ''), t.title) COLLATE NOCASE, t.id",
            Self::Artist => "COALESCE(NULLIF(TRIM(e.artist), ''), t.artist) COLLATE NOCASE,                              COALESCE(NULLIF(TRIM(e.title), ''), t.title) COLLATE NOCASE, t.id",
            Self::Album => "COALESCE(NULLIF(TRIM(e.album), ''), t.album) COLLATE NOCASE,                              COALESCE(NULLIF(TRIM(e.title), ''), t.title) COLLATE NOCASE, t.id",
            Self::Added => "t.added_at DESC, COALESCE(NULLIF(TRIM(e.title), ''), t.title) COLLATE NOCASE, t.id",
        }
    }
}

/// 浏览筛选：按覆盖后的歌手/专辑精确过滤（曲库的专辑/歌手视图用）。
#[derive(Debug, Clone, Default)]
pub struct TrackFilter {
    pub artist: Option<String>,
    pub album: Option<String>,
}

impl TrackFilter {
    /// `first` 是本语句里空闲参数的起始编号：筛选子句按 ?N 顺序占位。
    /// 列表语句的 ?1..?4 被 query/LIKE/LIMIT/OFFSET 占用，所以从 ?5 起；
    /// 计数语句没有 LIMIT/OFFSET，从 ?3 起。编号错位会让筛选静默落空。
    fn sql(&self, first: usize) -> String {
        let mut clauses = Vec::new();
        if self.artist.is_some() {
            clauses.push(format!(
                "COALESCE(NULLIF(TRIM(e.artist), ''), t.artist) = ?{first}"
            ));
        }
        if self.album.is_some() {
            clauses.push(format!(
                "COALESCE(NULLIF(TRIM(e.album), ''), t.album) = ?{second}",
                second = first + 1
            ));
        }
        if clauses.is_empty() {
            String::new()
        } else {
            format!(" AND {}", clauses.join(" AND "))
        }
    }

    fn binds(&self) -> Vec<String> {
        [&self.artist, &self.album]
            .into_iter()
            .filter_map(|b| b.clone())
            .collect()
    }
}

/// `filter_sql` 由调用方按本语句的空闲参数编号渲染（列表有 LIMIT/OFFSET，
/// 从 ?5 起；ids 没有分页子句，从 ?3 起）。
fn track_selection(columns: &str, sort: TrackSort, filter_sql: &str) -> String {
    format!(
        "SELECT {columns} FROM tracks t          LEFT JOIN track_edits e ON e.track_id = t.id          WHERE (?1 = '' OR COALESCE(NULLIF(TRIM(e.title), ''), t.title) LIKE ?2            OR COALESCE(NULLIF(TRIM(e.artist), ''), t.artist) LIKE ?2            OR COALESCE(NULLIF(TRIM(e.album), ''), t.album) LIKE ?2){filter_sql}          ORDER BY {}",
        sort.sql()
    )
}

pub async fn list_tracks_sorted(
    pool: &SqlitePool,
    query: Option<&str>,
    sort: TrackSort,
    limit: i64,
    offset: i64,
) -> Result<Vec<Track>, StoreError> {
    list_tracks_filtered(pool, query, &TrackFilter::default(), sort, limit, offset).await
}

pub async fn list_tracks_filtered(
    pool: &SqlitePool,
    query: Option<&str>,
    filter: &TrackFilter,
    sort: TrackSort,
    limit: i64,
    offset: i64,
) -> Result<Vec<Track>, StoreError> {
    let query = query.unwrap_or("").trim();
    let columns = format!(
        "t.id, t.path, t.source, {TRACK_COALESCE_COLS}, t.duration_ms, t.bitrate,          t.sample_rate, t.channels, t.has_cover, t.cover_key, t.file_mtime, t.file_size, t.added_at"
    );
    let filter_sql = filter.sql(5);
    let sql = format!(
        "{} LIMIT ?3 OFFSET ?4",
        track_selection(&columns, sort, &filter_sql)
    );
    let mut stmt = sqlx::query_as::<_, TrackRow>(&sql)
        .bind(query)
        .bind(format!("%{query}%"))
        .bind(limit)
        .bind(offset);
    for bind in filter.binds() {
        stmt = stmt.bind(bind.clone());
    }
    let rows = stmt
        .fetch_all(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// IDs are selected in one database snapshot, independent of UI pagination.
pub async fn list_track_ids(
    pool: &SqlitePool,
    query: Option<&str>,
    sort: TrackSort,
) -> Result<Vec<String>, StoreError> {
    list_track_ids_filtered(pool, query, &TrackFilter::default(), sort).await
}

pub async fn list_track_ids_filtered(
    pool: &SqlitePool,
    query: Option<&str>,
    filter: &TrackFilter,
    sort: TrackSort,
) -> Result<Vec<String>, StoreError> {
    let query = query.unwrap_or("").trim();
    let filter_sql = filter.sql(3);
    let sql = track_selection("t.id", sort, &filter_sql);
    let mut stmt = sqlx::query_scalar(&sql)
        .bind(query)
        .bind(format!("%{query}%"));
    if let Some(artist) = &filter.artist {
        stmt = stmt.bind(artist);
    }
    if let Some(album) = &filter.album {
        stmt = stmt.bind(album);
    }
    stmt.fetch_all(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))
}

pub async fn count_tracks(pool: &SqlitePool, query: Option<&str>) -> Result<i64, StoreError> {
    count_tracks_filtered(pool, query, &TrackFilter::default()).await
}

/// 与列表同一覆盖/筛选语义的计数：分页 total 必须和当前筛选的列表一致。
pub async fn count_tracks_filtered(
    pool: &SqlitePool,
    query: Option<&str>,
    filter: &TrackFilter,
) -> Result<i64, StoreError> {
    #[derive(FromRow)]
    struct CountRow {
        n: i64,
    }
    let query = query.unwrap_or("").trim();
    let sql = format!(
        "SELECT COUNT(*) AS n FROM tracks t          LEFT JOIN track_edits e ON e.track_id = t.id          WHERE (?1 = '' OR COALESCE(NULLIF(TRIM(e.title), ''), t.title) LIKE ?2            OR COALESCE(NULLIF(TRIM(e.artist), ''), t.artist) LIKE ?2            OR COALESCE(NULLIF(TRIM(e.album), ''), t.album) LIKE ?2){}",
        filter.sql(3)
    );
    let mut stmt = sqlx::query_as::<_, CountRow>(&sql)
        .bind(query)
        .bind(format!("%{query}%"));
    for bind in filter.binds() {
        stmt = stmt.bind(bind.clone());
    }
    let row = stmt
        .fetch_one(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(row.n)
}

/// 专辑/歌手浏览面：名字来自覆盖后的展示值，空值不出现。
pub async fn list_track_facets(
    pool: &SqlitePool,
    kind: &str,
) -> Result<Vec<(String, i64)>, StoreError> {
    let column = match kind {
        "artist" => "artist",
        "album" => "album",
        _ => {
            return Err(StoreError::Database(
                "facet kind must be artist or album".into(),
            ))
        }
    };
    let shown = format!("COALESCE(NULLIF(TRIM(e.{column}), ''), t.{column})");
    let sql = format!(
        "SELECT {shown} AS name, COUNT(*) AS n          FROM tracks t LEFT JOIN track_edits e ON e.track_id = t.id          WHERE {shown} IS NOT NULL AND TRIM({shown}) <> ''          GROUP BY name ORDER BY n DESC, name COLLATE NOCASE"
    );
    sqlx::query_as::<_, (String, i64)>(&sql)
        .fetch_all(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))
}

/// 批量删除曲目行（失效整理用）。返回删除的行数。
pub async fn delete_tracks(pool: &SqlitePool, ids: &[String]) -> Result<u64, StoreError> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    let mut deleted = 0u64;
    for id in ids {
        let result = sqlx::query("DELETE FROM tracks WHERE id = ?1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        deleted += result.rows_affected();
    }
    tx.commit()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(deleted)
}

/// 一首曲目的完整 ReplayGain 标签组（扫描值，跟文件走）。
///
/// 增益是 dB、峰值是线性幅度；四项都可为 NULL（文件没写标签）。播放端按
/// 「关闭 / 按曲目 / 按专辑」三档挑选，按专辑缺专辑值时回落曲目值。
#[derive(Debug, Clone, Copy, Default)]
pub struct RgTags {
    pub track_gain: Option<f64>,
    pub album_gain: Option<f64>,
    pub track_peak: Option<f64>,
    pub album_peak: Option<f64>,
}

/// 扫描读到的 ReplayGain 标签组。无标签的项为 NULL。
pub async fn set_track_rg(
    pool: &SqlitePool,
    id: &TrackId,
    rg: &RgTags,
) -> Result<(), StoreError> {
    sqlx::query(
        "UPDATE tracks SET rg_gain = ?2, rg_album_gain = ?3, rg_peak = ?4, rg_album_peak = ?5
         WHERE id = ?1",
    )
    .bind(id)
    .bind(rg.track_gain)
    .bind(rg.album_gain)
    .bind(rg.track_peak)
    .bind(rg.album_peak)
    .execute(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// 读取 ReplayGain 标签组（播放端响度归一化用）。
pub async fn get_track_rg(
    pool: &SqlitePool,
    id: &TrackId,
) -> Result<Option<RgTags>, StoreError> {
    let row: Option<(
        Option<f64>,
        Option<f64>,
        Option<f64>,
        Option<f64>,
    )> = sqlx::query_as(
        "SELECT rg_gain, rg_album_gain, rg_peak, rg_album_peak FROM tracks WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(row.map(|(track_gain, album_gain, track_peak, album_peak)| RgTags {
        track_gain,
        album_gain,
        track_peak,
        album_peak,
    }))
}

/// 封面替换后的展示位更新：用户封面已落缓存，has_cover 直接成立。
pub async fn set_has_cover(pool: &SqlitePool, id: &TrackId, has: bool) -> Result<(), StoreError> {
    sqlx::query("UPDATE tracks SET has_cover = ?2 WHERE id = ?1")
        .bind(id)
        .bind(has as i64)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
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
    delete_stale_under_root_cancellable(
        pool,
        root,
        keep,
        &std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    )
    .await
    .map(|removed| removed.unwrap_or(0))
}

/// All-or-nothing pruning: cancellation rolls back every deletion in this pass.
/// Paths are compared by components, not SQL LIKE (which treats `_` and `%`
/// specially and would include a neighbouring directory such as Music2).
pub async fn delete_stale_under_root_cancellable(
    pool: &SqlitePool,
    root: &str,
    keep: &[String],
    cancelled: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<Option<u64>, StoreError> {
    use std::sync::atomic::Ordering;
    let paths: Vec<String> = sqlx::query_scalar("SELECT path FROM tracks WHERE source = 'local'")
        .fetch_all(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    let keep: std::collections::HashSet<String> = keep.iter().cloned().collect();
    let root = root.to_string();
    let worker_cancel = cancelled.clone();
    // Path resolution may contact an unavailable drive. Keep filesystem work
    // off async workers and finish it before opening the write transaction.
    let candidates = tokio::task::spawn_blocking(move || {
        if worker_cancel.load(Ordering::Relaxed) {
            return None;
        }
        let root = track_path_key(Path::new(&root));
        let mut candidates = Vec::new();
        for path in paths {
            if worker_cancel.load(Ordering::Relaxed) {
                return None;
            }
            if !keep.contains(&path) && track_path_key(Path::new(&path)).starts_with(&root) {
                candidates.push(path);
            }
        }
        Some(candidates)
    })
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    let Some(candidates) = candidates else {
        return Ok(None);
    };
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    let mut removed = 0u64;
    for path in candidates {
        if cancelled.load(Ordering::Relaxed) {
            tx.rollback()
                .await
                .map_err(|e| StoreError::Database(e.to_string()))?;
            return Ok(None);
        }
        let result = sqlx::query("DELETE FROM tracks WHERE path = ?1")
            .bind(&path)
            .execute(&mut *tx)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        removed += result.rows_affected();
    }
    if cancelled.load(Ordering::Relaxed) {
        tx.rollback()
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
        return Ok(None);
    }
    tx.commit()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(Some(removed))
}

/// Compare legacy relative/alternate-separator paths with current absolute
/// paths without rewriting the stored path or track ID. Resolve the nearest
/// existing ancestor so removed files still have a stable directory identity.
/// No case folding: Windows can also contain case-sensitive directories.
pub fn track_path_key(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut ancestor = absolute.as_path();
    let mut suffix = Vec::new();
    let mut resolved = loop {
        if let Ok(canonical) = std::fs::canonicalize(ancestor) {
            break canonical;
        }
        let Some(parent) = ancestor.parent() else {
            suffix.clear();
            break absolute.clone();
        };
        if let Some(component) = ancestor.components().next_back() {
            suffix.push(component.as_os_str().to_os_string());
        }
        ancestor = parent;
    };
    for component in suffix.into_iter().rev() {
        resolved.push(component);
    }
    #[cfg(windows)]
    {
        let text = resolved.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            resolved = PathBuf::from(format!(r"\\{rest}"));
        } else if let Some(rest) = text.strip_prefix(r"\\?\") {
            resolved = PathBuf::from(rest);
        }
    }
    let mut clean = PathBuf::new();
    for component in resolved.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            _ => clean.push(component.as_os_str()),
        }
    }
    clean
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

/// 删掉测试留下的临时目录，**失败也不 panic**。
///
/// 清理不是被测行为：要断言的是 CRUD 的结果，删不掉目录只是在 `%TEMP%` 里
/// 留一个临时库。Windows 上 SQLite 刚关闭的那几百毫秒里 `-wal` / `-shm` 常常
/// 还没被放开（32/33 sharing violation），杀软扫一遍又会给 access denied(5)——
/// 这些都是"再等等就删得掉"。把它们升级成 panic，等于把一次与被测逻辑无关的
/// I/O 抖动变成红 CI；真删不掉时打到 stderr，谁看到谁来查。
#[cfg(test)]
pub(crate) fn cleanup_dir(dir: &std::path::Path) {
    let mut last = None;
    for _ in 0..40 {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return,
            Err(e) => last = Some(e),
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if let Some(e) = last {
        eprintln!(
            "[test] 临时目录没删掉（不影响断言结果）：{}: {e}",
            dir.display()
        );
    }
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
    async fn global_order_and_queue_cover_every_page() {
        let db = pool().await;
        for i in 0..205 {
            let mut track = sample(&format!("/large/{i}.mp3"), &format!("Song {i:03}"));
            track.artist = Some(format!("Artist {:03}", 204 - i));
            track.album = Some(if i % 2 == 0 { "Even" } else { "Odd" }.into());
            upsert_track(&db, &track).await.unwrap();
            sqlx::query("UPDATE tracks SET added_at = ?1 WHERE id = ?2")
                .bind(i as i64)
                .bind(&track.id)
                .execute(&db)
                .await
                .unwrap();
        }
        for sort in [
            TrackSort::Title,
            TrackSort::Artist,
            TrackSort::Album,
            TrackSort::Added,
        ] {
            for query in [None, Some("Even")] {
                let first = list_tracks_sorted(&db, query, sort, 200, 0).await.unwrap();
                let second = list_tracks_sorted(&db, query, sort, 200, 200)
                    .await
                    .unwrap();
                let page_ids: Vec<_> = first.iter().chain(&second).map(|t| t.id.clone()).collect();
                let all = list_track_ids(&db, query, sort).await.unwrap();
                assert_eq!(page_ids, all);
                assert_eq!(all.len(), if query.is_none() { 205 } else { 103 });
                if query.is_none() && matches!(sort, TrackSort::Artist | TrackSort::Added) {
                    assert_eq!(first[0].title, "Song 204");
                    assert_eq!(second.last().unwrap().title, "Song 000");
                }
            }
        }
        assert!(TrackSort::parse("title; DROP TABLE tracks").is_none());
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

    #[tokio::test]
    async fn root_pruning_obeys_path_boundaries_and_literal_names() {
        let db = pool().await;
        for path in [
            "/Music/a.mp3",
            "/Music2/b.mp3",
            "/Music_%/c.mp3",
            "/Music_other/d.mp3",
        ] {
            upsert_track(&db, &sample(path, path)).await.unwrap();
        }
        assert_eq!(
            delete_stale_under_root(&db, "/Music", &[]).await.unwrap(),
            1
        );
        assert_eq!(
            delete_stale_under_root(&db, "/Music_%", &[]).await.unwrap(),
            1
        );
        let remaining = list_tracks(&db, None, 10, 0).await.unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining
            .iter()
            .all(|t| t.path == "/Music2/b.mp3" || t.path == "/Music_other/d.mp3"));
    }

    #[tokio::test]
    async fn cancelled_pruning_keeps_existing_rows() {
        let db = pool().await;
        upsert_track(&db, &sample("/Music/a.mp3", "A"))
            .await
            .unwrap();
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        assert_eq!(
            delete_stale_under_root_cancellable(&db, "/Music", &[], &cancel)
                .await
                .unwrap(),
            None
        );
        assert_eq!(count_tracks(&db, None).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn legacy_relative_paths_prune_within_resolved_directory_only() {
        let db = pool().await;
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(
            track_path_key(Path::new("Cargo.toml")),
            track_path_key(&cwd.join("Cargo.toml"))
        );
        upsert_track(&db, &sample("missing-legacy.wav", "inside"))
            .await
            .unwrap();
        upsert_track(&db, &sample("../missing-neighbor.wav", "outside"))
            .await
            .unwrap();
        assert_eq!(
            delete_stale_under_root(&db, cwd.to_str().unwrap(), &[])
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            list_tracks(&db, None, 10, 0).await.unwrap()[0].title,
            "outside"
        );
    }
}
