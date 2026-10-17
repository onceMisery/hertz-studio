// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! CCmixter 音源。
//!
//! Creative Commons 授权的音乐社区，接口是公开文档化的、无需凭据，直链就是
//! 普通 mp3。接它的理由是：它是**能合法播放**的第二曲库，而不是因为它歌多。
//!
//! 使用 upload_id 标识作品，通过公开 query API 的 ids 参数回查详情和音频。
//! 历史收藏中的 content/<作者>/<文件名>.mp3 仍通过原有路径白名单播放。

use super::{
    client, ApiError, ApiResult, Ctx, OnlineDetail, OnlineTrack, SearchPage, SearchPagination,
    SearchQuery, StreamInfo,
};

const ORIGIN: &str = "https://ccmixter.org";
const QUERY: &str = "https://ccmixter.org/api/query";

pub async fn search(ctx: &Ctx, q: &SearchQuery) -> ApiResult<SearchPage> {
    let _ = ctx; // 这个音源不需要凭据
    let term = q.q.clone().unwrap_or_default();
    let term = term.trim();
    if term.is_empty() {
        // 分类 chips 在界面上对这个音源是隐藏的（SOURCES 里 cats 为空），
        // 走到这里只可能是直接构造了请求。
        return Err(super::bad_request(
            "CCmixter 只支持关键词检索，请输入歌名或作者",
        ));
    }

    let limit = q.limit.clamp(1, 60);
    let offset = q.offset.min(480);

    let mut url = super::const_url(QUERY)?;
    url.query_pairs_mut().extend_pairs([
        ("f", "json"),
        ("search_type", "all"),
        ("search", term),
        ("limit", &limit.to_string()),
        ("offset", &offset.to_string()),
    ]);
    let body = super::http::get_json(&client()?, url.as_str(), Default::default()).await?;
    let uploads = body
        .as_array()
        .ok_or_else(|| ApiError::upstream_rejected("CCmixter 搜索响应缺少曲目列表"))?;

    let mut tracks = Vec::with_capacity(uploads.len());
    for upload in uploads {
        if let Some(t) = upload_track(upload) {
            tracks.push(t);
        }
    }
    let total = tracks.len();

    Ok(SearchPage {
        source: "ccmixter".into(),
        keyword: term.to_string(),
        total,
        tracks,
        warning: None,
        pagination: Some(SearchPagination {
            next_offset: offset + uploads.len(),
            has_more: uploads.len() >= limit && offset + uploads.len() <= 480,
        }),
    })
}

/// 把一条 upload 折成曲目。一首上传可能带多个文件（不同格式），取第一个能直链
/// 播放的 mp3；一个都没有就整条丢掉，而不是挂一首点开必挂的歌。
fn upload_track(upload: &serde_json::Value) -> Option<OnlineTrack> {
    let id = upload.get("upload_id")?;
    let id = id
        .as_str()
        .map(str::to_string)
        .or_else(|| id.as_u64().map(|n| n.to_string()))?;
    if !valid_upload_id(&id) {
        return None;
    }
    let (file, _) = playable_file(upload)?;

    // 时长在文件格式信息里，写作 m:ss；缺了就当不知道，而不是猜一个 0 让进度条
    // 看起来是坏歌。
    let duration_ms = file
        .get("file_format_info")
        .and_then(|i| i.get("ps"))
        .and_then(|v| v.as_str())
        .map(super::parse_clock_ms)
        .unwrap_or(0);

    let artist = upload
        .get("user_real_name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| upload.get("user_name").and_then(|v| v.as_str()))
        .unwrap_or("未知艺术家")
        .to_string();

    Some(OnlineTrack {
        source: "ccmixter".into(),
        id,
        title: upload
            .get("upload_name")
            .and_then(|v| v.as_str())
            .unwrap_or("未知曲目")
            .to_string(),
        artist,
        // 这个站没有「专辑」这一层；licence_name 是授权条款，塞进 album 字段
        // 会把法务信息当成发行信息展示，所以留空。
        album: String::new(),
        duration_ms,
        cover: None,
        playable: true,
        vip_only: false,
        track_ref: serde_json::json!({
            "license_url": upload.get("license_url").and_then(|v| v.as_str()),
            "license_name": upload.get("license_name").and_then(|v| v.as_str()),
            "webpage_url": upload.get("file_page_url").and_then(|v| v.as_str()),
        }),
    })
}

fn valid_upload_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit())
}

fn playable_file(upload: &serde_json::Value) -> Option<(&serde_json::Value, String)> {
    upload.get("files")?.as_array()?.iter().find_map(|file| {
        let raw = file.get("download_url")?.as_str()?;
        let path = raw
            .strip_prefix("https://ccmixter.org/")
            .or_else(|| raw.strip_prefix("http://ccmixter.org/"))?;
        audio_url(path).ok().map(|url| (file, url))
    })
}

async fn lookup(id: &str) -> ApiResult<serde_json::Value> {
    if !valid_upload_id(id) {
        return Err(super::bad_request("CCmixter 的作品 id 必须是纯数字"));
    }
    let mut url = super::const_url(QUERY)?;
    url.query_pairs_mut()
        .extend_pairs([("f", "json"), ("ids", id)]);
    let body = super::http::get_json(&client()?, url.as_str(), Default::default()).await?;
    body.as_array()
        .ok_or_else(|| ApiError::upstream_rejected("CCmixter 详情响应缺少曲目列表"))?
        .iter()
        .find(|item| {
            item.get("upload_id").is_some_and(|value| {
                value.as_str() == Some(id) || value.as_u64().is_some_and(|n| n.to_string() == id)
            })
        })
        .cloned()
        .ok_or_else(|| ApiError::upstream_rejected("CCmixter 未找到该作品（可能已下架）"))
}

fn audio_url(id: &str) -> ApiResult<String> {
    let id = id.trim();
    if !is_safe_path(id) {
        return Err(super::bad_request(
            "CCmixter 的曲目 id 必须是它自己的直链路径".to_string(),
        ));
    }
    Ok(format!("{ORIGIN}/{id}"))
}

/// 直链路径白名单。
///
/// 只放行 `content/<作者>/<文件名>.mp3` 这一段站内路径：必须以 content/ 开头、
/// 以 .mp3 结尾、且每个字符都落在字母数字与 `-_. /` 之内。协议头、查询串、
/// 片段标识符、反斜杠和 `..` 都被这个字符集天然排除——所以任意 URL 注入
/// （`https://内网地址/`、`file:///`）进不来。
fn is_safe_path(id: &str) -> bool {
    let ok_chars = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ' '));
    id.starts_with("content/")
        && id.ends_with(".mp3")
        && !id.contains("..")
        && id.len() <= 512
        && ok_chars
}

/// 新 ID 按 upload 回查文件；旧收藏继续接受经过白名单校验的站内路径。
pub async fn stream(ctx: &Ctx, id: &str, _quality: u32) -> ApiResult<StreamInfo> {
    let _ = ctx;
    let id = id.trim();
    let url = if valid_upload_id(id) {
        let upload = lookup(id).await?;
        playable_file(&upload)
            .map(|(_, url)| url)
            .ok_or_else(|| ApiError::upstream_rejected("CCmixter 该作品没有可播放的 MP3"))?
    } else {
        audio_url(id)?
    };
    Ok(StreamInfo {
        url,
        source: "ccmixter".into(),
        id: id.to_string(),
        bitrate: None,
        expires_in_secs: None,
        fallbacks: Vec::new(),
        rg_gain_db: None,
        rg_peak: None,
    })
}

pub async fn detail(_ctx: &Ctx, id: &str) -> ApiResult<OnlineDetail> {
    let upload = lookup(id.trim()).await?;
    let t = upload_track(&upload)
        .ok_or_else(|| ApiError::upstream_rejected("CCmixter 该作品没有可播放的 MP3"))?;
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

/// 站内没有官方歌词，返回空文档而不是错误——前端的占位文案比一条红 toast 准。
pub async fn lyric(_ctx: &Ctx, _id: &str) -> ApiResult<vmusic_core::LyricDocument> {
    Ok(vmusic_core::LyricDocument::empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upload() -> serde_json::Value {
        serde_json::json!({
            "upload_id": 71185,
            "upload_name": "Vacation - Ukulele Sample",
            "user_name": "gabriel_shelligton",
            "user_real_name": "Gabriel Shellington",
            "license_name": "Attribution (4.0)",
            "files": [{
                "file_id": 130179,
                "file_name": "gabriel_shelligton_-_Vacation_-_Ukulele_Sample.mp3",
                "file_format_info": {"media-type": "audio", "ps": "0:21"},
                "download_url": "https://ccmixter.org/content/gabriel_shelligton/gabriel_shelligton_-_Vacation_-_Ukulele_Sample.mp3"
            }]
        })
    }

    #[test]
    fn uploads_fold_into_the_shared_track_shape() {
        let t = upload_track(&upload()).expect("这条 upload 应该可播");
        assert_eq!(t.source, "ccmixter");
        assert_eq!(t.title, "Vacation - Ukulele Sample");
        assert_eq!(t.artist, "Gabriel Shellington");
        assert_eq!(t.duration_ms, 21_000);
        assert!(t.playable);
        assert!(t.cover.is_none());
        assert_eq!(t.id, "71185");
        assert!(!t.id.contains("https"));
    }

    #[test]
    fn upload_identity_and_attribution_survive_normalization() {
        let mut u = upload();
        u["license_url"] = serde_json::json!("https://creativecommons.org/licenses/by/4.0/");
        u["file_page_url"] =
            serde_json::json!("https://ccmixter.org/files/gabriel_shelligton/71185");
        let t = upload_track(&u).unwrap();
        assert_eq!(t.id, "71185");
        assert_eq!(t.track_ref["license_url"], u["license_url"]);
        assert_eq!(t.track_ref["webpage_url"], u["file_page_url"]);
    }

    #[test]
    fn unusable_first_file_does_not_hide_a_valid_mp3() {
        let mut u = upload();
        let good = u["files"][0].clone();
        u["files"] = serde_json::json!([
            {"download_url": "https://elsewhere.example/track.mp3"}, good
        ]);
        assert!(upload_track(&u).is_some());
    }

    #[tokio::test]
    #[ignore = "requires access to the public ccMixter API"]
    async fn live_search_respects_keywords_and_numeric_details() {
        let dir = std::env::temp_dir().join(format!("hertz-ccmixter-{}", uuid::Uuid::new_v4()));
        let ctx = Ctx::new(vmusic_store::open(&dir).await.unwrap());
        let q = SearchQuery {
            q: Some("zzhertznonexistent12345678".into()),
            cat: None,
            source: "ccmixter".into(),
            limit: 2,
            offset: 0,
        };
        assert!(search(&ctx, &q).await.unwrap().tracks.is_empty());
        let q = SearchQuery {
            q: Some("Vacation Ukulele Sample".into()),
            limit: 10,
            ..q
        };
        let page = search(&ctx, &q).await.unwrap();
        assert!(page.tracks.iter().any(|t| t.id == "71185"));
        let d = detail(&ctx, "71185").await.unwrap();
        assert_eq!(d.title, "Vacation - Ukulele Sample");
        assert!(stream(&ctx, "71185", 128)
            .await
            .unwrap()
            .url
            .contains("/content/"));
        ctx.db.close().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn artist_falls_back_to_the_login_name() {
        let mut u = upload();
        u["user_real_name"] = serde_json::json!("  ");
        let t = upload_track(&u).unwrap();
        assert_eq!(t.artist, "gabriel_shelligton");
    }

    #[test]
    fn uploads_without_a_playable_mp3_are_dropped() {
        assert!(upload_track(&serde_json::json!({"files": []})).is_none());
        assert!(upload_track(&serde_json::json!({})).is_none());
        let mut u = upload();
        u["files"][0]["download_url"] = serde_json::json!("https://elsewhere.example/a.wav");
        assert!(upload_track(&u).is_none());
    }

    #[test]
    fn only_site_content_paths_are_accepted_as_ids() {
        assert!(audio_url("content/a/a.mp3").is_ok());
        for bad in [
            "https://attacker.example/x.mp3",
            "content/a/../../etc/passwd.mp3",
            "content/a/x.wav",
            "content/a/x.mp3?next=http://169.254.169.254/",
            "file:///etc/passwd.mp3",
            "content/a/x.mp3#frag",
            "other/a/x.mp3",
            "",
            "content/a/\u{7c}x.mp3",
        ] {
            assert!(audio_url(bad).is_err(), "这个 id 不该被接受: {bad:?}");
        }
    }

    #[test]
    fn long_ids_are_refused() {
        let long = format!("content/{}x.mp3", "a".repeat(600));
        assert!(audio_url(&long).is_err());
    }
}
