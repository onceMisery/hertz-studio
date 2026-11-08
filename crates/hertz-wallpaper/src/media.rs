// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 媒体容器探测（设计 docs/desktop-wallpaper.md §7.1 第一道 / §5.1 / §23）。
//!
//! 「容器真值与解码抽样分开」：本模块用可信解析器从字节本身提取 codec/profile、
//! 编码/显示尺寸、旋转、像素宽高比、时长与帧时间上界——扩展名不参与分派，
//! 一律先读魔数。第二道由 decode_probe 的独立 WebView2 完成真实首帧/seek，
//! PNG 还执行有界的流式像素与 CRC 校验。
//!
//! 有界规则（§6.3）：累计元数据读取 ≤32 MiB、box/元素数量有界、mdat 不入内存；
//! 结构未知、病态时间戳或超限 → 明确 `format_unsupported`，不用平均帧率冒充
//! 上界（C52）。

use std::io::{Read, Seek, SeekFrom};

use serde::Serialize;

/// 稳定错误码复用包合同风格：`format_unsupported` / `probe_budget_exceeded`。
pub type ProbeResult<T> = std::result::Result<T, ProbeError>;

#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct ProbeError {
    pub code: &'static str,
    pub message: String,
}

impl ProbeError {
    fn unsupported(message: impl Into<String>) -> Self {
        Self {
            code: "format_unsupported",
            message: message.into(),
        }
    }
    fn budget(message: impl Into<String>) -> Self {
        Self {
            code: "probe_budget_exceeded",
            message: message.into(),
        }
    }
}

/// 单文件元数据扫描预算（§6.3：累计检查最多 32 MiB 元数据）。
pub const MAX_METADATA_BYTES: u64 = 32 * 1024 * 1024;
const MAX_BOXES: usize = 4096;
const MAX_TRACKS: usize = 32;
const MAX_EBML_DEPTH: usize = 12;
/// Cluster 扫描预算内的最多采样时间戳（VFR 上界用）。
const MAX_FRAME_TIMESTAMPS: usize = 200_000;

/// 探测结果：解码预算与适配计算的真值来源（§8.1 AssetMetadata 的媒体子集）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub container: Container,
    /// 容器内声明的编码格式（avc1/hvc1/vp09/…；图片为 png/webp/gif）。
    pub codec: String,
    /// codec/profile 细节（如 H.264 的 profile_idc/level_idc）。
    pub profile: Option<String>,
    /// 编码像素尺寸（§8.1：解码预算按编码尺寸计，旋转/CSS 不降低它）。
    pub encoded_width: u32,
    pub encoded_height: u32,
    /// 显示尺寸（§7.1：适配用它；来自 tkhd / WebM Video / 图片头）。
    pub display_width: u32,
    pub display_height: u32,
    /// 旋转角度（MP4 tkhd 矩阵；图片来自 EXIF 的职责属导入准备器）。
    pub rotation_degrees: u32,
    /// 像素宽高比（§7.1：显示尺寸按它换算；无信号时为 1）。
    pub pixel_aspect_ratio: f64,
    pub duration_ms: Option<u64>,
    /// CFR 源帧率（§7.1：仅当所有采样间隔一致）。
    pub source_fps: Option<f64>,
    /// VFR 帧率上界（§11.1：无法得出上界的变体不具备资格）。
    pub fps_upper_bound: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Container {
    Mp4,
    Webm,
    Image,
}

/// 魔数分派入口（§7.1：不靠文件名选择 decoder）。
pub fn probe<R: Read + Seek>(reader: &mut R) -> ProbeResult<MediaProbe> {
    let mut magic = [0u8; 16];
    let read = reader
        .read(&mut magic)
        .map_err(|error| ProbeError::unsupported(format!("读取魔数失败：{error}")))?;
    if read < 12 {
        return Err(ProbeError::unsupported("文件过短，不构成受支持媒体"));
    }
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| ProbeError::unsupported(format!("回卷失败：{error}")))?;
    if magic[4..8] == *b"ftyp" {
        return mp4::probe(reader);
    }
    if magic[0..4] == [0x1A, 0x45, 0xDF, 0xA3] {
        return webm::probe(reader);
    }
    if magic[..2] == [0xff, 0xd8] {
        return image::probe_jpeg(reader);
    }
    if magic[0..8] == [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A] {
        return image::probe_png(reader);
    }
    if magic[0..4] == *b"RIFF" && magic[8..12] == *b"WEBP" {
        return image::probe_webp(reader);
    }
    if magic[0..3] == *b"GIF" {
        return image::probe_gif(reader);
    }
    Err(ProbeError::unsupported(
        "未知容器魔数；扩展名不作为可播声明",
    ))
}

/// 有界读取统计：任何解析路径共享同一份元数据预算。
pub(crate) struct Budget {
    remaining: u64,
}

impl Budget {
    pub(crate) fn new() -> Self {
        Self {
            remaining: MAX_METADATA_BYTES,
        }
    }

    pub(crate) fn charge(&mut self, bytes: u64) -> ProbeResult<()> {
        self.remaining = self.remaining.saturating_sub(bytes);
        if self.remaining == 0 {
            return Err(ProbeError::budget(format!(
                "元数据扫描超过 {MAX_METADATA_BYTES} 字节预算"
            )));
        }
        Ok(())
    }
}

pub(crate) fn fps_from_delta(timescale: u32, delta: u32) -> Option<f64> {
    if timescale == 0 || delta == 0 {
        return None;
    }
    Some(f64::from(timescale) / f64::from(delta))
}

pub(crate) fn sane_dimensions(width: u32, height: u32) -> ProbeResult<()> {
    if width == 0 || height == 0 {
        return Err(ProbeError::unsupported("尺寸为 0，疑似损坏媒体"));
    }
    // §6.3 图片单边 16384；视频编码尺寸同尺度封顶（解码预算 sanity）。
    const MAX_SIDE: u32 = 16384;
    if width > MAX_SIDE || height > MAX_SIDE {
        return Err(ProbeError::unsupported(format!(
            "编码尺寸 {width}×{height} 超过单边 {MAX_SIDE} 上限"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// MP4 / ISO-BMFF
// ---------------------------------------------------------------------------

pub(crate) mod mp4 {
    use super::*;

    struct BoxHeader {
        kind: [u8; 4],
        /// header 之后的负载起点。
        payload_start: u64,
        /// 负载结束（含子 box）。
        end: u64,
    }

    fn read_box_header<R: Read + Seek>(
        reader: &mut R,
        budget: &mut Budget,
        depth: usize,
    ) -> ProbeResult<Option<BoxHeader>> {
        if depth > 8 {
            return Err(ProbeError::unsupported("box 嵌套深度超限"));
        }
        let start = reader
            .stream_position()
            .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
        let mut header = [0u8; 8];
        match reader.read(&mut header) {
            Ok(0) => return Ok(None),
            Ok(8) => {}
            Ok(_) => return Ok(None), // 截断尾部：按结束处理
            Err(error) => return Err(ProbeError::unsupported(format!("box 头读取失败：{error}"))),
        }
        budget.charge(8)?;
        let size32 = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let mut kind = [0u8; 4];
        kind.copy_from_slice(&header[4..8]);
        // size 是从 box 起点开始的长度（ISO-BMFF），end 必须按起点换算。
        let (payload_start, end) = if size32 == 1 {
            let mut large = [0u8; 8];
            reader
                .read_exact(&mut large)
                .map_err(|_| ProbeError::unsupported("largesize 截断"))?;
            budget.charge(8)?;
            let size = u64::from_be_bytes(large);
            if size < 16 {
                return Err(ProbeError::unsupported("largesize 非法"));
            }
            (start + 16, start + size)
        } else if size32 == 0 {
            // 到文件尾。
            let here = start + 8;
            let len = reader
                .seek(SeekFrom::End(0))
                .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
            reader
                .seek(SeekFrom::Start(here))
                .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
            (here, len.max(here))
        } else if size32 < 8 {
            return Err(ProbeError::unsupported("box size 非法"));
        } else {
            (start + 8, start + size32)
        };
        Ok(Some(BoxHeader {
            kind,
            payload_start,
            end,
        }))
    }

    fn read_exact_n<R: Read + Seek>(
        reader: &mut R,
        len: usize,
        budget: &mut Budget,
        what: &str,
    ) -> ProbeResult<Vec<u8>> {
        let mut bytes = vec![0u8; len];
        reader
            .read_exact(&mut bytes)
            .map_err(|_| ProbeError::unsupported(format!("{what} 截断")))?;
        budget.charge(len as u64)?;
        Ok(bytes)
    }

    pub(super) fn probe<R: Read + Seek>(reader: &mut R) -> ProbeResult<MediaProbe> {
        let mut budget = Budget::new();
        let mut mvhd: Option<(u32, u64)> = None; // (timescale, duration)
        let mut video = VideoTrackFacts::default();
        let mut top_level = 0usize;

        while let Some(header) = read_box_header(reader, &mut budget, 0)? {
            top_level += 1;
            if top_level > MAX_BOXES {
                return Err(ProbeError::budget(format!("顶层 box 数超限：{top_level}")));
            }
            match &header.kind {
                b"ftyp" => {
                    let payload_len = (header.end - header.payload_start).min(64) as usize;
                    let payload = read_exact_n(reader, payload_len, &mut budget, "ftyp")?;
                    // 主 brand 必须是 mp 家族（isom/mp42/mp41/msnv 等）——只作
                    // 记录，解码能力以 stsd codec 为准。
                    if payload.len() < 4 {
                        return Err(ProbeError::unsupported("ftyp 截断"));
                    }
                    reader
                        .seek(SeekFrom::Start(header.end))
                        .map_err(|error| ProbeError::unsupported(format!("跳转失败：{error}")))?;
                }
                b"mdat" | b"free" | b"skip" | b"wide" | b"sidx" => {
                    // 不读媒体负载（§7.1：mdat 不入内存）。
                    reader
                        .seek(SeekFrom::Start(header.end))
                        .map_err(|error| ProbeError::unsupported(format!("跳转失败：{error}")))?;
                }
                b"moov" => {
                    // tail moov 天然支持：顶层顺序遍历到它即可（§7.1）。
                    parse_moov(reader, &header, &mut budget, &mut mvhd, &mut video)?;
                    reader
                        .seek(SeekFrom::Start(header.end))
                        .map_err(|error| ProbeError::unsupported(format!("跳转失败：{error}")))?;
                }
                _ => {
                    reader
                        .seek(SeekFrom::Start(header.end))
                        .map_err(|error| ProbeError::unsupported(format!("跳转失败：{error}")))?;
                }
            }
        }
        video.finish(&mvhd)
    }

    fn parse_moov<R: Read + Seek>(
        reader: &mut R,
        header: &BoxHeader,
        budget: &mut Budget,
        mvhd: &mut Option<(u32, u64)>,
        video: &mut VideoTrackFacts,
    ) -> ProbeResult<()> {
        let mut offset = header.payload_start;
        while offset + 8 <= header.end {
            reader
                .seek(SeekFrom::Start(offset))
                .map_err(|error| ProbeError::unsupported(format!("moov 遍历失败：{error}")))?;
            let Some(child) = read_box_header(reader, budget, 1)? else {
                break;
            };
            match &child.kind {
                b"mvhd" => {
                    let payload_len = (child.end - child.payload_start).min(32) as usize;
                    let payload = read_exact_n(reader, payload_len, budget, "mvhd")?;
                    if payload.len() >= 20 {
                        let (timescale, duration) = if payload[0] == 1 {
                            (
                                u32::from_be_bytes(payload[20..24].try_into().unwrap()),
                                u64::from_be_bytes(payload[24..32].try_into().unwrap()),
                            )
                        } else {
                            (
                                u32::from_be_bytes(payload[12..16].try_into().unwrap()),
                                u64::from(u32::from_be_bytes(payload[16..20].try_into().unwrap())),
                            )
                        };
                        *mvhd = Some((timescale, duration));
                    }
                }
                b"trak" if video.parsed_tracks < MAX_TRACKS => {
                    parse_trak(reader, &child, budget, video)?;
                    video.parsed_tracks += 1;
                }
                b"trak" => {}
                _ => {}
            }
            offset = child.end;
        }
        Ok(())
    }

    fn parse_trak<R: Read + Seek>(
        reader: &mut R,
        trak: &BoxHeader,
        budget: &mut Budget,
        video: &mut VideoTrackFacts,
    ) -> ProbeResult<()> {
        // trak 下的直接子层：tkhd / mdia。深度优先但只关心这两条路径。
        let mut stack: Vec<(u64, u64, usize)> = vec![(trak.payload_start, trak.end, 1)];
        let mut mdhd: Option<(u32, u64)> = None;
        let mut is_video_track = false;
        while let Some((start, end, depth)) = stack.pop() {
            if depth > 6 {
                continue;
            }
            let mut offset = start;
            while offset + 8 <= end {
                reader
                    .seek(SeekFrom::Start(offset))
                    .map_err(|error| ProbeError::unsupported(format!("trak 遍历失败：{error}")))?;
                let Some(child) = read_box_header(reader, budget, depth)? else {
                    break;
                };
                match &child.kind {
                    b"tkhd" => {
                        let payload_len = (child.end - child.payload_start).min(96) as usize;
                        let payload = read_exact_n(reader, payload_len, budget, "tkhd")?;
                        if let Some((width, height, rotation)) = parse_tkhd(&payload) {
                            video.display_width = width;
                            video.display_height = height;
                            video.rotation_degrees = rotation;
                        }
                    }
                    b"mdia" => stack.push((child.payload_start, child.end, depth + 1)),
                    b"hdlr" => {
                        let payload_len = (child.end - child.payload_start).min(24) as usize;
                        let payload = read_exact_n(reader, payload_len, budget, "hdlr")?;
                        // hdlr: version/flags(4) + pre_defined(4) + handler_type(4)
                        if payload.len() >= 12 && &payload[8..12] == b"vide" {
                            is_video_track = true;
                        }
                    }
                    b"mdhd" => {
                        let payload_len = (child.end - child.payload_start).min(28) as usize;
                        let payload = read_exact_n(reader, payload_len, budget, "mdhd")?;
                        if payload.len() >= 20 {
                            let (timescale, duration) = if payload[0] == 1 {
                                (
                                    u32::from_be_bytes(payload[20..24].try_into().unwrap()),
                                    u64::from_be_bytes(payload[24..32].try_into().unwrap()),
                                )
                            } else {
                                (
                                    u32::from_be_bytes(payload[12..16].try_into().unwrap()),
                                    u64::from(u32::from_be_bytes(
                                        payload[16..20].try_into().unwrap(),
                                    )),
                                )
                            };
                            mdhd = Some((timescale, duration));
                        }
                    }
                    b"minf" => stack.push((child.payload_start, child.end, depth + 1)),
                    b"stbl" => stack.push((child.payload_start, child.end, depth + 1)),
                    b"stsd" => {
                        parse_stsd(reader, &child, budget, video)?;
                    }
                    b"stts" => {
                        let len = (child.end - child.payload_start) as usize;
                        if len <= 64 * 1024 * 1024 {
                            let payload =
                                read_exact_n(reader, len.min(1024 * 1024), budget, "stts")?;
                            if let Some(facts) = parse_stts(&payload)? {
                                video.stts = Some(facts);
                            }
                        }
                    }
                    b"stss" => {
                        video.has_sync_samples = true;
                    }
                    b"pasp" => {
                        let payload_len = (child.end - child.payload_start).min(8) as usize;
                        let payload = read_exact_n(reader, payload_len, budget, "pasp")?;
                        if payload.len() >= 8 {
                            let h = u32::from_be_bytes(payload[0..4].try_into().unwrap());
                            let v = u32::from_be_bytes(payload[4..8].try_into().unwrap());
                            if h > 0 && v > 0 {
                                video.pixel_aspect_ratio = f64::from(h) / f64::from(v);
                            }
                        }
                    }
                    _ => {}
                }
                offset = child.end;
            }
        }
        if is_video_track {
            video.video_mdhd = mdhd;
            video.confirmed_video = true;
        }
        Ok(())
    }

    /// tkhd：返回 (显示宽, 显示高, 旋转角度)。
    fn parse_tkhd(payload: &[u8]) -> Option<(u32, u32, u32)> {
        // version(1)+flags(3) [+ creation/modification 8(v0)/16(v1)] + track_id 等
        // 宽高固定位于体末尾 8 字节；矩阵在其前 36 字节。
        if payload.len() < 4 {
            return None;
        }
        let version = payload[0];
        let body = match version {
            0 if payload.len() >= 84 => &payload[4..],
            1 if payload.len() >= 96 => &payload[4..],
            _ => return None,
        };
        // 体结构：… + matrix(36) + width(4) + height(4)；
        // 矩阵起始 = 体尾 - 44。
        if body.len() < 44 {
            return None;
        }
        let matrix_start = body.len() - 44;
        let width_fixed =
            u32::from_be_bytes(body[matrix_start - 8..matrix_start - 4].try_into().unwrap());
        let height_fixed =
            u32::from_be_bytes(body[matrix_start - 4..matrix_start].try_into().unwrap());
        // 矩阵：a b u | c d v | tx ty w（16.16 定点；u/v/w 为 2.30）。
        let a = i32::from_be_bytes(body[matrix_start..matrix_start + 4].try_into().unwrap());
        let b = i32::from_be_bytes(body[matrix_start + 4..matrix_start + 8].try_into().unwrap());
        let degrees = match (a, b) {
            (a, b) if a > 0 && b == 0 => 0,
            (0, b) if b > 0 => 90,
            (a, b) if a < 0 && b == 0 => 180,
            (0, b) if b < 0 => 270,
            _ => 0, // 任意旋转按 0 报告并保留矩阵事实于未来 P2
        };
        Some((width_fixed >> 16, height_fixed >> 16, degrees))
    }

    /// stsd：取首个视频样本项的编码尺寸/codec/profile/pasp。
    fn parse_stsd<R: Read + Seek>(
        reader: &mut R,
        stsd: &BoxHeader,
        budget: &mut Budget,
        video: &mut VideoTrackFacts,
    ) -> ProbeResult<()> {
        let head = read_exact_n(reader, 8, budget, "stsd")?;
        let entry_count = u32::from_be_bytes(head[4..8].try_into().unwrap());
        let mut offset = stsd.payload_start + 8;
        for _ in 0..entry_count.min(64) {
            if offset + 8 > stsd.end {
                break;
            }
            reader
                .seek(SeekFrom::Start(offset))
                .map_err(|error| ProbeError::unsupported(format!("stsd 遍历失败：{error}")))?;
            let Some(entry) = read_box_header(reader, budget, 2)? else {
                break;
            };
            // 样本项：8 头 + 6 reserved + 2 index + 16 predefined/reserved
            // + 2 width + 2 height + …（78 字节固定前缀）。
            let fixed = read_exact_n(reader, 78, budget, "样本项")?;
            let encoded_width = u16::from_be_bytes(fixed[24..26].try_into().unwrap()) as u32;
            let encoded_height = u16::from_be_bytes(fixed[26..28].try_into().unwrap()) as u32;
            if is_video_codec(&entry.kind) {
                video.codec = String::from_utf8_lossy(&entry.kind).to_string();
                video.encoded_width = encoded_width;
                video.encoded_height = encoded_height;
                video.found_codec = true;
                // 子 box：avcC（profile/level）、pasp。
                let child_end = entry.end;
                let mut child_offset = entry.payload_start + 78;
                while child_offset + 8 <= child_end {
                    reader
                        .seek(SeekFrom::Start(child_offset))
                        .map_err(|error| {
                            ProbeError::unsupported(format!("样本项遍历失败：{error}"))
                        })?;
                    let Some(child) = read_box_header(reader, budget, 3)? else {
                        break;
                    };
                    match &child.kind {
                        b"avcC" => {
                            let payload_len = (child.end - child.payload_start).min(32) as usize;
                            let payload = read_exact_n(reader, payload_len, budget, "avcC")?;
                            if payload.len() >= 4 {
                                video.profile =
                                    Some(format!("profile-{}-level-{}", payload[1], payload[3]));
                            }
                        }
                        b"pasp" => {
                            let payload_len = (child.end - child.payload_start).min(8) as usize;
                            let payload = read_exact_n(reader, payload_len, budget, "pasp")?;
                            if payload.len() >= 8 {
                                let h = u32::from_be_bytes(payload[0..4].try_into().unwrap());
                                let v = u32::from_be_bytes(payload[4..8].try_into().unwrap());
                                if h > 0 && v > 0 {
                                    video.pixel_aspect_ratio = f64::from(h) / f64::from(v);
                                }
                            }
                        }
                        _ => {}
                    }
                    child_offset = child.end;
                }
                break; // 只取首个视频样本项
            }
            offset = entry.end;
        }
        Ok(())
    }

    fn parse_stts(payload: &[u8]) -> ProbeResult<Option<SttsFacts>> {
        if payload.len() < 8 {
            return Ok(None);
        }
        let entry_count = u32::from_be_bytes(payload[4..8].try_into().unwrap()) as usize;
        let mut entries: Vec<(u32, u32)> = Vec::with_capacity(entry_count.min(1024));
        let available = (payload.len() - 8) / 8;
        let count = entry_count.min(available);
        for index in 0..count {
            let base = 8 + index * 8;
            let sample_count = u32::from_be_bytes(payload[base..base + 4].try_into().unwrap());
            let sample_delta = u32::from_be_bytes(payload[base + 4..base + 8].try_into().unwrap());
            entries.push((sample_count, sample_delta));
        }
        if entries.is_empty() {
            return Ok(None);
        }
        // 病态时间戳：delta 0 或全零计数 → 明确拒绝（C52：不给假上界）。
        if entries
            .iter()
            .any(|(count, delta)| *count == 0 || *delta == 0)
        {
            return Err(ProbeError::unsupported(
                "stts 存在零计数/零间隔的病态时间戳",
            ));
        }
        let total_samples: u64 = entries.iter().map(|(count, _)| u64::from(*count)).sum();
        if total_samples == 0 {
            return Ok(None);
        }
        if entries.len() == 1 {
            return Ok(Some(SttsFacts {
                cfr: true,
                min_delta: entries[0].1,
            }));
        }
        let min_delta = entries.iter().map(|(_, delta)| *delta).min().unwrap();
        Ok(Some(SttsFacts {
            cfr: false,
            min_delta,
        }))
    }

    #[derive(Debug, Clone, Copy)]
    struct SttsFacts {
        cfr: bool,
        min_delta: u32,
    }

    #[derive(Default)]
    struct VideoTrackFacts {
        parsed_tracks: usize,
        confirmed_video: bool,
        found_codec: bool,
        codec: String,
        profile: Option<String>,
        encoded_width: u32,
        encoded_height: u32,
        display_width: u32,
        display_height: u32,
        rotation_degrees: u32,
        pixel_aspect_ratio: f64,
        has_sync_samples: bool,
        stts: Option<SttsFacts>,
        video_mdhd: Option<(u32, u64)>,
    }

    impl VideoTrackFacts {
        fn finish(self, mvhd: &Option<(u32, u64)>) -> ProbeResult<MediaProbe> {
            if !self.confirmed_video && !self.found_codec {
                return Err(ProbeError::unsupported(
                    "未找到视频轨（音频轨不能冒充壁纸）",
                ));
            }
            sane_dimensions(self.encoded_width, self.encoded_height)?;
            let (duration_ms, source_fps, fps_upper_bound) = match self.stts {
                Some(facts) => {
                    // 优先用媒体轨自己的 timescale/duration；mvhd 兜底。
                    let (timescale, duration) = match self.video_mdhd {
                        Some((scale, duration)) if scale > 0 => (scale, duration),
                        _ => mvhd.unwrap_or((0, 0)),
                    };
                    let duration_ms = if timescale > 0 {
                        Some(duration.saturating_mul(1000) / u64::from(timescale))
                    } else {
                        None
                    };
                    if facts.cfr {
                        (
                            duration_ms,
                            fps_from_delta(
                                self.video_mdhd
                                    .map_or(mvhd.map_or(0, |(scale, _)| scale), |(scale, _)| scale),
                                facts.min_delta,
                            ),
                            None,
                        )
                    } else {
                        (
                            duration_ms,
                            None,
                            fps_from_delta(
                                self.video_mdhd
                                    .map_or(mvhd.map_or(0, |(scale, _)| scale), |(scale, _)| scale),
                                facts.min_delta,
                            ),
                        )
                    }
                }
                None => {
                    let (timescale, duration) = mvhd.unwrap_or((0, 0));
                    let duration_ms = if timescale > 0 {
                        Some(duration.saturating_mul(1000) / u64::from(timescale))
                    } else {
                        None
                    };
                    (duration_ms, None, None)
                }
            };
            // 无可靠帧时间（无 stts）→ fpsUpperBound 缺失：变体资格由上层拒绝。
            Ok(MediaProbe {
                container: Container::Mp4,
                codec: self.codec,
                profile: self.profile,
                encoded_width: self.encoded_width,
                encoded_height: self.encoded_height,
                display_width: if self.display_width == 0 {
                    self.encoded_width
                } else {
                    self.display_width
                },
                display_height: if self.display_height == 0 {
                    self.encoded_height
                } else {
                    self.display_height
                },
                rotation_degrees: self.rotation_degrees,
                pixel_aspect_ratio: if self.pixel_aspect_ratio > 0.0 {
                    self.pixel_aspect_ratio
                } else {
                    1.0
                },
                duration_ms,
                source_fps,
                fps_upper_bound,
            })
        }
    }

    fn is_video_codec(kind: &[u8; 4]) -> bool {
        matches!(
            kind,
            b"avc1"
                | b"avc2"
                | b"avc3"
                | b"avc4"
                | b"hvc1"
                | b"hev1"
                | b"vp08"
                | b"vp09"
                | b"av01"
                | b"mp4v"
                | b"encv"
        )
    }
}

// ---------------------------------------------------------------------------
// WebM / Matroska（EBML）
// ---------------------------------------------------------------------------

pub(crate) mod webm {
    use super::*;

    pub(super) fn probe<R: Read + Seek>(reader: &mut R) -> ProbeResult<MediaProbe> {
        let mut budget = Budget::new();
        let mut facts = WebmFacts::default();
        let file_len = reader
            .seek(SeekFrom::End(0))
            .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
        reader
            .seek(SeekFrom::Start(0))
            .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
        parse_element(reader, file_len, 0, &mut budget, &mut facts)?;
        facts.finish()
    }

    #[derive(Default)]
    struct WebmFacts {
        codec: Option<String>,
        encoded_width: u32,
        encoded_height: u32,
        timestamp_scale_ns: u64,
        duration_ns: Option<u64>,
        /// 采样到的帧绝对时间（ns），用于最小间隔 → fpsUpperBound。
        frame_times: Vec<u64>,
    }

    impl WebmFacts {
        fn finish(self) -> ProbeResult<MediaProbe> {
            let codec = self
                .codec
                .ok_or_else(|| ProbeError::unsupported("WebM 缺少视频 CodecID 或轨类型不是视频"))?;
            sane_dimensions(self.encoded_width, self.encoded_height)?;
            let duration_ms = self.duration_ns.map(|ns| ns / 1_000_000).or_else(|| {
                // 时长缺失：用最大帧时间近似（仅作显示参考，不作准入上界）。
                self.frame_times.last().map(|last| last / 1_000_000)
            });
            // VFR 上界：最小正间隔（ns→fps）。§7.1：不把总时长平均当上界。
            let mut min_delta_ns: Option<u64> = None;
            for pair in self.frame_times.windows(2) {
                if pair[1] > pair[0] {
                    let delta = pair[1] - pair[0];
                    if delta > 0 && min_delta_ns.is_none_or(|current| delta < current) {
                        min_delta_ns = Some(delta);
                    }
                }
            }
            let fps_upper_bound = min_delta_ns.map(|delta_ns| 1_000_000_000f64 / delta_ns as f64);
            Ok(MediaProbe {
                container: Container::Webm,
                codec,
                profile: None,
                encoded_width: self.encoded_width,
                encoded_height: self.encoded_height,
                display_width: self.encoded_width,
                display_height: self.encoded_height,
                rotation_degrees: 0,
                pixel_aspect_ratio: 1.0,
                duration_ms,
                source_fps: None,
                fps_upper_bound: fps_upper_bound.filter(|fps| fps.is_finite() && *fps > 0.0),
            })
        }
    }

    /// 读一个 EBML vint（ID 或尺寸）。`keep_marker=false` 时清掉首位标记位。
    fn read_vint<R: Read + Seek>(
        reader: &mut R,
        id: bool,
        budget: &mut Budget,
    ) -> ProbeResult<Option<u64>> {
        let mut first = [0u8; 1];
        match reader.read(&mut first) {
            Ok(0) => return Ok(None),
            Ok(_) => {}
            Err(error) => return Err(ProbeError::unsupported(format!("vint 读取失败：{error}"))),
        }
        budget.charge(1)?;
        let byte = first[0];
        if byte == 0 {
            return Err(ProbeError::unsupported("EBML vint 长度非法"));
        }
        let total = byte.leading_zeros() as usize + 1; // 首字节前导零+1 = 总长
        let mut value = u64::from(byte);
        if id {
            // ID 保留标记位返回（解析端常量即完整 ID）。
            for _ in 1..total {
                let mut next = [0u8; 1];
                reader
                    .read_exact(&mut next)
                    .map_err(|_| ProbeError::unsupported("EBML ID 截断"))?;
                budget.charge(1)?;
                value = (value << 8) | u64::from(next[0]);
            }
            return Ok(Some(value));
        }
        // 掩码指数 = total：total=1 时清 bit7（0x7F），total=2 清 bit6……
        value &= (1u64 << (8 - total as u32)) - 1; // 清标记位
        for _ in 1..total {
            let mut next = [0u8; 1];
            reader
                .read_exact(&mut next)
                .map_err(|_| ProbeError::unsupported("EBML 尺寸截断"))?;
            budget.charge(1)?;
            value = (value << 8) | u64::from(next[0]);
        }
        Ok(Some(value))
    }

    #[allow(clippy::too_many_arguments)]
    fn parse_element<R: Read + Seek>(
        reader: &mut R,
        parent_end: u64,
        depth: usize,
        budget: &mut Budget,
        facts: &mut WebmFacts,
    ) -> ProbeResult<()> {
        if depth > MAX_EBML_DEPTH {
            return Err(ProbeError::unsupported("EBML 嵌套深度超限"));
        }
        loop {
            let position = reader
                .stream_position()
                .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
            if position >= parent_end {
                return Ok(());
            }
            let Some(id) = read_vint(reader, true, budget)? else {
                return Ok(());
            };
            let Some(size) = read_vint(reader, false, budget)? else {
                return Ok(());
            };
            let payload_start = reader
                .stream_position()
                .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
            // 未知尺寸（全 1）：按父层剩余量处理，继续受限扫描。
            let element_end = if size == u64::MAX {
                parent_end
            } else {
                payload_start
                    .checked_add(size)
                    .ok_or_else(|| ProbeError::unsupported("EBML 尺寸溢出"))?
                    .min(parent_end)
            };
            match id {
                // EBML header
                0x1A_45_DF_A3 => {
                    parse_element(reader, element_end, depth + 1, budget, facts)?;
                }
                // Segment
                0x18_53_80_67 => {
                    parse_element(reader, element_end, depth + 1, budget, facts)?;
                }
                // Info
                0x15_49_A9_66 => {
                    parse_info(reader, element_end, budget, facts)?;
                }
                // Tracks
                0x16_54_AE_6B => {
                    parse_tracks(reader, element_end, budget, facts)?;
                }
                // Cluster
                0x1F_43_B6_75 => {
                    if facts.frame_times.len() < MAX_FRAME_TIMESTAMPS {
                        parse_cluster(reader, element_end, budget, facts)?;
                    } else {
                        reader.seek(SeekFrom::Start(element_end)).map_err(|error| {
                            ProbeError::unsupported(format!("跳转失败：{error}"))
                        })?;
                    }
                }
                _ => {
                    reader
                        .seek(SeekFrom::Start(element_end))
                        .map_err(|error| ProbeError::unsupported(format!("跳转失败：{error}")))?;
                }
            }
        }
    }

    fn read_uint_payload<R: Read + Seek>(
        reader: &mut R,
        len: usize,
        budget: &mut Budget,
    ) -> ProbeResult<u64> {
        if len == 0 || len > 8 {
            return Err(ProbeError::unsupported("EBML uint 宽度非法"));
        }
        let mut bytes = vec![0u8; len];
        reader
            .read_exact(&mut bytes)
            .map_err(|_| ProbeError::unsupported("EBML uint 截断"))?;
        budget.charge(len as u64)?;
        let mut value = 0u64;
        for byte in bytes {
            value = (value << 8) | u64::from(byte);
        }
        Ok(value)
    }

    fn read_float_payload<R: Read + Seek>(
        reader: &mut R,
        len: usize,
        budget: &mut Budget,
    ) -> ProbeResult<f64> {
        match len {
            0 => Ok(0.0),
            4 => {
                let mut bytes = [0u8; 4];
                reader
                    .read_exact(&mut bytes)
                    .map_err(|_| ProbeError::unsupported("EBML float 截断"))?;
                budget.charge(4)?;
                Ok(f32::from_be_bytes(bytes) as f64)
            }
            8 => {
                let mut bytes = [0u8; 8];
                reader
                    .read_exact(&mut bytes)
                    .map_err(|_| ProbeError::unsupported("EBML float 截断"))?;
                budget.charge(8)?;
                Ok(f64::from_be_bytes(bytes))
            }
            _ => Err(ProbeError::unsupported("EBML float 宽度非法")),
        }
    }

    fn parse_info<R: Read + Seek>(
        reader: &mut R,
        end: u64,
        budget: &mut Budget,
        facts: &mut WebmFacts,
    ) -> ProbeResult<()> {
        loop {
            let position = reader
                .stream_position()
                .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
            if position >= end {
                return Ok(());
            }
            let Some(id) = read_vint(reader, true, budget)? else {
                return Ok(());
            };
            let Some(size) = read_vint(reader, false, budget)? else {
                return Ok(());
            };
            match id {
                // TimestampScale
                0x2A_D7_B1 => {
                    facts.timestamp_scale_ns = read_uint_payload(reader, size as usize, budget)?;
                }
                // Duration（float）
                0x44_89 => {
                    let seconds = read_float_payload(reader, size as usize, budget)?;
                    let scale = if facts.timestamp_scale_ns > 0 {
                        facts.timestamp_scale_ns
                    } else {
                        1_000_000
                    };
                    facts.duration_ns = Some((seconds * scale as f64) as u64);
                }
                _ => {
                    let here = reader
                        .stream_position()
                        .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
                    reader
                        .seek(SeekFrom::Start(here + size))
                        .map_err(|error| ProbeError::unsupported(format!("跳转失败：{error}")))?;
                }
            }
            if size == u64::MAX {
                return Ok(());
            }
        }
    }

    fn parse_tracks<R: Read + Seek>(
        reader: &mut R,
        end: u64,
        budget: &mut Budget,
        facts: &mut WebmFacts,
    ) -> ProbeResult<()> {
        loop {
            let position = reader
                .stream_position()
                .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
            if position >= end {
                return Ok(());
            }
            let Some(id) = read_vint(reader, true, budget)? else {
                return Ok(());
            };
            let Some(size) = read_vint(reader, false, budget)? else {
                return Ok(());
            };
            let payload_start = reader
                .stream_position()
                .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
            let element_end = if size == u64::MAX {
                end
            } else {
                payload_start + size.min(end - payload_start)
            };
            // TrackEntry
            if id == 0xAE {
                parse_track_entry(reader, payload_start, element_end, budget, facts)?;
            }
            if size == u64::MAX {
                return Ok(());
            }
            reader
                .seek(SeekFrom::Start(element_end))
                .map_err(|error| ProbeError::unsupported(format!("跳转失败：{error}")))?;
        }
    }

    fn parse_track_entry<R: Read + Seek>(
        reader: &mut R,
        entry_start: u64,
        entry_end: u64,
        budget: &mut Budget,
        facts: &mut WebmFacts,
    ) -> ProbeResult<()> {
        let mut is_video = false;
        let mut codec: Option<String> = None;
        let mut width = 0u32;
        let mut height = 0u32;
        let mut offset = entry_start;
        while offset < entry_end {
            reader.seek(SeekFrom::Start(offset)).map_err(|error| {
                ProbeError::unsupported(format!("TrackEntry 遍历失败：{error}"))
            })?;
            let Some(id) = read_vint(reader, true, budget)? else {
                break;
            };
            let Some(size) = read_vint(reader, false, budget)? else {
                break;
            };
            let payload_start = reader
                .stream_position()
                .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
            match id {
                // TrackType
                0x83 => {
                    is_video = read_uint_payload(reader, size as usize, budget)? == 1;
                }
                // CodecID
                0x86 => {
                    let mut bytes = vec![0u8; size.min(64) as usize];
                    reader
                        .read_exact(&mut bytes)
                        .map_err(|_| ProbeError::unsupported("CodecID 截断"))?;
                    budget.charge(bytes.len() as u64)?;
                    codec = Some(String::from_utf8_lossy(&bytes).trim().to_string());
                }
                // Video
                0xE0 => {
                    let video_end = payload_start + size.min(entry_end - payload_start);
                    let mut inner = payload_start;
                    while inner < video_end {
                        reader.seek(SeekFrom::Start(inner)).map_err(|error| {
                            ProbeError::unsupported(format!("Video 遍历失败：{error}"))
                        })?;
                        let Some(child_id) = read_vint(reader, true, budget)? else {
                            break;
                        };
                        let Some(child_size) = read_vint(reader, false, budget)? else {
                            break;
                        };
                        match child_id {
                            // PixelWidth
                            0xB0 => {
                                width =
                                    read_uint_payload(reader, child_size as usize, budget)? as u32
                            }
                            // PixelHeight
                            0xBA => {
                                height =
                                    read_uint_payload(reader, child_size as usize, budget)? as u32
                            }
                            _ => {
                                reader.seek(SeekFrom::Current(child_size as i64)).map_err(
                                    |error| ProbeError::unsupported(format!("跳转失败：{error}")),
                                )?;
                            }
                        }
                        if child_size == u64::MAX {
                            break;
                        }
                        inner = reader.stream_position().map_err(|error| {
                            ProbeError::unsupported(format!("定位失败：{error}"))
                        })?;
                    }
                }
                _ => {
                    reader
                        .seek(SeekFrom::Start(
                            payload_start + size.min(entry_end - payload_start),
                        ))
                        .map_err(|error| ProbeError::unsupported(format!("跳转失败：{error}")))?;
                }
            }
            if size == u64::MAX {
                break;
            }
            offset = reader
                .stream_position()
                .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
            if offset <= entry_start + 1 {
                break;
            }
        }
        if is_video {
            if let Some(codec) = codec {
                facts.codec = Some(codec);
                facts.encoded_width = width;
                facts.encoded_height = height;
            }
        }
        Ok(())
    }

    /// Cluster 受限扫描：Timecode + SimpleBlock 时间戳 → 帧绝对时间样本。
    fn parse_cluster<R: Read + Seek>(
        reader: &mut R,
        end: u64,
        budget: &mut Budget,
        facts: &mut WebmFacts,
    ) -> ProbeResult<()> {
        let mut cluster_time_ns: u64 = 0;
        loop {
            let position = reader
                .stream_position()
                .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
            if position >= end || facts.frame_times.len() >= MAX_FRAME_TIMESTAMPS {
                return Ok(());
            }
            let Some(id) = read_vint(reader, true, budget)? else {
                return Ok(());
            };
            let Some(size) = read_vint(reader, false, budget)? else {
                return Ok(());
            };
            let payload_start = reader
                .stream_position()
                .map_err(|error| ProbeError::unsupported(format!("定位失败：{error}")))?;
            let element_end = if size == u64::MAX {
                end
            } else {
                payload_start + size.min(end - payload_start)
            };
            match id {
                // Timecode
                0xE7 => {
                    let milliseconds = read_uint_payload(reader, size as usize, budget)?;
                    cluster_time_ns = milliseconds * 1_000_000;
                }
                // SimpleBlock
                0xA3 => {
                    let mut header = [0u8; 4];
                    if size >= 4 {
                        reader
                            .read_exact(&mut header)
                            .map_err(|_| ProbeError::unsupported("SimpleBlock 截断"))?;
                        budget.charge(4)?;
                        // block 时间戳 = track vint 之后的 int16 BE；
                        // track vint 长度由首字节标记位决定（1 或 2 字节）。
                        let timecode_offset = if header[0] & 0x80 != 0 { 1 } else { 2 };
                        reader
                            .seek(SeekFrom::Start(payload_start + timecode_offset as u64))
                            .map_err(|error| {
                                ProbeError::unsupported(format!("跳转失败：{error}"))
                            })?;
                        let mut timecode = [0u8; 2];
                        reader
                            .read_exact(&mut timecode)
                            .map_err(|_| ProbeError::unsupported("block 时间戳截断"))?;
                        budget.charge(2)?;
                        let relative = i16::from_be_bytes(timecode);
                        let absolute_ns = (cluster_time_ns as i64 + i64::from(relative) * 1_000_000)
                            .max(0) as u64;
                        facts.frame_times.push(absolute_ns);
                    }
                    reader
                        .seek(SeekFrom::Start(element_end))
                        .map_err(|error| ProbeError::unsupported(format!("跳转失败：{error}")))?;
                }
                _ => {
                    reader
                        .seek(SeekFrom::Start(element_end))
                        .map_err(|error| ProbeError::unsupported(format!("跳转失败：{error}")))?;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 图片：静态/动画判别（§5.1：动画不得混入静态轻后端）
// ---------------------------------------------------------------------------

#[path = "media_images.rs"]
pub(crate) mod image;

#[cfg(test)]
#[path = "media_tests.rs"]
mod tests;
