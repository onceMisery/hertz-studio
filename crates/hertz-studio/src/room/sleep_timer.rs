// SPDX-License-Identifier: MIT
//! One-shot room timer owned by the host, independent of any UI connection.
use super::contract::{RoomError, RoomResult};

#[derive(Default)]
pub(super) struct SleepTimer {
    deadline_ns: Option<u64>,
}

impl SleepTimer {
    pub fn set(&mut self, now: u64, seconds: Option<u32>) -> RoomResult<()> {
        let deadline = match seconds {
            Some(seconds) if (1..=28_800).contains(&seconds) => Some(
                now.checked_add(u64::from(seconds) * 1_000_000_000)
                    .ok_or_else(RoomError::exhausted)?,
            ),
            Some(_) => return Err(RoomError::invalid("睡眠定时须为 1 秒至 8 小时")),
            None => None,
        };
        self.deadline_ns = deadline;
        Ok(())
    }

    pub fn is_due(&self, now: u64) -> bool {
        self.deadline_ns.is_some_and(|deadline| now >= deadline)
    }

    pub fn complete(&mut self) {
        self.deadline_ns = None;
    }

    pub fn remaining_seconds(&self, now: u64) -> Option<u64> {
        self.deadline_ns
            .map(|deadline| deadline.saturating_sub(now).div_ceil(1_000_000_000))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_cancellation_and_expiry_are_atomic_and_one_shot() {
        let mut timer = SleepTimer::default();
        timer.set(10, Some(2)).unwrap();
        assert_eq!(timer.remaining_seconds(1_000_000_011), Some(1));
        assert!(!timer.is_due(2_000_000_009));
        assert!(timer.is_due(2_000_000_010));
        // A busy owner must retain the intent for the next tick.
        assert!(timer.is_due(3_000_000_010));
        timer.complete();
        assert!(!timer.is_due(u64::MAX));
        timer.set(0, Some(60)).unwrap();
        assert!(timer.set(0, Some(28_801)).is_err());
        assert_eq!(timer.remaining_seconds(0), Some(60));
        assert!(timer.set(u64::MAX, Some(1)).is_err());
        assert_eq!(timer.remaining_seconds(0), Some(60));
        timer.set(5, Some(1)).unwrap();
        timer.set(6, None).unwrap();
        assert!(!timer.is_due(u64::MAX));
        assert_eq!(timer.remaining_seconds(0), None);
    }
}
