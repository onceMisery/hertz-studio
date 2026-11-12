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
        for (index, &(pointer, bytes, _)) in allocations.iter().enumerate() {
            assert!(pointer != 0 && bytes != 0);
            assert!(!allocations[..index].iter().any(|a| a.0 == pointer));
        }
        for (index, &(pointer, bytes, align)) in allocations.iter().enumerate() {
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

pub(super) fn count_resource_plan_copies<T>(
    plan: &SessionPlan,
    run: impl FnOnce() -> T,
) -> (T, usize) {
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

pub(super) fn requested_heap_contains(pointer: usize) -> bool {
    REQUESTED_HEAP.with(|cell| {
        let meter = cell.borrow();
        assert!(meter.active);
        meter.records.iter().any(|entry| entry.pointer == pointer)
    })
}

#[test]
fn invalid_physical_capture_does_not_publish_partial_slots() {
    const NAME: &str =
        "wallpaper::budget::test_support::invalid_physical_capture_does_not_publish_partial_slots";
    if std::env::var("HERTZ_PHYSICAL_CAPTURE_CHILD").as_deref() != Ok(NAME) {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", NAME, "--test-threads=1"])
            .env("HERTZ_PHYSICAL_CAPTURE_CHILD", NAME)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
        return;
    }
    for invalid in [[(1, 1, 1), (0, 1, 1)], [(1, 1, 1), (1, 1, 1)]] {
        assert!(std::panic::catch_unwind(|| PhysicalReleaseCapture::new(&invalid)).is_err());
        let exclusive = PHYSICAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        assert!(!PHYSICAL_ACTIVE.load(Ordering::Acquire));
        for slot in &PHYSICAL_SLOTS {
            assert_eq!(slot.pointer.load(Ordering::Acquire), 0);
            assert_eq!(slot.bytes.load(Ordering::Relaxed), 0);
        }
        drop(exclusive);
    }
    let capture = PhysicalReleaseCapture::new(&[(1, 1, 1)]);
    drop(capture);
    assert!(!PHYSICAL_ACTIVE.load(Ordering::Acquire));
}
