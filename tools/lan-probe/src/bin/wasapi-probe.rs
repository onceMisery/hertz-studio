// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//! Windows WASAPI 原生设备时钟 + 回录相关性探针（lan-listening §7.2/§12.2 P0）。
//!
//! 同一默认渲染设备上开两个 IAudioClient：渲染端写入「背景微噪声 + 每
//! 250ms 一个 4ms 升余弦 4kHz 标记突发」，同时按 AUDCLNT_STREAMFLAGS_
//! LOOPBACK 数字回录正在播放的混音。测量：
//! - 设备时钟：IAudioClock::GetPosition 的 (帧位置, QPC) 锚点序列 →
//!   线性拟合斜率 vs 名义采样率（ppm）、单调性（cpal 丢弃帧位置的补充）；
//! - 排队：GetCurrentPadding 的队列毫秒分布；
//! - 端到端呈现时延：每个标记的「计划呈现 QPC（时钟拟合推算）」与
//!   「回录中互相关检测到的实际出现 QPC」之差的分布（录音相关性证据）。
//!
//! 只用合成信号；退出即关闭，不随正式包发布。运行：
//! `cargo run --release -p lan-probe --bin wasapi-probe -- --seconds 6`
#![cfg(windows)]

use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows::core::Interface;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IAudioClock, IAudioRenderClient,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

/// 标记突发参数。
const MARKER_INTERVAL_MS: u64 = 250;
const MARKER_LEN_MS: f64 = 4.0;
const MARKER_FREQ: f64 = 4000.0;
const MARKER_AMP: f32 = 0.25;
/// 背景微噪声：维持引擎活跃，不干扰检测。
const BACKGROUND_AMP: f32 = 1.0e-4;
/// 相关搜索窗（±）。
const SEARCH_MS: f64 = 100.0;

#[derive(Clone, Copy)]
struct ClockAnchor {
    qpc_ns: u64,
    frames: u64,
}

#[derive(Default)]
struct RenderTelemetry {
    anchors: Vec<ClockAnchor>,
    padding_ms: Vec<f64>,
    written_frames: u64,
}

/// 渲染线程：持续补满缓冲，注入标记；周期采样设备时钟锚点。
unsafe fn render_loop(
    audio_client: &IAudioClient,
    render_client: &IAudioRenderClient,
    clock: &IAudioClock,
    rate: u32,
    channels: usize,
    buffer_frames: u32,
    stop: &AtomicBool,
    telemetry: &mut RenderTelemetry,
    marker_frames: &mut Vec<u64>,
    last_qpc_ns: &AtomicU64,
) -> windows::core::Result<()> {
    let mut written: u64 = 0;
    let mut rng: u64 = 0x243F_6A88_85A3_08D3;
    let marker_len = (MARKER_LEN_MS / 1000.0 * f64::from(rate)).round() as usize;
    let marker_stride = MARKER_INTERVAL_MS * u64::from(rate) / 1000;
    // 标记的绝对帧位：首帧 + 0.5s 起，每 250ms 一个（升余弦 4kHz 突发）。
    let first_marker = u64::from(rate) / 2;
    while !stop.load(Ordering::Relaxed) {
        let padding = audio_client.GetCurrentPadding()?;
        telemetry
            .padding_ms
            .push(f64::from(padding) * 1000.0 / f64::from(rate));
        let available = buffer_frames - padding;
        if available == 0 {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        let data = render_client.GetBuffer(available)?;
        let data = data.cast::<f32>();
        let abs_start = written;
        for i in 0..available as usize {
            let abs = abs_start + i as u64;
            let t = abs as f64 / f64::from(rate);
            let mut v = BACKGROUND_AMP * (((rng >> 11) as f32 / (1u64 << 53) as f32) * 2.0 - 1.0);
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            if abs >= first_marker {
                let rel = abs - first_marker;
                let off = rel % marker_stride;
                if (off as usize) < marker_len {
                    let m = off as usize;
                    let frac = m as f64 / marker_len as f64;
                    let env = 0.5 * (1.0 - (std::f64::consts::PI * (2.0 * frac - 1.0)).cos());
                    v = MARKER_AMP
                        * env as f32
                        * (std::f64::consts::TAU * MARKER_FREQ * t).sin() as f32;
                    if m == 0 && !marker_frames.contains(&abs) {
                        marker_frames.push(abs);
                    }
                }
            }
            for ch in 0..channels {
                *data.add(i * channels + ch) = v;
            }
        }
        written += u64::from(available);
        telemetry.written_frames = written;
        render_client.ReleaseBuffer(available, 0)?;
        // 设备时钟锚点（QPC 为 100ns 单位 → 纳秒 ×100）。
        let mut pos = 0u64;
        let mut qpc = 0u64;
        clock.GetPosition(&mut pos, Some(&mut qpc))?;
        last_qpc_ns.store(qpc * 100, Ordering::Relaxed);
        telemetry.anchors.push(ClockAnchor {
            qpc_ns: qpc * 100,
            frames: pos,
        });
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = audio_client.Stop();
    Ok(())
}

/// 回录采集：记录 (样本, 其 QPC 纳秒)。
struct Capture {
    samples: Vec<f32>,
    times: Vec<u64>,
    packets: u64,
    qpc_fallback: u64,
}

unsafe fn capture_loop(
    audio_client: &IAudioClient,
    capture_client: &IAudioCaptureClient,
    rate: u32,
    channels: usize,
    stop: &AtomicBool,
    capture: &mut Capture,
    last_qpc_ns: &AtomicU64,
) -> windows::core::Result<()> {
    audio_client.Start()?;
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let mut packet = capture_client.GetNextPacketSize()?;
        let mut processed_any = false;
        while packet > 0 {
            processed_any = true;
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            let mut dev_pos = 0u64;
            let mut qpc_position = 0u64;
            capture_client.GetBuffer(
                &mut data,
                &mut frames,
                &mut flags,
                Some(&mut dev_pos),
                Some(&mut qpc_position),
            )?;
            // 兜底：个别驱动回 0，用渲染循环最近一次锚点的 QPC（精度略降）。
            let base_qpc_ns = if qpc_position > 0 {
                qpc_position * 100
            } else {
                capture.qpc_fallback += 1;
                last_qpc_ns.load(Ordering::Relaxed)
            };
            let samples = data.cast::<f32>();
            for i in 0..frames as usize {
                let v = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 == 0 {
                    *samples.add(i * channels)
                } else {
                    0.0
                };
                capture.samples.push(v);
                capture
                    .times
                    .push(base_qpc_ns + (i as f64 / f64::from(rate)) as u64);
            }
            capture_client.ReleaseBuffer(packet)?;
            capture.packets += 1;
            packet = capture_client.GetNextPacketSize()?;
        }
        if !processed_any {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let _ = audio_client.Stop();
    Ok(())
}

/// 设备时钟拟合：position = a×qpc_ns + b。返回
/// (每纳秒位置单位, 截距, 最大残差 ns, 单调)。
/// 位置单位不保证等于流帧（实测 Realtek 按 384kHz 端点钟计数，比例 ×8），
/// 调用方用 `ratio = a×1e9/rate` 自标定后再换算呈现时间。
fn fit_clock(anchors: &[ClockAnchor]) -> (f64, f64, f64, bool) {
    let n = anchors.len() as f64;
    let mut sx = 0.0;
    let mut sy = 0.0;
    let mut sxx = 0.0;
    let mut sxy = 0.0;
    let mut monotonic = true;
    let mut prev: Option<(u64, u64)> = None;
    for a in anchors {
        let x = a.qpc_ns as f64;
        let y = a.frames as f64;
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
        if let Some((pq, pf)) = prev {
            if a.qpc_ns < pq || a.frames < pf {
                monotonic = false;
            }
        }
        prev = Some((a.qpc_ns, a.frames));
    }
    let denom = n * sxx - sx * sx;
    if denom.abs() < 1e-9 || anchors.len() < 4 {
        return (0.0, 0.0, f64::INFINITY, monotonic);
    }
    let a = (n * sxy - sx * sy) / denom;
    let b = (sy - a * sx) / n;
    // 残差（位置单位）→ 换算 ns 的最大偏差。
    let mut residual_ns = 0.0f64;
    for anchor in anchors {
        let predicted = a * anchor.qpc_ns as f64 + b;
        let dev_units = (anchor.frames as f64 - predicted).abs();
        if a > 0.0 {
            residual_ns = residual_ns.max(dev_units / a);
        }
    }
    (a, b, residual_ns, monotonic)
}

/// 模板（升余弦 4kHz，与渲染端同参数）。
fn marker_template(rate: u32) -> Vec<f32> {
    let len = (MARKER_LEN_MS / 1000.0 * f64::from(rate)).round() as usize;
    (0..len)
        .map(|m| {
            let t = m as f64 / f64::from(rate);
            let frac = m as f64 / len as f64;
            let env = 0.5 * (1.0 - (std::f64::consts::PI * (2.0 * frac - 1.0)).cos());
            (MARKER_AMP as f64 * env * (std::f64::consts::TAU * MARKER_FREQ * t).sin()) as f32
        })
        .collect()
}

/// 窗口互相关：返回最佳滞后（样本）与归一化峰值。
fn cross_correlate(window: &[f32], template: &[f32]) -> (usize, f64) {
    let norm: f64 = template.iter().map(|v| f64::from(*v) * f64::from(*v)).sum();
    let mut best = (0usize, f64::NEG_INFINITY);
    for lag in 0..window.len().saturating_sub(template.len()) {
        let mut acc = 0.0f64;
        for (i, tv) in template.iter().enumerate() {
            acc += f64::from(window[lag + i]) * f64::from(*tv);
        }
        if acc > best.1 {
            best = (lag, acc);
        }
    }
    (best.0, if norm > 0.0 { best.1 / norm } else { 0.0 })
}

fn median_of(values: &[f64]) -> f64 {
    let mut v = values.to_vec();
    v.sort_by(f64::total_cmp);
    if v.is_empty() {
        f64::NAN
    } else {
        v[v.len() / 2]
    }
}

/// IMMDevice::Activate 的类型化封装。
unsafe fn activate<T: Interface>(
    device: &windows::Win32::Media::Audio::IMMDevice,
) -> windows::core::Result<T> {
    device.Activate(CLSCTX_ALL, None)
}

/// COM 接口的 Send 包裹：本探针全程 MTA，接口跨线程传递安全（cpal 同做法）。
#[derive(Clone)]
struct SendCom<T>(T);
unsafe impl<T> Send for SendCom<T> {}

/// 经函数边界取出，避免 Rust 2021 不相交捕获绕过 Send 包裹（闭包体里
/// 直接解构 `let SendCom(x) = x;` 只捕获裸接口字段）。
fn unwrap_com<T>(s: SendCom<T>) -> T {
    s.0
}

fn main() {
    let mut seconds = 6.0f64;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--seconds" {
            if let Some(v) = args.next() {
                if let Ok(parsed) = v.parse() {
                    seconds = parsed;
                }
            }
        }
    }
    unsafe {
        // RPC_E_CHANGED_MODE（线程模型不同）可容忍：接口已可用。
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.0 < 0 && hr.0 != -2147417850i32 {
            panic!("CoInitializeEx 失败: 0x{:08X}", hr.0 as u32);
        }
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).expect("CoCreateInstance");
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .expect("GetDefaultAudioEndpoint");

        // 两个 IAudioClient：渲染 + 回录。
        let render_ac: IAudioClient = activate(&device).expect("Activate render");
        let capture_ac: IAudioClient = activate(&device).expect("Activate capture");

        let fmt = render_ac.GetMixFormat().expect("GetMixFormat");
        let rate = (*fmt).nSamplesPerSec;
        let channels = (*fmt).nChannels as usize;

        // 渲染：200ms 缓冲（REFERENCE_TIME 100ns 单位）。
        render_ac
            .Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 2_000_000, 0, fmt, None)
            .expect("render Initialize");
        let buffer_frames = render_ac.GetBufferSize().expect("GetBufferSize");
        let render_svc: IAudioRenderClient = render_ac.GetService().expect("GetService render");
        let clock: IAudioClock = render_ac.GetService().expect("GetService clock");

        // 回录：同一设备 LOOPBACK。
        capture_ac
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                1_000_000,
                0,
                fmt,
                None,
            )
            .expect("capture Initialize");
        let capture_svc: IAudioCaptureClient = capture_ac.GetService().expect("GetService capture");
        CoTaskMemFree(Some(fmt.cast()));

        render_ac.Start().expect("render Start");

        let stop = Arc::new(AtomicBool::new(false));
        let telemetry = Arc::new(Mutex::new(RenderTelemetry::default()));
        let capture = Arc::new(Mutex::new(Capture {
            samples: Vec::new(),
            times: Vec::new(),
            packets: 0,
            qpc_fallback: 0,
        }));
        let markers = Arc::new(Mutex::new(Vec::<u64>::new()));
        let last_qpc_ns = Arc::new(AtomicU64::new(0));

        {
            let telemetry = telemetry.clone();
            let markers = markers.clone();
            let stop = stop.clone();
            let last_qpc = last_qpc_ns.clone();
            let render_ac = SendCom(render_ac);
            let render_svc = SendCom(render_svc);
            let clock = SendCom(clock);
            std::thread::spawn(move || {
                let render_ac = unwrap_com(render_ac);
                let render_svc = unwrap_com(render_svc);
                let clock = unwrap_com(clock);
                let Ok(mut telemetry) = telemetry.lock() else {
                    return;
                };
                let Ok(mut markers) = markers.lock() else {
                    return;
                };
                let result = render_loop(
                    &render_ac,
                    &render_svc,
                    &clock,
                    rate,
                    channels,
                    buffer_frames,
                    &stop,
                    &mut telemetry,
                    &mut markers,
                    &last_qpc,
                );
                if let Err(e) = result {
                    eprintln!("render loop: {e}");
                }
            });
        }
        {
            let capture = capture.clone();
            let stop = stop.clone();
            let last_qpc = last_qpc_ns.clone();
            let capture_ac = SendCom(capture_ac);
            let capture_svc = SendCom(capture_svc);
            std::thread::spawn(move || {
                let capture_ac = unwrap_com(capture_ac);
                let capture_svc = unwrap_com(capture_svc);
                let Ok(mut capture) = capture.lock() else {
                    return;
                };
                let result = capture_loop(
                    &capture_ac,
                    &capture_svc,
                    rate,
                    channels,
                    &stop,
                    &mut capture,
                    &last_qpc,
                );
                if let Err(e) = result {
                    eprintln!("capture loop: {e}");
                }
            });
        }

        eprintln!(
            "探测 {seconds}s：rate={rate} channels={channels}（每 250ms 一个 4ms 标记突发 + 微噪声背景）"
        );
        std::thread::sleep(Duration::from_secs_f64(seconds));
        stop.store(true, Ordering::Release);
        std::thread::sleep(Duration::from_millis(50));

        // 分析。起播瞬态（设备位置迟滞启动）污染线性拟合，丢弃首 1 秒锚点。
        let telemetry = telemetry.lock().unwrap();
        let capture = capture.lock().unwrap();
        let marker_frames = markers.lock().unwrap().clone();
        let warmup_end = telemetry
            .anchors
            .first()
            .map(|a| a.qpc_ns + 1_000_000_000)
            .unwrap_or(0);
        let fit_anchors: Vec<ClockAnchor> = telemetry
            .anchors
            .iter()
            .filter(|a| a.qpc_ns >= warmup_end)
            .cloned()
            .collect();
        let (slope, intercept, residual_ns, clock_monotonic) =
            fit_clock(if fit_anchors.len() >= 8 {
                &fit_anchors
            } else {
                &telemetry.anchors
            });
        // 位置单位自标定：ratio = 位置速率 / 流采样率（Realtek 实测 ×8）。
        let position_unit_ratio = if slope > 0.0 {
            slope * 1e9 / f64::from(rate)
        } else {
            f64::NAN
        };
        let clock_usable = clock_monotonic
            && slope > 0.0
            && residual_ns < 1e6
            && (0.5..=64.0).contains(&position_unit_ratio);

        let template = marker_template(rate);
        let mut latencies = Vec::new();
        let mut peak_norms = Vec::new();
        let search = (SEARCH_MS / 1000.0 * f64::from(rate)).round() as usize;
        for &frame in marker_frames.iter() {
            // 计划呈现 QPC：流帧 × 位置单位比例 → 设备位置 → QPC（拟合）。
            if !clock_usable {
                break;
            }
            let expected_qpc_ns = ((frame as f64 * position_unit_ratio - intercept) / slope) as i64;
            // 回录中找窗。
            let lo = expected_qpc_ns - search as i64 * 1_000_000_000 / rate as i64;
            let hi = expected_qpc_ns + search as i64 * 1_000_000_000 / rate as i64;
            let start_idx = capture
                .times
                .partition_point(|&t| (t as i64) < lo)
                .saturating_sub(template.len());
            let end_idx = capture
                .times
                .partition_point(|&t| (t as i64) < hi)
                .min(capture.samples.len());
            if end_idx <= start_idx || end_idx - start_idx < template.len() {
                continue;
            }
            let window = &capture.samples[start_idx..end_idx];
            let (lag, norm) = cross_correlate(window, &template);
            // 峰值阈值：对齐时归一化互相关 ≈1，噪声 ≈1e-4；低于 0.5 不算检测。
            if norm < 0.5 {
                continue;
            }
            let detected_qpc = capture.times[start_idx + lag] as i64;
            latencies.push((detected_qpc - expected_qpc_ns) as f64 / 1e6);
            peak_norms.push(norm);
        }
        latencies.sort_by(f64::total_cmp);
        let pick = |v: &[f64], q: f64| {
            if v.is_empty() {
                f64::NAN
            } else {
                v[((v.len() as f64 * q) as usize).min(v.len() - 1)]
            }
        };
        let mean = if latencies.is_empty() {
            f64::NAN
        } else {
            latencies.iter().sum::<f64>() / latencies.len() as f64
        };
        let latency_std = if latencies.len() < 2 {
            f64::NAN
        } else {
            (latencies.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / latencies.len() as f64)
                .sqrt()
        };
        let mut padding = telemetry.padding_ms.clone();
        padding.sort_by(f64::total_cmp);
        let detection_rate = if marker_frames.is_empty() {
            0.0
        } else {
            latencies.len() as f64 / marker_frames.len() as f64
        };
        let verdict_ok = detection_rate >= 0.8
            && latencies.len() >= 5
            && latency_std.is_finite()
            && latency_std < 2.0
            && clock_usable;

        let report = json!({
            "schemaVersion": 1,
            "probe": "wasapi-loopback-correlation",
            "os": std::env::consts::OS,
            "cpu": std::env::var("PROCESSOR_IDENTIFIER").ok(),
            "sampleRate": rate,
            "channels": channels,
            "bufferFrames": buffer_frames,
            "requestedSeconds": seconds,
            "deviceClock": {
                "anchors": telemetry.anchors.len(),
                "monotonic": clock_monotonic,
                "fitResidualMsMax": residual_ns / 1e6,
                "positionUnitRatio": position_unit_ratio,
                "positionDropped": "cpal 0.15 丢弃的帧位置由本探针直接读取；Realtek 实测位置按端点内钟计数（比例≠1），需自标定",
            },
            "padding": {
                "msMedian": pick(&padding, 0.5),
                "msP95": pick(&padding, 0.95),
            },
            "capture": {
                "packets": capture.packets,
                "samples": capture.samples.len(),
                "qpcFallbackPackets": capture.qpc_fallback,
            },
            "markers": {
                "scheduled": marker_frames.len(),
                "detected": latencies.len(),
                "detectionRate": detection_rate,
            },
            "latencyMs": {
                "mean": mean,
                "p50": pick(&latencies, 0.5),
                "p95": pick(&latencies, 0.95),
                "std": latency_std,
                "min": latencies.first().copied().unwrap_or(f64::NAN),
                "max": latencies.last().copied().unwrap_or(f64::NAN),
            },
            "correlationPeakNormMedian": median_of(&peak_norms),
            "verdict": {
                "correlationEvidence": verdict_ok,
                "deviceClockUsable": clock_usable,
            },
        });
        println!("{}", serde_json::to_string_pretty(&report).unwrap());

        if !verdict_ok {
            std::process::exit(2);
        }
    }
    unsafe {
        CoUninitialize();
    }
}
