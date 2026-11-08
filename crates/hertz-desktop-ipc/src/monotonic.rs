// SPDX-License-Identifier: MIT
//! Same-machine deadline identity. Windows uptime is shared across processes,
//! includes suspend time, and is independent of wall-clock corrections.
pub const CLOCK: &str = "windows-uptime-ms-v1";
pub const CALIBRATION_TOTAL_MS: u64 = 5000;

pub fn now_millis() -> Option<u64> {
    #[cfg(windows)]
    {
        Some(unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() })
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// The source accepts only a supported, unexpired deadline within its budget.
/// Every later action uses this original value; no hop mints another deadline.
pub fn remaining(clock: &str, deadline: u64) -> Option<u64> {
    let now = now_millis()?;
    remaining_at(clock, deadline, now)
}
fn remaining_at(clock: &str, deadline: u64, now: u64) -> Option<u64> {
    let left = deadline.checked_sub(now)?;
    (clock == CLOCK && (1..=CALIBRATION_TOTAL_MS).contains(&left)).then_some(left)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calibration_late_delivery_and_expiry_never_extend_the_original_deadline() {
        assert_eq!(remaining_at(CLOCK, 15_000, 10_000), Some(5000));
        assert_eq!(remaining_at(CLOCK, 15_000, 14_000), Some(1000));
        assert_eq!(remaining_at(CLOCK, 15_000, 15_000), None);
        assert_eq!(remaining_at(CLOCK, 15_000, 16_000), None);
        assert_eq!(remaining_at("unix-utc-ms", 15_000, 10_000), None);
        assert_eq!(remaining_at(CLOCK, 20_000, 10_000), None);
        // UTC-based values are rejected; the runtime input is only uptime.
    }
}
