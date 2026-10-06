// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 本地歌曲在线补全（folia 的「整理歌曲信息」batchAutoMatch）。
//!
//! 分两阶段，写入永远是用户点的：
//!
//! 1. `suggest_tracks`（`POST /v1/tracks/complete/suggest`）只搜索打分、
//!    返回每首的候选与缺口，**不写任何数据**；
//! 2. `apply_choice`（`POST /v1/tracks/complete/apply`）按用户选中的候选落地。
//!
//! 早期版本在 suggest 的位置直接写库：用户看不见也拦不住，错了只能事后去删。
//! 打分规则不变——按「标题 - 歌手 - 专辑」构造查询词 → 网易云搜索（limit 10）
//! → 加权打分（标题 45 / 歌手 25 / 专辑 30，缺项封顶 74；时长差 1s 内 1.0、
//! 3s 内 0.95、5s 内 0.75）→ 过阈值（标题命中且 ≥60）即算候选。
//!
//! 落地时**只补缺、不覆盖**：专辑缺失补专辑（写 track_edits 覆盖层）、
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
/// 每曲回给前端的候选数：够用户判断，又不至于把响应撑大。
const MAX_CANDIDATES: usize = 3;

/// 候选阶段请求：只读，不写库。
#[derive(serde::Deserialize)]
pub(crate) struct SuggestRequest {
    pub(crate) track_ids: Vec<String>,
    /// 匹配音源；目前只有网易云实现了完整链路，缺省即网易云。
    #[serde(default)]
    pub(crate) source: Option<String>,
}

/// 落地请求：单曲单候选，用户点一次才写一次。
#[derive(serde::Deserialize)]
pub(crate) struct ApplyRequest {
    pub(crate) track_id: String,
    #[serde(default)]
    pub(crate) source: Option<String>,
    /// 选中的候选 id；`None` = 用户明确「不匹配」，只记决定、不写任何数据。
    #[serde(default)]
    pub(crate) candidate_id: Option<String>,
    /// 允许落地的槽位（`album` / `cover` / `lyrics`），缺省 = 三个都允许。
    /// 即便允许，服务端仍然只补缺、不覆盖。
    #[serde(default)]
    pub(crate) slots: Option<Vec<String>>,
}

/// 槽位白名单：前端传别的值一律忽略，不认。
fn slot_enabled(slots: &Option<Vec<String>>, name: &str) -> bool {
    match slots {
        None => true,
        Some(list) => list.iter().any(|s| s == name),
    }
}

fn resolve_source(source: &Option<String>) -> String {
    source
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "netease".to_string())
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

/// 单曲候选：搜索 → 打分 → 取前 N 个过阈值的候选。不写任何数据。
async fn suggest_one(
    state: &AppState,
    track: &vmusic_core::Track,
    source: &str,
) -> ApiResult<Vec<Value>> {
    let ctx = online_ctx(state);
    let query = online::SearchQuery {
        q: Some(build_query(track)),
        cat: None,
        source: source.to_string(),
        limit: 10,
        offset: 0,
    };
    let page = online::search(&ctx, query).await?;
    let mut scored: Vec<(f64, &online::OnlineTrack)> = Vec::new();
    for candidate in &page.tracks {
        let (score, hit) = match_score(track, candidate);
        if hit {
            scored.push((score, candidate));
        }
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(scored
        .into_iter()
        .take(MAX_CANDIDATES)
        .map(|(score, c)| {
            json!({
                "id": c.id,
                "title": c.title,
                "artist": c.artist,
                "album": c.album,
                "duration_ms": c.duration_ms,
                "cover": c.cover,
                "score": score.round(),
            })
        })
        .collect())
}

/// 缺口：哪些槽位是空的（只有空的才可能被补，服务端落地时再核一次）。
async fn missing_slots(state: &AppState, track: &vmusic_core::Track) -> Value {
    let lyrics = crate::routes::lyric_doc_for(state, track).await;
    json!({
        "album": track.album.as_deref().map(str::trim).unwrap_or("").is_empty(),
        "cover": !track.has_cover,
        "lyrics": lyrics.lines.is_empty(),
    })
}

/// 单曲落地：按用户选中的候选补缺。`candidate_id` 为 None 表示「不匹配」，
/// 只记决定、不写数据。
async fn apply_one(
    state: &AppState,
    track: &vmusic_core::Track,
    source: &str,
    candidate_id: Option<&str>,
    slots: &Option<Vec<String>>,
) -> ApiResult<Value> {
    let Some(candidate_id) = candidate_id else {
        // 用户明确拒绝：记下来，后续候选阶段直接跳过这首。
        vmusic_store::no_auto_match::mark(&state.db, &track.id)
            .await
            .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
        return Ok(json!({ "status": "skipped", "reason": "已标记不再自动匹配" }));
    };

    let ctx = online_ctx(state);
    // 候选详情重新取一次：封面/专辑以平台当前值为准，不信任前端回传的字段。
    let detail = online::detail(&ctx, source, candidate_id).await?;

    let mut filled = Filled { album: false, cover: false, lyrics: false };

    // 专辑缺失 → 写覆盖层（不碰文件标签）。
    if slot_enabled(slots, "album")
        && track.album.as_deref().map(str::trim).unwrap_or("").is_empty()
        && !detail.album.trim().is_empty()
    {
        vmusic_store::track_edits::apply(
            &state.db,
            &track.id,
            &vmusic_store::track_edits::EditInput {
                album: Some(detail.album.clone()),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
        filled.album = true;
    }

    // 无封面 → 下载落缓存（失败不拖垮其余槽位，folia 同款状态）。
    if slot_enabled(slots, "cover") && !track.has_cover {
        if let Some(cover_url) = detail.cover.clone() {
            match download_cover(state, &track.id, &cover_url).await {
                Ok(()) => filled.cover = true,
                Err(e) => tracing::debug!("补全封面下载失败（不影响其余字段）: {e:?}"),
            }
        }
    }

    // 无歌词（三层都空）→ 导入在线歌词原文。
    if slot_enabled(slots, "lyrics") {
        let existing = crate::routes::lyric_doc_for(state, track).await;
        if existing.lines.is_empty() {
            let doc = online::lyric(&ctx, source, candidate_id)
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
    }

    // 用户这次接受了候选：之前若有「不匹配」决定，就此撤销。
    vmusic_store::no_auto_match::clear(&state.db, &track.id)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;

    Ok(json!({
        "status": "applied",
        "filled": { "album": filled.album, "cover": filled.cover, "lyrics": filled.lyrics },
    }))
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
    // `save_cover` 自己会接上 `covers/`：这里给缓存根目录，给 `cover_dir()`
    // 会写进 `covers/covers/`，`GET /tracks/{id}/cover` 就再也找不到这张图。
    let dir = state.cache_dir();
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

/// 候选阶段入口（HTTP 与 RPC 共用）：逐曲串行搜索、上游压力可控，
/// 单首失败记 failed 不拖垮整批。**不写任何数据。**
pub(crate) async fn suggest_tracks(
    state: &Arc<AppState>,
    body: &SuggestRequest,
) -> ApiResult<Value> {
    if body.track_ids.is_empty() {
        return Err(crate::error::bad_request("track_ids must not be empty"));
    }
    if body.track_ids.len() > MAX_BATCH {
        return Err(crate::error::bad_request(format!(
            "单批最多 {MAX_BATCH} 首，分批再试"
        )));
    }
    let source = resolve_source(&body.source);

    // 一次性取出被标记「不匹配」的曲目：这些连候选都不再给。
    let marked = vmusic_store::no_auto_match::marked_ids(&state.db, &body.track_ids)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))
        .unwrap_or_default();

    let mut suggested = 0usize;
    let mut no_match = 0usize;
    let mut skipped = 0usize;
    let mut failed = 0usize;
    let mut results: Vec<Value> = Vec::with_capacity(body.track_ids.len());

    for id in &body.track_ids {
        if crate::online::split_virtual_id(id).is_some() {
            skipped += 1;
            results.push(json!({ "track_id": id, "status": "skipped", "reason": "在线曲目无需补全" }));
            continue;
        }
        let track = match vmusic_store::get_track(&state.db, id).await {
            Ok(Some(t)) => t,
            Ok(None) => {
                no_match += 1;
                results.push(json!({ "track_id": id, "status": "no_match" }));
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
        if marked.contains(&track.id) {
            skipped += 1;
            results.push(json!({
                "track_id": id,
                "title": track.title,
                "artist": track.artist,
                "status": "skipped",
                "reason": "已标记不再自动匹配",
            }));
            continue;
        }
        match suggest_one(state, &track, &source).await {
            Ok(candidates) => {
                let missing = missing_slots(state, &track).await;
                let nothing_missing = missing["album"] == json!(false)
                    && missing["cover"] == json!(false)
                    && missing["lyrics"] == json!(false);
                let status = if candidates.is_empty() {
                    no_match += 1;
                    "no_match"
                } else if nothing_missing {
                    // 有候选但没有缺口：给用户看，不必落地。
                    suggested += 1;
                    "nothing_to_fill"
                } else {
                    suggested += 1;
                    "match"
                };
                results.push(json!({
                    "track_id": id,
                    "title": track.title,
                    "artist": track.artist,
                    "album": track.album,
                    "status": status,
                    "missing": missing,
                    "candidates": candidates,
                }));
            }
            Err(e) => {
                tracing::debug!("补全候选失败 {id}: {e:?}");
                failed += 1;
                results.push(json!({
                    "track_id": id,
                    "title": track.title,
                    "artist": track.artist,
                    "status": "failed",
                }));
            }
        }
    }

    Ok(json!({
        "suggested": suggested,
        "no_match": no_match,
        "skipped": skipped,
        "failed": failed,
        "results": results,
    }))
}

/// 落地阶段入口：单曲单候选。用户点一次才写一次，天然原子。
pub(crate) async fn apply_choice(
    state: &Arc<AppState>,
    body: &ApplyRequest,
) -> ApiResult<Value> {
    if crate::online::split_virtual_id(&body.track_id).is_some() {
        return Err(crate::error::bad_request("在线曲目无需补全"));
    }
    let track = vmusic_store::get_track(&state.db, &body.track_id)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?
        .ok_or_else(|| crate::error::not_found(format!("track {}", body.track_id)))?;
    let source = resolve_source(&body.source);
    apply_one(
        state,
        &track,
        &source,
        body.candidate_id.as_deref(),
        &body.slots,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 槽位白名单：缺省 = 三个都允许（老调用的语义），显式列表则只认列出的
    /// 名字——前端传别的字符串不该被当成「允许」。
    #[test]
    fn slots_default_to_all_and_unknown_names_are_ignored() {
        assert!(slot_enabled(&None, "album"));
        assert!(slot_enabled(&None, "cover"));
        assert!(slot_enabled(&None, "lyrics"));

        let only_cover = Some(vec!["cover".to_string()]);
        assert!(slot_enabled(&only_cover, "cover"));
        assert!(!slot_enabled(&only_cover, "album"));
        assert!(!slot_enabled(&only_cover, "lyrics"));

        let junk = Some(vec!["everything".to_string()]);
        assert!(!slot_enabled(&junk, "album"));
        assert!(!slot_enabled(&junk, "cover"));
    }

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
