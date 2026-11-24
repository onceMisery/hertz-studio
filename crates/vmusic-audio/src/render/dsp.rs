// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::EQ_BANDS;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use vmusic_core::audio_quality::{HeadroomInfo, QualityParams, QualityStatus};
mod preparation;
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
    pub(super) revision: u64,
    rate: u32,
    gains: [f32; 6],
    bands: [BiQuad; 6],
    preamp_db: f32,
    pub(super) params: QualityParams,
    pub(super) preview_gain_db: f32,
    pub(super) preview_alignment: usize,
    pub(super) headroom: HeadroomInfo,
    warm_frames: usize,
}

impl PreparedEq {
    pub(super) fn preview(
        rate: u32,
        params: QualityParams,
        gain_db: f32,
        alignment: usize,
    ) -> Result<Self, AudioError> {
        let mut result = preparation::prepare(0, rate, params)?;
        result.preview_gain_db = gain_db;
        result.preview_alignment = alignment;
        Ok(result)
    }
    fn new(revision: u64, rate: u32, gains: [f32; 6], preamp_db: f32) -> Self {
        let mut params = QualityParams::default();
        params.eq.enabled = gains.iter().any(|g| *g != 0.0);
        for (band, gain) in params.eq.bands.iter_mut().zip(gains) {
            band.gain_db = gain;
        }
        params.preamp_db = preamp_db;
        preparation::prepare_legacy(revision, rate, params).expect("legacy fixed EQ parameters")
    }
}

#[derive(Clone, Copy, Default)]
struct ObservedQuality {
    epoch: u64,
    applied: Option<QualityParams>,
    from: Option<QualityParams>,
    target: Option<QualityParams>,
    headroom: HeadroomInfo,
}

pub(super) struct DspControl {
    pub(super) parameters: Mutex<PreparedEq>,
    pub(super) applied_revision: AtomicU64,
    pub(super) applied_epoch: AtomicU64,
    pub(super) reset_epoch: AtomicU64,
    prepared_cache: Mutex<Option<PreparedEq>>,
    observed: Mutex<ObservedQuality>,
    pub(super) impulse: Mutex<Option<super::impulse::PreparedImpulse>>,
    deferred_reset: AtomicBool,
    pub(super) terminal_epoch: AtomicU64,
    pub(super) terminal_queued: AtomicU64,
    pub(super) terminal_audible: AtomicU64,
    pub(super) terminal_latency: AtomicU64,
    pub(super) terminal_position: AtomicU64,
    pub(super) terminal_transition: AtomicBool,
    pub(super) terminal_inflight: AtomicBool,
    terminal_peak: AtomicU32,
    terminal_reduction: AtomicU32,
    progress: AtomicU32,
    sample_peak: AtomicU32,
    overload_samples: AtomicU64,
}

impl DspControl {
    pub(super) fn invalidate_adoption(&self) {
        self.applied_revision.store(0, Ordering::Release);
        if let Ok(mut observed) = self.observed.lock() {
            *observed = ObservedQuality::default();
        }
    }
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
            } else if self.deferred_reset.load(Ordering::Acquire) {
                EqApplicationState::Deferred
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
        let impulse = Mutex::new(None);
        super::prime(&impulse);
        let observed = Mutex::new(ObservedQuality::default());
        super::prime(&observed);
        Self {
            parameters,
            applied_revision: AtomicU64::new(0),
            applied_epoch: AtomicU64::new(0),
            reset_epoch: AtomicU64::new(1),
            prepared_cache: Mutex::new(None),
            observed,
            impulse,
            deferred_reset: AtomicBool::new(false),
            terminal_epoch: AtomicU64::new(0),
            terminal_queued: AtomicU64::new(0),
            terminal_audible: AtomicU64::new(0),
            terminal_latency: AtomicU64::new(0),
            terminal_position: AtomicU64::new(0),
            terminal_transition: AtomicBool::new(false),
            terminal_inflight: AtomicBool::new(false),
            terminal_peak: AtomicU32::new(0),
            terminal_reduction: AtomicU32::new(0),
            progress: AtomicU32::new(0),
            sample_peak: AtomicU32::new(0),
            overload_samples: AtomicU64::new(0),
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
        let mut params = self
            .parameters
            .lock()
            .map_err(|_| AudioError::Other("DSP parameters unavailable".into()))?
            .params;
        if params.gains() != gains {
            params.eq.enabled = gains.iter().any(|g| *g != 0.0);
            for (band, gain) in params.eq.bands.iter_mut().zip(gains) {
                band.gain_db = gain;
            }
        }
        params.preamp_db = preamp_db;
        params.validate_processing_rate(rate)?;
        {
            let old = self
                .parameters
                .lock()
                .map_err(|_| AudioError::Other("DSP parameters unavailable".into()))?;
            if old.rate == rate && old.params == params {
                return Ok(());
            }
        }
        let legacy = params
            .eq
            .bands
            .iter()
            .zip(EQ_BANDS)
            .all(|(b, f)| b.frequency_hz == f && b.q == 1.2);
        if !legacy {
            return self.publish_quality(rate, params);
        }
        let mut prepared = preparation::prepare_legacy(0, rate, params)?;
        let mut pending = self
            .parameters
            .lock()
            .map_err(|_| AudioError::Other("DSP parameters unavailable".into()))?;
        prepared.revision = pending
            .revision
            .checked_add(1)
            .ok_or_else(|| AudioError::Other("DSP revision exhausted".into()))?;
        *pending = prepared;
        Ok(())
    }

    pub(super) fn validate_quality(
        &self,
        rate: u32,
        params: QualityParams,
    ) -> Result<(), AudioError> {
        params.validate_processing_rate(rate)?;
        if let Some(id) = params.impulse_id {
            let prepared = self
                .impulse
                .lock()
                .map_err(|_| AudioError::Other("校正资源不可用".into()))?;
            if !prepared
                .as_ref()
                .is_some_and(|k| k.id == id && k.rate == rate && !k.preview_only)
            {
                return Err(AudioError::Other("校正资源尚未按此输出格式准备".into()));
            }
        }
        let prepared = preparation::prepare(1, rate, params)?;
        *self
            .prepared_cache
            .lock()
            .map_err(|_| AudioError::Other("DSP preparation unavailable".into()))? = Some(prepared);
        Ok(())
    }

    pub(super) fn publish_quality(
        &self,
        rate: u32,
        params: QualityParams,
    ) -> Result<(), AudioError> {
        params.validate_processing_rate(rate)?;
        if let Some(id) = params.impulse_id {
            let prepared = self
                .impulse
                .lock()
                .map_err(|_| AudioError::Other("校正资源不可用".into()))?;
            if !prepared
                .as_ref()
                .is_some_and(|k| k.id == id && k.rate == rate && !k.preview_only)
            {
                return Err(AudioError::Other("校正资源尚未按此输出格式准备".into()));
            }
        }
        // Expensive response preparation is outside the parameter mailbox lock.
        let cached = self
            .prepared_cache
            .lock()
            .map_err(|_| AudioError::Other("DSP preparation unavailable".into()))?
            .take();
        let mut prepared = match cached {
            Some(p) if p.rate == rate && p.params == params => p,
            _ => preparation::prepare(0, rate, params)?,
        };
        let mut pending = self
            .parameters
            .lock()
            .map_err(|_| AudioError::Other("DSP parameters unavailable".into()))?;
        if pending.rate == rate && pending.params == params {
            return Ok(());
        }
        prepared.revision = pending
            .revision
            .checked_add(1)
            .ok_or_else(|| AudioError::Other("DSP revision exhausted".into()))?;
        *pending = prepared;
        Ok(())
    }

    pub(super) fn quality_status(&self, active: bool, output: u64) -> QualityStatus {
        let eq = self.status(active, output);
        let p = *self.parameters.lock().unwrap_or_else(|e| e.into_inner());
        let observed = *self.observed.lock().unwrap_or_else(|e| e.into_inner());
        let current = observed.epoch == self.reset_epoch.load(Ordering::Acquire);
        QualityStatus {
            preview: None,
            track_gain_db: 0.0,
            eq,
            requested: p.params,
            applied: if current { observed.applied } else { None },
            headroom: observed.headroom,
            requested_headroom: p.headroom,
            transition_from: if current { observed.from } else { None },
            transition_target: if current { observed.target } else { None },
            transition_progress: f32::from_bits(self.progress.load(Ordering::Relaxed)),
            sample_peak: f32::from_bits(self.sample_peak.load(Ordering::Relaxed)),
            overload_samples: self.overload_samples.load(Ordering::Relaxed),
            deferred_reason: self
                .deferred_reset
                .load(Ordering::Acquire)
                .then_some("processing_latency_change_waits_for_seek_or_load"),
            latency_frames: self.terminal_latency.load(Ordering::Relaxed),
            true_peak: (current
                && observed
                    .applied
                    .is_some_and(|p| p.limiter != vmusic_core::audio_quality::LimiterMode::Soft))
            .then(|| f32::from_bits(self.terminal_peak.load(Ordering::Relaxed))),
            protection_reduction_db: f32::from_bits(
                self.terminal_reduction.load(Ordering::Relaxed),
            ),
        }
    }

    pub(super) fn reserve_preview_restore(&self) -> Result<(), AudioError> {
        let pending = self
            .parameters
            .lock()
            .map_err(|_| AudioError::Other("DSP parameters unavailable".into()))?;
        pending.revision.checked_add(2).ok_or_else(|| {
            AudioError::Other("DSP revision exhausted; cannot reserve preview restoration".into())
        })?;
        Ok(())
    }

    pub(super) fn publish_preview(
        &self,
        mut prepared: PreparedEq,
        kernel: Option<super::impulse::PreparedImpulse>,
    ) -> Result<(), AudioError> {
        // Preparation is already complete. The render consumer observes the
        // coefficients and their matching gain/alignment as one fixed message.
        let mut pending = self
            .parameters
            .lock()
            .map_err(|_| AudioError::Other("DSP parameters unavailable".into()))?;
        prepared.revision = pending
            .revision
            .checked_add(1)
            .ok_or_else(|| AudioError::Other("DSP revision exhausted".into()))?;
        *self
            .impulse
            .lock()
            .map_err(|_| AudioError::Other("校正准备状态不可用".into()))? = kernel;
        *pending = prepared;
        Ok(())
    }

    pub(super) fn observe(&self, peak: f32, overloads: u64) {
        self.sample_peak.store(peak.to_bits(), Ordering::Relaxed);
        self.overload_samples
            .fetch_add(overloads, Ordering::Relaxed);
    }

    pub(super) fn reset(&self) {
        // An exhausted generation stays terminal; no old acknowledgement can
        // become current again through wrapping.
        #[allow(deprecated)] // MSRV 1.88 has no try_update; see vmusic-lan MemoryBudget::reserve
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
    pub(super) terminal: super::terminal::Terminal,
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
    history_tracks_min: [f32; 2],
    history_tracks_max: [f32; 2],
    history_frames: usize,
    fade_frames: usize,
    transition: Transition,
    preamps: [f32; 2],
    preamp_gains: [f32; 2],
    _native_history: Option<super::NativePcmReservation>,
    configs: [QualityParams; 2],
    headrooms: [HeadroomInfo; 2],
}

impl DspRuntime {
    pub(super) fn applied_revision(&self) -> u64 {
        self.applied
    }

    pub(super) fn new(rate: u32, channels: usize) -> Self {
        let budget_ms = if channels <= 2 && matches!(rate, 44_100 | 48_000 | 96_000) {
            preparation::PARAMETRIC_HISTORY_MS
        } else {
            EQ_HISTORY_MS
        };
        Self::with_history(rate, channels, budget_ms)
    }

    fn with_history(rate: u32, channels: usize, history_ms: u64) -> Self {
        let history_frames = ((rate as u64 * history_ms).div_ceil(1000) as usize).max(1);
        Self {
            rate,
            channels,
            terminal: super::terminal::Terminal::new(rate, channels, history_ms > EQ_HISTORY_MS),
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
            history_tracks_min: [0.0; 2],
            history_tracks_max: [0.0; 2],
            history_frames,
            fade_frames: ((rate as u64 * EQ_FADE_MS).div_ceil(1000) as usize).max(2),
            transition: Transition::Idle,
            preamps: [0.0; 2],
            preamp_gains: [1.0; 2],
            _native_history: None,
            configs: [QualityParams::default(); 2],
            headrooms: [HeadroomInfo::default(); 2],
        }
    }

    pub(super) fn new_native(
        rate: u32,
        budget: &super::NativePcmBudget,
    ) -> Result<Self, AudioError> {
        let frames = ((rate as u64 * EQ_HISTORY_MS).div_ceil(1000)).max(1);
        let reservation = budget.reserve(frames * 2, rate, frames as usize * (2 * 2 + 4) * 4)?;
        let mut runtime = Self::with_history(rate, 2, EQ_HISTORY_MS);
        runtime._native_history = Some(reservation);
        Ok(runtime)
    }

    fn configure(&mut self, bank: usize, parameters: PreparedEq) {
        self.cache_valid = false;
        self.warm_cache_valid = false;
        self.configs[bank] = parameters.params;
        self.headrooms[bank] = parameters.headroom;
        self.preamps[bank] = parameters.preamp_db;
        self.preamp_gains[bank] =
            10f64.powf(parameters.headroom.effective_preamp_db as f64 / 20.0) as f32;
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
            self.terminal.reset();
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
            self.history_tracks_min = [0.0; 2];
            self.history_tracks_max = [0.0; 2];
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
        if self
            .terminal
            .requires_reset(parameters.params.limiter, parameters.params.tone)
            && self.history_len > 0
        {
            control.deferred_reset.store(true, Ordering::Release);
            return true;
        }
        if self.history_len > 0
            && self
                .terminal
                .preview_needs_reset(parameters.preview_alignment)
        {
            control.deferred_reset.store(true, Ordering::Release);
            return true;
        }
        control.deferred_reset.store(false, Ordering::Release);
        if parameters.params.impulse_id != self.terminal.impulse_id() {
            let Ok(kernel) = control.impulse.try_lock() else {
                return self.applied != 0;
            };
            let prepared = if let Some(id) = parameters.params.impulse_id {
                let Some(prepared) = kernel
                    .as_ref()
                    .filter(|k| k.id == id && k.rate == self.rate)
                else {
                    return self.applied != 0;
                };
                Some(*prepared)
            } else {
                None
            };
            if self.history_len > 0
                && prepared.map_or(0, |k| k.delay) != self.terminal.impulse_delay()
            {
                control.deferred_reset.store(true, Ordering::Release);
                return true;
            }
            self.terminal
                .configure_impulse(prepared, self.history_len == 0);
        }
        let tone_changed = self.configs[self.current].tone != parameters.params.tone;
        self.fade_frames = ((self.rate as u64 * if tone_changed { 250 } else { EQ_FADE_MS })
            .div_ceil(1000) as usize)
            .max(2);
        self.terminal
            .configure(parameters.params.limiter, parameters.params.tone);
        self.terminal
            .configure_preview(parameters.preview_gain_db, parameters.preview_alignment);
        if self.history_len == 0 {
            self.configure(self.current, parameters);
            self.applied = parameters.revision;
        } else if self.configs[self.current] == parameters.params {
            self.applied = parameters.revision;
        } else if self.configs[self.current].eq == parameters.params.eq
            && (0..2).all(|i| {
                [self.preamps[self.current], parameters.preamp_db]
                    .iter()
                    .all(|p| {
                        p + self.history_tracks_min[i] >= -24.0
                            && p + self.history_tracks_max[i] <= 18.0
                    })
            })
        {
            // Gain-only changes preserve the exact filter history and need
            // only the unity-sum sample ramp, never historical catch-up.
            let next = 1 - self.current;
            self.configure(next, parameters);
            for channel in 0..self.channels {
                self.banks[next].states[channel] = self.banks[self.current].states[channel];
            }
            self.target = parameters.revision;
            self.transition = Transition::Fading { done: 0 };
        } else {
            self.configure(1 - self.current, parameters);
            self.target = parameters.revision;
            let history = self.history_len.min(parameters.warm_frames);
            self.transition = Transition::Warming {
                read: (self.write + self.history_frames - history) % self.history_frames,
                remaining: history,
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
        for (i, track) in tracks.iter().enumerate() {
            self.history_tracks_min[i] = self.history_tracks_min[i].min(*track);
            self.history_tracks_max[i] = self.history_tracks_max[i].max(*track);
        }
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
        let progress = match self.transition {
            Transition::Idle => 1.0,
            Transition::Warming { .. } => 0.0,
            Transition::Fading { done } => done as f32 / self.fade_frames as f32,
        };
        control
            .progress
            .store(progress.to_bits(), Ordering::Relaxed);
        if control.reset_epoch.load(Ordering::Acquire) == self.epoch {
            control
                .terminal_queued
                .store(self.terminal.queued(), Ordering::Relaxed);
            control
                .terminal_audible
                .store(self.terminal.audible_pending, Ordering::Relaxed);
            control
                .terminal_position
                .store(self.terminal.position, Ordering::Relaxed);
            control
                .terminal_latency
                .store(self.terminal.latency(), Ordering::Relaxed);
            control
                .terminal_transition
                .store(self.terminal.transition_pending, Ordering::Relaxed);
            control.terminal_peak.store(
                self.terminal.peak().unwrap_or(0.0).to_bits(),
                Ordering::Relaxed,
            );
            control
                .terminal_reduction
                .store(self.terminal.reduction().to_bits(), Ordering::Relaxed);
            control.terminal_epoch.store(self.epoch, Ordering::Release);

            if let Ok(mut observed) = control.observed.try_lock() {
                let transitioning = !matches!(self.transition, Transition::Idle);
                *observed = ObservedQuality {
                    epoch: self.epoch,
                    applied: (self.applied != 0).then_some(self.configs[self.current]),
                    from: transitioning.then_some(self.configs[self.current]),
                    target: transitioning.then_some(self.configs[1 - self.current]),
                    headroom: self.headrooms[self.current],
                };
            }
            control
                .applied_revision
                .store(self.applied, Ordering::Relaxed);
            control.applied_epoch.store(self.epoch, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod parametric_tests;
#[cfg(test)]
mod tests;
