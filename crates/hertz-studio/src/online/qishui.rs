// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 汽水音乐音源。
//!
//! 走的是**汽水音乐 PC 客户端自己公开使用的 Web 接口**（`api.qishui.com/luna/...`），
//! 凭据是用户本人扫码/登录得到的会话 cookie，与浏览器登录后的行为一致。这一条
//! 和网易云、QQ、酷狗的做法完全相同：只在用户本机、以用户本人凭据调用。
//!
//! ## 未登录时也能用
//!
//! 会话 cookie 缺失时回落到**公开目录接口**（火山引擎车机曲库的公开检索端点，
//! 无需凭据）。它只能给元数据，取不到可播放地址，所以结果一律 `playable: false`
//! —— 宁可让用户看到「这首歌需要先登录」的灰行，也不要给一个点了必失败的行。
//!
//! ## 明确不做的事
//!
//! 与 `online/mod.rs` 的边界一致，这里**不实现**下面这些，能力位也不登记：
//!
//!   - **加密音频的解密**。平台对部分音质返回的流是 SENC 加密容器，解密需要
//!     从 `spade_a` 反解内容密钥。`collect_streams` 会识别并剔除这些候选，
//!     只剩加密流时按 `vip_required` 如实报错，绝不尝试解密。
//!   - **二次验证（2046）**。上游对部分账号在扫码确认后要求过一道官方 JS 的
//!     安全验证，参考实现为此弹一个 Electron 窗口去跑。本项目没有浏览器内核，
//!     遇到它回终态 `mfa_required` 并引导用户改用粘贴 cookie，不假装能完成。
//!
//! 登录入口有两条：粘贴你自己的 cookie，以及官方 Passport 网页接口的扫码
//! （见本文件「扫码登录」一节——它**不**需要伪造设备指纹或求解 JS 挑战，
//! 与参考实现的 bdms/sdk-glue 桥接是两回事）。
//!
//! 会员权益也照实处理：拿不到可验证的会员态时按「未知」报错，不假定有权益。

use super::http::{absorb_cookies, cookie_string, merge_cookie};
use super::{
    bad_request, client, https_url, AccountInfo, ApiError, ApiResult, Ctx, OnlineDetail,
    OnlineTrack, QrPayload, SearchPage, SearchQuery, StreamInfo, TrackRef,
};

/// PC 客户端 Web 接口根。
const PC_BASE: &str = "https://api.qishui.com";
/// 音源标识。能力表、凭据库、dispatch 都用它，字面量散在各处容易写错。
const ID: &str = "qishui";
/// 下载音频时要带的来源页。缺了 CDN 直链会 403。
const REFERER: &str = "https://www.qishui.com/";

/// 公开目录检索（无凭据时的降级通道）。
const PUBLIC_SEARCH: &str = "https://api-vehicle.volcengine.com/v2/search/type";
const PUBLIC_CONTENTS: &str = "https://api-vehicle.volcengine.com/v2/custom/contents";

/// PC 客户端请求的自述参数。这些是客户端随每个请求上报的静态字段，
/// 不是签名——没有它们接口会拒绝，但它们不承载任何凭据。
fn pc_params() -> Vec<(&'static str, String)> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    vec![
        ("aid", "386088".to_string()),
        ("app_name", "luna_pc".to_string()),
        ("region", "cn".to_string()),
        ("device_platform", "windows".to_string()),
        ("version_name", "3.3.0".to_string()),
        ("version_code", "30030000".to_string()),
        ("device_id", now.to_string()),
    ]
}

/// 会话 cookie；未登录时为空。
async fn session_cookie(ctx: &Ctx) -> Option<String> {
    let pack = super::cred::get(&ctx.db, ID).await.ok()??;
    if !super::cred::is_signed_in(ID, &pack) {
        return None;
    }
    Some(pack.cookie)
}

/// 平台返回的业务状态码。0 表示成功，其余按错误抛。
///
/// 1000016 是会话失效（需重新登录），单独识别以便给出可操作的文案。
fn status_error(payload: &serde_json::Value, fallback: &str) -> Option<ApiError> {
    let code = payload
        .get("status_code")
        .or_else(|| payload.get("error_code"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if code == 0 {
        return None;
    }
    let message = payload
        .get("status_info")
        .and_then(|i| i.get("status_msg"))
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("message").and_then(|v| v.as_str()))
        .unwrap_or(fallback)
        .to_string();
    Some(if code == 1000016 || code == 401 {
        ApiError::auth_required(format!(
            "汽水音乐登录状态已失效，请重新粘贴 cookie（{message}）"
        ))
    } else {
        ApiError::upstream_rejected(format!("汽水音乐返回状态码 {code}：{message}"))
    })
}

fn get_str<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| value.get(*k).and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn get_u64(value: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|k| {
        value.get(*k).and_then(|v| match v {
            serde_json::Value::Number(n) => n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)),
            serde_json::Value::String(s) => s.trim().parse::<u64>().ok(),
            _ => None,
        })
    })
}

fn get_obj<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a serde_json::Value> {
    keys.iter().find_map(|k| value.get(*k))
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

pub async fn search(ctx: &Ctx, q: &SearchQuery) -> ApiResult<SearchPage> {
    let term = q.q.as_deref().unwrap_or("").trim().to_string();
    if term.is_empty() {
        return Err(super::bad_request(
            "汽水音乐只支持关键词检索，请输入歌名或歌手",
        ));
    }
    let limit = q.limit.clamp(1, 60);
    let offset = q.offset;

    match session_cookie(ctx).await {
        Some(cookie) => match pc_search(&cookie, &term, limit, offset).await {
            Ok(page) => Ok(page),
            Err(e) if e.status == 401 => {
                // 会话失效：降级到公开目录而不是直接把错误甩给用户——
                // 公开目录至少还能看到有哪些歌。
                public_search(&term, limit, offset).await
            }
            Err(e) => Err(e),
        },
        None => public_search(&term, limit, offset).await,
    }
}

async fn pc_search(cookie: &str, term: &str, limit: usize, offset: usize) -> ApiResult<SearchPage> {
    let mut params = pc_params();
    params.push(("q", term.to_string()));
    params.push(("cursor", offset.to_string()));
    params.push(("count", limit.to_string()));
    params.push(("search_method", "input".to_string()));

    let mut headers = super::http::headers(Some(cookie), Some(REFERER));
    headers.insert(
        reqwest::header::ACCEPT,
        reqwest::header::HeaderValue::from_static("application/json,text/plain,*/*"),
    );
    let url = format!("{PC_BASE}/luna/pc/search/track");
    let payload = super::http::get_json(&client()?, &append_query(&url, &params), headers).await?;
    if let Some(e) = status_error(&payload, "汽水音乐搜索失败") {
        return Err(e);
    }

    let items = extract_items(&payload);
    let mut tracks = Vec::with_capacity(items.len());
    for item in &items {
        if let Some(t) = media_track(item, true) {
            tracks.push(t);
        }
    }
    let total = tracks.len();
    Ok(SearchPage {
        source: ID.into(),
        keyword: term.to_string(),
        total,
        tracks: tracks.into_iter().take(limit).collect(),
        warning: None,
    })
}

/// 从搜索响应里捞出曲目数组。上游把结果放在 `data.result_groups[].data` 里，
/// 不同版本字段名有 camelCase 与 snake_case 两种，都认。
///
/// 返回克隆而不是借用：`result_groups` 是从 `payload` 里取出后拼出来的中间
/// 容器，借它出来活不过本函数。曲目量在百级，克隆成本可以忽略。
fn extract_items(payload: &serde_json::Value) -> Vec<serde_json::Value> {
    let data = payload.get("data").unwrap_or(payload);
    let mut out: Vec<serde_json::Value> = Vec::new();

    if let Some(groups) =
        get_obj(data, &["result_groups", "resultGroups"]).and_then(|v| v.as_array())
    {
        for group in groups {
            if let Some(arr) = collect_array(group) {
                out.extend(arr.iter().cloned());
            }
        }
    }
    if out.is_empty() {
        if let Some(arr) = collect_array(data) {
            out.extend(arr.iter().cloned());
        }
    }
    out
}

/// 从一个可能是分组/可能是结果容器的节点里取数组。
fn collect_array(node: &serde_json::Value) -> Option<&Vec<serde_json::Value>> {
    get_obj(node, &["data", "items", "list", "result", "tracks"]).and_then(|v| v.as_array())
}

/// 一条上游媒体记录 → 归一化曲目。
///
/// `playable` 只在**已登录**时为真：公开目录给不出播放地址，标成可播只会让用户
/// 点一下拿到一条错误。
fn media_track(item: &serde_json::Value, signed_in: bool) -> Option<OnlineTrack> {
    let id = get_str(item, &["track_id", "trackId", "id", "media_id", "mediaId"])?;
    let title = get_str(item, &["title", "name", "track_name", "trackName"])?;

    let artist = get_str(item, &["artist", "author", "artist_name", "artistName"])
        .or_else(|| {
            item.get("artists")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|f| get_str(f, &["name", "artist_name"]))
        })
        .unwrap_or("未知艺术家")
        .to_string();

    let album = get_obj(item, &["album", "album_info", "albumInfo"])
        .and_then(|a| get_str(a, &["name", "title", "album_name"]))
        .or_else(|| get_str(item, &["album", "album_name"]))
        .unwrap_or("")
        .to_string();

    // 时长上游有时给秒、有时给毫秒：大于 100000 一律按毫秒读，否则按秒。
    let duration_ms = get_u64(item, &["duration_ms", "durationMs", "duration", "dt"])
        .map(|v| if v > 100_000 { v } else { v * 1000 })
        .unwrap_or(0);

    let cover = get_obj(item, &["cover", "album", "album_info", "albumInfo"])
        .and_then(|c| get_str(c, &["url", "uri", "cover", "pic_url", "picUrl", "url_list"]))
        .or_else(|| get_str(item, &["cover", "pic_url", "picUrl", "image_url"]))
        .and_then(https_url);

    let vip_only = item
        .get("vip")
        .or_else(|| item.get("need_vip"))
        .or_else(|| item.get("vip_only"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    Some(OnlineTrack {
        source: ID.into(),
        id: id.to_string(),
        title: title.to_string(),
        artist,
        album,
        duration_ms,
        cover,
        playable: signed_in && !vip_only,
        vip_only,
        track_ref: serde_json::json!({}),
    })
}

/// 无凭据时的公开目录检索。只给元数据，不可播。
async fn public_search(term: &str, limit: usize, offset: usize) -> ApiResult<SearchPage> {
    // 上游没有分页语义：一次取一个候选窗口，本地切片。
    let window = (offset + limit).clamp(1, 100);
    let url = append_query(
        PUBLIC_SEARCH,
        &[
            ("sources", ID.to_string()),
            ("keyword", term.to_string()),
            ("count", window.to_string()),
            ("search_source", ID.to_string()),
        ],
    );
    let payload = super::http::get_json(
        &client()?,
        &url,
        super::http::headers(None, Some("https://www.qishui.com/")),
    )
    .await?;

    let list = payload
        .get("data")
        .and_then(|d| d.get("list"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut tracks = Vec::new();
    for item in list.iter().skip(offset).take(limit) {
        if let Some(mut t) = media_track(item, false) {
            t.playable = false;
            tracks.push(t);
        }
    }
    let total = tracks.len();
    Ok(SearchPage {
        source: ID.into(),
        keyword: term.to_string(),
        total,
        tracks,
        warning: Some("未登录汽水音乐，以下仅是可浏览的目录信息，需要登录后才能试听。".to_string()),
    })
}

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

pub async fn detail(ctx: &Ctx, id: &str) -> ApiResult<OnlineDetail> {
    if id.trim().is_empty() {
        return Err(super::bad_request("缺少曲目 id"));
    }
    match session_cookie(ctx).await {
        Some(cookie) => match pc_track(&cookie, id).await {
            Ok(payload) => {
                if let Some(t) = payload.get("data").and_then(|d| d.get("track")) {
                    if let Some(track) = media_track(t, true) {
                        return Ok(OnlineDetail {
                            source: ID.into(),
                            id: id.to_string(),
                            title: track.title,
                            artist: track.artist,
                            album: track.album,
                            duration_ms: track.duration_ms,
                            cover: track.cover,
                        });
                    }
                }
                Err(ApiError::upstream_rejected(
                    "汽水音乐详情响应里没有曲目信息".to_string(),
                ))
            }
            Err(e) => Err(e),
        },
        None => public_detail(id).await,
    }
}

async fn public_detail(id: &str) -> ApiResult<OnlineDetail> {
    let url = append_query(
        PUBLIC_CONTENTS,
        &[
            ("sources", ID.to_string()),
            ("item_ids", id.to_string()),
            ("need_album", "true".to_string()),
        ],
    );
    let payload = super::http::get_json(
        &client()?,
        &url,
        super::http::headers(None, Some("https://www.qishui.com/")),
    )
    .await?;
    let item = payload
        .get("data")
        .and_then(|d| d.get("list"))
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| ApiError::upstream_rejected("公开目录里没有这首曲目".to_string()))?;
    let track = media_track(item, false)
        .ok_or_else(|| ApiError::upstream_rejected("公开目录曲目字段缺失".to_string()))?;
    Ok(OnlineDetail {
        source: ID.into(),
        id: id.to_string(),
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration_ms: track.duration_ms,
        cover: track.cover,
    })
}

// ---------------------------------------------------------------------------
// 取流
// ---------------------------------------------------------------------------

/// 取曲目元数据（含播放候选）。
async fn pc_track(cookie: &str, id: &str) -> ApiResult<serde_json::Value> {
    let body = serde_json::json!({
        "track_id": id,
        "media_type": "track",
        "scene_name": "library",
    });
    let mut headers = super::http::headers(Some(cookie), Some(REFERER));
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    let url = append_query(&format!("{PC_BASE}/luna/pc/track_v2"), &pc_params());
    let payload = super::http::post_json(&client()?, &url, headers, body.to_string()).await?;
    if let Some(e) = status_error(&payload, "汽水音乐取流元数据失败") {
        return Err(e);
    }
    Ok(payload)
}

pub async fn stream(
    ctx: &Ctx,
    id: &str,
    _track_ref: Option<&TrackRef>,
    _quality: u32,
) -> ApiResult<StreamInfo> {
    if id.trim().is_empty() {
        return Err(super::bad_request("缺少曲目 id"));
    }
    let cookie = session_cookie(ctx).await.ok_or_else(|| {
        ApiError::auth_required("试听汽水音乐需要先登录：请在设置里粘贴你自己的 cookie")
    })?;

    let payload = pc_track(&cookie, id).await?;
    let candidates = collect_streams(&payload);

    let best = match select_playable(&candidates) {
        Some(s) => s,
        None => {
            // 平台没给可播档：区分「什么都没给」与「只给了加密的」，
            // 后者要明确告诉用户是受保护内容而不是「没有音源」。
            return Err(if best_overall(&candidates).is_some() {
                ApiError::vip_required("该曲目只提供了加密音质，本项目不解密受保护内容，已跳过")
            } else {
                ApiError::vip_required("汽水音乐没有返回当前账号可播放的音质")
            });
        }
    };

    // 备选直链先算再搬走 best.url：下游按序降级重试，只收非加密档。
    let fallback_urls: Vec<String> = candidates
        .iter()
        .filter(|c| !c.encrypted && c.url != best.url)
        .map(|c| c.url.clone())
        .take(3)
        .collect();

    Ok(StreamInfo {
        url: best.url,
        source: ID.into(),
        id: id.to_string(),
        bitrate: best.bitrate,
        expires_in_secs: None,
        fallback_urls,
    })
}

/// 一个播放候选。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Stream {
    url: String,
    bitrate: Option<u64>,
    /// 排序用的质量分：越大越好。
    rank: i64,
    /// 上游给的是加密容器（带内容密钥）。这类候选一律不播。
    encrypted: bool,
}

/// 从曲目元数据里收集播放候选。
///
/// 上游把直链放在 `audio_info.play_info_list[]` 与 `bit_rates[]` 两处，字段名
/// 有 snake_case 与 PascalCase 两套；两套都扫，避免换一次上游版本就全站取不到流。
fn collect_streams(payload: &serde_json::Value) -> Vec<Stream> {
    let data = payload.get("data").unwrap_or(payload);
    let track = get_obj(data, &["track", "track_info", "trackInfo"]).unwrap_or(data);
    let audio = get_obj(track, &["audio_info", "audioInfo"]).unwrap_or(track);

    let mut out = Vec::new();
    for list in get_obj(audio, &["play_info_list", "PlayInfoList", "playInfoList"])
        .and_then(|v| v.as_array())
        .into_iter()
        .chain(get_obj(track, &["bit_rates", "bitRates"]).and_then(|v| v.as_array()))
    {
        for item in list {
            if let Some(s) = stream_from(item) {
                out.push(s);
            }
        }
    }
    out
}

fn stream_from(item: &serde_json::Value) -> Option<Stream> {
    let url = get_str(
        item,
        &[
            "url",
            "Url",
            "main_url",
            "mainUrl",
            "play_url",
            "playUrl",
            "download_url",
            "downloadUrl",
            "url_list",
        ],
    )?
    .to_string();
    if !url.starts_with("http") {
        return None;
    }

    let format = get_str(item, &["format", "Format", "file_format", "codec"]).unwrap_or("");
    let quality =
        get_str(item, &["quality", "Quality", "quality_level", "definition"]).unwrap_or("");
    let bitrate = get_u64(item, &["bitrate", "Bitrate", "bit_rate", "bitRate", "br"]);

    // 加密容器：上游在候选里带上内容密钥（spade_a / auth）就说明这一档是受保护的。
    let encrypted = get_str(
        item,
        &["spade_a", "spadeA", "auth", "Auth", "key_id", "keyId"],
    )
    .is_some()
        || format.to_lowercase().contains("enc")
        || get_obj(item, &["encryption", "drm"]).is_some();

    let rank = quality_rank(quality, format, bitrate);
    Some(Stream {
        url,
        bitrate,
        rank,
        encrypted,
    })
}

/// 质量分：无损/高码率优先。只看上游自己声明的字段，不猜。
fn quality_rank(quality: &str, format: &str, bitrate: Option<u64>) -> i64 {
    let text = format!("{quality} {format}").to_lowercase();
    let mut rank = bitrate.unwrap_or(0) as i64;
    if text.contains("flac") || text.contains("lossless") || text.contains("hi_res") {
        rank += 400_000;
    } else if text.contains("320") || text.contains("high") || text.contains("hq") {
        rank += 200_000;
    } else if text.contains("128") || text.contains("standard") || text.contains("sq") {
        rank += 0;
    }
    rank
}

/// 选**可播的**最佳候选：加密档位直接排除。
///
/// 这是唯一允许产出播放 URL 的函数。把「排除加密」做成独立的纯函数而不是
/// 散在 `stream()` 里的一个 if，是因为它是一条红线——必须有自己的单测，
/// 而不是靠读代码的人记得住。
fn select_playable(candidates: &[Stream]) -> Option<Stream> {
    candidates
        .iter()
        .filter(|c| !c.encrypted)
        .max_by_key(|c| (c.rank, c.bitrate.unwrap_or(0)))
        .cloned()
}

/// 最佳候选（**含**加密档）。只用于分辨「平台没给音源」和「平台只给了加密
/// 音源」这两种失败，好给出不同的文案；它产出的 URL 绝不能拿去播放。
fn best_overall(candidates: &[Stream]) -> Option<Stream> {
    candidates
        .iter()
        .max_by_key(|c| (c.rank, c.bitrate.unwrap_or(0)))
        .cloned()
}

// ---------------------------------------------------------------------------
// 歌词
// ---------------------------------------------------------------------------

/// 上游的歌词是 LRC 文本，带翻译时是第二段。
pub async fn lyric(ctx: &Ctx, id: &str) -> ApiResult<vmusic_core::LyricDocument> {
    if id.trim().is_empty() {
        return Err(super::bad_request("缺少曲目 id"));
    }
    let Some(cookie) = session_cookie(ctx).await else {
        // 未登录只是没有歌词，不是错误：在线播放链路对歌词失败是宽容的。
        return Ok(vmusic_core::LyricDocument::empty());
    };
    let payload = pc_track(&cookie, id).await?;
    let text = get_lyric_text(&payload);
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
        return Ok(vmusic_core::LyricDocument::empty());
    };
    Ok(vmusic_lyrics::parse_lrc(&text))
}

fn get_lyric_text(payload: &serde_json::Value) -> Option<String> {
    let data = payload.get("data").unwrap_or(payload);
    let track = get_obj(data, &["track", "track_info", "trackInfo"]).unwrap_or(data);
    let lyric = get_obj(track, &["lyric", "lyric_info", "lyricInfo"])?;
    get_str(
        lyric,
        &["content", "lyric", "lyric_text", "lyricText", "text"],
    )
    .map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

fn append_query(base: &str, params: &[(&str, String)]) -> String {
    let mut out = base.to_string();
    let mut first = !out.contains('?');
    for (key, value) in params {
        if value.is_empty() {
            continue;
        }
        out.push(if first { '?' } else { '&' });
        first = false;
        out.push_str(key);
        out.push('=');
        out.push_str(&urlencode(value));
    }
    out
}

/// 只转义查询串里必须转义的字符。中文交给 reqwest 不会自动编码，
/// 所以这里按字节百分号编码——ASCII 安全字符原样保留，其余按 UTF-8 字节转义。
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 扫码登录
// ---------------------------------------------------------------------------
//
// 二维码由**汽水音乐官方 Passport 网页接口**签发，用**用户自己的抖音 App**
// 扫码确认——与网页端登录同源，只在用户本机、以用户本人凭据调用。
//
// 这里**不涉及**参考实现里 bdms/sdk-glue 那一套：既不伪造设备指纹，也不执行
// 或求解任何 JS 挑战。实测（2026-09-22）两个端点在不带 `a_bogus`、`msToken`、
// `account_sdk_source_info`、`device_id` 的情况下直接返回 `error_code: 0`，
// 二维码图片还是服务端下发好的 base64 PNG。所以登录入口在「粘贴 cookie」
// 之外多一条扫码，能力位登记 `QrLogin`。
//
// 上游真正要求的只有 `passport_jssdk_version` 那一组**版本自述字段**：缺了
// 它们接口回 `4031 当前版本过低，需要 2.8.8 及以上版本`（实测：只补
// `device_id` 而不补该字段，仍然 4031）。它们与 [`pc_params`] 同一性质——
// 客户端随每个请求上报的静态字段，不是签名，也不承载任何凭据。
//
// 明确不做的一环：上游对部分账号在确认后回 `2046` 要求**二次验证**。参考
// 实现为此弹一个 Electron 窗口跑官方 JS，本项目没有浏览器内核，遇到 2046
// 如实回终态 `mfa_required` 并引导走 cookie 粘贴，不假装能完成。

/// Passport 网页接口根。
const PASSPORT_BASE: &str = "https://api.qishui.com/passport/web";

/// 汽水音乐的 aid。Passport 用它决定签发哪个 App 的码。
const PASSPORT_AID: &str = "386088";

/// 握手票里分隔「token」与「创建期 cookie」的字符。token 是 hex/base64url
/// 形态，不含换行，用换行分隔（与网易云同形），Registry 只当整串是字符串。
const QR_TICKET_SEP: &str = "\n";

/// 轮询间隔。手机会在几秒内确认，1.5s 足够跟上又不至于频繁打上游。
const QR_POLL_MS: u32 = 1500;

/// 「需要二次验证」的业务码。它不是错误，而是「此路走不通」的信号。
const QR_MFA_CODE: i64 = 2046;

/// Passport 请求自述参数。
///
/// 只有这一组**版本自述字段**是接口硬要求（缺了回 4031）。清单是实测收敛
/// 出来的：`device_id`/`install_id`/`msToken`/`a_bogus` 全都试过，都不是必需。
/// 刻意不补伪造的设备指纹——少一个假字段就少一分「像在冒充客户端」。
fn passport_params() -> Vec<(&'static str, String)> {
    vec![
        ("aid", PASSPORT_AID.to_string()),
        ("passport_jssdk_version", "2.4.13".to_string()),
        ("passport_jssdk_type", "normal".to_string()),
        ("account_sdk_source", "web".to_string()),
        ("is_from_ttaccountsdk", "1".to_string()),
        ("is_new_login", "1".to_string()),
        ("language", "zh".to_string()),
    ]
}

/// 二维码接口的固定参数：不要 logo、不要短链（短链要再过一跳才能拿到图）。
fn qr_create_params() -> Vec<(&'static str, String)> {
    let mut p = passport_params();
    p.push(("next", PC_BASE.to_string()));
    p.push(("need_logo", "false".to_string()));
    p.push(("need_short_url", "false".to_string()));
    p
}

/// 发起扫码，返回握手票 `token + 换行 + 创建期 cookie`。
///
/// 创建期上游会种 `passport_csrf_token`，虽然实测轮询不带它也能拿到 `new`
/// 态，但仍原样带回：确认那一步的行为无法在不真机扫码的前提下验证，多带一
/// 罐上游自己种的 cookie 只会更接近网页端的真实形态。
pub async fn qr_create(_ctx: &Ctx) -> ApiResult<QrPayload> {
    let url = append_query(&format!("{PASSPORT_BASE}/get_qrcode/"), &qr_create_params());
    let headers = super::http::headers(None, Some(REFERER));
    let (resp_headers, payload) =
        super::http::get_json_with_headers(&client()?, &url, headers).await?;
    let data = passport_data(&payload)?;
    let error_code = data
        .get("error_code")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    if error_code != 0 {
        let desc = get_str(data, &["description"]).unwrap_or("未知原因");
        return Err(ApiError::upstream_rejected(format!(
            "汽水音乐创建二维码失败（{error_code}）：{desc}"
        )));
    }
    let token = get_str(data, &["token"])
        .ok_or_else(|| ApiError::upstream_rejected("汽水音乐未返回扫码 token".to_string()))?;
    // 服务端直接给整张 PNG（data URL）。前端 renderQr 优先用 qr_image，
    // 所以这里不需要本地二维码库，也不需要 qrcode_index_url 那一跳。
    let image = get_str(data, &["qrcode"]).map(str::to_string);
    if image.is_none() {
        return Err(ApiError::upstream_rejected(
            "汽水音乐未返回二维码图片".to_string(),
        ));
    }
    let mut jar = std::collections::BTreeMap::new();
    absorb_cookies(&resp_headers, &mut jar);
    let seed = cookie_string(&jar);
    let platform_ticket = if seed.is_empty() {
        token.to_string()
    } else {
        format!("{token}{QR_TICKET_SEP}{seed}")
    };
    Ok(QrPayload {
        platform_ticket,
        qr_text: None,
        qr_image: image,
        poll_ms: QR_POLL_MS,
    })
}

/// 轮询扫码结果。确认时上游通过 `Set-Cookie` 下发会话凭据，整罐写进保险库。
pub async fn qr_check(
    ctx: &Ctx,
    platform_ticket: &str,
) -> ApiResult<(String, Option<AccountInfo>)> {
    let (token, seed) = split_qr_ticket(platform_ticket.trim());
    if token.is_empty() {
        return Err(bad_request("缺少汽水音乐扫码握手票 token"));
    }
    let (headers, payload) = qr_check_round(&token, &seed).await?;
    let data = passport_data(&payload)?;
    let error_code = data
        .get("error_code")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);

    if error_code == QR_MFA_CODE {
        // 二次验证要跑官方 JS，本项目没有浏览器内核：如实回终态让前端引导
        // 用户改用 cookie 粘贴，而不是让轮询空转到超时。
        tracing::warn!("汽水音乐要求二次验证，本项目无法完成，引导用户改用 cookie");
        return Ok(("mfa_required".to_string(), None));
    }
    if error_code != 0 {
        let desc = get_str(data, &["description"]).unwrap_or("未知原因");
        return Err(ApiError::upstream_rejected(format!(
            "汽水音乐扫码失败（{error_code}）：{desc}"
        )));
    }

    let session_cookie = get_str(data, &["session_cookie", "cookie"]).map(str::to_string);
    let state = qr_state(
        get_str(data, &["status", "status_str"]),
        session_cookie.as_deref(),
    );
    // 排障主线索：状态停在 new 说明扫码没关联上这次握手；停在已确认却没有
    // 会话 cookie 说明上游没下发凭据。只记状态与字段名，cookie 值绝不进日志。
    let mut jar = std::collections::BTreeMap::new();
    absorb_cookies(&headers, &mut jar);
    tracing::info!(
        error_code,
        state,
        cookie_names = %jar.keys().cloned().collect::<Vec<_>>().join(","),
        "汽水音乐扫码轮询"
    );
    if state != "confirmed" {
        return Ok((state.to_string(), None));
    }

    // 会话凭据可能来自响应体的 session_cookie，也可能只在 Set-Cookie 里，
    // 两边与创建期的 cookie 合成一罐。
    let incoming = cookie_string(&jar);
    let merged = merge_cookie(&seed, &incoming);
    let cookie = match session_cookie {
        Some(sc) => merge_cookie(&merged, &sc),
        None => merged,
    };
    let pack = super::cred::CredPack {
        cookie,
        ..Default::default()
    };
    if !super::cred::is_signed_in(ID, &pack) {
        // 手机端已确认，但没拿到任何会话 cookie。这枚码已经用掉，再轮询也
        // 只会停在 new，所以回终态让前端提示刷新二维码，而不是报错让前端
        // 按原节奏无限重试、把「登录成功」永远卡在等待。
        tracing::warn!("汽水音乐扫码已确认但未取得会话 cookie，按过期处理让用户刷新二维码");
        return Ok(("expired".to_string(), None));
    }
    super::cred::put(&ctx.db, ID, &pack)
        .await
        .map_err(|e| ApiError::internal(format!("保存汽水音乐凭据失败: {e}")))?;
    // 账号资料回拉失败也按成功返回：凭据已落库，下一次 /account 会把昵称头像
    // 补齐，顶栏不该因为一次回拉失败就显示成未登录。
    let account = account(ctx).await.ok();
    Ok(("confirmed".to_string(), account))
}

/// 打一次状态轮询。HTTP 失败按错误上抛（让前端按原节奏重试），业务码由
/// [`qr_check`] 归一成票态。
async fn qr_check_round(
    token: &str,
    seed: &str,
) -> ApiResult<(reqwest::header::HeaderMap, serde_json::Value)> {
    let url = append_query(
        &format!("{PASSPORT_BASE}/check_qrconnect/"),
        &passport_params(),
    );
    let mut headers = super::http::headers(None, Some(REFERER));
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        reqwest::header::HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    // 表单形态。GET 形态实测回 `error_code 3 缺少参数`——这个端点只认 POST。
    let body = [
        ("token", token),
        ("is_new_login", "1"),
        ("next", PC_BASE),
        ("need_logo", "false"),
        ("need_short_url", "false"),
    ]
    .iter()
    .map(|(k, v)| format!("{k}={}", urlencode(v)))
    .collect::<Vec<_>>()
    .join("&");
    if !seed.is_empty() {
        headers.insert(
            reqwest::header::COOKIE,
            reqwest::header::HeaderValue::from_str(seed)
                .map_err(|e| ApiError::internal(format!("汽水音乐握手 cookie 非法: {e}")))?,
        );
    }
    super::http::post_json_with_headers(&client()?, &url, headers, body).await
}

/// 取 `data` 对象；顺带兜住「上游回了顶层错误」的形态。
fn passport_data(payload: &serde_json::Value) -> ApiResult<&serde_json::Value> {
    get_obj(payload, &["data"]).ok_or_else(|| {
        let msg = get_str(payload, &["message"]).unwrap_or("响应里没有 data");
        ApiError::upstream_rejected(format!("汽水音乐 Passport 响应异常：{msg}"))
    })
}

/// 把上游的 `status` 归一成票态（waiting|scanned|confirmed|expired）。
///
/// 汽水沿用抖音 Passport 的状态串：`new` 未扫、`2`/`scanned` 已扫待确认、
/// `3`/`confirmed` 已确认。拿到 `session_cookie` 就直接算确认——有会话凭据
/// 才算真的登录，状态串只是辅助。
fn qr_state(status: Option<&str>, session_cookie: Option<&str>) -> &'static str {
    if session_cookie.is_some_and(|c| !c.trim().is_empty()) {
        return "confirmed";
    }
    match status {
        Some("3") | Some("confirmed") => "confirmed",
        Some("2") | Some("scanned") | Some("scanning") => "scanned",
        Some("expired") | Some("reauth_required") => "expired",
        // 未知串一律按 waiting：上游加中间态时不该让前端停在「状态异常」。
        _ => "waiting",
    }
}

/// 把握手票拆回 (token, 创建期 cookie)。
fn split_qr_ticket(ticket: &str) -> (String, String) {
    match ticket.split_once(QR_TICKET_SEP) {
        Some((token, cookie)) => (token.trim().to_string(), cookie.trim().to_string()),
        None => (ticket.trim().to_string(), String::new()),
    }
}

/// 拉账号资料（昵称/头像）。扫码确认后调一次，失败不算登录失败。
pub async fn account(ctx: &Ctx) -> ApiResult<AccountInfo> {
    let cookie = session_cookie(ctx)
        .await
        .ok_or_else(|| ApiError::auth_required("汽水音乐未登录".to_string()))?;
    let url = append_query(&format!("{PC_BASE}/luna/pc/user/info"), &pc_params());
    let headers = super::http::headers(Some(&cookie), Some(REFERER));
    let payload = super::http::get_json(&client()?, &url, headers).await?;
    if let Some(e) = status_error(&payload, "汽水音乐账号信息获取失败") {
        return Err(e);
    }
    let user = get_obj(&payload, &["data", "user", "user_info", "userInfo"]).unwrap_or(&payload);
    let nickname = get_str(user, &["nickname", "user_name", "screen_name", "name"])
        .or_else(|| get_str(&payload, &["nickname", "user_name"]))
        .unwrap_or("汽水音乐用户")
        .to_string();
    let avatar = get_str(user, &["avatar_url", "avatar_uri", "avatar"])
        .or_else(|| get_str(&payload, &["avatar_url", "avatar_uri", "avatar"]))
        .and_then(https_url);
    Ok(AccountInfo {
        source: ID.to_string(),
        nickname,
        avatar,
        vip_level: 0,
        vip_label: String::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media() -> serde_json::Value {
        serde_json::json!({
            "track_id": "7123456789",
            "title": "晴天",
            "artist": "周杰伦",
            "album": {"name": "叶惠美"},
            "duration": 269,
            "cover": {"url": "http://p.qishui.com/cover.jpg"},
        })
    }

    #[test]
    fn media_folds_into_the_shared_track_shape() {
        let t = media_track(&media(), true).expect("这条记录应该可播");
        assert_eq!(t.source, ID);
        assert_eq!(t.id, "7123456789");
        assert_eq!(t.title, "晴天");
        assert_eq!(t.artist, "周杰伦");
        assert_eq!(t.album, "叶惠美");
        // 269 秒 → 毫秒；100000 是秒/毫秒的分界。
        assert_eq!(t.duration_ms, 269_000);
        assert!(t.playable);
        assert_eq!(t.cover.as_deref(), Some("https://p.qishui.com/cover.jpg"));
    }

    #[test]
    fn anonymous_results_are_never_playable() {
        let t = media_track(&media(), false).unwrap();
        assert!(!t.playable, "没登录时不能给用户点了必失败的行");
    }

    #[test]
    fn vip_tracks_are_marked_and_not_playable() {
        let mut m = media();
        m["vip"] = serde_json::json!(true);
        let t = media_track(&m, true).unwrap();
        assert!(t.vip_only);
        assert!(!t.playable);
    }

    #[test]
    fn duration_over_the_threshold_is_read_as_milliseconds() {
        let mut m = media();
        m["duration"] = serde_json::json!(269_000);
        assert_eq!(media_track(&m, true).unwrap().duration_ms, 269_000);
    }

    #[test]
    fn missing_id_or_title_drops_the_record() {
        assert!(media_track(&serde_json::json!({"title": "x"}), true).is_none());
        assert!(media_track(&serde_json::json!({"track_id": "1"}), true).is_none());
    }

    #[test]
    fn artists_may_come_as_an_array() {
        let m = serde_json::json!({
            "track_id": "1",
            "title": "T",
            "artists": [{"name": "A"}, {"name": "B"}],
        });
        assert_eq!(media_track(&m, true).unwrap().artist, "A");
    }

    fn streams() -> Vec<Stream> {
        vec![
            Stream {
                url: "https://a/lo".into(),
                bitrate: Some(128_000),
                rank: 300_000,
                encrypted: false,
            },
            Stream {
                url: "https://a/hi".into(),
                bitrate: Some(320_000),
                rank: 500_000,
                encrypted: false,
            },
            Stream {
                url: "https://a/enc".into(),
                bitrate: Some(999_000),
                rank: 900_000,
                encrypted: true,
            },
        ]
    }

    #[test]
    fn encrypted_streams_are_never_selected_for_playback() {
        // 这是本模块的红线：加密档位即使标称码率最高也绝不进入可播集合。
        let best = select_playable(&streams()).unwrap();
        assert!(!best.encrypted);
        assert_eq!(best.url, "https://a/hi");
    }

    #[test]
    fn only_encrypted_candidates_leave_nothing_playable() {
        // 只剩加密档时「可播集合」必须是空的——而不是退而求其次把加密档放出去。
        let only: Vec<Stream> = streams().into_iter().filter(|s| s.encrypted).collect();
        assert!(select_playable(&only).is_none());
        // 但 best_overall 仍然认得出平台是有货的（只是受保护），
        // 好让 stream() 报「加密音质」而不是「没有音源」。
        assert!(best_overall(&only).unwrap().encrypted);
    }

    #[test]
    fn empty_candidates_mean_no_source_at_all() {
        assert!(select_playable(&[]).is_none());
        assert!(best_overall(&[]).is_none());
    }

    #[test]
    fn non_playable_urls_are_dropped() {
        assert!(stream_from(&serde_json::json!({"url": "ftp://x/y"})).is_none());
        assert!(stream_from(&serde_json::json!({"bitrate": 320})).is_none());
    }

    #[test]
    fn spade_a_marks_a_stream_as_encrypted() {
        let s = stream_from(&serde_json::json!({"url": "https://a/b", "spade_a": "abc"})).unwrap();
        assert!(s.encrypted, "带内容密钥的候选必须被识别为加密");
        let plain = stream_from(&serde_json::json!({"url": "https://a/b"})).unwrap();
        assert!(!plain.encrypted);
    }

    #[test]
    fn urlencode_escapes_non_ascii_but_keeps_safe_chars() {
        assert_eq!(urlencode("a-b_c.9~"), "a-b_c.9~");
        // 中文按 UTF-8 字节百分号编码。
        assert_eq!(urlencode("周"), "%E5%91%A8");
    }

    #[test]
    fn append_query_builds_a_well_formed_query() {
        let out = append_query("https://h/p", &[("a", "1".into()), ("b", "周".into())]);
        assert_eq!(out, "https://h/p?a=1&b=%E5%91%A8");
        // 已带查询串时用 & 续接。
        assert_eq!(
            append_query("https://h/p?x=1", &[("a", "2".into())]),
            "https://h/p?x=1&a=2"
        );
        // 空值不产出空参数。
        assert_eq!(
            append_query("https://h/p", &[("a", "".into())]),
            "https://h/p"
        );
    }

    #[test]
    fn qr_state_maps_the_passport_status_strings() {
        // new 未扫；2/scanned 已扫待确认；3/confirmed 已确认。
        assert_eq!(qr_state(Some("new"), None), "waiting");
        assert_eq!(qr_state(Some("2"), None), "scanned");
        assert_eq!(qr_state(Some("scanned"), None), "scanned");
        assert_eq!(qr_state(Some("3"), None), "confirmed");
        assert_eq!(qr_state(Some("confirmed"), None), "confirmed");
        assert_eq!(qr_state(Some("expired"), None), "expired");
    }

    #[test]
    fn a_session_cookie_beats_the_status_string() {
        // 拿到会话凭据就算确认——状态串只是辅助，上游偶发只给 cookie 不给 3。
        assert_eq!(qr_state(Some("new"), Some("sessionid=s1")), "confirmed");
        assert_eq!(qr_state(None, Some("sid_guard=g")), "confirmed");
        // 空 cookie 不算凭据，退回按状态串判。
        assert_eq!(qr_state(Some("2"), Some("  ")), "scanned");
        assert_eq!(qr_state(Some("2"), Some("")), "scanned");
    }

    #[test]
    fn unknown_status_stays_waiting_instead_of_alarming_the_user() {
        // 上游加中间态时不该让前端停在「登录状态异常」上。
        assert_eq!(qr_state(Some("brand_new_state"), None), "waiting");
        assert_eq!(qr_state(None, None), "waiting");
    }

    #[test]
    fn ticket_round_trips_token_and_seed_cookie() {
        let t = format!("tok123{QR_TICKET_SEP}passport_csrf_token=c1");
        assert_eq!(
            split_qr_ticket(&t),
            ("tok123".to_string(), "passport_csrf_token=c1".to_string())
        );
    }

    #[test]
    fn ticket_without_cookies_still_yields_the_token() {
        // 创建期上游一个 cookie 都没种时，票就是裸 token，不能拆出空 token。
        assert_eq!(
            split_qr_ticket("tok123"),
            ("tok123".to_string(), String::new())
        );
        assert_eq!(split_qr_ticket("  "), (String::new(), String::new()));
    }

    #[test]
    fn passport_params_carry_the_version_fields_4031_requires() {
        // 实测：缺了这几个字段接口回 4031「当前版本过低，需要 2.8.8 及以上」。
        let p = passport_params();
        let get = |k: &str| p.iter().find(|(n, _)| *n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("aid"), Some(PASSPORT_AID));
        assert!(get("passport_jssdk_version").is_some());
        assert!(get("passport_jssdk_type").is_some());
        assert!(get("account_sdk_source").is_some());
        assert!(get("is_from_ttaccountsdk").is_some());
        // 不登记任何设备指纹/签名类字段：这条路径不需要它们。
        assert!(get("device_id").is_none());
        assert!(get("msToken").is_none());
        assert!(get("account_sdk_source_info").is_none());
    }

    #[test]
    fn session_expiry_is_translated_into_a_login_prompt() {
        let payload =
            serde_json::json!({"status_code": 1000016, "status_info": {"status_msg": "登录失效"}});
        let err = status_error(&payload, "x").expect("1000016 必须被识别为错误");
        assert_eq!(err.status, 401);
    }

    #[test]
    fn other_status_codes_are_upstream_errors() {
        let payload = serde_json::json!({"status_code": 5, "message": "内部错误"});
        let err = status_error(&payload, "兜底").unwrap();
        assert_ne!(err.status, 401);
        // 0 表示成功。
        assert!(status_error(&serde_json::json!({"status_code": 0}), "x").is_none());
    }

    #[test]
    fn lyric_text_is_found_under_both_field_shapes() {
        let payload =
            serde_json::json!({"data": {"track": {"lyric": {"content": "[00:01.00]hi"}}}});
        assert_eq!(get_lyric_text(&payload).as_deref(), Some("[00:01.00]hi"));
        let camel =
            serde_json::json!({"data": {"track": {"lyric_info": {"lyric_text": "[00:02.00]yo"}}}});
        assert_eq!(get_lyric_text(&camel).as_deref(), Some("[00:02.00]yo"));
        assert!(get_lyric_text(&serde_json::json!({})).is_none());
    }
}
