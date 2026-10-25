// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸只读桥：独立钥匙 + 最新一帧 64 段频谱。
//!
//! 不新增播放 owner、FFT 或第二个频谱订阅：`AudioEvent::Spectrum` 的既有
//! 消费方把最新帧写入这里，快照直接投影原 `AudioHandle` 与 `AppState` 真值。
//! 曲名、路径、账号和封面不进入该协议；W2 再单独评审。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::state::{AppState, WsEvent};

pub(crate) const PROTOCOL: u32 = 1;
pub(crate) const BANDS: usize = 64;
/// 最后一帧超过这个时长后，快照不再回放旧频谱。
const SPECTRUM_MAX_AGE: Duration = Duration::from_millis(1000);
/// 事件合并窗口：频谱/播放事件只标脏，最多每 250 ms 发一帧完整快照。
const EVENT_PUSH_INTERVAL: Duration = Duration::from_millis(250);
/// 没有新事件时也按 1 s 心跳推进 seq 与 ageMs，避免客户端把连接判死。
const EVENT_HEARTBEAT: Duration = Duration::from_secs(1);

struct SpectrumFrame {
    bands: [f32; BANDS],
    at: Instant,
}

#[derive(Default)]
pub(crate) struct Wallpaper {
    seq: AtomicU64,
    spectrum: Mutex<Option<SpectrumFrame>>,
}

impl Wallpaper {
    pub(crate) fn observe_spectrum(&self, bands: &[f32]) {
        let mut normalized = [0.0f32; BANDS];
        for (slot, value) in normalized.iter_mut().zip(bands.iter()) {
            *slot = if value.is_finite() {
                value.clamp(0.0, 1.0)
            } else {
                0.0
            };
        }
        if let Ok(mut slot) = self.spectrum.lock() {
            *slot = Some(SpectrumFrame {
                bands: normalized,
                at: Instant::now(),
            });
        }
    }

    #[cfg(test)]
    pub(crate) fn age_spectrum(&self, age: Duration) {
        if let Ok(mut slot) = self.spectrum.lock() {
            if let Some(frame) = slot.as_mut() {
                frame.at = Instant::now() - age;
            }
        }
    }

    fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub(crate) fn snapshot(&self, state: &AppState) -> Value {
        let seq = self.next_seq();
        let player = state.audio.snapshot();
        let (bands, age_ms) = self.spectrum_view();
        let energy = bands.iter().sum::<f32>() / BANDS as f32;
        json!({
            "protocol": PROTOCOL,
            "seq": seq,
            "server": {
                "session": state.server_instance_id(),
                "edition": crate::edition::NAME,
                "version": env!("CARGO_PKG_VERSION"),
            },
            "valid": true,
            "playing": player.playing,
            "positionMs": player.position_ms,
            "durationMs": player.duration_ms,
            "generation": player.generation.to_string(),
            "spectrum": {
                "bands": &bands[..],
                "energy": energy.clamp(0.0, 1.0),
                "ageMs": age_ms,
            },
            "timing": "presentation_applied",
        })
    }

    fn spectrum_view(&self) -> ([f32; BANDS], Option<u64>) {
        let Ok(slot) = self.spectrum.lock() else {
            return ([0.0; BANDS], None);
        };
        let Some(frame) = slot.as_ref() else {
            return ([0.0; BANDS], None);
        };
        let age = frame.at.elapsed();
        if age > SPECTRUM_MAX_AGE {
            ([0.0; BANDS], Some(age.as_millis() as u64))
        } else {
            (frame.bands, Some(age.as_millis() as u64))
        }
    }
}

pub(crate) fn snapshot(state: &AppState) -> Value {
    state.wallpaper.snapshot(state)
}

/// 壁纸事件流：首发完整快照，之后把现有播放/频谱广播合并成最多 4 Hz 的
/// 完整快照，空转时 1 s 心跳。不新开 FFT 或播放 owner，慢客户端由 send
/// 背压与 broadcast 的 Lagged 合并处理，旧事件不排队重放。
pub(crate) async fn events(state: Arc<AppState>, mut socket: WebSocket) {
    let initial = snapshot(&state).to_string();
    if socket.send(Message::Text(initial.into())).await.is_err() {
        return;
    }
    let mut source = state.events.subscribe();
    let mut ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + EVENT_PUSH_INTERVAL,
        EVENT_PUSH_INTERVAL,
    );
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut dirty = false;
    let mut last_sent = Instant::now();
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                if dirty || last_sent.elapsed() >= EVENT_HEARTBEAT {
                    let text = snapshot(&state).to_string();
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                    dirty = false;
                    last_sent = Instant::now();
                }
            }
            event = source.recv() => match event {
                Ok(WsEvent::State(_)) | Ok(WsEvent::Spectrum { .. }) => dirty = true,
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => dirty = true,
                Err(RecvError::Closed) => break,
            },
        }
    }
    let _ = socket.send(Message::Close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn idle_snapshot_is_valid_but_silent() {
        let (state, handle) = crate::state::tests::playback_state().await;
        let value = snapshot(&state);
        assert_eq!(value["protocol"], PROTOCOL);
        assert_eq!(value["timing"], "presentation_applied");
        assert_eq!(value["valid"], true);
        assert_eq!(value["playing"], false);
        assert_eq!(value["positionMs"], 0);
        assert_eq!(value["spectrum"]["bands"].as_array().unwrap().len(), BANDS);
        assert_eq!(value["spectrum"]["energy"], 0.0);
        assert_eq!(value["spectrum"]["ageMs"], Value::Null);
        let first = value["seq"].as_u64().unwrap();
        assert!(snapshot(&state)["seq"].as_u64().unwrap() > first);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn spectrum_is_bounded_and_finite() {
        let (state, handle) = crate::state::tests::playback_state().await;
        let mut input = vec![f32::NAN; BANDS];
        input[0] = 0.5;
        input[1] = 3.0;
        input[2] = -1.0;
        state.wallpaper.observe_spectrum(&input);
        let value = snapshot(&state);
        let bands = value["spectrum"]["bands"].as_array().unwrap();
        assert_eq!(bands.len(), BANDS);
        assert_eq!(bands[0], 0.5);
        assert_eq!(bands[1], 1.0);
        assert_eq!(bands[2], 0.0);
        assert_eq!(bands[3], 0.0);
        assert!(value["spectrum"]["energy"].as_f64().unwrap() <= 1.0);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn short_spectrum_is_zero_padded_and_expires() {
        let (state, handle) = crate::state::tests::playback_state().await;
        state.wallpaper.observe_spectrum(&[0.25, 0.5]);
        let value = snapshot(&state);
        let bands = value["spectrum"]["bands"].as_array().unwrap();
        assert_eq!(bands[0], 0.25);
        assert_eq!(bands[1], 0.5);
        assert_eq!(bands[2], 0.0);
        assert_eq!(bands[BANDS - 1], 0.0);

        state.wallpaper.age_spectrum(Duration::from_millis(1100));
        let expired = snapshot(&state);
        assert!(expired["spectrum"]["ageMs"].as_u64().unwrap() >= 1000);
        assert!(expired["spectrum"]["bands"]
            .as_array()
            .unwrap()
            .iter()
            .all(|band| band.as_f64() == Some(0.0)));
        assert_eq!(expired["spectrum"]["energy"], 0.0);
        state.audio.shutdown();
        handle.join().unwrap();
    }
}
