// SPDX-License-Identifier: MIT
//! Room sources reuse the online downloader. A decoder keeps its download and
//! cache lease alive; weak entries only coalesce simultaneous users of a track.
use super::contract::{RoomError, RoomResult};
use crate::{online, state::AppState};
use std::time::{Duration, Instant};
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Weak,
    },
};
use tokio::sync::{Mutex, OnceCell};
use vmusic_audio::render::{NativePcmBudget, PreparedMedia};
use vmusic_lan::protocol::FormatMode;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OnlineSong {
    pub source: String,
    pub id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub cover: Option<String>,
    #[serde(default, rename = "ref")]
    pub track_ref: online::TrackRef,
}
impl OnlineSong {
    pub fn validate(&self) -> RoomResult<()> {
        if online::find(&self.source).is_none()
            || self.id.trim().is_empty()
            || self.id.len() > 512
            || self.id.chars().any(char::is_control)
            || self.title.len() > 1024
            || self.title.trim().is_empty()
            || self.artist.as_ref().is_some_and(|s| s.len() > 1024)
            || self.album.as_ref().is_some_and(|s| s.len() > 1024)
            || self.cover.as_ref().is_some_and(|s| s.len() > 4096)
            || serde_json::to_vec(&self.track_ref).map_or(true, |v| v.len() > 8192)
        {
            return Err(RoomError::invalid("在线歌曲来源或元数据无效"));
        }
        Ok(())
    }
    pub fn virtual_id(&self) -> String {
        online::virtual_id(&self.source, &self.id)
    }
}

#[derive(Default)]
pub(super) struct OnlineSources(Mutex<HashMap<String, Weak<Session>>>);
struct Session {
    ready: OnceCell<Ready>,
    _cache: online::cache::CacheLease,
}
struct Ready {
    cached: Option<PathBuf>,
    download: Option<online::progressive::Download>,
}
impl Drop for Ready {
    fn drop(&mut self) {
        if let Some(dl) = &self.download {
            if !dl.is_finished() {
                dl.cancel();
            }
        }
    }
}

pub(super) fn error(error: crate::error::ApiError) -> RoomError {
    // Public error messages can include signed upstream URLs. Keep the machine
    // code, but expose only our fixed room text to authenticated peers.
    let message = match error.code {
        "auth_required" => "请房主先登录此在线音源",
        "vip_required" => "房主账号无法获取此音质或歌曲",
        "upstream_timeout" => "在线音源响应超时，请稍后重试",
        "not_found" => "在线歌曲已失效或无法播放",
        _ => "在线歌曲获取失败，请房主检查音源或账号后重试",
    };
    RoomError::new(error.code, message)
}
impl OnlineSources {
    #[cfg(test)]
    pub async fn prepare(
        &self,
        state: &Arc<AppState>,
        song: &OnlineSong,
        position_ms: u64,
    ) -> RoomResult<PreparedMedia> {
        self.prepare_configured(
            state,
            song,
            position_ms,
            FormatMode::Fixed,
            NativePcmBudget::default(),
            Instant::now() + Duration::from_secs(20),
        )
        .await
    }

    pub async fn prepare_configured(
        &self,
        state: &Arc<AppState>,
        song: &OnlineSong,
        position_ms: u64,
        format_mode: FormatMode,
        native_budget: NativePcmBudget,
        deadline: Instant,
    ) -> RoomResult<PreparedMedia> {
        self.prepare_with_configured(
            state,
            song,
            position_ms,
            format_mode,
            native_budget,
            deadline,
            |quality| async move {
                let ctx = online::Ctx::new(state.db.clone());
                online::stream(
                    &ctx,
                    &song.source,
                    &song.id,
                    Some(&song.track_ref),
                    Some(quality),
                )
                .await
                .map_err(error)
            },
        )
        .await
    }

    #[cfg(test)]
    async fn prepare_with<F, Fut>(
        &self,
        state: &Arc<AppState>,
        song: &OnlineSong,
        position_ms: u64,
        resolve: F,
    ) -> RoomResult<PreparedMedia>
    where
        F: FnOnce(u32) -> Fut,
        Fut: std::future::Future<Output = RoomResult<online::StreamInfo>>,
    {
        self.prepare_with_configured(
            state,
            song,
            position_ms,
            FormatMode::Fixed,
            NativePcmBudget::default(),
            Instant::now() + Duration::from_secs(20),
            resolve,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn prepare_with_configured<F, Fut>(
        &self,
        state: &Arc<AppState>,
        song: &OnlineSong,
        position_ms: u64,
        format_mode: FormatMode,
        native_budget: NativePcmBudget,
        deadline: Instant,
        resolve: F,
    ) -> RoomResult<PreparedMedia>
    where
        F: FnOnce(u32) -> Fut,
        Fut: std::future::Future<Output = RoomResult<online::StreamInfo>>,
    {
        let cleanup = if format_mode == FormatMode::Native {
            Duration::from_millis(500)
        } else {
            Duration::ZERO
        };
        tokio::time::timeout_at(
            tokio::time::Instant::from_std(deadline + cleanup),
            self.prepare_inner(
                state,
                song,
                position_ms,
                format_mode,
                native_budget,
                deadline,
                resolve,
            ),
        )
        .await
        .map_err(|_| preparation_timeout(format_mode))?
    }

    #[allow(clippy::too_many_arguments)]
    async fn prepare_inner<F, Fut>(
        &self,
        state: &Arc<AppState>,
        song: &OnlineSong,
        position_ms: u64,
        format_mode: FormatMode,
        native_budget: NativePcmBudget,
        deadline: Instant,
        resolve: F,
    ) -> RoomResult<PreparedMedia>
    where
        F: FnOnce(u32) -> Fut,
        Fut: std::future::Future<Output = RoomResult<online::StreamInfo>>,
    {
        check_deadline(deadline, format_mode)?;
        let track = song.virtual_id();
        let quality = state.online_quality_for(&song.source, &track).await;
        check_deadline(deadline, format_mode)?;
        let key = online::cache::cache_key(&song.source, &song.id, quality.as_str());
        let session = {
            let mut sessions = self.0.lock().await;
            sessions.retain(|_, value| value.strong_count() > 0);
            if let Some(session) = sessions.get(&key).and_then(Weak::upgrade) {
                session
            } else {
                let session = Arc::new(Session {
                    ready: OnceCell::new(),
                    _cache: state.cache_index.lease(&song.source, &song.id),
                });
                sessions.insert(key.clone(), Arc::downgrade(&session));
                session
            }
        };
        let ready = session
            .ready
            .get_or_try_init(|| async {
                if let Some((path, _)) = state
                    .find_online_cached(&song.source, &song.id, quality)
                    .await
                {
                    check_deadline(deadline, format_mode)?;
                    return Ok(Ready {
                        cached: Some(path),
                        download: None,
                    });
                }
                let info = tokio::time::timeout_at(
                    tokio::time::Instant::from_std(deadline),
                    resolve(quality.bps()),
                )
                .await
                .map_err(|_| preparation_timeout(format_mode))??;
                state
                    .store_online_rg(&track, info.rg_gain_db, info.rg_peak)
                    .await;
                check_deadline(deadline, format_mode)?;
                let dl = online::progressive::start(
                    &song.source,
                    state.online_cache_dir(),
                    key.clone(),
                    info.ladder(),
                    song.duration_ms,
                    state.cache_index.clone(),
                )
                .map_err(error)?;
                // Guard ownership is established before the first cancellable wait.
                Ok::<_, RoomError>(Ready {
                    cached: None,
                    download: Some(dl),
                })
            })
            .await?;
        let stop = Arc::new(AtomicBool::new(false));
        let mut cancel = PreparationGuard::new(stop.clone(), deadline);
        check_deadline(deadline, format_mode)?;
        let eof_check: Arc<dyn Fn() -> bool + Send + Sync> = if let Some(download) = &ready.download
        {
            let view = download.view();
            // Published only after successful rename and cache registration.
            Arc::new(move || view.completed_path().is_some())
        } else {
            Arc::new(|| true)
        };
        let (source, ext) = if let Some(path) = &ready.cached {
            let file = online::progressive::FileMediaSource::open(path)
                .map_err(|_| RoomError::invalid("在线缓存不可读，请清理缓存后重试"))?;
            (
                Box::new(file) as Box<dyn vmusic_core::AudioSource>,
                path.extension().and_then(|e| e.to_str()).map(str::to_owned),
            )
        } else {
            let view = ready.download.as_ref().unwrap().view();
            while !view
                .room_prebuffer_tick(song.duration_ms)
                .await
                .map_err(|_| RoomError::new("room_online_download", "在线歌曲下载中断"))?
            {
                check_deadline(deadline, format_mode)?;
            }
            if view
                .needs_full_download()
                .await
                .map_err(|_| RoomError::new("room_online_download", "无法读取在线歌曲头部"))?
            {
                while !view.is_finished() {
                    check_deadline(deadline, format_mode)?;
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    view.room_prebuffer_tick(song.duration_ms)
                        .await
                        .map_err(|_| RoomError::new("room_online_download", "在线歌曲下载中断"))?;
                }
            }
            (
                view.media_source(stop.clone())
                    .await
                    .map_err(|_| RoomError::new("room_online_download", "在线歌曲缓存不可读"))?,
                Some(view.ext().to_owned()),
            )
        };
        let source = LeasedSource {
            inner: source,
            _session: session,
            stop: stop.clone(),
        };
        let input = cancel.hold_input(source);
        check_deadline(deadline, format_mode)?;
        let worker_stop = stop.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let source = input.lock().unwrap().take().ok_or_else(|| {
                vmusic_core::AudioError::DecodeFailed("native_source_cancelled".into())
            })?;
            let mut media = if format_mode == FormatMode::Native {
                PreparedMedia::open_native_interruptible(
                    Box::new(source),
                    ext.as_deref(),
                    worker_stop,
                    native_budget.clone(),
                    deadline,
                )?
            } else {
                PreparedMedia::open_interruptible(Box::new(source), ext.as_deref(), worker_stop)?
            };
            if format_mode == FormatMode::Native {
                media.set_native_eof_check(eof_check);
                if position_ms > 0 {
                    media.seek_native(position_ms, native_budget, deadline)?;
                } else {
                    media.validate_native(native_budget, deadline)?;
                }
            } else if position_ms > 0 {
                media.seek(position_ms)?;
            }
            Ok::<_, vmusic_core::AudioError>(media)
        });
        cancel.arm_worker(&worker);
        let media = await_prepared(worker, &stop, deadline, format_mode).await?;
        check_deadline(deadline, format_mode)?;
        cancel.disarm();
        Ok(media)
    }
}
pub(super) struct PreparationGuard {
    stop: Option<Arc<AtomicBool>>,
    watchdog: tokio::task::JoinHandle<()>,
    worker_abort: Option<tokio::task::AbortHandle>,
    input_cleanup: Option<Box<dyn FnOnce() + Send>>,
}
impl PreparationGuard {
    pub(super) fn new(stop: Arc<AtomicBool>, deadline: Instant) -> Self {
        let worker_stop = stop.clone();
        let watchdog = tokio::spawn(async move {
            tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
            worker_stop.store(true, Ordering::Release);
        });
        Self {
            stop: Some(stop),
            watchdog,
            worker_abort: None,
            input_cleanup: None,
        }
    }
    pub(super) fn arm_worker<T>(&mut self, worker: &tokio::task::JoinHandle<T>) {
        self.worker_abort = Some(worker.abort_handle());
    }
    fn hold_input<T: Send + 'static>(&mut self, input: T) -> Arc<std::sync::Mutex<Option<T>>> {
        let slot = Arc::new(std::sync::Mutex::new(Some(input)));
        let cleanup = slot.clone();
        self.input_cleanup = Some(Box::new(move || {
            let input = cleanup.lock().unwrap().take();
            drop(input);
        }));
        slot
    }
    pub(super) fn disarm(&mut self) {
        self.stop.take();
        self.watchdog.abort();
        self.worker_abort.take();
        self.input_cleanup.take();
    }
}
impl Drop for PreparationGuard {
    fn drop(&mut self) {
        if let Some(stop) = &self.stop {
            stop.store(true, Ordering::Release);
        }
        self.watchdog.abort();
        if let Some(worker) = &self.worker_abort {
            worker.abort();
        }
        if let Some(cleanup) = self.input_cleanup.take() {
            cleanup();
        }
    }
}

pub(super) fn check_deadline(deadline: Instant, mode: FormatMode) -> RoomResult<()> {
    if Instant::now() >= deadline {
        Err(preparation_timeout(mode))
    } else {
        Ok(())
    }
}
pub(super) fn preparation_timeout(mode: FormatMode) -> RoomError {
    if mode == FormatMode::Native {
        RoomError::new(
            "native_source_preparation_timeout",
            "原生歌曲准备超时，操作未提交，请重试",
        )
    } else {
        RoomError::new(
            "room_preparation_timeout",
            "歌曲准备超时，操作未提交，请重试",
        )
    }
}

pub(super) fn native_decode_error(error: vmusic_core::AudioError) -> RoomError {
    // Never expose decoder I/O details, source paths or signed upstream URLs.
    let detail = match error {
        vmusic_core::AudioError::DecodeFailed(detail)
        | vmusic_core::AudioError::UnsupportedFormat(detail) => detail,
        _ => return RoomError::new("native_source_decode_failed", "此歌曲无法通过原生解码验证"),
    };
    let reason = detail.split([':', ' ']).next().unwrap_or("");
    for (code, message) in [
        (
            "native_source_rate_unsupported",
            "此歌曲的实际采样率不支持原生传输",
        ),
        (
            "native_source_layout_unsupported",
            "原生传输仅支持明确的单声道或双声道布局",
        ),
        (
            "native_source_nonfinite_samples",
            "歌曲解码数据包含无效样本",
        ),
        (
            "native_source_timeline_unverified",
            "歌曲解码帧与容器时间线无法可靠对应",
        ),
        ("native_source_empty", "歌曲没有可播放的音频帧"),
        ("native_source_incomplete", "歌曲下载不完整或已中断"),
        ("native_source_unreadable", "歌曲文件不可读，请检查本地资源"),
        (
            "native_source_preparation_timeout",
            "原生歌曲准备超时，操作未提交，请重试",
        ),
        ("native_source_cancelled", "歌曲准备已取消"),
        (
            "native_source_decoded_block_too_large",
            "歌曲解码块超过原生资源限额",
        ),
        (
            "native_pcm_budget_exceeded",
            "原生歌曲缓冲额度已满，请稍后重试",
        ),
        ("native_pcm_budget_mismatch", "歌曲缓冲与当前房间不匹配"),
    ] {
        if reason == code {
            return RoomError::new(code, message);
        }
    }
    RoomError::new("native_source_decode_failed", "此歌曲无法通过原生解码验证")
}

pub(super) async fn await_prepared(
    mut worker: tokio::task::JoinHandle<Result<PreparedMedia, vmusic_core::AudioError>>,
    stop: &Arc<AtomicBool>,
    deadline: Instant,
    mode: FormatMode,
) -> RoomResult<PreparedMedia> {
    match tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), &mut worker).await {
        Ok(result) if Instant::now() >= deadline => {
            stop.store(true, Ordering::Release);
            drop(result);
            Err(preparation_timeout(mode))
        }
        Ok(result) => result
            .map_err(|_| RoomError::new("room_online_decode", "歌曲准备失败"))?
            .map_err(|error| {
                if mode == FormatMode::Native {
                    native_decode_error(error)
                } else {
                    RoomError::new("room_online_decode", "在线歌曲格式无法解码")
                }
            }),
        Err(_) => {
            stop.store(true, Ordering::Release);
            // Tokio can cancel a blocking job that has not begun yet. A job
            // already reading observes the same stop flag at its input wait.
            worker.abort();
            // HTTP source waits poll this stop at most every 250 ms. Keep the
            // handle until cleanup completes rather than only dropping a future.
            let _ = tokio::time::timeout(Duration::from_millis(500), worker).await;
            Err(preparation_timeout(mode))
        }
    }
}
struct LeasedSource {
    inner: Box<dyn vmusic_core::AudioSource>,
    _session: Arc<Session>,
    stop: Arc<AtomicBool>,
}
impl LeasedSource {
    fn result<T>(&self, result: std::io::Result<T>) -> std::io::Result<T> {
        if self.stop.load(Ordering::Relaxed) {
            Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "source cancelled",
            ))
        } else {
            result
        }
    }
}
impl Read for LeasedSource {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if self.stop.load(Ordering::Relaxed) {
            return self.result(Ok(0));
        }
        let result = self.inner.read(bytes);
        self.result(result)
    }
}
impl Seek for LeasedSource {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        if self.stop.load(Ordering::Relaxed) {
            return self.result(Ok(0));
        }
        let result = self.inner.seek(position);
        self.result(result)
    }
}
impl vmusic_core::AudioSource for LeasedSource {
    fn media_len(&self) -> Option<u64> {
        self.inner.media_len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use std::{
        sync::atomic::AtomicUsize,
        time::{Duration, Instant},
    };
    use vmusic_core::AudioBackend;

    fn song() -> OnlineSong {
        OnlineSong {
            source: "ccmixter".into(),
            id: "room-slow-source".into(),
            title: "Slow source".into(),
            artist: None,
            album: None,
            duration_ms: Some(120_000),
            cover: None,
            track_ref: serde_json::json!({}),
        }
    }
    fn wave() -> Vec<u8> {
        wave_at(8_000)
    }
    fn wave_at(rate: u32) -> Vec<u8> {
        let size = rate * 2 * 120;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&size.to_le_bytes());
        for frame in 0..size / 2 {
            let sample = if frame < size / 4 { 4096i16 } else { -4096i16 };
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }
    async fn server(
        first_bytes: usize,
    ) -> (
        String,
        Arc<tokio::sync::Semaphore>,
        Arc<AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        server_with_wave(first_bytes, wave()).await
    }

    async fn server_with_wave(
        first_bytes: usize,
        bytes: Vec<u8>,
    ) -> (
        String,
        Arc<tokio::sync::Semaphore>,
        Arc<AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let hits = Arc::new(AtomicUsize::new(0));
        let bytes = Arc::new(bytes);
        let app = axum::Router::new().route(
            "/song",
            axum::routing::get({
                let gate = gate.clone();
                let hits = hits.clone();
                let bytes = bytes.clone();
                move || {
                    let gate = gate.clone();
                    let hits = hits.clone();
                    let bytes = bytes.clone();
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        let total = bytes.len();
                        let head = axum::body::Bytes::copy_from_slice(&bytes[..first_bytes]);
                        let tail = axum::body::Bytes::copy_from_slice(&bytes[first_bytes..]);
                        let stream =
                            futures::stream::once(async move { Ok::<_, std::io::Error>(head) })
                                .chain(futures::stream::once(async move {
                                    let _permit = gate.acquire().await.unwrap();
                                    Ok::<_, std::io::Error>(tail)
                                }));
                        axum::response::Response::builder()
                            .header("content-type", "audio/wav")
                            .header("content-length", total)
                            .body(axum::body::Body::from_stream(stream))
                            .unwrap()
                    }
                }
            }),
        );
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = socket.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(socket, app).await.unwrap();
        });
        (format!("http://{address}/song"), gate, hits, task)
    }
    fn info(url: String) -> online::StreamInfo {
        online::StreamInfo {
            url,
            source: "ccmixter".into(),
            id: song().id,
            bitrate: None,
            expires_in_secs: None,
            fallbacks: vec![],
            rg_gain_db: None,
            rg_peak: None,
        }
    }
    async fn state() -> (Arc<AppState>, std::thread::JoinHandle<()>, PathBuf) {
        let (mut state, thread) = crate::state::tests::playback_state().await;
        state.data_dir =
            std::env::temp_dir().join(format!("hertz-room-online-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(state.online_cache_dir())
            .await
            .unwrap();
        state.cache_index =
            Arc::new(online::cache::CacheIndex::load(state.online_cache_dir()).await);
        let dir = state.data_dir.clone();
        (Arc::new(state), thread, dir)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cold_source_renders_before_download_finishes_coalesces_and_protects_cache() {
        let (state, audio, dir) = state().await;
        let (url, gate, hits, server) = server(96 * 1024).await;
        let sources = OnlineSources::default();
        let song = song();
        let started = Instant::now();
        let media = tokio::time::timeout(
            Duration::from_secs(3),
            sources.prepare_with(&state, &song, 0, |_| async { Ok(info(url)) }),
        )
        .await
        .expect("startup must not wait for the gated song tail")
        .unwrap();
        let other = sources
            .prepare_with(&state, &song, 0, |_| async {
                panic!("same-song seek/successor must share the download")
            })
            .await
            .unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert_eq!(
            state.cache_index.stats().files,
            0,
            "download remains incomplete"
        );
        assert_eq!(
            state.cache_index.clear(&[], None).await.unwrap(),
            0,
            "active .part is leased"
        );
        let mut renderer = vmusic_audio::RenderCore::new(vmusic_audio::RenderFormat {
            sample_rate: 48000,
            channels: 2,
        })
        .unwrap();
        renderer.load_prepared(media).unwrap();
        renderer.play().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while renderer.buffered_frames() < 9600 {
            assert!(
                Instant::now() < deadline,
                "progressive decoder did not deliver PCM"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut samples = vec![0.0; 9600];
        // The realtime callback deliberately returns silence on contention.
        // Observe actual audio across callbacks, just as the output device does.
        loop {
            renderer.render(&mut samples);
            if samples.iter().any(|sample| sample.abs() > 0.01) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "real audio reaches the room renderer"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let clock = vmusic_lan::clock::MonotonicClock::default();
        let (producer, mut events) =
            super::super::producer::Producer::spawn(clock.clone()).unwrap();
        use vmusic_lan::protocol::{AudioFormat, Counter, Plan};
        producer
            .prepare(
                Plan {
                    epoch: Counter(1),
                    plan_id: Counter(1),
                    anchor_ns: Counter(clock.now_ns() + 1_000_000_000),
                    join_frame: Counter(0),
                    format: AudioFormat {
                        id: 1,
                        sample_rate: 48000,
                        channels: 2,
                    },
                },
                Some(super::super::producer::Source {
                    path: PathBuf::new(),
                    media: Some(other),
                    instance: 1,
                    position_ms: 0,
                    track_gain_db: 0.0,
                }),
                Default::default(),
                1.0,
            )
            .unwrap();
        producer.next(1, None, 0).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match events.recv().await.unwrap() {
                    super::super::producer::ProducerEvent::Pcm { samples, .. }
                        if samples.iter().any(|s| s.abs() > 0.01) =>
                    {
                        break
                    }
                    super::super::producer::ProducerEvent::Error { message, .. } => {
                        panic!("room producer failed: {message}")
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("room PCM must precede completion of the download");
        tokio::time::timeout(Duration::from_secs(2), producer.shutdown())
            .await
            .expect("stopping a stalled decoder must interrupt its input");
        eprintln!(
            "cold room source: audible PCM after {:?}; tail still gated; {} HTTP request",
            started.elapsed(),
            hits.load(Ordering::SeqCst)
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(150),
                sources.prepare_with(&state, &song, 90_000, |_| async {
                    panic!("seek must reuse the active download")
                })
            )
            .await
            .is_err(),
            "seeking beyond the available prefix waits in preparation"
        );
        gate.add_permits(1);
        let deadline = Instant::now() + Duration::from_secs(3);
        while state.cache_index.stats().files == 0 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            state.cache_index.clear(&[], None).await.unwrap(),
            0,
            "completed cache remains protected while decoded or prepared"
        );
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::task::spawn_blocking(move || drop(renderer)),
        )
        .await
        .unwrap()
        .unwrap();
        let fresh = OnlineSources::default();
        let cached = fresh
            .prepare_with(&state, &song, 90_000, |_| async {
                panic!("complete cache must not resolve again")
            })
            .await
            .unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let mut positioned = vmusic_audio::RenderCore::new(vmusic_audio::RenderFormat {
            sample_rate: 48000,
            channels: 2,
        })
        .unwrap();
        positioned.load_prepared(cached).unwrap();
        assert_eq!(positioned.position_frames(), 90 * 48000);
        positioned.play().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            positioned.render(&mut samples);
            if samples.iter().any(|sample| *sample < -0.01) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "prepared seek must render the requested tail, not the start"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        drop(positioned);
        assert!(
            state.cache_index.clear(&[], None).await.unwrap() > 0,
            "final decoder releases the cache lease"
        );
        server.abort();
        drop(state);
        audio.join().unwrap();
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cancelling_startup_releases_the_download_and_part_file() {
        let (state, audio, dir) = state().await;
        let (url, _gate, hits, server) = server(32 * 1024).await;
        let sources = OnlineSources::default();
        let song = song();
        assert!(tokio::time::timeout(
            Duration::from_millis(300),
            sources.prepare_with(&state, &song, 0, |_| async { Ok(info(url)) })
        )
        .await
        .is_err());
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let empty = sources
                .0
                .lock()
                .await
                .values()
                .all(|entry| entry.strong_count() == 0);
            let mut files = tokio::fs::read_dir(state.online_cache_dir()).await.unwrap();
            if empty && files.next_entry().await.unwrap().is_none() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "cancelled source left a download or .part behind"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        server.abort();
        drop(state);
        audio.join().unwrap();
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[test]
    fn native_decode_errors_expose_reason_without_private_decoder_details() {
        let error = native_decode_error(vmusic_core::AudioError::DecodeFailed("native_source_timeline_unverified: https://signed.invalid/song?secret=token D:/private/song".into()));
        assert_eq!(error.code, "native_source_timeline_unverified");
        assert!(!error.message.contains("signed.invalid"));
        assert!(!error.message.contains("private"));
        let error = native_decode_error(vmusic_core::AudioError::DecodeFailed(
            "https://signed.invalid/song?secret=token".into(),
        ));
        assert_eq!(error.code, "native_source_decode_failed");
        assert!(!error.message.contains("secret"));
        let error = native_decode_error(vmusic_core::AudioError::DecodeFailed(
            "read failed at https://signed.invalid/native_source_empty?secret=token".into(),
        ));
        assert_eq!(error.code, "native_source_decode_failed");
    }

    #[test]
    fn cancelled_preparation_removes_a_queued_blocking_job_and_releases_its_input() {
        struct InputLease(Arc<AtomicBool>);
        impl Drop for InputLease {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (release, wait) = std::sync::mpsc::channel();
            let (entered, ready) = tokio::sync::oneshot::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                let _ = entered.send(());
                wait.recv().unwrap();
            });
            ready.await.unwrap();
            let dropped = Arc::new(AtomicBool::new(false));
            let called = Arc::new(AtomicBool::new(false));
            let input = InputLease(dropped.clone());
            let stop = Arc::new(AtomicBool::new(false));
            let mut guard =
                PreparationGuard::new(stop.clone(), Instant::now() + Duration::from_secs(2));
            let input = guard.hold_input(input);
            let worker_called = called.clone();
            let worker = tokio::task::spawn_blocking(move || {
                let _input = input.lock().unwrap().take();
                worker_called.store(true, Ordering::Release);
                Err::<PreparedMedia, _>(vmusic_core::AudioError::Other(
                    "unused queued fixture".into(),
                ))
            });
            guard.arm_worker(&worker);
            drop(guard);
            assert!(
                dropped.load(Ordering::Acquire),
                "queued input must release before the pool runs it"
            );
            let ended = tokio::time::timeout(Duration::from_millis(500), worker).await;
            release.send(()).unwrap();
            blocker.await.unwrap();
            // Aborted Tokio blocking tasks finish their task bookkeeping when
            // the pool services them; the input has already been released.
            if let Ok(result) = ended {
                assert!(result.unwrap_err().is_cancelled());
            }
            assert!(stop.load(Ordering::Acquire));
            assert!(dropped.load(Ordering::Acquire));
            assert!(!called.load(Ordering::Acquire));
        });
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn native_online_qualification_keeps_one_download_and_cleans_a_stopped_seek_worker() {
        let (state, audio, dir) = state().await;
        let (url, gate, hits, server) = server_with_wave(384 * 1024, wave_at(48_000)).await;
        let sources = OnlineSources::default();
        let mut song = song();
        // Keep the Standard-available provider and exercise absent online
        // duration metadata. The downloader retains its requested cache tier
        // when it cannot measure bitrate; native qualification still reads the
        // WAV's real 48 kHz format and exact 120-second timeline.
        song.duration_ms = None;
        let budget = NativePcmBudget::default();
        let media = sources
            .prepare_with_configured(
                &state,
                &song,
                0,
                FormatMode::Native,
                budget.clone(),
                Instant::now() + Duration::from_secs(3),
                |_| async { Ok(info(url)) },
            )
            .await
            .unwrap();
        assert_eq!(media.decoded_format().unwrap().sample_rate, 48_000);
        assert_eq!(media.declared_info().sample_rate, Some(48_000));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert_eq!(state.cache_index.stats().files, 0);
        let initial_usage = budget.usage();
        let started = Instant::now();
        let error = sources
            .prepare_with_configured(
                &state,
                &song,
                90_000,
                FormatMode::Native,
                budget.clone(),
                Instant::now() + Duration::from_millis(100),
                |_| async { panic!("native seek reuses the same download") },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "native_source_preparation_timeout");
        assert!(started.elapsed() < Duration::from_millis(750));
        assert_eq!(budget.usage(), initial_usage);
        let cleanup = Instant::now() + Duration::from_secs(1);
        loop {
            let remaining: usize = sources
                .0
                .lock()
                .await
                .values()
                .map(Weak::strong_count)
                .sum();
            if remaining == 1 {
                break;
            }
            assert!(
                Instant::now() < cleanup,
                "cancelled blocking seek still owns its cache session"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert_eq!(state.cache_index.clear(&[], None).await.unwrap(), 0);
        gate.add_permits(1);
        let deadline = Instant::now() + Duration::from_secs(5);
        while state.cache_index.stats().files == 0 {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let fresh = OnlineSources::default();
        let tail = fresh
            .prepare_with_configured(
                &state,
                &song,
                119_990,
                FormatMode::Native,
                budget.clone(),
                Instant::now() + Duration::from_secs(3),
                |_| async { panic!("successful native cache needs no new upstream resolution") },
            )
            .await
            .unwrap();
        let mut renderer = vmusic_audio::RenderCore::new_native(
            vmusic_audio::RenderFormat {
                sample_rate: 48_000,
                channels: 2,
            },
            budget.clone(),
        )
        .unwrap();
        renderer.load_prepared(tail).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !renderer.decoded_eof() {
            assert!(Instant::now() < deadline);
            assert!(!renderer.take_decode_failure());
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(renderer.buffered_frames(), 480);
        drop(renderer);
        drop(media);
        assert_eq!(budget.usage(), Default::default());
        assert!(state.cache_index.clear(&[], None).await.unwrap() > 0);
        server.abort();
        drop(state);
        audio.join().unwrap();
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn native_online_rejected_rate_drops_lease_and_does_not_renew_total_deadline() {
        let (state, audio, dir) = state().await;
        let (url, _gate, hits, server) = server(96 * 1024).await;
        let sources = OnlineSources::default();
        let song = song();
        let budget = NativePcmBudget::default();
        let error = sources
            .prepare_with_configured(
                &state,
                &song,
                0,
                FormatMode::Native,
                budget.clone(),
                Instant::now() + Duration::from_secs(3),
                |_| async { Ok(info(url)) },
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error.code.as_str(),
            "native_source_rate_unsupported" | "native_source_timeline_unverified"
        ));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert_eq!(budget.usage(), Default::default());
        let deadline = Instant::now() + Duration::from_secs(2);
        while sources
            .0
            .lock()
            .await
            .values()
            .any(|entry| entry.strong_count() != 0)
        {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let started = Instant::now();
        let error = sources
            .prepare_with_configured(
                &state,
                &song,
                0,
                FormatMode::Native,
                budget,
                Instant::now() + Duration::from_millis(100),
                |_| async {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    panic!("resolution must stop at the original deadline")
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "native_source_preparation_timeout");
        assert!(started.elapsed() < Duration::from_millis(500));
        server.abort();
        drop(state);
        audio.join().unwrap();
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
