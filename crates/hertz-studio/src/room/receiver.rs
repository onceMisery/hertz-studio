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
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, watch};
use vmusic_audio::clocked_resample::{ClockedConverter, State as ConvertState};
use vmusic_audio::output_clock::ClockStatus;
use vmusic_audio::scheduled_output::EmergencyMute;
use vmusic_audio::{OutputError, OutputOptions, OutputTelemetry, RenderFormat, ScheduledOutput};
use vmusic_core::room::receiver::{FormatDesc, GateAction, GateInput, PlanDesc, ReceiverGate};
use vmusic_lan::clock::{ClockMapping, MonotonicClock};
use vmusic_lan::protocol::{validate_payload, AudioFormat, PcmBlock, Plan, StreamIdentity};

const COMMAND_CAPACITY: usize = 64;
const EVENT_CAPACITY: usize = 32;
// Includes commands waiting for the worker, not merely its active PCM deque.
// The worker publishes its two accepted formats for exact ingress accounting;
// unknown formats are charged at the lowest wire rate until matched. Input
// (1.3s), two full converter histories (0.744s at 44.1kHz), device queue (0.6s),
// and history/scratch (<0.286s even at 8kHz output) total less than 3s.
// The separate byte limit remains 4MiB; device PCM and
// conversion scratch keep total live PCM below 8MiB. Devices with >500ms
// submission lead are explicitly unsupported by this policy.
const MIN_WIRE_RATE: u32 = 44_100;
const MAX_WIRE_RATE: u32 = 192_000;
const INPUT_DURATION_LIMIT_NS: u64 = 1_300_000_000;
// Metadata only: actual queued PCM is constrained by its source duration.
const GATE_UNMATCHED_FRAME_LIMIT: u32 =
    (INPUT_DURATION_LIMIT_NS * MAX_WIRE_RATE as u64 / 1_000_000_000) as u32;
const INPUT_BYTE_LIMIT: usize = 4 * 1024 * 1024;
const HORIZON_NS: u64 = 100_000_000;
const SUBMIT_MARGIN_NS: u64 = 20_000_000;
const DEVICE_FRESHNESS_NS: u64 = 250_000_000;
const MAX_DEVICE_LEAD_NS: u64 = 500_000_000;
const MAX_PHASE_ERROR_NS: f64 = 3_000_000.0;
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
    pub binding: Option<vmusic_audio::OutputBinding>,
    pub buffered_input_frames: usize,
    /// Source-frame estimate from the converter's accumulated phase and device
    /// progress. Pending output is back-projected at the current smoothed ratio;
    /// it is not an exact source-sample counter during ratio slew. Exact device
    /// played/underrun counts and clock quality are exposed in `output`.
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
    Status(Box<ReceiverStatus>),
}

#[derive(Default)]
struct Budget {
    frames: AtomicUsize,
    bytes: AtomicUsize,
    duration_ns: AtomicU64,
    // Never held across conversion, I/O or command processing. At most the
    // current and preparing immutable formats are published by the worker.
    formats: Mutex<[Option<(u64, AudioFormat)>; 2]>,
}

struct Reservation {
    budget: Arc<Budget>,
    frames: usize,
    bytes: usize,
    duration_ns: u64,
}

impl Reservation {
    fn acquire(budget: &Arc<Budget>, block: &PcmBlock) -> Result<Self, ReceiverError> {
        let frames = block.frame_count() as usize;
        let bytes = block.byte_len();
        // Accepted formats price queued commands immediately; early PCM uses
        // the minimum rate. Upward rounding cannot undercharge packetization.
        let rate = budget
            .formats
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .flatten()
            .find(|(epoch, format)| {
                *epoch == block.epoch
                    && format.id == block.format_id
                    && format.channels == block.channels
            })
            .map_or(MIN_WIRE_RATE, |(_, format)| format.sample_rate);
        let duration_ns = Self::duration(frames, rate);
        if budget
            .duration_ns
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                n.checked_add(duration_ns)
                    .filter(|n| *n <= INPUT_DURATION_LIMIT_NS)
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
            budget.duration_ns.fetch_sub(duration_ns, Ordering::AcqRel);
            return Err(ReceiverError::Capacity);
        }
        budget.frames.fetch_add(frames, Ordering::AcqRel);
        Ok(Self {
            budget: Arc::clone(budget),
            frames,
            bytes,
            duration_ns,
        })
    }

    fn duration(frames: usize, rate: u32) -> u64 {
        (frames as u64 * 1_000_000_000).div_ceil(u64::from(rate))
    }

    fn match_format(&mut self, rate: u32) -> Result<(), ReceiverError> {
        // Called only after validating and matching the immutable epoch format.
        // Unknown PCM is repriced downward. If a queued block outlives the
        // published slot that priced it, a more expensive match must reserve
        // the extra duration before it can be accepted into the new slot.
        debug_assert!((MIN_WIRE_RATE..=MAX_WIRE_RATE).contains(&rate));
        let duration_ns = Self::duration(self.frames, rate);
        if duration_ns > self.duration_ns {
            let extra = duration_ns - self.duration_ns;
            self.budget
                .duration_ns
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                    n.checked_add(extra)
                        .filter(|n| *n <= INPUT_DURATION_LIMIT_NS)
                })
                .map_err(|_| ReceiverError::Capacity)?;
        } else {
            self.budget
                .duration_ns
                .fetch_sub(self.duration_ns - duration_ns, Ordering::AcqRel);
        }
        self.duration_ns = duration_ns;
        Ok(())
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget.frames.fetch_sub(self.frames, Ordering::AcqRel);
        self.budget.bytes.fetch_sub(self.bytes, Ordering::AcqRel);
        self.budget
            .duration_ns
            .fetch_sub(self.duration_ns, Ordering::AcqRel);
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
    Suspend {
        identity: StreamIdentity,
        epoch: u64,
        plan_id: u64,
        effective_at: u64,
    },
    Pcm(Pcm),
    Mapping(ClockMapping),
    Volume(f32),
    TestOutput(oneshot::Sender<Result<(), ReceiverError>>),
}

struct Envelope {
    generation: u64,
    command: Command,
}

type Emergency = Arc<Mutex<Option<EmergencyMute>>>;

fn emergency_mute(emergency: &Emergency) {
    if let Some(control) = emergency
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
    {
        control.mute();
    }
}

struct Lease {
    shutdown: Arc<AtomicBool>,
    emergency: Emergency,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        emergency_mute(&self.emergency);
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
    emergency: Emergency,
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
                emergency_mute(&self.emergency);
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

    pub fn suspend(
        &self,
        identity: StreamIdentity,
        epoch: u64,
        plan_id: u64,
        effective_at: u64,
    ) -> Result<(), ReceiverError> {
        self.send(Command::Suspend {
            identity,
            epoch,
            plan_id,
            effective_at,
        })
    }

    pub fn pcm(&self, block: PcmBlock) -> Result<(), ReceiverError> {
        validate_block(&block).inspect_err(|_| {
            self.generation.fetch_add(1, Ordering::AcqRel);
            self.trip.store(true, Ordering::Release);
            emergency_mute(&self.emergency);
        })?;
        let reservation = Reservation::acquire(&self.budget, &block).inspect_err(|_| {
            self.generation.fetch_add(1, Ordering::AcqRel);
            self.trip.store(true, Ordering::Release);
            emergency_mute(&self.emergency);
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
        emergency_mute(&self.emergency);
    }

    /// Revoke queued authorization immediately while retaining this session's
    /// monotonically increasing plan token. A fresh future Prepare may follow
    /// this call directly: its generation survives the urgent queue flush.
    pub fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.invalidated.store(true, Ordering::Release);
        emergency_mute(&self.emergency);
    }

    pub fn set_volume(&self, volume: f32) -> Result<(), ReceiverError> {
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err(ReceiverError::Invalid("volume"));
        }
        self.send(Command::Volume(volume))
    }

    pub fn status(&self) -> ReceiverStatus {
        self.status.borrow().clone()
    }

    pub async fn test_output(&self) -> Result<(), ReceiverError> {
        let (reply, response) = oneshot::channel();
        self.send(Command::TestOutput(reply))?;
        tokio::time::timeout(Duration::from_secs(1), response)
            .await
            .map_err(|_| ReceiverError::Output("test output request timed out".into()))?
            .map_err(|_| ReceiverError::Closed)?
    }

    /// Stops this entire session, including other handle clones. Success means
    /// the native output was dropped on its owner thread, so an exclusive
    /// device lease may be released. A timeout must not be treated as release.
    pub async fn shutdown(self) -> Result<(), ReceiverError> {
        self.request_shutdown();
        tokio::time::timeout(Duration::from_secs(3), self.wait_closed())
            .await
            .map_err(|_| ReceiverError::Output("native output shutdown timed out".into()))?
    }

    pub async fn wait_closed(&self) -> Result<(), ReceiverError> {
        let mut done = self.done.clone();
        while !*done.borrow_and_update() {
            done.changed().await.map_err(|_| ReceiverError::Closed)?;
        }
        Ok(())
    }

    fn request_shutdown(&self) {
        self._lease.shutdown.store(true, Ordering::Release);
        self.disconnect();
    }
}

#[derive(Clone, Default)]
pub(crate) struct ReceiverRegistry {
    state: Arc<Mutex<RegistryState>>,
}

#[derive(Default)]
struct RegistryState {
    closing: bool,
    current: Option<ReceiverHandle>,
}

impl ReceiverRegistry {
    #[cfg(test)]
    pub(super) fn is_closing(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .closing
    }

    /// Permanently prevents new native workers before lifecycle recovery is
    /// scheduled. Registration holds this same short, synchronous lock through
    /// native thread creation, so recovery cannot overlook an escaping worker.
    pub fn begin_close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.closing = true;
        if let Some(receiver) = &state.current {
            receiver.request_shutdown();
        }
    }

    fn register(
        &self,
        receiver: &ReceiverHandle,
        start_worker: impl FnOnce() -> Result<(), ReceiverError>,
    ) -> Result<(), ReceiverError> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.closing {
            return Err(ReceiverError::Closed);
        }
        if state.current.is_some() {
            return Err(ReceiverError::Invalid("previous receiver has not closed"));
        }
        // Publish before starting: unwinding in thread creation must also leave
        // the native completion barrier owned by lifecycle recovery.
        state.current = Some(receiver.clone());
        if let Err(error) = start_worker() {
            state.current = None;
            return Err(error);
        }
        Ok(())
    }

    /// Retains the completion handle in the registry throughout every await.
    /// Cancelling a reconfiguration or recovery cannot discard its barrier.
    /// This can close one worker for replacement without reopening a registry
    /// permanently sealed by begin_close().
    pub async fn close_current(&self) -> Result<(), ReceiverError> {
        let receiver = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .current
            .clone();
        let Some(receiver) = receiver else {
            return Ok(());
        };
        let result = receiver.clone().shutdown().await;
        if result.is_err() {
            let _ = receiver.wait_closed().await;
        }
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        // Another closer may have finished A and registered B while this
        // closer was suspended. Only A's completion permits removing A.
        if state
            .current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(&current._lease, &receiver._lease))
        {
            state.current = None;
        }
        result
    }
}

/// `OutputOptions.clock_origin` is normalized to the supplied shared clock.
/// CPAL never crosses an await or thread boundary. Initialization errors are
/// returned before the caller receives a handle. A replacement session uses a
/// new spawn after the prior worker's completion barrier. The lifecycle registry
/// atomically owns the worker before it can escape, including during cancelled
/// initialization, and rejects creation once restoration has started.
pub(crate) async fn spawn(
    mut options: OutputOptions,
    identity: StreamIdentity,
    clock: MonotonicClock,
    registry: ReceiverRegistry,
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
    let emergency = Arc::new(Mutex::new(None));
    let armed_generation = Arc::new(AtomicU64::new(0));
    let initial = ReceiverStatus {
        identity,
        connected: true,
        output_ready: false,
        current_epoch: None,
        preparing_epoch: None,
        network_clock: None,
        output: None,
        binding: None,
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
        emergency: Arc::clone(&emergency),
        disconnected: Arc::clone(&disconnected),
        budget: Arc::clone(&budget),
        status: status_rx,
        done: done_rx,
        _lease: Arc::new(Lease {
            shutdown: Arc::clone(&shutdown),
            emergency: Arc::clone(&emergency),
        }),
    };
    let (initialized, init_rx) = oneshot::channel();
    registry.register(&handle, || {
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
                // CPAL may choose a supported rate different from the preference.
                // The receiver's memory/duration proof applies to this actual rate.
                if !(8_000..=192_000).contains(&output.format().sample_rate) {
                    let _ = initialized.send(Err(ReceiverError::Output(
                        "actual device rate is outside 8kHz..192kHz receiver policy".into(),
                    )));
                    return;
                }
                let output = NativeOutput {
                    output,
                    emergency: Arc::clone(&emergency),
                    generation: Arc::clone(&generation),
                    armed_generation: Arc::clone(&armed_generation),
                    trip: Arc::clone(&trip),
                    invalidated: Arc::clone(&invalidated),
                    disconnected: Arc::clone(&disconnected),
                    shutdown: Arc::clone(&shutdown),
                };
                output.publish_emergency();
                let mut engine = Engine::new(output, identity, budget);
                status_tx.send_replace(engine.status(0));
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
                        armed_generation.store(active_generation, Ordering::Release);
                    }
                    if invalidated.swap(false, Ordering::AcqRel) {
                        engine.fail(
                            "receiver invalidated; fresh future join required",
                            &mut outgoing,
                        );
                        active_generation = generation.load(Ordering::Acquire);
                        armed_generation.store(active_generation, Ordering::Release);
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
                        let faults = engine.faults;
                        engine.command(clock.now_ns(), command, &mut outgoing);
                        if engine.faults != faults {
                            active_generation = revoke_generation(&generation, active_generation);
                            armed_generation.store(active_generation, Ordering::Release);
                            break;
                        }
                    }
                    let now = clock.now_ns();
                    let faults = engine.faults;
                    engine.tick(now, &mut outgoing);
                    if engine.faults != faults {
                        active_generation = revoke_generation(&generation, active_generation);
                        armed_generation.store(active_generation, Ordering::Release);
                    }
                    let status = engine.status(now);
                    status_tx.send_replace(status.clone());
                    if now.saturating_sub(last_status) >= 250_000_000 {
                        // Status is lossy and coalesced in watch. Protocol actions are
                        // not lossy: failure to deliver one revokes audio authorization.
                        let _ = events.try_send(ReceiverEvent::Status(Box::new(status)));
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
                engine.connected = false;
                status_tx.send_replace(engine.status(clock.now_ns()));
                drop(engine);
            })
            .map(|_| ())
            .map_err(|error| ReceiverError::Output(error.to_string()))
    })?;
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

// A concurrent explicit invalidate already moved ingress to a fresh
// generation. Internal faults revoke only the generation they processed,
// preserving the newly authorized commands queued after that invalidate.
fn revoke_generation(generation: &AtomicU64, active: u64) -> u64 {
    match generation.compare_exchange(active, active + 1, Ordering::AcqRel, Ordering::Acquire) {
        Ok(_) => active + 1,
        Err(current) => current,
    }
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
    fn binding(&self) -> Option<vmusic_audio::OutputBinding> {
        None
    }
    fn format(&self) -> RenderFormat;
    fn telemetry(&self) -> OutputTelemetry;
    fn write(
        &mut self,
        start: u64,
        samples: &[f32],
        now: u64,
        period: f64,
    ) -> Result<(), OutputError>;
    fn mute(&mut self);
    fn unmute(&mut self, start: u64);
    fn silence_from(&mut self, local_ns: u64);
    fn volume(&mut self, volume: f32) -> Result<(), OutputError>;
}

/// Only the native owner holds CPAL. A short control lock serializes each
/// unmute/write with external emergency mute; conversion never holds it and
/// the audio callback never takes it. Generation checks prevent a worker
/// already converting an old epoch from undoing emergency mute afterwards.
struct NativeOutput {
    output: ScheduledOutput,
    emergency: Emergency,
    generation: Arc<AtomicU64>,
    armed_generation: Arc<AtomicU64>,
    trip: Arc<AtomicBool>,
    invalidated: Arc<AtomicBool>,
    disconnected: Arc<AtomicBool>,
    shutdown: Arc<AtomicBool>,
}

impl NativeOutput {
    fn publish_emergency(&self) {
        *self
            .emergency
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(self.output.emergency_mute());
    }
    fn authorized(&self) -> bool {
        self.generation.load(Ordering::Acquire) == self.armed_generation.load(Ordering::Acquire)
            && !self.trip.load(Ordering::Acquire)
            && !self.invalidated.load(Ordering::Acquire)
            && !self.disconnected.load(Ordering::Acquire)
            && !self.shutdown.load(Ordering::Acquire)
    }
}

impl DeviceOutput for NativeOutput {
    fn binding(&self) -> Option<vmusic_audio::OutputBinding> {
        Some(self.output.binding().clone())
    }
    fn format(&self) -> RenderFormat {
        self.output.format()
    }
    fn telemetry(&self) -> OutputTelemetry {
        self.output.telemetry()
    }
    fn write(
        &mut self,
        start: u64,
        samples: &[f32],
        _now: u64,
        period: f64,
    ) -> Result<(), OutputError> {
        let _guard = self
            .emergency
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !self.authorized() {
            return Err(OutputError::Muted);
        }
        self.output.write_clocked(start, samples, period)
    }
    fn mute(&mut self) {
        self.output.mute();
    }
    fn unmute(&mut self, start: u64) {
        let _guard = self
            .emergency
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.authorized() {
            self.output.unmute_at(start);
        }
    }
    fn volume(&mut self, volume: f32) -> Result<(), OutputError> {
        self.output.set_local_volume(volume)
    }
    fn silence_from(&mut self, local_ns: u64) {
        self.output.silence_from(local_ns);
    }
}

impl DeviceOutput for ScheduledOutput {
    fn format(&self) -> RenderFormat {
        self.format()
    }
    fn telemetry(&self) -> OutputTelemetry {
        self.telemetry()
    }
    fn write(
        &mut self,
        start: u64,
        samples: &[f32],
        _now: u64,
        period: f64,
    ) -> Result<(), OutputError> {
        self.write_clocked(start, samples, period)
    }
    fn mute(&mut self) {
        self.mute();
    }
    fn unmute(&mut self, start: u64) {
        self.unmute_at(start);
    }
    fn volume(&mut self, volume: f32) -> Result<(), OutputError> {
        self.set_local_volume(volume)
    }
    fn silence_from(&mut self, local_ns: u64) {
        self.silence_from(local_ns);
    }
}

struct Epoch {
    plan: Plan,
    start: u64,
    ready: bool,
    committed: bool,
    expected_frame: u64,
    sequence: Option<u64>,
    pcm: VecDeque<Pcm>,
    converter: ClockedConverter,
    history: Vec<f32>,
    history_have: Vec<bool>,
    history_primed: bool,
    tail_padded: bool,
    // Once a continuous run starts this remains the output sample grid. The
    // source packet's nominal timestamp is never used as a new run boundary.
    output_frames: u64,
    cursor: DeviceCursor,
    drain: bool,
    played_baseline: Option<u64>,
}

struct DeviceCursor {
    anchor: u64,
    fraction: f64,
    frames: u64,
    period: f64,
}
impl DeviceCursor {
    fn time(&self) -> Result<u64, &'static str> {
        let offset = self.fraction + self.frames as f64 * self.period;
        if !offset.is_finite() || offset < 0.0 || offset >= u64::MAX as f64 {
            return Err("output cursor overflow");
        }
        self.anchor
            .checked_add(offset.round() as u64)
            .ok_or("output cursor overflow")
    }
    fn period(&mut self, period: f64) -> Result<(), &'static str> {
        if !period.is_finite() || period <= 0.0 {
            return Err("invalid output period");
        }
        if self.period != period {
            let offset = self.fraction + self.frames as f64 * self.period;
            let whole = offset.floor() as u64;
            self.anchor = self
                .anchor
                .checked_add(whole)
                .ok_or("output cursor overflow")?;
            self.fraction = offset - whole as f64;
            self.frames = 0;
            self.period = period;
        }
        Ok(())
    }
}

fn submission_frames(start: u64, now: u64, horizon: u64, period: f64, queued: usize) -> usize {
    if start >= horizon {
        return 0;
    }
    let target = (horizon.saturating_sub(now) as f64 / period).ceil() as usize;
    // Callback run boundaries use nearest-frame alignment. Rounding here
    // avoids stranding the final sample behind a fixed EOF due to a rounded
    // nanosecond cursor; the exclusive boundary remains within half a frame.
    (((horizon - start) as f64 / period).round() as usize)
        .min(target.saturating_sub(queued))
        .min(2048)
}

impl Epoch {
    fn new(plan: Plan, mapping: ClockMapping, output: RenderFormat) -> Result<Self, &'static str> {
        plan.format.validate().map_err(|_| "invalid plan format")?;
        let host_start = frame_time(plan.anchor_ns.0, plan.join_frame.0, plan.format.sample_rate)
            .ok_or("plan time overflow")?;
        let start = mapping
            .local_time(host_start)
            .ok_or("plan start outside local domain")?;
        let converter = ClockedConverter::new(
            plan.format.sample_rate,
            output.sample_rate,
            usize::from(output.channels),
        )
        .map_err(|_| "unsupported conversion")?;
        let history_frames = converter.lookahead_frames() as usize;
        let real_history = plan.join_frame.0.min(history_frames as u64) as usize;
        let mut history_have = vec![true; history_frames];
        history_have[history_frames - real_history..].fill(false);
        Ok(Self {
            expected_frame: plan.join_frame.0,
            plan,
            start,
            ready: false,
            committed: false,
            sequence: None,
            pcm: VecDeque::new(),
            converter,
            history: vec![0.0; history_frames * usize::from(output.channels)],
            history_have,
            history_primed: false,
            tail_padded: false,
            output_frames: 0,
            cursor: DeviceCursor {
                anchor: start,
                fraction: 0.0,
                frames: 0,
                period: 1e9 / f64::from(output.sample_rate),
            },
            drain: false,
            played_baseline: None,
        })
    }

    fn next_time(&self, _rate: u32) -> Result<u64, &'static str> {
        self.cursor.time()
    }

    fn collect_history(&mut self, block: &PcmBlock) {
        if self.history_primed {
            return;
        }
        let frames = self.history_have.len();
        let join = self.plan.join_frame.0;
        let start = join.saturating_sub(frames as u64).max(block.frame_index);
        let end = join.min(block.end_frame());
        let source_channels = usize::from(block.channels);
        let channels = self.history.len() / frames;
        for source_frame in start..end {
            let src = (source_frame - block.frame_index) as usize * source_channels;
            let at = frames - (join - source_frame) as usize;
            let dst = at * channels;
            match (source_channels, channels) {
                (1, 2) => self.history[dst..dst + 2].fill(block.samples[src]),
                (2, 1) => {
                    self.history[dst] = (block.samples[src] + block.samples[src + 1]) * 0.5;
                }
                _ => self.history[dst..dst + channels]
                    .copy_from_slice(&block.samples[src..src + channels]),
            }
            self.history_have[at] = true;
        }
    }

    fn prime_history(&mut self) -> Result<bool, &'static str> {
        if !self.history_have.iter().all(|have| *have) {
            return Ok(false);
        }
        if !self.history_primed {
            self.converter
                .prime_history(&self.history)
                .map_err(|_| "invalid source history prewarm")?;
            self.history_primed = true;
        }
        Ok(true)
    }

    fn phase_error_ns(&self, mapping: ClockMapping) -> Option<f64> {
        let host_time = mapping.host_time(self.cursor.time().ok()?)?;
        let mapped_source_ns = (i128::from(host_time) - i128::from(self.plan.anchor_ns.0)) as f64;
        let actual_source_ns = (self.plan.join_frame.0 as f64 + self.converter.source_phase())
            * 1e9
            / f64::from(self.plan.format.sample_rate);
        Some(actual_source_ns - mapped_source_ns)
    }

    fn played_frame(&self, played: u64) -> u64 {
        if played == 0 {
            return self.plan.join_frame.0;
        }
        let pending = self.output_frames.saturating_sub(played);
        let phase = self.converter.source_phase() - pending as f64 * self.converter.ratio();
        self.plan.join_frame.0.saturating_add(phase.max(0.0) as u64)
    }

    fn source_end_frame(&self, end_host_ns: u64) -> Result<u64, &'static str> {
        end_host_ns
            .checked_sub(self.plan.anchor_ns.0)
            .and_then(|duration| {
                u64::try_from(
                    u128::from(duration) * u128::from(self.plan.format.sample_rate) / 1_000_000_000,
                )
                .ok()
            })
            .ok_or("source end outside the media timeline")
    }

    fn gate_eof_limit(&self, end_host_ns: u64) -> Result<Option<u64>, &'static str> {
        let frames = self.source_end_frame(end_host_ns)?;
        if frames == 0 {
            return Ok(None);
        }
        // Gate due_until(t) includes the sample at t. The producer sends only
        // floor(duration * rate) frames, so cap immediately before frame N's
        // actual deadline, including when stop falls between source frames.
        let offset =
            (u128::from(frames) * 1_000_000_000).div_ceil(u128::from(self.plan.format.sample_rate));
        self.plan
            .anchor_ns
            .0
            .checked_add(u64::try_from(offset).map_err(|_| "source end time overflow")?)
            .and_then(|end| end.checked_sub(1))
            .map(Some)
            .ok_or("source end time overflow")
    }

    fn submit<D: DeviceOutput>(
        &mut self,
        output: &mut D,
        mapping: ClockMapping,
        now: u64,
        horizon: u64,
        end_host_ns: Option<u64>,
        silence_from: Option<u64>,
    ) -> Result<(), String> {
        if !self.committed {
            return Ok(());
        }
        if self
            .phase_error_ns(mapping)
            .is_none_or(|error| error.abs() > MAX_PHASE_ERROR_NS)
        {
            return Err("mapped device/source phase diverged; fresh future join required".into());
        }
        let format = output.format();
        let telemetry = output.telemetry();
        let combined = relative_drift_ppm(mapping.drift_ppm, telemetry.device_clock_ppm)
            .ok_or("relative device/network clock drift is unsupported")?;
        self.converter.set_drift_ppm(combined);
        self.cursor.period(telemetry.ns_per_frame)?;
        let channels = usize::from(format.channels);
        // Only a published Commit/Suspend freezes an EOF. A moving submission
        // horizon is never permission to synthesize missing source samples.
        let source_end = end_host_ns
            .map(|end| self.source_end_frame(end))
            .transpose()?;
        let mut input = Vec::with_capacity(1024 * channels);
        let mut samples = vec![0.0; 2048 * channels];
        // Bound worker work per tick even when ingress is continuously full.
        for _ in 0..8 {
            let start = self.next_time(format.sample_rate)?;
            let frames = submission_frames(
                start,
                now,
                horizon,
                telemetry.ns_per_frame,
                output.telemetry().queued_frames,
            );
            if frames == 0 {
                break;
            }
            input.clear();
            if !self.drain {
                let consumed = self
                    .plan
                    .join_frame
                    .0
                    .saturating_add(self.converter.counts().0);
                let remaining = source_end.map_or(usize::MAX, |end| {
                    end.saturating_sub(consumed).min(usize::MAX as u64) as usize
                });
                if remaining == 0 {
                    // The ingress cursor proves every real frame before EOF
                    // arrived contiguously. Zero extension supplies only the
                    // sinc lookahead; output is still limited to the boundary.
                    if !self.tail_padded && source_end.is_some_and(|end| self.expected_frame >= end)
                    {
                        // A stop may fall between source/device frames. Also
                        // cover the permitted phase residual plus one output
                        // step; all of this extension lies after proven EOF.
                        let phase_tail =
                            (MAX_PHASE_ERROR_NS * f64::from(self.plan.format.sample_rate) / 1e9)
                                .ceil() as usize;
                        let pad = self.converter.lookahead_frames() as usize
                            + phase_tail
                            + self.converter.nominal_ratio().ceil() as usize
                            + 1;
                        input.resize(pad * channels, 0.0);
                        self.tail_padded = true;
                    }
                } else if let Some(front) = self.pcm.front_mut() {
                    let block = &front.block;
                    let count = (block.frame_count() as usize - front.offset_frames)
                        .min(1024)
                        .min(remaining);
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
                    output.unmute(start);
                    if let Some(boundary) = silence_from {
                        output.silence_from(boundary);
                    }
                }
                if self.played_baseline.is_none() {
                    let t = output.telemetry();
                    self.played_baseline =
                        Some(t.played_frames.saturating_add(t.queued_frames as u64));
                }
                output
                    .write(
                        start,
                        &samples[..progress.produced_frames * channels],
                        now,
                        telemetry.ns_per_frame,
                    )
                    .map_err(|error| error.to_string())?;
                self.output_frames = self
                    .output_frames
                    .checked_add(progress.produced_frames as u64)
                    .ok_or("output frame counter overflow")?;
                self.cursor.frames = self
                    .cursor
                    .frames
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
    suspension: Option<(u64, u64, u64, u64)>,
    faults: u64,
    /// Applied epochs never move backwards, while per-endpoint rejoin tokens
    /// may replace the same epoch without changing the room's media epoch.
    epoch_floor: u64,
    latest_plan_id: Option<u64>,
    contracts: VecDeque<(u64, u64, AudioFormat, u64, Option<u64>)>,
    unmatched: VecDeque<(u64, Pcm)>,
    volume: f32,
    last_error: Option<String>,
    discarded: u64,
    previous_underrun: u64,
    previous_late: u64,
    played_frame: u64,
    test_until: Option<u64>,
}

impl<D: DeviceOutput> Engine<D> {
    fn publish_budget_formats(&self) {
        *self
            .budget
            .formats
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = [
            self.current
                .as_ref()
                .map(|epoch| (epoch.plan.epoch.0, epoch.plan.format)),
            self.preparing
                .as_ref()
                .map(|epoch| (epoch.plan.epoch.0, epoch.plan.format)),
        ];
    }
    fn bounded_gate_time(&self, host_now: u64) -> Result<Option<u64>, &'static str> {
        let Some((_, _, _, stop)) = self.suspension else {
            return Ok(Some(host_now));
        };
        // ReceiverGate applies a due committed preparation before presenting
        // frames, so select the epoch it will use on this exact advance.
        let next = self.preparing.as_ref().filter(|p| {
            p.committed
                && frame_time(
                    p.plan.anchor_ns.0,
                    p.plan.join_frame.0,
                    p.plan.format.sample_rate,
                )
                .is_some_and(|start| host_now >= start)
        });
        let Some(epoch) = next.or(self.current.as_ref()) else {
            return Ok(Some(host_now));
        };
        Ok(epoch.gate_eof_limit(stop)?.map(|limit| host_now.min(limit)))
    }
    fn new(mut output: D, identity: StreamIdentity, budget: Arc<Budget>) -> Self {
        output.mute();
        let mut gate = ReceiverGate::new(SUBMIT_MARGIN_NS, 500_000_000, GATE_UNMATCHED_FRAME_LIMIT);
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
            suspension: None,
            faults: 0,
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
            test_until: None,
        }
    }

    fn fail(&mut self, reason: &str, events: &mut Vec<ReceiverEvent>) {
        self.faults = self.faults.wrapping_add(1);
        if let Some(output) = self.output.as_mut() {
            output.mute();
        }
        self.current = None;
        self.test_until = None;
        self.preparing = None;
        self.intent = None;
        self.suspension = None;
        self.unmatched.clear();
        self.publish_budget_formats();
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
        self.test_until.is_none()
            && self.connected
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

    fn start_test_output(&mut self, now: u64) -> Result<(), ReceiverError> {
        // A local diagnostic never replaces a room epoch. A concurrently
        // arriving authorized Prepare cancels it before installing its plan.
        if self.current.is_some()
            || self.preparing.is_some()
            || self.intent.is_some()
            || self.suspension.is_some()
            || !self.output_ready(now)
        {
            return Err(ReceiverError::Invalid(
                "pause playback and wait for the output clock before testing",
            ));
        }
        let start = now
            .checked_add(self.lead(now))
            .ok_or(ReceiverError::Invalid("test time overflow"))?;
        let output = self.output.as_mut().ok_or(ReceiverError::Closed)?;
        let format = output.format();
        let period = output.telemetry().ns_per_frame;
        let frames = format.sample_rate as usize / 4;
        let end = start
            .checked_add((frames as f64 * period).round() as u64)
            .ok_or(ReceiverError::Invalid("test time overflow"))?;
        let ramp = (format.sample_rate as usize / 200).max(1);
        let mut samples = Vec::with_capacity(frames * usize::from(format.channels));
        for frame in 0..frames {
            let envelope = (frame.min(frames - 1 - frame) as f32 / ramp as f32).min(1.0);
            let phase = frame as f64 * period * 1e-9 * 440.0 * std::f64::consts::TAU;
            let sample = phase.sin() as f32 * 0.031_622_775 * envelope;
            samples.extend(std::iter::repeat_n(sample, usize::from(format.channels)));
        }
        output.unmute(start);
        output.silence_from(end);
        if let Err(error) = output.write(start, &samples, now, period) {
            output.mute();
            return Err(ReceiverError::Output(error.to_string()));
        }
        self.test_until = Some(end);
        Ok(())
    }

    fn command(&mut self, now: u64, command: Command, events: &mut Vec<ReceiverEvent>) {
        match command {
            Command::TestOutput(reply) => {
                if !reply.is_closed() {
                    let result = self.start_test_output(now);
                    let started = result.is_ok();
                    if reply.send(result).is_err() && started {
                        self.test_until = None;
                        if let Some(output) = self.output.as_mut() {
                            output.mute();
                        }
                    }
                }
            }
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
                if self.test_until.take().is_some() {
                    if let Some(output) = self.output.as_mut() {
                        output.mute();
                    }
                }
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
            Command::Suspend {
                identity,
                epoch,
                plan_id,
                effective_at,
            } if self.connected && identity == self.identity => {
                if let Some((e, p, _, h)) = self.suspension {
                    if e != epoch || p != plan_id || h != effective_at {
                        self.fail("immutable pending suspension changed", events);
                    }
                    return;
                }
                if epoch < self.epoch_floor || self.latest_plan_id.is_some_and(|id| plan_id <= id) {
                    return;
                }
                let local = self
                    .mapping
                    .filter(|m| m.valid_at(now))
                    .and_then(|m| m.local_time(effective_at));
                if !self.output_ready(now)
                    || local.is_none_or(|local| now.saturating_add(self.lead(now)) >= local)
                    || self
                        .preparing
                        .as_ref()
                        .is_some_and(|p| p.committed && local.is_some_and(|local| local <= p.start))
                {
                    self.fail("suspension missed its presentation deadline", events);
                    return;
                }
                self.latest_plan_id = Some(plan_id);
                self.suspension = Some((epoch, plan_id, local.unwrap(), effective_at));
                if let Some(output) = self.output.as_mut() {
                    output.silence_from(local.unwrap());
                }
            }
            Command::Pcm(pcm) if self.connected && pcm.block.identity == self.identity => {
                self.pcm(now, pcm, events)
            }
            Command::Pcm(_) => self.discarded += 1,
            _ => {}
        }
        self.publish_budget_formats();
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
        if let Some((_, anchor, format, join, _)) = self
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
                None,
            ));
            while self.contracts.len() > 4 {
                let current = self.current.as_ref().map(|p| p.plan.epoch.0);
                let preparing = self.preparing.as_ref().map(|p| p.plan.epoch.0);
                let intent = self.intent.as_ref().map(|p| p.epoch.0);
                let removable = self.contracts.iter().position(|(epoch, ..)| {
                    *epoch != self.epoch_floor
                        && Some(*epoch) != current
                        && Some(*epoch) != preparing
                        && Some(*epoch) != intent
                        && *epoch != plan.epoch.0
                });
                if let Some(index) = removable {
                    self.contracts.remove(index);
                } else {
                    break;
                }
            }
        }
        self.latest_plan_id = Some(plan.plan_id.0);
        if self.suspension.is_some() || self.preparing.as_ref().is_some_and(|p| p.committed) {
            // Only the newest third intent survives; it receives neither PCM
            // nor Ready until the committed preparation actually switches.
            self.intent = Some(plan);
            return;
        }
        self.install_plan(now, plan, events);
    }

    fn install_plan(&mut self, now: u64, plan: Plan, events: &mut Vec<ReceiverEvent>) {
        // Deferred intents can outlive the epoch floor they passed at ingress:
        // both a committed switch and a suspension raise it before promotion.
        if plan.epoch.0 < self.epoch_floor {
            return;
        }
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
        let Some(gate_now) = self.mapping.and_then(|mapping| mapping.host_time(now)) else {
            self.fail("network clock cannot map the current time", events);
            return;
        };
        let lead = self.lead(now);
        let Some(epoch) = self.preparing.as_mut().filter(|p| !p.ready) else {
            return;
        };
        let required = u64::from(epoch.plan.format.sample_rate).div_ceil(50)
            + epoch.converter.lookahead_frames();
        if epoch.expected_frame.saturating_sub(epoch.plan.join_frame.0) < required {
            return;
        }
        match epoch.prime_history() {
            Ok(true) => {}
            Ok(false) => return,
            Err(reason) => {
                self.fail(reason, events);
                return;
            }
        }
        if epoch.start <= now.saturating_add(lead) {
            self.fail("clock became ready after plan submission deadline", events);
            return;
        }
        let plan = &epoch.plan;
        self.gate.input(
            gate_now,
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
            gate_now,
            GateInput::Plan {
                session: GATE_SESSION,
                plan: PlanDesc {
                    epoch: plan.epoch.0,
                    plan_id: plan.plan_id.0,
                    // Metadata gate time is real current time in the host domain.
                    // This preserves the source frame rate under host/local drift
                    // and permits anchors preceding the client's Instant origin.
                    // Device submissions use the separate mapped local `start`.
                    anchor_ns: plan.anchor_ns.0,
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
            self.mapping
                .and_then(|mapping| mapping.host_time(now))
                .unwrap_or(now),
            GateInput::Commit {
                session: GATE_SESSION,
                epoch,
                plan_id,
                effective_at,
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
        let host_now = self
            .mapping
            .and_then(|mapping| mapping.host_time(now))
            .unwrap_or(now);
        let gate_now = match self.bounded_gate_time(host_now) {
            Ok(Some(time)) => time,
            // A suspended epoch may have no presentable source frame at all.
            Ok(None) => return,
            Err(reason) => {
                self.fail(reason, events);
                return;
            }
        };
        let block = &pcm.block;
        let previous_sequence = self
            .contracts
            .iter()
            .find(|(epoch, ..)| *epoch == block.epoch)
            .and_then(|(_, _, _, _, sequence)| *sequence);
        if previous_sequence.is_some_and(|sequence| block.sequence <= sequence) {
            self.discarded += 1;
            return;
        }
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
        if block.format_id != epoch.plan.format.id || block.channels != epoch.plan.format.channels {
            self.discarded += 1;
            return;
        }
        if pcm
            ._reservation
            .match_format(epoch.plan.format.sample_rate)
            .is_err()
        {
            self.fail("matched PCM exceeds its source duration budget", events);
            return;
        }
        // The sinc window needs real samples immediately before a late join.
        // Historical packets advance the wire highwater but never establish
        // the post-join contiguous sequence cursor or consume a PCM slot.
        let join = epoch.plan.join_frame.0;
        epoch.collect_history(block);
        if block.end_frame() <= join {
            if let Some((_, _, _, _, high)) = self
                .contracts
                .iter_mut()
                .find(|(known, ..)| *known == block.epoch)
            {
                *high = Some(block.sequence);
            }
            self.discarded += 1;
            self.ready(now, events);
            return;
        }
        if epoch.sequence.is_none() && block.frame_index < join {
            pcm.offset_frames = (join - block.frame_index) as usize;
        }
        let frame_index = block.frame_index + pcm.offset_frames as u64;
        let frame_count = block.frame_count() - pcm.offset_frames as u32;
        if frame_index < epoch.expected_frame
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
            gate_now,
            GateInput::Pcm {
                session: GATE_SESSION,
                epoch: block.epoch,
                sequence: block.sequence,
                frame_index,
                frame_count,
            },
        );
        if actions.iter().any(|action| {
            matches!(
                action,
                GateAction::Underrun { .. } | GateAction::Resync { .. }
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
            .any(|a| matches!(a, GateAction::DiscardPcm { .. }))
        {
            self.discarded += 1;
            self.fail("receiver gate discarded PCM", events);
            return;
        }
        epoch.pcm.push_back(pcm);
        if let Some((_, _, _, _, high)) = self
            .contracts
            .iter_mut()
            .find(|(known, ..)| *known == epoch.plan.epoch.0)
        {
            *high = epoch.sequence;
        }
        self.ready(now, events);
    }

    fn tick(&mut self, now: u64, events: &mut Vec<ReceiverEvent>) {
        if let Some(until) = self.test_until {
            let healthy = self.output.as_ref().is_some_and(|output| {
                let t = output.telemetry();
                t.clock_status == ClockStatus::Valid && !t.device_error
            });
            if now >= until || !healthy {
                if let Some(output) = self.output.as_mut() {
                    output.mute();
                }
                self.test_until = None;
            } else {
                return;
            }
        }
        if self.suspension.is_some_and(|(_, _, local, _)| now >= local) {
            let (epoch, _, _, _) = self.suspension.take().unwrap();
            let intent = self.intent.take();
            if let Some(output) = self.output.as_mut() {
                output.mute();
            }
            self.current = None;
            self.preparing = None;
            self.unmatched.clear();
            self.epoch_floor = self.epoch_floor.max(epoch);
            self.gate.input(
                0,
                GateInput::Rebind {
                    session: GATE_SESSION,
                },
            );
            self.last_error = None;
            if let Some(plan) = intent {
                self.install_plan(now, plan, events);
            }
            self.publish_budget_formats();
        }
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
        let Some(gate_now) = self
            .mapping
            .filter(|mapping| mapping.valid_at(now))
            .and_then(|mapping| mapping.host_time(now))
        else {
            return;
        };
        let actions = match self.bounded_gate_time(gate_now) {
            Ok(Some(time)) => self.gate.advance(time),
            Ok(None) => Vec::new(),
            Err(reason) => {
                self.fail(reason, events);
                return;
            }
        };
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
            self.publish_budget_formats();
        }
        if !self.output_ready(now) {
            return;
        }
        let mapping = self.mapping.unwrap();
        let horizon = now
            .saturating_add(self.device_lead().unwrap_or(0))
            .saturating_add(HORIZON_NS);
        let stop = self
            .preparing
            .as_ref()
            .filter(|p| p.committed)
            .and_then(|p| {
                Some((
                    p.start,
                    frame_time(
                        p.plan.anchor_ns.0,
                        p.plan.join_frame.0,
                        p.plan.format.sample_rate,
                    )?,
                ))
            })
            .into_iter()
            .chain(self.suspension.map(|(_, _, local, host)| (local, host)))
            .min_by_key(|(local, _)| *local);
        let boundary = stop.map_or(u64::MAX, |(local, _)| local);
        let output = self.output.as_mut().unwrap();
        let silence_from = self.suspension.map(|(_, _, local, _)| local);
        let result = (|| {
            if let Some(current) = self.current.as_mut() {
                current.submit(
                    output,
                    mapping,
                    now,
                    horizon.min(boundary),
                    stop.map(|(_, host)| host),
                    silence_from,
                )?;
                if let Some(baseline) = current.played_baseline {
                    let frames = output.telemetry().played_frames.saturating_sub(baseline);
                    self.played_frame = current.played_frame(frames.min(current.output_frames));
                }
            }
            if let Some(preparing) = self.preparing.as_mut() {
                preparing.submit(
                    output,
                    mapping,
                    now,
                    horizon.min(silence_from.unwrap_or(u64::MAX)),
                    self.suspension.map(|(_, _, _, host)| host),
                    silence_from,
                )?;
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
            binding: self.output.as_ref().and_then(|output| output.binding()),
            buffered_input_frames: self.budget.frames.load(Ordering::Acquire),
            played_frame: self.played_frame,
            underrun_frames: output.map_or(0, |o| o.underrun_frames),
            discarded_blocks: self.discarded,
            last_error: self.last_error.clone(),
        }
    }
}

#[cfg(test)]
#[path = "receiver_tests.rs"]
mod tests;

#[cfg(test)]
mod registry_tests {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::task::{Context, Waker};

    fn pending_worker() -> (ReceiverHandle, watch::Sender<bool>) {
        let (commands, _inbox) = mpsc::channel(1);
        let (_status, status) = watch::channel(ReceiverStatus {
            identity: StreamIdentity {
                room_id: uuid::Uuid::nil(),
                instance_id: uuid::Uuid::nil(),
                session_id: uuid::Uuid::nil(),
            },
            connected: true,
            output_ready: false,
            current_epoch: None,
            preparing_epoch: None,
            network_clock: None,
            output: None,
            binding: None,
            buffered_input_frames: 0,
            played_frame: 0,
            underrun_frames: 0,
            discarded_blocks: 0,
            last_error: None,
        });
        let (done_tx, done) = watch::channel(false);
        let emergency = Arc::new(Mutex::new(None));
        (
            ReceiverHandle {
                commands,
                trip: Arc::new(AtomicBool::new(false)),
                invalidated: Arc::new(AtomicBool::new(false)),
                generation: Arc::new(AtomicU64::new(0)),
                emergency: emergency.clone(),
                disconnected: Arc::new(AtomicBool::new(false)),
                budget: Arc::new(Budget::default()),
                status,
                done,
                _lease: Arc::new(Lease {
                    shutdown: Arc::new(AtomicBool::new(false)),
                    emergency,
                }),
            },
            done_tx,
        )
    }

    fn pending(future: Pin<&mut impl Future>) -> bool {
        future
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    }

    #[tokio::test]
    async fn restoration_cannot_miss_a_native_worker_during_registration_or_cancelled_close() {
        struct NativeOutput(Arc<AtomicBool>);
        impl Drop for NativeOutput {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let registry = ReceiverRegistry::default();
        let (receiver, done) = pending_worker();
        let shutdown = receiver._lease.shutdown.clone();
        let output_live = Arc::new(AtomicBool::new(false));
        let live = output_live.clone();
        let (started_tx, started) = std::sync::mpsc::channel();
        let (publish_tx, publish) = std::sync::mpsc::channel();
        let (drop_tx, drop_output) = std::sync::mpsc::channel();
        let registering = registry.clone();
        let registration = std::thread::spawn(move || {
            let mut worker = None;
            let result = registering.register(&receiver, || {
                worker = Some(std::thread::spawn(move || {
                    let _done = WorkerDone(done);
                    live.store(true, Ordering::Release);
                    let _output = NativeOutput(live);
                    started_tx.send(()).unwrap();
                    drop_output.recv_timeout(Duration::from_secs(5)).unwrap();
                }));
                // Keep native creation/publication in flight while restoration
                // tries to seal the registry from another thread.
                publish.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            });
            (result, worker.unwrap())
        });
        started.recv_timeout(Duration::from_secs(5)).unwrap();
        let closing = registry.clone();
        let (close_tx, close_attempt) = std::sync::mpsc::channel();
        let closer = std::thread::spawn(move || {
            close_tx.send(closing.state.try_lock().is_err()).unwrap();
            closing.begin_close();
        });
        let registration_holds_gate = close_attempt.recv_timeout(Duration::from_secs(5)).unwrap();
        publish_tx.send(()).unwrap();
        let (result, worker) = registration.join().unwrap();
        result.unwrap();
        closer.join().unwrap();
        assert!(registration_holds_gate);
        assert!(registry.is_closing());
        assert!(shutdown.load(Ordering::Acquire));
        assert!(output_live.load(Ordering::Acquire));

        let mut close = Box::pin(registry.close_current());
        assert!(pending(close.as_mut()));
        drop(close); // Tokio can cancel the host's reconfiguration here.
        let mut recovery = Box::pin(registry.close_current());
        assert!(pending(recovery.as_mut()));
        assert!(output_live.load(Ordering::Acquire));
        drop_tx.send(()).unwrap();
        worker.join().unwrap();
        recovery.await.unwrap();
        assert!(!output_live.load(Ordering::Acquire));

        let (replacement, _done) = pending_worker();
        assert!(matches!(
            registry.register(&replacement, || panic!("closed registry started a worker")),
            Err(ReceiverError::Closed)
        ));
    }

    #[tokio::test]
    async fn a_stale_closer_cannot_remove_a_replacement_workers_completion_barrier() {
        let registry = ReceiverRegistry::default();
        let (first, first_done) = pending_worker();
        registry.register(&first, || Ok(())).unwrap();
        let mut closing_first = Box::pin(registry.close_current());
        let mut stale_closer = Box::pin(registry.close_current());
        assert!(pending(closing_first.as_mut()));
        assert!(pending(stale_closer.as_mut()));
        first_done.send_replace(true);
        closing_first.await.unwrap();

        let (second, second_done) = pending_worker();
        registry.register(&second, || Ok(())).unwrap();
        stale_closer.await.unwrap();
        registry.begin_close();
        assert!(second._lease.shutdown.load(Ordering::Acquire));
        let mut closing_second = Box::pin(registry.close_current());
        assert!(pending(closing_second.as_mut()));
        second_done.send_replace(true);
        closing_second.await.unwrap();
    }
}
