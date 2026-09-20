// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! CCmixter 音源。
//!
//! Creative Commons 授权的音乐社区，接口是公开文档化的、无需凭据，直链就是
//! 普通 mp3。接它的理由是：它是**能合法播放**的第二曲库，而不是因为它歌多。
//!
//! ## 为什么 id 是路径而不是数字
//!
//! 它的 query 接口只能按关键词检索，没有「按 id 取一首歌」的入口。所以搜索
//! 结果里唯一能长期指代一首歌的东西就是它的直链路径，这里就把它当作 id：
//! `content/<作者>/<文件名>.mp3`。 [`audio_url`] 因此是这条链路上唯一的信任
//! 边界——它必须自己校验形状，不接受任意 URL，否则前端传什么我们就去取什么。

use super::{
    client, ApiError, ApiResult, Ctx, OnlineDetail, OnlineTrack, SearchPage, SearchQuery,
    StreamInfo,
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

    let resp = client()?
        .get(QUERY)
        .query(&[
            ("f", "json"),
            ("search_type", "tracks"),
            ("q", term),
            ("limit", &limit.to_string()),
            ("offset", &offset.to_string()),
        ])
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| ApiError::internal(format!("连接 CCmixter 失败: {e}")))?;
    if !resp.status().is_success() {
        return Err(ApiError::internal(format!(
            "CCmixter 返回 {}",
            resp.status()
        )));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ApiError::internal(format!("CCmixter 响应解析失败: {e}")))?;

    let uploads = body
        .as_array()
        .cloned()
        .or_else(|| body.get("items").and_then(|v| v.as_array()).cloned())
        .unwrap_or_default();

    let mut tracks = Vec::with_capacity(uploads.len());
    for upload in &uploads {
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
    })
}

/// 把一条 upload 折成曲目。一首上传可能带多个文件（不同格式），取第一个能直链
/// 播放的 mp3；一个都没有就整条丢掉，而不是挂一首点开必挂的歌。
fn upload_track(upload: &serde_json::Value) -> Option<OnlineTrack> {
    let files = upload.get("files")?.as_array()?;
    let file = files.iter().find(|f| {
        f.get("download_url")
            .and_then(|u| u.as_str())
            .is_some_and(|u| u.starts_with("http") && u.ends_with(".mp3"))
    })?;

    let url = file.get("download_url")?.as_str()?;
    let id = url.strip_prefix(ORIGIN)?.strip_prefix('/')?;
    if !is_safe_path(id) {
        return None;
    }

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
        id: id.to_string(),
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
    })
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

/// 试听地址：CCmixter 的直链就是最终地址，不需要再解析一次。
pub async fn stream(ctx: &Ctx, id: &str, _quality: u32) -> ApiResult<StreamInfo> {
    let _ = ctx;
    Ok(StreamInfo {
        url: audio_url(id)?,
        source: "ccmixter".into(),
        id: id.to_string(),
        bitrate: None,
        expires_in_secs: None,
    })
}

/// 没有按 id 查详情的接口。返回错误而不是编一个空壳，调用方（补封面那条路径）
/// 本来就按「拿不到就算了」处理。
pub async fn detail(_ctx: &Ctx, id: &str) -> ApiResult<OnlineDetail> {
    Err(super::bad_request(format!(
        "CCmixter 没有单曲详情接口，元数据以搜索结果为准（id {id}）"
    )))
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
        // id 是站内路径，不含协议头
        assert!(t.id.starts_with("content/"));
        assert!(!t.id.contains("https"));
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
