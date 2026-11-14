// SPDX-License-Identifier: MIT
//! KTX2 2D container and BASIC data format facts. Codec/GPU qualification is
//! not implied: this validates descriptor framing and uncompressed level sizes.

use std::io::Read;

use crate::{resource_container_io::ContainerReader, PackageError, Result, MAX_TEXTURE_BYTES};

const IDENTIFIER: [u8; 12] = [
    0xab, b'K', b'T', b'X', b' ', b'2', b'0', 0xbb, 13, 10, 26, 10,
];
const MAX_EDGE: u32 = 16_384;
const MAX_PIXELS: u64 = 64_000_000;
/// 4-byte total size plus one u16-sized BASIC block.
const MAX_DFD_BYTES: u64 = 65_539;
const MAX_DFD_SAMPLES: u64 = 4094;
const MAX_BLOCK_EDGE: u8 = 32;
const DFD_BLOCK_HEADER: u64 = 24;
const DFD_SAMPLE_BYTES: u64 = 16;
const DFD_VERSION: u16 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ktx2Level {
    pub offset: u64,
    pub bytes: u64,
    pub uncompressed_bytes: u64,
}

/// Facts from the single Khronos BASIC descriptor block. Samples are validated
/// and counted only; the full sample table is not retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ktx2DataFormat {
    pub color_model: u8,
    pub primaries: u8,
    pub transfer: u8,
    pub flags: u8,
    /// Decoded 1-based texel block dimensions.
    pub texel_block: [u8; 4],
    pub bytes_plane: [u8; 8],
    pub sample_count: u16,
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
    pub data_format: Ktx2DataFormat,
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
    let mut dfd_range = None;
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
        if required && !(DFD_BLOCK_HEADER + DFD_SAMPLE_BYTES + 4..=MAX_DFD_BYTES).contains(&bytes) {
            return Err(
                reader.error("KTX2 data format descriptor size is outside the BASIC block limit")
            );
        }
        let end = offset
            .checked_add(bytes)
            .ok_or_else(|| reader.error("KTX2 metadata range overflow"))?;
        if offset < index_end || offset % alignment != 0 || end > declared_bytes {
            return Err(reader.error("KTX2 metadata range exceeds or overlaps the header/index"));
        }
        if required {
            dfd_range = Some((offset, bytes));
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
            || supercompression == 0 && !level.offset.is_multiple_of(4)
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
    // The descriptor is required and starts after the level index, so the
    // sequential reader only skips forward to it.
    let (dfd_offset, dfd_bytes) = dfd_range.expect("required KTX2 data format descriptor");
    let position = reader.offset();
    debug_assert!(dfd_offset >= position);
    reader.skip(dfd_offset - position)?;
    let data_format = parse_data_format(
        &mut reader,
        dfd_bytes,
        width,
        height,
        type_size,
        supercompression,
        &levels,
    )?;
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
        data_format,
    })
}

/// Validates one Khronos BASIC descriptor block. Multi-block/vendor DFDs stay
/// fail-closed until a consumer actually needs them.
fn parse_data_format<R: Read>(
    reader: &mut ContainerReader<'_, R>,
    dfd_bytes: u64,
    width: u32,
    height: u32,
    type_size: u32,
    supercompression: u32,
    levels: &[Ktx2Level],
) -> Result<Ktx2DataFormat> {
    let total = u32_at(&reader.fixed::<4>()?, 0);
    if u64::from(total) != dfd_bytes {
        return Err(reader.error("KTX2 descriptor total size contradicts its header range"));
    }
    let block = reader.fixed::<8>()?;
    if u32_at(&block, 0) != 0 {
        return Err(PackageError::new(
            "texture_container_unavailable",
            "only Khronos BASIC KTX2 data format descriptors are available",
        ));
    }
    if u16::from_le_bytes([block[4], block[5]]) != DFD_VERSION {
        return Err(PackageError::new(
            "texture_container_unavailable",
            "unsupported KTX2 data format descriptor version",
        ));
    }
    let block_bytes = u64::from(u16::from_le_bytes([block[6], block[7]]));
    if block_bytes != dfd_bytes - 4
        || !(DFD_BLOCK_HEADER + DFD_SAMPLE_BYTES..).contains(&block_bytes)
        || !(block_bytes - DFD_BLOCK_HEADER).is_multiple_of(DFD_SAMPLE_BYTES)
    {
        return Err(reader.error("KTX2 descriptor block size contradicts the DFD framing"));
    }
    let sample_count = (block_bytes - DFD_BLOCK_HEADER) / DFD_SAMPLE_BYTES;
    debug_assert!(sample_count <= MAX_DFD_SAMPLES);
    let basic = reader.fixed::<16>()?;
    let color_model = basic[0];
    if color_model == 0 {
        return Err(PackageError::new(
            "texture_container_unavailable",
            "KTX2 data format color model is unspecified",
        ));
    }
    let flags = basic[3];
    if flags & !1 != 0 {
        return Err(reader.error("KTX2 descriptor flags contain undefined bits"));
    }
    let texel_block = [basic[4] + 1, basic[5] + 1, basic[6] + 1, basic[7] + 1];
    if texel_block[2] != 1 || texel_block[3] != 1 {
        return Err(PackageError::new(
            "texture_container_unavailable",
            "only single-plane 2D KTX2 texel blocks are available",
        ));
    }
    if texel_block[0] > MAX_BLOCK_EDGE || texel_block[1] > MAX_BLOCK_EDGE {
        return Err(reader.error("KTX2 texel block dimensions exceed the existing 2D limit"));
    }
    let mut bytes_plane = [0u8; 8];
    bytes_plane.copy_from_slice(&basic[8..16]);
    if bytes_plane[0] == 0 || u32::from(bytes_plane[0]) % type_size != 0 {
        return Err(reader.error("KTX2 bytesPlane contradicts typeSize"));
    }
    if bytes_plane[1..].iter().any(|plane| *plane != 0) {
        return Err(PackageError::new(
            "texture_container_unavailable",
            "only single-plane 2D KTX2 data formats are available",
        ));
    }
    let texel_bits = u32::from(bytes_plane[0]) * 8;
    for _ in 0..sample_count {
        let sample = reader.fixed::<16>()?;
        let offset = u32::from(u16::from_le_bytes([sample[0], sample[1]]));
        let length = u32::from(sample[2]);
        if length == 0
            || offset
                .checked_add(length)
                .is_none_or(|end| end > texel_bits)
        {
            return Err(reader.error("KTX2 sample bit range exceeds its texel plane"));
        }
        if sample[4..8]
            .iter()
            .zip(texel_block)
            .any(|(position, block)| *position >= block)
        {
            return Err(reader.error("KTX2 sample position exceeds its texel block"));
        }
    }
    if supercompression == 0 {
        for (index, level) in levels.iter().enumerate() {
            let level_width = u64::from((width >> index).max(1));
            let level_height = u64::from((height >> index).max(1));
            let expected = level_width
                .div_ceil(u64::from(texel_block[0]))
                .checked_mul(level_height.div_ceil(u64::from(texel_block[1])))
                .and_then(|blocks| blocks.checked_mul(u64::from(bytes_plane[0])))
                .ok_or_else(|| reader.error("KTX2 level byte count overflow"))?;
            if level.uncompressed_bytes != expected {
                return Err(
                    reader.error("KTX2 uncompressed level length contradicts its data format")
                );
            }
        }
    }
    Ok(Ktx2DataFormat {
        color_model,
        primaries: basic[1],
        transfer: basic[2],
        flags,
        texel_block,
        bytes_plane,
        sample_count: u16::try_from(sample_count).expect("bounded KTX2 DFD sample count"),
    })
}
