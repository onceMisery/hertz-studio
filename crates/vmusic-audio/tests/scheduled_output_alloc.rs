// SPDX-License-Identifier: MIT
//! Separate test binary: the renderer already has a unit-test global allocator.
#![cfg(feature = "playback")]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use vmusic_audio::output_clock::{ClockObservation, OutputClock};
use vmusic_audio::scheduled_output::{PresentationTime, ScheduledPcmQueue};
use vmusic_audio::RenderFormat;

thread_local! {
    static WATCHING: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
    static DEALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

struct CountingAllocator;

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if WATCHING.try_with(Cell::get).unwrap_or(false) {
            let _ = ALLOCATIONS.try_with(|count| count.set(count.get() + 1));
        }
        // SAFETY: delegates the unchanged allocation contract to System.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if WATCHING.try_with(Cell::get).unwrap_or(false) {
            let _ = DEALLOCATIONS.try_with(|count| count.set(count.get() + 1));
        }
        // SAFETY: ptr/layout came from this allocator's System allocation.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

#[test]
fn all_callback_paths_allocate_and_free_nothing() {
    let (mut producer, mut consumer) = ScheduledPcmQueue::new(RenderFormat {
        sample_rate: 48_000,
        channels: 2,
    })
    .unwrap();
    let mut output = [0.0; 1_024];
    let input = [0.75; 1_024];
    let mut clock = OutputClock::new(48_000, 0).unwrap();
    WATCHING.with(|watching| watching.set(false));
    ALLOCATIONS.with(|count| count.set(0));
    DEALLOCATIONS.with(|count| count.set(0));
    WATCHING.with(|watching| watching.set(true));
    for index in 0..100u64 {
        let start = index * 512 * 1_000_000_000 / 48_000;
        let _ = clock.observe(Some(ClockObservation {
            callback_ns: start,
            playback_ns: start + 30_000_000,
            local_ns: start + 1_000_000_000,
            frames: 512,
        }));
        producer.unmute();
        producer.write_at(start, &input, start).unwrap();
        consumer.render(
            &mut output,
            Some(PresentationTime {
                first_frame_local_ns: start,
                ns_per_frame: 1e9 / 48_000.0,
            }),
        );
        consumer.render(&mut output, None);
        producer.unmute();
        producer.write_at(start + 1_000_000, &input, start).unwrap();
        consumer.render(
            &mut output,
            Some(PresentationTime {
                first_frame_local_ns: start,
                ns_per_frame: 1e9 / 48_000.0,
            }),
        );
        consumer.render(
            &mut output,
            Some(PresentationTime {
                first_frame_local_ns: start + 512 * 1_000_000_000 / 48_000,
                ns_per_frame: 1e9 / 48_000.0,
            }),
        );
        consumer.render(&mut output, None);
        producer.unmute();
        producer.write_at(start, &input, start).unwrap();
        consumer.render(
            &mut output,
            Some(PresentationTime {
                first_frame_local_ns: start + 10_000_000,
                ns_per_frame: 1e9 / 48_000.0,
            }),
        );
        consumer.render(&mut output, None);
        producer.mute();
        consumer.render(
            &mut output,
            Some(PresentationTime {
                first_frame_local_ns: start,
                ns_per_frame: 1e9 / 48_000.0,
            }),
        );
        producer.unmute();
    }
    WATCHING.with(|watching| watching.set(false));
    assert_eq!(ALLOCATIONS.with(Cell::get), 0, "callback allocation");
    assert_eq!(
        DEALLOCATIONS.with(Cell::get),
        0,
        "callback deallocation/Arc retirement"
    );
}
