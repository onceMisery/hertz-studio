// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Pure WASAPI clock arithmetic. Position is in GetFrequency units, **not**
//! necessarily stream frames. QPC values returned by GetPosition are already
//! normalized to 100ns units (unlike QueryPerformanceCounter's raw ticks).

use crate::output_clock::{ClockFaultKind, ClockObservation, ClockReading, OutputClock};

#[derive(Clone, Copy, Debug)]
pub(super) struct DeviceSample {
    pub position: u64,
    pub qpc_100ns: u64,
    pub callback_qpc_100ns: u64,
    pub callback_local_ns: u64,
    pub padding_qpc_start_100ns: u64,
    pub padding_qpc_end_100ns: u64,
    pub submitted: u64,
    pub padding: u32,
    pub frames: usize,
}

pub(super) struct NativeClock {
    filter: OutputClock,
    rate: u32,
    frequency: u64,
    buffer_frames: u32,
    previous: Option<DeviceSample>,
    zero_position_since: Option<u64>,
}

impl NativeClock {
    pub fn new(rate: u32, frequency: u64, buffer_frames: u32, correction: i64) -> Option<Self> {
        if frequency == 0 || buffer_frames == 0 {
            return None;
        }
        Some(Self {
            filter: OutputClock::new(rate, correction)?,
            rate,
            frequency,
            buffer_frames,
            previous: None,
            zero_position_since: None,
        })
    }

    pub fn reject(&mut self, kind: ClockFaultKind, value: f64) -> ClockReading {
        self.previous = None;
        self.zero_position_since = None;
        self.filter.invalidate(kind, value)
    }

    pub fn observe(&mut self, sample: DeviceSample) -> ClockReading {
        let Some(skew) = sample
            .callback_qpc_100ns
            .checked_sub(sample.qpc_100ns)
            .and_then(|ticks| ticks.checked_mul(100))
        else {
            return self.reject(ClockFaultKind::InvalidDeviceSample, -1.0);
        };
        // A stale driver clock sample cannot describe this render transaction.
        if skew > 100_000_000
            || sample.padding > self.buffer_frames
            || sample.padding as u64 > sample.submitted
            || sample.frames == 0
            || sample.frames > (self.buffer_frames - sample.padding) as usize
            || sample.padding_qpc_start_100ns > sample.padding_qpc_end_100ns
            || sample.padding_qpc_end_100ns > sample.callback_qpc_100ns
        {
            return self.reject(ClockFaultKind::InvalidDeviceSample, skew as f64);
        }
        let device_frame = sample.position as f64 * f64::from(self.rate) / self.frequency as f64;
        if sample.position == 0 && self.previous.is_none() {
            // Start can feed engine quanta before the first sample reaches the
            // endpoint. Its API-defined zero position is not a usable anchor.
            // Remain muted, and fail a clock that never starts within 3 seconds.
            let since = *self
                .zero_position_since
                .get_or_insert(sample.callback_qpc_100ns);
            if sample.callback_qpc_100ns.saturating_sub(since) > 30_000_000 {
                return self.reject(ClockFaultKind::InvalidDeviceSample, 0.0);
            }
            return self.filter.pending();
        }
        if let Some(previous) = self.previous {
            if sample.position < previous.position
                || sample.qpc_100ns <= previous.qpc_100ns
                || sample.submitted < previous.submitted
            {
                return self.reject(
                    ClockFaultKind::DevicePositionRegression,
                    sample.position as f64,
                );
            }
        }
        let lead_frames = sample.submitted as f64 - device_frame;
        if lead_frames < -1.0 {
            return self.reject(ClockFaultKind::DeviceUnderrun, -lead_frames);
        }
        let period = 1e9 / f64::from(self.rate);
        if lead_frames * period + period < skew as f64 {
            return self.reject(
                ClockFaultKind::DeviceUnderrun,
                skew as f64 - lead_frames * period,
            );
        }
        // Padding is the engine queue; position is the sample at the endpoint.
        // They need not be equal. The endpoint cannot have consumed samples
        // still in the engine queue, apart from the measured sampling skew.
        // GetStreamLatency (sometimes zero on real endpoints) does not prove
        // an upper bound on their difference. Never fabricate that bound or
        // add its reported maximum as a presentation offset. OutputClock still
        // enforces its existing lead, phase and rate limits on the actual grid.
        let sampling_span_ns = sample
            .qpc_100ns
            .abs_diff(sample.padding_qpc_start_100ns)
            .max(sample.qpc_100ns.abs_diff(sample.padding_qpc_end_100ns))
            as f64
            * 100.0;
        let padding_difference_ns = (lead_frames - f64::from(sample.padding)) * period;
        if padding_difference_ns < -sampling_span_ns - period {
            return self.reject(ClockFaultKind::InvalidDeviceSample, padding_difference_ns);
        }
        let Some(clock_local_ns) = sample.callback_local_ns.checked_sub(skew) else {
            return self.reject(ClockFaultKind::InvalidDeviceSample, skew as f64);
        };
        let Some(qpc_ns) = sample.qpc_100ns.checked_mul(100) else {
            return self.reject(ClockFaultKind::InvalidDeviceSample, sample.qpc_100ns as f64);
        };
        let playback = qpc_ns as f64 + lead_frames.max(0.0) * period;
        if !playback.is_finite() || playback >= u64::MAX as f64 {
            return self.reject(ClockFaultKind::InvalidDeviceSample, playback);
        }
        self.previous = Some(sample);
        self.filter.observe(Some(ClockObservation {
            callback_ns: qpc_ns,
            playback_ns: playback.round() as u64,
            local_ns: clock_local_ns,
            frames: sample.frames,
        }))
    }

    /// Called only after the actual IAudioClient Reset: both counters now have
    /// the API-defined zero origin. Never infer a new origin from padding.
    pub fn reset_stream_grid(&mut self) {
        self.filter.restart_observations();
        self.previous = None;
        self.zero_position_since = None;
    }
}

/// Convert raw QueryPerformanceCounter ticks to the 100ns units WASAPI uses.
pub(super) fn qpc_100ns(counter: i64, frequency: i64) -> Option<u64> {
    if counter < 0 || frequency <= 0 {
        return None;
    }
    u64::try_from(counter as u128 * 10_000_000 / frequency as u128).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output_clock::ClockStatus;

    #[test]
    fn raw_qpc_and_normalized_clock_qpc_are_distinct_units() {
        assert_eq!(qpc_100ns(3_579_545, 3_579_545), Some(10_000_000));
        assert_eq!(qpc_100ns(24_000_000, 24_000_000), Some(10_000_000));
        assert_eq!(qpc_100ns(-1, 10), None);
        assert_eq!(qpc_100ns(1, 0), None);
    }

    #[test]
    fn endpoint_zero_position_startup_stays_muted_until_advance_and_times_out() {
        let mut clock = NativeClock::new(48_000, 384_000, 1_920, 0).unwrap();
        for index in 0..2 {
            let mut s = sample(0, 1_920 + index * 480, 480, 8, 1e9 / 48_000.0);
            s.padding = 960;
            s.qpc_100ns += index * 100_000;
            s.callback_qpc_100ns += index * 100_000;
            s.padding_qpc_start_100ns += index * 100_000;
            s.padding_qpc_end_100ns += index * 100_000;
            s.callback_local_ns += index * 10_000_000;
            let reading = clock.observe(s);
            assert_eq!(reading.status, ClockStatus::AwaitingTimestamps);
            assert!(reading.first_frame_local_ns.is_none());
            assert_eq!(reading.fault_count, 0);
        }
        for index in 1..=8 {
            let reading = clock.observe(sample(
                index * 480,
                index * 480 + 1_440,
                480,
                8,
                1e9 / 48_000.0,
            ));
            assert_eq!(reading.status == ClockStatus::Valid, index == 8);
            assert_eq!(reading.fault_count, 0);
        }
        let mut stopped = NativeClock::new(48_000, 384_000, 1_920, 0).unwrap();
        let mut s = sample(0, 1_920, 480, 8, 1e9 / 48_000.0);
        s.padding = 1_440;
        assert_eq!(stopped.observe(s).status, ClockStatus::AwaitingTimestamps);
        s.qpc_100ns += 30_000_001;
        s.callback_qpc_100ns += 30_000_001;
        s.padding_qpc_start_100ns += 30_000_001;
        s.padding_qpc_end_100ns += 30_000_001;
        s.callback_local_ns += 3_000_000_100;
        assert_eq!(stopped.observe(s).status, ClockStatus::Invalid);
    }

    fn sample(
        position_frames: u64,
        submitted: u64,
        frames: usize,
        ratio: u64,
        period: f64,
    ) -> DeviceSample {
        let ns = (position_frames as f64 * period).round() as u64;
        DeviceSample {
            position: position_frames * ratio,
            qpc_100ns: 10_000_000 + ns / 100,
            callback_qpc_100ns: 10_000_000 + ns / 100 + 2_000,
            callback_local_ns: 2_000_000_000 + ns + 200_000,
            padding_qpc_start_100ns: 10_000_000 + ns / 100,
            padding_qpc_end_100ns: 10_000_000 + ns / 100,
            submitted,
            padding: (submitted - position_frames) as u32,
            frames,
        }
    }

    #[test]
    fn variable_writable_lengths_follow_submitted_grid_at_nonunit_frequency() {
        for ratio in [1, 8] {
            let mut clock = NativeClock::new(48_000, 48_000 * ratio, 1_920, 0).unwrap();
            let mut submitted = 1_920;
            let mut position = 0;
            for index in 0..400 {
                let frames = [240, 720, 480, 960][index % 4];
                position += frames as u64;
                let value =
                    clock.observe(sample(position, submitted, frames, ratio, 1e9 / 48_000.0));
                if index >= 7 {
                    assert_eq!(value.status, ClockStatus::Valid, "{value:?}");
                    assert!(
                        value
                            .first_frame_local_ns
                            .unwrap()
                            .abs_diff(2_000_000_000 + submitted * 1_000_000_000 / 48_000)
                            < 500
                    );
                    assert_eq!(value.fault_count, 0);
                }
                submitted += frames as u64;
            }
        }
    }

    #[test]
    fn sampling_delay_is_removed_and_true_underrun_reset_are_rejected() {
        let mut clock = NativeClock::new(48_000, 384_000, 1_920, 0).unwrap();
        for index in 1..30 {
            let mut s = sample(index * 480, 1_440 + index * 480, 480, 8, 1e9 / 48_000.0);
            s.callback_qpc_100ns += index * 1_000;
            s.callback_local_ns += index * 100_000;
            let reading = clock.observe(s);
            if index >= 8 {
                assert_eq!(reading.status, ClockStatus::Valid);
            }
        }
        let mut reset = sample(1, 16_320, 480, 8, 1e9 / 48_000.0);
        reset.padding = 1_440;
        assert_eq!(
            clock.observe(reset).last_fault.unwrap().kind,
            ClockFaultKind::DevicePositionRegression
        );
        let mut fresh = NativeClock::new(48_000, 384_000, 1_920, 0).unwrap();
        let mut underrun = sample(2_001, 2_001, 480, 8, 1e9 / 48_000.0);
        underrun.submitted = 2_000;
        underrun.position += 8;
        assert_eq!(
            fresh.observe(underrun).last_fault.unwrap().kind,
            ClockFaultKind::DeviceUnderrun
        );
    }

    #[test]
    fn native_position_drift_reaches_existing_clock_filter_without_phase_jumps() {
        for ppm in [-250.0, 300.0] {
            let period = 1e9 / (48_000.0 * (1.0 + ppm / 1e6));
            let mut clock = NativeClock::new(48_000, 384_000, 1_920, 0).unwrap();
            let mut last = None;
            for index in 1..6_000 {
                let reading =
                    clock.observe(sample(index * 480, index * 480 + 1_440, 480, 8, period));
                assert_eq!(reading.fault_count, 0, "{reading:?}");
                last = Some(reading);
            }
            assert!((last.unwrap().device_clock_ppm - ppm).abs() < 1.0);
        }
    }

    #[test]
    fn endpoint_pipeline_latency_is_retained_and_padding_only_bounds_the_sample() {
        let mut clock = NativeClock::new(48_000, 384_000, 1_920, 0).unwrap();
        for index in 1..30 {
            let submitted = index * 480 + 1_440;
            let mut s = sample(index * 480, submitted, 480, 8, 1e9 / 48_000.0);
            s.padding = 960; // another 480 frames are already past the engine queue
            let reading = clock.observe(s);
            if index >= 8 {
                assert_eq!(reading.status, ClockStatus::Valid);
                assert!(
                    reading
                        .first_frame_local_ns
                        .unwrap()
                        .abs_diff(2_000_000_000 + submitted * 1_000_000_000 / 48_000)
                        < 500
                );
            }
        }
        let mut inconsistent = sample(30 * 480, 30 * 480 + 1_440, 480, 8, 1e9 / 48_000.0);
        inconsistent.padding = 1_900; // impossible: queued engine audio exceeds endpoint lead
        inconsistent.frames = 20;
        assert_eq!(
            clock.observe(inconsistent).last_fault.unwrap().kind,
            ClockFaultKind::InvalidDeviceSample
        );
    }

    #[test]
    fn malformed_stale_and_real_phase_faults_are_not_relaxed() {
        assert!(NativeClock::new(48_000, 0, 1_920, 0).is_none());
        for mutation in 0..4 {
            let mut clock = NativeClock::new(48_000, 384_000, 1_920, 0).unwrap();
            let mut s = sample(480, 1_920, 480, 8, 1e9 / 48_000.0);
            match mutation {
                0 => s.padding = 1_921,
                1 => s.frames = 0,
                2 => s.callback_qpc_100ns += 1_000_001,
                _ => s.qpc_100ns = s.callback_qpc_100ns + 1,
            }
            assert_eq!(
                clock.observe(s).last_fault.unwrap().kind,
                ClockFaultKind::InvalidDeviceSample
            );
        }
        let mut clock = NativeClock::new(48_000, 384_000, 1_920, 0).unwrap();
        for index in 1..16 {
            clock.observe(sample(
                index * 480,
                index * 480 + 1_440,
                480,
                8,
                1e9 / 48_000.0,
            ));
        }
        let mut jumped = sample(16 * 480, 16 * 480 + 1_440, 480, 8, 1e9 / 48_000.0);
        jumped.qpc_100ns += 400_000;
        jumped.callback_qpc_100ns += 400_000;
        jumped.padding_qpc_start_100ns += 400_000;
        jumped.padding_qpc_end_100ns += 400_000;
        jumped.callback_local_ns += 40_000_000;
        let failed = clock.observe(jumped);
        assert_eq!(failed.status, ClockStatus::Invalid);
        assert_eq!(
            failed.last_fault.unwrap().kind,
            ClockFaultKind::PhaseResidualNs
        );
        let faults = failed.fault_count;
        clock.reset_stream_grid(); // paired with a real device Reset by adapter
        for index in 1..=8 {
            let mut s = sample(index * 480, index * 480 + 1_440, 480, 8, 1e9 / 48_000.0);
            s.qpc_100ns += 2_000_000;
            s.callback_qpc_100ns += 2_000_000;
            s.padding_qpc_start_100ns += 2_000_000;
            s.padding_qpc_end_100ns += 2_000_000;
            s.callback_local_ns += 200_000_000;
            let reading = clock.observe(s);
            assert_eq!(reading.fault_count, faults);
            assert_eq!(reading.status == ClockStatus::Valid, index == 8);
        }
    }
}
