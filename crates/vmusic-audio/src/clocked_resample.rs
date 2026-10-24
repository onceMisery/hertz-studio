// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 接收侧可变比 sinc 转换（lan-listening §7.3 的动态重采样路径）。
//!
//! 与 [`crate::resample`] 的固定比例契约并存：那边是解码线程上一次性的
//! 源→设备域转换；这边是接收端连续运行的「格式转换 + 时钟漂移」合并转换，
//! 变比随对时估计平滑更新（内部限速 slew），同一接收链只做这一次转换。
//!
//! 机制：窗 sinc 多相表（相位子表间线性插值）+ f64 相位累加器。相位在变比
//! 变化时保持连续，不存在整块跳变或周期性 seek；每个输出帧最多改变
//! `MAX_RATIO_STEP_PER_FRAME` 的瞬时变比，±500ppm 的目标变化约 1 秒内平滑
//! 达成。`process` 全程零分配；表与缓冲在 `new` 预备。
//!
//! 时序口径：产生输出帧需要 `half = TAPS/2` 帧输入前视（lookahead），输出
//! 帧 y 对应输入时间轴上的绝对相位 pos（从 0 起）。滤波器对阶跃脉冲的峰值
//! 落在 pos = 脉冲帧号处（见脉冲回归）；`reset` 后从相位 0 重新开始，预热
//! 策略（用静音填充转换历史）由接收端调度决定，不在这里隐含。

/// 每输出帧访问的输入帧数（偶数；前视 = TAPS/2）。
const TAPS: usize = 256;
/// 相位子表密度：相邻子相位之间线性插值。
const SUBPHASES: usize = 1024;
/// 内部历史容量（输入帧）。超过即调用方生产过快，明确溢出而不是丢弃。
const HISTORY_CAP: usize = 16384;
/// 压缩阈值：落后于相位的无用历史帧超过该值才 memmove 清理。
const COMPACT_THRESHOLD: usize = 2048;
/// 瞬时变比每输出帧的最大变化量。500ppm ≈ 1 秒内平滑达成。
const MAX_RATIO_STEP_PER_FRAME: f64 = 1.5e-8;

pub const ALGORITHM: &str = "clocked-sinc-taps256-sub1024-bh4-cutoff095-slew1e8-v2";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// 缓冲里的输入不足以覆盖前视，需要更多输入。
    NeedInput,
    /// 输出缓冲已满，输入已全部收下。
    NeedOutput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub consumed_frames: usize,
    pub produced_frames: usize,
    pub state: State,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("unsupported clocked resampling format")]
    Format,
    #[error("buffers must contain complete interleaved frames")]
    Alignment,
    #[error("non-finite PCM")]
    NonFinite,
    #[error("clocked history overflow: caller produced faster than consumed")]
    Overflow,
}

/// 可变比流式转换器。通道交错布局，与 [`crate::resample::Converter`] 一致。
#[derive(Debug)]
pub struct ClockedConverter {
    channels: usize,
    nominal_ratio: f64,
    /// 目标瞬时变比（输入帧/输出帧），= nominal × (1 + ppm×1e-6)。
    target_ratio: f64,
    /// 当前瞬时变比（内部向 target 限速逼近）。
    ratio: f64,
    /// 窗 sinc 表：(SUBPHASES+1) × TAPS，行 = 相位子表。
    table: Vec<f32>,
    /// 交错历史缓冲。
    buf: Vec<f32>,
    /// buf[0] 的绝对输入帧号。构造时以 `half` 帧静音预热（base = −half），
    /// 使输出 y[m] 精确对应输入相位 m；起动期是零前缀滤波瞬态。
    base: i64,
    /// 下一个输出帧对应的绝对输入相位（输入帧单位）。
    pos: f64,
    half: usize,
    consumed: u64,
    produced: u64,
}

impl ClockedConverter {
    pub fn new(input_rate: u32, output_rate: u32, channels: usize) -> Result<Self, Error> {
        if !(1..=768_000).contains(&input_rate)
            || !(1..=768_000).contains(&output_rate)
            || !(1..=32).contains(&channels)
        {
            return Err(Error::Format);
        }
        let nominal = f64::from(input_rate) / f64::from(output_rate);
        if !(1.0 / 64.0..=64.0).contains(&nominal) {
            return Err(Error::Format);
        }
        let half = TAPS / 2;
        // build_table 的 sin(πcu)/(πu) 中 c 以输入奈奎斯特归一化，
        // 下变换时对应 out/in；不能再乘 0.5，否则同率也会砍掉一半通带。
        let c = 0.95 * f64::min(1.0, f64::from(output_rate) / f64::from(input_rate));
        let table = build_table(c, half);
        let mut buf = Vec::with_capacity(HISTORY_CAP * channels);
        buf.resize(half * channels, 0.0);
        Ok(Self {
            channels,
            nominal_ratio: nominal,
            target_ratio: nominal,
            ratio: nominal,
            table,
            buf,
            base: -(half as i64),
            pos: 0.0,
            half,
            consumed: 0,
            produced: 0,
        })
    }

    /// 标称变比（input_rate/output_rate）。
    pub fn nominal_ratio(&self) -> f64 {
        self.nominal_ratio
    }

    /// 当前瞬时变比（输入帧/输出帧）。
    pub fn ratio(&self) -> f64 {
        self.ratio
    }

    /// 目标漂移（ppm）。正值表示接收端设备时钟偏快，需要更多输入帧/输出帧。
    pub fn set_drift_ppm(&mut self, ppm: f64) {
        let clamped = ppm.clamp(-5000.0, 5000.0);
        self.target_ratio = self.nominal_ratio * (1.0 + clamped * 1e-6);
    }

    /// 输出帧需要的输入前视帧数（half = TAPS/2）。
    pub fn lookahead_frames(&self) -> u64 {
        self.half as u64
    }

    /// 已消耗/已产生的累计帧数（重置于 `reset`）。
    pub fn counts(&self) -> (u64, u64) {
        (self.consumed, self.produced)
    }

    /// 丢弃转换历史，从相位 0 重新开始（换代际/重同步用）。
    pub fn reset(&mut self) {
        self.buf.clear();
        self.buf.resize(self.half * self.channels, 0.0);
        self.base = -(self.half as i64);
        self.pos = 0.0;
        self.ratio = self.nominal_ratio;
        self.target_ratio = self.nominal_ratio;
        self.consumed = 0;
        self.produced = 0;
    }

    /// 收下一块输入并尽量产出输出。输入总是整块收下（进历史缓冲）；
    /// 产出受前视与输出空间限制。`State::NeedInput` 表示缓冲不足以覆盖
    /// 前视，`NeedOutput` 表示输出缓冲已满。
    pub fn process(&mut self, input: &[f32], output: &mut [f32]) -> Result<Progress, Error> {
        if !input.len().is_multiple_of(self.channels) || !output.len().is_multiple_of(self.channels)
        {
            return Err(Error::Alignment);
        }
        let in_frames = input.len() / self.channels;
        self.compact();
        let buffered = self.buf.len() / self.channels;
        if buffered + in_frames > HISTORY_CAP {
            return Err(Error::Overflow);
        }
        if input.iter().any(|v| !v.is_finite()) {
            return Err(Error::NonFinite);
        }
        self.buf.extend_from_slice(input);
        self.consumed = self
            .consumed
            .checked_add(in_frames as u64)
            .ok_or(Error::Overflow)?;

        let channels = self.channels;
        let table = &self.table;
        let half = self.half as i64;
        let mut produced = 0usize;
        let out_frames = output.len() / channels;
        while produced < out_frames {
            let pos_int = self.pos.floor() as i64;
            let frac = self.pos - self.pos.floor();
            // 需要 n ∈ [pos_int-half+1, pos_int+half] 全部在缓冲内。
            let last_needed = pos_int + half;
            let buffered_end = self.base + (self.buf.len() / channels) as i64;
            if last_needed >= buffered_end {
                break;
            }
            let first_needed = pos_int + 1 - half;
            debug_assert!(first_needed >= self.base);
            let start = (first_needed - self.base) as usize * channels;
            // 变比限速逼近目标，相位按当前瞬时变比推进。
            let step = self.target_ratio - self.ratio;
            self.ratio += step.clamp(-MAX_RATIO_STEP_PER_FRAME, MAX_RATIO_STEP_PER_FRAME);
            let pf = frac * SUBPHASES as f64;
            let p0 = pf.floor() as usize;
            let a = (pf - p0 as f64) as f32;
            let row0 = &table[p0 * TAPS..p0 * TAPS + TAPS];
            let row1 = &table[p0 * TAPS + TAPS..p0 * TAPS + 2 * TAPS];
            let at = produced * channels;
            for ch in 0..channels {
                let mut acc = 0.0f32;
                let mut idx = start + ch;
                for j in 0..TAPS {
                    let tap = row0[j] + (row1[j] - row0[j]) * a;
                    acc += self.buf[idx] * tap;
                    idx += channels;
                }
                output[at + ch] = acc;
            }
            if output[at..at + channels].iter().any(|v| !v.is_finite()) {
                return Err(Error::NonFinite);
            }
            self.pos += self.ratio;
            produced += 1;
        }
        self.produced = self
            .produced
            .checked_add(produced as u64)
            .ok_or(Error::Overflow)?;
        let state = if out_frames == 0 || produced == out_frames {
            State::NeedOutput
        } else {
            State::NeedInput
        };
        Ok(Progress {
            consumed_frames: in_frames,
            produced_frames: produced,
            state,
        })
    }

    /// 清理相位之前不再需要的历史。
    fn compact(&mut self) {
        let first_needed = self.pos.floor() as i64 + 1 - self.half as i64;
        let drop = (first_needed - self.base).max(0) as usize;
        if drop >= COMPACT_THRESHOLD {
            let samples = drop * self.channels;
            self.buf.drain(..samples);
            self.base += drop as i64;
        }
    }
}

/// 构造窗 sinc 表：行 r（0..=SUBPHASES）对应相位 r/SUBPHASES，
/// 列 j 对应输入帧 n = pos_int − half + 1 + j，u = t − n。
fn build_table(c: f64, half: usize) -> Vec<f32> {
    let mut table = vec![0.0f32; (SUBPHASES + 1) * TAPS];
    for r in 0..=SUBPHASES {
        let phase = r as f64 / SUBPHASES as f64;
        for j in 0..TAPS {
            let u = phase + half as f64 - 1.0 - j as f64;
            let sinc = if u.abs() < 1e-12 {
                c
            } else {
                (std::f64::consts::PI * c * u).sin() / (std::f64::consts::PI * u)
            };
            // 4 项 Blackman-Harris 窗，x = u/half ∈ (−1, 1)。
            let x = u / half as f64;
            let w = 0.35875
                + 0.48829 * (std::f64::consts::PI * x).cos()
                + 0.14128 * (2.0 * std::f64::consts::PI * x).cos()
                + 0.01168 * (3.0 * std::f64::consts::PI * x).cos();
            table[r * TAPS + j] = (sinc * w) as f32;
        }
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(seconds: f64, rate: u32, freq: f64, channels: usize) -> Vec<f32> {
        let frames = (seconds * f64::from(rate)).round() as usize;
        (0..frames)
            .flat_map(|i| {
                let v = (f64::from(i as u32) * std::f64::consts::TAU * freq / f64::from(rate)).sin()
                    as f32;
                (0..channels).map(move |_| v)
            })
            .collect()
    }

    /// 相关法测幅（与 resample_probe 同口径）。
    fn amplitude(data: &[f32], channels: usize, freq: f64, rate: u32) -> f64 {
        let frames = data.len() / channels;
        let start = frames / 4;
        let n = frames / 2;
        let (mut s, mut c) = (0.0f64, 0.0f64);
        for i in start..start + n {
            let phase = std::f64::consts::TAU * freq * i as f64 / f64::from(rate);
            s += f64::from(data[i * channels]) * phase.sin();
            c += f64::from(data[i * channels]) * phase.cos();
        }
        2.0 * s.hypot(c) / n as f64
    }

    fn db(v: f64) -> f64 {
        20.0 * v.max(1e-15).log10()
    }

    /// 驱动转换器：整段输入按块喂入，输出缓冲满时空输入续取，收集全部输出。
    fn run(converter: &mut ClockedConverter, input: &[f32], channels: usize) -> Vec<f32> {
        let mut out = Vec::new();
        let mut chunk_out = vec![0.0f32; 960 * channels];
        for block in input.chunks(1021 * channels) {
            let mut pending = Some(block);
            loop {
                let p = converter
                    .process(pending.take().unwrap_or(&[]), &mut chunk_out)
                    .unwrap();
                if p.produced_frames > 0 {
                    out.extend_from_slice(&chunk_out[..p.produced_frames * channels]);
                }
                if p.state == State::NeedInput {
                    break;
                }
            }
        }
        out
    }

    #[test]
    fn rejects_misaligned_and_nonfinite() {
        let mut c = ClockedConverter::new(48_000, 48_000, 2).unwrap();
        let bad = vec![0.0f32; 3];
        let mut out = vec![0.0f32; 8];
        assert_eq!(c.process(&bad, &mut out).unwrap_err(), Error::Alignment);
        let nan = vec![f32::NAN; 8];
        assert_eq!(c.process(&nan, &mut out).unwrap_err(), Error::NonFinite);
    }

    #[test]
    fn rejects_unsupported_formats() {
        assert_eq!(
            ClockedConverter::new(0, 48_000, 2).unwrap_err(),
            Error::Format
        );
        assert_eq!(
            ClockedConverter::new(48_000, 48_000, 0).unwrap_err(),
            Error::Format
        );
        assert_eq!(
            ClockedConverter::new(8_000, 1_536_000, 2).unwrap_err(),
            Error::Format
        );
    }

    /// 恒定漂移下 1kHz 增益保持平坦（±0.15dB 单测阈值；探针记录候选值）。
    #[test]
    fn gain_is_flat_under_constant_drift() {
        for ppm in [0.0, -500.0, 500.0] {
            let mut c = ClockedConverter::new(48_000, 48_000, 2).unwrap();
            c.set_drift_ppm(ppm);
            let input = sine(3.0, 48_000, 1000.0, 2);
            let out = run(&mut c, &input, 2);
            // 漂移按变比方向拉伸时间轴：输出样本域频率 = f × (1 + ppm)。
            let measured = 1000.0 * (1.0 + ppm * 1e-6);
            let gain = db(amplitude(&out, 2, measured, 48_000));
            assert!(gain.abs() < 0.15, "ppm {ppm}: gain {gain} dB 超出 ±0.15dB");
        }
    }

    /// 上下变换与跨率组合的增益。
    #[test]
    fn gain_is_flat_across_rate_combos() {
        for (src, dst) in [
            (44_100, 48_000),
            (48_000, 44_100),
            (96_000, 48_000),
            (48_000, 96_000),
        ] {
            let mut c = ClockedConverter::new(src, dst, 2).unwrap();
            let input = sine(2.0, src, 1000.0, 2);
            let out = run(&mut c, &input, 2);
            let gain = db(amplitude(&out, 2, 1000.0, dst));
            assert!(gain.abs() < 0.15, "{src}->{dst}: gain {gain} dB");
        }
    }

    /// 覆盖可听高频和较低 Nyquist 的 90%，防止只测 1kHz 漏掉通带被截半。
    #[test]
    fn audible_passband_survives_equal_up_and_down_conversion() {
        for (src, dst) in [
            (48_000, 48_000),
            (44_100, 48_000),
            (48_000, 44_100),
            (96_000, 48_000),
            (48_000, 96_000),
        ] {
            for freq in [1000.0, 10_000.0, 18_000.0, f64::from(src.min(dst)) * 0.45] {
                let mut c = ClockedConverter::new(src, dst, 1).unwrap();
                let out = run(&mut c, &sine(0.5, src, freq, 1), 1);
                let gain = db(amplitude(&out, 1, freq, dst));
                assert!(gain.abs() <= 0.1, "{src}->{dst} {freq}Hz: {gain}dB");
            }
        }
    }

    /// 超出输出奈奎斯特的音调按截止频率抑制（混叠候选线在探针里记录）。
    #[test]
    fn aliasing_is_suppressed_on_downconvert() {
        for freq in [27_000.0, 30_000.0, 40_000.0] {
            let mut c = ClockedConverter::new(96_000, 48_000, 1).unwrap();
            let input = sine(2.0, 96_000, freq, 1);
            let out = run(&mut c, &input, 1);
            let alias = (freq - (freq / 48_000.0).round() * 48_000.0).abs();
            let level = db(amplitude(&out, 1, alias, 48_000));
            assert!(
                level < -90.0,
                "{freq}Hz 折到 {alias}Hz: {level} dB 高于 -90dB"
            );
        }
    }

    /// 变比阶跃（0 → +500ppm → −500ppm）不得产生样本级跳变（click）。
    #[test]
    fn ratio_steps_do_not_click() {
        let mut c = ClockedConverter::new(48_000, 48_000, 1).unwrap();
        c.set_drift_ppm(0.0);
        // 稳态参考：1kHz 正弦的最大相邻步进 ≈ 2π×1000/48000 ≈ 0.131。
        let steady = run(&mut c, &sine(1.0, 48_000, 1000.0, 1), 1);
        let steady_max = steady
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0f32, f32::max);

        c.set_drift_ppm(500.0);
        let shifted = run(&mut c, &sine(1.0, 48_000, 1000.0, 1), 1);
        c.set_drift_ppm(-500.0);
        let back = run(&mut c, &sine(1.0, 48_000, 1000.0, 1), 1);
        for (name, wave) in [("up", &shifted), ("down", &back)] {
            let max = wave
                .windows(2)
                .map(|w| (w[1] - w[0]).abs())
                .fold(0.0f32, f32::max);
            assert!(
                max < steady_max * 1.5,
                "{name}: 变比阶跃后最大步进 {max} 超稳态 {steady_max} 的 1.5 倍"
            );
        }
    }

    /// 脉冲峰值落在相位口径声明的位置：pos = 脉冲输入帧号。
    #[test]
    fn pulse_peak_locates_at_source_frame() {
        let mut c = ClockedConverter::new(48_000, 48_000, 1).unwrap();
        let at_frame = 1000usize;
        let mut input = vec![0.0f32; 3000];
        input[at_frame] = 1.0;
        let out = run(&mut c, &input, 1);
        let peak = out
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
            .unwrap()
            .0;
        assert!(
            peak.abs_diff(at_frame) <= 1,
            "脉冲峰在 {peak}，期望 {at_frame}±1"
        );
    }

    /// 帧数按变比积分：产出 ≈ 消耗 / ratio，容差为滤波前视量级。
    #[test]
    fn frame_counts_track_ratio_integral() {
        let mut c = ClockedConverter::new(48_000, 48_000, 1).unwrap();
        c.set_drift_ppm(0.0);
        let input = sine(2.0, 48_000, 1000.0, 1);
        let out = run(&mut c, &input, 1);
        let (consumed, produced) = c.counts();
        assert_eq!(consumed, 96_000);
        // 同率同相：产出 = 消耗 − 前视（尚未覆盖的尾部）。
        assert!(
            (produced as i64 - out.len() as i64).abs() <= 1
                && (out.len() as i64 - 96_000 + TAPS as i64).abs() <= TAPS as i64,
            "produced {} 不在 [{}, {}] 内",
            out.len(),
            96_000 - 2 * TAPS,
            96_000
        );
    }

    /// 通道独立：左声道注入、右声道静默，右声道输出必须保持安静。
    #[test]
    fn channels_stay_independent() {
        let mut c = ClockedConverter::new(48_000, 48_000, 2).unwrap();
        let frames = 48_000usize;
        let mut input = vec![0.0f32; frames * 2];
        for i in 0..frames {
            input[i * 2] =
                (f64::from(i as u32) * std::f64::consts::TAU * 1000.0 / 48_000.0).sin() as f32;
        }
        let out = run(&mut c, &input, 2);
        let right = db(amplitude(
            &out.iter().skip(1).step_by(2).copied().collect::<Vec<_>>(),
            1,
            1000.0,
            48_000,
        ));
        assert!(right < -80.0, "右声道串扰 {right} dB");
        let left = db(amplitude(&out, 2, 1000.0, 48_000));
        assert!(left.abs() < 0.15);
    }

    /// reset 后相位归零：同一脉冲输入产生同一峰值位置。
    #[test]
    fn reset_restarts_phase() {
        let mut c = ClockedConverter::new(48_000, 48_000, 1).unwrap();
        let mut input = vec![0.0f32; 3000];
        input[500] = 1.0;
        let first = run(&mut c, &input, 1);
        c.reset();
        let second = run(&mut c, &input, 1);
        assert_eq!(first.len(), second.len());
        assert_eq!(first, second);
    }

    /// 超过历史容量的突发输入明确溢出，不静默丢帧。
    #[test]
    fn history_overflow_is_explicit() {
        let mut c = ClockedConverter::new(48_000, 48_000, 1).unwrap();
        // 只喂不取：灌满历史（首次 process 产出受输出缓冲限制）。
        let mut out = vec![0.0f32; 0];
        let big = vec![0.0f32; HISTORY_CAP - TAPS / 2];
        assert!(c.process(&big, &mut out).is_ok());
        let more = vec![0.0f32; 128];
        assert_eq!(c.process(&more, &mut out).unwrap_err(), Error::Overflow);
    }
}
