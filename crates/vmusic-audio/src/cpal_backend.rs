// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Real playback backend: symphonia decodes, cpal plays, rustfft listens.
//!
//! # Thread layout
//!
//! ```text
//!   current/next decoders ──push──► per-deck PCM queues ──mix──► cpal callback
//!                                                                          │
//!                                                                          └──► tap ──► FFT (called by the actor)
//! ```
//!
//! Three rules keep this safe:
//!
//! 1. The cpal callback never allocates, never locks for long and never blocks.
//! 2. The decoder thread decodes outside the lock and pushes in whole chunks.
//! 3. The FFT runs on the actor thread, never inside the audio callback.
//!
//! Resampling is linear interpolation. It is not the sinc/FIR resampler a
//! Hi-Fi player would use, but it keeps the first version dependency-light and
//! the code auditable; the [`AudioBackend`] trait is the seam where a better
//! one gets dropped in later.

use std::collections::VecDeque;
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, SupportedStreamConfig};
use num_complex::Complex;
use rustfft::FftPlanner;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;
use vmusic_core::{
    AudioBackend, AudioError, AudioSource, DeviceInfo, MediaInfo, NextEvent, NextTrack,
    PrepareResult,
};

/// Number of mono samples kept for spectrum analysis.
const FFT_SIZE: usize = 2048;
/// How much decoded audio we buffer ahead (seconds).
const BUFFER_SECONDS: f32 = 12.0;
/// Keep every Nth frame in the tap; 4 keeps the tap useful at 48 kHz.
const TAP_STRIDE: usize = 3;
const TAP_LEN: usize = FFT_SIZE * 3;
/// 开播 / 换装后的淡入时长。
const FADE_IN_MS: u64 = 250;
/// 暂停 / 停止 / 切歌时的淡出时长。
const FADE_OUT_MS: u64 = 200;
/// No prepared successor: retain the short tail fade used by sequential playback.
const TAIL_FADE_MS: u64 = 500;
/// EQ 频段中心频率（Hz）。六段峰化滤波，覆盖低频架到高频齿音的常用调节。
pub const EQ_BANDS: [f32; 6] = [60.0, 150.0, 400.0, 1000.0, 2400.0, 6000.0];

/// Each decoder owns its own queue and source clock. The output callback alone
/// promotes the prepared deck, so a boundary can occur inside an output block.
/// macOS 的 std `Mutex` 是 `OnceBox<pthread_mutex_t>`：OS 级互斥量要等**第一次加锁**
/// 才 `Box::pin` 到堆上（arm64 上一个 64 字节块，之后不再释放）。于是「回调第一次碰
/// 哪个锁」就变成「回调在那个线程上动一次堆」——正是本文件规则 1 要挡的东西，也解释了
/// 为什么零分配断言只在 macos 格红（Linux 走 futex、Windows 走 SRWLOCK，都是内联的）。
/// 构造时各上一次，把这笔一次性分配留在 actor 线程。
fn prime<T>(lock: &Mutex<T>) {
    drop(lock.lock().unwrap());
}

struct Deck {
    samples: Mutex<VecDeque<f32>>,
    frames_played: AtomicU64,
    decode_error: AtomicBool,
    eof: AtomicBool,
}

impl Deck {
    fn new() -> Self {
        let deck = Self {
            samples: Mutex::new(VecDeque::with_capacity(1 << 16)),
            frames_played: AtomicU64::new(0),
            decode_error: AtomicBool::new(false),
            eof: AtomicBool::new(false),
        };
        prime(&deck.samples);
        deck
    }

    fn flag_decode_error(&self) {
        self.decode_error.store(true, Ordering::Release);
    }
}

struct PreparedDeck {
    deck: Arc<Deck>,
    request: NextTrack,
    info: MediaInfo,
    gapless_supported: bool,
    overlap_frames: Option<u64>,
    mixed_frames: u64,
}

enum BypassReason {
    DecodeFailed,
    NotReady,
}

/// The callback moves already allocated metadata here. Human-readable messages
/// are built only when the actor consumes the event.
enum RenderEvent {
    Transitioned {
        request: NextTrack,
        info: MediaInfo,
        gapless_supported: bool,
        retired: Arc<Deck>,
    },
    Bypassed {
        prepared: PreparedDeck,
        reason: BypassReason,
    },
}

/// Output settings are shared by both decks; transport fades are independent
/// of the track overlap envelope.
struct Shared {
    // The callback takes this with try_lock; actor readers clone briefly. This
    // avoids ArcSwap's first-use thread-local allocation on the audio thread.
    deck: Mutex<Arc<Deck>>,
    next: Mutex<Option<PreparedDeck>>,
    next_event: Mutex<Option<RenderEvent>>,
    tap: Mutex<VecDeque<f32>>,
    volume: AtomicU32,
    playing: AtomicBool,
    /// 增益斜坡（单位：设备声道帧）。fade_frames=0 表示无斜坡，增益恒为 fade_gain。
    fade_gain: AtomicU32,
    fade_from: AtomicU32,
    fade_to: AtomicU32,
    fade_frames: AtomicU64,
    fade_done: AtomicU64,
    /// 解码线程异常早夭标志：仅在「非干净 EOF、非主动 stop」的退出时置位，
    /// actor 经 take_decode_failure 每 tick 取走（换装淡出窗口除外）。
    /// DSP：EQ 增益（dB bits × 6）与合成增益（preamp+track，dB bits）。
    eq_gains: [AtomicU32; 6],
    dsp_gain_db: AtomicU32,
    device_rate: AtomicU32,
    /// Requested overlap, also used for the unprepared sequential tail fallback.
    crossfade_ms: AtomicU64,
    /// 回调线程持有的双二阶滤波器组（含各声道状态）。try_lock 拿不到就跳过
    /// 本轮回调的 EQ——丢一段滤波远好过音频线程阻塞。
    filters: Mutex<Option<EqBank>>,
}

impl Shared {
    fn new() -> Self {
        let shared = Self {
            deck: Mutex::new(Arc::new(Deck::new())),
            next: Mutex::new(None),
            next_event: Mutex::new(None),
            tap: Mutex::new(VecDeque::with_capacity(TAP_LEN)),
            volume: AtomicU32::new(1.0f32.to_bits()),
            playing: AtomicBool::new(false),
            fade_gain: AtomicU32::new(1.0f32.to_bits()),
            fade_from: AtomicU32::new(1.0f32.to_bits()),
            fade_to: AtomicU32::new(1.0f32.to_bits()),
            fade_frames: AtomicU64::new(0),
            fade_done: AtomicU64::new(0),
            eq_gains: [
                AtomicU32::new(0.0f32.to_bits()),
                AtomicU32::new(0.0f32.to_bits()),
                AtomicU32::new(0.0f32.to_bits()),
                AtomicU32::new(0.0f32.to_bits()),
                AtomicU32::new(0.0f32.to_bits()),
                AtomicU32::new(0.0f32.to_bits()),
            ],
            dsp_gain_db: AtomicU32::new(0.0f32.to_bits()),
            device_rate: AtomicU32::new(48_000),
            crossfade_ms: AtomicU64::new(0),
            filters: Mutex::new(None),
        };
        // 回调会 try_lock 的锁，一把都不留地先暖过（含 current deck 的 samples，已在
        // Deck::new 里暖过）。
        prime(&shared.deck);
        prime(&shared.next);
        prime(&shared.next_event);
        prime(&shared.tap);
        prime(&shared.filters);
        shared
    }

    /// Actor/decoder setup access only. The output callback uses try_lock.
    fn current_deck(&self) -> Arc<Deck> {
        self.deck.lock().unwrap().clone()
    }

    /// 每帧增益的纯函数（便于单测）。
    fn ramp_value(from: f32, to: f32, total: u64, done: u64) -> f32 {
        if total == 0 {
            return to;
        }
        let t = (done as f32 / total as f32).clamp(0.0, 1.0);
        from + (to - from) * t
    }

    /// 从当前增益出发，装一条到 `to` 的线性斜坡（`ms` 毫秒，按设备采样率折算帧数）。
    fn arm_fade(&self, to: f32, ms: u64, rate: u32) {
        let from = f32::from_bits(self.fade_gain.load(Ordering::Relaxed));
        let frames = (ms as u128 * rate as u128 / 1000) as u64;
        self.fade_from.store(from.to_bits(), Ordering::Relaxed);
        self.fade_to.store(to.to_bits(), Ordering::Relaxed);
        self.fade_frames.store(frames, Ordering::Relaxed);
        self.fade_done.store(0, Ordering::Relaxed);
    }

    fn fade_active(&self) -> bool {
        self.fade_frames.load(Ordering::Relaxed) > 0
    }

    /// 解码线程异常早夭时置位（干净 EOF / 主动 stop 不调）。
    fn flag_decode_error(&self) {
        self.current_deck().flag_decode_error();
    }

    /// 取走并清零早夭标志；没有早夭返回 false。
    fn take_decode_error(&self) -> bool {
        self.current_deck()
            .decode_error
            .swap(false, Ordering::AcqRel)
    }

    /// 换装/新曲复位：增益归 0（静音），清掉一切斜坡。
    ///
    /// 换装之后要么立即 arm 一条 0→1 淡入，要么保持暂停（playing=false，
    /// 回调整体输出 0）——两条路都要求起点是静音，而不是 1：若归 1，随后的
    /// `arm_fade(1.0, …)` 会变成 1→1 常量斜坡，淡入名存实亡。
    fn reset_fade_shared(&self) {
        self.fade_gain.store(0.0f32.to_bits(), Ordering::Relaxed);
        self.fade_from.store(0.0f32.to_bits(), Ordering::Relaxed);
        self.fade_to.store(0.0f32.to_bits(), Ordering::Relaxed);
        self.fade_frames.store(0, Ordering::Relaxed);
        self.fade_done.store(0, Ordering::Relaxed);
    }
}

/// 解码线程的控制句柄。
///
/// `seek_to` 的三处 `.lock().unwrap()` 保留：临界区只有 `Some(..)` 赋值与 `take()`，
/// 不存在能 panic 的操作，锁不会中毒；而 `seek` 的错误类型是 `AudioError`，也没必要
/// 把「不可能发生的毒化」映射成一次「解码失败」去误导上层。
struct DecoderCtl {
    stop: Arc<AtomicBool>,
    /// `Some(ms)` means "seek here as soon as you can".
    seek_to: Arc<Mutex<Option<SeekRequest>>>,
}

impl DecoderCtl {
    fn seek(
        &self,
        handle: &JoinHandle<()>,
        position_ms: u64,
        timeout: std::time::Duration,
    ) -> Result<(), AudioError> {
        if handle.is_finished() {
            return Err(AudioError::DecodeFailed("decoder is not running".into()));
        }
        let (reply, result) = std::sync::mpsc::channel();
        *self.seek_to.lock().unwrap() = Some(SeekRequest { position_ms, reply });
        let started = std::time::Instant::now();
        loop {
            match result.recv_timeout(std::time::Duration::from_millis(20)) {
                Ok(result) => return result,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) if !handle.is_finished() => {
                    if started.elapsed() >= timeout && self.seek_to.lock().unwrap().take().is_some()
                    {
                        return Err(AudioError::DecodeFailed(
                            "seek timed out before decoder accepted it".into(),
                        ));
                    }
                }
                Err(_) => {
                    self.seek_to.lock().unwrap().take();
                    return Err(AudioError::DecodeFailed(
                        "decoder stopped during seek".into(),
                    ));
                }
            }
        }
    }
}

struct SeekRequest {
    position_ms: u64,
    reply: std::sync::mpsc::Sender<Result<(), AudioError>>,
}

/// 换装的"半完成态"：probe 已做完，等旧源淡出到 0 再由 maintain 换。
struct PendingLoad {
    opened: OpenedReader,
    info: MediaInfo,
    /// 换装完成后是否进入播放态（暂停/停止意图可能在淡出期间到达）。
    play_after: bool,
}

pub struct CpalBackend {
    shared: Arc<Shared>,
    device: Option<Device>,
    config: Option<SupportedStreamConfig>,
    stream: Option<Stream>,
    decoder: Option<(JoinHandle<()>, DecoderCtl)>,
    next_decoder: Option<(JoinHandle<()>, DecoderCtl)>,
    device_rate: u32,
    device_channels: u16,
    duration_ms: Option<u64>,
    source_rate: Option<u32>,
    gapless_supported: bool,
    fft: Arc<dyn rustfft::Fft<f32>>,
    spectrum_state: Mutex<Vec<f32>>,
    /// 暂停淡出到 0 的瞬间才真正置 playing=false。
    pending_pause: bool,
    /// 停止淡出到 0 的瞬间才 seek 回 0 复位。
    pending_stop: bool,
    stop_error: Option<String>,
    transport_error: Option<AudioError>,
    /// 自然尾部淡出是否已武装（seek 回主体段后可重新武装）。
    tail_armed: bool,
    /// 等旧源淡出完成后换装的新源。
    pending_load: Option<PendingLoad>,
}

impl CpalBackend {
    pub fn new() -> Result<Self, AudioError> {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);

        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| AudioError::DeviceUnavailable("no default output device".into()))?;
        let config = pick_config(&device)?;
        let device_rate = config.sample_rate().0;
        let device_channels = config.channels();

        Ok(Self {
            shared: Arc::new(Shared::new()),
            device: Some(device),
            config: Some(config),
            stream: None,
            decoder: None,
            next_decoder: None,
            device_rate,
            device_channels,
            duration_ms: None,
            source_rate: None,
            gapless_supported: false,
            fft,
            spectrum_state: Mutex::new(Vec::new()),
            pending_pause: false,
            pending_stop: false,
            stop_error: None,
            transport_error: None,
            tail_armed: false,
            pending_load: None,
        })
    }

    /// DSP 上下文（采样率/滤波器组）跟随设备重建；换设备后 EQ 系数必须
    /// 按新采样率重算。
    fn sync_dsp_context(&mut self) {
        self.shared
            .device_rate
            .store(self.device_rate, Ordering::Relaxed);
        let gains = std::array::from_fn(|i| {
            f32::from_bits(self.shared.eq_gains[i].load(Ordering::Relaxed))
        });
        if let Ok(mut filters) = self.shared.filters.lock() {
            if !filters.as_ref().is_some_and(|bank| {
                bank.matches(self.device_rate, &gains, self.device_channels as usize)
            }) {
                *filters = Some(EqBank::new(
                    self.device_rate,
                    gains,
                    self.device_channels as usize,
                ));
            }
        }
    }

    fn ensure_stream(&mut self) -> Result<(), AudioError> {
        self.sync_dsp_context();
        if self.stream.is_some() {
            return Ok(());
        }
        let device = self.device.as_ref().ok_or_else(no_device)?;
        let config = self.config.as_ref().ok_or_else(no_device)?;
        let shared = self.shared.clone();
        let channels = config.channels().max(1) as usize;

        let stream = device
            .build_output_stream(
                &config.config(),
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    write_samples(data, &shared, channels);
                },
                |err| tracing::warn!("audio output error: {err}"),
                None,
            )
            .map_err(|e| AudioError::BackendInit(e.to_string()))?;

        stream
            .play()
            .map_err(|e| AudioError::BackendInit(e.to_string()))?;
        self.stream = Some(stream);
        Ok(())
    }

    fn stop_decoder(&mut self) {
        if let Some((handle, ctl)) = self.decoder.take() {
            ctl.stop.store(true, Ordering::Relaxed);
            let _ = handle.join();
        }
    }

    fn clear_buffers(&self) {
        if let Ok(mut q) = self.shared.current_deck().samples.lock() {
            q.clear();
        }
        if let Ok(mut t) = self.shared.tap.lock() {
            t.clear();
        }
    }

    /// 立即换装（暂停/停止态）或新曲复位时调用：增益归 0、尾部门闩与
    /// pending 标志全部清掉。pending_load 不在此清：换装路径自己决定存不存。
    fn reset_fade(&mut self) {
        self.shared.reset_fade_shared();
        self.tail_armed = false;
        self.pending_pause = false;
        self.pending_stop = false;
    }

    /// 起一个解码线程消费 `opened`。立即换装与 pending 换装共用。
    fn spawn_now(&mut self, opened: OpenedReader) -> Result<(), AudioError> {
        self.gapless_supported = opened.gapless_supported;
        self.shared
            .current_deck()
            .eof
            .store(false, Ordering::Release);
        let stop = Arc::new(AtomicBool::new(false));
        let seek_to = Arc::new(Mutex::new(None));
        let ctl = DecoderCtl {
            stop: stop.clone(),
            seek_to: seek_to.clone(),
        };
        let shared = self.shared.current_deck();
        let device_rate = self.device_rate;
        let device_channels = self.device_channels.max(1) as usize;
        let handle = std::thread::Builder::new()
            .name("vmusic-decoder".into())
            .spawn(move || {
                decode_loop_opened(opened, shared, stop, seek_to, device_rate, device_channels);
            })
            .map_err(|e| AudioError::BackendInit(e.to_string()))?;
        self.decoder = Some((handle, ctl));
        self.stop_error = None;
        self.transport_error = None;
        Ok(())
    }

    fn prepare_opened(
        &mut self,
        opened: OpenedReader,
        info: MediaInfo,
        request: NextTrack,
    ) -> Result<PrepareResult, AudioError> {
        self.clear_next();
        if matches!(
            *self.shared.next_event.lock().unwrap(),
            Some(RenderEvent::Transitioned { .. })
        ) {
            return Ok(PrepareResult::Bypassed {
                reason: "previous transition is awaiting its actor commit".into(),
            });
        }
        if self.pending_load.is_some() || self.pending_stop || self.tail_armed {
            return Ok(PrepareResult::Bypassed {
                reason: "source is already changing or fading out".into(),
            });
        }
        if request.crossfade_ms == 0
            && (self.source_rate != Some(self.device_rate)
                || info.sample_rate != Some(self.device_rate))
        {
            return Ok(PrepareResult::Bypassed {
                reason: "sample-exact gapless requires both sources at the output sample rate"
                    .into(),
            });
        }
        if request.crossfade_ms == 0 && !(self.gapless_supported && opened.gapless_supported) {
            return Ok(PrepareResult::Bypassed {
                reason:
                    "sample-exact gapless requires verified delay/padding handling for both sources"
                        .into(),
            });
        }
        let gapless_supported = opened.gapless_supported;
        let deck = Arc::new(Deck::new());
        let stop = Arc::new(AtomicBool::new(false));
        let seek_to = Arc::new(Mutex::new(None));
        let ctl = DecoderCtl {
            stop: stop.clone(),
            seek_to: seek_to.clone(),
        };
        let worker_deck = deck.clone();
        let rate = self.device_rate;
        let channels = self.device_channels.max(1) as usize;
        let handle = std::thread::Builder::new()
            .name("vmusic-next-decoder".into())
            .spawn(move || {
                decode_loop_opened(opened, worker_deck, stop, seek_to, rate, channels);
            })
            .map_err(|e| AudioError::BackendInit(e.to_string()))?;
        self.next_decoder = Some((handle, ctl));
        *self.shared.next.lock().unwrap() = Some(PreparedDeck {
            deck,
            request,
            info: info.clone(),
            gapless_supported,
            overlap_frames: None,
            mixed_frames: 0,
        });
        Ok(PrepareResult::Prepared(info))
    }

    /// 停止语义的复位动作：seek 回 0、清缓冲、进度归零（duration 保留）。
    fn do_stop_reset(&mut self) -> Result<(), AudioError> {
        self.shared.playing.store(false, Ordering::Relaxed);
        let result = if self.decoder.is_none() && self.pending_load.is_none() {
            Ok(())
        } else {
            self.seek(0)
        };
        self.stop_error = result.as_ref().err().map(ToString::to_string);
        if result.is_err() {
            self.pending_pause = false;
            self.pending_stop = false;
        }
        result
    }

    /// 淡出到 0 后的换装：停旧解码线程 → 清场 → 起新线程 → 复位斜坡，
    /// 再按 play_after 决定淡入播放还是保持暂停。
    fn spawn_pending(&mut self) {
        let Some(pending) = self.pending_load.take() else {
            return;
        };
        self.stop_decoder();
        self.clear_buffers();
        // 旧源可能在淡出窗口里已置下解码错误位：那是旧世界的事，清掉。
        // pending 期间 take_decode_failure 不消费该位，就等这里清；新解码
        // 器若也早夭，会再置一次并照常上报。
        let _ = self.shared.take_decode_error();
        self.shared
            .current_deck()
            .frames_played
            .store(0, Ordering::Relaxed);
        self.duration_ms = pending.info.duration_ms;
        self.source_rate = pending.info.sample_rate;
        let PendingLoad {
            opened,
            info,
            play_after,
        } = pending;
        let _ = info;
        // 线程创建失败绝不能 panic（这里在 actor 线程上）：置解码错误位，
        // 让上层经 DecodeError 收口而不是整个 actor 挂掉。
        if let Err(e) = self.spawn_now(opened) {
            tracing::error!("spawn pending decoder failed: {e}");
            self.shared.flag_decode_error();
        }
        self.tail_armed = false;
        self.shared.reset_fade_shared();
        if play_after {
            self.shared.arm_fade(1.0, FADE_IN_MS, self.device_rate);
            self.shared.playing.store(true, Ordering::Relaxed);
        } else {
            self.shared.playing.store(false, Ordering::Relaxed);
        }
    }

    /// probe 时长 → 起解码线程。`load`（本地文件）与 `load_source`（流式源）
    /// 两个入口共用，杜绝双份打开/探测逻辑。
    ///
    /// 正在播放时不立即换：probe 期间旧曲继续出声，probe 成功后武装 200ms
    /// 淡出，把新源放进 pending_load，由 maintain() 在增益到 0 的瞬间换装，
    /// 切歌不爆音；暂停/停止态则立即换装。
    fn open_and_spawn(
        &mut self,
        mss: MediaSourceStream,
        ext: Option<&str>,
    ) -> Result<MediaInfo, AudioError> {
        self.ensure_stream()?;
        let was_playing = self.shared.playing.load(Ordering::Relaxed);
        // 播放中且仍有可闻增益才需要「先淡出再换装」；暂停态、或尾段淡出
        // 已把增益压到 0（自然播完自动接下一首）则立即换装，避免两首之间
        // 凭空多等 200ms 死寂。
        let audible = was_playing
            && (self.shared.fade_active()
                || f32::from_bits(self.shared.fade_gain.load(Ordering::Relaxed)) > 0.001);
        let (opened, info) = open_media(mss, ext)?;
        let duration_ms = info.duration_ms;

        if audible {
            // 旧源先淡出 200ms，probe 期间旧曲继续出声；maintain 到点换装并
            // 淡入。淡出期间到达的暂停/停止意图优先：换装后保持暂停而非开播。
            let play_after = false;
            self.pending_pause = false;
            self.pending_stop = false;
            self.shared.arm_fade(0.0, FADE_OUT_MS, self.device_rate);
            self.pending_load = Some(PendingLoad {
                opened,
                info: info.clone(),
                play_after,
            });
            return Ok(info);
        }

        // 立即换装：暂停态保持暂停（playing 为 false）；尾段淡出后自动接歌
        // （playing 仍为 true）则装一条 0→1 淡入，让新曲渐强而不是爆入。
        self.shared.playing.store(false, Ordering::Relaxed);
        self.pending_load = None;
        self.stop_decoder();
        self.clear_buffers();
        let _ = self.shared.take_decode_error();
        self.shared
            .current_deck()
            .frames_played
            .store(0, Ordering::Relaxed);
        self.reset_fade();
        self.duration_ms = duration_ms;
        self.source_rate = info.sample_rate;
        // 解码线程创建失败不再让 load 报错：置解码错误位，actor 下一 tick
        // 经 DecodeError 事件收口（在线曲自动跳曲），状态仍按已加载发布。
        if let Err(e) = self.spawn_now(opened) {
            tracing::error!("spawn decoder failed: {e}");
            self.shared.flag_decode_error();
        }
        if was_playing {
            self.shared.arm_fade(1.0, FADE_IN_MS, self.device_rate);
        }
        Ok(info)
    }

    /// actor 线程每 20ms 调一次：推进淡出后的延迟动作与自然尾部淡出。
    fn maintain(&mut self) {
        let fading = self.shared.fade_active();

        if self.pending_pause && !fading {
            self.shared.playing.store(false, Ordering::Relaxed);
            self.pending_pause = false;
        }
        if self.pending_stop && !fading {
            // 先复位再摘标志：do_stop_reset() 内 seek(0) 靠 pending_stop
            // 走「停止复位不回淡」例外，顺序反了会在停止后补出一条 120ms
            // 回淡（停止后放声）。
            if let Err(error) = self.do_stop_reset() {
                self.transport_error = Some(error);
            }
            self.pending_stop = false;
        }
        if self.pending_load.is_some() && !fading {
            self.spawn_pending();
        }

        // 自然结束前的尾部淡出（仅武装一次；seek 回主体段后可重新武装）。
        // 斜坡进行中（暂停/切歌淡出或本段尾淡出）绝不能覆写斜坡参数。
        if self.shared.playing.load(Ordering::Relaxed)
            && self.pending_load.is_none()
            && self.shared.next.lock().unwrap().is_none()
            && !self.pending_stop
            && self.shared.current_deck().eof.load(Ordering::Acquire)
            && !self.shared.fade_active()
        {
            if let Ok(samples) = self.shared.current_deck().samples.lock() {
                let frames = (samples.len() / self.device_channels.max(1) as usize) as u64;
                let remain = frames_to_ms(frames, self.device_rate);
                let tail_ms = self.shared.crossfade_ms.load(Ordering::Relaxed);
                let tail_ms = if tail_ms == 0 { TAIL_FADE_MS } else { tail_ms };
                if !self.tail_armed && remain <= tail_ms && remain > 0 {
                    // 直接按剩余帧数装斜坡（不用 arm_fade 的固定毫秒），
                    // 保证增益恰好在最后一帧到 0。
                    let from = f32::from_bits(self.shared.fade_gain.load(Ordering::Relaxed));
                    self.shared
                        .fade_from
                        .store(from.to_bits(), Ordering::Relaxed);
                    self.shared
                        .fade_to
                        .store(0.0f32.to_bits(), Ordering::Relaxed);
                    self.shared
                        .fade_frames
                        .store(frames.max(1), Ordering::Relaxed);
                    self.shared.fade_done.store(0, Ordering::Relaxed);
                    self.tail_armed = true;
                }
            }
        }
    }
}

/// 一个双二阶节（RBJ cookbook peaking EQ）+ 一条声道的历史状态。
#[derive(Debug, Clone, Copy)]
struct BiQuad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl BiQuad {
    /// RBJ cookbook peaking EQ，系数已按 a0 归一化。
    fn peaking(center_hz: f32, gain_db: f32, q: f32, rate: u32) -> Self {
        if gain_db == 0.0 || center_hz >= rate.max(1) as f32 * 0.5 {
            return Self {
                b0: 1.0,
                b1: 0.0,
                b2: 0.0,
                a1: 0.0,
                a2: 0.0,
                x1: 0.0,
                x2: 0.0,
                y1: 0.0,
                y2: 0.0,
            };
        }
        let big_a = 10f64.powf(gain_db as f64 / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * center_hz as f64 / rate.max(1) as f64;
        let alpha = w0.sin() / (2.0 * q as f64);
        let cos_w0 = w0.cos();
        let a0 = 1.0 + alpha / big_a;
        Self {
            b0: (1.0 + alpha * big_a) / a0,
            b1: (-2.0 * cos_w0) / a0,
            b2: (1.0 - alpha * big_a) / a0,
            a1: (-2.0 * cos_w0) / a0,
            a2: (1.0 - alpha / big_a) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    /// Direct Form I；中性段（增益 0）系数退化为恒等，计算量可忽略。
    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// 六段 EQ 滤波器组：系数按 (采样率, 增益) 缓存，状态按声道各一份。
struct EqBank {
    rate: u32,
    gains: [f32; 6],
    /// 每声道一份滤波器状态（采样历史），系数同源。
    states: Vec<[BiQuad; 6]>,
}

impl EqBank {
    fn new(rate: u32, gains: [f32; 6], channels: usize) -> Self {
        let bands: Vec<BiQuad> = EQ_BANDS
            .iter()
            .zip(gains.iter())
            .map(|(&f, &g)| BiQuad::peaking(f, g, 1.2, rate))
            .collect();
        let states = (0..channels.max(1))
            .map(|_| {
                let mut arr = [BiQuad {
                    b0: 1.0,
                    b1: 0.0,
                    b2: 0.0,
                    a1: 0.0,
                    a2: 0.0,
                    x1: 0.0,
                    x2: 0.0,
                    y1: 0.0,
                    y2: 0.0,
                }; 6];
                for (a, b) in arr.iter_mut().zip(bands.iter()) {
                    *a = *b;
                }
                arr
            })
            .collect();
        Self {
            rate,
            gains,
            states,
        }
    }

    fn matches(&self, rate: u32, gains: &[f32; 6], channels: usize) -> bool {
        self.rate == rate && self.gains == *gains && self.states.len() == channels.max(1)
    }

    #[inline]
    fn process_frame(&mut self, ch: usize, sample: f32) -> f32 {
        let mut v = sample as f64;
        for band in self.states[ch].iter_mut() {
            v = band.process(v);
        }
        v as f32
    }
}

/// 软限幅：-ceiling..ceiling 之外平滑压缩，线性段完全透明。
fn soft_limit(sample: f32, ceiling: f32) -> f32 {
    if !sample.is_finite() {
        return 0.0;
    }
    let a = sample.abs();
    if a <= ceiling {
        sample
    } else {
        let over = a - ceiling;
        let limited = ceiling + over / (1.0 + over);
        limited.min(1.0) * sample.signum()
    }
}

fn no_device() -> AudioError {
    AudioError::DeviceUnavailable("output device not initialised".into())
}

fn overlap_gains(frame: u64, frames: u64) -> (f32, f32) {
    let t = if frames <= 1 {
        1.0
    } else {
        frame as f32 / (frames - 1) as f32
    };
    let theta = t.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
    let headroom = 1.0 - 0.12 * (std::f32::consts::PI * t).sin();
    (theta.cos() * headroom, theta.sin() * headroom)
}

/// Concatenate or mix before EQ and the final output limiter. A promotion is
/// recorded after the last outgoing frame, never on the actor's timer.
fn render_decks(data: &mut [f32], shared: &Shared, channels: usize) -> (usize, bool) {
    let Ok(mut prepared) = shared.next.try_lock() else {
        return (0, true);
    };
    // Reserve notification capacity before consuming either source. Contention
    // produces an underrun, never a source switch whose event can be lost.
    let mut notification = if prepared.is_some() {
        match shared.next_event.try_lock() {
            Ok(slot) if slot.is_none() => Some(slot),
            _ => return (0, true),
        }
    } else {
        None
    };
    let Ok(mut current) = shared.deck.try_lock() else {
        return (0, true);
    };
    let mut copied = 0;
    while copied + channels <= data.len() {
        let Ok(mut outgoing) = current.samples.try_lock() else {
            return (copied, true);
        };
        let eof = current.eof.load(Ordering::Acquire);
        let Some(next) = prepared.as_mut() else {
            let count = ((data.len() - copied).min(outgoing.len()) / channels) * channels;
            for (target, sample) in data[copied..copied + count]
                .iter_mut()
                .zip(outgoing.drain(..count))
            {
                *target = sample;
            }
            current
                .frames_played
                .fetch_add((count / channels) as u64, Ordering::Relaxed);
            copied += count;
            break;
        };
        let Ok(mut incoming) = next.deck.samples.try_lock() else {
            return (copied, true);
        };
        if next.deck.decode_error.load(Ordering::Acquire)
            || (eof && outgoing.is_empty() && incoming.is_empty())
        {
            let reason = if next.deck.decode_error.load(Ordering::Acquire) {
                BypassReason::DecodeFailed
            } else {
                BypassReason::NotReady
            };
            drop(incoming);
            let next = prepared.take().unwrap();
            **notification.as_mut().unwrap() = Some(RenderEvent::Bypassed {
                prepared: next,
                reason,
            });
            continue;
        }
        let mut promote = false;
        let start_copied = copied;
        let start_mixed = next.mixed_frames;
        while copied + channels <= data.len() {
            let remain = (outgoing.len() / channels) as u64;
            if remain == 0 {
                promote = eof && incoming.len() >= channels;
                break;
            }
            if next.overlap_frames.is_none() && eof {
                let wanted = ms_to_frames(
                    next.request.crossfade_ms,
                    shared.device_rate.load(Ordering::Relaxed),
                );
                if wanted > 0 && remain <= wanted && incoming.len() / channels >= remain as usize {
                    next.overlap_frames = Some(remain);
                }
            }
            let mix = next.overlap_frames.is_some();
            if mix && incoming.len() < channels {
                break;
            }
            let (a, b) = next.overlap_frames.map_or((1.0, 0.0), |frames| {
                overlap_gains(next.mixed_frames, frames)
            });
            for channel in 0..channels {
                let old = outgoing.pop_front().unwrap();
                let new = if mix {
                    incoming.pop_front().unwrap()
                } else {
                    0.0
                };
                data[copied + channel] = old * a + new * b;
            }
            copied += channels;
            if mix {
                next.mixed_frames += 1;
            }
            if eof && outgoing.is_empty() {
                promote = mix || incoming.len() >= channels;
                break;
            }
        }
        current.frames_played.fetch_add(
            ((copied - start_copied) / channels) as u64,
            Ordering::Relaxed,
        );
        next.deck
            .frames_played
            .fetch_add(next.mixed_frames - start_mixed, Ordering::Relaxed);
        let exhausted = eof && outgoing.is_empty();
        drop(incoming);
        drop(outgoing);
        if promote {
            let next = prepared.take().unwrap();
            let retired = std::mem::replace(&mut *current, next.deck);
            **notification.as_mut().unwrap() = Some(RenderEvent::Transitioned {
                request: next.request,
                info: next.info,
                gapless_supported: next.gapless_supported,
                retired,
            });
        } else {
            if exhausted {
                let next = prepared.take().unwrap();
                **notification.as_mut().unwrap() = Some(RenderEvent::Bypassed {
                    prepared: next,
                    reason: BypassReason::NotReady,
                });
            }
            break;
        }
    }
    (copied, false)
}
fn write_samples(data: &mut [f32], shared: &Shared, channels: usize) {
    // Paused means "stop consuming", not "play silence we already decoded":
    // draining the queue here would keep the sound going and keep advancing
    // the position, so the transport would report paused while audio played on.
    // The decoder's flow control parks itself once the buffer is full, so
    // resuming continues from exactly this frame.
    if !shared.playing.load(Ordering::Relaxed) {
        for sample in data.iter_mut() {
            *sample = 0.0;
        }
        return;
    }

    let volume = f32::from_bits(shared.volume.load(Ordering::Relaxed));
    let (copied, contended) = render_decks(data, shared, channels.max(1));

    // 频谱 tap：淡变前信号（舞台可视化不随淡出塌陷）。cheap, bounded, and
    // skipped entirely under contention.
    if let Ok(mut tap) = shared.tap.try_lock() {
        let mut i = 0;
        while i + channels <= copied {
            let sum: f32 = data[i..i + channels].iter().sum();
            if tap.len() >= TAP_LEN {
                tap.pop_front();
            }
            tap.push_back(sum / channels as f32);
            i += channels * TAP_STRIDE;
        }
    }

    // DSP 链：EQ（每声道滤波器组）→ 线性增益（用户音量 × 斜坡 × preamp+track）
    // → 软限幅防削波。actor 预先建立滤波器组；签名不符或 try_lock 失败
    // 就跳过 EQ，音频线程绝不分配或阻塞。
    let rate = shared.device_rate.load(Ordering::Relaxed);
    let mut eq_gains = [0.0f32; 6];
    for (i, g) in eq_gains.iter_mut().enumerate() {
        *g = f32::from_bits(shared.eq_gains[i].load(Ordering::Relaxed));
    }
    let mut bank_guard = shared.filters.try_lock().ok();
    if !bank_guard.as_ref().is_some_and(|bank| {
        bank.as_ref()
            .is_some_and(|b| b.matches(rate, &eq_gains, channels))
    }) {
        // The actor rebuilds coefficients. Never allocate filters in a callback.
        bank_guard = None;
    }
    let dsp_gain =
        10f64.powf(f32::from_bits(shared.dsp_gain_db.load(Ordering::Relaxed)) as f64 / 20.0) as f32;

    // 逐帧乘 用户音量 × 斜坡增益，每帧推进一次斜坡。斜坡状态只在回调末尾
    // 写回原子量，中途不产生跨线程可见的中间态。
    let mut fade_total = shared.fade_frames.load(Ordering::Relaxed);
    let mut fade_done = shared.fade_done.load(Ordering::Relaxed);
    let fade_from = f32::from_bits(shared.fade_from.load(Ordering::Relaxed));
    let fade_to = f32::from_bits(shared.fade_to.load(Ordering::Relaxed));
    let mut gain = f32::from_bits(shared.fade_gain.load(Ordering::Relaxed));
    let frames = copied / channels.max(1);
    for f in 0..frames {
        if fade_total > 0 {
            fade_done += 1;
            gain = Shared::ramp_value(fade_from, fade_to, fade_total, fade_done);
            if fade_done >= fade_total {
                fade_total = 0;
                gain = fade_to;
            }
        }
        for c in 0..channels {
            let idx = f * channels + c;
            let mut sample = data[idx];
            if let Some(bank) = bank_guard.as_mut() {
                if let Some(b) = bank.as_mut() {
                    sample = b.process_frame(c, sample);
                }
            }
            sample = sample * volume * gain * dsp_gain;
            data[idx] = soft_limit(sample, 0.98);
        }
    }
    // 缓冲已干而斜坡没走完：尾部淡出按「剩余帧数」武装，但自然 EOF 后缓冲
    // 里的实际帧数受重采样/取整影响未必凑得满斜坡；斜坡只在拷到帧时推进，
    // 停在半路后 fade_active 永远为真，maintain 的换装（连同暂停/停止的
    // 收口）全部饿死 —— 表现为自动接力的下一首、以及随后的一切换装，
    // 永远卡在上一首的结束位置，无声。缓冲拿不出帧时直接落到终点收掉斜坡。
    if copied == 0 && fade_total > 0 && !contended {
        fade_total = 0;
        fade_done = 0;
        gain = fade_to;
    }
    shared.fade_gain.store(gain.to_bits(), Ordering::Relaxed);
    shared.fade_done.store(fade_done, Ordering::Relaxed);
    shared.fade_frames.store(fade_total, Ordering::Relaxed);

    // 缓冲欠载：没填满的部分补 0，不能把上一轮回调的残留样本播出去。
    for sample in data.iter_mut().skip(copied) {
        *sample = 0.0;
    }
}

impl AudioBackend for CpalBackend {
    fn name(&self) -> &'static str {
        "cpal"
    }

    fn devices(&self) -> Result<Vec<DeviceInfo>, AudioError> {
        let host = cpal::default_host();
        let default_name = host.default_output_device().and_then(|d| d.name().ok());
        let mut out = Vec::new();
        for device in host.output_devices().into_iter().flatten() {
            let Ok(name) = device.name() else { continue };
            let is_default = default_name.as_deref() == Some(name.as_str());
            out.push(DeviceInfo {
                id: name.clone(),
                name,
                is_default,
            });
        }
        if out.is_empty() {
            out.push(DeviceInfo {
                id: "default".into(),
                name: "System default".into(),
                is_default: true,
            });
        }
        Ok(out)
    }

    fn select_device(&mut self, id: Option<&str>) -> Result<(), AudioError> {
        let host = cpal::default_host();
        let device = match id {
            None => host.default_output_device().ok_or_else(no_device)?,
            Some(name) => host
                .output_devices()
                .into_iter()
                .flatten()
                .find(|d| d.name().map(|n| n == name).unwrap_or(false))
                .ok_or_else(|| AudioError::DeviceUnavailable(name.into()))?,
        };
        let config = pick_config(&device)?;

        // Rebuilding the device means rebuilding the stream and re-decoding.
        self.stop_decoder();
        self.stream = None;
        self.device_rate = config.sample_rate().0;
        self.device_channels = config.channels();
        self.device = Some(device);
        self.config = Some(config);
        self.clear_buffers();
        self.shared
            .current_deck()
            .frames_played
            .store(0, Ordering::Relaxed);
        Ok(())
    }

    fn load(&mut self, uri: &str) -> Result<MediaInfo, AudioError> {
        let path = uri_to_path(uri);
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_string);
        let file = File::open(&path).map_err(|e| AudioError::DecodeFailed(e.to_string()))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        self.open_and_spawn(mss, ext.as_deref())
    }

    fn load_source(
        &mut self,
        source: Box<dyn AudioSource>,
        ext: Option<String>,
    ) -> Result<MediaInfo, AudioError> {
        let mss = MediaSourceStream::new(
            Box::new(DynMediaSource { inner: source }),
            Default::default(),
        );
        self.open_and_spawn(mss, ext.as_deref())
    }

    fn play(&mut self) -> Result<(), AudioError> {
        if let Some(error) = &self.stop_error {
            return Err(AudioError::DecodeFailed(format!(
                "stop reset failed; retry stop or reload: {error}"
            )));
        }
        if self.pending_stop {
            self.do_stop_reset()?;
        }
        self.ensure_stream()?;
        if self.shared.current_deck().eof.load(Ordering::Acquire)
            && self
                .shared
                .current_deck()
                .samples
                .lock()
                .is_ok_and(|samples| samples.is_empty())
        {
            self.seek(0)?;
        }
        self.pending_pause = false;
        self.pending_stop = false;
        if self.pending_load.is_some() {
            // 切歌淡出途中按播放：不能把旧源的下行斜坡重新 arm 成淡入
            // （否则旧歌会先响回来再被换掉），只标记换装后开播；新曲由
            // spawn_pending 装自己的淡入。
            if let Some(pending) = self.pending_load.as_mut() {
                pending.play_after = true;
            }
        } else if self.shared.fade_active()
            || f32::from_bits(self.shared.fade_gain.load(Ordering::Relaxed)) < 0.999
        {
            // 从淡出中点或零增益恢复也走淡入，不硬拉满。
            self.shared.arm_fade(1.0, FADE_IN_MS, self.device_rate);
        }
        self.shared.playing.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn pause(&mut self) -> Result<(), AudioError> {
        if self.pending_load.is_none()
            && self.shared.current_deck().eof.load(Ordering::Acquire)
            && self
                .shared
                .current_deck()
                .samples
                .lock()
                .is_ok_and(|samples| samples.is_empty())
        {
            self.shared.playing.store(false, Ordering::Relaxed);
            self.pending_pause = false;
            return Ok(());
        }
        if self.shared.playing.load(Ordering::Relaxed) && !self.pending_pause {
            self.shared.arm_fade(0.0, FADE_OUT_MS, self.device_rate);
            self.pending_pause = true;
            // 换装淡出期间暂停：新曲换装后也保持暂停。
            if let Some(pending) = self.pending_load.as_mut() {
                pending.play_after = false;
            }
        }
        Ok(())
    }

    /// 停止 = 淡出到 0 + 回到开头，**保留解码线程**。
    ///
    /// 正在播放时先武装 200ms 淡出，maintain 到点再 seek 回 0（seek 内部清
    /// 缓冲）；已暂停则立刻复位。解码线程不杀：停止语义不等于「卸载曲目」，
    /// 卸载由 load() 负责，杀线程会让「停止 → 再播放」无声卡死。
    /// duration 不清：停止后进度条仍应显示总时长。
    fn stop(&mut self) -> Result<(), AudioError> {
        if self.shared.playing.load(Ordering::Relaxed) && !self.pending_stop {
            self.shared.arm_fade(0.0, FADE_OUT_MS, self.device_rate);
            self.pending_stop = true;
            if let Some(pending) = self.pending_load.as_mut() {
                pending.play_after = false;
            }
        } else if !self.pending_stop {
            // 已暂停：立刻复位，不等斜坡。
            self.do_stop_reset()?;
        }
        Ok(())
    }

    fn seek(&mut self, position_ms: u64) -> Result<(), AudioError> {
        if self.pending_load.is_some() {
            self.shared.playing.store(false, Ordering::Relaxed);
            self.spawn_pending();
        }
        let position_ms = position_ms.min(self.duration_ms.unwrap_or(u64::MAX));
        let (handle, ctl) = self.decoder.as_ref().ok_or(AudioError::NothingLoaded)?;
        ctl.seek(handle, position_ms, std::time::Duration::from_secs(2))?;
        // 尾段淡出途中 seek：增益正沿尾斜坡滑向 0，而 tail_armed 会阻止
        // 尾部逻辑重新武装——不处理就永远卡在静音。解除门闩，从当前增益
        // 起步装一条 120ms 短回淡（arm_fade 自己读当前 fade_gain 当初值）。
        // 例外：pending_stop 复位时的 seek(0) 是停止动作，不能再淡回来。
        if self.tail_armed {
            self.tail_armed = false;
            if !self.pending_stop && !self.pending_pause {
                self.shared.arm_fade(1.0, 120, self.device_rate);
            }
        }
        Ok(())
    }

    fn set_volume(&mut self, volume: f32) -> Result<(), AudioError> {
        if !volume.is_finite() {
            return Err(AudioError::Other("volume must be finite".into()));
        }
        self.shared
            .volume
            .store(volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        Ok(())
    }

    fn set_dsp(&mut self, params: vmusic_core::DspParams) -> Result<(), AudioError> {
        for (i, g) in params.eq_gains_db.iter().enumerate() {
            self.shared.eq_gains[i].store(g.clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
        }
        // 增益上限 +18 dB：RG 归一化补偿合理范围；限幅器在链尾兜底。
        let total_db =
            params.preamp_db.clamp(-24.0, 12.0) + params.track_gain_db.clamp(-24.0, 12.0);
        self.shared
            .dsp_gain_db
            .store(total_db.clamp(-24.0, 18.0).to_bits(), Ordering::Relaxed);
        self.sync_dsp_context();
        Ok(())
    }

    fn set_crossfade(&mut self, ms: u64) -> Result<(), AudioError> {
        self.shared
            .crossfade_ms
            .store(ms.min(8000), Ordering::Relaxed);
        Ok(())
    }

    fn prepare_next(&mut self, mut next: NextTrack) -> Result<PrepareResult, AudioError> {
        self.clear_next();
        // This entry deliberately accepts only a complete file. Network I/O
        // and cache warming remain the service's responsibility.
        next.crossfade_ms = next.crossfade_ms.min(8_000);
        let path = uri_to_path(&next.uri);
        if !path.is_file() || path.extension().is_some_and(|ext| ext == "part") {
            return Ok(PrepareResult::Bypassed {
                reason: "next complete file is unavailable".into(),
            });
        }
        let ext = path.extension().and_then(|ext| ext.to_str());
        let file = File::open(&path).map_err(|e| AudioError::DecodeFailed(e.to_string()))?;
        let (opened, info) = open_media(
            MediaSourceStream::new(Box::new(file), Default::default()),
            ext,
        )?;
        self.prepare_opened(opened, info, next)
    }

    fn clear_next(&mut self) {
        self.shared.next.lock().unwrap().take();
        // Removing the plan synchronizes with the callback. A completed switch
        // remains observable and is settled by the actor before its next command.
        if matches!(
            *self.shared.next_event.lock().unwrap(),
            Some(RenderEvent::Transitioned { .. })
        ) {
            return;
        }
        if let Some((handle, ctl)) = self.next_decoder.take() {
            ctl.stop.store(true, Ordering::Relaxed);
            let _ = handle.join();
        }
    }

    fn take_next_event(&mut self) -> Option<NextEvent> {
        let event = self.shared.next_event.lock().unwrap().take()?;
        Some(match event {
            RenderEvent::Transitioned {
                request,
                info,
                gapless_supported,
                retired,
            } => {
                self.stop_decoder();
                drop(retired);
                self.decoder = self.next_decoder.take();
                self.duration_ms = info.duration_ms;
                self.source_rate = info.sample_rate;
                self.gapless_supported = gapless_supported;
                self.tail_armed = false;
                NextEvent::Transitioned {
                    from_generation: request.generation,
                    track_id: request.track_id,
                    info,
                }
            }
            RenderEvent::Bypassed { prepared, reason } => {
                if let Some((handle, ctl)) = self.next_decoder.take() {
                    ctl.stop.store(true, Ordering::Relaxed);
                    let _ = handle.join();
                }
                let PreparedDeck { request, .. } = prepared;
                NextEvent::Bypassed {
                    generation: request.generation,
                    track_id: request.track_id,
                    reason: match reason {
                        BypassReason::DecodeFailed => "next decoder failed",
                        BypassReason::NotReady => "next samples were not ready at the boundary",
                    }
                    .into(),
                }
            }
        })
    }

    fn position_ms(&self) -> u64 {
        if self.pending_stop || self.pending_load.is_some() {
            return 0;
        }
        frames_to_ms(
            self.shared
                .current_deck()
                .frames_played
                .load(Ordering::Relaxed),
            self.device_rate,
        )
        .min(self.duration_ms.unwrap_or(u64::MAX))
    }

    fn duration_ms(&self) -> Option<u64> {
        self.pending_load
            .as_ref()
            .map_or(self.duration_ms, |pending| pending.info.duration_ms)
    }

    fn finished(&self) -> bool {
        // 换装淡出窗口里旧源耗尽绝不能算「播完」：maintain 马上要换上新源，
        // 此刻报 Ended 会让状态层错误地接力/停播（I1）。
        if self.pending_load.is_some()
            || self.shared.next.lock().unwrap().is_some()
            || self.pending_stop
            || self.pending_pause
            || !self.shared.playing.load(Ordering::Relaxed)
        {
            return false;
        }
        self.shared.current_deck().eof.load(Ordering::Acquire)
            && self
                .shared
                .current_deck()
                .samples
                .lock()
                .is_ok_and(|samples| samples.is_empty())
    }

    fn take_decode_failure(&mut self) -> bool {
        if self.stop_error.is_some() {
            self.shared.take_decode_error();
            return false;
        }
        // 换装淡出窗口里旧源的早夭不上报（新源即将接手；旧错误位由
        // spawn_pending 清掉，新解码器若再失败会重新置位）。
        if self.pending_load.is_some() {
            return false;
        }
        if !self.shared.take_decode_error() {
            return false;
        }
        self.shared.playing.store(false, Ordering::Relaxed);
        self.clear_buffers();
        self.reset_fade();
        true
    }

    fn spectrum(&self, out: &mut [f32]) -> bool {
        let tap = match self.shared.tap.try_lock() {
            Ok(t) => t,
            Err(_) => return false,
        };
        if tap.len() < FFT_SIZE || out.is_empty() {
            return false;
        }
        let start = tap.len() - FFT_SIZE;

        let mut buf: Vec<Complex<f32>> = Vec::with_capacity(FFT_SIZE);
        for (i, sample) in tap.iter().skip(start).take(FFT_SIZE).enumerate() {
            // Hann window: without it a partial frame leaks badly across bands.
            let w = 0.5 * (1.0 - ((2.0 * std::f32::consts::PI * i as f32) / FFT_SIZE as f32).cos());
            buf.push(Complex::new(sample * w, 0.0));
        }
        self.fft.process(&mut buf);

        let bins = FFT_SIZE / 2;
        let bands = out.len();
        let mut peak = 1e-6f32;
        for (i, slot) in out.iter_mut().enumerate() {
            // Log-spaced band edges so bass is not squeezed into two bands.
            let lo = (((i as f32 / bands as f32).powi(2)) * bins as f32) as usize;
            let hi = ((((i + 1) as f32 / bands as f32).powi(2)) * bins as f32).max(lo as f32 + 1.0)
                as usize;
            let hi = hi.min(bins);
            let mut acc = 0.0f32;
            for bin in buf[lo..hi].iter() {
                acc = acc.max(bin.norm());
            }
            let v = (acc / (bins as f32).sqrt()).clamp(0.0, 1.0).sqrt();
            peak = peak.max(v);
            *slot = v;
        }

        // Normalise against the frame peak so quiet tracks still animate,
        // then smooth: fast attack, slow decay reads as "musical".
        let scale = if peak > 0.02 { 1.0 / peak } else { 1.0 };
        let mut state = match self.spectrum_state.try_lock() {
            Ok(s) => s,
            Err(_) => {
                for v in out.iter_mut() {
                    *v *= scale;
                }
                return true;
            }
        };
        if state.len() != bands {
            *state = vec![0.0f32; bands];
        }
        for (i, v) in out.iter_mut().enumerate() {
            *v = (*v * scale).clamp(0.0, 1.0);
            let prev = state[i];
            state[i] = if *v > prev {
                prev + (*v - prev) * 0.55
            } else {
                prev + (*v - prev) * 0.14
            };
            *v = state[i];
        }
        true
    }

    fn maintain(&mut self) {
        CpalBackend::maintain(self);
    }

    fn take_transport_error(&mut self) -> Option<AudioError> {
        self.transport_error.take()
    }
}

impl Drop for CpalBackend {
    fn drop(&mut self) {
        self.clear_next();
        let _ = self.take_next_event();
        self.stop_decoder();
        self.stream = None;
    }
}

fn ms_to_frames(ms: u64, rate: u32) -> u64 {
    (ms as u128 * rate.max(1) as u128 / 1000) as u64
}

fn frames_to_ms(frames: u64, rate: u32) -> u64 {
    (frames as u128 * 1000 / rate.max(1) as u128) as u64
}

/// Accepts both a plain filesystem path and a `file:///…` URI.
fn uri_to_path(uri: &str) -> PathBuf {
    let trimmed = uri.trim();
    if let Some(rest) = trimmed.strip_prefix("file:///") {
        // Windows: file:///C:/x -> C:/x ; POSIX: file:///x -> /x
        if rest.len() > 2 && rest.as_bytes()[1] == b':' {
            PathBuf::from(rest)
        } else {
            PathBuf::from(format!("/{rest}"))
        }
    } else if let Some(rest) = trimmed.strip_prefix("file://") {
        PathBuf::from(rest)
    } else {
        PathBuf::from(trimmed)
    }
}

fn pick_config(device: &Device) -> Result<SupportedStreamConfig, AudioError> {
    let mut best: Option<cpal::SupportedStreamConfigRange> = None;
    for range in device
        .supported_output_configs()
        .map_err(|e| AudioError::DeviceUnavailable(e.to_string()))?
    {
        if range.sample_format() != SampleFormat::F32 {
            continue;
        }
        let better = best
            .as_ref()
            .map(|b| range.max_sample_rate() > b.max_sample_rate())
            .unwrap_or(true);
        if better {
            best = Some(range);
        }
    }
    let range = best.ok_or_else(|| {
        AudioError::DeviceUnavailable("no 32-bit float output configuration".into())
    })?;
    // `SampleRate` is a newtype in cpal 0.15, hence the `.0` juggling.
    let wanted = 48_000u32;
    let min = range.min_sample_rate().0;
    let max = range.max_sample_rate().0;
    let rate = if wanted >= min && wanted <= max {
        wanted
    } else {
        max
    };
    Ok(range.with_sample_rate(cpal::SampleRate(rate)))
}

#[allow(clippy::too_many_arguments)]
fn decode_loop_opened(
    opened: OpenedReader,
    shared: Arc<Deck>,
    stop: Arc<AtomicBool>,
    seek_to: Arc<Mutex<Option<SeekRequest>>>,
    device_rate: u32,
    device_channels: usize,
) {
    let OpenedReader {
        mut reader,
        mut decoder,
        track_id,
        ..
    } = opened;

    let src_rate = reader
        .default_track()
        .and_then(|t| t.codec_params.sample_rate)
        .unwrap_or(device_rate);
    let mut resampler = Resampler::new(src_rate, device_rate);
    let capacity = (device_rate as f32 * BUFFER_SECONDS) as usize * device_channels;
    // 循环退出原因有三种「正常」：symphonia 的 UnexpectedEof("end of stream")
    // 自然播完；io::ErrorKind::Interrupted（下载 abort / seek-stop 主动中止）；
    // stop 位被外部置上。其余跳出（含解码致命错、下载断开的 BrokenPipe）才算早夭。
    let mut natural_eof = false;
    let mut interrupted = false;
    let mut discard_until = None;

    while !stop.load(Ordering::Relaxed) {
        if let Some(SeekRequest {
            position_ms: target_ms,
            reply,
        }) = seek_to.lock().ok().and_then(|mut g| g.take())
        {
            let time = Time::new(target_ms / 1000, (target_ms % 1000) as f64 / 1000.0);
            let sought = reader.seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time,
                    track_id: Some(track_id),
                },
            );
            let sought = match sought {
                Ok(sought) => sought,
                Err(error) => {
                    let _ = reply.send(Err(AudioError::DecodeFailed(format!(
                        "seek failed: {error}"
                    ))));
                    continue;
                }
            };
            discard_until = Some(sought.required_ts);
            decoder.reset();
            resampler.reset();
            if let Ok(mut q) = shared.samples.lock() {
                q.clear();
                shared
                    .frames_played
                    .store(ms_to_frames(target_ms, device_rate), Ordering::Relaxed);
            }
            natural_eof = false;
            shared.eof.store(false, Ordering::Release);
            let _ = reply.send(Ok(()));
        }
        if natural_eof {
            std::thread::sleep(std::time::Duration::from_millis(8));
            continue;
        }

        // Flow control: decode only while the buffer is not full.
        if let Ok(q) = shared.samples.lock() {
            if q.len() >= capacity {
                drop(q);
                std::thread::sleep(std::time::Duration::from_millis(8));
                continue;
            }
        }

        match reader.next_packet() {
            Ok(packet) if packet.track_id() != track_id => continue,
            Ok(packet) => match decoder.decode(&packet) {
                Ok(decoded) => {
                    let spec = *decoded.spec();
                    let frames = decoded.frames();
                    if frames == 0 {
                        continue;
                    }
                    let mut sb = SampleBuffer::<f32>::new(frames as u64, spec);
                    sb.copy_interleaved_ref(decoded);
                    let skip = discard_until.map_or(0, |target| {
                        let ticks = target.saturating_sub(packet.ts());
                        reader
                            .default_track()
                            .and_then(|track| track.codec_params.time_base)
                            .map_or(ticks as usize, |base| {
                                let time = base.calc_time(ticks);
                                ((time.seconds as f64 + time.frac) * spec.rate as f64).round()
                                    as usize
                            })
                            .min(frames)
                    });
                    if skip == frames {
                        continue;
                    }
                    discard_until = None;
                    let resampled = resampler.push(
                        &sb.samples()[skip * spec.channels.count()..],
                        spec.channels.count(),
                    );
                    let mapped = map_channels(&resampled, spec.channels.count(), device_channels);
                    if let Ok(mut q) = shared.samples.lock() {
                        q.extend(mapped);
                    }
                }
                Err(SymError::DecodeError(e)) => {
                    tracing::debug!("skipping undecodable packet: {e}");
                }
                Err(e) => {
                    tracing::warn!("decode error: {e}");
                    // 解码器正常不做 I/O，但若主动中止的 Interrupted 从这里
                    // 冒出来，同样按中止收口，不能误报早夭。
                    interrupted = is_interrupted(&e);
                    break;
                }
            },
            Err(SymError::ResetRequired) => {
                decoder.reset();
            }
            Err(e) => {
                // symphonia 以 IoError(UnexpectedEof) 表示自然播完；
                // Interrupted 是下载 abort（未下完切歌）/ seek-stop 的主动
                // 中止；其它 I/O 错误（如下载链路断开）才是异常早夭，交循环
                // 后统一置位。
                if matches!(
                    &e,
                    SymError::IoError(ioe)
                        if ioe.kind() == std::io::ErrorKind::UnexpectedEof
                ) {
                    natural_eof = true;
                    shared.eof.store(true, Ordering::Release);
                    continue;
                } else if is_interrupted(&e) {
                    interrupted = true;
                    tracing::debug!("decoder loop aborted: {e}");
                } else {
                    tracing::warn!("format reader stalled: {e}");
                }
                break;
            }
        }
    }

    // 主动 stop（换装/选设备/卸载）、干净 EOF 与主动中止（下载 abort /
    // seek-stop 的 Interrupted，此时 stop 位可能尚未被解码线程观察到）都不报；
    // 只有非预期早夭置位，actor 下一个 tick 取走并发 DecodeError。
    if should_flag_decode_error(stop.load(Ordering::Relaxed), interrupted, natural_eof) {
        shared.flag_decode_error();
    }

    tracing::debug!("decoder thread finished for stream");
    stop.store(true, Ordering::Relaxed);
}

/// symphonia 错误链里是否藏着一个 [`std::io::ErrorKind::Interrupted`]。
///
/// 下载 abort（HttpMediaSource 把 WaitError::Aborted 映成 Interrupted）与
/// seek/stop 路径上的中断都以这个 kind 冒到解码循环：它是「主动中止」而不是
/// 解码早夭，绝不能据此 flag_decode_error——未下完即切歌时 stop 位甚至可能
/// 还没被解码线程观察到。
///
/// 两条途径都试：先匹配 `IoError` 变体里的 io::Error（等同 io_error() 入口）；
/// 再沿错误链逐层 downcast——symphonia 0.5 的 `Error` 只实现了旧版 `cause()`
/// 而 `source()` 返回 None，所以链上的 symphonia 层要显式认出 `IoError`
/// 变体；io::Error 层则用 `get_ref()` 取自定义负载（其 `source()` 会跳过
/// 负载本身，直接返回负载的 source，单纯走 source() 会漏掉这一层）。
fn is_interrupted(err: &SymError) -> bool {
    let mut chain: Vec<&(dyn std::error::Error + 'static)> = vec![err];
    while let Some(node) = chain.pop() {
        if let Some(ioe) = node.downcast_ref::<std::io::Error>() {
            if ioe.kind() == std::io::ErrorKind::Interrupted {
                return true;
            }
            if let Some(inner) = ioe.get_ref() {
                chain.push(inner);
            }
        } else if let Some(SymError::IoError(ioe)) = node.downcast_ref::<SymError>() {
            chain.push(ioe);
        } else if let Some(src) = std::error::Error::source(node) {
            chain.push(src);
        }
    }
    false
}

/// 解码线程退出后是否应置「异常早夭」位（纯函数，便于单测）。
///
/// 三种正常退出都不置位：外部主动 `stop`、自然 EOF（UnexpectedEof）、
/// 主动中止（Interrupted）；只有三者皆否时才算早夭候选。
fn should_flag_decode_error(stop: bool, interrupted: bool, natural_eof: bool) -> bool {
    !stop && !interrupted && !natural_eof
}

fn open_media(
    mss: MediaSourceStream,
    ext: Option<&str>,
) -> Result<(OpenedReader, MediaInfo), AudioError> {
    let mut hint = Hint::new();
    if let Some(e) = ext {
        if !e.is_empty() {
            hint.with_extension(e);
        }
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|e| AudioError::UnsupportedFormat(e.to_string()))?;

    let track = probed
        .format
        .default_track()
        .ok_or_else(|| AudioError::UnsupportedFormat("no audio track".into()))?;
    // 直接读 CodecParams 字段（都是 Copy），不要 clone 整个 params。
    let duration_ms = track
        .codec_params
        .time_base
        .zip(track.codec_params.n_frames)
        .map(|(tb, frames)| {
            let time = tb.calc_time(frames);
            // `Time::seconds` 截断，短于 1 秒的片段会报 0ms，进而让
            // finished() 一开播就触发——保留小数部分。
            ((time.seconds as f64 + time.frac) * 1000.0).round() as u64
        });
    let sample_rate = track.codec_params.sample_rate;
    let channels = track.codec_params.channels.map(|c| c.count() as u8);
    let track_id = track.id;
    let gapless_supported = supports_gapless(&track.codec_params);
    let decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| AudioError::UnsupportedFormat(e.to_string()))?;

    let opened = OpenedReader {
        reader: probed.format,
        decoder,
        track_id,
        gapless_supported,
    };
    let info = MediaInfo {
        duration_ms,
        sample_rate,
        channels,
    };

    Ok((opened, info))
}

struct OpenedReader {
    reader: Box<dyn FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    gapless_supported: bool,
}

/// Capability of the actual Symphonia 0.5 demux/decoder path, not a file suffix.
/// Keep unverified formats playable, but out of the sample-exact transition path.
fn supports_gapless(params: &symphonia::core::codecs::CodecParameters) -> bool {
    use symphonia::core::codecs::*;
    match params.codec {
        // These codecs encode exact sample counts without priming or tail padding.
        CODEC_TYPE_PCM_S32LE | CODEC_TYPE_PCM_S32BE | CODEC_TYPE_PCM_S24LE
        | CODEC_TYPE_PCM_S24BE | CODEC_TYPE_PCM_S16LE | CODEC_TYPE_PCM_S16BE
        | CODEC_TYPE_PCM_S8 | CODEC_TYPE_PCM_U32LE | CODEC_TYPE_PCM_U32BE
        | CODEC_TYPE_PCM_U24LE | CODEC_TYPE_PCM_U24BE | CODEC_TYPE_PCM_U16LE
        | CODEC_TYPE_PCM_U16BE | CODEC_TYPE_PCM_U8 | CODEC_TYPE_PCM_F32LE
        | CODEC_TYPE_PCM_F32BE | CODEC_TYPE_PCM_F64LE | CODEC_TYPE_PCM_F64BE
        | CODEC_TYPE_PCM_ALAW | CODEC_TYPE_PCM_MULAW | CODEC_TYPE_FLAC | CODEC_TYPE_ALAC => true,
        // MpaReader obtains these from a LAME-compatible header, trims its
        // packets with enable_gapless, and the MP3 decoder applies both trims.
        // Xing alone can report Some(0)/Some(0), which is not evidence of trimming.
        CODEC_TYPE_MP3 => {
            params.delay.is_some_and(|delay| delay > 0)
                && params.padding.is_some()
                && params.n_frames.is_some_and(|frames| frames > 0)
        }
        // In particular, IsoMp4Reader/AAC in 0.5 do not apply priming/edit trims.
        _ => false,
    }
}

/// 把标准库 `Read + Seek + Send` 超集（[`AudioSource`]）适配成 symphonia
/// 的 MediaSource。
struct DynMediaSource {
    inner: Box<dyn AudioSource>,
}

impl std::io::Read for DynMediaSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}

impl std::io::Seek for DynMediaSource {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

impl vmusic_core::AudioSource for DynMediaSource {
    /// 转发内层源上报的总字节数（流式源为 HTTP Content-Length）。
    fn media_len(&self) -> Option<u64> {
        self.inner.media_len()
    }
}

impl symphonia::core::io::MediaSource for DynMediaSource {
    fn is_seekable(&self) -> bool {
        true
    }

    /// 透传内层媒体源的总字节数：无 Xing/VBRI 头的 CBR mp3 靠它估算
    /// 时长（拿不到就 None，symphonia 仅依赖容器自身元数据）。
    fn byte_len(&self) -> Option<u64> {
        self.inner.media_len()
    }
}

/// Linear-interpolating resampler with carry-over between decode blocks.
struct Resampler {
    ratio: f64,
    frac: f64,
    prev: Vec<f32>,
}

impl Resampler {
    fn new(src_rate: u32, dst_rate: u32) -> Self {
        Self {
            ratio: src_rate.max(1) as f64 / dst_rate.max(1) as f64,
            frac: 0.0,
            prev: Vec::new(),
        }
    }

    fn reset(&mut self) {
        self.frac = 0.0;
        self.prev.clear();
    }

    fn push(&mut self, interleaved: &[f32], channels: usize) -> Vec<f32> {
        if channels == 0 || interleaved.is_empty() {
            return Vec::new();
        }
        if (self.ratio - 1.0).abs() < 1e-6 {
            return interleaved.to_vec();
        }
        let frames_in = interleaved.len() / channels;
        if frames_in == 0 {
            return Vec::new();
        }
        let mut out =
            Vec::with_capacity((frames_in as f64 / self.ratio) as usize * channels + channels);
        // The interpolation needs one frame from before this block; keep a
        // local copy so the loop below can work on plain slices.
        let prev: Vec<f32> = if self.prev.len() == channels {
            self.prev.clone()
        } else {
            vec![0.0; channels]
        };

        let mut pos = self.frac;
        while pos < frames_in as f64 {
            let i = pos.floor() as i64;
            let f = (pos - pos.floor()) as f32;

            let cur: &[f32] = if i < 0 {
                &prev
            } else {
                &interleaved[i as usize * channels..(i as usize + 1) * channels]
            };
            let next: &[f32] = if i + 1 < frames_in as i64 {
                &interleaved[(i + 1) as usize * channels..(i as usize + 2) * channels]
            } else {
                cur
            };

            for (a, b) in cur.iter().zip(next) {
                out.push(a + (b - a) * f);
            }
            pos += self.ratio;
        }
        self.frac = pos - frames_in as f64;
        self.prev = interleaved[(frames_in - 1) * channels..].to_vec();
        out
    }
}

fn map_channels(interleaved: &[f32], from: usize, to: usize) -> Vec<f32> {
    if from == to || from == 0 || to == 0 {
        return interleaved.to_vec();
    }
    let frames = interleaved.len() / from;
    let mut out = Vec::with_capacity(frames * to);
    for frame in interleaved.chunks_exact(from) {
        if from == 1 {
            out.extend(std::iter::repeat_n(frame[0], to));
        } else if to == 1 {
            out.push(frame.iter().sum::<f32>() / from as f32);
        } else {
            out.extend((0..to).map(|c| frame[c % from]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct CallbackAllocator;

    /// 窗口内前几笔分配的尺寸。钩子自己不能动堆，所以是定长数组。
    /// 只看到 `left: (1, 0)` 分不出「谁分配的」，尺寸能：等于某个缓冲/Vec 容量的
    /// 就是回调真的动了堆，零碎的小尺寸才可能是平台运行时的东西。
    const RECORDED_ALLOCS: usize = 4;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    struct CallbackMemory {
        allocs: usize,
        frees: usize,
        alloc_sizes: [usize; RECORDED_ALLOCS],
    }

    impl CallbackMemory {
        const ZERO: Self = Self {
            allocs: 0,
            frees: 0,
            alloc_sizes: [0; RECORDED_ALLOCS],
        };
    }

    thread_local! {
        static CALLBACK_ALLOCATIONS: std::cell::Cell<Option<CallbackMemory>> = const { std::cell::Cell::new(None) };
    }

    // Count only the measured callback on its own thread; decoder and parallel
    // test allocations must not contaminate this real-time regression.
    unsafe impl std::alloc::GlobalAlloc for CallbackAllocator {
        unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
            let _ = CALLBACK_ALLOCATIONS.try_with(|counts| {
                if let Some(mut memory) = counts.get() {
                    if memory.allocs < RECORDED_ALLOCS {
                        memory.alloc_sizes[memory.allocs] = layout.size();
                    }
                    memory.allocs += 1;
                    counts.set(Some(memory));
                }
            });
            unsafe { std::alloc::GlobalAlloc::alloc(&std::alloc::System, layout) }
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
            let _ = CALLBACK_ALLOCATIONS.try_with(|counts| {
                if let Some(mut memory) = counts.get() {
                    memory.frees += 1;
                    counts.set(Some(memory));
                }
            });
            unsafe { std::alloc::GlobalAlloc::dealloc(&std::alloc::System, ptr, layout) }
        }
    }

    #[global_allocator]
    static CALLBACK_ALLOCATOR: CallbackAllocator = CallbackAllocator;

    fn measure_memory<T>(call: impl FnOnce() -> T) -> (T, CallbackMemory) {
        CALLBACK_ALLOCATIONS.with(|counts| counts.set(Some(CallbackMemory::ZERO)));
        let result = call();
        let counts = CALLBACK_ALLOCATIONS.with(|counts| counts.take().unwrap());
        (result, counts)
    }

    /// 上面那套计数是零分配断言的唯一依据，所以它本身要先被守住：三个线程同时
    /// 各分配 1/2/3 笔，每笔都必须只算到自己头上。窗口之间用 sleep 隔开，保证
    /// 三段窗口是真的重叠的（重叠时计数仍然精确，才说明存储是按线程隔离的）。
    #[test]
    fn allocation_counter_only_counts_its_own_thread() {
        let handles: Vec<_> = (1..=3usize)
            .map(|count| {
                std::thread::spawn(move || {
                    measure_memory(|| {
                        for _ in 0..count {
                            let block = vec![0u8; 32];
                            std::hint::black_box(&block);
                            // 拉开各笔分配之间的时间，保证三段窗口真的重叠；
                            // 恰好串行的话共享计数器也测不出来。
                            std::thread::sleep(std::time::Duration::from_millis(40));
                        }
                        count
                    })
                })
            })
            .collect();
        for handle in handles {
            let (expect, memory) = handle.join().unwrap();
            assert_eq!(memory.allocs, expect, "own-thread allocs");
            assert_eq!(memory.frees, expect, "own-thread frees");
            assert!(
                memory.alloc_sizes[..expect].iter().all(|size| *size == 32),
                "recorded sizes: {:?}",
                memory.alloc_sizes
            );
        }
    }

    /// 计数钩子可信吗？空窗口（除了开关计数什么都不做）必须是 0。
    /// 这条红而零分配断言也红，说明数字里含本平台给新线程的一次性开销，
    /// 不是回调动堆；这条绿，才轮到 `alloc_sizes` 指认是谁分的。
    #[test]
    fn empty_measurement_window_is_free() {
        let handle = std::thread::spawn(|| measure_memory(|| std::hint::black_box(0u8)));
        let memory = handle.join().unwrap().1;
        assert_eq!(memory, CallbackMemory::ZERO, "空窗口就有分配");
    }

    fn prepared_samples(samples: &[f32], overlap_ms: u64) -> PreparedDeck {
        let deck = Arc::new(Deck::new());
        deck.samples.lock().unwrap().extend(samples);
        deck.eof.store(true, Ordering::Release);
        PreparedDeck {
            deck,
            request: NextTrack {
                uri: "already-allocated.wav".into(),
                track_id: "next".into(),
                generation: 7,
                crossfade_ms: overlap_ms,
            },
            info: MediaInfo::default(),
            gapless_supported: true,
            overlap_frames: None,
            mixed_frames: 0,
        }
    }

    #[test]
    fn first_callback_and_transition_callbacks_never_allocate_or_free() {
        for scenario in [
            "plain",
            "gapless",
            "overlap",
            "failed",
            "unready",
            "eq-change",
        ] {
            let shared = Arc::new(Shared::new());
            shared.device_rate.store(8_000, Ordering::Relaxed);
            shared.playing.store(true, Ordering::Relaxed);
            shared
                .current_deck()
                .samples
                .lock()
                .unwrap()
                .extend([0.25; 8]);
            shared.current_deck().eof.store(true, Ordering::Release);
            *shared.filters.lock().unwrap() = Some(EqBank::new(8_000, [1.0; 6], 1));
            for gain in &shared.eq_gains {
                gain.store(1.0f32.to_bits(), Ordering::Relaxed);
            }
            if scenario == "eq-change" {
                shared.eq_gains[0].store(2.0f32.to_bits(), Ordering::Relaxed);
            }
            if ["gapless", "overlap", "failed", "unready"].contains(&scenario) {
                let samples: &[f32] = if scenario == "unready" {
                    &[]
                } else {
                    &[0.5; 16]
                };
                let prepared = prepared_samples(samples, u64::from(scenario == "overlap"));
                if scenario == "failed" {
                    prepared.deck.flag_decode_error();
                }
                *shared.next.lock().unwrap() = Some(prepared);
            }
            // A fresh thread proves that first-use lazy initialization cannot
            // hide an allocation behind a warm-up callback.
            let callback_shared = shared.clone();
            let (output, memory) = std::thread::spawn(move || {
                let mut output = [0.0; 64];
                let (_, memory) =
                    measure_memory(|| write_samples(&mut output, &callback_shared, 1));
                (output, memory)
            })
            .join()
            .unwrap();
            assert_eq!(
                memory,
                CallbackMemory::ZERO,
                "callback allocations for {scenario}"
            );
            assert!(output.iter().all(|sample| sample.is_finite()));
        }
    }

    fn probe_while_locked<T: Send + 'static>(
        before_ready: impl FnOnce() + Send + 'static,
        callback: impl FnOnce() -> T + Send + 'static,
        release_lock: impl FnOnce(),
    ) -> Result<T, String> {
        let (ready_send, ready_receive) = std::sync::mpsc::channel();
        let (start_send, start_receive) = std::sync::mpsc::channel();
        let (send, receive) = std::sync::mpsc::channel();
        let entered = Arc::new(AtomicBool::new(false));
        let returned = Arc::new(AtomicBool::new(false));
        let worker_entered = entered.clone();
        let worker_returned = returned.clone();
        let worker = std::thread::spawn(move || {
            before_ready();
            let _ = ready_send.send(());
            if start_receive.recv().is_ok() {
                worker_entered.store(true, Ordering::Release);
                let result = callback();
                worker_returned.store(true, Ordering::Release);
                let _ = send.send(result);
            }
        });
        // Thread creation/scheduling is not part of callback lock behavior.
        // Wait for readiness, then explicitly release the already parked worker.
        // Both waits are deadlock watchdogs, not audio latency assertions.
        let result = ready_receive
            .recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|error| format!("callback worker did not become ready: {error}"))
            .and_then(|()| {
                start_send.send(()).map_err(|error| error.to_string())?;
                receive.recv_timeout(std::time::Duration::from_secs(5)).map_err(|error| {
                    format!(
                        "callback did not return while lock was held: {error}; entered={}, returned={}",
                        entered.load(Ordering::Acquire), returned.load(Ordering::Acquire),
                    )
                })
            });
        // Release before asserting/joining: a regression must fail, not leave
        // the test process hanging forever in a blocked callback.
        release_lock();
        drop(start_send);
        worker.join().unwrap();
        result
    }

    fn callback_returns_while_locked(shared: &Arc<Shared>, release_lock: impl FnOnce()) {
        let callback_shared = shared.clone();
        let (output, memory) = probe_while_locked(
            || {},
            move || {
                let mut output = [0.75; 4];
                let (_, memory) =
                    measure_memory(|| write_samples(&mut output, &callback_shared, 1));
                (output, memory)
            },
            release_lock,
        )
        .expect("callback contention probe failed");
        assert_eq!(output, [0.0; 4]);
        assert_eq!(memory, CallbackMemory::ZERO);
    }

    #[test]
    fn contention_probe_excludes_worker_startup_from_callback_watchdog() {
        let lock = Arc::new(Mutex::new(()));
        let guard = lock.lock().unwrap();
        let callback_lock = lock.clone();
        let result = probe_while_locked(
            // Longer than the callback watchdog: counting startup would fail.
            || std::thread::sleep(std::time::Duration::from_secs(6)),
            move || callback_lock.try_lock().is_err(),
            || drop(guard),
        );
        assert_eq!(result, Ok(true));
    }

    #[test]
    fn contention_probe_rejects_a_callback_that_waits_for_the_lock() {
        let lock = Arc::new(Mutex::new(()));
        let guard = lock.lock().unwrap();
        let callback_lock = lock.clone();
        let result = probe_while_locked(
            || {},
            move || drop(callback_lock.lock().unwrap()),
            || drop(guard),
        );
        assert!(result
            .unwrap_err()
            .contains("callback did not return while lock was held"));
    }

    #[test]
    fn callback_contention_never_blocks_consumes_samples_or_advances_fades() {
        for locked in ["plan", "event", "current-slot", "current-pcm", "next-pcm"] {
            let shared = Arc::new(Shared::new());
            shared.playing.store(true, Ordering::Relaxed);
            shared.arm_fade(0.0, 200, 8_000);
            let current = shared.current_deck();
            current.samples.lock().unwrap().extend([0.25; 8]);
            current.eof.store(true, Ordering::Release);
            *shared.next.lock().unwrap() = Some(prepared_samples(&[0.5; 16], 1));
            let incoming = shared.next.lock().unwrap().as_ref().unwrap().deck.clone();
            match locked {
                "plan" => {
                    let guard = shared.next.lock().unwrap();
                    callback_returns_while_locked(&shared, || drop(guard));
                }
                "event" => {
                    let guard = shared.next_event.lock().unwrap();
                    callback_returns_while_locked(&shared, || drop(guard));
                }
                "current-slot" => {
                    let guard = shared.deck.lock().unwrap();
                    callback_returns_while_locked(&shared, || drop(guard));
                }
                "current-pcm" => {
                    let guard = current.samples.lock().unwrap();
                    callback_returns_while_locked(&shared, || drop(guard));
                }
                "next-pcm" => {
                    let guard = incoming.samples.lock().unwrap();
                    callback_returns_while_locked(&shared, || drop(guard));
                }
                _ => unreachable!(),
            }
            assert_eq!(current.samples.lock().unwrap().len(), 8, "{locked}");
            assert_eq!(incoming.samples.lock().unwrap().len(), 16, "{locked}");
            assert_eq!(current.frames_played.load(Ordering::Relaxed), 0, "{locked}");
            assert_eq!(
                incoming.frames_played.load(Ordering::Relaxed),
                0,
                "{locked}"
            );
            assert_eq!(shared.fade_done.load(Ordering::Relaxed), 0, "{locked}");
            assert_eq!(
                shared.fade_frames.load(Ordering::Relaxed),
                1_600,
                "{locked}"
            );
            assert_eq!(
                shared.fade_gain.load(Ordering::Relaxed),
                1.0f32.to_bits(),
                "{locked}"
            );
            assert!(shared.next_event.lock().unwrap().is_none(), "{locked}");
        }
    }

    #[test]
    fn empty_outgoing_with_contended_next_defers_end_until_transition() {
        let mut backend = decoded_fixture();
        backend.shared.playing.store(true, Ordering::Relaxed);
        backend
            .shared
            .current_deck()
            .samples
            .lock()
            .unwrap()
            .clear();
        *backend.shared.next.lock().unwrap() = Some(prepared_samples(&[0.5; 8], 0));
        let next = backend
            .shared
            .next
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .deck
            .clone();
        let guard = next.samples.lock().unwrap();
        callback_returns_while_locked(&backend.shared, || drop(guard));
        assert!(!backend.finished());
        assert!(backend.take_next_event().is_none());
        let mut output = [0.0; 4];
        write_samples(&mut output, &backend.shared, 1);
        assert_eq!(output, [0.5; 4]);
        assert!(matches!(
            backend.take_next_event(),
            Some(NextEvent::Transitioned { .. })
        ));
        assert!(!backend.finished());
    }

    #[test]
    fn actor_reclaims_retired_and_cancelled_decks_after_render_event() {
        for bypass in [false, true] {
            let mut backend = decoded_fixture();
            backend.stop_decoder();
            backend.shared.playing.store(true, Ordering::Relaxed);
            backend
                .shared
                .current_deck()
                .samples
                .lock()
                .unwrap()
                .clear();
            let prepared = prepared_samples(&[0.5; 8], 0);
            let reclaimed = if bypass {
                prepared.deck.flag_decode_error();
                Arc::downgrade(&prepared.deck)
            } else {
                Arc::downgrade(&backend.shared.current_deck())
            };
            *backend.shared.next.lock().unwrap() = Some(prepared);
            write_samples(&mut [0.0; 4], &backend.shared, 1);
            assert!(
                reclaimed.upgrade().is_some(),
                "callback freed deck for bypass={bypass}"
            );
            let (_, memory) = measure_memory(|| drop(backend.take_next_event()));
            assert!(
                memory.frees >= 2,
                "actor must free both the PCM buffer and its deck"
            );
            assert!(reclaimed.upgrade().is_none());
        }
    }

    fn decoded_fixture() -> CpalBackend {
        let samples: Vec<i16> = (0..8_000).collect();
        let (opened, info) = open_pcm(&samples, 8_000, 1);
        decoded_opened_fixture(opened, info, 8_000, 1)
    }

    fn decoded_opened_fixture(
        opened: OpenedReader,
        info: MediaInfo,
        device_rate: u32,
        device_channels: u16,
    ) -> CpalBackend {
        let mut backend = CpalBackend {
            shared: Arc::new(Shared::new()),
            device: None,
            config: None,
            stream: None,
            decoder: None,
            next_decoder: None,
            device_rate,
            device_channels,
            duration_ms: info.duration_ms,
            source_rate: info.sample_rate,
            gapless_supported: false,
            fft: FftPlanner::new().plan_fft_forward(FFT_SIZE),
            spectrum_state: Mutex::new(Vec::new()),
            pending_pause: false,
            pending_stop: false,
            stop_error: None,
            transport_error: None,
            tail_armed: false,
            pending_load: None,
        };
        backend
            .shared
            .device_rate
            .store(device_rate, Ordering::Relaxed);
        backend.spawn_now(opened).unwrap();
        wait_for_eof(&backend);
        backend
    }

    fn wait_for_eof(backend: &CpalBackend) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !backend.shared.current_deck().eof.load(Ordering::Acquire) {
            assert!(
                std::time::Instant::now() < deadline,
                "decoder did not reach EOF"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    #[test]
    fn long_crossfade_does_not_delay_pause_or_stop() {
        for stop in [false, true] {
            let mut backend = decoded_fixture();
            backend.set_crossfade(8_000).unwrap();
            backend.shared.playing.store(true, Ordering::Relaxed);
            if stop {
                backend.stop().unwrap();
            } else {
                backend.pause().unwrap();
            }
            assert_eq!(backend.shared.fade_frames.load(Ordering::Relaxed), 1_600);
        }
    }

    fn open_pcm(samples: &[i16], rate: u32, channels: u16) -> (OpenedReader, MediaInfo) {
        let bytes = (samples.len() * 2) as u32;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&rate.to_le_bytes());
        wav.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
        wav.extend_from_slice(&(channels * 2).to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&bytes.to_le_bytes());
        for sample in samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        open_media(
            MediaSourceStream::new(Box::new(std::io::Cursor::new(wav)), Default::default()),
            Some("wav"),
        )
        .unwrap()
    }

    fn prepare_pcm(
        backend: &mut CpalBackend,
        samples: &[i16],
        rate: u32,
        channels: u16,
        crossfade_ms: u64,
    ) -> PrepareResult {
        let (opened, info) = open_pcm(samples, rate, channels);
        backend
            .prepare_opened(
                opened,
                info,
                NextTrack {
                    uri: "memory.wav".into(),
                    track_id: "next".into(),
                    generation: 7,
                    crossfade_ms,
                },
            )
            .unwrap()
    }

    fn wait_for_prepared(backend: &CpalBackend) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if backend
                .shared
                .next
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .deck
                .eof
                .load(Ordering::Acquire)
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "next decoder did not finish"
            );
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    fn compressed_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/compressed")
            .join(name)
    }

    fn open_compressed(name: &str) -> (OpenedReader, MediaInfo) {
        // No extension hint: eligibility must come from the demuxed codec.
        open_media(
            MediaSourceStream::new(
                Box::new(File::open(compressed_path(name)).unwrap()),
                Default::default(),
            ),
            None,
        )
        .unwrap()
    }

    fn decoded_compressed(name: &str) -> CpalBackend {
        let (opened, info) = open_compressed(name);
        decoded_opened_fixture(opened, info, 44_100, 1)
    }

    fn prepare_compressed(
        backend: &mut CpalBackend,
        name: &str,
        crossfade_ms: u64,
    ) -> PrepareResult {
        backend
            .prepare_next(NextTrack {
                uri: compressed_path(name).to_str().unwrap().into(),
                track_id: name.into(),
                generation: 7,
                crossfade_ms,
            })
            .unwrap()
    }

    fn decoded_samples(backend: &CpalBackend) -> Vec<f32> {
        backend
            .shared
            .current_deck()
            .samples
            .lock()
            .unwrap()
            .iter()
            .copied()
            .collect()
    }

    #[test]
    fn compressed_decoders_preserve_verified_lengths_and_report_untrimmed_formats() {
        for (name, frames, delay, padding, gapless) in [
            ("a.mp3", 10_000, Some(1105), Some(415), true),
            ("b.mp3", 12_345, Some(1105), Some(374), true),
            ("a-no-xing.mp3", 11_520, None, None, false),
            ("a-xing-no-lame.mp3", 11_520, Some(0), Some(0), false),
            ("a-exact-timescale.m4a", 11_264, None, None, false),
            ("b-exact-timescale.m4a", 14_336, None, None, false),
            ("a.flac", 10_000, None, None, true),
            ("a-alac.m4a", 10_000, None, None, true),
        ] {
            let (opened, info) = open_compressed(name);
            let params = &opened.reader.default_track().unwrap().codec_params;
            assert_eq!(params.delay, delay, "{name} delay");
            assert_eq!(params.padding, padding, "{name} padding");
            assert_eq!(opened.gapless_supported, gapless, "{name} capability");
            assert_eq!(info.sample_rate, Some(44_100));
            let backend = decoded_opened_fixture(opened, info, 44_100, 1);
            assert_eq!(
                decoded_samples(&backend).len(),
                frames,
                "{name} frame count"
            );
            assert!(!backend
                .shared
                .current_deck()
                .decode_error
                .load(Ordering::Acquire));
            // Bypassed formats remain available to ordinary playback.
            backend.shared.playing.store(true, Ordering::Relaxed);
            let mut out = vec![0.0; frames];
            write_samples(&mut out, &backend.shared, 1);
            assert!(out.iter().all(|sample| sample.is_finite()));
            assert!(
                out.iter().any(|sample| sample.abs() > 0.1),
                "{name} playback"
            );
        }
    }

    #[test]
    fn mp3_zero_tail_padding_remains_eligible_but_missing_trim_evidence_does_not() {
        let (opened, _) = open_compressed("a.mp3");
        let mut params = opened.reader.default_track().unwrap().codec_params.clone();
        // A LAME-compatible stream may end at the last decoded sample. Zero
        // tail padding does not erase the independently established delay.
        params.padding = Some(0);
        assert!(supports_gapless(&params));
        params.padding = None;
        assert!(!supports_gapless(&params));
        params.padding = Some(0);
        params.n_frames = None;
        assert!(!supports_gapless(&params));
    }

    #[test]
    fn gapless_mp3_decodes_join_unequal_lengths_sample_for_sample() {
        for (current, next) in [("a.mp3", "b.mp3"), ("b.mp3", "a.mp3")] {
            let mut backend = decoded_compressed(current);
            let mut expected = decoded_samples(&backend);
            // Decode the incoming track independently before preparing it again.
            let incoming = decoded_samples(&decoded_compressed(next));
            let incoming_frames = incoming.len();
            expected.extend(incoming);
            assert!(matches!(
                prepare_compressed(&mut backend, next, 0),
                PrepareResult::Prepared(_)
            ));
            wait_for_prepared(&backend);
            backend.shared.playing.store(true, Ordering::Relaxed);
            let mut out = vec![0.0; expected.len()];
            for block in out.chunks_mut(257) {
                write_samples(block, &backend.shared, 1);
            }
            for (index, (actual, expected)) in out.iter().zip(expected).enumerate() {
                assert_eq!(*actual, expected, "{current} -> {next}, sample {index}");
            }
            assert_eq!(
                backend
                    .shared
                    .current_deck()
                    .frames_played
                    .load(Ordering::Relaxed),
                incoming_frames as u64
            );
            assert!(matches!(
                backend.take_next_event(),
                Some(NextEvent::Transitioned { .. })
            ));
            assert!(backend.take_next_event().is_none());
        }
    }

    #[test]
    fn unverified_compressed_gapless_bypasses_both_directions_but_crossfade_plays() {
        for unverified in [
            "a-no-xing.mp3",
            "a-xing-no-lame.mp3",
            "a-exact-timescale.m4a",
        ] {
            for (current, next) in [("a.mp3", unverified), (unverified, "a.mp3")] {
                let mut backend = decoded_compressed(current);
                assert!(
                    matches!(
                        prepare_compressed(&mut backend, next, 0),
                        PrepareResult::Bypassed { reason } if reason.contains("verified delay/padding")
                    ),
                    "{current} -> {next}"
                );
                assert!(backend.shared.next.lock().unwrap().is_none());
                assert!(matches!(
                    prepare_compressed(&mut backend, next, 5),
                    PrepareResult::Prepared(_)
                ));
                wait_for_prepared(&backend);
                let outgoing_frames = decoded_samples(&backend).len();
                let incoming_frames = backend
                    .shared
                    .next
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .deck
                    .samples
                    .lock()
                    .unwrap()
                    .len();
                let mut out = vec![0.0; outgoing_frames + incoming_frames - 220];
                backend.shared.playing.store(true, Ordering::Relaxed);
                write_samples(&mut out, &backend.shared, 1);
                assert!(out
                    .iter()
                    .all(|sample| sample.is_finite() && sample.abs() <= 1.0));
                assert!(matches!(
                    backend.take_next_event(),
                    Some(NextEvent::Transitioned { .. })
                ));
                assert_eq!(
                    backend
                        .shared
                        .current_deck()
                        .frames_played
                        .load(Ordering::Relaxed),
                    incoming_frames as u64
                );
            }
        }
    }

    #[test]
    fn gapless_capability_follows_load_pending_load_and_committed_transition() {
        let mut backend = decoded_compressed("a.mp3");
        // spawn_now is the common immediate/pending load commit; both directions
        // must replace the outgoing source's capability.
        for name in ["a-exact-timescale.m4a", "a.mp3"] {
            backend.stop_decoder();
            backend.clear_buffers();
            let (opened, info) = open_compressed(name);
            backend.source_rate = info.sample_rate;
            backend.duration_ms = info.duration_ms;
            backend.spawn_now(opened).unwrap();
            wait_for_eof(&backend);
            assert_eq!(
                matches!(
                    prepare_compressed(&mut backend, "b.mp3", 0),
                    PrepareResult::Prepared(_)
                ),
                name == "a.mp3"
            );
            backend.clear_next();
        }
        for name in ["a-exact-timescale.m4a", "a.mp3"] {
            let (opened, info) = open_compressed(name);
            backend.pending_load = Some(PendingLoad {
                opened,
                info,
                play_after: false,
            });
            assert!(matches!(
                prepare_compressed(&mut backend, "b.mp3", 0),
                PrepareResult::Bypassed { .. }
            ));
            backend.spawn_pending();
            wait_for_eof(&backend);
            assert_eq!(
                matches!(
                    prepare_compressed(&mut backend, "b.mp3", 0),
                    PrepareResult::Prepared(_)
                ),
                name == "a.mp3"
            );
            backend.clear_next();
        }
        // Positive crossfade can promote an ineligible track. Its eligibility
        // becomes current only when the actor consumes the real callback event.
        for name in ["a-exact-timescale.m4a", "a.mp3"] {
            assert!(matches!(
                prepare_compressed(&mut backend, name, 5),
                PrepareResult::Prepared(_)
            ));
            wait_for_prepared(&backend);
            let frames = decoded_samples(&backend).len();
            backend
                .shared
                .fade_gain
                .store(1.0f32.to_bits(), Ordering::Relaxed);
            backend.shared.playing.store(true, Ordering::Relaxed);
            write_samples(&mut vec![0.0; frames], &backend.shared, 1);
            assert!(matches!(
                backend.take_next_event(),
                Some(NextEvent::Transitioned { .. })
            ));
            assert_eq!(
                matches!(
                    prepare_compressed(&mut backend, "b.mp3", 0),
                    PrepareResult::Prepared(_)
                ),
                name == "a.mp3"
            );
            backend.clear_next();
        }
    }

    #[test]
    fn gapless_decoded_sources_share_one_callback_without_padding_or_overlap() {
        let mut backend = decoded_fixture();
        backend.shared.device_rate.store(8_000, Ordering::Relaxed);
        let next = [1000, 2000, -3000, 4000];
        assert!(matches!(
            prepare_pcm(&mut backend, &next, 8_000, 1, 0),
            PrepareResult::Prepared(_)
        ));
        wait_for_prepared(&backend);
        backend.shared.playing.store(true, Ordering::Relaxed);
        let mut out = vec![0.0; 8004];
        write_samples(&mut out, &backend.shared, 1);
        for (i, sample) in out[..8000].iter().enumerate() {
            assert!(
                (*sample - i as f32 / 32768.0).abs() < 1e-6,
                "outgoing sample {i}"
            );
        }
        for (actual, expected) in out[8000..].iter().zip(next) {
            assert!((*actual - expected as f32 / 32768.0).abs() < 1e-6);
        }
        assert_eq!(
            backend
                .shared
                .current_deck()
                .frames_played
                .load(Ordering::Relaxed),
            4
        );
        assert!(matches!(
            backend.take_next_event(),
            Some(NextEvent::Transitioned {
                from_generation: 7,
                ..
            })
        ));
        assert!(backend.take_next_event().is_none());
    }

    #[test]
    fn crossfade_mixes_two_decoded_sources_and_limits_correlated_peaks() {
        for incoming in [8192, 32767, -32767] {
            let mut backend = decoded_fixture();
            backend.shared.device_rate.store(8_000, Ordering::Relaxed);
            backend
                .shared
                .current_deck()
                .samples
                .lock()
                .unwrap()
                .clear();
            backend
                .shared
                .current_deck()
                .samples
                .lock()
                .unwrap()
                .extend([0.999; 8]);
            assert!(matches!(
                prepare_pcm(&mut backend, &[incoming; 16], 8_000, 1, 1),
                PrepareResult::Prepared(_)
            ));
            wait_for_prepared(&backend);
            backend.shared.playing.store(true, Ordering::Relaxed);
            let mut out = [0.0; 16];
            write_samples(&mut out, &backend.shared, 1);
            let (a, b) = overlap_gains(3, 8);
            let expected = soft_limit(0.999 * a + incoming as f32 / 32768.0 * b, 0.98);
            assert!((out[3] - expected).abs() < 1e-6);
            assert!(a > 0.0 && b > 0.0);
            assert!(out
                .iter()
                .all(|sample| sample.is_finite() && sample.abs() <= 1.0));
            assert_eq!(
                backend
                    .shared
                    .current_deck()
                    .frames_played
                    .load(Ordering::Relaxed),
                16
            );
            assert!(matches!(
                backend.take_next_event(),
                Some(NextEvent::Transitioned { .. })
            ));
        }
    }

    #[test]
    fn different_rates_gapless_is_explicitly_bypassed_but_crossfade_resamples() {
        let mut backend = decoded_fixture();
        backend.shared.device_rate.store(8_000, Ordering::Relaxed);
        assert!(matches!(
            prepare_pcm(&mut backend, &[1000; 8], 4_000, 2, 0),
            PrepareResult::Bypassed { .. }
        ));
        assert!(backend.shared.next.lock().unwrap().is_none());
        assert!(matches!(
            prepare_pcm(&mut backend, &[1000; 8], 4_000, 2, 1),
            PrepareResult::Prepared(_)
        ));
        wait_for_prepared(&backend);
        let next = backend.shared.next.lock().unwrap();
        // Four stereo source frames at 4 kHz become eight mono frames at 8 kHz.
        let samples = next.as_ref().unwrap().deck.samples.lock().unwrap();
        assert_eq!(samples.len(), 8);
        assert!(samples
            .iter()
            .all(|sample| (*sample - 1000.0 / 32768.0).abs() < 1e-6));

        // The outgoing source's native rate also matters, even though its queue
        // has already been resampled to the device rate.
        let (opened, info) = open_pcm(&[1000; 8], 4_000, 1);
        let mut converted_current = decoded_opened_fixture(opened, info, 8_000, 1);
        assert!(matches!(
            prepare_pcm(&mut converted_current, &[1000; 8], 8_000, 1, 0),
            PrepareResult::Bypassed { .. }
        ));
        assert!(matches!(
            prepare_pcm(&mut converted_current, &[1000; 8], 8_000, 1, 1),
            PrepareResult::Prepared(_)
        ));
    }

    #[test]
    fn crossfade_of_unrelated_tones_tracks_the_sample_clock_without_actor_ticks() {
        let mut backend = decoded_fixture();
        backend.shared.device_rate.store(8_000, Ordering::Relaxed);
        let old: Vec<f32> = (0..800)
            .map(|i| (i as f32 * 397.0 * std::f32::consts::TAU / 8_000.0).sin())
            .collect();
        let new: Vec<i16> = (0..1600)
            .map(|i| ((i as f32 * 701.0 * std::f32::consts::TAU / 8_000.0).sin() * 32767.0) as i16)
            .collect();
        backend
            .shared
            .current_deck()
            .samples
            .lock()
            .unwrap()
            .clear();
        backend
            .shared
            .current_deck()
            .samples
            .lock()
            .unwrap()
            .extend(old.iter().copied());
        prepare_pcm(&mut backend, &new, 8_000, 1, 100);
        wait_for_prepared(&backend);
        backend.shared.playing.store(true, Ordering::Relaxed);
        let mut out = vec![0.0; 1600];
        // Deliberately no maintain()/actor ticks between or during these blocks.
        for block in out.chunks_mut(113) {
            write_samples(block, &backend.shared, 1);
        }
        for index in 0..800 {
            let (a, b) = overlap_gains(index as u64, 800);
            let expected = soft_limit(old[index] * a + new[index] as f32 / 32768.0 * b, 0.98);
            assert!((out[index] - expected).abs() < 1e-6, "sample {index}");
        }
        assert!(out
            .iter()
            .all(|sample| sample.is_finite() && sample.abs() <= 1.0));
        assert!(matches!(
            backend.take_next_event(),
            Some(NextEvent::Transitioned { .. })
        ));
    }

    #[test]
    fn failed_next_decoder_preserves_outgoing_audio_and_natural_end() {
        let mut backend = decoded_fixture();
        backend.shared.device_rate.store(8_000, Ordering::Relaxed);
        prepare_pcm(&mut backend, &[1000; 8], 8_000, 1, 0);
        wait_for_prepared(&backend);
        backend
            .shared
            .next
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .deck
            .flag_decode_error();
        backend.shared.playing.store(true, Ordering::Relaxed);
        let mut out = vec![0.0; 8_000];
        write_samples(&mut out, &backend.shared, 1);
        assert!((out[100] - 100.0 / 32768.0).abs() < 1e-6);
        assert!(backend.finished());
        assert!(!backend.take_decode_failure());
        assert!(matches!(
            backend.take_next_event(),
            Some(NextEvent::Bypassed { .. })
        ));
    }

    #[test]
    fn unready_next_never_promotes_an_empty_deck() {
        let mut backend = decoded_fixture();
        backend.shared.device_rate.store(8_000, Ordering::Relaxed);
        *backend.shared.next.lock().unwrap() = Some(PreparedDeck {
            deck: Arc::new(Deck::new()),
            request: NextTrack {
                uri: "slow.wav".into(),
                track_id: "next".into(),
                generation: 7,
                crossfade_ms: 0,
            },
            info: MediaInfo::default(),
            gapless_supported: false,
            overlap_frames: None,
            mixed_frames: 0,
        });
        let current = backend.shared.current_deck();
        backend.shared.playing.store(true, Ordering::Relaxed);
        write_samples(&mut vec![0.0; 8004], &backend.shared, 1);
        assert!(Arc::ptr_eq(&current, &backend.shared.current_deck()));
        assert!(backend.finished());
        assert!(matches!(
            backend.take_next_event(),
            Some(NextEvent::Bypassed { .. })
        ));
    }

    #[test]
    fn cancellation_preserves_an_already_completed_transition_event() {
        let mut backend = decoded_fixture();
        backend.shared.device_rate.store(8_000, Ordering::Relaxed);
        prepare_pcm(&mut backend, &[1000; 1000], 8_000, 1, 0);
        wait_for_prepared(&backend);
        backend.shared.playing.store(true, Ordering::Relaxed);
        write_samples(&mut vec![0.0; 8001], &backend.shared, 1);
        backend.clear_next();
        assert!(backend.next_decoder.is_some());
        assert!(matches!(
            backend.take_next_event(),
            Some(NextEvent::Transitioned { .. })
        ));
        assert!(backend.next_decoder.is_none());
        backend.seek(0).unwrap();
        assert_eq!(backend.position_ms(), 0);
    }

    fn rejecting_seek_fixture() -> (CpalBackend, Arc<AtomicBool>) {
        let mut backend = decoded_fixture();
        backend.stop_decoder();
        backend
            .shared
            .current_deck()
            .frames_played
            .store(4_000, Ordering::Relaxed);
        let stop = Arc::new(AtomicBool::new(false));
        let seek_to = Arc::new(Mutex::new(None::<SeekRequest>));
        let reject = Arc::new(AtomicBool::new(true));
        let worker_stop = stop.clone();
        let worker_seek = seek_to.clone();
        let worker_reject = reject.clone();
        let shared = backend.shared.clone();
        let handle = std::thread::spawn(move || {
            while !worker_stop.load(Ordering::Relaxed) {
                let request = worker_seek.lock().unwrap().take();
                if let Some(request) = request {
                    let result = if worker_reject.load(Ordering::Relaxed) {
                        Err(AudioError::DecodeFailed("test seek rejected".into()))
                    } else {
                        shared
                            .current_deck()
                            .frames_played
                            .store(0, Ordering::Relaxed);
                        Ok(())
                    };
                    let _ = request.reply.send(result);
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        });
        backend.decoder = Some((handle, DecoderCtl { stop, seek_to }));
        (backend, reject)
    }

    #[test]
    fn failed_stop_is_reported_and_blocks_play_until_reset_succeeds() {
        let (mut backend, reject) = rejecting_seek_fixture();
        assert!(backend.stop().is_err());
        assert_eq!(backend.position_ms(), 500);
        assert!(backend
            .play()
            .unwrap_err()
            .to_string()
            .contains("stop reset failed"));
        assert!(!backend.shared.playing.load(Ordering::Relaxed));
        reject.store(false, Ordering::Relaxed);
        backend.stop().unwrap();
        assert!(backend.stop_error.is_none());
        assert_eq!(backend.position_ms(), 0);
    }

    #[test]
    fn delayed_stop_failure_reports_once_without_auto_advance() {
        let (mut backend, _) = rejecting_seek_fixture();
        backend.shared.playing.store(true, Ordering::Relaxed);
        backend.stop().unwrap();
        backend.shared.fade_frames.store(0, Ordering::Relaxed);
        backend.maintain();
        assert!(backend.take_transport_error().is_some());
        backend.maintain();
        assert!(backend.take_transport_error().is_none());
        backend.shared.flag_decode_error();
        assert!(!backend.take_decode_failure());
        assert!(!backend.finished());
        assert!(backend
            .play()
            .unwrap_err()
            .to_string()
            .contains("stop reset failed"));
        assert_eq!(backend.position_ms(), 500);
    }

    #[test]
    fn play_during_pending_stop_propagates_reset_failure() {
        let (mut backend, _) = rejecting_seek_fixture();
        backend.shared.playing.store(true, Ordering::Relaxed);
        backend.stop().unwrap();
        assert!(backend
            .play()
            .unwrap_err()
            .to_string()
            .contains("test seek rejected"));
        assert!(!backend.shared.playing.load(Ordering::Relaxed));
        assert!(backend.stop_error.is_some());
    }

    #[test]
    fn unclaimed_seek_timeout_removes_request_before_decoder_resumes() {
        let seek_to = Arc::new(Mutex::new(None::<SeekRequest>));
        let worker_seek = seek_to.clone();
        let (release, resume) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            resume.recv().unwrap();
            assert!(worker_seek.lock().unwrap().take().is_none());
        });
        let control = DecoderCtl {
            stop: Arc::new(AtomicBool::new(false)),
            seek_to,
        };
        let started = std::time::Instant::now();
        let result = control.seek(&handle, 637, std::time::Duration::from_millis(40));
        let elapsed = started.elapsed();
        let removed = control.seek_to.lock().unwrap().is_none();
        release.send(()).unwrap();
        handle.join().unwrap();
        assert!(result.unwrap_err().to_string().contains("timed out"));
        assert!(removed);
        assert!(elapsed < std::time::Duration::from_secs(1));
    }

    #[test]
    fn seek_after_eof_discards_samples_before_the_exact_target() {
        let mut backend = decoded_fixture();
        backend.seek(637).unwrap();
        wait_for_eof(&backend);
        assert_eq!(backend.position_ms(), 637);
        let deck = backend.shared.current_deck();
        let samples = deck.samples.lock().unwrap();
        assert_eq!(samples.len(), 8_000 - 5_096);
        assert!((samples[0] - 5_096.0 / 32_768.0).abs() < 1e-6);
        assert!(!backend.decoder.as_ref().unwrap().0.is_finished());
    }

    #[test]
    fn stop_after_eof_rewinds_and_stops_consumption() {
        let mut backend = decoded_fixture();
        backend.seek(637).unwrap();
        wait_for_eof(&backend);
        backend.shared.playing.store(true, Ordering::Relaxed);
        backend.stop().unwrap();
        backend.shared.fade_frames.store(0, Ordering::Relaxed);
        backend.maintain();
        wait_for_eof(&backend);
        assert_eq!(backend.position_ms(), 0);
        assert!(!backend.shared.playing.load(Ordering::Relaxed));
        let mut output = [1.0; 128];
        write_samples(&mut output, &backend.shared, 1);
        assert_eq!(output, [0.0; 128]);
        assert_eq!(
            backend.shared.current_deck().samples.lock().unwrap().len(),
            8_000
        );
        backend.shared.playing.store(true, Ordering::Relaxed);
        write_samples(&mut output, &backend.shared, 1);
        assert_eq!(backend.position_ms(), 16);
    }

    #[test]
    fn natural_end_waits_for_all_samples_even_without_duration() {
        let mut backend = decoded_fixture();
        backend.duration_ms = None;
        backend.shared.playing.store(true, Ordering::Relaxed);
        let mut output = vec![0.0; 7_999];
        write_samples(&mut output, &backend.shared, 1);
        assert!(!backend.finished());
        write_samples(&mut [0.0], &backend.shared, 1);
        assert!(backend.finished());
        backend.seek(0).unwrap();
        wait_for_eof(&backend);
        assert!(!backend.finished());
    }

    #[test]
    fn volume_applies_to_already_buffered_samples() {
        let shared = Shared::new();
        shared.playing.store(true, Ordering::Relaxed);
        shared
            .current_deck()
            .samples
            .lock()
            .unwrap()
            .extend([0.5; 4]);
        shared.volume.store(0.25f32.to_bits(), Ordering::Relaxed);
        let mut output = [0.0; 4];
        write_samples(&mut output, &shared, 1);
        assert_eq!(output, [0.125; 4]);
    }

    #[test]
    fn tail_fade_uses_decoded_frames_instead_of_estimated_duration() {
        let mut backend = decoded_fixture();
        backend.duration_ms = Some(100);
        backend.shared.playing.store(true, Ordering::Relaxed);
        backend.maintain();
        assert!(!backend.tail_armed);
        write_samples(&mut vec![0.0; 7_000], &backend.shared, 1);
        backend.maintain();
        assert!(backend.tail_armed);
        assert_eq!(backend.shared.fade_frames.load(Ordering::Relaxed), 1_000);
    }

    #[test]
    fn seek_failure_preserves_position_and_end_pause_prevents_implicit_resume() {
        let mut backend = decoded_fixture();
        backend.duration_ms = None;
        assert!(backend.seek(10_000).is_err());
        assert_eq!(backend.position_ms(), 0);
        assert_eq!(
            backend.shared.current_deck().samples.lock().unwrap().len(),
            8_000
        );
        backend.shared.playing.store(true, Ordering::Relaxed);
        write_samples(&mut vec![0.0; 8_000], &backend.shared, 1);
        assert!(backend.finished());
        backend.pause().unwrap();
        backend.seek(637).unwrap();
        wait_for_eof(&backend);
        write_samples(&mut [0.0; 128], &backend.shared, 1);
        assert_eq!(backend.position_ms(), 637);
        assert!(!backend.shared.playing.load(Ordering::Relaxed));
    }

    #[test]
    fn decoder_failure_stops_buffered_audio_and_is_reported_once() {
        let mut backend = decoded_fixture();
        backend.shared.playing.store(true, Ordering::Relaxed);
        backend.shared.flag_decode_error();
        assert!(backend.take_decode_failure());
        assert!(!backend.take_decode_failure());
        let mut output = [1.0; 128];
        write_samples(&mut output, &backend.shared, 1);
        assert_eq!(output, [0.0; 128]);
        assert_eq!(backend.position_ms(), 0);
        assert!(backend
            .shared
            .current_deck()
            .samples
            .lock()
            .unwrap()
            .is_empty());
        assert!(!backend.finished());
    }

    #[test]
    fn uri_accepts_plain_path_and_file_uri() {
        assert_eq!(uri_to_path("/tmp/a.flac"), PathBuf::from("/tmp/a.flac"));
        assert_eq!(
            uri_to_path("file:///tmp/a.flac"),
            PathBuf::from("/tmp/a.flac")
        );
    }

    #[test]
    fn channel_mapping_covers_the_common_cases() {
        let stereo = vec![1.0f32, 2.0, 3.0, 4.0];
        assert_eq!(map_channels(&stereo, 2, 2), stereo);
        assert_eq!(map_channels(&stereo, 2, 1), vec![1.5, 3.5]);
        assert_eq!(map_channels(&[1.0, 2.0], 1, 2), vec![1.0, 1.0, 2.0, 2.0]);
    }

    /// Regression: the callback used to ignore `playing`, so pausing only
    /// flipped a flag while audio kept draining the queue — the UI said paused
    /// but sound and position continued.
    #[test]
    fn paused_callback_leaves_the_queue_untouched() {
        let shared = Shared::new();
        shared.playing.store(false, Ordering::Relaxed);
        {
            let deck = shared.current_deck();
            let mut q = deck.samples.lock().unwrap();
            q.extend([0.5f32; 16]);
        }

        let mut buf = vec![1.0f32; 8];
        write_samples(&mut buf, &shared, 2);

        assert!(
            buf.iter().all(|s| *s == 0.0),
            "paused output must be silent"
        );
        assert_eq!(
            shared.current_deck().frames_played.load(Ordering::Relaxed),
            0,
            "position must not advance while paused"
        );
        assert_eq!(
            shared.current_deck().samples.lock().unwrap().len(),
            16,
            "the queue must not be drained while paused"
        );
    }

    #[test]
    fn ramp_value_is_linear_and_clamped() {
        assert_eq!(Shared::ramp_value(0.0, 1.0, 100, 0), 0.0);
        assert!((Shared::ramp_value(0.0, 1.0, 100, 50) - 0.5).abs() < 1e-6);
        assert_eq!(Shared::ramp_value(0.0, 1.0, 100, 100), 1.0);
        assert_eq!(Shared::ramp_value(0.0, 1.0, 100, 500), 1.0);
        assert_eq!(Shared::ramp_value(0.0, 1.0, 0, 0), 1.0);
    }

    #[test]
    fn fade_in_callback_grows_sample_gain_across_frames() {
        let shared = Shared::new();
        shared.playing.store(true, Ordering::Relaxed);
        // 2 声道、48k：250ms 淡入 = 12000 帧；放 4 帧数据验证趋势。
        // 先 arm 再 reset 再 arm，钉死「换装复位不会留下脏斜坡」这条路径。
        shared.arm_fade(1.0, FADE_IN_MS, 48_000);
        shared.reset_fade_shared();
        shared.arm_fade(1.0, FADE_IN_MS, 48_000);
        // 队列里放 8 个样本（4 帧），全为 1。
        shared
            .current_deck()
            .samples
            .lock()
            .unwrap()
            .extend([1.0f32; 8]);
        let mut buf = vec![0.0f32; 8];
        write_samples(&mut buf, &shared, 2);
        // 淡入起点增益≈0：首帧样本幅值小于末帧。
        assert!(buf[0].abs() < buf[6].abs());
        assert!(buf[0] >= 0.0 && buf[0] < 0.01);
        assert!(shared.fade_active());
    }

    /// 自然 EOF 的尾部淡出按「剩余帧数」武装斜坡，而斜坡只在回调真的拷到
    /// 音频帧时推进。缓冲里的实际帧数受重采样/取整影响未必凑得满斜坡：
    /// 缓冲见底后 copied==0，斜坡永远停在半路，`fade_active()` 永远为真，
    /// maintain 的换装（连带暂停/停止收口）全部饿死 —— 表现为自动接力的
    /// 下一首（以及随后的一切换装）永远卡在上一首的结束位置，无声。
    /// 回归：缓冲干涸时斜坡必须落到终点。
    #[test]
    fn stalled_fade_completes_when_the_buffer_runs_dry() {
        let shared = Shared::new();
        shared.playing.store(true, Ordering::Relaxed);
        // 模拟尾部淡出：直接按帧数武装一条 0.x→0 的斜坡（与 maintain 的
        // 尾部武装同构），缓冲里只留 2 帧音频 —— 比斜坡短。
        shared.fade_from.store(0.8f32.to_bits(), Ordering::Relaxed);
        shared.fade_to.store(0.0f32.to_bits(), Ordering::Relaxed);
        shared.fade_gain.store(0.8f32.to_bits(), Ordering::Relaxed);
        shared.fade_frames.store(100, Ordering::Relaxed);
        shared.fade_done.store(0, Ordering::Relaxed);
        shared
            .current_deck()
            .samples
            .lock()
            .unwrap()
            .extend([0.5f32; 4]);
        let mut buf = vec![0.0f32; 4];

        // 第一轮回调：拷走仅有的 2 帧，斜坡只推进 2/100。
        write_samples(&mut buf, &shared, 2);
        assert!(shared.fade_active(), "斜坡未走完前必须仍处于武装态");
        assert!(
            f32::from_bits(shared.fade_gain.load(Ordering::Relaxed)) < 0.8,
            "拷贝到的帧必须推进斜坡"
        );

        // 缓冲已干：再次回调不允许把斜坡永远卡在半路。
        write_samples(&mut buf, &shared, 2);
        assert!(
            !shared.fade_active(),
            "缓冲干涸时斜坡必须落到终点（否则换装/暂停/停止永久饿死）"
        );
        assert_eq!(
            f32::from_bits(shared.fade_gain.load(Ordering::Relaxed)),
            0.0,
            "终点增益取 fade_to（尾部淡出 = 静音）"
        );
        assert_eq!(shared.fade_done.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn resampler_passes_through_when_rates_match() {
        let mut r = Resampler::new(48_000, 48_000);
        let input = vec![0.1f32, 0.2, 0.3, 0.4];
        assert_eq!(r.push(&input, 2), input);
    }

    #[test]
    fn resampler_changes_length_when_rates_differ() {
        let (src, dst) = (44_100u32, 48_000u32);
        let channels = 2;
        let frames_in = 2_205usize;
        let mut r = Resampler::new(src, dst);
        // `push` takes interleaved samples, so the buffer holds frames * channels.
        let input: Vec<f32> = (0..frames_in * channels)
            .map(|i| (i % 97) as f32 / 97.0)
            .collect();
        let out = r.push(&input, channels);
        let out_frames = out.len() / channels;
        // Expect the rate ratio, not a hand-copied constant: 2205 frames at
        // 44.1 kHz is 50 ms, which is 2400 frames at 48 kHz.
        let expected = (frames_in as f64 * dst as f64 / src as f64).round() as i64;
        assert!(
            (out_frames as i64 - expected).abs() <= 2,
            "unexpected frame count {out_frames}, expected about {expected}"
        );
    }

    #[test]
    fn is_interrupted_recognises_abort_along_the_error_chain() {
        use std::io;
        // 下载 abort：HttpMediaSource 直接返回 Interrupted，symphonia 包进
        // IoError 变体——中止候选，不是早夭。
        let aborted = SymError::IoError(io::Error::new(io::ErrorKind::Interrupted, "aborted"));
        assert!(is_interrupted(&aborted));
        // 自然 EOF：干净结束候选，不能当中止也不能当早夭。
        let eof = SymError::IoError(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "end of stream",
        ));
        assert!(!is_interrupted(&eof));
        // 与 I/O 无关的 symphonia 错误：早夭候选。
        assert!(!is_interrupted(&SymError::ResetRequired));
        // Interrupted 被外层 io::Error + IoError 变体埋深一层时，沿 source
        // 链 downcast 仍认得。
        let wrapped = io::Error::other(aborted);
        assert!(is_interrupted(&SymError::IoError(wrapped)));
    }

    #[test]
    fn exit_classification_flags_only_unexpected_deaths() {
        // UnexpectedEof 干净结束：不 flag（stop 位未必置上）。
        assert!(!should_flag_decode_error(false, false, true));
        // Interrupted 主动中止（未下完切歌，stop 位可能尚未被观察到）：不 flag。
        assert!(!should_flag_decode_error(false, true, false));
        // 主动 stop 之后无论何种错误都不 flag。
        assert!(!should_flag_decode_error(true, false, false));
        assert!(!should_flag_decode_error(true, true, true));
        // 其它错误（如下载链路断开）且未 stop：异常早夭，flag 候选。
        assert!(should_flag_decode_error(false, false, false));
    }
}

#[cfg(test)]
mod dsp_tests {
    use super::*;

    #[test]
    fn peaking_filter_zero_gain_is_identity() {
        let mut q = BiQuad::peaking(1000.0, 0.0, 1.2, 48_000);
        // 增益 0 时 b0≈1、b1≈-2cos、a1≈-2cos、其余≈0 → 直通（系数误差 < 1e-9）
        let out = q.process(0.5);
        assert!((out - 0.5).abs() < 1e-6, "identity violated: {out}");
    }

    #[test]
    fn peaking_filter_boosts_band_center() {
        // +12dB @1kHz：以 1kHz 正弦（数值上直接喂常数不合适，喂极低频近似直流，
        // 低频段增益应接近 1）。这里直接验证系数能量：中心频率处幅度比 > 1。
        let q = BiQuad::peaking(1000.0, 12.0, 1.2, 48_000);
        // 中心频率增益 |b0+b1 z+b2 z²|/|1+a1 z+a2 z²| 在 z=e^{-jw0} 处 ≈ 10^(12/20)
        // 简化：直接断言 b0 > a0 归一化后的 1（有增益）
        assert!(q.b0 > 1.0);
    }

    #[test]
    fn limiter_is_transparent_below_ceiling_and_caps_above() {
        for nonfinite in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(soft_limit(nonfinite, 0.98), 0.0);
        }
        assert_eq!(soft_limit(0.5, 0.98), 0.5);
        assert_eq!(soft_limit(-0.5, 0.98), -0.5);
        let loud = soft_limit(1.5, 0.98);
        assert!(
            loud > 0.98 && loud <= 1.0,
            "soft clip must stay bounded: {loud}"
        );
        let neg = soft_limit(-1.5, 0.98);
        assert!((-1.0..=-0.98).contains(&neg));
        assert_eq!(soft_limit(2.5, 0.98), 1.0);
    }

    #[test]
    fn eq_bank_matches_by_rate_gains_channels() {
        let bank = EqBank::new(48_000, [0.0; 6], 2);
        assert!(bank.matches(48_000, &[0.0; 6], 2));
        assert!(!bank.matches(44_100, &[0.0; 6], 2));
        assert!(!bank.matches(48_000, &[1.0, 0.0, 0.0, 0.0, 0.0, 0.0], 2));
        assert!(!bank.matches(48_000, &[0.0; 6], 1));
    }
}
