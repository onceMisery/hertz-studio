// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! P0 对时回环实验（lan-listening §7.1/§7.3）。
//!
//! 单进程、两个端点、真实 TCP 回环（127.0.0.1）：控制连接做四时间戳
//! 交换，音频连接按 H=1s 提前量发送 48k/f32 立体声 20ms 合成块。服务端
//! 时钟是带已知偏移与漂移的虚拟钟（模拟另一台机器），客户端用真实单调
//! 钟——估计器误差可对照真值逐样本计算。
//!
//! 应用层注入单向时延/抖动/尖峰（报告标注 shaping=app-layer；它不模拟
//! TCP 重传与排队，两机真实链路的测量另行执行）。退出码 0 = 收敛且尾部
//! P95 误差 < 1ms（P0 候选门槛）。
//!
//! 运行：`cargo run --release -p lan-probe --bin sync-experiment --
//! --seconds 20 --drift-pm 50 --offset-ms 12.5 --delay-ms 1 --jitter-ms 0.3`

use lan_probe::{Estimator, TimeSample};
use serde_json::json;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 音频块 20ms。
const BLOCK_MS: u64 = 20;
const RATE: u32 = 48_000;
const CHANNELS: usize = 2;
/// 发送提前量 H（候选值 1s，§7.3）。
const H_NS: u64 = 1_000_000_000;

/// 服务端虚拟钟：offset_ns + 真时×(1+drift)。
#[derive(Clone)]
struct VClock {
    start: Instant,
    offset_ns: f64,
    drift_ppm: f64,
}

impl VClock {
    fn now(&self) -> u64 {
        let e = self.start.elapsed().as_nanos() as f64;
        (self.offset_ns + e * (1.0 + self.drift_ppm * 1e-6)) as u64
    }
    /// 真实钟差（服务端 − 客户端）在真时 t 处的值。
    fn truth_offset(&self, real_ns: u64) -> i64 {
        (self.offset_ns + real_ns as f64 * self.drift_ppm * 1e-6) as i64
    }
}

struct Config {
    seconds: f64,
    drift_ppm: f64,
    offset_ms: f64,
    delay_ms: f64,
    jitter_ms: f64,
    spike_pct: f64,
    window: usize,
    audio: bool,
}

fn parse_args() -> Config {
    let mut config = Config {
        seconds: 20.0,
        drift_ppm: 50.0,
        offset_ms: 12.5,
        delay_ms: 1.0,
        jitter_ms: 0.3,
        spike_pct: 5.0,
        window: 32,
        audio: true,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut next_f = |slot: &mut f64| {
            if let Some(v) = args.next() {
                if let Ok(parsed) = v.parse() {
                    *slot = parsed;
                }
            }
        };
        match arg.as_str() {
            "--seconds" => next_f(&mut config.seconds),
            "--drift-ppm" => next_f(&mut config.drift_ppm),
            "--offset-ms" => next_f(&mut config.offset_ms),
            "--delay-ms" => next_f(&mut config.delay_ms),
            "--jitter-ms" => next_f(&mut config.jitter_ms),
            "--spike-pct" => next_f(&mut config.spike_pct),
            "--window" => {
                if let Some(v) = args.next() {
                    if let Ok(parsed) = v.parse() {
                        config.window = parsed;
                    }
                }
            }
            "--no-audio" => config.audio = false,
            other => eprintln!("忽略未知参数 {other}"),
        }
    }
    config
}

fn rand01() -> f64 {
    use std::cell::Cell;
    thread_local! {
        static STATE: Cell<u64> = const { Cell::new(0x9E3779B97F4A7C15) };
    }
    STATE.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        (x >> 11) as f64 / (1u64 << 53) as f64
    })
}

/// 应用层单向时延整形：基础 + 均匀抖动 + 概率尖峰。
fn shaping_sleep(base_ms: f64, jitter_ms: f64, spike_pct: f64) {
    let jitter = jitter_ms * 2.0 * (rand01() - 0.5);
    let spike = if rand01() * 100.0 < spike_pct {
        30.0 + rand01() * 20.0
    } else {
        0.0
    };
    std::thread::sleep(Duration::from_secs_f64(
        ((base_ms + jitter + spike).max(0.05)) / 1000.0,
    ));
}

fn read_u32(stream: &mut TcpStream) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    stream.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_u64(stream: &mut TcpStream) -> std::io::Result<u64> {
    let mut b = [0u8; 8];
    stream.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

/// 控制连接：PING{t1} → 整形 → PONG{t1,t2,t3}。
fn server_control(mut stream: TcpStream, clock: VClock, config: Arc<Config>) {
    loop {
        let Ok(tag) = read_u32(&mut stream) else {
            return;
        };
        if tag != 1 {
            return;
        }
        let Ok(t1) = read_u64(&mut stream) else {
            return;
        };
        shaping_sleep(config.delay_ms, config.jitter_ms, config.spike_pct);
        let t2 = clock.now();
        let t3 = clock.now();
        shaping_sleep(config.delay_ms, config.jitter_ms, config.spike_pct);
        let mut msg = Vec::with_capacity(28);
        msg.extend_from_slice(&2u32.to_le_bytes());
        msg.extend_from_slice(&t1.to_le_bytes());
        msg.extend_from_slice(&t2.to_le_bytes());
        msg.extend_from_slice(&t3.to_le_bytes());
        if stream.write_all(&msg).is_err() {
            return;
        }
    }
}

/// 音频连接：20ms 合成块，presentation = t0 + H + seq×20ms，只渲染到
/// 允许的未来水位（presentation ≤ now + H）。
fn server_audio(mut stream: TcpStream, clock: VClock, config: Arc<Config>) {
    let frames_per_block = (RATE as u64 * BLOCK_MS / 1000) as usize;
    let mut pcm = vec![0.0f32; frames_per_block * CHANNELS];
    let t0 = clock.now();
    let mut seq = 0u64;
    loop {
        let presentation = t0 + H_NS + seq * BLOCK_MS * 1_000_000;
        while presentation > clock.now() + H_NS {
            std::thread::sleep(Duration::from_millis(5));
            if clock.start.elapsed().as_secs_f64() > config.seconds + 2.0 {
                return;
            }
        }
        for (i, slot) in pcm.iter_mut().enumerate() {
            let frame = seq as f64 * frames_per_block as f64 + (i / CHANNELS) as f64;
            *slot = (0.1 * (frame * std::f64::consts::TAU * 1000.0 / f64::from(RATE)).sin()) as f32;
        }
        let mut msg = Vec::with_capacity(32 + pcm.len() * 4);
        msg.extend_from_slice(&3u32.to_le_bytes());
        msg.extend_from_slice(&seq.to_le_bytes());
        msg.extend_from_slice(&(seq * frames_per_block as u64).to_le_bytes());
        msg.extend_from_slice(&presentation.to_le_bytes());
        msg.extend_from_slice(&(frames_per_block as u32).to_le_bytes());
        for v in &pcm {
            msg.extend_from_slice(&v.to_le_bytes());
        }
        if stream.write_all(&msg).is_err() {
            return;
        }
        seq += 1;
    }
}

#[derive(Default)]
struct AudioStats {
    blocks: u64,
    late_blocks: u64,
    h_overshoot: u64,
    slack_ms: Vec<f64>,
}

fn main() {
    let config = Arc::new(parse_args());
    let start = Instant::now();
    let server_clock = VClock {
        start,
        offset_ns: config.offset_ms * 1e6,
        drift_ppm: config.drift_ppm,
    };

    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().unwrap();

    // 服务端：第一条连接固定是控制，音频连接按需第二条。
    let clock = server_clock.clone();
    let cfg = config.clone();
    let want_audio = config.audio;
    let server = std::thread::spawn(move || {
        let (control, _) = listener.accept().expect("accept control");
        control.set_nodelay(true).ok();
        let control_thread = {
            let clock = clock.clone();
            let cfg = cfg.clone();
            std::thread::spawn(move || server_control(control, clock, cfg))
        };
        if want_audio {
            let (audio, _) = listener.accept().expect("accept audio");
            server_audio(audio, clock, cfg);
        }
        control_thread.join().ok();
    });

    let mut control = TcpStream::connect(addr).expect("connect control");
    control.set_nodelay(true).ok();
    let audio = if config.audio {
        Some(TcpStream::connect(addr).expect("connect audio"))
    } else {
        None
    };

    // 客户端：真时单调钟。
    let estimator = Arc::new(Mutex::new(Estimator::new(config.window, 3.0)));
    let samples_log = Arc::new(Mutex::new(Vec::<(f64, f64)>::new()));
    let audio_stats = Arc::new(Mutex::new(AudioStats::default()));

    if let Some(mut audio_stream) = audio {
        let stats = audio_stats.clone();
        let est = estimator.clone();
        let origin = start;
        std::thread::spawn(move || loop {
            let Ok(tag) = read_u32(&mut audio_stream) else {
                return;
            };
            if tag != 3 {
                return;
            }
            let Ok(_seq) = read_u64(&mut audio_stream) else {
                return;
            };
            let Ok(_frame_index) = read_u64(&mut audio_stream) else {
                return;
            };
            let Ok(presentation) = read_u64(&mut audio_stream) else {
                return;
            };
            let Ok(frame_count) = read_u32(&mut audio_stream) else {
                return;
            };
            let mut payload = vec![0u8; frame_count as usize * CHANNELS * 4];
            if audio_stream.read_exact(&mut payload).is_err() {
                return;
            }
            let client_now = origin.elapsed().as_nanos() as u64;
            let offset = est
                .lock()
                .unwrap()
                .estimate()
                .map(|e| e.offset_ns)
                .unwrap_or(0);
            let slack_ms = (presentation as i64 - offset - client_now as i64) as f64 / 1e6;
            let mut s = stats.lock().unwrap();
            s.blocks += 1;
            s.slack_ms.push(slack_ms);
            if slack_ms < 50.0 {
                s.late_blocks += 1;
            }
            if slack_ms > H_NS as f64 / 1e6 + 100.0 {
                s.h_overshoot += 1;
            }
        });
    }

    // 对时循环：初始快速采样（2ms×25），随后 100ms 周期。
    let deadline = Instant::now() + Duration::from_secs_f64(config.seconds);
    let mut i = 0u64;
    while Instant::now() < deadline {
        let t1 = start.elapsed().as_nanos() as u64;
        let mut msg = Vec::with_capacity(12);
        msg.extend_from_slice(&1u32.to_le_bytes());
        msg.extend_from_slice(&t1.to_le_bytes());
        control.write_all(&msg).expect("write ping");
        let mut tag = [0u8; 4];
        if control.read_exact(&mut tag).is_err() {
            break;
        }
        debug_assert_eq!(u32::from_le_bytes(tag), 2);
        let t1_echo = read_u64(&mut control).unwrap();
        let t2 = read_u64(&mut control).unwrap();
        let t3 = read_u64(&mut control).unwrap();
        let t4 = start.elapsed().as_nanos() as u64;
        let sample = TimeSample {
            t1: t1_echo,
            t2,
            t3,
            t4,
        };
        // 真值：服务端虚拟钟在客户端中点真时的钟差。
        let truth = server_clock.truth_offset((t1 + t4) / 2);
        estimator.lock().unwrap().push(sample);
        if let Some(e) = estimator.lock().unwrap().estimate() {
            let err_ms = (e.offset_ns - truth) as f64 / 1e6;
            samples_log
                .lock()
                .unwrap()
                .push((start.elapsed().as_secs_f64(), err_ms));
        }
        i += 1;
        std::thread::sleep(if i < 25 {
            Duration::from_millis(2)
        } else {
            Duration::from_millis(100)
        });
    }
    drop(control);
    server.join().ok();

    // 汇总。
    let log = samples_log.lock().unwrap().clone();
    let estimator_guard = estimator.lock().unwrap();
    let Some(est) = estimator_guard.estimate() else {
        eprintln!("没有可用估计样本");
        std::process::exit(2);
    };
    let mut errors: Vec<f64> = log.iter().map(|(_, e)| e.abs()).collect();
    errors.sort_by(f64::total_cmp);
    let mut tail: Vec<f64> = log
        .iter()
        .filter(|(t, _)| *t > config.seconds * 0.5)
        .map(|(_, e)| e.abs())
        .collect();
    tail.sort_by(f64::total_cmp);
    // 收敛：最后一次 |err| ≥ 1ms 之后的时间（其后全部 < 1ms）。
    let convergence_ms = log
        .iter()
        .rev()
        .find(|(_, e)| e.abs() >= 1.0)
        .map(|(t, _)| t * 1000.0)
        .unwrap_or(0.0);
    let p95 = if tail.is_empty() {
        f64::INFINITY
    } else {
        tail[(tail.len() as f64 * 0.95) as usize % tail.len()]
    };

    let audio = audio_stats.lock().unwrap();
    let mut slack_sorted = audio.slack_ms.clone();
    slack_sorted.sort_by(f64::total_cmp);
    let pick = |v: &[f64], q: f64| {
        if v.is_empty() {
            0.0
        } else {
            v[((v.len() as f64 * q) as usize).min(v.len() - 1)]
        }
    };
    let report = json!({
        "schemaVersion": 1,
        "probe": "loopback-time-sync",
        "os": std::env::consts::OS,
        "shaping": "app-layer",
        "config": {
            "seconds": config.seconds,
            "groundTruthOffsetMs": config.offset_ms,
            "groundTruthDriftPpm": config.drift_ppm,
            "oneWayDelayMs": config.delay_ms,
            "jitterMs": config.jitter_ms,
            "spikePct": config.spike_pct,
            "estimatorWindow": config.window,
            "leadHMs": H_NS as f64 / 1e6,
            "audioRate": RATE,
            "audioChannels": CHANNELS,
            "blockMs": BLOCK_MS,
        },
        "samples": log.len(),
        "accepted": est.accepted,
        "rejected": est.rejected,
        "discontinuities": estimator_guard.discontinuities(),
        "offsetErrorMs": {
            "p50": pick(&errors, 0.5),
            "p95AfterHalf": p95,
            "maxAbs": errors.last().copied().unwrap_or(f64::INFINITY),
        },
        "convergenceTo1msMs": convergence_ms,
        "driftEstimatePpm": est.drift_ppm,
        "driftTruthPpm": config.drift_ppm,
        "rttMinMs": est.rtt_ns as f64 / 1e6,
        "uncertaintyMs": est.uncertainty_ns as f64 / 1e6,
        "audio": {
            "blocks": audio.blocks,
            "lateBlocks": audio.late_blocks,
            "hOvershoot": audio.h_overshoot,
            "slackMsMedian": pick(&slack_sorted, 0.5),
            "slackMsP95": pick(&slack_sorted, 0.95),
            "slackMsMin": slack_sorted.first().copied().unwrap_or(0.0),
        },
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    let _ = i;
    if !(convergence_ms.is_finite() && p95 < 1.0) {
        std::process::exit(2);
    }
}
