// SPDX-License-Identifier: MIT
//! Bounded local-output lookahead protection. All buffers/plans are prepared off-thread.
//! A finite interpolation detector is a measurement model, not a DAC guarantee.

const TAPS: usize = 128;
const CENTER: usize = TAPS / 2 - 1;

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn dot_avx2(taps: &[f64; TAPS], history: &[f64]) -> f64 {
    use std::arch::x86_64::*;
    // Selected once during preparation after feature detection. Every caller
    // supplies the full contiguous 128-sample detector window.
    let mut a = _mm256_setzero_pd();
    let mut b = a;
    let mut c = a;
    let mut d = a;
    for i in (0..TAPS).step_by(16) {
        a = _mm256_add_pd(
            a,
            _mm256_mul_pd(
                _mm256_loadu_pd(taps.as_ptr().add(i)),
                _mm256_loadu_pd(history.as_ptr().add(i)),
            ),
        );
        b = _mm256_add_pd(
            b,
            _mm256_mul_pd(
                _mm256_loadu_pd(taps.as_ptr().add(i + 4)),
                _mm256_loadu_pd(history.as_ptr().add(i + 4)),
            ),
        );
        c = _mm256_add_pd(
            c,
            _mm256_mul_pd(
                _mm256_loadu_pd(taps.as_ptr().add(i + 8)),
                _mm256_loadu_pd(history.as_ptr().add(i + 8)),
            ),
        );
        d = _mm256_add_pd(
            d,
            _mm256_mul_pd(
                _mm256_loadu_pd(taps.as_ptr().add(i + 12)),
                _mm256_loadu_pd(history.as_ptr().add(i + 12)),
            ),
        );
    }
    let sum = _mm256_add_pd(_mm256_add_pd(a, b), _mm256_add_pd(c, d));
    let half = _mm_add_pd(_mm256_castpd256_pd128(sum), _mm256_extractf128_pd(sum, 1));
    _mm_cvtsd_f64(_mm_add_sd(half, _mm_unpackhi_pd(half, half)))
}

#[inline]
fn dot(taps: &[f64; TAPS], history: &[f64]) -> f64 {
    debug_assert!(history.len() >= TAPS);
    #[cfg(target_arch = "x86_64")]
    {
        // SSE2 is an x86-64 baseline feature. Both slices contain 128 doubles;
        // unaligned loads avoid imposing allocation/alignment requirements.
        use std::arch::x86_64::*;
        unsafe {
            let mut a = _mm_setzero_pd();
            let mut b = a;
            let mut c = a;
            let mut d = a;
            for i in (0..TAPS).step_by(8) {
                a = _mm_add_pd(
                    a,
                    _mm_mul_pd(
                        _mm_loadu_pd(taps.as_ptr().add(i)),
                        _mm_loadu_pd(history.as_ptr().add(i)),
                    ),
                );
                b = _mm_add_pd(
                    b,
                    _mm_mul_pd(
                        _mm_loadu_pd(taps.as_ptr().add(i + 2)),
                        _mm_loadu_pd(history.as_ptr().add(i + 2)),
                    ),
                );
                c = _mm_add_pd(
                    c,
                    _mm_mul_pd(
                        _mm_loadu_pd(taps.as_ptr().add(i + 4)),
                        _mm_loadu_pd(history.as_ptr().add(i + 4)),
                    ),
                );
                d = _mm_add_pd(
                    d,
                    _mm_mul_pd(
                        _mm_loadu_pd(taps.as_ptr().add(i + 6)),
                        _mm_loadu_pd(history.as_ptr().add(i + 6)),
                    ),
                );
            }
            let sum = _mm_add_pd(_mm_add_pd(a, b), _mm_add_pd(c, d));
            _mm_cvtsd_f64(_mm_add_sd(sum, _mm_unpackhi_pd(sum, sum)))
        }
    }
    #[cfg(not(target_arch = "x86_64"))]
    taps.iter().zip(history).map(|(a, b)| a * b).sum()
}

pub(crate) struct Detector {
    dot: unsafe fn(&[f64; TAPS], &[f64]) -> f64,
    coefficients: Vec<[f64; TAPS]>,
    history: [[f64; TAPS * 2]; 2],
    write: usize,
    channels: usize,
}

impl Detector {
    pub(crate) fn new(rate: u32, channels: usize) -> Self {
        let dot: unsafe fn(&[f64; TAPS], &[f64]) -> f64 = {
            #[cfg(target_arch = "x86_64")]
            {
                if std::is_x86_feature_detected!("avx2") {
                    dot_avx2
                } else {
                    dot
                }
            }
            #[cfg(not(target_arch = "x86_64"))]
            {
                dot
            }
        };
        let phases = 8;
        let _ = rate;
        let coefficients = (0..phases)
            .map(|phase| {
                let fraction = phase as f64 / phases as f64;
                let mut taps = std::array::from_fn(|i| {
                    let x = i as f64 - CENTER as f64 - fraction;
                    let sinc = if x.abs() < 1e-12 {
                        1.0
                    } else {
                        (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
                    };
                    let window = if x.abs() > TAPS as f64 * 0.5 {
                        0.0
                    } else {
                        0.5 + 0.5 * (std::f64::consts::TAU * x / TAPS as f64).cos()
                    };
                    sinc * window
                });
                let sum: f64 = taps.iter().sum();
                for tap in &mut taps {
                    *tap /= sum;
                }
                taps
            })
            .collect();
        Self {
            dot,
            coefficients,
            history: [[0.0; TAPS * 2]; 2],
            write: 0,
            channels,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.history = [[0.0; TAPS * 2]; 2];
        self.write = 0;
    }

    pub(crate) fn push(&mut self, frame: &[f32]) -> f32 {
        for (ch, value) in frame.iter().take(self.channels).enumerate() {
            let sample = if value.is_finite() {
                *value as f64
            } else {
                0.0
            };
            self.history[ch][self.write] = sample;
            self.history[ch][self.write + TAPS] = sample;
        }
        self.write = (self.write + 1) % TAPS;
        let mut peak = 0.0f64;
        for ch in 0..self.channels {
            let history = &self.history[ch][self.write..self.write + TAPS];
            for taps in &self.coefficients {
                // The prepared implementation's ISA was checked off-thread;
                // this slice is exactly TAPS entries, including at ring wrap.
                peak = peak.max(unsafe { (self.dot)(taps, history) }.abs());
            }
        }
        peak as f32
    }
}

pub(crate) struct Limiter {
    detector: Detector,
    output_meter: Detector,
    delay: Vec<[f32; 2]>,
    gain_limits: Vec<f64>,
    lookahead: usize,
    channels: usize,
    latency: usize,
    frame: u64,
    accepted: u64,
    produced: u64,
    meter_flush: usize,
    gain: f64,
    release: f64,
    ceiling: f64,
    pub(crate) output_peak: f32,
    pub(crate) reduction_db: f32,
}

impl Limiter {
    pub(crate) fn new(rate: u32, channels: usize) -> Self {
        assert!((1..=2).contains(&channels));
        let lookahead = (rate as u64 * 5).div_ceil(1000) as usize;
        let latency = lookahead + (TAPS - 1 - CENTER);
        Self {
            detector: Detector::new(rate, channels),
            output_meter: Detector::new(rate, channels),
            delay: vec![[0.0; 2]; latency + 1],
            gain_limits: vec![1.0; latency + 1],
            lookahead,
            channels,
            latency,
            frame: 0,
            accepted: 0,
            produced: 0,
            meter_flush: 0,
            gain: 1.0,
            release: (-1.0 / (rate as f64 * 0.1)).exp(),
            // The support-aware envelope is checked against an independent
            // reconstruction; 0.1dB accommodates finite numerical error.
            ceiling: 10.0f64.powf(-1.1 / 20.0),
            output_peak: 0.0,
            reduction_db: 0.0,
        }
    }
    pub(crate) fn latency_frames(&self) -> usize {
        self.latency
    }
    pub(crate) fn queued_frames(&self) -> u64 {
        self.accepted - self.produced
    }
    pub(crate) fn reset(&mut self) {
        self.detector.reset();
        self.output_meter.reset();
        self.delay.fill([0.0; 2]);
        self.gain_limits.fill(1.0);
        self.frame = 0;
        self.accepted = 0;
        self.produced = 0;
        self.meter_flush = 0;
        self.gain = 1.0;
        self.output_peak = 0.0;
        self.reduction_db = 0.0;
    }
    pub(crate) fn push(&mut self, frame: &[f32], out: &mut [f32]) -> bool {
        self.meter_flush = 0;
        self.accepted += 1;
        self.step(frame, out)
    }
    pub(crate) fn finish_meter_frame(&mut self) {
        if self.meter_flush < TAPS {
            self.output_peak = self.output_peak.max(self.output_meter.push(&[0.0; 2]));
            self.meter_flush += 1;
        }
    }
    pub(crate) fn finish_frame(&mut self, out: &mut [f32]) -> bool {
        if self.queued_frames() == 0 {
            return false;
        }
        self.step(&[0.0; 2], out)
    }
    fn step(&mut self, input: &[f32], out: &mut [f32]) -> bool {
        let slot = self.frame as usize % self.delay.len();
        for (dst, src) in self.delay[slot].iter_mut().zip(input).take(self.channels) {
            *dst = if src.is_finite() { *src } else { 0.0 };
        }
        let measured = self.detector.push(input);
        let output_frame = self.frame.saturating_sub(self.latency as u64);
        if let Some(center) = self.frame.checked_sub((TAPS - 1 - CENTER) as u64) {
            let target = (self.ceiling / (measured as f64).max(self.ceiling)).min(1.0);
            if target < 1.0 {
                // Every detected interval contributes its own ramp constraint.
                // Keeping only the largest future peak loses earlier, smaller
                // constraints when the maximum's deadline moves forward.
                let start = center.saturating_sub(self.lookahead as u64);
                let attack_end = center.saturating_sub(CENTER as u64);
                let hold_end = center + (TAPS - 1 - CENTER) as u64;
                let divisor = self.lookahead.saturating_sub(CENTER).max(1) as f64;
                let mut slot = start as usize % self.gain_limits.len();
                for at in start..=hold_end {
                    let distance = attack_end.saturating_sub(at) as f64;
                    let limit = target + (1.0 - target) * (distance / divisor).min(1.0);
                    self.gain_limits[slot] = self.gain_limits[slot].min(limit);
                    slot += 1;
                    if slot == self.gain_limits.len() {
                        slot = 0;
                    }
                }
            }
        }
        let envelope = self.gain_limits[output_frame as usize % self.gain_limits.len()];
        self.gain = (1.0 + (self.gain - 1.0) * self.release).min(envelope);
        self.reduction_db = (-20.0 * self.gain.max(1e-30).log10()) as f32;
        let ready = self.frame >= self.latency as u64 && self.produced < self.accepted;
        if ready {
            let source = self.delay[output_frame as usize % self.delay.len()];
            for ch in 0..self.channels {
                out[ch] = (source[ch] as f64 * self.gain) as f32;
            }
            self.output_peak = self.output_peak.max(self.output_meter.push(out));
            self.produced += 1;
            let slot = output_frame as usize % self.gain_limits.len();
            self.gain_limits[slot] = 1.0;
        } else {
            out.fill(0.0);
        }
        self.frame += 1;
        ready
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Longer, independently constructed windowed-sinc reconstruction at 8x.
    fn reference_peak(samples: &[f32]) -> f64 {
        let mut peak = 0.0f64;
        for center in 0..samples.len() {
            for phase in 0..8 {
                let t = center as f64 + phase as f64 / 8.0;
                let mut value = 0.0;
                let mut norm = 0.0;
                for offset in -63..=64 {
                    let index = center as isize + offset;
                    let x = t - index as f64;
                    let sinc = if x.abs() < 1e-12 {
                        1.0
                    } else {
                        (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
                    };
                    let window = 0.5 + 0.5 * (std::f64::consts::PI * x / 64.0).cos();
                    let h = sinc * window;
                    norm += h;
                    if index >= 0 && (index as usize) < samples.len() {
                        value += samples[index as usize] as f64 * h;
                    }
                }
                peak = peak.max((value / norm).abs());
            }
        }
        peak
    }
    fn run(input: &[f32], rate: u32) -> Vec<f32> {
        let mut limiter = Limiter::new(rate, 1);
        let mut output = Vec::new();
        let mut frame = [0.0];
        for sample in input {
            if limiter.push(&[*sample], &mut frame) {
                output.push(frame[0]);
            }
        }
        let mut steps = 0;
        while limiter.queued_frames() > 0 {
            if limiter.finish_frame(&mut frame) {
                output.push(frame[0]);
            }
            steps += 1;
            assert!(steps <= limiter.latency_frames());
        }
        assert_eq!(output.len(), input.len());
        output
    }
    #[test]
    fn transparent_low_level_short_eof_and_reset() {
        for size in [1, 7, 128, 1000] {
            let input: Vec<_> = (0..size).map(|i| (i as f32 * 0.3).sin() * 0.1).collect();
            assert_eq!(run(&input, 48_000), input);
        }
        let mut limiter = Limiter::new(48_000, 2);
        for _ in 0..100 {
            limiter.push(&[2.0, -2.0], &mut [0.0; 2]);
        }
        limiter.reset();
        assert_eq!(limiter.queued_frames(), 0);
        assert_eq!(limiter.gain, 1.0);
    }
    #[test]
    fn independent_output_peak_after_gain_envelope() {
        for rate in [44_100, 48_000, 96_000] {
            for frequency in [997.0, rate as f64 * 0.43] {
                let input: Vec<_> = (0..1600)
                    .map(|i| {
                        let amplitude = if (400..900).contains(&i) { 2.0 } else { 0.3 };
                        (amplitude
                            * (i as f64 * std::f64::consts::TAU * frequency / rate as f64 + 0.6)
                                .sin()) as f32
                    })
                    .collect();
                let output = run(&input, rate);
                let peak = reference_peak(&output);
                assert!(
                    peak <= 10.0f64.powf(-1.0 / 20.0),
                    "{rate} {frequency}: {} dBTP",
                    20.0 * peak.log10()
                );
            }
        }
    }

    #[test]
    fn finite_extreme_impulse_reaches_ceiling_before_presentation() {
        for amplitude in [1.0, 10.0, 1000.0, 10000.0] {
            let output = run(&[amplitude], 48_000);
            assert!(
                output[0].abs() <= 10.0f32.powf(-1.0 / 20.0),
                "{amplitude}: {}",
                output[0]
            );
        }
    }

    #[test]
    fn independent_frequency_phase_sweep() {
        let mut worst = 0.0f64;
        for rate in [44_100, 48_000, 96_000] {
            for ratio in [0.02, 0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.43, 0.46, 0.49] {
                for phase in [0.0, 0.3, 0.6, 1.2, 1.57, 2.4] {
                    let input: Vec<_> = (0..1024)
                        .map(|n| {
                            (2.0 * (n as f64 * std::f64::consts::TAU * ratio + phase).sin()) as f32
                        })
                        .collect();
                    let output = run(&input, rate);
                    let peak = reference_peak(&output);
                    worst = worst.max(peak);
                    assert!(
                        peak <= 10.0f64.powf(-1.0 / 20.0),
                        "rate={rate} ratio={ratio} phase={phase} {} dBTP",
                        20.0 * peak.log10()
                    );
                }
            }
        }
        eprintln!("true-peak sweep worst={} dBTP", 20.0 * worst.log10());
    }

    #[test]
    fn sparse_alternating_extreme_bursts_stay_below_reference_ceiling() {
        let mut worst = 0.0f64;
        for rate in [44_100, 48_000, 96_000] {
            for first in [0, 1, 7, 31, 63, 127] {
                for gap in [1, 2, 3, 7, 15, 31, 63, 127] {
                    for signs in [(10.0, 10.0), (10.0, -10.0), (-10.0, 10.0), (-10.0, -10.0)] {
                        let mut input = vec![0.0; 512];
                        input[first] = signs.0;
                        input[first + gap] = signs.1;
                        let output = run(&input, rate);
                        let peak = reference_peak(&output);
                        worst = worst.max(peak);
                        assert!(
                            peak <= 10.0f64.powf(-1.0 / 20.0),
                            "rate={rate} first={first} gap={gap} signs={signs:?} {} dBTP",
                            20.0 * peak.log10()
                        );
                    }
                }
            }
        }
        eprintln!("sparse true-peak worst={} dBTP", 20.0 * worst.log10());
    }

    #[test]
    fn independent_short_bursts_and_extreme_edges() {
        let mut seed = 17u32;
        for rate in [44_100, 48_000, 96_000] {
            for shape in 0..24 {
                let input: Vec<_> = (0..768)
                    .map(|i| {
                        seed ^= seed << 13;
                        seed ^= seed >> 17;
                        seed ^= seed << 5;
                        match shape % 4 {
                            0 => {
                                if i == shape as usize * 17 || i == 767 {
                                    10000.0
                                } else {
                                    0.0
                                }
                            }
                            1 => {
                                if (128..420).contains(&i) {
                                    (2.0 * (i as f64 * std::f64::consts::TAU * 0.49
                                        + shape as f64 * 0.1)
                                        .sin()) as f32
                                } else {
                                    0.0
                                }
                            }
                            2 => (seed as f64 / u32::MAX as f64 * 8.0 - 4.0) as f32,
                            _ => {
                                if i < 384 {
                                    1.5
                                } else {
                                    -1.5
                                }
                            }
                        }
                    })
                    .collect();
                let output = run(&input, rate);
                let peak = reference_peak(&output);
                assert!(
                    peak <= 10.0f64.powf(-1.0 / 20.0),
                    "rate {rate} shape {shape}: {}dBTP",
                    20.0 * peak.log10()
                );
            }
        }
    }
}
