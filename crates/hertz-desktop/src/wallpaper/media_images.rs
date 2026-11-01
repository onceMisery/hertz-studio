// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 静态图片的有界结构探测。沿真实块边界判别动画，不在压缩数据中搜索标记。
//! 这里只确定结构/尺寸/方向，像素解码及标准化仍由导入准备器负责。

use super::*;

fn read<const N: usize>(reader: &mut impl Read, budget: &mut Budget) -> ProbeResult<[u8; N]> {
    budget.charge(N as u64)?;
    let mut out = [0; N];
    reader
        .read_exact(&mut out)
        .map_err(|_| ProbeError::unsupported("图片结构截断"))?;
    Ok(out)
}

fn seek(reader: &mut impl Seek, offset: u64) -> ProbeResult<()> {
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|error| ProbeError::unsupported(error.to_string()))?;
    Ok(())
}

fn length(reader: &mut impl Seek) -> ProbeResult<u64> {
    reader
        .seek(SeekFrom::End(0))
        .map_err(|error| ProbeError::unsupported(error.to_string()))
}

fn metadata(codec: &str, width: u32, height: u32, rotation: u32) -> ProbeResult<MediaProbe> {
    sane_dimensions(width, height)?;
    let (display_width, display_height) = if matches!(rotation, 90 | 270) {
        (height, width)
    } else {
        (width, height)
    };
    Ok(MediaProbe {
        container: Container::Image,
        codec: codec.into(),
        profile: None,
        encoded_width: width,
        encoded_height: height,
        display_width,
        display_height,
        rotation_degrees: rotation,
        pixel_aspect_ratio: 1.0,
        duration_ms: None,
        source_fps: None,
        fps_upper_bound: None,
    })
}

pub(super) fn probe_png<R: Read + Seek>(reader: &mut R) -> ProbeResult<MediaProbe> {
    let total = length(reader)?;
    seek(reader, 8)?;
    let mut budget = Budget::new();
    let mut offset = 8u64;
    let mut dimensions = None;
    let mut image_data = false;
    for _ in 0..MAX_BOXES {
        let header = read::<8>(reader, &mut budget)?;
        let size = u64::from(u32::from_be_bytes(header[..4].try_into().unwrap()));
        let end = offset
            .checked_add(12)
            .and_then(|value| value.checked_add(size))
            .filter(|end| *end <= total)
            .ok_or_else(|| ProbeError::unsupported("PNG 块越界"))?;
        let kind = &header[4..];
        if dimensions.is_none() && kind != b"IHDR" {
            return Err(ProbeError::unsupported("PNG 首块必须为 IHDR"));
        }
        match kind {
            b"IHDR" if dimensions.is_none() && size == 13 => {
                let data = read::<13>(reader, &mut budget)?;
                let width = u32::from_be_bytes(data[..4].try_into().unwrap());
                let height = u32::from_be_bytes(data[4..8].try_into().unwrap());
                sane_dimensions(width, height)?;
                let depth_valid = match data[9] {
                    0 => matches!(data[8], 1 | 2 | 4 | 8 | 16),
                    2 | 4 | 6 => matches!(data[8], 8 | 16),
                    3 => matches!(data[8], 1 | 2 | 4 | 8),
                    _ => false,
                };
                if !depth_valid || data[10] != 0 || data[11] != 0 || data[12] > 1 {
                    return Err(ProbeError::unsupported("PNG IHDR 编码参数错误"));
                }
                dimensions = Some((width, height));
            }
            b"IHDR" => return Err(ProbeError::unsupported("PNG IHDR 重复或长度错误")),
            b"acTL" | b"fcTL" | b"fdAT" => {
                return Err(ProbeError::unsupported("APNG 不具备静态图片资格"))
            }
            b"IDAT" => image_data = true,
            b"IEND" if size == 0 && image_data && end == total => {
                let (width, height) = dimensions.unwrap();
                return metadata("png", width, height, 0);
            }
            b"IEND" => return Err(ProbeError::unsupported("PNG 缺少图像数据或结束块错误")),
            _ => {}
        }
        seek(reader, end)?;
        offset = end;
    }
    Err(ProbeError::budget("PNG 块数量超限"))
}

pub(super) fn probe_webp<R: Read + Seek>(reader: &mut R) -> ProbeResult<MediaProbe> {
    let total = length(reader)?;
    seek(reader, 0)?;
    let mut budget = Budget::new();
    let header = read::<12>(reader, &mut budget)?;
    if u64::from(u32::from_le_bytes(header[4..8].try_into().unwrap())) + 8 != total {
        return Err(ProbeError::unsupported("WebP RIFF 长度不符"));
    }
    let mut offset = 12u64;
    let mut canvas = None;
    let mut image = None;
    for _ in 0..MAX_BOXES {
        if offset == total {
            let (width, height) =
                image.ok_or_else(|| ProbeError::unsupported("WebP 缺少图像块"))?;
            if canvas.is_some_and(|canvas| canvas != (width, height)) {
                return Err(ProbeError::unsupported("WebP canvas 与编码尺寸不符"));
            }
            return metadata("webp", width, height, 0);
        }
        let header = read::<8>(reader, &mut budget)?;
        let size = u64::from(u32::from_le_bytes(header[4..].try_into().unwrap()));
        let end = offset
            .checked_add(8)
            .and_then(|value| value.checked_add(size + (size & 1)))
            .filter(|end| *end <= total)
            .ok_or_else(|| ProbeError::unsupported("WebP 块越界"))?;
        match &header[..4] {
            b"ANIM" | b"ANMF" => {
                return Err(ProbeError::unsupported("动画 WebP 不具备静态图片资格"))
            }
            b"VP8X" if offset == 12 && size == 10 => {
                let data = read::<10>(reader, &mut budget)?;
                if data[0] & 2 != 0 {
                    return Err(ProbeError::unsupported("动画 WebP 不具备静态图片资格"));
                }
                let width = u32::from_le_bytes([data[4], data[5], data[6], 0]) + 1;
                let height = u32::from_le_bytes([data[7], data[8], data[9], 0]) + 1;
                sane_dimensions(width, height)?;
                canvas = Some((width, height));
            }
            b"VP8X" => return Err(ProbeError::unsupported("WebP 扩展头错误")),
            b"VP8 " if size >= 10 && image.is_none() => {
                let data = read::<10>(reader, &mut budget)?;
                if data[0] & 1 != 0 || data[3..6] != [0x9d, 0x01, 0x2a] {
                    return Err(ProbeError::unsupported("WebP VP8 关键帧头错误"));
                }
                image = Some((
                    u32::from(u16::from_le_bytes([data[6], data[7]]) & 0x3fff),
                    u32::from(u16::from_le_bytes([data[8], data[9]]) & 0x3fff),
                ));
            }
            b"VP8L" if size >= 5 && image.is_none() => {
                let data = read::<5>(reader, &mut budget)?;
                let bits = u32::from_le_bytes(data[1..].try_into().unwrap());
                if data[0] != 0x2f || bits >> 29 != 0 {
                    return Err(ProbeError::unsupported("WebP VP8L 头错误"));
                }
                image = Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
            }
            b"VP8 " | b"VP8L" => return Err(ProbeError::unsupported("WebP 图像块截断或重复")),
            _ => {}
        }
        seek(reader, end)?;
        offset = end;
    }
    Err(ProbeError::budget("WebP 块数量超限"))
}

pub(super) fn probe_jpeg<R: Read + Seek>(reader: &mut R) -> ProbeResult<MediaProbe> {
    let total = length(reader)?;
    seek(reader, 2)?;
    let mut budget = Budget::new();
    let mut dimensions = None;
    let mut orientation = 1;
    for _ in 0..MAX_BOXES {
        if read::<1>(reader, &mut budget)? != [0xff] {
            return Err(ProbeError::unsupported("JPEG marker 错误"));
        }
        let mut kind = read::<1>(reader, &mut budget)?[0];
        while kind == 0xff {
            kind = read::<1>(reader, &mut budget)?[0];
        }
        if matches!(kind, 0 | 0xd8 | 0xd9 | 0xd0..=0xd7) {
            return Err(ProbeError::unsupported("JPEG marker 错序"));
        }
        let size = u16::from_be_bytes(read::<2>(reader, &mut budget)?) as usize;
        let start = reader
            .stream_position()
            .map_err(|error| ProbeError::unsupported(error.to_string()))?;
        let end = start
            .checked_add(size.saturating_sub(2) as u64)
            .filter(|end| size >= 2 && *end <= total)
            .ok_or_else(|| ProbeError::unsupported("JPEG segment 越界"))?;
        match kind {
            0xc0..=0xc2 if size >= 8 && dimensions.is_none() => {
                let data = read::<6>(reader, &mut budget)?;
                if data[0] != 8 || size != 8 + 3 * usize::from(data[5]) || data[5] == 0 {
                    return Err(ProbeError::unsupported("JPEG 精度或 SOF 结构不支持"));
                }
                dimensions = Some((
                    u32::from(u16::from_be_bytes([data[3], data[4]])),
                    u32::from(u16::from_be_bytes([data[1], data[2]])),
                ));
            }
            0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf => {
                return Err(ProbeError::unsupported("JPEG SOF 不支持或重复"))
            }
            0xe1 => {
                budget.charge((size - 2) as u64)?;
                let mut data = vec![0; size - 2];
                reader
                    .read_exact(&mut data)
                    .map_err(|_| ProbeError::unsupported("JPEG APP1 截断"))?;
                if data.starts_with(b"Exif\0\0") {
                    orientation = exif_orientation(&data[6..])?;
                }
            }
            0xda => {
                let (width, height) =
                    dimensions.ok_or_else(|| ProbeError::unsupported("JPEG 缺少 SOF"))?;
                let components = usize::from(read::<1>(reader, &mut budget)?[0]);
                if components == 0 || components > 4 || size != 6 + 2 * components {
                    return Err(ProbeError::unsupported("JPEG SOS 结构不支持"));
                }
                seek(reader, total.saturating_sub(2))?;
                if read::<2>(reader, &mut budget)? != [0xff, 0xd9] {
                    return Err(ProbeError::unsupported("JPEG 缺少 EOI"));
                }
                let rotation = match orientation {
                    1 | 2 => 0,
                    3 | 4 => 180,
                    5 | 6 => 90,
                    7 | 8 => 270,
                    _ => return Err(ProbeError::unsupported("EXIF 方向无效")),
                };
                return metadata("jpeg", width, height, rotation);
            }
            _ => {}
        }
        seek(reader, end)?;
    }
    Err(ProbeError::budget("JPEG segment 数量超限"))
}

fn exif_orientation(data: &[u8]) -> ProbeResult<u16> {
    let invalid = || ProbeError::unsupported("EXIF TIFF 结构错误");
    let little = match data.get(..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return Err(invalid()),
    };
    let u16_at = |offset: usize| -> ProbeResult<u16> {
        let bytes: [u8; 2] = data
            .get(offset..offset + 2)
            .ok_or_else(invalid)?
            .try_into()
            .unwrap();
        Ok(if little {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        })
    };
    let u32_at = |offset: usize| -> ProbeResult<u32> {
        let bytes: [u8; 4] = data
            .get(offset..offset + 4)
            .ok_or_else(invalid)?
            .try_into()
            .unwrap();
        Ok(if little {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        })
    };
    if u16_at(2)? != 42 {
        return Err(invalid());
    }
    let base = u32_at(4)? as usize;
    let count = usize::from(u16_at(base)?);
    if base < 8 || count > 512 || data.get(base + 2..base + 2 + count * 12 + 4).is_none() {
        return Err(invalid());
    }
    for index in 0..count {
        let offset = base + 2 + index * 12;
        if u16_at(offset)? == 0x112 {
            if u16_at(offset + 2)? != 3 || u32_at(offset + 4)? != 1 {
                return Err(invalid());
            }
            let orientation = u16_at(offset + 8)?;
            return if (1..=8).contains(&orientation) {
                Ok(orientation)
            } else {
                Err(invalid())
            };
        }
    }
    Ok(1)
}

pub(super) fn probe_gif<R: Read + Seek>(_: &mut R) -> ProbeResult<MediaProbe> {
    Err(ProbeError::unsupported(
        "GIF 不在壁纸 P1 承诺内，请改用 JPEG/PNG/静态 WebP",
    ))
}
