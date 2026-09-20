// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! Domain models shared by the service, the audio backends and the UI.

use serde::{Deserialize, Serialize};

/// Protocol version of the HTTP + WebSocket surface.
///
/// Bumped independently from the crate version: any host (web UI, DBX plugin,
/// script) handshakes on this number and refuses to talk to a mismatched
/// server instead of silently mis-reading payloads.
pub const PROTOCOL_VERSION: u32 = 1;

pub type TrackId = String;
pub type PlaylistId = String;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackSource {
    #[default]
    Local,
    Remote,
}

/// A single audio file known to the library.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: TrackId,
    pub path: String,
    pub source: TrackSource,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub has_cover: bool,
    pub file_mtime: Option<i64>,
    pub file_size: Option<i64>,
    pub added_at: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlayMode {
    #[default]
    Repeat,
    RepeatOne,
    Shuffle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Immutable view of the player, cheap enough to hand out on every request.
///
/// `generation` increments whenever the position jumps discontinuously
/// (load / seek / stop). The UI uses it to throw away stale interpolations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerSnapshot {
    pub track_id: Option<TrackId>,
    pub position_ms: u64,
    pub duration_ms: Option<u64>,
    pub playing: bool,
    pub volume: f32,
    pub mode: PlayMode,
    pub device: Option<String>,
    pub generation: u64,
}

impl Default for PlayerSnapshot {
    fn default() -> Self {
        Self {
            track_id: None,
            position_ms: 0,
            duration_ms: None,
            playing: false,
            volume: 1.0,
            mode: PlayMode::Repeat,
            device: None,
            generation: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    pub id: PlaylistId,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub track_count: i64,
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LyricSource {
    /// Parsed from a sidecar `.lrc` file next to the audio file.
    Sidecar,
    /// Read out of the audio container (e.g. an embedded lyric tag).
    Embedded,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricWord {
    pub start_ms: u64,
    pub end_ms: Option<u64>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricLine {
    pub start_ms: u64,
    pub end_ms: Option<u64>,
    pub text: String,
    /// Empty when the source has no word-level timing.
    pub words: Vec<LyricWord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LyricDocument {
    pub source: LyricSource,
    pub offset_ms: i64,
    pub lines: Vec<LyricLine>,
    pub translation: Option<Vec<String>>,
}

impl LyricDocument {
    pub fn empty() -> Self {
        Self {
            source: LyricSource::None,
            offset_ms: 0,
            lines: Vec::new(),
            translation: None,
        }
    }

    /// Index of the line active at `position_ms`, if any.
    ///
    /// Binary search keeps this O(log n); the UI calls it once per animation
    /// frame, so a linear scan would show up in profiles on long tracks.
    pub fn line_index_at(&self, position_ms: u64) -> Option<usize> {
        if self.lines.is_empty() {
            return None;
        }
        let idx = self
            .lines
            .partition_point(|line| line.start_ms <= position_ms);
        if idx == 0 {
            None
        } else {
            Some(idx - 1)
        }
    }
}
