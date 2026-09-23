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
use vmusic_core::{
    AudioBackend, AudioError, AudioSource, DeviceInfo, MediaInfo, PlayMode, PlayerSnapshot,
};

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
    /// 直接喂一个可读可定位的媒体源（边下边播）。命令只携带标准库
    /// `Read + Seek + Send` 超集（[`AudioSource`]）：actor 层不认识
    /// symphonia，trait 对象可直接经 std mpsc 传递。
    LoadSource {
        source: Box<dyn AudioSource>,
        ext: Option<String>,
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

    /// 直接加载流式媒体源（边下边播）。`ext` 帮助 symphonia 探测容器格式。
    pub async fn load_source(
        &self,
        source: Box<dyn AudioSource>,
        ext: Option<String>,
        track_id: Option<String>,
    ) -> Result<MediaInfo, AudioError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::LoadSource {
            source,
            ext,
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
    // 「本首的 Ended 是否已发过」门闩。它必须在每次换装/停止后复位，否则进程
    // 生命周期里只有第一首歌自然结束会发 Ended——在线整盘的自动接力只会成功
    // 一次（apply 用返回值告知本 tick 是否发生了换装/停止）。
    let mut ended_emitted = false;

    loop {
        match rx.recv_timeout(TICK) {
            Ok(Command::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(cmd) => match apply(&mut *backend, &mut state, &snapshot, cmd) {
                Ok(source_reset) => {
                    if source_reset {
                        ended_emitted = false;
                    }
                }
                Err(e) => {
                    tracing::warn!("audio command failed: {e}");
                    let _ = events.send(AudioEvent::Error(e.to_string()));
                }
            },
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

/// 应用一条命令。
///
/// 返回值 `source_reset` 回答「本 tick 是否换装或停止」：成功的 Load/Stop 为
/// true，run() 据此把「每首一次」的 Ended 门闩重新上膛；其余命令为 false。
/// 注意命令自身的业务成败走 `reply`，这里 Err 只用于真正需要上 Error 事件的
/// 场景（当前各臂均不产生）。
fn apply(
    backend: &mut dyn AudioBackend,
    state: &mut PlayerSnapshot,
    sink: &ArcSwap<PlayerSnapshot>,
    cmd: Command,
) -> Result<bool, AudioError> {
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
            let reset = info.is_ok();
            let _ = reply.send(info);
            Ok(reset)
        }
        Command::LoadSource {
            source,
            ext,
            track_id,
            reply,
        } => {
            let info = backend.load_source(source, ext);
            if let Ok(info) = &info {
                state.track_id = track_id;
                state.duration_ms = info.duration_ms;
                state.position_ms = 0;
                state.playing = false;
                state.generation += 1;
            }
            publish(sink, state);
            let reset = info.is_ok();
            let _ = reply.send(info);
            Ok(reset)
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
            Ok(false)
        }
        Command::Pause(reply) => {
            let result = backend.pause().map(|()| state.playing = false);
            publish(sink, state);
            let _ = reply.send(result);
            Ok(false)
        }
        Command::Stop(reply) => {
            let result = backend.stop().map(|()| {
                state.playing = false;
                state.position_ms = 0;
                state.generation += 1;
            });
            publish(sink, state);
            let reset = result.is_ok();
            let _ = reply.send(result);
            Ok(reset)
        }
        Command::Seek(ms, reply) => {
            let result = backend.seek(ms).map(|()| {
                state.position_ms = ms;
                state.generation += 1;
            });
            publish(sink, state);
            let _ = reply.send(result);
            Ok(false)
        }
        Command::SetVolume(v, reply) => {
            let result = backend
                .set_volume(v)
                .map(|()| state.volume = v.clamp(0.0, 1.0));
            publish(sink, state);
            let _ = reply.send(result);
            Ok(false)
        }
        Command::SetMode(mode, reply) => {
            state.mode = mode;
            publish(sink, state);
            let _ = reply.send(Ok(()));
            Ok(false)
        }
        Command::Devices(reply) => {
            let devices = backend.devices().unwrap_or_default();
            publish(sink, state);
            let _ = reply.send(devices);
            Ok(false)
        }
        Command::SelectDevice(id, reply) => {
            let result = backend.select_device(id.as_deref());
            if result.is_ok() {
                state.device = id;
            }
            publish(sink, state);
            let _ = reply.send(result);
            Ok(false)
        }
        Command::Shutdown => Ok(false),
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

    /// 一 play 就「播完」的后端：用来钉 apply 的 Ended 门闩复位契约。
    /// run() 的门闩消费无法经 BackendKind 注入假后端，所以复位契约在这层钉：
    /// 只有成功的 Load/Stop 允许返回 true，且每次 Load 都要返回——门闩是
    /// 「每首一次」，不是「进程一次」。少了它，在线整盘只会自动接力一次。
    #[derive(Default)]
    struct InstantEndBackend {
        armed: bool,
        load_fails: bool,
        stop_fails: bool,
    }

    impl AudioBackend for InstantEndBackend {
        fn name(&self) -> &'static str {
            "instant-end"
        }
        fn devices(&self) -> Result<Vec<DeviceInfo>, AudioError> {
            Ok(vec![])
        }
        fn select_device(&mut self, _id: Option<&str>) -> Result<(), AudioError> {
            Ok(())
        }
        fn load(&mut self, _uri: &str) -> Result<MediaInfo, AudioError> {
            if self.load_fails {
                return Err(AudioError::UnsupportedFormat("test load failure".into()));
            }
            self.armed = false;
            Ok(MediaInfo::default())
        }
        fn play(&mut self) -> Result<(), AudioError> {
            self.armed = true;
            Ok(())
        }
        fn pause(&mut self) -> Result<(), AudioError> {
            Ok(())
        }
        fn stop(&mut self) -> Result<(), AudioError> {
            if self.stop_fails {
                return Err(AudioError::BackendInit("test stop failure".into()));
            }
            self.armed = false;
            Ok(())
        }
        fn seek(&mut self, _position_ms: u64) -> Result<(), AudioError> {
            Ok(())
        }
        fn set_volume(&mut self, _volume: f32) -> Result<(), AudioError> {
            Ok(())
        }
        fn position_ms(&self) -> u64 {
            0
        }
        fn duration_ms(&self) -> Option<u64> {
            None
        }
        fn finished(&self) -> bool {
            self.armed
        }
        fn spectrum(&self, _out: &mut [f32]) -> bool {
            false
        }
    }

    fn unit_reply<T>() -> oneshot::Sender<T> {
        let (tx, _rx) = oneshot::channel();
        tx
    }

    #[test]
    fn load_and_stop_rearm_the_ended_latch_every_time() {
        let mut backend = InstantEndBackend::default();
        let mut state = PlayerSnapshot::default();
        let sink = ArcSwap::from_pointee(PlayerSnapshot::default());

        // 成功 Load：换装，门闩必须重新上膛。
        assert!(apply(
            &mut backend,
            &mut state,
            &sink,
            Command::Load {
                uri: "a".into(),
                track_id: Some("t1".into()),
                reply: unit_reply(),
            }
        )
        .unwrap());
        // Play 之后后端即报 finished（模拟本首自然结束），但 Play 命令本身
        // 不触发复位。
        assert!(!apply(&mut backend, &mut state, &sink, Command::Play(unit_reply())).unwrap());
        assert!(backend.finished());
        // 其余传输/查询命令一律不复位。
        assert!(!apply(
            &mut backend,
            &mut state,
            &sink,
            Command::Pause(unit_reply())
        )
        .unwrap());
        assert!(!apply(
            &mut backend,
            &mut state,
            &sink,
            Command::Seek(0, unit_reply())
        )
        .unwrap());
        // Stop 也重新上膛（门闩不能把「停止后再播」吞掉）。
        assert!(apply(&mut backend, &mut state, &sink, Command::Stop(unit_reply())).unwrap());
        // 第二首 Load 仍须返回 true：门闩按首复位。
        assert!(apply(
            &mut backend,
            &mut state,
            &sink,
            Command::Load {
                uri: "b".into(),
                track_id: Some("t2".into()),
                reply: unit_reply(),
            }
        )
        .unwrap());

        // 负向半契约：换装/停止失败时门闩绝不能被重新上膛。门闩此刻已随第二
        // 首 Load 复位（ended_emitted=false），失败命令必须保持 false 返回值。
        let mut failing = InstantEndBackend {
            armed: true,
            load_fails: true,
            stop_fails: true,
        };
        let mut failing_state = PlayerSnapshot::default();
        // 先让它成功装一首，门闩应被复位；随后两个失败命令都不得再报复位。
        failing.load_fails = false;
        failing.stop_fails = false;
        assert!(apply(
            &mut failing,
            &mut failing_state,
            &sink,
            Command::Load {
                uri: "c".into(),
                track_id: Some("t3".into()),
                reply: unit_reply(),
            }
        )
        .unwrap());
        failing.load_fails = true;
        failing.stop_fails = true;
        assert!(!apply(
            &mut failing,
            &mut failing_state,
            &sink,
            Command::Load {
                uri: "broken".into(),
                track_id: Some("t4".into()),
                reply: unit_reply(),
            }
        )
        .unwrap());
        assert!(!apply(
            &mut failing,
            &mut failing_state,
            &sink,
            Command::Stop(unit_reply())
        )
        .unwrap());
    }

    /// LoadSource 的最小可用后端：记录调用标记，不做真解码。
    struct SourceBackend {
        loaded: std::cell::Cell<Option<String>>,
    }

    impl AudioBackend for SourceBackend {
        fn name(&self) -> &'static str {
            "source-test"
        }
        fn devices(&self) -> Result<Vec<DeviceInfo>, AudioError> {
            Ok(vec![])
        }
        fn select_device(&mut self, _id: Option<&str>) -> Result<(), AudioError> {
            Ok(())
        }
        fn load(&mut self, _uri: &str) -> Result<MediaInfo, AudioError> {
            Ok(MediaInfo::default())
        }
        fn load_source(
            &mut self,
            _source: Box<dyn AudioSource>,
            _ext: Option<String>,
        ) -> Result<MediaInfo, AudioError> {
            self.loaded.set(Some("stream".into()));
            Ok(MediaInfo::default())
        }
        fn play(&mut self) -> Result<(), AudioError> {
            Ok(())
        }
        fn pause(&mut self) -> Result<(), AudioError> {
            Ok(())
        }
        fn stop(&mut self) -> Result<(), AudioError> {
            Ok(())
        }
        fn seek(&mut self, _position_ms: u64) -> Result<(), AudioError> {
            Ok(())
        }
        fn set_volume(&mut self, _volume: f32) -> Result<(), AudioError> {
            Ok(())
        }
        fn position_ms(&self) -> u64 {
            0
        }
        fn duration_ms(&self) -> Option<u64> {
            None
        }
        fn finished(&self) -> bool {
            false
        }
        fn spectrum(&self, _out: &mut [f32]) -> bool {
            false
        }
    }

    /// 内存媒体源：命令字段类型是标准库 `Read + Seek + Send`，所以这里
    /// 只需委托 Cursor，不必实现 symphonia 的 MediaSource。
    struct MemSource(std::io::Cursor<Vec<u8>>);

    impl std::io::Read for MemSource {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl std::io::Seek for MemSource {
        fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
            self.0.seek(pos)
        }
    }

    #[test]
    fn load_source_command_updates_track_id() {
        let mut backend = SourceBackend {
            loaded: std::cell::Cell::new(None),
        };
        let mut state = PlayerSnapshot::default();
        let sink = ArcSwap::from_pointee(PlayerSnapshot::default());
        let ok = apply(
            &mut backend,
            &mut state,
            &sink,
            Command::LoadSource {
                source: Box::new(MemSource(std::io::Cursor::new(b"ID3fake".to_vec()))),
                ext: Some("mp3".into()),
                track_id: Some("online:qq:1".into()),
                reply: unit_reply(),
            },
        )
        .unwrap();
        assert!(ok);
        assert_eq!(state.track_id.as_deref(), Some("online:qq:1"));
        assert_eq!(state.position_ms, 0);
        assert!(!state.playing);
        assert_eq!(state.generation, 1);
        // Cell<Option<String>> 不是 Copy，用 take() 取出标记。
        assert_eq!(backend.loaded.take(), Some("stream".to_string()));
    }
}
