// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::*;
use std::cell::Cell;

thread_local! {
    static TRACE: Cell<bool> = const { Cell::new(false) };
    static STEPS: Cell<u8> = const { Cell::new(0) };
    static PANIC_BEFORE_ARC: Cell<bool> = const { Cell::new(false) };
    static UNWIND_BACKING: Cell<usize> = const { Cell::new(0) };
}

pub(super) fn before_allocate(stage: &str, ledger: &Ledger) {
    if TRACE.with(Cell::get) {
        assert_eq!(
            ledger.active_usage().asset_cpu_bytes,
            bootstrap::retained_requested_bytes().unwrap()
        );
        assert_eq!(ledger.active_usage().prepare_cpu_bytes, 0);
        assert_eq!(ledger.next_token, 1);
        assert_eq!(ledger.revision, 1);
        assert!(ledger.reservations.is_empty());
        let (previous, next, capacity) = match stage {
            "records" => (0, 1, 0),
            "arc" => (1, 2, MAX_RESERVATIONS),
            _ => unreachable!(),
        };
        assert_eq!(STEPS.with(Cell::get), previous);
        assert_eq!(ledger.reservations.capacity(), capacity);
        STEPS.with(|steps| steps.set(next));
    }
    if stage == "arc" && PANIC_BEFORE_ARC.with(|flag| flag.replace(false)) {
        UNWIND_BACKING.with(|pointer| pointer.set(ledger.reservations.as_ptr() as usize));
        panic!("test bootstrap unwind before Arc allocation");
    }
}

fn request() -> BudgetRequest {
    BudgetRequest {
        owner: OwnerKind::Probe,
        session: "s".repeat(128),
        generation: 1,
        task_id: "t".repeat(64),
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
    }
}

#[test]
fn process_storage_is_booked_before_both_real_allocations() {
    TRACE.with(|flag| flag.set(true));
    STEPS.with(|steps| steps.set(0));
    let (budget, sample) = measure_requested_heap(BudgetCoordinator::new_process);
    TRACE.with(|flag| flag.set(false));
    assert_eq!(STEPS.with(Cell::get), 2);
    assert!(!sample.overflow);
    let fee = bootstrap::retained_requested_bytes().unwrap();
    assert_eq!(sample.peak as u64, fee);
    assert_eq!(sample.retained as u64, fee);
    assert_eq!(budget.usage().asset_cpu_bytes, fee);
    let (_, freed) = measure_requested_heap(|| {
        let budget = BudgetCoordinator::new_process();
        drop(budget);
    });
    assert!(!freed.overflow);
    assert_eq!(freed.retained, 0);
    println!(
        "process storage requested={fee} peak={} retained={} drop={}",
        sample.peak, sample.retained, freed.retained
    );
}

#[test]
fn full_record_capacity_survives_exit_forget_and_purge_without_growth() {
    let budget = BudgetCoordinator::new_process();
    let fee = bootstrap::retained_requested_bytes().unwrap();
    let request = request();
    let pointer = budget.ledger.lock().unwrap().reservations.as_ptr();
    let (_, sample) = measure_requested_heap(|| {
        let first = budget.grant(&request).unwrap();
        for _ in 1..MAX_RESERVATIONS {
            budget.grant(&request).unwrap();
        }
        assert_eq!(budget.record_count_for_test(), MAX_RESERVATIONS);
        budget.release(first, &request.session, 1).unwrap();
        budget.confirm_exit(first, &request.session, 1).unwrap();
        budget.forget_released(first, &request.session, 1).unwrap();
        assert_eq!(
            budget.purge_session(&request.session, 1),
            MAX_RESERVATIONS - 1
        );
    });
    assert!(!sample.overflow);
    assert_eq!(sample.peak, MAX_RESERVATIONS * (128 + 64));
    assert_eq!(sample.retained, 0);
    assert_eq!(budget.usage().asset_cpu_bytes, fee);
    assert_eq!(budget.usage().reservation_records, 0);
    let ledger = budget.ledger.lock().unwrap();
    assert_eq!(ledger.reservations.capacity(), MAX_RESERVATIONS);
    assert_eq!(ledger.reservations.as_ptr(), pointer);
}

#[test]
fn process_floor_is_preserved_by_both_advisory_paths_and_exact_quota_checks() {
    let budget = BudgetCoordinator::new_process();
    let fee = bootstrap::retained_requested_bytes().unwrap();
    let mut full = request();
    full.asset_cpu_bytes = MAX_ASSET_CPU_BYTES - fee;
    budget.check_requests(std::slice::from_ref(&full)).unwrap();
    let token = budget.grant(&full).unwrap();
    assert_eq!(budget.usage().asset_cpu_bytes, MAX_ASSET_CPU_BYTES);
    full.asset_cpu_bytes += 1;
    let projection = budget.project_desktop_replacement(&[]);
    assert_eq!(projection.usage(), budget.usage());
    let mut extra = request();
    extra.asset_cpu_bytes = 1;
    assert_eq!(budget.grant(&extra).unwrap_err().quota, MEMORY_ASSET_QUOTA);
    assert_eq!(
        budget.check_requests(&[extra]).unwrap_err().quota,
        MEMORY_ASSET_QUOTA
    );
    budget.release(token, &full.session, 1).unwrap();
    budget.confirm_exit(token, &full.session, 1).unwrap();
    budget.forget_released(token, &full.session, 1).unwrap();
    assert_eq!(budget.grant(&full).unwrap_err().quota, MEMORY_ASSET_QUOTA);
    assert_eq!(budget.usage().asset_cpu_bytes, fee);
}

#[test]
fn unpublished_bootstrap_unwind_frees_backing_and_allows_retry() {
    let once = OnceLock::new();
    PANIC_BEFORE_ARC.with(|flag| flag.set(true));
    let (_, sample) = measure_requested_heap(|| {
        let failed = std::panic::catch_unwind(|| once.get_or_init(BudgetCoordinator::new_process));
        assert!(failed.is_err());
        // catch_unwind owns the real boxed panic payload until it is dropped.
        // Include that cleanup in the sample rather than counting it as backing.
        drop(failed);
        let pointer = UNWIND_BACKING.with(Cell::get);
        assert_ne!(pointer, 0);
        assert!(!super::test_support::requested_heap_contains(pointer));
    });
    assert!(once.get().is_none());
    assert!(!sample.overflow);
    // The test harness may retain its panic-output capture. The exact original
    // Vec allocation was observed and freed before the assertion above.
    let budget = once.get_or_init(BudgetCoordinator::new_process);
    assert_eq!(
        budget.usage().asset_cpu_bytes,
        bootstrap::retained_requested_bytes().unwrap()
    );
}
