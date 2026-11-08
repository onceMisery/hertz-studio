// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Strict native qualification. Decoder-returned planar PCM is precharged for
//! the accepted capacity, alongside queues and mapped copies. Codec-private
//! non-PCM allocations and invalid buffers beyond the accepted bounds remain
//! separate measurements; acceptance checks do not constrain earlier failures.
//! Application PCM is mapped directly from planar decoder output, avoiding a
//! second SampleBuffer allocation and applying demuxer/decoder trim only once.

use super::*;
use std::io::{Read, Seek};
use std::time::{Duration, Instant};
use symphonia::core::audio::{AudioBuffer, AudioBufferRef, Channels, Signal, SignalSpec};
use symphonia::core::conv::IntoSample;
use symphonia::core::formats::Packet;
use symphonia::core::sample::Sample;
use symphonia::core::units::TimeBase;

const MAX_DURATION_NS: u64 = 3_000_000_000;
const MAX_BYTES: usize = 8 * 1024 * 1024;
const DECODER_CAPACITY_FRAMES: u64 = 192_000 / 2;
const DECODER_CAPACITY_BYTES: usize = DECODER_CAPACITY_FRAMES as usize * 2 * 8;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct NativePcmUsage {
    pub duration_ns: u64,
    pub bytes: usize,
}

/// One producer's shared allowance across preparation, every renderer/deck,
/// and events waiting for its host. Each independent copy needs a reservation.
#[derive(Debug, Clone)]
pub struct NativePcmBudget(Arc<Mutex<NativePcmUsage>>);

impl Default for NativePcmBudget {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(NativePcmUsage::default())))
    }
}

impl NativePcmBudget {
    pub fn usage(&self) -> NativePcmUsage {
        *self.0.lock().unwrap()
    }

    pub fn reserve(
        &self,
        frames: u64,
        sample_rate: u32,
        bytes: usize,
    ) -> Result<NativePcmReservation, AudioError> {
        if sample_rate == 0 {
            return Err(native_error("native_pcm_budget_invalid_rate"));
        }
        let duration = (u128::from(frames) * 1_000_000_000).div_ceil(u128::from(sample_rate));
        let duration_ns =
            u64::try_from(duration).map_err(|_| native_error("native_pcm_budget_exceeded"))?;
        let mut used = self.0.lock().unwrap();
        let new_duration = used.duration_ns.checked_add(duration_ns);
        let new_bytes = used.bytes.checked_add(bytes);
        match (new_duration, new_bytes) {
            (Some(duration), Some(bytes)) if duration <= MAX_DURATION_NS && bytes <= MAX_BYTES => {
                used.duration_ns = duration;
                used.bytes = bytes;
            }
            _ => return Err(native_error("native_pcm_budget_exceeded")),
        }
        Ok(NativePcmReservation(Arc::new(Reservation {
            budget: self.clone(),
            usage: NativePcmUsage { duration_ns, bytes },
        })))
    }

    fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    fn wait_reserve(
        &self,
        frames: u64,
        rate: u32,
        bytes: usize,
        stop: Option<&AtomicBool>,
        deadline: Option<Instant>,
    ) -> Result<NativePcmReservation, AudioError> {
        // An intrinsically oversized block is rejected immediately. Live
        // pressure waits for release, with the preparation deadline or runtime
        // cancellation still active while the decoder keeps its planar charge.
        if rate == 0 {
            return Err(native_error("native_pcm_budget_invalid_rate"));
        }
        if bytes > MAX_BYTES
            || u128::from(frames) * 1_000_000_000 > u128::from(rate) * u128::from(MAX_DURATION_NS)
        {
            return Err(native_error("native_pcm_budget_exceeded"));
        }
        loop {
            check_stop(stop, deadline)?;
            match self.reserve(frames, rate, bytes) {
                Ok(reservation) => return Ok(reservation),
                Err(_) => std::thread::sleep(Duration::from_millis(4)),
            }
        }
    }
}

/// Clone this token only when cloning a reference to the same allocation.
/// Its charge ends after the last such reference; independent copies must call
/// `NativePcmBudget::reserve` before allocating.
#[derive(Debug, Clone)]
pub struct NativePcmReservation(Arc<Reservation>);

impl NativePcmReservation {
    pub fn usage(&self) -> NativePcmUsage {
        self.0.usage
    }
}

#[derive(Debug)]
struct Reservation {
    budget: NativePcmBudget,
    usage: NativePcmUsage,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut used = self.budget.0.lock().unwrap();
        used.duration_ns -= self.usage.duration_ns;
        used.bytes -= self.usage.bytes;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeDecodedFormat {
    pub sample_rate: u32,
    /// Actual source count; the room renderer always emits stereo.
    pub channels: u16,
}

fn native_error(reason: &str) -> AudioError {
    AudioError::DecodeFailed(reason.into())
}

pub(super) fn validate_output_format(format: RenderFormat) -> Result<(), AudioError> {
    if !native_rate(format.sample_rate) || format.channels != 2 {
        return Err(AudioError::UnsupportedFormat(
            "native_source_format_unsupported".into(),
        ));
    }
    Ok(())
}

fn native_rate(rate: u32) -> bool {
    matches!(rate, 44_100 | 48_000 | 88_200 | 96_000 | 176_400 | 192_000)
}

fn qualify_spec(spec: SignalSpec) -> Result<NativeDecodedFormat, AudioError> {
    if !native_rate(spec.rate) {
        return Err(AudioError::UnsupportedFormat(
            "native_source_rate_unsupported".into(),
        ));
    }
    let channels =
        if spec.channels == Channels::FRONT_LEFT || spec.channels == Channels::FRONT_CENTRE {
            1
        } else if spec.channels == (Channels::FRONT_LEFT | Channels::FRONT_RIGHT) {
            2
        } else {
            return Err(AudioError::UnsupportedFormat(
                "native_source_layout_unsupported".into(),
            ));
        };
    Ok(NativeDecodedFormat {
        sample_rate: spec.rate,
        channels,
    })
}

fn check_stop(stop: Option<&AtomicBool>, deadline: Option<Instant>) -> Result<(), AudioError> {
    if stop.is_some_and(|stop| stop.load(Ordering::Acquire)) {
        return Err(native_error("native_source_cancelled"));
    }
    if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        if let Some(stop) = stop {
            stop.store(true, Ordering::Release);
        }
        return Err(native_error("native_source_preparation_timeout"));
    }
    Ok(())
}

/// Checks shared cancellation before and after source calls. Blocking online
/// reads must also observe this same flag in their download wait implementation.
pub(super) struct GuardedSource {
    pub source: Box<dyn AudioSource>,
    pub stop: Arc<AtomicBool>,
    pub deadline: Arc<Mutex<Option<Instant>>>,
}

impl GuardedSource {
    fn check(&self) -> std::io::Result<()> {
        check_stop(Some(&self.stop), *self.deadline.lock().unwrap()).map_err(|error| {
            std::io::Error::new(std::io::ErrorKind::Interrupted, error.to_string())
        })
    }
}

impl Read for GuardedSource {
    fn read(&mut self, data: &mut [u8]) -> std::io::Result<usize> {
        self.check()?;
        let result = self.source.read(data);
        self.check()?;
        result
    }
}

impl Seek for GuardedSource {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        self.check()?;
        let result = self.source.seek(position);
        self.check()?;
        result
    }
}

impl symphonia::core::io::MediaSource for GuardedSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        self.source.media_len()
    }
}

struct PcmPrefix {
    samples: Vec<f32>,
    _reservation: NativePcmReservation,
}

pub(super) struct QualifiedSource {
    pub budget: NativePcmBudget,
    pub deadline: Instant,
    spec: SignalSpec,
    format: NativeDecodedFormat,
    timeline: Timeline,
    prefix: Option<PcmPrefix>,
}

impl QualifiedSource {
    pub(super) fn format(&self) -> NativeDecodedFormat {
        self.format
    }
}

struct Timeline {
    base: TimeBase,
    next_ts: Option<u64>,
    discard_until: Option<u64>,
    trimmed: bool,
    expected_end: Option<u64>,
}

impl Timeline {
    fn new(opened: &OpenedReader) -> Result<Self, AudioError> {
        let params = &opened
            .reader
            .tracks()
            .iter()
            .find(|track| track.id == opened.track_id)
            .ok_or_else(|| native_error("native_source_timeline_unverified"))?
            .codec_params;
        let base = params
            .time_base
            .filter(|base| base.numer != 0 && base.denom != 0)
            .ok_or_else(|| native_error("native_source_timeline_unverified"))?;
        let expected_end = if opened.gapless_supported {
            params
                .n_frames
                .and_then(|frames| params.start_ts.checked_add(frames))
        } else {
            None
        };
        Ok(Self {
            base,
            next_ts: None,
            discard_until: opened.initial_position.map(|(_, ts)| ts),
            trimmed: opened.gapless_supported,
            expected_end,
        })
    }

    fn frames(&self, ticks: u64, rate: u32) -> Result<usize, AudioError> {
        let numerator = u128::from(ticks) * u128::from(self.base.numer) * u128::from(rate);
        let denominator = u128::from(self.base.denom);
        if numerator % denominator != 0 {
            return Err(native_error("native_source_timeline_unverified"));
        }
        usize::try_from(numerator / denominator)
            .map_err(|_| native_error("native_source_timeline_unverified"))
    }

    fn check_packet(&self, opened: &OpenedReader, packet: &Packet) -> Result<(), AudioError> {
        let base = opened
            .reader
            .tracks()
            .iter()
            .find(|track| track.id == opened.track_id)
            .and_then(|track| track.codec_params.time_base);
        if base != Some(self.base) {
            return Err(native_error("native_source_timeline_unverified"));
        }
        // Check timeline duration and compressed packet size before decoding.
        // The actual returned capacity is checked again before PCM allocation.
        if u128::from(packet.dur()) * u128::from(self.base.numer) * 2 > u128::from(self.base.denom)
            || packet.buf().len() > 4 * 1024 * 1024
        {
            return Err(native_error("native_source_decoded_block_too_large"));
        }
        Ok(())
    }

    fn accept(
        &mut self,
        packet: &Packet,
        spec: SignalSpec,
        frames: usize,
    ) -> Result<usize, AudioError> {
        if self.next_ts.is_some_and(|next| packet.ts() != next)
            || self
                .discard_until
                .is_some_and(|target| packet.ts() > target)
            || self.frames(packet.dur(), spec.rate)? != frames
            || ((packet.trim_start() != 0 || packet.trim_end() != 0) && !self.trimmed)
        {
            return Err(native_error(&format!("native_source_timeline_unverified: packet ts={} duration={} decoded_frames={} rate={} time_base={}/{}", packet.ts(), packet.dur(), frames, spec.rate, self.base.numer, self.base.denom)));
        }
        self.next_ts = Some(
            packet
                .ts()
                .checked_add(packet.dur())
                .ok_or_else(|| native_error("native_source_timeline_unverified"))?,
        );
        let skip = match self.discard_until {
            Some(target) => self
                .frames(target.saturating_sub(packet.ts()), spec.rate)?
                .min(frames),
            None => 0,
        };
        if skip < frames {
            self.discard_until = None;
        }
        Ok(skip)
    }

    fn clean_end(&self) -> bool {
        self.expected_end
            .is_none_or(|end| self.next_ts == Some(end))
    }
}

/// Map and validate directly from the decoder's planar output. Both the saved
/// prefix and all following packets use this entry, after decoder-applied trim.
fn map_decoded(
    decoded: AudioBufferRef<'_>,
    skip: usize,
    budget: &NativePcmBudget,
    stop: Option<&AtomicBool>,
    deadline: Option<Instant>,
) -> Result<PcmPrefix, AudioError> {
    let spec = *decoded.spec();
    let frames = decoded.frames();
    if frames > spec.rate as usize / 2 || decoded.capacity() > spec.rate as usize / 2 {
        return Err(native_error("native_source_decoded_block_too_large"));
    }
    let remaining = frames - skip;
    let count = remaining
        .checked_mul(2)
        .ok_or_else(|| native_error("native_pcm_budget_exceeded"))?;
    let reservation =
        budget.wait_reserve(remaining as u64, spec.rate, count * 4, stop, deadline)?;
    let mut samples = Vec::with_capacity(count);
    fn copy<S: Sample + IntoSample<f32>>(
        buffer: &AudioBuffer<S>,
        skip: usize,
        output: &mut Vec<f32>,
    ) -> Result<(), AudioError> {
        let channels = buffer.spec().channels.count();
        for frame in 0..buffer.frames() {
            let left: f32 = buffer.chan(0)[frame].into_sample();
            let right: f32 = buffer.chan(channels - 1)[frame].into_sample();
            if !left.is_finite() || !right.is_finite() {
                return Err(native_error("native_source_nonfinite_samples"));
            }
            if frame >= skip {
                output.extend([left, right]);
            }
        }
        Ok(())
    }
    macro_rules! copy_variant {
        ($($kind:ident),*) => { match decoded { $(AudioBufferRef::$kind(buffer) => copy(&buffer, skip, &mut samples)?,)* } };
    }
    copy_variant!(U8, U16, U24, U32, S8, S16, S24, S32, F32, F64);
    check_stop(stop, deadline)?;
    Ok(PcmPrefix {
        samples,
        _reservation: reservation,
    })
}

impl PreparedMedia {
    /// Reserve accepted planar PCM before probing or creating the decoder.
    /// The 0.5-second duration bound applies at every supported source rate;
    /// bytes cover the maximum stereo f64 allocation at 192 kHz.
    pub fn open_native_interruptible(
        source: Box<dyn AudioSource>,
        ext: Option<&str>,
        stop: Arc<AtomicBool>,
        budget: NativePcmBudget,
        deadline: Instant,
    ) -> Result<Self, AudioError> {
        let storage = budget.wait_reserve(
            DECODER_CAPACITY_FRAMES,
            192_000,
            DECODER_CAPACITY_BYTES,
            Some(&stop),
            Some(deadline),
        )?;
        let mut media = Self::open_interruptible(source, ext, stop)?;
        media.opened.native_decoder_storage = Some(storage);
        Ok(media)
    }

    /// Seek and qualify under one total deadline, without using a declared
    /// duration to silently change the requested source position.
    pub fn seek_native(
        &mut self,
        position_ms: u64,
        budget: NativePcmBudget,
        deadline: Instant,
    ) -> Result<NativeDecodedFormat, AudioError> {
        self.opened.native = None;
        *self.opened.preparation_deadline.lock().unwrap() = Some(deadline);
        let result = (|| {
            check_stop(self.opened.input_stop.as_deref(), Some(deadline))?;
            self.seek_prepared(position_ms, false)?;
            self.validate_native(budget, deadline)
        })();
        *self.opened.preparation_deadline.lock().unwrap() = None;
        result
    }

    pub fn declared_info(&self) -> &MediaInfo {
        &self.info
    }

    pub fn decoded_format(&self) -> Option<NativeDecodedFormat> {
        self.opened.native.as_ref().map(|source| source.format)
    }

    /// Online callers install a download-completed predicate. A truncated or
    /// interrupted progressive source cannot publish a natural native EOF.
    pub fn set_native_eof_check(&mut self, check: Arc<dyn Fn() -> bool + Send + Sync>) {
        self.opened.native_eof_check = Some(check);
    }

    pub fn validate_native(
        &mut self,
        budget: NativePcmBudget,
        deadline: Instant,
    ) -> Result<NativeDecodedFormat, AudioError> {
        check_stop(self.opened.input_stop.as_deref(), Some(deadline))?;
        if let Some(qualified) = &self.opened.native {
            if !budget.same(&qualified.budget) {
                return Err(native_error("native_pcm_budget_mismatch"));
            }
            return Ok(qualified.format);
        }
        *self.opened.preparation_deadline.lock().unwrap() = Some(deadline);
        let result = self.validate_native_inner(budget, deadline);
        *self.opened.preparation_deadline.lock().unwrap() = None;
        result
    }

    fn validate_native_inner(
        &mut self,
        budget: NativePcmBudget,
        deadline: Instant,
    ) -> Result<NativeDecodedFormat, AudioError> {
        if let Some(storage) = &self.opened.native_decoder_storage {
            if !storage.0.budget.same(&budget) {
                return Err(native_error("native_pcm_budget_mismatch"));
            }
        } else {
            self.opened.native_decoder_storage = Some(budget.wait_reserve(
                DECODER_CAPACITY_FRAMES,
                192_000,
                DECODER_CAPACITY_BYTES,
                self.opened.input_stop.as_deref(),
                Some(deadline),
            )?);
        }
        let mut timeline = Timeline::new(&self.opened)?;
        loop {
            check_stop(self.opened.input_stop.as_deref(), Some(deadline))?;
            let packet = match self.opened.reader.next_packet() {
                Ok(packet) if packet.track_id() != self.opened.track_id => continue,
                Ok(packet) => packet,
                Err(SymError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    if !self
                        .opened
                        .native_eof_check
                        .as_ref()
                        .is_none_or(|check| check())
                    {
                        return Err(native_error("native_source_incomplete"));
                    }
                    return Err(native_error("native_source_empty"));
                }
                Err(SymError::ResetRequired) => {
                    return Err(native_error("native_source_timeline_unverified"))
                }
                Err(error) => {
                    return Err(native_error(&format!(
                        "native_source_decode_failed: {error}"
                    )))
                }
            };
            timeline.check_packet(&self.opened, &packet)?;
            let decoded =
                self.opened.decoder.decode(&packet).map_err(|error| {
                    native_error(&format!("native_source_decode_failed: {error}"))
                })?;
            if decoded.frames() == 0 {
                if packet.dur() != 0 {
                    return Err(native_error("native_source_timeline_unverified"));
                }
                continue;
            }
            let spec = *decoded.spec();
            let skip = timeline.accept(&packet, spec, decoded.frames())?;
            if skip == decoded.frames() {
                if decoded.capacity() > spec.rate as usize / 2 {
                    return Err(native_error("native_source_decoded_block_too_large"));
                }
                continue;
            }
            let format = qualify_spec(spec)?;
            let prefix = map_decoded(
                decoded,
                skip,
                &budget,
                self.opened.input_stop.as_deref(),
                Some(deadline),
            )?;
            if prefix.samples.is_empty() {
                continue;
            }
            self.opened.native = Some(QualifiedSource {
                budget,
                deadline,
                spec,
                format,
                timeline,
                prefix: Some(prefix),
            });
            return Ok(format);
        }
    }
}

impl RenderCore {
    pub(super) fn validate_native_install(&self, opened: &OpenedReader) -> Result<(), AudioError> {
        if let Some(budget) = &self.native_budget {
            let qualified = opened
                .native
                .as_ref()
                .ok_or_else(|| native_error("native_source_requires_prepared_media"))?;
            if qualified.format.sample_rate != self.output_rate || !budget.same(&qualified.budget) {
                return Err(native_error("native_source_format_or_budget_mismatch"));
            }
            if !opened
                .native_decoder_storage
                .as_ref()
                .is_some_and(|storage| storage.0.budget.same(budget))
            {
                return Err(native_error("native_pcm_budget_mismatch"));
            }
        } else if opened.native.is_some() || opened.native_decoder_storage.is_some() {
            return Err(native_error("native_source_requires_native_renderer"));
        }
        Ok(())
    }

    /// The producer can preserve the exact prepared source for a fresh epoch
    /// when a same-rate successor lacks sample-exact trim qualification.
    pub fn native_successor_eligible(
        &self,
        media: &PreparedMedia,
        crossfade_ms: u64,
        gain_db: f32,
    ) -> bool {
        self.native_budget.is_some()
            && self.validate_native_install(&media.opened).is_ok()
            && gain_db.is_finite()
            && self.pending_load.is_none()
            && !self.pending_stop
            && !self.tail_armed
            && !self.prepared_next_started()
            && !matches!(
                *self.shared.next_event.lock().unwrap(),
                Some(RenderEvent::Transitioned { .. })
            )
            && (crossfade_ms != 0 || (self.gapless_supported && media.opened.gapless_supported))
    }
}

fn enqueue(block: PcmPrefix, deck: &Deck, stop: &AtomicBool) -> Result<(), AudioError> {
    let mut at = 0;
    while at < block.samples.len() {
        check_stop(Some(stop), None)?;
        let mut queue = deck.samples.lock().unwrap();
        // Its reservation charges the whole retained allocation. This check
        // controls actual writes, including the initial decoded prefix.
        let capacity = deck.native_storage.as_ref().unwrap().usage().bytes / 4;
        let count = ((capacity - queue.len()).min(block.samples.len() - at) / 2) * 2;
        queue.extend(block.samples[at..at + count].iter().copied());
        at += count;
        drop(queue);
        if at < block.samples.len() {
            std::thread::sleep(Duration::from_millis(4));
        }
    }
    Ok(())
}

pub(super) fn decode_loop(
    mut opened: OpenedReader,
    deck: Arc<Deck>,
    stop: Arc<AtomicBool>,
    seek_to: Arc<Mutex<Option<SeekRequest>>>,
    output_rate: u32,
) {
    let mut qualified = opened.native.take().unwrap();
    let mut seek_reply = None;
    let mut pending_packet = None;
    let result = (|| -> Result<(), AudioError> {
        if let Some(prefix) = qualified.prefix.take() {
            enqueue(prefix, &deck, &stop)?;
        }
        'packets: loop {
            check_stop(Some(&stop), None)?;
            if let Some(SeekRequest { position_ms, reply }) = seek_to.lock().unwrap().take() {
                let time = Time::new(position_ms / 1000, (position_ms % 1000) as f64 / 1000.0);
                match opened.reader.seek(
                    SeekMode::Accurate,
                    SeekTo::Time {
                        time,
                        track_id: Some(opened.track_id),
                    },
                ) {
                    Ok(sought) => {
                        opened.decoder.reset();
                        pending_packet = None;
                        qualified.prefix = None;
                        qualified.timeline = Timeline::new(&opened)?;
                        qualified.timeline.discard_until = Some(sought.required_ts);
                        deck.samples.lock().unwrap().clear();
                        deck.frames_played
                            .store(ms_to_frames(position_ms, output_rate), Ordering::Relaxed);
                        deck.eof.store(false, Ordering::Release);
                        seek_reply = Some(reply);
                    }
                    Err(error) => {
                        let _ = reply.send(Err(native_error(&format!("seek failed: {error}"))));
                    }
                }
            }
            if deck.eof.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(4));
                continue;
            }
            if deck.samples.lock().unwrap().len()
                >= deck.native_storage.as_ref().unwrap().usage().bytes / 4
            {
                std::thread::sleep(Duration::from_millis(4));
                continue;
            }
            let packet = match pending_packet
                .take()
                .map(Ok)
                .unwrap_or_else(|| opened.reader.next_packet())
            {
                Ok(packet) if packet.track_id() != opened.track_id => continue,
                Ok(packet) => packet,
                Err(SymError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    check_stop(Some(&stop), None)?;
                    if !opened.native_eof_check.as_ref().is_none_or(|check| check())
                        || !qualified.timeline.clean_end()
                    {
                        return Err(native_error("native_source_incomplete"));
                    }
                    if seek_reply.is_some() {
                        return Err(native_error("native_source_empty"));
                    }
                    deck.eof.store(true, Ordering::Release);
                    continue;
                }
                Err(SymError::ResetRequired) => {
                    return Err(native_error("native_source_timeline_unverified"))
                }
                Err(error) => {
                    return Err(native_error(&format!(
                        "native_source_decode_failed: {error}"
                    )))
                }
            };
            qualified.timeline.check_packet(&opened, &packet)?;
            let packet_samples = qualified
                .timeline
                .frames(packet.dur(), qualified.spec.rate)?
                * 2;
            let capacity = deck.native_storage.as_ref().unwrap().usage().bytes / 4;
            // One decoder writes this queue; consumption only creates room.
            // Wait before decoding/mapping so an ahead successor never holds
            // a mapped PCM copy while its nearly full queue awaits playback.
            while capacity - deck.samples.lock().unwrap().len() < packet_samples {
                check_stop(Some(&stop), None)?;
                if seek_to.lock().unwrap().is_some() {
                    // A failed seek must retain the unread PCM packet. Only a
                    // successful seek replaces the decoder's current timeline.
                    pending_packet = Some(packet);
                    continue 'packets;
                }
                std::thread::sleep(Duration::from_millis(4));
            }
            let decoded = opened
                .decoder
                .decode(&packet)
                .map_err(|error| native_error(&format!("native_source_decode_failed: {error}")))?;
            if decoded.frames() == 0 {
                if packet.dur() != 0 {
                    return Err(native_error("native_source_timeline_unverified"));
                }
                continue;
            }
            let spec = *decoded.spec();
            if spec != qualified.spec {
                return Err(native_error("native_source_format_changed"));
            }
            let skip = qualified.timeline.accept(&packet, spec, decoded.frames())?;
            let prefix = map_decoded(decoded, skip, &qualified.budget, Some(&stop), None)?;
            if prefix.samples.is_empty() {
                continue;
            }
            enqueue(prefix, &deck, &stop)?;
            if let Some(reply) = seek_reply.take() {
                let _ = reply.send(Ok(()));
            }
        }
    })();
    if let Err(error) = result {
        if let Some(reply) = seek_reply.take() {
            let _ = reply.send(Err(native_error(&error.to_string())));
        }
        if !stop.load(Ordering::Acquire) {
            tracing::warn!(%error, "native decoding failed");
            deck.flag_decode_error();
        }
    }
    stop.store(true, Ordering::Release);
}
