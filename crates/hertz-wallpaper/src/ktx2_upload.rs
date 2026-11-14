// SPDX-License-Identifier: MIT
//! KTX2 upload-target decision table over declared device capabilities.
//! Pure policy only: no device probe, transcoding or GPU upload occurs here.

use crate::{
    texture_container::{Ktx2Container, Ktx2DataFormat},
    PackageError, Result,
};

const KHR_DF_MODEL_ETC1S: u8 = 163;
const KHR_DF_MODEL_UASTC: u8 = 166;
const KHR_DF_TRANSFER_SRGB: u8 = 2;

const VK_FORMAT_R8G8B8A8_UNORM: u32 = 37;

/// Declared capabilities, matching the WebGL extensions Three's KTX2 loader
/// probes. The caller owns the probe; this crate never touches a GPU.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Ktx2UploadCapabilities {
    pub astc: bool,
    pub etc1: bool,
    pub etc2: bool,
    pub dxt: bool,
    pub bptc: bool,
}

/// Transcode output family for Basis (ETC1S/UASTC) payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ktx2TranscodeTarget {
    Astc4x4,
    Bc1,
    Bc3,
    Bc7,
    Etc1Rgb8,
    Etc2Rgb8,
    Etc2Rgba8,
    Rgba8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ktx2UploadPlan {
    /// The payload is already in a device-supported upload format.
    Direct { vk_format: u32 },
    /// Basis payload needs transcoding; `rgba_bytes` is the full mip-chain RGBA
    /// fallback size for budget admission, never an actual allocation here.
    Transcode {
        target: Ktx2TranscodeTarget,
        srgb: bool,
        rgba_bytes: u64,
    },
}

fn unavailable(message: &'static str) -> PackageError {
    PackageError::new("texture_container_unavailable", message)
}

/// Decide how a validated KTX2 container reaches the declared device. Unknown
/// formats, missing capabilities and non-Basis supercompression fail closed.
pub fn plan_ktx2_upload(
    container: &Ktx2Container,
    capabilities: Ktx2UploadCapabilities,
) -> Result<Ktx2UploadPlan> {
    let format = &container.data_format;
    if matches!(format.color_model, KHR_DF_MODEL_ETC1S | KHR_DF_MODEL_UASTC) {
        return Ok(Ktx2UploadPlan::Transcode {
            target: transcode_target(format, capabilities),
            srgb: format.transfer == KHR_DF_TRANSFER_SRGB,
            rgba_bytes: rgba_bytes(container)?,
        });
    }
    if container.supercompression != 0 {
        return Err(unavailable(
            "KTX2 supercompression requires a decoder before upload",
        ));
    }
    let supported = match container.vk_format {
        VK_FORMAT_R8G8B8A8_UNORM => true,
        131..=138 => capabilities.dxt,
        143..=146 => capabilities.bptc,
        147..=152 => capabilities.etc2,
        157..=184 => capabilities.astc,
        _ => false,
    };
    if supported {
        Ok(Ktx2UploadPlan::Direct {
            vk_format: container.vk_format,
        })
    } else {
        Err(unavailable(
            "KTX2 format is not supported by the declared GPU capabilities",
        ))
    }
}

fn transcode_target(
    format: &Ktx2DataFormat,
    capabilities: Ktx2UploadCapabilities,
) -> Ktx2TranscodeTarget {
    let srgb = format.transfer == KHR_DF_TRANSFER_SRGB;
    let alpha = format.has_alpha;
    if capabilities.astc {
        Ktx2TranscodeTarget::Astc4x4
    } else if capabilities.bptc && format.color_model == KHR_DF_MODEL_UASTC {
        Ktx2TranscodeTarget::Bc7
    } else if capabilities.dxt {
        if alpha {
            Ktx2TranscodeTarget::Bc3
        } else {
            Ktx2TranscodeTarget::Bc1
        }
    } else if capabilities.etc2 {
        if alpha {
            Ktx2TranscodeTarget::Etc2Rgba8
        } else {
            Ktx2TranscodeTarget::Etc2Rgb8
        }
    } else if capabilities.etc1 && format.color_model == KHR_DF_MODEL_ETC1S && !alpha && !srgb {
        Ktx2TranscodeTarget::Etc1Rgb8
    } else {
        Ktx2TranscodeTarget::Rgba8
    }
}

fn rgba_bytes(container: &Ktx2Container) -> Result<u64> {
    let mut total = 0u64;
    for index in 0..container.levels.len() {
        let width = u64::from((container.width >> index).max(1));
        let height = u64::from((container.height >> index).max(1));
        let pixels = width
            .checked_mul(height)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| unavailable("KTX2 RGBA fallback size overflow"))?;
        total = total
            .checked_add(pixels)
            .ok_or_else(|| unavailable("KTX2 RGBA fallback size overflow"))?;
    }
    Ok(total)
}
