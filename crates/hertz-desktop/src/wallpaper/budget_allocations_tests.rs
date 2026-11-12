// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
use super::*;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

const PHYSICAL_CAPACITY: usize = 32;
struct PhysicalSlot {
    pointer: AtomicUsize,
    bytes: AtomicUsize,
    align: AtomicUsize,
    before: AtomicBool,
    allow_free: AtomicBool,
    after: AtomicUsize,
    allow_return: AtomicBool,
}
impl PhysicalSlot {
    const fn new() -> Self {
        Self {
            pointer: AtomicUsize::new(0),
            bytes: AtomicUsize::new(0),
            align: AtomicUsize::new(0),
            before: AtomicBool::new(false),
            allow_free: AtomicBool::new(false),
            after: AtomicUsize::new(0),
            allow_return: AtomicBool::new(false),
        }
    }
}
static PHYSICAL_LOCK: Mutex<()> = Mutex::new(());
static PHYSICAL_ACTIVE: AtomicBool = AtomicBool::new(false);
static PHYSICAL_OVERFLOW: AtomicBool = AtomicBool::new(false);
static PHYSICAL_SEQUENCE: AtomicUsize = AtomicUsize::new(0);
static PHYSICAL_SLOTS: [PhysicalSlot; PHYSICAL_CAPACITY] =
    [const { PhysicalSlot::new() }; PHYSICAL_CAPACITY];

fn physical_before(pointer: *mut u8, layout: Layout) -> Option<&'static PhysicalSlot> {
    if !PHYSICAL_ACTIVE.load(Ordering::Acquire) {
        return None;
    }
    let slot = PHYSICAL_SLOTS
        .iter()
        .find(|slot| slot.pointer.load(Ordering::Acquire) == pointer as usize)?;
    if slot.bytes.load(Ordering::Relaxed) != layout.size()
        || slot.align.load(Ordering::Relaxed) != layout.align()
        || slot.before.swap(true, Ordering::AcqRel)
    {
        PHYSICAL_OVERFLOW.store(true, Ordering::Release);
    }
    while !slot.allow_free.load(Ordering::Acquire) {
        std::thread::yield_now();
    }
    Some(slot)
}
fn physical_after(slot: Option<&PhysicalSlot>) {
    if let Some(slot) = slot {
        // The caller invokes this only AFTER the actual System.dealloc returns.
        slot.pointer.store(0, Ordering::Release); // A successor may reuse this address.
        slot.after.store(
            PHYSICAL_SEQUENCE.fetch_add(1, Ordering::AcqRel) + 1,
            Ordering::Release,
        );
        while !slot.allow_return.load(Ordering::Acquire) {
            std::thread::yield_now();
        }
    }
}

// Exact live pointers only, fixed storage and atomic signals: the allocator
// never allocates, invokes a callback or reenters the original budget mutex.
pub(crate) struct PhysicalReleaseCapture {
    _exclusive: MutexGuard<'static, ()>,
    len: usize,
}
impl PhysicalReleaseCapture {
    pub(crate) fn new(allocations: &[(usize, usize, usize)]) -> Self {
        let exclusive = PHYSICAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        assert!(!PHYSICAL_ACTIVE.load(Ordering::Acquire));
        assert!(allocations.len() <= PHYSICAL_CAPACITY);
        for (index, &(pointer, bytes, align)) in allocations.iter().enumerate() {
            assert!(pointer != 0 && bytes != 0);
            assert!(!allocations[..index].iter().any(|a| a.0 == pointer));
            let slot = &PHYSICAL_SLOTS[index];
            slot.bytes.store(bytes, Ordering::Relaxed);
            slot.align.store(align, Ordering::Relaxed);
            slot.before.store(false, Ordering::Relaxed);
            slot.allow_free.store(false, Ordering::Relaxed);
            slot.after.store(0, Ordering::Relaxed);
            slot.allow_return.store(false, Ordering::Relaxed);
            slot.pointer.store(pointer, Ordering::Release);
        }
        PHYSICAL_OVERFLOW.store(false, Ordering::Release);
        PHYSICAL_SEQUENCE.store(0, Ordering::Release);
        PHYSICAL_ACTIVE.store(true, Ordering::Release);
        Self {
            _exclusive: exclusive,
            len: allocations.len(),
        }
    }
    pub(crate) fn wait_before(&self, index: usize) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !PHYSICAL_SLOTS[index].before.load(Ordering::Acquire) {
            assert!(
                Instant::now() < deadline,
                "physical free gate {index} did not arrive"
            );
            std::thread::yield_now();
        }
    }
    pub(crate) fn free(&self, index: usize) {
        PHYSICAL_SLOTS[index]
            .allow_free
            .store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(20);
        while PHYSICAL_SLOTS[index].after.load(Ordering::Acquire) == 0 {
            assert!(
                Instant::now() < deadline,
                "System.dealloc {index} did not return"
            );
            std::thread::yield_now();
        }
    }
    pub(crate) fn resume(&self, index: usize) {
        PHYSICAL_SLOTS[index]
            .allow_return
            .store(true, Ordering::Release);
    }
    pub(crate) fn sequence(&self, index: usize) -> usize {
        PHYSICAL_SLOTS[index].after.load(Ordering::Acquire)
    }
    pub(crate) fn event_clock() -> usize {
        PHYSICAL_SEQUENCE.fetch_add(1, Ordering::AcqRel) + 1
    }
    pub(crate) fn assert_complete(&self) {
        assert!(
            !PHYSICAL_OVERFLOW.load(Ordering::Acquire),
            "physical capture overflow/layout mismatch"
        );
        for slot in &PHYSICAL_SLOTS[..self.len] {
            assert!(slot.after.load(Ordering::Acquire) != 0);
        }
    }
    pub(crate) fn unblock(&self) {
        for slot in &PHYSICAL_SLOTS[..self.len] {
            slot.allow_free.store(true, Ordering::Release);
            slot.allow_return.store(true, Ordering::Release);
        }
    }
    pub(crate) fn log_evidence(&self, label: &str, allocations: &[(usize, usize, usize)]) {
        self.assert_complete();
        for (index, &(pointer, _, _)) in allocations.iter().enumerate() {
            let slot = &PHYSICAL_SLOTS[index];
            println!("physical event {label} index={index} pointer={pointer:#x} bytes={} align={} after_system_dealloc={} overflow=false",
                slot.bytes.load(Ordering::Acquire), slot.align.load(Ordering::Acquire), self.sequence(index));
        }
    }
}
impl Drop for PhysicalReleaseCapture {
    fn drop(&mut self) {
        PHYSICAL_ACTIVE.store(false, Ordering::Release);
        for slot in &PHYSICAL_SLOTS[..self.len] {
            slot.allow_free.store(true, Ordering::Release);
            slot.allow_return.store(true, Ordering::Release);
            slot.pointer.store(0, Ordering::Release);
        }
    }
}

#[derive(Clone, Copy)]
struct HeapRecord {
    pointer: usize,
    bytes: usize,
}

struct HeapMeter {
    active: bool,
    records: [HeapRecord; 256],
    live: usize,
    peak: usize,
    overflow: bool,
}

thread_local! {
    static REQUESTED_HEAP: std::cell::RefCell<HeapMeter> = const { std::cell::RefCell::new(HeapMeter {
        active: false, records: [HeapRecord { pointer: 0, bytes: 0 }; 256], live: 0, peak: 0, overflow: false,
    }) };
}

fn heap_event(old: *mut u8, new: *mut u8, bytes: usize, reallocating: bool) {
    let _ = REQUESTED_HEAP.try_with(|cell| {
        let Ok(mut meter) = cell.try_borrow_mut() else {
            return;
        };
        if !meter.active {
            return;
        }
        let old_slot = meter
            .records
            .iter()
            .position(|record| record.pointer != 0 && record.pointer == old as usize);
        if reallocating {
            // Conservative requested old+new overlap at the real realloc call.
            let Some(overlap) = meter.live.checked_add(bytes) else {
                meter.overflow = true;
                return;
            };
            meter.peak = meter.peak.max(overlap);
            if new.is_null() {
                return;
            }
        }
        if let Some(slot) = old_slot {
            meter.live -= meter.records[slot].bytes;
            meter.records[slot] = HeapRecord {
                pointer: 0,
                bytes: 0,
            };
        }
        // Pre-owned frees are deliberately absent and never subtract live.
        if new.is_null() {
            return;
        }
        let Some(slot) = meter.records.iter().position(|record| record.pointer == 0) else {
            meter.overflow = true;
            return;
        };
        let Some(live) = meter.live.checked_add(bytes) else {
            meter.overflow = true;
            return;
        };
        meter.records[slot] = HeapRecord {
            pointer: new as usize,
            bytes,
        };
        meter.live = live;
        meter.peak = meter.peak.max(live);
    });
}

pub(crate) struct RequestedHeapSample {
    pub(crate) peak: usize,
    pub(crate) retained: usize,
    pub(crate) overflow: bool,
}

pub(crate) fn measure_requested_heap<T>(run: impl FnOnce() -> T) -> (T, RequestedHeapSample) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            REQUESTED_HEAP.with(|cell| cell.borrow_mut().active = false);
        }
    }
    REQUESTED_HEAP.with(|cell| {
        let mut meter = cell.borrow_mut();
        assert!(!meter.active);
        meter.records.fill(HeapRecord {
            pointer: 0,
            bytes: 0,
        });
        meter.live = 0;
        meter.peak = 0;
        meter.overflow = false;
        meter.active = true;
    });
    let reset = Reset;
    let result = run();
    let sample = REQUESTED_HEAP.with(|cell| {
        let meter = cell.borrow();
        RequestedHeapSample {
            peak: meter.peak,
            retained: meter.live,
            overflow: meter.overflow,
        }
    });
    drop(reset);
    (result, sample)
}

// Count the actual resource Vec backing request on this test thread. Other
// allocations and parallel tests continue through the original System allocator.
struct ResourcePlanAllocationMeter;

thread_local! {
    static RESOURCE_PLAN_ALLOCS: Cell<(usize, usize)> = const { Cell::new((0, 0)) };
}

fn record_resource_plan_allocation(size: usize) {
    let _ = RESOURCE_PLAN_ALLOCS.try_with(|meter| {
        let (expected, count) = meter.get();
        if expected != 0 && size == expected {
            meter.set((expected, count + 1));
        }
    });
}

unsafe impl GlobalAlloc for ResourcePlanAllocationMeter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_resource_plan_allocation(layout.size());
        let pointer = unsafe { System.alloc(layout) };
        heap_event(std::ptr::null_mut(), pointer, layout.size(), false);
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_resource_plan_allocation(layout.size());
        let pointer = unsafe { System.alloc_zeroed(layout) };
        heap_event(std::ptr::null_mut(), pointer, layout.size(), false);
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        let physical = physical_before(pointer, layout);
        heap_event(pointer, std::ptr::null_mut(), 0, false);
        unsafe { System.dealloc(pointer, layout) };
        physical_after(physical);
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record_resource_plan_allocation(size);
        let next = unsafe { System.realloc(pointer, layout, size) };
        heap_event(pointer, next, size, true);
        next
    }
}

#[global_allocator]
static RESOURCE_PLAN_METER: ResourcePlanAllocationMeter = ResourcePlanAllocationMeter;

fn count_resource_plan_copies<T>(plan: &SessionPlan, run: impl FnOnce() -> T) -> (T, usize) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            RESOURCE_PLAN_ALLOCS.with(|meter| meter.set((0, 0)));
        }
    }
    RESOURCE_PLAN_ALLOCS.with(|meter| {
        assert_eq!(meter.get(), (0, 0));
        meter.set((std::mem::size_of_val(plan.resources()), 0));
    });
    let reset = Reset;
    let result = run();
    let count = RESOURCE_PLAN_ALLOCS.with(|meter| meter.get().1);
    drop(reset);
    (result, count)
}

fn plan(owner: OwnerKind, session: &str, generation: u64) -> SessionPlan {
    SessionPlan::new(
        BudgetRequest {
            owner,
            session: session.into(),
            generation,
            task_id: "presentation".into(),
            targets: u32::from(owner == OwnerKind::Desktop),
            contexts: 1,
            decoders: 1,
            transcode_slots: 0,
            decode_pixel_rate: 100,
            output_pixel_rate: 200,
            texture_upload_bytes_per_second: 0,
            cpu_bytes: 300,
            prepare_cpu_bytes: 0,
            asset_cpu_bytes: 0,
            gpu_bytes: 400,
            prepare_tasks: 0,
        },
        vec![
            ResourcePlan {
                id: "decode".into(),
                maximum: ResourceAmounts {
                    decoders: 1,
                    decode_pixel_rate: 100,
                    cpu_bytes: 300,
                    ..Default::default()
                },
            },
            ResourcePlan {
                id: "render".into(),
                maximum: ResourceAmounts {
                    contexts: 1,
                    output_pixel_rate: 200,
                    gpu_bytes: 400,
                    ..Default::default()
                },
            },
        ],
    )
    .unwrap()
}

#[test]
fn quota_rejection_does_not_copy_resource_plans_or_mutate_existing_allocations() {
    let budget = BudgetCoordinator::new();
    let original = plan(OwnerKind::Desktop, "existing", 1);
    let parent = budget.grant_session(&original).unwrap();
    budget
        .allocate_resource(
            parent,
            "existing",
            1,
            "decode",
            original.resources()[0].maximum,
        )
        .unwrap();
    let before = budget.planning_snapshot();
    let allocations = budget.allocation_snapshot(parent, "existing", 1).unwrap();
    let mut request = plan(OwnerKind::Desktop, "candidate", 1).request().clone();
    request.decoders = 2;
    let resources: Vec<_> = (0..256)
        .map(|index| ResourcePlan {
            id: format!("resource-{index}"),
            maximum: ResourceAmounts::default(),
        })
        .collect();
    let candidate = SessionPlan::new(request.clone(), resources).unwrap();
    let (rejected, copies) =
        count_resource_plan_copies(&candidate, || budget.grant_session(&candidate));
    let error = rejected.unwrap_err();
    assert_eq!(error.code, "budget_busy");
    assert!(error.message.starts_with("decoder_slots:"));
    assert_eq!(
        copies, 0,
        "quota rejection must precede owned resource backing allocation"
    );
    assert_eq!(budget.planning_snapshot(), before);
    let after = budget.allocation_snapshot(parent, "existing", 1).unwrap();
    assert_eq!(after.allocation_revision, allocations.allocation_revision);
    assert_eq!(after.reserved, allocations.reserved);
    assert_eq!(after.allocated, allocations.allocated);
    assert_eq!((after.active, after.release_pending), (1, 0));

    request.decoders = 1;
    let candidate = SessionPlan::new(request, candidate.resources().to_vec()).unwrap();
    let resource = candidate.resources()[0].id.clone();
    let (admitted, copies) =
        count_resource_plan_copies(&candidate, || budget.grant_session(&candidate));
    let admitted = admitted.unwrap();
    assert_eq!(
        copies, 1,
        "successful admission must retain its own resource plan"
    );
    drop(candidate);
    budget
        .allocate_resource(
            admitted,
            "candidate",
            1,
            &resource,
            ResourceAmounts::default(),
        )
        .unwrap();
    assert_eq!(budget.usage().resource_allocations, 2);
}

#[test]
fn session_plans_keep_the_same_bounded_identity_rules_for_every_session_owner() {
    let original = plan(OwnerKind::Desktop, "identity", 1);
    for owner in [
        OwnerKind::Desktop,
        OwnerKind::DesktopFrame,
        OwnerKind::Preview,
        OwnerKind::PreviewFrame,
    ] {
        for (session, generation, task) in [
            (String::new(), 1, "task".into()),
            ("s".repeat(129), 1, "task".into()),
            ("会".repeat(43), 1, "task".into()),
            ("会".repeat(42) + "abc", 1, "task".into()),
            ("session".into(), 0, "task".into()),
            ("session".into(), 1, String::new()),
            ("session".into(), 1, "Task".into()),
            ("session".into(), 1, "task:bad".into()),
            ("session".into(), 1, "t".repeat(65)),
        ] {
            let mut request = original.request().clone();
            request.owner = owner;
            request.session = session;
            request.generation = generation;
            request.task_id = task;
            let error = SessionPlan::new(request, original.resources().to_vec()).unwrap_err();
            assert_eq!(error.code, "invalid_input");
            assert_eq!(error.message, "会话预算计划的 owner、代际或资源数量无效");
        }
        for session in ["S".repeat(128), "会".repeat(42) + "ab", "UPPER:会话".into()] {
            let mut request = original.request().clone();
            request.owner = owner;
            request.session = session.clone();
            request.generation = u64::MAX;
            request.task_id = "t".repeat(64);
            request.targets = u32::from(owner == OwnerKind::Desktop);
            if matches!(owner, OwnerKind::DesktopFrame | OwnerKind::PreviewFrame) {
                request.contexts = 0;
                request.decoders = 0;
                request.decode_pixel_rate = 0;
                request.output_pixel_rate = 0;
            }
            let plan = SessionPlan::new(
                request,
                vec![ResourcePlan {
                    id: "resource".into(),
                    maximum: ResourceAmounts::default(),
                }],
            )
            .unwrap();
            assert_eq!(plan.request().session, session);
            let budget = BudgetCoordinator::new();
            let token = budget.grant_session(&plan).unwrap();
            budget.release(token, &session, u64::MAX).unwrap();
            budget.confirm_exit(token, &session, u64::MAX).unwrap();
        }
    }
    let mut probe = original.request().clone();
    probe.owner = OwnerKind::Probe;
    assert_eq!(
        SessionPlan::new(probe, original.resources().to_vec())
            .unwrap_err()
            .code,
        "invalid_input"
    );
}

#[test]
fn upload_suballocations_cannot_borrow_or_return_parent_rate_before_resource_exit() {
    let original = plan(OwnerKind::Desktop, "upload-owner", 3);
    let mut request = original.request().clone();
    request.texture_upload_bytes_per_second = 100;
    let mut resources = original.resources().to_vec();
    resources[1].maximum.texture_upload_bytes_per_second = 100;
    let plan = SessionPlan::new(request, resources).unwrap();
    let budget = BudgetCoordinator::new();
    let parent = budget.grant_session(&plan).unwrap();
    let first = budget
        .allocate_resource(
            parent,
            "upload-owner",
            3,
            "render",
            ResourceAmounts {
                texture_upload_bytes_per_second: 60,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(budget.usage().texture_upload_bytes_per_second, 100);
    assert!(budget
        .allocate_resource(
            parent,
            "upload-owner",
            3,
            "render",
            ResourceAmounts {
                texture_upload_bytes_per_second: 41,
                ..Default::default()
            }
        )
        .is_err());
    let second = budget
        .allocate_resource(
            parent,
            "upload-owner",
            3,
            "render",
            ResourceAmounts {
                texture_upload_bytes_per_second: 40,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        budget
            .allocation_snapshot(parent, "upload-owner", 3)
            .unwrap()
            .allocated
            .texture_upload_bytes_per_second,
        100
    );
    assert!(budget.release_resource(first, "upload-owner", 2).is_err());
    budget.release_resource(first, "upload-owner", 3).unwrap();
    budget
        .confirm_resource_exit(first, "upload-owner", 3)
        .unwrap();
    assert!(budget
        .retire_resource_plan(first, "upload-owner", 3)
        .is_err());
    assert_eq!(budget.usage().texture_upload_bytes_per_second, 100);
    budget.release_resource(second, "upload-owner", 3).unwrap();
    assert!(budget
        .retire_resource_plan(second, "upload-owner", 3)
        .is_err());
    budget
        .confirm_resource_exit(second, "upload-owner", 3)
        .unwrap();
    budget
        .retire_resource_plan(second, "upload-owner", 3)
        .unwrap();
    assert_eq!(budget.usage().texture_upload_bytes_per_second, 0);
    assert!(budget
        .allocate_resource(
            parent,
            "upload-owner",
            3,
            "render",
            ResourceAmounts {
                texture_upload_bytes_per_second: 1,
                ..Default::default()
            }
        )
        .is_err());
}

#[test]
fn session_reserves_once_and_suballocations_do_not_double_charge_preview_or_bytes() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Preview, "preview", 7);
    let parent = budget.grant_session(&plan).unwrap();
    let before = budget.usage();
    assert_eq!(
        budget.grant_session(&plan).unwrap_err().code,
        "allocation_identity"
    );
    assert_eq!(budget.usage(), before);
    assert_eq!(
        (
            before.targets,
            before.contexts,
            before.preview_instances,
            before.decoder_slots
        ),
        (0, 1, 1, 1)
    );
    for entry in plan.resources() {
        budget
            .allocate_resource(parent, "preview", 7, &entry.id, entry.maximum)
            .unwrap();
    }
    let after = budget.usage();
    assert_eq!(
        (
            after.targets,
            after.contexts,
            after.preview_instances,
            after.decoder_slots
        ),
        (0, 1, 1, 1)
    );
    assert_eq!(
        (
            after.cpu_bytes,
            after.gpu_bytes,
            after.output_pixel_rate,
            after.decode_pixel_rate
        ),
        (300, 400, 200, 100)
    );
    assert_eq!(
        (after.session_reservations, after.resource_allocations),
        (1, 2)
    );
    let snapshot = budget.allocation_snapshot(parent, "preview", 7).unwrap();
    assert_eq!(snapshot.allocated, snapshot.reserved);
    assert!(snapshot.allocation_revision > 0);
}

#[test]
fn resource_plan_and_parent_identity_bound_every_allocation() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Desktop, "desktop", 2);
    let parent = budget.grant_session(&plan).unwrap();
    let before = budget.usage();
    for (owner, generation, resource, amounts, code) in [
        (
            "wrong",
            2,
            "decode",
            ResourceAmounts::default(),
            "allocation_identity",
        ),
        (
            "desktop",
            1,
            "decode",
            ResourceAmounts::default(),
            "allocation_identity",
        ),
        (
            "desktop",
            2,
            "unplanned",
            ResourceAmounts::default(),
            "resource_not_planned",
        ),
        (
            "desktop",
            2,
            "decode",
            ResourceAmounts {
                gpu_bytes: 1,
                ..Default::default()
            },
            "budget_exceeded",
        ),
        (
            "desktop",
            2,
            "render",
            ResourceAmounts {
                gpu_bytes: 401,
                ..Default::default()
            },
            "budget_exceeded",
        ),
    ] {
        assert_eq!(
            budget
                .allocate_resource(parent, owner, generation, resource, amounts)
                .unwrap_err()
                .code,
            code
        );
        assert_eq!(budget.usage(), before);
    }
    let child = budget
        .allocate_resource(parent, "desktop", 2, "decode", plan.resources()[0].maximum)
        .unwrap();
    let wrong_revision = Allocation {
        allocation_revision: child.allocation_revision + 1,
        ..child
    };
    assert_eq!(
        budget
            .release_resource(wrong_revision, "desktop", 2)
            .unwrap_err()
            .code,
        "allocation_identity"
    );
    assert_eq!(
        budget
            .confirm_resource_exit(child, "desktop", 1)
            .unwrap_err()
            .code,
        "allocation_identity"
    );
    assert_eq!(budget.usage().resource_release_pending, 0);
}

#[test]
fn cancelling_a_resource_keeps_capacity_until_exit_and_does_not_shrink_global_reservation() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Desktop, "desktop", 1);
    let parent = budget.grant_session(&plan).unwrap();
    let amounts = plan.resources()[0].maximum;
    let first = budget
        .allocate_resource(parent, "desktop", 1, "decode", amounts)
        .unwrap();
    budget.release_resource(first, "desktop", 1).unwrap();
    budget.release_resource(first, "desktop", 1).unwrap();
    assert_eq!(budget.usage().resource_release_pending, 1);
    assert_eq!(
        budget
            .allocate_resource(parent, "desktop", 1, "decode", amounts)
            .unwrap_err()
            .code,
        "budget_exceeded"
    );
    assert!(!budget.forget_resource(first, "desktop", 1).unwrap());
    assert_eq!(
        budget.confirm_exit(parent, "desktop", 1),
        Err(LedgerError::ChildrenPending)
    );
    budget.confirm_resource_exit(first, "desktop", 1).unwrap();
    budget.confirm_resource_exit(first, "desktop", 1).unwrap();
    assert_eq!(
        budget.usage().decoder_slots,
        1,
        "only internal capacity returns"
    );
    assert!(budget.forget_resource(first, "desktop", 1).unwrap());
    assert_eq!(budget.usage().resource_records, 0);
    let second = budget
        .allocate_resource(parent, "desktop", 1, "decode", amounts)
        .unwrap();
    assert_ne!(first.token, second.token);
    assert!(budget.release_resource(first, "desktop", 1).is_err());
    assert_eq!(budget.usage().resource_release_pending, 0);
    budget.release(parent, "desktop", 1).unwrap();
    assert_eq!(
        budget.usage().resource_release_pending,
        1,
        "parent cancellation propagates without freeing"
    );
    assert_eq!(
        budget
            .allocate_resource(parent, "desktop", 1, "decode", ResourceAmounts::default())
            .unwrap_err()
            .code,
        "allocation_retiring"
    );
    budget.confirm_resource_exit(second, "desktop", 1).unwrap();
    budget.confirm_exit(parent, "desktop", 1).unwrap();
    budget.forget_released(parent, "desktop", 1).unwrap();
    assert_eq!(budget.usage(), BudgetUsage::default());
}

#[test]
fn concurrent_resources_compete_for_reserved_subcapacity_atomically() {
    let budget = Arc::new(BudgetCoordinator::new());
    let plan = plan(OwnerKind::Desktop, "desktop", 1);
    let parent = budget.grant_session(&plan).unwrap();
    let amounts = plan.resources()[0].maximum;
    let barrier = Arc::new(std::sync::Barrier::new(12));
    let threads = (0..12)
        .map(|_| {
            let budget = Arc::clone(&budget);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                budget.allocate_resource(parent, "desktop", 1, "decode", amounts)
            })
        })
        .collect::<Vec<_>>();
    let results = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(budget.usage().resource_allocations, 1);
    assert_eq!(budget.usage().decoder_slots, 1);
}

#[test]
fn plans_cannot_overflow_duplicate_resources_or_expand_the_global_envelope() {
    let original = plan(OwnerKind::Desktop, "desktop", 1);
    let entry = original.resources()[0].clone();
    assert!(SessionPlan::new(
        original.request().clone(),
        vec![entry.clone(), entry.clone()]
    )
    .is_err());
    assert!(SessionPlan::new(
        original.request().clone(),
        vec![
            ResourcePlan {
                id: "large".into(),
                maximum: ResourceAmounts {
                    cpu_bytes: u64::MAX,
                    ..Default::default()
                }
            },
            ResourcePlan {
                id: "overflow".into(),
                maximum: ResourceAmounts {
                    cpu_bytes: 1,
                    ..Default::default()
                }
            }
        ]
    )
    .is_err());
    assert!(SessionPlan::new(
        original.request().clone(),
        vec![ResourcePlan {
            id: "large".into(),
            maximum: ResourceAmounts {
                cpu_bytes: 301,
                ..Default::default()
            }
        }]
    )
    .is_err());
    assert!(SessionPlan::new(original.request().clone(), Vec::new()).is_err());
    let mut wrong = original.request().clone();
    wrong.generation = 0;
    assert!(SessionPlan::new(wrong, vec![entry]).is_err());
}

#[test]
fn subtoken_metadata_is_bounded_and_old_tokens_cannot_release_replacements() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Desktop, "desktop", 1);
    let parent = budget.grant_session(&plan).unwrap();
    let mut tokens = Vec::new();
    for _ in 0..256 {
        tokens.push(
            budget
                .allocate_resource(parent, "desktop", 1, "render", ResourceAmounts::default())
                .unwrap(),
        );
    }
    assert_eq!(
        budget
            .allocate_resource(parent, "desktop", 1, "render", ResourceAmounts::default())
            .unwrap_err()
            .code,
        "budget_busy"
    );
    budget.release_resource(tokens[0], "desktop", 1).unwrap();
    budget
        .confirm_resource_exit(tokens[0], "desktop", 1)
        .unwrap();
    assert_eq!(
        budget
            .allocate_resource(parent, "desktop", 1, "render", ResourceAmounts::default())
            .unwrap_err()
            .code,
        "budget_busy",
        "uncollected tombstones remain bounded"
    );
    budget.forget_resource(tokens[0], "desktop", 1).unwrap();
    let fresh = budget
        .allocate_resource(parent, "desktop", 1, "render", ResourceAmounts::default())
        .unwrap();
    assert_ne!(fresh.token, tokens[0].token);
    assert!(budget
        .confirm_resource_exit(tokens[0], "desktop", 1)
        .is_err());
    assert_eq!(budget.usage().resource_allocations, 256);
    assert_eq!(budget.usage().resource_records, 256);
}

#[test]
fn resource_exit_never_confirms_another_parent_or_a_later_generation() {
    let budget = BudgetCoordinator::new();
    let old = plan(OwnerKind::Desktop, "desktop", 1);
    let new = plan(OwnerKind::Desktop, "desktop", 2);
    let p1 = budget.grant_session(&old).unwrap();
    let p2 = budget.grant_session(&new).unwrap();
    let a = budget
        .allocate_resource(p1, "desktop", 1, "decode", old.resources()[0].maximum)
        .unwrap();
    let b = budget
        .allocate_resource(p2, "desktop", 2, "decode", new.resources()[0].maximum)
        .unwrap();
    let forged = Allocation {
        parent_token: p2,
        allocation_revision: b.allocation_revision,
        ..a
    };
    assert!(budget.confirm_resource_exit(forged, "desktop", 2).is_err());
    budget.release(p1, "desktop", 1).unwrap();
    budget.confirm_resource_exit(a, "desktop", 1).unwrap();
    budget.confirm_exit(p1, "desktop", 1).unwrap();
    budget.forget_released(p1, "desktop", 1).unwrap();
    assert_eq!(budget.usage().decoder_slots, 1);
    assert_eq!(budget.usage().resource_allocations, 1);
    assert_eq!(
        budget
            .allocation_snapshot(p2, "desktop", 2)
            .unwrap()
            .allocated,
        new.resources()[0].maximum
    );
}

#[test]
fn empty_flat_reservations_cannot_grow_native_metadata_without_bound() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Desktop, "metadata", 1);
    let mut request = plan.request().clone();
    request.owner = OwnerKind::Probe;
    request.targets = 0;
    request.contexts = 0;
    request.decoders = 0;
    request.cpu_bytes = 0;
    request.gpu_bytes = 0;
    request.decode_pixel_rate = 0;
    request.output_pixel_rate = 0;
    let mut tokens = Vec::new();
    for _ in 0..64 {
        tokens.push(budget.grant(&request).unwrap());
    }
    assert_eq!(budget.usage().reservation_records, 64);
    let before = budget.planning_snapshot();
    let rejection = budget.grant(&request).unwrap_err();
    assert_eq!(rejection.quota, "reservation_metadata");
    assert_eq!(
        (rejection.cap, rejection.held, rejection.requested),
        (64, 64, 1)
    );
    assert_eq!(budget.planning_snapshot(), before);
    assert!(!budget.forget_released(tokens[0], "metadata", 1).unwrap());
    budget.release(tokens[0], "metadata", 1).unwrap();
    assert_eq!(budget.usage().release_pending, 1);
    assert_eq!(budget.usage().reservation_records, 64);
    assert!(!budget.forget_released(tokens[0], "metadata", 1).unwrap());
    assert_eq!(
        budget.grant(&request).unwrap_err().quota,
        "reservation_metadata"
    );
    budget.confirm_exit(tokens[0], "metadata", 1).unwrap();
    assert_eq!(budget.usage().release_pending, 0);
    assert_eq!(budget.usage().reservation_records, 64);
    assert_eq!(
        budget.grant(&request).unwrap_err().quota,
        "reservation_metadata"
    );
    budget.forget_released(tokens[0], "metadata", 1).unwrap();
    let fresh = budget.grant(&request).unwrap();
    assert!(fresh > tokens[63]);
    assert_eq!(budget.usage().reservation_records, 64);
    assert_eq!(
        budget.release(tokens[0], "metadata", 1),
        Err(LedgerError::UnknownToken)
    );
}

#[test]
fn metadata_rejection_keeps_actual_probe_usage_until_confirmed_exit() {
    let budget = BudgetCoordinator::new();
    let original = plan(OwnerKind::Desktop, "work", 1);
    let mut request = original.request().clone();
    request.owner = OwnerKind::Probe;
    request.targets = 0;
    request.contexts = 0;
    request.output_pixel_rate = 0;
    request.prepare_cpu_bytes = 1024;
    let token = budget.grant(&request).unwrap();
    let mut empty = request.clone();
    empty.session = "empty".into();
    empty.decoders = 0;
    empty.decode_pixel_rate = 0;
    empty.cpu_bytes = 0;
    empty.gpu_bytes = 0;
    empty.prepare_cpu_bytes = 0;
    for _ in 0..63 {
        budget.grant(&empty).unwrap();
    }
    let held = budget.usage();
    budget.release(token, "work", 1).unwrap();
    let pending = budget.usage();
    assert_eq!(pending.release_pending, 1);
    assert_eq!(pending.reservation_records, 64);
    assert_eq!(pending.decoder_slots, held.decoder_slots);
    assert_eq!(pending.decode_pixel_rate, held.decode_pixel_rate);
    assert_eq!(pending.cpu_bytes, held.cpu_bytes);
    assert_eq!(pending.gpu_bytes, held.gpu_bytes);
    assert_eq!(pending.prepare_cpu_bytes, held.prepare_cpu_bytes);
    assert!(!budget.forget_released(token, "work", 1).unwrap());
    assert_eq!(
        budget.grant(&empty).unwrap_err().quota,
        "reservation_metadata"
    );
    budget.confirm_exit(token, "work", 1).unwrap();
    let exited = budget.usage();
    assert_eq!(
        (
            exited.decoder_slots,
            exited.decode_pixel_rate,
            exited.cpu_bytes,
            exited.gpu_bytes,
            exited.prepare_cpu_bytes,
            exited.release_pending
        ),
        (0, 0, 0, 0, 0, 0)
    );
    assert_eq!(exited.reservation_records, 64);
    assert_eq!(
        budget.grant(&empty).unwrap_err().quota,
        "reservation_metadata"
    );
    assert!(budget.forget_released(token, "work", 1).unwrap());
    budget.grant(&empty).unwrap();
    assert_eq!(budget.usage().reservation_records, 64);
}

#[test]
fn resource_retirement_returns_its_global_envelope_and_seals_only_that_resource() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Preview, "preview", 7);
    let parent = budget.grant_session(&plan).unwrap();
    let decode = budget
        .allocate_resource(parent, "preview", 7, "decode", plan.resources()[0].maximum)
        .unwrap();
    let render = budget
        .allocate_resource(parent, "preview", 7, "render", plan.resources()[1].maximum)
        .unwrap();
    let mut successor = self::plan(OwnerKind::Desktop, "successor", 1)
        .request()
        .clone();
    successor.decoders = MAX_DECODER_SLOTS;
    assert_eq!(budget.grant(&successor).unwrap_err().quota, "decoder_slots");
    let revision = budget.ledger.lock().unwrap().revision;
    budget.release_resource(decode, "preview", 7).unwrap();
    budget.confirm_resource_exit(decode, "preview", 7).unwrap();
    budget.retire_resource_plan(decode, "preview", 7).unwrap();
    let usage = budget.usage();
    assert_eq!(
        (
            usage.decoder_slots,
            usage.decode_pixel_rate,
            usage.cpu_bytes
        ),
        (0, 0, 0)
    );
    assert_eq!(
        (
            usage.preview_instances,
            usage.contexts,
            usage.gpu_bytes,
            usage.output_pixel_rate
        ),
        (1, 1, 400, 200)
    );
    assert_eq!(
        (usage.session_reservations, usage.resource_allocations),
        (1, 1)
    );
    let snapshot = budget.allocation_snapshot(parent, "preview", 7).unwrap();
    assert_eq!(snapshot.reserved, plan.resources()[1].maximum);
    assert_eq!(snapshot.allocated, snapshot.reserved);
    assert_eq!(snapshot.allocation_revision, render.allocation_revision);
    assert!(budget.ledger.lock().unwrap().revision > revision);
    let revision = budget.ledger.lock().unwrap().revision;
    budget.retire_resource_plan(decode, "preview", 7).unwrap();
    assert_eq!(budget.usage(), usage);
    assert_eq!(budget.ledger.lock().unwrap().revision, revision);
    budget.forget_resource(decode, "preview", 7).unwrap();
    assert_eq!(
        budget
            .allocate_resource(parent, "preview", 7, "decode", ResourceAmounts::default())
            .unwrap_err()
            .code,
        "resource_plan_retired"
    );
    // The envelope is available to another session, rather than just to this parent.
    let other = budget.grant(&successor).unwrap();
    assert_eq!(budget.usage().decoder_slots, MAX_DECODER_SLOTS);
    budget.confirm_exit(other, "successor", 1).unwrap();
    budget.forget_released(other, "successor", 1).unwrap();
    // The surviving token retains its identity and still guards the parent exit.
    budget.release(parent, "preview", 7).unwrap();
    assert_eq!(
        budget.confirm_exit(parent, "preview", 7),
        Err(LedgerError::ChildrenPending)
    );
    budget.confirm_resource_exit(render, "preview", 7).unwrap();
    budget.confirm_exit(parent, "preview", 7).unwrap();
    budget.forget_released(parent, "preview", 7).unwrap();
    assert_eq!(budget.usage(), Default::default());
}

#[test]
fn resource_retirement_requires_every_child_exit_and_the_exact_parent_identity() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Desktop, "desktop", 2);
    let parent = budget.grant_session(&plan).unwrap();
    let amounts = ResourceAmounts {
        cpu_bytes: 100,
        ..Default::default()
    };
    let first = budget
        .allocate_resource(parent, "desktop", 2, "decode", amounts)
        .unwrap();
    let second = budget
        .allocate_resource(parent, "desktop", 2, "decode", amounts)
        .unwrap();
    for (allocation, session, generation, code) in [
        (first, "wrong", 2, "allocation_identity"),
        (first, "desktop", 1, "allocation_identity"),
        (
            Allocation {
                allocation_revision: first.allocation_revision + 1,
                ..first
            },
            "desktop",
            2,
            "allocation_identity",
        ),
        (
            Allocation {
                token: second.token + 1,
                ..first
            },
            "desktop",
            2,
            "allocation_identity",
        ),
        (first, "desktop", 2, "resource_exit_pending"),
    ] {
        let before = budget.usage();
        assert_eq!(
            budget
                .retire_resource_plan(allocation, session, generation)
                .unwrap_err()
                .code,
            code
        );
        assert_eq!(budget.usage(), before);
    }
    budget.confirm_resource_exit(first, "desktop", 2).unwrap();
    budget.release_resource(second, "desktop", 2).unwrap();
    assert_eq!(
        budget
            .retire_resource_plan(first, "desktop", 2)
            .unwrap_err()
            .code,
        "resource_exit_pending"
    );
    assert_eq!(budget.usage().cpu_bytes, 300);
    budget.confirm_resource_exit(second, "desktop", 2).unwrap();
    budget.release(parent, "desktop", 2).unwrap();
    budget.retire_resource_plan(first, "desktop", 2).unwrap();
    assert_eq!(
        budget.usage().cpu_bytes,
        0,
        "the whole planned envelope, including unused capacity, returns"
    );
    assert_eq!(budget.usage().contexts, 1);
    assert_eq!(budget.usage().targets, 1);
    budget.confirm_exit(parent, "desktop", 2).unwrap();
    assert_eq!(
        budget
            .retire_resource_plan(first, "desktop", 2)
            .unwrap_err()
            .code,
        "allocation_retiring"
    );
    budget.forget_released(parent, "desktop", 2).unwrap();
    assert_eq!(budget.usage(), Default::default());
}
