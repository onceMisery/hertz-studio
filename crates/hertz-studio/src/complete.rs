// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 本地歌曲在线补全（folia 的「整理歌曲信息」batchAutoMatch）。
//!
//! 流程：按「标题 - 歌手 - 专辑」构造查询词 → 网易云搜索（limit 10）→
//! 加权打分（标题 45 / 歌手 25 / 专辑 30，缺项封顶 74；时长差 1s 内 1.0、
//! 3s 内 0.95、5s 内 0.75）→ 过阈值即采纳。
//!
//! 采纳后**只补缺、不覆盖**：专辑缺失补专辑（写 track_edits 覆盖层）、
//! 无封面下载在线封面（落封面缓存 + cover_edited）、无歌词导入在线歌词
//! （存 LRC 原文）。标题/歌手永远不动——它们是匹配的依据，也是用户文件
//! 里的既有事实；folia 会整体重写标签，这里选择更保守的路线。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{internal, ApiError, ApiResult};
use crate::online;
use crate::routes::online_ctx;
use crate::state::AppState;

/// 采纳阈值：标题必须命中（folia 的 titleMatched 同义），且加权分 ≥60。
const ACCEPT_SCORE: f64 = 60.0;
/// 单批上限：每首都要打一次上游搜索，批太大会把限流踩穿。
const MAX_BATCH: usize = 50;

#[derive(serde::Deserialize)]
pub(crate) struct CompleteRequest {
    pub(crate) track_ids: Vec<String>,
    /// 匹配音源；目前只有网易云实现了完整链路，缺省即网易云。
    #[serde(default)]
    pub(crate) source: Option<String>,
}

/// 归一化比对：小写、去空白与标点。中文歌名里的全角括号/空格差异全消。
fn norm(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn component_score(haystack: &str, needle: &str, weight: f64) -> (f64, bool) {
    let (h, n) = (norm(haystack), norm(needle));
    if n.is_empty() {
        return (0.0, false);
    }
    if h == n {
        return (weight, true);
    }
    if h.contains(&n) || n.contains(&h) {
        return (weight * 0.7, true);
    }
    (0.0, false)
}

/// folia matchScore 的简化版：三分加权 + 缺项封顶 + 时长乘数。
fn match_score(
    local: &vmusic_core::Track,
    candidate: &online::OnlineTrack,
) -> (f64, bool) {
    let (title_s, title_hit) = component_score(&candidate.title, &local.title, 45.0);
    let artist = local.artist.as_deref().unwrap_or("");
    let album = local.album.as_deref().unwrap_or("");
    let (artist_s, artist_hit) = component_score(&candidate.artist, artist, 25.0);
    let (album_s, album_hit) = component_score(&candidate.album, album, 30.0);
    let mut score = title_s + artist_s + album_s;
    // 任一非空维度没命中：封顶 74（folia 同值）。标题没命中直接判不匹配。
    if !title_hit {
        return (0.0, false);
    }
    if (!artist_hit && !artist.is_empty()) || (!album_hit && !album.is_empty()) {
        score = score.min(74.0);
    }
    // 时长乘数：本地与在线的时长差。
    if let (Some(local_ms), cand_ms) = (local.duration_ms, candidate.duration_ms) {
        if cand_ms > 0 && local_ms > 0 {
            let diff = local_ms.abs_diff(cand_ms);
            let mult = if diff <= 1000 {
                1.0
            } else if diff <= 3000 {
                0.95
            } else if diff <= 5000 {
                0.75
            } else {
                0.55
            };
            score *= mult;
        }
    }
    (score, score >= ACCEPT_SCORE)
}

/// 查询词：`title - artist - album`（专辑截到 48 字符，folia 同规则）。
fn build_query(track: &vmusic_core::Track) -> String {
    let mut parts = vec![track.title.trim().to_string()];
    if let Some(artist) = track.artist.as_deref() {
        let artist = artist.trim();
        if !artist.is_empty() {
            parts.push(artist.to_string());
        }
    }
    if let Some(album) = track.album.as_deref() {
        let album: String = album.trim().chars().take(48).collect();
        if !album.is_empty() {
            parts.push(album);
        }
    }
    parts.join(" - ")
}

/// LyricDocument → LRC 原文（导入歌词表存的是原文，读取端再解析）。
///
/// 时间戳必须是标准 `[mm:ss.xxx]`：`try_timestamp` 把两段式解析成
/// 「分:秒」，写成 `[总秒:毫秒]` 会让 2:45.123 变成 167 分钟。
/// 翻译不导出：LRC 原文里无法无损还原 `translation` 平行数组（同时间戳
/// 的译文行会被解析端读成两条同刻歌词行），与在线歌词不合并 tlyric 同口径。
fn doc_to_lrc(doc: &vmusic_core::LyricDocument) -> String {
    fn stamp(start_ms: u64) -> String {
        let mm = start_ms / 60_000;
        let ss = (start_ms % 60_000) / 1000;
        let ms = start_ms % 1000;
        format!("[{mm:02}:{ss:02}.{ms:03}]")
    }
    let mut out = String::new();
    for line in &doc.lines {
        if line.words.is_empty() {
            out.push_str(&format!("{}{}\n", stamp(line.start_ms), line.text));
        } else {
            // 逐词行：首个词戳兼任行戳。行戳后紧跟词戳的「空首段」形态会被
            // 读取端判定为重复戳展开（parse_lyric_line 的空首段规则），词级
            // 信息就丢了。
            for w in &line.words {
                out.push_str(&format!("{}{}", stamp(w.start_ms), w.text));
            }
            out.push('\n');
        }
    }
    out
}

struct Filled {
    album: bool,
    cover: bool,
    lyrics: bool,
}

/// 单曲补全：搜索 → 打分 → 采纳 → 补缺。返回 (状态, 补了什么)。
async fn complete_one(
    state: &AppState,
    track: &vmusic_core::Track,
    source: &str,
) -> ApiResult<(String, Filled)> {
    let ctx = online_ctx(state);
    let query = online::SearchQuery {
        q: Some(build_query(track)),
        cat: None,
        source: source.to_string(),
        limit: 10,
        offset: 0,
    };
    let page = online::search(&ctx, query).await?;
    let mut best: Option<(f64, &online::OnlineTrack)> = None;
    for candidate in &page.tracks {
        let (score, hit) = match_score(track, candidate);
        if hit && best.map_or(true, |(s, _)| score > s) {
            best = Some((score, candidate));
        }
    }
    let Some((_score, candidate)) = best else {
        return Ok(("no_match".into(), Filled { album: false, cover: false, lyrics: false }));
    };

    let mut filled = Filled { album: false, cover: false, lyrics: false };
    let id = candidate.id.clone();

    // 专辑缺失 → 写覆盖层（不碰文件标签）。
    if track.album.as_deref().map(str::trim).unwrap_or("").is_empty()
        && !candidate.album.trim().is_empty()
    {
        vmusic_store::track_edits::apply(
            &state.db,
            &track.id,
            &vmusic_store::track_edits::EditInput {
                album: Some(candidate.album.clone()),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
        filled.album = true;
    }

    // 无封面 → 详情拿封面地址 → 下载落缓存（失败记 matched-cover-failed，
    // folia 同款状态，不算整体失败）。
    if !track.has_cover {
        let detail = online::detail(&ctx, source, &id).await.ok();
        if let Some(cover_url) = detail.as_ref().and_then(|d| d.cover.clone()) {
            match download_cover(state, &track.id, &cover_url).await {
                Ok(()) => filled.cover = true,
                Err(e) => tracing::debug!("补全封面下载失败（不影响其余字段）: {e:?}"),
            }
        }
    }

    // 无歌词（三层都空）→ 导入在线歌词原文。
    let existing = crate::routes::lyric_doc_for(state, track).await;
    if existing.lines.is_empty() {
        let doc = online::lyric(&ctx, source, &id)
            .await
            .unwrap_or_else(|_| vmusic_core::LyricDocument::empty());
        if !doc.lines.is_empty() {
            let lrc = doc_to_lrc(&doc);
            vmusic_store::lyrics::import(&state.db, &track.id, &lrc)
                .await
                .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
            filled.lyrics = true;
        }
    }

    Ok(("matched".into(), filled))
}

/// 下载在线封面到本地封面缓存（与手动替换封面同一落点：cover_edited 置位，
/// 重扫不会拿旧标签盖回去）。
async fn download_cover(state: &AppState, track_id: &str, url: &str) -> ApiResult<()> {
    let client = online::client()?;
    let bytes = client
        .get(url)
        .send()
        .await
        .map_err(|e| ApiError::upstream_rejected(format!("封面下载失败: {e}")))?
        .bytes()
        .await
        .map_err(|e| ApiError::upstream_rejected(format!("封面读取失败: {e}")))?;
    if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
        return Err(ApiError::upstream_rejected("封面内容为空或超过 8MiB"));
    }
    // 从 URL 后缀猜媒体类型，猜不出按 jpeg。
    let media_type = url
        .rsplit('.')
        .next()
        .and_then(|ext| match ext.split(&['?', '/'][..]).next().unwrap_or("") {
            "png" => Some("image/png"),
            "webp" => Some("image/webp"),
            "gif" => Some("image/gif"),
            "jpg" | "jpeg" => Some("image/jpeg"),
            _ => None,
        })
        .unwrap_or("image/jpeg");
    let dir = state.cover_dir();
    let tid = track_id.to_string();
    let data = bytes.to_vec();
    let saved = tokio::task::spawn_blocking(move || {
        vmusic_library::save_cover(&dir, &tid, &data, media_type)
    })
    .await
    .map_err(|e| internal(e.to_string()))?;
    if saved.is_none() {
        return Err(internal("封面落盘失败"));
    }
    vmusic_store::track_edits::set_cover_edited(&state.db, track_id, true)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    vmusic_store::set_has_cover(&state.db, &track_id.to_string(), true)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    Ok(())
}

/// 批量补全入口（HTTP 与 RPC 共用）：逐曲串行、上游压力可控，单首失败
/// 记 failed 不拖垮整批。
pub(crate) async fn complete_tracks(
    state: &Arc<AppState>,
    body: &CompleteRequest,
) -> ApiResult<Value> {
    if body.track_ids.is_empty() {
        return Err(crate::error::bad_request("track_ids must not be empty"));
    }
    if body.track_ids.len() > MAX_BATCH {
        return Err(crate::error::bad_request(format!(
            "单批最多 {MAX_BATCH} 首，分批再试"
        )));
    }
    let source = body
        .source
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "netease".to_string());

    let mut matched = 0usize;
    let mut no_match = 0usize;
    let mut failed = 0usize;
    let mut filled_albums = 0usize;
    let mut filled_covers = 0usize;
    let mut filled_lyrics = 0usize;
    let mut results: Vec<Value> = Vec::with_capacity(body.track_ids.len());

    for id in &body.track_ids {
        if crate::online::split_virtual_id(id).is_some() {
            results.push(json!({ "track_id": id, "status": "skipped", "reason": "在线曲目无需补全" }));
            continue;
        }
        let track = match vmusic_store::get_track(&state.db, id).await {
            Ok(Some(t)) => t,
            Ok(None) => {
                results.push(json!({ "track_id": id, "status": "no_match" }));
                no_match += 1;
                continue;
            }
            Err(e) => {
                let err = ApiError::from(vmusic_core::CoreError::Store(e));
                tracing::debug!("补全读曲失败: {err:?}");
                failed += 1;
                results.push(json!({ "track_id": id, "status": "failed" }));
                continue;
            }
        };
        match complete_one(state, &track, &source).await {
            Ok((status, filled)) => {
                if status == "matched" {
                    matched += 1;
                    if filled.album {
                        filled_albums += 1;
                    }
                    if filled.cover {
                        filled_covers += 1;
                    }
                    if filled.lyrics {
                        filled_lyrics += 1;
                    }
                } else {
                    no_match += 1;
                }
                results.push(json!({
                    "track_id": id,
                    "status": status,
                    "filled": {
                        "album": filled.album,
                        "cover": filled.cover,
                        "lyrics": filled.lyrics,
                    },
                }));
            }
            Err(e) => {
                tracing::debug!("补全失败 {id}: {e:?}");
                failed += 1;
                results.push(json!({ "track_id": id, "status": "failed" }));
            }
        }
    }

    Ok(json!({
        "matched": matched,
        "no_match": no_match,
        "failed": failed,
        "filled_albums": filled_albums,
        "filled_covers": filled_covers,
        "filled_lyrics": filled_lyrics,
        "results": results,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 导出的 LRC 必须能被读取端原样还原时间轴：`doc_to_lrc` 曾把
    /// `[总秒:毫秒]` 当 `[分:秒]` 写，2:45.123 被读成 167 分钟。
    #[test]
    fn doc_to_lrc_roundtrips_through_parse_lrc() {
        let doc = vmusic_core::LyricDocument {
            source: vmusic_core::LyricSource::Imported,
            offset_ms: 0,
            lines: vec![
                vmusic_core::LyricLine {
                    text: "晴天".into(),
                    start_ms: 165_123,
                    end_ms: Some(201_456),
                    words: vec![
                        vmusic_core::LyricWord { text: "晴".into(), start_ms: 165_123, end_ms: Some(166_000) },
                        vmusic_core::LyricWord { text: "天".into(), start_ms: 166_000, end_ms: Some(167_000) },
                    ],
                },
                vmusic_core::LyricLine {
                    text: "故事的小黄花".into(),
                    start_ms: 201_456,
                    end_ms: None,
                    words: Vec::new(),
                },
            ],
            translation: None,
        };
        let parsed = vmusic_lyrics::parse_lrc(&doc_to_lrc(&doc));
        assert_eq!(parsed.lines.len(), 2);
        assert_eq!(parsed.lines[0].start_ms, 165_123);
        assert_eq!(parsed.lines[1].start_ms, 201_456);
        // 逐词行还原出词级时间戳（词序保持）。
        let words: Vec<u64> = parsed.lines[0].words.iter().map(|w| w.start_ms).collect();
        assert_eq!(words, vec![165_123, 166_000]);
    }
}
