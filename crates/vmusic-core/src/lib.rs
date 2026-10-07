// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! `vmusic-core` — the vocabulary of the project.
//!
//! Holds the domain model, the [`AudioBackend`] trait and the error taxonomy.
//! It has no dependency on any concrete backend, database or web framework, so
//! it stays cheap to unit-test and impossible to tangle.

pub mod audio;
pub mod error;
pub mod model;

pub use audio::{
    AudioBackend, AudioSource, DspParams, MediaInfo, NextEvent, NextTrack, PrepareResult,
};
pub use error::{http_status, AudioError, CoreError, LibraryError, Result, StoreError};
pub use model::{
    DeviceInfo, Favorite, FavoriteKind, LyricDocument, LyricLine, LyricSource, LyricWord, PlayMode,
    PlayerSnapshot, Playlist, PlaylistId, Track, TrackId, TrackSource, PROTOCOL_VERSION,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the protocol contract: hosts reject mismatched servers.
    #[test]
    fn protocol_version_is_stable() {
        assert_eq!(PROTOCOL_VERSION, 1);
    }

    #[test]
    fn error_codes_and_statuses_map_as_documented() {
        let e = CoreError::Library(LibraryError::TrackNotFound("x".into()));
        assert_eq!(e.code(), "track_not_found");
        assert_eq!(e.status(), 404);

        let e = CoreError::Unauthorized("bad token".into());
        assert_eq!(e.code(), "unauthorized");
        assert_eq!(e.status(), 401);
    }

    #[test]
    fn lyric_lookup_finds_the_active_line() {
        let doc = LyricDocument {
            source: LyricSource::Sidecar,
            offset_ms: 0,
            lines: vec![
                LyricLine {
                    start_ms: 0,
                    end_ms: Some(1000),
                    text: "a".into(),
                    words: vec![],
                },
                LyricLine {
                    start_ms: 1000,
                    end_ms: Some(2000),
                    text: "b".into(),
                    words: vec![],
                },
                LyricLine {
                    start_ms: 2000,
                    end_ms: None,
                    text: "c".into(),
                    words: vec![],
                },
            ],
            translation: None,
        };
        assert_eq!(doc.line_index_at(0), Some(0));
        assert_eq!(doc.line_index_at(999), Some(0));
        assert_eq!(doc.line_index_at(1000), Some(1));
        assert_eq!(doc.line_index_at(99_999), Some(2));
        // Before the first line there is nothing active yet.
        assert_eq!(
            LyricDocument {
                lines: vec![LyricLine {
                    start_ms: 500,
                    end_ms: None,
                    text: "x".into(),
                    words: vec![]
                }],
                ..doc
            }
            .line_index_at(100),
            None
        );
    }
}
