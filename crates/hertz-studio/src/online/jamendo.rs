// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Jamendo 音源。
//!
//! CC 授权曲库，官方公开文档化 API（v3.0，非商用免费），与 CCmixter 同属
//! 「能合法播放」的曲库。接口无反爬、无防盗链，直链就是普通 mp3。
//!
//! ## client_id
//!
//! Jamendo 按 application 发 client_id（在 https://devportal.jamendo.com
//! 免费注册）。本项目不为用户内置任何应用的 id，用户拿到自己的 id 后经
//! 通用设置端点写入 settings 键 [`CLIENT_ID_KEY`] 即可。未配置时本源从
//! `/v1/online/sources` 列表整体隐藏（[`super::list_sources`] 与聚合搜索
//! 都会跳过），直接调用搜索会得到带注册指引的 400——列表里不该出现一个
//! 点了必报错的源。
//!
//! ## 信任边界
//!
//! 曲目 id 必须是纯数字（Jamendo 的 id 语义）；取流不信任搜索结果带回的
//! URL，而是按 id 现查一次 API 拿 `audio` 直链——客户端传什么 id 我们就
//! 查什么 id，任意 URL 注入没有入口。字段名对照官方文档（aegis 证据 §6）。

use super::{
    bad_request, client, const_url, ApiError, ApiResult, Ctx, OnlineDetail, OnlineTrack,
    SearchPage, SearchPagination, SearchQuery, StreamInfo,
};

pub const ID: &str = "jamendo";
/// settings 表里存 Jamendo client_id 的键（PUT /v1/settings 写入）。
pub const CLIENT_ID_KEY: &str = "jamendo_client_id";
const API: &str = "https://api.jamendo.com/v3.0/tracks/";

fn internal_store(e: vmusic_core::StoreError) -> ApiError {
    ApiError::internal(e.to_string())
}

/// 列表、聚合搜索与推荐状态共同使用的可用性规则。
pub(super) async fn ready(ctx: &Ctx) -> bool {
    matches!(
        vmusic_store::settings::get(&ctx.db, CLIENT_ID_KEY).await,
        Ok(Some(v)) if v.as_str().is_some_and(|s| !s.trim().is_empty())
    )
}

/// 读 client_id；未配置时报带注册指引的 400。
async fn client_id(ctx: &Ctx) -> ApiResult<String> {
    let v = vmusic_store::settings::get(&ctx.db, CLIENT_ID_KEY)
        .await
        .map_err(internal_store)?;
    let s = v
        .as_ref()
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    if s.is_empty() {
        return Err(bad_request(
            "尚未配置 Jamendo：在 https://devportal.jamendo.com 免费注册应用取得 \
             client_id，然后 PUT /v1/settings 写入键 jamendo_client_id",
        ));
    }
    Ok(s.to_string())
}

/// Jamendo 的曲目 id 是纯数字；客户端回传的 id 在这里过闸。
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) && id.len() <= 20
}

fn tracks_url(cid: &str, extra: &[(&str, String)]) -> ApiResult<reqwest::Url> {
    let mut url = const_url(API)?;
    {
        let mut p = url.query_pairs_mut();
        p.append_pair("client_id", cid)
            .append_pair("format", "json")
            .append_pair("audioformat", "mp32")
            .append_pair("type", "albumtrack+single");
        for (k, v) in extra {
            p.append_pair(k, v);
        }
    }
    Ok(url)
}

/// All track operations include both singles and album tracks.
async fn tracks_call(
    ctx: &Ctx,
    extra: &[(&str, String)],
) -> ApiResult<(serde_json::Value, Vec<serde_json::Value>)> {
    let url = tracks_url(&client_id(ctx).await?, extra)?;
    let body = super::http::get_json(&client()?, url.as_str(), Default::default()).await?;
    let status = body
        .pointer("/headers/status")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if status != "success" {
        let msg = body
            .pointer("/headers/error_message")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(ApiError::upstream_rejected(format!(
            "Jamendo 返回失败: {msg}"
        )));
    }
    let results = body
        .get("results")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| ApiError::upstream_rejected("Jamendo 响应缺少曲目列表"))?;
    Ok((body, results))
}

pub async fn search(ctx: &Ctx, q: &SearchQuery) -> ApiResult<SearchPage> {
    let term = q.q.clone().unwrap_or_default();
    let term = term.trim();
    if term.is_empty() {
        // 分类 chips 在界面上对这个音源是隐藏的（SOURCES 里 cats 为空），
        // 走到这里只可能是直接构造了请求。
        return Err(bad_request("Jamendo 只支持关键词检索，请输入歌名或歌手"));
    }

    let limit = q.limit.clamp(1, 50);
    let offset = q.offset.min(1000);
    let (body, results) = tracks_call(
        ctx,
        &[
            ("search", term.to_string()),
            ("limit", limit.to_string()),
            ("offset", offset.to_string()),
            ("fullcount", "true".to_string()),
        ],
    )
    .await?;

    let tracks: Vec<OnlineTrack> = results.iter().filter_map(map_track).collect();
    let total = body
        .pointer("/headers/results_fullcount")
        .and_then(|v| v.as_u64())
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or(offset + results.len());
    let next_offset = offset + results.len();

    Ok(SearchPage {
        source: ID.into(),
        keyword: term.to_string(),
        total,
        tracks,
        warning: body
            .pointer("/headers/warnings")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string),
        pagination: Some(SearchPagination {
            next_offset,
            has_more: results.len() >= limit
                && next_offset <= 1000
                && body
                    .pointer("/headers/results_fullcount")
                    .and_then(|v| v.as_u64())
                    .is_none_or(|count| (next_offset as u64) < count),
        }),
    })
}

/// 折一条 result 成曲目。Jamendo 无会员概念，vip_only 恒 false；
/// playable 看 audio 直链是否真的返回了（个别下架曲目字段为空）。
fn map_track(item: &serde_json::Value) -> Option<OnlineTrack> {
    // id 文档示例是字符串形态，数字形态也容忍（折成十进制串）。
    let id = match item.get("id") {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
        Some(serde_json::Value::Number(n)) if !n.to_string().is_empty() => n.to_string(),
        _ => return None,
    };
    if !valid_id(&id) {
        return None;
    }

    let title = item
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("未知曲目")
        .to_string();
    let artist = item
        .get("artist_name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("未知艺术家")
        .to_string();
    let album = item
        .get("album_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let duration_ms = item
        .get("duration")
        .and_then(|v| {
            v.as_str()
                .and_then(|s| s.trim().parse::<u64>().ok())
                .or_else(|| v.as_u64())
        })
        .unwrap_or(0)
        .saturating_mul(1000);
    let cover = ["image", "album_image"]
        .iter()
        .find_map(|key| {
            item.get(key)
                .and_then(|v| v.as_str())
                .filter(|s| http_url(s))
        })
        .map(str::to_string);
    let audio = item
        .get("audio")
        .and_then(|v| v.as_str())
        .is_some_and(http_url);

    Some(OnlineTrack {
        source: ID.into(),
        id: id.clone(),
        title,
        artist,
        album,
        duration_ms,
        cover,
        playable: audio,
        vip_only: false,
        track_ref: serde_json::json!({
            "license_url": item.get("license_ccurl").and_then(|v| v.as_str()),
            "webpage_url": item.get("shareurl").and_then(|v| v.as_str())
                .map(str::to_string).unwrap_or_else(|| format!("https://www.jamendo.com/track/{id}")),
        }),
    })
}

fn http_url(raw: &str) -> bool {
    reqwest::Url::parse(raw)
        .is_ok_and(|url| matches!(url.scheme(), "https" | "http") && url.host_str().is_some())
}

/// 取流：按 id 现查直链，不信任客户端带来的 URL。
pub async fn stream(ctx: &Ctx, id: &str, _quality: u32) -> ApiResult<StreamInfo> {
    let id = id.trim();
    if !valid_id(id) {
        return Err(bad_request("Jamendo 的曲目 id 必须是纯数字"));
    }
    let (_, results) = tracks_call(ctx, &[("id", id.to_string())]).await?;
    let audio = results
        .iter()
        .find(|t| map_track(t).is_some_and(|track| track.id == id))
        .and_then(|t| t.get("audio"))
        .and_then(|v| v.as_str())
        .filter(|s| http_url(s))
        .ok_or_else(|| {
            ApiError::upstream_rejected("Jamendo 未返回该曲目的音频地址（可能已下架）")
        })?;
    Ok(StreamInfo {
        url: audio.to_string(),
        source: ID.into(),
        id: id.to_string(),
        bitrate: None,
        expires_in_secs: None,
        fallbacks: Vec::new(),
        rg_gain_db: None,
        rg_peak: None,
    })
}

/// 单曲详情与取流同一条按 id 现查的路。
pub async fn detail(ctx: &Ctx, id: &str) -> ApiResult<OnlineDetail> {
    let id = id.trim();
    if !valid_id(id) {
        return Err(bad_request("Jamendo 的曲目 id 必须是纯数字"));
    }
    let (_, results) = tracks_call(ctx, &[("id", id.to_string())]).await?;
    let t = results
        .iter()
        .filter_map(map_track)
        .find(|t| t.id == id)
        .ok_or_else(|| ApiError::upstream_rejected("Jamendo 未找到该曲目（可能已下架）"))?;
    Ok(OnlineDetail {
        source: t.source,
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration_ms: t.duration_ms,
        cover: t.cover,
    })
}

/// 站内没有歌词，返回空文档而不是错误——前端的占位文案比一条红 toast 准。
pub async fn lyric(_ctx: &Ctx, _id: &str) -> ApiResult<vmusic_core::LyricDocument> {
    Ok(vmusic_core::LyricDocument::empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../tests/fixtures/jamendo_search.json")).unwrap()
    }

    #[test]
    fn search_and_lookup_keep_the_same_catalog_and_encode_user_input() {
        for extra in [
            vec![("search", "piano & guitar 中文".to_string())],
            vec![("id", "42".to_string())],
        ] {
            let url = tracks_url("my-app", &extra).unwrap();
            let params: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
            assert_eq!(url.path(), "/v3.0/tracks/");
            assert_eq!(params["type"], "albumtrack+single");
            assert_eq!(params["audioformat"], "mp32");
            assert_eq!(params["client_id"], "my-app");
            assert_eq!(params[extra[0].0], extra[0].1);
            assert_eq!(params.len(), 5);
        }
    }

    #[test]
    fn fixture_normalizes_search_results() {
        let body = fixture();
        let results = body.get("results").and_then(|v| v.as_array()).unwrap();
        let tracks: Vec<OnlineTrack> = results.iter().filter_map(map_track).collect();
        assert_eq!(tracks.len(), 2);
        let first = &tracks[0];
        assert_eq!(first.source, "jamendo");
        assert_eq!(first.id, "1176055");
        assert_eq!(first.title, "Yes I Do");
        assert_eq!(first.artist, "Room 94");
        assert_eq!(first.album, "Lost Boy");
        assert_eq!(first.duration_ms, 196_000);
        assert!(first.playable);
        // Jamendo 是 CC 曲库，不存在会员曲。
        assert!(!first.vip_only);
        assert_eq!(
            first.cover.as_deref(),
            Some("https://usercontent.jamendo.com?type=album&id=13152&width=300")
        );
        // 第二条：无专辑（单曲形态）、无封面、audio 缺失 → 不可播。
        let second = &tracks[1];
        assert_eq!(second.album, "");
        assert!(second.cover.is_none());
        assert!(!second.playable);
    }

    #[test]
    fn ids_must_be_plain_digits() {
        assert!(valid_id("1176055"));
        assert!(!valid_id(""));
        assert!(!valid_id(" 1176055"));
        assert!(!valid_id("abc"));
        assert!(!valid_id("1/../../etc"));
        assert!(!valid_id("http://169.254.169.254/"));
        assert!(!valid_id(&"1".repeat(21)));
    }

    #[test]
    fn results_without_an_id_are_dropped() {
        assert!(map_track(&serde_json::json!({"name": "x"})).is_none());
        // 数字形态的 id 也能折（上游文档两态都出现过）。
        let t = map_track(&serde_json::json!({"id": 42, "name": "n"})).unwrap();
        assert_eq!(t.id, "42");
    }

    #[test]
    fn attribution_is_preserved_and_empty_album_cover_uses_track_image() {
        let mut item = fixture()["results"][0].clone();
        item["album_image"] = serde_json::json!("");
        item["image"] = serde_json::json!("https://usercontent.jamendo.com/track.jpg");
        item["shareurl"] = serde_json::json!("https://www.jamendo.com/track/1176055");
        let t = map_track(&item).unwrap();
        assert_eq!(
            t.cover.as_deref(),
            Some("https://usercontent.jamendo.com/track.jpg")
        );
        assert_eq!(t.track_ref["license_url"], item["license_ccurl"]);
        assert_eq!(t.track_ref["webpage_url"], item["shareurl"]);
    }

    #[test]
    fn malformed_ids_and_non_http_audio_are_not_playable() {
        for id in [
            serde_json::json!("abc"),
            serde_json::json!(-5),
            serde_json::json!(1.5),
        ] {
            assert!(map_track(&serde_json::json!({"id": id})).is_none());
        }
        let t = map_track(&serde_json::json!({"id": "42", "audio": "httpnot-a-url"})).unwrap();
        assert!(!t.playable);
    }

    #[tokio::test]
    async fn missing_client_id_gives_a_registration_hint() {
        let dir = std::env::temp_dir().join(format!("vmusic-jam-test-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let ctx = Ctx::new(db);

        let err = client_id(&ctx).await.unwrap_err();
        assert_eq!(err.status, 400);
        assert!(err.message.contains("devportal.jamendo.com"));
        assert!(err.message.contains(CLIENT_ID_KEY));

        vmusic_store::settings::set(&ctx.db, CLIENT_ID_KEY, &serde_json::json!(" cid-9 "))
            .await
            .unwrap();
        // 空白容忍、去尾随空格。
        assert_eq!(client_id(&ctx).await.unwrap(), "cid-9");

        ctx.db.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
