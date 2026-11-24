// SPDX-License-Identifier: MIT
//! Bounded WAV correction import and odd symmetric FIR preparation, outside realtime.
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use vmusic_core::{impulse::ImpulseKernel, AudioError};
const MAX_BYTES: usize = 8 * 1024 * 1024;
const MAX_TAPS: usize = 32768;
const GENERATED_TAPS: usize = 257;
const GENERATION_FFT_SIZE: usize = 16384;
const MAX_RESPONSE_ERROR_DB: f64 = 3.0;

/// Desired absolute magnitude response, not a measurement or an inverted
/// headphone response. The caller owns how measurement and target were combined.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrequencyPoint {
    pub frequency_hz: f64,
    pub gain_db: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RealizedFrequencyPoint {
    pub frequency_hz: f64,
    pub requested_db: f64,
    pub realized_db: f64,
    pub error_db: f64,
    /// Gain after the explicitly reported conservative playback attenuation.
    pub playback_db: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GenerationReport {
    pub algorithm: &'static str,
    pub interpolation: &'static str,
    pub sample_rate: u32,
    pub taps: usize,
    pub delay_frames: usize,
    pub delay_ms: f64,
    pub attenuation_db: f32,
    /// Error is checked on both a linear and a logarithmic grid, augmented by
    /// every exact control point. This is not an all-frequency proof.
    pub verification_points: usize,
    pub max_error_db: f64,
    pub rms_error_db: f64,
    pub worst_frequency_hz: f64,
    pub acceptance_limit_db: f64,
    pub control_points: Vec<RealizedFrequencyPoint>,
    pub response: Vec<RealizedFrequencyPoint>,
}

pub struct GeneratedImpulse {
    /// Mono IEEE float32 WAV, retaining the user's requested absolute level.
    pub wav: Vec<u8>,
    pub report: GenerationReport,
}

/// Generate one bounded, odd symmetric linear-phase correction FIR off the
/// callback thread. Short FIRs cannot reproduce arbitrary sharp/low-frequency
/// features; reject requests exceeding the measured representation tolerance.
pub fn generate_fir(points: &[FrequencyPoint], rate: u32) -> Result<GeneratedImpulse, AudioError> {
    generate_fir_cancellable(points, rate, &AtomicBool::new(false))
}

pub fn generate_fir_cancellable(
    points: &[FrequencyPoint],
    rate: u32,
    cancelled: &AtomicBool,
) -> Result<GeneratedImpulse, AudioError> {
    use rustfft::{num_complex::Complex, FftPlanner};
    check_cancelled(cancelled)?;
    validate_curve(points, rate)?;
    let nyquist = f64::from(rate) * 0.5;
    let mut spectrum = vec![Complex::new(0.0, 0.0); GENERATION_FFT_SIZE];
    for bin in 0..=GENERATION_FFT_SIZE / 2 {
        if bin % 128 == 0 {
            check_cancelled(cancelled)?;
        }
        let frequency = bin as f64 * f64::from(rate) / GENERATION_FFT_SIZE as f64;
        let magnitude = 10.0f64.powf(target_db(points, frequency) / 20.0);
        spectrum[bin].re = magnitude;
        if bin != 0 && bin != GENERATION_FFT_SIZE / 2 {
            spectrum[GENERATION_FFT_SIZE - bin].re = magnitude;
        }
    }
    let fft = FftPlanner::<f64>::new().plan_fft_inverse(GENERATION_FFT_SIZE);
    check_cancelled(cancelled)?;
    fft.process(&mut spectrum);
    check_cancelled(cancelled)?;
    let half = GENERATED_TAPS / 2;
    let mut taps = vec![0.0f32; GENERATED_TAPS];
    for distance in 0..=half {
        check_cancelled(cancelled)?;
        // Even Blackman window about the known group-delay center. Average the
        // conjugate impulse pair only to remove numerical FFT asymmetry.
        let phase = std::f64::consts::PI * distance as f64 / half as f64;
        let window = 0.42 + 0.5 * phase.cos() + 0.08 * (2.0 * phase).cos();
        let paired = if distance == 0 {
            spectrum[0].re
        } else {
            (spectrum[distance].re + spectrum[GENERATION_FFT_SIZE - distance].re) * 0.5
        };
        let tap = (paired * window / GENERATION_FFT_SIZE as f64) as f32;
        taps[half - distance] = tap;
        taps[half + distance] = tap;
    }
    let attenuation_db = conservative_attenuation(std::slice::from_ref(&taps))?;
    let mut verification = Vec::with_capacity(4164);
    for index in 0..=2048 {
        verification.push(nyquist * index as f64 / 2048.0);
        verification.push(20.0 * (nyquist / 20.0).powf(index as f64 / 2048.0));
    }
    verification.extend(points.iter().map(|point| point.frequency_hz));
    let mut max_error_db = 0.0;
    let mut squared_error = 0.0;
    let mut worst_frequency_hz = 0.0;
    for &frequency in &verification {
        check_cancelled(cancelled)?;
        let error = (response_db(&taps, rate, frequency) - target_db(points, frequency)).abs();
        squared_error += error * error;
        if error > max_error_db {
            max_error_db = error;
            worst_frequency_hz = frequency;
        }
    }
    if !max_error_db.is_finite() || max_error_db > MAX_RESPONSE_ERROR_DB {
        return Err(invalid(&format!(
            "257 taps 无法表示该曲线：采样检查最大误差 {max_error_db:.2} dB（{worst_frequency_hz:.1} Hz），上限 {MAX_RESPONSE_ERROR_DB:.1} dB；请减少窄峰或陡变，不会自动改变目标增益"
        )));
    }
    let realize = |frequency| {
        let requested_db = target_db(points, frequency);
        let realized_db = response_db(&taps, rate, frequency);
        RealizedFrequencyPoint {
            frequency_hz: frequency,
            requested_db,
            realized_db,
            error_db: realized_db - requested_db,
            playback_db: realized_db + f64::from(attenuation_db),
        }
    };
    let control_points = points
        .iter()
        .map(|point| realize(point.frequency_hz))
        .collect();
    let mut response = Vec::with_capacity(130);
    response.push(realize(0.0));
    for index in 0..=128 {
        check_cancelled(cancelled)?;
        response.push(realize(20.0 * (nyquist / 20.0).powf(index as f64 / 128.0)));
    }
    check_cancelled(cancelled)?;
    Ok(GeneratedImpulse {
        wav: encode_mono_float_wav(&taps, rate),
        report: GenerationReport {
            algorithm: "windowed-frequency-sampling-blackman-v1",
            interpolation: "linear_db_over_log_frequency_endpoint_hold",
            sample_rate: rate,
            taps: GENERATED_TAPS,
            delay_frames: half,
            delay_ms: half as f64 * 1000.0 / f64::from(rate),
            attenuation_db,
            verification_points: verification.len(),
            max_error_db,
            rms_error_db: (squared_error / verification.len() as f64).sqrt(),
            worst_frequency_hz,
            acceptance_limit_db: MAX_RESPONSE_ERROR_DB,
            control_points,
            response,
        },
    })
}

pub fn validate_curve(points: &[FrequencyPoint], rate: u32) -> Result<(), AudioError> {
    if !matches!(rate, 44100 | 48000 | 96000) {
        return Err(invalid("FIR 生成只支持实际 44.1/48/96 kHz 处理率"));
    }
    if !(2..=64).contains(&points.len()) {
        return Err(invalid("FIR 曲线需要 2–64 个控制点"));
    }
    let mut previous = 0.0;
    for point in points {
        if !point.frequency_hz.is_finite()
            || !point.gain_db.is_finite()
            || !(20.0..=f64::from(rate) * 0.5).contains(&point.frequency_hz)
            || point.frequency_hz <= previous
            || !(-24.0..=12.0).contains(&point.gain_db)
        {
            return Err(invalid(
                "控制点频率须在 20 Hz 至当前 Nyquist 之间严格递增，增益须为有限的 −24 至 +12 dB",
            ));
        }
        previous = point.frequency_hz;
    }
    Ok(())
}

fn target_db(points: &[FrequencyPoint], frequency: f64) -> f64 {
    if frequency <= points[0].frequency_hz {
        return points[0].gain_db;
    }
    let index = points.partition_point(|point| point.frequency_hz < frequency);
    if index == points.len() {
        return points[points.len() - 1].gain_db;
    }
    let (left, right) = (points[index - 1], points[index]);
    // ln_1p keeps adjacent representable input frequencies well-defined even
    // when rounding their quotient would otherwise produce exactly 1.0.
    let fraction = ((frequency - left.frequency_hz) / left.frequency_hz).ln_1p()
        / ((right.frequency_hz - left.frequency_hz) / left.frequency_hz).ln_1p();
    left.gain_db + fraction * (right.gain_db - left.gain_db)
}

fn response_db(taps: &[f32], rate: u32, frequency: f64) -> f64 {
    let center = taps.len() / 2;
    let omega = std::f64::consts::TAU * frequency / f64::from(rate);
    let magnitude = f64::from(taps[center])
        + (1..=center)
            .map(|distance| {
                2.0 * f64::from(taps[center - distance]) * (omega * distance as f64).cos()
            })
            .sum::<f64>();
    20.0 * magnitude.abs().max(1e-12).log10()
}

fn encode_mono_float_wav(samples: &[f32], rate: u32) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(44 + samples.len() * 4);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + samples.len() as u32 * 4).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt \x10\0\0\0\x03\0\x01\0");
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * 4).to_le_bytes());
    bytes.extend_from_slice(b"\x04\0\x20\0data");
    bytes.extend_from_slice(&(samples.len() as u32 * 4).to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

fn conservative_attenuation(channels: &[Vec<f32>]) -> Result<f32, AudioError> {
    let bound = channels
        .iter()
        .map(|channel| {
            channel
                .iter()
                .map(|sample| f64::from(sample.abs()))
                .sum::<f64>()
        })
        .fold(0.0f64, f64::max);
    if bound == 0.0 || !bound.is_finite() {
        return Err(invalid("全零或无效校正核不会产生声音"));
    }
    Ok(-(20.0 * bound.max(1.0).log10()) as f32)
}
fn invalid(message: &str) -> AudioError {
    AudioError::UnsupportedFormat(message.into())
}
fn check_cancelled(cancelled: &AtomicBool) -> Result<(), AudioError> {
    if cancelled.load(Ordering::Acquire) {
        Err(invalid("校正任务已取消"))
    } else {
        Ok(())
    }
}
fn u16le(bytes: &[u8], i: usize) -> Result<u16, AudioError> {
    Ok(u16::from_le_bytes(
        bytes
            .get(i..i + 2)
            .ok_or_else(|| invalid("WAV 字段截断"))?
            .try_into()
            .unwrap(),
    ))
}
fn u32le(bytes: &[u8], i: usize) -> Result<u32, AudioError> {
    Ok(u32::from_le_bytes(
        bytes
            .get(i..i + 4)
            .ok_or_else(|| invalid("WAV 字段截断"))?
            .try_into()
            .unwrap(),
    ))
}

pub fn prepare_wav(bytes: &[u8], id: String, rate: u32) -> Result<ImpulseKernel, AudioError> {
    prepare_wav_cancellable(bytes, id, rate, &AtomicBool::new(false))
}

pub fn prepare_wav_cancellable(
    bytes: &[u8],
    id: String,
    rate: u32,
    cancelled: &AtomicBool,
) -> Result<ImpulseKernel, AudioError> {
    check_cancelled(cancelled)?;
    if bytes.len() > MAX_BYTES
        || bytes.len() < 44
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WAVE"
        || u32le(bytes, 4)? as usize + 8 != bytes.len()
    {
        return Err(invalid("需要完整且不超过 8 MiB 的 RIFF WAV"));
    }
    let mut format = None;
    let mut pcm = None;
    let mut cursor = 12usize;
    while cursor + 8 <= bytes.len() {
        check_cancelled(cancelled)?;
        let len = u32le(bytes, cursor + 4)? as usize;
        let end = cursor
            .checked_add(8 + len)
            .filter(|v| *v <= bytes.len())
            .ok_or_else(|| invalid("WAV chunk 越界"))?;
        let chunk = &bytes[cursor + 8..end];
        match &bytes[cursor..cursor + 4] {
            b"fmt " => {
                if format.is_some() {
                    return Err(invalid("WAV fmt 重复"));
                }
                format = Some(chunk);
            }
            b"data" => {
                if pcm.is_some() {
                    return Err(invalid("WAV data 重复"));
                }
                pcm = Some(chunk);
            }
            _ => {}
        }
        cursor = end + (len % 2);
    }
    if cursor != bytes.len() {
        return Err(invalid("WAV 尾部格式无效"));
    }
    let f = format.ok_or_else(|| invalid("缺少 WAV fmt"))?;
    let pcm = pcm.ok_or_else(|| invalid("缺少 WAV data"))?;
    let tag = u16le(f, 0)?;
    let channels = u16le(f, 2)? as usize;
    let source_rate = u32le(f, 4)?;
    let align = u16le(f, 12)? as usize;
    let bits = u16le(f, 14)?;
    if !(1..=2).contains(&channels)
        || !(8000..=192000).contains(&source_rate)
        || !matches!((tag, bits), (1, 16) | (1, 24) | (1, 32) | (3, 32))
        || align != channels * bits as usize / 8
        || pcm.len() % align != 0
    {
        return Err(invalid(
            "IR 只接受单/双声道 8–192 kHz PCM16/24/32 或 float32 WAV",
        ));
    }
    let frames = pcm.len() / align;
    if frames == 0 || frames > MAX_TAPS {
        return Err(invalid("IR 长度须为 1–32768 taps"));
    }
    let mut source = vec![vec![0.0f32; frames]; channels];
    let width = bits as usize / 8;
    for i in 0..frames {
        if i % 128 == 0 {
            check_cancelled(cancelled)?;
        }
        for ch in 0..channels {
            let sample = &pcm[i * align + ch * width..i * align + (ch + 1) * width];
            source[ch][i] = match (tag, bits) {
                (3, 32) => f32::from_le_bytes(sample.try_into().unwrap()),
                (1, 16) => i16::from_le_bytes(sample.try_into().unwrap()) as f32 / 32768.0,
                (1, 24) => {
                    let value = ((sample[0] as i32)
                        | ((sample[1] as i32) << 8)
                        | ((sample[2] as i32) << 16))
                        << 8
                        >> 8;
                    value as f32 / 8388608.0
                }
                (1, 32) => i32::from_le_bytes(sample.try_into().unwrap()) as f32 / 2147483648.0,
                _ => unreachable!(),
            };
        }
    }
    if source.iter().flatten().any(|v| !v.is_finite()) {
        return Err(invalid("IR 含非有限样本"));
    }
    if frames % 2 == 0
        || source.iter().any(|c| {
            c.iter()
                .zip(c.iter().rev())
                .any(|(a, b)| (a - b).abs() > 1e-6)
        })
    {
        return Err(invalid(
            "此 IR 的固定群延迟未确定；正式播放仅接受奇数长度的对称线性相位校正核",
        ));
    }
    if !matches!(rate, 44100 | 48000 | 96000) {
        return Err(invalid("校正当前只支持 44.1/48/96 kHz 输出"));
    }
    let support = if source_rate == rate { 0.0 } else { 32.0 };
    let target_half =
        (((frames - 1) as f64 * 0.5 + support) * rate as f64 / source_rate as f64).ceil() as usize;
    let target_frames = target_half * 2 + 1;
    if target_frames > 257 {
        return Err(invalid(
            "重采样后的校正核超过首批实时预算（257 taps）；请使用更短的线性相位校正",
        ));
    }
    let prepared = if source_rate == rate {
        source
    } else {
        source
            .iter()
            .map(|samples| -> Result<Vec<f32>, AudioError> {
                let mut result = vec![0.0; target_frames];
                let center = (samples.len() - 1) as f64 * 0.5;
                let cutoff = (rate as f64 / source_rate as f64).min(1.0);
                for (n, out) in result.iter_mut().enumerate() {
                    check_cancelled(cancelled)?;
                    let position =
                        center + (n as f64 - target_half as f64) * source_rate as f64 / rate as f64;
                    let mut value = 0.0;
                    for k in (position.floor() as isize - 32)..=(position.floor() as isize + 32) {
                        if k < 0 || k as usize >= samples.len() {
                            continue;
                        }
                        let x = position - k as f64;
                        let sinc = if x.abs() < 1e-12 {
                            cutoff
                        } else {
                            (std::f64::consts::PI * x * cutoff).sin() / (std::f64::consts::PI * x)
                        };
                        let window = if x.abs() <= 32.0 {
                            0.5 + 0.5 * (std::f64::consts::PI * x / 32.0).cos()
                        } else {
                            0.0
                        };
                        value += samples[k as usize] as f64 * sinc * window;
                    }
                    *out = (value * source_rate as f64 / rate as f64) as f32;
                }
                // Remove only floating-point roundoff asymmetry, not source phase.
                for i in 0..target_half {
                    let v = (result[i] + result[target_frames - 1 - i]) * 0.5;
                    result[i] = v;
                    result[target_frames - 1 - i] = v;
                }
                Ok(result)
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    let attenuation = conservative_attenuation(&prepared)?;
    let kernel = ImpulseKernel {
        resource_id: id,
        sample_rate: rate,
        channels: prepared,
        delay_frames: target_half,
        attenuation_db: attenuation,
    };
    kernel.validate()?;
    check_cancelled(cancelled)?;
    Ok(kernel)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn point(frequency_hz: f64, gain_db: f64) -> FrequencyPoint {
        FrequencyPoint {
            frequency_hz,
            gain_db,
        }
    }

    fn independent_response_db(samples: &[f32], rate: u32, frequency: f64) -> f64 {
        let (real, imaginary) =
            samples
                .iter()
                .enumerate()
                .fold((0.0, 0.0), |(re, im), (index, sample)| {
                    let angle = std::f64::consts::TAU * frequency * index as f64 / f64::from(rate);
                    (
                        re + f64::from(*sample) * angle.cos(),
                        im - f64::from(*sample) * angle.sin(),
                    )
                });
        20.0 * real.hypot(imaginary).max(1e-12).log10()
    }

    #[test]
    fn generated_flat_levels_preserve_absolute_gain_and_report_separate_attenuation() {
        for rate in [44100, 48000, 96000] {
            for gain in [-24.0, -6.0, 0.0, 6.0, 12.0] {
                let generated =
                    generate_fir(&[point(20.0, gain), point(20_000.0, gain)], rate).unwrap();
                let prepared = prepare_wav(&generated.wav, "f".repeat(64), rate).unwrap();
                let samples = &prepared.channels[0];
                assert_eq!(samples.len(), 257);
                assert_eq!(prepared.delay_frames, 128);
                assert!(samples
                    .iter()
                    .zip(samples.iter().rev())
                    .all(|(left, right)| left.to_bits() == right.to_bits()));
                let amplitude = 10.0f64.powf(gain / 20.0);
                assert!((f64::from(samples[128]) - amplitude).abs() < 1e-6);
                assert!(samples
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| *index != 128)
                    .all(|(_, sample)| sample.abs() < 1e-6));
                assert!((f64::from(prepared.attenuation_db) + gain.max(0.0)).abs() < 1e-5);
                assert_eq!(prepared.attenuation_db, generated.report.attenuation_db);
                assert!(generated.report.max_error_db < 1e-5);
                for frequency in [0.0, 20.0, 1000.0, 20_000.0, f64::from(rate) * 0.5] {
                    assert!(
                        (independent_response_db(samples, rate, frequency) - gain).abs() < 1e-5
                    );
                }
            }
        }
    }

    #[test]
    fn generated_broad_curve_reports_realized_response_against_independent_dft() {
        let points = [
            point(20.0, -3.0),
            point(500.0, -3.0),
            point(2000.0, 0.0),
            point(8000.0, 3.0),
            point(20_000.0, 3.0),
        ];
        for rate in [44100, 48000, 96000] {
            let generated = generate_fir(&points, rate).unwrap();
            let prepared = prepare_wav(&generated.wav, "a".repeat(64), rate).unwrap();
            assert!(
                generated.report.max_error_db < 1.0,
                "{}",
                generated.report.max_error_db
            );
            assert!(generated.report.verification_points >= 4098 + points.len());
            assert_eq!(generated.report.control_points.len(), points.len());
            assert!(generated.report.attenuation_db < -3.0);
            for response in generated
                .report
                .control_points
                .iter()
                .chain(&generated.report.response)
            {
                let measured =
                    independent_response_db(&prepared.channels[0], rate, response.frequency_hz);
                assert!((measured - response.realized_db).abs() < 1e-8);
                assert!(
                    (response.realized_db + f64::from(prepared.attenuation_db)
                        - response.playback_db)
                        .abs()
                        < 1e-10
                );
            }
        }
    }

    #[test]
    fn generated_curve_refuses_unrepresentable_narrow_low_frequency_notch() {
        let points = [
            point(20.0, 0.0),
            point(99.0, 0.0),
            point(100.0, -24.0),
            point(101.0, 0.0),
            point(20_000.0, 0.0),
        ];
        let error = generate_fir(&points, 48_000).err().unwrap().to_string();
        assert!(error.contains("257 taps 无法表示"));
        assert!(error.contains("误差"));
    }

    #[test]
    fn curve_validation_rejects_nonfinite_order_range_rate_and_size_errors() {
        let valid = [point(20.0, 0.0), point(20_000.0, 0.0)];
        assert!(validate_curve(&valid, 48000).is_ok());
        assert!(validate_curve(&valid, 192000).is_err());
        assert!(validate_curve(&valid[..1], 48000).is_err());
        assert!(validate_curve(&vec![point(20.0, 0.0); 65], 48000).is_err());
        for bad in [
            point(f64::NAN, 0.0),
            point(f64::INFINITY, 0.0),
            point(19.9, 0.0),
            point(24000.1, 0.0),
            point(20_000.0, f64::NAN),
            point(20_000.0, 12.1),
            point(20_000.0, -24.1),
            point(20.0, 0.0),
        ] {
            assert!(validate_curve(&[valid[0], bad], 48000).is_err());
        }
        assert!(validate_curve(&[valid[1], valid[0]], 48000).is_err());
        assert!(
            serde_json::from_str::<FrequencyPoint>(r#"{"frequency_hz":20,"gain_db":0,"q":1}"#)
                .is_err()
        );
    }

    #[test]
    fn target_curve_interpolates_db_in_log_frequency_with_endpoint_hold() {
        let points = [point(100.0, -6.0), point(10_000.0, 6.0)];
        assert_eq!(target_db(&points, 0.0), -6.0);
        assert_eq!(target_db(&points, 24_000.0), 6.0);
        assert!(target_db(&points, 1000.0).abs() < 1e-12);
        let left = 1000.0f64;
        let right = f64::from_bits(left.to_bits() + 1);
        let adjacent = [point(left, -3.0), point(right, 3.0)];
        assert_eq!(target_db(&adjacent, right), 3.0);
    }

    #[test]
    fn cancelled_generation_and_wav_preparation_stop_before_work() {
        let cancelled = AtomicBool::new(true);
        let points = [point(20.0, 0.0), point(20_000.0, 0.0)];
        assert!(generate_fir_cancellable(&points, 48000, &cancelled)
            .err()
            .unwrap()
            .to_string()
            .contains("已取消"));
        assert!(prepare_wav_cancellable(
            &wav(&[0.0, 1.0, 0.0], 48000),
            "f".repeat(64),
            48000,
            &cancelled
        )
        .err()
        .unwrap()
        .to_string()
        .contains("已取消"));
        cancelled.store(false, Ordering::Release);
        assert!(generate_fir_cancellable(&points, 48000, &cancelled).is_ok());
        assert!(prepare_wav_cancellable(
            &wav(&[0.0, 1.0, 0.0], 48000),
            "f".repeat(64),
            48000,
            &cancelled
        )
        .is_ok());
    }
    fn wav(samples: &[f32], rate: u32) -> Vec<u8> {
        let mut b = b"RIFF".to_vec();
        b.extend_from_slice(&(36 + samples.len() as u32 * 4).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt \x10\0\0\0\x03\0\x01\0");
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * 4).to_le_bytes());
        b.extend_from_slice(b"\x04\0\x20\0data");
        b.extend_from_slice(&(samples.len() as u32 * 4).to_le_bytes());
        for s in samples {
            b.extend_from_slice(&s.to_le_bytes());
        }
        b
    }
    #[test]
    fn identity_phase_and_bounds() {
        let k = prepare_wav(&wav(&[0.0, 1.0, 0.0], 48000), "a".repeat(64), 48000).unwrap();
        assert_eq!(k.delay_frames, 1);
        assert_eq!(k.attenuation_db, 0.0);
        assert!(prepare_wav(&wav(&[0.0, 0.0, 1.0], 48000), "a".repeat(64), 48000).is_err());
        assert!(prepare_wav(&wav(&vec![0.1; 259], 48000), "a".repeat(64), 48000).is_err());
    }
    #[test]
    fn resampled_unity_keeps_its_dc_level_and_declared_phase() {
        for from in [44100, 48000, 96000] {
            for to in [44100, 48000, 96000] {
                let k = prepare_wav(&wav(&[1.0], from), "a".repeat(64), to).unwrap();
                let sum: f64 = k.channels[0].iter().map(|v| *v as f64).sum();
                assert!((20.0 * sum.log10()).abs() < 0.05, "{from}->{to}: {sum}");
                assert_eq!(k.delay_frames, (k.channels[0].len() - 1) / 2);
            }
        }
    }
}
