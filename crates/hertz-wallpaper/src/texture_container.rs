// SPDX-License-Identifier: MIT
//! KTX2 2D container bounds only. DFD/codec/GPU qualification is not implied.

use std::io::Read;

use crate::{resource_container_io::ContainerReader, PackageError, Result, MAX_TEXTURE_BYTES};

const IDENTIFIER: [u8; 12] = [
    0xab, b'K', b'T', b'X', b' ', b'2', b'0', 0xbb, 13, 10, 26, 10,
];
const MAX_EDGE: u32 = 16_384;
const MAX_PIXELS: u64 = 64_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ktx2Level {
    pub offset: u64,
    pub bytes: u64,
    pub uncompressed_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ktx2Container {
    pub width: u32,
    pub height: u32,
    pub vk_format: u32,
    pub type_size: u32,
    pub supercompression: u32,
    pub generate_mipmaps: bool,
    pub levels: Vec<Ktx2Level>,
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("fixed u32 header field"),
    )
}
fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("fixed u64 header field"),
    )
}

pub fn inspect_ktx2<R: Read>(input: R, declared_bytes: u64) -> Result<Ktx2Container> {
    if !(104..=MAX_TEXTURE_BYTES).contains(&declared_bytes) {
        return Err(PackageError::new(
            "invalid_texture_container",
            "KTX2 entry length is outside the texture/header limit",
        ));
    }
    let mut reader = ContainerReader::new(input, declared_bytes, "invalid_texture_container");
    let header = reader.fixed::<80>()?;
    if header[..12] != IDENTIFIER {
        return Err(reader.error("KTX2 magic mismatch"));
    }
    let width = u32_at(&header, 20);
    let height = u32_at(&header, 24);
    if width == 0
        || height == 0
        || width > MAX_EDGE
        || height > MAX_EDGE
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(reader.error("KTX2 dimensions exceed the existing 2D texture limits"));
    }
    if u32_at(&header, 28) != 0 || u32_at(&header, 32) != 0 || u32_at(&header, 36) != 1 {
        return Err(PackageError::new(
            "texture_container_unavailable",
            "only ordinary 2D KTX2 textures are available",
        ));
    }
    let type_size = u32_at(&header, 16);
    if ![1, 2, 4, 8].contains(&type_size) {
        return Err(reader.error("invalid KTX2 typeSize"));
    }
    let declared_levels = u32_at(&header, 40);
    let level_count = declared_levels.max(1);
    let maximum_levels = u32::BITS - width.max(height).leading_zeros();
    if level_count > maximum_levels {
        return Err(reader.error("KTX2 mip count exceeds the dimension-derived chain"));
    }
    let supercompression = u32_at(&header, 44);
    if supercompression > 3 {
        return Err(PackageError::new(
            "texture_container_unavailable",
            "unrecognized KTX2 supercompression scheme",
        ));
    }
    let index_end = 80 + u64::from(level_count) * 24;
    if index_end > declared_bytes {
        return Err(reader.error("truncated KTX2 level index"));
    }
    let mut ranges = Vec::with_capacity(level_count as usize + 3);
    for (offset, bytes, alignment, required) in [
        (
            u64::from(u32_at(&header, 48)),
            u64::from(u32_at(&header, 52)),
            4,
            true,
        ),
        (
            u64::from(u32_at(&header, 56)),
            u64::from(u32_at(&header, 60)),
            4,
            false,
        ),
        (u64_at(&header, 64), u64_at(&header, 72), 8, false),
    ] {
        if bytes == 0 {
            if required || offset != 0 {
                return Err(reader.error("missing or inconsistent KTX2 metadata range"));
            }
            continue;
        }
        if required && bytes < 28 {
            return Err(reader.error("truncated KTX2 data format descriptor"));
        }
        let end = offset
            .checked_add(bytes)
            .ok_or_else(|| reader.error("KTX2 metadata range overflow"))?;
        if offset < index_end || offset % alignment != 0 || end > declared_bytes {
            return Err(reader.error("KTX2 metadata range exceeds or overlaps the header/index"));
        }
        ranges.push((offset, end));
    }
    let mut levels = Vec::with_capacity(level_count as usize);
    for _ in 0..level_count {
        let bytes = reader.fixed::<24>()?;
        let level = Ktx2Level {
            offset: u64_at(&bytes, 0),
            bytes: u64_at(&bytes, 8),
            uncompressed_bytes: u64_at(&bytes, 16),
        };
        let end = level
            .offset
            .checked_add(level.bytes)
            .ok_or_else(|| reader.error("KTX2 level range overflow"))?;
        if level.bytes == 0
            || level.offset < index_end
            || supercompression == 0 && level.offset % 4 != 0
            || end > declared_bytes
        {
            return Err(reader.error("invalid KTX2 level range"));
        }
        if supercompression == 0 && level.bytes != level.uncompressed_bytes
            || supercompression == 1 && level.uncompressed_bytes != 0
            || supercompression >= 2 && level.uncompressed_bytes == 0
        {
            return Err(reader.error("KTX2 uncompressed length contradicts its compression scheme"));
        }
        ranges.push((level.offset, end));
        levels.push(level);
    }
    ranges.sort_unstable();
    if ranges.windows(2).any(|range| range[0].1 > range[1].0) {
        return Err(reader.error("overlapping KTX2 metadata/level ranges"));
    }
    let remaining = reader.remaining();
    reader.skip(remaining)?;
    reader.finish()?;
    Ok(Ktx2Container {
        width,
        height,
        vk_format: u32_at(&header, 12),
        type_size,
        supercompression,
        generate_mipmaps: declared_levels == 0,
        levels,
    })
}
