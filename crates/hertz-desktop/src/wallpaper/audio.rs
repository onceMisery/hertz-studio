// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 系统音频分析管线与输入 owner（设计 docs/desktop-wallpaper.md §11.3，P1-06b）。
//!
//! `AudioInput` 是互斥联合：none、hertz、system。system 选择 WASAPI render
//! endpoint 的 shared/event loopback（不是麦克风，也不是 IAudioRenderClient
//! 输出路径——采集线程属下一片 WASAPI 接线）；本片交付与播放器逐位一致的
//! 频带分析、有界环形缓冲与切换代际语义。
//!
//! 频带映射复用播放器 2048 点 Hann FFT 的算法（vmusic-audio/render.rs）：
//! 二次方间隔频带、`norm/√bins` → sqrt → 峰值归一（0.02 底）→ 快攻 0.55 /
//! 慢放 0.14 平滑。壁纸在 hertz 源与 system 源下必须同一观感，黄金向量测试
//! 把两份实现对同一信号的输出钉死（rustfft 与播放器同版本、同 workspace 锁）。
//!
//! 采集线程合同（本片先钉数据面，WASAPI 接线随下一片）：只做有界格式转换
//! （交织多声道→单声道平均）与环形缓冲写入，不分配、不写日志；缓冲最多
//! 250 ms，过载丢最旧并计数；分析输出 ≤30 Hz 由消费节拍保证。

use std::sync::Arc;

use rustfft::FftPlanner;

/// FFT 窗长（与播放器一致，§11.3 复用 2048 点 Hann）。
pub(crate) const FFT_SIZE: usize = 2048;
/// 频带数（与 wallpaper_feed::BANDS 一致）。
pub(crate) const BANDS: usize = 64;
/// 环形缓冲时长上限（§11.3：最多 250 ms，过载丢最旧）。
const RING_MS: u64 = 250;
/// 峰值归一底：低于此认为近似静音，不做放大（与播放器一致）。
const PEAK_FLOOR: f32 = 0.02;
/// 平滑系数：快攻慢放读作"音乐感"（与播放器一致）。
const SMOOTH_ATTACK: f32 = 0.55;
const SMOOTH_RELEASE: f32 = 0.14;

/// 与播放器逐位一致的频带分析器。非 Send 场景外不共享；单线程持有。
pub(crate) struct SpectrumAnalyzer {
    fft: Arc<dyn rustfft::Fft<f32>>,
    input: Vec<num_complex::Complex<f32>>,
    scratch: Vec<num_complex::Complex<f32>>,
    hann: Vec<f32>,
    smooth: Vec<f32>,
}

impl Default for SpectrumAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

impl SpectrumAnalyzer {
    pub(crate) fn new() -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        Self {
            scratch: vec![num_complex::Complex::new(0.0, 0.0); fft.get_inplace_scratch_len()],
            fft,
            input: vec![num_complex::Complex::new(0.0, 0.0); FFT_SIZE],
            hann: (0..FFT_SIZE)
                .map(|i| {
                    0.5 * (1.0 - ((2.0 * std::f32::consts::PI * i as f32) / FFT_SIZE as f32).cos())
                })
                .collect(),
            smooth: vec![0.0; BANDS],
        }
    }

    /// 分析一整窗单声道样本（恰好 [`FFT_SIZE`] 个），输出 64 个频带值。
    /// `window[0..]` 为时间序（环形缓冲按时间序取出的滑动窗）。
    pub(crate) fn analyze(&mut self, window: &[f32], out: &mut [f32; BANDS]) -> bool {
        assert_eq!(window.len(), FFT_SIZE, "分析窗必须恰好 2048 样本");
        for ((bin, sample), gain) in self
            .input
            .iter_mut()
            .zip(window.iter())
            .zip(self.hann.iter())
        {
            *bin = num_complex::Complex::new(sample * gain, 0.0);
        }
        self.fft
            .process_with_scratch(&mut self.input, &mut self.scratch);

        let bins = FFT_SIZE / 2;
        let mut peak = 1e-6f32;
        for (i, slot) in out.iter_mut().enumerate() {
            // 二次方间隔频带边沿：低频不被挤进两带（与播放器一致）。
            let lo = (((i as f32 / BANDS as f32).powi(2)) * bins as f32) as usize;
            let hi = ((((i + 1) as f32 / BANDS as f32).powi(2)) * bins as f32).max(lo as f32 + 1.0)
                as usize;
            let hi = hi.min(bins);
            let mut acc = 0.0f32;
            for bin in self.input[lo..hi].iter() {
                acc = acc.max(bin.norm());
            }
            let v = (acc / (bins as f32).sqrt()).clamp(0.0, 1.0).sqrt();
            peak = peak.max(v);
            *slot = v;
        }

        // 峰值归一让安静曲目也有动画，随后快攻慢放平滑。
        let scale = if peak > PEAK_FLOOR { 1.0 / peak } else { 1.0 };
        for (i, v) in out.iter_mut().enumerate() {
            *v = (*v * scale).clamp(0.0, 1.0);
            let prev = self.smooth[i];
            self.smooth[i] = if *v > prev {
                prev + (*v - prev) * SMOOTH_ATTACK
            } else {
                prev + (*v - prev) * SMOOTH_RELEASE
            };
            *v = self.smooth[i];
        }
        true
    }

    /// 切换输入时清空滤波状态（§11.3：清空频谱和滤波）。
    pub(crate) fn reset(&mut self) {
        self.smooth.fill(0.0);
    }
}

/// 250 ms 单声道环形缓冲：采集线程写入、分析线程滑窗读取。
/// 容量在建时一次分配；热路径零分配，过载丢最旧并计数（§11.3）。
pub(crate) struct SampleRing {
    samples: Vec<f32>,
    /// 下一写位置；满载时该位置即最旧样本（覆盖=丢弃）。
    write_pos: usize,
    len: usize,
    pending: usize,
    dropped: u64,
}

impl SampleRing {
    /// 按采样率建 250 ms 容量；下限保证装得下一个 FFT 窗。
    pub(crate) fn new(sample_rate: u32) -> Self {
        let capacity = (((u64::from(sample_rate) * RING_MS) / 1000) as usize).max(FFT_SIZE);
        Self {
            samples: vec![0.0; capacity],
            write_pos: 0,
            len: 0,
            pending: 0,
            dropped: 0,
        }
    }

    pub(crate) fn capacity(&self) -> usize {
        self.samples.len()
    }

    pub(crate) fn len(&self) -> usize {
        self.len
    }

    /// 被过载丢弃的样本累计（设备切换时归零，按代际记账）。
    pub(crate) fn dropped(&self) -> u64 {
        self.dropped
    }

    /// 追加单声道样本；容量不足覆盖最旧并计数。
    pub(crate) fn push(&mut self, mono: &[f32]) {
        for &sample in mono {
            if self.len < self.samples.len() {
                self.len += 1;
            }
            if self.pending == self.samples.len() {
                self.dropped += 1;
            } else {
                self.pending += 1;
            }
            self.samples[self.write_pos] = sample;
            self.write_pos = (self.write_pos + 1) % self.samples.len();
        }
    }

    /// 取最新 FFT 窗并确认消费；保留滑窗历史，没有新样本时不重复刷新频谱。
    pub(crate) fn take_window(&mut self, out: &mut [f32; FFT_SIZE]) -> bool {
        if self.len < FFT_SIZE || self.pending == 0 {
            return false;
        }
        let cap = self.samples.len();
        let newest = (self.write_pos + cap - 1) % cap;
        for (i, slot) in out.iter_mut().enumerate() {
            let idx = (newest + cap - (FFT_SIZE - 1 - i)) % cap;
            *slot = self.samples[idx];
        }
        self.pending = 0;
        true
    }

    /// 清空（§11.3 切换顺序：代际递增后清空频谱和滤波，丢弃计数一并归零）。
    pub(crate) fn clear(&mut self) {
        self.write_pos = 0;
        self.len = 0;
        self.pending = 0;
        self.dropped = 0;
    }
}

/// 交织多声道 → 单声道平均（§11.3：多声道合成单声道后分析）。
/// `out` 由调用方复用（clear + reserve），采集线程热路径零分配。
pub(crate) fn downmix_interleaved(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    for frame in interleaved.chunks_exact(channels) {
        let sum: f32 = frame.iter().sum();
        out.push(sum / channels as f32);
    }
}

/// 音频输入互斥联合（§11.3）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum InputKind {
    None,
    /// 原 Hertz 播放器频谱（现有只读 feed 路径，不在此分析）。
    Hertz,
    /// 系统声音 loopback。`device: None` = 跟随默认渲染设备（默认设备变化
    /// 时只对这种选择重绑，§11.3 固定/默认分别编码）。
    System {
        device: Option<String>,
    },
}

/// 单一输入 owner：同一时刻只有一种来源。切换按 §11.3 顺序推进：
/// 代际递增 → 清空频谱和滤波 → 旧线程真实退出 → 打开新输入 → 首个合法
/// 样本生效。线程生命周期（退出/打开）由编排层按返回的 generation 执行，
/// 旧代际样本一律拒收。
pub(crate) struct AudioInputOwner {
    kind: InputKind,
    generation: u64,
}

impl AudioInputOwner {
    pub(crate) fn new(kind: InputKind) -> Self {
        Self {
            kind,
            generation: 0,
        }
    }

    pub(crate) fn kind(&self) -> &InputKind {
        &self.kind
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    /// 切换来源：递增代际并清空数据面。返回新代际。
    pub(crate) fn switch(
        &mut self,
        kind: InputKind,
        ring: &mut SampleRing,
        analyzer: &mut SpectrumAnalyzer,
    ) -> u64 {
        self.generation += 1;
        self.kind = kind;
        ring.clear();
        analyzer.reset();
        self.generation
    }
}

#[cfg(test)]
#[path = "audio_tests.rs"]
mod tests;
