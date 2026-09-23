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

/// State shared between the decoder thread and the audio callback.
struct Shared {
    samples: Mutex<VecDeque<f32>>,
    tap: Mutex<VecDeque<f32>>,
    volume: AtomicU32,
    playing: AtomicBool,
    frames_played: AtomicU64,
}

impl Shared {
    fn new() -> Self {
        Self {
            samples: Mutex::new(VecDeque::with_capacity(1 << 16)),
            tap: Mutex::new(VecDeque::with_capacity(TAP_LEN)),
            volume: AtomicU32::new(1.0f32.to_bits()),
            playing: AtomicBool::new(false),
            frames_played: AtomicU64::new(0),
        }
    }
}

struct DecoderCtl {
    stop: Arc<AtomicBool>,
    /// `Some(ms)` means "seek here as soon as you can".
    seek_to: Arc<Mutex<Option<u64>>>,
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

    /// Task 8 会用真实的淡入淡出斜坡替换；open_and_spawn 换装时必须调用它。
    fn reset_fade(&mut self) {}

    /// probe 时长 → 起解码线程。`load`（本地文件）与 `load_source`（流式源）
    /// 两个入口共用，杜绝双份打开/探测逻辑。
    fn open_and_spawn(
        &mut self,
        mss: MediaSourceStream,
        ext: Option<&str>,
    ) -> Result<MediaInfo, AudioError> {
        self.ensure_stream()?;
        self.stop_decoder();
        self.clear_buffers();
        self.shared.frames_played.store(0, Ordering::Relaxed);
        self.shared.playing.store(false, Ordering::Relaxed);
        self.reset_fade();

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
        self.duration_ms = duration_ms;

        let stop = Arc::new(AtomicBool::new(false));
        let seek_to = Arc::new(Mutex::new(None));
        let ctl = DecoderCtl {
            stop: stop.clone(),
            seek_to: seek_to.clone(),
        };
        let shared = self.shared.clone();
        let device_rate = self.device_rate;
        let device_channels = self.device_channels.max(1) as usize;
        let opened: OpenedReader = (probed.format, decoder, track_id);
        let handle = std::thread::Builder::new()
            .name("vmusic-decoder".into())
            .spawn(move || {
                decode_loop_opened(opened, shared, stop, seek_to, device_rate, device_channels);
            })
            .map_err(|e| AudioError::BackendInit(e.to_string()))?;
        self.decoder = Some((handle, ctl));

        Ok(MediaInfo {
            duration_ms,
            sample_rate,
            channels,
        })
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
            data[i] = sample * volume;
        }
    }
    for sample in data.iter_mut().skip(copied) {
        *sample = 0.0;
    }

    if copied > 0 {
        shared
            .frames_played
            .fetch_add((copied / channels.max(1)) as u64, Ordering::Relaxed);
    }

    // Spectrum tap: cheap, bounded, and skipped entirely under contention.
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
        self.shared.playing.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn pause(&mut self) -> Result<(), AudioError> {
        self.shared.playing.store(false, Ordering::Relaxed);
        Ok(())
    }

    /// 停止 = 暂停 + 回到开头，**保留解码线程**。
    ///
    /// 之前这里会 `stop_decoder()` 杀掉解码线程，但上层的 track_id / playing
    /// 状态并没有清空，于是「点停止 → 再点播放」就变成：playing 置回 true、
    /// 却再没有解码线程往环形缓冲里写数据 —— 界面显示正在播放，实际一声不响，
    /// 进度也永远停在 0。停止语义上不该等于「卸载曲目」，卸载由 load() 负责。
    fn stop(&mut self) -> Result<(), AudioError> {
        self.shared.playing.store(false, Ordering::Relaxed);
        // 解码线程还在就 seek 回 0（seek 内部会清缓冲）；没有解码线程说明
        // 还没 load 过，此时 frames_played 本来就是 0。
        let _ = self.seek(0);
        self.clear_buffers();
        self.shared.frames_played.store(0, Ordering::Relaxed);
        // duration 不清：停止后进度条仍应显示总时长，而不是变回 0:00 / 0:00。
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
                    break;
                }
            },
            Err(SymError::ResetRequired) => {
                decoder.reset();
            }
            Err(_) => break, // end of stream (or unrecoverable I/O)
        }
    }

    tracing::debug!("decoder thread finished for stream");
    stop.store(true, Ordering::Relaxed);
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

impl symphonia::core::io::MediaSource for DynMediaSource {
    fn is_seekable(&self) -> bool {
        true
    }

    /// 流式源（边下边播）往往拿不到总长；返回 None 让 symphonia 仅依赖
    /// 容器自身的元数据。
    fn byte_len(&self) -> Option<u64> {
        None
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
}
