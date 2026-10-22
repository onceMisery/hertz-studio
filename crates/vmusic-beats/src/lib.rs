// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 离线节拍分析：解码 → 单声道重采样 → STFT 频谱通量 → 峰值/BPM/强拍分型。
//!
//! 纯计算库（不碰 cpal、不做网络）。分析主流程拆成 [`analyze_path`]（symphonia
//! 解码）与 [`analyze_mono`]（PCM → 地图）两段，单测直接合成 PCM 喂第二段。

use num_complex::Complex;
use serde::{Deserialize, Serialize};
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use rustfft::FftPlanner;

pub mod pitch;

/// 一拍。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Beat {
    /// 相对曲目开头的毫秒时间，全表严格升序。
    pub t: i64,
    /// 峰强度 0..=1。
    pub strength: f32,
    /// 4/4 强拍标记。
    pub downbeat: bool,
    /// 能量分档 0..=3。
    pub intensity: u8,
}

/// 节拍地图（磁盘缓存与 HTTP 响应共用结构）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BeatMap {
    pub version: u32,
    /// 置信度不足时为 None；峰点仍可用，只失去规整化。
    pub bpm: Option<f64>,
    pub offset_ms: i64,
    /// 只分析了前 720s、尾段按 BPM 推演时为 true。
    pub truncated: bool,
    pub beats: Vec<Beat>,
}

/// 解码/分析失败。[`AnalyzeError::Unsupported`] 表示文件能解但检不出拍
/// （空地图），其余一律 Failed。
#[derive(Debug)]
pub enum AnalyzeError {
    Unsupported(String),
    Failed(String),
}

impl std::fmt::Display for AnalyzeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AnalyzeError::Unsupported(s) | AnalyzeError::Failed(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for AnalyzeError {}

const WINDOW: usize = 1024;
const HOP: usize = 512;
const MEL_BANDS: usize = 26;
const ANALYZE_MS: u64 = 720_000;
const LONG_MS: u64 = 480_000;
const HIGH_RATE: u32 = 22_050;
const LOW_RATE: u32 = 11_025;
/// 拍表本身的版本（分析算法换代才动）。磁盘信封另有自己的编码版本，
/// 见 hertz-studio stage_beats 的 CACHE_FORMAT_VERSION——两者别混。
pub const MAP_VERSION: u32 = 1;

/// 解码文件 → 单声道 → [`analyze_mono`]。只解前 720s（推演补尾段），
/// 避免对整首长曲做无谓解码。
pub fn analyze_path(path: &Path) -> Result<BeatMap, AnalyzeError> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let file = std::fs::File::open(path).map_err(|e| AnalyzeError::Failed(e.to_string()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if !ext.is_empty() {
        hint.with_extension(&ext);
    }
    let mut probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| AnalyzeError::Failed(e.to_string()))?;
    let track = probed
        .format
        .default_track()
        .ok_or_else(|| AnalyzeError::Failed("no audio track".into()))?;
    let params = track.codec_params.clone();
    // 时长优先取容器/帧头（不必整曲解完就知道长度）；缺了再用实际解码样本兜底。
    let header_ms = params.time_base.zip(params.n_frames).map(|(tb, frames)| {
        let time = tb.calc_time(frames);
        ((time.seconds as f64 + time.frac) * 1000.0) as u64
    });
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|e| AnalyzeError::Failed(e.to_string()))?;

    let mut channels: usize = 1;
    let mut pcm: Option<DecodedPcm> = None;
    let mut sample_buffer: Option<SampleBuffer<f32>> = None;
    loop {
        match probed.format.next_packet() {
            Ok(packet) => match decoder.decode(&packet) {
                Ok(decoded) => {
                    let spec = *decoded.spec();
                    if pcm.is_none() {
                        if spec.rate == 0 {
                            return Err(AnalyzeError::Failed("zero sample rate".into()));
                        }
                        pcm = Some(DecodedPcm::new(spec.rate, header_ms));
                        channels = spec.channels.count().max(1);
                    }
                    let pcm = pcm.as_mut().unwrap();
                    let frames = decoded.frames();
                    let wanted = pcm.remaining().min(frames);
                    if sample_buffer
                        .as_ref()
                        .is_none_or(|buffer| buffer.capacity() < frames * spec.channels.count())
                    {
                        sample_buffer = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
                    }
                    let sb = sample_buffer.as_mut().unwrap();
                    sb.copy_interleaved_ref(decoded);
                    let samples = sb.samples();
                    for f in 0..wanted {
                        let base = f * channels;
                        let mut acc = 0.0f32;
                        for c in 0..channels {
                            let s = samples[base + c];
                            acc += if s.is_finite() { s } else { 0.0 };
                        }
                        let sample = acc / channels as f32;
                        // Finite channels can still overflow their f32 sum.
                        // The former analyze_mono entry point rejected this.
                        if !sample.is_finite() {
                            return Err(AnalyzeError::Failed("non-finite pcm".into()));
                        }
                        pcm.push(sample);
                    }
                    if pcm.remaining() == 0 {
                        break;
                    }
                }
                // 坏帧跳过（与播放后端 cpal_backend 同策略），ResetRequired 复位。
                Err(SymError::DecodeError(_)) => {}
                Err(_) => break,
            },
            Err(SymError::ResetRequired) => {
                decoder.reset();
            }
            Err(_) => break,
        }
    }
    let Some(pcm) = pcm.filter(|pcm| pcm.input_count > 0) else {
        return Err(AnalyzeError::Failed("decoded no audio samples".into()));
    };
    let (pcm, out_rate, duration_ms) = pcm.finish();
    analyze_resampled(&pcm, out_rate, duration_ms)
}

/// Decode-time rate selection. With no duration header, retain both analysis
/// rates until 480s; the high-rate candidate can then be discarded. Source-rate
/// PCM is never accumulated, even for high-resolution files.
struct DecodedPcm {
    in_rate: u32,
    header_ms: Option<u64>,
    input_count: usize,
    high: Option<StreamingLinear>,
    low: Option<StreamingLinear>,
}

impl DecodedPcm {
    fn new(in_rate: u32, header_ms: Option<u64>) -> Self {
        Self {
            in_rate,
            header_ms,
            input_count: 0,
            high: header_ms
                .is_none_or(|ms| ms < LONG_MS)
                .then(|| StreamingLinear::new(in_rate, HIGH_RATE)),
            low: header_ms
                .is_none_or(|ms| ms >= LONG_MS)
                .then(|| StreamingLinear::new(in_rate, LOW_RATE)),
        }
    }

    fn remaining(&self) -> usize {
        (ANALYZE_MS as usize * self.in_rate as usize / 1000).saturating_sub(self.input_count)
    }

    fn push(&mut self, sample: f32) {
        debug_assert!(self.remaining() > 0);
        self.input_count += 1;
        if let Some(high) = &mut self.high {
            high.push(sample);
        }
        if let Some(low) = &mut self.low {
            low.push(sample);
        }
        if self.header_ms.is_none()
            && self.input_count as u64 * 1000 >= LONG_MS * self.in_rate as u64
        {
            self.high = None;
        }
    }

    fn finish(self) -> (Vec<f32>, u32, u64) {
        let decoded_ms = self.input_count as u64 * 1000 / self.in_rate as u64;
        let duration = self.header_ms.unwrap_or(if self.remaining() == 0 {
            ANALYZE_MS + 1
        } else {
            decoded_ms
        });
        if duration >= LONG_MS {
            (self.low.unwrap().finish(), LOW_RATE, duration)
        } else {
            (self.high.unwrap().finish(), HIGH_RATE, duration)
        }
    }
}

/// The exact batch interpolation formula, evaluated on its original global
/// output index. Only the preceding source sample survives each push. EOF
/// supplies the same last-sample clamp and floor output length as the batch path.
struct StreamingLinear {
    in_rate: u32,
    out_rate: u32,
    input_count: usize,
    last: f32,
    next_i0: usize,
    next_frac: f64,
    output: Vec<f32>,
}

impl StreamingLinear {
    fn new(in_rate: u32, out_rate: u32) -> Self {
        Self {
            in_rate,
            out_rate,
            input_count: 0,
            last: 0.0,
            next_i0: 0,
            next_frac: 0.0,
            output: Vec::new(),
        }
    }

    fn push(&mut self, sample: f32) {
        let index = self.input_count;
        self.input_count += 1;
        if self.in_rate == self.out_rate {
            self.output.push(sample);
        } else {
            loop {
                if self.next_i0 + 1 > index {
                    break;
                }
                debug_assert_eq!(self.next_i0 + 1, index);
                let frac = self.next_frac;
                self.output
                    .push((self.last as f64 * (1.0 - frac) + sample as f64 * frac) as f32);
                let pos = self.output.len() as f64 * self.in_rate as f64 / self.out_rate as f64;
                self.next_i0 = pos.floor() as usize;
                self.next_frac = pos - self.next_i0 as f64;
            }
        }
        self.last = sample;
    }

    fn finish(mut self) -> Vec<f32> {
        let count = (self.input_count as u64 * self.out_rate as u64 / self.in_rate as u64) as usize;
        // A downsampled prefix may speculatively contain a sample before its
        // floor output length catches up. Trim it if EOF arrives that early.
        self.output.truncate(count);
        while self.output.len() < count {
            let pos = self.output.len() as f64 * self.in_rate as f64 / self.out_rate as f64;
            let frac = pos - pos.floor();
            self.output
                .push((self.last as f64 * (1.0 - frac) + self.last as f64 * frac) as f32);
        }
        self.output
    }
}

/// PCM 单声道 f32（采样率 in_rate）→ 节拍地图。时长由调用方给出（用于选分析率
/// 与推演判定），可以长于实际样本（边下边播场景不会走到这里，解码路径给头时长）。
pub fn analyze_mono(mono: &[f32], in_rate: u32, duration_ms: u64) -> Result<BeatMap, AnalyzeError> {
    if mono.is_empty() || in_rate == 0 {
        return Err(AnalyzeError::Failed("empty pcm".into()));
    }
    if mono.iter().any(|s| !s.is_finite()) {
        return Err(AnalyzeError::Failed("non-finite pcm".into()));
    }
    let out_rate = if duration_ms >= LONG_MS {
        LOW_RATE
    } else {
        HIGH_RATE
    };
    let mut pcm = resample_linear(mono, in_rate, out_rate);
    let max_out = (ANALYZE_MS as usize * out_rate as usize) / 1000;
    if pcm.len() > max_out {
        pcm.truncate(max_out);
    }
    analyze_resampled(&pcm, out_rate, duration_ms)
}

fn analyze_resampled(
    pcm: &[f32],
    out_rate: u32,
    duration_ms: u64,
) -> Result<BeatMap, AnalyzeError> {
    let analyzed_ms = (pcm.len() as u64 * 1000) / out_rate as u64;
    if pcm.len() < WINDOW {
        return Err(AnalyzeError::Unsupported("audio too short".into()));
    }
    let n_frames = (pcm.len() - WINDOW) / HOP + 1;

    // Hann 窗 + 26 个 mel 三角带（30Hz .. min(8kHz, 奈奎斯特 95%)），mel 均匀。
    let mut hann = vec![0f32; WINDOW];
    for (i, h) in hann.iter_mut().enumerate() {
        *h = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (WINDOW as f32 - 1.0)).cos();
    }
    let edges = mel_edges(out_rate as f32 * 0.5);
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(WINDOW);
    let mut scratch = vec![Complex::new(0f32, 0f32); WINDOW];
    let mut fft_scratch = vec![Complex::new(0f32, 0f32); fft.get_inplace_scratch_len()];
    let mut spectrum = vec![0f32; WINDOW / 2 + 1];
    let mut prev_band = [0f32; MEL_BANDS];
    let mut flux = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        let start = f * HOP;
        for i in 0..WINDOW {
            scratch[i] = Complex::new(pcm[start + i] * hann[i], 0.0);
        }
        fft.process_with_scratch(&mut scratch, &mut fft_scratch);
        for i in 0..=WINDOW / 2 {
            spectrum[i] = scratch[i].norm();
        }
        let mut band = [0f32; MEL_BANDS];
        for (b, win) in edges.windows(3).enumerate() {
            let (l, c, r) = (win[0], win[1], win[2]);
            let i0 = ((l * WINDOW as f32) / out_rate as f32).floor() as usize;
            let i1 = (((r * WINDOW as f32) / out_rate as f32).ceil() as usize).min(WINDOW / 2);
            for (i, &spec) in spectrum.iter().enumerate().take(i1 + 1).skip(i0) {
                let hz = i as f32 * out_rate as f32 / WINDOW as f32;
                let w = if hz <= c {
                    if c > l {
                        ((hz - l) / (c - l)).max(0.0)
                    } else {
                        0.0
                    }
                } else if r > c {
                    ((r - hz) / (r - c)).max(0.0)
                } else {
                    0.0
                };
                band[b] += spec * w;
            }
        }
        let mut pos = 0f32;
        for b in 0..MEL_BANDS {
            let d = band[b] - prev_band[b];
            if d > 0.0 {
                pos += d;
            }
            prev_band[b] = band[b];
        }
        flux.push(pos);
    }

    // 局部均值归一（±300ms）得到 onset 包络。
    let radius = ((300u32.saturating_mul(out_rate)) / (HOP as u32 * 1000)).max(4) as usize;
    let mut env = vec![0f32; n_frames];
    for i in 0..n_frames {
        let lo = i.saturating_sub(radius);
        let hi = (i + radius + 1).min(n_frames);
        let sum: f32 = flux[lo..hi].iter().sum();
        let mean = sum / (hi - lo) as f32;
        env[i] = flux[i] / (mean + 1e-6);
    }

    // 峰值：局部极大 + 局部中值自适应阈值 + 200ms 最小间隔（按强度贪心选取）。
    let gap_frames = (200u32 * out_rate).div_ceil(HOP as u32 * 1000).max(1) as usize;
    let mut cands: Vec<(usize, f32)> = Vec::new();
    for i in 1..n_frames.saturating_sub(1) {
        if env[i] > env[i - 1] && env[i] >= env[i + 1] {
            let mlo = i.saturating_sub(radius * 2);
            let mhi = (i + radius * 2 + 1).min(n_frames);
            let mut window: Vec<f32> = env[mlo..mhi].to_vec();
            window.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let med = window[window.len() / 2];
            if env[i] >= med * 1.35 + 0.25 {
                cands.push((i, env[i]));
            }
        }
    }
    cands.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let mut chosen_idx: Vec<(usize, f32)> = Vec::new();
    for (i, v) in cands {
        if chosen_idx
            .iter()
            .all(|(j, _)| (*j as isize - i as isize).unsigned_abs() >= gap_frames)
        {
            chosen_idx.push((i, v));
        }
    }
    chosen_idx.sort_by_key(|(i, _)| *i);
    if chosen_idx.is_empty() {
        return Err(AnalyzeError::Unsupported("no beats detected".into()));
    }

    // strength 按本曲峰高的 20/98 分位归一到 0..1。
    let mut vals: Vec<f32> = chosen_idx.iter().map(|(_, v)| *v).collect();
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let lo = percentile_sorted(&vals, 0.20);
    let hi = percentile_sorted(&vals, 0.98);
    let span = (hi - lo).max(1e-3);
    let times: Vec<i64> = chosen_idx
        .iter()
        .map(|(i, _)| (*i as i64 * HOP as i64 * 1000 + out_rate as i64 / 2) / out_rate as i64)
        .collect();
    let strengths: Vec<f32> = chosen_idx
        .iter()
        .map(|(_, v)| ((*v - lo) / span).clamp(0.0, 1.0))
        .collect();

    let bpm = estimate_bpm(&times, &env, out_rate);

    // downbeat：前 8 拍里取最强峰为第 0 拍（并列取第一拍），之后每 4 拍。
    let anchor_window = chosen_idx.len().min(8);
    let mut anchor = 0;
    let mut anchor_v = -1f32;
    for (i, &strength) in strengths.iter().enumerate().take(anchor_window) {
        if strength > anchor_v {
            anchor_v = strength;
            anchor = i;
        }
    }

    // intensity：前后 2 拍 strength 均值的 33/66 分位四档。
    let mut means = Vec::with_capacity(chosen_idx.len());
    for i in 0..chosen_idx.len() {
        let lo_i = i.saturating_sub(2);
        let hi_i = (i + 3).min(chosen_idx.len());
        means.push(strengths[lo_i..hi_i].iter().sum::<f32>() / (hi_i - lo_i) as f32);
    }
    let mut sorted_means = means.clone();
    sorted_means.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let q33 = percentile_sorted(&sorted_means, 0.33);
    let q66 = percentile_sorted(&sorted_means, 0.66);
    let q85 = percentile_sorted(&sorted_means, 0.85);

    let mut beats: Vec<Beat> = Vec::with_capacity(chosen_idx.len());
    for (i, t) in times.iter().enumerate() {
        let mean = means[i];
        let intensity = if mean >= q85 {
            3
        } else if mean >= q66 {
            2
        } else if mean >= q33 {
            1
        } else {
            0
        };
        beats.push(Beat {
            t: *t,
            strength: strengths[i],
            downbeat: (i as isize - anchor as isize).rem_euclid(4) == 0,
            intensity,
        });
    }

    // 超 720s：按 BPM 周期推演（strength=近 8 拍均值、intensity 沿用末值）。
    let mut truncated = duration_ms > analyzed_ms;
    if truncated {
        if let Some(bpm_v) = bpm {
            let period = (60_000.0 / bpm_v).round() as i64;
            if (333..=1000).contains(&period) {
                // 推演拍强度取近 8 拍（不足取全部）均值。
                let tail = &beats[beats.len().saturating_sub(8)..];
                let avg8 = tail.iter().map(|b| b.strength).sum::<f32>() / tail.len() as f32;
                let last_intensity = beats.last().map(|b| b.intensity).unwrap_or(0);
                let mut t = beats.last().map(|b| b.t).unwrap_or(0);
                while t + period <= duration_ms as i64 && beats.len() < 30_000 {
                    t += period;
                    let idx = beats.len() as isize;
                    beats.push(Beat {
                        t,
                        strength: avg8.clamp(0.0, 1.0),
                        downbeat: (idx - anchor as isize).rem_euclid(4) == 0,
                        intensity: last_intensity,
                    });
                }
            } else {
                truncated = false;
            }
        } else {
            // 无 BPM 无法推演：截断部分没有合法补点，不声称 truncated。
            truncated = false;
        }
    }

    Ok(BeatMap {
        version: MAP_VERSION,
        bpm,
        offset_ms: 0,
        truncated,
        beats,
    })
}

/// 线性重采样（比值任意）。采样率相同时原样返回，省一次拷贝。
fn resample_linear(input: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
    if in_rate == out_rate {
        return input.to_vec();
    }
    let n_out = (input.len() as u64 * out_rate as u64 / in_rate as u64) as usize;
    let mut out = Vec::with_capacity(n_out);
    for i in 0..n_out {
        let pos = i as f64 * in_rate as f64 / out_rate as f64;
        let i0 = pos.floor() as usize;
        let frac = pos - i0 as f64;
        let i1 = (i0 + 1).min(input.len() - 1);
        out.push((input[i0] as f64 * (1.0 - frac) + input[i1] as f64 * frac) as f32);
    }
    out
}

fn mel_edges(nyquist: f32) -> Vec<f32> {
    let f_lo = 30f32;
    let f_hi = 8000f32.min(nyquist * 0.95);
    let mel = |f: f32| 2595.0 * (1.0 + f / 700.0).log10();
    let hz = |m: f32| 700.0 * (10f32.powf(m / 2595.0) - 1.0);
    let m0 = mel(f_lo);
    let m1 = mel(f_hi);
    (0..MEL_BANDS + 2)
        .map(|i| hz(m0 + (m1 - m0) * i as f32 / (MEL_BANDS + 1) as f32))
        .collect()
}

fn percentile_sorted(sorted: &[f32], q: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() - 1) as f32 * q).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// BPM 粗估：峰间隔三角加权直方图（333..1000ms）+ ×1.6 显著性门；
/// 精修：在粗估 lag ±8% 内对 onset 包络做自相关，抛物线插值取连续周期
/// （hop 量化约 23/46ms，整数毫秒中位数会偏到整档，插值消除该量化误差）。
fn estimate_bpm(times: &[i64], env: &[f32], out_rate: u32) -> Option<f64> {
    if times.len() < 8 {
        return None;
    }
    let intervals: Vec<f64> = times
        .windows(2)
        .map(|w| (w[1] - w[0]) as f64)
        .filter(|d| (333.0..=1000.0).contains(d))
        .collect();
    if intervals.len() < 8 {
        return None;
    }
    let mut hist = vec![0f64; 1001];
    for d in &intervals {
        for (b, h) in hist.iter_mut().enumerate().take(1001).skip(333) {
            let w = (1.0 - (d - b as f64).abs() / 15.0).max(0.0);
            *h += w;
        }
    }
    let (best, score) = hist
        .iter()
        .enumerate()
        .skip(333)
        .take(668)
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())?;
    let mean: f64 = hist[333..=1000].iter().sum::<f64>() / 668.0;
    if *score < mean * 1.6 {
        return None;
    }

    // 自相关精修：粗周期换算成帧 lag，±8% 内找自相关最大整数 lag，
    // 再用相邻三点抛物线插值得到亚帧周期。
    let hop_ms = HOP as f64 * 1000.0 / out_rate as f64;
    let lag0 = best as f64 / hop_ms;
    let lo_lag = (lag0 * 0.92).ceil().max(1.0) as usize;
    let hi_lag = (lag0 * 1.08).floor() as usize;
    let hi_lag = hi_lag.min(env.len().saturating_sub(1));
    if hi_lag < lo_lag {
        return Some(60_000.0 / best as f64);
    }
    let acf = |lag: usize| -> f64 {
        let n = env.len() - lag;
        if n == 0 {
            return 0.0;
        }
        let mut s = 0.0f64;
        for i in 0..n {
            s += env[i] as f64 * env[i + lag] as f64;
        }
        s / n as f64
    };
    let mut peak_lag = lo_lag;
    let mut peak_v = f64::MIN;
    for lag in lo_lag..=hi_lag {
        let v = acf(lag);
        if v > peak_v {
            peak_v = v;
            peak_lag = lag;
        }
    }
    let mut refined = peak_lag as f64;
    if peak_lag > 0 && peak_lag + 1 < env.len() {
        let rm = acf(peak_lag - 1);
        let rp = acf(peak_lag + 1);
        let denom = rm - 2.0 * peak_v + rp;
        if denom < 0.0 {
            let delta = 0.5 * (rm - rp) / denom;
            if (-1.0..=1.0).contains(&delta) {
                refined += delta;
            }
        }
    }
    let period = refined * hop_ms;
    if !(333.0..=1000.0).contains(&period) {
        return Some(60_000.0 / best as f64);
    }
    Some(60_000.0 / period)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AllocationCounter;
    thread_local! {
        static FFT_ALLOCS: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
    }
    unsafe impl std::alloc::GlobalAlloc for AllocationCounter {
        unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
            let _ = FFT_ALLOCS.try_with(|count| {
                if layout.size() == WINDOW * std::mem::size_of::<Complex<f32>>() {
                    if let Some(n) = count.get() {
                        count.set(Some(n + 1));
                    }
                }
            });
            unsafe { std::alloc::System.alloc(layout) }
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: std::alloc::Layout) {
            unsafe { std::alloc::System.dealloc(ptr, layout) }
        }
    }
    #[global_allocator]
    static ALLOCATOR: AllocationCounter = AllocationCounter;

    #[test]
    fn stft_does_not_allocate_a_scratch_buffer_per_window() {
        let pcm = click_train(120.0, 32, 300, 16_800, 22_050);
        FFT_ALLOCS.with(|count| count.set(Some(0)));
        let map = analyze_mono(&pcm, 22_050, 16_800).unwrap();
        let allocations = FFT_ALLOCS.with(|count| count.replace(None).unwrap());
        assert!(!map.beats.is_empty());
        assert!(allocations < 20, "8192-byte FFT allocations: {allocations}");
        println!("STFT 8192-byte allocations: {allocations}");
    }

    /// 合成 bpm 恒定的 click 轨：每个点击是 24ms 的 200+900Hz 双音 Hann 短脉冲。
    fn click_train(bpm: f64, beats_n: usize, lead_ms: u64, total_ms: u64, sr: u32) -> Vec<f32> {
        let period = 60_000.0 / bpm;
        let n = (total_ms as usize * sr as usize) / 1000;
        let mut buf = vec![0f32; n];
        let burst = (sr as usize * 24) / 1000;
        for k in 0..beats_n {
            let center =
                ((lead_ms as f64 + k as f64 * period) * sr as f64 / 1000.0).round() as usize;
            for s in 0..burst {
                let idx = center + s;
                if idx >= n {
                    break;
                }
                let ph = s as f32 / sr as f32;
                let env = 0.5
                    - 0.5 * (2.0 * std::f32::consts::PI * s as f32 / (burst as f32 - 1.0)).cos();
                let v = (2.0 * std::f32::consts::PI * 200.0 * ph).sin() * 0.6
                    + (2.0 * std::f32::consts::PI * 900.0 * ph).sin() * 0.4;
                buf[idx] += v * env;
            }
        }
        buf
    }

    #[test]
    fn resampling_matches_frozen_scalar_reference() {
        for in_rate in [8_000, 11_025, 22_050, 44_100, 48_000, 192_000] {
            for out_rate in [LOW_RATE, HIGH_RATE] {
                for n in [0, 1, 2, 3, 17, 513, 4097] {
                    let input: Vec<f32> = (0..n)
                        .map(|i| {
                            if i % 19 == 0 {
                                -0.0
                            } else {
                                (i as f32 * 0.17).sin()
                            }
                        })
                        .collect();
                    let expected = reference_resample(&input, in_rate, out_rate);
                    let actual = resample_linear(&input, in_rate, out_rate);
                    assert_eq!(
                        actual.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                        expected.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                        "{in_rate}/{out_rate}, {n}"
                    );
                }
            }
        }
    }

    // Frozen pre-optimization formula: independent global phase and EOF clamp.
    fn reference_resample(input: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
        if in_rate == out_rate {
            return input.to_vec();
        }
        let count = (input.len() as u64 * out_rate as u64 / in_rate as u64) as usize;
        (0..count)
            .map(|i| {
                let pos = i as f64 * in_rate as f64 / out_rate as f64;
                let i0 = pos.floor() as usize;
                let frac = pos - i0 as f64;
                let i1 = (i0 + 1).min(input.len() - 1);
                (input[i0] as f64 * (1.0 - frac) + input[i1] as f64 * frac) as f32
            })
            .collect()
    }

    #[test]
    fn streaming_resampling_matches_batch_bits_at_all_packet_boundaries() {
        for in_rate in [8_000, 11_025, 22_050, 44_100, 48_000, 192_000] {
            for out_rate in [LOW_RATE, HIGH_RATE] {
                for n in [0, 1, 2, 3, 17, 513, 4097] {
                    let input: Vec<f32> = (0..n)
                        .map(|i| {
                            if i % 19 == 0 {
                                -0.0
                            } else {
                                (i as f32 * 0.17).sin()
                            }
                        })
                        .collect();
                    let reference = reference_resample(&input, in_rate, out_rate);
                    for packet_frames in [1, 7, 512, 1152] {
                        let mut stream = StreamingLinear::new(in_rate, out_rate);
                        for packet in input.chunks(packet_frames) {
                            for &sample in packet {
                                stream.push(sample);
                            }
                        }
                        let actual = stream.finish();
                        assert_eq!(actual.len(), reference.len());
                        for (i, (a, b)) in actual.iter().zip(&reference).enumerate() {
                            assert_eq!(
                                a.to_bits(),
                                b.to_bits(),
                                "{in_rate}/{out_rate}, n={n}, packet={packet_frames}, sample={i}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn streaming_analysis_and_duration_choice_match_batch_maps() {
        let pcm = click_train(120.0, 32, 300, 16_800, 48_000);
        for header_ms in [
            None,
            Some(16_800),
            Some(LONG_MS - 1),
            Some(LONG_MS),
            Some(ANALYZE_MS + 1),
        ] {
            let mut decoded = DecodedPcm::new(48_000, header_ms);
            for &sample in &pcm {
                decoded.push(sample);
            }
            let (streamed, rate, duration) = decoded.finish();
            let actual = analyze_resampled(&streamed, rate, duration).unwrap();
            let reference = analyze_mono(&pcm, 48_000, header_ms.unwrap_or(16_800)).unwrap();
            assert_eq!(actual, reference, "header={header_ms:?}");
        }
    }

    #[test]
    fn streaming_decode_retains_analysis_pcm_instead_of_full_source() {
        let in_rate = 192_000;
        let count = in_rate * 2;
        let mut decoded = DecodedPcm::new(in_rate, Some(2000));
        for i in 0..count {
            decoded.push((i as f32 * 0.017).sin());
        }
        assert!(decoded.low.is_none());
        let high = decoded.high.as_ref().unwrap();
        let retained = high.output.capacity() * std::mem::size_of::<f32>()
            + std::mem::size_of::<StreamingLinear>();
        let previous_source_bytes = count as usize * std::mem::size_of::<f32>();
        assert!(retained < previous_source_bytes / 4);
        println!("192kHz/2s: old source PCM alone={previous_source_bytes} bytes, streaming retained={retained} bytes (includes output capacity); source history=one f32");
        let (pcm, rate, duration) = decoded.finish();
        assert_eq!((pcm.len(), rate, duration), (44_100, HIGH_RATE, 2000));
    }

    #[test]
    fn unknown_duration_discards_high_rate_at_480s_and_caps_at_720s() {
        // A 1Hz source exercises duration boundaries with very few source
        // samples; the analysis-rate outputs retain their actual production size.
        let mut decoded = DecodedPcm::new(1, None);
        for _ in 0..479 {
            decoded.push(0.25);
        }
        assert!(decoded.high.is_some());
        assert!(decoded.low.is_some());
        decoded.push(0.25);
        assert!(decoded.high.is_none());
        while decoded.remaining() > 0 {
            decoded.push(0.25);
        }
        assert_eq!(decoded.input_count, 720);
        let (pcm, rate, duration) = decoded.finish();
        assert_eq!(
            (pcm.len(), rate, duration),
            (720 * LOW_RATE as usize, LOW_RATE, ANALYZE_MS + 1)
        );
        assert!(pcm.iter().all(|sample| *sample == 0.25));
    }

    #[test]
    fn decoded_stereo_wav_matches_original_mono_pipeline() {
        let input = click_train(120.0, 32, 300, 16_800, 48_000);
        let mut bytes = Vec::new();
        let mut mono = Vec::with_capacity(input.len());
        let data_len = (input.len() * 4) as u32;
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_len).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x02\0");
        bytes.extend_from_slice(&48_000u32.to_le_bytes());
        bytes.extend_from_slice(&192_000u32.to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        for sample in input {
            let left = (sample * 15_000.0) as i16;
            let right = (sample * 10_000.0) as i16;
            bytes.extend_from_slice(&left.to_le_bytes());
            bytes.extend_from_slice(&right.to_le_bytes());
            mono.push((left as f32 / 32768.0 + right as f32 / 32768.0) / 2.0);
        }
        let path =
            std::env::temp_dir().join(format!("hertz-beats-streaming-{}.wav", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        let actual = analyze_path(&path);
        std::fs::remove_file(path).unwrap();
        assert_eq!(
            actual.unwrap(),
            analyze_mono(&mono, 48_000, 16_800).unwrap()
        );
    }

    #[test]
    fn decoded_channel_sum_overflow_retains_nonfinite_pcm_error() {
        let frames = 2048u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + frames * 8).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt \x10\0\0\0\x03\0\x02\0");
        bytes.extend_from_slice(&HIGH_RATE.to_le_bytes());
        bytes.extend_from_slice(&(HIGH_RATE * 8).to_le_bytes());
        bytes.extend_from_slice(&8u16.to_le_bytes());
        bytes.extend_from_slice(&32u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(frames * 8).to_le_bytes());
        for _ in 0..frames * 2 {
            bytes.extend_from_slice(&f32::MAX.to_le_bytes());
        }
        let path =
            std::env::temp_dir().join(format!("hertz-beats-overflow-{}.wav", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        let actual = analyze_path(&path);
        std::fs::remove_file(path).unwrap();
        assert!(
            matches!(actual, Err(AnalyzeError::Failed(ref error)) if error == "non-finite pcm"),
            "{actual:?}"
        );
    }

    #[test]
    fn explicit_fft_scratch_is_bit_identical_to_allocating_reference() {
        let pcm = click_train(120.0, 4, 300, 2500, HIGH_RATE);
        let fft = FftPlanner::<f32>::new().plan_fft_forward(WINDOW);
        let mut input = vec![Complex::new(0.0, 0.0); WINDOW];
        let mut workspace = vec![Complex::new(0.0, 0.0); fft.get_inplace_scratch_len()];
        for frame in pcm.windows(WINDOW).step_by(HOP) {
            let mut reference: Vec<_> = frame
                .iter()
                .enumerate()
                .map(|(i, sample)| {
                    let hann = 0.5
                        - 0.5
                            * (2.0 * std::f32::consts::PI * i as f32 / (WINDOW as f32 - 1.0)).cos();
                    Complex::new(sample * hann, 0.0)
                })
                .collect();
            input.copy_from_slice(&reference);
            fft.process(&mut reference);
            fft.process_with_scratch(&mut input, &mut workspace);
            for (actual, expected) in input.iter().zip(reference) {
                assert_eq!(actual.re.to_bits(), expected.re.to_bits());
                assert_eq!(actual.im.to_bits(), expected.im.to_bits());
            }
        }
    }

    #[test]
    fn resample_halves_and_keeps_rate() {
        let input: Vec<f32> = (0..2205).map(|i| (i as f32 * 0.1).sin()).collect();
        let half = resample_linear(&input, 22050, 11025);
        assert!(half.len() >= 1100 && half.len() <= 1104);
        let same = resample_linear(&input, 22050, 22050);
        assert_eq!(same.len(), input.len());
    }

    #[test]
    fn flux_peaks_land_on_clicks_and_bpm_is_120() {
        // 32 拍 × 500ms + 前导 300ms + 尾 500ms ≈ 16.8s，走 22050Hz 分析率。
        let pcm = click_train(120.0, 32, 300, 300 + 32 * 500 + 500, 22050);
        let map = analyze_mono(&pcm, 22050, (300 + 32 * 500 + 500) as u64).unwrap();
        assert!(map.bpm.is_some(), "恒定 click 轨必须给出 BPM");
        let bpm = map.bpm.unwrap();
        assert!((118.0..=122.0).contains(&bpm), "bpm={bpm}");
        assert!(
            map.beats.len() >= 28 && map.beats.len() <= 36,
            "{}",
            map.beats.len()
        );
        // 至少 30 个点击在 ±60ms 内有检出峰，首拍落在前导点击附近（±80ms）。
        let mut hit = 0;
        for k in 0..32 {
            let expect = 300.0 + k as f64 * 500.0;
            if map
                .beats
                .iter()
                .any(|b| (b.t as f64 - expect).abs() <= 60.0)
            {
                hit += 1;
            }
        }
        assert!(hit >= 30, "峰位置命中 {hit}/32");
        assert!((map.beats[0].t as f64 - 300.0).abs() <= 80.0);
    }

    #[test]
    fn downbeats_anchor_at_zero_then_every_four() {
        let pcm = click_train(120.0, 32, 300, 300 + 32 * 500 + 500, 22050);
        let map = analyze_mono(&pcm, 22050, (300 + 32 * 500 + 500) as u64).unwrap();
        assert!(map.beats[0].downbeat, "等强度峰的锚点必须是第一拍");
        for (i, b) in map.beats.iter().enumerate() {
            assert_eq!(b.downbeat, i % 4 == 0, "第 {i} 拍 downbeat 分型错误");
        }
    }

    #[test]
    fn strength_and_intensity_ranges() {
        let pcm = click_train(120.0, 32, 300, 300 + 32 * 500 + 500, 22050);
        let map = analyze_mono(&pcm, 22050, (300 + 32 * 500 + 500) as u64).unwrap();
        for b in &map.beats {
            assert!(b.strength >= 0.0 && b.strength <= 1.0);
            assert!(b.intensity <= 3);
        }
    }

    #[test]
    fn sparse_irregular_clicks_have_null_bpm_but_keep_beats() {
        let pcm = click_train(120.0, 4, 300, 4000, 22050);
        let map = analyze_mono(&pcm, 22050, 4000).unwrap();
        assert!(map.bpm.is_none());
        assert!(!map.beats.is_empty());
    }

    #[test]
    fn long_track_is_truncated_and_tail_is_extrapolated() {
        // 725s 输入：解码侧按 11025Hz，分析只吃前 720s，尾段按 BPM 推演。
        let pcm = click_train(120.0, 1450, 300, 725_000, 11025);
        let map = analyze_mono(&pcm, 11025, 725_000).unwrap();
        assert!(map.truncated);
        assert!((118.0..=122.0).contains(&map.bpm.unwrap()));
        let tail: Vec<_> = map.beats.iter().filter(|b| b.t > 720_000).collect();
        assert!(tail.len() >= 5, "720s 之后应有推演拍，实际 {}", tail.len());
        for w in map.beats.windows(2) {
            assert!(w[1].t > w[0].t, "beats 必须严格升序");
        }
    }

    #[test]
    fn silence_is_unsupported_not_empty_map() {
        let pcm = vec![0f32; 22050 * 2];
        let err = analyze_mono(&pcm, 22050, 2000).unwrap_err();
        assert!(matches!(err, AnalyzeError::Unsupported(_)));
    }

    #[test]
    fn non_finite_samples_fail_without_panicking() {
        let mut pcm = vec![0.1f32; 22050];
        pcm[100] = f32::INFINITY;
        pcm[200] = f32::NAN;
        let err = analyze_mono(&pcm, 22050, 1000).unwrap_err();
        assert!(matches!(err, AnalyzeError::Failed(_)));
    }
}
