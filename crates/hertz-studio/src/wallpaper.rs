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
use vmusic_core::PlayerSnapshot;

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
    generation: u64,
    position_ms: u64,
}

#[derive(Default)]
pub(crate) struct Wallpaper {
    seq: AtomicU64,
    spectrum: Mutex<Option<SpectrumFrame>>,
}

impl Wallpaper {
    pub(crate) fn observe_spectrum(&self, bands: &[f32], player: &PlayerSnapshot) {
        if !player.playing || player.track_id.is_none() {
            return;
        }
        let Ok(mut slot) = self.spectrum.lock() else {
            return;
        };
        // The backend can repeat its last FFT while an online decoder waits for
        // bytes. Only advancing PCM (or a new timeline) refreshes desktop age.
        if slot.as_ref().is_some_and(|frame| {
            frame.generation == player.generation && frame.position_ms == player.position_ms
        }) {
            return;
        }
        let mut normalized = [0.0f32; BANDS];
        for (slot, value) in normalized.iter_mut().zip(bands.iter()) {
            *slot = if value.is_finite() {
                value.clamp(0.0, 1.0)
            } else {
                0.0
            };
        }
        *slot = Some(SpectrumFrame {
            bands: normalized,
            at: Instant::now(),
            generation: player.generation,
            position_ms: player.position_ms,
        });
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

pub(crate) async fn snapshot(state: &AppState) -> Value {
    let mut value = state.wallpaper.snapshot(state);
    value["space"] = space_presentation(state).await;
    value
}

/// 三维空间当前场景的窄投影：只带场景 id 和该场景参数，不带账号、曲目或整份设置。
async fn space_presentation(state: &AppState) -> Value {
    let value = vmusic_store::settings::get(&state.db, "space3d")
        .await
        .ok()
        .flatten();
    value
        .as_ref()
        .map(space_presentation_from)
        .unwrap_or(Value::Null)
}

fn space_presentation_from(value: &Value) -> Value {
    let Some(scene) = value.get("sceneSource").and_then(Value::as_str) else {
        return Value::Null;
    };
    if scene.is_empty() {
        return Value::Null;
    }
    let params = value
        .get("sceneStates")
        .and_then(|states| states.get(scene))
        .and_then(|state| state.get("params"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Value::Null;
    }
    json!({ "scene": scene, "params": params })
}

/// 壁纸事件流：首发完整快照，之后把现有播放/频谱广播合并成最多 4 Hz 的
/// 完整快照，空转时 1 s 心跳。不新开 FFT 或播放 owner，慢客户端由 send
/// 背压与 broadcast 的 Lagged 合并处理，旧事件不排队重放。
pub(crate) async fn events(state: Arc<AppState>, mut socket: WebSocket) {
    let initial = snapshot(&state).await.to_string();
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
                    let text = snapshot(&state).await.to_string();
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

    #[test]
    fn stalled_playback_does_not_make_the_last_fft_fresh_again() {
        let wallpaper = Wallpaper::default();
        let mut player = PlayerSnapshot {
            track_id: Some("progressive-track".into()),
            playing: true,
            position_ms: 28_801,
            generation: 2,
            ..PlayerSnapshot::default()
        };
        wallpaper.observe_spectrum(&[0.5; BANDS], &player);
        wallpaper.age_spectrum(Duration::from_millis(1100));
        for _ in 0..30 {
            wallpaper.observe_spectrum(&[0.5; BANDS], &player);
        }
        let (bands, age) = wallpaper.spectrum_view();
        assert_eq!(bands, [0.0; BANDS]);
        assert!(age.unwrap() >= 1100);

        player.position_ms += 20;
        wallpaper.observe_spectrum(&[0.25; BANDS], &player);
        assert_eq!(wallpaper.spectrum_view().0, [0.25; BANDS]);

        player.playing = false;
        player.position_ms += 20;
        wallpaper.age_spectrum(Duration::from_millis(1100));
        wallpaper.observe_spectrum(&[1.0; BANDS], &player);
        assert_eq!(wallpaper.spectrum_view().0, [0.0; BANDS]);

        // A seek/load owns a new timeline, including when its position repeats.
        player.playing = true;
        player.position_ms -= 20;
        player.generation += 1;
        wallpaper.observe_spectrum(&[0.75; BANDS], &player);
        assert_eq!(wallpaper.spectrum_view().0, [0.75; BANDS]);
    }

    #[tokio::test]
    async fn idle_snapshot_is_valid_but_silent() {
        let (state, handle) = crate::state::tests::playback_state().await;
        let value = snapshot(&state).await;
        assert_eq!(value["protocol"], PROTOCOL);
        assert_eq!(value["timing"], "presentation_applied");
        assert_eq!(value["valid"], true);
        assert_eq!(value["playing"], false);
        assert_eq!(value["positionMs"], 0);
        assert_eq!(value["spectrum"]["bands"].as_array().unwrap().len(), BANDS);
        assert_eq!(value["spectrum"]["energy"], 0.0);
        assert_eq!(value["spectrum"]["ageMs"], Value::Null);
        assert_eq!(value["space"], Value::Null);
        let first = value["seq"].as_u64().unwrap();
        assert!(snapshot(&state).await["seq"].as_u64().unwrap() > first);
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
        let player = PlayerSnapshot {
            track_id: Some("test-spectrum".into()),
            playing: true,
            ..PlayerSnapshot::default()
        };
        state.wallpaper.observe_spectrum(&input, &player);
        let value = snapshot(&state).await;
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
        let player = PlayerSnapshot {
            track_id: Some("test-spectrum".into()),
            playing: true,
            ..PlayerSnapshot::default()
        };
        state.wallpaper.observe_spectrum(&[0.25, 0.5], &player);
        let value = snapshot(&state).await;
        let bands = value["spectrum"]["bands"].as_array().unwrap();
        assert_eq!(bands[0], 0.25);
        assert_eq!(bands[1], 0.5);
        assert_eq!(bands[2], 0.0);
        assert_eq!(bands[BANDS - 1], 0.0);

        state.wallpaper.age_spectrum(Duration::from_millis(1100));
        let expired = snapshot(&state).await;
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

    #[test]
    fn space_presentation_uses_current_scene_and_its_params() {
        let value = json!({
            "sceneSource": "butterfly-vortex",
            "sceneStates": {
                "butterfly-vortex": { "params": { "speed": 1.2, "performance": "auto" } },
                "coast": { "params": { "tod": 0.4 } }
            }
        });
        assert_eq!(
            space_presentation_from(&value),
            json!({
                "scene": "butterfly-vortex",
                "params": { "speed": 1.2, "performance": "auto" }
            })
        );
    }

    #[test]
    fn space_presentation_is_null_without_a_scene_or_valid_params() {
        assert_eq!(space_presentation_from(&json!({})), Value::Null);
        assert_eq!(
            space_presentation_from(&json!({ "sceneSource": "" })),
            Value::Null
        );
        assert_eq!(
            space_presentation_from(&json!({
                "sceneSource": "coast",
                "sceneStates": { "coast": { "params": [] } }
            })),
            Value::Null
        );
        assert_eq!(
            space_presentation_from(&json!({ "sceneSource": "coast" })),
            json!({ "scene": "coast", "params": {} })
        );
    }

    #[tokio::test]
    async fn snapshot_reads_the_current_space_scene_from_settings() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hertz-wallpaper-space-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        let db = vmusic_store::open(&dir).await.unwrap();
        let (state, handle) = crate::state::tests::playback_state_with_db(db).await;
        vmusic_store::settings::set(
            &state.db,
            "space3d",
            &json!({
                "sceneSource": "phoenix-vortex",
                "sceneStates": {
                    "phoenix-vortex": { "params": { "speed": 0.9 } },
                    "coast": { "params": { "tod": 0.5 } }
                }
            }),
        )
        .await
        .unwrap();

        let value = snapshot(&state).await;
        assert_eq!(value["space"]["scene"], "phoenix-vortex");
        assert_eq!(value["space"]["params"]["speed"], 0.9);
        assert!(value["space"]["params"].get("tod").is_none());

        state.audio.shutdown();
        handle.join().unwrap();
        state.db.close().await;
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}
