// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Local library scanning.
//!
//! Metadata comes from symphonia, the same crate the playback backend decodes
//! with, so what the library shows and what the decoder sees can never
//! disagree. Everything happens offline: no tag is ever looked up on the
//! network.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

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
    let mut files = collect_audio_files_checked(root, &AtomicBool::new(false)).files;
    files.sort();
    files
}

#[derive(Debug, Default)]
pub struct WalkReport {
    pub files: Vec<PathBuf>,
    pub errors: Vec<(PathBuf, String)>,
    pub error_count: usize,
    pub cancelled: bool,
}

/// A partial walk is never evidence that an unseen file was deleted. Callers
/// must skip pruning if `error_count > 0` or `cancelled` is set.
pub fn collect_audio_files_checked(root: &Path, cancel: &AtomicBool) -> WalkReport {
    let mut report = WalkReport::default();
    let mut entries = walkdir::WalkDir::new(root).follow_links(false).into_iter();
    loop {
        if cancel.load(Ordering::Relaxed) {
            report.cancelled = true;
            break;
        }
        let Some(entry) = entries.next() else { break };
        match entry {
            Ok(entry) if entry.file_type().is_file() && is_audio_file(entry.path()) => {
                report.files.push(entry.path().to_path_buf());
            }
            Ok(_) => {}
            Err(error) => {
                report.error_count += 1;
                if report.errors.len() < 50 {
                    report.errors.push((
                        error.path().unwrap_or(root).to_path_buf(),
                        error.to_string(),
                    ));
                }
            }
        }
    }
    report
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
    /// 容器内嵌的歌词原文（未同步的 USLT / Vorbis `LYRICS` 类标签）。
    pub lyrics: Option<String>,
    /// ReplayGain 曲目增益（dB，来自 REPLAYGAIN_TRACK_GAIN 类标签）。
    pub rg_gain: Option<f64>,
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

/// 宽松解析 "-6.20 dB" / "-6.2dB" / "-6.2" 中的前导浮点。
fn parse_leading_f64(text: &str) -> Option<f64> {
    let t = text.trim();
    let end = t
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+'))
        .unwrap_or(t.len());
    t[..end].trim().parse().ok()
}

/// Fills still-absent fields of `meta` from one metadata revision.
fn apply_revision(meta: &mut FileMeta, revision: &MetadataRevision) {
    for tag in revision.tags() {
        let Value::String(raw) = &tag.value else {
            continue;
        };
        // RIFF INFO 的字符串以 NUL 结尾，而且块长度把终止符算在内；symphonia
        // 0.5.5 的 `riff::parse` 只是把整块 `from_utf8_lossy`，不剥终止符，于是
        // WAV 的标题/艺术家/专辑会带着一个 `\0` 一路落库（ffmpeg 的
        // `ff_riff_write_info_tag` 正是按这个形状写的，所以真实文件就会中招）。
        // `str::trim` 治不了它：NUL 不属于 Unicode 空白。
        let text = raw.trim_end_matches('\0');
        if text.trim().is_empty() {
            continue;
        }
        match tag.std_key {
            Some(StandardTagKey::TrackTitle) if meta.title.is_none() => {
                meta.title = Some(text.to_string())
            }
            Some(StandardTagKey::Artist) if meta.artist.is_none() => {
                meta.artist = Some(text.to_string())
            }
            Some(StandardTagKey::Album) if meta.album.is_none() => {
                meta.album = Some(text.to_string())
            }
            _ => {}
        }
        // 歌词标签：ID3v2 USLT 经 symphonia 映射为 std Lyrics，FLAC/Ogg 的
        // Vorbis comment 常见裸键（LYRICS/UNSYNCEDLYRICS/SYNCEDLYRICS）也接住。
        let is_lyrics_tag = matches!(tag.std_key, Some(StandardTagKey::Lyrics))
            || tag.key.eq_ignore_ascii_case("lyrics")
            || tag.key.eq_ignore_ascii_case("unsyncedlyrics")
            || tag.key.eq_ignore_ascii_case("syncedlyrics");
        if is_lyrics_tag && meta.lyrics.is_none() {
            meta.lyrics = Some(text.to_string());
        }
        // ReplayGain 增益：形如 "-6.20 dB"，宽松解析前导浮点。
        if meta.rg_gain.is_none()
            && (matches!(tag.std_key, Some(StandardTagKey::ReplayGainTrackGain))
                || tag.key.eq_ignore_ascii_case("replaygain_track_gain"))
        {
            if let Some(v) = parse_leading_f64(text) {
                meta.rg_gain = Some(v);
            }
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
    fn walk_reports_missing_root_and_honours_cancellation() {
        let missing = std::env::temp_dir().join(format!("missing-{}", uuid::Uuid::new_v4()));
        let failed = collect_audio_files_checked(&missing, &AtomicBool::new(false));
        assert_eq!(failed.error_count, 1);
        assert_eq!(failed.errors[0].0, missing);
        let cancelled = collect_audio_files_checked(&missing, &AtomicBool::new(true));
        assert!(cancelled.cancelled);
        assert!(cancelled.files.is_empty());
        assert_eq!(cancelled.error_count, 0);
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

    /// 构造一个最小的 FLAC 文件：STREAMINFO + VORBIS_COMMENT（含歌词标签）。
    /// read_metadata 只读元数据，不需要真正的音频帧。
    fn flac_with_comment(tags: &[(&str, &str)]) -> Vec<u8> {
        let mut out = b"fLaC".to_vec();
        // STREAMINFO（block type 0，最后一块标志位由下面按需拼）：
        // 34 字节，字段布局按 FLAC 规范位打包。
        let streaminfo = {
            let mut b = Vec::new();
            b.extend_from_slice(&4096u16.to_be_bytes()); // min blocksize
            b.extend_from_slice(&4096u16.to_be_bytes()); // max blocksize
            b.extend_from_slice(&0u32.to_be_bytes()[1..]); // min framesize (u24)
            b.extend_from_slice(&0u32.to_be_bytes()[1..]); // max framesize (u24)
                                                           // 20 bits sample-rate | 3 bits channels-1 | 5 bits bps-1 | 36 bits total-samples
            let packed = (44_100u64 << 44) | (1u64 << 41) | (15u64 << 36) | 44_100u64;
            b.extend_from_slice(&packed.to_be_bytes());
            b.extend_from_slice(&[0u8; 16]); // md5
            b
        };
        let is_last = false;
        out.push(if is_last { 0x80 } else { 0x00 });
        out.extend_from_slice(&(streaminfo.len() as u32).to_be_bytes()[1..]);
        out.extend_from_slice(&streaminfo);

        // VORBIS_COMMENT（block type 4）：
        let comment = {
            let mut b = Vec::new();
            let vendor = b"vmusic-test";
            b.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
            b.extend_from_slice(vendor);
            b.extend_from_slice(&(tags.len() as u32).to_le_bytes());
            for (k, v) in tags {
                let entry = format!("{k}={v}");
                b.extend_from_slice(&(entry.len() as u32).to_le_bytes());
                b.extend_from_slice(entry.as_bytes());
            }
            b
        };
        out.push(0x80 | 0x04); // last-block flag | type 4
        out.extend_from_slice(&(comment.len() as u32).to_be_bytes()[1..]);
        out.extend_from_slice(&comment);

        // 元数据之后追加一个最小合法音频帧（192 样本、2ch、16bit、常数子帧），
        // symphonia 的 flac reader 在元数据结束后要能读到帧，否则报 end of stream。
        // 帧头：同步码 + 固定块策略 + 块大小 192 + 44.1kHz(0b1001) + 2ch + 16bit + 帧号 0。
        let mut frame: Vec<u8> = vec![0xFF, 0xF8, 0x19, 0x18, 0x00];
        frame.push(crc8(&frame));
        // 子帧：每声道 1B 常数子帧头 + 2B 常数值；两声道共 6B。
        frame.extend_from_slice(&[0u8; 6]);
        // CRC-16 覆盖从帧同步码到子帧结束（不含 CRC 自身）。
        let tail = crc16(&frame);
        frame.extend_from_slice(&tail);
        out.extend_from_slice(&frame);
        out
    }

    fn crc8(data: &[u8]) -> u8 {
        let mut crc: u8 = 0;
        for &b in data {
            crc ^= b;
            for _ in 0..8 {
                crc = if crc & 0x80 != 0 {
                    (crc << 1) ^ 0x07
                } else {
                    crc << 1
                };
            }
        }
        crc
    }

    fn crc16(data: &[u8]) -> [u8; 2] {
        let mut crc: u16 = 0;
        for &b in data {
            crc ^= (b as u16) << 8;
            for _ in 0..8 {
                crc = if crc & 0x8000 != 0 {
                    (crc << 1) ^ 0x8005
                } else {
                    crc << 1
                };
            }
        }
        crc.to_be_bytes()
    }

    #[test]
    fn embedded_lyrics_are_read_from_vorbis_comment() {
        let dir = std::env::temp_dir().join(format!("vmusic-lib-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("embedded.flac");
        std::fs::write(
            &file,
            flac_with_comment(&[("TITLE", "嵌入"), ("LYRICS", "[00:01.00]内嵌歌词")]),
        )
        .unwrap();
        let meta = read_metadata(&file).unwrap();
        assert_eq!(meta.lyrics.as_deref(), Some("[00:01.00]内嵌歌词"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn files_without_lyrics_tags_leave_lyrics_absent() {
        let dir = std::env::temp_dir().join(format!("vmusic-lib-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("plain.flac");
        std::fs::write(&file, flac_with_comment(&[("TITLE", "无词")])).unwrap();
        let meta = read_metadata(&file).unwrap();
        assert!(meta.lyrics.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 构造一个最小 WAV：fmt + LIST/INFO + data。
    ///
    /// INFO 子块按 ffmpeg `ff_riff_write_info_tag` 的形状写——长度字段**含**结尾
    /// 的 NUL（`len = strlen(str) + 1`），长度为奇数时再补一个 pad 字节。真实的
    /// WAV 就是这样的，而 symphonia 0.5.5 的 `riff::parse` 把整块 `from_utf8_lossy`
    /// 之后并不剥终止符，于是标题会带着一个 `\0` 一路落库。
    fn wav_with_info(tags: &[(&str, &str)]) -> Vec<u8> {
        fn chunk(tag: &[u8; 4], payload: &[u8]) -> Vec<u8> {
            let mut out = Vec::new();
            out.extend_from_slice(tag);
            out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            out.extend_from_slice(payload);
            // pad 字节不计入长度字段。
            if payload.len() % 2 == 1 {
                out.push(0);
            }
            out
        }

        let mut fmt = Vec::new();
        fmt.extend_from_slice(&1u16.to_le_bytes()); // PCM
        fmt.extend_from_slice(&1u16.to_le_bytes()); // 单声道
        fmt.extend_from_slice(&44_100u32.to_le_bytes());
        fmt.extend_from_slice(&88_200u32.to_le_bytes()); // 字节率
        fmt.extend_from_slice(&2u16.to_le_bytes()); // 块对齐
        fmt.extend_from_slice(&16u16.to_le_bytes()); // 位深

        let mut info = b"INFO".to_vec();
        for (tag, value) in tags {
            let mut fourcc = [0u8; 4];
            fourcc.copy_from_slice(tag.as_bytes());
            let mut payload = value.as_bytes().to_vec();
            payload.push(0);
            info.extend(chunk(&fourcc, &payload));
        }

        // 32 个静音采样：够 symphonia 认定这是一条音轨，read_metadata 不要求真帧。
        let mut body = b"WAVE".to_vec();
        body.extend(chunk(b"fmt ", &fmt));
        body.extend(chunk(b"LIST", &info));
        body.extend(chunk(b"data", &[0u8; 64]));

        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend(body);
        out
    }

    /// 三个标签的长度奇偶都覆盖到了：含 NUL 后 "Nocturne"/"Hertz QA" 是 9 字节
    /// （要补 pad），"Smoke" 是 6 字节（不补）。pad 被误当成内容的话这里会红。
    #[test]
    fn riff_info_tags_drop_the_null_terminator() {
        let dir = std::env::temp_dir().join(format!("vmusic-lib-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("tagged.wav");
        std::fs::write(
            &file,
            wav_with_info(&[
                ("INAM", "Nocturne"),
                ("IART", "Hertz QA"),
                ("IPRD", "Smoke"),
            ]),
        )
        .unwrap();
        let meta = read_metadata(&file).unwrap();
        assert_eq!(meta.title.as_deref(), Some("Nocturne"));
        assert_eq!(meta.artist.as_deref(), Some("Hertz QA"));
        assert_eq!(meta.album.as_deref(), Some("Smoke"));
        std::fs::remove_dir_all(&dir).ok();
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
