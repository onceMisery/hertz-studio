// SPDX-License-Identifier: MIT
//! Service workspace policy over the shared native pixel algorithm.
use hertz_wallpaper::{
    generation::{MAX_ARTIFACT_BYTES, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS},
    image_prepare::{self, Output},
    PackageError,
};
use std::{path::Path, sync::atomic::AtomicBool};
pub(super) const WORKSPACE_BYTES: u64 = 128 * 1024 * 1024;

pub(super) fn prepare(
    source: &Path,
    destination: &Path,
    expected: (u32, u32),
    cancel: &AtomicBool,
) -> Result<Output, PackageError> {
    let mut input = std::fs::File::open(source)
        .map_err(|_| PackageError::new("image_io", "无法打开图像暂存文件"))?;
    let bytes = input
        .metadata()
        .map_err(|_| PackageError::new("image_io", "无法读取图像长度"))?
        .len();
    if bytes == 0 || bytes > MAX_ARTIFACT_BYTES {
        return Err(PackageError::new("image_bounds", "图像文件超过32 MiB"));
    }
    let probe = hertz_wallpaper::media::probe(&mut input)
        .map_err(|e| PackageError::new(e.code, e.message))?;
    let (width, height) = (probe.encoded_width, probe.encoded_height);
    let pixels = u64::from(width) * u64::from(height);
    if !matches!(probe.codec.as_str(), "png" | "jpeg" | "webp")
        || width.max(height) > MAX_IMAGE_EDGE
        || pixels > MAX_IMAGE_PIXELS
    {
        return Err(PackageError::new(
            "image_bounds",
            "仅接收单帧PNG/JPEG/WebP且最长边4096、像素8 Mi",
        ));
    }
    // Same conservative decoder/CMS/output estimate as native preparation,
    // with the service's own budget. Admissible dimensions are not a promise
    // that every compressed image fits this decoder's bounded workspace.
    let estimate = pixels * 36 + bytes * 2 + 32 * 1024 * 1024;
    if estimate > WORKSPACE_BYTES {
        return Err(PackageError::new(
            "image_workspace_exceeded",
            "图像准备超过独立128 MiB工作区",
        ));
    }
    let (pixels, orientation) = image_prepare::decode(
        source,
        &probe.codec,
        width,
        height,
        pixels * 24 + 8 * 1024 * 1024,
        cancel,
    )?;
    let dimensions = if orientation >= 5 {
        (height, width)
    } else {
        (width, height)
    };
    if dimensions != expected {
        return Err(PackageError::new(
            "image_sku_mismatch",
            "实际图像尺寸与冻结规格不一致",
        ));
    }
    if orientation == 1 {
        image_prepare::write_png(destination, &pixels, cancel)
    } else {
        let output =
            image_prepare::resample(&pixels, orientation, dimensions.0, dimensions.1, cancel)?;
        image_prepare::write_png(destination, &output, cancel)
    }
}
