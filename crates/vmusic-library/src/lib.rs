// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Local library scanning.
//!
//! Metadata comes from symphonia, the same crate the playback backend decodes
//! with, so what the library shows and what the decoder sees can never
//! disagree. Everything happens offline: no tag is ever looked up on the
//! network.

use std::path::{Component, Prefix, Path, PathBuf};
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

/// 扫描根目录的本地性闸门：网络位置（UNC）一律拒绝，遍历一步都不许迈出去。
///
/// 三条理由，都落在「扫描侧无法自救」这一类故障上：
///
/// 1. UNC 根把凭据留在 SMB 会话上。进程是以运行者的身份去开 `\\nas\share` 的，用的
///    是系统缓存的域凭据，而不是用户在这个请求里明示授权的账号 —— 一次「扫曲库」
///    于是变成对端整卷的读权限。
/// 2. 遍历会挂在断开的共享上。walkdir 没有超时，也没有可中断的网络错误：NAS 睡眠、
///    掉线或权限变动都能让扫描永久停在 running，而调用方的看门狗只会看到「还在跑」，
///    之后每次扫描都被上一轮的 running 挡掉。
/// 3. 这类根通常是别人的机器写的，扫描侧判断不了可写性与配额。封面缓存要往根目录里
///    写，只读共享和满盘只能在遍历中途才暴露，此时库里已经落了一半曲目。
///
/// 让用户「映射成本地盘符或复制到本地」不是推卸：映射盘走的是用户自己确认过凭据的
/// 那条会话，`Z:\Music` 对扫描器而言与本地目录同形，也就能被正常对待。
///
/// 平台差异是刻意的：`//server/share` 只在 Windows 上是网络路径，在 Unix 上它是
/// 一条合法的本地相对/绝对路径，拒绝它就是把用户家的目录结构当 bug 修。判定因此只看
/// `Path` 解析出的前缀形状（Unix 根本不产生 Prefix 分量），而不是手写字符串前缀 +
/// `cfg(windows)` —— 后者会随分隔符写法漏判。反过来的差距也要认：Unix 上的 NFS/CIFS
/// 挂载在语法上与本地目录无从区分，这条闸门在那些平台上只挡不住真网络盘。
pub fn ensure_local_root(root: &Path) -> Result<(), String> {
    if is_unc(root) {
        return Err(format!(
            "{}: 不支持网络位置，请先映射成本地盘符或复制到本地",
            root.display()
        ));
    }
    Ok(())
}

/// UNC（`\\server\share`）与逐字 UNC（`\\?\UNC\server\share`）两种写法都算网络位置；
/// 其余前缀（盘符、映射盘、`\\.\` 设备名）与无前缀路径都按本地放行。
fn is_unc(path: &Path) -> bool {
    matches!(
        path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..))
    )
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
    // 闸门放在这里而不是只放在调用方：调用方会换（HTTP 入口、文件事件、启动自愈是
    // 三条不同的路），而「别拿网络位置去遍历」是遍历自身的约束，只在某条入口上成立
    // 就等于没成立。
    if let Err(message) = ensure_local_root(root) {
        report.error_count = 1;
        report.errors.push((root.to_path_buf(), message));
        return report;
    }
    // `false` 是定值，不是「walkdir 默认就这样」：默认的隐式取值一旦被谁顺手改成跟随，
    // 编译没有任何信号，症状却出现在离改动很远的地方。
    //
    // 不跟随换来的是三件确定不进库的东西：跟随会把根外的目录（乃至 UNC 目标，映射盘
    // 里的符号链接照样指得出去）当成曲库的一部分、会让 `Music/loop -> Music` 这种自引用
    // 遍历到 walkdir 的循环检测报错为止、并且同一首歌经两条路径进来就是两条曲目记录。
    // 代价同样确定：链接指向的本地曲目在库里就是看不见 —— 这是设计取舍，不是 bug，
    // 下面的断言两边都钉住，谁改动这一行都要有一条测试红给他看。
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
    /// ReplayGain 专辑增益（dB，来自 REPLAYGAIN_ALBUM_GAIN 类标签）。
    pub rg_album_gain: Option<f64>,
    /// ReplayGain 曲目峰值（线性，来自 REPLAYGAIN_TRACK_PEAK 类标签）。
    pub rg_peak: Option<f64>,
    /// ReplayGain 专辑峰值（线性，来自 REPLAYGAIN_ALBUM_PEAK 类标签）。
    pub rg_album_peak: Option<f64>,
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
        // ReplayGain 家族：增益形如 "-6.20 dB"、峰值形如 "0.987654"（线性），
        // 都按宽松解析前导浮点。std_key 覆盖 FLAC/Ogg 与 ID3v2 的规范映射，
        // 裸键兜底接住不规范写入的标签（大小写不敏感）。
        match tag.std_key {
            Some(StandardTagKey::ReplayGainTrackGain) => {
                if meta.rg_gain.is_none() {
                    meta.rg_gain = parse_leading_f64(text);
                }
            }
            Some(StandardTagKey::ReplayGainAlbumGain) => {
                if meta.rg_album_gain.is_none() {
                    meta.rg_album_gain = parse_leading_f64(text);
                }
            }
            Some(StandardTagKey::ReplayGainTrackPeak) => {
                if meta.rg_peak.is_none() {
                    meta.rg_peak = parse_leading_f64(text);
                }
            }
            Some(StandardTagKey::ReplayGainAlbumPeak) => {
                if meta.rg_album_peak.is_none() {
                    meta.rg_album_peak = parse_leading_f64(text);
                }
            }
            _ => {
                let key = tag.key.to_ascii_lowercase();
                let slot = match key.as_str() {
                    "replaygain_track_gain" => &mut meta.rg_gain,
                    "replaygain_album_gain" => &mut meta.rg_album_gain,
                    "replaygain_track_peak" => &mut meta.rg_peak,
                    "replaygain_album_peak" => &mut meta.rg_album_peak,
                    _ => {
                        continue;
                    }
                };
                if slot.is_none() {
                    *slot = parse_leading_f64(text);
                }
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
///
/// 两道把关（都来自「缓存里出现过坏封面」这一类真实故障，不是洁癖）：
///
/// 1. **按像素尺寸与格式签名拒绝**，不按字节数。内嵌图里常见 1×1 / 32×32 的占位
///    图与「图标」类型附件，几十~几百字节都算「非空」，按字节拦不住，界面拿到就是
///    一块糊斑；而 `complete.rs` 那条路是从 URL 后缀猜媒体类型的，服务端回一句
///    「稍后再试」的 HTML 也会被当成 jpg 存进封面缓存 —— 头部签名这一关同时挡住两者。
/// 2. **两阶段写**：先写同目录下的 `.part`，成功后 rename 覆盖。直接 `fs::write`
///    是先截断再写，进程在中间被杀掉就留下一个半截 jpg，而库里 `has_cover=true`，
///    症状是「封面永远碎掉」，且重扫时文件签名没变就永远不会重写它。
pub fn save_cover(
    cache_dir: &Path,
    track_id: &str,
    data: &[u8],
    media_type: &str,
) -> Option<String> {
    if data.is_empty() || !plausible_cover(data, media_type) {
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
    let tmp = dir.join(format!(".{name}.part"));
    if std::fs::write(&tmp, data).is_err() {
        return None;
    }
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return None;
    }
    // 重打标签换了格式（jpg→png）时把同源的旧扩展名删掉：留着就是没人引用的孤儿，
    // 而封面缓存是按 track_id 命名的，没人会再去读它。
    for other in ["jpg", "png", "webp", "gif"] {
        if other == ext {
            continue;
        }
        let _ = std::fs::remove_file(dir.join(format!("{track_id}.{other}")));
    }
    Some(name)
}

/// 封面像素边长下限。低于这个数不值得当封面（占位图、图标类型附件都在这一档）。
const MIN_COVER_EDGE: u32 = 64;

/// 这团字节能不能当封面用：签名对得上声明的格式，且**读得出尺寸时**两边都不小于
/// [`MIN_COVER_EDGE`]。读不出尺寸的少见分支（认不出的子格式）放行 ——
/// 宁可留一张糊图，也不要把用户本来有的封面变成没有。
fn plausible_cover(data: &[u8], media_type: &str) -> bool {
    match image_dimensions(data, media_type) {
        Some((w, h)) => w >= MIN_COVER_EDGE && h >= MIN_COVER_EDGE,
        // 尺寸读不出来：至少声明格式的签名要对得上。放行「签名对但子格式认不出」
        // 的少数情况，宁可留一张糊图也不要把用户本来有的封面变成没有。
        None => has_image_signature(data, media_type),
    }
}

fn has_image_signature(data: &[u8], media_type: &str) -> bool {
    match media_type {
        "image/png" => data.starts_with(&[0x89, b'P', b'N', b'G']),
        "image/gif" => data.starts_with(b"GIF8"),
        "image/webp" => data.len() > 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP",
        _ => data.starts_with(&[0xFF, 0xD8]),
    }
}

/// 只读图片头部拿宽高，不引图像解码库（这里只需要「多大、是不是真图」）。
/// 返回 None = 认不出这个格式的子格式或头部不完整，由调用方决定信不信。
fn image_dimensions(data: &[u8], media_type: &str) -> Option<(u32, u32)> {
    let be32 = |at: usize| -> Option<u32> {
        Some(u32::from_be_bytes([
            *data.get(at)?,
            *data.get(at + 1)?,
            *data.get(at + 2)?,
            *data.get(at + 3)?,
        ]))
    };
    let le16 = |at: usize| -> Option<u32> {
        Some(u16::from_le_bytes([*data.get(at)?, *data.get(at + 1)?]) as u32)
    };
    match media_type {
        "image/png" => {
            if !data.starts_with(&[0x89, b'P', b'N', b'G']) || data.len() < 24 {
                return None;
            }
            Some((be32(16)?, be32(20)?))
        }
        "image/gif" => {
            if !data.starts_with(b"GIF8") {
                return None;
            }
            Some((le16(6)?, le16(8)?))
        }
        "image/webp" => webp_dimensions(data),
        // 其余声明（含 image/jpeg 与来路不明的媒体类型）一律按 JPEG 头读。
        _ => jpeg_dimensions(data),
    }
}

fn jpeg_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if !data.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut i = 2;
    while i + 9 <= data.len() {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = data[i + 1];
        // SOF0–3 / 5–7 / 9–11 / 13–15 都带帧尺寸（渐进式 JPEG 也在其中）。
        if matches!(marker, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF) {
            let h = u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32;
            let w = u16::from_be_bytes([data[i + 7], data[i + 8]]) as u32;
            return (w > 0 && h > 0).then_some((w, h));
        }
        if marker == 0xFF {
            i += 1;
            continue; // 填充字节
        }
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue; // 无长度段的标记
        }
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        if len < 2 {
            return None;
        }
        i += 2 + len;
    }
    None
}

fn webp_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 16 || !data.starts_with(b"RIFF") || &data[8..12] != b"WEBP" {
        return None;
    }
    match &data[12..16] {
        // VP8X：扩展格式，画布尺寸是 24bit 小端、且都是「值 - 1」。
        b"VP8X" if data.len() >= 30 => {
            let w = 1 + u32::from_le_bytes([data[24], data[25], data[26], 0]);
            let h = 1 + u32::from_le_bytes([data[27], data[28], data[29], 0]);
            Some((w, h))
        }
        // VP8：有损格式，帧头里 14bit 小端的宽高（偏移 26 / 28）。
        b"VP8 " if data.len() >= 30 => Some((
            u16::from_le_bytes([data[26], data[27]]) as u32 & 0x3FFF,
            u16::from_le_bytes([data[28], data[29]]) as u32 & 0x3FFF,
        )),
        // VP8L：无损格式，0xFF 之后 4 字节里各塞了 14bit 的宽与高。
        b"VP8L" if data.len() >= 25 && data[20] == 0xFF => {
            let bits = u32::from_le_bytes([data[21], data[22], data[23], data[24]]);
            Some((1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)))
        }
        _ => None,
    }
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

/// 依赖裁剪的契约（P2-9）：`AUDIO_EXTENSIONS` 里每个 symphonia 支持的扩展名，
/// 都必须在 workspace `Cargo.toml` 里打开对应的 feature。
///
/// 值得一条测试的理由：那行 features 列表是**手写**的裁剪结果，谁删掉一个 feature
/// （或改回 `all`、或漏掉 `default-features = false`——symphonia 的默认集里带
/// mkv，漏了就等于没裁）都不会编译失败，症状是「某类文件扫描收得进、播放报
/// unsupported」，离改动很远才暴露。这里把扩展名表与 feature 列表钉在一起。
#[cfg(test)]
mod symphonia_features {
    use super::AUDIO_EXTENSIONS;

    /// 扩展名 → 需要的 feature。
    const FEATURE_FOR_EXT: &[(&str, &str)] = &[
        ("mp3", "mpa"),
        ("flac", "flac"),
        ("wav", "wav"),
        ("aiff", "aiff"),
        ("aif", "aiff"),
        ("m4a", "isomp4"),
        ("aac", "aac"),
        ("alac", "alac"),
        ("ogg", "ogg"),
        ("oga", "ogg"),
    ];

    /// wav/aiff 里的 PCM 与 ADPCM 载体：没有扩展名单独指向它们，缺了就放不出声。
    const CODEC_FEATURES: &[&str] = &["pcm", "adpcm"];

    /// symphonia 0.5 没有解码器的扩展名：扫描收得进、播放会报 unsupported，
    /// 是既有差距，不在本契约内（要支持得先换实现）。
    const UNSUPPORTED_EXTS: &[&str] = &["opus", "ape", "wma"];

    /// 明确裁掉的容器：扩展名表里没有它们，留着只是白编译。
    const DROPPED_FORMATS: &[&str] = &["mkv", "caf"];

    /// 取 workspace Cargo.toml 里 symphonia 那条声明中打开的全部 feature。
    fn symphonia_features() -> Vec<String> {
        let manifest = include_str!("../../../Cargo.toml");
        let start = manifest
            .find("\nsymphonia = ")
            .expect("Cargo.toml 里应有 symphonia 声明");
        let rest = &manifest[start..];
        let end = rest.find(']').expect("symphonia 声明应是 features 数组");
        let decl = &rest[..end];
        assert!(
            decl.contains("default-features = false"),
            "必须关掉默认特性，否则 symphonia 的默认集会把 mkv 拉回来：{decl}"
        );
        decl.split('"')
            .skip(1)
            .step_by(2)
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn symphonia_features_cover_every_decodable_extension() {
        let features = symphonia_features();
        assert!(
            !features.iter().any(|f| f.starts_with("all")),
            "别再用 all：{features:?}"
        );
        for (ext, feature) in FEATURE_FOR_EXT {
            assert!(
                features.iter().any(|f| f == feature),
                "扩展名 {ext} 需要 feature {feature}，当前：{features:?}"
            );
        }
        for feature in CODEC_FEATURES {
            assert!(
                features.iter().any(|f| f == feature),
                "wav/aiff 的 PCM/ADPCM 载体重少了 {feature}，当前：{features:?}"
            );
        }
        for dropped in DROPPED_FORMATS {
            assert!(
                !features.iter().any(|f| f == dropped),
                "扩展名表里没有 {dropped} 这种容器，不该再编译它"
            );
        }
    }

    /// 新增扩展名时必须在上面做个决定：要么给它配 feature，要么明确列为不支持。
    #[test]
    fn every_extension_is_accounted_for() {
        for ext in AUDIO_EXTENSIONS {
            let known =
                FEATURE_FOR_EXT.iter().any(|(e, _)| e == ext) || UNSUPPORTED_EXTS.contains(ext);
            assert!(known, "扩展名 {ext} 既没有 feature 映射也没列进不支持名单");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // —— 封面尺寸读取与落盘（合成头部，只测「多大、是不是真图」这条判断）——

    fn fake_png(w: u32, h: u32) -> Vec<u8> {
        // PNG 的签名是 8 字节（0x89 P N G \r \x1a \n 之后还有一个 \r\n 对），
        // IHDR 的宽高因此正好落在偏移 16 / 20。
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0]);
        v
    }

    /// 带一个 APP0 段再跟 SOF2（渐进式）：既验跳过逻辑，也验 SOF 集合。
    fn fake_jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x06];
        v.extend_from_slice(b"JFIF\0\0");
        v.extend_from_slice(&[0xFF, 0xC2, 0x00, 0x0B, 0x08]);
        v.extend_from_slice(&(h as u16).to_be_bytes());
        v.extend_from_slice(&(w as u16).to_be_bytes());
        v.push(0x03);
        v
    }

    fn fake_gif(w: u16, h: u16) -> Vec<u8> {
        let mut v = b"GIF89a".to_vec();
        v.extend_from_slice(&w.to_le_bytes());
        v.extend_from_slice(&h.to_le_bytes());
        v.push(0);
        v
    }

    /// VP8X：画布尺寸是 24bit 小端且写的是「值 - 1」。
    fn fake_webp(w: u32, h: u32) -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        v.extend_from_slice(&[0; 4]);
        v.extend_from_slice(b"WEBPVP8X");
        v.extend_from_slice(&[10, 0, 0, 0, 0, 0, 0, 0]);
        v.extend_from_slice(&[(w - 1) as u8, ((w - 1) >> 8) as u8, 0]);
        v.extend_from_slice(&[(h - 1) as u8, ((h - 1) >> 8) as u8, 0]);
        v
    }

    #[test]
    fn cover_dimensions_come_from_the_header_not_the_byte_count() {
        assert_eq!(
            image_dimensions(&fake_png(1200, 800), "image/png"),
            Some((1200, 800))
        );
        assert_eq!(
            image_dimensions(&fake_jpeg(640, 480), "image/jpeg"),
            Some((640, 480))
        );
        assert_eq!(
            image_dimensions(&fake_gif(200, 100), "image/gif"),
            Some((200, 100))
        );
        assert_eq!(
            image_dimensions(&fake_webp(300, 300), "image/webp"),
            Some((300, 300))
        );
        // 认不出头部与签名对不上都算「读不出」，由调用方决定信不信。
        assert_eq!(image_dimensions(b"not an image at all", "image/png"), None);
        assert_eq!(
            image_dimensions(&fake_png(300, 300)[..12], "image/png"),
            None
        );
    }

    #[test]
    fn tiny_or_mislabeled_covers_are_rejected_by_pixels() {
        // 32px 的占位图按字节看有几百 B，字节闸门放得住它；像素闸门不放。
        assert!(!plausible_cover(&fake_png(32, 32), "image/png"));
        assert!(
            plausible_cover(&fake_png(64, 64), "image/png"),
            "下限本身要放行"
        );
        assert!(
            !plausible_cover(&fake_jpeg(300, 40), "image/jpeg"),
            "任一边过小都不行"
        );
        assert!(plausible_cover(&fake_jpeg(500, 320), "image/jpeg"));
        assert!(plausible_cover(&fake_gif(400, 400), "image/gif"));
        assert!(plausible_cover(&fake_webp(100, 100), "image/webp"));
        // complete.rs 按 URL 后缀猜媒体类型：一句「稍后再试」的 HTML 不能当 jpg 存进封面缓存。
        assert!(!plausible_cover(
            b"<html><body>try later</body></html>",
            "image/jpeg"
        ));
        // 签名对但子格式认不出：放行，别把用户本来有的封面变成没有。
        let mut odd = b"RIFF".to_vec();
        odd.extend_from_slice(&[0; 4]);
        odd.extend_from_slice(b"WEBPALPH");
        odd.extend_from_slice(&[0; 16]);
        assert!(plausible_cover(&odd, "image/webp"));
    }

    #[test]
    fn save_cover_writes_atomically_and_leaves_no_orphans() {
        let dir = std::env::temp_dir().join(format!("vmusic-cover-{}", uuid::Uuid::new_v4()));

        // 被拒的尺寸：什么都不落盘。
        assert_eq!(save_cover(&dir, "t0", &fake_png(10, 10), "image/png"), None);
        assert_eq!(
            cover_names(&dir),
            Vec::<String>::new(),
            "拒掉的封面不留文件"
        );

        let name =
            save_cover(&dir, "t1", &fake_png(400, 400), "image/png").expect("合法封面要落盘");
        assert_eq!(
            cover_names(&dir),
            vec!["t1.png".to_string()],
            "只落这一份，不留 .part"
        );
        assert_eq!(name, "t1.png");
        assert_eq!(
            std::fs::read(dir.join("covers").join(&name)).unwrap(),
            fake_png(400, 400)
        );

        // 重打标签换了格式：旧扩展名那份要跟着清掉，否则缓存只增不减。
        save_cover(&dir, "t1", &fake_jpeg(400, 400), "image/jpeg").expect("jpg 落盘");
        assert_eq!(
            cover_names(&dir),
            vec!["t1.jpg".to_string()],
            "旧的 png 该被删掉"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// covers/ 里的文件名，排序后返回（目录不存在时给空表）。两阶段写的验收点是
    /// 「目录里既没有多余 `.part` 残留，也没有上一轮的孤儿」——逐个数比只查
    /// 目标文件存在要严：残留和孤儿都是「现在没症状、以后占盘又被人读到」的东西。
    fn cover_names(dir: &Path) -> Vec<String> {
        let mut out = match std::fs::read_dir(dir.join("covers")) {
            Ok(entries) => entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        out.sort();
        out
    }

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

    // —— 扫描根目录的本地性（网络位置一律拒绝）——

    /// 网络根要在遍历开始前就拒掉，且拒得像个错误而不是像「扫到 0 首」：调用方按
    /// `error_count > 0` 跳过清理，把 0 首当成证据就会把整个曲库删空。
    #[cfg(windows)]
    #[test]
    fn network_scan_roots_are_refused_before_the_walk() {
        for root in [
            r"\\nas\music",
            r"\\nas\music\2024",
            r"\\192.168.1.10\share",
            "//nas/music",
            r"\\nas/music",
            r"\\?\UNC\nas\music",
        ] {
            let root = Path::new(root);
            let report = collect_audio_files_checked(root, &AtomicBool::new(false));
            assert!(
                report.files.is_empty(),
                "网络根 {root:?} 一步都不许遍历：{:?}",
                report.files
            );
            assert_eq!(report.error_count, 1, "网络根 {root:?} 要留下一条错误");
            assert_eq!(report.errors[0].0, root);
            assert!(
                report.errors[0].1.contains("不支持网络位置，请先映射成本地盘符或复制到本地"),
                "错误消息要给出路，当前：{}",
                report.errors[0].1
            );
        }
    }

    /// 盘符、映射盘、根目录相对路径都不是网络位置。这一半和上面那一半一样重要：
    /// 拒绝消息让用户「映射成本地盘符」，闸门要是顺手把映射盘也毙了，就是自己把
    /// 唯一的出路堵死。
    #[cfg(windows)]
    #[test]
    fn drive_letter_and_local_roots_stay_allowed() {
        for root in [
            r"D:\music",
            r"C:\Users\me\Music",
            r"Z:\Music on NAS",
            r"\\?\D:\music",
            r"\Music",
            "music/2024",
        ] {
            assert!(
                ensure_local_root(Path::new(root)).is_ok(),
                "{root} 是本地路径，不该被拒"
            );
        }
    }

    /// `//server/share` 在 Unix 上是合法本地路径（`\\nas\music` 只是名字奇怪的目录）。
    /// 这条断言必须与上面那条 Windows 断言反向存在 —— 少了它，跨平台的实现就会被
    /// 一句无条件 `starts_with("//")` 悄悄改成「拒掉用户家目录里的正常路径」。
    #[cfg(not(windows))]
    #[test]
    fn double_slash_is_an_ordinary_local_path_off_windows() {
        for root in ["//nas/music", r"\\nas\music", "/music", "music/2024"] {
            assert!(
                ensure_local_root(Path::new(root)).is_ok(),
                "{root} 在非 Windows 上不是网络路径"
            );
        }
    }

    // —— 符号链接策略（`follow_links(false)` 是定值，不是默认值）——

    /// Windows 上造符号链接要权限（开发者模式或管理员），拿不到就返回 false 让调用方
    /// 跳过 —— 这条断言在缺权限的机器上不该变成假红，兜底是下面的文本断言。
    fn make_symlink(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            let created = if target.is_dir() {
                std::os::windows::fs::symlink_dir(target, link)
            } else {
                std::os::windows::fs::symlink_file(target, link)
            };
            created.is_ok()
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vmusic-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 只经链接可达的本地曲目就是看不见：这一条钉住 `false` 的代价，改成一边都会红。
    #[test]
    fn tracks_reachable_only_through_a_symlink_stay_out_of_the_library() {
        let base = scratch_dir("walk-base");
        let root = base.join("root");
        let outside = base.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let real = root.join("real.mp3");
        std::fs::write(&real, b"x").unwrap();
        let hidden = outside.join("hidden.mp3");
        std::fs::write(&hidden, b"x").unwrap();
        let hidden_dir = outside.join("album");
        std::fs::create_dir_all(&hidden_dir).unwrap();
        std::fs::write(hidden_dir.join("side.mp3"), b"x").unwrap();

        let made_file_link = make_symlink(&hidden, &root.join("link.mp3"));
        let made_dir_link = make_symlink(&hidden_dir, &root.join("linkdir"));
        if !made_file_link || !made_dir_link {
            eprintln!("本平台造不出符号链接，跳过（改由文本断言兜底）");
            let _ = std::fs::remove_dir_all(&base);
            return;
        }

        let report = collect_audio_files_checked(&root, &AtomicBool::new(false));
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(report.files, vec![real], "曲库里只该有根目录里那份真实文件");
        assert_eq!(report.error_count, 0);
    }

    /// 指向祖先目录的链接不会把遍历变成循环，也不会让同一首歌以两条路径进库两遍。
    #[test]
    fn directory_link_back_to_the_root_neither_loops_duplicates_nor_errors() {
        let base = scratch_dir("walk-cycle");
        let root = base.join("root");
        std::fs::create_dir_all(root.join("album")).unwrap();
        let real = root.join("album").join("real.mp3");
        std::fs::write(&real, b"x").unwrap();
        if !make_symlink(&root, &root.join("album").join("loop")) {
            eprintln!("本平台造不出符号链接，跳过（改由文本断言兜底）");
            let _ = std::fs::remove_dir_all(&base);
            return;
        }

        let report = collect_audio_files_checked(&root, &AtomicBool::new(false));
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(report.files, vec![real], "一份真实文件只该出现一次");
        assert_eq!(report.error_count, 0, "遍历不该停在循环检测的错误上");
        assert!(!report.cancelled);
    }

    /// 上面两条行为断言在没有建链权限的机器上会自己跳过，这一条是唯一的硬兜底：
    /// `follow_links` 的实参必须写在源码里、且必须是 `false`。改成 `true` 或不写
    /// 都没有编译期信号，靠人 review 一行 builder 链迟早漏。
    #[test]
    fn walk_declares_its_symlink_policy_as_a_literal() {
        // 针头用 concat! 拼：写成字面量的话这个文件里就有两处匹配（另一处在本测试里），
        // 谁把调用点改掉断言照样是绿 —— 那条断言只证明它自己存在。
        let declared = concat!(".follow_", "links", "(false)");
        let followed = concat!(".follow_", "links", "(true)");
        let source = include_str!("lib.rs");
        assert_eq!(
            source.matches(declared).count(),
            1,
            "遍历入口应恰好有一处显式的不跟随声明"
        );
        assert_eq!(
            source.matches(followed).count(),
            0,
            "跟随会把根外目录、循环链接与网络目标带进曲库"
        );
    }
}
