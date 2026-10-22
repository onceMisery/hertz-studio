// SPDX-License-Identifier: MIT
//! Reproducible synthetic quality/CPU probe. No audio device, media or network.
use serde_json::json;
use sha2::{Digest, Sha256};
use std::time::Instant;
use vmusic_audio::resample::{Converter, Format, State, ALGORITHM};

fn input(rate: u32, frequency: f64, channels: usize) -> Vec<f32> {
    (0..rate)
        .flat_map(|i| {
            let sample =
                (f64::from(i) * std::f64::consts::TAU * frequency / f64::from(rate)).sin() as f32;
            (0..channels).map(move |_| sample)
        })
        .collect()
}
fn render(src: u32, dst: u32, channels: usize, input: &[f32]) -> (Vec<f32>, f64, f64) {
    let prep = Instant::now();
    let mut r = Converter::new(Format {
        input_rate: src,
        output_rate: dst,
        channels,
    })
    .unwrap();
    let prep_ms = prep.elapsed().as_secs_f64() * 1000.0;
    let expected =
        (input.len() as u64 / channels as u64 * u64::from(dst)).div_ceil(u64::from(src)) as usize;
    let mut result = Vec::with_capacity(expected * channels);
    let mut out = vec![0.0; 997 * channels];
    let timer = Instant::now();
    for block in input.chunks(1031 * channels) {
        let mut at = 0;
        loop {
            let p = r.process(&block[at..], &mut out).unwrap();
            at += p.consumed_frames * channels;
            result.extend_from_slice(&out[..p.produced_frames * channels]);
            if at == block.len() && p.state != State::NeedOutput {
                break;
            }
        }
    }
    loop {
        let p = r.finish(&mut out).unwrap();
        result.extend_from_slice(&out[..p.produced_frames * channels]);
        if p.state == State::Finished {
            break;
        }
    }
    let seconds = timer.elapsed().as_secs_f64();
    assert_eq!(result.len(), expected * channels);
    assert!(result.iter().all(|v| v.is_finite()));
    (result, seconds, prep_ms)
}
fn amplitude(data: &[f32], rate: u32, frequency: f64, channels: usize) -> f64 {
    let start = rate as usize / 4;
    let n = rate as usize / 2;
    let (sin, cos) = data
        .chunks_exact(channels)
        .skip(start)
        .take(n)
        .enumerate()
        .fold((0.0, 0.0), |(s, c), (i, v)| {
            let phase = std::f64::consts::TAU * frequency * (i + start) as f64 / f64::from(rate);
            (
                s + f64::from(v[0]) * phase.sin(),
                c + f64::from(v[0]) * phase.cos(),
            )
        });
    2.0 * sin.hypot(cos) / n as f64
}
fn linear_reference(input: &[f32], src: u32, dst: u32) -> Vec<f32> {
    // Continuous linear interpolation is a comparison baseline, not another
    // shipping backend or an emulation of the old packet-boundary bug.
    let len = (input.len() as u64 * u64::from(dst)).div_ceil(u64::from(src)) as usize;
    (0..len)
        .map(|i| {
            let pos = i as f64 * f64::from(src) / f64::from(dst);
            let at = pos.floor() as usize;
            let a = input[at];
            let b = input[(at + 1).min(input.len() - 1)];
            a + (b - a) * (pos - at as f64) as f32
        })
        .collect()
}
fn db(amplitude: f64) -> f64 {
    20.0 * amplitude.max(1e-15).log10()
}
fn main() {
    let mut performance = Vec::new();
    let mut quality = Vec::new();
    for src in [44100, 48000, 96000] {
        for dst in [44100, 48000, 96000] {
            for channels in [1, 2] {
                let wave = input(src, 1000.0, channels);
                let mut runs = Vec::new();
                let mut prep = Vec::new();
                let mut gain = 0.0;
                let mut frames = 0;
                for _ in 0..3 {
                    let (out, seconds, prep_ms) = render(src, dst, channels, &wave);
                    runs.push(seconds);
                    prep.push(prep_ms);
                    gain = db(amplitude(&out, dst, 1000.0, channels));
                    frames = out.len() / channels;
                }
                runs.sort_by(f64::total_cmp);
                prep.sort_by(f64::total_cmp);
                assert!(gain.abs() < 0.05);
                performance.push(json!({"inputRate":src,"outputRate":dst,"channels":channels,"inputFrames":src,"outputFrames":frames,
            "audioSecondsPerRun":1,"runs":3,"medianPrepareMs":prep[1],"medianProcessMs":runs[1]*1000.0,"maxProcessMs":runs[2]*1000.0,
            "medianRealTimeFactor":runs[1],"gain1000HzDb":gain}));
            }
        }
    }
    for dst in [44100, 48000] {
        for frequency in [27000.0, 30000.0, 40000.0] {
            let wave = input(96000, frequency, 1);
            let (out, _, _) = render(96000, dst, 1, &wave);
            let baseline = linear_reference(&wave, 96000, dst);
            let alias = (frequency - (frequency / f64::from(dst)).round() * f64::from(dst)).abs();
            let sinc = db(amplitude(&out, dst, alias, 1));
            let linear = db(amplitude(&baseline, dst, alias, 1));
            assert!(sinc < -80.0);
            quality.push(json!({"inputRate":96000,"outputRate":dst,"inputFrequencyHz":frequency,"aliasFrequencyHz":alias,
            "sincAliasDb":sinc,"linearReferenceAliasDb":linear,"requiredMaxSincAliasDb":-80}));
        }
    }
    let hash = |bytes: &[u8]| format!("{:x}", Sha256::digest(bytes));
    println!("{}",serde_json::to_string_pretty(&json!({"schemaVersion":1,"algorithm":ALGORITHM,
        "os":std::env::consts::OS,"arch":std::env::consts::ARCH,"cpu":std::env::var("PROCESSOR_IDENTIFIER").ok(),
        "debugAssertions":cfg!(debug_assertions),"sourceHash":hash(include_bytes!("../src/resample.rs")),
        "backendHash":hash(include_bytes!("../src/cpal_backend.rs")),"lockHash":hash(include_bytes!("../../../Cargo.lock")),
        "performance":performance,"quality":quality,"realSoundCardVerified":false,"releaseEligible":false})).unwrap());
}
