// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

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
use sqlx::SqlitePool;
use vmusic_core::StoreError;

use crate::now_ms;

pub const BACKUP_VERSION: i64 = 1;

#[derive(Debug, Deserialize)]
pub struct BackupFile {
    pub version: i64,
    #[serde(default)]
    pub playlists: Vec<BackupPlaylist>,
    #[serde(default)]
    pub favorites: Vec<BackupFavorite>,
    #[serde(default)]
    pub settings: std::collections::BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub scan_roots: Vec<BackupScanRoot>,
}

#[derive(Debug, Deserialize)]
pub struct BackupPlaylist {
    pub name: String,
    #[serde(default)]
    pub tracks: Vec<BackupPlaylistTrack>,
}

#[derive(Debug, Default, Deserialize)]
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

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
pub struct BackupScanRoot {
    pub path: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, serde::Serialize)]
pub struct ExportedBackup {
    pub version: i64,
    pub exported_at: i64,
    pub playlists: Vec<ExportedPlaylist>,
    pub favorites: Vec<ExportedFavorite>,
    pub settings: std::collections::BTreeMap<String, serde_json::Value>,
    pub scan_roots: Vec<(String, bool)>,
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
    let playlists: Vec<(String, String)> = sqlx::query_as(
        "SELECT p.name, pt.track_id FROM playlists p
         LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
         ORDER BY p.created_at, pt.position",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;

    type SnapRow = (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    );
    let snaps: Vec<SnapRow> = sqlx::query_as(
            "SELECT track_id, source, title, artist, album, duration_ms, cover FROM playlist_tracks",
        )
        .fetch_all(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    type SnapVals = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    );
    let snap_by_id: std::collections::HashMap<String, SnapVals> = snaps
        .into_iter()
        .map(|(id, source, title, artist, album, dur, cover)| {
            (id, (source, title, artist, album, dur, cover))
        })
        .collect();

    let mut exported: Vec<ExportedPlaylist> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (name, track_id) in playlists {
        let pos = match index.get(&name) {
            Some(&pos) => pos,
            None => {
                exported.push(ExportedPlaylist {
                    name: name.clone(),
                    tracks: Vec::new(),
                });
                index.insert(name.clone(), exported.len() - 1);
                exported.len() - 1
            }
        };
        let (source, title, artist, album, duration_ms, cover) =
            snap_by_id.get(&track_id).cloned().unwrap_or_default();
        exported[pos].tracks.push(ExportedTrack {
            track_id,
            source,
            title,
            artist,
            album,
            duration_ms,
            cover,
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
        .fetch_all(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    let favorites = rows
        .into_iter()
        .map(|(kind, source, ref_id, title, artist, album, duration_ms, cover)| {
            ExportedFavorite {
                kind,
                source,
                ref_id,
                title,
                artist,
                album,
                duration_ms,
                cover,
            }
        })
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
        crate::settings::get_all(pool)
            .await?
            .into_iter()
            .filter(|(key, _)| {
                !SECRET_PREFIXES
                    .iter()
                    .any(|prefix| key.starts_with(prefix))
            })
            .collect();
    let roots: Vec<(String, i64)> =
        sqlx::query_as("SELECT path, enabled FROM scan_roots ORDER BY path")
            .fetch_all(pool)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;

    Ok(ExportedBackup {
        version: BACKUP_VERSION,
        exported_at: now_ms(),
        playlists: exported,
        favorites,
        settings,
        scan_roots: roots.into_iter().map(|(p, e)| (p, e != 0)).collect(),
    })
}

#[derive(Debug, Default, serde::Serialize)]
pub struct RestoreReport {
    pub playlists_created: u64,
    pub playlists_merged: u64,
    pub tracks_added: u64,
    pub favorites_added: u64,
    pub settings_applied: u64,
    pub roots_applied: u64,
}

/// 恢复：校验版本与必需字段，单个事务写入，任何失败整体回滚。
pub async fn restore(pool: &SqlitePool, file: &BackupFile) -> Result<RestoreReport, StoreError> {
    if file.version != BACKUP_VERSION {
        return Err(StoreError::Database(format!(
            "不支持的备份版本 {}（当前支持 {}）",
            file.version, BACKUP_VERSION
        )));
    }
    // 曲目 id 不做存在性校验：备份可能跨机器恢复，曲目尚未扫描是合法状态。
    for playlist in &file.playlists {
        if playlist.name.trim().is_empty() {
            return Err(StoreError::Database("歌单名不能为空".into()));
        }
        for track in &playlist.tracks {
            if track.track_id.trim().is_empty() {
                return Err(StoreError::Database(format!(
                    "歌单「{}」里存在没有 id 的曲目",
                    playlist.name
                )));
            }
        }
    }
    for favorite in &file.favorites {
        if favorite.ref_id.trim().is_empty() || favorite.title.trim().is_empty() {
            return Err(StoreError::Database("收藏缺少 ref_id 或 title".into()));
        }
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
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(key)
        .bind(value.to_string())
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
        out.push_str(&format!("#EXTINF:-1,{}\n{path}\n", title.unwrap_or_default()));
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
    sqlx::query(
        "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
    )
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

    #[tokio::test]
    async fn restore_is_idempotent_and_rejects_unknown_version() {
        let db = pool().await;
        crate::upsert_track(&db, &sample_track("t1", "A", Some("X"))).await.unwrap();
        crate::favorites::add(
            &db,
            vmusic_core::FavoriteKind::Track,
            "local",
            "t1",
            &crate::favorites::FavoriteMeta { title: "A".into(), ..Default::default() },
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

    #[tokio::test]
    async fn export_never_contains_credential_keys() {
        let db = pool().await;
        // 模拟钥匙串迁移失败：凭据明文键还留在 settings 里。
        use serde_json::Value;
        let mut rows: Vec<(String, Value)> = Vec::new();
        rows.push(("online_cred_netease".into(), serde_json::json!({"cookie": "MUSIC_U=secret"})));
        rows.push(("online_cookie_kugou".into(), Value::String("kgmid=old".into())));
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

    #[tokio::test]
    async fn m3u_round_trip_matches_by_path_and_reports_skips() {
        let db = pool().await;
        crate::upsert_track(&db, &sample_track("m1", "M One", None)).await.unwrap();
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
        let m3u_with_miss = format!("{m3u}/nowhere/missing.mp3
");
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
