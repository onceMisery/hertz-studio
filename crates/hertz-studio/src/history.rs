// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 播放历史：upsert 置顶、上限截断、查询与删除。

use serde::Serialize;
use sqlx::SqlitePool;

/// 历史保留条数。超出后删最旧。
pub const HISTORY_LIMIT: i64 = 500;

/// 写入一条历史所需的信息。
#[derive(Debug, Clone)]
pub struct HistoryEntry<'a> {
    /// 本地曲目 id，或 `online:{source}:{ref_id}`。
    pub track_id: &'a str,
    /// `local` / `netease` / `qq` / `kugou` / ...
    pub source: &'a str,
    pub ref_id: &'a str,
    pub title: &'a str,
    pub artist: Option<&'a str>,
    pub album: Option<&'a str>,
    pub cover_url: Option<&'a str>,
    pub duration_ms: Option<u64>,
}

/// 读出形状（驼峰序列化，前端直接消费）。
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct HistoryItem {
    pub id: i64,
    pub track_id: String,
    pub source: String,
    pub ref_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover_url: Option<String>,
    pub duration_ms: Option<i64>,
    pub played_at: i64,
}

/// 插入或把同一曲目顶到最前，然后截断到 [`HISTORY_LIMIT`]。
pub async fn upsert(pool: &SqlitePool, e: HistoryEntry<'_>) -> Result<(), String> {
    let now = vmusic_store::now_ms();
    sqlx::query(
        r#"INSERT INTO play_history
             (track_id, source, ref_id, title, artist, album, cover_url, duration_ms, played_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT(track_id) DO UPDATE SET
             source=excluded.source, ref_id=excluded.ref_id, title=excluded.title,
             artist=excluded.artist, album=excluded.album, cover_url=excluded.cover_url,
             duration_ms=excluded.duration_ms, played_at=excluded.played_at"#,
    )
    .bind(e.track_id)
    .bind(e.source)
    .bind(e.ref_id)
    .bind(e.title)
    .bind(e.artist)
    .bind(e.album)
    .bind(e.cover_url)
    .bind(e.duration_ms.map(|v| v as i64))
    .bind(now)
    .execute(pool)
    .await
    .map_err(|err| err.to_string())?;

    // 保留最近 N 条：先按偏移定位边界，再双条件删除（OFFSET 不能直接配合 DELETE）。
    sqlx::query(
        r#"DELETE FROM play_history WHERE id NOT IN (
             SELECT id FROM play_history ORDER BY played_at DESC, id DESC LIMIT ?1
           )"#,
    )
    .bind(HISTORY_LIMIT)
    .execute(pool)
    .await
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// 按曲目 id 读单条历史。写历史自愈用：online_meta 缺快照时（重启后恢复
/// 会话起播），把同一首曲上一会话写下的元数据捞回来，不让退化行覆盖好数据。
pub async fn find_by_track(
    pool: &SqlitePool,
    track_id: &str,
) -> Result<Option<HistoryItem>, String> {
    sqlx::query_as::<_, HistoryItem>(
        "SELECT id, track_id, source, ref_id, title, artist, album, cover_url, \
         duration_ms, played_at FROM play_history WHERE track_id = ?1",
    )
    .bind(track_id)
    .fetch_optional(pool)
    .await
    .map_err(|err| err.to_string())
}

/// 退化在线行（元数据缺失、标题退成了平台 id）的来源与 ref。本地行不在列：
/// 它们的 cover_url/duration 本来就是 None，不是退化。
pub async fn list_degraded_online(
    pool: &SqlitePool,
    limit: i64,
) -> Result<Vec<(String, String, String)>, String> {
    sqlx::query_as(
        "SELECT track_id, source, ref_id FROM play_history \
         WHERE source != 'local' AND artist IS NULL AND cover_url IS NULL \
         AND duration_ms IS NULL AND title = ref_id \
         ORDER BY played_at DESC LIMIT ?1",
    )
    .bind(limit.clamp(1, 200))
    .fetch_all(pool)
    .await
    .map_err(|err| err.to_string())
}

/// 只补缺失字段：把退化行修正为真实元数据。行已被并发写成好数据（或已补过）
/// 时 WHERE 不命中，天然无竞争；played_at 不动，历史顺序保持原样。
pub async fn fill_missing(
    pool: &SqlitePool,
    track_id: &str,
    title: &str,
    artist: Option<&str>,
    album: Option<&str>,
    cover_url: Option<&str>,
    duration_ms: Option<u64>,
) -> Result<u64, String> {
    let result = sqlx::query(
        "UPDATE play_history SET title=?2, artist=?3, album=?4, cover_url=?5, duration_ms=?6 \
         WHERE track_id=?1 AND source != 'local' AND artist IS NULL \
         AND cover_url IS NULL AND duration_ms IS NULL AND title=ref_id",
    )
    .bind(track_id)
    .bind(title)
    .bind(artist)
    .bind(album)
    .bind(cover_url)
    .bind(duration_ms.map(|v| v as i64))
    .execute(pool)
    .await
    .map_err(|err| err.to_string())?;
    Ok(result.rows_affected())
}

/// 分页 + 来源筛选 + 标题/歌手/专辑搜索。返回 (条目, 命中总数)。
///
/// 500 条上限之外的旧记录因此可达：UI 用 offset 翻页，不靠单次大查询。
pub async fn list_filtered(
    pool: &SqlitePool,
    query: Option<&str>,
    source: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<(Vec<HistoryItem>, i64), String> {
    let q = query.unwrap_or("").trim();
    let source = source.unwrap_or("").trim();
    let sql = "SELECT id, track_id, source, ref_id, title, artist, album, cover_url, \
               duration_ms, played_at FROM play_history \
               WHERE (?1 = '' OR title LIKE ?2 OR artist LIKE ?2 OR album LIKE ?2) \
               AND (?3 = '' OR source = ?3) \
               ORDER BY played_at DESC, id DESC LIMIT ?4 OFFSET ?5";
    let items = sqlx::query_as::<_, HistoryItem>(sql)
        .bind(q)
        .bind(format!("%{q}%"))
        .bind(source)
        .bind(limit.clamp(1, 200))
        .bind(offset.max(0))
        .fetch_all(pool)
        .await
        .map_err(|err| err.to_string())?;
    let count_sql = "SELECT COUNT(*) FROM play_history \
                     WHERE (?1 = '' OR title LIKE ?2 OR artist LIKE ?2 OR album LIKE ?2) \
                     AND (?3 = '' OR source = ?3)";
    let total: (i64,) = sqlx::query_as(count_sql)
        .bind(q)
        .bind(format!("%{q}%"))
        .bind(source)
        .fetch_one(pool)
        .await
        .map_err(|err| err.to_string())?;
    Ok((items, total.0))
}

pub async fn clear(pool: &SqlitePool) -> Result<u64, String> {
    sqlx::query("DELETE FROM play_history")
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .map_err(|err| err.to_string())
}

pub async fn remove(pool: &SqlitePool, id: i64) -> Result<u64, String> {
    sqlx::query("DELETE FROM play_history WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("vmusic-history-{}", uuid::Uuid::new_v4()));
        vmusic_store::open(&dir).await.expect("open db")
    }

    fn entry(n: u8) -> HistoryEntry<'static> {
        HistoryEntry {
            track_id: Box::leak(format!("online:netease:{n}").into_boxed_str()),
            source: "netease",
            ref_id: Box::leak(format!("id{n}").into_boxed_str()),
            title: Box::leak(format!("歌曲{n}").into_boxed_str()),
            artist: Some("歌手"),
            album: None,
            cover_url: None,
            duration_ms: Some(200_000),
        }
    }

    #[tokio::test]
    async fn find_by_track_and_fill_missing_repair_degraded_rows() {
        let pool = db().await;
        // 退化行：标题 = 平台 id、歌手/封面全空（重启后恢复会话起播写下的那种）。
        let degraded = HistoryEntry {
            track_id: "online:netease:189602",
            source: "netease",
            ref_id: "189602",
            title: "189602",
            artist: None,
            album: None,
            cover_url: None,
            duration_ms: None,
        };
        upsert(&pool, degraded).await.unwrap();
        let mut local = entry(2);
        local.track_id = "local-2";
        local.source = "local";
        local.ref_id = "local-2";
        local.title = "local-2";
        local.artist = None;
        local.duration_ms = None;
        upsert(&pool, local).await.unwrap();

        // 退化行只在在线侧登记，本地行不在此列。
        let pending = list_degraded_online(&pool, 40).await.unwrap();
        assert_eq!(
            pending,
            vec![(
                "online:netease:189602".into(),
                "netease".into(),
                "189602".into()
            )]
        );

        // 自愈读：能按 track_id 找回这一行。
        let old = find_by_track(&pool, "online:netease:189602")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(old.title, "189602");

        // 修复：只补缺失字段。
        let healed = fill_missing(
            &pool,
            "online:netease:189602",
            "真实歌名",
            Some("真实歌手"),
            Some("真实专辑"),
            Some("https://cover"),
            Some(210_000),
        )
        .await
        .unwrap();
        assert_eq!(healed, 1);
        let row = find_by_track(&pool, "online:netease:189602")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.title, "真实歌名");
        assert_eq!(row.artist.as_deref(), Some("真实歌手"));
        assert_eq!(row.cover_url.as_deref(), Some("https://cover"));

        // 已是好数据时不再命中（无竞争、不重复写），本地行也绝不被误改。
        let again = fill_missing(
            &pool,
            "online:netease:189602",
            "另一个名字",
            Some("别人"),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(again, 0);
        assert_eq!(
            find_by_track(&pool, "online:netease:189602")
                .await
                .unwrap()
                .unwrap()
                .title,
            "真实歌名"
        );
        let touched = fill_missing(&pool, "local-2", "本地歌", Some("歌手"), None, None, None)
            .await
            .unwrap();
        assert_eq!(touched, 0);
    }

    #[tokio::test]
    async fn upsert_moves_track_to_top_and_updates_fields() {
        let pool = db().await;
        upsert(&pool, entry(1)).await.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        upsert(&pool, entry(2)).await.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let mut e1 = entry(1);
        e1.title = "歌曲1-改名";
        upsert(&pool, e1).await.unwrap();

        let items = list_filtered(&pool, None, None, 10, 0).await.unwrap().0;
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "歌曲1-改名");
        assert_eq!(items[1].title, "歌曲2");
    }

    #[tokio::test]
    async fn truncates_to_limit() {
        let pool = db().await;
        let total = (HISTORY_LIMIT + 5) as u16;
        for n in 0..total {
            let mut e = entry((n % 250) as u8);
            e.track_id = Box::leak(format!("online:netease:song{n}").into_boxed_str());
            e.ref_id = Box::leak(format!("ref{n}").into_boxed_str());
            upsert(&pool, e).await.unwrap();
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM play_history")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, HISTORY_LIMIT);
    }

    #[tokio::test]
    async fn filtered_listing_supports_pagination_source_and_search() {
        let pool = db().await;
        upsert(&pool, entry(1)).await.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let mut local = entry(2);
        local.track_id = "local-2";
        local.source = "local";
        local.title = "本地歌";
        upsert(&pool, local).await.unwrap();

        // 来源筛选
        let (items, total) = list_filtered(&pool, None, Some("netease"), 50, 0)
            .await
            .unwrap();
        assert_eq!((items.len(), total), (1, 1));
        assert_eq!(items[0].source, "netease");
        // 搜索命中标题
        let (_, total) = list_filtered(&pool, Some("本地"), None, 50, 0)
            .await
            .unwrap();
        assert_eq!(total, 1);
        // 分页：limit 1 offset 1 取第二新的
        let (items, total) = list_filtered(&pool, None, None, 1, 1).await.unwrap();
        assert_eq!(total, 2);
        assert_eq!(items.len(), 1);
    }

    #[tokio::test]
    async fn remove_and_clear_work() {
        let pool = db().await;
        upsert(&pool, entry(9)).await.unwrap();
        let items = list_filtered(&pool, None, None, 10, 0).await.unwrap().0;
        assert_eq!(remove(&pool, items[0].id).await.unwrap(), 1);
        assert_eq!(
            list_filtered(&pool, None, None, 10, 0)
                .await
                .unwrap()
                .0
                .len(),
            0
        );
        upsert(&pool, entry(8)).await.unwrap();
        assert!(clear(&pool).await.unwrap() >= 1);
    }
}
