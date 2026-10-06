// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 咪咕音乐音源。
//!
//! 端点来自咪咕网页/移动 H5（基址 `https://c.musicapp.migu.cn`，2026-10 拿到
//! 的公开接口），**均无需请求签名**，只需一组固定的移动端请求头即可调用：
//!
//!   - 单曲搜索：`/v1.0/content/search_all.do`（`searchSwitch.song=1`）
//!   - 歌单搜索：同一个 search_all.do（`searchSwitch.songList=1`），本音源
//!     参与在线歌单搜索的能力就在这里；
//!   - 单曲详情：`/v1.0/content/resourceinfo.do?copyrightId=&resourceType=2`
//!   - 歌词：详情里的 `lrcUrl` 直链，就是普通 LRC 文本。
//!
//! ## 为什么明确不支持播放
//!
//! 取流端点 `/strategy/listen-url/h5/v2.4` 的响应体是 AES 加密的 hex 密文，
//! 本地无法解析。本项目不碰加密内容（见 `online/mod.rs` 模块文档的边界），
//! 所以这里**绝不解密、绝不伪造一个能播的地址**：搜索结果的 `playable`
//! 一律 false，[`stream`] 直接回显式错误。等平台改为下发明文直链时再放开。
//!
//! ## 其余取舍
//!
//! 搜索结果不带时长（`length` 只在详情里有），所以搜索阶段 `duration_ms` 记 0，
//! 由详情的 `length`（形如 "00:03:02"）折成毫秒补齐。歌单条目上游**没有
//! description 字段**，`OnlinePlaylist.description` 因此恒为 None。

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, USER_AGENT};
use serde_json::Value;

use super::{
    bad_request, client, const_url, https_url, parse_clock_ms, ApiError, ApiResult, Ctx,
    OnlineDetail, OnlinePlaylist, OnlineTrack, PlaylistSearchPage, SearchPage, SearchQuery,
    StreamInfo,
};

pub const ID: &str = "migu";

const SEARCH_URL: &str = "https://c.musicapp.migu.cn/v1.0/content/search_all.do";
const RESOURCE_URL: &str = "https://c.musicapp.migu.cn/v1.0/content/resourceinfo.do";
const REFERER: &str = "https://y.migu.cn/";
/// 咪咕 H5 认移动版 UA；桌面 UA 下 search_all.do 可能返回空结果。
const MOBILE_UA: &str = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 \
                        (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36";
/// 单曲搜索的 searchSwitch。
const SWITCH_SONG: &str = r#"{"song":1,"album":0,"singer":0,"tagSong":1,"mvSong":0,"bestShow":1}"#;
/// 歌单搜索的 searchSwitch。
const SWITCH_SONGLIST: &str = r#"{"song":0,"songList":1}"#;

/// 固定请求头。除了 Referer，还要带上客户端标识；这几枚头名按 HTTP/2 要求
/// 写成小写，语义与真机上的 channel/ua/version/IMEI 一致（HTTP 头名大小写
/// 不敏感）。
fn headers() -> HeaderMap {
    let mut h = super::http::headers(None, Some(REFERER));
    h.insert(USER_AGENT, HeaderValue::from_static(MOBILE_UA));
    h.insert(
        HeaderName::from_static("channel"),
        HeaderValue::from_static("014X031"),
    );
    h.insert(
        HeaderName::from_static("ua"),
        HeaderValue::from_static("Android_migu"),
    );
    h.insert(
        HeaderName::from_static("version"),
        HeaderValue::from_static("6.8.8"),
    );
    h.insert(
        HeaderName::from_static("imei"),
        HeaderValue::from_static("h5page"),
    );
    h
}

/// 上游字段值统一取字符串（同一字段数字/字符串混用是常态）。
fn val_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// 上游计数（musicNum/playNum 等）统一折成 u64；脏数据按未知处理。
fn val_u64(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64)),
        Value::String(s) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

/// 图片列表取封面：优先 imgSizeType=03（大图），再 02，最后退回首张。
fn pick_cover(items: Option<&Value>) -> Option<String> {
    let arr = items?.as_array()?;
    let mut chosen = None;
    for pref in ["03", "02"] {
        if let Some(it) = arr
            .iter()
            .find(|it| it.get("imgSizeType").and_then(|v| v.as_str()) == Some(pref))
        {
            chosen = Some(it);
            break;
        }
    }
    let url = chosen.or_else(|| arr.first())?.get("img")?.as_str()?;
    https_url(url)
}

/// search_all.do 公共请求：文本 / 页码（从 1 起）/ 每页条数 / searchSwitch。
async fn search_all(
    term: &str,
    page_no: usize,
    page_size: usize,
    search_switch: &str,
) -> ApiResult<Value> {
    let mut url = const_url(SEARCH_URL)?;
    {
        let mut p = url.query_pairs_mut();
        p.append_pair("text", term)
            .append_pair("pageNo", &page_no.to_string())
            .append_pair("pageSize", &page_size.to_string())
            .append_pair("isCopyright", "1")
            .append_pair("sort", "1")
            .append_pair("searchSwitch", search_switch);
    }
    super::http::get_json(&client()?, url.as_str(), headers()).await
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

pub async fn search(ctx: &Ctx, q: &SearchQuery) -> ApiResult<SearchPage> {
    let _ = ctx; // 搜索不需要凭据
    let term = q.q.clone().unwrap_or_default();
    let term = term.trim();
    if term.is_empty() {
        // 分类 chips 在界面上对这个音源是隐藏的（SOURCES 里 cats 为空），
        // 走到这里只可能是直接构造了请求。
        return Err(bad_request("咪咕只支持关键词检索，请输入歌名或歌手"));
    }

    let limit = q.limit.clamp(1, 50);
    // pageNo 从 1 起，按 offset/limit 折算。
    let page_no = q.offset / limit + 1;
    let body = search_all(term, page_no, limit, SWITCH_SONG).await?;

    let data = body.get("songResultData");
    let items = data
        .and_then(|d| d.get("result"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let tracks: Vec<OnlineTrack> = items.iter().filter_map(map_track).collect();
    let total = data
        .and_then(|d| d.get("totalCount"))
        .and_then(val_u64)
        .map(|n| n as usize)
        .unwrap_or(tracks.len());

    Ok(SearchPage {
        source: ID.into(),
        keyword: term.to_string(),
        total,
        tracks,
        warning: None,
    })
}

/// 把一条 songResultData.result 折成曲目。id 用 copyrightId（稳定 cid），
/// 取流/详情都按它索引；contentId 一并塞进 track_ref 备用。
///
/// playable 恒 false：见模块文档，取流响应是加密的。这里如实置灰，
/// 不因为「搜索能搜到」就假装这首歌能播。
fn map_track(item: &Value) -> Option<OnlineTrack> {
    let cid = item
        .get("copyrightId")
        .and_then(val_string)
        .filter(|s| !s.trim().is_empty())?;

    let title = item
        .get("name")
        .and_then(val_string)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "未知曲目".into());
    let artist = join_singers(item.get("singers"));
    let album = item
        .get("albums")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|a| a.get("name"))
        .and_then(val_string)
        .unwrap_or_default();
    let cover = pick_cover(item.get("imgItems"));
    let content_id = item
        .get("contentId")
        .and_then(val_string)
        .unwrap_or_default();

    Some(OnlineTrack {
        source: ID.into(),
        id: cid.clone(),
        title,
        artist,
        album,
        // 时长只在详情里（length），搜索阶段如实记 0。
        duration_ms: 0,
        cover,
        playable: false,
        vip_only: false,
        track_ref: serde_json::json!({ "contentId": content_id, "copyrightId": cid }),
    })
}

/// singers:[{id,name}] → "A、B"；空数组/缺字段回落「未知艺术家」。
fn join_singers(singers: Option<&Value>) -> String {
    let names: Vec<String> = singers
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.get("name").and_then(val_string))
                .filter(|n| !n.trim().is_empty())
                .collect()
        })
        .unwrap_or_default();
    if names.is_empty() {
        "未知艺术家".into()
    } else {
        names.join("、")
    }
}

// ---------------------------------------------------------------------------
// 歌单搜索
// ---------------------------------------------------------------------------

pub async fn search_playlists(ctx: &Ctx, q: &SearchQuery) -> ApiResult<PlaylistSearchPage> {
    let _ = ctx;
    let term = q.q.clone().unwrap_or_default();
    let term = term.trim();
    if term.is_empty() {
        return Err(bad_request("咪咕歌单搜索需要关键词"));
    }

    let limit = q.limit.clamp(1, 50);
    let page_no = q.offset / limit + 1;
    let body = search_all(term, page_no, limit, SWITCH_SONGLIST).await?;

    // 上游按 searchSwitch 只回对应分组；分组缺失（如命中为空）时给空列表，
    // 不 panic、不编造。
    let data = body.get("songListResultData");
    let items = data
        .and_then(|d| d.get("result"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let playlists: Vec<OnlinePlaylist> = items.iter().filter_map(map_playlist).collect();
    let total = data
        .and_then(|d| d.get("totalCount"))
        .and_then(val_u64)
        .map(|n| n as usize)
        .unwrap_or(playlists.len());

    Ok(PlaylistSearchPage {
        source: ID.into(),
        keyword: term.to_string(),
        total,
        playlists,
    })
}

/// 把一条 songListResultData.result 折成歌单。上游只给 userId，没有昵称；
/// creator 就填 userId（不冒充平台昵称）。ts 是标签数组，OnlinePlaylist 没有
/// 对应字段，丢掉不影响契约；description 上游本就没有，恒 None。
fn map_playlist(item: &Value) -> Option<OnlinePlaylist> {
    let id = item
        .get("id")
        .and_then(val_string)
        .filter(|s| !s.trim().is_empty())?;
    let name = item
        .get("name")
        .and_then(val_string)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "未知歌单".into());
    let cover = item
        .get("musicListPicUrl")
        .and_then(|v| v.as_str())
        .and_then(https_url);
    let track_count = item.get("musicNum").and_then(val_u64).unwrap_or(0);
    let play_count = item.get("playNum").and_then(val_u64);
    let creator = item.get("userId").and_then(val_string).unwrap_or_default();

    Some(OnlinePlaylist {
        source: ID.into(),
        id,
        name,
        cover,
        track_count,
        play_count,
        creator,
        kind: "created".into(),
        description: None,
    })
}

// ---------------------------------------------------------------------------
// 详情 / 歌词
// ---------------------------------------------------------------------------

/// resourceinfo.do → resource[0]。缺分组时回 Null，由调用方决定怎么退。
async fn resource_info(cid: &str) -> ApiResult<Value> {
    let mut url = const_url(RESOURCE_URL)?;
    {
        let mut p = url.query_pairs_mut();
        p.append_pair("copyrightId", cid)
            .append_pair("resourceType", "2");
    }
    let body = super::http::get_json(&client()?, url.as_str(), headers()).await?;
    Ok(body
        .get("resource")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(Value::Null))
}

pub async fn detail(ctx: &Ctx, id: &str) -> ApiResult<OnlineDetail> {
    let _ = ctx;
    let cid = id.trim();
    if cid.is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    let r = resource_info(cid).await?;
    if r.is_null() {
        return Err(ApiError::upstream_rejected(
            "咪咕未返回单曲详情".to_string(),
        ));
    }
    Ok(OnlineDetail {
        source: ID.into(),
        id: r
            .get("copyrightId")
            .and_then(val_string)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| cid.to_string()),
        title: r.get("songName").and_then(val_string).unwrap_or_default(),
        artist: r.get("singer").and_then(val_string).unwrap_or_default(),
        album: r.get("album").and_then(val_string).unwrap_or_default(),
        duration_ms: r
            .get("length")
            .and_then(val_string)
            .map(|s| parse_clock_ms(&s))
            .unwrap_or(0),
        cover: pick_cover(r.get("albumImgs")),
    })
}

/// 歌词：详情里的 lrcUrl 是普通 LRC 直链，取回原文交给公共解析器。
/// 缺 URL / 取不到 / 解析空都返回空文档——「没有歌词」是常态而不是错误。
pub async fn lyric(ctx: &Ctx, id: &str) -> ApiResult<vmusic_core::LyricDocument> {
    let _ = ctx;
    let cid = id.trim();
    if cid.is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    let r = match resource_info(cid).await {
        Ok(r) => r,
        Err(_) => return Ok(vmusic_core::LyricDocument::empty()),
    };
    let Some(lrc_url) = r
        .get("lrcUrl")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Ok(vmusic_core::LyricDocument::empty());
    };
    let text = match super::http::get_text(&client()?, lrc_url, headers()).await {
        Ok(t) => t,
        Err(_) => return Ok(vmusic_core::LyricDocument::empty()),
    };
    if text.trim().is_empty() {
        return Ok(vmusic_core::LyricDocument::empty());
    }
    let mut doc = vmusic_lyrics::parse_lrc(&text);
    vmusic_lyrics::apply_offset(&mut doc);
    Ok(doc)
}

// ---------------------------------------------------------------------------
// 取流
// ---------------------------------------------------------------------------

/// 咪咕的取流响应是 AES 加密的 hex 密文，无法解析。这里明确报错，
/// 绝不为了「看起来能用」而伪造一个地址（见模块文档的边界）。
pub async fn stream(
    _ctx: &Ctx,
    _id: &str,
    _track_ref: Option<&super::TrackRef>,
    _quality: u32,
) -> ApiResult<StreamInfo> {
    Err(ApiError::upstream_rejected(
        "咪咕取流响应为加密内容，暂未支持".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_clock_folds_into_milliseconds() {
        // resourceinfo 的 length 形如 "00:03:02"，公共折秒器按 m:ss 连乘。
        assert_eq!(super::super::parse_clock_ms("00:03:02"), 182_000);
    }

    #[test]
    fn song_list_item_folds_into_playlist() {
        let item = serde_json::json!({
            "id": "205356198",
            "name": "华语流行精选",
            "userId": "1234567",
            "musicNum": "25",
            "keepNum": "10",
            "playNum": "12345",
            "shareNum": "3",
            "ts": ["华语", "流行"],
            "musicListPicUrl": "http://img.migu.cn/cover/a.jpg"
        });
        let p = map_playlist(&item).expect("这条歌单应能折");
        assert_eq!(p.source, "migu");
        assert_eq!(p.id, "205356198");
        assert_eq!(p.name, "华语流行精选");
        assert_eq!(p.track_count, 25);
        assert_eq!(p.play_count, Some(12345));
        assert_eq!(p.creator, "1234567");
        assert_eq!(p.kind, "created");
        assert!(p.description.is_none());
        // 封面统一升 https。
        assert_eq!(p.cover.as_deref(), Some("https://img.migu.cn/cover/a.jpg"));
    }

    #[test]
    fn playlist_without_id_is_dropped_and_bad_counts_tolerated() {
        assert!(map_playlist(&serde_json::json!({"name": "x"})).is_none());
        let p = map_playlist(&serde_json::json!({
            "id": 42,
            "name": "数字 id",
            "musicNum": "not-a-number",
            "playNum": 7
        }))
        .unwrap();
        assert_eq!(p.id, "42");
        assert_eq!(p.track_count, 0);
        assert_eq!(p.play_count, Some(7));
    }

    #[test]
    fn song_item_folds_into_track_with_ref() {
        let item = serde_json::json!({
            "copyrightId": "600907000002816350",
            "contentId": "600907000002816351",
            "name": "晴天",
            "singers": [{"id": "1", "name": "周杰伦"}],
            "albums": [{"id": "9", "name": "叶惠美"}],
            "imgItems": [
                {"imgSizeType": "01", "img": "http://img.migu.cn/s.jpg"},
                {"imgSizeType": "03", "img": "http://img.migu.cn/l.jpg"}
            ]
        });
        let t = map_track(&item).expect("这条曲目应能折");
        assert_eq!(t.id, "600907000002816350");
        assert_eq!(t.title, "晴天");
        assert_eq!(t.artist, "周杰伦");
        assert_eq!(t.album, "叶惠美");
        // 明确不可播：取流加密。
        assert!(!t.playable);
        // 优先取 03 大图并升 https。
        assert_eq!(t.cover.as_deref(), Some("https://img.migu.cn/l.jpg"));
        assert_eq!(
            t.track_ref.get("copyrightId").and_then(|v| v.as_str()),
            Some("600907000002816350")
        );
    }

    #[tokio::test]
    async fn stream_reports_encrypted_upstream() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .connect_lazy("sqlite::memory:")
            .expect("lazy sqlite pool");
        let ctx = Ctx { db };
        let err = stream(&ctx, "600907000002816350", None, 320_000)
            .await
            .unwrap_err();
        assert_eq!(err.status, 502);
        assert!(err.message.contains("加密"), "错误应说明取流加密: {err:?}");
    }
}
