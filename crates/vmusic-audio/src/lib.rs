// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! Audio backends plus the actor that owns them.
//!
//! Nothing in this crate knows about HTTP: callers talk to [`actor::AudioHandle`].

pub mod actor;
pub mod null;

#[cfg(feature = "playback")]
pub mod cpal_backend;

pub use actor::{spawn, AudioEvent, AudioHandle, BackendKind};
pub use null::NullBackend;
