// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! The command actor: the single writer of playback state.
//!
//! Every playback operation becomes a message on one queue, consumed by one
//! thread that owns the backend. That removes the need for locks around
//! playback state entirely — readers get an [`arc_swap`] snapshot, writers are
//! serialised by construction.
//!
//! The actor also owns the wall-clock duties: publishing snapshots, sampling
//! the spectrum at ~30 Hz and turning "the decoder ran dry" into an
//! [`AudioEvent::Ended`] so the service layer can advance the queue.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use arc_swap::ArcSwap;
use tokio::sync::{broadcast, oneshot};
use vmusic_core::{AudioBackend, AudioError, DeviceInfo, MediaInfo, PlayMode, PlayerSnapshot};

#[cfg(feature = "playback")]
use crate::cpal_backend::CpalBackend;
use crate::null::NullBackend;

/// Which backend the actor should build. Chosen at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    /// Real playback. Requires a usable output device.
    #[cfg(feature = "playback")]
    Cpal,
    /// No sound. Deterministic timing, used by tests and `--backend null`.
    Null,
}

impl BackendKind {
    /// Fall back to `Null` when the `playback` feature is compiled out.
    #[cfg(not(feature = "playback"))]
    #[allow(dead_code)]
    pub fn cpal() -> Self {
        BackendKind::Null
    }

    #[cfg(feature = "playback")]
    #[allow(dead_code)]
    pub fn cpal() -> Self {
        BackendKind::Cpal
    }
}

const SPECTRUM_BANDS: usize = 64;
const SPECTRUM_INTERVAL: Duration = Duration::from_millis(33);
const TICK: Duration = Duration::from_millis(20);

#[derive(Debug, Clone)]
pub enum AudioEvent {
    Snapshot(PlayerSnapshot),
    Spectrum(Vec<f32>),
    /// The current source played to its end.
    Ended,
    Error(String),
}

type Reply<T> = oneshot::Sender<T>;

enum Command {
    Load {
        uri: String,
        track_id: Option<String>,
        reply: Reply<Result<MediaInfo, AudioError>>,
    },
    /// Every transport command carries a reply so the caller sees the *result*
    /// of the command, not merely "the queue accepted it". Without this the HTTP
    /// handler reads the snapshot before the actor has run and reports stale
    /// state (and swallows backend failures).
    Play(Reply<Result<(), AudioError>>),
    Pause(Reply<Result<(), AudioError>>),
    Stop(Reply<Result<(), AudioError>>),
    Seek(u64, Reply<Result<(), AudioError>>),
    SetVolume(f32, Reply<Result<(), AudioError>>),
    SetMode(PlayMode, Reply<Result<(), AudioError>>),
    Devices(Reply<Vec<DeviceInfo>>),
    SelectDevice(Option<String>, Reply<Result<(), AudioError>>),
    Shutdown,
}

/// Cheap, cloneable handle to the actor. Safe to keep in axum state.
#[derive(Clone)]
pub struct AudioHandle {
    tx: Sender<Command>,
    snapshot: std::sync::Arc<ArcSwap<PlayerSnapshot>>,
    events: broadcast::Sender<AudioEvent>,
}

impl AudioHandle {
    pub fn snapshot(&self) -> PlayerSnapshot {
        (**self.snapshot.load()).clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AudioEvent> {
        self.events.subscribe()
    }

    pub async fn load(&self, uri: &str, track_id: Option<String>) -> Result<MediaInfo, AudioError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Load {
            uri: uri.to_string(),
            track_id,
            reply: tx,
        })?;
        rx.await
            .unwrap_or(Err(AudioError::Other("actor gone".into())))
    }

    pub async fn play(&self) -> Result<(), AudioError> {
        self.ask(Command::Play).await
    }

    pub async fn pause(&self) -> Result<(), AudioError> {
        self.ask(Command::Pause).await
    }

    pub async fn stop(&self) -> Result<(), AudioError> {
        self.ask(Command::Stop).await
    }

    pub async fn seek(&self, position_ms: u64) -> Result<(), AudioError> {
        self.ask(|reply| Command::Seek(position_ms, reply)).await
    }

    pub async fn set_volume(&self, volume: f32) -> Result<(), AudioError> {
        self.ask(|reply| Command::SetVolume(volume, reply)).await
    }

    pub async fn set_mode(&self, mode: PlayMode) -> Result<(), AudioError> {
        self.ask(|reply| Command::SetMode(mode, reply)).await
    }

    /// Send a command that carries a reply and wait for the actor to run it.
    async fn ask(
        &self,
        make: impl FnOnce(Reply<Result<(), AudioError>>) -> Command,
    ) -> Result<(), AudioError> {
        let (tx, rx) = oneshot::channel();
        self.send(make(tx))?;
        rx.await
            .unwrap_or(Err(AudioError::Other("actor gone".into())))
    }

    pub async fn devices(&self) -> Result<Vec<DeviceInfo>, AudioError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Devices(tx))?;
        Ok(rx.await.unwrap_or_default())
    }

    pub async fn select_device(&self, id: Option<String>) -> Result<(), AudioError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::SelectDevice(id, tx))?;
        rx.await.unwrap_or(Ok(()))
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(Command::Shutdown);
    }

    fn send(&self, cmd: Command) -> Result<(), AudioError> {
        self.tx
            .send(cmd)
            .map_err(|_| AudioError::Other("audio actor is not running".into()))
    }
}

/// Spawn the actor thread and wait until its backend is ready.
pub async fn spawn(kind: BackendKind) -> Result<(AudioHandle, JoinHandle<()>), AudioError> {
    let (init_tx, init_rx) = oneshot::channel();
    let (tx, rx) = mpsc::channel::<Command>();
    let snapshot = std::sync::Arc::new(ArcSwap::from_pointee(PlayerSnapshot::default()));
    let (events, _) = broadcast::channel(64);

    let actor_snapshot = snapshot.clone();
    let actor_events = events.clone();

    let handle = std::thread::Builder::new()
        .name("vmusic-audio".into())
        .spawn(move || run(kind, rx, actor_snapshot, actor_events, init_tx))
        .map_err(|e| AudioError::BackendInit(e.to_string()))?;

    let audio = AudioHandle {
        tx,
        snapshot,
        events,
    };

    match init_rx.await {
        Ok(Ok(())) => Ok((audio, handle)),
        Ok(Err(e)) => {
            audio.shutdown();
            Err(e)
        }
        Err(_) => Err(AudioError::BackendInit("actor died during startup".into())),
    }
}

fn run(
    kind: BackendKind,
    rx: Receiver<Command>,
    snapshot: std::sync::Arc<ArcSwap<PlayerSnapshot>>,
    events: broadcast::Sender<AudioEvent>,
    init_tx: oneshot::Sender<Result<(), AudioError>>,
) {
    let mut backend: Box<dyn AudioBackend> = match kind {
        #[cfg(feature = "playback")]
        BackendKind::Cpal => match CpalBackend::new() {
            Ok(b) => {
                let _ = init_tx.send(Ok(()));
                Box::new(b)
            }
            Err(e) => {
                tracing::error!("cpal backend unavailable: {e}");
                let _ = init_tx.send(Err(e));
                return;
            }
        },
        BackendKind::Null => {
            let _ = init_tx.send(Ok(()));
            Box::new(NullBackend::new())
        }
    };

    tracing::info!("audio actor started with backend '{}'", backend.name());

    let mut state = PlayerSnapshot::default();
    let mut spectrum = vec![0f32; SPECTRUM_BANDS];
    let mut last_spectrum = Instant::now();
    let mut ended_emitted = false;

    loop {
        match rx.recv_timeout(TICK) {
            Ok(Command::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(cmd) => {
                if let Err(e) = apply(&mut *backend, &mut state, &snapshot, cmd) {
                    tracing::warn!("audio command failed: {e}");
                    let _ = events.send(AudioEvent::Error(e.to_string()));
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        // Natural end of track: latch it so we emit exactly once.
        if !ended_emitted && backend.finished() {
            ended_emitted = true;
            state.playing = false;
            tracing::debug!("track finished");
            let _ = events.send(AudioEvent::Ended);
        }

        state.position_ms = backend.position_ms();
        state.duration_ms = backend.duration_ms();

        let _ = events.send(AudioEvent::Snapshot(state.clone()));
        snapshot.store(std::sync::Arc::new(state.clone()));

        if last_spectrum.elapsed() >= SPECTRUM_INTERVAL {
            last_spectrum = Instant::now();
            if backend.spectrum(&mut spectrum) {
                let _ = events.send(AudioEvent::Spectrum(spectrum.clone()));
            }
        }
    }

    tracing::info!("audio actor stopped");
}

/// 把当前状态发布到共享快照。
///
/// **必须早于命令回执**：`Handle::set_volume()` 之类返回后调用方往往会立刻读
/// `Handle::snapshot()`，而回执只保证「命令已应用」、不保证「已发布」——
/// 原来快照统一在循环末尾 `store`，于是 `apply` 里 `reply.send()` 之后、
/// 循环末尾之前存在一个窗口，等待中的调用方线程可能先被唤醒、读到上一个状态
/// （`a_completed_command_is_visible_immediately` 就是钉这个不变量的回归测试，
/// 在机器有负载时能稳定复现失败）。先发布再回复，窗口就不存在了。
fn publish(sink: &ArcSwap<PlayerSnapshot>, state: &PlayerSnapshot) {
    sink.store(std::sync::Arc::new(state.clone()));
}

fn apply(
    backend: &mut dyn AudioBackend,
    state: &mut PlayerSnapshot,
    sink: &ArcSwap<PlayerSnapshot>,
    cmd: Command,
) -> Result<(), AudioError> {
    match cmd {
        Command::Load {
            uri,
            track_id,
            reply,
        } => {
            let info = backend.load(&uri);
            if let Ok(info) = &info {
                state.track_id = track_id;
                state.duration_ms = info.duration_ms;
                state.position_ms = 0;
                state.playing = false;
                state.generation += 1;
            }
            publish(sink, state);
            let _ = reply.send(info);
            Ok(())
        }
        Command::Play(reply) => {
            // Playing with nothing loaded used to silently flip `playing` to
            // true. Refuse instead so the API can answer 409 rather than lying.
            let result = if state.track_id.is_none() {
                Err(AudioError::NothingLoaded)
            } else {
                backend.play().map(|()| state.playing = true)
            };
            publish(sink, state);
            let _ = reply.send(result);
            Ok(())
        }
        Command::Pause(reply) => {
            let result = backend.pause().map(|()| state.playing = false);
            publish(sink, state);
            let _ = reply.send(result);
            Ok(())
        }
        Command::Stop(reply) => {
            let result = backend.stop().map(|()| {
                state.playing = false;
                state.position_ms = 0;
                state.generation += 1;
            });
            publish(sink, state);
            let _ = reply.send(result);
            Ok(())
        }
        Command::Seek(ms, reply) => {
            let result = backend.seek(ms).map(|()| {
                state.position_ms = ms;
                state.generation += 1;
            });
            publish(sink, state);
            let _ = reply.send(result);
            Ok(())
        }
        Command::SetVolume(v, reply) => {
            let result = backend
                .set_volume(v)
                .map(|()| state.volume = v.clamp(0.0, 1.0));
            publish(sink, state);
            let _ = reply.send(result);
            Ok(())
        }
        Command::SetMode(mode, reply) => {
            state.mode = mode;
            publish(sink, state);
            let _ = reply.send(Ok(()));
            Ok(())
        }
        Command::Devices(reply) => {
            let devices = backend.devices().unwrap_or_default();
            publish(sink, state);
            let _ = reply.send(devices);
            Ok(())
        }
        Command::SelectDevice(id, reply) => {
            let result = backend.select_device(id.as_deref());
            if result.is_ok() {
                state.device = id;
            }
            publish(sink, state);
            let _ = reply.send(result);
            Ok(())
        }
        Command::Shutdown => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// NullBackend 的位置来自墙上时钟，而 actor 只在 `TICK`(20ms) 边界上把
    /// `backend.position_ms()` 抄进快照。所以「睡固定时长后立刻断言位置」会卡在
    /// 边界上抖动：断言 `>= 100` 而读到的可能是上一个 tick 在 99.x ms 采到的值
    /// （`as_millis()` 截断成 99）。实测空载下 5 次里就有 2 次失败。
    ///
    /// 助手把「等一个精确时刻」换成「等一个截止时间」：断言强度不变（位置必须真的
    /// 推进到目标），只是不再假设快照刷新发生在哪一毫秒。
    fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_millis(1_000);
        while !cond() {
            assert!(Instant::now() < deadline, "{what} 在 1s 内没有达成");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[tokio::test]
    async fn actor_loads_plays_and_seeks_on_the_null_backend() {
        let (audio, _handle) = spawn(BackendKind::Null).await.unwrap();

        let info = audio
            .load("file:///x/a.mp3", Some("t1".into()))
            .await
            .unwrap();
        assert!(info.duration_ms.is_none(), "null backend has no duration");

        audio.play().await.unwrap();
        assert!(audio.snapshot().playing);
        wait_until("播放位置推进到 100ms", || {
            audio.snapshot().position_ms >= 100
        });

        audio.pause().await.unwrap();
        assert!(!audio.snapshot().playing);

        audio.seek(4_200).await.unwrap();
        // 暂停态下位置是冻结的，落点容忍 100ms；同样用截止时间而不是固定 sleep。
        wait_until("跳转落到 4200ms 附近", || {
            (audio.snapshot().position_ms as i64 - 4_200).abs() < 100
        });

        audio.shutdown();
    }

    #[tokio::test]
    async fn snapshots_are_visible_without_a_subscription() {
        let (audio, _handle) = spawn(BackendKind::Null).await.unwrap();
        audio.set_volume(0.25).await.unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!((audio.snapshot().volume - 0.25).abs() < 1e-6);
        audio.shutdown();
    }

    /// Regression: the command must be *applied* before the caller reads state.
    /// Previously the handle returned as soon as the command was queued, so a
    /// caller that read the snapshot right away saw the previous value.
    #[tokio::test]
    async fn a_completed_command_is_visible_immediately() {
        let (audio, _handle) = spawn(BackendKind::Null).await.unwrap();

        audio.set_volume(0.5).await.unwrap();
        assert!((audio.snapshot().volume - 0.5).abs() < 1e-6);

        audio.set_mode(PlayMode::Shuffle).await.unwrap();
        assert_eq!(audio.snapshot().mode, PlayMode::Shuffle);

        audio.shutdown();
    }

    /// Regression: `play` on an empty queue used to report success and set
    /// `playing: true` with no track attached.
    #[tokio::test]
    async fn play_without_a_track_is_rejected() {
        let (audio, _handle) = spawn(BackendKind::Null).await.unwrap();

        let err = audio.play().await.unwrap_err();
        assert!(matches!(err, AudioError::NothingLoaded), "got {err:?}");
        assert!(
            !audio.snapshot().playing,
            "state must not claim to be playing"
        );

        audio.shutdown();
    }
}
