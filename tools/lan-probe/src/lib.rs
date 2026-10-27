// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! P0 对时估计器与实验共用件（lan-listening §7.1）。
//!
//! 四时间戳交换：`offset = ((t2-t1)+(t3-t4))/2`、`rtt = (t4-t1)-(t3-t2)`，
//! t1/t4 在客户端时钟域，t2/t3 在服务端时钟域。样本按 RTT 剔除异常
//! （RTT > 拒绝系数 × 历史最小 RTT），偏移取中值；频率偏差对「偏移 vs
//! 服务端中点时间」做最小二乘。时钟突变（阶跃 > 8×不确定度）重建窗口，
//! 不沿用旧锚点。网络路径不对称的固有偏差不在此消除。

use std::collections::VecDeque;

/// 一次对时交换的四个时间戳（纳秒）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeSample {
    pub t1: u64,
    pub t2: u64,
    pub t3: u64,
    pub t4: u64,
}

impl TimeSample {
    /// 服务端相对客户端的钟差（服务端 − 客户端）。
    pub fn offset(&self) -> i64 {
        ((self.t2 as i64 - self.t1 as i64) + (self.t3 as i64 - self.t4 as i64)) / 2
    }
    /// 往返时延（客户端域）。
    pub fn rtt(&self) -> u64 {
        ((self.t4 - self.t1) as i64 - (self.t3 as i64 - self.t2 as i64)).max(0) as u64
    }
    /// 样本的服务端中点时间（漂移回归的自变量）。
    pub fn server_mid(&self) -> u64 {
        (self.t2 + self.t3) / 2
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClockEstimate {
    /// 服务端 − 客户端（纳秒）。
    pub offset_ns: i64,
    /// 中值绝对偏差 ×1.4826（纳秒）。
    pub uncertainty_ns: u64,
    pub rtt_ns: u64,
    /// 服务端相对客户端的频率偏差（ppm，正 = 服务端偏快）。
    pub drift_ppm: f64,
    pub accepted: usize,
    pub rejected: usize,
}

pub struct Estimator {
    window: VecDeque<(u64, i64, u64)>, // (server_mid, offset, rtt)
    capacity: usize,
    min_rtt: Option<u64>,
    reject_factor: f64,
    rejected: u64,
    discontinuities: u64,
    last_offset_median: Option<i64>,
    last_uncertainty: u64,
}

impl Estimator {
    /// `capacity` 为滑动窗口样本数；`reject_factor` 为 RTT 剔除倍数。
    pub fn new(capacity: usize, reject_factor: f64) -> Self {
        Self {
            window: VecDeque::with_capacity(capacity.max(2)),
            capacity: capacity.max(2),
            min_rtt: None,
            reject_factor,
            rejected: 0,
            discontinuities: 0,
            last_offset_median: None,
            last_uncertainty: u64::MAX,
        }
    }

    /// 喂入一个样本。返回 true 表示接受。先按 RTT 剔除，再检测时钟突变
    /// （阶跃超过 8×不确定度即清空重建，禁止沿用旧锚点）。
    pub fn push(&mut self, sample: TimeSample) -> bool {
        let rtt = sample.rtt();
        let min = *self.min_rtt.get_or_insert(rtt);
        if rtt < min {
            self.min_rtt = Some(rtt);
        }
        let threshold = (self.min_rtt.unwrap_or(rtt) as f64 * self.reject_factor).max(1.0);
        if rtt as f64 > threshold {
            self.rejected += 1;
            return false;
        }
        let offset = sample.offset();
        if let Some(median) = self.last_offset_median {
            let jump = (offset - median).unsigned_abs();
            if jump > self.last_uncertainty.saturating_mul(8).max(2_000_000) {
                self.window.clear();
                self.min_rtt = Some(rtt);
                self.discontinuities += 1;
                self.last_offset_median = None;
                self.last_uncertainty = u64::MAX;
            }
        }
        self.window.push_back((sample.server_mid(), offset, rtt));
        while self.window.len() > self.capacity {
            self.window.pop_front();
        }
        let estimate = self.estimate();
        if let Some(e) = estimate {
            self.last_offset_median = Some(e.offset_ns);
            self.last_uncertainty = e.uncertainty_ns;
        }
        true
    }

    /// 当前估计：偏移取接受样本的中值，RTT 取最小，漂移取最小二乘斜率。
    pub fn estimate(&self) -> Option<ClockEstimate> {
        if self.window.is_empty() {
            return None;
        }
        let mut offsets: Vec<i64> = self.window.iter().map(|(_, o, _)| *o).collect();
        offsets.sort_unstable();
        let median = offsets[offsets.len() / 2];
        let mad = median_abs_deviation(&offsets, median);
        let drift = least_squares_slope(&self.window);
        Some(ClockEstimate {
            offset_ns: median,
            uncertainty_ns: mad,
            rtt_ns: self.min_rtt.unwrap_or(0),
            drift_ppm: drift,
            accepted: self.window.len(),
            rejected: self.rejected as usize,
        })
    }

    pub fn discontinuities(&self) -> u64 {
        self.discontinuities
    }
}

fn median_abs_deviation(sorted_offsets: &[i64], median: i64) -> u64 {
    let mut devs: Vec<u64> = sorted_offsets.iter().map(|o| o.abs_diff(median)).collect();
    devs.sort_unstable();
    // ×1.4826 对齐正态标准差。
    ((devs[devs.len() / 2] as f64) * 1.4826).round() as u64
}

/// offset（ns）对 server_mid 的斜率 → ppm。
fn least_squares_slope(window: &VecDeque<(u64, i64, u64)>) -> f64 {
    if window.len() < 4 {
        return 0.0;
    }
    let n = window.len() as f64;
    let t0 = window[0].0 as f64;
    let mut sx = 0.0;
    let mut sy = 0.0;
    let mut sxx = 0.0;
    let mut sxy = 0.0;
    for (t, o, _) in window {
        let x = (*t as f64 - t0) / 1e9; // 秒
        let y = *o as f64;
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
    }
    let denom = n * sxx - sx * sx;
    if denom.abs() < 1e-9 {
        return 0.0;
    }
    // 斜率（ns 偏移 / 秒）：ppm = ns/s ÷ 1000（37ppm → 37000ns/s）。
    (n * sxy - sx * sy) / denom / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 模拟两钟 + 网络：client 真时，server = offset + drift；
    /// 每方向 delay_ms + jitter 均匀抖动，偶发 spike 概率加额外时延。
    struct Sim {
        offset_ns: i64,
        drift_ppm: f64,
        delay_ns: u64,
        jitter_ns: u64,
        spike_extra_ns: u64,
        spike_p: f64,
        t: u64,
        rng: u64,
    }

    impl Sim {
        fn next_f64(&mut self) -> f64 {
            self_rng_step(&mut self.rng)
        }
        /// 客户端钟 = 真时；服务端钟 = offset + 真时×(1+drift)。
        /// 返回样本与「服务端中点真时处的真实钟差」。
        fn sample(&mut self) -> (TimeSample, i64) {
            let delay = |s: &mut Self| {
                let mut d = s.delay_ns as f64 + s.next_f64() * s.jitter_ns as f64;
                if s.next_f64() < s.spike_p {
                    d += s.spike_extra_ns as f64;
                }
                d as u64
            };
            let t1 = self.t;
            let d1 = delay(self);
            let proc = 1_000u64;
            let d2 = delay(self);
            let t4 = t1 + d1 + proc + d2;
            let server = |real: u64| {
                (self.offset_ns as f64 + real as f64 * (1.0 + self.drift_ppm * 1e-6)) as u64
            };
            let t2 = server(t1 + d1);
            let t3 = server(t1 + d1 + proc);
            let truth_mid =
                self.offset_ns as f64 + ((t1 + d1 + proc / 2) as f64) * self.drift_ppm * 1e-6;
            self.t += 50_000_000; // 50ms 一次对时
            (TimeSample { t1, t2, t3, t4 }, truth_mid as i64)
        }
    }

    fn self_rng_step(state: &mut u64) -> f64 {
        *state ^= *state << 13;
        *state ^= *state >> 7;
        *state ^= *state << 17;
        (*state >> 11) as f64 / (1u64 << 53) as f64
    }

    /// 对称时延 + 抖动 + 尖峰：偏移误差收敛到亚毫秒。
    #[test]
    fn converges_under_symmetric_jitter() {
        let mut sim = Sim {
            offset_ns: 12_500_000,
            drift_ppm: 0.0,
            delay_ns: 1_000_000,
            jitter_ns: 400_000,
            spike_extra_ns: 40_000_000,
            spike_p: 0.05,
            t: 0,
            rng: 0x1234_5678,
        };
        let mut est = Estimator::new(16, 3.0);
        let mut errors = Vec::new();
        for _ in 0..200 {
            let (s, truth) = sim.sample();
            est.push(s);
            if let Some(e) = est.estimate() {
                errors.push((e.offset_ns - truth).abs() as f64 / 1e6);
            }
        }
        let tail = &errors[errors.len() - 50..];
        let max = tail.iter().cloned().fold(0.0f64, f64::max);
        assert!(max < 0.5, "收敛后最大误差 {max} ms 超过 0.5ms");
        assert!(est.estimate().unwrap().rejected > 0, "尖峰应被剔除");
    }

    /// 非对称时延的固有偏差约为不对称量的一半（文档口径，不声称消除）。
    #[test]
    fn asymmetric_delay_bias_is_bounded() {
        let mut sim = Sim {
            offset_ns: 0,
            drift_ppm: 0.0,
            delay_ns: 1_000_000,
            jitter_ns: 200_000,
            spike_extra_ns: 0,
            spike_p: 0.0,
            t: 0,
            rng: 0xdead_beef,
        };
        // 手动改一侧时延：t2 方向 +6ms。
        let mut est = Estimator::new(16, 3.0);
        let mut errors = Vec::new();
        for _ in 0..100 {
            let t1 = sim.t;
            let t2 = t1 + 7_000_000 + (sim.next_f64() * 200_000.0) as u64;
            let t3 = t2 + 1_000;
            let t4 = t3 + 1_000_000 + (sim.next_f64() * 200_000.0) as u64;
            sim.t += 50_000_000;
            est.push(TimeSample { t1, t2, t3, t4 });
            if let Some(e) = est.estimate() {
                errors.push((e.offset_ns - 0).abs() as f64 / 1e6);
            }
        }
        let last = *errors.last().unwrap();
        // 期望 ≈ 3ms；只挡量级错误（方向/公式错会给出 ≈6ms 或 0）。
        assert!(
            (2.0..=4.0).contains(&last),
            "非对称偏差 {last} ms 不在 2–4ms"
        );
    }

    /// 频率偏差被最小二乘恢复（±5ppm 内；窗口需覆盖足够时间跨度）。
    #[test]
    fn drift_is_recovered() {
        let mut sim = Sim {
            offset_ns: 5_000_000,
            drift_ppm: 37.0,
            delay_ns: 1_000_000,
            jitter_ns: 100_000,
            spike_extra_ns: 0,
            spike_p: 0.0,
            t: 0,
            rng: 0xfeed_face,
        };
        let mut est = Estimator::new(200, 3.0);
        for _ in 0..500 {
            let (s, _) = sim.sample();
            est.push(s);
        }
        let drift = est.estimate().unwrap().drift_ppm;
        assert!(
            (drift - 37.0).abs() < 5.0,
            "漂移估计 {drift} ppm 偏离 37ppm 超过 5ppm"
        );
    }

    /// 时钟阶跃触发重建并重新收敛。
    #[test]
    fn step_change_resets_and_reconverges() {
        let mut sim = Sim {
            offset_ns: 0,
            drift_ppm: 0.0,
            delay_ns: 1_000_000,
            jitter_ns: 100_000,
            spike_extra_ns: 0,
            spike_p: 0.0,
            t: 0,
            rng: 7,
        };
        let mut est = Estimator::new(16, 3.0);
        for _ in 0..40 {
            let (s, _) = sim.sample();
            est.push(s);
        }
        assert!(est.discontinuities() == 0);
        sim.offset_ns = 90_000_000; // 阶跃 +90ms
        for _ in 0..40 {
            let (s, _) = sim.sample();
            est.push(s);
        }
        assert!(est.discontinuities() >= 1, "阶跃应触发重建");
        let e = est.estimate().unwrap();
        assert!((e.offset_ns - 90_000_000).abs() < 500_000);
    }
}
