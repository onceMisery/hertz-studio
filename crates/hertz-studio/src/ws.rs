// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! WebSocket transport for state, spectrum and scan progress.
//!
//! Browsers cannot set headers on a WebSocket, so the credential travels as a
//! query parameter. 首选是一次性票据（`?ticket=`，见 `crate::ticket`）：握手本来
//! 就与「一次连接一张票」天然对应。长期 token（`?token=`）仍然接受，留给尚未
//! 迁移的调用方。查询串只出现在本机回环上的这次请求里，不落盘。

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;

use crate::error::unauthorized;
use crate::state::{AppState, ViewerGuard, WsEvent};

#[derive(Deserialize)]
pub struct WsQuery {
    pub token: Option<String>,
    /// 一次性握手票据（推荐）；与 `token` 二选一。
    pub ticket: Option<String>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    State(state): State<Arc<AppState>>,
) -> Response {
    let long_lived = query.token.as_deref() == Some(state.token.as_str());
    // 票只在长期 token 没出示时才兑：同时带上两者时不该白耗一张票。
    let ticketed = !long_lived
        && query
            .ticket
            .as_deref()
            .is_some_and(|ticket| state.tickets.redeem(ticket));
    if !(long_lived || ticketed) {
        return unauthorized().into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    // 计数守卫：本函数返回（含下面任何一条早退）即 -1，所以「还有没有页面开着」
    // 与这条连接的存活期一一对应。武装逻辑见 `AppState::schedule_depart_pause`。
    let _viewer = ViewerGuard::enter(state.clone());
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.events.subscribe();

    // Give the client a full picture before the first event arrives.
    let initial =
        serde_json::to_string(&WsEvent::State(state.audio.snapshot())).unwrap_or_default();
    if sender.send(Message::Text(initial.into())).await.is_err() {
        return;
    }

    'events: loop {
        tokio::select! {
            event_batch = state.next_event_batch(&mut rx) => match event_batch {
                Some(events) => {
                    for event in events.into_iter().flatten() {
                        let text = match serde_json::to_string(&event) {
                            Ok(t) => t,
                            Err(e) => {
                                tracing::warn!(error = %e, "ws event failed to serialise");
                                continue;
                            }
                        };
                        if sender.send(Message::Text(text.into())).await.is_err() {
                            break 'events;
                        }
                    }
                }
                None => break,
            },
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                _ => {}
            },
        }
    }

    let _ = sender.send(Message::Close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialise_with_a_type_tag() {
        let json = serde_json::to_string(&WsEvent::Ended).unwrap();
        assert!(json.contains("\"type\":\"ended\""));
    }

    /// `Ended` 是单元变体，任何表示法都能序列化，所以上面这条通过并不代表
    /// 带数据的变体也没问题。频谱帧当年正是这样混过去的：newtype 变体在
    /// `#[serde(tag = "type")]` 的内部标签表示下必然失败，而 `handle_socket`
    /// 对 `to_string` 失败是 `continue` —— 于是 WS 上一帧 spectrum 都看不到，
    /// 状态帧却一切正常，界面只是安静地不动。
    #[test]
    fn data_carrying_events_serialise_with_a_type_tag() {
        let json = serde_json::to_string(&WsEvent::QueueChanged).unwrap();
        assert_eq!(json, "{\"type\":\"queue_changed\"}");

        let json = serde_json::to_string(&WsEvent::Spectrum {
            bands: vec![0.5, 0.25],
        })
        .unwrap();
        assert_eq!(json, "{\"type\":\"spectrum\",\"bands\":[0.5,0.25]}");

        let json = serde_json::to_string(&WsEvent::Scan {
            phase: "indexing".into(),
            done: 3,
            total: 9,
        })
        .unwrap();
        assert!(json.contains("\"type\":\"scan\""));
        assert!(json.contains("\"total\":9"));

        let json = serde_json::to_string(&WsEvent::Error {
            message: "boom".into(),
            code: None,
            source: None,
            index: None,
        })
        .unwrap();
        assert!(json.contains("\"type\":\"error\""));
        // 本地音频错误不带 code/source/index：可选字段缺省时必须整体缺席而不是
        // null，否则旧客户端会收到它不认识的 null 字段。
        assert!(!json.contains("\"code\""));
        assert!(!json.contains("\"source\""));
        assert!(!json.contains("\"index\""));

        // 在线播放失败的错误事件带错误码与音源 id（spec §1.5），供前端按码分流。
        let json = serde_json::to_string(&WsEvent::Error {
            message: "受版权限制".into(),
            code: Some("upstream_error".into()),
            source: Some("qq".into()),
            index: None,
        })
        .unwrap();
        assert!(json.contains("\"code\":\"upstream_error\""));
        assert!(json.contains("\"source\":\"qq\""));
        assert!(!json.contains("\"index\""));

        // 手动点播失败带失败曲的队列下标，错误条「重试」凭它精确重放。
        let json = serde_json::to_string(&WsEvent::Error {
            message: "取流失败".into(),
            code: Some("upstream_rejected".into()),
            source: Some("netease".into()),
            index: Some(2),
        })
        .unwrap();
        assert!(json.contains("\"index\":2"));

        // buffering：掉队时补发的就是这一帧，形状必须与前端读的字段完全对上。
        // `active` 不许缺省（收口转圈全靠它），`pct` 只在 WaitFull 进度里有。
        let json = serde_json::to_string(&WsEvent::Buffering {
            active: false,
            pct: None,
        })
        .unwrap();
        assert_eq!(json, "{\"type\":\"buffering\",\"active\":false}");
        let json = serde_json::to_string(&WsEvent::Buffering {
            active: true,
            pct: Some(40),
        })
        .unwrap();
        assert_eq!(json, "{\"type\":\"buffering\",\"active\":true,\"pct\":40}");

        let json = serde_json::to_string(&WsEvent::AiTasksResync).unwrap();
        assert_eq!(json, "{\"type\":\"ai_tasks_resync\"}");

        // beatmap_ready：bpm=None 时字段必须整体缺席（不是 null）。
        // persisted 不许缺席：「就绪」与「已写进磁盘」是两种状态，消费方要能
        // 一眼分清（缺席就等于把第二种状态又抹平了）。
        let json = serde_json::to_string(&WsEvent::BeatmapReady {
            track_id: "online:qq:42".into(),
            bpm: Some(128.4),
            beats_n: 412,
            persisted: true,
        })
        .unwrap();
        assert_eq!(
            json,
            "{\"type\":\"beatmap_ready\",\"track_id\":\"online:qq:42\",\"bpm\":128.4,\"beats_n\":412,\"persisted\":true}"
        );
        let json = serde_json::to_string(&WsEvent::BeatmapReady {
            track_id: "t1".into(),
            bpm: None,
            beats_n: 0,
            persisted: false,
        })
        .unwrap();
        assert_eq!(
            json,
            "{\"type\":\"beatmap_ready\",\"track_id\":\"t1\",\"beats_n\":0,\"persisted\":false}"
        );
        assert!(!json.contains("bpm"));
    }
}
