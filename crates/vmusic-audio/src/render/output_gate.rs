// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use vmusic_core::AudioError;

/// The actor changes output ownership; callbacks only attempt a bounded claim.
/// A prepared device cannot consume PCM before activation, and a retired device
/// cannot consume PCM after handoff. The mutable DSP itself is not shared here.
pub(super) struct OutputGate {
    active: AtomicU64,
    in_flight: AtomicBool,
}

impl OutputGate {
    pub(super) fn current(&self) -> u64 {
        self.active.load(Ordering::Acquire)
    }

    pub(super) fn new() -> Self {
        Self {
            active: AtomicU64::new(0),
            in_flight: AtomicBool::new(false),
        }
    }

    pub(super) fn enter(&self, id: u64) -> Option<OutputGuard<'_>> {
        if id == 0 || self.active.load(Ordering::Acquire) != id {
            return None;
        }
        if self
            .in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .is_err()
        {
            return None;
        }
        if self.active.load(Ordering::Acquire) != id {
            self.in_flight.store(false, Ordering::Release);
            return None;
        }
        Some(OutputGuard { gate: self, id })
    }

    /// Actor only. Revoke first, then wait for the finite in-flight callback.
    pub(super) fn activate(&self, id: u64) -> Result<u64, AudioError> {
        let previous = self.active.swap(0, Ordering::AcqRel);
        let start = Instant::now();
        while self.in_flight.load(Ordering::Acquire) {
            if start.elapsed() >= Duration::from_secs(1) {
                self.active.store(previous, Ordering::Release);
                return Err(AudioError::BackendInit(
                    "audio output did not quiesce".into(),
                ));
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        self.active.store(id, Ordering::Release);
        Ok(previous)
    }
}

pub(super) struct OutputGuard<'a> {
    gate: &'a OutputGate,
    id: u64,
}

impl OutputGuard<'_> {
    pub(super) fn is_current(&self) -> bool {
        self.gate.active.load(Ordering::Acquire) == self.id
    }
}

impl Drop for OutputGuard<'_> {
    fn drop(&mut self) {
        self.gate.in_flight.store(false, Ordering::Release);
    }
}
