// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 公开点播播客：节目目录、RSS 与持久化单集身份；播放沿用 online 的下载器。

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{bad_request, ApiError, ApiResult};
use crate::online::{self, OnlineTrack};

mod network;
mod parse;
mod store;

pub use network::public_client;
pub(crate) use network::public_url;
use parse::parse_feed;
use store::persist_feed;

const MAX_FEED_BYTES: usize = 16 * 1024 * 1024;
const MAX_XML_NODES: u32 = 200_000;
const MAX_EPISODES: usize = 2_000;
const MAX_DESCRIPTION_CHARS: usize = 4_000;
const SEARCH_CACHE_CAP: usize = 64;
const CACHE_TTL_SECS: u64 = 15 * 60;
// 已保存直链的可选刷新仅占外层 online::stream 共同 20s 预算的一小部分。
const STREAM_REFRESH_BUDGET: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Show {
    pub id: String,
    pub title: String,
    pub author: String,
    pub description: String,
    pub cover: Option<String>,
    pub feed_url: String,
    pub episode_count: usize,
    pub subscribed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Episode {
    #[serde(flatten)]
    pub track: OnlineTrack,
    pub published_at: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub query: String,
    pub shows: Vec<Show>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedPage {
    pub show: Show,
    pub episodes: Vec<Episode>,
    pub total: usize,
    pub episode_limit: usize,
}

#[derive(Debug)]
struct ParsedFeed {
    show: Show,
    episodes: Vec<ParsedEpisode>,
}

#[derive(Debug)]
struct ParsedEpisode {
    episode: Episode,
    identity: String,
    enclosure_url: String,
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

/// Apple 公开节目目录没有 offset/全目录总量契约；这里仅返回本次命中的节目。
pub async fn search(ctx: &online::Ctx, query: &str, limit: usize) -> ApiResult<SearchResult> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 120 {
        return Err(bad_request("请输入 1–120 个字符的节目名称").with_source("podcast"));
    }
    let limit = limit.clamp(1, 50);
    let key = format!("{}:{limit}", query.to_lowercase());
    static CACHE: OnceLock<Mutex<SearchCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(SearchCache::default()));
    let cached = cache
        .lock()
        .map_err(|_| crate::error::internal("播客搜索缓存不可用"))?
        .get(&key, Instant::now());
    let mut shows = if let Some(shows) = cached {
        shows
    } else {
        let mut url = public_url("https://itunes.apple.com/search")?;
        url.query_pairs_mut()
            .append_pair("term", query)
            .append_pair("country", "CN")
            .append_pair("media", "podcast")
            .append_pair("entity", "podcast")
            .append_pair("limit", &limit.to_string());
        let response = public_client()?
            .get(url)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(network::request_error)?;
        let bytes = network::read_bounded(response, 2 * 1024 * 1024, || {
            ApiError::upstream_rejected("播客目录响应超过 2 MiB 上限").with_source("podcast")
        })
        .await?;
        let value = serde_json::from_slice(&bytes).map_err(|_| {
            ApiError::upstream_rejected("播客目录返回了无效数据").with_source("podcast")
        })?;
        let mut shows = directory_shows(value)?;
        shows.truncate(limit);
        cache
            .lock()
            .map_err(|_| crate::error::internal("播客搜索缓存不可用"))?
            .insert(key, shows.clone(), Instant::now());
        shows
    };
    // 订阅态始终来自当前数据库，不随目录 TTL 缓存。
    let subscribed: HashSet<_> = subscriptions(ctx)
        .await?
        .into_iter()
        .map(|s| s.id)
        .collect();
    for show in &mut shows {
        show.subscribed = subscribed.contains(&show.id);
    }
    Ok(SearchResult {
        query: query.into(),
        shows,
    })
}

pub async fn feed(
    ctx: &online::Ctx,
    url: &str,
    offset: usize,
    limit: usize,
    refresh: bool,
) -> ApiResult<FeedPage> {
    let url = public_url(url)?;
    let saved = store::find_show(ctx, url.as_str()).await?;
    let fresh = saved
        .as_ref()
        .is_some_and(|s| unix_now().saturating_sub(s.fetched_at) < CACHE_TTL_SECS as i64);
    if refresh || !fresh {
        let response = public_client()?
            .get(url.clone())
            .header(
                reqwest::header::ACCEPT,
                "application/rss+xml, application/atom+xml, application/xml, text/xml",
            )
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(network::request_error)?;
        let document_url = response.url().clone();
        let bytes = network::read_bounded(response, MAX_FEED_BYTES, parse::feed_too_large).await?;
        let identity_url = url.clone();
        let parsed =
            tokio::task::spawn_blocking(move || parse_feed(&identity_url, &document_url, &bytes))
                .await
                .map_err(|_| crate::error::internal("播客解析任务失败").with_source("podcast"))??;
        persist_feed(ctx, &parsed).await?;
    }
    store::begin_page(ctx, url.as_str())
        .await?
        .finish(offset, limit)
        .await
}

pub async fn subscriptions(ctx: &online::Ctx) -> ApiResult<Vec<Show>> {
    store::subscribed_shows(ctx).await
}

pub async fn subscribe(ctx: &online::Ctx, feed_url: &str) -> ApiResult<Show> {
    let mut show = feed(ctx, feed_url, 0, 1, false).await?.show;
    store::set_subscribed(ctx, &show.id, true).await?;
    show.subscribed = true;
    Ok(show)
}

pub async fn unsubscribe(ctx: &online::Ctx, show_id: &str) -> ApiResult<()> {
    store::set_subscribed(ctx, show_id, false).await
}

pub async fn episode_detail(ctx: &online::Ctx, id: &str) -> ApiResult<online::OnlineDetail> {
    let track = store::get_episode(ctx, id).await?.episode().track;
    Ok(online::OnlineDetail {
        source: track.source,
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration_ms: track.duration_ms,
        cover: track.cover,
    })
}

pub async fn episode_stream(ctx: &online::Ctx, id: &str) -> ApiResult<online::StreamInfo> {
    let row = store::get_episode(ctx, id).await?;
    let feed_url = row.feed_url.clone();
    stream_from_saved(ctx, id, row, feed(ctx, &feed_url, 0, 1, true)).await
}

async fn stream_from_saved<F>(
    ctx: &online::Ctx,
    id: &str,
    mut row: store::EpisodeRow,
    refresh: F,
) -> ApiResult<online::StreamInfo>
where
    F: std::future::Future<Output = ApiResult<FeedPage>>,
{
    // RSS 中的签名 URL 可变；按节目 TTL 刷新身份映射，刷新失败仍保留已保存的公开直链。
    if unix_now().saturating_sub(row.fetched_at) >= CACHE_TTL_SECS as i64 {
        match tokio::time::timeout(STREAM_REFRESH_BUDGET, refresh).await {
            Ok(Ok(_)) => row = store::get_episode(ctx, id).await?,
            Ok(Err(error)) => tracing::debug!(
                code = error.code,
                "podcast refresh failed; using saved episode"
            ),
            Err(_) => tracing::debug!("podcast optional refresh timed out; using saved episode"),
        }
    }
    let url = public_url(&row.enclosure_url)?;
    Ok(online::StreamInfo {
        url: url.into(),
        source: "podcast".into(),
        id: id.into(),
        bitrate: None,
        expires_in_secs: None,
        fallbacks: Vec::new(),
        rg_gain_db: None,
        rg_peak: None,
    })
}

fn directory_shows(value: serde_json::Value) -> ApiResult<Vec<Show>> {
    let rows = value
        .get("results")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            ApiError::upstream_rejected("播客目录未返回节目列表").with_source("podcast")
        })?;
    let mut seen = HashSet::new();
    Ok(rows
        .iter()
        .take(200)
        .filter_map(|row| {
            let url = public_url(row.get("feedUrl")?.as_str()?).ok()?;
            let id = parse::show_id(&url);
            if !seen.insert(id.clone()) {
                return None;
            }
            let title = row
                .get("collectionName")
                .or_else(|| row.get("trackName"))?
                .as_str()?;
            let title = parse::plain_text(title, 512);
            if title.is_empty() {
                return None;
            }
            let author = parse::plain_text(
                row.get("artistName").and_then(|v| v.as_str()).unwrap_or(""),
                256,
            );
            let cover = row
                .get("artworkUrl600")
                .or_else(|| row.get("artworkUrl100"))
                .and_then(|v| v.as_str())
                .and_then(|s| public_url(s).ok())
                .map(|u| u.to_string());
            Some(Show {
                id,
                title,
                author,
                description: String::new(),
                cover,
                feed_url: url.to_string(),
                episode_count: row
                    .get("trackCount")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0)
                    .min(usize::MAX as u64) as usize,
                subscribed: false,
            })
        })
        .collect())
}

#[derive(Default)]
struct SearchCache {
    entries: HashMap<String, (Instant, Vec<Show>)>,
}

impl SearchCache {
    fn insert(&mut self, key: String, shows: Vec<Show>, now: Instant) {
        self.entries
            .retain(|_, (at, _)| now.saturating_duration_since(*at).as_secs() < CACHE_TTL_SECS);
        if self.entries.len() >= SEARCH_CACHE_CAP && !self.entries.contains_key(&key) {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(key, (now, shows));
    }
    fn get(&mut self, key: &str, now: Instant) -> Option<Vec<Show>> {
        let (at, shows) = self.entries.get(key)?;
        if now.saturating_duration_since(*at).as_secs() < CACHE_TTL_SECS {
            Some(shows.clone())
        } else {
            self.entries.remove(key);
            None
        }
    }
    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests;
