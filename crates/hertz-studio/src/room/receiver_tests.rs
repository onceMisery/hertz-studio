// SPDX-License-Identifier: MIT
use super::*;
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
    fn write(
        &mut self,
        start: u64,
        samples: &[f32],
        now: u64,
        period: f64,
    ) -> Result<(), OutputError> {
        self.queue.write_clocked_at(start, samples, now, period)
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
    engine.command(0, Command::Mapping(mapping(0, 0.0)), &mut Vec::new());
    engine
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
    engine.tick(now, &mut events);
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
            engine.command(now, Command::Mapping(mapping(now, 0.0)), &mut Vec::new());
        }
        if millis >= 200 && millis % 20 == 0 {
            // Wire input is deliberately processed before this timer tick.
            let block = pcm(&engine, 1, sequence, next_frame, 882);
            let mut events = Vec::new();
            engine.command(now, Command::Pcm(block), &mut events);
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
fn late_join_allows_a_media_anchor_older_than_the_client_clock_origin() {
    let mut engine = engine();
    let mut clock = mapping(0, 0.0);
    clock.offset_ns = 10_000 * MS as i64;
    engine.command(0, Command::Mapping(clock), &mut Vec::new());
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
    assert!(events.is_empty());
    let block = pcm(&engine, 1, 9, 22_050 - 128, 4096);
    engine.command(350 * MS, Command::Pcm(block), &mut events);
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
    feed(&mut engine, 1, 0, 4096);
    commit(&mut engine, 0, &first);
    tick(&mut engine, 350 * MS);
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
    engine.command(0, Command::Pcm(waiting), &mut Vec::new());
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
        engine.command(0, Command::Pcm(block), &mut Vec::new());
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
    engine.command(0, Command::Pcm(block), &mut Vec::new());
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
                engine.command(now, Command::Pcm(block), &mut events);
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
        350 * MS,
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
    let (_status, status) = watch::channel(engine().status(0));
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
    missing.command(0, Command::Pcm(block), &mut Vec::new());
    assert!(!missing.preparing.as_ref().unwrap().ready);
    assert!(!missing.preparing.as_ref().unwrap().history_primed);
    // Rewinding the broadcast sequence to retrieve history is forbidden.
    let old = pcm(&missing, 1, 7, 22_050 - 128, 128);
    missing.command(0, Command::Pcm(old), &mut Vec::new());
    assert!(!missing.preparing.as_ref().unwrap().ready);
    let mut engine = engine();
    prepare(&mut engine, plan(1, 10, 0, 22_050));
    let history = pcm(&engine, 1, 8, 22_050 - 128, 128);
    engine.command(0, Command::Pcm(history), &mut Vec::new());
    assert!(!engine.preparing.as_ref().unwrap().ready);
    assert_eq!(engine.preparing.as_ref().unwrap().sequence, None);
    let future = pcm(&engine, 1, 9, 22_050, 2000);
    let mut events = Vec::new();
    engine.command(0, Command::Pcm(future), &mut events);
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
            400 * MS,
            Command::Prepare(identity(), future),
            &mut Vec::new(),
        );
    }
    assert!(engine.contracts.iter().any(|(epoch, ..)| *epoch == 1));
    let mut changed = plan(1, 20, 400 * MS, 44_100);
    changed.format.sample_rate = 48_000;
    let mut events = Vec::new();
    engine.command(400 * MS, Command::Prepare(identity(), changed), &mut events);
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
        engine.command(0, suspend(10, 400 * MS), &mut events);
        assert!(events.is_empty());
        assert!(engine.suspension.is_some());
        engine.command(0, suspend(10, 400 * MS), &mut events);
        assert!(events.is_empty());
        engine.command(
            0,
            suspend(if changed { 11 } else { 10 }, 500 * MS),
            &mut events,
        );
        assert!(matches!(events.as_slice(), [ReceiverEvent::Resync { .. }]));
        assert!(engine.suspension.is_none());
    }
    let mut engine = engine();
    engine.command(
        0,
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
                400 * MS,
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
                400 * MS,
                Command::Prepare(identity(), next.clone()),
                &mut events,
            );
            let block = pcm(&engine, 2, 0, 0, 4096);
            engine.command(400 * MS, Command::Pcm(block), &mut events);
            assert!(engine.preparing.as_ref().unwrap().ready);
            assert!(commit(&mut engine, 400 * MS, &next).is_empty());
        }
        let stale = plan(1, 12, 400 * MS, 22_050);
        engine.command(
            400 * MS,
            Command::Prepare(identity(), stale.clone()),
            &mut events,
        );
        assert_eq!(engine.intent.as_ref().unwrap().epoch.0, 1);
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
        engine.command(700 * MS, Command::Pcm(old_pcm), &mut events);
        events.extend(commit(&mut engine, 700 * MS, &stale));
        assert!(events.is_empty());
        assert!(engine.preparing.is_none());
        if suspend {
            assert!(engine.output.as_ref().unwrap().telemetry().muted);
        }
        // A genuinely future generation still prepares normally.
        engine.command(
            700 * MS,
            Command::Prepare(identity(), plan(3, 13, 1100 * MS, 0)),
            &mut events,
        );
        let fresh = pcm(&engine, 3, 0, 0, 4096);
        engine.command(700 * MS, Command::Pcm(fresh), &mut events);
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
        0,
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
        700 * MS,
        Command::Prepare(identity(), next.clone()),
        &mut Vec::new(),
    );
    let block = pcm(&engine, 3, 0, 0, 16_000);
    engine.command(700 * MS, Command::Pcm(block), &mut Vec::new());
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
        0,
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
                now,
                Command::Prepare(identity(), next.clone()),
                &mut Vec::new(),
            );
            let block = pcm(&engine, 2, 0, 0, 16_000);
            engine.command(now, Command::Pcm(block), &mut Vec::new());
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
fn pending_suspend_caps_metadata_at_real_eof_after_small_mapping_updates() {
    for stop in [700 * MS, 700 * MS + 12_345] {
        let mut engine = engine();
        let first = plan(1, 10, 400 * MS, 0);
        prepare(&mut engine, first.clone());
        let frames = ((stop - 400 * MS) as u128 * 44_100 / 1_000_000_000) as usize;
        feed(&mut engine, 1, 0, frames);
        commit(&mut engine, 0, &first);
        engine.command(
            0,
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
                engine.command(now, Command::Mapping(updated), &mut Vec::new());
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
        engine.command(350 * MS, Command::Mapping(clock), &mut events);
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
        let mut cursor = DeviceCursor {
            anchor: 400 * MS,
            fraction: 0.0,
            frames: 0,
            period,
        };
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
                let frames =
                    submission_frames(cursor.time().unwrap(), now, horizon, period, queued);
                if frames == 0 {
                    break;
                }
                cursor.frames += frames as u64;
                submitted += frames as u64;
                queued += frames;
                phase += frames as f64 * ratio;
            }
            max_queue = max_queue.max(queued);
            assert!(queued <= 4_804);
            if now >= 400 * MS {
                assert!(queued > 4_300);
                assert!(cursor.time().unwrap() <= horizon + period.ceil() as u64);
                // A slowly revised offset remains below the 3ms rejoin
                // threshold; adjacent mapping steps are under 10ns.
                let offset = (tick as f64 / 300_000.0).sin() * 2_000_000.0;
                let actual_ns = phase * 1e9 / 48_000.0;
                let mapped_ns = (cursor.time().unwrap() - 400 * MS) as f64 + offset;
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
            engine.command(0, Command::Pcm(block), &mut Vec::new());
        }
        commit(&mut engine, 0, &plan);
        let output = engine.output.as_mut().unwrap();
        output.ppm = device_ppm;
        let epoch = engine.preparing.as_mut().unwrap();
        for _ in 0..64 {
            epoch
                .submit(output, mapping(0, 0.0), 0, 1500 * MS, None, None)
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
