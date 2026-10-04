// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 在线曲库（代理）：搜索、取流、详情、歌词、整盘播放、FM 电台、缓存、音质、
//! cookie 登录、扫码登录、平台歌单、红心与推荐。
//!
//! 逐个对应 `routes.rs` 里的同名 handler，逻辑照抄（理由见 `rpc/mod.rs`）。这一域
//! 几乎全是薄转发——校验入参 → 过能力闸门（在 `online::dispatch` 内）→ 回统一
//! DTO——所以两边的差别只剩取参方式。
//!
//! # 三件必须与 HTTP 版逐字一致的事
//!
//! 1. **错误带音源 id**。`tagged()` 把 `source` 挂到 `ApiError` 上，前端据此按平台
//!    分流提示（去登录 / 版权 / 限流），不解析 message。漏掉的表现是所有平台的
//!    失败都长得一样。
//! 2. **查询参数用 `query_as`**（见 `rpc/mod.rs`）：这一域有九个不同的 query 结构
//!    体，各自带 `#[serde(default)]` 与自定义默认值（`limit` 缺省 30、`scope`
//!    缺省 created），手写「按字符串读再 parse」要把这些默认值全复刻一遍，漏一个
//!    就是只在插件形态下出现的分页错乱。
//! 3. **写操作失败绝不伪造空成功**。任何平台侧失败都原样透传 `ApiError`。
//!
//! # 扫码登录的票为什么要在服务端换一次
//!
//! 平台握手票绝不离开服务端：`qr_start` 把它收进 Registry 换成不透明 ticket，
//! 前端轮询/取消只认 ticket；`qr_poll` 还要校验票属于请求的那个音源——否则 A 平台
//! 的票投到 B 平台的 check 里，confirmed 时会把 A 的凭据写进 B 的保险库。这套
//! 逻辑在 `routes::qr_session` 里，两边共用同一份。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{bad_request, internal, ApiError};
use crate::online;
use crate::routes::{
    online_ctx, pick_index, playlist_scope, qr_session, source_of, tagged, AccountQuery,
    CacheClearRequest, CacheKeepRequest, CookieRequest, ItemQuery, LikeRequest, OnlinePlayRequest,
    OnlinePlayTrack, OnlineQualityRequest, PlaylistCreateRequest, PlaylistDeleteRequest,
    PlaylistQuery, PlaylistTracksRequest, PlaylistsQuery, QrCancelRequest, QrPollQuery,
    RadioRequest, RecommendQuery, SearchAllQuery, SourceRequest, StreamQuery,
};
use crate::rpc::{body_as, query_as, Reply, RpcResult};
use crate::state::{AppState, PlayTrigger};

fn store_err(e: vmusic_core::StoreError) -> ApiError {
    ApiError::from(vmusic_core::CoreError::Store(e))
}

/// 有音质偏好的平台清单。与 HTTP 版是同一份字面量——两边各写一份，加平台时漏
/// 一边的表现是「设置页里能选，但选了不生效」。
const QUALITY_SOURCES: [&str; 5] = ["netease", "qq", "kugou", "qishui", "ccmixter"];

// ---------------------------------------------------------------------------
// 搜索 / 详情 / 歌词 / 取流
// ---------------------------------------------------------------------------

/// 音源清单：id、显示名、分类、是否支持 cookie、当前是否已登录。前端的音源
/// 下拉框和分类 chips 全部由它生成。
pub async fn sources(state: &Arc<AppState>) -> RpcResult {
    Ok(Reply::ok(json!({
        "sources": online::list_sources(&online_ctx(state)).await,
    })))
}

pub async fn search(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: online::SearchQuery = query_as(query)?;
    let source = q.source.clone();
    Reply::json(&tagged(
        &source,
        online::search(&online_ctx(state), q).await,
    )?)
}

pub async fn search_all(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: SearchAllQuery = query_as(query)?;
    // 路由层先夹到 30（聚合要并发打全部源），dispatch 内还有 1..=50 的兜底。
    Reply::json(&online::search_all(&online_ctx(state), q.q.trim(), q.limit.clamp(1, 30)).await?)
}

pub async fn stream(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: StreamQuery = query_as(query)?;
    let source = source_of(q.source);
    // GET 形态没有 track_ref，平台模块按 id 回落取流。
    Reply::json(&tagged(
        &source,
        online::stream(&online_ctx(state), &source, &q.id, None, q.quality).await,
    )?)
}

/// 单曲详情（封面等）。搜索结果里的封面常常缺失，播放前用它补齐。
pub async fn detail(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: ItemQuery = query_as(query)?;
    let source = source_of(q.source);
    Reply::json(&tagged(
        &source,
        online::detail(&online_ctx(state), &source, &q.id).await,
    )?)
}

/// 在线歌词。返回体与 `/v1/tracks/{id}/lyrics` 同形，前端可直接使用。
/// 无歌词/无权限时返回**空文档**（200），不报错——缺失是常态而非异常。
pub async fn lyric(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: ItemQuery = query_as(query)?;
    let source = source_of(q.source);
    Reply::json(&tagged(
        &source,
        online::lyric(&online_ctx(state), &source, &q.id).await,
    )?)
}

/// 远程封面代理：插件沙箱的 img-src 只放行 `data:` / `blob:` / 插件资源源，音源
/// CDN 的 https 图在插件形态画不出来，只能由服务端取回 base64。准入与限流在
/// `routes::public_https_url` / `fetch_remote_image`，两边共用同一份；应答形状与
/// 本地封面端点一致，前端一条 data-URL 链路吃两种封面。
pub async fn cover_proxy(_state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: crate::routes::CoverProxyQuery = query_as(query)?;
    let url = crate::routes::public_https_url(&q.url)?;
    let (bytes, content_type) = crate::routes::fetch_remote_image(&url).await?;
    Ok(Reply::ok(json!({
        "data": crate::rpc::encode_base64(&bytes),
        "content_type": content_type,
    })))
}

// ---------------------------------------------------------------------------
// 整盘播放
// ---------------------------------------------------------------------------

/// 在线试听：先把整盘虚拟 id 占进队列，再交给 `play_index_for` 按服务端音质偏好
/// 在线取流、边下边播，提交链路与本地曲目完全相同。
///
/// 队列必须先占：stream/下载是数秒级 await，期间用户可能改点别的。早 `set_queue`
/// 立即顶代际并挂出新队列，起播调用回来后凭代际复核——已被顶掉的迟到结果静默
/// 收在当前播放器状态上，绝不允许整盘换回、把用户后来选的曲盖掉。
pub async fn play(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: OnlinePlayRequest = body_as(body)?;
    let source = source_of(request.source);

    // 归一两种入站形态：整盘 tracks 优先；旧单曲 {id,+元数据} 包成长度 1。
    let mut tracks = request.tracks.unwrap_or_default();
    if tracks.is_empty() {
        let id = request.id.as_deref().unwrap_or("").trim().to_string();
        if id.is_empty() {
            return Err(bad_request("缺少曲目 id"));
        }
        tracks.push(OnlinePlayTrack {
            id,
            title: request.title,
            artist: request.artist,
            album: request.album,
            duration_ms: request.duration_ms,
            cover: None,
            track_ref: None,
        });
    }
    // virtual_id 必须能反解出非空 id，任何一项空都在入队前拒绝。
    if tracks.iter().any(|t| t.id.trim().is_empty()) {
        return Err(bad_request("tracks 中存在缺少 id 的曲目"));
    }
    let index = pick_index(request.index, tracks.len());
    let current = &tracks[index];

    let vids: Vec<String> = tracks
        .iter()
        .map(|t| online::virtual_id(&source, &t.id))
        .collect();

    let (gen, _, _) = state.set_queue(vids.clone(), Some(index)).await;

    // 整盘元数据入内存暂存：play_index_for 提交成功后据此写历史（在线曲的 URL
    // 会过期，历史只存元数据快照，重播时重新实时取流）。
    {
        let mut meta = state.online_meta.lock().await;
        for (t, vid) in tracks.iter().zip(vids.iter()) {
            meta.insert(
                vid.clone(),
                crate::state::OnlineMetaSnap {
                    title: t.title.clone().unwrap_or_else(|| t.id.clone()),
                    artist: t.artist.clone(),
                    album: t.album.clone(),
                    cover: t.cover.clone(),
                    duration_ms: t.duration_ms.filter(|v| *v > 0),
                },
            );
        }
    }

    let outcome = state.play_index_for(index, Some(gen), PlayTrigger::Pick).await?;
    if !outcome.committed {
        // 被更新的代际顶掉：不改队列也不报错，把当下的播放器状态原样回给前端。
        return Ok(Reply::ok(crate::rpc::playback::snapshot(state).await));
    }
    // 首曲确认起播：后台预取后一首 + LRU（play_index_for 内部不预取）。
    state.post_commit_background();

    // 封面：整盘曲目通常已带 cover；缺失时补一次详情。补不到不算失败——前端有
    // 占位图，不能让一张图片拖垮整次播放。
    let ctx = online_ctx(state);
    let cover = match &current.cover {
        Some(c) if !c.is_empty() => Some(c.clone()),
        _ => online::detail(&ctx, &source, &current.id)
            .await
            .ok()
            .and_then(|d| d.cover),
    };

    Ok(Reply::ok(json!({
        "ok": true,
        "track_id": vids[index],
        // 前端用它填充队列 UI，避免再拼一遍虚拟 id。
        "track_ids": vids,
        "index": index,
        "source": source,
        "id": current.id,
        "title": current.title.clone().unwrap_or_default(),
        "artist": current.artist.clone().unwrap_or_default(),
        "album": current.album.clone().unwrap_or_default(),
        "duration_ms": current.duration_ms.unwrap_or(0),
        "cover": cover,
        // 平台实际给到的音质档位（缓存命中/预取接管时为 null）。
        "actual_quality": outcome.actual_quality.map(|q| q.as_str()),
    })))
}

// ---------------------------------------------------------------------------
// FM 电台
// ---------------------------------------------------------------------------

pub async fn radio_status(state: &Arc<AppState>) -> RpcResult {
    Ok(Reply::ok(state.radio_status().await))
}

pub async fn radio(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: RadioRequest = body_as(body)?;
    match request.action.as_str() {
        "start" => {
            if let Some(gen) = state.radio_start().await? {
                state.play_index_for(0, Some(gen), PlayTrigger::Pick).await?;
                state.post_commit_background();
            }
        }
        "retry" => {
            let initial = state.radio.lock().await.initial_generation.is_some();
            if initial {
                if let Some(gen) = state.radio_start().await? {
                    state.play_index_for(0, Some(gen), PlayTrigger::Pick).await?;
                    state.post_commit_background();
                }
            } else {
                state.radio_refill(true).await?;
            }
        }
        "stop" => state.radio_stop().await,
        "next" => {
            state.step(1, false).await?;
            state.post_commit_background();
        }
        _ => return Err(bad_request("未知 FM 操作")),
    }
    Ok(Reply::ok(state.radio_status().await))
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

/// 缓存占用展示：总量/文件数/按音源分组 + 配置上限 + 用户保留名单。
pub async fn cache_stats(state: &Arc<AppState>) -> RpcResult {
    let stats = crate::online::cache::cache_stats(&state.online_cache_dir()).await;
    let keep = state.keep.lock().await.clone();
    let max = state.config.online.cache_max_bytes;
    Ok(Reply::ok(json!({
        "total_bytes": stats.total_bytes,
        "files": stats.files,
        "by_source": stats.by_source,
        "max_bytes": max,
        "keep": keep,
    })))
}

/// 手动清理：当前播放与用户保留项豁免，返回删除字节数。
pub async fn cache_clear(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: CacheClearRequest = body_as(body)?;
    if let Some(src) = &request.source {
        if src.trim().is_empty() {
            return Err(bad_request("source must not be empty"));
        }
    }
    let protected = state.protected_all().await;
    let dir = state.online_cache_dir();
    let source = request.source.clone();
    let removed = tokio::task::spawn_blocking(move || {
        tokio::runtime::Handle::current().block_on(async {
            crate::online::cache::clear_cache(&dir, &protected, source.as_deref()).await
        })
    })
    .await
    .map_err(|e| bad_request(e.to_string()))?
    .map_err(|e| internal(e.to_string()))?;
    Ok(Reply::ok(json!({ "ok": true, "removed_bytes": removed })))
}

/// 指定内容保留/取消保留：以 `{stem}.` 前缀写入豁免名单并持久化，覆盖该曲目
/// 全部音质档。LRU 与手动清理都尊重它。
pub async fn cache_keep(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: CacheKeepRequest = body_as(body)?;
    if request.source.trim().is_empty() || request.id.trim().is_empty() {
        return Err(bad_request("source and id are required"));
    }
    // 保留粒度是「曲目全部音质档」：文件名形如 {stem}-{quality}.{ext}，豁免名单
    // 按 `{stem}-` 前缀匹配。代价是 id 前缀撞车（保留 1 会连带豁免 10/100）——
    // 多保留几首比误删用户想留的歌便宜。
    let stem = {
        let sanitized: String = format!("{}-{}", request.source.trim(), request.id.trim())
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        format!("{sanitized}-")
    };
    let mut keep = state.keep.lock().await;
    if request.keep {
        if !keep.iter().any(|k| k == &stem) {
            keep.push(stem.clone());
        }
    } else {
        keep.retain(|k| k != &stem);
    }
    let snapshot = keep.clone();
    drop(keep);
    crate::persist::save_strings(&state.db, "online_keep", &snapshot)
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    Ok(Reply::ok(json!({ "ok": true, "keep": snapshot })))
}

// ---------------------------------------------------------------------------
// 音质偏好
// ---------------------------------------------------------------------------

pub async fn quality_get(state: &Arc<AppState>) -> RpcResult {
    let prefs = online::quality::load(&state.db).await.map_err(store_err)?;
    Ok(Reply::ok(json!({
        "prefs": QUALITY_SOURCES.iter().map(|s| {
            let q = online::quality::get(&prefs, s);
            json!({
                "source": s,
                "selected": q.as_str(),
                "options": online::quality::allowed_for(s).iter().map(|c|
                    json!({"value": c.as_str(), "label": c.label()})
                ).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>()
    })))
}

pub async fn quality_set(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: OnlineQualityRequest = body_as(body)?;
    if !QUALITY_SOURCES.contains(&request.source.as_str()) {
        return Err(bad_request("不支持的音源"));
    }
    let mut prefs = online::quality::load(&state.db).await.map_err(store_err)?;
    let q = online::quality::save_source(&state.db, &mut prefs, &request.source, &request.quality)
        .await
        .map_err(store_err)?;
    // 内存偏好表同步热更新：play_index_for 读这张表决定取流码率，不热更的话
    // 要等重启才生效。
    state.quality.lock().await.insert(request.source.clone(), q);
    Ok(Reply::ok(
        json!({ "source": request.source, "selected": q.as_str() }),
    ))
}

// ---------------------------------------------------------------------------
// cookie 登录
// ---------------------------------------------------------------------------

/// 保存/清除用户自己账号的 cookie —— 本项目对「第三方登录」的全部实现。
pub async fn cookie(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: CookieRequest = body_as(body)?;
    let Some(info) = online::find(&request.source) else {
        return Err(bad_request(format!("不支持的音源: {}", request.source)));
    };
    if !info.supports_cookie {
        return Err(bad_request(format!(
            "{} 不需要登录，也不接受 cookie",
            info.label
        )));
    }
    let value = request.cookie.unwrap_or_default().trim().to_string();
    // 上限是防一手误粘超大内容：settings 是 SQLite 的一行文本，cookie 头部超过
    // 服务器容忍度时表现是「所有请求 400」，而报错的地方离原因很远。
    if value.len() > 8192 {
        return Err(bad_request("cookie 过长（上限 8192 字节）"));
    }
    // 统一走 cred 保险库：空串=登出（新键与历史裸键一起清，否则扫码写入的 cred
    // 会让「清空 cookie」不生效）；非空时先按平台规则补齐判态字段再存，否则酷狗
    // 的 userid/token 缺失会被误判成未登录。
    if value.is_empty() {
        online::cred_clear(&state.db, &request.source)
            .await
            .map_err(store_err)?;
    } else {
        online::cred_put_cookie(&state.db, &request.source, &value)
            .await
            .map_err(store_err)?;
    }
    // 只回布尔：原文一旦回到前端，就可能进日志、进截图、进用户粘贴到别处的那段
    // 文本里。signedIn 也不能用「cookie 非空」冒充——贴进来的串可能缺平台判态
    // 关键字段（网易 MUSIC_U、QQ qm_keyst、酷狗 token），那种包存得进去但各平台
    // 仍按未登录处理。回读 cred 包走平台自己的判据，能力失败绝不伪造成功。
    let signed_in = online::cred_get(&state.db, &request.source)
        .await
        .map_err(store_err)?
        .is_some_and(|pack| online::cred_is_signed_in(&request.source, &pack));
    Ok(Reply::ok(json!({
        "ok": true,
        "source": request.source,
        "signedIn": signed_in,
    })))
}

// ---------------------------------------------------------------------------
// 平台歌单 / 红心 / 推荐
// ---------------------------------------------------------------------------

pub async fn playlists(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: PlaylistsQuery = query_as(query)?;
    let scope = playlist_scope(q.scope)?;
    let limit = q.limit.clamp(1, 50);
    Reply::json(&tagged(
        &q.source,
        online::playlists(&online_ctx(state), &q.source, &scope, q.offset, limit).await,
    )?)
}

pub async fn playlist(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: PlaylistQuery = query_as(query)?;
    let limit = q.limit.clamp(1, 50);
    Reply::json(&tagged(
        &q.source,
        online::playlist_detail(&online_ctx(state), &q.source, &q.id, q.offset, limit).await,
    )?)
}

pub async fn playlist_create(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: PlaylistCreateRequest = body_as(body)?;
    let name = request.name.trim();
    if name.is_empty() {
        return Err(bad_request("歌单名不能为空"));
    }
    Reply::json(&tagged(
        &request.source,
        online::playlist_create(&online_ctx(state), &request.source, name).await,
    )?)
}

pub async fn playlist_delete(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: PlaylistDeleteRequest = body_as(body)?;
    if request.id.trim().is_empty() {
        return Err(bad_request("缺少歌单 id"));
    }
    tagged(
        &request.source,
        online::playlist_delete(&online_ctx(state), &request.source, &request.id).await,
    )?;
    Ok(Reply::ok(json!({ "ok": true })))
}

pub async fn playlist_add(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: PlaylistTracksRequest = body_as(body)?;
    if request.id.trim().is_empty() {
        return Err(bad_request("缺少歌单 id"));
    }
    if request.tracks.is_empty() {
        return Err(bad_request("没有要添加的曲目"));
    }
    tagged(
        &request.source,
        online::playlist_add(
            &online_ctx(state),
            &request.source,
            &request.id,
            &request.tracks,
        )
        .await,
    )?;
    Ok(Reply::ok(json!({ "ok": true })))
}

pub async fn playlist_remove(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: PlaylistTracksRequest = body_as(body)?;
    if request.id.trim().is_empty() {
        return Err(bad_request("缺少歌单 id"));
    }
    if request.tracks.is_empty() {
        return Err(bad_request("没有要移除的曲目"));
    }
    tagged(
        &request.source,
        online::playlist_remove(
            &online_ctx(state),
            &request.source,
            &request.id,
            &request.tracks,
        )
        .await,
    )?;
    Ok(Reply::ok(json!({ "ok": true })))
}

pub async fn like(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: LikeRequest = body_as(body)?;
    if request.id.trim().is_empty() {
        return Err(bad_request("缺少曲目 id"));
    }
    tagged(
        &request.source,
        online::like(
            &online_ctx(state),
            &request.source,
            &request.id,
            request.liked,
        )
        .await,
    )?;
    Ok(Reply::ok(json!({ "ok": true })))
}

pub async fn rec_songs(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: RecommendQuery = query_as(query)?;
    let limit = q.limit.clamp(1, 50);
    Reply::json(&tagged(
        &q.source,
        online::recommend_songs(&online_ctx(state), &q.source, q.offset, limit).await,
    )?)
}

pub async fn rec_playlists(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: RecommendQuery = query_as(query)?;
    let limit = q.limit.clamp(1, 50);
    Reply::json(&tagged(
        &q.source,
        online::recommend_playlists(&online_ctx(state), &q.source, q.offset, limit).await,
    )?)
}

// ---------------------------------------------------------------------------
// 扫码登录
// ---------------------------------------------------------------------------

pub async fn qr_start(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: SourceRequest = body_as(body)?;
    // 平台握手票绝不离开服务端：进 Registry 换成不透明 ticket，前端轮询/取消
    // 只认 ticket。
    let payload = tagged(
        &request.source,
        online::qr_start(
            &online_ctx(state),
            &request.source,
            request.channel.as_deref(),
        )
        .await,
    )?;
    let ticket = state
        .qr
        .start(&request.source, payload.platform_ticket)
        .await;
    Ok(Reply::ok(json!({
        "ticket": ticket,
        "qr_text": payload.qr_text,
        "qr_image": payload.qr_image,
        "poll_ms": payload.poll_ms,
    })))
}

pub async fn qr_poll(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: QrPollQuery = query_as(query)?;
    let sess = qr_session(&q.source, state.qr.take(&q.ticket).await)?;
    // 终态直接回本地票态、不再打上游：confirmed/expired 不可回退，QQ 的
    // check_sig 是一次性凭证，confirmed 后重放只会报错并可能逼票态降级。
    // account 在首次 confirmed 响应里已带过，前端见终态即停止轮询。
    if online::qr::is_terminal(&sess.state) {
        return Reply::json(&online::QrPoll {
            state: sess.state,
            account: None,
        });
    }
    let (state_name, account) = tagged(
        &q.source,
        online::qr_poll(&online_ctx(state), &q.source, &sess.platform_ticket).await,
    )?;
    // 平台已确认时凭据由平台模块自己写入 cred 保险库；这里只同步票态。上游调用
    // 失败时不更新票态，让前端按原节奏继续轮询；Registry 自身再挡一道：终态不会
    // 被任何上游返回降级。
    state.qr.update(&q.ticket, &state_name).await;
    Reply::json(&online::QrPoll {
        state: state_name,
        account,
    })
}

pub async fn qr_cancel(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: QrCancelRequest = body_as(body)?;
    if !request.ticket.is_empty() {
        // 取消同样要验源：不能拿一个源的 ticket 去删另一个源的会话。
        if let Some(sess) = state.qr.take(&request.ticket).await {
            if sess.source != request.source {
                return Err(bad_request("二维码会话与音源不匹配，请重新扫码"));
            }
            state.qr.cancel(&request.ticket).await;
        }
        // 票已过期/不存在：cancel 本就是幂等清理，返回成功即可。
    }
    Ok(Reply::ok(json!({ "ok": true })))
}

pub async fn account(state: &Arc<AppState>, query: &Value) -> RpcResult {
    let q: AccountQuery = query_as(query)?;
    Reply::json(&tagged(
        &q.source,
        online::account(&online_ctx(state), &q.source).await,
    )?)
}
