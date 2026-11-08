// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 用户数据备份与恢复（歌单 / 收藏 / 设置 / 曲库目录）。
//!
//! 导出是纯 JSON，不包含任何平台凭据——凭据属于系统钥匙串（第 7 项），
//! 绝不混进可以随手拷贝分享的备份文件。恢复在一个事务里完成：任何一条
//! 校验失败或写入失败都会整体回滚，不会留下半份新数据。
//!
//! 幂等语义：
//!   - 歌单按名字匹配：已存在则追加曲目（去重），不存在则新建；
//!   - 收藏按 (kind, source, ref_id) 唯一键 INSERT OR IGNORE；
//!   - 设置/目录 upsert 覆盖。
//!
//! 重复恢复同一份备份是安全的。

use serde::Deserialize;
use sqlx::{SqliteConnection, SqlitePool};
use vmusic_core::StoreError;

use crate::now_ms;

pub const BACKUP_VERSION: i64 = 1;
pub const LYRICS_BACKUP_VERSION: i64 = 2;
pub const MAX_BACKUP_LYRICS: usize = 2048;
pub const MAX_BACKUP_LYRICS_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct BackupFile {
    pub version: i64,
    #[serde(default)]
    pub exported_at: Option<i64>,
    #[serde(default)]
    pub playlists: Vec<BackupPlaylist>,
    #[serde(default)]
    pub favorites: Vec<BackupFavorite>,
    #[serde(default)]
    pub settings: std::collections::BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub scan_roots: Vec<BackupScanRoot>,
    #[serde(default)]
    pub lyrics: Vec<BackupLyric>,
}

/// Original source only. Canonical lines and vocal identities are rebuilt by
/// the existing lyric parser when the service admits a restore.
#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupLyric {
    pub track_id: String,
    pub content: String,
    pub offset_ms: i64,
    pub revision: String,
}

pub fn validate_lyrics(file: &BackupFile) -> Result<(), StoreError> {
    if !matches!(file.version, BACKUP_VERSION | LYRICS_BACKUP_VERSION) {
        return Err(StoreError::Serialization(
            "不支持的备份版本（当前支持1、2）".into(),
        ));
    }
    if file.version == BACKUP_VERSION && !file.lyrics.is_empty() {
        return Err(StoreError::Serialization(
            "带歌词原文的备份必须使用版本2".into(),
        ));
    }
    validate_lyric_entries(&file.lyrics)?;
    // HTTP and RPC admit this same canonical payload before parser work or writes.
    // Source bytes alone omit JSON escaping and the other exported user data.
    if file.version == LYRICS_BACKUP_VERSION
        && serde_json::to_vec(file)
            .map_err(|error| StoreError::Serialization(error.to_string()))?
            .len()
            > MAX_BACKUP_LYRICS_BYTES
    {
        return Err(StoreError::Serialization(
            "歌词备份JSON超过2 MiB恢复预算".into(),
        ));
    }
    Ok(())
}

fn validate_lyric_entries(lyrics: &[BackupLyric]) -> Result<(), StoreError> {
    if lyrics.len() > MAX_BACKUP_LYRICS
        || lyrics.iter().map(|l| l.content.len()).sum::<usize>() > MAX_BACKUP_LYRICS_BYTES
    {
        return Err(StoreError::Serialization(
            "歌词备份超过2048项或2 MiB原文预算".into(),
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for lyric in lyrics {
        crate::limits::check_len(
            "歌词曲目id",
            Some(&lyric.track_id),
            crate::limits::MAX_ID_CHARS,
            "歌词备份",
        )?;
        let revision = lyric.revision.parse::<i64>().ok();
        if lyric.track_id.trim().is_empty()
            || !ids.insert(lyric.track_id.as_str())
            || lyric.offset_ms.unsigned_abs() > 60_000
            || revision.is_none_or(|r| r < 1 || r.to_string() != lyric.revision)
        {
            return Err(StoreError::Serialization(
                "歌词备份身份、偏移或修订无效".into(),
            ));
        }
    }
    Ok(())
}

#[derive(Debug, serde::Serialize, Deserialize)]
pub struct BackupPlaylist {
    pub name: String,
    #[serde(default)]
    pub tracks: Vec<BackupPlaylistTrack>,
}

#[derive(Debug, Default, serde::Serialize, Deserialize)]
pub struct BackupPlaylistTrack {
    pub track_id: String,
    /// 在线曲目的快照（来源/标题等）；本地曲目没有。
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub cover: Option<String>,
}

#[derive(Debug, serde::Serialize, Deserialize)]
pub struct BackupFavorite {
    pub kind: String,
    #[serde(default)]
    pub source: String,
    pub ref_id: String,
    pub title: String,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub cover: Option<String>,
}

#[derive(Debug, serde::Serialize, Deserialize)]
pub struct BackupScanRoot {
    pub path: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// 快照字段（在线曲目的来源/标题/封面）逐个过长度闸门。
fn check_optional_text(field: &str, value: Option<&str>) -> Result<(), StoreError> {
    crate::limits::check_len(field, value, crate::limits::MAX_TEXT_CHARS, field)
}

fn check_snapshot_strings(t: &BackupPlaylistTrack) -> Result<(), StoreError> {
    crate::limits::check_len(
        "曲目 id",
        Some(&t.track_id),
        crate::limits::MAX_ID_CHARS,
        "歌单条目",
    )?;
    crate::limits::check_len(
        "曲目来源",
        t.source.as_deref(),
        crate::limits::MAX_ID_CHARS,
        "歌单条目",
    )?;
    check_optional_text("曲目标题", t.title.as_deref())?;
    check_optional_text("曲目歌手", t.artist.as_deref())?;
    check_optional_text("曲目专辑", t.album.as_deref())?;
    // cover 只该放 URL。放得下一张 base64 图的备份能把整个用户库撑大几十倍，
    // 而且它不是「用户数据」，是缓存 —— 该走封面缓存目录，不该进数据库。
    crate::limits::check_len(
        "曲目封面",
        t.cover.as_deref(),
        crate::limits::MAX_URL_CHARS,
        "歌单条目",
    )
}

#[derive(Debug)]
pub struct ExportedBackup {
    pub version: i64,
    pub exported_at: i64,
    pub playlists: Vec<ExportedPlaylist>,
    pub favorites: Vec<ExportedFavorite>,
    pub settings: std::collections::BTreeMap<String, serde_json::Value>,
    pub scan_roots: Vec<(String, bool)>,
    pub lyrics: Vec<BackupLyric>,
}

/// One wire shape for export and restore admission, including tuple scan roots
/// and export metadata. The restore DTO must not inflate an admitted export.
#[derive(serde::Serialize)]
struct BackupWire<'a, P, F, R> {
    version: i64,
    exported_at: i64,
    playlists: &'a [P],
    favorites: &'a [F],
    settings: &'a std::collections::BTreeMap<String, serde_json::Value>,
    scan_roots: R,
    #[serde(skip_serializing_if = "Option::is_none")]
    lyrics: Option<&'a [BackupLyric]>,
}

impl serde::Serialize for ExportedBackup {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        BackupWire {
            version: self.version,
            exported_at: self.exported_at,
            playlists: &self.playlists,
            favorites: &self.favorites,
            settings: &self.settings,
            scan_roots: &self.scan_roots,
            lyrics: (!self.lyrics.is_empty()).then_some(self.lyrics.as_slice()),
        }
        .serialize(serializer)
    }
}

impl serde::Serialize for BackupFile {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let roots: Vec<_> = self
            .scan_roots
            .iter()
            .map(|root| (root.path.as_str(), root.enabled))
            .collect();
        BackupWire {
            version: self.version,
            exported_at: self.exported_at.unwrap_or_else(now_ms),
            playlists: &self.playlists,
            favorites: &self.favorites,
            settings: &self.settings,
            scan_roots: &roots,
            lyrics: (!self.lyrics.is_empty()).then_some(self.lyrics.as_slice()),
        }
        .serialize(serializer)
    }
}

#[derive(Debug, serde::Serialize)]
pub struct ExportedPlaylist {
    pub name: String,
    pub tracks: Vec<ExportedTrack>,
}

#[derive(Debug, serde::Serialize)]
pub struct ExportedTrack {
    pub track_id: String,
    pub source: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
    pub cover: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct ExportedFavorite {
    pub kind: String,
    pub source: String,
    pub ref_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
    pub cover: Option<String>,
}

/// 导出全部用户数据。歌单曲目带在线快照列，本地曲目这些列是 NULL。
pub async fn export(pool: &SqlitePool) -> Result<ExportedBackup, StoreError> {
    // Deferred BEGIN keeps one WAL read snapshot without taking the writer lock.
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    let exported = export_snapshot(&mut tx).await?;
    tx.commit()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(exported)
}

async fn export_snapshot(connection: &mut SqliteConnection) -> Result<ExportedBackup, StoreError> {
    #[derive(sqlx::FromRow)]
    struct PlaylistRow {
        id: String,
        name: String,
        track_id: Option<String>,
        source: Option<String>,
        title: Option<String>,
        artist: Option<String>,
        album: Option<String>,
        duration_ms: Option<i64>,
        cover: Option<String>,
    }
    let playlists: Vec<PlaylistRow> = sqlx::query_as(
        "SELECT p.id, p.name, pt.track_id, pt.source, pt.title,
                pt.artist, pt.album, pt.duration_ms, pt.cover FROM playlists p
         LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
         ORDER BY p.created_at, p.id, pt.position, pt.track_id",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;

    let mut exported: Vec<ExportedPlaylist> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for row in playlists {
        let pos = match index.get(&row.id) {
            Some(&pos) => pos,
            None => {
                exported.push(ExportedPlaylist {
                    name: row.name,
                    tracks: Vec::new(),
                });
                index.insert(row.id, exported.len() - 1);
                exported.len() - 1
            }
        };
        let Some(track_id) = row.track_id else {
            continue;
        };
        exported[pos].tracks.push(ExportedTrack {
            track_id,
            source: row.source,
            title: row.title,
            artist: row.artist,
            album: row.album,
            duration_ms: row.duration_ms,
            cover: row.cover,
        });
    }

    type FavRow = (
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    );
    let rows: Vec<FavRow> = sqlx::query_as(
        "SELECT kind, source, ref_id, title, artist, album, duration_ms, cover
             FROM favorites ORDER BY added_at",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    let favorites = rows
        .into_iter()
        .map(
            |(kind, source, ref_id, title, artist, album, duration_ms, cover)| ExportedFavorite {
                kind,
                source,
                ref_id,
                title,
                artist,
                album,
                duration_ms,
                cover,
            },
        )
        .collect();

    // 凭据绝不进备份：正常情况下钥匙串迁移已把 online_cred_/cookie_ 键搬走，
    // 但迁移失败时它们还留在 settings——这里按前缀兜底过滤，保证导出文件
    // 无论服务处于什么状态都不含秘密（remote_cred_ 只进钥匙串，纯防御）。
    const SECRET_PREFIXES: [&str; 4] = [
        "online_cred_",
        "online_cookie_",
        "online_device_",
        "remote_cred_",
    ];
    let settings: std::collections::BTreeMap<String, serde_json::Value> =
        crate::settings::get_all_from(&mut *connection)
            .await?
            .into_iter()
            .filter(|(key, _)| {
                key != crate::stage_presets::STATE
                    && !SECRET_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
            })
            .collect();
    let roots: Vec<(String, i64)> =
        sqlx::query_as("SELECT path, enabled FROM scan_roots ORDER BY path")
            .fetch_all(&mut *connection)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;

    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT l.track_id,l.content,l.offset_ms,r.revision FROM track_lyrics l
         JOIN lyric_revisions r ON r.track_id=l.track_id ORDER BY l.track_id",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    let lyrics: Vec<_> = rows
        .into_iter()
        .map(|(track_id, content, offset_ms, revision)| BackupLyric {
            track_id,
            content,
            offset_ms,
            revision: revision.to_string(),
        })
        .collect();
    let result = ExportedBackup {
        version: if lyrics.is_empty() {
            BACKUP_VERSION
        } else {
            LYRICS_BACKUP_VERSION
        },
        exported_at: now_ms(),
        playlists: exported,
        favorites,
        settings,
        scan_roots: roots.into_iter().map(|(p, e)| (p, e != 0)).collect(),
        lyrics,
    };
    validate_lyric_entries(&result.lyrics)?;
    // Respect the existing 2 MiB HTTP restore envelope. A complete backup is
    // either admitted as a whole or rejected, never truncated.
    if !result.lyrics.is_empty()
        && serde_json::to_vec(&result)
            .map_err(|e| StoreError::Serialization(e.to_string()))?
            .len()
            > MAX_BACKUP_LYRICS_BYTES
    {
        return Err(StoreError::Serialization(
            "含歌词原文的完整备份超过2 MiB恢复预算".into(),
        ));
    }
    Ok(result)
}

#[derive(Debug, Default, serde::Serialize)]
pub struct RestoreReport {
    pub playlists_created: u64,
    pub playlists_merged: u64,
    pub tracks_added: u64,
    pub favorites_added: u64,
    pub settings_applied: u64,
    pub roots_applied: u64,
    pub lyrics_applied: u64,
}

/// 恢复：校验版本与必需字段，单个事务写入，任何失败整体回滚。
pub async fn restore(pool: &SqlitePool, file: &BackupFile) -> Result<RestoreReport, StoreError> {
    crate::stage_presets::validate_backup(&file.settings)
        .map_err(|e| StoreError::Serialization(e.to_string()))?;
    if !matches!(file.version, BACKUP_VERSION | LYRICS_BACKUP_VERSION) {
        return Err(StoreError::Database(format!(
            "不支持的备份版本 {}（当前支持1、2）",
            file.version
        )));
    }
    validate_lyrics(file)?;
    // 曲目 id 不做存在性校验：备份可能跨机器恢复，曲目尚未扫描是合法状态。
    // 数量与长度先整体过一遍（`limits` 模块）：**任何写入之前**验完，所以越界的
    // 载荷一条都进不了库，而不是「写了一半再回滚」。
    crate::limits::check_count(
        "备份里的歌单数",
        file.playlists.len(),
        crate::limits::MAX_PLAYLISTS_PER_BACKUP,
        "整个备份",
    )?;
    crate::limits::check_count(
        "备份里的收藏数",
        file.favorites.len(),
        crate::limits::MAX_FAVORITES_PER_BACKUP,
        "整个备份",
    )?;
    crate::limits::check_count(
        "备份里的扫描目录数",
        file.scan_roots.len(),
        crate::limits::MAX_SCAN_ROOTS_PER_BACKUP,
        "整个备份",
    )?;
    crate::limits::check_count(
        "备份里的设置键数",
        file.settings.len(),
        crate::limits::MAX_SETTINGS_KEYS,
        "整个备份",
    )?;
    let mut total_tracks = 0usize;
    for playlist in &file.playlists {
        if playlist.name.trim().is_empty() {
            return Err(StoreError::Database("歌单名不能为空".into()));
        }
        crate::limits::check_len(
            "歌单名",
            Some(&playlist.name),
            crate::limits::MAX_NAME_CHARS,
            "歌单名",
        )?;
        crate::limits::check_count(
            "单曲库里的曲目数",
            playlist.tracks.len(),
            crate::limits::MAX_TRACKS_PER_PLAYLIST,
            &playlist.name,
        )?;
        total_tracks += playlist.tracks.len();
        for track in &playlist.tracks {
            if track.track_id.trim().is_empty() {
                return Err(StoreError::Database(format!(
                    "歌单「{}」里存在没有 id 的曲目",
                    playlist.name
                )));
            }
            check_snapshot_strings(track)?;
        }
    }
    crate::limits::check_count(
        "备份里的曲目总数",
        total_tracks,
        crate::limits::MAX_TRACKS_PER_BACKUP,
        "整个备份",
    )?;
    for favorite in &file.favorites {
        if favorite.ref_id.trim().is_empty() || favorite.title.trim().is_empty() {
            return Err(StoreError::Database("收藏缺少 ref_id 或 title".into()));
        }
        crate::limits::check_len(
            "收藏 ref_id",
            Some(&favorite.ref_id),
            crate::limits::MAX_ID_CHARS,
            "收藏",
        )?;
        crate::limits::check_len(
            "收藏 source",
            Some(&favorite.source),
            crate::limits::MAX_ID_CHARS,
            "收藏",
        )?;
        crate::limits::check_len(
            "收藏标题",
            Some(&favorite.title),
            crate::limits::MAX_TEXT_CHARS,
            "收藏",
        )?;
        check_optional_text("收藏歌手", favorite.artist.as_deref())?;
        check_optional_text("收藏专辑", favorite.album.as_deref())?;
        crate::limits::check_len(
            "收藏封面",
            favorite.cover.as_deref(),
            crate::limits::MAX_URL_CHARS,
            "收藏",
        )?;
    }
    for root in &file.scan_roots {
        crate::limits::check_len(
            "扫描目录路径",
            Some(&root.path),
            crate::limits::MAX_PATH_CHARS,
            "扫描目录",
        )?;
    }
    for favorite in &file.favorites {
        if favorite.kind != "track" && favorite.kind != "radio" {
            return Err(StoreError::Database(format!(
                "未知收藏类型: {}",
                favorite.kind
            )));
        }
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    let mut report = RestoreReport::default();

    for playlist in &file.playlists {
        let existing: Option<(String,)> =
            sqlx::query_as("SELECT id FROM playlists WHERE name = ?1")
                .bind(playlist.name.trim())
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| StoreError::Database(e.to_string()))?;
        let playlist_id = match existing {
            Some((id,)) => {
                report.playlists_merged += 1;
                id
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                sqlx::query(
                    "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
                )
                .bind(&id)
                .bind(playlist.name.trim())
                .bind(now_ms())
                .execute(&mut *tx)
                .await
                .map_err(|e| StoreError::Database(e.to_string()))?;
                report.playlists_created += 1;
                id
            }
        };
        let existing_ids: Vec<String> =
            sqlx::query_scalar("SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1")
                .bind(&playlist_id)
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| StoreError::Database(e.to_string()))?;
        let mut position = existing_ids.len() as i64;
        for track in &playlist.tracks {
            if existing_ids.iter().any(|id| id == &track.track_id) {
                continue;
            }
            match (&track.source, &track.title) {
                (Some(source), Some(title))
                    if !source.trim().is_empty() && !title.trim().is_empty() =>
                {
                    sqlx::query(
                        "INSERT OR IGNORE INTO playlist_tracks
                           (playlist_id, track_id, position, source, title, artist, album, duration_ms, cover)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    )
                    .bind(&playlist_id)
                    .bind(&track.track_id)
                    .bind(position)
                    .bind(source)
                    .bind(title)
                    .bind(&track.artist)
                    .bind(&track.album)
                    .bind(track.duration_ms)
                    .bind(&track.cover)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| StoreError::Database(e.to_string()))?;
                }
                _ => {
                    sqlx::query(
                        "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position)
                         VALUES (?1, ?2, ?3)",
                    )
                    .bind(&playlist_id)
                    .bind(&track.track_id)
                    .bind(position)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| StoreError::Database(e.to_string()))?;
                }
            }
            position += 1;
            report.tracks_added += 1;
        }
    }

    for favorite in &file.favorites {
        let id = format!("{}:{}:{}", favorite.kind, favorite.source, favorite.ref_id);
        let result = sqlx::query(
            "INSERT INTO favorites
               (id, kind, source, ref_id, title, artist, album, duration_ms, cover, added_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
             ON CONFLICT(kind, source, ref_id) DO NOTHING",
        )
        .bind(&id)
        .bind(&favorite.kind)
        .bind(&favorite.source)
        .bind(&favorite.ref_id)
        .bind(&favorite.title)
        .bind(&favorite.artist)
        .bind(&favorite.album)
        .bind(favorite.duration_ms)
        .bind(&favorite.cover)
        .bind(now_ms())
        .execute(&mut *tx)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
        if result.rows_affected() > 0 {
            report.favorites_added += 1;
        }
    }

    for (key, value) in &file.settings {
        if crate::stage_presets::managed(key) {
            continue;
        }
        // updated_at 是 NOT NULL 且没有默认值，必须显式写；冲突时一并更新，口径
        // 与 settings::set_all 一致。
        sqlx::query(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(value.to_string())
        .bind(now_ms())
        .execute(&mut *tx)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
        report.settings_applied += 1;
    }

    for root in &file.scan_roots {
        sqlx::query(
            "INSERT INTO scan_roots (path, enabled) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET enabled = excluded.enabled",
        )
        .bind(&root.path)
        .bind(root.enabled)
        .execute(&mut *tx)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
        report.roots_applied += 1;
    }

    for lyric in &file.lyrics {
        // Existing content or a deletion tombstone is an intentional local
        // revision. Merge restores must not overwrite either.
        let result = sqlx::query(
            "INSERT INTO track_lyrics(track_id,content,offset_ms,updated_at)
             SELECT ?1,?2,?3,?4 WHERE NOT EXISTS(SELECT 1 FROM lyric_revisions WHERE track_id=?1)",
        )
        .bind(&lyric.track_id)
        .bind(&lyric.content)
        .bind(lyric.offset_ms)
        .bind(now_ms())
        .execute(&mut *tx)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
        if result.rows_affected() != 0 {
            sqlx::query("UPDATE lyric_revisions SET revision=?2 WHERE track_id=?1")
                .bind(&lyric.track_id)
                .bind(
                    lyric
                        .revision
                        .parse::<i64>()
                        .map_err(|e| StoreError::Serialization(e.to_string()))?,
                )
                .execute(&mut *tx)
                .await
                .map_err(|e| StoreError::Database(e.to_string()))?;
            report.lyrics_applied += 1;
        }
    }
    crate::stage_presets::restore(&mut tx, &file.settings)
        .await
        .map_err(|e| StoreError::Serialization(e.to_string()))?;
    report.settings_applied += file
        .settings
        .keys()
        .filter(|key| crate::stage_presets::managed(key))
        .count() as u64;
    tx.commit()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(report)
}

/// M3U 导出：本地曲按 #EXTINF + 路径输出；在线曲不在 tracks 表，JOIN 自动过滤。
pub async fn export_m3u(
    pool: &SqlitePool,
    playlist_id: &str,
) -> Result<Option<String>, StoreError> {
    let name: Option<(String,)> = sqlx::query_as("SELECT name FROM playlists WHERE id = ?1")
        .bind(playlist_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    let Some((name,)) = name else {
        return Ok(None);
    };
    let entries: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT t.path, t.title FROM playlist_tracks pt
         JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = ?1 ORDER BY pt.position",
    )
    .bind(playlist_id)
    .fetch_all(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    let mut out = String::from("#EXTM3U\n");
    out.push_str(&format!("#PLAYLIST:{name}\n"));
    for (path, title) in entries {
        out.push_str(&format!(
            "#EXTINF:-1,{}\n{path}\n",
            title.unwrap_or_default()
        ));
    }
    Ok(Some(out))
}

/// M3U 导入：按文件路径精确匹配本地曲目，未命中的行计入 skipped。
/// 始终新建歌单（避免同名覆盖既有编排）。返回 None 表示内容不是 M3U。
pub async fn import_m3u(
    pool: &SqlitePool,
    name: &str,
    content: &str,
) -> Result<Option<(String, u64, u64)>, StoreError> {
    crate::limits::check_len(
        "歌单名",
        Some(name),
        crate::limits::MAX_NAME_CHARS,
        "m3u 导入",
    )?;
    // 行数不单独设上限：一行至少一个字符，字节闸门已经把行数夹住了。
    if content.len() > crate::limits::MAX_M3U_BYTES {
        return Err(StoreError::Database(format!(
            "m3u 内容超过上限 {} 字节",
            crate::limits::MAX_M3U_BYTES
        )));
    }
    let mut lines = content.lines().map(str::trim).filter(|l| !l.is_empty());
    match lines.next() {
        // 宽松识别：BOM 与属性行都容忍，但首行必须是 # 注释（M3U 的标志）。
        Some(first) if first.trim_start_matches('\u{feff}').starts_with('#') => {}
        _ => return Ok(None),
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    let playlist_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)")
        .bind(&playlist_id)
        .bind(name.trim())
        .bind(now_ms())
        .execute(&mut *tx)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

    let mut added = 0u64;
    let mut skipped = 0u64;
    let mut position = 0i64;
    for line in lines {
        if line.starts_with('#') {
            continue; // 匹配靠路径，#EXTINF 元数据仅展示用
        }
        let hit: Option<(String,)> =
            sqlx::query_as("SELECT id FROM tracks WHERE path = ?1 AND source = 'local'")
                .bind(line)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| StoreError::Database(e.to_string()))?;
        match hit {
            Some((id,)) => {
                sqlx::query(
                    "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
                )
                .bind(&playlist_id)
                .bind(&id)
                .bind(position)
                .execute(&mut *tx)
                .await
                .map_err(|e| StoreError::Database(e.to_string()))?;
                position += 1;
                added += 1;
            }
            None => skipped += 1,
        }
    }
    tx.commit()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(Some((playlist_id, added, skipped)))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("vmusic-bk-test-{}", uuid::Uuid::new_v4()));
        crate::open(&dir).await.expect("open db")
    }

    fn sample(exported: &ExportedBackup) -> BackupFile {
        serde_json::from_value(serde_json::to_value(exported).unwrap()).unwrap()
    }

    #[test]
    fn complete_v2_restore_budget_includes_json_envelope_and_escaping() {
        let mut file: BackupFile = serde_json::from_value(serde_json::json!({
            "version": 2,
            "lyrics": (0..8).map(|index| BackupLyric {
                track_id: format!("t{index}"), content: "a".repeat(256 * 1024),
                offset_ms: 0, revision: "1".into(),
            }).collect::<Vec<_>>()
        }))
        .unwrap();
        assert_eq!(
            file.lyrics
                .iter()
                .map(|line| line.content.len())
                .sum::<usize>(),
            MAX_BACKUP_LYRICS_BYTES
        );
        assert!(validate_lyric_entries(&file.lyrics).is_ok());
        assert!(validate_lyrics(&file).is_err());
        file.lyrics.last_mut().unwrap().content.truncate(255 * 1024);
        assert!(validate_lyrics(&file).is_ok());
        // Escaped source fits the source-byte budget but exceeds the JSON budget.
        file.lyrics[0].content = "\"".repeat(256 * 1024);
        assert!(validate_lyric_entries(&file.lyrics).is_ok());
        assert!(validate_lyrics(&file).is_err());
    }

    #[test]
    fn complete_v2_budget_accepts_own_exact_limit_export_with_tuple_roots() {
        let mut exported = ExportedBackup {
            version: LYRICS_BACKUP_VERSION,
            exported_at: 1_794_000_000_000,
            playlists: vec![],
            favorites: vec![],
            settings: Default::default(),
            scan_roots: (0..100)
                .map(|index| (format!("D:/music/{index}"), true))
                .collect(),
            lyrics: vec![BackupLyric {
                track_id: "t1".into(),
                content: "[00:00]line".into(),
                offset_ms: 0,
                revision: "1".into(),
            }],
        };
        exported
            .settings
            .insert("padding".into(), serde_json::json!(""));
        let overhead = serde_json::to_vec(&exported).unwrap().len();
        exported.settings.insert(
            "padding".into(),
            serde_json::json!("x".repeat(MAX_BACKUP_LYRICS_BYTES - overhead)),
        );
        let bytes = serde_json::to_vec(&exported).unwrap();
        assert_eq!(bytes.len(), MAX_BACKUP_LYRICS_BYTES);
        let restored: BackupFile = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(serde_json::to_vec(&restored).unwrap(), bytes);
        assert!(validate_lyrics(&restored).is_ok());
        exported.settings.insert(
            "padding".into(),
            serde_json::json!("x".repeat(MAX_BACKUP_LYRICS_BYTES - overhead + 1)),
        );
        assert!(validate_lyrics(&sample(&exported)).is_err());
    }

    #[tokio::test]
    async fn lyric_source_offsets_and_revisions_roundtrip_without_overwriting_local_edits() {
        let source = pool().await;
        let target = pool().await;
        let raw = "<tt xmlns=\"http://www.w3.org/ns/ttml\"><body><p begin=\"1s\" end=\"2s\">原文</p></body></tt>";
        crate::lyrics::import(&source, "local", raw).await.unwrap();
        crate::lyrics::set_offset(&source, "local", -750)
            .await
            .unwrap();
        let before = crate::lyrics::snapshot(&source, "local").await.unwrap();
        let exported = export(&source).await.unwrap();
        assert_eq!(exported.version, LYRICS_BACKUP_VERSION);
        let file = sample(&exported);
        assert_eq!(file.lyrics[0].content, raw);
        assert_eq!(file.lyrics[0].revision, before.revision.to_string());
        assert_eq!(restore(&target, &file).await.unwrap().lyrics_applied, 1);
        let restored = crate::lyrics::snapshot(&target, "local").await.unwrap();
        assert_eq!(restored.content, before.content);
        assert_eq!(restored.offset_ms, before.offset_ms);
        assert_eq!(restored.revision, before.revision);
        assert_eq!(restore(&target, &file).await.unwrap().lyrics_applied, 0);
        assert_eq!(
            crate::lyrics::snapshot(&target, "local")
                .await
                .unwrap()
                .revision,
            restored.revision
        );
        crate::lyrics::import(&target, "local", "[00:01.00]local edit")
            .await
            .unwrap();
        assert_eq!(restore(&target, &file).await.unwrap().lyrics_applied, 0);
        assert_eq!(
            crate::lyrics::get(&target, "local")
                .await
                .unwrap()
                .unwrap()
                .content,
            "[00:01.00]local edit"
        );
        crate::lyrics::remove(&target, "local").await.unwrap();
        assert_eq!(restore(&target, &file).await.unwrap().lyrics_applied, 0);
        assert!(crate::lyrics::get(&target, "local")
            .await
            .unwrap()
            .is_none());
        let empty = export(&target).await.unwrap();
        assert_eq!(empty.version, BACKUP_VERSION);
        assert!(serde_json::to_value(empty).unwrap().get("lyrics").is_none());
        source.close().await;
        target.close().await;
    }

    #[tokio::test]
    async fn invalid_lyric_backup_is_rejected_before_other_business_writes() {
        let db = pool().await;
        let mut file = sample(&export(&db).await.unwrap());
        file.settings
            .insert("backup_probe".into(), serde_json::json!(true));
        file.lyrics.push(BackupLyric {
            track_id: "t".into(),
            content: "[00:01.00]x".into(),
            offset_ms: 0,
            revision: "1".into(),
        });
        assert!(
            restore(&db, &file).await.is_err(),
            "version1 must not silently discard lyrics"
        );
        file.version = LYRICS_BACKUP_VERSION;
        file.lyrics[0].offset_ms = 60001;
        assert!(restore(&db, &file).await.is_err());
        file.lyrics[0].offset_ms = 0;
        file.lyrics[0].revision = "01".into();
        assert!(restore(&db, &file).await.is_err());
        file.lyrics[0].revision = "1".into();
        file.lyrics.push(file.lyrics[0].clone());
        assert!(restore(&db, &file).await.is_err());
        assert!(crate::settings::get(&db, "backup_probe")
            .await
            .unwrap()
            .is_none());
        assert!(crate::lyrics::get(&db, "t").await.unwrap().is_none());
        db.close().await;
    }

    #[tokio::test]
    async fn export_preserves_playlist_membership_empty_lists_and_version_one_restore() {
        let db = pool().await;
        sqlx::raw_sql(
            "INSERT INTO playlists (id, name, created_at, updated_at) VALUES
             ('a', 'Repeat', 1, 1), ('b', 'Repeat', 2, 2),
             ('c', 'Other', 3, 3), ('d', 'Empty', 4, 4);
             INSERT INTO playlist_tracks (playlist_id, track_id, position, source, title) VALUES
             ('a', 'shared', 1, 'online', 'Snapshot A'),
             ('a', 'local', 0, NULL, NULL),
             ('b', 'shared', 0, 'online', 'Snapshot B'),
             ('c', 'shared', 0, 'online', 'Snapshot C');",
        )
        .execute(&db)
        .await
        .unwrap();
        crate::scan_roots::upsert(&db, "D:/music", false)
            .await
            .unwrap();

        let exported = export(&db).await.unwrap();
        assert_eq!(exported.playlists.len(), 4);
        assert_eq!(exported.playlists[0].name, "Repeat");
        assert_eq!(exported.playlists[1].name, "Repeat");
        assert_eq!(exported.playlists[0].tracks[0].track_id, "local");
        assert!(exported.playlists[0].tracks[0].title.is_none());
        assert_eq!(
            exported.playlists[0].tracks[1].title.as_deref(),
            Some("Snapshot A")
        );
        assert_eq!(
            exported.playlists[1].tracks[0].title.as_deref(),
            Some("Snapshot B")
        );
        assert_eq!(
            exported.playlists[2].tracks[0].title.as_deref(),
            Some("Snapshot C")
        );
        assert_eq!(exported.playlists[3].name, "Empty");
        assert!(exported.playlists[3].tracks.is_empty());

        // Version 1 keeps tuple roots and name-based restore merging.
        let json = serde_json::to_value(&exported).unwrap();
        assert_eq!(json["scan_roots"], serde_json::json!([["D:/music", false]]));
        let fresh = pool().await;
        let report = restore(&fresh, &sample(&exported)).await.unwrap();
        assert_eq!(report.playlists_created, 3);
        assert_eq!(report.playlists_merged, 1);
        assert_eq!(report.tracks_added, 3);
        assert_eq!(report.roots_applied, 1);
        let restored = export(&fresh).await.unwrap();
        let repeated = restored
            .playlists
            .iter()
            .find(|p| p.name == "Repeat")
            .unwrap();
        assert_eq!(repeated.tracks.len(), 2);
        assert_eq!(repeated.tracks[1].title.as_deref(), Some("Snapshot A"));
        let other = restored
            .playlists
            .iter()
            .find(|p| p.name == "Other")
            .unwrap();
        assert_eq!(other.tracks[0].title.as_deref(), Some("Snapshot C"));
        assert!(restored
            .playlists
            .iter()
            .find(|p| p.name == "Empty")
            .unwrap()
            .tracks
            .is_empty());
        assert_eq!(restored.scan_roots, exported.scan_roots);
        db.close().await;
        fresh.close().await;
    }

    #[tokio::test]
    async fn export_snapshot_keeps_all_sections_on_one_wal_generation() {
        let db = pool().await;
        sqlx::raw_sql(
            "INSERT INTO playlists (id, name, created_at, updated_at) VALUES ('p', 'Before', 1, 1);
             INSERT INTO playlist_tracks (playlist_id, track_id, position, source, title)
             VALUES ('p', 'track', 0, 'online', 'Before');
             INSERT INTO favorites (id, kind, source, ref_id, title, added_at, updated_at)
             VALUES ('track:online:track', 'track', 'online', 'track', 'Before', 1, 1);
             INSERT INTO settings (key, value, updated_at) VALUES ('backup_generation', '\"Before\"', 1);
             INSERT INTO scan_roots (path, enabled) VALUES ('D:/music', 1);",
        )
        .execute(&db)
        .await
        .unwrap();
        let mut reader = db.begin().await.unwrap();
        // A real read establishes the snapshot; BEGIN alone does not.
        let first: String = sqlx::query_scalar("SELECT name FROM playlists WHERE id = 'p'")
            .fetch_one(&mut *reader)
            .await
            .unwrap();
        assert_eq!(first, "Before");

        let mut writer = crate::begin_immediate(&db).await.unwrap();
        sqlx::raw_sql(
            "UPDATE playlists SET name = 'After';
             UPDATE playlist_tracks SET title = 'After';
             UPDATE favorites SET title = 'After';
             UPDATE settings SET value = '\"After\"' WHERE key = 'backup_generation';
             UPDATE scan_roots SET enabled = 0;",
        )
        .execute(&mut *writer)
        .await
        .unwrap();
        writer.commit().await.unwrap();

        let before = export_snapshot(&mut reader).await.unwrap();
        assert_eq!(before.playlists[0].name, "Before");
        assert_eq!(
            before.playlists[0].tracks[0].title.as_deref(),
            Some("Before")
        );
        assert_eq!(before.favorites[0].title, "Before");
        assert_eq!(
            before.settings["backup_generation"],
            serde_json::json!("Before")
        );
        assert_eq!(before.scan_roots, [("D:/music".to_owned(), true)]);
        reader.commit().await.unwrap();

        let after = export(&db).await.unwrap();
        assert_eq!(after.playlists[0].name, "After");
        assert_eq!(after.playlists[0].tracks[0].title.as_deref(), Some("After"));
        assert_eq!(after.favorites[0].title, "After");
        assert_eq!(
            after.settings["backup_generation"],
            serde_json::json!("After")
        );
        assert_eq!(after.scan_roots, [("D:/music".to_owned(), false)]);
        db.close().await;
    }

    #[tokio::test]
    async fn restore_is_idempotent_and_rejects_unknown_version() {
        let db = pool().await;
        crate::upsert_track(&db, &sample_track("t1", "A", Some("X")))
            .await
            .unwrap();
        crate::favorites::add(
            &db,
            vmusic_core::FavoriteKind::Track,
            "local",
            "t1",
            &crate::favorites::FavoriteMeta {
                title: "A".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let pl = new_playlist(&db, "我的歌单").await;
        crate::playlists::add_tracks(&db, &pl, &["t1".to_string()])
            .await
            .unwrap();

        let exported = export(&db).await.unwrap();
        assert_eq!(exported.version, BACKUP_VERSION);
        let file = sample(&exported);

        let report = restore(&db, &file).await.unwrap();
        assert_eq!(report.playlists_merged, 1);
        assert_eq!(report.tracks_added, 0, "已有条目不重复追加");
        assert_eq!(report.favorites_added, 0, "已有收藏不重复");
        // 重复恢复仍然安全。
        let again = restore(&db, &file).await.unwrap();
        assert_eq!(again.playlists_merged, 1);
        assert_eq!(crate::count_tracks(&db, None).await.unwrap(), 1);

        let mut bad = sample(&exported);
        bad.version = 99;
        assert!(restore(&db, &bad).await.is_err(), "未知版本必须拒绝");
        db.close().await;
    }

    /// 备份里带 settings 时，恢复必须真的写得进去。
    ///
    /// `settings.updated_at` 是 NOT NULL 且没有默认值，而 restore 里那条 INSERT
    /// 一度漏了这一列，于是任何带 settings 的备份恢复都会撞约束、整单回滚——而
    /// 真实备份几乎总是带 settings（音量、播放模式、主题…），等于「备份导入」
    /// 这个功能一直是坏的。上面那个幂等测试没写任何 settings，所以从没覆盖到。
    #[tokio::test]
    async fn restore_applies_settings_from_the_backup() {
        let db = pool().await;
        crate::settings::set(&db, "player_volume", &serde_json::json!(0.3))
            .await
            .unwrap();
        crate::settings::set(&db, "player_mode", &serde_json::json!("shuffle"))
            .await
            .unwrap();

        let exported = export(&db).await.unwrap();
        assert_eq!(exported.settings.len(), 2, "两个键都进了备份");
        let file = sample(&exported);

        // 换一个空库恢复，才证明值是写进去的而不是本来就在。
        let fresh = pool().await;
        let report = restore(&fresh, &file).await.unwrap();
        assert_eq!(report.settings_applied, 2);
        assert_eq!(
            crate::settings::get(&fresh, "player_volume").await.unwrap(),
            Some(serde_json::json!(0.3))
        );
        assert_eq!(
            crate::settings::get(&fresh, "player_mode").await.unwrap(),
            Some(serde_json::json!("shuffle"))
        );

        // 再恢复一次走 ON CONFLICT 分支：updated_at 也要跟着更新，不能只改 value。
        let again = restore(&fresh, &file).await.unwrap();
        assert_eq!(again.settings_applied, 2);
        db.close().await;
        fresh.close().await;
    }

    #[tokio::test]
    async fn export_never_contains_credential_keys() {
        let db = pool().await;
        // 模拟钥匙串迁移失败：凭据明文键还留在 settings 里。
        use serde_json::Value;
        let mut rows: Vec<(String, Value)> = Vec::new();
        rows.push((
            "online_cred_netease".into(),
            serde_json::json!({"cookie": "MUSIC_U=secret"}),
        ));
        rows.push((
            "online_cookie_kugou".into(),
            Value::String("kgmid=old".into()),
        ));
        rows.push((
            "online_device_fixture".into(),
            Value::String("device-secret".into()),
        ));
        rows.push((
            "remote_cred_fixture".into(),
            Value::String("remote-secret".into()),
        ));
        rows.push(("play_mode".into(), Value::String("repeat".into())));
        for (key, value) in &rows {
            crate::settings::set(&db, key, value).await.unwrap();
        }
        let exported = export(&db).await.unwrap();
        assert!(exported.settings.contains_key("play_mode"), "正常键保留");
        for key in exported.settings.keys() {
            assert!(
                !key.starts_with("online_cred_")
                    && !key.starts_with("online_cookie_")
                    && !key.starts_with("online_device_")
                    && !key.starts_with("remote_cred_"),
                "备份混入凭据键: {key}"
            );
        }
        db.close().await;
    }

    #[tokio::test]
    async fn restore_rejects_invalid_entries_without_partial_write() {
        let db = pool().await;
        let file = BackupFile {
            exported_at: None,
            lyrics: Vec::new(),
            version: BACKUP_VERSION,
            playlists: vec![BackupPlaylist {
                name: "坏歌单".into(),
                tracks: vec![BackupPlaylistTrack {
                    track_id: "  ".into(),
                    ..Default::default()
                }],
            }],
            favorites: vec![],
            settings: Default::default(),
            scan_roots: vec![],
        };
        assert!(restore(&db, &file).await.is_err(), "空 id 必须拒绝");
        // 事务回滚：坏歌单没有留下。
        assert!(crate::list_playlists(&db).await.unwrap().is_empty());
        db.close().await;
    }

    /// 数量与长度闸门必须在**任何写入之前**过完。「前半合法、后半越界」的载荷
    /// 才是危险的那种：它看起来只会失败，实际会留下半库，而事务回滚虽然也能兜住，
    /// 却要求我们为一次失败付出一整轮的写入与锁。
    #[tokio::test]
    async fn restore_rejects_oversize_payloads_before_writing_anything() {
        use crate::limits as L;
        let db = pool().await;
        let good = BackupPlaylist {
            name: "合法一半".into(),
            tracks: vec![BackupPlaylistTrack {
                track_id: "t1".into(),
                ..Default::default()
            }],
        };
        // 字段类型完全合法，只是体量越界：一张 base64 塞进封面列。
        let bad_cover = format!(
            "data:image/png;base64,{}",
            "A".repeat(L::MAX_URL_CHARS + 10)
        );
        let bad = BackupPlaylist {
            name: "越界一半".into(),
            tracks: vec![BackupPlaylistTrack {
                track_id: "t2".into(),
                cover: Some(bad_cover),
                ..Default::default()
            }],
        };
        let file = BackupFile {
            exported_at: None,
            lyrics: Vec::new(),
            version: BACKUP_VERSION,
            playlists: vec![good, bad],
            favorites: vec![],
            settings: Default::default(),
            scan_roots: vec![],
        };
        let err = restore(&db, &file).await.expect_err("超长封面必须拒绝");
        assert!(
            err.to_string().contains("上限"),
            "报错要说清是越界而不是数据库故障：{err}"
        );
        assert!(
            crate::list_playlists(&db).await.unwrap().is_empty(),
            "越界载荷一条都不该入库"
        );

        let many = BackupFile {
            exported_at: None,
            lyrics: Vec::new(),
            version: BACKUP_VERSION,
            playlists: (0..=L::MAX_PLAYLISTS_PER_BACKUP)
                .map(|i| BackupPlaylist {
                    name: format!("p{i}"),
                    tracks: vec![],
                })
                .collect(),
            favorites: vec![],
            settings: Default::default(),
            scan_roots: vec![],
        };
        assert!(restore(&db, &many).await.is_err(), "歌单条数上限要生效");
        assert!(
            crate::list_playlists(&db).await.unwrap().is_empty(),
            "数量越界同样一条不进"
        );
        db.close().await;
    }

    /// 上限不许贴身裁剪：刚好在界内的真实备份必须照常恢复。
    #[tokio::test]
    async fn restore_still_accepts_backups_at_the_bounds() {
        use crate::limits as L;
        let db = pool().await;
        crate::upsert_track(
            &db,
            &sample_track("r1", &"长".repeat(L::MAX_TEXT_CHARS), None),
        )
        .await
        .unwrap();
        let file = BackupFile {
            exported_at: None,
            lyrics: Vec::new(),
            version: BACKUP_VERSION,
            playlists: vec![BackupPlaylist {
                name: "上限内的歌单".into(),
                tracks: vec![BackupPlaylistTrack {
                    track_id: "r1".into(),
                    source: Some("netease".into()),
                    title: Some("长".repeat(L::MAX_TEXT_CHARS)),
                    artist: None,
                    album: None,
                    duration_ms: Some(1000),
                    cover: Some("https://music.163.com/x.jpg?sig=abc".into()),
                }],
            }],
            favorites: vec![],
            settings: Default::default(),
            scan_roots: vec![],
        };
        let report = restore(&db, &file).await.expect("界内的备份该能恢复");
        assert_eq!(report.playlists_created, 1);
        assert_eq!(report.tracks_added, 1);
        db.close().await;
    }

    /// m3u 的字节闸门：行数不单独设限（一行至少一个字符，字节闸已经夹住了），
    /// 歌单名同样过长度闸。
    #[tokio::test]
    async fn m3u_import_rejects_oversize_content_and_name() {
        use crate::limits as L;
        let db = pool().await;
        // 一行 9 字节，所以要除 9 才能真越过上限（第一版按 11 算，构造出来的
        // 载荷其实还没越界，测试于是慢吞吞地真去导入了 70 万行）。
        let huge = format!("#EXTM3U\n{}", "/m/x.mp3\n".repeat(L::MAX_M3U_BYTES / 9 + 8));
        assert!(huge.len() > L::MAX_M3U_BYTES, "夹具本身要真的越过上限");
        assert!(
            import_m3u(&db, "太大", &huge).await.is_err(),
            "超过字节上限的 m3u 要拒绝"
        );
        assert!(
            crate::list_playlists(&db).await.unwrap().is_empty(),
            "拒绝就不该建歌单"
        );
        let long_name = "名".repeat(L::MAX_NAME_CHARS + 1);
        assert!(
            import_m3u(&db, &long_name, "#EXTM3U\n/m/a.mp3\n")
                .await
                .is_err(),
            "歌单名超长要拒绝"
        );
        assert!(crate::list_playlists(&db).await.unwrap().is_empty());
        db.close().await;
    }

    #[tokio::test]
    async fn m3u_round_trip_matches_by_path_and_reports_skips() {
        let db = pool().await;
        crate::upsert_track(&db, &sample_track("m1", "M One", None))
            .await
            .unwrap();
        let playlist = new_playlist(&db, "M3U 源").await;
        crate::playlists::add_tracks(&db, &playlist, &["m1".into(), "online:netease:1".into()])
            .await
            .unwrap();

        let m3u = export_m3u(&db, &playlist).await.unwrap().unwrap();
        assert!(m3u.starts_with("#EXTM3U"));
        assert!(m3u.contains("#EXTINF:-1,M One"));
        // 在线条目没有本地路径，不输出。
        assert_eq!(m3u.matches("/m/").count(), 1);

        // 追加一行不存在的路径：导入应计入 skipped。
        let m3u_with_miss = format!(
            "{m3u}/nowhere/missing.mp3
"
        );
        let (new_id, added, skipped) = import_m3u(&db, "M3U 导入", &m3u_with_miss)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(added, 1);
        assert_eq!(skipped, 1, "未命中的路径计数 skipped");
        let ids = crate::get_playlist_track_ids(&db, &new_id).await.unwrap();
        assert_eq!(ids, vec!["m1".to_string()]);

        // 不是 M3U 的文本拒绝导入。
        assert!(import_m3u(&db, "x", "随便一段话").await.unwrap().is_none());
        db.close().await;
    }

    async fn new_playlist(db: &SqlitePool, name: &str) -> String {
        crate::playlists::create(db, name).await.unwrap().id
    }

    fn sample_track(id: &str, title: &str, artist: Option<&str>) -> vmusic_core::Track {
        vmusic_core::Track {
            id: id.into(),
            path: format!("/m/{id}.mp3"),
            source: vmusic_core::TrackSource::Local,
            title: title.into(),
            artist: artist.map(Into::into),
            album: None,
            duration_ms: None,
            bitrate: None,
            sample_rate: None,
            channels: None,
            has_cover: false,
            file_mtime: None,
            file_size: None,
            added_at: 0,
        }
    }
}
