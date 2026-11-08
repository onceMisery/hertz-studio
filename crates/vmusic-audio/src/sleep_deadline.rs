// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Clock and callback gate for the local player's sleep timer.
//!
//! Windows uses system uptime, including time spent asleep, independently of
//! wall-clock corrections. Other platforms use a best-effort combination of
//! `Instant` and wall-clock elapsed time: a forward wall-clock correction can
//! expire a timer early, and a correction across suspend can hide elapsed sleep.
//! The native sleep/resume guarantee currently applies to Windows only.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Milliseconds in the local sleep timer's clock domain. Values are process/
/// machine-local deadlines, not Unix timestamps and must not be persisted.
#[cfg(windows)]
pub fn now_ms() -> u64 {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetTickCount64() -> u64;
    }
    // SAFETY: GetTickCount64 has no arguments, ownership or initialization
    // requirements. Keep this tiny import available in headless builds too.
    unsafe { GetTickCount64() }
}

#[cfg(not(windows))]
pub fn now_ms() -> u64 {
    use std::sync::OnceLock;
    use std::time::{Instant, SystemTime};

    static ORIGIN: OnceLock<(Instant, SystemTime)> = OnceLock::new();
    let (steady, wall) = ORIGIN.get_or_init(|| (Instant::now(), SystemTime::now()));
    portable_elapsed_ms(steady.elapsed(), wall.elapsed().ok())
}

#[cfg(any(not(windows), test))]
fn portable_elapsed_ms(steady: std::time::Duration, wall: Option<std::time::Duration>) -> u64 {
    // Reserve zero for an unarmed gate; saturate rather than truncate even for
    // artificial test samples or an implausibly large wall-clock adjustment.
    steady
        .max(wall.unwrap_or_default())
        .as_millis()
        .min(u128::from(u64::MAX - 1)) as u64
        + 1
}

/// Shared by the local handle, actor and renderer. No locks or allocation are
/// needed to read the deadline from the device callback.
pub(crate) struct SleepDeadline {
    deadline_ms: AtomicU64,
    expiry_epoch: AtomicU64,
    closed: AtomicBool,
    #[cfg(test)]
    test_now_ms: AtomicU64,
}

/// A block retains the deadline that authorized it even when timer cleanup
/// clears or replaces the shared deadline while its callback is suspended.
#[derive(Clone, Copy)]
pub(crate) struct CallbackDeadline {
    deadline_ms: u64,
    expiry_epoch: u64,
}

impl SleepDeadline {
    pub(crate) fn new() -> Self {
        // Initialize the portable clock on the owner thread, never lazily in
        // the device callback. Windows has no lazy initialization at all.
        let _ = now_ms();
        Self {
            deadline_ms: AtomicU64::new(0),
            expiry_epoch: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            #[cfg(test)]
            test_now_ms: AtomicU64::new(0),
        }
    }

    pub(crate) fn set(&self, deadline_ms: Option<u64>) {
        let previous = self.deadline_ms.load(Ordering::Acquire);
        if previous != 0 && self.clock_ms() >= previous {
            // Setters are serialized by the handle/coordinator. Publish the
            // expiry history before lifting the gate so even a block that
            // began unarmed can detect arm -> expiry -> cleanup while asleep.
            self.expiry_epoch.fetch_add(1, Ordering::AcqRel);
        }
        self.deadline_ms
            .store(deadline_ms.unwrap_or(0), Ordering::Release);
    }

    pub(crate) fn expired(&self) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return true;
        }
        let deadline = self.deadline_ms.load(Ordering::Acquire);
        deadline != 0 && self.clock_ms() >= deadline
    }

    pub(crate) fn callback_deadline(&self) -> CallbackDeadline {
        CallbackDeadline {
            expiry_epoch: self.expiry_epoch.load(Ordering::Acquire),
            deadline_ms: self.deadline_ms.load(Ordering::Acquire),
        }
    }

    pub(crate) fn callback_expired(&self, captured: CallbackDeadline) -> bool {
        if self.closed.load(Ordering::Acquire) {
            return true;
        }
        let deadline = self.deadline_ms.load(Ordering::Acquire);
        // Read after the deadline: observing a cleared/replaced deadline also
        // observes the expiry history published before its release store.
        if self.expiry_epoch.load(Ordering::Acquire) != captured.expiry_epoch {
            return true;
        }
        if captured.deadline_ms == 0 && deadline == 0 {
            return false;
        }
        let now = self.clock_ms();
        (captured.deadline_ms != 0 && now >= captured.deadline_ms)
            || (deadline != 0 && now >= deadline)
    }

    fn clock_ms(&self) -> u64 {
        #[cfg(test)]
        {
            let now = self.test_now_ms.load(Ordering::Acquire);
            if now != 0 {
                return now;
            }
        }
        now_ms()
    }

    #[cfg(test)]
    pub(crate) fn set_test_now_ms(&self, now: u64) {
        assert_ne!(now, 0);
        self.test_now_ms.store(now, Ordering::Release);
    }

    /// Owner teardown is permanent; racing timer cleanup cannot reopen output.
    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
    }

    #[cfg(test)]
    fn expired_at(&self, now: u64) -> bool {
        let deadline = self.deadline_ms.load(Ordering::Acquire);
        self.closed.load(Ordering::Acquire) || deadline != 0 && now >= deadline
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn deadline_boundary_replacement_and_cancellation_are_exact() {
        let gate = SleepDeadline::new();
        assert!(!gate.expired_at(u64::MAX));
        gate.set(Some(1_000));
        assert!(!gate.expired_at(999));
        assert!(gate.expired_at(1_000));
        assert!(gate.expired_at(1_001));
        gate.set(Some(2_000));
        assert!(!gate.expired_at(1_000));
        assert!(gate.expired_at(2_000));
        gate.set(None);
        assert!(!gate.expired_at(u64::MAX));
    }

    #[test]
    fn closing_the_owner_cannot_be_reversed_by_timer_cleanup_or_rearming() {
        let gate = SleepDeadline::new();
        gate.set(Some(1_000));
        gate.close();
        assert!(gate.expired());
        gate.set(None);
        assert!(gate.expired());
        assert!(gate.expired_at(0));
        gate.set(Some(u64::MAX));
        assert!(gate.expired());
        assert!(gate.expired_at(0));
    }

    #[test]
    fn callback_keeps_its_deadline_after_cleanup_and_rearming() {
        let gate = SleepDeadline::new();
        gate.set_test_now_ms(999);
        gate.set(Some(1_000));
        let captured = gate.callback_deadline();
        assert!(!gate.callback_expired(captured));
        gate.set_test_now_ms(1_000);
        gate.set(None);
        assert!(!gate.expired());
        assert!(gate.callback_expired(captured));
        gate.set(Some(2_000));
        assert!(!gate.expired());
        assert!(gate.callback_expired(captured));
        assert!(!gate.callback_expired(gate.callback_deadline()));
        gate.close();
        assert!(gate.callback_expired(gate.callback_deadline()));
    }

    #[test]
    fn callback_detects_a_timer_armed_expired_and_cleared_after_entry() {
        for initial in [None, Some(2_000)] {
            let gate = SleepDeadline::new();
            gate.set_test_now_ms(999);
            gate.set(initial);
            let captured = gate.callback_deadline();
            gate.set(Some(1_000));
            gate.set_test_now_ms(1_000);
            gate.set(None);
            assert!(!gate.expired());
            assert!(gate.callback_expired(captured));
            assert!(!gate.callback_expired(gate.callback_deadline()));
        }
    }

    #[test]
    fn cancellation_before_expiry_does_not_change_expiry_history() {
        let gate = SleepDeadline::new();
        gate.set_test_now_ms(999);
        let captured = gate.callback_deadline();
        gate.set(Some(1_000));
        gate.set(None);
        gate.set_test_now_ms(1_000);
        assert!(!gate.callback_expired(captured));
    }

    #[test]
    fn portable_clock_samples_include_sleep_and_saturate() {
        assert_eq!(portable_elapsed_ms(Duration::ZERO, None), 1);
        assert_eq!(
            portable_elapsed_ms(Duration::from_secs(2), Some(Duration::from_secs(62))),
            62_001
        );
        assert_eq!(portable_elapsed_ms(Duration::from_secs(2), None), 2_001);
        assert_eq!(
            portable_elapsed_ms(Duration::from_secs(2), Some(Duration::from_secs(1))),
            2_001
        );
        assert_eq!(portable_elapsed_ms(Duration::MAX, None), u64::MAX);
    }
}
