// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

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
        let (items, total) = list_filtered(&pool, None, Some("netease"), 50, 0).await.unwrap();
        assert_eq!((items.len(), total), (1, 1));
        assert_eq!(items[0].source, "netease");
        // 搜索命中标题
        let (_, total) = list_filtered(&pool, Some("本地"), None, 50, 0).await.unwrap();
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
        assert_eq!(list_filtered(&pool, None, None, 10, 0).await.unwrap().0.len(), 0);
        upsert(&pool, entry(8)).await.unwrap();
        assert!(clear(&pool).await.unwrap() >= 1);
    }
}
