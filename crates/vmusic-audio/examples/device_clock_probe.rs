// SPDX-License-Identifier: MIT
//! CPAL 输出时间戳语义探针（lan-listening §7.2 P0：验证 CPAL 各后端的
//! `OutputCallbackInfo` 是否构成可用的设备时钟锚点）。
//!
//! 只用静音合成输出：时间戳与内容无关，不惊扰扬声器。测量口径：
//! - `callback` / `playback` 时间戳是否推进、是否单调；
//! - `playback` 时间戳增量与帧数/采样率是否一致（同一时钟域，斜率误差 ppm）；
//! - `callback` 时间戳与宿主单调钟（std Instant）的推进速率是否一致；
//! - `playback − callback`（驱动排队提前量估计）的均值/P95/抖动；
//! - 回调到达间隔抖动。
//!
//! 运行：`cargo run --release -p vmusic-audio --example device_clock_probe --
//! --seconds 5 [--rate 48000] [--device 子串]`。JSON 报告打印到 stdout；
//! 退出码 0 = 时间戳可用，2 = 不可用（可脚本门禁）。已知缺口（cpal 0.15
//! WASAPI 丢弃 IAudioClock 的设备帧位置、playback 按可写空间估算）由本探针
//! 实证并在报告中标注，原生 WASAPI 对照由 tools/lan-probe 负责。
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use vmusic_audio::output_clock::{ClockObservation, ClockStatus, OutputClock};

#[derive(Clone, Copy)]
struct CallbackSample {
    /// callback 时间戳相对首帧 callback 的纳秒。
    callback_ns: Option<u128>,
    /// playback 时间戳相对首帧 callback 的纳秒。
    playback_ns: Option<u128>,
    /// 首帧宿主 Instant 之后的纳秒。
    host_ns: u128,
    frames: usize,
}

#[derive(Default)]
struct Collector {
    inner: Mutex<CollectorInner>,
}

#[derive(Default)]
struct CollectorInner {
    origin: Option<(cpal::StreamInstant, std::time::Instant)>,
    samples: Vec<CallbackSample>,
}

impl Collector {
    fn record(&self, info: &cpal::OutputCallbackInfo, frames: usize) {
        let ts = info.timestamp();
        let mut inner = self.inner.lock().unwrap();
        let origin = *inner
            .origin
            .get_or_insert((ts.callback, std::time::Instant::now()));
        inner.samples.push(CallbackSample {
            callback_ns: ts.callback.duration_since(&origin.0).map(|d| d.as_nanos()),
            playback_ns: ts.playback.duration_since(&origin.0).map(|d| d.as_nanos()),
            host_ns: origin.1.elapsed().as_nanos(),
            frames,
        });
    }
}

fn median(sorted: &[f64]) -> f64 {
    if sorted.is_empty() {
        0.0
    } else {
        sorted[sorted.len() / 2]
    }
}

fn p95(sorted: &[f64]) -> f64 {
    if sorted.is_empty() {
        0.0
    } else {
        sorted[((sorted.len() as f64 * 0.95) as usize).min(sorted.len() - 1)]
    }
}

fn mean(values: &[f64]) -> f64 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f64>() / values.len() as f64
    }
}

fn std_dev(values: &[f64], mean: f64) -> f64 {
    if values.len() < 2 {
        0.0
    } else {
        (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64).sqrt()
    }
}

fn main() {
    let mut seconds = 5.0f64;
    let mut rate_wanted = 48_000u32;
    let mut device_substring: Option<String> = None;
    let mut trace_path = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--seconds" => {
                seconds = args.next().and_then(|v| v.parse().ok()).unwrap_or(seconds);
            }
            "--rate" => {
                rate_wanted = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(rate_wanted);
            }
            "--device" => {
                device_substring = args.next();
            }
            "--trace" => trace_path = args.next().map(std::path::PathBuf::from),
            other => {
                eprintln!("未知参数 {other}；支持 --seconds/--rate/--device/--trace");
                std::process::exit(1);
            }
        }
    }

    let host = cpal::default_host();
    let device = match &device_substring {
        None => host.default_output_device(),
        Some(want) => host
            .output_devices()
            .into_iter()
            .flatten()
            .find(|d| d.name().map(|n| n.contains(want)).unwrap_or(false)),
    };
    let Some(device) = device else {
        eprintln!("找不到输出设备");
        std::process::exit(1);
    };
    let device_name = device.name().unwrap_or_default();

    let mut config = None;
    for range in device.supported_output_configs().into_iter().flatten() {
        if range.sample_format() != cpal::SampleFormat::F32 {
            continue;
        }
        let min = range.min_sample_rate().0;
        let max = range.max_sample_rate().0;
        if rate_wanted >= min && rate_wanted <= max {
            config = Some(range.with_sample_rate(cpal::SampleRate(rate_wanted)));
            break;
        }
        config = config.or(Some(
            range.with_sample_rate(cpal::SampleRate(rate_wanted.clamp(min, max))),
        ));
    }
    let Some(config) = config else {
        eprintln!("设备无 f32 输出配置");
        std::process::exit(1);
    };
    let rate = config.sample_rate().0;
    let channels = config.channels().max(1) as usize;

    let collector = Arc::new(Collector::default());
    let sink = collector.clone();
    let stream = device
        .build_output_stream(
            &config.config(),
            move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
                data.fill(0.0);
                sink.record(info, data.len() / channels);
            },
            |err| eprintln!("stream error: {err}"),
            None,
        )
        .expect("build_output_stream");
    stream.play().expect("play");
    eprintln!("探测 {seconds}s：device={device_name} rate={rate} channels={channels}（静音输出）");
    std::thread::sleep(std::time::Duration::from_secs_f64(seconds));
    drop(stream);

    let inner = collector.inner.lock().unwrap();
    let samples = &inner.samples;
    let total_frames: u64 = samples.iter().map(|s| s.frames as u64).sum();

    // Offline replay keeps diagnostic allocation and formatting out of the
    // callback. The optional trace contains only monotonic timestamps, frame
    // counts and estimator readings; it never includes a service profile.
    if let Some(path) = trace_path {
        let mut clock = OutputClock::new(rate, 0).expect("sample rate");
        let mut valid = false;
        let mut failures = 0;
        let mut first_failure_state = None;
        let mut trace = Vec::with_capacity(samples.len());
        for (index, sample) in samples.iter().enumerate() {
            let observation = (|| {
                Some(ClockObservation {
                    callback_ns: u64::try_from(sample.callback_ns?).ok()?,
                    playback_ns: u64::try_from(sample.playback_ns?).ok()?,
                    local_ns: 1_000_000_000u64.checked_add(u64::try_from(sample.host_ns).ok()?)?,
                    frames: sample.frames,
                })
            })();
            let before = first_failure_state.is_none().then(|| format!("{clock:?}"));
            let reading = clock.observe(observation);
            if valid && reading.status != ClockStatus::Valid {
                failures += 1;
                if first_failure_state.is_none() {
                    first_failure_state = Some(json!({"index":index,"before":before}));
                }
            }
            valid = reading.status == ClockStatus::Valid;
            trace.push(json!({
                "callback_ns": observation.map(|o|o.callback_ns),
                "playback_ns": observation.map(|o|o.playback_ns),
                "local_ns": observation.map(|o|o.local_ns),
                "frames": sample.frames,
                "status":format!("{:?}",reading.status),
                "first_frame_local_ns":reading.first_frame_local_ns,
                "device_clock_ppm":reading.device_clock_ppm,
                "uncertainty_ns":reading.uncertainty_ns,
                "fault_count":reading.fault_count,
                "last_fault":reading.last_fault.map(|fault|json!({"kind":format!("{:?}",fault.kind),"value":fault.value})),
            }));
        }
        let trace = json!({"sample_rate":rate,"failures":failures,"first_failure":first_failure_state,"samples":trace});
        std::fs::write(&path, serde_json::to_vec(&trace).expect("serialize trace"))
            .expect("write trace");
        eprintln!(
            "Clock replay: {failures} failures; trace={}",
            path.display()
        );
    }

    // 时间戳回归（duration_since 为 None 或负增量）。
    let mut playback_regressions = 0usize;
    let mut callback_regressions = 0usize;
    let mut prev_cb: Option<u128> = None;
    let mut prev_pb: Option<u128> = None;
    for s in samples.iter() {
        if let (Some(cb), Some(p)) = (s.callback_ns, prev_cb) {
            if cb < p {
                callback_regressions += 1;
            }
        } else if s.callback_ns.is_none() && prev_cb.is_some() {
            callback_regressions += 1;
        }
        prev_cb = s.callback_ns;
        if let (Some(pb), Some(p)) = (s.playback_ns, prev_pb) {
            if pb < p {
                playback_regressions += 1;
            }
        } else if s.playback_ns.is_none() && prev_pb.is_some() {
            playback_regressions += 1;
        }
        prev_pb = s.playback_ns;
    }

    // 斜率：playback 时间戳对累计帧（ns/frame），首尾差分对抖动最稳。
    let mut usable: Vec<(f64, f64, f64)> = Vec::new(); // (playback_ns, cum_frames, callback_ns)
    let mut cum = 0f64;
    for s in samples.iter() {
        if let (Some(pb), Some(cb)) = (s.playback_ns, s.callback_ns) {
            usable.push((pb as f64, cum, cb as f64));
        }
        cum += s.frames as f64;
    }
    let slope_ns_per_frame = if usable.len() >= 2 {
        let (pb0, f0, _) = usable[0];
        let (pb1, f1, _) = usable[usable.len() - 1];
        if f1 - f0 > 0.0 {
            (pb1 - pb0) / (f1 - f0)
        } else {
            0.0
        }
    } else {
        0.0
    };
    let expected_ns_per_frame = 1e9 / f64::from(rate);
    let slope_error_ppm = if expected_ns_per_frame > 0.0 {
        (slope_ns_per_frame - expected_ns_per_frame) / expected_ns_per_frame * 1e6
    } else {
        f64::NAN
    };

    // callback 时间戳 vs 宿主单调钟速率。
    let host_slope = if usable.len() >= 2 {
        let first_cb = samples.iter().find(|s| s.callback_ns.is_some());
        let last_cb = samples.iter().rev().find(|s| s.callback_ns.is_some());
        match (first_cb, last_cb) {
            (Some(a), Some(b)) => {
                let (cb_a, host_a) = (a.callback_ns.unwrap() as f64, a.host_ns as f64);
                let (cb_b, host_b) = (b.callback_ns.unwrap() as f64, b.host_ns as f64);
                if host_b - host_a > 0.0 {
                    (cb_b - cb_a) / (host_b - host_a)
                } else {
                    0.0
                }
            }
            _ => 0.0,
        }
    } else {
        0.0
    };

    // 提前量 playback − callback 与回调间隔抖动。
    let leads: Vec<f64> = samples
        .iter()
        .filter_map(|s| match (s.playback_ns, s.callback_ns) {
            (Some(pb), Some(cb)) => Some(pb as f64 - cb as f64),
            _ => None,
        })
        .collect();
    let mut leads_sorted = leads.clone();
    leads_sorted.sort_by(f64::total_cmp);
    let lead_mean = mean(&leads);
    let lead_std = std_dev(&leads, lead_mean);

    let mut intervals: Vec<f64> = Vec::new();
    for pair in samples.windows(2) {
        if let (Some(a), Some(b)) = (pair[0].callback_ns, pair[1].callback_ns) {
            intervals.push((b - a) as f64);
        }
    }
    let interval_mean = mean(&intervals);
    let interval_std = std_dev(&intervals, interval_mean);

    // 判定门槛（P0 口径，冻结前为候选值），分两类时间戳单独判定：
    // - callback（WASAPI=IAudioClock QPC 位置）：单调且与宿主单调钟同速率
    //   （±1000ppm）即可作设备时钟锚点；
    // - playback（估算的呈现时间）：另需对帧时钟斜率一致（±1000ppm）且
    //   无回归，才可直接当呈现期限；否则设备排队深度须走原生查询。
    let callback_monotonic_ok = callback_regressions == 0;
    let playback_monotonic_ok = playback_regressions == 0;
    let host_domain_ok = host_slope > 0.999 && host_slope < 1.001;
    let slope_ok = slope_error_ppm.abs() < 1000.0;
    let lead_ok = lead_std < 5e6;
    let callback_usable =
        callback_monotonic_ok && host_domain_ok && samples.len() >= 8 && total_frames > 0;
    let playback_usable = playback_monotonic_ok && slope_ok && callback_usable;
    let timestamps_usable = callback_usable;

    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    let report = json!({
        "schemaVersion": 1,
        "probe": "cpal-output-timestamps",
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "cpu": std::env::var("PROCESSOR_IDENTIFIER").ok(),
        "cpalHost": cpal::default_host().id().name(),
        "device": device_name,
        "sampleRate": rate,
        "channels": channels,
        "requestedSeconds": seconds,
        "callbacks": samples.len(),
        "totalFrames": total_frames,
        "framesPerCallbackFirst": samples.first().map(|s| s.frames),
        "playbackRegressions": playback_regressions,
        "callbackRegressions": callback_regressions,
        "slopeNsPerFrame": slope_ns_per_frame,
        "expectedNsPerFrame": expected_ns_per_frame,
        "slopeErrorPpm": slope_error_ppm,
        "callbackVsHostSlope": host_slope,
        "leadNsMean": lead_mean,
        "leadNsMedian": median(&leads_sorted),
        "leadNsP95": p95(&leads_sorted),
        "leadNsStd": lead_std,
        "callbackIntervalNsMean": interval_mean,
        "callbackIntervalNsStd": interval_std,
        "verdict": {
            "callbackMonotonicOk": callback_monotonic_ok,
            "playbackMonotonicOk": playback_monotonic_ok,
            "hostDomainOk": host_domain_ok,
            "slopeOk": slope_ok,
            "leadStableOk": lead_ok,
            "callbackUsable": callback_usable,
            "playbackUsable": playback_usable,
            "timestampsUsable": timestamps_usable,
        },
        "notes": "cpal 0.15 WASAPI：callback=IAudioClock QPC 位置，playback=callback+可写空间（估算，丢弃设备帧位置）；原生对照见 tools/lan-probe",
        "backendHash": hash(include_bytes!("../src/cpal_backend.rs")),
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    if !timestamps_usable {
        std::process::exit(2);
    }
}
