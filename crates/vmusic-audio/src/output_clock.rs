// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Allocation-free estimation of a device's presentation clock.
//!
//! This models timestamps supplied by the audio backend, not an independently
//! measured acoustic/DAC clock. In particular CPAL 0.15 WASAPI estimates its
//! playback timestamp from writable buffer space. Callers must retain that
//! capability distinction when presenting synchronization quality to users.

const WARMUP_OBSERVATIONS: u32 = 8;
const MAX_LEAD_NS: u64 = 3_000_000_000;
const MAX_PHASE_ERROR_NS: f64 = 20_000_000.0;
const RATE_WINDOW_NS: u64 = 1_000_000_000;
const RATE_ENVELOPES: usize = 8;
const MIN_RATE_SPAN_NS: u64 = 2 * RATE_WINDOW_NS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClockStatus {
    AwaitingTimestamps,
    Valid,
    Invalid,
    DeviceError,
}

/// One callback observation. Backend timestamps must share one monotonic domain;
/// `local_ns` is the callback entry's `Instant` relative to the caller's origin.
#[derive(Debug, Clone, Copy)]
pub struct ClockObservation {
    pub callback_ns: u64,
    pub playback_ns: u64,
    pub local_ns: u64,
    pub frames: usize,
}

/// The first frame's estimated presentation time and the period of subsequent
/// frames. Positive correction means additional measured device latency.
#[derive(Debug, Clone, Copy)]
pub struct ClockReading {
    pub status: ClockStatus,
    pub first_frame_local_ns: Option<u64>,
    pub ns_per_frame: f64,
    /// Positive means the device consumes frames faster than nominal local time.
    pub device_clock_ppm: f64,
    /// Timestamp/model residual, including observed callback delivery jitter.
    /// This is an estimate, not a bound on unreported hardware/acoustic latency.
    pub uncertainty_ns: u64,
}

/// Backend-independent clock filter. No allocation, locking or I/O in `observe`.
///
/// Callback timestamps anchor the backend domain to the supplied local domain.
/// A lower-envelope offset avoids treating ordinary positive delivery jitter as
/// device latency. Presentation phase is slewed rather than rebased on every
/// callback; the sample counter stays continuous through small timestamp jitter.
#[derive(Debug)]
pub struct OutputClock {
    nominal_period: f64,
    correction_ns: i64,
    anchor: Option<ClockObservation>,
    previous: Option<ClockObservation>,
    window: Option<(ClockObservation, u64)>,
    rate_envelopes: [Option<ClockObservation>; RATE_ENVELOPES],
    next_rate_envelope: usize,
    offset_min_observation: Option<ClockObservation>,
    frames: u64,
    good: u32,
    invalid: bool,
    offset_ns: f64,
    host_ratio: f64,
    period_ns: f64,
    phase_ns: f64,
    uncertainty_ns: f64,
}

impl OutputClock {
    pub fn new(sample_rate: u32, latency_correction_ns: i64) -> Option<Self> {
        if !(1..=768_000).contains(&sample_rate) {
            return None;
        }
        let nominal = 1e9 / f64::from(sample_rate);
        Some(Self {
            nominal_period: nominal,
            correction_ns: latency_correction_ns,
            anchor: None,
            previous: None,
            window: None,
            rate_envelopes: [None; RATE_ENVELOPES],
            next_rate_envelope: 0,
            offset_min_observation: None,
            frames: 0,
            good: 0,
            invalid: false,
            offset_ns: 0.0,
            host_ratio: 1.0,
            period_ns: nominal,
            phase_ns: 0.0,
            uncertainty_ns: 0.0,
        })
    }

    fn invalidate(&mut self) -> ClockReading {
        self.anchor = None;
        self.previous = None;
        self.window = None;
        self.rate_envelopes.fill(None);
        self.next_rate_envelope = 0;
        self.offset_min_observation = None;
        self.frames = 0;
        self.good = 0;
        self.invalid = true;
        self.period_ns = self.nominal_period;
        self.host_ratio = 1.0;
        self.reading(None)
    }

    fn reading(&self, presentation_ns: Option<u64>) -> ClockReading {
        ClockReading {
            status: if self.good >= WARMUP_OBSERVATIONS {
                ClockStatus::Valid
            } else if self.invalid {
                ClockStatus::Invalid
            } else {
                ClockStatus::AwaitingTimestamps
            },
            first_frame_local_ns: presentation_ns,
            ns_per_frame: self.period_ns,
            device_clock_ppm: (self.nominal_period / self.period_ns - 1.0) * 1e6,
            uncertainty_ns: self.uncertainty_ns.ceil().max(1.0) as u64,
        }
    }

    fn observe_rate_envelope(&mut self, minimum: ClockObservation) -> f64 {
        self.rate_envelopes[self.next_rate_envelope] = Some(minimum);
        self.next_rate_envelope = (self.next_rate_envelope + 1) % RATE_ENVELOPES;
        // Median of pairwise slopes over separated lower-envelope windows.
        // An isolated late window cannot dominate a populated rate estimate;
        // two-second minimum spans also bound short startup delivery steps.
        // Both arrays live inline; this executes only once per rate window.
        let mut slopes = [0.0; RATE_ENVELOPES * (RATE_ENVELOPES - 1) / 2];
        let mut count = 0;
        for (index, left) in self.rate_envelopes.iter().enumerate() {
            let Some(left) = left else { continue };
            for right in self.rate_envelopes.iter().skip(index + 1).flatten() {
                let (first, last) = if left.callback_ns <= right.callback_ns {
                    (left, right)
                } else {
                    (right, left)
                };
                let span = last.callback_ns - first.callback_ns;
                if span >= MIN_RATE_SPAN_NS {
                    slopes[count] = (last.local_ns - first.local_ns) as f64 / span as f64;
                    count += 1;
                }
            }
        }
        if count == 0 {
            return self.host_ratio;
        }
        let slopes = &mut slopes[..count];
        slopes.sort_unstable_by(f64::total_cmp);
        (slopes[(count - 1) / 2] + slopes[count / 2]) * 0.5
    }

    pub fn observe(&mut self, observation: Option<ClockObservation>) -> ClockReading {
        let Some(observation) = observation else {
            return self.invalidate();
        };
        let Some(lead_ns) = observation.playback_ns.checked_sub(observation.callback_ns) else {
            return self.invalidate();
        };
        if lead_ns > MAX_LEAD_NS || observation.frames == 0 {
            return self.invalidate();
        }
        if let Some(previous) = self.previous {
            if observation.callback_ns <= previous.callback_ns
                || observation.playback_ns <= previous.playback_ns
                || observation.local_ns <= previous.local_ns
            {
                return self.invalidate();
            }
            let Some(frames) = self.frames.checked_add(previous.frames as u64) else {
                return self.invalidate();
            };
            self.frames = frames;
        }

        let anchor = *self.anchor.get_or_insert(observation);
        let callback_delta = observation.callback_ns - anchor.callback_ns;
        let playback_delta = observation.playback_ns - anchor.callback_ns;
        let offset = observation.local_ns as f64 - callback_delta as f64 * self.host_ratio;
        if self.previous.is_none() {
            self.offset_ns = offset;
            self.phase_ns = offset + playback_delta as f64;
            self.uncertainty_ns = self.nominal_period;
            self.window = Some((observation, 0));
            self.offset_min_observation = Some(observation);
        } else {
            // Never move the domain anchor forward because a callback was late.
            self.offset_ns = self.offset_ns.min(offset);
            if let Some(minimum) = self.offset_min_observation {
                let minimum_offset = minimum.local_ns as f64
                    - (minimum.callback_ns - anchor.callback_ns) as f64 * self.host_ratio;
                if offset < minimum_offset {
                    self.offset_min_observation = Some(observation);
                }
            }
            let raw_phase = self.offset_ns + playback_delta as f64 * self.host_ratio;
            let previous = self.previous.expect("previous observation exists");
            let predicted = self.phase_ns + previous.frames as f64 * self.period_ns;
            let error = raw_phase - predicted;
            if error.abs() > MAX_PHASE_ERROR_NS {
                return self.invalidate();
            }
            let delivery_jitter = (offset - self.offset_ns).abs();
            self.uncertainty_ns = (self.uncertainty_ns * 0.98)
                .max(error.abs())
                .max(delivery_jitter)
                .max(self.nominal_period);
            // Less than 1/32 of a frame per callback: jitter cannot periodically
            // jump an entire sample, even at high callback frequency.
            let slew =
                (error / 32.0).clamp(-self.nominal_period / 32.0, self.nominal_period / 32.0);
            self.phase_ns = predicted + slew;
        }

        if let Some((window, frame_origin)) = self.window {
            let callback_span = observation.callback_ns - window.callback_ns;
            if callback_span >= RATE_WINDOW_NS {
                let frame_span = self.frames - frame_origin;
                let playback_span = observation.playback_ns - window.playback_ns;
                // Callback delivery time is a noisy upper bound. Whole windows
                // of delayed delivery must not become a false device fault.
                let minimum = self.offset_min_observation.unwrap_or(observation);
                let host_ratio = self.observe_rate_envelope(minimum);
                let backend_period = playback_span as f64 / frame_span as f64;
                let period = backend_period * host_ratio;
                // Reject stale/fabricated timestamps or wildly inconsistent
                // device frame positions. Ordinary callback jitter is filtered.
                if frame_span == 0
                    || !(0.995..=1.005).contains(&host_ratio)
                    || !(0.995..=1.005).contains(&(backend_period / self.nominal_period))
                    || !(0.995..=1.005).contains(&(period / self.nominal_period))
                {
                    return self.invalidate();
                }
                // Refresh the lower envelope once per rate window. Retaining
                // the minimum forever would accumulate a permanent phase bias
                // while learning two clock domains' different slopes. Slewing
                // phase above keeps this calibration change sample-continuous.
                let next_ratio = self.host_ratio + (host_ratio - self.host_ratio) * 0.1;
                self.offset_ns = minimum.local_ns as f64
                    - (minimum.callback_ns - anchor.callback_ns) as f64 * next_ratio;
                self.host_ratio = next_ratio;
                self.period_ns += (period - self.period_ns) * 0.2;
                self.window = Some((observation, self.frames));
                self.offset_min_observation = Some(observation);
            }
        }

        self.previous = Some(observation);
        self.good = self.good.saturating_add(1);
        let corrected = self.phase_ns + self.correction_ns as f64;
        if !corrected.is_finite() || corrected < 0.0 || corrected >= u64::MAX as f64 {
            return self.invalidate();
        }
        let ready = self.good >= WARMUP_OBSERVATIONS;
        self.reading(ready.then_some(corrected.round() as u64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(index: u64, period: f64, jitter_ns: u64) -> ClockObservation {
        let ns = (index as f64 * 480.0 * period).round() as u64;
        ClockObservation {
            callback_ns: ns,
            playback_ns: ns + 30_000_000,
            local_ns: ns + 1_000_000_000 + jitter_ns,
            frames: 480,
        }
    }

    #[test]
    fn warmup_missing_regression_and_recovery_are_explicit() {
        let mut clock = OutputClock::new(48_000, 0).unwrap();
        for n in 0..7 {
            let reading = clock.observe(Some(observation(n, 1e9 / 48_000.0, 0)));
            assert_eq!(reading.status, ClockStatus::AwaitingTimestamps);
            assert!(reading.first_frame_local_ns.is_none());
        }
        assert_eq!(
            clock
                .observe(Some(observation(7, 1e9 / 48_000.0, 0)))
                .status,
            ClockStatus::Valid
        );
        assert_eq!(clock.observe(None).status, ClockStatus::Invalid);
        for n in 8..16 {
            clock.observe(Some(observation(n, 1e9 / 48_000.0, 0)));
        }
        assert_eq!(
            clock
                .observe(Some(observation(16, 1e9 / 48_000.0, 0)))
                .status,
            ClockStatus::Valid
        );
        assert_eq!(
            clock
                .observe(Some(observation(15, 1e9 / 48_000.0, 0)))
                .status,
            ClockStatus::Invalid
        );
    }

    #[test]
    fn drift_converges_without_following_delivery_jitter() {
        let period = 1e9 / (48_000.0 * 1.0002);
        let mut clock = OutputClock::new(48_000, 0).unwrap();
        let mut reading = clock.observe(Some(observation(0, period, 0)));
        let mut last = 0;
        for n in 1..6_000 {
            let jitter = if n % 13 == 0 { 500_000 } else { 0 };
            reading = clock.observe(Some(observation(n, period, jitter)));
            if let Some(time) = reading.first_frame_local_ns {
                assert!(time > last);
                let expected = observation(n, period, 0).local_ns + 30_000_000;
                assert!(time.abs_diff(expected) < 1_000_000);
                last = time;
            }
        }
        assert_eq!(reading.status, ClockStatus::Valid);
        assert!((reading.device_clock_ppm - 200.0).abs() < 20.0);
        assert!(reading.uncertainty_ns >= 400_000);
    }

    #[test]
    fn correction_uses_the_same_external_local_origin() {
        let mut clock = OutputClock::new(48_000, 2_000_000).unwrap();
        let mut reading = clock.observe(None);
        for n in 0..8 {
            reading = clock.observe(Some(observation(n, 1e9 / 48_000.0, 0)));
        }
        assert_eq!(reading.first_frame_local_ns, Some(1_102_000_000));
        assert!(OutputClock::new(0, 0).is_none());
        assert_eq!(
            clock
                .observe(Some(ClockObservation {
                    callback_ns: 100,
                    playback_ns: 99,
                    local_ns: 1_000,
                    frames: 1,
                }))
                .status,
            ClockStatus::Invalid
        );
    }

    #[test]
    fn backend_and_local_clock_domains_can_have_different_slopes() {
        let mut clock = OutputClock::new(48_000, 0).unwrap();
        let mut last = clock.observe(None);
        for index in 0..6_000u64 {
            let callback = index * 10_000_000;
            let playback = callback + 30_000_000;
            let local = 1_000_000_000 + (callback as f64 * 1.00025).round() as u64;
            last = clock.observe(Some(ClockObservation {
                callback_ns: callback,
                playback_ns: playback,
                local_ns: local,
                frames: 480,
            }));
            if index > 5_000 {
                let expected = 1_000_000_000 + (playback as f64 * 1.00025).round() as u64;
                assert!(last.first_frame_local_ns.unwrap().abs_diff(expected) < 200_000);
            }
        }
        assert_eq!(last.status, ClockStatus::Valid);
        assert!((last.device_clock_ppm + 249.94).abs() < 2.0);
    }

    #[test]
    fn delivery_jitter_on_rate_window_boundaries_does_not_invalidate_device_clock() {
        let mut clock = OutputClock::new(48_000, 0).unwrap();
        let mut reading = clock.observe(None);
        for index in 0..600 {
            let jitter = if index % 100 == 0 { 6_000_000 } else { 0 };
            reading = clock.observe(Some(observation(index, 1e9 / 48_000.0, jitter)));
            if index >= 8 {
                assert_eq!(reading.status, ClockStatus::Valid, "callback {index}");
            }
        }
        assert!(reading.device_clock_ppm.abs() < 1.0);
    }

    #[test]
    fn entire_late_delivery_windows_do_not_invalidate_the_device_clock() {
        for slope in [0.9995, 1.0, 1.0005] {
            let mut clock = OutputClock::new(48_000, 0).unwrap();
            let mut reading = clock.observe(None);
            for index in 0..6_000 {
                // The initial observation is late too; two later bursts leave
                // several consecutive windows with no clean callback at all.
                let jitter = if index == 0
                    || (101..=400).contains(&index)
                    || (901..=1200).contains(&index)
                {
                    6_000_000
                } else {
                    0
                };
                let mut obs = observation(index, 1e9 / 48_000.0, jitter);
                obs.local_ns =
                    1_000_000_000 + (obs.callback_ns as f64 * slope).round() as u64 + jitter;
                reading = clock.observe(Some(obs));
                if index >= 8 {
                    assert_eq!(
                        reading.status,
                        ClockStatus::Valid,
                        "callback {index}, slope {slope}"
                    );
                }
            }
            assert!((reading.device_clock_ppm - (1.0 / slope - 1.0) * 1e6).abs() < 3.0);
        }
    }

    #[test]
    fn robust_delivery_filter_keeps_backend_rate_and_phase_faults_explicit() {
        for phase_jump in [false, true] {
            let mut clock = OutputClock::new(48_000, 0).unwrap();
            for index in 0..100 {
                let reading = clock.observe(Some(observation(index, 1e9 / 48_000.0, 0)));
                if index >= 8 {
                    assert_eq!(reading.status, ClockStatus::Valid);
                }
            }
            let mut changed = observation(100, 1e9 / 48_000.0, 6_000_000);
            // A real 0.6% playback-frame mismatch still fails at the first
            // one-second measurement, even when the same callback is late.
            changed.playback_ns += if phase_jump { 21_000_000 } else { 6_000_000 };
            assert_eq!(clock.observe(Some(changed)).status, ClockStatus::Invalid);
        }
    }
}
