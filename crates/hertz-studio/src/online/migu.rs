// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 咪咕音乐音源。
//!
//! 端点来自咪咕官网 v5 / 移动 H5（`https://c.musicapp.migu.cn`）。
//!
//!   - 单曲搜索：`/v1.0/content/search_all.do`（`searchSwitch.song=1`）
//!   - 歌单搜索：同一个 search_all.do（`searchSwitch.songList=1`），本音源
//!     参与在线歌单搜索的能力就在这里；
//!   - 单曲详情：`/v1.0/content/resourceinfo.do?copyrightId=&resourceType=2`
//!   - 歌词：详情里的 `lrcUrl` 直链，就是普通 LRC 文本。
//!   - 账号：`/user/h5/user-info/v1.0`，用户 Cookie 的 `pacmtoken` 作同名请求头。
//!   - 歌单：`/resource/playlist/v2.0` 元数据及独立的 1-based 曲目分页接口。
//!   - 取流：`/strategy/pc/listen/v2.0` 的标准 PQ 普通音频直链。
//!
//! ## 授权与响应编码
//!
//! 官网 SDK 的 `signature: 1` 是 API JSON 信封编码，不是音频 DRM。
//! 这里仅按公开协议还原 JSON；先验证平台错误码与 `cannotCode`，再接受 HTTP(S)
//! 地址。不解密音频、不绕过会员限制。Cookie 形状只表示已保存凭据；账号接口
//! 验证会话，真实取流结果裁决本首权限。未知会员等级与码率都保持未知。
//!
//! ## 其余取舍
//!
//! 搜索结果不带时长（`length` 只在详情里有），所以搜索阶段 `duration_ms` 记 0，
//! 由详情的 `length`（形如 "00:03:02"）折成毫秒补齐。歌单搜索无简介，详情的
//! `summary` 则如实返回。曲目分页的空尾页会把 totalCount 置零，总数以元数据为准。

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, USER_AGENT};
use serde_json::Value;

use super::{
    bad_request, client, const_url, cred, https_url, parse_clock_ms, AccountInfo, ApiError,
    ApiResult, Ctx, OnlineDetail, OnlinePlaylist, OnlineTrack, PlaylistDetail, PlaylistSearchPage,
    ProfileMembership, SearchPage, SearchQuery, StreamInfo, TrackRef,
};

pub const ID: &str = "migu";

const SEARCH_URL: &str = "https://c.musicapp.migu.cn/v1.0/content/search_all.do";
const API_BASE: &str = "https://c.musicapp.migu.cn/";
const REFERER: &str = "https://music.migu.cn/v5/";
const PLAYLIST_PAGE_SIZE: usize = 50;
/// 与 ADR-0001 的通用上游文本预算一致；累计 chunk 时即拒绝，不先无限读入内存。
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
/// 官网 @migusdk-617e3513.js 的 J5[0]：公开的 JSON 信封种子，不是媒体密钥。
const ENVELOPE_SEED: &[u8] = b"Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP";
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

/// 只检查能作为请求头发送的凭据形状；不据此断言会话有效或账号具有会员权益。
pub(super) fn signed_in(pack: &cred::CredPack) -> bool {
    token_header(pack).is_some()
}

fn token_header(pack: &cred::CredPack) -> Option<HeaderValue> {
    let token = cred::cookie_field(&pack.cookie, "pacmtoken")?.trim();
    if token.is_empty()
        || matches!(token, "null" | "undefined")
        || !token.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return None;
    }
    let mut header = HeaderValue::from_str(token).ok()?;
    header.set_sensitive(true);
    Some(header)
}

/// 平台请求共用现有连接池；基址可由模块测试换成真实的本地 HTTP 服务。
/// 取流整次 20 秒期限仍由 online::stream 持有，不在每个请求上重新计时。
struct MiguApi {
    http: reqwest::Client,
    base: reqwest::Url,
    headers: HeaderMap,
}

impl MiguApi {
    fn new(pack: Option<&cred::CredPack>) -> ApiResult<Self> {
        let mut request_headers = headers();
        if let Some(token) = pack.and_then(token_header) {
            request_headers.insert(HeaderName::from_static("pacmtoken"), token);
        }
        Ok(Self {
            http: client()?,
            base: const_url(API_BASE)?,
            headers: request_headers,
        })
    }

    fn url(&self, path: &str, params: &[(&str, &str)]) -> ApiResult<reqwest::Url> {
        let mut url = self
            .base
            .join(path)
            .map_err(|_| ApiError::internal("咪咕接口地址无效"))?;
        url.query_pairs_mut().extend_pairs(params.iter().copied());
        Ok(url)
    }

    async fn json(&self, path: &str, params: &[(&str, &str)]) -> ApiResult<Value> {
        let response = self
            .http
            .get(self.url(path, params)?)
            .headers(self.headers.clone())
            .send()
            .await
            .map_err(super::http::send_error)?;
        let bytes = read_response(response).await?;
        serde_json::from_slice(&bytes)
            .map_err(|_| ApiError::upstream_rejected("咪咕接口未返回有效 JSON"))
    }

    async fn resource_info(&self, cid: &str) -> ApiResult<Value> {
        let body = self
            .json(
                "/v1.0/content/resourceinfo.do",
                &[("copyrightId", cid), ("resourceType", "2")],
            )
            .await?;
        check_code(&body)?;
        Ok(body
            .get("resource")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .cloned()
            .unwrap_or(Value::Null))
    }

    async fn account(&self) -> ApiResult<AccountInfo> {
        parse_account(&self.json("/user/h5/user-info/v1.0", &[]).await?)
    }

    async fn playlist_detail(
        &self,
        id: &str,
        offset: usize,
        limit: usize,
    ) -> ApiResult<PlaylistDetail> {
        let id = id.trim();
        if id.is_empty() {
            return Err(bad_request("缺少歌单 id"));
        }
        let body = self
            .json("/resource/playlist/v2.0", &[("playlistId", id)])
            .await?;
        let playlist = parse_playlist_metadata(&body)?;
        let total = playlist.track_count;
        let mut remaining = total
            .saturating_sub(offset as u64)
            .min(limit.clamp(1, 100) as u64) as usize;
        let mut tracks = Vec::with_capacity(remaining);
        let mut page = offset / PLAYLIST_PAGE_SIZE + 1;
        let mut skip = offset % PLAYLIST_PAGE_SIZE;
        while remaining > 0 {
            let page_no = page.to_string();
            let page_size = PLAYLIST_PAGE_SIZE.to_string();
            let body = self
                .json(
                    "/MIGUM3.0/resource/playlist/song/v2.0",
                    &[
                        ("playlistId", id),
                        ("pageNo", &page_no),
                        ("pageSize", &page_size),
                    ],
                )
                .await?;
            let songs = response_data(&body)?
                .get("songList")
                .and_then(Value::as_array)
                .ok_or_else(|| ApiError::upstream_rejected("咪咕未返回歌单曲目列表"))?;
            let take = remaining.min(songs.len().min(PLAYLIST_PAGE_SIZE).saturating_sub(skip));
            tracks.extend(
                songs
                    .iter()
                    .skip(skip)
                    .take(take)
                    .filter_map(map_playlist_track),
            );
            remaining -= take;
            if songs.len() < PLAYLIST_PAGE_SIZE || take == 0 {
                break;
            }
            page += 1;
            skip = 0;
        }
        Ok(PlaylistDetail {
            playlist,
            total,
            tracks,
        })
    }

    async fn stream(&self, cid: &str, track_ref: Option<&TrackRef>) -> ApiResult<StreamInfo> {
        let cid = cid.trim();
        if cid.is_empty() {
            return Err(bad_request("缺少曲目 id"));
        }
        let content_id = track_ref
            .filter(|reference| {
                reference
                    .get("copyrightId")
                    .and_then(val_string)
                    .is_none_or(|reference_id| reference_id == cid)
            })
            .and_then(|reference| reference.get("contentId"))
            .and_then(val_string)
            .filter(|value| !value.trim().is_empty());
        let content_id = match content_id {
            Some(content_id) => content_id,
            None => self
                .resource_info(cid)
                .await?
                .get("contentId")
                .and_then(val_string)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| ApiError::upstream_rejected("咪咕未返回该曲目的内容 ID"))?,
        };
        let url = self.url(
            "/strategy/pc/listen/v2.0",
            &[
                ("contentId", &content_id),
                ("copyrightId", cid),
                ("resourceType", "2"),
                ("netType", "01"),
                ("toneFlag", "PQ"),
                ("scene", ""),
            ],
        )?;
        let mut request_headers = self.headers.clone();
        request_headers.insert(
            HeaderName::from_static("birth"),
            HeaderValue::from_static("h5page"),
        );
        request_headers.insert(
            HeaderName::from_static("signature"),
            HeaderValue::from_static("1"),
        );
        request_headers.insert(
            reqwest::header::CONTENT_TYPE,
            HeaderValue::from_static("application/json;charset=UTF-8"),
        );
        let response = self
            .http
            .get(url)
            .headers(request_headers)
            .send()
            .await
            .map_err(super::http::send_error)?;
        parse_stream(&decode_envelope(&read_response(response).await?)?, cid)
    }
}

async fn read_response(mut response: reqwest::Response) -> ApiResult<Vec<u8>> {
    let status = response.status();
    if !status.is_success() {
        return Err(ApiError::upstream_rejected(format!(
            "咪咕接口返回 HTTP {status}"
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ApiError::upstream_rejected("咪咕接口响应超过 2 MiB 上限"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(super::http::read_error)? {
        if chunk.len() > MAX_RESPONSE_BYTES.saturating_sub(bytes.len()) {
            return Err(ApiError::upstream_rejected("咪咕接口响应超过 2 MiB 上限"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn decode_envelope(bytes: &[u8]) -> ApiResult<Value> {
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(ApiError::upstream_rejected("咪咕接口响应超过 2 MiB 上限"));
    }
    if bytes.len() <= 4 || bytes[..3] != [0xab, 0xcd, 0x01] {
        return Err(ApiError::upstream_rejected("咪咕取流响应信封无效或不完整"));
    }
    let offset = bytes[3];
    let decoded: Vec<u8> = bytes[4..]
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            byte.wrapping_add(offset)
                .wrapping_sub(ENVELOPE_SEED[index % ENVELOPE_SEED.len()])
        })
        .collect();
    serde_json::from_slice(&decoded)
        .map_err(|_| ApiError::upstream_rejected("咪咕取流响应不含有效 JSON"))
}

fn platform_error(code: Option<&str>) -> ApiError {
    match code {
        Some("290001") => ApiError::auth_required("请登录咪咕或重新导入有效 Cookie"),
        Some("440013") => ApiError::vip_required("咪咕要求该曲目具备会员播放权益（440013）"),
        _ => ApiError::upstream_rejected("咪咕未允许本次请求"),
    }
}

fn check_code(body: &Value) -> ApiResult<()> {
    match body.get("code").and_then(Value::as_str) {
        Some("000000") => Ok(()),
        code => Err(platform_error(code)),
    }
}

fn response_data(body: &Value) -> ApiResult<&Value> {
    check_code(body)?;
    body.get("data")
        .filter(|data| data.is_object())
        .ok_or_else(|| ApiError::upstream_rejected("咪咕接口缺少数据"))
}

fn parse_account(body: &Value) -> ApiResult<AccountInfo> {
    let data = response_data(body)?;
    data.get("userId")
        .and_then(val_string)
        .filter(|id| !id.trim().is_empty() && id.trim() != "0")
        .ok_or_else(|| ApiError::upstream_rejected("咪咕未返回有效账号信息"))?;
    Ok(AccountInfo {
        source: ID.into(),
        nickname: data
            .get("nickName")
            .and_then(val_string)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "咪咕音乐用户".into()),
        avatar: data
            .get("smallIcon")
            .and_then(Value::as_str)
            .and_then(image_url),
        membership: ProfileMembership::Unknown,
        vip_level: 0,
        vip_label: String::new(),
    })
}

fn parse_stream(body: &Value, cid: &str) -> ApiResult<StreamInfo> {
    let data = response_data(body)?;
    if let Some(value) = data.get("cannotCode").filter(|value| !value.is_null()) {
        let code = val_string(value)
            .ok_or_else(|| ApiError::upstream_rejected("咪咕返回了无效的播放权限状态"))?;
        if !matches!(code.trim(), "" | "0" | "000000") {
            return Err(platform_error(Some(&code)));
        }
    }
    let url = data
        .get("url")
        .and_then(Value::as_str)
        .and_then(web_url)
        .ok_or_else(|| ApiError::upstream_rejected("咪咕未返回可播放的普通音频地址"))?;
    Ok(StreamInfo {
        source: ID.into(),
        id: cid.into(),
        url: url.to_string(),
        bitrate: None,
        expires_in_secs: None,
        fallbacks: Vec::new(),
        rg_gain_db: None,
        rg_peak: None,
    })
}

fn web_url(value: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(value.trim()).ok()?;
    (matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

fn image_url(value: &str) -> Option<String> {
    let value = value.trim();
    let url = if value.starts_with('/') && !value.starts_with("//") {
        format!("https://d.musicapp.migu.cn{value}")
    } else {
        https_url(value)?
    };
    web_url(&url).map(|url| url.to_string())
}

pub async fn account(ctx: &Ctx) -> ApiResult<AccountInfo> {
    let pack = cred::get(&ctx.db, ID)
        .await
        .map_err(|_| ApiError::internal("读取咪咕凭据失败"))?
        .filter(signed_in)
        .ok_or_else(|| ApiError::auth_required("请先导入咪咕登录 Cookie"))?;
    MiguApi::new(Some(&pack))?.account().await
}

pub async fn playlist_detail(
    _ctx: &Ctx,
    id: &str,
    offset: usize,
    limit: usize,
) -> ApiResult<PlaylistDetail> {
    MiguApi::new(None)?.playlist_detail(id, offset, limit).await
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
/// 有稳定 ID 即可请求取流；vip_only 只是标准档标签，实际权限由 listen 裁决。
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
        playable: true,
        vip_only: standard_vip(item),
        track_ref: serde_json::json!({ "contentId": content_id, "copyrightId": cid }),
    })
}

fn has_vip(tags: Option<&Value>) -> bool {
    tags.and_then(Value::as_array)
        .is_some_and(|tags| tags.iter().any(|tag| tag.as_str() == Some("vip")))
}

fn standard_vip(item: &Value) -> bool {
    ["newRateFormats", "rateFormats"]
        .iter()
        .filter_map(|field| item.get(field).and_then(Value::as_array))
        .flatten()
        .find(|format| format.get("formatType").and_then(Value::as_str) == Some("PQ"))
        .map(|format| has_vip(format.get("showTag")))
        .unwrap_or_else(|| has_vip(item.get("showTag")))
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

fn parse_playlist_metadata(body: &Value) -> ApiResult<OnlinePlaylist> {
    let data = response_data(body)?;
    let id = data
        .get("musicListId")
        .and_then(val_string)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| ApiError::upstream_rejected("咪咕未返回歌单 ID"))?;
    let track_count = data
        .get("musicNum")
        .and_then(val_u64)
        .ok_or_else(|| ApiError::upstream_rejected("咪咕未返回歌单曲目总数"))?;
    Ok(OnlinePlaylist {
        source: ID.into(),
        id,
        name: data
            .get("title")
            .and_then(val_string)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "未知歌单".into()),
        cover: data
            .get("imgItem")
            .and_then(|item| item.get("img"))
            .and_then(Value::as_str)
            .and_then(image_url),
        track_count,
        play_count: data
            .get("opNumItem")
            .and_then(|item| item.get("playNum"))
            .and_then(val_u64),
        creator: data
            .get("ownerName")
            .and_then(val_string)
            .unwrap_or_default(),
        kind: "created".into(),
        description: data
            .get("summary")
            .and_then(val_string)
            .filter(|text| !text.trim().is_empty()),
    })
}

/// 歌单曲目和搜索 DTO 不同：duration 是秒，图片可能是 d.musicapp.migu.cn 相对路径。
fn map_playlist_track(item: &Value) -> Option<OnlineTrack> {
    let cid = item
        .get("copyrightId")
        .and_then(val_string)
        .filter(|id| !id.trim().is_empty())?;
    let content_id = item
        .get("contentId")
        .and_then(val_string)
        .unwrap_or_default();
    let song_id = item.get("songId").and_then(val_string).unwrap_or_default();
    Some(OnlineTrack {
        source: ID.into(),
        id: cid.clone(),
        title: item
            .get("songName")
            .and_then(val_string)
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| "未知曲目".into()),
        artist: join_singers(item.get("singerList")),
        album: item.get("album").and_then(val_string).unwrap_or_default(),
        duration_ms: item
            .get("duration")
            .and_then(val_u64)
            .unwrap_or(0)
            .saturating_mul(1000),
        cover: ["img3", "img2", "img1"]
            .iter()
            .find_map(|field| item.get(field).and_then(Value::as_str).and_then(image_url)),
        playable: true,
        vip_only: has_vip(item.get("showTags")),
        track_ref: serde_json::json!({"copyrightId": cid, "contentId": content_id, "songId": song_id}),
    })
}

// ---------------------------------------------------------------------------
// 详情 / 歌词
// ---------------------------------------------------------------------------

/// resourceinfo.do → resource[0]。缺分组时回 Null，由调用方决定怎么退。
async fn resource_info(cid: &str) -> ApiResult<Value> {
    MiguApi::new(None)?.resource_info(cid).await
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

/// 标准档普通音频。无 ref 的队列重播先补 contentId；凭据只供平台实际裁决权限。
pub async fn stream(
    ctx: &Ctx,
    id: &str,
    track_ref: Option<&TrackRef>,
    _quality: u32,
) -> ApiResult<StreamInfo> {
    if id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    let pack = cred::get(&ctx.db, ID)
        .await
        .map_err(|_| ApiError::internal("读取咪咕凭据失败"))?;
    MiguApi::new(pack.as_ref())?.stream(id, track_ref).await
}

#[cfg(test)]
#[path = "migu/tests.rs"]
mod protocol_tests;

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
        // ID 可以请求公开取流；会员权益仍由 listen 接口裁决。
        assert!(t.playable);
        // 优先取 03 大图并升 https。
        assert_eq!(t.cover.as_deref(), Some("https://img.migu.cn/l.jpg"));
        assert_eq!(
            t.track_ref.get("copyrightId").and_then(|v| v.as_str()),
            Some("600907000002816350")
        );
    }

    #[tokio::test]
    async fn stream_rejects_blank_id_before_reading_credentials() {
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .connect_lazy("sqlite::memory:")
            .expect("lazy sqlite pool");
        let ctx = Ctx { db };
        let err = stream(&ctx, "   ", None, 128_000).await.unwrap_err();
        assert_eq!(err.code, "bad_request");
    }

    #[test]
    fn requests_use_current_official_site() {
        assert_eq!(
            headers()[reqwest::header::REFERER],
            "https://music.migu.cn/v5/"
        );
    }

    #[test]
    fn search_marks_standard_quality_vip_without_assuming_membership() {
        let track = map_track(&serde_json::json!({
            "copyrightId": "60054701923", "name": "晴天",
            "rateFormats": [
                {"formatType": "PQ", "showTag": ["vip"]},
                {"formatType": "HQ"}
            ]
        }))
        .unwrap();
        assert!(track.vip_only);
        assert!(track.playable, "取流接口仍要能验证当前账号的真实权益");
    }
}
