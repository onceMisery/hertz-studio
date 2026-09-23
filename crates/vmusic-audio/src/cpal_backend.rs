// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! Real playback backend: symphonia decodes, cpal plays, rustfft listens.
//!
//! # Thread layout
//!
//! ```text
//!   decoder thread  ──push──►  samples (VecDeque + Mutex)  ──drain──►  cpal callback
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
use vmusic_core::{AudioBackend, AudioError, AudioSource, DeviceInfo, MediaInfo};

/// Number of mono samples kept for spectrum analysis.
const FFT_SIZE: usize = 2048;
/// How much decoded audio we buffer ahead (seconds).
const BUFFER_SECONDS: f32 = 4.0;
/// Keep every Nth frame in the tap; 4 keeps the tap useful at 48 kHz.
const TAP_STRIDE: usize = 3;
const TAP_LEN: usize = FFT_SIZE * 3;
/// 开播 / 换装后的淡入时长。
const FADE_IN_MS: u64 = 250;
/// 暂停 / 停止 / 切歌时的淡出时长。
const FADE_OUT_MS: u64 = 200;
/// 自然播放到尾部前提前开始淡出的时长。
const TAIL_FADE_MS: u64 = 500;

/// State shared between the decoder thread and the audio callback.
struct Shared {
    samples: Mutex<VecDeque<f32>>,
    tap: Mutex<VecDeque<f32>>,
    volume: AtomicU32,
    playing: AtomicBool,
    frames_played: AtomicU64,
    /// 增益斜坡（单位：设备声道帧）。fade_frames=0 表示无斜坡，增益恒为 fade_gain。
    fade_gain: AtomicU32,
    fade_from: AtomicU32,
    fade_to: AtomicU32,
    fade_frames: AtomicU64,
    fade_done: AtomicU64,
    /// 解码线程异常早夭标志：仅在「非干净 EOF、非主动 stop」的退出时置位，
    /// actor 经 take_decode_failure 每 tick 取走（换装淡出窗口除外）。
    decode_error: AtomicBool,
}

impl Shared {
    fn new() -> Self {
        Self {
            samples: Mutex::new(VecDeque::with_capacity(1 << 16)),
            tap: Mutex::new(VecDeque::with_capacity(TAP_LEN)),
            volume: AtomicU32::new(1.0f32.to_bits()),
            playing: AtomicBool::new(false),
            frames_played: AtomicU64::new(0),
            fade_gain: AtomicU32::new(1.0f32.to_bits()),
            fade_from: AtomicU32::new(1.0f32.to_bits()),
            fade_to: AtomicU32::new(1.0f32.to_bits()),
            fade_frames: AtomicU64::new(0),
            fade_done: AtomicU64::new(0),
            decode_error: AtomicBool::new(false),
        }
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
        self.decode_error.store(true, Ordering::Relaxed);
    }

    /// 取走并清零早夭标志；没有早夭返回 false。
    fn take_decode_error(&self) -> bool {
        self.decode_error.swap(false, Ordering::Relaxed)
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

struct DecoderCtl {
    stop: Arc<AtomicBool>,
    /// `Some(ms)` means "seek here as soon as you can".
    seek_to: Arc<Mutex<Option<u64>>>,
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
    device_rate: u32,
    device_channels: u16,
    duration_ms: Option<u64>,
    fft: Arc<dyn rustfft::Fft<f32>>,
    spectrum_state: Mutex<Vec<f32>>,
    /// 暂停淡出到 0 的瞬间才真正置 playing=false。
    pending_pause: bool,
    /// 停止淡出到 0 的瞬间才 seek 回 0 复位。
    pending_stop: bool,
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
            device_rate,
            device_channels,
            duration_ms: None,
            fft,
            spectrum_state: Mutex::new(Vec::new()),
            pending_pause: false,
            pending_stop: false,
            tail_armed: false,
            pending_load: None,
        })
    }

    fn ensure_stream(&mut self) -> Result<(), AudioError> {
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
        if let Ok(mut q) = self.shared.samples.lock() {
            q.clear();
        }
        if let Ok(mut t) = self.shared.tap.lock() {
            t.clear();
        }
    }

    /// 立即换装（暂停/停止态）或新曲复位时调用：增益归 1、尾部门闩与
    /// pending 标志全部清掉。pending_load 不在此清：换装路径自己决定存不存。
    fn reset_fade(&mut self) {
        self.shared.reset_fade_shared();
        self.tail_armed = false;
        self.pending_pause = false;
        self.pending_stop = false;
    }

    /// 起一个解码线程消费 `opened`。立即换装与 pending 换装共用。
    fn spawn_now(&mut self, opened: OpenedReader) -> Result<(), AudioError> {
        let stop = Arc::new(AtomicBool::new(false));
        let seek_to = Arc::new(Mutex::new(None));
        let ctl = DecoderCtl {
            stop: stop.clone(),
            seek_to: seek_to.clone(),
        };
        let shared = self.shared.clone();
        let device_rate = self.device_rate;
        let device_channels = self.device_channels.max(1) as usize;
        let handle = std::thread::Builder::new()
            .name("vmusic-decoder".into())
            .spawn(move || {
                decode_loop_opened(opened, shared, stop, seek_to, device_rate, device_channels);
            })
            .map_err(|e| AudioError::BackendInit(e.to_string()))?;
        self.decoder = Some((handle, ctl));
        Ok(())
    }

    /// 停止语义的复位动作：seek 回 0、清缓冲、进度归零（duration 保留）。
    fn do_stop_reset(&mut self) {
        let _ = self.seek(0);
        self.clear_buffers();
        self.shared.frames_played.store(0, Ordering::Relaxed);
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
        self.shared.frames_played.store(0, Ordering::Relaxed);
        self.duration_ms = pending.info.duration_ms;
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
        if !audible {
            self.stop_decoder();
            self.clear_buffers();
            // 旧解码线程的早夭位随换装一并作废（stop 与其置位可能竞争），
            // 否则新曲刚加载就会被旧标志误报 DecodeError。
            let _ = self.shared.take_decode_error();
            self.shared.frames_played.store(0, Ordering::Relaxed);
            self.reset_fade();
        }

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
                &FormatOptions::default(),
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
        let decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| AudioError::UnsupportedFormat(e.to_string()))?;

        let opened: OpenedReader = (probed.format, decoder, track_id);
        let info = MediaInfo {
            duration_ms,
            sample_rate,
            channels,
        };

        if audible {
            // 旧源先淡出 200ms，probe 期间旧曲继续出声；maintain 到点换装并
            // 淡入。淡出期间到达的暂停/停止意图优先：换装后保持暂停而非开播。
            let play_after = !self.pending_pause && !self.pending_stop;
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
        self.duration_ms = duration_ms;
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
            self.do_stop_reset();
            self.pending_stop = false;
        }
        if self.pending_load.is_some() && !fading {
            self.spawn_pending();
        }

        // 自然结束前的尾部淡出（仅武装一次；seek 回主体段后可重新武装）。
        // 斜坡进行中（暂停/切歌淡出或本段尾淡出）绝不能覆写斜坡参数。
        if self.shared.playing.load(Ordering::Relaxed)
            && self.pending_load.is_none()
            && !self.pending_stop
            && !self.shared.fade_active()
        {
            if let Some(d) = self.duration_ms {
                let pos = self.position_ms();
                let remain = d.saturating_sub(pos);
                if !self.tail_armed && remain <= TAIL_FADE_MS && remain > 0 {
                    // 直接按剩余帧数装斜坡（不用 arm_fade 的固定毫秒），
                    // 保证增益恰好在最后一帧到 0。
                    let frames = (remain as u128 * self.device_rate as u128 / 1000) as u64;
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
                // 用户拖回主体段：允许再次武装。
                if pos + 100 < d.saturating_sub(TAIL_FADE_MS) {
                    self.tail_armed = false;
                }
            }
        }
    }
}

fn no_device() -> AudioError {
    AudioError::DeviceUnavailable("output device not initialised".into())
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
    let mut copied = 0usize;

    if let Ok(mut queue) = shared.samples.lock() {
        copied = data.len().min(queue.len());
        for (i, sample) in queue.drain(..copied).enumerate() {
            data[i] = sample; // 先放原始样本，tap 要在淡变前取
        }
    }

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
            data[idx] = data[idx] * volume * gain;
        }
    }
    shared.fade_gain.store(gain.to_bits(), Ordering::Relaxed);
    shared.fade_done.store(fade_done, Ordering::Relaxed);
    shared.fade_frames.store(fade_total, Ordering::Relaxed);

    // 缓冲欠载：没填满的部分补 0，不能把上一轮回调的残留样本播出去。
    for sample in data.iter_mut().skip(copied) {
        *sample = 0.0;
    }

    if copied > 0 {
        shared
            .frames_played
            .fetch_add((copied / channels.max(1)) as u64, Ordering::Relaxed);
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
        self.shared.frames_played.store(0, Ordering::Relaxed);
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
        self.ensure_stream()?;
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
            self.do_stop_reset();
        }
        Ok(())
    }

    fn seek(&mut self, position_ms: u64) -> Result<(), AudioError> {
        if let Some((_, ctl)) = &self.decoder {
            *ctl.seek_to.lock().unwrap() = Some(position_ms);
            self.clear_buffers();
            self.shared.frames_played.store(
                ms_to_frames(position_ms, self.device_rate),
                Ordering::Relaxed,
            );
        }
        // 尾段淡出途中 seek：增益正沿尾斜坡滑向 0，而 tail_armed 会阻止
        // 尾部逻辑重新武装——不处理就永远卡在静音。解除门闩，从当前增益
        // 起步装一条 120ms 短回淡（arm_fade 自己读当前 fade_gain 当初值）。
        // 例外：pending_stop 复位时的 seek(0) 是停止动作，不能再淡回来。
        if self.tail_armed {
            self.tail_armed = false;
            if !self.pending_stop {
                self.shared.arm_fade(1.0, 120, self.device_rate);
            }
        }
        Ok(())
    }

    fn set_volume(&mut self, volume: f32) -> Result<(), AudioError> {
        self.shared
            .volume
            .store(volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        Ok(())
    }

    fn position_ms(&self) -> u64 {
        frames_to_ms(
            self.shared.frames_played.load(Ordering::Relaxed),
            self.device_rate,
        )
        .min(self.duration_ms.unwrap_or(u64::MAX))
    }

    fn duration_ms(&self) -> Option<u64> {
        self.duration_ms
    }

    fn finished(&self) -> bool {
        // 换装淡出窗口里旧源耗尽绝不能算「播完」：maintain 马上要换上新源，
        // 此刻报 Ended 会让状态层错误地接力/停播（I1）。
        if self.pending_load.is_some() {
            return false;
        }
        // Finished means "decoder drained the file and we played all of it".
        let drained = self
            .decoder
            .as_ref()
            .map(|(_, ctl)| ctl.stop.load(Ordering::Relaxed))
            .unwrap_or(true);
        if !drained {
            return false;
        }
        match self.duration_ms {
            // Tolerance for rounding in the frame counter, but never so wide
            // that a short clip is "finished" before it has started.
            Some(d) => self.position_ms() + d.div_ceil(4).min(80) >= d,
            None => false,
        }
    }

    fn take_decode_failure(&mut self) -> bool {
        // 换装淡出窗口里旧源的早夭不上报（新源即将接手；旧错误位由
        // spawn_pending 清掉，新解码器若再失败会重新置位）。
        if self.pending_load.is_some() {
            return false;
        }
        self.shared.take_decode_error()
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
}

impl Drop for CpalBackend {
    fn drop(&mut self) {
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
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    seek_to: Arc<Mutex<Option<u64>>>,
    device_rate: u32,
    device_channels: usize,
) {
    let (mut reader, mut decoder, track_id) = opened;

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

    while !stop.load(Ordering::Relaxed) {
        if let Some(target_ms) = seek_to.lock().ok().and_then(|mut g| g.take()) {
            let time = Time::new(target_ms / 1000, (target_ms % 1000) as f64 / 1000.0);
            if let Err(e) = reader.seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time,
                    track_id: Some(track_id),
                },
            ) {
                tracing::warn!("seek failed: {e}");
            }
            decoder.reset();
            resampler.reset();
            if let Ok(mut q) = shared.samples.lock() {
                q.clear();
            }
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
            Ok(packet) => match decoder.decode(&packet) {
                Ok(decoded) => {
                    let spec = *decoded.spec();
                    let frames = decoded.frames();
                    if frames == 0 {
                        continue;
                    }
                    let mut sb = SampleBuffer::<f32>::new(frames as u64, spec);
                    sb.copy_interleaved_ref(decoded);
                    let resampled = resampler.push(sb.samples(), spec.channels.count());
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

type OpenedReader = (
    Box<dyn FormatReader>,
    Box<dyn symphonia::core::codecs::Decoder>,
    u32,
);

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
            let mut q = shared.samples.lock().unwrap();
            q.extend([0.5f32; 16]);
        }

        let mut buf = vec![1.0f32; 8];
        write_samples(&mut buf, &shared, 2);

        assert!(
            buf.iter().all(|s| *s == 0.0),
            "paused output must be silent"
        );
        assert_eq!(
            shared.frames_played.load(Ordering::Relaxed),
            0,
            "position must not advance while paused"
        );
        assert_eq!(
            shared.samples.lock().unwrap().len(),
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
        shared.samples.lock().unwrap().extend([1.0f32; 8]);
        let mut buf = vec![0.0f32; 8];
        write_samples(&mut buf, &shared, 2);
        // 淡入起点增益≈0：首帧样本幅值小于末帧。
        assert!(buf[0].abs() < buf[6].abs());
        assert!(buf[0] >= 0.0 && buf[0] < 0.01);
        assert!(shared.fade_active());
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
