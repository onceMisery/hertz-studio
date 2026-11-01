// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 小窗播放（桌面宠物）数据桥。
//!
//! 与桌面歌词同一形态：独立钥匙、独立路由组、只读快照与显式窄播控分开，
//! 不新增播放 owner、不连主 `/ws`、不增加页面观众计数——位置、代际与
//! buffering 全部直接投影 `AudioHandle` 的当前真值。
//!
//! 多出来的只有两件事：
//!   1. 一张封面（小窗要显示唱片，桌面歌词不需要），按 coverKey 只取一次；
//!   2. 主窗口的可见性回传。小窗要知道「主界面还在不在」才能自动接管 /
//!      自动收回，而这个真值只有浏览器那边说得准。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{bad_request, ApiError};
use crate::state::AppState;

/// 小窗数据协议。与服务的 `PROTOCOL_VERSION` 独立演进。
pub(crate) const PROTOCOL: u32 = 1;

/// 主窗口可见性被判定为「真的没了」所需的持续时间。
///
/// `visibilitychange` 分不清最小化和切标签页：Alt-Tab 切走也会 hidden。
/// 所以这里不做瞬时判断，只报「上次可见到现在多久了」，由小窗组件自己定阈值
/// （默认 1.2s）。这样一次快速切走不会把小窗弹出来。
const MAIN_HIDDEN_DEBOUNCE: Duration = Duration::from_millis(1200);

/// 主窗口可见性。整个进程只有一份（一个服务实例对应一个组件），
/// 用原子量而不是塞进 AppState：可见性不属于播放真值，别让它参与状态快照。
static MAIN_VISIBLE: AtomicBool = AtomicBool::new(true);
static MAIN_LAST_SEEN: AtomicU64 = AtomicU64::new(0);

/// 主窗口上报可见性。由 `/v1/ui/notice` 的 `main-visibility` 动作转进来。
pub(crate) fn note_main_visibility(visible: bool) {
    MAIN_VISIBLE.store(visible, Ordering::Relaxed);
    if visible {
        MAIN_LAST_SEEN.store(monotonic_ms(), Ordering::Relaxed);
    }
}

/// 主窗口是否已经被判定为「不在了」。这是自动接管的唯一依据。
pub(crate) fn main_hidden() -> bool {
    if MAIN_VISIBLE.load(Ordering::Relaxed) {
        return false;
    }
    let last = MAIN_LAST_SEEN.load(Ordering::Relaxed);
    if last == 0 {
        // 从没上报过可见：没有证据说它藏起来了，别自动弹小窗。
        return false;
    }
    monotonic_ms().saturating_sub(last) >= MAIN_HIDDEN_DEBOUNCE.as_millis() as u64
}

fn monotonic_ms() -> u64 {
    // 进程内单调毫秒。用 OnceLock 固定基准，保证差值只增不减。
    // 下限 1：`main_hidden()` 用 0 当「从未上报」的哨兵，而进程启动后的
    // 第一毫秒里 elapsed() 真的会是 0——首测就撞上了，不能让两者相撞。
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let start = START.get_or_init(Instant::now);
    (start.elapsed().as_millis() as u64).max(1)
}

/// 小窗快照：轻量、可 500ms 轮询，绝不等待封面 I/O。
pub(crate) async fn snapshot(state: &Arc<AppState>) -> Value {
    let player = state.audio.snapshot();
    let (buffering, _) = *state.buffering.lock().await;
    let seq = state.desktop_mini_seq.fetch_add(1, Ordering::Relaxed) + 1;

    let track = match player.track_id.as_deref() {
        Some(track_id) => Some(build_track(state, track_id, player.duration_ms).await),
        None => None,
    };

    json!({
        "protocol": PROTOCOL,
        "seq": seq,
        "server": {
            "session": state.server_instance_id(),
            "edition": crate::edition::NAME,
            "version": env!("CARGO_PKG_VERSION"),
        },
        "generation": player.generation.to_string(),
        "positionMs": player.position_ms,
        "durationMs": player.duration_ms,
        "playing": player.playing,
        "buffering": buffering,
        "track": track,
        "main": {
            "visible": !main_hidden(),
            "sinceMs": monotonic_ms().saturating_sub(MAIN_LAST_SEEN.load(Ordering::Relaxed)),
        },
        // 与桌面歌词同一语义：位置是「呈现时刻」的位置，不是解码器读数。
        "timing": "presentation_applied",
    })
}

async fn build_track(state: &Arc<AppState>, track_id: &str, duration_ms: Option<u64>) -> Value {
    match crate::online::split_virtual_id(track_id) {
        Some((_source, ref_id)) => {
            let meta = state.online_meta.lock().await.get(track_id).cloned();
            json!({
                "id": track_id,
                "title": meta.as_ref().map(|m| m.title.clone()).unwrap_or(ref_id),
                "artist": meta.as_ref().and_then(|m| m.artist.clone()),
                "album": meta.as_ref().and_then(|m| m.album.clone()),
                "durationMs": duration_ms.or_else(|| meta.as_ref().and_then(|m| m.duration_ms)),
                // 在线封面要走公网代理，小窗是本机窄凭据，不该有那个能力：
                // 这里不给 coverKey，页面落回音符字形。
                "coverKey": Value::Null,
                "online": true,
            })
        }
        None => {
            let Ok(Some(track)) = vmusic_store::get_track(&state.db, &track_id.to_owned()).await
            else {
                return json!({
                    "id": track_id,
                    "title": "未知曲目",
                    "artist": Value::Null,
                    "album": Value::Null,
                    "durationMs": duration_ms,
                    "coverKey": Value::Null,
                    "online": false,
                });
            };
            // coverKey 就是曲目 id：本地封面文件名是 `{id}.{ext}`，id 本身是
            // uuid，天然满足 safe_cover_id 的准入。封面变了（用户换封面）文件
            // 名不变，所以还要带上 has_cover 让组件知道有没有。
            let has_cover = track.has_cover;
            json!({
                "id": track.id,
                "title": track.title,
                "artist": track.artist,
                "album": track.album,
                "durationMs": duration_ms.or(track.duration_ms),
                "coverKey": if has_cover { json!(track.id) } else { Value::Null },
                "online": false,
            })
        }
    }
}

/// 小窗封面。与 `/v1/tracks/{id}/cover` 同一套准入和同样的扩展名探测，
/// 但走小窗钥匙、不给上传能力（POST 不挂在这条路由上）。
pub(crate) fn cover(state: &Arc<AppState>, key: &str) -> Response {
    let Some(id) = crate::routes::safe_cover_id(key) else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let dir = state.cover_dir();
    let found = ["jpg", "png", "webp", "gif"].iter().find_map(|ext| {
        let path = dir.join(format!("{id}.{ext}"));
        if path.is_file() {
            Some((path, *ext))
        } else {
            None
        }
    });
    match found {
        Some((path, ext)) => match std::fs::read(&path) {
            Ok(bytes) => {
                let mime = match ext {
                    "png" => "image/png",
                    "webp" => "image/webp",
                    "gif" => "image/gif",
                    _ => "image/jpeg",
                };
                Response::builder()
                    .status(StatusCode::OK)
                    .header(CONTENT_TYPE, mime)
                    .header(CACHE_CONTROL, "max-age=86400")
                    .body(axum::body::Body::from(Bytes::from(bytes)))
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
            }
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        },
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

/// 小窗播控的动作白名单。比桌面歌词多的是 `toggle` / `next` / `previous`——
/// 小窗上有完整的传输三键，但依旧不接受音量、队列、随机等更大范围的写入。
/// `restore` 不动播放状态，只广播「回主窗口」（§7.7：落到既有 expand-capsule
/// 通知，不新增订阅协议）。
const MINI_ACTIONS: [&str; 6] = ["play", "pause", "toggle", "next", "previous", "restore"];

#[derive(Debug, Deserialize)]
pub(crate) struct MiniControlRequest {
    pub(crate) action: String,
    #[serde(default)]
    pub(crate) session: String,
    #[serde(default)]
    pub(crate) generation: Option<String>,
}

/// 显式窄播控。与桌面歌词同一套「代际校验」：带 generation，避免小窗上迟到的
/// 一次点击把已经换掉的曲目的状态改了。
pub(crate) async fn control(
    state: &Arc<AppState>,
    request: MiniControlRequest,
) -> Result<Value, ApiError> {
    if !MINI_ACTIONS.contains(&request.action.as_str()) {
        return Err(bad_request("不支持的小窗播控操作"));
    }
    let player = state.audio.snapshot();
    if request.session != state.server_instance_id() {
        return Err(control_stale());
    }
    if let Some(generation) = request.generation.as_deref() {
        if generation != player.generation.to_string() {
            return Err(control_stale());
        }
    }
    let expected = player
        .track_id
        .as_deref()
        .map(|track_id| (track_id, player.generation));

    // restore 只是个界面信号，与播放代际无关，提前于代际校验处理。
    if request.action == "restore" {
        request_restore(state).await?;
        return Ok(json!({ "ok": true }));
    }

    // toggle 由当前真值决定方向，不读 UI 侧缓存的布尔——小窗关着的时候
    // 那份缓存没有更新来源。
    let outcome = match request.action.as_str() {
        "play" => state.resume_control_if(true, expected).await?,
        "pause" => state.pause_control_if(expected).await?,
        "toggle" => {
            if player.playing {
                state.pause_control_if(expected).await?
            } else {
                state.resume_control_if(true, expected).await?
            }
        }
        // 上下曲走与主界面同一条 step_by_user：预取、LRU detach 与历史
        // 记录都在里面，不能在小窗这条路上另起一套。
        "next" => state.step_by_user(1).await?,
        "previous" => state.step_by_user(-1).await?,
        _ => return Err(bad_request("不支持的小窗播控操作")),
    };

    if matches!(outcome, crate::state::ControlOutcome::Superseded { .. }) {
        return Err(control_stale());
    }
    Ok(json!({ "ok": true }))
}

fn control_stale() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "stale_playback",
        "播放已变化，请重试",
    )
}

/// 小窗请求回到主窗口。走既有的 `/v1/ui/notice` 广播：主界面那条 WS 本来就
/// 在消费 `expand-capsule`，小窗只是多一个发起方，不新增订阅协议。
pub(crate) async fn request_restore(state: &Arc<AppState>) -> Result<(), ApiError> {
    crate::routes::broadcast_ui_notice(state, "expand-capsule").await
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    // 可见性判定读的是进程级 static，测试之间必须串行，否则一个用例的
    // 去抖等待会被另一个用例的复位打断（首次接进模块树时踩过）。
    static VISIBILITY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn action_allowlist_is_explicit() {
        assert!(MINI_ACTIONS.contains(&"toggle"));
        assert!(MINI_ACTIONS.contains(&"next"));
        assert!(MINI_ACTIONS.contains(&"restore"));
        // 比桌面歌词宽的只有传输键与回主窗口；音量、队列、随机一律不放行。
        for denied in ["volume", "shuffle", "enqueue", "seek", "stop"] {
            assert!(!MINI_ACTIONS.contains(&denied), "{denied} 不该在小窗白名单");
        }
    }

    #[test]
    fn main_visibility_never_auto_enters_without_evidence() {
        let _guard = VISIBILITY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 组件刚起来、主窗口还没上报过一次可见：没有证据说它藏起来了。
        MAIN_VISIBLE.store(true, Ordering::Relaxed);
        MAIN_LAST_SEEN.store(0, Ordering::Relaxed);
        assert!(!main_hidden());
    }

    #[test]
    fn main_hidden_needs_the_debounce_to_elapse() {
        let _guard = VISIBILITY_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        MAIN_LAST_SEEN.store(monotonic_ms(), Ordering::Relaxed);
        MAIN_VISIBLE.store(true, Ordering::Relaxed);
        note_main_visibility(false);
        // 刚上报 hidden：还在去抖窗口内，不算藏起来。
        assert!(!main_hidden());
        std::thread::sleep(MAIN_HIDDEN_DEBOUNCE + Duration::from_millis(60));
        assert!(main_hidden());
        // 主窗口回来：立刻不算藏起来。
        note_main_visibility(true);
        assert!(!main_hidden());
    }

    #[test]
    fn monotonic_ms_only_moves_forward() {
        let first = monotonic_ms();
        std::thread::sleep(Duration::from_millis(5));
        assert!(monotonic_ms() >= first);
    }
}
