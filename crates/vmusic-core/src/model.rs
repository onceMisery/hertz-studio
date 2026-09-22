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
// 收藏
// ---------------------------------------------------------------------------

/// 收藏项的类型。
///
/// 歌曲与电台在「我的收藏」里是同一个列表的两种行：歌曲点下去是入队播放，
/// 电台点下去是载入整盘。用枚举而不是两个布尔/两张表，是为了让类型本身
/// 成为排他约束——一行收藏不可能同时是歌曲和电台。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FavoriteKind {
    /// 一首歌。本地曲目或某个在线音源的曲目。
    Track,
    /// 电台 / 在线歌单这类可整体播放的节目。
    Radio,
}

impl FavoriteKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FavoriteKind::Track => "track",
            FavoriteKind::Radio => "radio",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "track" => Some(FavoriteKind::Track),
            "radio" => Some(FavoriteKind::Radio),
            _ => None,
        }
    }
}

impl std::fmt::Display for FavoriteKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 一条收藏。
///
/// `source` + `ref_id` 是它指向的对象：`local` + 本地曲目 id，或音源 id +
/// 该音源内的曲目/电台 id。之所以把标题、艺术家、封面这些**快照**一起存下来，
/// 是因为在线收藏的对象不在本地库里——不存快照的话，收藏列表要么得为每条
/// 现打一次上游接口（慢且可能失败），要么显示一排空白行。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Favorite {
    /// 稳定主键：`favorites::identity(kind, source, ref_id)`。
    pub id: String,
    pub kind: FavoriteKind,
    pub source: String,
    pub ref_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub cover: Option<String>,
    pub added_at: i64,
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
