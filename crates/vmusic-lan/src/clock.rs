// SPDX-License-Identifier: MIT
//! Continuous affine mapping of client monotonic time to the host clock.
use std::collections::VecDeque;
use std::time::Instant;

pub const CLOCK_FRESHNESS_NS: u64 = 3_000_000_000;

#[derive(Clone, Debug)]
pub struct MonotonicClock {
    origin: Instant,
}
impl Default for MonotonicClock {
    fn default() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}
impl MonotonicClock {
    /// Origin shared with the native device adapter; never serialize this value.
    pub fn origin(&self) -> Instant {
        self.origin
    }

    pub fn now_ns(&self) -> u64 {
        self.origin.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64
    }
}

#[derive(Clone, Copy, Debug)]
pub struct TimeSample {
    pub t1: u64,
    pub t2: u64,
    pub t3: u64,
    pub t4: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct ClockMapping {
    pub reference_local_ns: u64,
    pub offset_ns: i64,
    pub drift_ppm: f64,
    pub uncertainty_ns: u64,
    pub min_rtt_ns: u64,
    pub samples: usize,
    pub residual_mad_ns: u64,
    pub observation_span_ns: u64,
}
impl ClockMapping {
    pub fn host_time(&self, local_ns: u64) -> Option<u64> {
        let delta = i128::from(local_ns) - i128::from(self.reference_local_ns);
        let host = i128::from(local_ns)
            + i128::from(self.offset_ns)
            + (delta as f64 * self.drift_ppm * 1e-6).round() as i128;
        u64::try_from(host).ok()
    }
    pub fn local_time(&self, host_ns: u64) -> Option<u64> {
        let reference_host = i128::from(self.reference_local_ns) + i128::from(self.offset_ns);
        let delta = i128::from(host_ns) - reference_host;
        let local = i128::from(self.reference_local_ns)
            + (delta as f64 / (1.0 + self.drift_ppm * 1e-6)).round() as i128;
        u64::try_from(local).ok()
    }
    pub fn converged(&self) -> bool {
        self.samples >= 8
            && self.observation_span_ns >= 1_000_000_000
            && self.uncertainty_ns <= 3_000_000
            && self.min_rtt_ns <= 50_000_000
            && self.drift_ppm.abs() <= 5000.0
    }
    /// A previously converged mapping is not a lease to run through lost sync.
    pub fn valid_at(&self, local_now: u64) -> bool {
        local_now >= self.reference_local_ns
            && local_now - self.reference_local_ns <= CLOCK_FRESHNESS_NS
            && self.converged()
    }
}

pub struct Estimator {
    window: VecDeque<(u64, i64, u64)>,
    capacity: usize,
    discontinuities: u64,
}
impl Default for Estimator {
    fn default() -> Self {
        Self::new(180)
    }
}
impl Estimator {
    pub fn new(capacity: usize) -> Self {
        Self {
            window: VecDeque::new(),
            capacity: capacity.clamp(8, 360),
            discontinuities: 0,
        }
    }
    pub fn discontinuities(&self) -> u64 {
        self.discontinuities
    }
    pub fn push(&mut self, sample: TimeSample) -> bool {
        let Some(roundtrip) = sample.t4.checked_sub(sample.t1) else {
            return false;
        };
        let Some(processing) = sample.t3.checked_sub(sample.t2) else {
            return false;
        };
        let Some(rtt) = roundtrip.checked_sub(processing) else {
            return false;
        };
        if rtt > 2_000_000_000 {
            return false;
        }
        let offset = ((i128::from(sample.t2) - i128::from(sample.t1))
            + (i128::from(sample.t3) - i128::from(sample.t4)))
            / 2;
        let Ok(offset) = i64::try_from(offset) else {
            return false;
        };
        let mid = sample.t1 + roundtrip / 2;
        if let Some(last) = self.window.back() {
            if mid <= last.0 {
                return false;
            }
            // Expire the old RTT floor as well as the fit. Otherwise a sustained
            // route change can reject every future sample and never recover.
            if mid - last.0 > CLOCK_FRESHNESS_NS {
                self.window.clear();
                self.discontinuities += 1;
            }
        }
        let minimum = self
            .window
            .iter()
            .map(|s| s.2)
            .min()
            .unwrap_or(rtt)
            .min(rtt);
        if rtt > minimum.saturating_mul(4).max(2_000_000) {
            return false;
        }
        if let Some(mapping) = self
            .mapping()
            .filter(|m| m.samples >= 8 && m.observation_span_ns >= 1_000_000_000)
        {
            let observed_host = i128::from(mid) + i128::from(offset);
            let predicted_host = mapping.host_time(mid).map(i128::from);
            let error = predicted_host.map(|predicted| (predicted - observed_host).unsigned_abs());
            // Frequency uncertainty comes from the uncertainty at both ends
            // of the observed span. Bound its extrapolation by the same 3s
            // freshness horizon that expires the fit above.
            let horizon = (mid - mapping.reference_local_ns).min(CLOCK_FRESHNESS_NS);
            let frequency_uncertainty =
                u128::from(mapping.uncertainty_ns) * 2 * u128::from(horizon)
                    / u128::from(mapping.observation_span_ns);
            let prediction_uncertainty =
                u128::from(mapping.uncertainty_ns) + u128::from(rtt / 2) + frequency_uncertainty;
            if error
                .is_none_or(|error| error > prediction_uncertainty.saturating_mul(4).max(2_000_000))
            {
                self.window.clear();
                self.discontinuities += 1;
            } else if error.is_some_and(|error| {
                error
                    > u128::from(mapping.residual_mad_ns.saturating_mul(6))
                        .max(prediction_uncertainty)
                        .max(200_000)
            }) {
                return false;
            }
        }
        self.window.push_back((mid, offset, rtt));
        while self.window.len() > self.capacity {
            self.window.pop_front();
        }
        true
    }
    pub fn mapping(&self) -> Option<ClockMapping> {
        let reference = self.window.back()?.0;
        let observation_span = reference - self.window.front()?.0;
        let x = |time: u64| (i128::from(time) - i128::from(reference)) as f64 / 1e9;
        let origin_offset = self.window.back()?.1;
        let y = |offset: i64| (i128::from(offset) - i128::from(origin_offset)) as f64;
        // Theil-Sen slope tolerates isolated asymmetric packets even during
        // initial convergence. The bounded window keeps this off-callback work
        // small (at most 64,620 pairs at the public 360-sample upper limit).
        let mut slopes = Vec::new();
        if self.window.len() >= 8 {
            for (i, a) in self.window.iter().enumerate() {
                for b in self.window.iter().skip(i + 1) {
                    let seconds = (b.0 - a.0) as f64 / 1e9;
                    if seconds >= 0.25 {
                        slopes.push((i128::from(b.1) - i128::from(a.1)) as f64 / seconds);
                    }
                }
            }
        }
        slopes.sort_by(f64::total_cmp);
        let slope = slopes.get(slopes.len() / 2).copied().unwrap_or(0.0);
        let mut intercepts: Vec<f64> = self
            .window
            .iter()
            .map(|s| y(s.1) - slope * x(s.0))
            .collect();
        intercepts.sort_by(f64::total_cmp);
        let intercept = intercepts[intercepts.len() / 2];
        let mut errors: Vec<f64> = intercepts.iter().map(|v| (v - intercept).abs()).collect();
        errors.sort_by(f64::total_cmp);
        let rtt = self.window.iter().map(|s| s.2).min().unwrap_or(0);
        let residual_mad_ns = (errors[errors.len() / 2] * 1.4826).ceil() as u64;
        // A dense earlier burst can still own the median while newer samples
        // disagree with its extrapolation. Include the latest residual so the
        // reported precision cannot hide that evidence and reject all updates.
        let latest_residual_ns = intercept.abs().ceil() as u64;
        Some(ClockMapping {
            reference_local_ns: reference,
            offset_ns: (i128::from(origin_offset) + intercept.round() as i128)
                .clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64,
            drift_ppm: slope / 1000.0,
            uncertainty_ns: residual_mad_ns
                .max(latest_residual_ns)
                .saturating_add(rtt / 2),
            min_rtt_ns: rtt,
            samples: self.window.len(),
            residual_mad_ns,
            observation_span_ns: observation_span,
        })
    }
    pub fn mapping_at(&self, local_now: u64) -> Option<ClockMapping> {
        self.mapping().filter(|mapping| mapping.valid_at(local_now))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(local: u64, offset: i64, ppm: f64) -> TimeSample {
        let host = |t: u64| (t as f64 * (1.0 + ppm * 1e-6) + offset as f64).round() as u64;
        TimeSample {
            t1: local,
            t2: host(local + 1_000_000),
            t3: host(local + 1_010_000),
            t4: local + 2_010_000,
        }
    }
    #[test]
    fn mapping_predicts_current_clock_without_half_window_drift_lag() {
        for ppm in [-150.0, 0.0, 180.0] {
            let mut estimator = Estimator::default();
            for second in 1..=240 {
                assert!(estimator.push(sample(second * 1_000_000_000, -500_000_000, ppm)));
            }
            let mapping = estimator.mapping().unwrap();
            assert!(mapping.converged());
            for local in [241_000_000_000u64, 250_000_000_000] {
                let expected = (local as f64 * (1.0 + ppm * 1e-6) - 500_000_000.0).round() as u64;
                assert!(mapping.host_time(local).unwrap().abs_diff(expected) < 1000);
                assert!(mapping.local_time(expected).unwrap().abs_diff(local) < 1000);
            }
        }
    }
    #[test]
    fn rejects_invalid_and_rtt_spikes_then_rebuilds_after_clock_step() {
        let mut estimator = Estimator::default();
        for second in 1..20 {
            estimator.push(sample(second * 1_000_000_000, 10_000_000, 20.0));
        }
        let mut spike = sample(20_000_000_000, 10_000_000, 20.0);
        spike.t4 += 50_000_000;
        assert!(!estimator.push(spike));
        assert!(!estimator.push(TimeSample {
            t1: 4,
            t2: 2,
            t3: 1,
            t4: 3
        }));
        assert!(estimator.push(sample(21_000_000_000, 110_000_000, 20.0)));
        assert_eq!(estimator.discontinuities(), 1);
        assert!(!estimator.mapping().unwrap().converged());
        for second in 22..35 {
            estimator.push(sample(second * 1_000_000_000, 110_000_000, 20.0));
        }
        assert!(estimator.mapping().unwrap().converged());
    }
    #[test]
    fn expires_stale_rtt_floor_and_reconverges_after_route_change() {
        let mut estimator = Estimator::default();
        for second in 1..=20 {
            assert!(estimator.push(sample(second * 1_000_000_000, 0, 0.0)));
        }
        assert!(estimator.mapping_at(24_000_000_000).is_none());
        for second in 21..=40 {
            let local = second * 1_000_000_000;
            let changed = TimeSample {
                t1: local,
                t2: local + 10_000_000,
                t3: local + 10_010_000,
                t4: local + 20_010_000,
            };
            estimator.push(changed);
        }
        let mapping = estimator.mapping().unwrap();
        assert!(mapping.reference_local_ns > 40_000_000_000);
        assert_eq!(mapping.min_rtt_ns, 20_000_000);
        // High RTT is valid data, but exceeds the 3ms precision gate.
        assert!(!mapping.converged());
    }
    #[test]
    fn asymmetric_sample_cannot_turn_offset_noise_into_frequency_drift() {
        let mut estimator = Estimator::new(8);
        for second in 1..=8 {
            assert!(estimator.push(sample(second * 1_000_000_000, 0, 0.0)));
        }
        // This offset is inside the measured RTT uncertainty. Admit it to the
        // robust fit; rejecting every such sample can freeze a startup slope
        // until its freshness lease expires on an otherwise healthy network.
        assert!(estimator.push(sample(9_000_000_000, 900_000, 0.0)));
        let mapping = estimator.mapping().unwrap();
        assert_eq!(mapping.drift_ppm, 0.0);
        assert_eq!(mapping.host_time(19_000_000_000), Some(19_000_000_000));
        assert!(!estimator.push(sample(8_000_000_000, 0, 0.0)));
    }
    #[test]
    fn startup_offset_noise_inside_measured_rtt_cannot_freeze_a_healthy_clock() {
        let mut estimator = Estimator::default();
        let measured = |local: u64, offset: i64| TimeSample {
            t1: local,
            t2: (i128::from(local) + 250_000 + i128::from(offset)) as u64,
            t3: (i128::from(local) + 260_000 + i128::from(offset)) as u64,
            t4: local + 510_000,
        };
        // An ordinary half-millisecond RTT contains a short correlated startup
        // asymmetry. Later unbiased measurements must refresh the fit rather
        // than all being rejected against a spuriously precise startup slope.
        for i in 0..20 {
            assert!(estimator.push(measured(
                1_000_000_000 + i * 100_000_000,
                100_000 - i as i64 * 10_000
            )));
        }
        for second in 4..=60 {
            let now = second * 1_000_000_000;
            assert!(
                estimator.push(measured(now, 0)),
                "healthy sample rejected at {second}s"
            );
            assert!(
                estimator.mapping_at(now + 900_000_000).is_some(),
                "clock became stale at {second}s"
            );
        }
        let mapping = estimator.mapping().unwrap();
        assert!(mapping.drift_ppm.abs() < 10.0);
        assert!(mapping.offset_ns.abs() < 100_000);
    }
    #[test]
    fn startup_asymmetry_near_the_rtt_boundary_keeps_refreshing_with_real_drift() {
        for ppm in [-180.0, 0.0, 180.0] {
            let mut estimator = Estimator::default();
            let host = |local: u64| (local as f64 * (1.0 + ppm * 1e-6)).round() as u64;
            let measured = |local: u64, offset: i64| TimeSample {
                t1: local,
                t2: (i128::from(host(local + 250_000)) + i128::from(offset)) as u64,
                t3: (i128::from(host(local + 260_000)) + i128::from(offset)) as u64,
                t4: local + 510_000,
            };
            for i in 0..20 {
                assert!(estimator.push(measured(
                    1_000_000_000 + i * 100_000_000,
                    247_000 - i as i64 * 26_000
                )));
            }
            for second in 4..=60 {
                let now = second * 1_000_000_000;
                assert!(
                    estimator.push(measured(now, 0)),
                    "rejected at {second}s, {ppm}ppm"
                );
                assert!(estimator.mapping_at(now + 900_000_000).is_some());
                assert_eq!(estimator.discontinuities(), 0);
            }
            let mapping = estimator.mapping().unwrap();
            assert!((mapping.drift_ppm - ppm).abs() < 10.0);
            assert!(
                mapping
                    .host_time(60_900_000_000)
                    .unwrap()
                    .abs_diff(host(60_900_000_000))
                    < 100_000
            );
        }
    }
    #[test]
    fn one_sparse_endpoint_outlier_cannot_own_a_later_dense_burst() {
        let mut estimator = Estimator::default();
        assert!(estimator.push(sample(1_000_000_000, 900_000, 0.0)));
        for i in 0..7 {
            assert!(estimator.push(sample(2_000_000_000 + i * 100_000_000, 0, 0.0)));
        }
        let mapping = estimator.mapping().unwrap();
        assert_eq!(mapping.drift_ppm, 0.0);
        assert_eq!(mapping.offset_ns, 0);
    }
    #[test]
    fn a_short_initial_burst_cannot_authorize_unmeasured_frequency_extrapolation() {
        let mut estimator = Estimator::default();
        for i in 0..8 {
            assert!(estimator.push(sample(1_000_000_000 + i * 3_000_000, 0, 2000.0)));
        }
        assert!(estimator.mapping_at(3_900_000_000).is_none());
        assert!(!estimator.mapping().unwrap().converged());
        for second in 2..=10 {
            assert!(estimator.push(sample(second * 1_000_000_000, 0, 2000.0)));
        }
        assert!(estimator.mapping_at(10_100_000_000).is_some());
    }
}
