// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Local output preferences belong to the device owner, separately from DSP.
//! Requested settings can differ from the last working device after a rejected
//! switch; only `actual` describes a successfully opened output.

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputMode {
    #[default]
    Shared,
    Exclusive,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputSampleFormat {
    #[default]
    Auto,
    F32,
    S16,
    S24,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DitherMode {
    #[default]
    Auto,
    Off,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct OutputPreferences {
    pub device_id: Option<String>,
    pub mode: OutputMode,
    pub sample_format: OutputSampleFormat,
    pub dither: DitherMode,
}

impl OutputPreferences {
    pub fn validate(&self) -> Result<(), crate::AudioError> {
        if self
            .device_id
            .as_ref()
            .is_some_and(|id| id.trim().is_empty() || id.len() > 2048 || id.contains('\0'))
        {
            return Err(crate::AudioError::DeviceUnavailable(
                "invalid output device identifier".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct OutputActual {
    /// The selected device's user-visible identifier (currently its name).
    pub device_id: String,
    /// Stable native endpoint identity when the adapter exposes it.
    pub endpoint_id: Option<String>,
    pub backend: String,
    pub mode: OutputMode,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: OutputSampleFormat,
    pub container_bits: u16,
    pub valid_bits: u16,
    pub dither_active: bool,
    pub dither_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct OutputCapabilities {
    /// Adapter availability, not a claim that this endpoint passed qualification.
    pub exclusive_available: bool,
    pub exclusive_reason: Option<String>,
    pub device_qualified: bool,
    pub qualification_reason: String,
}

impl Default for OutputCapabilities {
    fn default() -> Self {
        Self {
            exclusive_available: cfg!(target_os = "windows"),
            exclusive_reason: if cfg!(target_os = "windows") {
                None
            } else {
                Some("exclusive_output_requires_windows_wasapi".into())
            },
            device_qualified: false,
            qualification_reason: "physical_device_qualification_pending".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct OutputStatus {
    pub requested: OutputPreferences,
    /// Last accepted device preferences; restoring a local lease must not apply
    /// a newer rejected draft in `requested`.
    pub accepted: OutputPreferences,
    pub actual: Option<OutputActual>,
    /// An opened, healthy output owns the renderer; this is not playing intent.
    pub active: bool,
    pub last_error: Option<String>,
    pub capabilities: OutputCapabilities,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_keep_shared_float_automatic_output() {
        let preferences: OutputPreferences = serde_json::from_str("{}").unwrap();
        assert_eq!(preferences, OutputPreferences::default());
        assert!(serde_json::from_str::<OutputPreferences>(r#"{"rate":192000}"#).is_err());
        assert!(serde_json::from_str::<OutputPreferences>(r#"{"mode":"direct"}"#).is_err());
    }

    #[test]
    fn rejects_empty_or_embedded_nul_device_ids() {
        for id in ["", "  ", "speaker\0other"] {
            assert!(OutputPreferences {
                device_id: Some(id.into()),
                ..Default::default()
            }
            .validate()
            .is_err());
        }
    }
}
