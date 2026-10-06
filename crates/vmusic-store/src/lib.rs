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

/// tracks 表的 upsert SQL：单条与批量两个入口共用同一份文本，避免漂移。
const UPSERT_TRACK_SQL: &str = r#"INSERT INTO tracks
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
             updated_at = excluded.updated_at"#;

/// 绑定并执行一条 track upsert。`executor` 泛型承载连接池与事务连接两种形态，
/// 让扫描能在自己开的事务里批量写入而不用复制一遍 SQL。
async fn bind_upsert_track<'a, E>(executor: E, track: &Track, now: i64) -> Result<(), StoreError>
where
    E: sqlx::Executor<'a, Database = sqlx::Sqlite>,
{
    sqlx::query(UPSERT_TRACK_SQL)
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
        .execute(executor)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

pub async fn upsert_track(pool: &SqlitePool, track: &Track) -> Result<(), StoreError> {
    bind_upsert_track(pool, track, now_ms()).await
}

/// 扫描批量落库：一批曲目在调用方开的事务里按序 upsert。
///
/// 逐文件一条隐式事务在万首级曲库上就是上万次独立提交（WAL + synchronous
/// 默认真实落盘也扛不住），这是扫描主循环的分批入口。事务的开与 commit 由
/// 调用方负责——本函数只负责把这一批写进给定连接，不自行提交。
pub async fn upsert_tracks_batch(
    conn: &mut SqliteConnection,
    tracks: &[Track],
) -> Result<(), StoreError> {
    let now = now_ms();
    for track in tracks {
        bind_upsert_track(&mut *conn, track, now).await?;
    }
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

/// 曲库搜索的谓词（照旧）：`COALESCE(...) LIKE '%q%'` 三段 OR。
///
/// 前导通配符让任何 B-tree 索引都用不上，所以这条语句本身永远是「整表扫 + 排序」。
/// 加速走的是 [`search_candidates`] 的预筛路径（见那里的注释）：能用索引的查询先
/// 取出一小撮候选 rowid，再用 [`SEARCH_PREFILTER_WHERE`] 点查。索引用不上时
/// （空查询、短查询、含通配符）就退回这条语句 —— 它与改造前逐字一致，所以那些
/// 路径的代价与行为都没有变化。
const TRACK_SEARCH_LIKE_PREDICATE: &str = "(?1 = '' OR COALESCE(NULLIF(TRIM(e.title), ''), t.title) LIKE ?2            OR COALESCE(NULLIF(TRIM(e.artist), ''), t.artist) LIKE ?2            OR COALESCE(NULLIF(TRIM(e.album), ''), t.album) LIKE ?2)";

/// 预筛路径的谓词：候选 rowid 由调用方以 JSON 数组绑定在 ?1，复核仍在原来的
/// COALESCE LIKE 上做（?2）。
///
/// 为什么还要复核：trigram 的 LIKE 优化是「把模式交给分词器近似匹配」，实测对
/// 含空白的模式会给出**超集**（`% 晴天%` 能查出「晴天」）。粗筛放松只会多给候选，
/// 所以「粗筛 ∩ LIKE 复核」= 旧结果；而复核只作用在候选行上，成本与候选数同阶
/// （实测 100 候选 0.62ms，整表扫 12ms）。
///
/// `json_each` 是 SQLite 内置 JSON1（本项目用的是 bundled SQLite，编译期已开）；
/// 候选作为**顶层约束**才能让计划变成 `SEARCH t USING INTEGER PRIMARY KEY`——
/// 塞进 `OR ?1 = ''` 里会退回整表扫，实测那样反而比旧语句更慢。
const SEARCH_PREFILTER_WHERE: &str = "t.rowid IN (SELECT value FROM json_each(?1)) AND (COALESCE(NULLIF(TRIM(e.title), ''), t.title) LIKE ?2 OR COALESCE(NULLIF(TRIM(e.artist), ''), t.artist) LIKE ?2 OR COALESCE(NULLIF(TRIM(e.album), ''), t.album) LIKE ?2)";

/// 预筛候选数上限：超过它就不再预筛（临时索引 + 逐行点查会比整表扫更贵）。
/// 实测（10k 曲库）：1 个候选 0.23ms、100 个候选 0.62ms、整表扫 12ms，阈值取
/// 2000 有足够余量；真到几千个候选时结果集本身已经大到用户不会再往下看。
const SEARCH_PREFILTER_MAX: usize = 2000;

/// 模式能否交给 trigram 索引粗筛：至少 3 个字符（trigram 的最小长度），且不含
/// LIKE 通配符（`%`/`_` 在 trigram 里不是通配符，含它们会漏配）。
fn indexable_query(query: &str) -> bool {
    query.chars().count() >= 3 && !query.contains('%') && !query.contains('_')
}

/// 索引粗筛：返回候选 rowid；命中数超过上限、或模式用不上索引时返回 None。
///
/// 三列必须分开 UNION：`title LIKE ? OR artist LIKE ? OR album LIKE ?` 这种同表三列
/// OR 会让优化器放弃 trigram 约束（计划里只剩 `INDEX 0:`），单列 LIKE 才是
/// `INDEX 0:L0`（见 `search_plan_uses_the_trigram_index`）。
async fn search_candidates(
    pool: &SqlitePool,
    query: &str,
) -> Result<Option<Vec<i64>>, StoreError> {
    if !indexable_query(query) {
        return Ok(None);
    }
    let pattern = format!("%{query}%");
    let rows: Vec<i64> = sqlx::query_scalar(
        "SELECT rowid FROM track_search WHERE title LIKE ?1
         UNION SELECT rowid FROM track_search WHERE artist LIKE ?1
         UNION SELECT rowid FROM track_search WHERE album LIKE ?1
         LIMIT ?2",
    )
    .bind(pattern)
    .bind(SEARCH_PREFILTER_MAX as i64 + 1)
    .fetch_all(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    if rows.len() > SEARCH_PREFILTER_MAX {
        return Ok(None);
    }
    Ok(Some(rows))
}

/// 预筛路径的 `WHERE` 之后、`ORDER BY` 之前的片段（列表/计数/ids 共用）。
fn prefilter_selection(columns: &str, sort: TrackSort, filter_sql: &str) -> String {
    format!(
        "SELECT {columns} FROM tracks t          LEFT JOIN track_edits e ON e.track_id = t.id          WHERE {SEARCH_PREFILTER_WHERE}{filter_sql}          ORDER BY {}",
        sort.sql()
    )
}

/// `filter_sql` 由调用方按本语句的空闲参数编号渲染（列表有 LIMIT/OFFSET，
/// 从 ?5 起；ids 没有分页子句，从 ?3 起）。
fn track_selection(columns: &str, sort: TrackSort, filter_sql: &str) -> String {
    format!(
        "SELECT {columns} FROM tracks t          LEFT JOIN track_edits e ON e.track_id = t.id          WHERE {TRACK_SEARCH_LIKE_PREDICATE}{filter_sql}          ORDER BY {}",
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
    let pattern = format!("%{query}%");
    // 索引可用时走预筛：候选 rowid 作 ?1，复核模式作 ?2，条数参数顺延到 ?3/?4。
    let candidates = search_candidates(pool, query).await?;
    let (sql, binds) = match &candidates {
        Some(ids) => (
            format!(
                "{} LIMIT ?3 OFFSET ?4",
                prefilter_selection(&columns, sort, &filter.sql(5))
            ),
            vec![serde_json::to_string(ids).unwrap_or_else(|_| "[]".into()), pattern],
        ),
        None => (
            format!(
                "{} LIMIT ?3 OFFSET ?4",
                track_selection(&columns, sort, &filter.sql(5))
            ),
            vec![query.to_string(), pattern],
        ),
    };
    let mut stmt = sqlx::query_as::<_, TrackRow>(&sql);
    for bind in binds {
        stmt = stmt.bind(bind);
    }
    stmt = stmt.bind(limit).bind(offset);
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
    let pattern = format!("%{query}%");
    let candidates = search_candidates(pool, query).await?;
    let (sql, first, second) = match &candidates {
        Some(ids) => (
            prefilter_selection("t.id", sort, &filter.sql(3)),
            serde_json::to_string(ids).unwrap_or_else(|_| "[]".into()),
            pattern,
        ),
        None => (
            track_selection("t.id", sort, &filter.sql(3)),
            query.to_string(),
            pattern,
        ),
    };
    let mut stmt = sqlx::query_scalar(&sql).bind(first).bind(second);
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
    let pattern = format!("%{query}%");
    let candidates = search_candidates(pool, query).await?;
    let (sql, first, second) = match &candidates {
        Some(ids) => (
            format!(
                "SELECT COUNT(*) AS n FROM tracks t          LEFT JOIN track_edits e ON e.track_id = t.id          WHERE {SEARCH_PREFILTER_WHERE}{}",
                filter.sql(3)
            ),
            serde_json::to_string(ids).unwrap_or_else(|_| "[]".into()),
            pattern,
        ),
        None => (
            format!(
                "SELECT COUNT(*) AS n FROM tracks t          LEFT JOIN track_edits e ON e.track_id = t.id          WHERE {TRACK_SEARCH_LIKE_PREDICATE}{}",
                filter.sql(3)
            ),
            query.to_string(),
            pattern,
        ),
    };
    let mut stmt = sqlx::query_as::<_, CountRow>(&sql).bind(first).bind(second);
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

const SET_TRACK_RG_SQL: &str =
    "UPDATE tracks SET rg_gain = ?2, rg_album_gain = ?3, rg_peak = ?4, rg_album_peak = ?5
         WHERE id = ?1";

async fn bind_set_track_rg<'a, E>(executor: E, id: &TrackId, rg: &RgTags) -> Result<(), StoreError>
where
    E: sqlx::Executor<'a, Database = sqlx::Sqlite>,
{
    sqlx::query(SET_TRACK_RG_SQL)
        .bind(id)
        .bind(rg.track_gain)
        .bind(rg.album_gain)
        .bind(rg.track_peak)
        .bind(rg.album_peak)
        .execute(executor)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// 扫描读到的 ReplayGain 标签组。无标签的项为 NULL。
pub async fn set_track_rg(
    pool: &SqlitePool,
    id: &TrackId,
    rg: &RgTags,
) -> Result<(), StoreError> {
    bind_set_track_rg(pool, id, rg).await
}

/// ReplayGain 的批量写入口，与 `upsert_tracks_batch` 同一个事务里调用。
pub async fn set_track_rg_batch(
    conn: &mut SqliteConnection,
    rows: &[(TrackId, RgTags)],
) -> Result<(), StoreError> {
    for (id, rg) in rows {
        bind_set_track_rg(&mut *conn, id, rg).await?;
    }
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

    /// 改造前的搜索谓词：等价性与代价对比的语义基准（FTS 索引必须给出同一集合）。
    const LEGACY_SEARCH_PREDICATE: &str = "(?1 = '' OR COALESCE(NULLIF(TRIM(e.title), ''), t.title) LIKE ?2            OR COALESCE(NULLIF(TRIM(e.artist), ''), t.artist) LIKE ?2            OR COALESCE(NULLIF(TRIM(e.album), ''), t.album) LIKE ?2)";

    fn legacy_ids_sql(sort: TrackSort) -> String {
        format!(
            "SELECT t.id FROM tracks t          LEFT JOIN track_edits e ON e.track_id = t.id          WHERE {LEGACY_SEARCH_PREDICATE}          ORDER BY {}",
            sort.sql()
        )
    }

    /// 用改造前的 LIKE 语句取一次命中集合，作为与 FTS 索引结果比对的基准。
    ///
    /// 进 SQL 前必须和生产语句走同一条归一（`query.unwrap_or("").trim()`），
    /// 否则比的是两件事：带前导空格的查询会被生产侧 trim 成另一串。
    async fn legacy_ids(db: &SqlitePool, query: &str, sort: TrackSort) -> Vec<String> {
        let query = query.trim();
        sqlx::query_scalar::<_, String>(&legacy_ids_sql(sort))
            .bind(query)
            .bind(format!("%{query}%"))
            .fetch_all(db)
            .await
            .unwrap()
    }

    /// FTS 索引表的内容必须与「覆盖后展示值」逐行一致。
    ///
    /// 这是这套方案唯一的系统性风险：索引是触发器维护的派生数据，漏掉任何一条写
    /// 路径都会让搜索静默少结果。所以这里把索引内容与回填表达式直接比对（双向：
    /// 既不能少行，也不能留下孤儿行）。
    async fn assert_index_mirrors_effective_values(db: &SqlitePool) {
        type Row = (i64, Option<String>, Option<String>, Option<String>);
        let indexed: Vec<Row> = sqlx::query_as(
            "SELECT rowid, title, artist, album FROM track_search ORDER BY rowid",
        )
        .fetch_all(db)
        .await
        .unwrap();
        let expected: Vec<Row> = sqlx::query_as(
            "SELECT t.rowid, COALESCE(NULLIF(TRIM(e.title), ''), t.title),
                    COALESCE(NULLIF(TRIM(e.artist), ''), t.artist),
                    COALESCE(NULLIF(TRIM(e.album), ''), t.album)
               FROM tracks t LEFT JOIN track_edits e ON e.track_id = t.id
              ORDER BY t.rowid",
        )
        .fetch_all(db)
        .await
        .unwrap();
        assert_eq!(indexed, expected, "track_search 与覆盖后展示值不一致");
    }

    #[tokio::test]
    async fn search_index_tracks_every_write_path() {
        let db = pool().await;
        let a = sample("/m/a.mp3", "Alpha");
        let b = sample("/m/b.mp3", "Beta");
        upsert_track(&db, &a).await.unwrap();
        upsert_track(&db, &b).await.unwrap();
        assert_index_mirrors_effective_values(&db).await;

        // 全量覆盖 + 部分覆盖（未提供的字段保持 NULL）。
        track_edits::apply(
            &db,
            &a.id,
            &track_edits::EditInput {
                title: Some("Alpha (edit)".into()),
                artist: None,
                album: Some("Edited Album".into()),
            },
        )
        .await
        .unwrap();
        track_edits::apply(
            &db,
            &b.id,
            &track_edits::EditInput {
                title: None,
                artist: Some("Beta Artist".into()),
                album: None,
            },
        )
        .await
        .unwrap();
        assert_index_mirrors_effective_values(&db).await;

        // 纯空白编辑 = 回退到扫描值（读取端 NULLIF(TRIM(...)) 的语义）。
        track_edits::apply(
            &db,
            &a.id,
            &track_edits::EditInput {
                title: Some("   ".into()),
                artist: None,
                album: None,
            },
        )
        .await
        .unwrap();
        assert_index_mirrors_effective_values(&db).await;

        // 重置编辑（删覆盖行）与再次扫描刷新标签。
        track_edits::remove(&db, &a.id).await.unwrap();
        assert_index_mirrors_effective_values(&db).await;
        let mut rescanned = b.clone();
        rescanned.title = "Beta (rescan)".into();
        upsert_track(&db, &rescanned).await.unwrap();
        assert_index_mirrors_effective_values(&db).await;

        // 删除曲目不能留下孤儿索引行。
        assert!(delete_tracks(&db, std::slice::from_ref(&a.id)).await.unwrap() > 0);
        assert_index_mirrors_effective_values(&db).await;
    }

    #[tokio::test]
    async fn search_index_returns_the_same_rows_as_the_like_scan() {
        let db = pool().await;
        let corpus = [
            ("/m/1.mp3", "晴天", "周杰伦", "叶惠美"),
            ("/m/2.mp3", "晴天 (Live)", "周杰伦", "演唱会"),
            ("/m/3.mp3", "七里香", "周杰伦", "七里香"),
            ("/m/4.mp3", "Blóðberg", "Sigur Rós", "ÁTTA"),
            ("/m/5.mp3", "100% Love", "A_B", "MiXeD case"),
            // 元数据缺失：artist/album 为 NULL，覆盖后仍为空。
            ("/m/6.mp3", "untitled", "", ""),
            // 末尾空白：TRIM 归一后不应被查询命中。
            ("/m/7.mp3", "trailing   ", "spaced", "album"),
        ];
        for (path, title, artist, album) in corpus {
            let mut track = sample(path, title);
            track.artist = if artist.is_empty() {
                None
            } else {
                Some(artist.to_string())
            };
            track.album = if album.is_empty() {
                None
            } else {
                Some(album.to_string())
            };
            upsert_track(&db, &track).await.unwrap();
        }
        // 覆盖一条：索引与旧 LIKE 都必须优先用编辑值。
        let edited = sqlx::query_scalar::<_, String>("SELECT id FROM tracks WHERE path = ?1")
            .bind("/m/3.mp3")
            .fetch_one(&db)
            .await
            .unwrap();
        track_edits::apply(
            &db,
            &edited,
            &track_edits::EditInput {
                title: Some("七里香 (remaster)".into()),
                artist: None,
                album: None,
            },
        )
        .await
        .unwrap();

        // 含 1~2 字符（trigram 用不上）、大小写、中文、通配符、前后与内部空白、
        // 无命中的各式查询。前后空白与 `周杰伦 nope` 这两类是实测过的差异点：
        // 只靠 FTS 匹配会给出超集，必须由 LIKE 复核收敛回旧行为。
        for query in [
            "晴", "晴天", "周杰", "周杰伦", "七里香", "remaster", "REM", "bló", "BLÓ",
            "sigur rós", "100%", "a_b", "A_B", "mixed", "MIXED", "trailing", "nope",
            " 晴天", "叶惠美", "spaced", "周杰伦 nope", "晴天 ", "r ó s",
        ] {
            for sort in [TrackSort::Title, TrackSort::Artist, TrackSort::Added] {
                let fts = list_track_ids(&db, Some(query), sort).await.unwrap();
                let like = legacy_ids(&db, query, sort).await;
                assert_eq!(fts, like, "查询 {query:?} 在 {sort:?} 下与 LIKE 结果不一致");
            }
            assert_eq!(
                count_tracks(&db, Some(query)).await.unwrap() as usize,
                legacy_ids(&db, query, TrackSort::Title).await.len(),
                "查询 {query:?} 的计数与 LIKE 基准不一致"
            );
        }
    }

    /// 搜索路径必须真的走 FTS 索引 —— 否则这次改造只是换了个更慢的写法。
    #[tokio::test]
    async fn search_plan_uses_the_trigram_index() {
        let db = pool().await;
        for i in 0..64 {
            upsert_track(&db, &sample(&format!("/m/{i}.mp3"), &format!("Song {i:03}")))
                .await
                .unwrap();
        }
        let sql = format!("EXPLAIN QUERY PLAN {}", legacy_ids_sql(TrackSort::Title));
        type PlanRow = (i64, i64, i64, String);
        let plan: Vec<PlanRow> = sqlx::query_as(&sql)
            .bind("Song 007")
            .bind("%Song 007%")
            .fetch_all(&db)
            .await
            .unwrap();
        let text = plan
            .iter()
            .map(|(_, _, _, detail)| detail.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        println!("LEGACY PLAN:\n{text}");
        assert!(text.contains("SCAN t"), "旧 LIKE 语句应全表扫：{text}");
        assert!(
            !text.contains("track_search"),
            "旧语句不该碰索引表：{text}"
        );

        // 粗筛语句必须真的落到 trigram 约束上：`INDEX 0:L0` 里的 L0 就是 LIKE 约束；
        // 只有 `INDEX 0:` 表示退化成整表扫索引表（这正是三列写成一个 OR 时的样子）。
        let plan: Vec<PlanRow> = sqlx::query_as(
            "EXPLAIN QUERY PLAN SELECT rowid FROM track_search WHERE title LIKE ?1
             UNION SELECT rowid FROM track_search WHERE artist LIKE ?1
             UNION SELECT rowid FROM track_search WHERE album LIKE ?1",
        )
        .bind("%Song 007%")
        .fetch_all(&db)
        .await
        .unwrap();
        let text = plan
            .iter()
            .map(|(_, _, _, detail)| detail.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        println!("CANDIDATE PLAN:\n{text}");
        assert!(
            text.contains("INDEX 0:L0"),
            "粗筛没有用上 trigram 索引：{text}"
        );

        // 预筛后的主语句必须由候选驱动（走主键点查），而不是再扫一遍 tracks。
        let plan: Vec<PlanRow> = sqlx::query_as(&format!(
            "EXPLAIN QUERY PLAN SELECT t.id FROM tracks t LEFT JOIN track_edits e ON e.track_id = t.id WHERE {SEARCH_PREFILTER_WHERE} ORDER BY {}",
            TrackSort::Title.sql()
        ))
        .bind("[1,2,3]")
        .bind("%Song 007%")
        .fetch_all(&db)
        .await
        .unwrap();
        let text = plan
            .iter()
            .map(|(_, _, _, detail)| detail.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        println!("PREFILTER PLAN:\n{text}");
        assert!(
            text.contains("SEARCH t USING INTEGER PRIMARY KEY"),
            "预筛语句没有走主键点查：{text}"
        );
    }

    fn legacy_ids_sql_filtered(sort: TrackSort, filter: &TrackFilter) -> String {
        format!(
            "SELECT t.id FROM tracks t          LEFT JOIN track_edits e ON e.track_id = t.id          WHERE {LEGACY_SEARCH_PREDICATE}{}          ORDER BY {}",
            filter.sql(3),
            sort.sql()
        )
    }

    /// 查询 + 歌手/专辑筛选的组合：预筛路径与旧路径的**参数编号不同**
    /// （预筛 ?1=候选 JSON、?2=复核模式；旧路径 ?1=原始查询、?2=模式），
    /// 编号错位会静默筛错，所以这里把三条语句都对着 LIKE 基准比一遍。
    #[tokio::test]
    async fn search_with_facet_filter_matches_the_like_scan() {
        let db = pool().await;
        for (i, (title, artist, album)) in [
            ("晴天", "周杰伦", "叶惠美"),
            ("晴天 (Live)", "周杰伦", "演唱会"),
            ("七里香", "周杰伦", "七里香"),
            ("普通朋友", "陶喆", "I'm OK"),
            ("元素", "陶喆", "黑色柳丁"),
            ("奥尔菲斯", "陈奕迅", "Live"),
        ]
        .iter()
        .enumerate()
        {
            let mut track = sample(&format!("/f/{i}.mp3"), title);
            track.artist = Some((*artist).into());
            track.album = Some((*album).into());
            upsert_track(&db, &track).await.unwrap();
        }

        // 覆盖：能走索引的长查询、走不了索引的短查询、以及只命中单曲的查询。
        for query in ["晴天", "周杰", "七里香", "普通朋友", "Te", "陈", "nope"] {
            for artist in [None, Some("周杰伦"), Some("陶喆")] {
                for album in [None, Some("叶惠美"), Some("Live")] {
                    let filter = TrackFilter {
                        artist: artist.map(str::to_string),
                        album: album.map(str::to_string),
                    };
                    let label = format!("q={query:?} artist={artist:?} album={album:?}");

                    let sql = legacy_ids_sql_filtered(TrackSort::Title, &filter);
                    let mut stmt = sqlx::query_scalar::<_, String>(&sql)
                        .bind(query.trim())
                        .bind(format!("%{}%", query.trim()));
                    for bind in filter.binds() {
                        stmt = stmt.bind(bind);
                    }
                    let expected = stmt.fetch_all(&db).await.unwrap();

                    let got = list_track_ids_filtered(&db, Some(query), &filter, TrackSort::Title)
                        .await
                        .unwrap();
                    assert_eq!(got, expected, "ids 不一致：{label}");

                    let page = list_tracks_filtered(&db, Some(query), &filter, TrackSort::Title, 50, 0)
                        .await
                        .unwrap();
                    let page_ids: Vec<String> = page.into_iter().map(|t| t.id).collect();
                    assert_eq!(page_ids, expected, "列表分页不一致：{label}");

                    let count = count_tracks_filtered(&db, Some(query), &filter)
                        .await
                        .unwrap();
                    assert_eq!(count as usize, expected.len(), "计数不一致：{label}");
                }
            }
        }
    }

    /// 升级路径：老库（有曲目、没有索引内容与触发器）跑完 0012 之后必须立即同步。
    ///
    /// 其余测试都是新建库，0012 执行时 tracks 还是空的 —— 回填那条 `INSERT ...
    /// SELECT` 从没被真正跑过。这里把索引行清空、触发器删掉来模拟升级前的状态，
    /// 再**重放迁移文件本身**（不是抄一份 SQL），保证测的就是上线时要执行的东西。
    #[tokio::test]
    async fn migration_backfills_existing_rows_and_restores_triggers() {
        let db = pool().await;
        for trigger in [
            "tracks_search_ai",
            "tracks_search_au",
            "tracks_search_ad",
            "track_edits_search_ai",
            "track_edits_search_au",
            "track_edits_search_ad",
        ] {
            sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger}"))
                .execute(&db)
                .await
                .unwrap();
        }
        let mut ids = Vec::new();
        for i in 0..5 {
            let track = sample(&format!("/up/{i}.mp3"), &format!("Upgrade {i}"));
            upsert_track(&db, &track).await.unwrap();
            ids.push(track.id);
        }
        track_edits::apply(
            &db,
            &ids[0],
            &track_edits::EditInput {
                title: Some("Upgrade 0 (edited)".into()),
                artist: None,
                album: None,
            },
        )
        .await
        .unwrap();
        // 前置条件：索引确实是空的（否则这个测试什么也没证明）。
        let indexed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM track_search")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(indexed, 0, "模拟升级前的库时不该有索引行");

        sqlx::raw_sql(include_str!("../../../migrations/0012_track_search.sql"))
            .execute(&db)
            .await
            .unwrap();

        assert_index_mirrors_effective_values(&db).await;
        // 触发器也回来了：再改一次标签，索引要跟着变。
        track_edits::apply(
            &db,
            &ids[1],
            &track_edits::EditInput {
                title: Some("Upgrade 1 (edited)".into()),
                artist: None,
                album: None,
            },
        )
        .await
        .unwrap();
        assert_index_mirrors_effective_values(&db).await;
        assert_eq!(
            list_track_ids(&db, Some("Upgrade 1 (edited)"), TrackSort::Title)
                .await
                .unwrap(),
            vec![ids[1].clone()]
        );
    }

    /// 候选数超过上限时必须回落整表扫，且结果与 LIKE 基准一致（阈值两侧都不能少结果）。
    #[tokio::test]
    async fn search_overflow_falls_back_to_the_like_scan() {
        let db = pool().await;
        for i in 0..SEARCH_PREFILTER_MAX + 5 {
            upsert_track(&db, &sample(&format!("/big/{i}.mp3"), &format!("Overflow {i:05}")))
                .await
                .unwrap();
        }
        let query = "Overflow";
        assert!(search_candidates(&db, query).await.unwrap().is_none());
        assert_eq!(
            list_track_ids(&db, Some(query), TrackSort::Title).await.unwrap(),
            legacy_ids(&db, query, TrackSort::Title).await
        );
        assert_eq!(
            count_tracks(&db, Some(query)).await.unwrap() as usize,
            legacy_ids(&db, query, TrackSort::Title).await.len()
        );
        // 换成只命中 1 首的查询：候选在上限内，必须走预筛且结果一致。
        assert!(search_candidates(&db, "Overflow 00007")
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            list_track_ids(&db, Some("Overflow 00007"), TrackSort::Title)
                .await
                .unwrap(),
            legacy_ids(&db, "Overflow 00007", TrackSort::Title).await
        );
    }

    /// 性能探针（不设断言，避免抖动变成红 CI）：量「搜索提速」与「写入/浏览代价」。
    /// 手动跑：`$env:VMUSIC_PERF=1; cargo test -p vmusic-store -- --nocapture search_perf`
    #[tokio::test]
    async fn search_perf_probe() {
        if std::env::var("VMUSIC_PERF").is_err() {
            return;
        }
        const N: usize = 10_000;
        let db = pool().await;
        let started = std::time::Instant::now();
        for i in 0..N {
            let mut track = sample(
                &format!("/perf/{i}.mp3"),
                &format!("Song {i:05}"),
            );
            track.artist = Some(format!("Artist {}", i % 500));
            track.album = Some(format!("Album {}", i % 200));
            upsert_track(&db, &track).await.unwrap();
        }
        println!(
            "PERF upsert {N} tracks with index: {:?}",
            started.elapsed()
        );

        // 生产路径 vs 旧 LIKE 基准：每轮 = 一次计数 + 一次 ids（列表视图真实开销）。
        for (label, query) in [
            ("3char-narrow", "Song 00123"),
            ("3char-broad", "Song 001"),
            ("1char", "7"),
            ("empty", ""),
        ] {
            let t = std::time::Instant::now();
            for _ in 0..20 {
                let _ = count_tracks(&db, Some(query)).await.unwrap();
                let _ = list_track_ids(&db, Some(query), TrackSort::Title)
                    .await
                    .unwrap();
            }
            let new = t.elapsed() / 20;
            let t = std::time::Instant::now();
            for _ in 0..20 {
                let _ = legacy_count(&db, query).await;
                let _ = legacy_ids(&db, query, TrackSort::Title).await;
            }
            let old = t.elapsed() / 20;
            println!("PERF {label}: index={new:?} like={old:?}");
        }

        // 写入代价：去掉触发器再灌一批，差值就是索引维护成本。
        for trigger in [
            "tracks_search_ai",
            "tracks_search_au",
            "tracks_search_ad",
            "track_edits_search_ai",
            "track_edits_search_au",
            "track_edits_search_ad",
        ] {
            sqlx::query(&format!("DROP TRIGGER IF EXISTS {trigger}"))
                .execute(&db)
                .await
                .unwrap();
        }
        let started = std::time::Instant::now();
        for i in 0..N {
            let track = sample(&format!("/perf2/{i}.mp3"), &format!("Song {i:05}"));
            upsert_track(&db, &track).await.unwrap();
        }
        println!(
            "PERF upsert {N} tracks without index: {:?}",
            started.elapsed()
        );
    }

    /// 计数基准（旧 LIKE 语句），只给性能探针用。
    async fn legacy_count(db: &SqlitePool, query: &str) -> i64 {
        let query = query.trim();
        let sql = format!(
            "SELECT COUNT(*) AS n FROM tracks t          LEFT JOIN track_edits e ON e.track_id = t.id          WHERE {LEGACY_SEARCH_PREDICATE}"
        );
        type CountRow = (i64,);
        let row: CountRow = sqlx::query_as(&sql)
            .bind(query)
            .bind(format!("%{query}%"))
            .fetch_one(db)
            .await
            .unwrap();
        row.0
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
