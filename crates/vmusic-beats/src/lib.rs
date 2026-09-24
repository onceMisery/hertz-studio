// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

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
const MAP_VERSION: u32 = 1;

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

    let mut sr: u32 = 0;
    let mut channels: usize = 1;
    let mut mono: Vec<f32> = Vec::new();
    loop {
        match probed.format.next_packet() {
            Ok(packet) => match decoder.decode(&packet) {
                Ok(decoded) => {
                    let spec = *decoded.spec();
                    if sr == 0 {
                        sr = spec.rate;
                        channels = spec.channels.count().max(1);
                    }
                    let frames = decoded.frames();
                    let max_in = (ANALYZE_MS as usize * sr as usize) / 1000;
                    let wanted = if mono.len() >= max_in {
                        0
                    } else {
                        (max_in - mono.len()).min(frames)
                    };
                    let mut sb = SampleBuffer::<f32>::new(frames as u64, spec);
                    sb.copy_interleaved_ref(decoded);
                    let samples = sb.samples();
                    for f in 0..wanted {
                        let base = f * channels;
                        let mut acc = 0.0f32;
                        for c in 0..channels {
                            acc += samples[base + c];
                        }
                        mono.push(acc / channels as f32);
                    }
                    if mono.len() >= max_in {
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
    if sr == 0 || mono.is_empty() {
        return Err(AnalyzeError::Failed("decoded no audio samples".into()));
    }
    let decoded_ms = (mono.len() as u64 * 1000) / sr as u64;
    analyze_mono(&mono, sr, header_ms.unwrap_or(decoded_ms))
}

/// PCM 单声道 f32（采样率 in_rate）→ 节拍地图。时长由调用方给出（用于选分析率
/// 与推演判定），可以长于实际样本（边下边播场景不会走到这里，解码路径给头时长）。
pub fn analyze_mono(mono: &[f32], in_rate: u32, duration_ms: u64) -> Result<BeatMap, AnalyzeError> {
    if mono.is_empty() || in_rate == 0 {
        return Err(AnalyzeError::Failed("empty pcm".into()));
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
    let mut spectrum = vec![0f32; WINDOW / 2 + 1];
    let mut prev_band = [0f32; MEL_BANDS];
    let mut flux = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        let start = f * HOP;
        for i in 0..WINDOW {
            scratch[i] = Complex::new(pcm[start + i] * hann[i], 0.0);
        }
        fft.process(&mut scratch);
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
pub fn resample_linear(input: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
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
        for (b, h) in hist.iter_mut().enumerate().take(1000).skip(333) {
            let w = (1.0 - (d - b as f64).abs() / 15.0).max(0.0);
            *h += w;
        }
    }
    let (best, score) = hist
        .iter()
        .enumerate()
        .skip(333)
        .take(667)
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())?;
    let mean: f64 = hist[333..1000].iter().sum::<f64>() / 667.0;
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
}
