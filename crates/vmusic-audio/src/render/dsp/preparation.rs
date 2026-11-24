// SPDX-License-Identifier: MIT
use super::{BiQuad, PreparedEq};
use vmusic_core::{
    audio_quality::{HeadroomInfo, HeadroomMode, QualityParams},
    AudioError,
};

/// Maximum local history. Admission uses the poles of the actual cascade.
pub(super) const PARAMETRIC_HISTORY_MS: u64 = 2000;

pub(super) fn prepare(
    revision: u64,
    rate: u32,
    params: QualityParams,
) -> Result<PreparedEq, AudioError> {
    prepare_inner(revision, rate, params, !params.legacy_processing())
}

pub(super) fn prepare_legacy(
    revision: u64,
    rate: u32,
    params: QualityParams,
) -> Result<PreparedEq, AudioError> {
    prepare_inner(revision, rate, params, false)
}

fn prepare_inner(
    revision: u64,
    rate: u32,
    params: QualityParams,
    strict_format: bool,
) -> Result<PreparedEq, AudioError> {
    params.validate()?;
    let gains = params.gains();
    let mut needed = 0usize;
    let mut bands = [BiQuad::peaking(60.0, 0.0, 1.2, rate); 6];
    let fixed = params
        .eq
        .bands
        .iter()
        .zip(super::EQ_BANDS)
        .all(|(b, f)| b.frequency_hz == f && b.q == 1.2);
    for i in 0..6 {
        let band = params.eq.bands[i];
        if strict_format && gains[i] != 0.0 && band.frequency_hz >= 0.45 * rate as f32 {
            return Err(AudioError::Other(format!(
                "EQ 第 {} 段频率须小于处理率的 45%",
                i + 1
            )));
        }
        bands[i] = BiQuad::peaking(band.frequency_hz, gains[i], band.q, rate);
        let b = bands[i];
        if ![b.a1, b.a2, b.b0, b.b1, b.b2].iter().all(|v| v.is_finite()) {
            return Err(AudioError::Other("EQ 系数不是有限数值".into()));
        }
        if gains[i] != 0.0 {
            let discriminant = b.a1 * b.a1 - 4.0 * b.a2;
            let radius = if discriminant < 0.0 {
                b.a2.sqrt()
            } else {
                ((-b.a1 + discriminant.sqrt())
                    .abs()
                    .max((-b.a1 - discriminant.sqrt()).abs()))
                    * 0.5
            };
            if !(0.0..1.0).contains(&radius) {
                return Err(AudioError::Other("EQ 极点不稳定".into()));
            }
            // 32 time constants leave room for repeated cascade poles. Tests
            // compare the admitted boundary against a long-history reference.
            needed = needed.max((-32.0 / radius.ln()).ceil() as usize);
        }
    }
    if fixed {
        needed = (rate as u64 * super::EQ_HISTORY_MS / 1000) as usize;
    }
    let max = (rate as u64 * PARAMETRIC_HISTORY_MS / 1000) as usize;
    if needed > max {
        return Err(AudioError::Other(
            "此低频/Q 组合超过 2 秒历史预算，请提高频率或降低 Q".into(),
        ));
    }
    let mut peak = 0.0f64;
    let response = |f: f64| -> f64 {
        let w = 2.0 * std::f64::consts::PI * f / rate as f64;
        bands
            .iter()
            .map(|b| {
                let (s, c) = w.sin_cos();
                let (s2, c2) = (2.0 * w).sin_cos();
                let n = (b.b0 + b.b1 * c + b.b2 * c2).powi(2) + (b.b1 * s + b.b2 * s2).powi(2);
                let d = (1.0 + b.a1 * c + b.a2 * c2).powi(2) + (b.a1 * s + b.a2 * s2).powi(2);
                10.0 * (n / d).max(1e-30).log10()
            })
            .sum()
    };
    // Include endpoints and centers, then refine every local grid maximum.
    let top = rate as f64 * 0.5;
    let ratio = (top / 1.0).ln();
    let mut previous = response(0.0);
    let mut current = response(1.0);
    peak = peak.max(previous).max(current).max(response(top));
    for i in 1usize..=4096 {
        let frequency = (ratio * i as f64 / 4096.0).exp();
        let next = response(frequency);
        if current >= previous && current >= next {
            let mut lo = (ratio * (i.saturating_sub(2)) as f64 / 4096.0).exp();
            let mut hi = frequency;
            for _ in 0..16 {
                let a = lo + (hi - lo) / 3.0;
                let b = hi - (hi - lo) / 3.0;
                if response(a) < response(b) {
                    lo = a;
                } else {
                    hi = b;
                }
            }
            peak = peak.max(response((lo + hi) * 0.5));
        }
        peak = peak.max(next);
        previous = current;
        current = next;
    }
    for b in params.eq.bands {
        peak = peak.max(response((b.frequency_hz as f64).min(top)));
    }
    let auto = params.headroom_mode == HeadroomMode::Auto;
    let mix = if params.crossfade_ms > 0 {
        20.0 * (0.88f32 * 2.0f32.sqrt()).log10()
    } else {
        0.0
    };
    let attenuation = if auto {
        -(peak as f32 + params.preamp_db + mix + 1.0).max(0.0)
    } else {
        0.0
    };
    Ok(PreparedEq {
        revision,
        rate,
        gains,
        bands,
        preamp_db: params.preamp_db,
        params,
        headroom: HeadroomInfo {
            eq_peak_db: peak as f32,
            mix_peak_db: mix,
            margin_db: if auto { 1.0 } else { 0.0 },
            attenuation_db: attenuation,
            effective_preamp_db: params.preamp_db + attenuation,
        },
        warm_frames: needed,
    })
}
