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

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
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
/// 从实际 hidden 转换开始去抖，1.2s 后才向小窗报告不可见。
const MAIN_HIDDEN_DEBOUNCE: Duration = Duration::from_millis(1200);
const MAX_WINDOW_TITLE_CHARS: usize = 512;

/// 主窗口可见性。整个进程只有一份（一个服务实例对应一个组件），
/// 锁内一起更新可见性、转换时刻与窗口标题，快照不会读到不同次上报的组合。
static MAIN_VISIBILITY: Mutex<MainVisibility> = Mutex::new(MainVisibility::new());

struct MainVisibility {
    visible: bool,
    changed_at_ms: Option<u64>,
    window_title: String,
}

impl MainVisibility {
    const fn new() -> Self {
        Self {
            visible: true,
            changed_at_ms: None,
            window_title: String::new(),
        }
    }

    fn note(&mut self, visible: bool, window_title: Option<&str>, now_ms: u64) {
        if self.changed_at_ms.is_none() || self.visible != visible {
            self.changed_at_ms = Some(now_ms);
        }
        self.visible = visible;
        if let Some(title) = window_title {
            self.window_title = title.chars().take(MAX_WINDOW_TITLE_CHARS).collect();
        }
    }

    fn since_ms(&self, now_ms: u64) -> u64 {
        self.changed_at_ms
            .map_or(0, |changed| now_ms.saturating_sub(changed))
    }

    fn hidden(&self, now_ms: u64) -> bool {
        !self.visible && self.since_ms(now_ms) >= MAIN_HIDDEN_DEBOUNCE.as_millis() as u64
    }

    fn snapshot(&self, now_ms: u64) -> Value {
        json!({
            "visible": !self.hidden(now_ms),
            "sinceMs": self.since_ms(now_ms),
            "windowTitle": self.window_title,
        })
    }
}

/// 主窗口上报可见性。由 `/v1/ui/notice` 的 `main-visibility` 动作转进来。
pub(crate) fn note_main_visibility(visible: bool, window_title: Option<&str>) {
    let mut visibility = MAIN_VISIBILITY.lock().unwrap_or_else(|e| e.into_inner());
    visibility.note(visible, window_title, monotonic_ms());
}

fn monotonic_ms() -> u64 {
    // 进程内单调毫秒。用 OnceLock 固定基准，保证差值只增不减。
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let start = START.get_or_init(Instant::now);
    start.elapsed().as_millis() as u64
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

    let main = MAIN_VISIBILITY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .snapshot(monotonic_ms());

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
        "main": main,
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
    if request.session != state.server_instance_id() {
        return Err(control_stale());
    }
    // restore 只是个界面信号，与播放代际无关，但仍须属于当前服务会话。
    if request.action == "restore" {
        request_restore(state).await?;
        return Ok(json!({ "ok": true }));
    }

    let player = state.audio.snapshot();
    if let Some(generation) = request.generation.as_deref() {
        if generation != player.generation.to_string() {
            return Err(control_stale());
        }
    }
    let expected = player
        .track_id
        .as_deref()
        .map(|track_id| (track_id, player.generation));

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
    ApiError::new(StatusCode::CONFLICT, "stale_playback", "播放已变化，请重试")
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
        let visibility = MainVisibility::new();
        assert!(!visibility.hidden(60_000));
        assert_eq!(
            visibility.snapshot(60_000),
            json!({
                "visible": true, "sinceMs": 0, "windowTitle": "",
            })
        );
    }

    #[test]
    fn first_report_can_be_hidden_at_clock_zero() {
        let mut visibility = MainVisibility::new();
        visibility.note(false, None, 0);
        assert!(!visibility.hidden(1199));
        assert!(visibility.hidden(1200));
    }

    #[test]
    fn debounce_starts_at_hidden_transition_after_a_long_visible_period() {
        let mut visibility = MainVisibility::new();
        visibility.note(true, None, 10);
        visibility.note(false, None, 60_000);
        assert!(!visibility.hidden(61_199));
        assert!(visibility.hidden(61_200));
        assert_eq!(visibility.snapshot(61_200)["sinceMs"], 1200);
    }

    #[test]
    fn repeated_reports_and_hidden_title_changes_preserve_transition_age() {
        let mut visibility = MainVisibility::new();
        visibility.note(false, Some("First · hertz-studio"), 100);
        visibility.note(false, Some("Second · hertz-studio"), 1100);
        visibility.note(false, None, 1299);
        assert!(!visibility.hidden(1299));
        assert_eq!(
            visibility.snapshot(1300),
            json!({
                "visible": false, "sinceMs": 1200, "windowTitle": "Second · hertz-studio",
            })
        );
        visibility.note(true, None, 1400);
        assert!(!visibility.hidden(1400));
        visibility.note(true, None, 1900);
        assert_eq!(visibility.snapshot(2000)["sinceMs"], 600);
        visibility.note(false, None, 2100);
        assert!(!visibility.hidden(3299));
        assert!(visibility.hidden(3300));
    }

    #[test]
    fn window_title_is_bounded_without_breaking_unicode_and_can_be_cleared() {
        let mut visibility = MainVisibility::new();
        visibility.note(true, Some(&"音🎵".repeat(MAX_WINDOW_TITLE_CHARS)), 0);
        assert_eq!(
            visibility.window_title.chars().count(),
            MAX_WINDOW_TITLE_CHARS
        );
        visibility.note(true, None, 1);
        assert_eq!(
            visibility.window_title.chars().count(),
            MAX_WINDOW_TITLE_CHARS
        );
        visibility.note(true, Some(""), 2);
        assert!(visibility.window_title.is_empty());
    }

    #[test]
    fn visibility_notice_fields_remain_optional_and_title_is_camel_case() {
        let default: crate::routes::UiNoticeRequest =
            serde_json::from_value(json!({ "action": "main-visibility" })).unwrap();
        assert!(default.hidden.is_none());
        assert!(default.window_title.is_none());
        let notice: crate::routes::UiNoticeRequest = serde_json::from_value(json!({
            "action": "main-visibility", "hidden": true, "windowTitle": "曲目 · hertz-studio",
        }))
        .unwrap();
        assert_eq!(notice.hidden, Some(true));
        assert_eq!(notice.window_title.as_deref(), Some("曲目 · hertz-studio"));
    }

    #[tokio::test]
    async fn restore_ignores_playback_generation_but_requires_current_session() {
        let (state, handle) = crate::state::tests::playback_state().await;
        let state = Arc::new(state);
        let mut notices = state.events.subscribe();
        let request = |action: &str, session: &str| MiniControlRequest {
            action: action.to_owned(),
            session: session.to_owned(),
            generation: Some("stale-generation".to_owned()),
        };
        assert!(control(&state, request("restore", "another-session"))
            .await
            .is_err());
        assert!(notices.try_recv().is_err());
        assert!(
            control(&state, request("pause", state.server_instance_id()))
                .await
                .is_err()
        );
        assert!(notices.try_recv().is_err());
        assert_eq!(
            control(&state, request("restore", state.server_instance_id()))
                .await
                .unwrap(),
            json!({ "ok": true })
        );
        assert!(
            matches!(notices.try_recv().unwrap(), crate::state::WsEvent::UiNotice { action } if action == "expand-capsule")
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }
}
