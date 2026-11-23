// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::EQ_BANDS;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use vmusic_core::AudioError;

const EQ_HISTORY_MS: u64 = 160;
const EQ_FADE_MS: u64 = 20;
const EQ_WARMUP_FRAMES_PER_FRAME: usize = 4;

/// 一个双二阶节（RBJ cookbook peaking EQ）+ 一条声道的历史状态。
#[derive(Debug, Clone, Copy)]
struct BiQuad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl BiQuad {
    /// RBJ cookbook peaking EQ，系数已按 a0 归一化。
    fn peaking(center_hz: f32, gain_db: f32, q: f32, rate: u32) -> Self {
        if gain_db == 0.0 || center_hz >= rate.max(1) as f32 * 0.5 {
            return Self {
                b0: 1.0,
                b1: 0.0,
                b2: 0.0,
                a1: 0.0,
                a2: 0.0,
                x1: 0.0,
                x2: 0.0,
                y1: 0.0,
                y2: 0.0,
            };
        }
        let big_a = 10f64.powf(gain_db as f64 / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * center_hz as f64 / rate.max(1) as f64;
        let alpha = w0.sin() / (2.0 * q as f64);
        let cos_w0 = w0.cos();
        let a0 = 1.0 + alpha / big_a;
        Self {
            b0: (1.0 + alpha * big_a) / a0,
            b1: (-2.0 * cos_w0) / a0,
            b2: (1.0 - alpha * big_a) / a0,
            a1: (-2.0 * cos_w0) / a0,
            a2: (1.0 - alpha / big_a) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    /// Direct Form I；中性段（增益 0）系数退化为恒等，计算量可忽略。
    #[inline]
    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// 六段 EQ 滤波器组：系数按 (采样率, 增益) 缓存，状态按声道各一份。
pub(super) struct EqBank {
    rate: u32,
    gains: [f32; 6],
    neutral: bool,
    /// 每声道一份滤波器状态（采样历史），系数同源。
    states: Vec<[BiQuad; 6]>,
}

impl EqBank {
    pub(super) fn new(rate: u32, gains: [f32; 6], channels: usize) -> Self {
        let bands: Vec<BiQuad> = EQ_BANDS
            .iter()
            .zip(gains.iter())
            .map(|(&f, &g)| BiQuad::peaking(f, g, 1.2, rate))
            .collect();
        let states = (0..channels.max(1))
            .map(|_| {
                let mut arr = [BiQuad {
                    b0: 1.0,
                    b1: 0.0,
                    b2: 0.0,
                    a1: 0.0,
                    a2: 0.0,
                    x1: 0.0,
                    x2: 0.0,
                    y1: 0.0,
                    y2: 0.0,
                }; 6];
                for (a, b) in arr.iter_mut().zip(bands.iter()) {
                    *a = *b;
                }
                arr
            })
            .collect();
        Self {
            rate,
            gains,
            neutral: gains.iter().all(|gain| *gain == 0.0),
            states,
        }
    }

    #[cfg(test)]
    fn matches(&self, rate: u32, gains: &[f32; 6], channels: usize) -> bool {
        self.rate == rate && self.gains == *gains && self.states.len() == channels.max(1)
    }

    #[inline]
    fn process_frame(&mut self, ch: usize, sample: f32) -> f32 {
        if self.neutral && sample.is_finite() && self.states[ch][0].y1.is_finite() {
            // Identity sections have no history-dependent contribution. Preserve
            // the old chain's +0 result and its non-finite poisoning behavior.
            return if sample == 0.0 { 0.0 } else { sample };
        }
        let mut v = sample as f64;
        for band in self.states[ch].iter_mut() {
            v = band.process(v);
        }
        v as f32
    }
}

/// 软限幅：-ceiling..ceiling 之外平滑压缩，线性段完全透明。
pub(super) fn soft_limit(sample: f32, ceiling: f32) -> f32 {
    if !sample.is_finite() {
        return 0.0;
    }
    let a = sample.abs();
    if a <= ceiling {
        sample
    } else {
        let over = a - ceiling;
        let limited = ceiling + over / (1.0 + over);
        limited.min(1.0) * sample.signum()
    }
}

/// Fixed-size coefficient message. The control thread never touches live history.
#[derive(Clone, Copy)]
pub(super) struct PreparedEq {
    revision: u64,
    rate: u32,
    gains: [f32; 6],
    bands: [BiQuad; 6],
    preamp_db: f32,
}

impl PreparedEq {
    fn new(revision: u64, rate: u32, gains: [f32; 6], preamp_db: f32) -> Self {
        Self {
            revision,
            rate,
            gains,
            bands: std::array::from_fn(|i| BiQuad::peaking(EQ_BANDS[i], gains[i], 1.2, rate)),
            preamp_db,
        }
    }
}

pub(super) struct DspControl {
    pub(super) parameters: Mutex<PreparedEq>,
    pub(super) applied_revision: AtomicU64,
    pub(super) applied_epoch: AtomicU64,
    pub(super) reset_epoch: AtomicU64,
}

impl DspControl {
    pub(super) fn status(&self, active: bool, output_id: u64) -> vmusic_core::EqStatus {
        use vmusic_core::{EqApplicationState, EqStatus};
        let parameters = self
            .parameters
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let epoch = self.reset_epoch.load(Ordering::Acquire);
        let applied_epoch = self.applied_epoch.load(Ordering::Acquire);
        let revision = self.applied_revision.load(Ordering::Acquire);
        let applied = (applied_epoch == epoch && revision != 0).then_some(revision);
        EqStatus {
            state: if applied == Some(parameters.revision) {
                EqApplicationState::Applied
            } else if active {
                EqApplicationState::Applying
            } else {
                EqApplicationState::Deferred
            },
            requested_revision: parameters.revision.to_string(),
            applied_revision: applied.map(|value| value.to_string()),
            render_generation: format!("{output_id}:{epoch}"),
            requested_gains_db: parameters.gains,
            requested_preamp_db: parameters.preamp_db,
            processing_rate: parameters.rate,
            active,
        }
    }

    pub(super) fn gains(&self) -> [f32; 6] {
        self.parameters
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .gains
    }

    pub(super) fn preamp(&self) -> f32 {
        self.parameters
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .preamp_db
    }

    pub(super) fn new() -> Self {
        let parameters = Mutex::new(PreparedEq::new(1, 48_000, [0.0; 6], 0.0));
        super::prime(&parameters);
        Self {
            parameters,
            applied_revision: AtomicU64::new(0),
            applied_epoch: AtomicU64::new(0),
            reset_epoch: AtomicU64::new(1),
        }
    }

    pub(super) fn publish(&self, rate: u32, gains: [f32; 6]) -> Result<(), AudioError> {
        self.publish_complete(rate, gains, self.preamp())
    }

    pub(super) fn publish_complete(
        &self,
        rate: u32,
        gains: [f32; 6],
        preamp_db: f32,
    ) -> Result<(), AudioError> {
        let mut pending = self
            .parameters
            .lock()
            .map_err(|_| AudioError::Other("DSP parameters unavailable".into()))?;
        if pending.rate == rate && pending.gains == gains && pending.preamp_db == preamp_db {
            return Ok(());
        }
        let revision = pending
            .revision
            .checked_add(1)
            .ok_or_else(|| AudioError::Other("DSP revision exhausted".into()))?;
        *pending = PreparedEq::new(revision, rate, gains, preamp_db);
        Ok(())
    }

    pub(super) fn reset(&self) {
        // An exhausted generation stays terminal; no old acknowledgement can
        // become current again through wrapping.
        let _ = self
            .reset_epoch
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |epoch| {
                epoch.checked_add(1)
            });
        self.applied_revision.store(0, Ordering::Release);
    }
}

#[derive(Clone, Copy)]
enum Transition {
    Idle,
    Warming { read: usize, remaining: usize },
    Fading { done: usize },
}

/// Owned by one output consumer. Every allocation is made before rendering.
/// The history is 160 ms, specific to the existing fixed six bands/Q=1.2;
/// broader parametric EQ must requalify this bound.
pub(super) struct DspRuntime {
    rate: u32,
    channels: usize,
    banks: [EqBank; 2],
    current: usize,
    applied: u64,
    target: u64,
    epoch: u64,
    history: Vec<f32>,
    history_gains: Vec<[f32; 2]>,
    history_weights: Vec<[f32; 2]>,
    warm_tracks: [f32; 2],
    warm_factors: [f32; 2],
    warm_cache_valid: bool,
    cached_tracks: [f32; 2],
    cached_factors: [[f32; 2]; 2],
    cache_valid: bool,
    write: usize,
    history_len: usize,
    history_frames: usize,
    fade_frames: usize,
    transition: Transition,
    preamps: [f32; 2],
    preamp_gains: [f32; 2],
    _native_history: Option<super::NativePcmReservation>,
}

impl DspRuntime {
    pub(super) fn applied_revision(&self) -> u64 {
        self.applied
    }

    pub(super) fn new(rate: u32, channels: usize) -> Self {
        let history_frames = ((rate as u64 * EQ_HISTORY_MS).div_ceil(1000) as usize).max(1);
        Self {
            rate,
            channels,
            banks: [
                EqBank::new(rate, [0.0; 6], channels),
                EqBank::new(rate, [0.0; 6], channels),
            ],
            current: 0,
            applied: 0,
            target: 0,
            epoch: 0,
            history: vec![0.0; history_frames * channels * 2],
            history_gains: vec![[0.0; 2]; history_frames],
            history_weights: vec![[1.0, 0.0]; history_frames],
            warm_tracks: [0.0; 2],
            warm_factors: [1.0; 2],
            warm_cache_valid: false,
            cached_tracks: [0.0; 2],
            cached_factors: [[1.0; 2]; 2],
            cache_valid: false,
            write: 0,
            history_len: 0,
            history_frames,
            fade_frames: ((rate as u64 * EQ_FADE_MS).div_ceil(1000) as usize).max(2),
            transition: Transition::Idle,
            preamps: [0.0; 2],
            preamp_gains: [1.0; 2],
            _native_history: None,
        }
    }

    pub(super) fn new_native(
        rate: u32,
        budget: &super::NativePcmBudget,
    ) -> Result<Self, AudioError> {
        let frames = ((rate as u64 * EQ_HISTORY_MS).div_ceil(1000)).max(1);
        let reservation = budget.reserve(frames * 2, rate, frames as usize * (2 * 2 + 4) * 4)?;
        let mut runtime = Self::new(rate, 2);
        runtime._native_history = Some(reservation);
        Ok(runtime)
    }

    fn configure(&mut self, bank: usize, parameters: PreparedEq) {
        self.cache_valid = false;
        self.warm_cache_valid = false;
        self.preamps[bank] = parameters.preamp_db;
        self.preamp_gains[bank] = 10f64.powf(parameters.preamp_db as f64 / 20.0) as f32;
        let bank = &mut self.banks[bank];
        bank.rate = parameters.rate;
        bank.gains = parameters.gains;
        bank.neutral = parameters.gains.iter().all(|gain| *gain == 0.0);
        bank.states.fill(parameters.bands);
    }

    #[cfg(test)]
    pub(super) fn begin_block(&mut self, control: &DspControl) {
        let epoch = control.reset_epoch.load(Ordering::Acquire);
        self.begin_epoch(control, epoch);
    }

    pub(super) fn begin_epoch(&mut self, control: &DspControl, epoch: u64) -> bool {
        if self.epoch != epoch {
            for bank in &mut self.banks {
                for channel in &mut bank.states {
                    for band in channel {
                        band.x1 = 0.0;
                        band.x2 = 0.0;
                        band.y1 = 0.0;
                        band.y2 = 0.0;
                    }
                }
            }
            self.history_len = 0;
            self.write = 0;
            self.transition = Transition::Idle;
            self.applied = 0;
            self.epoch = epoch;
        }
        if !matches!(self.transition, Transition::Idle) {
            return true;
        }
        // Contention postpones a change, never the existing filter operation.
        let Ok(pending) = control.parameters.try_lock() else {
            return self.applied != 0;
        };
        let parameters = *pending;
        drop(pending);
        if parameters.rate != self.rate || parameters.revision == self.applied {
            return self.applied != 0;
        }
        if self.history_len == 0 {
            self.configure(self.current, parameters);
            self.applied = parameters.revision;
        } else if self.banks[self.current].gains == parameters.gains
            && self.preamps[self.current] == parameters.preamp_db
        {
            self.applied = parameters.revision;
        } else {
            self.configure(1 - self.current, parameters);
            self.target = parameters.revision;
            self.transition = Transition::Warming {
                read: (self.write + self.history_frames - self.history_len) % self.history_frames,
                remaining: self.history_len,
            };
        }
        true
    }

    fn track_factors(&self, bank: usize, tracks: [f32; 2]) -> [f32; 2] {
        let preamp = self.preamps[bank];
        tracks.map(|track| 10.0f32.powf(((preamp + track).clamp(-24.0, 18.0) - preamp) / 20.0))
    }

    pub(super) fn current_track_factors(&mut self, tracks: [f32; 2]) -> [f32; 2] {
        if !self.cache_valid || self.cached_tracks != tracks {
            self.cached_tracks = tracks;
            self.cached_factors = [self.track_factors(0, tracks), self.track_factors(1, tracks)];
            self.cache_valid = true;
        }
        self.cached_factors[self.current]
    }

    #[cfg(test)]
    pub(super) fn process(&mut self, frame: &mut [f32]) {
        let mut old = [0.0; 32];
        old[..frame.len()].copy_from_slice(frame);
        self.process_mix(
            &old[..frame.len()],
            &[0.0; 32][..frame.len()],
            [0.0; 2],
            [1.0, 0.0],
            frame,
        );
    }

    pub(super) fn process_mix(
        &mut self,
        old_input: &[f32],
        new_input: &[f32],
        tracks: [f32; 2],
        weights: [f32; 2],
        frame: &mut [f32],
    ) {
        debug_assert_eq!(frame.len(), self.channels);
        if !self.cache_valid || self.cached_tracks != tracks {
            self.cached_tracks = tracks;
            self.cached_factors = [self.track_factors(0, tracks), self.track_factors(1, tracks)];
            self.cache_valid = true;
        }
        let next = 1 - self.current;
        let mut phase = self.transition;
        if let Transition::Warming {
            mut read,
            mut remaining,
        } = phase
        {
            // Consume old history before overwriting its ring slot. Four old
            // frames per live frame bounds both callback work and catch-up time.
            for _ in 0..remaining.min(EQ_WARMUP_FRAMES_PER_FRAME) {
                if !self.warm_cache_valid || self.warm_tracks != self.history_gains[read] {
                    self.warm_tracks = self.history_gains[read];
                    self.warm_factors = self.track_factors(next, self.warm_tracks);
                    self.warm_cache_valid = true;
                }
                let factors = self.warm_factors;
                let weights = self.history_weights[read];
                for ch in 0..self.channels {
                    let index = read * self.channels * 2 + ch;
                    let sample = self.history[index] * factors[0] * weights[0]
                        + self.history[index + self.channels] * factors[1] * weights[1];
                    self.banks[next].process_frame(ch, sample);
                }
                read = (read + 1) % self.history_frames;
                remaining -= 1;
            }
            phase = if remaining == 0 {
                Transition::Fading { done: 0 }
            } else {
                Transition::Warming {
                    read,
                    remaining: remaining + 1,
                }
            };
        }
        let offset = self.write * self.channels * 2;
        self.history[offset..offset + self.channels].copy_from_slice(old_input);
        self.history[offset + self.channels..offset + self.channels * 2].copy_from_slice(new_input);
        self.history_gains[self.write] = tracks;
        self.history_weights[self.write] = weights;
        self.write = (self.write + 1) % self.history_frames;
        self.history_len = (self.history_len + 1).min(self.history_frames);

        for (ch, sample) in frame.iter_mut().enumerate() {
            let factors = self.cached_factors[self.current];
            let input =
                old_input[ch] * factors[0] * weights[0] + new_input[ch] * factors[1] * weights[1];
            let old =
                self.banks[self.current].process_frame(ch, input) * self.preamp_gains[self.current];
            *sample = if let Transition::Fading { done } = phase {
                let factors = self.cached_factors[next];
                let input = old_input[ch] * factors[0] * weights[0]
                    + new_input[ch] * factors[1] * weights[1];
                let new = self.banks[next].process_frame(ch, input) * self.preamp_gains[next];
                let weight = done as f64 / (self.fade_frames - 1) as f64;
                // Correlated copies require weights summing to one.
                ((1.0 - weight) * old as f64 + weight * new as f64) as f32
            } else {
                old
            };
        }
        self.transition = if let Transition::Fading { done } = phase {
            if done + 1 == self.fade_frames {
                self.current = next;
                self.applied = self.target;
                Transition::Idle
            } else {
                Transition::Fading { done: done + 1 }
            }
        } else {
            phase
        };
    }

    pub(super) fn finish_block(&self, control: &DspControl) {
        if control.reset_epoch.load(Ordering::Acquire) == self.epoch {
            control
                .applied_revision
                .store(self.applied, Ordering::Relaxed);
            control.applied_epoch.store(self.epoch, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_eq_transition_matches_long_history_and_survives_block_fragmentation() {
        for rate in [44_100, 48_000, 96_000, 192_000] {
            let gains = [12.0, -12.0, 12.0, -12.0, 12.0, -12.0];
            let control = DspControl::new();
            control.publish(rate, [0.0; 6]).unwrap();
            let mut runtime = DspRuntime::new(rate, 2);
            let mut reference = EqBank::new(rate, gains, 2);
            let input = |n: usize| {
                [
                    0.03 * (std::f64::consts::TAU * 60.0 * n as f64 / rate as f64).sin() as f32,
                    0.03 * (std::f64::consts::TAU * 2400.0 * n as f64 / rate as f64).sin() as f32,
                ]
            };
            runtime.begin_block(&control);
            for n in 0..rate as usize {
                let mut frame = input(n);
                for (ch, value) in frame.iter().enumerate() {
                    reference.process_frame(ch, *value);
                }
                runtime.process(&mut frame);
            }
            runtime.finish_block(&control);
            control.publish(rate, gains).unwrap();
            runtime.begin_block(&control);
            let mut max_error = 0.0f32;
            let mut completed = None;
            for n in 0..(rate / 10) as usize {
                if n % 127 == 0 {
                    runtime.begin_block(&control);
                }
                let mut frame = input(rate as usize + n);
                let expected = [
                    reference.process_frame(0, frame[0]),
                    reference.process_frame(1, frame[1]),
                ];
                runtime.process(&mut frame);
                if matches!(runtime.transition, Transition::Idle) {
                    completed.get_or_insert(n);
                    for ch in 0..2 {
                        max_error = max_error.max((frame[ch] - expected[ch]).abs());
                    }
                }
            }
            assert!(
                completed.is_some_and(|n| n < (rate / 10) as usize),
                "rate {rate}: adoption exceeds 100 ms"
            );
            assert!(
                max_error < 0.00001,
                "rate {rate}: long-history residual {max_error}"
            );
            runtime.finish_block(&control);
            assert_eq!(
                control.status(true, 0).state,
                vmusic_core::EqApplicationState::Applied
            );
        }
    }

    #[test]
    fn rapid_requests_keep_only_the_latest_and_reset_clears_pending_history() {
        let control = DspControl::new();
        let mut runtime = DspRuntime::new(48_000, 1);
        runtime.begin_block(&control);
        for _ in 0..7680 {
            runtime.process(&mut [0.01]);
        }
        control.publish(48_000, [12.0; 6]).unwrap();
        runtime.begin_block(&control);
        for gain in -12..12 {
            control.publish(48_000, [gain as f32; 6]).unwrap();
        }
        control.publish(48_000, [-3.0; 6]).unwrap();
        for _ in 0..150 {
            runtime.begin_block(&control);
            for _ in 0..128 {
                runtime.process(&mut [0.01]);
            }
            runtime.finish_block(&control);
        }
        assert_eq!(runtime.banks[runtime.current].gains, [-3.0; 6]);
        assert_eq!(
            control.status(true, 0).state,
            vmusic_core::EqApplicationState::Applied
        );
        control.reset();
        runtime.begin_block(&control);
        let mut silence = [0.0];
        runtime.process(&mut silence);
        assert_eq!(silence, [0.0]);
    }

    #[test]
    #[ignore = "release-only synthetic DSP timing; does not open an audio device"]
    fn quality_probe() {
        assert!(!cfg!(debug_assertions), "run this probe with --release");
        for rate in [44_100, 48_000, 96_000] {
            for block in [128usize, 512] {
                let control = DspControl::new();
                control.publish(rate, [0.0; 6]).unwrap();
                let mut runtime = DspRuntime::new(rate, 2);
                let mut output = vec![[0.0f32; 2]; block];
                let blocks = (rate as usize * 30).div_ceil(block);
                let mut times = Vec::with_capacity(blocks);
                for iteration in 0..blocks {
                    if iteration % 32 == 0 {
                        let gain = if iteration % 64 == 0 { 12.0 } else { -12.0 };
                        control.publish(rate, [gain; 6]).unwrap();
                    }
                    for (offset, frame) in output.iter_mut().enumerate() {
                        let t = (iteration * block + offset) as f64 / rate as f64;
                        *frame = [
                            0.01 * (std::f64::consts::TAU * 60.0 * t).sin() as f32,
                            0.01 * (std::f64::consts::TAU * 6000.0 * t).sin() as f32,
                        ];
                    }
                    let started = std::time::Instant::now();
                    runtime.begin_block(&control);
                    for frame in &mut output {
                        runtime.process(std::hint::black_box(frame));
                    }
                    runtime.finish_block(&control);
                    times.push(started.elapsed().as_nanos() as u64);
                }
                times.sort_unstable();
                let deadline = block as f64 * 1e9 / rate as f64;
                let over = times
                    .iter()
                    .filter(|value| **value as f64 > deadline)
                    .count();
                println!(
                    "DSP_PROBE {}",
                    serde_json::json!({
                        "rate":rate,"channels":2,"blockFrames":block,"blocks":blocks,
                        "p99Ns":times[times.len()*99/100],"maxNs":times.last(),
                        "deadlineNs":deadline,"overDeadline":over,
                        "historyBytes":runtime.history.len()*4,
                        "syntheticAudioSeconds":30,"realDeviceVerified":false
                    })
                );
            }
        }
        let c = 0.98f32;
        let onset = c + (1.0 - c) / c;
        let limiter_samples =
            [0.0f32, 0.5, 0.98, 1.0, 1.001, 1.1, 2.0].map(|x| [x, soft_limit(x, c)]);
        println!(
            "DSP_BASELINE {}",
            serde_json::json!({
                "hardClipInputAmplitude":onset,
                "correlatedCrossfadePeakDb":20.0f64*(0.88*2.0f64.sqrt()).log10(),
                "limiterSamples":limiter_samples
            })
        );
    }

    #[test]
    fn eq_pcm_matches_original_filter_chain_across_parameter_switches() {
        for rate in [8_000, 44_100, 48_000, 192_000] {
            for gains in [[0.0; 6], [2.0, 0.0, -3.0, 0.0, 4.0, 0.0], [0.0; 6]] {
                let mut bank = EqBank::new(rate, gains, 2);
                let mut reference = bank.states.clone();
                for frame in 0..4096 {
                    for (ch, channel_reference) in reference.iter_mut().enumerate() {
                        let sample = match frame % 31 {
                            0 => -0.0,
                            1 => f32::from_bits(1),
                            _ => (frame as f32 * (0.11 + ch as f32 * 0.003)).sin(),
                        };
                        let mut expected = sample as f64;
                        for band in channel_reference {
                            expected = band.process(expected);
                        }
                        assert_eq!(
                            bank.process_frame(ch, sample).to_bits(),
                            (expected as f32).to_bits()
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn neutral_eq_preserves_nonfinite_filter_history_semantics() {
        for invalid in [f32::INFINITY, f32::NEG_INFINITY, f32::NAN] {
            let mut bank = EqBank::new(48_000, [0.0; 6], 1);
            let mut reference = bank.states.clone();
            for sample in [0.5, -0.5, invalid, 0.25, 0.0] {
                let mut expected = sample as f64;
                for band in &mut reference[0] {
                    expected = band.process(expected);
                }
                let actual = bank.process_frame(0, sample);
                assert!(
                    actual.to_bits() == (expected as f32).to_bits()
                        || actual.is_nan() && expected.is_nan()
                );
            }
        }
    }

    #[test]
    fn peaking_filter_zero_gain_is_identity() {
        let mut q = BiQuad::peaking(1000.0, 0.0, 1.2, 48_000);
        // 增益 0 时 b0≈1、b1≈-2cos、a1≈-2cos、其余≈0 → 直通（系数误差 < 1e-9）
        let out = q.process(0.5);
        assert!((out - 0.5).abs() < 1e-6, "identity violated: {out}");
    }

    #[test]
    fn peaking_filter_boosts_band_center() {
        // +12dB @1kHz：以 1kHz 正弦（数值上直接喂常数不合适，喂极低频近似直流，
        // 低频段增益应接近 1）。这里直接验证系数能量：中心频率处幅度比 > 1。
        let q = BiQuad::peaking(1000.0, 12.0, 1.2, 48_000);
        // 中心频率增益 |b0+b1 z+b2 z²|/|1+a1 z+a2 z²| 在 z=e^{-jw0} 处 ≈ 10^(12/20)
        // 简化：直接断言 b0 > a0 归一化后的 1（有增益）
        assert!(q.b0 > 1.0);
    }

    #[test]
    fn limiter_is_transparent_below_ceiling_and_caps_above() {
        for nonfinite in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert_eq!(soft_limit(nonfinite, 0.98), 0.0);
        }
        assert_eq!(soft_limit(0.5, 0.98), 0.5);
        assert_eq!(soft_limit(-0.5, 0.98), -0.5);
        let loud = soft_limit(1.5, 0.98);
        assert!(
            loud > 0.98 && loud <= 1.0,
            "soft clip must stay bounded: {loud}"
        );
        let neg = soft_limit(-1.5, 0.98);
        assert!((-1.0..=-0.98).contains(&neg));
        assert_eq!(soft_limit(2.5, 0.98), 1.0);
    }

    #[test]
    fn eq_bank_matches_by_rate_gains_channels() {
        let bank = EqBank::new(48_000, [0.0; 6], 2);
        assert!(bank.matches(48_000, &[0.0; 6], 2));
        assert!(!bank.matches(44_100, &[0.0; 6], 2));
        assert!(!bank.matches(48_000, &[1.0, 0.0, 0.0, 0.0, 0.0, 0.0], 2));
        assert!(!bank.matches(48_000, &[0.0; 6], 1));
    }
}
