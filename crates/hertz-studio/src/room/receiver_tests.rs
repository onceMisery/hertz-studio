// SPDX-License-Identifier: MIT
use super::*;
use std::cell::Cell;
use std::rc::Rc;
use uuid::Uuid;
use vmusic_audio::scheduled_output::{PresentationConsumer, PresentationTime, ScheduledPcmQueue};
use vmusic_lan::protocol::{AudioFormat, Counter};

const MS: u64 = 1_000_000;

struct FakeOutput {
    queue: ScheduledPcmQueue,
    consumer: PresentationConsumer,
    now: u64,
    valid: bool,
    ppm: f64,
    cancel_diagnostic_on_write: Option<oneshot::Receiver<Result<(), ReceiverError>>>,
    telemetry_clock: Option<Rc<Cell<u64>>>,
    clock_fault_count: u64,
    fault_on_unmute: bool,
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
            cancel_diagnostic_on_write: None,
            telemetry_clock: None,
            clock_fault_count: 0,
            fault_on_unmute: false,
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
        let callback = self.telemetry_clock.as_ref().map_or(self.now, |clock| {
            let next = clock.get() + 10 * MS;
            clock.set(next);
            next
        });
        t.last_callback_local_ns = Some(callback);
        t.last_presentation_local_ns = Some(callback + 20 * MS);
        t.device_clock_ppm = self.ppm;
        t.clock_fault_count = self.clock_fault_count;
        t.ns_per_frame = 1e9 / (f64::from(self.format().sample_rate) * (1.0 + self.ppm * 1e-6));
        t
    }
    fn clocked_cursor(&self, start: u64, period: f64) -> Result<OutputCursor, OutputError> {
        self.queue.clocked_cursor_at(start, period)
    }
    fn scheduled_cursor(&self) -> Option<OutputCursor> {
        self.queue.scheduled_cursor()
    }
    fn write(
        &mut self,
        start: u64,
        samples: &[f32],
        now: u64,
        period: f64,
    ) -> Result<OutputCursor, OutputError> {
        drop(self.cancel_diagnostic_on_write.take());
        self.queue.write_clocked_at(start, samples, now, period)?;
        self.queue
            .scheduled_cursor()
            .ok_or(OutputError::Interrupted)
    }
    fn write_finite(
        &mut self,
        start: u64,
        samples: &[f32],
        now: u64,
        period: f64,
    ) -> Result<(), OutputError> {
        drop(self.cancel_diagnostic_on_write.take());
        self.queue
            .write_finite_clocked_at(start, samples, now, period)
    }
    fn mute(&mut self) {
        self.queue.mute();
    }
    fn unmute(&mut self, start: u64, clock_fault_count: u64) -> Result<(), OutputError> {
        if self.fault_on_unmute {
            self.fault_on_unmute = false;
            self.clock_fault_count += 1;
            self.queue.mute();
        }
        if self.clock_fault_count != clock_fault_count {
            return Err(OutputError::ClockChanged);
        }
        self.queue.unmute_at(start);
        Ok(())
    }
    fn volume(&mut self, volume: f32) -> Result<(), OutputError> {
        self.queue.set_local_volume(volume)
    }
    fn silence_from(&mut self, local_ns: u64) {
        self.queue.silence_from(local_ns);
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
    engine.command(
        engine.observe(|| 0),
        Command::Mapping(mapping(0, 0.0)),
        &mut Vec::new(),
    );
    engine
}

#[test]
fn callback_snapshot_precedes_status_time_even_after_long_conversion_work() {
    let mut engine = engine();
    let clock = Rc::new(Cell::new(0));
    engine.output.as_mut().unwrap().telemetry_clock = Some(clock.clone());
    for index in 0..4_500 {
        engine.mapping = Some(mapping(clock.get(), 0.0));
        let snapshot = engine.observe(|| clock.get());
        assert_eq!(snapshot.observed_at, (index + 1) * 10 * MS);
        let status = engine.status(snapshot);
        assert!(status.output_ready, "callback {index}");
        // Readiness and device lead must use the captured callback, including
        // when another callback would advance during any second telemetry read.
        assert_eq!(clock.get(), snapshot.observed_at);
        assert_eq!(
            status.output.unwrap().last_callback_local_ns,
            Some(clock.get())
        );
    }
    // Reproduce a tick whose conversion work lasts longer than the 2ms future
    // guard. A new callback arrives before status is sampled; it belongs to the
    // new status time, not the time sampled before conversion.
    let tick_time = clock.get();
    clock.set(tick_time + 6 * MS);
    engine.mapping = Some(mapping(clock.get(), 0.0));
    let snapshot = engine.observe(|| clock.get());
    assert!(snapshot.telemetry.unwrap().last_callback_local_ns.unwrap() > tick_time + 2 * MS);
    assert!(engine.status(snapshot).output_ready);
    assert_eq!(clock.get(), tick_time + 16 * MS);

    // Causal sampling preserves all gates: stalled callbacks, truly future
    // timestamps and excessive submission lead still make output unavailable.
    let mut stale = snapshot;
    stale.observed_at += DEVICE_FRESHNESS_NS + 1;
    assert!(!engine.status(stale).output_ready);
    assert_eq!(
        engine.output_unavailable(stale),
        Some(("device_callback_age_ns", DEVICE_FRESHNESS_NS + 1))
    );
    let mut future = snapshot;
    future.observed_at -= 2 * MS + 1;
    assert!(!engine.status(future).output_ready);
    assert_eq!(
        engine.output_unavailable(future),
        Some(("device_callback_future_ns", 2 * MS + 1))
    );
    let mut excessive_lead = snapshot;
    let telemetry = excessive_lead.telemetry.as_mut().unwrap();
    telemetry.last_presentation_local_ns = telemetry
        .last_callback_local_ns
        .map(|callback| callback + MAX_DEVICE_LEAD_NS + 1);
    assert!(!engine.status(excessive_lead).output_ready);
}

#[test]
fn fractional_device_grid_hands_off_without_overlapping_the_next_epoch() {
    let nominal = 1e9 / 48_000.0;
    let (mut queue, _) = ScheduledPcmQueue::new(RenderFormat {
        sample_rate: 48_000,
        channels: 2,
    })
    .unwrap();
    queue.unmute_at(1_000_000_000);
    queue
        .write_clocked_at(1_000_000_000, &[1.0; 2], 0, 20_833.49)
        .unwrap();
    let cursor = queue.clocked_cursor_at(1_000_020_833, nominal).unwrap();
    assert_eq!(cursor.time_after(1).unwrap(), 1_000_041_667);
    let start = cursor.time_after(0).unwrap();
    let boundary = start + 10_417;
    let frames = submission_frames(cursor, 0, boundary, 48_000, 0).unwrap();
    if frames > 0 {
        queue
            .write_clocked_at(start, &vec![1.0; frames * 2], 0, nominal)
            .unwrap();
    }
    queue
        .write_clocked_at(boundary, &[2.0; 2], 0, nominal)
        .unwrap();
}

#[test]
fn consecutive_epoch_handoffs_budget_from_the_retained_device_grid() {
    let period = 20_833.0;
    let (mut queue, _) = ScheduledPcmQueue::new(RenderFormat {
        sample_rate: 48_000,
        channels: 2,
    })
    .unwrap();
    let first = 1_000_000_000;
    queue.unmute_at(first);
    queue.write_clocked_at(first, &[1.0; 2], 0, period).unwrap();
    let second = first + 20_833 - 10_000;
    let third = second + 48_000 * 20_833 - 10_000;
    let mut cursor = queue.clocked_cursor_at(second, period).unwrap();
    assert_eq!(cursor.time_after(0).unwrap(), first + 20_833);
    loop {
        let frames = submission_frames(cursor, 0, third, 48_000, 0).unwrap();
        if frames == 0 {
            break;
        }
        queue
            .write_clocked_at(
                cursor.time_after(0).unwrap(),
                &vec![1.0; frames * 2],
                0,
                period,
            )
            .unwrap();
        cursor = queue.scheduled_cursor().unwrap();
    }
    queue.write_clocked_at(third, &[2.0; 2], 0, period).unwrap();
}

#[test]
fn resync_diagnostics_survive_a_fresh_preparation() {
    let mut engine = engine();
    let mut events = Vec::new();
    engine.fail("device clock lost", &mut events);
    engine.command(
        engine.observe(|| 0),
        Command::Prepare(identity(), plan(1, 1, 1000 * MS, 0)),
        &mut events,
    );
    let status = engine.status(engine.observe(|| 0));
    assert_eq!(status.resync_count, 1);
    assert_eq!(
        status.last_resync_reason.as_deref(),
        Some("device clock lost")
    );
}

#[test]
fn native_diagnostic_is_bounded_ramped_and_silent_at_both_boundaries() {
    let mut engine = engine();
    engine.start_test_output(engine.observe(|| 0)).unwrap();
    let until = engine.test_until.unwrap();
    assert!(!engine.output_ready(engine.observe(|| 0)));
    assert!(engine.start_test_output(engine.observe(|| 0)).is_err());
    let output = engine.output.as_mut().unwrap();
    assert_eq!(output.queue.telemetry().queued_frames, 12_000);
    assert!(output.render(0, 480).iter().all(|v| *v == 0.0));
    let tone = output.render(until - 250 * MS, 12_000);
    assert!(tone.iter().any(|v| v.abs() > 0.03));
    assert!(tone.iter().all(|v| v.is_finite() && v.abs() < 0.032));
    assert_eq!(tone[0], 0.0);
    assert_eq!(tone[tone.len() - 1], 0.0);
    assert!(output.render(until, 480).iter().all(|v| *v == 0.0));
    assert_eq!(output.queue.telemetry().underrun_frames, 0);
    output.now = until;
    let mut events = Vec::new();
    engine.tick(engine.observe(|| until), &mut events);
    assert!(engine.test_until.is_none());
    assert!(engine.output_ready(engine.observe(|| until)));
    assert!(events.is_empty());
}

#[test]
fn native_diagnostic_ends_on_its_pcm_extent_with_fractional_clock_phase_slew() {
    for ppm in [-500.0, 151.260_500_040_884, 500.0] {
        for phase in [-0.49, 0.49] {
            for slew in [-1.0 / 32.0, 1.0 / 32.0] {
                let mut engine = engine();
                let now = 123_456_789;
                let output = engine.output.as_mut().unwrap();
                output.now = now;
                output.ppm = ppm;
                let period = output.telemetry().ns_per_frame;
                let start = now + engine.lead(engine.observe(|| now));
                engine.start_test_output(engine.observe(|| now)).unwrap();
                let until = engine.test_until.unwrap();
                let output = engine.output.as_mut().unwrap();
                // A run starts on the nearest physical frame. The native clock
                // can slew phase by 1/32 frame per callback without a gap; that
                // must neither truncate the tone nor append empty PCM frames.
                let first = start as f64 - (3.0 + phase) * period;
                for block in 0..50 {
                    let at = (first + block as f64 * (256.0 + slew) * period).round() as u64;
                    output.render(at, 256);
                }
                let telemetry = output.queue.telemetry();
                assert_eq!(telemetry.played_frames, 12_000);
                assert_eq!(telemetry.late_frames, 0);
                assert_eq!(telemetry.underrun_frames, 0);
                assert_eq!(telemetry.queued_frames, 0);
                assert!(output
                    .render(until + 20 * MS, 480)
                    .iter()
                    .all(|v| *v == 0.0));
            }
        }
    }
}

#[test]
fn a_room_plan_preempts_diagnostics_and_cancelled_requests_cannot_play_late() {
    let mut engine = engine();
    let (tx, rx) = oneshot::channel();
    drop(rx);
    engine.command(
        engine.observe(|| 0),
        Command::TestOutput(tx),
        &mut Vec::new(),
    );
    assert!(engine.test_until.is_none());
    engine.start_test_output(engine.observe(|| 0)).unwrap();
    let mut events = Vec::new();
    engine.command(
        engine.observe(|| 0),
        Command::Prepare(identity(), plan(1, 1, 1_000 * MS, 0)),
        &mut events,
    );
    assert!(engine.test_until.is_none());
    assert!(engine
        .output
        .as_mut()
        .unwrap()
        .render(140 * MS, 12_000)
        .iter()
        .all(|v| *v == 0.0));
    assert!(engine.start_test_output(engine.observe(|| 0)).is_err());
}

#[test]
fn cancelling_a_diagnostic_during_pcm_submission_revokes_its_future_audio() {
    let mut engine = engine();
    let (tx, rx) = oneshot::channel();
    engine.output.as_mut().unwrap().cancel_diagnostic_on_write = Some(rx);
    engine.command(
        engine.observe(|| 0),
        Command::TestOutput(tx),
        &mut Vec::new(),
    );
    assert!(engine.test_until.is_none());
    let output = engine.output.as_mut().unwrap();
    assert!(output.queue.telemetry().muted);
    assert!(output.render(140 * MS, 12_000).iter().all(|v| *v == 0.0));
}

fn pcm(engine: &Engine<FakeOutput>, epoch: u64, sequence: u64, frame: u64, frames: usize) -> Pcm {
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
        engine.command(engine.observe(|| 0), Command::Pcm(block), &mut Vec::new());
        offset += count;
        sequence += 1;
    }
}

fn prepare(engine: &mut Engine<FakeOutput>, plan: Plan) -> Vec<ReceiverEvent> {
    let mut events = Vec::new();
    engine.command(
        engine.observe(|| 0),
        Command::Prepare(identity(), plan),
        &mut events,
    );
    events
}

fn commit(engine: &mut Engine<FakeOutput>, now: u64, plan: &Plan) -> Vec<ReceiverEvent> {
    let mut events = Vec::new();
    engine.output.as_mut().unwrap().now = now;
    engine.command(
        engine.observe(|| now),
        Command::Commit {
            identity: identity(),
            epoch: plan.epoch.0,
            plan_id: plan.plan_id.0,
            effective_at: frame_time(plan.anchor_ns.0, plan.join_frame.0, plan.format.sample_rate)
                .unwrap(),
        },
        &mut events,
    );
    events
}

fn tick(engine: &mut Engine<FakeOutput>, now: u64) -> Vec<ReceiverEvent> {
    engine.output.as_mut().unwrap().now = now;
    let mut events = Vec::new();
    engine.tick(engine.observe(|| now), &mut events);
    events
}

#[test]
fn ready_never_authorizes_audio_without_commit() {
    let mut engine = engine();
    let events = prepare(&mut engine, plan(1, 10, 400 * MS, 0));
    assert!(events.is_empty());
    assert!(!engine.preparing.as_ref().unwrap().ready);
    feed(&mut engine, 1, 0, 22_050);
    assert!(engine.preparing.as_ref().unwrap().ready);
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
fn streaming_pcm_arrivals_between_ticks_do_not_manufacture_source_gaps() {
    let mut engine = engine();
    let plan = plan(1, 10, 400 * MS, 0);
    prepare(&mut engine, plan.clone());
    feed(&mut engine, 1, 0, 30_000);
    commit(&mut engine, 0, &plan);
    let mut next_frame = 30_000;
    let mut sequence = 17; // feed() used 9..=16.
    for millis in (0..=2_000).step_by(10) {
        let now = millis * MS;
        engine.output.as_mut().unwrap().now = now;
        if millis % 200 == 0 {
            engine.command(
                engine.observe(|| now),
                Command::Mapping(mapping(now, 0.0)),
                &mut Vec::new(),
            );
        }
        if millis >= 200 && millis % 20 == 0 {
            // Wire input is deliberately processed before this timer tick.
            let block = pcm(&engine, 1, sequence, next_frame, 882);
            let mut events = Vec::new();
            engine.command(engine.observe(|| now), Command::Pcm(block), &mut events);
            assert!(events.is_empty(), "{millis}: {events:?}");
            sequence += 1;
            next_frame += 882;
        }
        assert!(
            tick(&mut engine, now).is_empty(),
            "{millis}: {:?}",
            engine.last_error
        );
        engine.output.as_mut().unwrap().render(now + 20 * MS, 480);
    }
    assert_eq!(engine.gate.current_epoch(), Some(1));
    assert!(engine.last_error.is_none());
}

#[test]
fn late_join_matches_early_pcm_and_trims_only_the_prejoin_prefix() {
    let mut engine = engine();
    // Broadcast reaches the endpoint before its Prepare. Sequence 50 is
    // arbitrary and the first block straddles the eventual join boundary.
    let first = pcm(&engine, 7, 50, 17_000, 4096);
    engine.command(engine.observe(|| 0), Command::Pcm(first), &mut Vec::new());
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
    engine.command(engine.observe(|| 0), Command::Pcm(old), &mut Vec::new());
    assert_eq!(engine.preparing.as_ref().unwrap().sequence, Some(50));
    assert!(commit(&mut engine, 0, &plan).is_empty());
    tick(&mut engine, 350 * MS);
    assert!(engine.output.as_ref().unwrap().telemetry().queued_frames > 0);
}

#[test]
fn late_join_allows_a_media_anchor_older_than_the_client_clock_origin() {
    let mut engine = engine();
    let mut clock = mapping(0, 0.0);
    clock.offset_ns = 10_000 * MS as i64;
    engine.command(
        engine.observe(|| 0),
        Command::Mapping(clock),
        &mut Vec::new(),
    );
    // Host media frame 0 predates this process by one second. Only the
    // selected future join must be representable in the local clock.
    let plan = plan(7, 100, 9_000 * MS, 61_740);
    assert!(prepare(&mut engine, plan.clone()).is_empty());
    feed(&mut engine, 7, 61_740 - 128, 10_128);
    assert!(engine.preparing.as_ref().unwrap().ready);
    assert!(commit(&mut engine, 0, &plan).is_empty());
    assert_eq!(engine.preparing.as_ref().unwrap().start, 400 * MS);
    assert!(tick(&mut engine, 350 * MS).is_empty());
    assert!(engine.output.as_ref().unwrap().telemetry().queued_frames > 0);
    assert!(tick(&mut engine, 400 * MS).is_empty());
    assert_eq!(engine.gate.current_epoch(), Some(7));
    assert!(engine.last_error.is_none());
}

#[test]
fn uuid_collision_reordered_trailing_and_wrong_format_never_change_cursor() {
    let mut engine = engine();
    prepare(&mut engine, plan(1, 10, 400 * MS, 0));
    let mut wrong = pcm(&engine, 1, 1, 0, 1000);
    wrong.block.identity.session_id = Uuid::from_u128((2u128 << 64) | 7);
    engine.command(engine.observe(|| 0), Command::Pcm(wrong), &mut Vec::new());
    assert_eq!(engine.preparing.as_ref().unwrap().expected_frame, 0);
    let good = pcm(&engine, 1, 1, 0, 1000);
    engine.command(engine.observe(|| 0), Command::Pcm(good), &mut Vec::new());
    for (sequence, frame, format) in [(1, 0, 3), (0, 1000, 3), (2, 1000, 4)] {
        let mut wrong = pcm(&engine, 1, sequence, frame, 1000);
        wrong.block.format_id = format;
        engine.command(engine.observe(|| 0), Command::Pcm(wrong), &mut Vec::new());
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
    engine.command(engine.observe(|| 0), Command::Pcm(first), &mut Vec::new());
    commit(&mut engine, 0, &original);
    tick(&mut engine, 350 * MS);
    assert!(engine.output.as_ref().unwrap().telemetry().queued_frames > 0);
    let missing = pcm(&engine, 1, 3, 4096, 1000);
    let mut events = Vec::new();
    engine.command(
        engine.observe(|| 350 * MS),
        Command::Pcm(missing),
        &mut events,
    );
    assert!(matches!(events.as_slice(), [ReceiverEvent::Resync { .. }]));
    assert!(engine.output.as_ref().unwrap().telemetry().muted);
    assert_eq!(engine.output.as_ref().unwrap().telemetry().queued_frames, 0);
    assert_eq!(engine.budget.frames.load(Ordering::Acquire), 0);
    prepare(&mut engine, original);
    assert!(engine.preparing.is_none(), "old plan cannot revive");
    // Same media epoch, immutable anchor/format, increasing future join.
    let rejoin = plan(1, 11, 400 * MS, 22_050);
    let mut events = Vec::new();
    engine.command(
        engine.observe(|| 350 * MS),
        Command::Prepare(identity(), rejoin),
        &mut events,
    );
    assert!(events.is_empty());
    let block = pcm(&engine, 1, 9, 22_050 - 128, 4096);
    engine.command(
        engine.observe(|| 350 * MS),
        Command::Pcm(block),
        &mut events,
    );
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
fn recovered_clock_fault_retires_old_plans_even_when_invalid_was_never_observed() {
    for command_first in [false, true] {
        let mut engine = engine();
        let original = plan(1, 10, 400 * MS, 0);
        prepare(&mut engine, original.clone());
        feed(&mut engine, 1, 0, 30_000);
        commit(&mut engine, 0, &original);
        tick(&mut engine, 350 * MS);
        assert!(engine.output.as_ref().unwrap().telemetry().queued_frames > 0);
        // A committed preparation also holds a deferred third intent. Neither
        // may survive a native reset that completes between Receiver ticks.
        prepare(&mut engine, plan(2, 11, 900 * MS, 0));
        assert!(engine.intent.is_some());
        let output = engine.output.as_mut().unwrap();
        output.queue.mute();
        output.clock_fault_count = 1;
        output.valid = true; // Invalid -> native Reset -> eight warmups already finished
        output.now = 360 * MS;
        let snapshot = engine.observe(|| 360 * MS);
        assert_eq!(snapshot.telemetry.unwrap().clock_status, ClockStatus::Valid);
        assert!(!engine.status(snapshot).output_ready);
        let mut events = Vec::new();
        if command_first {
            engine.command(
                snapshot,
                Command::Commit {
                    identity: identity(),
                    epoch: 1,
                    plan_id: 10,
                    effective_at: 400 * MS,
                },
                &mut events,
            );
        } else {
            engine.tick(snapshot, &mut events);
        }
        assert!(matches!(events.as_slice(), [ReceiverEvent::Resync { .. }]));
        assert!(engine.current.is_none() && engine.preparing.is_none() && engine.intent.is_none());
        assert_eq!(engine.gate.current_epoch(), None);
        assert_eq!(engine.acknowledged_clock_fault_count, 1);
        assert!(engine.output.as_ref().unwrap().telemetry().muted);
        assert_eq!(engine.output.as_ref().unwrap().telemetry().queued_frames, 0);
        assert!(tick(&mut engine, 370 * MS).is_empty());
        assert!(commit(&mut engine, 370 * MS, &original).is_empty());
        assert!(engine.preparing.is_none());
        assert!(engine.output.as_ref().unwrap().telemetry().muted);

        // Only a new token and a future boundary can authorize the recovered
        // generation. Old Commit/Prepare replays cannot restore its PCM.
        let fresh = plan(2, 12, 900 * MS, 0);
        let mut events = Vec::new();
        engine.command(
            engine.observe(|| 370 * MS),
            Command::Prepare(identity(), fresh.clone()),
            &mut events,
        );
        feed(&mut engine, 2, 0, 10_000);
        tick(&mut engine, 370 * MS);
        assert!(engine.preparing.as_ref().unwrap().ready);
        assert!(engine.output.as_ref().unwrap().telemetry().muted);
        assert!(commit(&mut engine, 370 * MS, &fresh).is_empty());
        assert!(tick(&mut engine, 800 * MS).is_empty());
        assert!(engine.output.as_ref().unwrap().telemetry().queued_frames > 0);
        assert!(!engine.output.as_ref().unwrap().telemetry().muted);
    }
}

#[test]
fn fault_recovered_during_conversion_cannot_unmute_the_old_committed_plan() {
    let mut engine = engine();
    let original = plan(1, 10, 400 * MS, 0);
    prepare(&mut engine, original.clone());
    feed(&mut engine, 1, 0, 30_000);
    commit(&mut engine, 0, &original);
    engine.output.as_mut().unwrap().fault_on_unmute = true;
    let events = tick(&mut engine, 350 * MS);
    assert!(matches!(events.as_slice(), [ReceiverEvent::Resync { .. }]));
    assert_eq!(engine.acknowledged_clock_fault_count, 1);
    assert!(engine.current.is_none() && engine.preparing.is_none());
    assert!(engine.output.as_ref().unwrap().telemetry().muted);
    assert_eq!(engine.output.as_ref().unwrap().telemetry().queued_frames, 0);
}

#[test]
fn reopened_output_acknowledges_its_own_counter_origin() {
    let mut old = engine();
    old.output.as_mut().unwrap().clock_fault_count = 7;
    assert_eq!(tick(&mut old, 0).len(), 1);
    assert_eq!(old.acknowledged_clock_fault_count, 7);
    drop(old);
    // Production reopen is a new worker/Engine after the old completion
    // barrier, not replacement of an output under an existing Engine.
    let mut reopened = engine();
    assert_eq!(reopened.acknowledged_clock_fault_count, 0);
    assert!(tick(&mut reopened, 0).is_empty());
    reopened.output.as_mut().unwrap().clock_fault_count = 1;
    assert_eq!(tick(&mut reopened, 0).len(), 1);
}

#[test]
fn commit_cannot_move_the_plan_boundary_and_third_epoch_has_no_pcm() {
    let mut engine = engine();
    let first = plan(1, 10, 400 * MS, 0);
    prepare(&mut engine, first.clone());
    let mut events = Vec::new();
    engine.command(
        engine.observe(|| 0),
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
    feed(&mut engine, 1, 0, 4096);
    commit(&mut engine, 0, &first);
    tick(&mut engine, 350 * MS);
    prepare(&mut engine, plan(2, 12, 800 * MS, 0));
    let block = pcm(&engine, 2, 1, 0, 1000);
    engine.command(engine.observe(|| 0), Command::Pcm(block), &mut Vec::new());
    assert_eq!(engine.intent.as_ref().unwrap().epoch.0, 2);
    assert_eq!(engine.preparing.as_ref().unwrap().plan.epoch.0, 1);
    assert!(engine.unmatched.is_empty());
    assert_eq!(engine.budget.frames.load(Ordering::Acquire), 0);
}

#[test]
fn input_budget_includes_pending_commands_and_releases_on_drop() {
    let mut engine = engine();
    let mut pending = Vec::new();
    for sequence in 0..3 {
        pending.push(pcm(&engine, 1, sequence, sequence * 16_000, 16_000));
    }
    let block = PcmBlock {
        identity: identity(),
        epoch: 1,
        sequence: 6,
        frame_index: 48_000,
        format_id: 3,
        channels: 1,
        samples: vec![0.0; 16_000].into(),
    };
    assert!(matches!(
        Reservation::acquire(&engine.budget, &block),
        Err(ReceiverError::Capacity)
    ));
    assert_eq!(engine.budget.frames.load(Ordering::Acquire), 48_000);
    drop(pending);
    assert_eq!(engine.budget.frames.load(Ordering::Acquire), 0);
    assert_eq!(engine.budget.duration_ns.load(Ordering::Acquire), 0);
    assert_eq!(engine.budget.bytes.load(Ordering::Acquire), 0);
    let waiting = pcm(&engine, 1, 0, 0, 1000);
    engine.command(engine.observe(|| 0), Command::Pcm(waiting), &mut Vec::new());
    assert!(tick(&mut engine, 501 * MS)
        .iter()
        .any(|event| matches!(event, ReceiverEvent::Resync { .. })));
    assert_eq!(engine.budget.frames.load(Ordering::Acquire), 0);
    assert_eq!(engine.budget.duration_ns.load(Ordering::Acquire), 0);
}

#[test]
fn minimum_rate_input_budget_cannot_exceed_its_duration_even_before_matching() {
    let mut engine = engine();
    let mut pending = Vec::new();
    // Exact 200ms packets plus a final 100ms packet exercise the hard boundary
    // without depending on rounding slack or exceeding the wire packet limit.
    for sequence in 0..6 {
        pending.push(pcm(&engine, 1, sequence, sequence * 8820, 8820));
    }
    pending.push(pcm(&engine, 1, 6, 52_920, 4410));
    assert_eq!(
        engine.budget.duration_ns.load(Ordering::Acquire),
        INPUT_DURATION_LIMIT_NS
    );
    assert_eq!(engine.budget.frames.load(Ordering::Acquire), 57_330);
    let extra = PcmBlock {
        identity: identity(),
        epoch: 1,
        sequence: 7,
        frame_index: 57_330,
        format_id: 3,
        channels: 1,
        samples: vec![0.5].into(),
    };
    assert!(matches!(
        Reservation::acquire(&engine.budget, &extra),
        Err(ReceiverError::Capacity)
    ));
    prepare(&mut engine, plan(1, 10, 400 * MS, 0));
    for block in pending {
        engine.command(engine.observe(|| 0), Command::Pcm(block), &mut Vec::new());
    }
    assert_eq!(
        engine.budget.duration_ns.load(Ordering::Acquire),
        INPUT_DURATION_LIMIT_NS
    );
    // Failure drops both matched and unmatched ownership, including repriced
    // reservations; no byte, frame or duration capacity may leak.
    engine.fail("test release", &mut Vec::new());
    assert_eq!(engine.budget.frames.load(Ordering::Acquire), 0);
    assert_eq!(engine.budget.bytes.load(Ordering::Acquire), 0);
    assert_eq!(engine.budget.duration_ns.load(Ordering::Acquire), 0);
}

#[test]
fn matching_early_pcm_reprices_duration_and_byte_rejection_rolls_it_back() {
    let mut engine = engine();
    let block = pcm(&engine, 1, 0, 0, 8820);
    engine.command(engine.observe(|| 0), Command::Pcm(block), &mut Vec::new());
    assert_eq!(engine.budget.duration_ns.load(Ordering::Acquire), 200 * MS);
    let mut future = plan(1, 10, 400 * MS, 0);
    future.format.sample_rate = 192_000;
    assert!(matches!(
        prepare(&mut engine, future).as_slice(),
        [ReceiverEvent::Ready { .. }]
    ));
    assert_eq!(
        engine.budget.duration_ns.load(Ordering::Acquire),
        Reservation::duration(8820, 192_000)
    );
    let used = engine.budget.duration_ns.load(Ordering::Acquire);
    let extra = PcmBlock {
        identity: identity(),
        epoch: 1,
        sequence: 1,
        frame_index: 8820,
        format_id: 3,
        channels: 1,
        samples: vec![0.5].into(),
    };
    let bytes = engine.budget.bytes.swap(INPUT_BYTE_LIMIT, Ordering::AcqRel);
    assert!(matches!(
        Reservation::acquire(&engine.budget, &extra),
        Err(ReceiverError::Capacity)
    ));
    assert_eq!(engine.budget.duration_ns.load(Ordering::Acquire), used);
    assert_eq!(engine.budget.frames.load(Ordering::Acquire), 8820);
    engine.budget.bytes.store(bytes, Ordering::Release);
    engine.fail("test release", &mut Vec::new());
    assert_eq!(engine.budget.duration_ns.load(Ordering::Acquire), 0);
    assert_eq!(engine.budget.bytes.load(Ordering::Acquire), 0);
    assert_eq!(engine.budget.frames.load(Ordering::Acquire), 0);
}

#[test]
fn repricing_a_retired_format_reserves_any_increased_duration() {
    let mut engine = engine();
    let mut plan = plan(1, 10, 400 * MS, 0);
    plan.format.sample_rate = 192_000;
    prepare(&mut engine, plan);
    let mut pending = pcm(&engine, 1, 0, 0, 8820);
    assert_eq!(
        engine.budget.duration_ns.load(Ordering::Acquire),
        45_937_500
    );
    engine.fail("retire published format", &mut Vec::new());
    let others: Vec<_> = (0..6)
        .map(|sequence| pcm(&engine, 2, sequence, sequence * 8820, 8820))
        .collect();
    let before = engine.budget.duration_ns.load(Ordering::Acquire);
    assert!(matches!(
        pending._reservation.match_format(44_100),
        Err(ReceiverError::Capacity)
    ));
    assert_eq!(engine.budget.duration_ns.load(Ordering::Acquire), before);
    drop(others);
    pending._reservation.match_format(44_100).unwrap();
    assert_eq!(engine.budget.duration_ns.load(Ordering::Acquire), 200 * MS);
    drop(pending);
    assert_eq!(engine.budget.duration_ns.load(Ordering::Acquire), 0);
    assert_eq!(engine.budget.frames.load(Ordering::Acquire), 0);
    assert_eq!(engine.budget.bytes.load(Ordering::Acquire), 0);
}

#[test]
fn high_rate_epoch_switch_buffers_current_and_pending_candidate_without_capacity_fault() {
    let mut engine = engine();
    let mut first = plan(1, 10, 400 * MS, 0);
    first.format.sample_rate = 192_000;
    prepare(&mut engine, first.clone());
    feed(&mut engine, 1, 0, 96_000);
    assert!(commit(&mut engine, 0, &first).is_empty());
    for millis in (0..=850).step_by(10) {
        let now = millis * MS;
        assert!(
            tick(&mut engine, now).is_empty(),
            "{millis}: {:?}",
            engine.last_error
        );
        if millis == 400 {
            assert_eq!(engine.current.as_ref().unwrap().plan.epoch.0, 1);
            let mut next = plan(2, 11, 700 * MS, 0);
            next.format.sample_rate = 192_000;
            assert!(prepare(&mut engine, next.clone()).is_empty());
            let current_duration = engine.budget.duration_ns.load(Ordering::Acquire);
            let mut pending = Vec::new();
            for (sequence, frame) in (0..38_400).step_by(4096).enumerate() {
                pending.push(pcm(
                    &engine,
                    2,
                    sequence as u64,
                    frame as u64,
                    (38_400 - frame).min(4096),
                ));
            }
            assert!(engine.budget.frames.load(Ordering::Acquire) > 80_000);
            assert!(engine.budget.duration_ns.load(Ordering::Acquire) <= INPUT_DURATION_LIMIT_NS);
            // Accepted format publication prices queued commands immediately;
            // a worker scheduling delay cannot multiply the 192kHz candidate's
            // budget by the minimum-rate/actual-rate ratio.
            assert!(
                engine.budget.duration_ns.load(Ordering::Acquire)
                    <= current_duration + 200 * MS + 10
            );
            for block in pending {
                let mut events = Vec::new();
                engine.command(engine.observe(|| now), Command::Pcm(block), &mut events);
                assert!(events
                    .iter()
                    .all(|event| matches!(event, ReceiverEvent::Ready { .. })));
            }
            assert!(engine.preparing.as_ref().unwrap().ready);
            assert!(
                engine.budget.duration_ns.load(Ordering::Acquire)
                    <= current_duration + 200 * MS + 10
            );
            assert!(commit(&mut engine, now, &next).is_empty());
        }
        let at = now + 20 * MS;
        let samples = engine.output.as_mut().unwrap().render(at, 480);
        if (420 * MS..680 * MS).contains(&at) || (720 * MS..870 * MS).contains(&at) {
            assert!(samples.iter().all(|sample| *sample > 0.4), "gap at {at}");
        }
    }
    assert_eq!(engine.current.as_ref().unwrap().plan.epoch.0, 2);
    assert_eq!(
        engine.output.as_ref().unwrap().telemetry().underrun_frames,
        0
    );
    assert!(engine.last_error.is_none());
    engine.fail("test release", &mut Vec::new());
    assert_eq!(engine.budget.duration_ns.load(Ordering::Acquire), 0);
    assert_eq!(engine.budget.frames.load(Ordering::Acquire), 0);
    assert_eq!(engine.budget.bytes.load(Ordering::Acquire), 0);
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
    assert!(
        epoch
            .next_time(48_000)
            .unwrap()
            .abs_diff(400 * MS + epoch.output_frames * 1_000_000_000 / 48_000)
            <= 1
    );
    engine.command(
        engine.observe(|| 350 * MS),
        Command::Mapping(mapping(350 * MS, 300.0)),
        &mut Vec::new(),
    );
    engine.output.as_mut().unwrap().ppm = 500.0;
    tick(&mut engine, 370 * MS);
    let epoch = engine.preparing.as_ref().unwrap();
    assert!(
        epoch.next_time(48_000).unwrap() < 400 * MS + epoch.output_frames * 1_000_000_000 / 48_000
    );
    assert!(engine.last_error.is_none());
}

#[test]
fn internal_fault_does_not_revoke_commands_after_explicit_invalidation() {
    let generation = AtomicU64::new(4);
    assert_eq!(revoke_generation(&generation, 4), 5);
    // invalidate() and a fresh Prepare raced an old in-flight conversion.
    generation.store(6, Ordering::Release);
    assert_eq!(revoke_generation(&generation, 5), 6);
    assert_eq!(generation.load(Ordering::Acquire), 6);
}

fn queued_handle(engine: &Engine<FakeOutput>) -> (ReceiverHandle, mpsc::Receiver<Envelope>) {
    let (commands, inbox) = mpsc::channel(COMMAND_CAPACITY);
    let (_status, status) = watch::channel(engine.status(engine.observe(|| 0)));
    let (_done, done) = watch::channel(false);
    let emergency = Arc::new(Mutex::new(None));
    (
        ReceiverHandle {
            commands,
            trip: Arc::new(AtomicBool::new(false)),
            invalidated: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
            emergency: emergency.clone(),
            disconnected: Arc::new(AtomicBool::new(false)),
            budget: engine.budget.clone(),
            status,
            done,
            _lease: Arc::new(Lease {
                shutdown: Arc::new(AtomicBool::new(false)),
                emergency,
            }),
        },
        inbox,
    )
}

#[test]
fn accepted_volume_survives_native_fault_before_dispatch_and_silences_fresh_pcm() {
    let mut engine = engine();
    let original = plan(1, 10, 400 * MS, 0);
    prepare(&mut engine, original.clone());
    feed(&mut engine, 1, 0, 30_000);
    commit(&mut engine, 0, &original);
    let (handle, mut inbox) = queued_handle(&engine);
    // The caller may persist zero after this succeeds. Native recovery finishes
    // before dispatch, so the volume command itself first discovers the fault.
    handle.set_volume(0.0).unwrap();
    engine.output.as_mut().unwrap().clock_fault_count = 1;
    let mut events = Vec::new();
    let command = inbox.try_recv().unwrap().into_command(0).unwrap();
    engine.command(engine.observe(|| 0), command, &mut events);
    assert!(matches!(events.as_slice(), [ReceiverEvent::Resync { .. }]));
    assert!(engine.preparing.is_none());
    assert_eq!(engine.volume, 0.0);

    let fresh = plan(2, 11, 900 * MS, 0);
    prepare(&mut engine, fresh.clone());
    feed(&mut engine, 2, 0, 10_000);
    commit(&mut engine, 0, &fresh);
    assert!(tick(&mut engine, 800 * MS).is_empty());
    let output = engine.output.as_mut().unwrap();
    assert!(!output.telemetry().muted);
    assert!(output
        .render(900 * MS, 480)
        .iter()
        .all(|sample| *sample == 0.0));
    assert_eq!(output.telemetry().played_frames, 480);
}

#[test]
fn accepted_volumes_keep_fifo_order_when_media_generations_are_revoked() {
    for cause in ["internal fault", "invalidate", "backpressure"] {
        let mut engine = engine();
        let (handle, mut inbox) = queued_handle(&engine);
        handle
            .prepare(identity(), plan(1, 10, 400 * MS, 0))
            .unwrap();
        handle.set_volume(0.75).unwrap();
        handle.set_volume(0.0).unwrap();
        let mut events = Vec::new();
        let active = match cause {
            "internal fault" => {
                engine.fail(cause, &mut events);
                revoke_generation(&handle.generation, 0)
            }
            "invalidate" => {
                handle.invalidate();
                engine.fail(cause, &mut events);
                handle.generation.load(Ordering::Acquire)
            }
            "backpressure" => {
                while handle.commands.capacity() > 0 {
                    handle.mapping(mapping(0, 0.0)).unwrap();
                }
                assert!(matches!(
                    handle.set_volume(1.0),
                    Err(ReceiverError::Capacity)
                ));
                assert!(handle.trip.load(Ordering::Acquire));
                engine.fail(cause, &mut events);
                handle.generation.load(Ordering::Acquire)
            }
            _ => unreachable!(),
        };
        let mut applied = Vec::new();
        while let Ok(envelope) = inbox.try_recv() {
            if let Some(command) = envelope.into_command(active) {
                engine.command(engine.observe(|| 0), command, &mut events);
                applied.push(engine.volume);
            }
        }
        assert_eq!(applied, [0.75, 0.0], "{cause}");
        assert!(engine.preparing.is_none(), "old media remains revoked");
        // Verify the actual consumer gain, not merely Engine's stored value.
        let output = engine.output.as_mut().unwrap();
        output.queue.unmute_at(10 * MS);
        output.queue.write_at(10 * MS, &[1.0; 960], 0).unwrap();
        assert!(output
            .render(10 * MS, 480)
            .iter()
            .all(|sample| *sample == 0.0));
        assert_eq!(output.telemetry().played_frames, 480);
    }
}

#[tokio::test]
async fn shutdown_completes_after_output_drop_while_other_handle_clones_live() {
    struct OutputDropped(Arc<AtomicBool>);
    impl Drop for OutputDropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    let shutdown = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicBool::new(false));
    let emergency = Arc::new(Mutex::new(None));
    let (commands, _inbox) = mpsc::channel(1);
    let engine = engine();
    let (_status, status) = watch::channel(engine.status(engine.observe(|| 0)));
    let (done_tx, done) = watch::channel(false);
    let handle = ReceiverHandle {
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
            shutdown: shutdown.clone(),
            emergency,
        }),
    };
    let registry_clone = handle.clone();
    let completion_clone = handle.clone();
    let output_dropped = dropped.clone();
    let worker = std::thread::spawn(move || {
        let _done = WorkerDone(done_tx);
        let _output = OutputDropped(output_dropped);
        while !shutdown.load(Ordering::Acquire) {
            std::thread::park_timeout(Duration::from_millis(1));
        }
    });
    handle.shutdown().await.unwrap();
    assert!(dropped.load(Ordering::Acquire));
    assert!(*registry_clone.done.borrow());
    completion_clone.wait_closed().await.unwrap();
    worker.join().unwrap();
}

#[test]
fn late_join_requires_real_complete_history_and_future_pcm_before_ready() {
    let mut missing = engine();
    prepare(&mut missing, plan(1, 10, 0, 22_050));
    // A post-join suffix alone cannot silently use zero history.
    let block = pcm(&missing, 1, 8, 22_050, 2000);
    missing.command(missing.observe(|| 0), Command::Pcm(block), &mut Vec::new());
    assert!(!missing.preparing.as_ref().unwrap().ready);
    assert!(!missing.preparing.as_ref().unwrap().history_primed);
    // Rewinding the broadcast sequence to retrieve history is forbidden.
    let old = pcm(&missing, 1, 7, 22_050 - 128, 128);
    missing.command(missing.observe(|| 0), Command::Pcm(old), &mut Vec::new());
    assert!(!missing.preparing.as_ref().unwrap().ready);
    let mut engine = engine();
    prepare(&mut engine, plan(1, 10, 0, 22_050));
    let history = pcm(&engine, 1, 8, 22_050 - 128, 128);
    engine.command(engine.observe(|| 0), Command::Pcm(history), &mut Vec::new());
    assert!(!engine.preparing.as_ref().unwrap().ready);
    assert_eq!(engine.preparing.as_ref().unwrap().sequence, None);
    let future = pcm(&engine, 1, 9, 22_050, 2000);
    let mut events = Vec::new();
    engine.command(engine.observe(|| 0), Command::Pcm(future), &mut events);
    assert!(matches!(events.as_slice(), [ReceiverEvent::Ready { .. }]));
    let epoch = engine.preparing.as_ref().unwrap();
    assert!(epoch.history.iter().all(|sample| *sample == 0.5));
    assert!(epoch.history_primed);
    assert_eq!(epoch.converter.counts(), (0, 0));
}

#[test]
fn speculative_prepares_cannot_evict_the_current_epoch_contract() {
    let mut engine = engine();
    let initial = plan(1, 10, 400 * MS, 0);
    prepare(&mut engine, initial.clone());
    feed(&mut engine, 1, 0, 30_000);
    commit(&mut engine, 0, &initial);
    tick(&mut engine, 400 * MS);
    assert_eq!(engine.current.as_ref().unwrap().plan.epoch.0, 1);
    for epoch in 2..=5 {
        let future = plan(epoch, 10 + epoch, 1000 * MS, 0);
        engine.command(
            engine.observe(|| 400 * MS),
            Command::Prepare(identity(), future),
            &mut Vec::new(),
        );
    }
    assert!(engine.contracts.iter().any(|(epoch, ..)| *epoch == 1));
    let mut changed = plan(1, 20, 400 * MS, 44_100);
    changed.format.sample_rate = 48_000;
    let mut events = Vec::new();
    engine.command(
        engine.observe(|| 400 * MS),
        Command::Prepare(identity(), changed),
        &mut events,
    );
    assert!(matches!(events.as_slice(), [ReceiverEvent::Resync { .. }]));
    assert!(engine.output.as_ref().unwrap().telemetry().muted);
}

#[test]
fn pending_suspend_is_frozen_and_does_not_require_pcm_ready() {
    for changed in [false, true] {
        let mut engine = engine();
        let mut events = Vec::new();
        let suspend = |id, at| Command::Suspend {
            identity: identity(),
            epoch: 2,
            plan_id: id,
            effective_at: at,
        };
        engine.command(engine.observe(|| 0), suspend(10, 400 * MS), &mut events);
        assert!(events.is_empty());
        assert!(engine.suspension.is_some());
        engine.command(engine.observe(|| 0), suspend(10, 400 * MS), &mut events);
        assert!(events.is_empty());
        engine.command(
            engine.observe(|| 0),
            suspend(if changed { 11 } else { 10 }, 500 * MS),
            &mut events,
        );
        assert!(matches!(events.as_slice(), [ReceiverEvent::Resync { .. }]));
        assert!(engine.suspension.is_none());
    }
    let mut engine = engine();
    engine.command(
        engine.observe(|| 0),
        Command::Suspend {
            identity: identity(),
            epoch: 2,
            plan_id: 10,
            effective_at: 400 * MS,
        },
        &mut Vec::new(),
    );
    assert!(tick(&mut engine, 400 * MS).is_empty());
    assert!(engine.suspension.is_none());
    assert_eq!(engine.epoch_floor, 2);
    assert!(engine.output.as_ref().unwrap().telemetry().muted);
}

#[test]
fn deferred_intents_recheck_the_epoch_floor_after_suspend_and_commit() {
    for suspend in [true, false] {
        let mut engine = engine();
        let first = plan(1, 10, 400 * MS, 0);
        prepare(&mut engine, first.clone());
        feed(&mut engine, 1, 0, 30_000);
        commit(&mut engine, 0, &first);
        assert!(tick(&mut engine, 400 * MS).is_empty());
        assert_eq!(engine.epoch_floor, 1);
        let mut events = Vec::new();
        if suspend {
            engine.command(
                engine.observe(|| 400 * MS),
                Command::Suspend {
                    identity: identity(),
                    epoch: 2,
                    plan_id: 11,
                    effective_at: 700 * MS,
                },
                &mut events,
            );
        } else {
            let next = plan(2, 11, 700 * MS, 0);
            engine.command(
                engine.observe(|| 400 * MS),
                Command::Prepare(identity(), next.clone()),
                &mut events,
            );
            let block = pcm(&engine, 2, 0, 0, 4096);
            engine.command(
                engine.observe(|| 400 * MS),
                Command::Pcm(block),
                &mut events,
            );
            assert!(engine.preparing.as_ref().unwrap().ready);
            assert!(commit(&mut engine, 400 * MS, &next).is_empty());
        }
        let stale = plan(1, 12, 400 * MS, 22_050);
        engine.command(
            engine.observe(|| 400 * MS),
            Command::Prepare(identity(), stale.clone()),
            &mut events,
        );
        assert_eq!(engine.intent.as_ref().unwrap().epoch.0, 1);
        // Continue the native worker/callback lifecycle through the handoff.
        // Jumping 300ms without ticks cannot complete a bounded conversion or
        // authorize discarding the old device owner at the switch deadline.
        for millis in (400..700).step_by(10) {
            let now = millis * MS;
            if millis > 400 {
                assert!(tick(&mut engine, now).is_empty(), "{:?}", engine.last_error);
            }
            engine.output.as_mut().unwrap().render(now, 480);
        }
        assert!(tick(&mut engine, 700 * MS).is_empty());
        assert_eq!(engine.epoch_floor, 2);
        assert!(engine.intent.is_none());
        assert!(
            engine.preparing.is_none(),
            "stale intent must not be installed"
        );
        assert_eq!(
            engine.current.as_ref().map(|p| p.plan.epoch.0),
            (!suspend).then_some(2)
        );
        events.clear();
        // Even complete, newer wire PCM and Commit cannot revive the old
        // intent after promotion raises the session's accepted epoch.
        let old_pcm = pcm(&engine, 1, 100, 22_050 - 128, 4096);
        engine.command(
            engine.observe(|| 700 * MS),
            Command::Pcm(old_pcm),
            &mut events,
        );
        events.extend(commit(&mut engine, 700 * MS, &stale));
        assert!(events.is_empty());
        assert!(engine.preparing.is_none());
        if suspend {
            assert!(engine.output.as_ref().unwrap().telemetry().muted);
        }
        // A genuinely future generation still prepares normally.
        engine.command(
            engine.observe(|| 700 * MS),
            Command::Prepare(identity(), plan(3, 13, 1100 * MS, 0)),
            &mut events,
        );
        let fresh = pcm(&engine, 3, 0, 0, 4096);
        engine.command(
            engine.observe(|| 700 * MS),
            Command::Pcm(fresh),
            &mut events,
        );
        assert!(matches!(
            events.as_slice(),
            [ReceiverEvent::Ready {
                epoch: 3,
                plan_id: 13
            }]
        ));
    }
}

#[test]
fn scheduled_pause_keeps_its_complete_tail_and_a_fresh_run_can_resume() {
    let mut engine = engine();
    let first = plan(1, 10, 400 * MS, 0);
    prepare(&mut engine, first.clone());
    // Producer ends exactly at the 700ms boundary, with no future PCM
    // available to satisfy the converter's final 128-frame lookahead.
    feed(&mut engine, 1, 0, 13_230);
    commit(&mut engine, 0, &first);
    engine.command(
        engine.observe(|| 0),
        Command::Suspend {
            identity: identity(),
            epoch: 2,
            plan_id: 11,
            effective_at: 700 * MS,
        },
        &mut Vec::new(),
    );
    for millis in (0..=700).step_by(10) {
        let now = millis * MS;
        assert!(tick(&mut engine, now).is_empty(), "{:?}", engine.last_error);
        let at = now + 20 * MS;
        let samples = engine.output.as_mut().unwrap().render(at, 480);
        if (400 * MS..700 * MS).contains(&at) {
            assert!(samples.iter().all(|sample| *sample > 0.4));
        } else {
            assert!(samples.iter().all(|sample| *sample == 0.0));
        }
    }
    assert_eq!(
        engine.output.as_ref().unwrap().telemetry().underrun_frames,
        0
    );
    assert!(engine.current.is_none());
    assert!(engine.preparing.is_none());
    let next = plan(3, 12, 1100 * MS, 0);
    engine.command(
        engine.observe(|| 700 * MS),
        Command::Prepare(identity(), next.clone()),
        &mut Vec::new(),
    );
    let block = pcm(&engine, 3, 0, 0, 16_000);
    engine.command(
        engine.observe(|| 700 * MS),
        Command::Pcm(block),
        &mut Vec::new(),
    );
    assert!(engine.preparing.as_ref().unwrap().ready);
    assert!(commit(&mut engine, 700 * MS, &next).is_empty());
    for millis in (710..=1140).step_by(10) {
        let now = millis * MS;
        assert!(tick(&mut engine, now).is_empty(), "{:?}", engine.last_error);
        let at = now + 20 * MS;
        let samples = engine.output.as_mut().unwrap().render(at, 480);
        if at < 1100 * MS {
            assert!(samples.iter().all(|sample| *sample == 0.0));
        } else {
            assert!(samples.iter().all(|sample| *sample > 0.4));
        }
    }
    assert_eq!(engine.current.as_ref().unwrap().plan.epoch.0, 3);
}

#[test]
fn published_eof_never_zero_fills_a_missing_real_source_frame() {
    let mut engine = engine();
    let first = plan(1, 10, 400 * MS, 0);
    prepare(&mut engine, first.clone());
    feed(&mut engine, 1, 0, 13_229); // EOF needs 13_230 real frames.
    commit(&mut engine, 0, &first);
    engine.command(
        engine.observe(|| 0),
        Command::Suspend {
            identity: identity(),
            epoch: 2,
            plan_id: 11,
            effective_at: 700 * MS,
        },
        &mut Vec::new(),
    );
    let mut faulted = false;
    for millis in (0..700).step_by(10) {
        let now = millis * MS;
        let events = tick(&mut engine, now);
        if !events.is_empty() {
            assert!(matches!(events.as_slice(), [ReceiverEvent::Resync { .. }]));
            assert!(engine.last_error.as_ref().unwrap().contains("underrun"));
            faulted = true;
            break;
        }
        engine.output.as_mut().unwrap().render(now + 20 * MS, 480);
    }
    assert!(faulted);
    assert!(engine.output.as_ref().unwrap().telemetry().muted);
}

#[test]
fn ordinary_epoch_switch_flushes_the_complete_old_source_tail() {
    let mut engine = engine();
    let first = plan(1, 10, 400 * MS, 0);
    prepare(&mut engine, first.clone());
    feed(&mut engine, 1, 0, 13_230);
    commit(&mut engine, 0, &first);
    for millis in (0..=850).step_by(10) {
        let now = millis * MS;
        assert!(tick(&mut engine, now).is_empty(), "{:?}", engine.last_error);
        if now == 400 * MS {
            let next = plan(2, 11, 700 * MS, 0);
            engine.command(
                engine.observe(|| now),
                Command::Prepare(identity(), next.clone()),
                &mut Vec::new(),
            );
            let block = pcm(&engine, 2, 0, 0, 16_000);
            engine.command(engine.observe(|| now), Command::Pcm(block), &mut Vec::new());
            assert!(engine.preparing.as_ref().unwrap().ready);
            assert!(commit(&mut engine, now, &next).is_empty());
        }
        let at = now + 20 * MS;
        let samples = engine.output.as_mut().unwrap().render(at, 480);
        if at >= 400 * MS {
            assert!(
                samples.iter().all(|sample| *sample > 0.4),
                "tail gap at {at}"
            );
        }
    }
    assert_eq!(
        engine.output.as_ref().unwrap().telemetry().underrun_frames,
        0
    );
    assert_eq!(engine.current.as_ref().unwrap().plan.epoch.0, 2);
}

#[test]
fn consecutive_engine_switches_transfer_the_retained_grid_and_retire_predecessors() {
    let mut engine = engine();
    let period = 20_833u64;
    engine.output.as_mut().unwrap().ppm = (1e9 / (48_000.0 * period as f64) - 1.0) * 1e6;
    let start = 400 * MS;
    let retained_second = start + 14_400 * period;
    let second = retained_second - 10_000;
    let third = second + 48_000 * period - 10_000;
    let mut first_plan = plan(1, 10, start, 0);
    first_plan.format.sample_rate = 48_000;
    prepare(&mut engine, first_plan.clone());
    feed(&mut engine, 1, 0, 14_399);
    assert!(commit(&mut engine, 0, &first_plan).is_empty());
    let mut retired = None;
    let mut handoffs = 0;
    for millis in (0..=1850).step_by(10) {
        let now = millis * MS;
        assert!(
            tick(&mut engine, now).is_empty(),
            "{millis}: {:?}",
            engine.last_error
        );
        if let Some(candidate) = engine
            .preparing
            .as_ref()
            .filter(|epoch| epoch.output_frames > 0)
        {
            if let Some(current) = engine.current.as_ref() {
                let state = (current.plan.epoch.0, current.output_frames);
                if let Some(previous) =
                    retired.filter(|previous: &(u64, u64)| previous.0 == state.0)
                {
                    assert_eq!(state, previous, "retired predecessor appended PCM");
                } else {
                    retired = Some(state);
                    handoffs += 1;
                    let expected = if state.0 == 1 { 14_400 } else { 47_999 };
                    assert_eq!(current.output_frames, expected);
                    assert!(
                        current.pcm.is_empty(),
                        "all real predecessor frames must be consumed"
                    );
                    assert_eq!(
                        current.expected_frame,
                        if state.0 == 1 { 14_399 } else { 47_998 }
                    );
                }
                let actual_start = candidate.next_output_ns - candidate.output_frames * period;
                assert_eq!(
                    actual_start,
                    if candidate.plan.epoch.0 == 2 {
                        retained_second
                    } else {
                        retained_second + 47_999 * period
                    }
                );
                assert_eq!(
                    candidate.next_output_ns,
                    engine
                        .output
                        .as_ref()
                        .unwrap()
                        .queue
                        .scheduled_cursor()
                        .unwrap()
                        .time_after(0)
                        .unwrap()
                );
            }
        }
        if now == 400 * MS || now == 1000 * MS {
            let (epoch, boundary, frames) = if now == 400 * MS {
                (2, second, 47_998)
            } else {
                (3, third, 16_000)
            };
            let mut next = plan(epoch, epoch + 9, boundary, 0);
            next.format.sample_rate = 48_000;
            engine.command(
                engine.observe(|| now),
                Command::Prepare(identity(), next.clone()),
                &mut Vec::new(),
            );
            for (sequence, frame) in (0..frames).step_by(4096).enumerate() {
                let block = pcm(
                    &engine,
                    epoch,
                    sequence as u64,
                    frame as u64,
                    (frames - frame).min(4096),
                );
                engine.command(engine.observe(|| now), Command::Pcm(block), &mut Vec::new());
            }
            assert!(engine.preparing.as_ref().unwrap().ready);
            assert!(commit(&mut engine, now, &next).is_empty());
        }
        if now >= start {
            let expected_epoch = if now < second {
                1
            } else if now < third {
                2
            } else {
                3
            };
            assert_eq!(
                engine.current.as_ref().unwrap().plan.epoch.0,
                expected_epoch
            );
        }
        let at = now + 20 * MS;
        let samples = engine.output.as_mut().unwrap().render(at, 480);
        if at >= start && at.abs_diff(second) > 20 * MS && at.abs_diff(third) > 20 * MS {
            assert!(samples.iter().all(|sample| *sample > 0.4), "gap at {at}");
        }
    }
    assert_eq!(handoffs, 2);
    assert_eq!(engine.current.as_ref().unwrap().plan.epoch.0, 3);
    let telemetry = engine.output.as_ref().unwrap().telemetry();
    assert_eq!(telemetry.underrun_frames, 0);
    assert_eq!(telemetry.late_frames, 0);
    assert_eq!(engine.faults, 0);
}

#[test]
fn a_committed_successor_cannot_hide_a_missing_real_predecessor_tail() {
    let mut engine = engine();
    let first = plan(1, 10, 400 * MS, 0);
    prepare(&mut engine, first.clone());
    feed(&mut engine, 1, 0, 13_229); // The 700ms EOF needs 13_230 real frames.
    assert!(commit(&mut engine, 0, &first).is_empty());
    for millis in (0..=600).step_by(10) {
        let now = millis * MS;
        assert!(tick(&mut engine, now).is_empty(), "{:?}", engine.last_error);
        if now == 400 * MS {
            let next = plan(2, 11, 700 * MS, 0);
            engine.command(
                engine.observe(|| now),
                Command::Prepare(identity(), next.clone()),
                &mut Vec::new(),
            );
            let block = pcm(&engine, 2, 0, 0, 16_000);
            engine.command(engine.observe(|| now), Command::Pcm(block), &mut Vec::new());
            assert!(commit(&mut engine, now, &next).is_empty());
        }
        engine.output.as_mut().unwrap().render(now + 20 * MS, 480);
    }
    assert!(engine.preparing.as_ref().unwrap().committed);
    assert_eq!(engine.preparing.as_ref().unwrap().output_frames, 0);
    let output = engine.output.as_mut().unwrap();
    output.render(630 * MS, 3_360);
    assert!(output.telemetry().underrun_frames > 0);
    let events = tick(&mut engine, 610 * MS);
    assert!(matches!(events.as_slice(), [ReceiverEvent::Resync { .. }]));
    assert!(engine.last_error.as_ref().unwrap().contains("underrun"));
    assert!(engine.output.as_ref().unwrap().telemetry().muted);
}

#[test]
fn slow_device_midpoints_prequeue_a_successor_on_the_retained_grid() {
    for (ppm, boundary) in [(-500.0, 700_139_653), (-150.0, 700_034_588)] {
        let mut engine = engine();
        engine.output.as_mut().unwrap().ppm = ppm;
        let first = plan(1, 10, 400 * MS, 0);
        prepare(&mut engine, first.clone());
        let real_frames = ((boundary - 400 * MS) as u128 * 44_100 / 1_000_000_000) as usize;
        feed(&mut engine, 1, 0, real_frames);
        assert!(commit(&mut engine, 0, &first).is_empty());
        for millis in (0..=850).step_by(10) {
            let now = millis * MS;
            assert!(
                tick(&mut engine, now).is_empty(),
                "{ppm}/{millis}: {:?}",
                engine.last_error
            );
            if now == 400 * MS {
                let next = plan(2, 11, boundary, 0);
                engine.command(
                    engine.observe(|| now),
                    Command::Prepare(identity(), next.clone()),
                    &mut Vec::new(),
                );
                let block = pcm(&engine, 2, 0, 0, 16_000);
                engine.command(engine.observe(|| now), Command::Pcm(block), &mut Vec::new());
                assert!(commit(&mut engine, now, &next).is_empty());
            }
            if now == 610 * MS {
                assert!(
                    engine.preparing.as_ref().unwrap().output_frames > 0,
                    "no midpoint owner at {ppm}ppm"
                );
                assert_eq!(
                    engine.current.as_ref().unwrap().expected_frame,
                    real_frames as u64
                );
            }
            engine.output.as_mut().unwrap().render(now + 20 * MS, 480);
        }
        assert_eq!(engine.current.as_ref().unwrap().plan.epoch.0, 2);
        assert_eq!(
            engine.output.as_ref().unwrap().telemetry().underrun_frames,
            0
        );
    }
}

#[test]
fn an_early_metadata_switch_cannot_retire_an_incomplete_device_tail() {
    let mut engine = engine();
    let first = plan(1, 10, 400 * MS, 0);
    prepare(&mut engine, first.clone());
    feed(&mut engine, 1, 0, 13_229);
    assert!(commit(&mut engine, 0, &first).is_empty());
    for millis in (0..=660).step_by(10) {
        let now = millis * MS;
        assert!(
            tick(&mut engine, now).is_empty(),
            "{millis}: {:?}",
            engine.last_error
        );
        if now == 400 * MS {
            let next = plan(2, 11, 700 * MS, 0);
            engine.command(
                engine.observe(|| now),
                Command::Prepare(identity(), next.clone()),
                &mut Vec::new(),
            );
            let block = pcm(&engine, 2, 0, 0, 16_000);
            engine.command(engine.observe(|| now), Command::Pcm(block), &mut Vec::new());
            assert!(commit(&mut engine, now, &next).is_empty());
        }
        engine.output.as_mut().unwrap().render(now + 20 * MS, 480);
    }
    assert_eq!(
        engine.output.as_ref().unwrap().telemetry().underrun_frames,
        0
    );
    assert_eq!(engine.preparing.as_ref().unwrap().output_frames, 0);
    let mut updated = mapping(697 * MS, 0.0);
    updated.offset_ns = 3 * MS as i64;
    engine.command(
        engine.observe(|| 697 * MS),
        Command::Mapping(updated),
        &mut Vec::new(),
    );
    let events = tick(&mut engine, 697 * MS);
    assert!(
        matches!(events.as_slice(), [ReceiverEvent::Resync { .. }]),
        "{:?}",
        engine.last_error
    );
    assert!(engine.output.as_ref().unwrap().telemetry().muted);
    assert!(
        engine.last_error.as_ref().unwrap().contains("handoff")
            || engine.last_error.as_ref().unwrap().contains("source gap")
    );
}

#[test]
fn pending_suspend_caps_metadata_at_real_eof_after_small_mapping_updates() {
    for stop in [700 * MS, 700 * MS + 12_345] {
        let mut engine = engine();
        let first = plan(1, 10, 400 * MS, 0);
        prepare(&mut engine, first.clone());
        let frames = ((stop - 400 * MS) as u128 * 44_100 / 1_000_000_000) as usize;
        feed(&mut engine, 1, 0, frames);
        commit(&mut engine, 0, &first);
        engine.command(
            engine.observe(|| 0),
            Command::Suspend {
                identity: identity(),
                epoch: 2,
                plan_id: 11,
                effective_at: stop,
            },
            &mut Vec::new(),
        );
        for millis in 0..=702 {
            let now = millis * MS;
            if millis == 600 {
                let mut updated = mapping(now, 0.0);
                updated.offset_ns = 2 * MS as i64;
                engine.command(
                    engine.observe(|| now),
                    Command::Mapping(updated),
                    &mut Vec::new(),
                );
            }
            assert!(
                tick(&mut engine, now).is_empty(),
                "stop {stop}, now {now}: {:?}",
                engine.last_error
            );
            engine.output.as_mut().unwrap().render(now + 20 * MS, 48);
        }
        assert_eq!(engine.epoch_floor, 2);
        assert_eq!(
            engine.output.as_ref().unwrap().telemetry().underrun_frames,
            0
        );
        assert!(engine.last_error.is_none());
        assert!(engine.output.as_ref().unwrap().telemetry().muted);
    }
}

#[test]
fn accumulated_small_mapping_offsets_revoke_a_frozen_sample_grid() {
    let mut engine = engine();
    let plan = plan(1, 10, 400 * MS, 0);
    prepare(&mut engine, plan.clone());
    feed(&mut engine, 1, 0, 30_000);
    commit(&mut engine, 0, &plan);
    tick(&mut engine, 350 * MS);
    for step in 1..=13 {
        let mut clock = mapping(350 * MS, 0.0);
        clock.offset_ns = step * 240_000;
        let mut events = Vec::new();
        engine.command(
            engine.observe(|| 350 * MS),
            Command::Mapping(clock),
            &mut events,
        );
        events.extend(tick(&mut engine, 350 * MS));
        if step <= 12 {
            assert!(events.is_empty(), "step {step}: {:?}", engine.last_error);
        } else {
            assert!(matches!(events.as_slice(), [ReceiverEvent::Resync { .. }]));
            assert!(engine.output.as_ref().unwrap().telemetry().muted);
            assert!(engine
                .last_error
                .as_ref()
                .unwrap()
                .contains("phase diverged"));
        }
    }
}

#[test]
fn eight_virtual_hours_keep_a_measured_device_cursor_and_queue_bounded() {
    // Production cursor + submission policy, virtual 48kHz hardware counts.
    // Avoid billions of sinc operations; separate converter/consumer tests
    // cover real samples and the output queue over the same duration.
    for ppm in [-500.0, 500.0] {
        let period = 1e9 / (48_000.0 * (1.0 + ppm * 1e-6));
        let (queue, _) = ScheduledPcmQueue::new(RenderFormat {
            sample_rate: 48_000,
            channels: 2,
        })
        .unwrap();
        let mut cursor = queue.clocked_cursor_at(400 * MS, period).unwrap();
        let mut submitted = 0u64;
        let mut phase = 0.0;
        let ratio = 1.0 + relative_drift_ppm(0.0, ppm).unwrap() * 1e-6;
        let mut max_queue = 0;
        for tick in 0..=2_880_000u64 {
            let now = tick * 10 * MS;
            let hardware = (now.saturating_sub(400 * MS) as f64 / period).floor() as u64;
            assert!(hardware <= submitted, "underrun at {now}, ppm {ppm}");
            let mut queued = (submitted - hardware) as usize;
            let horizon = now + 100 * MS;
            loop {
                let frames = submission_frames(cursor, now, horizon, 48_000, queued).unwrap();
                if frames == 0 {
                    break;
                }
                cursor = cursor.advanced(frames as u64).unwrap();
                submitted += frames as u64;
                queued += frames;
                phase += frames as f64 * ratio;
            }
            max_queue = max_queue.max(queued);
            assert!(queued <= 4_804);
            if now >= 400 * MS {
                assert!(queued > 4_300);
                assert!(cursor.time_after(0).unwrap() <= horizon + period.ceil() as u64);
                // A slowly revised offset remains below the 3ms rejoin
                // threshold; adjacent mapping steps are under 10ns.
                let offset = (tick as f64 / 300_000.0).sin() * 2_000_000.0;
                let actual_ns = phase * 1e9 / 48_000.0;
                let mapped_ns = (cursor.time_after(0).unwrap() - 400 * MS) as f64 + offset;
                assert!((actual_ns - mapped_ns).abs() < MAX_PHASE_ERROR_NS);
            }
        }
        assert!(max_queue >= 4_790);
    }
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
            engine.command(engine.observe(|| 0), Command::Pcm(block), &mut Vec::new());
        }
        commit(&mut engine, 0, &plan);
        let output = engine.output.as_mut().unwrap();
        output.ppm = device_ppm;
        let epoch = engine.preparing.as_mut().unwrap();
        for _ in 0..64 {
            epoch
                .submit(
                    output,
                    mapping(0, 0.0),
                    OutputSnapshot {
                        telemetry: Some(output.telemetry()),
                        observed_at: 0,
                        capture_span_ns: 0,
                    },
                    1500 * MS,
                    None,
                    None,
                )
                .unwrap();
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
