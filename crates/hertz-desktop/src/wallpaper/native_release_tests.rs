// SPDX-License-Identifier: MIT
use super::*;
use std::{
    alloc::Layout,
    sync::{mpsc, Barrier},
    thread,
};

// All synchronization and the original successor request are constructed
// before measured destruction. Only the successor thread calls the ledger.
struct Successor {
    command: mpsc::SyncSender<u64>,
    result: mpsc::Receiver<(bool, usize)>,
    entered: Arc<AtomicBool>,
    contended: Arc<AtomicBool>,
    thread: thread::JoinHandle<()>,
}
impl Successor {
    fn new(coordinator: Arc<budget::BudgetCoordinator>) -> Self {
        let (command, commands) = mpsc::sync_channel::<u64>(1);
        let (results, result) = mpsc::sync_channel(1);
        let entered = Arc::new(AtomicBool::new(false));
        let started = Arc::clone(&entered);
        let contended = Arc::new(AtomicBool::new(false));
        let contention = Arc::clone(&contended);
        let thread = thread::spawn(move || {
            let mut request = budget::BudgetRequest {
                owner: budget::OwnerKind::Probe,
                session: "physical-successor".into(),
                generation: 81,
                task_id: "model-input".into(),
                targets: 0,
                contexts: 0,
                decoders: 0,
                transcode_slots: 0,
                decode_pixel_rate: 0,
                output_pixel_rate: 0,
                texture_upload_bytes_per_second: 0,
                cpu_bytes: 0,
                prepare_cpu_bytes: 0,
                asset_cpu_bytes: 0,
                gpu_bytes: 0,
                prepare_tasks: 0,
            };
            while let Ok(bytes) = commands.recv() {
                request.asset_cpu_bytes = bytes;
                // Actual original mutex attempt by this successor thread,
                // acknowledged before the measured ledger free is allowed.
                contention.store(coordinator.ledger_mutex_held_for_test(), Ordering::Release);
                started.store(true, Ordering::Release);
                let grant = coordinator.grant(&request);
                let event = budget::PhysicalReleaseCapture::event_clock();
                let success = grant.is_ok();
                if let Ok(token) = grant {
                    coordinator
                        .release(token, &request.session, request.generation)
                        .unwrap();
                    coordinator
                        .confirm_exit(token, &request.session, request.generation)
                        .unwrap();
                    coordinator
                        .forget_released(token, &request.session, request.generation)
                        .unwrap();
                }
                results.send((success, event)).unwrap();
            }
        });
        Self {
            command,
            result,
            entered,
            contended,
            thread,
        }
    }
    fn start(&self, bytes: u64) {
        self.entered.store(false, Ordering::Release);
        self.contended.store(false, Ordering::Release);
        self.command.send(bytes).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !self.entered.load(Ordering::Acquire) {
            assert!(std::time::Instant::now() < deadline);
            thread::yield_now();
        }
    }
    fn denied(&self, bytes: u64) {
        self.start(bytes);
        assert!(!self.result.recv_timeout(Duration::from_secs(10)).unwrap().0);
    }
    fn blocked(&self, bytes: u64) {
        self.start(bytes);
        assert!(
            self.contended.load(Ordering::Acquire),
            "successor must witness the real original mutex held"
        );
        assert!(matches!(
            self.result.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }
    fn finish(self) {
        drop(self.command);
        self.thread.join().unwrap();
    }
}

fn arc_allocation<T>(arc: &Arc<T>) -> (usize, usize, usize) {
    let (layout, offset) = Layout::new::<[std::sync::atomic::AtomicUsize; 2]>()
        .extend(Layout::new::<T>())
        .unwrap();
    (
        Arc::as_ptr(arc) as usize - offset,
        layout.pad_to_align().size(),
        layout.align(),
    )
}

fn gated_denial(
    capture: &budget::PhysicalReleaseCapture,
    successor: &Successor,
    index: usize,
    bytes: u64,
) {
    capture.wait_before(index);
    successor.denied(bytes);
    capture.free(index);
    // Even after physical free, the surrounding cleanup has not returned.
    successor.denied(bytes);
    capture.resume(index);
}

fn drop_clones<T: Clone + Send + Sync>(
    owner: T,
    count: usize,
    capture: &budget::PhysicalReleaseCapture,
    run_gates: impl FnOnce(),
) {
    let barrier = Arc::new(Barrier::new(count + 1));
    thread::scope(|scope| {
        let mut threads = Vec::new();
        let mut owners = (1..count).map(|_| owner.clone()).collect::<Vec<_>>();
        owners.push(owner);
        for clone in owners {
            let ready = Arc::clone(&barrier);
            threads.push(scope.spawn(move || {
                ready.wait();
                budget::measure_requested_heap(|| drop(clone)).1
            }));
        }
        barrier.wait();
        {
            struct Unblock<'a>(&'a budget::PhysicalReleaseCapture);
            impl Drop for Unblock<'_> {
                fn drop(&mut self) {
                    self.0.unblock();
                }
            }
            let _unblock = Unblock(capture);
            run_gates();
        }
        for thread in threads {
            let sample = thread.join().unwrap();
            assert_eq!(
                (sample.peak, sample.retained, sample.overflow),
                (0, 0, false)
            );
        }
    });
}

fn coupled_native_release(count: usize) {
    let fixture = installed_full_model_fixture(&format!("physical-model-{count}"), false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("physical-model".into(), 81).unwrap();
    let input = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let coordinator = probe.budget_for_test();
    let resources = input.inner().resources.as_ref().unwrap();
    let facts_ticket = input.inner().retained.as_ref().unwrap();
    let facts_bytes = facts_ticket.asset_requested_bytes();
    let source_bytes = resources.source.retained_source_charge();
    let (source_token, source) = resources.source.release_allocations_for_test();
    let (facts_token, facts_caller) = facts_ticket.release_allocations_for_test();
    let mut allocations = vec![arc_allocation(input.0.as_ref().unwrap())];
    let images = &resources.facts.structure().images;
    let mut shared = false;
    for (index, image) in images.iter().enumerate() {
        if let hertz_wallpaper::model_structure::ModelImage::Package { references, .. } = image {
            if images[index + 1..].iter().any(|other| matches!(other,
                hertz_wallpaper::model_structure::ModelImage::Package { references: r, .. } if Arc::ptr_eq(r, references))) {
                shared = true;
                continue;
            }
            let (layout, offset) = Layout::new::<[std::sync::atomic::AtomicUsize; 2]>()
                .extend(
                    Layout::array::<hertz_wallpaper::model_structure::PackageImageRef>(
                        references.len(),
                    )
                    .unwrap(),
                )
                .unwrap();
            allocations.push((
                Arc::as_ptr(references) as *const () as usize - offset,
                layout.pad_to_align().size(),
                layout.align(),
            ));
        }
    }
    assert!(shared); // Real same-path aliases share one original allocation.
    assert_eq!(allocations.len(), 3); // Input Arc and two distinct alias backings.
    allocations.extend_from_slice(&source[..2]); // source Arc then last pin-vector backing
    let payload_end = allocations.len();
    allocations.extend_from_slice(&facts_caller);
    allocations.extend_from_slice(&coordinator.request_allocations_for_test(facts_token));
    let facts_end = allocations.len();
    allocations.extend_from_slice(&source[2..]);
    allocations.extend_from_slice(&coordinator.request_allocations_for_test(source_token));
    let source_end = allocations.len();
    let blocker = probe
        .job_memory(
            &preparation,
            "model-source",
            0,
            budget::MAX_ASSET_CPU_BYTES - facts_bytes - source_bytes,
        )
        .unwrap();
    let successor = Successor::new(Arc::clone(&coordinator));
    let capture = budget::PhysicalReleaseCapture::new(&allocations);
    drop_clones(input, count, &capture, || {
        for index in 0..payload_end + 2 {
            gated_denial(&capture, &successor, index, facts_bytes);
        }
        assert!(model_source_writable(
            &fixture.store,
            &fixture.reference,
            "models/a/source.glb"
        ));
        // The original mutex protects both ledger Strings and their occupancy.
        capture.wait_before(facts_end - 2);
        successor.blocked(facts_bytes);
        for index in facts_end - 2..facts_end {
            capture.wait_before(index);
            capture.free(index);
            capture.resume(index);
        }
        let (granted, fact_grant) = successor
            .result
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        assert!(granted);
        for index in 0..facts_end {
            assert!(capture.sequence(index) < fact_grant);
        }
        // Facts quota is now available, but sourceR still pays its controls.
        for index in facts_end..source_end - 2 {
            gated_denial(&capture, &successor, index, facts_bytes + source_bytes);
        }
        capture.wait_before(source_end - 2);
        successor.blocked(facts_bytes + source_bytes);
        for index in source_end - 2..source_end {
            capture.wait_before(index);
            capture.free(index);
            capture.resume(index);
        }
        let (granted, source_grant) = successor
            .result
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        assert!(granted);
        for index in 0..source_end {
            assert!(capture.sequence(index) < source_grant);
        }
        assert!(fact_grant < capture.sequence(facts_end));
        println!("physical native clones={count} real_after_frees={source_end} factsR={facts_bytes} sourceR={source_bytes} facts_grant={fact_grant} source_grant={source_grant} mutex_attempt=WouldBlock overflow=false");
    });
    capture.assert_complete();
    capture.log_evidence("model", &allocations);
    drop(capture);
    successor.finish();
    blocker.finish();
    preparation.finish();
    assert_eq!(coordinator.record_count_for_test(), 0);
    assert!(coordinator.stuck().is_empty());
}

#[test]
fn simultaneous_two_final_inputs_free_original_backings_before_competing_grants() {
    coupled_native_release(2);
}
#[test]
fn simultaneous_many_final_inputs_free_original_backings_before_competing_grants() {
    coupled_native_release(8);
}

fn source_only_release(count: usize) {
    let fixture = installed_full_model_fixture(&format!("physical-source-{count}"), false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("physical-source".into(), 82).unwrap();
    let source = fixture
        .store
        .pin_canonical_model_source(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let coordinator = probe.budget_for_test();
    let bytes = source.retained_source_charge();
    let (token, pointers) = source.release_allocations_for_test();
    let mut allocations = pointers.to_vec();
    allocations.extend_from_slice(&coordinator.request_allocations_for_test(token));
    let blocker = probe
        .job_memory(
            &preparation,
            "model-source",
            0,
            budget::MAX_ASSET_CPU_BYTES - bytes,
        )
        .unwrap();
    let successor = Successor::new(Arc::clone(&coordinator));
    let capture = budget::PhysicalReleaseCapture::new(&allocations);
    drop_clones(source, count, &capture, || {
        for index in 0..4 {
            gated_denial(&capture, &successor, index, bytes);
        }
        assert!(model_source_writable(
            &fixture.store,
            &fixture.reference,
            "models/a/source.glb"
        ));
        capture.wait_before(4);
        successor.blocked(bytes);
        for index in 4..6 {
            capture.wait_before(index);
            capture.free(index);
            capture.resume(index);
        }
        let (granted, event) = successor
            .result
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        assert!(granted);
        for index in 0..6 {
            assert!(capture.sequence(index) < event);
        }
        println!("physical source clones={count} real_after_frees=6 sourceR={bytes} successor={event} mutex_attempt=WouldBlock overflow=false");
    });
    capture.assert_complete();
    capture.log_evidence("source", &allocations);
    drop(capture);
    successor.finish();
    blocker.finish();
    preparation.finish();
    assert_eq!(coordinator.record_count_for_test(), 0);
}

#[test]
fn source_only_two_clones_free_arc_payload_caller_and_ledger_before_successor() {
    source_only_release(2);
}
#[test]
fn source_only_many_clones_free_arc_payload_caller_and_ledger_before_successor() {
    source_only_release(8);
}
