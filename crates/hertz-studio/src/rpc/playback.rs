// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 播放域：状态快照、播放控制、队列、DSP、音频设备、舞台节拍地图。
//!
//! 逐个对应 `routes.rs` 里的同名 handler，逻辑照抄——两边唯一的差别是取参方式
//! （axum 的 `State`/`Json`/`Query` 抽取器 vs 信封里的 `body`/`query`）和应答
//! 如何表达（HTTP 状态码 vs `Reply.status`）。请求体结构直接复用 `routes` 里那
//! 一份，两处定义才不会漂移。
//!
//! 播放控制统一走 `play_commit` 锁 + `play_generation` 代际：新的播放意图会把
//! 还在准备中的旧意图顶掉，避免"点了下一首却又跳回上一首"。这套语义在 HTTP
//! 与 RPC 两条路上必须一致，所以照抄而不是另写一份。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{bad_request, internal, ApiError};
use crate::routes::{
    DspUpdate, LoadRequest, ModeRequest, ReplayRequest, SeekRequest, SelectDeviceRequest,
    SetQueueRequest, VolumeRequest,
};
use crate::rpc::{body_as, Reply, RpcResult};
use crate::state::{AppState, PlayTrigger};

/// 播放器快照，叠加「在线曲缓冲覆盖态」。
///
/// buffering 与事件总线上的 `Buffering` 事件读同一个 `state.buffering`，所以
/// 轮询快照与推送的口径一致（前端只用推送，快照仅作首帧与降级对齐）。
pub async fn snapshot(state: &Arc<AppState>) -> Value {
    let mut value = serde_json::to_value(state.audio.snapshot()).unwrap_or_default();
    if let Some(obj) = value.as_object_mut() {
        let (active, pct) = *state.buffering.lock().await;
        obj.insert("buffering".into(), Value::Bool(active));
        if let Some(pct) = pct {
            obj.insert("pct".into(), Value::from(pct));
        }
    }
    value
}

async fn with_state(state: &Arc<AppState>) -> RpcResult {
    Ok(Reply::ok(snapshot(state).await))
}

pub async fn play(state: &Arc<AppState>) -> RpcResult {
    // 会话恢复后的首次 play：按恢复的游标起播 + 接续上次进度（见 routes::play）。
    if state.audio.snapshot().track_id.is_none() {
        if let Some(index) = state.current_index().await {
            let outcome = state
                .play_index_for(index, None, PlayTrigger::Pick)
                .await
                .map_err(|e| ApiError::internal(e.to_string()))?;
            if outcome.committed {
                state.consume_restore_seek().await;
                state.post_commit_background();
            }
            return with_state(state).await;
        }
    }
    let commit = state.play_commit.lock().await;
    state
        .play_generation
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state
        .audio
        .play()
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    drop(commit);
    with_state(state).await
}

pub async fn pause(state: &Arc<AppState>) -> RpcResult {
    let commit = state.play_commit.lock().await;
    state
        .play_generation
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.set_buffering(false, None).await;
    state
        .audio
        .pause()
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    drop(commit);
    with_state(state).await
}

pub async fn stop(state: &Arc<AppState>) -> RpcResult {
    let commit = state.play_commit.lock().await;
    state
        .play_generation
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.set_buffering(false, None).await;
    state
        .audio
        .stop()
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    drop(commit);
    with_state(state).await
}

pub async fn next(state: &Arc<AppState>) -> RpcResult {
    state.step_by_user(1).await?;
    // 成功起播后在入口 detach 预取 + LRU（每首恰好一次）。
    state.post_commit_background();
    with_state(state).await
}

pub async fn previous(state: &Arc<AppState>) -> RpcResult {
    state.step_by_user(-1).await?;
    state.post_commit_background();
    with_state(state).await
}

pub async fn seek(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: SeekRequest = body_as(body)?;
    let commit = state.play_commit.lock().await;
    state
        .play_generation
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state
        .audio
        .seek(request.position_ms)
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    drop(commit);
    with_state(state).await
}

pub async fn volume(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: VolumeRequest = body_as(body)?;
    if !(0.0..=1.0).contains(&request.volume) {
        return Err(bad_request("volume must be between 0.0 and 1.0"));
    }
    state
        .audio
        .set_volume(request.volume)
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    crate::persist::save_volume(&state.db, request.volume).await;
    with_state(state).await
}

pub async fn mode(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: ModeRequest = body_as(body)?;
    state
        .audio
        .set_mode(request.mode)
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    crate::persist::save_mode(&state.db, request.mode).await;
    with_state(state).await
}

pub async fn load(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: LoadRequest = body_as(body)?;
    // 重启后从歌单/收藏整单播放时，客户端持有元数据快照而服务端内存已清空；
    // 不注入的话播放历史里的标题会退化成平台 id。只接受合法虚拟 id 的键。
    if let Some(meta) = &request.meta {
        let mut online_meta = state.online_meta.lock().await;
        for (id, snap) in meta {
            if crate::online::split_virtual_id(id).is_some() {
                online_meta.insert(id.clone(), snap.clone());
            }
        }
    }
    let queue = request
        .queue
        .clone()
        .unwrap_or_else(|| vec![request.track_id.clone()]);
    let index = queue
        .iter()
        .position(|id| *id == request.track_id)
        .unwrap_or(0);
    let (generation, _, _) = state.set_queue(queue, Some(index)).await;
    state.play_index_for(index, Some(generation), PlayTrigger::Pick).await?;
    state.post_commit_background();
    with_state(state).await
}

pub async fn get_queue(state: &Arc<AppState>) -> RpcResult {
    // 队列过去只存在于服务内存且无法读回，页面一刷新就丢了。
    let queue = state.queue.lock().await.clone();
    let index = state.current_index().await;
    Ok(Reply::ok(json!({ "queue": queue, "index": index })))
}

/// 换队列但**不**重载当前曲目。
///
/// `set_queue` 只写队列与游标，从不碰音频 actor；走 `load` 会调 `play_index`
/// 把曲子从 0:00 重开——那正是拖动排序时绝对不能发生的事。
pub async fn set_queue(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: SetQueueRequest = body_as(body)?;
    let index = match request.index {
        Some(i) if i < request.queue.len() => Some(i),
        // 纯排序不带 index。这时丢掉游标会让「下一首」失灵直到下次 load，
        // 所以客户端声明是编辑而非跳转时，按当前曲目重新定位。
        _ if request.resume == Some(true) => state
            .audio
            .snapshot()
            .track_id
            .as_ref()
            .and_then(|track_id| request.queue.iter().position(|id| id == track_id)),
        _ => None,
    };
    state.set_queue(request.queue.clone(), index).await;
    Ok(Reply::ok(json!({ "queue": request.queue, "index": index })))
}

pub async fn get_dsp(state: &Arc<AppState>) -> RpcResult {
    let settings = vmusic_store::settings::get_all(&state.db)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let config = crate::state::DspConfig::from_settings(&settings);
    Ok(Reply::ok(
        serde_json::to_value(&config).map_err(|e| internal(e.to_string()))?,
    ))
}

/// OBS 歌词输出：与 HTTP 版共用 `overlay_lyric_data`（永不失败的 200 空文档）。
pub async fn overlay_lyric(state: &Arc<AppState>) -> RpcResult {
    Ok(Reply::ok(crate::routes::overlay_lyric_data(state).await))
}

/// 更新 DSP 并即时下发到音频后端；交叉淡化同步换装/尾淡出时长。
pub async fn set_dsp(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: DspUpdate = body_as(body)?;
    let settings = vmusic_store::settings::get_all(&state.db)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let mut config = crate::state::DspConfig::from_settings(&settings);
    if let Some(eq) = request.eq_gains_db {
        config.eq_gains_db = eq;
        config.clamp_eq();
    }
    if let Some(preamp) = request.preamp_db {
        config.preamp_db = preamp.clamp(-24.0, 12.0);
    }
    if let Some(mode) = &request.loudness_mode {
        if !matches!(mode.as_str(), "off" | "track" | "album") {
            return Err(bad_request("loudness_mode 只接受 off / track / album"));
        }
        config.loudness_mode = mode.clone();
    }
    if let Some(ms) = request.crossfade_ms {
        config.crossfade_ms = ms.min(8000);
    }
    let eq_json = serde_json::json!(config.eq_gains_db);
    vmusic_store::settings::set(&state.db, "dsp_eq", &eq_json)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    for (key, value) in [
        ("dsp_preamp", serde_json::json!(config.preamp_db)),
        ("dsp_loudness_mode", serde_json::json!(config.loudness_mode)),
        ("dsp_crossfade_ms", serde_json::json!(config.crossfade_ms)),
    ] {
        vmusic_store::settings::set(&state.db, key, &value)
            .await
            .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    }
    // 即时生效：EQ/增益走 set_dsp，交叉淡化走 set_crossfade。
    let track_gain = if config.loudness_enabled() {
        state
            .current_loudness(&config.loudness_mode)
            .await
            .map(|(gain, _)| gain)
            .unwrap_or(0.0) as f32
    } else {
        0.0
    };
    state
        .audio
        .set_dsp(vmusic_core::DspParams {
            eq_gains_db: config.eq_gains_db,
            preamp_db: config.preamp_db,
            track_gain_db: track_gain,
        })
        .await
        .ok();
    state.audio.set_crossfade(config.crossfade_ms).await.ok();
    Ok(Reply::ok(
        serde_json::to_value(&config).map_err(|e| internal(e.to_string()))?,
    ))
}

/// 错误条「重试」/ 音质热切换：重播当前队列指定下标（在线曲重新取流），
/// 并接续切换前的进度（>1s 才 seek；渐进源会在解码侧等到对应字节）。
pub async fn replay(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: ReplayRequest = body_as(body)?;
    // 在重新取流（数秒 await）之前抓进度：提交后旧曲已被换装，快照归零。
    let resume = state.audio.snapshot().position_ms;
    let outcome = state
        .play_index_for(request.index, None, PlayTrigger::Pick)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    // 只有真正起播才 seek + 触发后台预取 + LRU；被更新代际顶掉时不收口。
    if outcome.committed {
        if resume > 1000 {
            // seek 失败不致命：从头播也好过半途整个请求报错。
            state.audio.seek(resume).await.ok();
        }
        state.post_commit_background();
    }
    with_state(state).await
}

pub async fn devices(state: &Arc<AppState>) -> RpcResult {
    let devices = state
        .audio
        .devices()
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    Ok(Reply::ok(json!({ "devices": devices })))
}

pub async fn select_device(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: SelectDeviceRequest = body_as(body)?;
    state
        .audio
        .select_device(request.id)
        .await
        .map_err(vmusic_core::CoreError::Audio)?;
    Ok(Reply::ok(json!({ "ok": true })))
}

/// 三态应答：200 带节拍图 / 202 分析中 / 404 不可用。
///
/// 404 的体是 `{status, reason}` 而不是标准 ApiError 的 `{error}`，前端按
/// `err.status` 与 `body.status` 分流、不弹错。所以这里不能走 `ApiError`，
/// 必须直接给 `Reply`——这正是 `Reply` 允许自定义状态码与体的原因。
pub async fn beatmap(state: &Arc<AppState>, query: &Value) -> RpcResult {
    // track 是必填项：HTTP 版用 Query<BeatmapQuery> 抽取，缺了就是 400。这里走
    // 同一个结构体，免得「没带 track」在插件形态下变成一个 404 unavailable。
    let q: crate::routes::BeatmapQuery = crate::rpc::query_as(query)?;
    Ok(
        match crate::stage_beats::request_on_demand(state, &q.track).await {
            crate::stage_beats::Outcome::Ready { map, cached } => {
                let mut value = serde_json::to_value(&map).unwrap_or(Value::Null);
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("cached".into(), Value::Bool(cached));
                }
                Reply::ok(value)
            }
            crate::stage_beats::Outcome::Analyzing => {
                Reply::with_status(202, json!({ "status": "analyzing" }))
            }
            crate::stage_beats::Outcome::Unavailable(reason) => Reply::with_status(
                404,
                json!({ "status": "unavailable", "reason": reason.as_str() }),
            ),
        },
    )
}
