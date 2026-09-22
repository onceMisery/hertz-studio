// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! WebSocket transport for state, spectrum and scan progress.
//!
//! Browsers cannot set headers on a WebSocket, so the token travels as a query
//! parameter. That is acceptable here only because the listener is bound to
//! the loopback interface; the bound address is asserted at startup.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;

use crate::error::unauthorized;
use crate::state::{AppState, WsEvent};

#[derive(Deserialize)]
pub struct WsQuery {
    pub token: Option<String>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    State(state): State<Arc<AppState>>,
) -> Response {
    if query.token.as_deref() != Some(state.token.as_str()) {
        return unauthorized().into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.events.subscribe();

    // Give the client a full picture before the first event arrives.
    let initial =
        serde_json::to_string(&WsEvent::State(state.audio.snapshot())).unwrap_or_default();
    if sender.send(Message::Text(initial.into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Ok(event) => {
                    let text = match serde_json::to_string(&event) {
                        Ok(t) => t,
                        Err(e) => {
                            // 丢帧是对的，但一声不吭地丢不是：这里曾经因为
                            // Spectrum 变体的表示法问题长期一帧不发，而状态帧
                            // 照常，界面上只是"频谱不动了"，没有任何线索指向这里。
                            tracing::warn!(error = %e, "ws event failed to serialise");
                            continue;
                        }
                    };
                    if sender.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                // Lagging just means this client is slow: drop it rather than
                // letting it stall the broadcast channel for everyone else.
                Err(_) => break,
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
        })
        .unwrap();
        assert!(json.contains("\"type\":\"error\""));
        // 本地音频错误不带 code/source：可选字段缺省时必须整体缺席而不是 null，
        // 否则旧客户端会收到它不认识的 null 字段。
        assert!(!json.contains("\"code\""));
        assert!(!json.contains("\"source\""));

        // 在线播放失败的错误事件带错误码与音源 id（spec §1.5），供前端按码分流。
        let json = serde_json::to_string(&WsEvent::Error {
            message: "受版权限制".into(),
            code: Some("upstream_error".into()),
            source: Some("qq".into()),
        })
        .unwrap();
        assert!(json.contains("\"code\":\"upstream_error\""));
        assert!(json.contains("\"source\":\"qq\""));
    }
}
