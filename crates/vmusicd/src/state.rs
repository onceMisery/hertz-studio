// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! Shared server state, the event bus and the playback queue.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, Mutex};
use vmusic_audio::{AudioEvent, AudioHandle};
use vmusic_core::{PlayMode, PlayerSnapshot, PROTOCOL_VERSION};

use crate::config::Config;

/// Everything that crosses the WebSocket boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsEvent {
    State(PlayerSnapshot),
    /// 必须是命名变体。`#[serde(tag = "type")]` 是内部标签表示法，serde 只
    /// 允许它包住 struct/map 形状的数据；newtype 变体（`Spectrum(Vec<f32>)`）
    /// 会在序列化时直接报错，而 ws.rs 对 `to_string` 失败是 `continue`，
    /// 于是整条频谱链路静默地一帧都发不出去——不崩、不报错、状态帧照发。
    Spectrum {
        bands: Vec<f32>,
    },
    Ended,
    Error {
        message: String,
    },
    Scan {
        phase: String,
        done: usize,
        total: usize,
    },
    LibraryChanged,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ScanProgress {
    pub running: bool,
    pub done: usize,
    pub total: usize,
    pub added: usize,
    pub failed: usize,
    pub last_error: Option<String>,
}

pub struct AppState {
    pub db: SqlitePool,
    pub audio: AudioHandle,
    pub config: Arc<Config>,
    pub data_dir: PathBuf,
    pub token: String,
    pub events: broadcast::Sender<WsEvent>,
    /// Ordered list of track ids the "next / previous" buttons walk through.
    pub queue: Mutex<Vec<String>>,
    pub cursor: Mutex<Option<usize>>,
    pub scan: Mutex<ScanProgress>,
}

impl AppState {
    pub fn cover_dir(&self) -> PathBuf {
        self.data_dir.join("cache").join("covers")
    }

    /// 在线试听的落盘位置。音频后端目前只吃本地文件路径，所以远程流先缓存到
    /// 这里再交给 audio actor —— 播放链路本身完全不变。
    pub fn online_cache_dir(&self) -> PathBuf {
        self.data_dir.join("cache").join("online")
    }

    pub fn publish(&self, event: WsEvent) {
        // No receivers is the common case and is not an error.
        let _ = self.events.send(event);
    }

    pub async fn set_queue(&self, ids: Vec<String>, start: Option<usize>) {
        *self.queue.lock().await = ids;
        *self.cursor.lock().await = start;
    }

    pub async fn current_index(&self) -> Option<usize> {
        *self.cursor.lock().await
    }

    /// Loads and starts the track at `index` of the current queue.
    pub async fn play_index(&self, index: usize) -> Result<(), vmusic_core::CoreError> {
        let queue = self.queue.lock().await;
        let Some(track_id) = queue.get(index).cloned() else {
            return Err(vmusic_core::CoreError::NotFound("queue index".into()));
        };
        drop(queue);
        *self.cursor.lock().await = Some(index);

        // 在线试听的虚拟 id 不在本地库里：它对应的是 online 缓存目录里那个
        // 已经落盘的文件。不认这个前缀的话，上一首/下一首走到在线曲目时
        // 只会在本地库里查、必然 NotFound —— 表现就是「点了下一曲没反应」。
        let path = if let Some((source, id)) = crate::online::split_virtual_id(&track_id) {
            let cached = self
                .online_cache_dir()
                .join(crate::online::cache_name(&source, &id));
            if !cached.exists() {
                return Err(vmusic_core::CoreError::NotFound(format!(
                    "在线缓存已失效，请重新试听: {track_id}"
                )));
            }
            cached
        } else {
            let track = vmusic_store::get_track(&self.db, &track_id)
                .await
                .map_err(vmusic_core::CoreError::Store)?
                .ok_or_else(|| vmusic_core::CoreError::NotFound(track_id.clone()))?;
            std::path::PathBuf::from(track.path)
        };

        let uri = path
            .to_str()
            .ok_or_else(|| vmusic_core::CoreError::NotFound("路径含非 UTF-8 字符".into()))?;

        self.audio
            .load(uri, Some(track_id.clone()))
            .await
            .map_err(vmusic_core::CoreError::Audio)?;
        self.audio
            .play()
            .await
            .map_err(vmusic_core::CoreError::Audio)?;
        Ok(())
    }

    /// Moves the queue according to the current play mode.
    ///
    /// `auto` is true when the move comes from a track finishing rather than a
    /// button press: `RepeatOne` only repeats on auto, a user pressing "next"
    /// always moves forward.
    pub async fn step(&self, delta: isize, auto: bool) -> Result<(), vmusic_core::CoreError> {
        let mode = self.audio.snapshot().mode;
        let len = self.queue.lock().await.len();
        if len == 0 {
            return Ok(());
        }
        let current = self.current_index().await.unwrap_or(0);

        let next = match mode {
            PlayMode::RepeatOne if auto => current,
            // Shuffle must move: picking the current index again would look
            // like "next" did nothing. VCP keeps a pre-shuffled queue for the
            // same reason; excluding the current index is the minimal version.
            PlayMode::Shuffle if delta > 0 => random_index(len, Some(current)),
            _ => {
                let raw = current as isize + delta;
                if raw < 0 {
                    len - 1
                } else if raw as usize >= len {
                    0
                } else {
                    raw as usize
                }
            }
        };

        self.play_index(next).await
    }
}

/// Shuffle without pulling in an RNG crate: xorshift seeded from the clock.
///
/// `exclude` is the index that must not be returned (the one already playing),
/// honoured only when the queue has somewhere else to go.
fn random_index(len: usize, exclude: Option<usize>) -> usize {
    if len == 0 {
        return 0;
    }
    let mut x = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15);
    if x == 0 {
        x = 0x9E3779B97F4A7C15;
    }
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    let pick = (x % len as u64) as usize;
    match exclude {
        Some(skip) if len > 1 && pick == skip => (pick + 1) % len,
        _ => pick,
    }
}

/// Bridges audio-actor events onto the WebSocket bus and drives auto-advance.
pub fn spawn_event_pump(state: Arc<AppState>) {
    let mut rx = state.audio.subscribe();
    tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            match event {
                AudioEvent::Snapshot(snap) => state.publish(WsEvent::State(snap)),
                AudioEvent::Spectrum(bands) => state.publish(WsEvent::Spectrum { bands }),
                AudioEvent::Ended => {
                    state.publish(WsEvent::Ended);
                    if let Err(e) = state.step(1, true).await {
                        tracing::warn!("auto-advance failed: {e}");
                    }
                }
                AudioEvent::Error(message) => state.publish(WsEvent::Error { message }),
            }
        }
    });
}

/// Writes the discovery file a host reads to find us. Removed on shutdown so
/// a crashed instance does not leave a stale port behind.
pub async fn write_discovery(state: &AppState, port: u16) -> anyhow::Result<PathBuf> {
    #[derive(Serialize)]
    struct Discovery {
        pid: u32,
        port: u16,
        token: String,
        version: String,
        protocol_version: u32,
    }
    let body = Discovery {
        pid: std::process::id(),
        port,
        token: state.token.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: PROTOCOL_VERSION,
    };
    let path = state.data_dir.join("vmusicd.json");
    tokio::fs::write(&path, serde_json::to_vec_pretty(&body)?).await?;
    Ok(path)
}

pub async fn remove_discovery(data_dir: &std::path::Path) {
    let _ = tokio::fs::remove_file(data_dir.join("vmusicd.json")).await;
}

#[cfg(test)]
mod tests {
    use super::random_index;

    #[test]
    fn shuffle_never_returns_the_excluded_index() {
        for len in 2..8usize {
            for skip in 0..len {
                for _ in 0..64 {
                    assert_ne!(random_index(len, Some(skip)), skip);
                }
            }
        }
    }

    #[test]
    fn shuffle_stays_inside_the_queue() {
        for _ in 0..256 {
            assert!(random_index(5, None) < 5);
        }
        // A one-item queue has nowhere else to go; it must stay valid.
        assert_eq!(random_index(1, Some(0)), 0);
    }
}
