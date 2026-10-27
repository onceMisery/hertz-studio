// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Audio backends plus the actor that owns them.
//!
//! Nothing in this crate knows about HTTP: callers talk to [`actor::AudioHandle`].

pub mod actor;
pub mod null;

#[cfg(feature = "playback")]
pub mod clocked_resample;

#[cfg(feature = "playback")]
pub mod output_clock;

#[cfg(feature = "playback")]
pub mod scheduled_output;

#[cfg(feature = "playback")]
pub mod cpal_backend;

#[cfg(feature = "playback")]
pub mod render;

#[cfg(feature = "playback")]
pub mod resample;

#[cfg(feature = "playback")]
pub use render::{RenderCore, RenderFormat};

#[cfg(feature = "playback")]
pub use scheduled_output::{
    OutputBinding, OutputError, OutputOptions, OutputTelemetry, ScheduledOutput,
};

pub use actor::{spawn, AudioEvent, AudioHandle, BackendKind};
pub use null::NullBackend;
pub use vmusic_core::PrepareResult;
