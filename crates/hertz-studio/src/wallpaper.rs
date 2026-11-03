// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 壁纸只读桥 v2：独立钥匙 + 双序号（状态 ≤1 Hz / 频谱 ≤30 Hz）。
//!
//! 不新增播放 owner、FFT 或第二个频谱订阅：`AudioEvent::Spectrum` 的既有
//! 消费方（33 ms 一帧）把最新帧写入这里，快照直接投影原 `AudioHandle` 与
//! `AppState` 真值。曲名、路径、账号和封面不进入该协议。
//!
//! v2（设计 §11.2）：状态与频谱序号分别递增——离散播放状态（播放/曲目/
//! 代际）推送不超过 1 Hz，频谱帧跟随引擎节拍推送不超过 30 Hz；每客户端
//! 只保留一份待发送数据，慢消费者不排历史帧；包长 ≤8 KiB。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;
use vmusic_core::PlayerSnapshot;

use crate::state::{AppState, WsEvent};

pub(crate) const PROTOCOL: u32 = 2;
pub(crate) const BANDS: usize = 64;
/// 最后一帧超过这个时长后，快照不再回放旧频谱。
const SPECTRUM_MAX_AGE: Duration = Duration::from_millis(1000);
/// v2 频谱帧推送节拍（引擎 33 ms 一帧；推送上限 30 Hz，§11.2）。
const SPECTRUM_PUSH_INTERVAL: Duration = Duration::from_nanos(1_000_000_000 / 30 + 1);
/// v2 离散状态推送上限，也是空转心跳周期（§11.2 状态最多 1 Hz）。
const STATUS_PUSH_INTERVAL: Duration = Duration::from_secs(1);
/// v2 单帧长度上限（§11.2 包长最多 8 KiB）。运行期不逐帧断言（30 Hz 热路径
/// 不做序列化两次），由测试钉住当前形状的帧长。
#[cfg(test)]
const MAX_FRAME_BYTES: usize = 8 * 1024;

struct SpectrumFrame {
    bands: [f32; BANDS],
    at: Instant,
    generation: u64,
    position_ms: u64,
}

#[derive(Default)]
pub(crate) struct Wallpaper {
    /// 离散状态帧序号（≤1 Hz 推送时递增）。
    status_seq: AtomicU64,
    /// 频谱帧序号（≤30 Hz 推送时递增）。
    spectrum_seq: AtomicU64,
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

    /// 组装一帧。`bump_status`/`bump_spectrum` 决定哪个序号随本帧递增：
    /// 轮询与首发是合并帧（双递增），事件流的频谱帧只递增 spectrum_seq、
    /// 状态帧只递增 status_seq（§11.2 两个序号分别递增）。
    fn frame(&self, state: &AppState, bump_status: bool, bump_spectrum: bool) -> Value {
        let status_seq = if bump_status {
            self.status_seq.fetch_add(1, Ordering::Relaxed) + 1
        } else {
            self.status_seq.load(Ordering::Relaxed)
        };
        let spectrum_seq = if bump_spectrum {
            self.spectrum_seq.fetch_add(1, Ordering::Relaxed) + 1
        } else {
            self.spectrum_seq.load(Ordering::Relaxed)
        };
        let player = state.audio.snapshot();
        let (bands, age_ms) = self.spectrum_view();
        let energy = bands.iter().sum::<f32>() / BANDS as f32;
        json!({
            "protocol": PROTOCOL,
            "seq": status_seq,
            "spectrumSeq": spectrum_seq,
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

    /// 轮询端点：合并帧，双序号递增（v1 语义的推平）。
    pub(crate) fn snapshot(&self, state: &AppState) -> Value {
        self.frame(state, true, true)
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

/// 一次 tick 的推送决策：状态帧每秒必发（≤1 Hz 的上限与保底——space 场景
/// 切换与暂停反馈都随它 ≤1 s 送达），频谱帧只跟脏标记（≤30 Hz）。
/// 纯函数便于测试节拍合同。
fn plan_push(spectrum_dirty: bool, since_status: Duration) -> (bool, bool) {
    (since_status >= STATUS_PUSH_INTERVAL, spectrum_dirty)
}

/// 壁纸事件流 v2：首发合并帧；33 ms 频谱节拍只推频谱帧（≤30 Hz），
/// 状态帧每秒一帧（space 投影随之刷新）。不新开 FFT 或播放 owner，慢客户端
/// 只保留最新帧（send 背压 + broadcast Lagged 合并），旧事件不排队重放。
pub(crate) async fn events(state: Arc<AppState>, mut socket: WebSocket) {
    let initial = snapshot(&state).await.to_string();
    if socket.send(Message::Text(initial.into())).await.is_err() {
        return;
    }
    // space 投影只在状态帧时重查（DB 查询不进 30 Hz 热路径）；频谱帧复用
    // 缓存。任一帧都带 space，否则 follow 模式会在客户端掉回固定场景。
    let mut space_cache = space_presentation(&state).await;
    let mut source = state.events.subscribe();
    let mut ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + SPECTRUM_PUSH_INTERVAL,
        SPECTRUM_PUSH_INTERVAL,
    );
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut spectrum_dirty = false;
    let mut last_status_sent = Instant::now();
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let now = Instant::now();
                let (bump_status, bump_spectrum) =
                    plan_push(spectrum_dirty, now.duration_since(last_status_sent));
                if !bump_status && !bump_spectrum {
                    continue;
                }
                if bump_status {
                    space_cache = space_presentation(&state).await;
                }
                let mut value = state.wallpaper.frame(&state, bump_status, bump_spectrum);
                value["space"] = space_cache.clone();
                if socket.send(Message::Text(value.to_string().into())).await.is_err() {
                    break;
                }
                if bump_status {
                    last_status_sent = now;
                }
                if bump_spectrum {
                    spectrum_dirty = false;
                }
            }
            event = source.recv() => match event {
                Ok(WsEvent::Spectrum { .. }) => spectrum_dirty = true,
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => spectrum_dirty = true,
                Err(RecvError::Closed) => break,
            },
        }
    }
    let _ = socket.send(Message::Close(None)).await;
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
        // 合并帧双序号各自递增（§11.2 状态和频谱序号分别递增）。
        let status_first = value["seq"].as_u64().unwrap();
        let spectrum_first = value["spectrumSeq"].as_u64().unwrap();
        let next = snapshot(&state).await;
        assert!(next["seq"].as_u64().unwrap() > status_first);
        assert!(next["spectrumSeq"].as_u64().unwrap() > spectrum_first);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    /// 频谱帧只递增 spectrumSeq：状态序号冻结（≤1 Hz 合同的另一半）。
    #[tokio::test]
    async fn spectrum_frame_advances_only_spectrum_seq() {
        let (state, handle) = crate::state::tests::playback_state().await;
        let merged = snapshot(&state).await;
        let status = merged["seq"].as_u64().unwrap();
        let spectrum = merged["spectrumSeq"].as_u64().unwrap();

        let frame = state.wallpaper.frame(&state, false, true);
        assert_eq!(
            frame["seq"].as_u64().unwrap(),
            status,
            "频谱帧不得动状态序号"
        );
        assert!(frame["spectrumSeq"].as_u64().unwrap() > spectrum);

        let status_frame = state.wallpaper.frame(&state, true, false);
        assert!(status_frame["seq"].as_u64().unwrap() > status);
        assert_eq!(
            status_frame["spectrumSeq"].as_u64().unwrap(),
            frame["spectrumSeq"].as_u64().unwrap(),
            "状态帧不得动频谱序号"
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    /// §11.2：单帧 ≤8 KiB（64 段 + 信封）。
    #[tokio::test]
    async fn frame_length_stays_under_8kib() {
        let (state, handle) = crate::state::tests::playback_state().await;
        let value = snapshot(&state).await;
        assert!(
            value.to_string().len() <= MAX_FRAME_BYTES,
            "帧长 {} 超过 {} 上限",
            value.to_string().len(),
            MAX_FRAME_BYTES
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    /// 节拍合同：频谱只跟脏标记；状态每秒必发（上限与保底）。
    #[test]
    fn plan_push_follows_cadence_contract() {
        // 频谱脏 → 发频谱帧；状态未到 1 s 不发。
        assert_eq!(plan_push(true, Duration::from_millis(100)), (false, true));
        // 状态到 1 s：即使频谱不脏也发状态帧（space 刷新与暂停反馈的保底）。
        assert_eq!(plan_push(false, STATUS_PUSH_INTERVAL), (true, false));
        assert_eq!(
            plan_push(false, STATUS_PUSH_INTERVAL + Duration::from_secs(5)),
            (true, false)
        );
        // 双脏同 tick：一帧双递增。
        assert_eq!(plan_push(true, STATUS_PUSH_INTERVAL), (true, true));
        // 全静默且未到 1 s：不发。
        assert_eq!(plan_push(false, Duration::from_millis(500)), (false, false));
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
