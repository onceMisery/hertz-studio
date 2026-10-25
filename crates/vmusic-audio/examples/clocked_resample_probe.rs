// SPDX-License-Identifier: MIT
//! 可变比转换的可复现合成质量/CPU 探针。无音频设备、媒体或网络。
//!
//! 运行：`cargo run --release -p vmusic-audio --example clocked_resample_probe`。
//! 报告口径对齐 §12.1 候选线：通带波动 ≤0.1dB、代表转换组合混叠 ≤−90dBFS、
//! 动态 ppm 无整块跳变/click。候选值需 P0 冻结后才作为验收线。
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::Instant;
use vmusic_audio::clocked_resample::{ClockedConverter, State, ALGORITHM};

fn input(rate: u32, frequency: f64, channels: usize, seconds: f64) -> Vec<f32> {
    let frames = (seconds * f64::from(rate)).round() as usize;
    (0..frames)
        .flat_map(|i| {
            let sample =
                (i as f64 * std::f64::consts::TAU * frequency / f64::from(rate)).sin() as f32;
            (0..channels).map(move |_| sample)
        })
        .collect()
}

/// 驱动整段输入，收集输出（输出缓冲满时空输入续取）。
fn run(converter: &mut ClockedConverter, wave: &[f32], channels: usize) -> (Vec<f32>, f64) {
    let mut out = Vec::new();
    let mut chunk = vec![0.0f32; 960 * channels];
    let timer = Instant::now();
    for block in wave.chunks(1021 * channels) {
        let mut pending = Some(block);
        loop {
            let p = converter
                .process(pending.take().unwrap_or(&[]), &mut chunk)
                .unwrap();
            if p.produced_frames > 0 {
                out.extend_from_slice(&chunk[..p.produced_frames * channels]);
            }
            if p.state == State::NeedInput {
                break;
            }
        }
    }
    (out, timer.elapsed().as_secs_f64())
}

/// 相关法测幅（与 resample_probe 同口径）。窗口取后半段：避开变比 slew
/// 建立期（±500ppm 约 0.7s）带来的频率扫动。
fn amplitude(data: &[f32], channels: usize, frequency: f64, rate: u32) -> f64 {
    let frames = data.len() / channels;
    let start = frames / 2;
    let n = frames / 2;
    let mut sin = 0.0f64;
    let mut cos = 0.0f64;
    for i in start..start + n {
        let phase = std::f64::consts::TAU * frequency * i as f64 / f64::from(rate);
        sin += f64::from(data[i * channels]) * phase.sin();
        cos += f64::from(data[i * channels]) * phase.cos();
    }
    2.0 * sin.hypot(cos) / n as f64
}

fn db(v: f64) -> f64 {
    20.0 * v.max(1e-15).log10()
}

fn max_step(data: &[f32], channels: usize) -> f32 {
    data.chunks_exact(channels)
        .map(|f| f[0])
        .collect::<Vec<_>>()
        .windows(2)
        .map(|w| (w[1] - w[0]).abs())
        .fold(0.0f32, f32::max)
}

fn main() {
    let mut quality = Vec::new();
    let mut passband = Vec::new();
    let mut performance = Vec::new();

    // 通带增益：速率组合 × 漂移。
    for (src, dst) in [
        (48_000u32, 48_000u32),
        (44_100, 48_000),
        (48_000, 44_100),
        (96_000, 48_000),
        (48_000, 96_000),
    ] {
        for ppm in [0.0f64, -500.0, 500.0] {
            let mut converter = ClockedConverter::new(src, dst, 2).unwrap();
            converter.set_drift_ppm(ppm);
            let wave = input(src, 1000.0, 2, 3.0);
            let (out, seconds) = run(&mut converter, &wave, 2);
            // 重采样保持物理频率；只有 ppm 漂移会缩放输出域频率。
            let f_out = 1000.0 * (1.0 + ppm * 1e-6);
            let gain = db(amplitude(&out, 2, f_out, dst));
            assert!(gain.abs() < 0.1, "{src}->{dst} ppm{ppm}: {gain} dB");
            performance.push(json!({
                "inputRate": src, "outputRate": dst, "ppm": ppm,
                "audioSecondsPerRun": 3.0, "processSeconds": seconds,
                "realTimeFactor": seconds / 3.0,
                "gain1000HzDb": gain,
            }));
        }
    }

    // 通带：覆盖可听高频及较低 Nyquist 的 90%，避免 1kHz 测幅掩盖截止错误。
    for (src, dst) in [
        (48_000, 48_000),
        (44_100, 48_000),
        (48_000, 44_100),
        (96_000, 48_000),
        (48_000, 96_000),
    ] {
        for frequency in [1000.0, 10_000.0, 18_000.0, f64::from(src.min(dst)) * 0.45] {
            let mut converter = ClockedConverter::new(src, dst, 1).unwrap();
            let (out, _) = run(&mut converter, &input(src, frequency, 1, 1.0), 1);
            let gain = db(amplitude(&out, 1, frequency, dst));
            passband.push(json!({
                "inputRate": src, "outputRate": dst, "frequencyHz": frequency,
                "gainDb": gain, "requiredMaxAbsGainDb": 0.1,
            }));
            assert!(gain.abs() <= 0.1, "{src}->{dst} {frequency}Hz: {gain}dB");
        }
    }

    // 混叠：96k 输入携带超输出奈奎斯特的音调，48k 输出按折返频率测幅。
    for frequency in [27_000.0f64, 30_000.0, 40_000.0] {
        let mut converter = ClockedConverter::new(96_000, 48_000, 1).unwrap();
        let wave = input(96_000, frequency, 1, 2.0);
        let (out, _) = run(&mut converter, &wave, 1);
        let alias = (frequency - (frequency / 48_000.0).round() * 48_000.0).abs();
        let level = db(amplitude(&out, 1, alias, 48_000));
        quality.push(json!({
            "inputRate": 96_000, "outputRate": 48_000,
            "inputFrequencyHz": frequency, "aliasFrequencyHz": alias,
            "aliasDb": level, "requiredMaxAliasDb": -90,
        }));
        assert!(level < -90.0, "{frequency}Hz 折返 {alias}Hz: {level} dB");
    }

    // 变比阶跃连续性：0 → +500ppm → −500ppm 的相邻样本最大步进对比稳态。
    let mut converter = ClockedConverter::new(48_000, 48_000, 1).unwrap();
    converter.set_drift_ppm(0.0);
    let (_, _) = run(&mut converter, &input(48_000, 1000.0, 1, 1.0), 1);
    converter.set_drift_ppm(500.0);
    let (up, _) = run(&mut converter, &input(48_000, 1000.0, 1, 1.0), 1);
    converter.set_drift_ppm(-500.0);
    let (down, _) = run(&mut converter, &input(48_000, 1000.0, 1, 1.0), 1);
    let steady = max_step(&input(48_000, 1000.0, 1, 1.0), 1);
    let step_up = max_step(&up, 1);
    let step_down = max_step(&down, 1);
    assert!(step_up < steady * 1.5 && step_down < steady * 1.5, "click");

    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "schemaVersion": 2,
            "algorithm": ALGORITHM,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "cpu": std::env::var("PROCESSOR_IDENTIFIER").ok(),
            "debugAssertions": cfg!(debug_assertions),
            "sourceHash": hash(include_bytes!("../src/clocked_resample.rs")),
            "lockHash": hash(include_bytes!("../../../Cargo.lock")),
            "performance": performance,
            "passband": passband,
            "quality": quality,
            "ratioStepMaxStepUp": step_up,
            "ratioStepMaxStepDown": step_down,
            "steadyStateMaxStep": steady,
            "realSoundCardVerified": false,
        }))
        .unwrap()
    );
}
