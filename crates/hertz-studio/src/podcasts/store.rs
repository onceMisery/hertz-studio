// SPDX-License-Identifier: MIT

use sqlx::FromRow;

use super::{unix_now, Episode, FeedPage, ParsedFeed, Show, MAX_EPISODES};
use crate::error::{not_found, ApiError, ApiResult};
use crate::online::{self, OnlineTrack};

#[derive(FromRow)]
pub(super) struct ShowRow {
    id: String,
    feed_url: String,
    title: String,
    author: String,
    description: String,
    cover: Option<String>,
    episode_count: i64,
    subscribed: bool,
    pub fetched_at: i64,
}

impl ShowRow {
    pub fn show(self) -> Show {
        Show {
            id: self.id,
            feed_url: self.feed_url,
            title: self.title,
            author: self.author,
            description: self.description,
            cover: self.cover,
            episode_count: self.episode_count.max(0) as usize,
            subscribed: self.subscribed,
        }
    }
}

#[derive(FromRow)]
pub(super) struct EpisodeRow {
    id: String,
    title: String,
    artist: String,
    album: String,
    duration_ms: i64,
    cover: Option<String>,
    published_at: String,
    description: String,
    pub enclosure_url: String,
    pub feed_url: String,
    pub fetched_at: i64,
}

impl EpisodeRow {
    pub fn episode(self) -> Episode {
        Episode {
            track: OnlineTrack {
                source: "podcast".into(),
                id: self.id,
                title: self.title,
                artist: self.artist,
                album: self.album,
                duration_ms: self.duration_ms.max(0) as u64,
                cover: self.cover,
                playable: true,
                vip_only: false,
                track_ref: serde_json::Value::Null,
            },
            published_at: self.published_at,
            description: self.description,
        }
    }
}

const EPISODE_SELECT: &str = "SELECT e.id, e.title, e.artist, e.album, e.duration_ms, e.cover,
    e.published_at, e.description, e.enclosure_url, s.feed_url, s.fetched_at
    FROM podcast_episodes e JOIN podcast_shows s ON s.id = e.show_id";

pub(super) fn db_error(error: sqlx::Error) -> ApiError {
    let api =
        crate::error::internal("播客数据库操作失败（详情见服务端日志）").with_source("podcast");
    tracing::error!(request_id = %api.request_id, detail = %error, "podcast database error");
    api
}

pub(super) async fn find_show(ctx: &online::Ctx, url: &str) -> ApiResult<Option<ShowRow>> {
    sqlx::query_as::<_, ShowRow>("SELECT * FROM podcast_shows WHERE feed_url = ?")
        .bind(url)
        .fetch_optional(&ctx.db)
        .await
        .map_err(db_error)
}

pub(super) struct PageRead {
    tx: sqlx::Transaction<'static, sqlx::Sqlite>,
    show: Show,
}

pub(super) async fn begin_page(ctx: &online::Ctx, url: &str) -> ApiResult<PageRead> {
    let mut tx = ctx.db.begin().await.map_err(db_error)?;
    // 首次读取固定 SQLite 快照，保证节目总数与随后读取的单集一致。
    let show = sqlx::query_as::<_, ShowRow>("SELECT * FROM podcast_shows WHERE feed_url = ?")
        .bind(url)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?
        .ok_or_else(|| not_found("未找到此播客节目").with_source("podcast"))?
        .show();
    Ok(PageRead { tx, show })
}

impl PageRead {
    pub(super) async fn finish(mut self, offset: usize, limit: usize) -> ApiResult<FeedPage> {
        let episodes = episode_page(&mut self.tx, &self.show.id, limit, offset).await?;
        self.tx.commit().await.map_err(db_error)?;
        Ok(FeedPage {
            total: self.show.episode_count,
            episode_limit: MAX_EPISODES,
            show: self.show,
            episodes,
        })
    }
}

pub(super) async fn get_episode(ctx: &online::Ctx, id: &str) -> ApiResult<EpisodeRow> {
    sqlx::query_as::<_, EpisodeRow>(&format!("{EPISODE_SELECT} WHERE e.id = ?"))
        .bind(id)
        .fetch_optional(&ctx.db)
        .await
        .map_err(db_error)?
        .ok_or_else(|| not_found("未找到此播客单集，请重新打开节目导入").with_source("podcast"))
}

pub(super) async fn episode_page(
    connection: &mut sqlx::SqliteConnection,
    show_id: &str,
    limit: usize,
    offset: usize,
) -> ApiResult<Vec<Episode>> {
    if offset >= MAX_EPISODES {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_as::<_, EpisodeRow>(&format!(
        "{EPISODE_SELECT} WHERE e.show_id = ? AND e.active = 1 ORDER BY e.ordinal, e.id LIMIT ? OFFSET ?"
    ))
    .bind(show_id)
    .bind(limit.clamp(1, 100) as i64)
    .bind(offset as i64)
    .fetch_all(connection)
    .await
    .map_err(db_error)?
    .into_iter()
    .map(EpisodeRow::episode)
    .collect())
}

pub(super) async fn subscribed_shows(ctx: &online::Ctx) -> ApiResult<Vec<Show>> {
    Ok(sqlx::query_as::<_, ShowRow>(
        "SELECT * FROM podcast_shows WHERE subscribed = 1 ORDER BY subscribed_at DESC, title, id",
    )
    .fetch_all(&ctx.db)
    .await
    .map_err(db_error)?
    .into_iter()
    .map(ShowRow::show)
    .collect())
}

pub(super) async fn set_subscribed(ctx: &online::Ctx, id: &str, value: bool) -> ApiResult<()> {
    let result = sqlx::query("UPDATE podcast_shows SET subscribed = ?, subscribed_at = CASE WHEN ? THEN ? ELSE subscribed_at END WHERE id = ?")
        .bind(value).bind(value).bind(unix_now()).bind(id)
        .execute(&ctx.db).await.map_err(db_error)?;
    if result.rows_affected() == 0 {
        return Err(not_found("未找到此播客节目").with_source("podcast"));
    }
    Ok(())
}

pub(super) async fn persist_feed(ctx: &online::Ctx, parsed: &ParsedFeed) -> ApiResult<()> {
    let show = &parsed.show;
    let mut tx = ctx.db.begin().await.map_err(db_error)?;
    sqlx::query("INSERT INTO podcast_shows (id, feed_url, title, author, description, cover, episode_count, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, author=excluded.author,
          description=excluded.description, cover=excluded.cover, episode_count=excluded.episode_count,
          fetched_at=excluded.fetched_at")
        .bind(&show.id).bind(&show.feed_url).bind(&show.title).bind(&show.author)
        .bind(&show.description).bind(&show.cover).bind(parsed.episodes.len().min(MAX_EPISODES) as i64)
        .bind(unix_now()).execute(&mut *tx).await.map_err(db_error)?;
    // 当前 RSS 分页只显示本次内容；旧记录保留，避免已保存的 online:podcast:<id> 失效。
    sqlx::query("UPDATE podcast_episodes SET active = 0 WHERE show_id = ?")
        .bind(&show.id)
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    for (ordinal, item) in parsed.episodes.iter().take(MAX_EPISODES).enumerate() {
        let episode = &item.episode;
        let track = &episode.track;
        sqlx::query("INSERT INTO podcast_episodes
            (id, show_id, identity, enclosure_url, title, artist, album, duration_ms, cover, published_at, description, ordinal, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(id) DO UPDATE SET enclosure_url=excluded.enclosure_url, title=excluded.title,
              artist=excluded.artist, album=excluded.album, duration_ms=excluded.duration_ms,
              cover=excluded.cover, published_at=excluded.published_at, description=excluded.description,
              ordinal=excluded.ordinal, active=1")
            .bind(&track.id).bind(&show.id).bind(&item.identity).bind(&item.enclosure_url)
            .bind(&track.title).bind(&track.artist).bind(&track.album).bind(track.duration_ms.min(i64::MAX as u64) as i64)
            .bind(&track.cover).bind(&episode.published_at).bind(&episode.description).bind(ordinal as i64)
            .execute(&mut *tx).await.map_err(db_error)?;
    }
    tx.commit().await.map_err(db_error)
}
