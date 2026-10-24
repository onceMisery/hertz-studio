// SPDX-License-Identifier: MIT
//! Native LAN presentation owner. The worker constructs, uses and drops CPAL
//! on one ordinary thread. Both local-host and remote PCM enter this pipeline.
//!
//! ReceiverGate remains the protocol authority; its time is never advanced to
//! a speculative submission horizon. Accepted commits separately authorize
//! future writes to ScheduledOutput, whose callback enforces presentation time.
//! A converter's output counter is the only packet scheduling cursor: changing
//! the clock estimate never reanchors packets or drops/duplicates samples.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, watch};
use vmusic_audio::clocked_resample::{ClockedConverter, State as ConvertState};
use vmusic_audio::output_clock::ClockStatus;
use vmusic_audio::{OutputError, OutputOptions, OutputTelemetry, RenderFormat, ScheduledOutput};
use vmusic_core::room::receiver::{FormatDesc, GateAction, GateInput, PlanDesc, ReceiverGate};
use vmusic_lan::clock::{ClockMapping, MonotonicClock};
use vmusic_lan::protocol::{validate_payload, AudioFormat, PcmBlock, Plan, StreamIdentity};

const COMMAND_CAPACITY: usize = 64;
const EVENT_CAPACITY: usize = 32;
// Includes commands waiting for the worker, not merely its active PCM deque.
// At the lowest accepted wire rate this is under 1.82 seconds. Converter lookahead
// and a <=600ms output horizon keep total live PCM below 3s/8MiB. A device
// reporting >500ms submission lead is explicitly unsupported by this policy.
const INPUT_FRAME_LIMIT: usize = 80_000;
const INPUT_BYTE_LIMIT: usize = 4 * 1024 * 1024;
const HORIZON_NS: u64 = 100_000_000;
const SUBMIT_MARGIN_NS: u64 = 20_000_000;
const DEVICE_FRESHNESS_NS: u64 = 250_000_000;
const MAX_DEVICE_LEAD_NS: u64 = 500_000_000;
const TICK: Duration = Duration::from_millis(2);
const GATE_SESSION: u64 = 1; // Used only after comparing all three UUIDs.

#[derive(Debug, Clone, thiserror::Error)]
pub(crate) enum ReceiverError {
    #[error("receiver command/PCM budget exhausted")]
    Capacity,
    #[error("receiver has stopped")]
    Closed,
    #[error("receiver output initialization failed: {0}")]
    Output(String),
    #[error("invalid receiver input: {0}")]
    Invalid(&'static str),
}

#[derive(Debug, Clone)]
pub(crate) struct ReceiverStatus {
    pub identity: StreamIdentity,
    pub connected: bool,
    pub output_ready: bool,
    pub current_epoch: Option<u64>,
    pub preparing_epoch: Option<u64>,
    pub network_clock: Option<ClockMapping>,
    pub output: Option<OutputTelemetry>,
    pub buffered_input_frames: usize,
    /// Nominal source-frame estimate from actual device output progress. Exact
    /// device played/underrun counts and clock quality are exposed in `output`.
    pub played_frame: u64,
    pub underrun_frames: u64,
    pub discarded_blocks: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum ReceiverEvent {
    Ready {
        epoch: u64,
        plan_id: u64,
    },
    /// The application must arrange a fresh future join. The worker never
    /// reconnects sockets or authorizes an old plan after a fault.
    Resync {
        reason: String,
    },
    Status(ReceiverStatus),
}

#[derive(Default)]
struct Budget {
    frames: AtomicUsize,
    bytes: AtomicUsize,
}

struct Reservation {
    budget: Arc<Budget>,
    frames: usize,
    bytes: usize,
}

impl Reservation {
    fn acquire(budget: &Arc<Budget>, block: &PcmBlock) -> Result<Self, ReceiverError> {
        let frames = block.frame_count() as usize;
        let bytes = block.byte_len();
        if budget
            .frames
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_add(frames).filter(|n| *n <= INPUT_FRAME_LIMIT)
            })
            .is_err()
        {
            return Err(ReceiverError::Capacity);
        }
        if budget
            .bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_add(bytes).filter(|n| *n <= INPUT_BYTE_LIMIT)
            })
            .is_err()
        {
            budget.frames.fetch_sub(frames, Ordering::AcqRel);
            return Err(ReceiverError::Capacity);
        }
        Ok(Self {
            budget: Arc::clone(budget),
            frames,
            bytes,
        })
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget.frames.fetch_sub(self.frames, Ordering::AcqRel);
        self.budget.bytes.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

struct Pcm {
    block: PcmBlock,
    offset_frames: usize,
    _reservation: Reservation,
}

enum Command {
    Prepare(StreamIdentity, Plan),
    Commit {
        identity: StreamIdentity,
        epoch: u64,
        plan_id: u64,
        effective_at: u64,
    },
    Pcm(Pcm),
    Mapping(ClockMapping),
    Volume(f32),
    Reopen(OutputOptions),
}

struct Envelope {
    generation: u64,
    command: Command,
}

struct Lease(Arc<AtomicBool>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

struct WorkerDone(watch::Sender<bool>);
impl Drop for WorkerDone {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

#[derive(Clone)]
pub(crate) struct ReceiverHandle {
    commands: mpsc::Sender<Envelope>,
    trip: Arc<AtomicBool>,
    invalidated: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    disconnected: Arc<AtomicBool>,
    budget: Arc<Budget>,
    status: watch::Receiver<ReceiverStatus>,
    done: watch::Receiver<bool>,
    _lease: Arc<Lease>,
}

impl ReceiverHandle {
    // Nonblocking ingress: a slow receiver must never hold the network owner.
    // Backpressure is an authorization failure, so the urgent latch bypasses
    // the full command queue and silences the worker on its next bounded tick.
    fn send(&self, command: Command) -> Result<(), ReceiverError> {
        let envelope = Envelope {
            generation: self.generation.load(Ordering::Acquire),
            command,
        };
        match self.commands.try_send(envelope) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.generation.fetch_add(1, Ordering::AcqRel);
                self.trip.store(true, Ordering::Release);
                Err(ReceiverError::Capacity)
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Err(ReceiverError::Closed),
        }
    }

    pub fn prepare(&self, identity: StreamIdentity, plan: Plan) -> Result<(), ReceiverError> {
        self.send(Command::Prepare(identity, plan))
    }

    pub fn commit(
        &self,
        identity: StreamIdentity,
        epoch: u64,
        plan_id: u64,
        effective_at: u64,
    ) -> Result<(), ReceiverError> {
        self.send(Command::Commit {
            identity,
            epoch,
            plan_id,
            effective_at,
        })
    }

    pub fn pcm(&self, block: PcmBlock) -> Result<(), ReceiverError> {
        validate_block(&block)?;
        let reservation = Reservation::acquire(&self.budget, &block).inspect_err(|_| {
            self.generation.fetch_add(1, Ordering::AcqRel);
            self.trip.store(true, Ordering::Release);
        })?;
        self.send(Command::Pcm(Pcm {
            block,
            offset_frames: 0,
            _reservation: reservation,
        }))
    }

    pub fn mapping(&self, mapping: ClockMapping) -> Result<(), ReceiverError> {
        self.send(Command::Mapping(mapping))
    }

    /// Permanent for this session. Reconnection creates a new receiver with a
    /// fresh identity; queued commands cannot undo this out-of-band latch.
    pub fn disconnect(&self) {
        self.disconnected.store(true, Ordering::Release);
    }

    /// Revoke queued authorization immediately while retaining this session's
    /// monotonically increasing plan token. A fresh future Prepare may follow
    /// this call directly: its generation survives the urgent queue flush.
    pub fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.invalidated.store(true, Ordering::Release);
    }

    pub fn set_volume(&self, volume: f32) -> Result<(), ReceiverError> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err(ReceiverError::Invalid("volume"));
        }
        self.send(Command::Volume(volume))
    }

    pub fn reopen(&self, options: OutputOptions) -> Result<(), ReceiverError> {
        validate_options(&options)?;
        self.send(Command::Reopen(options))
    }

    pub fn status(&self) -> ReceiverStatus {
        self.status.borrow().clone()
    }

    pub fn subscribe_status(&self) -> watch::Receiver<ReceiverStatus> {
        self.status.clone()
    }

    /// Stops this entire session, including other handle clones. Success means
    /// the native output was dropped on its owner thread, so an exclusive
    /// device lease may be released. A timeout must not be treated as release.
    pub async fn shutdown(self) -> Result<(), ReceiverError> {
        self.disconnect();
        let mut done = self.done.clone();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !*done.borrow_and_update() {
                done.changed().await.map_err(|_| ReceiverError::Closed)?;
            }
            Ok(())
        })
        .await
        .map_err(|_| ReceiverError::Output("native output shutdown timed out".into()))?
    }
}

/// `OutputOptions.clock_origin` is normalized to the supplied shared clock.
/// CPAL never crosses an await or thread boundary. Initialization errors are
/// returned before the handle is published; reopening reports through status.
pub(crate) async fn spawn(
    mut options: OutputOptions,
    identity: StreamIdentity,
    clock: MonotonicClock,
) -> Result<(ReceiverHandle, mpsc::Receiver<ReceiverEvent>), ReceiverError> {
    validate_options(&options)?;
    options.clock_origin = clock.origin();
    let (commands, mut inbox) = mpsc::channel(COMMAND_CAPACITY);
    let (events, event_rx) = mpsc::channel(EVENT_CAPACITY);
    let budget = Arc::new(Budget::default());
    let trip = Arc::new(AtomicBool::new(false));
    let invalidated = Arc::new(AtomicBool::new(false));
    let generation = Arc::new(AtomicU64::new(0));
    let disconnected = Arc::new(AtomicBool::new(false));
    let shutdown = Arc::new(AtomicBool::new(false));
    let initial = ReceiverStatus {
        identity,
        connected: true,
        output_ready: false,
        current_epoch: None,
        preparing_epoch: None,
        network_clock: None,
        output: None,
        buffered_input_frames: 0,
        played_frame: 0,
        underrun_frames: 0,
        discarded_blocks: 0,
        last_error: None,
    };
    let (status_tx, status_rx) = watch::channel(initial);
    let (done_tx, done_rx) = watch::channel(false);
    let handle = ReceiverHandle {
        commands,
        trip: Arc::clone(&trip),
        invalidated: Arc::clone(&invalidated),
        generation: Arc::clone(&generation),
        disconnected: Arc::clone(&disconnected),
        budget: Arc::clone(&budget),
        status: status_rx,
        done: done_rx,
        _lease: Arc::new(Lease(Arc::clone(&shutdown))),
    };
    let (initialized, init_rx) = oneshot::channel();
    std::thread::Builder::new()
        .name("lan-presentation".into())
        .spawn(move || {
            // Declared before the engine, therefore dropped after CPAL on
            // normal return and unwinding alike.
            let _done = WorkerDone(done_tx);
            let output = match ScheduledOutput::open(options) {
                Ok(output) => output,
                Err(error) => {
                    let _ = initialized.send(Err(ReceiverError::Output(error.to_string())));
                    return;
                }
            };
            let mut engine = Engine::new(output, identity, budget);
            if initialized.send(Ok(())).is_err() {
                return;
            }
            let mut last_status = 0;
            let mut active_generation = 0;
            while !shutdown.load(Ordering::Acquire) {
                let mut outgoing = Vec::new();
                if disconnected.load(Ordering::Acquire) && engine.connected {
                    engine.connected = false;
                    engine.fail("session disconnected", &mut outgoing);
                }
                if trip.swap(false, Ordering::AcqRel) {
                    engine.fail("receiver ingress backpressure", &mut outgoing);
                    active_generation = generation.load(Ordering::Acquire);
                }
                if invalidated.swap(false, Ordering::AcqRel) {
                    engine.fail(
                        "receiver invalidated; fresh future join required",
                        &mut outgoing,
                    );
                    active_generation = generation.load(Ordering::Acquire);
                }
                for _ in 0..8 {
                    if disconnected.load(Ordering::Acquire)
                        || trip.load(Ordering::Acquire)
                        || invalidated.load(Ordering::Acquire)
                    {
                        break;
                    }
                    let Ok(envelope) = inbox.try_recv() else {
                        break;
                    };
                    if envelope.generation != active_generation {
                        continue;
                    }
                    let command = envelope.command;
                    match command {
                        Command::Reopen(mut options) => {
                            engine
                                .fail("output device reopened; fresh join required", &mut outgoing);
                            options.clock_origin = clock.origin();
                            // Drop old CPAL stream before opening the new device.
                            engine.output.take();
                            match ScheduledOutput::open(options) {
                                Ok(mut output) => {
                                    output.mute();
                                    let _ = output.set_local_volume(engine.volume);
                                    engine.output = Some(output);
                                }
                                Err(error) => engine.last_error = Some(error.to_string()),
                            }
                        }
                        command => engine.command(clock.now_ns(), command, &mut outgoing),
                    }
                }
                let now = clock.now_ns();
                engine.tick(now, &mut outgoing);
                let status = engine.status(now);
                status_tx.send_replace(status.clone());
                if now.saturating_sub(last_status) >= 250_000_000 {
                    // Status is lossy and coalesced in watch. Protocol actions are
                    // not lossy: failure to deliver one revokes audio authorization.
                    let _ = events.try_send(ReceiverEvent::Status(status));
                    last_status = now;
                }
                for event in outgoing {
                    if events.try_send(event).is_err() {
                        engine.fail("receiver event consumer stalled", &mut Vec::new());
                        engine.connected = false;
                        status_tx.send_replace(engine.status(now));
                        break;
                    }
                }
                if !engine.connected {
                    break;
                }
                std::thread::sleep(TICK);
            }
            if let Some(output) = engine.output.as_mut() {
                output.mute();
            }
            drop(engine);
        })
        .map_err(|error| ReceiverError::Output(error.to_string()))?;
    init_rx.await.map_err(|_| ReceiverError::Closed)??;
    Ok((handle, event_rx))
}

fn validate_options(options: &OutputOptions) -> Result<(), ReceiverError> {
    if !(1..=2).contains(&options.channels)
        || !(8_000..=192_000).contains(&options.preferred_rate)
        || options
            .device_id
            .as_ref()
            .is_some_and(|name| name.len() > 512)
    {
        return Err(ReceiverError::Invalid("output format/device"));
    }
    Ok(())
}

fn validate_block(block: &PcmBlock) -> Result<(), ReceiverError> {
    if !(1..=2).contains(&block.channels)
        || !block
            .samples
            .len()
            .is_multiple_of(usize::from(block.channels))
        || block.format_id == 0
        || block
            .frame_index
            .checked_add(u64::from(block.frame_count()))
            .is_none()
        || block.samples.iter().any(|s| !s.is_finite())
        || validate_payload(block.frame_count(), block.channels, block.samples.len() * 4).is_err()
    {
        return Err(ReceiverError::Invalid("PCM block"));
    }
    Ok(())
}

/// Tiny native adapter boundary, also used by the deterministic end-to-end
/// tests with the production ScheduledPcmQueue and PresentationConsumer.
trait DeviceOutput {
    fn format(&self) -> RenderFormat;
    fn telemetry(&self) -> OutputTelemetry;
    fn write(&mut self, start: u64, samples: &[f32], now: u64) -> Result<(), OutputError>;
    fn mute(&mut self);
    fn unmute(&mut self);
    fn volume(&mut self, volume: f32) -> Result<(), OutputError>;
}

impl DeviceOutput for ScheduledOutput {
    fn format(&self) -> RenderFormat {
        self.format()
    }
    fn telemetry(&self) -> OutputTelemetry {
        self.telemetry()
    }
    fn write(&mut self, start: u64, samples: &[f32], _now: u64) -> Result<(), OutputError> {
        self.write(start, samples)
    }
    fn mute(&mut self) {
        self.mute();
    }
    fn unmute(&mut self) {
        self.unmute();
    }
    fn volume(&mut self, volume: f32) -> Result<(), OutputError> {
        self.set_local_volume(volume)
    }
}

struct Epoch {
    plan: Plan,
    local_anchor: u64,
    start: u64,
    ready: bool,
    committed: bool,
    expected_frame: u64,
    sequence: Option<u64>,
    pcm: VecDeque<Pcm>,
    converter: ClockedConverter,
    // Once a continuous run starts this remains the output sample grid. The
    // source packet's nominal timestamp is never used as a new run boundary.
    output_frames: u64,
    drain: bool,
    played_baseline: Option<u64>,
}

impl Epoch {
    fn new(plan: Plan, mapping: ClockMapping, output: RenderFormat) -> Result<Self, &'static str> {
        plan.format.validate().map_err(|_| "invalid plan format")?;
        let host_start = frame_time(plan.anchor_ns.0, plan.join_frame.0, plan.format.sample_rate)
            .ok_or("plan time overflow")?;
        let local_anchor = mapping
            .local_time(plan.anchor_ns.0)
            .ok_or("plan anchor outside local domain")?;
        let start = mapping
            .local_time(host_start)
            .ok_or("plan start outside local domain")?;
        let converter = ClockedConverter::new(
            plan.format.sample_rate,
            output.sample_rate,
            usize::from(output.channels),
        )
        .map_err(|_| "unsupported conversion")?;
        Ok(Self {
            expected_frame: plan.join_frame.0,
            plan,
            local_anchor,
            start,
            ready: false,
            committed: false,
            sequence: None,
            pcm: VecDeque::new(),
            converter,
            output_frames: 0,
            drain: false,
            played_baseline: None,
        })
    }

    fn next_time(&self, rate: u32) -> Result<u64, &'static str> {
        frame_time(self.start, self.output_frames, rate).ok_or("output cursor overflow")
    }

    fn submit<D: DeviceOutput>(
        &mut self,
        output: &mut D,
        mapping: ClockMapping,
        now: u64,
        horizon: u64,
    ) -> Result<(), String> {
        if !self.committed {
            return Ok(());
        }
        let format = output.format();
        let telemetry = output.telemetry();
        let combined = relative_drift_ppm(mapping.drift_ppm, telemetry.device_clock_ppm)
            .ok_or("relative device/network clock drift is unsupported")?;
        self.converter.set_drift_ppm(combined);
        let channels = usize::from(format.channels);
        let mut input = Vec::with_capacity(1024 * channels);
        let mut samples = vec![0.0; 2048 * channels];
        // Bound worker work per tick even when ingress is continuously full.
        for _ in 0..8 {
            let start = self.next_time(format.sample_rate)?;
            if start >= horizon {
                break;
            }
            let frames = ((u128::from(horizon - start) * u128::from(format.sample_rate)
                / 1_000_000_000) as usize)
                .min(2048);
            if frames == 0 {
                break;
            }
            input.clear();
            if !self.drain {
                if let Some(front) = self.pcm.front_mut() {
                    let block = &front.block;
                    let count = (block.frame_count() as usize - front.offset_frames).min(1024);
                    let source_channels = usize::from(block.channels);
                    for frame in block
                        .samples
                        .chunks_exact(source_channels)
                        .skip(front.offset_frames)
                        .take(count)
                    {
                        match (source_channels, channels) {
                            (1, 2) => input.extend_from_slice(&[frame[0], frame[0]]),
                            (2, 1) => input.push((frame[0] + frame[1]) * 0.5),
                            _ => input.extend_from_slice(frame),
                        }
                    }
                    front.offset_frames += count;
                    if front.offset_frames == block.frame_count() as usize {
                        self.pcm.pop_front();
                    }
                }
            }
            let progress = self
                .converter
                .process(&input, &mut samples[..frames * channels])
                .map_err(|error| error.to_string())?;
            self.drain = progress.state == ConvertState::NeedOutput;
            if progress.produced_frames > 0 {
                if output.telemetry().muted {
                    // Only an accepted Commit reaches here. The queue's
                    // deadlines keep this unmute silent until the future join.
                    output.unmute();
                }
                if self.played_baseline.is_none() {
                    let t = output.telemetry();
                    self.played_baseline =
                        Some(t.played_frames.saturating_add(t.queued_frames as u64));
                }
                output
                    .write(start, &samples[..progress.produced_frames * channels], now)
                    .map_err(|error| error.to_string())?;
                self.output_frames = self
                    .output_frames
                    .checked_add(progress.produced_frames as u64)
                    .ok_or("output frame counter overflow")?;
            }
            if progress.produced_frames == 0 && input.is_empty() {
                break;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    use vmusic_audio::scheduled_output::{
        PresentationConsumer, PresentationTime, ScheduledPcmQueue,
    };
    use vmusic_lan::protocol::{AudioFormat, Counter};

    const MS: u64 = 1_000_000;

    struct FakeOutput {
        queue: ScheduledPcmQueue,
        consumer: PresentationConsumer,
        now: u64,
        valid: bool,
        ppm: f64,
    }

    impl FakeOutput {
        fn new(rate: u32) -> Self {
            let (queue, consumer) = ScheduledPcmQueue::new(RenderFormat {
                sample_rate: rate,
                channels: 2,
            })
            .unwrap();
            Self {
                queue,
                consumer,
                now: 0,
                valid: true,
                ppm: 0.0,
            }
        }

        fn render(&mut self, at: u64, frames: usize) -> Vec<f32> {
            let mut samples = vec![f32::NAN; frames * 2];
            self.consumer.render(
                &mut samples,
                self.valid.then_some(PresentationTime {
                    first_frame_local_ns: at,
                    ns_per_frame: 1e9
                        / (f64::from(self.queue.format().sample_rate) * (1.0 + self.ppm * 1e-6)),
                }),
            );
            samples
        }
    }

    impl DeviceOutput for FakeOutput {
        fn format(&self) -> RenderFormat {
            self.queue.format()
        }
        fn telemetry(&self) -> OutputTelemetry {
            let mut t = self.queue.telemetry();
            t.clock_status = if self.valid {
                ClockStatus::Valid
            } else {
                ClockStatus::Invalid
            };
            t.last_callback_local_ns = Some(self.now);
            t.last_presentation_local_ns = Some(self.now + 20 * MS);
            t.device_clock_ppm = self.ppm;
            t.ns_per_frame = 1e9 / (f64::from(self.format().sample_rate) * (1.0 + self.ppm * 1e-6));
            t
        }
        fn write(&mut self, start: u64, samples: &[f32], now: u64) -> Result<(), OutputError> {
            self.queue.write_at(start, samples, now)
        }
        fn mute(&mut self) {
            self.queue.mute();
        }
        fn unmute(&mut self) {
            self.queue.unmute();
        }
        fn volume(&mut self, volume: f32) -> Result<(), OutputError> {
            self.queue.set_local_volume(volume)
        }
    }

    fn identity() -> StreamIdentity {
        StreamIdentity {
            room_id: Uuid::from_u128(1),
            instance_id: Uuid::from_u128(2),
            session_id: Uuid::from_u128((1u128 << 64) | 7),
        }
    }

    fn mapping(now: u64, ppm: f64) -> ClockMapping {
        ClockMapping {
            reference_local_ns: now,
            offset_ns: 0,
            drift_ppm: ppm,
            uncertainty_ns: 100_000,
            min_rtt_ns: 200_000,
            samples: 8,
            residual_mad_ns: 0,
            observation_span_ns: 2_000_000_000,
        }
    }

    fn plan(epoch: u64, id: u64, anchor: u64, join: u64) -> Plan {
        Plan {
            epoch: Counter(epoch),
            plan_id: Counter(id),
            anchor_ns: Counter(anchor),
            join_frame: Counter(join),
            format: AudioFormat {
                id: 3,
                sample_rate: 44_100,
                channels: 1,
            },
        }
    }

    fn engine() -> Engine<FakeOutput> {
        let mut engine = Engine::new(
            FakeOutput::new(48_000),
            identity(),
            Arc::new(Budget::default()),
        );
        engine.command(0, Command::Mapping(mapping(0, 0.0)), &mut Vec::new());
        engine
    }

    fn pcm(
        engine: &Engine<FakeOutput>,
        epoch: u64,
        sequence: u64,
        frame: u64,
        frames: usize,
    ) -> Pcm {
        let block = PcmBlock {
            identity: identity(),
            epoch,
            sequence,
            frame_index: frame,
            format_id: 3,
            channels: 1,
            samples: vec![0.5; frames].into(),
        };
        validate_block(&block).unwrap();
        let reservation = Reservation::acquire(&engine.budget, &block).unwrap();
        Pcm {
            block,
            offset_frames: 0,
            _reservation: reservation,
        }
    }

    fn feed(engine: &mut Engine<FakeOutput>, epoch: u64, first: u64, frames: usize) {
        let mut offset = 0;
        let mut sequence = 9;
        while offset < frames {
            let count = (frames - offset).min(4096);
            let block = pcm(engine, epoch, sequence, first + offset as u64, count);
            engine.command(0, Command::Pcm(block), &mut Vec::new());
            offset += count;
            sequence += 1;
        }
    }

    fn prepare(engine: &mut Engine<FakeOutput>, plan: Plan) -> Vec<ReceiverEvent> {
        let mut events = Vec::new();
        engine.command(0, Command::Prepare(identity(), plan), &mut events);
        events
    }

    fn commit(engine: &mut Engine<FakeOutput>, now: u64, plan: &Plan) -> Vec<ReceiverEvent> {
        let mut events = Vec::new();
        engine.output.as_mut().unwrap().now = now;
        engine.command(
            now,
            Command::Commit {
                identity: identity(),
                epoch: plan.epoch.0,
                plan_id: plan.plan_id.0,
                effective_at: frame_time(
                    plan.anchor_ns.0,
                    plan.join_frame.0,
                    plan.format.sample_rate,
                )
                .unwrap(),
            },
            &mut events,
        );
        events
    }

    fn tick(engine: &mut Engine<FakeOutput>, now: u64) -> Vec<ReceiverEvent> {
        engine.output.as_mut().unwrap().now = now;
        let mut events = Vec::new();
        engine.tick(now, &mut events);
        events
    }

    #[test]
    fn ready_never_authorizes_audio_without_commit() {
        let mut engine = engine();
        let events = prepare(&mut engine, plan(1, 10, 400 * MS, 0));
        assert!(matches!(
            events.as_slice(),
            [ReceiverEvent::Ready {
                epoch: 1,
                plan_id: 10
            }]
        ));
        feed(&mut engine, 1, 0, 22_050);
        tick(&mut engine, 200 * MS);
        assert!(engine.output.as_ref().unwrap().telemetry().muted);
        assert_eq!(engine.output.as_ref().unwrap().telemetry().queued_frames, 0);
        assert!(engine
            .output
            .as_mut()
            .unwrap()
            .render(400 * MS, 480)
            .iter()
            .all(|s| *s == 0.0));
        assert_eq!(engine.gate.current_epoch(), None);
    }

    #[test]
    fn accepted_commit_prequeues_but_callback_waits_for_presentation_boundary() {
        let mut engine = engine();
        let plan = plan(1, 10, 400 * MS, 0);
        prepare(&mut engine, plan.clone());
        feed(&mut engine, 1, 0, 30_000);
        assert!(commit(&mut engine, 0, &plan).is_empty());
        let mut heard = false;
        for millis in (0..=700).step_by(10) {
            let now = millis * MS;
            assert!(tick(&mut engine, now).is_empty(), "{:?}", engine.last_error);
            if now == 350 * MS {
                assert!(engine.output.as_ref().unwrap().telemetry().queued_frames > 0);
                assert_eq!(
                    engine.gate.current_epoch(),
                    None,
                    "prequeue must not advance gate into the future"
                );
            }
            let at = now + 20 * MS;
            let output = engine.output.as_mut().unwrap().render(at, 480);
            if at < 400 * MS {
                assert!(output.iter().all(|s| *s == 0.0));
            }
            if at > 420 * MS {
                heard |= output.iter().any(|s| *s > 0.4);
            }
        }
        assert!(heard);
        assert_eq!(engine.gate.current_epoch(), Some(1));
        assert!(engine.output.as_ref().unwrap().telemetry().played_frames > 10_000);
    }

    #[test]
    fn late_join_matches_early_pcm_and_trims_only_the_prejoin_prefix() {
        let mut engine = engine();
        // Broadcast reaches the endpoint before its Prepare. Sequence 50 is
        // arbitrary and the first block straddles the eventual join boundary.
        let first = pcm(&engine, 7, 50, 17_000, 4096);
        engine.command(0, Command::Pcm(first), &mut Vec::new());
        assert_eq!(engine.unmatched.len(), 1);
        let plan = plan(7, 100, 0, 17_640); // 400ms
        assert!(matches!(
            prepare(&mut engine, plan.clone()).as_slice(),
            [ReceiverEvent::Ready { .. }]
        ));
        let preparing = engine.preparing.as_ref().unwrap();
        assert_eq!(preparing.sequence, Some(50));
        assert_eq!(preparing.expected_frame, 21_096);
        assert_eq!(preparing.pcm.front().unwrap().offset_frames, 640);
        let old = pcm(&engine, 7, 49, 0, 4096);
        engine.command(0, Command::Pcm(old), &mut Vec::new());
        assert_eq!(engine.preparing.as_ref().unwrap().sequence, Some(50));
        assert!(commit(&mut engine, 0, &plan).is_empty());
        tick(&mut engine, 350 * MS);
        assert!(engine.output.as_ref().unwrap().telemetry().queued_frames > 0);
    }

    #[test]
    fn uuid_collision_reordered_trailing_and_wrong_format_never_change_cursor() {
        let mut engine = engine();
        prepare(&mut engine, plan(1, 10, 400 * MS, 0));
        let mut wrong = pcm(&engine, 1, 1, 0, 1000);
        wrong.block.identity.session_id = Uuid::from_u128((2u128 << 64) | 7);
        engine.command(0, Command::Pcm(wrong), &mut Vec::new());
        assert_eq!(engine.preparing.as_ref().unwrap().expected_frame, 0);
        let good = pcm(&engine, 1, 1, 0, 1000);
        engine.command(0, Command::Pcm(good), &mut Vec::new());
        for (sequence, frame, format) in [(1, 0, 3), (0, 1000, 3), (2, 1000, 4)] {
            let mut wrong = pcm(&engine, 1, sequence, frame, 1000);
            wrong.block.format_id = format;
            engine.command(0, Command::Pcm(wrong), &mut Vec::new());
        }
        assert_eq!(engine.preparing.as_ref().unwrap().expected_frame, 1000);
        assert_eq!(engine.discarded, 4);
    }

    #[test]
    fn gap_mutes_clears_and_requires_a_new_monotonic_join_token() {
        let mut engine = engine();
        let original = plan(1, 10, 400 * MS, 0);
        prepare(&mut engine, original.clone());
        let first = pcm(&engine, 1, 1, 0, 4096);
        engine.command(0, Command::Pcm(first), &mut Vec::new());
        commit(&mut engine, 0, &original);
        tick(&mut engine, 350 * MS);
        assert!(engine.output.as_ref().unwrap().telemetry().queued_frames > 0);
        let missing = pcm(&engine, 1, 3, 4096, 1000);
        let mut events = Vec::new();
        engine.command(350 * MS, Command::Pcm(missing), &mut events);
        assert!(matches!(events.as_slice(), [ReceiverEvent::Resync { .. }]));
        assert!(engine.output.as_ref().unwrap().telemetry().muted);
        assert_eq!(engine.output.as_ref().unwrap().telemetry().queued_frames, 0);
        assert_eq!(engine.budget.frames.load(Ordering::Acquire), 0);
        prepare(&mut engine, original);
        assert!(engine.preparing.is_none(), "old plan cannot revive");
        // Same media epoch, immutable anchor/format, increasing future join.
        let rejoin = plan(1, 11, 400 * MS, 22_050);
        let mut events = Vec::new();
        engine.command(350 * MS, Command::Prepare(identity(), rejoin), &mut events);
        assert!(matches!(
            events.as_slice(),
            [ReceiverEvent::Ready { plan_id: 11, .. }]
        ));
        assert_eq!(engine.preparing.as_ref().unwrap().start, 900 * MS);
    }

    #[test]
    fn missing_fresh_clock_and_expired_commit_cannot_unmute() {
        for case in 0..3 {
            let mut engine = engine();
            let original = plan(1, 10, 400 * MS, 0);
            prepare(&mut engine, original.clone());
            feed(&mut engine, 1, 0, 10_000);
            let events = match case {
                0 => commit(&mut engine, 260 * MS, &original), // equality is late
                1 => {
                    commit(&mut engine, 0, &original);
                    engine.output.as_mut().unwrap().valid = false;
                    tick(&mut engine, MS)
                }
                _ => {
                    commit(&mut engine, 0, &original);
                    tick(&mut engine, 3_000 * MS + 1)
                }
            };
            assert!(events
                .iter()
                .any(|event| matches!(event, ReceiverEvent::Resync { .. })));
            assert!(engine.output.as_ref().unwrap().telemetry().muted);
            assert!(engine.preparing.is_none());
            assert!(commit(&mut engine, 0, &original).is_empty());
            assert!(engine.preparing.is_none());
        }
    }

    #[test]
    fn commit_cannot_move_the_plan_boundary_and_third_epoch_has_no_pcm() {
        let mut engine = engine();
        let first = plan(1, 10, 400 * MS, 0);
        prepare(&mut engine, first.clone());
        let mut events = Vec::new();
        engine.command(
            0,
            Command::Commit {
                identity: identity(),
                epoch: 1,
                plan_id: 10,
                effective_at: 401 * MS,
            },
            &mut events,
        );
        assert!(events
            .iter()
            .any(|e| matches!(e, ReceiverEvent::Resync { .. })));
        let first = plan(1, 11, 400 * MS, 0);
        prepare(&mut engine, first.clone());
        commit(&mut engine, 0, &first);
        prepare(&mut engine, plan(2, 12, 800 * MS, 0));
        let block = pcm(&engine, 2, 1, 0, 1000);
        engine.command(0, Command::Pcm(block), &mut Vec::new());
        assert_eq!(engine.intent.as_ref().unwrap().epoch.0, 2);
        assert_eq!(engine.preparing.as_ref().unwrap().plan.epoch.0, 1);
        assert!(engine.unmatched.is_empty());
        assert_eq!(engine.budget.frames.load(Ordering::Acquire), 0);
    }

    #[test]
    fn input_budget_includes_pending_commands_and_releases_on_drop() {
        let mut engine = engine();
        let mut pending = Vec::new();
        for sequence in 0..5 {
            pending.push(pcm(&engine, 1, sequence, sequence * 16_000, 16_000));
        }
        let block = PcmBlock {
            identity: identity(),
            epoch: 1,
            sequence: 6,
            frame_index: 80_000,
            format_id: 3,
            channels: 1,
            samples: vec![0.0; 16_000].into(),
        };
        assert!(matches!(
            Reservation::acquire(&engine.budget, &block),
            Err(ReceiverError::Capacity)
        ));
        assert_eq!(engine.budget.frames.load(Ordering::Acquire), 80_000);
        drop(pending);
        assert_eq!(engine.budget.frames.load(Ordering::Acquire), 0);
        let waiting = pcm(&engine, 1, 0, 0, 1000);
        engine.command(0, Command::Pcm(waiting), &mut Vec::new());
        assert!(tick(&mut engine, 501 * MS)
            .iter()
            .any(|event| matches!(event, ReceiverEvent::Resync { .. })));
        assert_eq!(engine.budget.frames.load(Ordering::Acquire), 0);
    }

    #[test]
    fn device_positive_ppm_reduces_input_per_output_and_packet_grid_stays_continuous() {
        assert!(relative_drift_ppm(0.0, 500.0).unwrap() < 0.0);
        assert!(relative_drift_ppm(500.0, 0.0).unwrap() > 0.0);
        let expected = ((1.0 + 300.0e-6) / (1.0 + 500.0e-6) - 1.0) * 1e6;
        assert!((relative_drift_ppm(300.0, 500.0).unwrap() - expected).abs() < 1e-9);
        let mut engine = engine();
        let first = plan(1, 10, 400 * MS, 0);
        prepare(&mut engine, first.clone());
        feed(&mut engine, 1, 0, 30_000);
        commit(&mut engine, 0, &first);
        tick(&mut engine, 350 * MS);
        let epoch = engine.preparing.as_ref().unwrap();
        assert!(epoch.output_frames > 0);
        assert_eq!(
            epoch.next_time(48_000).unwrap(),
            400 * MS + epoch.output_frames * 1_000_000_000 / 48_000
        );
        engine.command(
            350 * MS,
            Command::Mapping(mapping(350 * MS, 300.0)),
            &mut Vec::new(),
        );
        engine.output.as_mut().unwrap().ppm = 500.0;
        tick(&mut engine, 370 * MS);
        let epoch = engine.preparing.as_ref().unwrap();
        assert_eq!(
            epoch.next_time(48_000).unwrap(),
            400 * MS + epoch.output_frames * 1_000_000_000 / 48_000
        );
        assert!(engine.last_error.is_none());
    }

    #[test]
    fn converting_different_wire_packet_sizes_produces_identical_continuous_audio() {
        fn run(packet_frames: usize, device_ppm: f64) -> (Vec<f32>, u64) {
            let mut engine = engine();
            let plan = plan(1, 10, 400 * MS, 0);
            prepare(&mut engine, plan.clone());
            let total = 30_000;
            for (sequence, first) in (0..total).step_by(packet_frames).enumerate() {
                let block = pcm(
                    &engine,
                    1,
                    sequence as u64,
                    first as u64,
                    (total - first).min(packet_frames),
                );
                engine.command(0, Command::Pcm(block), &mut Vec::new());
            }
            commit(&mut engine, 0, &plan);
            let output = engine.output.as_mut().unwrap();
            output.ppm = device_ppm;
            let epoch = engine.preparing.as_mut().unwrap();
            for _ in 0..64 {
                epoch.submit(output, mapping(0, 0.0), 0, 1500 * MS).unwrap();
            }
            let frames = epoch.output_frames;
            // Production consumer reads the submitted continuous run. Changes
            // to the wire packet boundaries may not create new timing grids.
            (output.render(400 * MS, frames as usize), frames)
        }
        let (small, small_count) = run(137, 500.0);
        let (large, large_count) = run(4096, 500.0);
        assert_eq!(small_count, large_count);
        assert_eq!(small, large);
        assert!(small
            .iter()
            .skip(1024)
            .all(|sample| *sample > 0.49 && *sample < 0.51));
        let (_, nominal_count) = run(4096, 0.0);
        assert!(
            large_count > nominal_count,
            "a fast device must receive more output frames for the same source span"
        );
    }
}

fn frame_time(anchor: u64, frame: u64, rate: u32) -> Option<u64> {
    if rate == 0 {
        return None;
    }
    anchor.checked_add(u64::try_from(u128::from(frame) * 1_000_000_000 / u128::from(rate)).ok()?)
}

fn relative_drift_ppm(host: f64, device: f64) -> Option<f64> {
    let ppm = ((1.0 + host * 1e-6) / (1.0 + device * 1e-6) - 1.0) * 1e6;
    (host.is_finite() && device.is_finite() && ppm.is_finite() && ppm.abs() <= 5000.0)
        .then_some(ppm)
}

struct Engine<D: DeviceOutput> {
    output: Option<D>,
    identity: StreamIdentity,
    budget: Arc<Budget>,
    connected: bool,
    mapping: Option<ClockMapping>,
    gate: ReceiverGate,
    current: Option<Epoch>,
    preparing: Option<Epoch>,
    intent: Option<Plan>,
    /// Applied epochs never move backwards, while per-endpoint rejoin tokens
    /// may replace the same epoch without changing the room's media epoch.
    epoch_floor: u64,
    latest_plan_id: Option<u64>,
    contracts: VecDeque<(u64, u64, AudioFormat, u64)>,
    unmatched: VecDeque<(u64, Pcm)>,
    volume: f32,
    last_error: Option<String>,
    discarded: u64,
    previous_underrun: u64,
    previous_late: u64,
    played_frame: u64,
}

impl<D: DeviceOutput> Engine<D> {
    fn new(mut output: D, identity: StreamIdentity, budget: Arc<Budget>) -> Self {
        output.mute();
        let mut gate = ReceiverGate::new(SUBMIT_MARGIN_NS, 500_000_000, INPUT_FRAME_LIMIT as u32);
        gate.input(
            0,
            GateInput::Rebind {
                session: GATE_SESSION,
            },
        );
        Self {
            output: Some(output),
            identity,
            budget,
            connected: true,
            mapping: None,
            gate,
            current: None,
            preparing: None,
            intent: None,
            epoch_floor: 0,
            latest_plan_id: None,
            contracts: VecDeque::new(),
            unmatched: VecDeque::new(),
            volume: 1.0,
            last_error: None,
            discarded: 0,
            previous_underrun: 0,
            previous_late: 0,
            played_frame: 0,
        }
    }

    fn fail(&mut self, reason: &str, events: &mut Vec<ReceiverEvent>) {
        if let Some(output) = self.output.as_mut() {
            output.mute();
        }
        self.current = None;
        self.preparing = None;
        self.intent = None;
        self.unmatched.clear();
        self.gate.input(
            0,
            GateInput::Rebind {
                session: GATE_SESSION,
            },
        );
        self.last_error = Some(reason.into());
        events.push(ReceiverEvent::Resync {
            reason: reason.into(),
        });
    }

    fn output_ready(&self, now: u64) -> bool {
        self.connected
            && self
                .device_lead()
                .is_some_and(|lead| lead <= MAX_DEVICE_LEAD_NS)
            && self.mapping.is_some_and(|mapping| mapping.valid_at(now))
            && self.output.as_ref().is_some_and(|output| {
                let t = output.telemetry();
                t.clock_status == ClockStatus::Valid
                    && !t.device_error
                    && t.device_clock_ppm.is_finite()
                    && t.ns_per_frame.is_finite()
                    && t.last_presentation_local_ns.is_some_and(|presentation| {
                        presentation <= now.saturating_add(3_000_000_000)
                    })
                    && t.last_callback_local_ns.is_some_and(|seen| {
                        seen <= now.saturating_add(2_000_000)
                            && now.saturating_sub(seen) <= DEVICE_FRESHNESS_NS
                    })
            })
    }

    fn device_lead(&self) -> Option<u64> {
        self.output.as_ref().and_then(|o| {
            let t = o.telemetry();
            Some(
                t.last_presentation_local_ns?
                    .saturating_sub(t.last_callback_local_ns?),
            )
        })
    }

    fn lead(&self, _now: u64) -> u64 {
        self.device_lead()
            .unwrap_or(0)
            .saturating_add(HORIZON_NS + SUBMIT_MARGIN_NS)
    }

    fn command(&mut self, now: u64, command: Command, events: &mut Vec<ReceiverEvent>) {
        match command {
            Command::Volume(volume) => {
                self.volume = volume;
                if let Some(output) = self.output.as_mut() {
                    if let Err(error) = output.volume(volume) {
                        self.fail(&error.to_string(), events);
                    }
                }
            }
            Command::Mapping(mapping) if self.connected => {
                // A phase step cannot be hidden inside a resampler ratio update.
                if let Some(previous) = self.mapping {
                    let step = previous
                        .host_time(now)
                        .zip(mapping.host_time(now))
                        .map(|(a, b)| a.abs_diff(b))
                        .unwrap_or(u64::MAX);
                    if step > 3_000_000 && (self.current.is_some() || self.preparing.is_some()) {
                        self.fail("network clock discontinuity", events);
                    }
                }
                self.mapping = Some(mapping);
            }
            Command::Prepare(identity, plan) if self.connected && identity == self.identity => {
                self.prepare(now, plan, events)
            }
            Command::Commit {
                identity,
                epoch,
                plan_id,
                effective_at,
            } if self.connected && identity == self.identity => {
                self.commit(now, epoch, plan_id, effective_at, events);
            }
            Command::Pcm(pcm) if self.connected && pcm.block.identity == self.identity => {
                self.pcm(now, pcm, events)
            }
            Command::Pcm(_) => self.discarded += 1,
            _ => {}
        }
    }

    fn prepare(&mut self, now: u64, plan: Plan, events: &mut Vec<ReceiverEvent>) {
        if plan.epoch.0 < self.epoch_floor {
            return;
        }
        let existing = [&self.current, &self.preparing]
            .into_iter()
            .flatten()
            .find(|p| p.plan.plan_id == plan.plan_id)
            .map(|p| p.plan == plan);
        if let Some(unchanged) = existing {
            if !unchanged {
                self.fail("immutable prepared plan changed", events);
            }
            return;
        }
        if let Some(intent) = self.intent.as_ref().filter(|p| p.plan_id == plan.plan_id) {
            if intent != &plan {
                self.fail("immutable intended plan changed", events);
            }
            return;
        }
        if self.latest_plan_id.is_some_and(|id| plan.plan_id.0 <= id) {
            return;
        }
        if plan.format.validate().is_err() {
            self.fail("invalid plan format", events);
            return;
        }
        if let Some((_, anchor, format, join)) = self
            .contracts
            .iter_mut()
            .find(|(epoch, ..)| *epoch == plan.epoch.0)
        {
            if *anchor != plan.anchor_ns.0 || *format != plan.format || plan.join_frame.0 < *join {
                self.fail(
                    "same-epoch rejoin changed its anchor/format or moved backwards",
                    events,
                );
                return;
            }
            *join = plan.join_frame.0;
        } else {
            self.contracts.push_back((
                plan.epoch.0,
                plan.anchor_ns.0,
                plan.format,
                plan.join_frame.0,
            ));
            while self.contracts.len() > 4 {
                self.contracts.pop_front();
            }
        }
        self.latest_plan_id = Some(plan.plan_id.0);
        if self.preparing.as_ref().is_some_and(|p| p.committed) {
            // Only the newest third intent survives; it receives neither PCM
            // nor Ready until the committed preparation actually switches.
            self.intent = Some(plan);
            return;
        }
        self.install_plan(now, plan, events);
    }

    fn install_plan(&mut self, now: u64, plan: Plan, events: &mut Vec<ReceiverEvent>) {
        // A new token for the current media epoch is a per-endpoint future
        // rejoin. Its old samples and authorization must not cross the join.
        if self
            .current
            .as_ref()
            .is_some_and(|p| p.plan.epoch == plan.epoch)
        {
            if let Some(output) = self.output.as_mut() {
                output.mute();
            }
            self.current = None;
            self.preparing = None;
            self.gate.input(
                now,
                GateInput::Rebind {
                    session: GATE_SESSION,
                },
            );
        }
        let Some(mapping) = self.mapping.filter(|m| m.valid_at(now)) else {
            self.last_error = Some("clock not ready; resend a future plan".into());
            events.push(ReceiverEvent::Resync {
                reason: "clock not ready; resend a future plan".into(),
            });
            return;
        };
        let Some(output) = &self.output else {
            return;
        };
        match Epoch::new(plan, mapping, output.format()) {
            Ok(epoch)
                if epoch.start > now.saturating_add(self.lead(now))
                    && epoch.start <= now.saturating_add(3_000_000_000) =>
            {
                self.preparing.take();
                self.preparing = Some(epoch);
                let unmatched = std::mem::take(&mut self.unmatched);
                for (arrived, pcm) in unmatched {
                    if now.saturating_sub(arrived) <= 500_000_000 {
                        self.pcm(now, pcm, events);
                    } else {
                        self.fail("PCM arrived before an expired format/plan match", events);
                        return;
                    }
                }
                self.ready(now, events);
            }
            Ok(_) => self.fail("prepared join is past device submission deadline", events),
            Err(reason) => self.fail(reason, events),
        }
    }

    fn ready(&mut self, now: u64, events: &mut Vec<ReceiverEvent>) {
        if !self.output_ready(now) {
            return;
        }
        let lead = self.lead(now);
        let Some(epoch) = self.preparing.as_mut().filter(|p| !p.ready) else {
            return;
        };
        if epoch.start <= now.saturating_add(lead) {
            self.fail("clock became ready after plan submission deadline", events);
            return;
        }
        let plan = &epoch.plan;
        self.gate.input(
            now,
            GateInput::Format {
                session: GATE_SESSION,
                epoch: plan.epoch.0,
                format: FormatDesc {
                    format_id: plan.format.id,
                    sample_rate: plan.format.sample_rate,
                    channels: plan.format.channels as u8,
                },
            },
        );
        let actions = self.gate.input(
            now,
            GateInput::Plan {
                session: GATE_SESSION,
                plan: PlanDesc {
                    epoch: plan.epoch.0,
                    plan_id: plan.plan_id.0,
                    anchor_ns: epoch.local_anchor,
                    join_frame: plan.join_frame.0,
                },
            },
        );
        if actions.iter().any(|action| {
            matches!(
                action,
                GateAction::DiscardPcm { .. } | GateAction::Resync { .. }
            )
        }) {
            self.fail(
                "PCM expired or failed while waiting for plan readiness",
                events,
            );
            return;
        }
        epoch.ready = actions
            .iter()
            .any(|a| matches!(a, GateAction::Ready { .. }));
        if epoch.ready {
            self.last_error = None;
            events.push(ReceiverEvent::Ready {
                epoch: plan.epoch.0,
                plan_id: plan.plan_id.0,
            });
        }
    }

    fn commit(
        &mut self,
        now: u64,
        epoch: u64,
        plan_id: u64,
        effective_at: u64,
        events: &mut Vec<ReceiverEvent>,
    ) {
        let Some(preparing) = self.preparing.as_ref() else {
            return;
        };
        if preparing.plan.epoch.0 != epoch || preparing.plan.plan_id.0 != plan_id {
            return;
        }
        let expected = frame_time(
            preparing.plan.anchor_ns.0,
            preparing.plan.join_frame.0,
            preparing.plan.format.sample_rate,
        );
        if expected != Some(effective_at) {
            self.fail("commit changes the immutable plan join boundary", events);
            return;
        }
        if preparing.committed {
            return;
        }
        if !preparing.ready {
            return;
        }
        if !self.output_ready(now) {
            self.fail("commit arrived without a fresh presentation clock", events);
            return;
        }
        let local = preparing.start;
        if now.saturating_add(self.lead(now)) >= local {
            self.fail("commit arrived past device submission deadline", events);
            return;
        }
        let actions = self.gate.input(
            now,
            GateInput::Commit {
                session: GATE_SESSION,
                epoch,
                plan_id,
                effective_at: local,
            },
        );
        if actions
            .iter()
            .any(|a| matches!(a, GateAction::CommitIgnored { .. }))
        {
            self.fail("receiver gate rejected commit", events);
            return;
        }
        self.preparing.as_mut().unwrap().committed = true;
    }

    fn pcm(&mut self, now: u64, mut pcm: Pcm, events: &mut Vec<ReceiverEvent>) {
        let block = &pcm.block;
        let slot = if self
            .current
            .as_ref()
            .is_some_and(|p| p.plan.epoch.0 == block.epoch)
        {
            self.current.as_mut()
        } else {
            self.preparing
                .as_mut()
                .filter(|p| p.plan.epoch.0 == block.epoch)
        };
        let Some(epoch) = slot else {
            // At most one unknown future epoch can wait for its control frame.
            // A current+preparing pair already owns both PCM slots.
            if self.preparing.is_none()
                && block.epoch >= self.epoch_floor
                && self
                    .current
                    .as_ref()
                    .is_none_or(|p| block.epoch > p.plan.epoch.0)
                && self
                    .unmatched
                    .front()
                    .is_none_or(|(_, p)| p.block.epoch == block.epoch)
            {
                self.unmatched.push_back((now, pcm));
            } else {
                self.discarded += 1;
            }
            return;
        };
        // Broadcast PCM may precede a late join. It carries the media epoch,
        // not a join token. Skip its prefix without establishing sequence state.
        let join = epoch.plan.join_frame.0;
        if block.end_frame() <= join {
            self.discarded += 1;
            return;
        }
        if epoch.sequence.is_none() && block.frame_index < join {
            pcm.offset_frames = (join - block.frame_index) as usize;
        }
        let frame_index = block.frame_index + pcm.offset_frames as u64;
        let frame_count = block.frame_count() - pcm.offset_frames as u32;
        if block.format_id != epoch.plan.format.id
            || block.channels != epoch.plan.format.channels
            || frame_index < epoch.expected_frame
            || epoch
                .sequence
                .is_some_and(|sequence| block.sequence <= sequence)
        {
            self.discarded += 1;
            return;
        }
        if frame_index != epoch.expected_frame
            || epoch
                .sequence
                .is_some_and(|sequence| sequence.checked_add(1) != Some(block.sequence))
        {
            self.discarded += 1;
            self.fail("PCM gap; fresh future join required", events);
            return;
        }
        epoch.expected_frame = block.end_frame();
        epoch.sequence = Some(block.sequence);
        let actions = self.gate.input(
            now,
            GateInput::Pcm {
                session: GATE_SESSION,
                epoch: block.epoch,
                sequence: block.sequence,
                frame_index,
                frame_count,
            },
        );
        if actions
            .iter()
            .any(|a| matches!(a, GateAction::DiscardPcm { .. }))
        {
            self.discarded += 1;
            self.fail("receiver gate discarded PCM", events);
            return;
        }
        epoch.pcm.push_back(pcm);
    }

    fn tick(&mut self, now: u64, events: &mut Vec<ReceiverEvent>) {
        let Some(output) = &self.output else {
            return;
        };
        let telemetry = output.telemetry();
        if self
            .device_lead()
            .is_some_and(|lead| lead > MAX_DEVICE_LEAD_NS)
        {
            if self.last_error.as_deref()
                != Some("device submission lead exceeds 500ms receiver policy")
            {
                self.fail(
                    "device submission lead exceeds 500ms receiver policy",
                    events,
                );
            }
            return;
        }
        if self
            .unmatched
            .front()
            .is_some_and(|(arrived, _)| now.saturating_sub(*arrived) > 500_000_000)
        {
            self.fail("PCM arrived before an expired format/plan match", events);
            return;
        }
        let authorized = self.current.is_some()
            || self
                .preparing
                .as_ref()
                .is_some_and(|p| p.ready || p.committed);
        if authorized && !self.output_ready(now) {
            self.fail(
                "network/device presentation clock unavailable or stale",
                events,
            );
            return;
        }
        if telemetry.device_error {
            if self.last_error.as_deref() != Some("device output failed") {
                self.fail("device output failed", events);
            }
            return;
        }
        let started = [&self.current, &self.preparing]
            .into_iter()
            .flatten()
            .any(|p| p.committed && now >= p.start);
        if started
            && (telemetry.underrun_frames > self.previous_underrun
                || telemetry.late_frames > self.previous_late)
        {
            self.previous_underrun = telemetry.underrun_frames;
            self.previous_late = telemetry.late_frames;
            self.fail("device queue underrun; fresh future join required", events);
            return;
        }
        self.previous_underrun = telemetry.underrun_frames;
        self.previous_late = telemetry.late_frames;
        if self
            .preparing
            .as_ref()
            .is_some_and(|p| !p.committed && now.saturating_add(self.lead(now)) >= p.start)
        {
            self.fail("prepared plan expired without a timely commit", events);
            return;
        }
        self.ready(now, events);
        let actions = self.gate.advance(now);
        if actions.iter().any(|action| {
            matches!(
                action,
                GateAction::Resync { .. } | GateAction::Underrun { .. }
            )
        }) {
            self.fail(
                "presentation source gap; fresh future join required",
                events,
            );
            return;
        }
        if actions
            .iter()
            .any(|a| matches!(a, GateAction::EpochSwitch { .. }))
        {
            self.current = self.preparing.take();
            self.epoch_floor = self
                .current
                .as_ref()
                .map_or(self.epoch_floor, |p| p.plan.epoch.0.max(self.epoch_floor));
            if let Some(plan) = self.intent.take() {
                self.install_plan(now, plan, events);
            }
        }
        if !self.output_ready(now) {
            return;
        }
        let mapping = self.mapping.unwrap();
        let horizon = now
            .saturating_add(self.device_lead().unwrap_or(0))
            .saturating_add(HORIZON_NS);
        let boundary = self
            .preparing
            .as_ref()
            .filter(|p| p.committed)
            .map(|p| p.start)
            .unwrap_or(u64::MAX);
        let output = self.output.as_mut().unwrap();
        let result = (|| {
            if let Some(current) = self.current.as_mut() {
                current.submit(output, mapping, now, horizon.min(boundary))?;
                if let Some(baseline) = current.played_baseline {
                    let frames = output.telemetry().played_frames.saturating_sub(baseline);
                    self.played_frame = current.plan.join_frame.0.saturating_add(
                        (u128::from(frames) * u128::from(current.plan.format.sample_rate)
                            / u128::from(output.format().sample_rate))
                        .min(u128::from(u64::MAX)) as u64,
                    );
                }
            }
            if let Some(preparing) = self.preparing.as_mut() {
                preparing.submit(output, mapping, now, horizon)?;
            }
            Ok::<_, String>(())
        })();
        if let Err(reason) = result {
            self.fail(&reason, events);
        }
    }

    fn status(&self, now: u64) -> ReceiverStatus {
        let output = self.output.as_ref().map(|output| output.telemetry());
        ReceiverStatus {
            identity: self.identity,
            connected: self.connected,
            output_ready: self.output_ready(now),
            current_epoch: self.current.as_ref().map(|p| p.plan.epoch.0),
            preparing_epoch: self.preparing.as_ref().map(|p| p.plan.epoch.0),
            network_clock: self.mapping,
            output,
            buffered_input_frames: self.budget.frames.load(Ordering::Acquire),
            played_frame: self.played_frame,
            underrun_frames: output.map_or(0, |o| o.underrun_frames),
            discarded_blocks: self.discarded,
            last_error: self.last_error.clone(),
        }
    }
}
