// SPDX-License-Identifier: MIT
//! Format-independent audio quality parameters. Runtime history belongs to the renderer.
use serde::{Deserialize, Serialize};

pub const EQ_FREQUENCIES: [f32; 6] = [60.0, 150.0, 400.0, 1000.0, 2400.0, 6000.0];
pub const QUALITY_PROCESSING_RATES: [u32; 3] = [44_100, 48_000, 96_000];
pub const CORRECTION_PROCESSING_RATES: [u32; 2] = [44_100, 48_000];
pub const CORRECTION_RATE_MESSAGE: &str =
    "校正 IR/FIR 与过采样饱和当前仅支持 44.1/48 kHz；请关闭这些处理或选择受支持的输出采样率";

/// Shared software qualification for managed correction and oversampled tone.
/// This does not establish physical output-device qualification.
pub fn validate_correction_rate(rate: u32) -> Result<(), crate::AudioError> {
    if !CORRECTION_PROCESSING_RATES.contains(&rate) {
        return Err(crate::AudioError::UnsupportedFormat(
            CORRECTION_RATE_MESSAGE.into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EqBand {
    pub frequency_hz: f32,
    pub q: f32,
    pub gain_db: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Equalizer {
    pub enabled: bool,
    pub bands: [EqBand; 6],
}

impl Default for Equalizer {
    fn default() -> Self {
        Self {
            enabled: false,
            bands: EQ_FREQUENCIES.map(|frequency_hz| EqBand {
                frequency_hz,
                q: 1.2,
                gain_db: 0.0,
            }),
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeadroomMode {
    #[default]
    Off,
    Auto,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimiterMode {
    #[default]
    Soft,
    TruePeak,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoudnessSource {
    #[default]
    FileTags,
    R128,
}

fn default_target_lufs() -> f32 {
    -18.0
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToneParams {
    pub crossfeed: bool,
    pub crossfeed_amount: f32,
    pub loudness_compensation: bool,
    pub saturation: bool,
    pub drive: f32,
    pub mix: f32,
}
impl Default for ToneParams {
    fn default() -> Self {
        Self {
            crossfeed: false,
            crossfeed_amount: 0.25,
            loudness_compensation: false,
            saturation: false,
            drive: 0.15,
            mix: 0.1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualityParams {
    #[serde(with = "decimal_u64")]
    pub configuration_revision: u64,
    pub eq: Equalizer,
    pub preamp_db: f32,
    pub headroom_mode: HeadroomMode,
    pub crossfade_ms: u64,
    #[serde(default)]
    pub limiter: LimiterMode,
    #[serde(default)]
    pub tone: ToneParams,
    #[serde(default)]
    pub impulse_id: Option<[u8; 32]>,
}

mod decimal_u64 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = String::deserialize(deserializer)?;
        let n = value.parse::<u64>().map_err(serde::de::Error::custom)?;
        if n.to_string() != value {
            return Err(serde::de::Error::custom(
                "revision must be canonical decimal",
            ));
        }
        Ok(n)
    }
}

impl Default for QualityParams {
    fn default() -> Self {
        Self {
            configuration_revision: 0,
            eq: Equalizer::default(),
            preamp_db: 0.0,
            headroom_mode: HeadroomMode::Off,
            crossfade_ms: 0,
            limiter: LimiterMode::Soft,
            tone: ToneParams::default(),
            impulse_id: None,
        }
    }
}

impl QualityParams {
    pub fn validate_processing_rate(&self, rate: u32) -> Result<(), crate::AudioError> {
        if self.impulse_id.is_some() || self.tone.saturation {
            validate_correction_rate(rate)?;
        }
        if !self.legacy_processing() && !QUALITY_PROCESSING_RATES.contains(&rate) {
            return Err(crate::AudioError::UnsupportedFormat(
                "参数 EQ、余量与真峰值保护当前只支持 44.1/48/96 kHz 的处理格式".into(),
            ));
        }
        Ok(())
    }

    pub fn legacy_processing(&self) -> bool {
        (!self.eq.enabled
            || self
                .eq
                .bands
                .iter()
                .zip(EQ_FREQUENCIES)
                .all(|(band, f)| band.gain_db == 0.0 || (band.frequency_hz == f && band.q == 1.2)))
            && self.headroom_mode == HeadroomMode::Off
            && self.limiter == LimiterMode::Soft
            && self.tone == ToneParams::default()
            && self.impulse_id.is_none()
    }
    pub fn validate(&self) -> Result<(), crate::AudioError> {
        let invalid = |text: &str| crate::AudioError::Other(text.into());
        if self.impulse_id.is_some() && self.limiter != LimiterMode::TruePeak {
            return Err(invalid("校正核需要真峰值保护"));
        }
        if ![self.tone.crossfeed_amount, self.tone.drive, self.tone.mix]
            .iter()
            .all(|v| v.is_finite() && (0.0..=1.0).contains(v))
        {
            return Err(invalid("耳机及音色强度须为 0 至 1"));
        }
        if (self.tone.loudness_compensation || self.tone.saturation)
            && self.limiter != LimiterMode::TruePeak
        {
            return Err(invalid("音色加工与小音量补偿需要真峰值保护"));
        }
        if !self.preamp_db.is_finite()
            || !(-24.0..=12.0).contains(&self.preamp_db)
            || self.crossfade_ms > 8000
        {
            return Err(invalid("前级须为 -24 至 +12 dB，交叉淡化须为 0 至 8000 ms"));
        }
        for band in self.eq.bands {
            if !band.frequency_hz.is_finite()
                || !(20.0..=20_000.0).contains(&band.frequency_hz)
                || !band.q.is_finite()
                || !(0.25..=8.0).contains(&band.q)
                || !band.gain_db.is_finite()
                || !(-12.0..=12.0).contains(&band.gain_db)
            {
                return Err(invalid(
                    "EQ 频率须为 20–20000 Hz，Q 为 0.25–8，增益为 -12 至 +12 dB",
                ));
            }
        }
        Ok(())
    }

    pub fn gains(&self) -> [f32; 6] {
        if self.eq.enabled {
            self.eq.bands.map(|band| band.gain_db)
        } else {
            [0.0; 6]
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct HeadroomInfo {
    pub eq_peak_db: f32,
    pub mix_peak_db: f32,
    pub margin_db: f32,
    pub attenuation_db: f32,
    pub effective_preamp_db: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct QualityStatus {
    pub eq: crate::EqStatus,
    pub requested: QualityParams,
    pub applied: Option<QualityParams>,
    pub headroom: HeadroomInfo,
    pub requested_headroom: HeadroomInfo,
    pub transition_from: Option<QualityParams>,
    pub transition_target: Option<QualityParams>,
    pub transition_progress: f32,
    pub sample_peak: f32,
    pub overload_samples: u64,
    pub deferred_reason: Option<&'static str>,
    pub latency_frames: u64,
    pub true_peak: Option<f32>,
    pub protection_reduction_db: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualityConfig {
    pub schema_version: u32,
    pub revision: String,
    pub eq: Equalizer,
    pub preamp_db: f32,
    pub headroom_mode: HeadroomMode,
    pub loudness_mode: String,
    pub crossfade_ms: u64,
    #[serde(default)]
    pub limiter: LimiterMode,
    #[serde(default)]
    pub loudness_source: LoudnessSource,
    #[serde(default = "default_target_lufs")]
    pub target_lufs: f32,
    #[serde(default)]
    pub tone: ToneParams,
    #[serde(default)]
    pub impulse_id: Option<String>,
}

impl QualityConfig {
    pub fn params(&self) -> QualityParams {
        QualityParams {
            configuration_revision: self.revision.parse().unwrap_or(0),
            eq: self.eq,
            preamp_db: self.preamp_db,
            headroom_mode: self.headroom_mode,
            crossfade_ms: self.crossfade_ms,
            limiter: self.limiter,
            tone: self.tone,
            impulse_id: self.impulse_id.as_ref().and_then(|id| decode_id(id)),
        }
    }
    pub fn validate(&self) -> Result<(), crate::AudioError> {
        let invalid = |s: &str| crate::AudioError::Other(s.into());
        if !matches!(self.schema_version, 2..=4)
            || (self.schema_version == 2 && self.limiter != LimiterMode::Soft)
        {
            return Err(invalid("不支持的音质配置版本，原数据已保留"));
        }
        if self
            .revision
            .parse::<u64>()
            .ok()
            .map(|n| n.to_string())
            .as_deref()
            != Some(&self.revision)
        {
            return Err(invalid("音质修订必须是规范十进制 u64 字符串"));
        }
        if !matches!(self.loudness_mode.as_str(), "off" | "track" | "album") {
            return Err(invalid("响度模式只接受 off / track / album"));
        }
        if !self.target_lufs.is_finite() || !(-24.0..=-12.0).contains(&self.target_lufs) {
            return Err(invalid("响度目标须为 -24 至 -12 LUFS"));
        }
        if self.loudness_source == LoudnessSource::R128
            && self.loudness_mode != "off"
            && self.limiter != LimiterMode::TruePeak
        {
            return Err(invalid("本机响度归一化须同时启用真峰值保护"));
        }
        if self.schema_version == 2 && self.loudness_source != LoudnessSource::FileTags {
            return Err(invalid("响度测量来源需要配置版本 3"));
        }
        if self
            .impulse_id
            .as_ref()
            .is_some_and(|id| decode_id(id).is_none())
        {
            return Err(invalid("校正资源 ID 无效"));
        }
        if self.impulse_id.is_some()
            && (self.schema_version < 4 || self.limiter != LimiterMode::TruePeak)
        {
            return Err(invalid("校正核需要版本4及真峰值保护"));
        }
        if self.schema_version < 4 && self.tone != ToneParams::default() {
            return Err(invalid("耳机与音色设置需要配置版本 4"));
        }
        self.params().validate()
    }
}

pub fn decode_id(id: &str) -> Option<[u8; 32]> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&id[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}
