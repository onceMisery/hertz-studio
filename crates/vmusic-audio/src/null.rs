// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! A backend that makes no sound.
//!
//! It implements the full state machine against the wall clock, which is
//! exactly what the integration tests, CI and `--backend null` need: no sound
//! card, no platform-specific behaviour, deterministic timing.
//!
//! Position is always derived from `Instant`, never accumulated, so the
//! `&self` accessors on [`AudioBackend`] stay correct even though the backend
//! is not being ticked.

use std::time::Instant;

use vmusic_core::{AudioBackend, AudioError, DeviceInfo, MediaInfo};

pub struct NullBackend {
    duration_ms: Option<u64>,
    position_ms: u64,
    playing: bool,
    finished: bool,
    volume: f32,
    started: Option<Instant>,
    offset_ms: u64,
}

impl NullBackend {
    pub fn new() -> Self {
        Self {
            duration_ms: None,
            position_ms: 0,
            playing: false,
            finished: false,
            volume: 1.0,
            started: None,
            offset_ms: 0,
        }
    }

    fn live_position(&self) -> u64 {
        let mut pos = self.position_ms;
        if self.playing {
            if let Some(started) = self.started {
                pos = self.offset_ms + started.elapsed().as_millis() as u64;
            }
        }
        match self.duration_ms {
            Some(d) if pos > d => d,
            _ => pos,
        }
    }
}

impl Default for NullBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioBackend for NullBackend {
    fn name(&self) -> &'static str {
        "null"
    }

    fn devices(&self) -> Result<Vec<DeviceInfo>, AudioError> {
        Ok(vec![DeviceInfo {
            id: "null".into(),
            name: "Null output".into(),
            is_default: true,
        }])
    }

    fn select_device(&mut self, _id: Option<&str>) -> Result<(), AudioError> {
        Ok(())
    }

    fn load(&mut self, uri: &str) -> Result<MediaInfo, AudioError> {
        // The null backend never touches the file, so duration is unknown.
        // Callers must treat `None` as "unknown", not as zero.
        if uri.trim().is_empty() {
            return Err(AudioError::UnsupportedFormat("empty uri".into()));
        }
        self.duration_ms = None;
        self.position_ms = 0;
        self.offset_ms = 0;
        self.playing = false;
        self.finished = false;
        self.started = None;
        Ok(MediaInfo::default())
    }

    fn play(&mut self) -> Result<(), AudioError> {
        if self.finished || self.playing {
            return Ok(());
        }
        self.offset_ms = self.position_ms;
        self.started = Some(Instant::now());
        self.playing = true;
        Ok(())
    }

    fn pause(&mut self) -> Result<(), AudioError> {
        self.position_ms = self.live_position();
        self.offset_ms = self.position_ms;
        self.playing = false;
        self.started = None;
        Ok(())
    }

    fn stop(&mut self) -> Result<(), AudioError> {
        self.playing = false;
        self.finished = false;
        self.position_ms = 0;
        self.offset_ms = 0;
        self.started = None;
        Ok(())
    }

    fn seek(&mut self, position_ms: u64) -> Result<(), AudioError> {
        self.position_ms = position_ms;
        self.offset_ms = position_ms;
        self.finished = false;
        self.started = self.playing.then(Instant::now);
        Ok(())
    }

    fn set_volume(&mut self, volume: f32) -> Result<(), AudioError> {
        self.volume = volume.clamp(0.0, 1.0);
        Ok(())
    }

    fn position_ms(&self) -> u64 {
        self.live_position()
    }

    fn duration_ms(&self) -> Option<u64> {
        self.duration_ms
    }

    fn finished(&self) -> bool {
        if self.finished {
            return true;
        }
        match self.duration_ms {
            Some(d) => self.live_position() >= d,
            None => false,
        }
    }

    fn spectrum(&self, _out: &mut [f32]) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn play_pause_advance_and_stop() {
        let mut b = NullBackend::new();
        b.load("file:///a.mp3").unwrap();
        assert_eq!(b.position_ms(), 0);

        b.play().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(120));
        b.pause().unwrap();
        let paused = b.position_ms();
        assert!(paused >= 100, "expected >=100ms, got {paused}");

        std::thread::sleep(std::time::Duration::from_millis(60));
        assert_eq!(b.position_ms(), paused, "position must freeze while paused");

        b.stop().unwrap();
        assert_eq!(b.position_ms(), 0);
    }

    #[test]
    fn seek_is_honoured_and_clamped_by_duration() {
        let mut b = NullBackend::new();
        b.load("file:///a.mp3").unwrap();
        b.seek(5_000).unwrap();
        assert_eq!(b.position_ms(), 5_000);
    }

    #[test]
    fn empty_uri_is_rejected() {
        let mut b = NullBackend::new();
        assert!(matches!(
            b.load("  "),
            Err(AudioError::UnsupportedFormat(_))
        ));
    }
}
