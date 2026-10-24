// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Native device output for locally scheduled, device-format PCM.
//!
//! The receiver worker creates and owns [`ScheduledOutput`] (including CPAL's
//! stream). Its unique producer writes already converted interleaved f32 PCM;
//! resampling never occurs on the device callback. All nanosecond arguments use
//! the caller's single `std::time::Instant` origin, never wall-clock time.
//!
//! [`ScheduledPcmQueue`] and [`PresentationConsumer`] expose the exact same
//! device-independent path for deterministic tests or another native adapter.
//! Neither endpoint is cloneable. All storage is allocated before callbacks;
//! atomic slots avoid unsafe aliasing even when clear races a callback. There
//! are no callback locks, allocations, buffer drops, logging or I/O.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use vmusic_core::AudioError;

use crate::output_clock::{ClockObservation, ClockReading, ClockStatus, OutputClock};
use crate::RenderFormat;

pub const MAX_BUFFERED_NS: u64 = 3_000_000_000;
pub const MAX_QUEUE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct OutputOptions {
    /// CPAL 0.15 device name, as used by the existing audio device listing.
    pub device_id: Option<String>,
    pub preferred_rate: u32,
    /// Exact required channel count; unsupported layouts fail explicitly.
    pub channels: u16,
    pub clock_origin: Instant,
    /// Additional measured device latency. Positive values advance the PCM
    /// relative to CPAL's reported presentation time by this amount.
    pub latency_correction_ns: i64,
}

/// A capability statement, not a physical DAC synchronization guarantee.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimestampCapability {
    /// CPAL backend presentation timestamp; it may be a driver/buffer estimate.
    BackendEstimate,
    /// The embedding adapter supplies presentation time to the queue directly.
    External,
}

#[derive(Debug, Clone, Copy)]
pub struct OutputTelemetry {
    pub clock_status: ClockStatus,
    pub timestamp_capability: TimestampCapability,
    pub muted: bool,
    pub device_error: bool,
    pub played_frames: u64,
    pub underrun_frames: u64,
    pub future_silence_frames: u64,
    pub late_frames: u64,
    pub dropped_frames: u64,
    pub queued_frames: usize,
    pub capacity_frames: usize,
    pub device_clock_ppm: f64,
    pub clock_uncertainty_ns: u64,
    pub ns_per_frame: f64,
    pub last_presentation_local_ns: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum OutputError {
    #[error("unsupported device PCM format")]
    Format,
    #[error("PCM must contain complete interleaved frames")]
    Alignment,
    #[error("PCM and volume must be finite; volume must be in [0, 1]")]
    NonFinite,
    #[error("scheduled PCM queue is full")]
    Capacity,
    #[error("scheduled time arithmetic overflow")]
    Overflow,
    #[error("PCM is more than three seconds in the future")]
    TooFarFuture,
    #[error("scheduled PCM overlaps an earlier write")]
    OutOfOrder,
    #[error("output is muted")]
    Muted,
    #[error("device output failed")]
    DeviceError,
    #[error("output was cleared while the PCM was being written")]
    Interrupted,
}

/// Presentation time for the first output frame; subsequent frames advance by
/// the measured device period. Invalid/missing timestamps must use `None`.
#[derive(Debug, Clone, Copy)]
pub struct PresentationTime {
    pub first_frame_local_ns: u64,
    pub ns_per_frame: f64,
}

struct Shared {
    samples: Box<[AtomicU32]>,
    deadlines: Box<[AtomicU64]>,
    epochs: Box<[AtomicU64]>,
    capacity: usize,
    channels: usize,
    written: AtomicU64,
    read: AtomicU64,
    clear_before: AtomicU64,
    generation: AtomicU64,
    muted: AtomicBool,
    device_error: AtomicBool,
    volume: AtomicU32,
    clock_status: AtomicU32,
    period_bits: AtomicU64,
    ppm_bits: AtomicU64,
    uncertainty: AtomicU64,
    presentation: AtomicU64,
    played: AtomicU64,
    underrun: AtomicU64,
    future_silence: AtomicU64,
    late: AtomicU64,
    dropped: AtomicU64,
    capability: TimestampCapability,
}

impl Shared {
    fn clear(&self, written: u64) {
        self.clear_before.fetch_max(written, Ordering::AcqRel);
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    fn status(&self, status: ClockStatus) {
        self.clock_status.store(status as u32, Ordering::Release);
    }

    fn telemetry(&self) -> OutputTelemetry {
        let written = self.written.load(Ordering::Acquire);
        let read = self
            .read
            .load(Ordering::Acquire)
            .max(self.clear_before.load(Ordering::Acquire));
        let device_error = self.device_error.load(Ordering::Acquire);
        let status = match self.clock_status.load(Ordering::Acquire) {
            0 => ClockStatus::AwaitingTimestamps,
            1 => ClockStatus::Valid,
            2 => ClockStatus::Invalid,
            _ => ClockStatus::DeviceError,
        };
        let presentation = self.presentation.load(Ordering::Acquire);
        OutputTelemetry {
            clock_status: if device_error {
                ClockStatus::DeviceError
            } else {
                status
            },
            timestamp_capability: self.capability,
            muted: self.muted.load(Ordering::Acquire),
            device_error,
            played_frames: self.played.load(Ordering::Relaxed),
            underrun_frames: self.underrun.load(Ordering::Relaxed),
            future_silence_frames: self.future_silence.load(Ordering::Relaxed),
            late_frames: self.late.load(Ordering::Relaxed),
            dropped_frames: self.dropped.load(Ordering::Relaxed),
            queued_frames: written.saturating_sub(read).min(self.capacity as u64) as usize,
            capacity_frames: self.capacity,
            device_clock_ppm: f64::from_bits(self.ppm_bits.load(Ordering::Relaxed)),
            clock_uncertainty_ns: self.uncertainty.load(Ordering::Relaxed),
            ns_per_frame: f64::from_bits(self.period_bits.load(Ordering::Relaxed)),
            last_presentation_local_ns: (presentation != u64::MAX).then_some(presentation),
        }
    }
}

#[derive(Clone, Copy)]
struct Schedule {
    start_ns: u64,
    frames: u64,
}

impl Schedule {
    fn time(self, frames: u64, rate: u32) -> Result<u64, OutputError> {
        let offset = u128::from(frames) * 1_000_000_000 / u128::from(rate);
        let offset = u64::try_from(offset).map_err(|_| OutputError::Overflow)?;
        self.start_ns
            .checked_add(offset)
            .ok_or(OutputError::Overflow)
    }
}

/// Unique, non-cloneable SPSC producer. Methods require `&mut self`; it must not
/// be wrapped in a callback-side mutex. PCM is immutable after publication.
pub struct ScheduledPcmQueue {
    shared: Arc<Shared>,
    format: RenderFormat,
    written: u64,
    generation: u64,
    schedule: Option<Schedule>,
}

/// Unique SPSC consumer, owned by the native audio callback. Dropping this
/// object is an adapter shutdown operation, never part of `render`.
pub struct PresentationConsumer {
    shared: Arc<Shared>,
    read: u64,
    next_presentation_ns: Option<f64>,
    last_deadline: Option<(u64, u64)>,
}

impl ScheduledPcmQueue {
    pub fn new(format: RenderFormat) -> Result<(Self, PresentationConsumer), OutputError> {
        Self::with_capability(format, TimestampCapability::External)
    }

    fn with_capability(
        format: RenderFormat,
        capability: TimestampCapability,
    ) -> Result<(Self, PresentationConsumer), OutputError> {
        if !(1..=768_000).contains(&format.sample_rate) || !(1..=32).contains(&format.channels) {
            return Err(OutputError::Format);
        }
        let channels = usize::from(format.channels);
        // Reserve space for Arc/control storage as well as both timestamp arrays.
        let bytes_per_frame = channels * size_of::<AtomicU32>() + 2 * size_of::<AtomicU64>();
        let capacity =
            (format.sample_rate as usize * 3).min((MAX_QUEUE_BYTES - 4096) / bytes_per_frame);
        let period = 1e9 / f64::from(format.sample_rate);
        let shared = Arc::new(Shared {
            samples: (0..capacity * channels)
                .map(|_| AtomicU32::new(0))
                .collect(),
            deadlines: (0..capacity).map(|_| AtomicU64::new(0)).collect(),
            epochs: (0..capacity).map(|_| AtomicU64::new(0)).collect(),
            capacity,
            channels,
            written: AtomicU64::new(0),
            read: AtomicU64::new(0),
            clear_before: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            muted: AtomicBool::new(false),
            device_error: AtomicBool::new(false),
            volume: AtomicU32::new(1.0f32.to_bits()),
            clock_status: AtomicU32::new(ClockStatus::AwaitingTimestamps as u32),
            period_bits: AtomicU64::new(period.to_bits()),
            ppm_bits: AtomicU64::new(0.0f64.to_bits()),
            uncertainty: AtomicU64::new(0),
            presentation: AtomicU64::new(u64::MAX),
            played: AtomicU64::new(0),
            underrun: AtomicU64::new(0),
            future_silence: AtomicU64::new(0),
            late: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            capability,
        });
        Ok((
            Self {
                shared: Arc::clone(&shared),
                format,
                written: 0,
                generation: 0,
                schedule: None,
            },
            PresentationConsumer {
                shared,
                read: 0,
                next_presentation_ns: None,
                last_deadline: None,
            },
        ))
    }

    pub fn format(&self) -> RenderFormat {
        self.format
    }

    /// All-or-nothing write with an explicit local "now" for deterministic
    /// embedding. Production [`ScheduledOutput::write`] supplies its origin's
    /// current elapsed time. Blocks must be chronological. Starts within half
    /// a nominal sample of the prior end snap to the same rational sample grid,
    /// so packet timestamp rounding does not periodically duplicate/drop frames.
    pub fn write_at(
        &mut self,
        start_local_ns: u64,
        samples: &[f32],
        now_local_ns: u64,
    ) -> Result<(), OutputError> {
        if self.shared.device_error.load(Ordering::Acquire) {
            return Err(OutputError::DeviceError);
        }
        if self.shared.muted.load(Ordering::Acquire) {
            return Err(OutputError::Muted);
        }
        let channels = usize::from(self.format.channels);
        if !samples.len().is_multiple_of(channels) {
            return Err(OutputError::Alignment);
        }
        if samples.iter().any(|sample| !sample.is_finite()) {
            return Err(OutputError::NonFinite);
        }
        let frames = samples.len() / channels;
        if frames == 0 {
            return Ok(());
        }
        let generation = self.shared.generation.load(Ordering::Acquire);
        if self.generation != generation {
            self.schedule = None;
            self.generation = generation;
        }
        let mut schedule = Schedule {
            start_ns: start_local_ns,
            frames: 0,
        };
        if let Some(previous) = self.schedule {
            let end = previous.time(previous.frames, self.format.sample_rate)?;
            let half_frame_ns = 500_000_000 / u64::from(self.format.sample_rate);
            if start_local_ns.abs_diff(end) <= half_frame_ns {
                schedule = previous;
            } else if start_local_ns < end {
                return Err(OutputError::OutOfOrder);
            }
        }
        let end_frame = schedule
            .frames
            .checked_add(frames as u64)
            .ok_or(OutputError::Overflow)?;
        let end_ns = schedule.time(end_frame, self.format.sample_rate)?;
        let limit = now_local_ns
            .checked_add(MAX_BUFFERED_NS)
            .ok_or(OutputError::Overflow)?;
        if start_local_ns > limit || end_ns > limit {
            return Err(OutputError::TooFarFuture);
        }
        let read = self
            .shared
            .read
            .load(Ordering::Acquire)
            .max(self.shared.clear_before.load(Ordering::Acquire));
        let new_written = self
            .written
            .checked_add(frames as u64)
            .ok_or(OutputError::Overflow)?;
        if new_written.saturating_sub(read) > self.shared.capacity as u64 {
            return Err(OutputError::Capacity);
        }
        // Time overflow was validated above for the entire block.
        for (frame, input) in samples.chunks_exact(channels).enumerate() {
            let slot = ((self.written + frame as u64) % self.shared.capacity as u64) as usize;
            for (channel, sample) in input.iter().enumerate() {
                // Release/acquire on slots matters when a clear immediately
                // reuses storage still inspected by a callback. Observing any
                // overwritten value then also observes the new generation at
                // the callback's final check, including on weakly ordered CPUs.
                self.shared.samples[slot * channels + channel]
                    .store(sample.to_bits(), Ordering::Release);
            }
            let deadline =
                schedule.time(schedule.frames + frame as u64, self.format.sample_rate)?;
            self.shared.deadlines[slot].store(deadline, Ordering::Release);
            self.shared.epochs[slot].store(generation, Ordering::Release);
        }
        self.written = new_written;
        self.shared.written.store(new_written, Ordering::Release);
        // Epochs on every frame also cover a fault/clear in the narrow interval
        // between this publication and the generation check.
        if self.shared.generation.load(Ordering::Acquire) != generation {
            self.shared
                .clear_before
                .fetch_max(new_written, Ordering::AcqRel);
            self.schedule = None;
            return Err(OutputError::Interrupted);
        }
        self.schedule = Some(Schedule {
            frames: end_frame,
            ..schedule
        });
        Ok(())
    }

    /// Invalidate every published frame immediately, without waiting for a
    /// callback acknowledgement. New writes can reuse the cleared capacity.
    pub fn clear(&mut self) {
        self.shared.clear(self.written);
        self.schedule = None;
    }

    /// Muting clears the queue. PCM cannot be accumulated while muted.
    pub fn mute(&mut self) {
        self.shared.muted.store(true, Ordering::Release);
        self.clear();
    }

    /// Clear again before enabling output; a previous epoch cannot revive.
    pub fn unmute(&mut self) {
        self.clear();
        self.shared.muted.store(false, Ordering::Release);
    }

    pub fn set_local_volume(&mut self, volume: f32) -> Result<(), OutputError> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err(OutputError::NonFinite);
        }
        self.shared
            .volume
            .store(volume.to_bits(), Ordering::Release);
        Ok(())
    }

    pub fn telemetry(&self) -> OutputTelemetry {
        self.shared.telemetry()
    }
}

impl PresentationConsumer {
    fn publish_clock(&self, reading: ClockReading) {
        self.shared
            .period_bits
            .store(reading.ns_per_frame.to_bits(), Ordering::Relaxed);
        self.shared
            .ppm_bits
            .store(reading.device_clock_ppm.to_bits(), Ordering::Relaxed);
        self.shared
            .uncertainty
            .store(reading.uncertainty_ns, Ordering::Relaxed);
        self.shared.status(reading.status);
    }

    fn discard(&mut self) {
        let written = self.shared.written.load(Ordering::Acquire);
        let dropped = written.saturating_sub(self.read);
        self.read = written;
        self.shared.clear(written);
        self.shared.read.store(written, Ordering::Release);
        self.shared.dropped.fetch_add(dropped, Ordering::Relaxed);
        self.next_presentation_ns = None;
        self.last_deadline = None;
    }

    /// Fill a device buffer without allocating, deallocating, locking or I/O.
    /// Run starts align to the nearest device frame (half-frame tolerance).
    /// A contiguous PCM run then advances exactly one sample per device frame;
    /// the worker's converter owns clock drift correction. Rechecking nominal
    /// sample deadlines within a continuous run would cause periodic drops.
    /// Future runs stay queued; expired runs trim by binary search, never play
    /// to catch up. Underflow or a callback gap releases that continuity lock.
    /// Missing/invalid time discards the entire old epoch.
    ///
    /// `clear`/`mute` racing this function silence the whole unsubmitted buffer.
    /// Already submitted hardware buffers cannot be recalled by any CPAL API.
    pub fn render(&mut self, output: &mut [f32], presentation: Option<PresentationTime>) {
        self.render_inner(output, presentation, || {});
    }

    fn render_inner(
        &mut self,
        output: &mut [f32],
        presentation: Option<PresentationTime>,
        before_commit: impl FnOnce(),
    ) {
        output.fill(0.0);
        let Some(presentation) = presentation else {
            self.shared.status(ClockStatus::Invalid);
            self.discard();
            return;
        };
        let period = presentation.ns_per_frame;
        let first = presentation.first_frame_local_ns as f64;
        let channels = self.shared.channels;
        let nominal = f64::from_bits(self.shared.period_bits.load(Ordering::Relaxed));
        if !output.len().is_multiple_of(channels)
            || !period.is_finite()
            || !(nominal * 0.99..=nominal * 1.01).contains(&period)
            || self
                .next_presentation_ns
                .is_some_and(|next| first < next - period * 0.5)
            || first + (output.len() / channels) as f64 * period >= u64::MAX as f64
        {
            self.shared.status(ClockStatus::Invalid);
            self.discard();
            return;
        }
        if self.shared.muted.load(Ordering::Acquire)
            || self.shared.device_error.load(Ordering::Acquire)
        {
            self.discard();
            return;
        }
        if self
            .next_presentation_ns
            .is_some_and(|next| first > next + period * 0.5)
        {
            self.last_deadline = None;
        }
        self.shared.status(ClockStatus::Valid);
        self.shared
            .presentation
            .store(presentation.first_frame_local_ns, Ordering::Release);
        let generation = self.shared.generation.load(Ordering::Acquire);
        let clear_before = self.shared.clear_before.load(Ordering::Acquire);
        let mut dropped = clear_before.saturating_sub(self.read);
        self.read = self.read.max(clear_before);
        let written = self.shared.written.load(Ordering::Acquire);
        let gain = f32::from_bits(self.shared.volume.load(Ordering::Acquire));
        let mut played = 0u64;
        let mut late = 0u64;
        let mut underrun = 0u64;
        let mut future = 0u64;
        for (index, frame) in output.chunks_exact_mut(channels).enumerate() {
            let time = first + index as f64 * period;
            let contiguous = if self.read < written {
                let slot = (self.read % self.shared.capacity as u64) as usize;
                let epoch = self.shared.epochs[slot].load(Ordering::Acquire);
                let deadline = self.shared.deadlines[slot].load(Ordering::Acquire);
                self.last_deadline
                    .is_some_and(|(previous_epoch, previous)| {
                        epoch == generation
                            && previous_epoch == generation
                            && (deadline as f64 - previous as f64 - nominal).abs() <= nominal * 0.5
                    })
            } else {
                false
            };
            if !contiguous {
                self.last_deadline = None;
                // Binary-search expired frames once at a run boundary, bounded
                // by log(capacity); continuous rendering only reads the head.
                let mut low = self.read;
                let mut high = written;
                while low < high {
                    let middle = low + (high - low) / 2;
                    let slot = (middle % self.shared.capacity as u64) as usize;
                    let epoch = self.shared.epochs[slot].load(Ordering::Acquire);
                    let deadline = self.shared.deadlines[slot].load(Ordering::Acquire) as f64;
                    if epoch < generation || (epoch == generation && deadline < time - period * 0.5)
                    {
                        low = middle + 1;
                    } else {
                        high = middle;
                    }
                }
                let expired = low - self.read;
                late += expired;
                dropped += expired;
                self.read = low;
            }
            if self.read == written {
                underrun += 1;
                self.last_deadline = None;
                continue;
            }
            let slot = (self.read % self.shared.capacity as u64) as usize;
            let epoch = self.shared.epochs[slot].load(Ordering::Acquire);
            let deadline = self.shared.deadlines[slot].load(Ordering::Acquire) as f64;
            if epoch != generation || (!contiguous && deadline > time + period * 0.5) {
                future += 1;
                self.last_deadline = None;
                continue;
            }
            for (channel, sample) in frame.iter_mut().enumerate() {
                let value = f32::from_bits(
                    self.shared.samples[slot * channels + channel].load(Ordering::Acquire),
                );
                *sample = if gain == 1.0 { value } else { value * gain };
            }
            played += 1;
            self.read += 1;
            self.last_deadline = Some((generation, deadline as u64));
        }
        before_commit();
        if self.shared.generation.load(Ordering::Acquire) != generation
            || self.shared.muted.load(Ordering::Acquire)
            || self.shared.device_error.load(Ordering::Acquire)
        {
            output.fill(0.0);
            dropped += played;
            played = 0;
            self.last_deadline = None;
        }
        self.next_presentation_ns = Some(first + (output.len() / channels) as f64 * period);
        self.shared.read.store(self.read, Ordering::Release);
        self.shared.played.fetch_add(played, Ordering::Relaxed);
        self.shared.underrun.fetch_add(underrun, Ordering::Relaxed);
        self.shared
            .future_silence
            .fetch_add(future, Ordering::Relaxed);
        self.shared.late.fetch_add(late, Ordering::Relaxed);
        self.shared.dropped.fetch_add(dropped, Ordering::Relaxed);
    }
}

/// CPAL stream owned by the receiver worker. Create, control and drop it on that
/// worker; no async runtime or audio actor is involved.
pub struct ScheduledOutput {
    stream: Option<cpal::Stream>,
    queue: ScheduledPcmQueue,
    clock_origin: Instant,
}

impl ScheduledOutput {
    pub fn open(options: OutputOptions) -> Result<Self, AudioError> {
        if !(1..=768_000).contains(&options.preferred_rate)
            || !(1..=32).contains(&options.channels)
            || options.clock_origin > Instant::now()
        {
            return Err(AudioError::UnsupportedFormat(
                "invalid scheduled output options".into(),
            ));
        }
        let host = cpal::default_host();
        let device = if let Some(id) = options.device_id.as_deref() {
            host.output_devices()
                .map_err(|error| AudioError::DeviceUnavailable(error.to_string()))?
                .find(|device| device.name().is_ok_and(|name| name == id))
        } else {
            host.default_output_device()
        }
        .ok_or_else(|| AudioError::DeviceUnavailable("scheduled output device not found".into()))?;
        let mut best: Option<cpal::SupportedStreamConfig> = None;
        for range in device
            .supported_output_configs()
            .map_err(|error| AudioError::DeviceUnavailable(error.to_string()))?
        {
            if range.sample_format() != cpal::SampleFormat::F32
                || range.channels() != options.channels
            {
                continue;
            }
            let rate = options
                .preferred_rate
                .clamp(range.min_sample_rate().0, range.max_sample_rate().0);
            if !(1..=768_000).contains(&rate) {
                continue;
            }
            if best.as_ref().is_none_or(|old| {
                rate.abs_diff(options.preferred_rate)
                    < old.sample_rate().0.abs_diff(options.preferred_rate)
            }) {
                best = Some(range.with_sample_rate(cpal::SampleRate(rate)));
            }
        }
        let config = best.ok_or_else(|| {
            AudioError::UnsupportedFormat(format!(
                "device has no f32 output with {} channels",
                options.channels
            ))
        })?;
        let format = RenderFormat {
            sample_rate: config.sample_rate().0,
            channels: config.channels(),
        };
        let (queue, mut consumer) =
            ScheduledPcmQueue::with_capability(format, TimestampCapability::BackendEstimate)
                .map_err(|error| AudioError::BackendInit(error.to_string()))?;
        let errors = Arc::clone(&queue.shared);
        let clock_origin = options.clock_origin;
        let mut stream_origin: Option<cpal::StreamInstant> = None;
        let mut clock = OutputClock::new(format.sample_rate, options.latency_correction_ns)
            .ok_or_else(|| AudioError::UnsupportedFormat("invalid device clock rate".into()))?;
        let stream = device
            .build_output_stream(
                &config.config(),
                move |data: &mut [f32], info: &cpal::OutputCallbackInfo| {
                    let now = Instant::now();
                    let timestamp = info.timestamp();
                    let origin = *stream_origin.get_or_insert(timestamp.callback);
                    let observation = (|| {
                        Some(ClockObservation {
                            callback_ns: u64::try_from(
                                timestamp.callback.duration_since(&origin)?.as_nanos(),
                            )
                            .ok()?,
                            playback_ns: u64::try_from(
                                timestamp.playback.duration_since(&origin)?.as_nanos(),
                            )
                            .ok()?,
                            local_ns: u64::try_from(
                                now.checked_duration_since(clock_origin)?.as_nanos(),
                            )
                            .ok()?,
                            frames: data.len() / usize::from(format.channels),
                        })
                    })();
                    let reading = clock.observe(observation);
                    consumer.render(
                        data,
                        reading
                            .first_frame_local_ns
                            .map(|first_frame_local_ns| PresentationTime {
                                first_frame_local_ns,
                                ns_per_frame: reading.ns_per_frame,
                            }),
                    );
                    consumer.publish_clock(reading);
                },
                move |_error| {
                    errors.device_error.store(true, Ordering::Release);
                    errors.status(ClockStatus::DeviceError);
                    errors.clear(errors.written.load(Ordering::Acquire));
                },
                None,
            )
            .map_err(|error| AudioError::BackendInit(error.to_string()))?;
        stream
            .play()
            .map_err(|error| AudioError::BackendInit(error.to_string()))?;
        Ok(Self {
            stream: Some(stream),
            queue,
            clock_origin,
        })
    }

    pub fn format(&self) -> RenderFormat {
        self.queue.format()
    }

    pub fn write(&mut self, start_local_ns: u64, samples: &[f32]) -> Result<(), OutputError> {
        let now = u64::try_from(self.clock_origin.elapsed().as_nanos())
            .map_err(|_| OutputError::Overflow)?;
        self.queue.write_at(start_local_ns, samples, now)
    }

    pub fn clear(&mut self) {
        self.queue.clear();
    }
    pub fn mute(&mut self) {
        self.queue.mute();
    }
    pub fn unmute(&mut self) {
        self.queue.unmute();
    }
    pub fn set_local_volume(&mut self, volume: f32) -> Result<(), OutputError> {
        self.queue.set_local_volume(volume)
    }
    pub fn telemetry(&self) -> OutputTelemetry {
        self.queue.telemetry()
    }
}

impl Drop for ScheduledOutput {
    fn drop(&mut self) {
        self.queue.mute();
        // Join/stop the native stream while the worker still holds Shared. A
        // callback closure's destruction can never be the last shared Arc drop.
        self.stream = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue(rate: u32, channels: u16) -> (ScheduledPcmQueue, PresentationConsumer) {
        ScheduledPcmQueue::new(RenderFormat {
            sample_rate: rate,
            channels,
        })
        .unwrap()
    }

    fn time(start: u64, rate: u32) -> Option<PresentationTime> {
        Some(PresentationTime {
            first_frame_local_ns: start,
            ns_per_frame: 1e9 / f64::from(rate),
        })
    }

    #[test]
    fn future_start_stays_silent_then_on_time_is_bitwise() {
        let (mut producer, mut consumer) = queue(1_000, 2);
        let input = [-0.0, f32::from_bits(1), -0.75, 0.25];
        producer.write_at(2_000_000, &input, 0).unwrap();
        let mut output = [9.0; 4];
        consumer.render(&mut output, time(0, 1_000));
        assert_eq!(output, [0.0; 4]);
        assert_eq!(producer.telemetry().queued_frames, 2);
        consumer.render(&mut output, time(2_000_000, 1_000));
        assert_eq!(output.map(f32::to_bits), input.map(f32::to_bits));
        let telemetry = producer.telemetry();
        assert_eq!(telemetry.played_frames, 2);
        assert_eq!(telemetry.future_silence_frames, 2);
        assert_eq!(telemetry.queued_frames, 0);
    }

    #[test]
    fn late_frames_trim_and_underflow_never_replays_old_pcm() {
        let (mut producer, mut consumer) = queue(1_000, 1);
        producer.write_at(0, &[1.0, 2.0, 3.0, 4.0], 0).unwrap();
        let mut output = [0.0; 3];
        consumer.render(&mut output, time(2_000_000, 1_000));
        assert_eq!(output, [3.0, 4.0, 0.0]);
        assert_eq!(producer.telemetry().late_frames, 2);
        consumer.render(&mut output, time(5_000_000, 1_000));
        assert_eq!(output, [0.0; 3]);
        producer
            .write_at(4_000_000, &[5.0, 6.0, 7.0, 8.0], 8_000_000)
            .unwrap();
        consumer.render(&mut output, time(8_000_000, 1_000));
        assert_eq!(output, [0.0; 3]);
        assert_eq!(producer.telemetry().late_frames, 6);
    }

    #[test]
    fn clear_reuses_capacity_and_mute_unmute_never_revives_pcm() {
        let (mut producer, mut consumer) = queue(1_000, 1);
        producer.write_at(0, &vec![1.0; 3_000], 0).unwrap();
        producer.clear();
        assert_eq!(producer.telemetry().queued_frames, 0);
        producer.write_at(0, &[2.0], 0).unwrap();
        let mut output = [0.0];
        consumer.render(&mut output, time(0, 1_000));
        assert_eq!(output, [2.0]);
        producer.write_at(1_000_000, &[3.0], 0).unwrap();
        producer.mute();
        assert_eq!(producer.write_at(0, &[4.0], 0), Err(OutputError::Muted));
        consumer.render(&mut output, time(1_000_000, 1_000));
        assert_eq!(output, [0.0]);
        producer.unmute();
        consumer.render(&mut output, time(2_000_000, 1_000));
        assert_eq!(output, [0.0]);
        producer.write_at(3_000_000, &[5.0], 0).unwrap();
        consumer.render(&mut output, time(3_000_000, 1_000));
        assert_eq!(output, [5.0]);
    }

    #[test]
    fn invalid_timestamps_drop_old_epoch_and_report_status() {
        let (mut producer, mut consumer) = queue(48_000, 2);
        producer.write_at(0, &[1.0; 32], 0).unwrap();
        let mut output = [9.0; 32];
        consumer.render(&mut output, None);
        assert_eq!(output, [0.0; 32]);
        assert_eq!(producer.telemetry().clock_status, ClockStatus::Invalid);
        assert_eq!(producer.telemetry().queued_frames, 0);
        consumer.render(&mut output, time(0, 48_000));
        assert_eq!(output, [0.0; 32]);
        let invalid = [f64::NAN, f64::INFINITY, 0.0, -1.0, 2e9];
        for period in invalid {
            consumer.render(
                &mut output,
                Some(PresentationTime {
                    first_frame_local_ns: 1_000_000,
                    ns_per_frame: period,
                }),
            );
            assert_eq!(producer.telemetry().clock_status, ClockStatus::Invalid);
        }
    }

    #[test]
    fn capacity_is_bounded_in_frames_and_bytes_and_errors_are_atomic() {
        let (mut producer, _consumer) = queue(768_000, 32);
        let capacity = producer.telemetry().capacity_frames;
        assert!(capacity <= 768_000 * 3);
        assert!(capacity * (32 * 4 + 16) + 4096 <= MAX_QUEUE_BYTES);
        producer.write_at(0, &vec![0.5; capacity * 32], 0).unwrap();
        assert_eq!(
            producer.write_at(1_000_000_000, &[0.5; 32], 0),
            Err(OutputError::Capacity)
        );
        assert_eq!(producer.telemetry().queued_frames, capacity);
        producer.clear();
        assert_eq!(producer.write_at(0, &[0.0], 0), Err(OutputError::Alignment));
        assert_eq!(
            producer.write_at(0, &[f32::NAN; 32], 0),
            Err(OutputError::NonFinite)
        );
        assert_eq!(
            producer.write_at(0, &[f32::INFINITY; 32], 0),
            Err(OutputError::NonFinite)
        );
        assert_eq!(
            producer.write_at(u64::MAX, &[0.0; 32], 0),
            Err(OutputError::Overflow)
        );
        assert_eq!(
            producer.write_at(MAX_BUFFERED_NS + 1, &[0.0; 32], 0),
            Err(OutputError::TooFarFuture)
        );
        assert_eq!(producer.telemetry().queued_frames, 0);
        assert_eq!(
            producer.set_local_volume(f32::NAN),
            Err(OutputError::NonFinite)
        );
        assert_eq!(producer.set_local_volume(1.1), Err(OutputError::NonFinite));
        assert!(matches!(
            ScheduledPcmQueue::new(RenderFormat {
                sample_rate: 0,
                channels: 2
            }),
            Err(OutputError::Format)
        ));
    }

    #[test]
    fn packet_rounding_and_small_callback_jitter_do_not_drop_samples() {
        let (mut producer, mut consumer) = queue(44_100, 1);
        let mut output = [0.0; 64];
        for block in 0..1_000u64 {
            let start = block * 64 * 1_000_000_000 / 44_100;
            let jitter = if block.is_multiple_of(2) { 1_000 } else { 0 };
            producer
                .write_at(start + jitter, &[0.75; 64], start)
                .unwrap();
            consumer.render(&mut output, time(start, 44_100));
            assert_eq!(output, [0.75; 64], "block {block}");
        }
        assert_eq!(producer.telemetry().late_frames, 0);
        assert_eq!(producer.telemetry().underrun_frames, 0);
        assert_eq!(producer.telemetry().played_frames, 64_000);
    }

    #[test]
    fn continuous_device_clock_run_never_implements_a_second_rate_converter() {
        for ppm in [-500.0, 500.0] {
            let (mut producer, mut consumer) = queue(48_000, 1);
            let period = 1e9 / (48_000.0 * (1.0 + ppm * 1e-6));
            let mut output = [0.0; 480];
            for block in 0..2_000u64 {
                let scheduled = block * 480 * 1_000_000_000 / 48_000;
                let actual = (block as f64 * 480.0 * period).round() as u64;
                producer.write_at(scheduled, &[0.75; 480], actual).unwrap();
                consumer.render(
                    &mut output,
                    Some(PresentationTime {
                        first_frame_local_ns: actual,
                        ns_per_frame: period,
                    }),
                );
                assert_eq!(output, [0.75; 480], "ppm={ppm}, block={block}");
            }
            assert_eq!(producer.telemetry().late_frames, 0);
            assert_eq!(producer.telemetry().underrun_frames, 0);
        }
    }

    #[test]
    fn control_changes_during_callback_zero_the_unsubmitted_buffer() {
        let (mut producer, mut consumer) = queue(1_000, 1);
        producer.write_at(0, &[0.5; 4], 0).unwrap();
        let mut output = [9.0; 4];
        consumer.render_inner(&mut output, time(0, 1_000), || {
            producer.clear();
            producer.write_at(4_000_000, &[0.75; 4], 0).unwrap();
        });
        assert_eq!(output, [0.0; 4]);
        consumer.render(&mut output, time(4_000_000, 1_000));
        assert_eq!(output, [0.75; 4]);
        producer.write_at(8_000_000, &[0.5; 4], 0).unwrap();
        consumer.render_inner(&mut output, time(8_000_000, 1_000), || {
            producer.mute();
            producer.unmute();
        });
        assert_eq!(output, [0.0; 4]);
        consumer.render(&mut output, time(12_000_000, 1_000));
        assert_eq!(output, [0.0; 4]);
    }

    #[test]
    fn volume_is_applied_after_scheduling_and_device_failure_is_sticky() {
        let (mut producer, mut consumer) = queue(1_000, 1);
        producer.set_local_volume(0.5).unwrap();
        producer.write_at(0, &[0.75], 0).unwrap();
        let mut output = [0.0];
        consumer.render(&mut output, time(0, 1_000));
        assert_eq!(output, [0.375]);
        producer.shared.device_error.store(true, Ordering::Release);
        assert_eq!(producer.telemetry().clock_status, ClockStatus::DeviceError);
        assert_eq!(
            producer.write_at(1_000_000, &[1.0], 0),
            Err(OutputError::DeviceError)
        );
        consumer.render(&mut output, time(1_000_000, 1_000));
        assert_eq!(output, [0.0]);
    }

    #[test]
    fn concurrent_clear_and_mute_cannot_revive_old_generation() {
        let (mut producer, mut consumer) = queue(48_000, 2);
        let stop = Arc::new(AtomicBool::new(false));
        let render_stop = Arc::clone(&stop);
        let worker = std::thread::spawn(move || {
            let mut output = [0.0; 256];
            let mut cursor = 0u64;
            while !render_stop.load(Ordering::Acquire) {
                consumer.render(&mut output, time(cursor * 1_000_000_000 / 48_000, 48_000));
                cursor += 128;
            }
            consumer
        });
        for _ in 0..500 {
            producer.clear();
            let _ = producer.write_at(0, &[0.5; 1_024], 0);
            producer.mute();
            producer.unmute();
        }
        producer.mute();
        stop.store(true, Ordering::Release);
        let mut consumer = worker.join().unwrap();
        producer.unmute();
        let mut output = [9.0; 1_024];
        consumer.render(&mut output, time(2_000_000_000, 48_000));
        assert_eq!(output, [0.0; 1_024]);
        assert_eq!(producer.telemetry().queued_frames, 0);
    }
}
