// SPDX-License-Identifier: MIT
//! Continuous affine mapping of client monotonic time to the host clock.
use std::collections::VecDeque;
use std::time::Instant;

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
            && self.uncertainty_ns <= 3_000_000
            && self.min_rtt_ns <= 50_000_000
            && self.drift_ppm.abs() <= 5000.0
    }
}

pub struct Estimator {
    window: VecDeque<(u64, i64, u64)>,
    capacity: usize,
    min_rtt: Option<u64>,
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
            capacity: capacity.clamp(8, 3600),
            min_rtt: None,
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
        let minimum = self.min_rtt.unwrap_or(rtt).min(rtt);
        if rtt > minimum.saturating_mul(4).max(2_000_000) {
            return false;
        }
        if let Some(mapping) = self.mapping().filter(|m| m.samples >= 8) {
            let observed_host = i128::from(mid) + i128::from(offset);
            let predicted_host = mapping.host_time(mid).map(i128::from);
            if predicted_host.is_none_or(|predicted| {
                (predicted - observed_host).unsigned_abs()
                    > u128::from(mapping.uncertainty_ns.saturating_mul(8).max(2_000_000))
            }) {
                self.window.clear();
                self.min_rtt = None;
                self.discontinuities += 1;
            }
        }
        self.min_rtt = Some(self.min_rtt.unwrap_or(rtt).min(rtt));
        self.window.push_back((mid, offset, rtt));
        while self.window.len() > self.capacity {
            self.window.pop_front();
        }
        true
    }
    pub fn mapping(&self) -> Option<ClockMapping> {
        let reference = self.window.back()?.0;
        let n = self.window.len() as f64;
        let x = |time: u64| (i128::from(time) - i128::from(reference)) as f64 / 1e9;
        let mean_x = self.window.iter().map(|s| x(s.0)).sum::<f64>() / n;
        let origin_offset = self.window.back()?.1;
        let y = |offset: i64| (i128::from(offset) - i128::from(origin_offset)) as f64;
        let mean_y = self.window.iter().map(|s| y(s.1)).sum::<f64>() / n;
        let denom = self
            .window
            .iter()
            .map(|s| (x(s.0) - mean_x).powi(2))
            .sum::<f64>();
        let slope = if self.window.len() >= 8 && denom > 0.01 {
            self.window
                .iter()
                .map(|s| (x(s.0) - mean_x) * (y(s.1) - mean_y))
                .sum::<f64>()
                / denom
        } else {
            0.0
        };
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
        Some(ClockMapping {
            reference_local_ns: reference,
            offset_ns: (i128::from(origin_offset) + intercept.round() as i128)
                .clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64,
            drift_ppm: slope / 1000.0,
            uncertainty_ns: (errors[errors.len() / 2] * 1.4826).ceil() as u64 + rtt / 2,
            min_rtt_ns: rtt,
            samples: self.window.len(),
        })
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
}
