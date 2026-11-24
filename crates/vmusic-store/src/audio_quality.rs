// SPDX-License-Identifier: MIT
//! The quality object's persistence boundary, shared by settings reads and backups.
use serde_json::Value;
use std::collections::BTreeMap;
use vmusic_core::{
    audio_quality::{Equalizer, HeadroomMode, QualityConfig},
    StoreError,
};
pub const KEY: &str = "audio_quality_v2";
pub const LEGACY_KEYS: [&str; 5] = [
    "dsp_eq",
    "dsp_preamp",
    "dsp_loudness_mode",
    "dsp_crossfade_ms",
    "dsp_loudness",
];

pub fn from_settings(
    settings: &BTreeMap<String, Value>,
) -> Result<(QualityConfig, &'static str), StoreError> {
    if let Some(value) = settings.get(KEY) {
        if serde_json::to_vec(value)
            .map_err(|e| StoreError::Serialization(e.to_string()))?
            .len()
            > 65536
        {
            return Err(StoreError::Serialization(
                "音质配置超过 64 KiB，原数据已保留".into(),
            ));
        }
        let config: QualityConfig = serde_json::from_value(value.clone())
            .map_err(|e| StoreError::Serialization(format!("音质配置无效：{e}")))?;
        config
            .validate()
            .map_err(|e| StoreError::Serialization(e.to_string()))?;
        return Ok((config, "v2"));
    }
    let gains = settings
        .get("dsp_eq")
        .and_then(|v| serde_json::from_value::<[f32; 6]>(v.clone()).ok())
        .unwrap_or([0.0; 6]);
    let mut eq = Equalizer {
        enabled: gains.iter().any(|g| *g != 0.0),
        ..Default::default()
    };
    for (b, g) in eq.bands.iter_mut().zip(gains) {
        b.gain_db = g.clamp(-12.0, 12.0);
    }
    let mode = settings
        .get("dsp_loudness_mode")
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "off" | "track" | "album"))
        .unwrap_or(
            if settings.get("dsp_loudness").and_then(Value::as_bool) == Some(true) {
                "track"
            } else {
                "off"
            },
        );
    let config = QualityConfig {
        schema_version: 2,
        impulse_id: None,
        tone: vmusic_core::audio_quality::ToneParams::default(),
        loudness_source: vmusic_core::audio_quality::LoudnessSource::FileTags,
        target_lufs: -18.0,
        limiter: vmusic_core::audio_quality::LimiterMode::Soft,
        revision: "0".into(),
        eq,
        preamp_db: settings
            .get("dsp_preamp")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .clamp(-24.0, 12.0) as f32,
        headroom_mode: HeadroomMode::Off,
        loudness_mode: mode.into(),
        crossfade_ms: settings
            .get("dsp_crossfade_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(8000),
    };
    config
        .validate()
        .map_err(|e| StoreError::Serialization(e.to_string()))?;
    Ok((config, "legacy_projection"))
}
