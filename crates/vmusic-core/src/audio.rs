// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! The audio backend contract.
//!
//! Deliberately **synchronous**: real backends own an OS audio callback that
//! must never block on an executor. Anything async lives one layer up, in the
//! command actor (see `vmusic_audio::actor`), which serialises commands so the
//! backend never sees two operations at once.
//!
//! Backends are intentionally **not** required to be `Send`. A cpal stream is
//! owned by the thread that created it, so the actor spawns a dedicated thread
//! and builds the backend there rather than moving it across threads.

use crate::error::AudioError;
use crate::model::DeviceInfo;

/// What a backend reports back after successfully opening a source.
#[derive(Debug, Clone, Default)]
pub struct MediaInfo {
    pub duration_ms: Option<u64>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
}

pub trait AudioBackend {
    fn name(&self) -> &'static str;

    fn devices(&self) -> Result<Vec<DeviceInfo>, AudioError>;

    fn select_device(&mut self, id: Option<&str>) -> Result<(), AudioError>;

    /// Open a source and prepare playback in a paused state.
    fn load(&mut self, uri: &str) -> Result<MediaInfo, AudioError>;

    fn play(&mut self) -> Result<(), AudioError>;
    fn pause(&mut self) -> Result<(), AudioError>;
    fn stop(&mut self) -> Result<(), AudioError>;

    fn seek(&mut self, position_ms: u64) -> Result<(), AudioError>;
    fn set_volume(&mut self, volume: f32) -> Result<(), AudioError>;

    fn position_ms(&self) -> u64;
    fn duration_ms(&self) -> Option<u64>;

    /// True once the current source has been fully consumed.
    fn finished(&self) -> bool;

    /// Fill `out` with normalized band energies (0.0..=1.0).
    ///
    /// Returns `false` when the backend cannot provide spectrum data (null
    /// backend, unsupported format, or not currently playing).
    fn spectrum(&self, out: &mut [f32]) -> bool;
}
