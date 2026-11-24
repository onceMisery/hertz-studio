// SPDX-License-Identifier: MIT
//! Offline BS.1770 analysis of already trimmed source PCM. No playback state.
//!
//! ebur128 0.1.10 supplies K weighting and the 4x/2x FIR true-peak scanner.
//! Exact 400 ms block energies (100 ms hop) are retained in a bounded vector,
//! so the same absolute/relative gate can be applied to complete album members.
use ebur128::{EbuR128, Mode};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{self, Read, Seek},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use symphonia::core::{
    audio::{Channels, SampleBuffer},
    codecs::*,
    errors::Error as SymError,
    formats::FormatOptions,
    io::{MediaSource, MediaSourceStream},
    meta::{Limit, MetadataOptions},
    probe::Hint,
};

pub const ALGORITHM: &str = "bs1770-ebur128-0.1.10-exact-gate-v1";
pub const MAX_TRACK_SECONDS: u64 = 6 * 60 * 60;
pub const MAX_ALBUM_BLOCKS: usize = 1_000_000;
const MAX_PACKET_FRAMES: u64 = 96_000;
const MAX_TRACK_BLOCKS: usize = MAX_TRACK_SECONDS as usize * 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeasurementState {
    Measured,
    Silence,
    InsufficientBlocks,
    BelowGate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Measurement {
    pub state: MeasurementState,
    pub integrated_lufs: Option<f64>,
    /// Linear amplitude; zero represents silence (never negative infinity JSON).
    pub sample_peak: f64,
    pub true_peak: f64,
    pub sample_rate: u32,
    pub channels: u32,
    /// Original Symphonia speaker positions (FL=1, FR=2, FC=4).
    pub channel_mask: u32,
    pub frames: u64,
    pub gated_blocks: u64,
}

pub struct Analysis {
    pub measurement: Measurement,
    pub block_energies: Vec<f64>,
}

#[derive(Clone)]
pub struct Control {
    pub until: Instant,
    pub cancelled: Arc<AtomicBool>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnalyzeError {
    Cancelled,
    Deadline,
    Unsupported,
    Decode,
    Limit,
}
impl std::fmt::Display for AnalyzeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "loudness: {self:?}")
    }
}
impl std::error::Error for AnalyzeError {}
impl Control {
    pub fn check(&self) -> Result<(), AnalyzeError> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(AnalyzeError::Cancelled);
        }
        if Instant::now() >= self.until {
            return Err(AnalyzeError::Deadline);
        }
        Ok(())
    }
}

/// BS.1770: absolute -70 LUFS gate, then -10 LU relative to surviving energy.
/// Pool energies, never LUFS. Every track starts its own 400 ms block grid.
pub fn gated_loudness(energies: &[f64]) -> (Option<f64>, u64) {
    let absolute = 10.0_f64.powf((-70.0 + 0.691) / 10.0);
    let (sum, count) = energies
        .iter()
        .filter(|e| e.is_finite() && **e > absolute)
        .fold((0.0, 0u64), |(sum, n), e| (sum + e, n + 1));
    if count == 0 {
        return (None, 0);
    }
    let threshold = absolute.max(sum / count as f64 * 0.1);
    let (sum, count) = energies
        .iter()
        .filter(|e| e.is_finite() && **e > threshold)
        .fold((0.0, 0u64), |(sum, n), e| (sum + e, n + 1));
    if count == 0 {
        return (None, 0);
    }
    (Some(-0.691 + 10.0 * (sum / count as f64).log10()), count)
}

pub(crate) struct Meter {
    ebu: EbuR128,
    rate: u32,
    channels: u32,
    frames: u64,
    sample_peak: f64,
    energies: Vec<f64>,
    max_frames: u64,
    max_blocks: usize,
}
impl Meter {
    fn new(rate: u32, channels: u32) -> Result<Self, AnalyzeError> {
        Self::bounded(rate, channels, MAX_TRACK_SECONDS)
    }
    pub(crate) fn bounded(rate: u32, channels: u32, seconds: u64) -> Result<Self, AnalyzeError> {
        // Initial qualification matrix. No resampling/channel downmix for analysis.
        if !matches!(rate, 44_100 | 48_000 | 96_000) || !(1..=2).contains(&channels) {
            return Err(AnalyzeError::Unsupported);
        }
        Ok(Self {
            ebu: EbuR128::new(channels, rate, Mode::M | Mode::TRUE_PEAK)
                .map_err(|_| AnalyzeError::Limit)?,
            rate,
            channels,
            frames: 0,
            sample_peak: 0.0,
            energies: Vec::with_capacity((seconds as usize * 10).min(MAX_TRACK_BLOCKS)),
            max_frames: u64::from(rate) * seconds.min(MAX_TRACK_SECONDS),
            max_blocks: (seconds as usize * 10).min(MAX_TRACK_BLOCKS),
        })
    }
    pub(crate) fn push(&mut self, mut pcm: &[f32], control: &Control) -> Result<(), AnalyzeError> {
        if !pcm.len().is_multiple_of(self.channels as usize) {
            return Err(AnalyzeError::Decode);
        }
        let hop = u64::from(self.rate / 10);
        while !pcm.is_empty() {
            control.check()?;
            let frames = (hop - self.frames % hop).min((pcm.len() / self.channels as usize) as u64);
            if self.frames + frames > self.max_frames {
                return Err(AnalyzeError::Limit);
            }
            let n = frames as usize * self.channels as usize;
            let part = &pcm[..n];
            for &sample in part {
                if !sample.is_finite() {
                    return Err(AnalyzeError::Decode);
                }
                self.sample_peak = self.sample_peak.max(f64::from(sample.abs()));
            }
            self.ebu
                .add_frames_f32(part)
                .map_err(|_| AnalyzeError::Decode)?;
            self.frames += frames;
            if self.frames >= 4 * hop && self.frames.is_multiple_of(hop) {
                if self.energies.len() >= self.max_blocks {
                    return Err(AnalyzeError::Limit);
                }
                let lufs = self
                    .ebu
                    .loudness_momentary()
                    .map_err(|_| AnalyzeError::Decode)?;
                let energy = if lufs == f64::NEG_INFINITY {
                    0.0
                } else {
                    10.0_f64.powf((lufs + 0.691) / 10.0)
                };
                if !energy.is_finite() {
                    return Err(AnalyzeError::Decode);
                }
                self.energies.push(energy);
            }
            pcm = &pcm[n..];
        }
        Ok(())
    }
    pub(crate) fn finish(mut self) -> Result<Analysis, AnalyzeError> {
        let (integrated_lufs, gated_blocks) = gated_loudness(&self.energies);
        let state = if self.sample_peak == 0.0 {
            MeasurementState::Silence
        } else if self.energies.is_empty() {
            MeasurementState::InsufficientBlocks
        } else if integrated_lufs.is_none() {
            MeasurementState::BelowGate
        } else {
            MeasurementState::Measured
        };
        // The ebur128 FIR has at most 24 input samples of history. Flush only
        // the peak scanner after collecting loudness; padding is never gated.
        self.ebu
            .add_frames_f32(&[0.0; 64][..32 * self.channels as usize])
            .map_err(|_| AnalyzeError::Decode)?;
        let mut true_peak = self.sample_peak;
        for c in 0..self.channels {
            true_peak = true_peak.max(self.ebu.true_peak(c).map_err(|_| AnalyzeError::Decode)?);
        }
        if !true_peak.is_finite() {
            return Err(AnalyzeError::Decode);
        }
        Ok(Analysis {
            measurement: Measurement {
                state,
                integrated_lufs,
                sample_peak: self.sample_peak,
                true_peak,
                sample_rate: self.rate,
                channels: self.channels,
                channel_mask: if self.channels == 1 {
                    Channels::FRONT_LEFT.bits()
                } else {
                    (Channels::FRONT_LEFT | Channels::FRONT_RIGHT).bits()
                },
                frames: self.frames,
                gated_blocks,
            },
            block_energies: self.energies,
        })
    }
}

struct Source {
    file: File,
    control: Control,
}
impl Read for Source {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.control.check().map_err(io::Error::other)?;
        self.file.read(buf)
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

fn qualified(params: &CodecParameters) -> bool {
    match params.codec {
        CODEC_TYPE_PCM_S32LE | CODEC_TYPE_PCM_S32BE | CODEC_TYPE_PCM_S24LE
        | CODEC_TYPE_PCM_S24BE | CODEC_TYPE_PCM_S16LE | CODEC_TYPE_PCM_S16BE
        | CODEC_TYPE_PCM_S8 | CODEC_TYPE_PCM_U32LE | CODEC_TYPE_PCM_U32BE
        | CODEC_TYPE_PCM_U24LE | CODEC_TYPE_PCM_U24BE | CODEC_TYPE_PCM_U16LE
        | CODEC_TYPE_PCM_U16BE | CODEC_TYPE_PCM_U8 | CODEC_TYPE_PCM_F32LE
        | CODEC_TYPE_PCM_F32BE | CODEC_TYPE_PCM_F64LE | CODEC_TYPE_PCM_F64BE
        | CODEC_TYPE_PCM_ALAW | CODEC_TYPE_PCM_MULAW | CODEC_TYPE_FLAC => true,
        CODEC_TYPE_ALAC => params.extra_data.as_ref().is_some_and(|data| {
            matches!(data.len(), 24 | 48)
                && u32::from_be_bytes(data[..4].try_into().unwrap()) as u64 <= MAX_PACKET_FRAMES
                && (1..=2).contains(&data[9])
        }),
        CODEC_TYPE_MP3 => {
            params.delay.is_some_and(|delay| delay > 0)
                && params.padding.is_some()
                && params.n_frames.is_some_and(|n| n > 0)
        }
        _ => false,
    }
}

fn qualified_layout(channels: Channels) -> bool {
    channels == Channels::FRONT_LEFT
        || channels == Channels::FRONT_CENTRE
        || channels == (Channels::FRONT_LEFT | Channels::FRONT_RIGHT)
}

/// Retains no whole-track PCM. Decoder buffers + interleaved copy are capped;
/// block energies use <1.7 MiB; album owner reserves at most 8 MiB separately.
pub fn analyze_file(file: File, control: &Control) -> Result<Analysis, AnalyzeError> {
    let mut meter: Option<Meter> = None;
    let info = visit_file(file, control, None, |rate, channels, pcm| {
        if meter.is_none() {
            meter = Some(Meter::new(rate, channels.count() as u32)?);
        }
        meter
            .as_mut()
            .ok_or(AnalyzeError::Decode)?
            .push(pcm, control)
    })?;
    let mut analysis = meter.ok_or(AnalyzeError::Decode)?.finish()?;
    analysis.measurement.channel_mask = info.channel_mask;
    Ok(analysis)
}

pub(crate) struct DecodedPrefix {
    pub pcm: Vec<f32>,
    pub rate: u32,
    pub channels: usize,
}
/// Reference preparation reads a finite prefix plus one source block of sinc lookahead.
/// The qualified decoder/layout/trim path is exactly the whole-track analysis path.
pub(crate) fn prefix_file(
    file: File,
    seconds: u64,
    control: &Control,
) -> Result<DecodedPrefix, AnalyzeError> {
    let mut pcm = Vec::new();
    let info = visit_file(file, control, Some(seconds), |rate, channels, samples| {
        if pcm.capacity() == 0 {
            pcm.reserve_exact(
                (rate as usize * seconds as usize + crate::resample::INPUT_BLOCK)
                    * channels.count(),
            );
        }
        if samples.iter().any(|s| !s.is_finite()) {
            return Err(AnalyzeError::Decode);
        }
        pcm.extend_from_slice(samples);
        Ok(())
    })?;
    Ok(DecodedPrefix {
        pcm,
        rate: info.rate,
        channels: info.channels,
    })
}
struct DecodedInfo {
    rate: u32,
    channels: usize,
    channel_mask: u32,
}
fn visit_file(
    file: File,
    control: &Control,
    prefix_seconds: Option<u64>,
    mut visit: impl FnMut(u32, Channels, &[f32]) -> Result<(), AnalyzeError>,
) -> Result<DecodedInfo, AnalyzeError> {
    control.check()?;
    let source = MediaSourceStream::new(
        Box::new(Source {
            file,
            control: control.clone(),
        }),
        Default::default(),
    );
    let mut probed = symphonia::default::get_probe()
        .format(
            &Hint::new(),
            source,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions {
                limit_metadata_bytes: Limit::Maximum(64 * 1024),
                limit_visual_bytes: Limit::Maximum(0),
            },
        )
        .map_err(|_| AnalyzeError::Decode)?;
    let track = probed
        .format
        .default_track()
        .ok_or(AnalyzeError::Unsupported)?;
    let params = &track.codec_params;
    let rate = params.sample_rate.ok_or(AnalyzeError::Unsupported)?;
    if !qualified(params)
        || !matches!(rate, 44_100 | 48_000 | 96_000)
        || params
            .max_frames_per_packet
            .is_some_and(|n| n > MAX_PACKET_FRAMES)
    {
        return Err(AnalyzeError::Unsupported);
    }
    let track_id = track.id;
    let expected_frames = params.n_frames;
    let mut channels = params.channels;
    if channels.is_some_and(|c| !qualified_layout(c)) {
        return Err(AnalyzeError::Unsupported);
    }
    let limit = prefix_seconds
        .map(|s| s.min(MAX_TRACK_SECONDS) * u64::from(rate) + crate::resample::INPUT_BLOCK as u64);
    let mut decoder = symphonia::default::get_codecs()
        .make(params, &DecoderOptions::default())
        .map_err(|_| AnalyzeError::Unsupported)?;
    let mut frames = 0u64;
    let mut prefix_complete = false;
    loop {
        control.check()?;
        let packet = match probed.format.next_packet() {
            Ok(packet) => packet,
            Err(SymError::IoError(error)) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(_) => {
                control.check()?;
                return Err(AnalyzeError::Decode);
            }
        };
        if packet.track_id() != track_id {
            continue;
        }
        if packet.dur() > MAX_PACKET_FRAMES || packet.data.len() > 4 * 1024 * 1024 {
            return Err(AnalyzeError::Limit);
        }
        let decoded = decoder.decode(&packet).map_err(|_| AnalyzeError::Decode)?;
        let spec = *decoded.spec();
        if spec.rate != rate
            || !qualified_layout(spec.channels)
            || channels.is_some_and(|c| spec.channels != c)
            || decoded.capacity() as u64 > MAX_PACKET_FRAMES
        {
            return Err(AnalyzeError::Unsupported);
        }
        channels = Some(spec.channels);
        let mut samples = SampleBuffer::<f32>::new(decoded.frames() as u64, spec);
        samples.copy_interleaved_ref(decoded);
        let count = samples.samples().len() / spec.channels.count();
        let take = limit.map_or(count, |max| count.min(max.saturating_sub(frames) as usize));
        visit(
            rate,
            spec.channels,
            &samples.samples()[..take * spec.channels.count()],
        )?;
        frames += take as u64;
        if frames > u64::from(rate) * MAX_TRACK_SECONDS {
            return Err(AnalyzeError::Limit);
        }
        if limit.is_some_and(|limit| frames == limit) {
            prefix_complete = true;
            break;
        }
    }
    control.check()?;
    // A bounded prefix deliberately does not qualify an unread tail. When EOF
    // occurs within the reference, the same exact-count check rejects truncation.
    if !prefix_complete && expected_frames.is_some_and(|expected| expected != frames) {
        return Err(AnalyzeError::Decode);
    }
    let channels = channels.ok_or(AnalyzeError::Decode)?;
    Ok(DecodedInfo {
        rate,
        channels: channels.count(),
        channel_mask: channels.bits(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn control() -> Control {
        Control {
            until: Instant::now() + std::time::Duration::from_secs(20),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
    fn tone(rate: u32, seconds: usize, gain: f32, channels: usize) -> Vec<f32> {
        (0..rate as usize * seconds)
            .flat_map(|i| {
                let x =
                    gain * (std::f64::consts::TAU * 1000.0 * i as f64 / rate as f64).sin() as f32;
                std::iter::repeat_n(x, channels)
            })
            .collect()
    }
    #[test]
    fn reference_level_and_partition_invariance() {
        for rate in [44_100, 48_000, 96_000] {
            for channels in [1, 2] {
                let pcm = tone(rate, 2, 0.1, channels);
                let mut reference = EbuR128::new(channels as u32, rate, Mode::I).unwrap();
                reference.add_frames_f32(&pcm).unwrap();
                let expected = reference.loudness_global().unwrap();
                for block in [127, 1024] {
                    let mut meter = Meter::new(rate, channels as u32).unwrap();
                    for chunk in pcm.chunks(block * channels) {
                        meter.push(chunk, &control()).unwrap();
                    }
                    let result = meter.finish().unwrap();
                    assert!((result.measurement.integrated_lufs.unwrap() - expected).abs() < 1e-8);
                    let analytic = if channels == 1 { -23.0 } else { -20.0 };
                    assert!((result.measurement.integrated_lufs.unwrap() - analytic).abs() < 0.1);
                    assert!(result.measurement.true_peak >= result.measurement.sample_peak);
                }
            }
        }
    }
    #[test]
    fn explicit_silence_short_and_absolute_gate() {
        for (pcm, expected) in [
            (vec![0.0; 48_000], MeasurementState::Silence),
            (vec![0.1; 100], MeasurementState::InsufficientBlocks),
            (tone(48_000, 1, 0.000001, 1), MeasurementState::BelowGate),
        ] {
            let mut meter = Meter::new(48_000, 1).unwrap();
            meter.push(&pcm, &control()).unwrap();
            let result = meter.finish().unwrap();
            assert_eq!(result.measurement.state, expected);
            assert!(result.measurement.integrated_lufs.is_none());
            assert!(!serde_json::to_string(&result.measurement)
                .unwrap()
                .contains("Infinity"));
        }
    }
    #[test]
    fn album_gates_energy_and_preserves_differences() {
        let loud = vec![0.1; 100];
        let quiet = vec![0.001; 100];
        let (album, count) = gated_loudness(&[loud.clone(), quiet.clone()].concat());
        assert_eq!(count, 100);
        assert_eq!(album, gated_loudness(&loud).0);
        assert!(
            (album.unwrap()
                - (gated_loudness(&loud).0.unwrap() + gated_loudness(&quiet).0.unwrap()) / 2.0)
                .abs()
                > 9.0
        );
        let absolute = 10.0f64.powf((-70.0 + 0.691) / 10.0);
        assert_eq!(
            gated_loudness(&[absolute * 0.99, absolute, absolute * 1.01]).1,
            1
        );
    }
    #[test]
    fn cancellation_and_nonfinite_never_produce_measurement() {
        let mut meter = Meter::new(48_000, 1).unwrap();
        assert_eq!(
            meter.push(&[f32::NAN], &control()),
            Err(AnalyzeError::Decode)
        );
        let c = control();
        c.cancelled.store(true, Ordering::Relaxed);
        assert_eq!(meter.push(&[0.0], &c), Err(AnalyzeError::Cancelled));
        assert!(Meter::new(48_000, 6).is_err());
    }
    #[test]
    fn compressed_trim_is_applied_once_and_untrimmed_formats_are_rejected() {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/compressed");
        for (name, frames) in [
            ("a.mp3", 10_000),
            ("b.mp3", 12_345),
            ("a.flac", 10_000),
            ("a-alac.m4a", 10_000),
        ] {
            let measured = analyze_file(File::open(root.join(name)).unwrap(), &control())
                .unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(measured.measurement.frames, frames, "{name}");
            assert_eq!(
                measured.measurement.state,
                MeasurementState::InsufficientBlocks
            );
        }
        for name in [
            "a-exact-timescale.m4a",
            "a-no-xing.mp3",
            "a-xing-no-lame.mp3",
        ] {
            assert!(
                matches!(
                    analyze_file(File::open(root.join(name)).unwrap(), &control()),
                    Err(AnalyzeError::Unsupported)
                ),
                "{name}"
            );
        }
    }
    #[test]
    fn true_peak_recovers_known_intersample_sine_maximum() {
        let pcm: Vec<f32> = (0..48_000)
            .map(|i| {
                let envelope = (i as f64 / 1000.0)
                    .min((47_999 - i) as f64 / 1000.0)
                    .min(1.0);
                (0.8 * envelope * (std::f64::consts::TAU * (i as f64 / 4.0 + 0.125)).sin()) as f32
            })
            .collect();
        let mut meter = Meter::new(48_000, 1).unwrap();
        meter.push(&pcm, &control()).unwrap();
        let measured = meter.finish().unwrap().measurement;
        assert!((measured.sample_peak - 0.8 / 2.0f64.sqrt()).abs() < 1e-6);
        assert!(
            (measured.true_peak - 0.8).abs() < 0.015,
            "{}",
            measured.true_peak
        );
        assert!(measured.true_peak > measured.sample_peak * 1.3);
    }
}
