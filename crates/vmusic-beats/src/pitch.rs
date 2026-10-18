// SPDX-License-Identifier: MIT
//! Bounded, experimental periodicity estimates. Not lead-melody separation.
use std::{
    fs::File,
    io::{self, Read, Seek},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

use num_complex::Complex;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::DecoderOptions,
    errors::Error as SymError,
    formats::FormatOptions,
    io::{MediaSource, MediaSourceStream},
    meta::MetadataOptions,
    probe::Hint,
};

pub const ALGORITHM: &str = "nsdf-lowpass-v1";
pub const VERSION: u32 = 1;
pub const RATE: u32 = 8_000;
pub const MAX_MS: u64 = 720_000;
pub const HOP_MS: u64 = 40;
pub const MIN_HZ: f64 = 55.0;
pub const MAX_HZ: f64 = 1_200.0;
const WINDOW: usize = 1024;
const FFT_LEN: usize = WINDOW * 2;
const HOP: usize = RATE as usize * HOP_MS as usize / 1000;
const MAX_SAMPLES: usize = RATE as usize * MAX_MS as usize / 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchPoint {
    pub t: u64,
    pub hz: Option<f64>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchMap {
    pub version: u32,
    pub algorithm: String,
    pub analyzed_ms: u64,
    pub truncated: bool,
    pub points: Vec<PitchPoint>,
}

#[derive(Clone)]
pub struct Control {
    pub until: Instant,
    pub cancelled: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PitchError {
    Cancelled,
    Deadline,
    Unsupported,
    Decode,
}

impl std::fmt::Display for PitchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "pitch analysis: {self:?}")
    }
}
impl std::error::Error for PitchError {}

impl Control {
    pub fn check(&self) -> Result<(), PitchError> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(PitchError::Cancelled);
        }
        if Instant::now() >= self.until {
            return Err(PitchError::Deadline);
        }
        Ok(())
    }
}

struct Source {
    file: File,
    control: Control,
}
impl Read for Source {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        self.control.check().map_err(io::Error::other)?;
        self.file.read(out)
    }
}
impl Seek for Source {
    fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
        self.control.check().map_err(io::Error::other)?;
        self.file.seek(pos)
    }
}
impl MediaSource for Source {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        self.file.metadata().ok().map(|m| m.len())
    }
}

// Cascaded Butterworth low-pass sections prevent out-of-band tones becoming
// plausible low pitches during downsampling. Coefficients stay off hot audio paths.
struct LowPass {
    sections: [[f64; 7]; 3],
}
impl LowPass {
    fn new(rate: u32) -> Self {
        let w = 2.0 * std::f64::consts::PI * 1600.0 / f64::from(rate);
        let sections = [
            0.517_638_090_2,
            std::f64::consts::FRAC_1_SQRT_2,
            1.931_851_652_6,
        ]
        .map(|q| {
            let alpha = w.sin() / (2.0 * q);
            let a0 = 1.0 + alpha;
            [
                (1.0 - w.cos()) / 2.0 / a0,
                (1.0 - w.cos()) / a0,
                (1.0 - w.cos()) / 2.0 / a0,
                -2.0 * w.cos() / a0,
                (1.0 - alpha) / a0,
                0.0,
                0.0,
            ]
        });
        Self { sections }
    }
    fn process(&mut self, mut sample: f64) -> f32 {
        for s in &mut self.sections {
            let out = s[0] * sample + s[5];
            s[5] = s[1] * sample - s[3] * out + s[6];
            s[6] = s[2] * sample - s[4] * out;
            sample = out;
        }
        sample as f32
    }
}

struct Sampler {
    filter: LowPass,
    rate: u32,
    index: u64,
    next: u64,
    previous: f32,
    pcm: Vec<f32>,
}
impl Sampler {
    fn new(rate: u32) -> Result<Self, PitchError> {
        if !(8_000..=192_000).contains(&rate) {
            return Err(PitchError::Unsupported);
        }
        Ok(Self {
            filter: LowPass::new(rate),
            rate,
            index: 0,
            next: 0,
            previous: 0.0,
            pcm: Vec::new(),
        })
    }
    fn push(&mut self, sample: f32) -> Result<(), PitchError> {
        if !sample.is_finite() {
            return Err(PitchError::Decode);
        }
        let current = self.filter.process(f64::from(sample));
        let position = self.index * u64::from(RATE);
        // One bounded lookahead sample distinguishes exact EOF at the limit
        // from a source with an unanalyzed tail.
        if self.next <= position && self.pcm.len() <= MAX_SAMPLES {
            let value = if self.index == 0 {
                current
            } else {
                let fraction =
                    (self.next - (self.index - 1) * u64::from(RATE)) as f32 / RATE as f32;
                self.previous + (current - self.previous) * fraction
            };
            self.pcm.push(value);
            self.next += u64::from(self.rate);
        }
        self.index += 1;
        self.previous = current;
        Ok(())
    }
}

/// Decode only the selected audio track, with stable rate/channels and bounded
/// PCM. Corrupt packets are errors: skipping them would compress the time axis.
pub fn analyze_file(file: File, control: &Control) -> Result<PitchMap, PitchError> {
    control.check()?;
    let source = MediaSourceStream::new(
        Box::new(Source {
            file,
            control: control.clone(),
        }),
        Default::default(),
    );
    let options = FormatOptions {
        enable_gapless: true,
        ..Default::default()
    };
    let mut probed = symphonia::default::get_probe()
        .format(&Hint::new(), source, &options, &MetadataOptions::default())
        .map_err(|_| PitchError::Decode)?;
    let track = probed
        .format
        .default_track()
        .ok_or(PitchError::Unsupported)?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|_| PitchError::Unsupported)?;
    let mut sampler: Option<Sampler> = None;
    let mut channels = 0;
    let mut truncated = false;
    loop {
        control.check()?;
        let packet = match probed.format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(_) => return Err(PitchError::Decode),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = decoder.decode(&packet).map_err(|_| PitchError::Decode)?;
        let spec = *decoded.spec();
        if channels == 0 {
            channels = spec.channels.count();
            if channels == 0 || channels > 8 {
                return Err(PitchError::Unsupported);
            }
            sampler = Some(Sampler::new(spec.rate)?);
        }
        let sampler = sampler.as_mut().ok_or(PitchError::Decode)?;
        if sampler.rate != spec.rate
            || channels != spec.channels.count()
            || decoded.frames() > 262_144
        {
            return Err(PitchError::Unsupported);
        }
        let mut samples = SampleBuffer::<f32>::new(decoded.frames() as u64, spec);
        samples.copy_interleaved_ref(decoded);
        for (i, frame) in samples.samples().chunks_exact(channels).enumerate() {
            if i % 4096 == 0 {
                control.check()?;
            }
            // Mono average may cancel anti-phase stereo; it must then be unvoiced.
            let mono = frame.iter().map(|x| f64::from(*x)).sum::<f64>() / channels as f64;
            sampler.push(mono as f32)?;
            if sampler.pcm.len() > MAX_SAMPLES {
                truncated = true;
                break;
            }
        }
        if truncated {
            break;
        }
    }
    let sampler = sampler.ok_or(PitchError::Decode)?;
    analyze_sampled(
        &sampler.pcm[..sampler.pcm.len().min(MAX_SAMPLES)],
        truncated,
        control,
    )
}

/// Evaluation entry for known PCM. Uses the exact same low-pass and estimator.
pub fn analyze_mono(pcm: &[f32], rate: u32, control: &Control) -> Result<PitchMap, PitchError> {
    let mut sampler = Sampler::new(rate)?;
    for (i, sample) in pcm.iter().enumerate() {
        if i % 4096 == 0 {
            control.check()?;
        }
        sampler.push(*sample)?;
        if sampler.pcm.len() > MAX_SAMPLES {
            break;
        }
    }
    analyze_sampled(
        &sampler.pcm[..sampler.pcm.len().min(MAX_SAMPLES)],
        sampler.pcm.len() > MAX_SAMPLES,
        control,
    )
}

fn analyze_sampled(
    pcm: &[f32],
    truncated: bool,
    control: &Control,
) -> Result<PitchMap, PitchError> {
    control.check()?;
    let mut planner = FftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(FFT_LEN);
    let inverse = planner.plan_fft_inverse(FFT_LEN);
    let scratch_len = fft
        .get_inplace_scratch_len()
        .max(inverse.get_inplace_scratch_len());
    let mut scratch = vec![Complex::default(); scratch_len];
    let mut buffer = vec![Complex::default(); FFT_LEN];
    let mut energy = vec![0.0; WINDOW + 1];
    let max_lag = (f64::from(RATE) / MIN_HZ).ceil() as usize + 1;
    let mut nsdf = vec![0.0; max_lag + 1];
    let mut points = Vec::with_capacity(pcm.len() / HOP);
    for (i, frame) in pcm.windows(WINDOW).step_by(HOP).enumerate() {
        control.check()?;
        let mean = frame.iter().map(|x| f64::from(*x)).sum::<f64>() / WINDOW as f64;
        buffer.fill(Complex::default());
        for (j, sample) in frame.iter().enumerate() {
            let value = f64::from(*sample) - mean;
            buffer[j].re = value;
            energy[j + 1] = energy[j] + value * value;
        }
        let mut point = PitchPoint {
            t: (i * HOP + WINDOW / 2) as u64 * 1000 / u64::from(RATE),
            hz: None,
            confidence: 0.0,
        };
        if energy[WINDOW] / WINDOW as f64 >= 0.000_025 {
            fft.process_with_scratch(&mut buffer, &mut scratch);
            for bin in &mut buffer {
                *bin = Complex::new(bin.norm_sqr(), 0.0);
            }
            inverse.process_with_scratch(&mut buffer, &mut scratch);
            for lag in 0..=max_lag {
                let divisor = energy[WINDOW - lag] + energy[WINDOW] - energy[lag];
                nsdf[lag] = if divisor > 0.0 {
                    2.0 * buffer[lag].re / FFT_LEN as f64 / divisor
                } else {
                    0.0
                };
            }
            let mut peaks = Vec::new();
            for lag in 2..max_lag {
                let (left, mid, right) = (nsdf[lag - 1], nsdf[lag], nsdf[lag + 1]);
                if mid > left && mid >= right && mid > 0.0 {
                    let denominator = left - 2.0 * mid + right;
                    let delta = if denominator.abs() > 1e-12 {
                        (0.5 * (left - right) / denominator).clamp(-0.5, 0.5)
                    } else {
                        0.0
                    };
                    let confidence = (mid - 0.25 * (left - right) * delta).clamp(0.0, 1.0);
                    peaks.push((lag as f64 + delta, confidence));
                }
            }
            let best = peaks.iter().map(|p| p.1).fold(0.0, f64::max);
            if let Some(&(period, confidence)) =
                peaks.iter().find(|p| p.1 >= (best * 0.93).max(0.85))
            {
                let hz = f64::from(RATE) / period;
                // A one-cent edge tolerance avoids rejecting an in-range tone
                // solely because sub-sample interpolation lands just outside.
                let edge = 2.0_f64.powf(1.0 / 1200.0);
                if (MIN_HZ / edge..=MAX_HZ * edge).contains(&hz) {
                    point.hz = Some(hz.clamp(MIN_HZ, MAX_HZ));
                    point.confidence = confidence;
                }
            }
        }
        points.push(point);
    }
    control.check()?;
    Ok(PitchMap {
        version: VERSION,
        algorithm: ALGORITHM.into(),
        analyzed_ms: pcm.len() as u64 * 1000 / u64::from(RATE),
        truncated,
        points,
    })
}
