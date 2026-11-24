// SPDX-License-Identifier: MIT
//! Bounded temporary auditions; none of these values are persisted preferences.
use crate::{audio_quality::QualityParams, impulse::ImpulseKernel, AudioError};
use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

pub const PREVIEW_TTL_MS: u64 = 30_000;
pub const REFERENCE_WARMUP_SECONDS: u64 = 2;
pub const REFERENCE_SECONDS: u64 = 10;
pub const MAX_ALIGNMENT_FRAMES: usize = 136;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewSide {
    Enhanced,
    Bypass,
}
impl PreviewSide {
    pub fn index(self) -> usize {
        match self {
            Self::Enhanced => 0,
            Self::Bypass => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImpulsePhase {
    SymmetricLinear,
    Unknown,
}

#[derive(Debug, Clone)]
pub struct PreviewImpulse {
    pub kernel: ImpulseKernel,
    pub phase: ImpulsePhase,
}
impl PreviewImpulse {
    pub fn validate(&self) -> Result<(), AudioError> {
        crate::audio_quality::validate_correction_rate(self.kernel.sample_rate)?;
        if self.phase == ImpulsePhase::SymmetricLinear {
            return self.kernel.validate();
        }
        let k = &self.kernel;
        let len = k.channels.first().map_or(0, Vec::len);
        if crate::audio_quality::decode_id(&k.resource_id).is_none()
            || !(1..=2).contains(&k.channels.len())
            || !(1..=257).contains(&len)
            || k.channels
                .iter()
                .any(|c| c.len() != len || c.iter().any(|v| !v.is_finite()))
            || k.delay_frames > 128
            || k.delay_frames >= len
            || !k.attenuation_db.is_finite()
            || k.attenuation_db > 0.0
        {
            return Err(AudioError::Other(
                "未知相位试听需要不超过 257 taps 的有限单/双声道核；不推断或补偿内在延迟".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LoudnessMatch {
    pub enhanced_lufs: f64,
    pub bypass_lufs: f64,
    pub enhanced_attenuation_db: f32,
    pub bypass_attenuation_db: f32,
    pub common_attenuation_db: f32,
    pub residual_lu: f64,
    pub final_true_peak: f64,
    pub max_protection_reduction_db: f32,
    pub reference_start_ms: u64,
    pub reference_duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct PreviewPlan {
    pub request_id: String,
    pub saved: QualityParams,
    pub enhanced: QualityParams,
    pub impulse: Option<PreviewImpulse>,
    pub matching: Option<LoudnessMatch>,
    pub volume: f32,
    pub track_gain_db: f32,
    pub source_sha256: String,
    pub reference_end_ms: u64,
    /// Exclusive reference boundary in the processing-rate frame domain.
    pub reference_end_frame: u64,
}
impl PreviewPlan {
    pub fn validate(&self, rate: u32) -> Result<(), AudioError> {
        self.saved.validate()?;
        self.enhanced.validate()?;
        self.enhanced.validate_processing_rate(rate)?;
        if self.request_id.len() != 36
            || crate::audio_quality::decode_id(&self.source_sha256).is_none()
            || !self.volume.is_finite()
            || !(0.0..=1.0).contains(&self.volume)
            || !self.track_gain_db.is_finite()
            || !(-24.0..=12.0).contains(&self.track_gain_db)
            || self.enhanced.configuration_revision != self.saved.configuration_revision
            || self.enhanced.crossfade_ms != self.saved.crossfade_ms
            || self.enhanced.limiter != self.saved.limiter
            || self.reference_end_ms > (REFERENCE_SECONDS + REFERENCE_WARMUP_SECONDS) * 1000
            || self.reference_end_frame == 0
            || self.reference_end_frame
                > (REFERENCE_SECONDS + REFERENCE_WARMUP_SECONDS) * u64::from(rate)
            || self.reference_end_ms != self.reference_end_frame * 1000 / u64::from(rate.max(1))
        {
            return Err(AudioError::Other("试听身份、冻结参数或参考区间无效".into()));
        }
        if let Some(impulse) = &self.impulse {
            impulse.validate()?;
            if impulse.kernel.sample_rate != rate
                || crate::audio_quality::decode_id(&impulse.kernel.resource_id)
                    != self.enhanced.impulse_id
            {
                return Err(AudioError::Other("试听校正核身份或处理率不匹配".into()));
            }
        } else if self.enhanced.impulse_id.is_some() {
            return Err(AudioError::Other("试听校正核尚未准备".into()));
        }
        if let Some(m) = &self.matching {
            if ![
                m.enhanced_lufs,
                m.bypass_lufs,
                m.residual_lu,
                m.final_true_peak,
            ]
            .iter()
            .all(|v| v.is_finite())
                || [
                    m.enhanced_attenuation_db,
                    m.bypass_attenuation_db,
                    m.common_attenuation_db,
                ]
                .iter()
                .any(|v| !v.is_finite() || !(-72.0..=0.0).contains(v))
                || m.residual_lu.abs() > 0.1
                || m.final_true_peak < 0.0
                || m.final_true_peak > 10f64.powf(-2.9 / 20.0)
                || !m.max_protection_reduction_db.is_finite()
                || m.max_protection_reduction_db < 0.0
                || m.max_protection_reduction_db > 0.01
                || m.enhanced_attenuation_db + m.common_attenuation_db < -72.0
                || m.bypass_attenuation_db + m.common_attenuation_db < -72.0
                || m.reference_start_ms != REFERENCE_WARMUP_SECONDS * 1000
                || m.reference_duration_ms < 400
                || m.reference_start_ms.checked_add(m.reference_duration_ms)
                    != Some(self.reference_end_ms)
            {
                return Err(AudioError::Other(
                    "参考片段尚未通过独立响度匹配及保护检查".into(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewStatus {
    pub request_id: String,
    pub side: PreviewSide,
    pub state: String,
    pub saved_revision: String,
    pub phase: Option<ImpulsePhase>,
    pub matching: Option<LoudnessMatch>,
    pub source_sha256: String,
    pub remaining_ms: u64,
    pub reference_end_ms: u64,
    pub reference_end_frame: u64,
    pub alignment_frames: usize,
    pub temporary_attenuation_db: f32,
    pub effective_params: Option<QualityParams>,
}
