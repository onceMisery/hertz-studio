// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! Local library scanning.
//!
//! Metadata comes from symphonia, the same crate the playback backend decodes
//! with, so what the library shows and what the decoder sees can never
//! disagree. Everything happens offline: no tag is ever looked up on the
//! network.

use std::path::{Path, PathBuf};

use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, MetadataRevision, StandardTagKey, Value};
use symphonia::core::probe::Hint;
use vmusic_core::{Track, TrackSource};

pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "wav", "m4a", "aac", "ogg", "oga", "opus", "ape", "wma", "aiff", "aif", "alac",
];

pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Walks `root` and returns every file that looks like audio.
///
/// Symlinks are not followed: a music library that links back to its own
/// parent would otherwise turn a scan into an infinite loop.
pub fn collect_audio_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() && is_audio_file(entry.path()) {
            out.push(entry.path().to_path_buf());
        }
    }
    out.sort();
    out
}

/// Everything the library needs from one file.
#[derive(Debug, Default)]
pub struct FileMeta {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub cover: Option<(Vec<u8>, String)>,
}

pub fn read_metadata(path: &Path) -> Result<FileMeta, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let mut hint = Hint::new();
    if !ext.is_empty() {
        hint.with_extension(&ext);
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| e.to_string())?;

    let mut meta = FileMeta::default();
    let mut reader = probed.format;

    if let Some(params) = reader.default_track().map(|t| t.codec_params.clone()) {
        if let (Some(tb), Some(frames)) = (params.time_base, params.n_frames) {
            // `seconds` truncates; keep the fraction or short clips land on 0.
            let time = tb.calc_time(frames);
            meta.duration_ms = Some(((time.seconds as f64 + time.frac) * 1000.0).round() as u64);
        }
        meta.sample_rate = params.sample_rate;
        meta.channels = params.channels.map(|c| c.count() as u8);
        // Symphonia exposes bits-per-sample, not a bitrate; deriving one from
        // it would be guesswork, so the field stays absent and the UI shows "-".
    }

    // Tags inside the container are reached through the reader, while tags
    // living outside it — an ID3v2 block prefixed to an MP3 — come back on
    // the probe result itself. Gather both; the in-container revision wins
    // when the same field exists in both places (empty fields are simply
    // left for the next revision to fill).
    if let Some(revision) = reader.metadata().current() {
        apply_revision(&mut meta, revision);
    }
    if let Some(mut extra) = probed.metadata.into_inner() {
        if let Some(revision) = extra.metadata().skip_to_latest() {
            apply_revision(&mut meta, revision);
        }
    }

    Ok(meta)
}

/// Fills still-absent fields of `meta` from one metadata revision.
fn apply_revision(meta: &mut FileMeta, revision: &MetadataRevision) {
    for tag in revision.tags() {
        let Value::String(text) = &tag.value else {
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        match tag.std_key {
            Some(StandardTagKey::TrackTitle) if meta.title.is_none() => {
                meta.title = Some(text.clone())
            }
            Some(StandardTagKey::Artist) if meta.artist.is_none() => {
                meta.artist = Some(text.clone())
            }
            Some(StandardTagKey::Album) if meta.album.is_none() => meta.album = Some(text.clone()),
            _ => {}
        }
    }
    if meta.cover.is_none() {
        if let Some(visual) = revision.visuals().first() {
            meta.cover = Some((visual.data.to_vec(), visual.media_type.clone()));
        }
    }
}

/// Builds a [`Track`] from a path plus its metadata.
///
/// When tags are missing we fall back to the file name, because a track with
/// an empty title is worse than one with a slightly ugly title.
pub fn build_track(path: &Path, meta: FileMeta) -> Track {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let fs_meta = std::fs::metadata(path).ok();

    Track {
        id: uuid::Uuid::new_v4().to_string(),
        path: path.to_string_lossy().to_string(),
        source: TrackSource::Local,
        title: meta.title.filter(|s| !s.trim().is_empty()).unwrap_or(stem),
        artist: meta.artist.filter(|s| !s.trim().is_empty()),
        album: meta.album.filter(|s| !s.trim().is_empty()),
        duration_ms: meta.duration_ms,
        bitrate: meta.bitrate,
        sample_rate: meta.sample_rate,
        channels: meta.channels,
        has_cover: false,
        file_mtime: fs_meta.as_ref().and_then(|m| {
            m.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
        }),
        file_size: fs_meta.map(|m| m.len() as i64),
        added_at: now,
    }
}

/// Persists an embedded cover to the cache directory.
///
/// Returns the cache key, or `None` if there is nothing to write. The key is
/// derived from the track id so a re-scan overwrites in place instead of
/// accumulating orphaned images.
pub fn save_cover(
    cache_dir: &Path,
    track_id: &str,
    data: &[u8],
    media_type: &str,
) -> Option<String> {
    if data.is_empty() {
        return None;
    }
    let ext = match media_type {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    };
    let dir = cache_dir.join("covers");
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let name = format!("{track_id}.{ext}");
    let path = dir.join(&name);
    if std::fs::write(&path, data).is_err() {
        return None;
    }
    Some(name)
}

/// Looks for a sidecar `.lrc` next to the audio file.
pub fn find_sidecar_lyrics(track_path: &Path) -> Option<PathBuf> {
    let stem = track_path.file_stem()?.to_str()?;
    let parent = track_path.parent()?;
    let candidate = parent.join(format!("{stem}.lrc"));
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_filter_is_case_insensitive() {
        assert!(is_audio_file(Path::new("/a/b/Song.FLAC")));
        assert!(is_audio_file(Path::new("/a/b/c.mp3")));
        assert!(!is_audio_file(Path::new("/a/b/cover.jpg")));
        assert!(!is_audio_file(Path::new("/a/b/notes.txt")));
    }

    #[test]
    fn missing_tags_fall_back_to_the_file_name() {
        let track = build_track(Path::new("/music/My Song.mp3"), FileMeta::default());
        assert_eq!(track.title, "My Song");
        assert!(track.artist.is_none());
    }

    #[test]
    fn empty_tags_are_ignored_in_favour_of_the_file_name() {
        let track = build_track(
            Path::new("/music/My Song.mp3"),
            FileMeta {
                title: Some("   ".into()),
                ..Default::default()
            },
        );
        assert_eq!(track.title, "My Song");
    }

    #[test]
    fn sidecar_lookup_uses_the_track_stem() {
        let dir = std::env::temp_dir().join(format!("vmusic-lib-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("track01.mp3");
        std::fs::write(&audio, b"").unwrap();
        assert!(find_sidecar_lyrics(&audio).is_none());

        std::fs::write(dir.join("track01.lrc"), b"[00:01.00]x").unwrap();
        assert_eq!(find_sidecar_lyrics(&audio), Some(dir.join("track01.lrc")));
    }
}
