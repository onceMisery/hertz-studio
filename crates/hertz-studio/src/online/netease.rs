// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 网易云音源。
//!
//! 用的是公开的 /api/search/get 与 /api/song/detail 接口，和网页端自己调的是
//! 同一套端点。游客会话使用 eapi、私人 FM 使用 weapi 参数封装；不处理加密音频。需要登录
//! 的场景由用户把自己账号的 cookie 填进设置，或走网页同款二维码登录，我们
//! 只是原样转发给网易云。
//!
//! 扫码登录与网页端同源（`unikey` → 二维码 → 轮询 `client/login`），密钥参数
//! 与凭据取法对齐公开的 NeteaseCloudMusicApi：`type=3`，确认后从这次轮询响应
//! 的 `Set-Cookie` 里整罐取 MUSIC_U/__csrf（详见 [`qr_create`] / [`qr_check`]）。

use std::collections::BTreeMap;
use std::time::Duration;

use reqwest::header::{HeaderValue, ACCEPT, CONTENT_TYPE};

use super::http::{absorb_cookies, cookie_string, merge_cookie};
use super::playlist_common::{created_playlist, form_map, require_playlist_name, require_tracks};
use super::{
    bad_request, client, https_url, AccountInfo, AlbumSearchPage, ApiError, ApiResult,
    ArtistSearchPage, Candidate, CollectionDetail, Ctx, OnlineAlbum, OnlineArtist, OnlineDetail,
    OnlinePlaylist, OnlineTrack, PlaylistDetail, PlaylistSearchPage, QrPayload, SearchPage,
    SearchQuery, StreamInfo, TrackEntry,
};

const ID: &str = "netease";
const W: &str = "https://music.163.com";

/// 详情接口。搜索结果里拿不到封面时用它成批补 `songs[].album.picUrl`。
const DETAIL_URL: &str = "https://music.163.com/api/song/detail";
/// 一次详情请求带的曲目数。搜索 limit 上限 60，因此最多两批。
const DETAIL_BATCH: usize = 40;
/// 补图失败后的重试间隔。上游限流是秒级的，250ms 足够错开同一瞬；再长就会把
/// 整次搜索的响应拖到用户能感觉出来的程度。
const COVER_RETRY_DELAY: Duration = Duration::from_millis(250);

/// 扫码登录的 `type` 参数。与网页端/公开 API 库同参：取 unikey 与轮询状态都
/// 带它，两个端点必须用同一个值（真机实测 1 与 3 都能取到 unikey，这里统一
/// 用 3 与参考实现保持一致）。
const QR_TYPE: &str = "3";

/// 分类浏览的候选项。搜索接口没有「按风格列歌」的公开端点，所以这里把分类名
/// 当关键词用——行为对用户是一致可预期的，而不是随机出结果。
pub const CATS: &[(&str, &str)] = &[
    ("hot", "热门"),
    ("new", "新歌"),
    ("rock", "摇滚"),
    ("electronic", "电子"),
    ("folk", "民谣"),
    ("jazz", "爵士"),
    ("classical", "古典"),
    ("acg", "ACG"),
];

const TERM_BY_CAT: &[(&str, &str)] = &[
    ("new", "新歌"),
    ("hot", "热门"),
    ("rock", "摇滚"),
    ("electronic", "电子"),
    ("folk", "民谣"),
    ("jazz", "爵士"),
    ("classical", "古典"),
    ("acg", "ACG"),
];

pub async fn search(ctx: &Ctx, q: &SearchQuery) -> ApiResult<SearchPage> {
    let keyword = q.q.clone().unwrap_or_default();
    let keyword = keyword.trim();

    let term = if !keyword.is_empty() {
        keyword.to_string()
    } else {
        match q.cat.as_deref() {
            Some("hot") | None => "热门".to_string(),
            Some(other) => TERM_BY_CAT
                .iter()
                .find(|(k, _)| *k == other)
                .map(|(_, v)| (*v).to_string())
                .unwrap_or_else(|| "热门".to_string()),
        }
    };

    let limit = q.limit.clamp(1, 60);
    let offset = q.offset.min(500);

    let body = search_get(ctx, &term, "1", limit, offset).await?;

    let songs = body
        .get("result")
        .and_then(|r| r.get("songs"))
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    let total = body
        .get("result")
        .and_then(|r| r.get("songCount"))
        .and_then(|v| v.as_u64())
        .unwrap_or(songs.len() as u64) as usize;

    let mut tracks = songs.iter().map(netease_track).collect::<Vec<_>>();
    fill_album_covers(ctx, &mut tracks).await;

    Ok(SearchPage {
        source: "netease".into(),
        keyword: term,
        total,
        tracks,
        warning: None,
    })
}

/// [`search`] 与歌手/专辑/歌单搜索共用的请求端：`/api/search/get` 网页同款
/// 公开接口，`type` 区分结果组（1 单曲 / 10 专辑 / 100 歌手 / 1000 歌单）。
/// 风控处理与单曲搜索逐字同源：code != 200 先按游客会话失效归类，登录态
/// 问题如实报 401，其余统一「上游拒绝」。
async fn search_get(
    ctx: &Ctx,
    term: &str,
    type_code: &str,
    limit: usize,
    offset: usize,
) -> ApiResult<serde_json::Value> {
    let cookie = visitor_cookie(ctx).await.unwrap_or(None);
    let mut req = client()?
        .get("https://music.163.com/api/search/get/")
        .query(&[
            ("s", term),
            ("type", type_code),
            ("limit", &limit.to_string()),
            ("offset", &offset.to_string()),
        ])
        .header("Referer", W)
        .header("Accept", "application/json");
    req = with_cookie(req, cookie.as_deref());

    let resp = req.send().await.map_err(super::http::send_error)?;

    if !resp.status().is_success() {
        return Err(ApiError::internal(format!("网易云返回 {}", resp.status())));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ApiError::internal(format!("网易云响应解析失败: {e}")))?;

    // 上游在触发风控时会返回 code != 200，或者干脆返回 HTML 登录页。
    let code = body.get("code").and_then(|v| v.as_i64()).unwrap_or(200);
    if code != 200 {
        invalidate_visitor(&body).await;
        expect_200(&body, "搜索")?;
        return Err(ApiError::internal(format!(
            "网易云拒绝了这次搜索（code {code}），稍后重试或换关键词"
        )));
    }
    Ok(body)
}

// ---------------------------------------------------------------------------
// 歌手 / 专辑 / 歌单搜索（与单曲搜索同一个端点，type 区分）
// ---------------------------------------------------------------------------

/// 关键词必答检查：分类浏览（cat）只有单曲搜索支持，歌手/专辑/歌单搜索
/// 没有分类语义，空关键词一律 400。
fn search_term(q: &SearchQuery) -> ApiResult<String> {
    let term = q.q.clone().unwrap_or_default();
    let term = term.trim();
    if term.is_empty() {
        return Err(bad_request("需要给出搜索关键词"));
    }
    Ok(term.to_string())
}

pub async fn search_artists(ctx: &Ctx, q: &SearchQuery) -> ApiResult<ArtistSearchPage> {
    let term = search_term(q)?;
    let limit = q.limit.clamp(1, 60);
    let offset = q.offset.min(500);
    let body = search_get(ctx, &term, "100", limit, offset).await?;

    let items = body
        .pointer("/result/artists")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let total = body
        .pointer("/result/artistCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(items.len() as u64) as usize;

    Ok(ArtistSearchPage {
        source: ID.into(),
        keyword: term,
        total,
        artists: items.iter().map(map_artist).collect(),
    })
}

/// 搜索结果的歌手条目。封面只认 `picUrl`（真人头像），`img1v1Url` 兜底；
/// 两者都是完整 URL，无「picId 拼不出来」的单曲封面问题。
fn map_artist(item: &serde_json::Value) -> OnlineArtist {
    let alias = item
        .get("alias")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("、")
        })
        .filter(|s| !s.is_empty());
    OnlineArtist {
        source: ID.into(),
        id: item
            .get("id")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            .to_string(),
        name: item
            .get("name")
            .and_then(|n| n.as_str())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or("未知歌手")
            .to_string(),
        alias,
        cover: item
            .get("picUrl")
            .or_else(|| item.get("img1v1Url"))
            .and_then(|v| v.as_str())
            .and_then(https_url),
        song_count: item.get("musicSize").and_then(|v| v.as_u64()),
    }
}

pub async fn search_albums(ctx: &Ctx, q: &SearchQuery) -> ApiResult<AlbumSearchPage> {
    let term = search_term(q)?;
    let limit = q.limit.clamp(1, 60);
    let offset = q.offset.min(500);
    let body = search_get(ctx, &term, "10", limit, offset).await?;

    let items = body
        .pointer("/result/albums")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let total = body
        .pointer("/result/albumCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(items.len() as u64) as usize;

    Ok(AlbumSearchPage {
        source: ID.into(),
        keyword: term,
        total,
        albums: items.iter().map(map_album).collect(),
    })
}

fn map_album(item: &serde_json::Value) -> OnlineAlbum {
    OnlineAlbum {
        source: ID.into(),
        id: item
            .get("id")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            .to_string(),
        name: item
            .get("name")
            .and_then(|n| n.as_str())
            .filter(|n| !n.trim().is_empty())
            .unwrap_or("未知专辑")
            .to_string(),
        artist: item
            .pointer("/artist/name")
            .and_then(|n| n.as_str())
            .unwrap_or("未知歌手")
            .to_string(),
        cover: item
            .get("picUrl")
            .and_then(|v| v.as_str())
            .and_then(https_url),
        track_count: item.get("size").and_then(|v| v.as_u64()),
        publish_time: item.get("publishTime").and_then(|v| v.as_u64()),
    }
}

/// 网易云公开歌单搜索（type=1000）。与咪咕的歌单搜索同契约：归一化成
/// [`OnlinePlaylist`]，kind 恒 "created"（搜索结果没有 created/collected 之别）。
pub async fn search_playlists(ctx: &Ctx, q: &SearchQuery) -> ApiResult<PlaylistSearchPage> {
    let term = search_term(q)?;
    let limit = q.limit.clamp(1, 60);
    let offset = q.offset.min(500);
    let body = search_get(ctx, &term, "1000", limit, offset).await?;

    let items = body
        .pointer("/result/playlists")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let total = body
        .pointer("/result/playlistCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(items.len() as u64) as usize;

    Ok(PlaylistSearchPage {
        source: ID.into(),
        keyword: term,
        total,
        playlists: items.iter().filter_map(map_public_playlist).collect(),
    })
}

fn map_public_playlist(item: &serde_json::Value) -> Option<OnlinePlaylist> {
    let id = item
        .get("id")
        .and_then(|v| v.as_i64())
        .filter(|v| *v > 0)
        .map(|v| v.to_string())?;
    let name = item
        .get("name")
        .and_then(|n| n.as_str())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or("未知歌单")
        .to_string();
    Some(OnlinePlaylist {
        source: ID.into(),
        id,
        name,
        cover: item
            .get("coverImgUrl")
            .and_then(|v| v.as_str())
            .and_then(https_url),
        track_count: item.get("trackCount").and_then(|v| v.as_u64()).unwrap_or(0),
        play_count: item.get("playCount").and_then(|v| v.as_u64()),
        creator: item
            .pointer("/creator/nickname")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string(),
        kind: "created".into(),
        description: None,
    })
}

// ---------------------------------------------------------------------------
// 歌手页 / 专辑页
// ---------------------------------------------------------------------------

/// 平台 id 只可能是正整数；先卡死字符集再拼进 URL path，防注入。
fn valid_platform_id(id: &str) -> ApiResult<&str> {
    let id = id.trim();
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad_request("id 只能是数字"));
    }
    Ok(id)
}

/// 歌手页：`/api/v1/artist/{id}` 一次给齐头部信息与热门歌曲（上游固定 50
/// 首封顶）。翻页在返回列表内本地切片；hotSongs 本身就是「热门歌曲」截断
/// 列表，没有「下一页」语义，more 恒 false。
pub async fn artist_songs(
    ctx: &Ctx,
    id: &str,
    limit: usize,
    offset: usize,
) -> ApiResult<CollectionDetail> {
    let id = valid_platform_id(id)?;
    let limit = limit.clamp(1, 100);
    let j = api_get(ctx, &format!("/api/v1/artist/{id}"), &[], false).await?;
    expect_200(&j, "获取网易云歌手页")?;

    let artist = j
        .get("artist")
        .filter(|v| !v.is_null())
        .ok_or_else(|| ApiError::upstream_rejected("网易云未返回歌手信息".to_string()))?;
    let songs = j
        .get("hotSongs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut tracks: Vec<OnlineTrack> = songs
        .iter()
        .map(netease_track)
        .filter(|t| !t.id.is_empty() && t.id != "0")
        .collect();
    fill_album_covers(ctx, &mut tracks).await;
    let total = tracks.len() as u64;
    let tracks = tracks
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();

    Ok(CollectionDetail {
        kind: "artist".into(),
        source: ID.into(),
        id: id.to_string(),
        name: artist
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("未知歌手")
            .to_string(),
        cover: artist
            .get("picUrl")
            .or_else(|| artist.get("img1v1Url"))
            .and_then(|v| v.as_str())
            .and_then(https_url),
        artist: None,
        total,
        more: false,
        tracks,
    })
}

/// 专辑页：`/api/v1/album/{id}` 返回专辑头 + 全部曲目，翻页在返回列表内
/// 本地切片（专辑曲目天然有界）。
pub async fn album_detail(
    ctx: &Ctx,
    id: &str,
    limit: usize,
    offset: usize,
) -> ApiResult<CollectionDetail> {
    let id = valid_platform_id(id)?;
    let limit = limit.clamp(1, 100);
    let j = api_get(ctx, &format!("/api/v1/album/{id}"), &[], false).await?;
    expect_200(&j, "获取网易云专辑详情")?;

    let album = j
        .get("album")
        .filter(|v| !v.is_null())
        .ok_or_else(|| ApiError::upstream_rejected("网易云未返回专辑详情".to_string()))?;
    let songs = j
        .get("songs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut tracks: Vec<OnlineTrack> = songs
        .iter()
        .map(netease_track)
        .filter(|t| !t.id.is_empty() && t.id != "0")
        .collect();
    fill_album_covers(ctx, &mut tracks).await;
    let total = tracks.len() as u64;
    let tracks = tracks
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<_>>();

    Ok(CollectionDetail {
        kind: "album".into(),
        source: ID.into(),
        id: id.to_string(),
        name: album
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("未知专辑")
            .to_string(),
        cover: album
            .get("picUrl")
            .and_then(|v| v.as_str())
            .and_then(https_url),
        artist: album
            .pointer("/artist/name")
            .and_then(|n| n.as_str())
            .map(str::to_string),
        total,
        more: false,
        tracks,
    })
}

fn netease_track(song: &serde_json::Value) -> OnlineTrack {
    let id = song
        .get("id")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        .to_string();
    let album = song
        .get("album")
        .or_else(|| song.get("al"))
        .and_then(|a| a.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    // 只认 `album.picUrl`。搜索接口绝大多数结果只带 `album.picId`（拼不出
    // URL），曾经拿 `artists[].img1v1Url` 兜底——但上游在搜索结果里给的是
    // **同一张默认头像**（实测每一条都是同一个 hash），结果整列曲目顶着一模
    // 一样的灰图，看着像"有封面"其实全是占位。所以这里宁可留 None，由
    // [`fill_album_covers`] 用详情接口补真图。
    let cover = song
        .get("album")
        .or_else(|| song.get("al"))
        .and_then(|a| a.get("picUrl"))
        .and_then(|n| n.as_str())
        .and_then(https_url);

    OnlineTrack {
        source: "netease".into(),
        id: id.clone(),
        title: song
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("未知曲目")
            .to_string(),
        artist: song_artists(song),
        album,
        duration_ms: song
            .get("duration")
            .or_else(|| song.get("dt"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cover,
        // 网易云对外链试听有版权限制，能不能播要等 /url 接口确认。
        // 这里统一标 true，实际播放时再报错，避免"看起来全不可点"。
        playable: true,
        vip_only: false,
        // 写操作（加歌/红心）只认数字 id，顺手放进 ref，dispatch 统一取它。
        track_ref: serde_json::json!({ "id": id }),
    }
}

/// 成批补齐搜索结果缺的专辑封面。
///
/// `/api/search/get` 只给 `album.picId`，而 picId 与封面 URL 之间那层加密不
/// 属于公开接口，不能自己拼；`/api/song/detail` 则直接给出 `album.picUrl`，
/// 且支持一次传多个 id。所以搜索后对缺封面的曲目补一次批量详情：一屏 30 首
/// 只要一个请求，成本远低于逐首问。
///
/// 补不到就保持原样——封面缺失不是搜索失败，不该让整次搜索报错，也不该把
/// 失败吞成"没封面"。失败只在日志里留痕；每一批先问一次、拿不到再问一次，
/// 重试的细节在 [`fetch_detail_covers`]。
async fn fill_album_covers(ctx: &Ctx, tracks: &mut [OnlineTrack]) {
    let ids = cover_gaps(tracks);
    if ids.is_empty() {
        return;
    }

    let client = match client() {
        Ok(c) => c,
        Err(_) => return,
    };
    let cookie = login_cookie(ctx).await;

    for chunk in ids.chunks(DETAIL_BATCH) {
        let ids = format!("[{}]", chunk.join(","));
        if !fetch_detail_covers(&client, cookie.as_deref(), &ids, tracks, DETAIL_URL).await {
            return;
        }
    }
}

/// 问一次歌曲详情并把 `songs[]` 回填进 `tracks`；没拿到就隔
/// [`COVER_RETRY_DELAY`] 再问一次，两次都不行才放弃这一批。返回是否拿到了回包。
///
/// 「没拿到」含三种：连接/请求失败、响应不是 JSON、以及**回包里根本没有
/// `songs`** —— 最后一种是网易云对这个端点限流时的实际形态（回 200 加一段
/// `code` 非 200 的 JSON），它一次重试就能过去；不重试的话整列曲目都顶着
/// 占位音符，而且只有重新搜索才会恢复。
async fn fetch_detail_covers(
    client: &reqwest::Client,
    cookie: Option<&str>,
    ids: &str,
    tracks: &mut [OnlineTrack],
    url: &str,
) -> bool {
    for attempt in 1..=2 {
        if attempt > 1 {
            tokio::time::sleep(COVER_RETRY_DELAY).await;
        }
        let req = client
            .get(url)
            .query(&[("ids", ids)])
            .header("Referer", W)
            .header("Accept", "application/json");
        let resp = match with_cookie(req, cookie).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!("封面补全：第 {attempt} 次请求歌曲详情失败: {e}");
                continue;
            }
        };
        let body: serde_json::Value = match resp.json().await {
            Ok(b) => b,
            Err(e) => {
                tracing::debug!("封面补全：第 {attempt} 次解析歌曲详情失败: {e}");
                continue;
            }
        };
        match body.get("songs").and_then(|s| s.as_array()) {
            Some(songs) => {
                apply_detail_covers(tracks, songs);
                return true;
            }
            None => continue,
        }
    }
    false
}

/// 哪些曲目需要补封面：缺封面且 id 合法（空串 / "0" 是解析失败的占位，
/// 拿它去问详情只会浪费一次请求）。
fn cover_gaps(tracks: &[OnlineTrack]) -> Vec<String> {
    tracks
        .iter()
        .filter(|t| t.cover.is_none() && !t.id.is_empty() && t.id != "0")
        .map(|t| t.id.clone())
        .collect()
}

/// 把 `/api/song/detail` 的 `songs[]` 按 id 回填专辑封面。
///
/// 只填空缺：已经有封面的曲目（搜索接口直接给了 picUrl）不被覆盖，避免详情
/// 接口偶发缺字段时把到手的封面清成 None。
fn apply_detail_covers(tracks: &mut [OnlineTrack], songs: &[serde_json::Value]) {
    for s in songs {
        let id = match s.get("id").and_then(|v| v.as_i64()) {
            Some(v) => v.to_string(),
            None => continue,
        };
        let pic = match s
            .pointer("/album/picUrl")
            .and_then(|v| v.as_str())
            .and_then(https_url)
        {
            Some(p) => p,
            None => continue,
        };
        if let Some(t) = tracks.iter_mut().find(|t| t.id == id && t.cover.is_none()) {
            t.cover = Some(pic);
        }
    }
}

fn song_artists(song: &serde_json::Value) -> String {
    song.get("artists")
        .or_else(|| song.get("ar"))
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn with_cookie(req: reqwest::RequestBuilder, cookie: Option<&str>) -> reqwest::RequestBuilder {
    match cookie {
        Some(value) => req.header("Cookie", value),
        None => req,
    }
}

/// 一档取流响应里的 `data[]` 条目。
///
/// `size`/`type` 以前被整个丢掉：容器名是阶梯降级时唯一的落盘旁证（首 32
/// 字节嗅不出来的话没有依据），码率则是诚实性校验的比较基准。
struct Rung {
    url: String,
    bitrate: Option<u64>,
    expires_in_secs: Option<u64>,
    container: Option<&'static str>,
    gain: Option<f64>,
    peak: Option<f64>,
}

/// 上游的容器名 → 本项目认得的扩展名。认不出返回 None，交给字节嗅探。
fn container_of(raw: &str) -> Option<&'static str> {
    match raw {
        "flac" => Some("flac"),
        "mp3" => Some("mp3"),
        "m4a" | "aac" => Some("m4a"),
        "ogg" => Some("ogg"),
        _ => None,
    }
}

/// 解析一个取流条目；没有可用地址返回 None（这一档空着，不是错误）。
fn parse_rung(entry: &serde_json::Value) -> Option<Rung> {
    let url = entry
        .get("url")
        .and_then(|u| u.as_str())
        .filter(|s| !s.is_empty())?;
    // 公开 api 用 `br`，eapi v1 用 `bitrate`，两个都要认。
    let bitrate = entry
        .get("br")
        .or_else(|| entry.get("bitrate"))
        .and_then(|v| v.as_u64());
    let container = entry
        .get("type")
        .and_then(|v| v.as_str())
        .and_then(container_of);
    // peak 为 0 或缺失视作没有，别拿 0 去做防削波的分母。
    let peak = entry
        .get("peak")
        .and_then(|v| v.as_f64())
        .filter(|p| *p > 0.0);
    Some(Rung {
        url: url.to_string(),
        bitrate,
        expires_in_secs: entry.get("expi").and_then(|v| v.as_u64()),
        container,
        gain: entry.get("gain").and_then(|v| v.as_f64()),
        peak,
    })
}

/// 请求码率 → eapi 的 `level` 名。档位判定复用 `quality::from_bitrate`，
/// 免得这里再写一套阈值跟档位表漂移。
fn level_for(quality: u32) -> &'static str {
    use super::quality::Quality;
    match super::quality::from_bitrate(Some(u64::from(quality))) {
        Some(Quality::Hires) => "hires",
        Some(Quality::Lossless) => "lossless",
        Some(Quality::Exhigh) => "exhigh",
        _ => "standard",
    }
}

/// eapi 封装：只加密 API 参数（AES-ECB + 固定摘要），不碰音频内容。
///
/// 摘要里的路径用 `/api/…` 形式，实际 POST 打到 `/eapi/…`，与游客会话
/// （[`visitor_cookie`]）用的是同一套签名。
async fn eapi(
    path: &str,
    data: serde_json::Value,
    cookie: Option<&str>,
) -> ApiResult<serde_json::Value> {
    let params = super::sign::netease::eapi(path, &data.to_string());
    let mut headers = super::http::headers(cookie, Some(W));
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    let url = format!(
        "https://interface.music.163.com/eapi{}",
        path.trim_start_matches("/api")
    );
    let (_, body) = super::http::post_json_with_headers(
        &client()?,
        &url,
        headers,
        form_urlencoded(&BTreeMap::from([("params".into(), params)])),
    )
    .await?;
    Ok(body)
}

/// 公开 api 一次请求：游客 cookie 即可，但码率到 320k 封顶。
async fn api_rung(id: &str, quality: u32, cookie: Option<&str>) -> ApiResult<Option<Rung>> {
    let client = client()?;
    let req = client
        .get("https://music.163.com/api/song/enhance/player/url")
        .query(&[("ids", &format!("[{id}]")), ("br", &quality.to_string())])
        .header("Referer", W);
    let resp = with_cookie(req, cookie)
        .send()
        .await
        .map_err(super::http::send_error)?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ApiError::internal(format!("试听响应解析失败: {e}")))?;

    invalidate_visitor(&body).await;
    if body.get("code").is_some() {
        expect_200(&body, "获取音频")?;
    }
    let entry = body
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| ApiError::internal("上游未返回试听信息".to_string()))?;
    Ok(parse_rung(entry))
}

/// eapi 取流：显式声明 `level` 与 `encodeType`，无损/Hi-Res 只有这条路会给。
async fn eapi_rung(id: &str, level: &str, cookie: Option<&str>) -> ApiResult<Option<Rung>> {
    // header 沿用 minting 这个游客会话时的那套身份（os/appver 一致），
    // 只换 requestId：换一个设备身份等于用另一台设备去要这条流。
    let header = serde_json::json!({
        "os": "ios",
        "appver": "8.20.21",
        "osver": "",
        "deviceId": "",
        "__csrf": "",
        "requestId": uuid::Uuid::new_v4().simple().to_string(),
    });
    let data = serde_json::json!({
        "ids": format!("[\"{id}\"]"),
        "level": level,
        "encodeType": if level == "lossless" || level == "hires" { "flac" } else { "mp3" },
        "header": header,
        "e_r": false,
    });
    let body = eapi("/api/song/enhance/player/url/v1", data, cookie).await?;
    invalidate_visitor(&body).await;
    if body.get("code").is_some() {
        expect_200(&body, "获取音频")?;
    }
    Ok(body
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
        .and_then(parse_rung))
}

pub async fn stream(ctx: &Ctx, id: &str, quality: u32) -> ApiResult<StreamInfo> {
    let cookie = visitor_cookie(ctx).await.unwrap_or(None);
    let api = api_rung(id, quality, cookie.as_deref()).await?;
    // 无损/Hi-Res 得问 eapi（公开 api 封顶 320k）；api 空手而归时也用它兜一次。
    // 上游请求就到此为止：最多两次，绝不为每个候选各打一次网易的接口。
    let eapi = if quality >= 600_000 || api.is_none() {
        match eapi_rung(id, level_for(quality), cookie.as_deref()).await {
            Ok(rung) => rung,
            // eapi 失败不毁掉已经到手的 api 地址；但原因要留下，这类
            // 「游客身份能不能走 eapi」只能靠线上日志判断。
            Err(e) => {
                crate::diaglog!(
                    "netease.eapi_fail",
                    id = id,
                    level = level_for(quality),
                    reason = e.message
                );
                None
            }
        }
    } else {
        None
    };

    let mut rungs: Vec<Rung> = [api, eapi].into_iter().flatten().collect();
    // 声明码率高的排前面：阶梯只会向下降级，反过来等于把无损让给 128k。
    rungs.sort_by_key(|r| std::cmp::Reverse(r.bitrate.unwrap_or(0)));
    ladder_from(id, rungs)
}

/// 把各路取流结果组成阶梯：调用方给的顺序即音质从高到低，第一个是主地址，
/// 其余进 `fallbacks`（各带自己的码率与容器，降级后档位标注才有依据）。
///
/// 排序留在 `stream` 里（那里才知道各上游字段的可信度），这里只管组装与空手
/// 而归的错误文案。
fn ladder_from(id: &str, mut rungs: Vec<Rung>) -> ApiResult<StreamInfo> {
    if rungs.is_empty() {
        return Err(ApiError::upstream_rejected(
            "这首歌暂无可用音频，可能受版权、地区或账号权益限制；可换一首或登录后重试",
        ));
    }
    let head = rungs.remove(0);
    let fallbacks: Vec<Candidate> = rungs
        .into_iter()
        .map(|r| Candidate {
            url: r.url,
            bitrate: r.bitrate,
            container: r.container,
            referer: None,
        })
        .collect();

    // 响度标签随取流一起给，语义与本地曲的 ReplayGain 一致：`gain` 是 dB、
    // `peak` 是线性峰值。实测只有公开 api 那条返回 gain/peak，eapi 档没有
    // 就是 None —— 不猜、不派生。
    Ok(StreamInfo {
        url: head.url,
        source: ID.into(),
        id: id.to_string(),
        bitrate: head.bitrate,
        expires_in_secs: head.expires_in_secs,
        fallbacks,
        rg_gain_db: head.gain,
        rg_peak: head.peak,
    })
}

/// 单曲详情。搜索接口返回的字段不全（尤其是封面），播放前用它补齐。
pub async fn detail(ctx: &Ctx, id: &str) -> ApiResult<OnlineDetail> {
    let cookie = login_cookie(ctx).await;
    let client = client()?;
    let req = client
        .get("https://music.163.com/api/song/detail")
        .query(&[("ids", &format!("[{id}]"))])
        .header("Referer", "https://music.163.com");
    let resp = with_cookie(req, cookie.as_deref())
        .send()
        .await
        .map_err(|e| ApiError::internal(format!("获取歌曲详情失败: {e}")))?;
    if !resp.status().is_success() {
        return Err(ApiError::internal(format!(
            "歌曲详情接口返回 HTTP {}",
            resp.status()
        )));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ApiError::internal(format!("解析歌曲详情失败: {e}")))?;

    let song = body
        .get("songs")
        .and_then(|s| s.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| ApiError::internal("歌曲详情里没有这首".to_string()))?;

    // 专辑封面优先；拿不到就退回艺人头像，再拿不到就交给前端画占位图。
    let cover = song
        .get("album")
        .or_else(|| song.get("al"))
        .and_then(|a| a.get("picUrl"))
        .and_then(|v| v.as_str())
        .and_then(https_url)
        .or_else(|| {
            song.get("artists")
                .or_else(|| song.get("ar"))
                .and_then(|a| a.as_array())
                .and_then(|arr| arr.first())
                .and_then(|a| a.get("img1v1Url").or_else(|| a.get("picUrl")))
                .and_then(|v| v.as_str())
                .and_then(https_url)
        });

    Ok(OnlineDetail {
        source: "netease".into(),
        id: id.to_string(),
        title: song
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("未知曲目")
            .to_string(),
        artist: song_artists(song),
        album: song
            .get("album")
            .or_else(|| song.get("al"))
            .and_then(|a| a.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        duration_ms: song
            .get("duration")
            .or_else(|| song.get("dt"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cover,
    })
}

pub async fn lyric(ctx: &Ctx, id: &str) -> ApiResult<vmusic_core::LyricDocument> {
    let cookie = login_cookie(ctx).await;
    let client = client()?;
    let req = client
        .get("https://music.163.com/api/song/lyric")
        .query(&[("id", id), ("lv", "1"), ("kv", "1"), ("tv", "-1")])
        .header("Referer", "https://music.163.com");
    let resp = with_cookie(req, cookie.as_deref())
        .send()
        .await
        .map_err(|e| ApiError::internal(format!("获取歌词失败: {e}")))?;
    if !resp.status().is_success() {
        return Err(ApiError::internal(format!(
            "歌词接口返回 HTTP {}",
            resp.status()
        )));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ApiError::internal(format!("解析歌词失败: {e}")))?;

    // 翻译歌词（tlyric，tv=-1 已随请求带回）：不混进 LRC 文本（那会把同刻
    // 译文行读进时间轴、毁掉逐字扫色的词级结构），走 LyricDocument.translation
    // 平行数组——overlay API 已按行透传该字段。对齐必须在 apply_offset 之前
    // （原始时间轴两侧一致；偏移后 translation 按下标跟随，无需再平移）。
    let text = body
        .get("lrc")
        .and_then(|l| l.get("lyric"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if text.trim().is_empty() {
        return Ok(vmusic_core::LyricDocument::empty());
    }

    let mut doc = vmusic_lyrics::parse_lrc(&text);
    if let Some(tlyric) = body
        .get("tlyric")
        .and_then(|t| t.get("lyric"))
        .and_then(|v| v.as_str())
    {
        doc.translation = vmusic_lyrics::align_translation(&doc, tlyric);
    }
    vmusic_lyrics::apply_offset(&mut doc);
    Ok(doc)
}

// ===========================================================================
// Task 12：账号 / 用户歌单 / 歌单详情 / 二维码登录 / 写操作 / 推荐
//
// 全部走公开网页端点（spec §2.1）：Referer 固定 https://music.163.com，
// POST 为 application/x-www-form-urlencoded，__csrf（从 cookie 取）同时进
// query 与表单体。不实现 weapi/eapi 加密；登录靠用户自己的 cookie 或同款
// 网页二维码。账号体系统一走 cred 保险库（旧的裸 cookie 键读取时自动回落）。
// ===========================================================================

/// 取登录 cookie（新 cred 保险库优先，旧键自动回落）；未登录返回 None。
async fn login_cookie(ctx: &Ctx) -> Option<String> {
    super::cred::get(&ctx.db, ID)
        .await
        .ok()
        .flatten()
        .map(|p| p.cookie)
        .filter(|s| !s.trim().is_empty())
}

// 游客会话与账号保险库分离，进程退出即清空；串行申请避免并发搜索重复注册。
static VISITOR: tokio::sync::Mutex<Option<(std::time::Instant, Option<String>)>> =
    tokio::sync::Mutex::const_new(None);

async fn invalidate_visitor(body: &serde_json::Value) {
    if matches!(body["code"].as_i64(), Some(301 | 401 | 403 | -462)) {
        *VISITOR.lock().await = None;
    }
}

fn visitor_ttl(cookie: &Option<String>) -> std::time::Duration {
    std::time::Duration::from_secs(if cookie.is_some() { 3600 } else { 30 })
}

#[test]
fn visitor_lifetime_and_modern_track_fields() {
    assert_eq!(visitor_ttl(&None).as_secs(), 30);
    assert_eq!(visitor_ttl(&Some("MUSIC_A=fixture".into())).as_secs(), 3600);
    let song = netease_track(
        &serde_json::json!({"id":1,"name":"Song","ar":[{"name":"Artist"}],"al":{"name":"Album","picUrl":"https://example.com/cover.jpg"},"dt":123456}),
    );
    assert_eq!(song.artist, "Artist");
    assert_eq!(song.album, "Album");
    assert_eq!(song.duration_ms, 123456);
    assert!(song.cover.is_some());
}

async fn weapi(
    path: &str,
    mut data: serde_json::Value,
    cookie: Option<&str>,
) -> ApiResult<(reqwest::header::HeaderMap, serde_json::Value)> {
    let csrf = cookie
        .unwrap_or("")
        .split(';')
        .find_map(|s| s.trim().strip_prefix("__csrf="))
        .unwrap_or("");
    data["csrf_token"] = csrf.into();
    let key = super::sign::kugou_login::random_key();
    let (params, secret) = super::sign::netease::weapi(&data.to_string(), &key);
    let form = BTreeMap::from([("params".into(), params), ("encSecKey".into(), secret)]);
    let mut headers = super::http::headers(cookie, Some(W));
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    super::http::post_json_with_headers(
        &client()?,
        &format!("{W}/weapi/{path}"),
        headers,
        form_urlencoded(&form),
    )
    .await
}

async fn visitor_cookie(ctx: &Ctx) -> ApiResult<Option<String>> {
    if let Some(cookie) = login_cookie(ctx).await {
        return Ok(Some(cookie));
    }
    let mut cache = VISITOR.lock().await;
    if let Some((created, cookie)) = cache.as_ref() {
        if created.elapsed() < visitor_ttl(cookie) {
            return Ok(cookie.clone());
        }
    }
    *cache = Some((std::time::Instant::now(), None));
    let device = uuid::Uuid::new_v4().simple().to_string();
    let header = serde_json::json!({"os":"ios","appver":"8.20.21","deviceId":device,"versioncode":"140","resolution":"1920x1080","__csrf":"","requestId":uuid::Uuid::new_v4().simple().to_string()});
    let data = serde_json::json!({"username": super::sign::netease::anonymous_username(&device),"header":header,"e_r":false});
    let params = super::sign::netease::eapi("/api/register/anonimous", &data.to_string());
    let mut h = super::http::headers(Some("os=ios; appver=8.20.21"), Some(W));
    h.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    let (headers, body) = super::http::post_json_with_headers(
        &client()?,
        "https://interface.music.163.com/eapi/register/anonimous",
        h,
        form_urlencoded(&BTreeMap::from([("params".into(), params)])),
    )
    .await?;
    expect_200(&body, "游客会话")?;
    let mut cookies = BTreeMap::new();
    absorb_cookies(&headers, &mut cookies);
    let cookie = cookie_string(&cookies);
    if !cookies.contains_key("MUSIC_A") {
        return Err(ApiError::upstream_rejected("网易云未返回游客会话"));
    }
    *cache = Some((std::time::Instant::now(), Some(cookie.clone())));
    Ok(Some(cookie))
}

pub async fn personal_fm(ctx: &Ctx) -> ApiResult<Vec<OnlineTrack>> {
    let cookie = visitor_cookie(ctx).await?;
    let (_, body) = weapi(
        "v1/radio/get",
        serde_json::json!({"limit": 3}),
        cookie.as_deref(),
    )
    .await?;
    invalidate_visitor(&body).await;
    expect_200(&body, "私人 FM")?;
    let tracks: Vec<_> = body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["id"].as_i64().is_some_and(|id| id > 0))
        .take(20)
        .map(netease_track)
        .collect();
    if tracks.is_empty() {
        return Err(ApiError::upstream_rejected(
            "私人 FM 暂未返回歌曲，请稍后重试",
        ));
    }
    Ok(tracks)
}

/// 要求已登录（cookie 含 MUSIC_U），否则 401。
async fn login_pack(ctx: &Ctx) -> ApiResult<super::cred::CredPack> {
    let pack = super::cred::get(&ctx.db, ID)
        .await
        .map_err(|e| ApiError::internal(format!("读取网易云凭据失败: {e}")))?
        .unwrap_or_default();
    if super::cred::is_signed_in(ID, &pack) {
        Ok(pack)
    } else {
        Err(ApiError::auth_required(
            "需要先登录网易云音乐（扫码或手动填写 cookie）".to_string(),
        ))
    }
}

/// 拼 W 站点下的绝对 URL 并附带 query（走 Url 编码器，中文/特殊字符不裸奔）。
fn api_url(path: &str, query: &[(&str, &str)]) -> ApiResult<String> {
    let mut u = reqwest::Url::parse(W)
        .and_then(|u| u.join(path))
        .map_err(|e| ApiError::internal(format!("网易云地址无效: {e}")))?;
    {
        let mut q = u.query_pairs_mut();
        for (k, v) in query {
            q.append_pair(k, v);
        }
    }
    Ok(u.to_string())
}

/// 与 QQ 模块同形态的表单编码：复用 Url 的 query_pairs，不引新依赖。
fn form_urlencoded(form: &BTreeMap<String, String>) -> String {
    // unwrap 安全：常量字面量，解析结果恒定；改成 Result 会把纯编码器签名
    // 污染成 ApiResult。真正的网络站点已走 const_url 降级。
    let mut u = reqwest::Url::parse("https://local.invalid/").unwrap();
    u.query_pairs_mut()
        .extend_pairs(form.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    u.query().unwrap_or("").to_string()
}

/// 网易云业务 code 判定：200 成功；301/-462 = 未登录；400 是请求参数问题；
/// -460 是风控（Cheating）；其余（含 302、缺 code）一律上游拒绝。摘要只带
/// code，不回显整包。
fn expect_200(j: &serde_json::Value, what: &str) -> ApiResult<()> {
    match j.get("code").and_then(|c| c.as_i64()) {
        Some(200) => Ok(()),
        // 301 未登录、-462 登录过期，才是登录态问题（前端据此弹登录引导）。
        Some(301) | Some(-462) => Err(ApiError::auth_required(format!(
            "{what}需要先登录网易云音乐"
        ))),
        Some(400) => Err(bad_request(format!("{what}的请求参数有误"))),
        // -460 是网易风控（响应体常带 "Cheating"/网络拥挤），不是没登录：归 502
        // 才会被 spec §2.4 的连续 502 熔断统计到，也不会误导用户反复重登。
        Some(-460) => Err(ApiError::upstream_rejected(format!(
            "{what}触发网易云风控，稍后再试"
        ))),
        // 302 在网易云业务码里没有登录态语义（HTTP 3xx 在传输层已归 502），
        // 与其他未知码一律按上游拒绝处理，绝不猜成 401。
        Some(c) => Err(ApiError::upstream_rejected(format!(
            "{what}失败（code={c}）"
        ))),
        None => Err(ApiError::upstream_rejected(format!(
            "{what}失败：上游响应缺少 code"
        ))),
    }
}

/// GET JSON：require_auth=true 时先过登录闸门；调用方再自行做 code 判定。
async fn api_get(
    ctx: &Ctx,
    path: &str,
    query: &[(&str, &str)],
    require_auth: bool,
) -> ApiResult<serde_json::Value> {
    let pack = if require_auth {
        Some(login_pack(ctx).await?)
    } else {
        super::cred::get(&ctx.db, ID)
            .await
            .map_err(|e| ApiError::internal(format!("读取网易云凭据失败: {e}")))?
    };
    let url = api_url(path, query)?;
    let mut h = super::http::headers(pack.as_ref().map(|p| p.cookie.as_str()), Some(W));
    h.insert(ACCEPT, HeaderValue::from_static("application/json"));
    super::http::get_json(&client()?, &url, h).await
}

/// 登录态表单 POST：csrf_token 同时进 query 和表单体（网页端校验两者一致）。
/// 返回的 JSON 已通过 code==200 严格判定——写操作缺 code/非 200 绝不报成功。
async fn api_post(
    ctx: &Ctx,
    path: &str,
    form: &BTreeMap<String, String>,
) -> ApiResult<serde_json::Value> {
    let pack = login_pack(ctx).await?;
    let csrf = super::cred::cookie_field(&pack.cookie, "__csrf").unwrap_or("");
    if csrf.is_empty() {
        // 写操作没有 __csrf 必败（query 与表单体都要它），与其发一次注定被拒的
        // 请求，不如明确告诉用户凭据不完整——判 401，引导重新扫码/粘贴完整 cookie。
        return Err(ApiError::auth_required(
            "网易云登录凭据不完整（缺少 __csrf），请重新扫码或粘贴完整 cookie".to_string(),
        ));
    }
    let mut pairs = form.clone();
    pairs.insert("csrf_token".to_string(), csrf.to_string());
    let url = api_url(path, &[("csrf_token", csrf)])?;
    let mut h = super::http::headers(Some(pack.cookie.as_str()), Some(W));
    h.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    let j = super::http::post_json(&client()?, &url, h, form_urlencoded(&pairs)).await?;
    expect_200(&j, "网易云写操作")?;
    Ok(j)
}

/// v6 系列歌单接口的曲目形态（ar/al/dt），与搜索接口的 artists/album/duration
/// 不同，单独归一化。fee==1 是 VIP 曲（4=数字专辑购买，同样标灰）。
fn v6_track(song: &serde_json::Value) -> OnlineTrack {
    let id = song
        .get("id")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        .to_string();
    let artist = song
        .get("ar")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let album = song
        .pointer("/al/name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cover = song
        .pointer("/al/picUrl")
        .and_then(|v| v.as_str())
        .and_then(https_url);
    let fee = song.get("fee").and_then(|v| v.as_i64()).unwrap_or(0);
    OnlineTrack {
        source: ID.into(),
        id: id.clone(),
        title: song
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("未知曲目")
            .to_string(),
        artist,
        album,
        duration_ms: song.get("dt").and_then(|v| v.as_u64()).unwrap_or(0),
        cover,
        playable: !id.is_empty() && id != "0",
        vip_only: matches!(fee, 1 | 4),
        track_ref: serde_json::json!({ "id": id }),
    }
}

/// 用户歌单项（user/playlist 与 v6/detail 的 playlist 头字段基本同形）。
/// `uid` 是当前登录用户：创建者是自己 → created（红心歌单单列 liked），
/// 否则 collected。红心歌单优先认上游稳定字段 `specialType==5`，名字含
/// 「我喜欢」只作兜底（老接口/脏数据可能缺 specialType）。
fn map_user_playlist(item: &serde_json::Value, uid: i64) -> OnlinePlaylist {
    let id = item
        .get("id")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        .to_string();
    let name = item
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let is_liked =
        item.get("specialType").and_then(|v| v.as_i64()) == Some(5) || name.contains("我喜欢");
    let kind = if is_liked {
        "liked"
    } else if item
        .pointer("/creator/userId")
        .and_then(|v| v.as_i64())
        .is_some_and(|c| c == uid)
    {
        "created"
    } else {
        "collected"
    };
    OnlinePlaylist {
        source: ID.into(),
        id,
        name,
        cover: item
            .get("coverImgUrl")
            .or_else(|| item.get("coverImgurl"))
            .and_then(|v| v.as_str())
            .and_then(https_url),
        track_count: item.get("trackCount").and_then(|v| v.as_u64()).unwrap_or(0),
        play_count: item.get("playCount").and_then(|v| v.as_u64()),
        creator: item
            .pointer("/creator/nickname")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        kind: kind.into(),
        description: None,
    }
}

/// 账号信息：`/api/nuser/account/get` 的 profile。
pub async fn account(ctx: &Ctx) -> ApiResult<AccountInfo> {
    let j = api_get(ctx, "/api/nuser/account/get", &[], true).await?;
    expect_200(&j, "获取网易云账号信息")?;
    // code 200 却没有 profile 属于畸形响应，不能误报「未登录」（真未登录的
    // 301/-462 已在 expect_200 归 401）。
    let p = j
        .pointer("/profile")
        .filter(|v| !v.is_null())
        .ok_or_else(|| ApiError::upstream_rejected("网易云账号响应缺少 profile".to_string()))?;
    let vip_level = p
        .get("vipType")
        .or_else(|| p.get("vipTypeCode"))
        .and_then(|v| v.as_u64());
    let membership = super::ProfileMembership::from_level(vip_level);
    let vip_level = vip_level.and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
    Ok(AccountInfo {
        source: ID.into(),
        nickname: p
            .get("nickname")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        avatar: p
            .get("avatarUrl")
            .and_then(|v| v.as_str())
            .and_then(https_url),
        membership,
        vip_level,
        vip_label: if vip_level > 0 {
            "VIP".to_string()
        } else {
            String::new()
        },
    })
}

/// 用户歌单：`/api/user/playlist?uid=`。uid 来自账号接口；创建单/收藏单/
/// 我喜欢在同一个端点里混合返回（创建单通常排在前面），上游不支持按 scope
/// 过滤。所以这里按 100/页循环拉取（上限 1000 项，覆盖正常账号并保证有界），
/// 本地 retain 出 scope 后再做 offset/limit 切片——直接把前端分页透传会让
/// collected 的第一页被创建单占满、过滤后成空页。
pub async fn playlists(
    ctx: &Ctx,
    scope: &str,
    offset: usize,
    limit: usize,
) -> ApiResult<Vec<OnlinePlaylist>> {
    // 账号接口本身需登录，api_get(..., true) 已过登录闸门，不用再单独 gate。
    let acc = api_get(ctx, "/api/nuser/account/get", &[], true).await?;
    expect_200(&acc, "获取网易云账号信息")?;
    let uid = acc
        .pointer("/profile/userId")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| ApiError::auth_required("未能取得网易云用户 uid".to_string()))?;
    let limit = limit.clamp(1, 100);

    const PAGE: usize = 100;
    const MAX_FETCHED: usize = 1000;
    let mut fetched = 0usize;
    let mut all: Vec<OnlinePlaylist> = Vec::new();
    loop {
        let q: &[(&str, &str)] = &[
            ("uid", &uid.to_string()),
            ("limit", &PAGE.to_string()),
            ("offset", &fetched.to_string()),
            // include=true：网页端默认携带，连同收藏信息一起返回。
            ("include", "true"),
        ];
        let j = api_get(ctx, "/api/user/playlist", q, true).await?;
        expect_200(&j, "获取网易云歌单")?;
        // code 200 但缺 playlist 字段是畸形响应，按上游拒绝处理，不能表达成
        // 「用户没有歌单」的空成功；空数组才是合法的空列表。
        let arr = j
            .get("playlist")
            .and_then(|v| v.as_array())
            .ok_or_else(|| ApiError::upstream_rejected("网易云未返回歌单列表".to_string()))?;
        let got = arr.len();
        for item in arr {
            let pl = map_user_playlist(item, uid);
            if !pl.id.is_empty() && pl.id != "0" {
                all.push(pl);
            }
        }
        fetched = fetched.saturating_add(got);
        // 短页即到尾；到上限也停，极端大账号不再无限翻页。
        if got < PAGE || fetched >= MAX_FETCHED {
            break;
        }
    }
    all.retain(|pl| match scope {
        "created" => pl.kind == "created",
        "collected" => pl.kind == "collected",
        "liked" => pl.kind == "liked",
        _ => true,
    });
    Ok(all.into_iter().skip(offset).take(limit).collect())
}

/// 歌单 id 非空校验（trim 后）；网易云的详情与各写操作共用同一句缺参文案。
fn require_id(id: &str) -> ApiResult<&str> {
    let id = id.trim();
    if id.is_empty() {
        return Err(bad_request("缺少网易云歌单 id"));
    }
    Ok(id)
}

/// 歌单详情：`/api/v6/playlist/detail`（n=1000）。1000 首以内曲目随详情一次
/// 返回，内部按 offset/limit 切片；超过 1000 的大歌单走 `/track/all` 补取，
/// 对前端始终是统一分页（spec §2.1）。
pub async fn playlist_detail(
    ctx: &Ctx,
    id: &str,
    offset: usize,
    limit: usize,
) -> ApiResult<PlaylistDetail> {
    let id = require_id(id)?;
    let limit = limit.clamp(1, 100);
    // 歌单详情匿名可访问（公开歌单）；私密歌单上游会回登录码，由 expect_200 归类。
    let j = api_get(
        ctx,
        "/api/v6/playlist/detail",
        &[("id", id), ("n", "1000")],
        false,
    )
    .await?;
    expect_200(&j, "获取网易云歌单详情")?;
    let pl = j
        .pointer("/playlist")
        .filter(|v| !v.is_null())
        .ok_or_else(|| ApiError::upstream_rejected("网易云未返回歌单详情".to_string()))?;
    let total = pl.get("trackCount").and_then(|v| v.as_u64()).unwrap_or(0);
    let mut playlist = map_user_playlist(pl, 0);
    playlist.source = ID.into();
    playlist.id = id.to_string();
    // kind 已由 map_user_playlist 按 specialType==5（名字兜底）判定；详情接口
    // 里自己的 uid 未知，自建单会落成 collected，但详情页不展示 kind 徽章，不纠结。

    let head: Vec<&serde_json::Value> = pl
        .get("tracks")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let total_as = usize::try_from(total).unwrap_or(usize::MAX);
    let tracks: Vec<OnlineTrack> = if total_as <= head.len() {
        // 小歌单：直接对详情里的 tracks 本地分页。先滤掉幽灵曲再切片，避免
        // 窗口内的脏 id 占掉页大小导致本页少曲。
        head.into_iter()
            .map(v6_track)
            .filter(|t| !t.id.is_empty() && t.id != "0")
            .skip(offset)
            .take(limit)
            .collect()
    } else {
        // 大歌单（>1000）：用 track/all 按请求窗口补取。
        let q: &[(&str, &str)] = &[
            ("id", id),
            ("limit", &limit.to_string()),
            ("offset", &offset.to_string()),
        ];
        let aj = api_get(ctx, "/api/v6/playlist/track/all", q, false).await?;
        expect_200(&aj, "获取网易云歌单全部曲目")?;
        // code 200 但缺 songs 字段是畸形响应：此时 total>0，绝不能回「空歌单」
        // 的假成功（空数组才是合法空页）。
        let songs = aj
            .get("songs")
            .and_then(|v| v.as_array())
            .ok_or_else(|| ApiError::upstream_rejected("网易云未返回歌单曲目".to_string()))?;
        songs
            .iter()
            .map(v6_track)
            .filter(|t| !t.id.is_empty() && t.id != "0")
            .collect()
    };

    Ok(PlaylistDetail {
        playlist,
        total,
        tracks,
    })
}

/// 新建歌单：POST /api/playlist/create。成功回包顶层或 playlist.id 给新 id。
pub async fn playlist_create(ctx: &Ctx, name: &str) -> ApiResult<OnlinePlaylist> {
    let name = require_playlist_name(name)?;
    // 0 公开。
    let form = form_map(&[("name", name), ("privacy", "0")]);
    let j = api_post(ctx, "/api/playlist/create", &form).await?;
    let id = j
        .get("id")
        .or_else(|| j.pointer("/playlist/id"))
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0)
        .map(|n| n.to_string())
        .ok_or_else(|| ApiError::upstream_rejected("创建成功但未取得歌单 id".to_string()))?;
    Ok(created_playlist(ID, id, name))
}

/// 删除歌单：POST /api/playlist/delete。
pub async fn playlist_delete(ctx: &Ctx, id: &str) -> ApiResult<()> {
    let id = require_id(id)?;
    let form = form_map(&[("pid", id)]);
    api_post(ctx, "/api/playlist/delete", &form).await?;
    Ok(())
}

/// 从曲目元素取数字 id，拼成 manipulate/tracks 要的 `[1,2,3]` 串。
/// 优先 ref.id（搜索/详情原样带回），缺失时按 spec §1.4 用稳定 id 尝试。
fn track_ids_json(tracks: &[TrackEntry]) -> ApiResult<String> {
    let mut ids = Vec::with_capacity(tracks.len());
    for (idx, entry) in tracks.iter().enumerate() {
        let from_ref = entry
            .track_ref
            .as_ref()
            .and_then(|r| r.get("id"))
            .and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
            });
        let id = from_ref
            .or_else(|| entry.id.trim().parse::<i64>().ok())
            .ok_or_else(|| {
                bad_request(format!(
                    "第 {} 首的 id 不是数字，无法操作网易云歌单",
                    idx + 1
                ))
            })?;
        if id <= 0 {
            return Err(bad_request(format!(
                "第 {} 首的 id 不是正数，无法操作网易云歌单",
                idx + 1
            )));
        }
        ids.push(id);
    }
    serde_json::to_string(&serde_json::json!(ids))
        .map_err(|e| ApiError::internal(format!("编码 trackIds 失败: {e}")))
}

/// 加曲：POST /api/playlist/manipulate/tracks，op=add。
pub async fn playlist_add(ctx: &Ctx, id: &str, tracks: &[TrackEntry]) -> ApiResult<()> {
    require_tracks(tracks, "加入")?;
    let id = require_id(id)?;
    let track_ids = track_ids_json(tracks)?;
    // imme=true：跨端立即同步歌单（网页端默认带）。
    let form = form_map(&[
        ("op", "add"),
        ("pid", id),
        ("trackIds", &track_ids),
        ("imme", "true"),
    ]);
    api_post(ctx, "/api/playlist/manipulate/tracks", &form).await?;
    Ok(())
}

/// 移除曲目：同端点 op=del。
pub async fn playlist_remove(ctx: &Ctx, id: &str, tracks: &[TrackEntry]) -> ApiResult<()> {
    require_tracks(tracks, "移除")?;
    let id = require_id(id)?;
    let track_ids = track_ids_json(tracks)?;
    let form = form_map(&[
        ("op", "del"),
        ("pid", id),
        ("trackIds", &track_ids),
        ("imme", "true"),
    ]);
    api_post(ctx, "/api/playlist/manipulate/tracks", &form).await?;
    Ok(())
}

/// 红心/取消红心：POST /api/song/like。
pub async fn like(ctx: &Ctx, id: &str, liked: bool) -> ApiResult<()> {
    let id = id.trim();
    if id.is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    let mut form = BTreeMap::new();
    form.insert("trackId".to_string(), id.to_string());
    form.insert(
        "like".to_string(),
        if liked { "true" } else { "false" }.to_string(),
    );
    api_post(ctx, "/api/song/like", &form).await?;
    Ok(())
}

/// 听歌打卡（scrobble）：把一次「有效收听 ≥30 秒」上报给网易云，计入歌曲
/// 播放量。走网页端同款 `weapi/feedback/weblog`（action=play、end=playend），
/// 必须已登录（cookie 含 MUSIC_U）。`seconds` 是 seek-proof 计时器累计的
/// 有效秒数，由调用方保证 ≥30。
pub async fn scrobble(ctx: &Ctx, id: &str, seconds: u64) -> ApiResult<()> {
    let pack = login_pack(ctx).await?;
    let log = serde_json::json!({
        "action": "play",
        "json": {
            "download": 0,
            "end": "playend",
            "id": id,
            "time": seconds,
            "type": "song",
            "url": "",
        }
    });
    let logs = serde_json::to_string(&[log])
        .map_err(|e| ApiError::internal(format!("序列化打卡日志失败: {e}")))?;
    let (_, body) = weapi(
        "feedback/weblog",
        serde_json::json!({ "logs": logs }),
        Some(pack.cookie.as_str()),
    )
    .await?;
    expect_200(&body, "听歌打卡")?;
    Ok(())
}

/// 推荐歌单：`/api/personalized/playlist`，免登录。result[] 字段 id/name/
/// picUrl/playCount。端点本身不支持翻页（limit 上限 30），offset 在本地切片：
/// 超窗返回空页而不是把第一页重复发第二遍。
pub async fn recommend_playlists(
    ctx: &Ctx,
    offset: usize,
    limit: usize,
) -> ApiResult<Vec<OnlinePlaylist>> {
    let limit = limit.clamp(1, 30);
    let j = api_get(
        ctx,
        "/api/personalized/playlist",
        &[("limit", &limit.to_string())],
        false,
    )
    .await?;
    expect_200(&j, "获取网易云推荐歌单")?;
    let items = j
        .get("result")
        .and_then(|v| v.as_array())
        .ok_or_else(|| ApiError::upstream_rejected("网易云未返回推荐歌单".to_string()))?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let id = item
            .get("id")
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            .to_string();
        if id.is_empty() || id == "0" {
            continue;
        }
        out.push(OnlinePlaylist {
            source: ID.into(),
            id,
            name: item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            cover: item
                .get("picUrl")
                .or_else(|| item.get("picUrl_small"))
                .and_then(|v| v.as_str())
                .and_then(https_url),
            track_count: 0,
            play_count: item.get("playCount").and_then(|v| v.as_u64()),
            creator: String::new(),
            // spec §1.3 的 kind 枚举封闭（created|collected|liked）；推荐结果走
            // 独立端点，前端不得对它渲染收藏类写操作（与 QQ 推荐广场同口径）。
            kind: "collected".into(),
            description: None,
        });
    }
    Ok(out.into_iter().skip(offset).take(limit).collect())
}

/// 每日推荐歌曲：`/api/v3/discovery/recommend/songs`（注意是 recommend/songs，
/// 写成了 recommendSongs 上游会回 code=404「接口未找到」，实测确认）。需登录。
/// 响应在 data.dailySongs[]（旧版 data.recommend[] 兜底），曲目是 v6 形态。
pub async fn recommend_songs(
    ctx: &Ctx,
    offset: usize,
    limit: usize,
) -> ApiResult<Vec<OnlineTrack>> {
    let j = api_get(ctx, "/api/v3/discovery/recommend/songs", &[], true).await?;
    expect_200(&j, "获取网易云每日推荐")?;
    let songs = j
        .pointer("/data/dailySongs")
        .or_else(|| j.pointer("/data/recommend"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| ApiError::upstream_rejected("网易云未返回每日推荐".to_string()))?;
    Ok(songs
        .iter()
        .map(v6_track)
        .filter(|t| !t.id.is_empty() && t.id != "0")
        .skip(offset)
        .take(limit.clamp(1, 100))
        .collect())
}

/// 扫码轮询状态码：801 等待 / 802 已扫描 / 803 确认 / 800 过期。
/// 未知码一律 waiting（不猜过期，不提前把用户的码作废）。
fn qr_state(code: Option<i64>) -> &'static str {
    match code {
        Some(801) => "waiting",
        Some(802) => "scanned",
        Some(803) => "confirmed",
        Some(800) => "expired",
        _ => "waiting",
    }
}

/// 握手票分隔符：第一行 unikey，第二行创建 unikey 时上游 Set-Cookie 的会话
/// cookie（NMTID 设备标识）。轮询必须回传它，否则手机端确认后上游不绑定
/// MUSIC_U（真机实测：缺它会出现「手机已确认、电脑端永远 waiting」）。
const QR_TICKET_SEP: &str = "\n";

/// 解析握手票：(unikey, 可选的创建期 cookie 串)。旧形态裸 unikey 也兼容。
fn parse_qr_ticket(ticket: &str) -> (String, Option<String>) {
    match ticket.split_once(QR_TICKET_SEP) {
        Some((k, c)) => (
            k.trim().to_string(),
            Some(c.trim().to_string()).filter(|s| !s.is_empty()),
        ),
        None => (ticket.trim().to_string(), None),
    }
}

/// 扫码专用的短命客户端：不跟随重定向、不挂 cookie jar。
///
/// 两道防线：一是杜绝开放重定向把请求带到第三方主机后，对方的 Set-Cookie
/// 被我们当真凭据落库（与 QQ 扫码 check_sig 的域白名单同一道防线）；二是
/// 握手 cookie 由调用方显式收发，不与共享客户端的其他请求串味。
fn qr_client() -> ApiResult<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .read_timeout(std::time::Duration::from_secs(12))
        .user_agent(super::UA)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| ApiError::internal(format!("网易云扫码客户端初始化失败: {e}")))
}

/// 把响应 Set-Cookie 合并进 name=value 表（后写覆盖先写，值不进日志）。
///
/// 只取每条的第一段（`name=value`），Path/Expires/Domain 这些属性对请求头
/// 没有意义，留在串里还会干扰 `cred::cookie_field` 的判态解析。
/// 扫码登录的客户端标识串（上游从 Cookie 头里读，不是从 UA 读）。
///
/// 只带 NMTID、不带这些字段时，手机端确认后上游回
/// `8821 请切换其他登录方式或升级新版本再试`，永远不会进 803（真机实测
/// 2026-09-22）；这句话比对的就是 `appver`/`versioncode`。字段与 PC 客户端
/// 一致：`os=pc` 决定登录通道，`buildver`/`requestId` 只需每次不同。
///
/// 所有键值都是 URL 安全字符，不需要额外百分号编码。
fn qr_client_cookie() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    [
        ("os", "pc".to_string()),
        ("appver", "3.1.17.204416".to_string()),
        (
            "osver",
            "Microsoft-Windows-10-Professional-build-19045-64bit".to_string(),
        ),
        ("channel", "netease".to_string()),
        ("deviceId", String::new()),
        ("versioncode", "140".to_string()),
        ("mobilename", String::new()),
        ("buildver", secs.to_string()),
        ("resolution", "1920x1080".to_string()),
        ("__csrf", String::new()),
        ("requestId", format!("{secs}_{:04}", secs % 1000)),
    ]
    .iter()
    .map(|(k, v)| format!("{k}={v}"))
    .collect::<Vec<_>>()
    .join("; ")
}

/// 扫码请求的完整 Cookie 头：客户端标识 + 创建期回传的 NMTID（可为空）。
fn qr_cookie(seed: &str) -> String {
    let identity = qr_client_cookie();
    if seed.trim().is_empty() {
        identity
    } else {
        format!("{identity}; {seed}")
    }
}

/// 创建扫码握手：取 unikey，二维码内容是
/// `https://music.163.com/login?codekey=<unikey>`，由前端本地渲染。
///
/// 往返只有一次：上游在取 unikey 的同时用 Set-Cookie 下发设备标识 NMTID，
/// 它与 unikey 一起进握手票，后续轮询必须回传（真机实测：缺它会出现「手机
/// 已确认、电脑端永远 waiting」）。
pub async fn qr_create(_ctx: &Ctx) -> ApiResult<QrPayload> {
    let url = api_url("/api/login/qrcode/unikey", &[("type", QR_TYPE)])?;
    let mut h = super::http::headers(Some(&qr_cookie("")), Some(W));
    h.insert(ACCEPT, HeaderValue::from_static("application/json"));
    let (resp_headers, j) = super::http::get_json_with_headers(&qr_client()?, &url, h).await?;
    expect_200(&j, "创建网易云扫码")?;
    let key = j
        .get("unikey")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::upstream_rejected("网易云未返回 unikey".to_string()))?;
    let mut jar = BTreeMap::new();
    absorb_cookies(&resp_headers, &mut jar);
    let seed = cookie_string(&jar);
    // 把创建期 cookie（NMTID）并入不透明握手票，Registry 只当它是字符串。
    let platform_ticket = if seed.is_empty() {
        key.to_string()
    } else {
        format!("{key}{QR_TICKET_SEP}{seed}")
    };
    // codekey 走 Url 编码；unikey 通常是 UUID，但不假设。
    let mut u = reqwest::Url::parse(W)
        .and_then(|u| u.join("/login"))
        .map_err(|e| ApiError::internal(format!("网易云扫码地址无效: {e}")))?;
    u.query_pairs_mut().append_pair("codekey", key);
    Ok(QrPayload {
        platform_ticket,
        qr_text: Some(u.to_string()),
        qr_image: None,
        poll_ms: 2000,
    })
}

/// 上游明确拒绝这次扫码的业务码（终局失败，不是"再等等"）。
///
/// 8821「请切换其他登录方式或升级新版本再试」：客户端标识不被接受时，手机
/// 端一点确认就会回它。它不在 801/802/803 这条链上，轮询多少次都是同一句，
/// 所以不能落进 [`qr_state`] 的兜底 waiting（那会让前端静默空转到超时）。
const QR_REJECT_CODE: i64 = 8821;

/// 一次轮询的原始结果：票态、这一轮结束后的完整 cookie、上游回包。
///
/// cookie 是「回传的 seed + 本轮 Set-Cookie」的并集——确认登录时上游只下发
/// MUSIC_U/__csrf，设备标识要由我们补回去。
struct QrCheckRound {
    state: String,
    cookie: String,
    body: serde_json::Value,
}

/// 打一次状态轮询。HTTP 失败按错误上抛（让前端按原节奏重试），业务码一律
/// 由 [`qr_state`] 归一成票态。
async fn qr_check_round(key: &str, seed: &str) -> ApiResult<QrCheckRound> {
    let url = api_url(
        "/api/login/qrcode/client/login",
        &[("key", key), ("type", QR_TYPE)],
    )?;
    // 客户端标识 + 创建期的 NMTID 一起回传：缺前者上游在确认后回 8821，
    // 缺后者真机会停在 waiting。
    let mut h = super::http::headers(Some(&qr_cookie(seed)), Some(W));
    h.insert(ACCEPT, HeaderValue::from_static("application/json"));
    let (resp_headers, body) = super::http::get_json_with_headers(&qr_client()?, &url, h).await?;
    let code = body.get("code").and_then(|c| c.as_i64());
    if code == Some(QR_REJECT_CODE) {
        // 把上游的原话带出去：这是用户需要知道的事实，不是"稍后重试"。
        let msg = body
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("请切换其他登录方式或升级新版本再试");
        tracing::warn!(message = %msg, "网易云拒绝了这次扫码登录");
        return Ok(QrCheckRound {
            state: "rejected".to_string(),
            cookie: String::new(),
            body,
        });
    }
    let state = qr_state(code).to_string();
    let mut jar = BTreeMap::new();
    absorb_cookies(&resp_headers, &mut jar);
    let cookie = merge_cookie(seed, &cookie_string(&jar));
    // 扫码流程的排障主线索：状态停在 waiting 说明上游没把手机端的确认关联到
    // 这次握手（多半是身份/type 不匹配），停在 confirmed 但没 MUSIC_U 说明
    // 上游没下发凭据。只记字段名与状态码，cookie 值绝不进日志。
    tracing::info!(
        code = code.unwrap_or(-1),
        state = %state,
        cookie_names = %jar.keys().cloned().collect::<Vec<_>>().join(","),
        "网易云扫码轮询"
    );
    Ok(QrCheckRound {
        state,
        cookie,
        body,
    })
}

/// 轮询扫码状态。803 确认时上游通过 Set-Cookie 种入 MUSIC_U/__csrf，整罐
/// cookie 写进 cred 保险库。
///
/// 与参考实现同形的两处细节：确认后若没拿到可用凭据会**补一次轮询**（上游
/// 偶发在首次 803 的回包里漏发 cookie）；补不到也不报错——这枚码已经用掉了，
/// 继续轮询只会永远 waiting，回终态让前端提示刷新二维码。
pub async fn qr_check(
    ctx: &Ctx,
    platform_ticket: &str,
) -> ApiResult<(String, Option<AccountInfo>)> {
    let (key, seed_cookie) = parse_qr_ticket(platform_ticket.trim());
    if key.is_empty() {
        return Err(bad_request("缺少网易云扫码握手票 unikey"));
    }
    let seed = seed_cookie.unwrap_or_default();
    let mut round = qr_check_round(&key, &seed).await?;
    if round.state == "confirmed" && !cred_is_signed_in(&round.cookie) {
        tracing::warn!("网易云扫码已确认但未取得登录 Cookie，补一次轮询");
        match qr_check_round(&key, &seed).await {
            Ok(retry) => round = retry,
            Err(e) => tracing::warn!(error = %e.message, "网易云扫码补轮询失败，沿用首次结果"),
        }
    }
    if round.state != "confirmed" {
        return Ok((round.state, None));
    }
    let pack = super::cred::CredPack {
        cookie: round.cookie,
        ..Default::default()
    };
    if !cred_is_signed_in(&pack.cookie) {
        // 手机端已确认，但上游没下发 MUSIC_U。这枚码已经用掉，再轮询也只会
        // 停在 waiting，所以回终态（前端提示刷新二维码）而不是报错——报错会
        // 让前端按原节奏无限重试，用户看到的永远是「正在等待扫码」。
        tracing::warn!("网易云扫码确认但未取得 MUSIC_U，按过期处理让用户刷新二维码");
        return Ok(("expired".to_string(), None));
    }
    super::cred::put(&ctx.db, ID, &pack)
        .await
        .map_err(|e| ApiError::internal(format!("保存网易云凭据失败: {e}")))?;
    // 凭据已落库，账号资料回拉失败也按成功返回：用 803 回包里的 profile 兜底
    // 一个「已登录但资料未同步」的账号，顶栏不会显示成未登录，下一次
    // /account 会把昵称头像补齐。
    let account = match account(ctx).await {
        Ok(info) => Some(info),
        Err(e) => {
            tracing::debug!(error = %e.message, "网易云扫码登录成功但账号信息回拉失败，用握手响应兜底");
            account_from_login_body(&round.body)
        }
    };
    Ok(("confirmed".to_string(), account))
}

/// 按平台判据判断一串 cookie 是否已登录（不落库，只做判定）。
fn cred_is_signed_in(cookie: &str) -> bool {
    super::cred::is_signed_in(
        ID,
        &super::cred::CredPack {
            cookie: cookie.to_string(),
            ..Default::default()
        },
    )
}

/// 账号资料兜底：803 回包里可能直接带 profile/account，取得到就构造一个账号
/// 信息，避免「明明登录成功了、顶栏还是未登录」。
fn account_from_login_body(j: &serde_json::Value) -> Option<AccountInfo> {
    let profile = j.get("profile").filter(|v| !v.is_null());
    let nickname = profile
        .and_then(|p| p.get("nickname"))
        .or_else(|| j.get("nickname"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let avatar = profile
        .and_then(|p| p.get("avatarUrl"))
        .or_else(|| j.get("avatarUrl"))
        .and_then(|v| v.as_str())
        .and_then(https_url);
    // 昵称头像都没有说明回包里确实没有账号信息，交给下一次 /account 补拉。
    if nickname.is_none() && avatar.is_none() {
        return None;
    }
    let vip_level = profile
        .and_then(|p| p.get("vipType").or_else(|| p.get("vipTypeCode")))
        .and_then(|v| v.as_u64());
    let membership = super::ProfileMembership::from_level(vip_level);
    let vip_level = vip_level.and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
    Some(AccountInfo {
        source: ID.into(),
        nickname: nickname.unwrap_or("网易云用户").to_string(),
        avatar,
        membership,
        vip_level,
        vip_label: if vip_level > 0 {
            "VIP".to_string()
        } else {
            String::new()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    // 只在断言里用到：解析回一罐 cookie 来逐项检查合并结果。
    use super::super::http::parse_cookie;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn song() -> serde_json::Value {
        serde_json::json!({
            "id": 5257138,
            "name": "屋顶",
            "duration": 319039,
            "artists": [{"name": "周杰伦", "img1v1Url": "http://p1.music.126.net/a.jpg"}],
            "album": {"name": "男女情歌对唱冠军全记录"}
        })
    }

    #[test]
    fn search_tracks_are_normalised_into_the_shared_shape() {
        let t = netease_track(&song());
        assert_eq!(t.source, "netease");
        assert_eq!(t.id, "5257138");
        assert_eq!(t.title, "屋顶");
        assert_eq!(t.artist, "周杰伦");
        assert_eq!(t.album, "男女情歌对唱冠军全记录");
        assert_eq!(t.duration_ms, 319039);
        // 搜索接口只给 picId 时不拿艺人头像顶替（那是上游人人同一张的默认
        // 头像），留空交给 fill_album_covers 用详情接口补真图。
        assert_eq!(t.cover, None);
        assert!(t.playable);
    }

    #[test]
    fn album_pic_url_is_taken_and_upgraded_to_https() {
        let t = netease_track(&serde_json::json!({
            "id": 7,
            "name": "屋顶",
            "album": {"name": "A", "picId": 1, "picUrl": "http://p1.music.126.net/a.jpg"}
        }));
        assert_eq!(t.cover.as_deref(), Some("https://p1.music.126.net/a.jpg"));
    }

    /// 按脚本逐次回包的本地详情端点替身，并数出实际收到几次请求。
    /// 用真 TCP 而不是假客户端：要验的就是「失败之后确实又发了一次」。
    async fn stub_detail(responses: Vec<&'static str>) -> (String, std::sync::Arc<AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定本地端口");
        let url = format!(
            "http://127.0.0.1:{}/api/song/detail",
            listener.local_addr().unwrap().port()
        );
        let hits = std::sync::Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            for body in responses {
                let (mut sock, _) = listener.accept().await.expect("连接");
                let mut buf = [0u8; 2048];
                loop {
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    if n == 0 || buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (url, hits)
    }

    #[tokio::test]
    async fn cover_backfill_retries_once_when_the_first_response_has_no_songs() {
        // 上游限流时的真实形态：200 + 一段没有 songs 的 JSON。
        let (url, hits) = stub_detail(vec![
            r#"{"code":-460,"message":"请重新登录"}"#,
            r#"{"songs":[{"id":5257138,"album":{"picUrl":"https://p1.music.126.net/a/1.jpg"}}]}"#,
        ])
        .await;
        let mut tracks = vec![netease_track(&song())];
        assert_eq!(
            tracks[0].cover, None,
            "搜索接口只给 picId，进函数时应当还没有封面"
        );
        let got = fetch_detail_covers(
            &reqwest::Client::new(),
            None,
            "[5257138]",
            &mut tracks,
            &url,
        )
        .await;
        assert!(got, "第二次拿到 songs 就该算成功");
        assert_eq!(
            tracks[0].cover.as_deref(),
            Some("https://p1.music.126.net/a/1.jpg")
        );
        assert_eq!(hits.load(Ordering::SeqCst), 2, "应当恰好重试一次");
    }

    #[tokio::test]
    async fn cover_backfill_gives_up_after_the_single_retry() {
        // 脚本比尝试次数多一条：不然「改成试三次」这种变异只会让第三次拿到
        // 连接被拒，计数仍是 2，断言就抓不到多试的那一次。
        let (url, hits) = stub_detail(vec![
            r#"{"code":-460}"#,
            r#"{"code":-460}"#,
            r#"{"code":-460}"#,
        ])
        .await;
        let mut tracks = vec![netease_track(&song())];
        let got = fetch_detail_covers(
            &reqwest::Client::new(),
            None,
            "[5257138]",
            &mut tracks,
            &url,
        )
        .await;
        assert!(!got, "两次都没有 songs 就该放弃这一批");
        assert_eq!(tracks[0].cover, None, "放弃时不该留下半张封面");
        assert_eq!(hits.load(Ordering::SeqCst), 2, "重试只有一次，不能越试越多");
    }

    #[test]
    fn artist_entries_are_normalised() {
        let page = map_artist(&serde_json::json!({
            "id": 6452,
            "name": "周杰伦",
            "alias": ["Jay Chou", "周董"],
            "picUrl": "http://p1.music.126.net/a.jpg",
            "musicSize": 568
        }));
        assert_eq!(page.source, "netease");
        assert_eq!(page.id, "6452");
        assert_eq!(page.name, "周杰伦");
        assert_eq!(page.alias.as_deref(), Some("Jay Chou、周董"));
        assert_eq!(
            page.cover.as_deref(),
            Some("https://p1.music.126.net/a.jpg")
        );
        assert_eq!(page.song_count, Some(568));

        // 空别名不序列化成空串；缺封面不兜假图。
        let bare = map_artist(&serde_json::json!({"id": 1, "name": "某人"}));
        assert_eq!(bare.alias, None);
        assert_eq!(bare.cover, None);
        assert_eq!(bare.song_count, None);
    }

    #[test]
    fn album_entries_are_normalised() {
        let a = map_album(&serde_json::json!({
            "id": 18909,
            "name": "Partners 拍档",
            "picUrl": "http://p1.music.126.net/b.jpg",
            "size": 13,
            "publishTime": 1019750400000u64,
            "artist": {"name": "周杰伦"}
        }));
        assert_eq!(a.source, "netease");
        assert_eq!(a.id, "18909");
        assert_eq!(a.name, "Partners 拍档");
        assert_eq!(a.artist, "周杰伦");
        assert_eq!(a.cover.as_deref(), Some("https://p1.music.126.net/b.jpg"));
        assert_eq!(a.track_count, Some(13));
        assert_eq!(a.publish_time, Some(1_019_750_400_000));
    }

    #[test]
    fn public_playlist_entries_skip_invalid_ids() {
        let ok = map_public_playlist(&serde_json::json!({
            "id": 6792103822i64,
            "name": "精选",
            "coverImgUrl": "http://p1.music.126.net/c.jpg",
            "trackCount": 144,
            "playCount": 33595024i64,
            "creator": {"nickname": "Buradarrr"}
        }))
        .unwrap();
        assert_eq!(ok.id, "6792103822");
        assert_eq!(ok.name, "精选");
        assert_eq!(ok.track_count, 144);
        assert_eq!(ok.play_count, Some(33_595_024));
        assert_eq!(ok.creator, "Buradarrr");
        assert_eq!(ok.kind, "created");

        // id 缺失/非法的条目整条丢弃，不产出空壳卡片。
        assert!(map_public_playlist(&serde_json::json!({"name": "无 id"})).is_none());
        assert!(map_public_playlist(&serde_json::json!({"id": 0, "name": "零"})).is_none());
    }

    #[test]
    fn platform_ids_must_be_numeric() {
        assert!(valid_platform_id("6452").is_ok());
        assert!(valid_platform_id(" 18909 ").is_ok());
        assert!(valid_platform_id("").is_err());
        assert!(valid_platform_id("../settings").is_err());
        assert!(valid_platform_id("6452;drop").is_err());
        assert!(valid_platform_id("0").is_ok()); // 0 由上游报错，这里只卡字符集
    }

    #[test]
    fn search_term_requires_a_keyword() {
        let q = |json: serde_json::Value| -> SearchQuery { serde_json::from_value(json).unwrap() };
        assert!(search_term(&q(serde_json::json!({"q": " 周杰伦 "}))).unwrap() == "周杰伦");
        assert!(search_term(&q(serde_json::json!({}))).is_err());
        assert!(search_term(&q(serde_json::json!({"q": "   "}))).is_err());
    }

    fn track(id: &str, cover: Option<&str>) -> OnlineTrack {
        OnlineTrack {
            source: "netease".into(),
            id: id.into(),
            title: "t".into(),
            artist: String::new(),
            album: String::new(),
            duration_ms: 0,
            cover: cover.map(|c| c.to_string()),
            playable: true,
            vip_only: false,
            track_ref: serde_json::json!({}),
        }
    }

    #[test]
    fn cover_gaps_skip_tracks_that_already_have_art() {
        let tracks = vec![
            track("1", None),
            track("2", Some("https://p1.music.126.net/has.jpg")),
            track("0", None), // 解析失败的占位 id
            track("", None),  // 同上
            track("5", None),
        ];
        assert_eq!(cover_gaps(&tracks), vec!["1", "5"]);
    }

    #[test]
    fn detail_covers_fill_gaps_and_never_overwrite() {
        let mut tracks = vec![
            track("1", None),
            track("2", Some("https://p1.music.126.net/keep.jpg")),
            track("3", None),
        ];
        let songs = vec![
            serde_json::json!({"id": 1, "album": {"picUrl": "http://p1.music.126.net/a.jpg"}}),
            // 已经有封面的 2 号：详情给的新图也不能覆盖它
            serde_json::json!({"id": 2, "album": {"picUrl": "https://p1.music.126.net/new.jpg"}}),
            // 详情里没有 picUrl / 没有 id 的脏数据：跳过，不 panic
            serde_json::json!({"id": 3, "album": {}}),
            serde_json::json!({"album": {"picUrl": "https://x/y.jpg"}}),
        ];
        apply_detail_covers(&mut tracks, &songs);
        assert_eq!(
            tracks[0].cover.as_deref(),
            Some("https://p1.music.126.net/a.jpg")
        );
        assert_eq!(
            tracks[1].cover.as_deref(),
            Some("https://p1.music.126.net/keep.jpg")
        );
        assert_eq!(tracks[2].cover, None);
    }

    #[test]
    fn missing_fields_degrade_instead_of_panicking() {
        let t = netease_track(&serde_json::json!({}));
        assert_eq!(t.id, "0");
        assert_eq!(t.title, "未知曲目");
        assert!(t.artist.is_empty());
        assert_eq!(t.duration_ms, 0);
        assert_eq!(t.cover, None);
    }

    #[test]
    fn every_declared_category_resolves_to_a_search_term() {
        // CATS 与 TERM_BY_CAT 漏配一项的表现是「点了分类但搜热门」，不报错，
        // 所以只能靠断言兜住。
        for (id, _) in CATS {
            let term = TERM_BY_CAT
                .iter()
                .find(|(k, _)| k == id)
                .map(|(_, v)| *v)
                .unwrap_or("热门");
            assert!(!term.is_empty(), "{id} 的分类词是空的");
            if *id != "hot" {
                assert_ne!(term, "热门", "{id} 没有自己的分类词");
            }
        }
    }

    /// 取流条目要留住档位元数据：`size`/`type`/`br` 以前全被丢掉，而降级后
    /// 落盘的扩展名与档位标注只能靠它们撑着。两个上游字段名不同（api 用 `br`，
    /// eapi 用 `bitrate`），都得认。
    #[test]
    fn rung_parsing_keeps_tier_metadata() {
        let api = parse_rung(&serde_json::json!({
            "url": "https://m10.music.126.net/a.mp3", "br": 320_000, "expi": 1200,
            "type": "mp3", "gain": -8.4, "peak": 1.02
        }))
        .expect("api 条目应解析成候选");
        assert_eq!(api.bitrate, Some(320_000));
        assert_eq!(api.container, Some("mp3"));
        assert_eq!(api.expires_in_secs, Some(1200));
        assert_eq!(api.gain, Some(-8.4));
        assert_eq!(api.peak, Some(1.02));

        let eapi = parse_rung(&serde_json::json!({
            "url": "https://p.music.163.com/b.flac", "bitrate": 999_000,
            "type": "flac", "peak": 0
        }))
        .expect("eapi 条目应解析成候选");
        assert_eq!(eapi.bitrate, Some(999_000));
        assert_eq!(eapi.container, Some("flac"));
        assert!(eapi.peak.is_none(), "peak=0 不能当防削波的分母");
        assert!(eapi.gain.is_none(), "eapi 不给响度就不编一个");

        // url 为 null / 空串 = 这一档当前身份拿不到，是空格子而不是错误。
        assert!(parse_rung(&serde_json::json!({"url": null, "br": 0})).is_none());
        assert!(parse_rung(&serde_json::json!({"url": ""})).is_none());
        // 认不出的容器名留给字节嗅探，不硬编成 mp3。
        assert_eq!(container_of("unknown"), None);
        assert_eq!(container_of("aac"), Some("m4a"));
    }

    /// 档位名必须由 `quality` 表反推，不能在音源里再写一套阈值。
    #[test]
    fn level_names_follow_the_tier_table() {
        assert_eq!(level_for(999_000), "hires");
        assert_eq!(level_for(740_000), "lossless");
        assert_eq!(level_for(320_000), "exhigh");
        assert_eq!(level_for(128_000), "standard");
    }

    /// 阶梯组装：主地址带自己的元数据，其余按序进 `fallbacks`；两路都空手
    /// 才是「暂无可用音频」，且这条文案不能变（前端原样显示）。
    #[test]
    fn ladder_head_carries_the_top_tier_and_rest_become_fallbacks() {
        let rung = |url: &str, bps: u64, c: Option<&'static str>| Rung {
            url: url.into(),
            bitrate: Some(bps),
            expires_in_secs: Some(60),
            container: c,
            gain: None,
            peak: None,
        };
        let info = ladder_from(
            "123",
            vec![
                rung("https://p/music.163.com/f.flac", 999_000, Some("flac")),
                rung("https://m10.music.126.net/a.mp3", 320_000, Some("mp3")),
            ],
        )
        .unwrap();
        assert_eq!(info.url, "https://p/music.163.com/f.flac");
        assert_eq!(info.bitrate, Some(999_000));
        assert_eq!(info.fallbacks.len(), 1);
        assert_eq!(info.fallbacks[0].bitrate, Some(320_000));
        assert_eq!(info.fallbacks[0].container, Some("mp3"));
        // 主地址是 flac 档、备胎是 mp3 档：降级落盘的扩展名据此才不会写错。
        assert_eq!(
            ladder_from("123", vec![]).unwrap_err().code,
            "upstream_rejected"
        );
    }

    // -- Task 12 纯函数 -----------------------------------------------------

    #[test]
    fn expect_200_classifies_business_codes() {
        assert!(expect_200(&serde_json::json!({"code": 200}), "操作").is_ok());
        // 只有 301/-462 是未登录/登录过期，归 401。
        for code in [301, -462] {
            let e = expect_200(&serde_json::json!({"code": code}), "操作").unwrap_err();
            assert_eq!(e.status.as_u16(), 401, "code {code} 应归类为未登录");
        }
        assert_eq!(
            expect_200(&serde_json::json!({"code": 400}), "操作")
                .unwrap_err()
                .status
                .as_u16(),
            400
        );
        // -460 是风控不是没登录；302 无登录态语义——都不能弹登录框，归 502。
        for code in [-460, 302, 505] {
            let e = expect_200(&serde_json::json!({"code": code}), "操作").unwrap_err();
            assert_eq!(e.status.as_u16(), 502, "code {code} 应归类为上游拒绝");
        }
        // 缺 code 也算上游拒绝，绝不放过成成功。
        assert_eq!(
            expect_200(&serde_json::json!({}), "操作")
                .unwrap_err()
                .status
                .as_u16(),
            502
        );
    }

    #[test]
    fn v6_track_normalises_ar_al_dt_and_flags_vip_fee() {
        let t = v6_track(&serde_json::json!({
            "id": 123,
            "name": "歌",
            "dt": 240_000,
            "ar": [{"name": "甲"}, {"name": "乙"}],
            "al": {"name": "专辑", "picUrl": "http://p1.music.126.net/x.jpg"},
            "fee": 1
        }));
        assert_eq!(t.id, "123");
        assert_eq!(t.artist, "甲, 乙");
        assert_eq!(t.album, "专辑");
        assert_eq!(t.duration_ms, 240_000);
        assert_eq!(t.cover.as_deref(), Some("https://p1.music.126.net/x.jpg"));
        assert!(t.playable);
        assert!(t.vip_only, "fee=1 是 VIP 曲");
        assert_eq!(t.track_ref["id"], serde_json::json!("123"));

        // fee=4（数字专辑付费）同样标灰。
        assert!(v6_track(&serde_json::json!({"id": 9, "fee": 4})).vip_only);
        assert!(!v6_track(&serde_json::json!({"id": 9, "fee": 0})).vip_only);

        // 缺字段不 panic；id 缺失时不可点。
        let ghost = v6_track(&serde_json::json!({}));
        assert_eq!(ghost.id, "0");
        assert!(!ghost.playable);
        assert_eq!(ghost.title, "未知曲目");
    }

    #[test]
    fn user_playlist_kind_follows_creator_and_liked_name() {
        let own = map_user_playlist(
            &serde_json::json!({
                "id": 1,
                "name": "我的歌单",
                "coverImgUrl": "http://x/c.jpg",
                "trackCount": 3,
                "playCount": 9,
                "creator": {"userId": 100, "nickname": "我"}
            }),
            100,
        );
        assert_eq!(own.kind, "created");
        assert_eq!(own.creator, "我");
        assert_eq!(own.track_count, 3);
        assert_eq!(own.play_count, Some(9));
        assert_eq!(own.cover.as_deref(), Some("https://x/c.jpg"));

        let other = map_user_playlist(
            &serde_json::json!({
                "id": 2,
                "name": "别人的精选",
                "creator": {"userId": 200, "nickname": "他"}
            }),
            100,
        );
        assert_eq!(other.kind, "collected");

        // 名字含「我喜欢」一律 liked，哪怕创建者字段对不上（名字兜底路径）。
        let liked = map_user_playlist(
            &serde_json::json!({
                "id": 3,
                "name": "我喜欢的音乐",
                "creator": {"userId": 200, "nickname": "他"}
            }),
            100,
        );
        assert_eq!(liked.kind, "liked");

        // 主路径：specialType==5 才是红心歌单的稳定判据，名字不带「我喜欢」也算。
        let special = map_user_playlist(
            &serde_json::json!({
                "id": 5,
                "name": "My Favorite",
                "specialType": 5,
                "creator": {"userId": 200, "nickname": "他"}
            }),
            100,
        );
        assert_eq!(special.kind, "liked");
        // specialType 存在但不是 5，不影响 created/collected 判定。
        let normal = map_user_playlist(
            &serde_json::json!({
                "id": 6,
                "name": "新建合集",
                "specialType": 0,
                "creator": {"userId": 100, "nickname": "我"}
            }),
            100,
        );
        assert_eq!(normal.kind, "created");

        // 老接口的小写字段 coverImgurl 也要兜住。
        let lower = map_user_playlist(
            &serde_json::json!({"id": 4, "name": "n", "coverImgurl": "//x/4.jpg"}),
            100,
        );
        assert_eq!(lower.cover.as_deref(), Some("https://x/4.jpg"));
    }

    #[test]
    fn track_ids_json_accepts_mixed_numeric_forms_and_rejects_bad_ones() {
        // 构造写操作元素：id 为稳定 id，ref 为可选平台载荷。
        let entry = |id: &str, r: Option<serde_json::Value>| TrackEntry {
            id: id.into(),
            track_ref: r,
        };
        let entries = [
            entry("1", Some(serde_json::json!({"id": 1}))),
            entry("2", Some(serde_json::json!({"id": "2"}))),
            entry("3", Some(serde_json::json!({"id": " 3 "}))),
            // spec §1.4：ref 缺失时仅用稳定 id 尝试。
            entry("4", None),
            entry(" 5 ", None),
            // ref 里没 id 键时回落到稳定 id。
            entry("6", Some(serde_json::json!({}))),
        ];
        let body = track_ids_json(&entries).unwrap();
        let parsed: Vec<i64> = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed, vec![1, 2, 3, 4, 5, 6]);

        // 两处都拿不到数字 → 400，不能把脏 trackIds 发给写操作端点。
        assert_eq!(
            track_ids_json(&[entry("abc", Some(serde_json::json!({})))])
                .unwrap_err()
                .status
                .as_u16(),
            400
        );
        assert_eq!(
            track_ids_json(&[entry("abc", None)])
                .unwrap_err()
                .status
                .as_u16(),
            400
        );
        // 非正数 id 也不能发给写操作端点（ref 与稳定 id 各验一遍）。
        assert_eq!(
            track_ids_json(&[entry("0", None)])
                .unwrap_err()
                .status
                .as_u16(),
            400
        );
        assert_eq!(
            track_ids_json(&[entry("9", Some(serde_json::json!({"id": "-7"})))])
                .unwrap_err()
                .status
                .as_u16(),
            400
        );
    }

    #[test]
    fn qr_state_maps_the_four_codes_and_keeps_unknown_as_waiting() {
        assert_eq!(qr_state(Some(801)), "waiting");
        assert_eq!(qr_state(Some(802)), "scanned");
        assert_eq!(qr_state(Some(803)), "confirmed");
        assert_eq!(qr_state(Some(800)), "expired");
        // 未知码 / 缺码不猜过期，继续等待，避免提前把用户的码作废。
        assert_eq!(qr_state(Some(999)), "waiting");
        assert_eq!(qr_state(None), "waiting");
    }

    #[test]
    fn qr_ticket_carries_seed_cookie_and_accepts_legacy_bare_unikey() {
        let (k, c) = parse_qr_ticket("abc-123\nNMTID=xyz; __csrf=z");
        assert_eq!(k, "abc-123");
        assert_eq!(c.as_deref(), Some("NMTID=xyz; __csrf=z"));

        let (k2, c2) = parse_qr_ticket("  bare-uuid  ");
        assert_eq!(k2, "bare-uuid");
        assert!(c2.is_none());

        let (k3, c3) = parse_qr_ticket("uuid\n   ");
        assert_eq!(k3, "uuid");
        assert!(c3.is_none());
    }

    #[test]
    fn set_cookie_is_absorbed_as_bare_name_value_pairs() {
        // 属性（Path/Expires/Domain）必须被剥掉：留着会干扰 cookie_field 判态。
        let mut h = reqwest::header::HeaderMap::new();
        h.append(
            reqwest::header::SET_COOKIE,
            reqwest::header::HeaderValue::from_static(
                "NMTID=abc; Max-Age=315360000; Path=/; Domain=music.163.com",
            ),
        );
        h.append(
            reqwest::header::SET_COOKIE,
            reqwest::header::HeaderValue::from_static("MUSIC_U=tok=en; Path=/"),
        );
        // 空值是上游「删除 cookie」的写法，不能落进 jar。
        h.append(
            reqwest::header::SET_COOKIE,
            reqwest::header::HeaderValue::from_static("__csrf=; Path=/"),
        );
        let mut jar = BTreeMap::new();
        absorb_cookies(&h, &mut jar);
        assert_eq!(jar.get("NMTID").map(String::as_str), Some("abc"));
        // 值里的 '=' 只在第一个处切分，不能被截断。
        assert_eq!(jar.get("MUSIC_U").map(String::as_str), Some("tok=en"));
        assert!(!jar.contains_key("__csrf"), "空值项应被丢弃");
        assert!(!jar.contains_key("Path"));
        assert_eq!(cookie_string(&jar), "MUSIC_U=tok=en; NMTID=abc");
    }

    #[test]
    fn merge_cookie_keeps_seed_and_lets_fresh_pair_win() {
        // 轮询只回传 NMTID，确认时上游只下发 MUSIC_U：两边必须合成一罐。
        let merged = merge_cookie("NMTID=seed", "MUSIC_U=u; __csrf=c");
        let jar = parse_cookie(&merged);
        assert_eq!(jar.get("NMTID").map(String::as_str), Some("seed"));
        assert_eq!(jar.get("MUSIC_U").map(String::as_str), Some("u"));
        assert_eq!(jar.get("__csrf").map(String::as_str), Some("c"));
        assert!(cred_is_signed_in(&merged));

        // 同名项以新值为准（上游刷新 NMTID 的场景）。
        assert_eq!(merge_cookie("NMTID=old", "NMTID=new"), "NMTID=new");
        // 空串两侧都不产生垃圾项。
        assert_eq!(merge_cookie("", ""), "");
        assert_eq!(merge_cookie("", "MUSIC_U=u"), "MUSIC_U=u");
        // 缺 MUSIC_U 的一罐不算登录。
        assert!(!cred_is_signed_in("NMTID=seed; __csrf=c"));
        // MUSIC_U 只有空值也不算（上游删 cookie 的写法）。
        assert!(!cred_is_signed_in("MUSIC_U=; NMTID=seed"));
    }

    #[test]
    fn account_falls_back_to_the_confirmation_payload() {
        // 803 回包直接带 profile：昵称头像都取得到。
        let info = account_from_login_body(&serde_json::json!({
            "code": 803,
            "profile": {"nickname": "阿七", "avatarUrl": "http://p1.music.126.net/a.jpg", "vipType": 11}
        }))
        .expect("有 profile 就该构造出账号");
        assert_eq!(info.source, ID);
        assert_eq!(info.nickname, "阿七");
        assert_eq!(
            info.avatar.as_deref(),
            Some("https://p1.music.126.net/a.jpg")
        );
        assert_eq!(info.vip_level, 11);
        assert_eq!(info.vip_label, "VIP");

        // 顶层昵称/头像（老接口形态）也要兜住。
        let flat = account_from_login_body(&serde_json::json!({
            "nickname": " 阿七 ", "avatarUrl": "http://p1.music.126.net/b.jpg"
        }))
        .expect("顶层字段同样可用");
        assert_eq!(flat.nickname, "阿七");
        assert_eq!(flat.vip_level, 0);
        assert!(flat.vip_label.is_empty());

        // 只有头像没有昵称：昵称给占位，不算失败。
        let avatar_only = account_from_login_body(&serde_json::json!({
            "profile": {"avatarUrl": "http://p1.music.126.net/c.jpg"}
        }))
        .expect("有头像就该构造出账号");
        assert_eq!(avatar_only.nickname, "网易云用户");

        // 什么都没有 → 交给下一次 /account 补拉，绝不造一个空账号。
        assert!(account_from_login_body(&serde_json::json!({"code": 803})).is_none());
        assert!(account_from_login_body(&serde_json::json!({"profile": null})).is_none());
        assert!(account_from_login_body(&serde_json::json!({"profile": {}})).is_none());
    }

    #[test]
    fn qr_code_8821_is_a_terminal_rejection_not_a_silent_wait() {
        // 8821 不在 801/802/803 这条链上：qr_state 的兜底是 waiting，直接拿它
        // 会让前端静默空转到超时。必须先拦下来。
        assert_eq!(
            qr_state(Some(8821)),
            "waiting",
            "兜底确实是 waiting，所以必须前置拦截"
        );
        assert_eq!(QR_REJECT_CODE, 8821);
    }

    #[test]
    fn client_cookie_carries_the_identity_upstream_checks() {
        // 手机确认后上游回 8821「升级新版本再试」，比对的就是这几个字段。
        let c = qr_client_cookie();
        assert!(c.contains("os=pc"), "缺 os: {c}");
        assert!(c.contains("appver=3.1.17.204416"), "缺 appver: {c}");
        assert!(c.contains("channel=netease"), "缺 channel: {c}");
        assert!(c.contains("versioncode=140"), "缺 versioncode: {c}");
        // 每次都要变，否则服务端可能按重放处理。
        assert!(c.contains("requestId="), "缺 requestId: {c}");
        assert!(c.contains("buildver="), "缺 buildver: {c}");

        // 叠加 seed：标识在前，NMTID 在后，两者都在。
        let with_seed = qr_cookie("NMTID=abc");
        assert!(with_seed.starts_with("os=pc"), "标识应在最前: {with_seed}");
        assert!(
            with_seed.ends_with("; NMTID=abc"),
            "NMTID 应被回传: {with_seed}"
        );
        // 没有 seed 时不应留下空尾巴。
        assert!(!qr_cookie("").ends_with(';'), "空 seed 不应留分号");
    }

    #[test]
    fn qr_urls_carry_the_agreed_type_on_both_endpoints() {
        // 取 key 与轮询必须用同一个 type，否则上游不认这张票。
        let key_url = api_url("/api/login/qrcode/unikey", &[("type", QR_TYPE)]).unwrap();
        let poll_url = api_url(
            "/api/login/qrcode/client/login",
            &[("key", "k"), ("type", QR_TYPE)],
        )
        .unwrap();
        assert!(key_url.ends_with("?type=3"), "取 key: {key_url}");
        assert!(poll_url.contains("type=3"), "轮询: {poll_url}");
        assert!(poll_url.contains("key=k"));
    }

    #[test]
    fn api_url_percent_encodes_chinese_and_reserved_chars() {
        let u = api_url("/api/x", &[("k", "中文 &a=b")]).unwrap();
        assert!(u.starts_with("https://music.163.com/api/x?"));
        assert!(!u.contains("中文"), "中文必须编码: {u}");
        // 值里的 & 与 = 不能切出新参数。
        assert!(!u.contains("a=b"), "保留字符必须编码: {u}");
        let parsed = reqwest::Url::parse(&u).unwrap();
        let (_, v) = parsed
            .query_pairs()
            .find(|(k, _)| k == "k")
            .expect("query 里应有 k");
        assert_eq!(v, "中文 &a=b");
    }

    #[test]
    fn form_urlencoded_roundtrips_unicode_and_reserved_chars() {
        let mut form = BTreeMap::new();
        form.insert("name".to_string(), "歌 单&x=1".to_string());
        let body = form_urlencoded(&form);
        // 裸 & 会切断表单项，必须被百分号编码。
        assert!(!body.contains("&x="), "表单值未正确编码: {body}");
        let back = reqwest::Url::parse(&format!("https://local.invalid/?{body}")).unwrap();
        let (_, v) = back
            .query_pairs()
            .find(|(k, _)| k == "name")
            .expect("表单里应有 name");
        assert_eq!(v, "歌 单&x=1");
    }
}
