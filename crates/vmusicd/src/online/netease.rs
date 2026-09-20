// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 网易云音源。
//!
//! 用的是公开的 /api/search/get 与 /api/song/detail 接口，和网页端自己调的是
//! 同一套端点。这里**不**实现任何签名算法、设备指纹或加密音频解密：需要登录
//! 的场景一律由用户把自己账号的 cookie 填进设置，我们只是原样转发给网易云。

use super::{
    client, https_url, ApiError, ApiResult, Ctx, OnlineDetail, OnlineTrack, SearchPage,
    SearchQuery, StreamInfo,
};

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
    let client = client()?;
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

    let cookie = ctx.cookie("netease").await;
    let mut req = client
        .get("https://music.163.com/api/search/get/")
        .query(&[
            ("s", term.as_str()),
            ("type", "1"),
            ("limit", &limit.to_string()),
            ("offset", &offset.to_string()),
        ])
        .header("Referer", "https://music.163.com")
        .header("Accept", "application/json");
    req = with_cookie(req, cookie.as_deref());

    let resp = req
        .send()
        .await
        .map_err(|e| ApiError::internal(format!("连接网易云失败: {e}")))?;

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
        return Err(ApiError::internal(format!(
            "网易云拒绝了这次搜索（code {code}），稍后重试或换关键词"
        )));
    }

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

    let tracks = songs.iter().map(netease_track).collect::<Vec<_>>();

    Ok(SearchPage {
        source: "netease".into(),
        keyword: term,
        total,
        tracks,
        warning: None,
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
        .and_then(|a| a.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string();
    // /api/search/get 的 album 里通常只有 picId 没有拼好的 picUrl，而艺人的
    // img1v1Url 倒是直接可用。优先专辑封面，拿不到就退回艺人头像——比空着强，
    // 舞台取色也因此能出结果。
    let cover = song
        .get("album")
        .and_then(|a| a.get("picUrl"))
        .and_then(|n| n.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            song.get("artists")
                .and_then(|a| a.as_array())
                .and_then(|arr| arr.first())
                .and_then(|a| a.get("img1v1Url"))
                .and_then(|n| n.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        });

    OnlineTrack {
        source: "netease".into(),
        id,
        title: song
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("未知曲目")
            .to_string(),
        artist: song_artists(song),
        album,
        duration_ms: song.get("duration").and_then(|v| v.as_u64()).unwrap_or(0),
        cover,
        // 网易云对外链试听有版权限制，能不能播要等 /url 接口确认。
        // 这里统一标 true，实际播放时再报错，避免"看起来全不可点"。
        playable: true,
    }
}

fn song_artists(song: &serde_json::Value) -> String {
    song.get("artists")
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

pub async fn stream(ctx: &Ctx, id: &str, quality: u32) -> ApiResult<StreamInfo> {
    let cookie = ctx.cookie("netease").await;
    let client = client()?;
    let req = client
        .get("https://music.163.com/api/song/enhance/player/url")
        .query(&[("ids", &format!("[{id}]")), ("br", &quality.to_string())])
        .header("Referer", "https://music.163.com");
    let resp = with_cookie(req, cookie.as_deref())
        .send()
        .await
        .map_err(|e| ApiError::internal(format!("获取试听地址失败: {e}")))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ApiError::internal(format!("试听响应解析失败: {e}")))?;

    let entry = body
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| ApiError::internal("上游未返回试听信息".to_string()))?;

    let url = entry
        .get("url")
        .and_then(|u| u.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            // 同一条「没有地址」在登录态前后是可修与不可修的两件事，分开说才
            // 值得用户去设置里粘一次 cookie。
            if cookie.is_some() {
                ApiError::internal(
                    "这首歌在你的账号里也没有可用的试听地址（大概率是版权下架）".to_string(),
                )
            } else {
                ApiError::internal(
                    "这首歌需要登录：在「设置 → 在线音源」里填入你自己网易云账号的 cookie 再试"
                        .to_string(),
                )
            }
        })?;

    Ok(StreamInfo {
        url: url.to_string(),
        source: "netease".into(),
        id: id.to_string(),
        bitrate: entry.get("br").and_then(|v| v.as_u64()),
        expires_in_secs: entry.get("expi").and_then(|v| v.as_u64()),
    })
}

/// 单曲详情。搜索接口返回的字段不全（尤其是封面），播放前用它补齐。
pub async fn detail(ctx: &Ctx, id: &str) -> ApiResult<OnlineDetail> {
    let cookie = ctx.cookie("netease").await;
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
        .and_then(|a| a.get("picUrl"))
        .and_then(|v| v.as_str())
        .and_then(https_url)
        .or_else(|| {
            song.get("artists")
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
            .and_then(|a| a.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        duration_ms: song.get("duration").and_then(|v| v.as_u64()).unwrap_or(0),
        cover,
    })
}

pub async fn lyric(ctx: &Ctx, id: &str) -> ApiResult<vmusic_core::LyricDocument> {
    let cookie = ctx.cookie("netease").await;
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

    // 翻译歌词（tlyric）目前不合并：舞台的逐字擦除靠原文时间轴，译文混进去
    // 只会让同一行的字数对不上。
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
    vmusic_lyrics::apply_offset(&mut doc);
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // 搜索接口没给专辑封 URL 时退回艺人头像，而不是留空
        assert_eq!(t.cover.as_deref(), Some("http://p1.music.126.net/a.jpg"));
        assert!(t.playable);
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
}
