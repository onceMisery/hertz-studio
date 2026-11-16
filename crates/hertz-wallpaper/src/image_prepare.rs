// SPDX-License-Identifier: MIT
//! Shared bounded pixel pipeline. Callers own concurrency, workspace and files.
//! Extracted from the native preparer, preserving ICC, orientation and alpha.
use crate::PackageError;
use image::{ImageDecoder, ImageFormat, ImageReader, RgbaImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{BufReader, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
type Result<T> = std::result::Result<T, PackageError>;
const MAX_FILE: u64 = 32 * 1024 * 1024;
fn invalid(error: impl std::fmt::Display) -> PackageError {
    PackageError::new("decode_failed", format!("图片准备失败：{error}"))
}
fn unsupported(message: &str) -> PackageError {
    PackageError::new("format_unsupported", message)
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(PackageError::new("cancelled", "图片准备已取消"))
    } else {
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Output {
    pub sha256: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
}

pub fn decode(
    path: &Path,
    codec: &str,
    width: u32,
    height: u32,
    max_alloc: u64,
    cancel: &AtomicBool,
) -> Result<(RgbaImage, u8)> {
    cancelled(cancel)?;
    let mut input = open(path)?;
    if input.metadata().map_err(invalid)?.len() > MAX_FILE {
        return Err(unsupported("图片超过 32 MiB"));
    }
    let probe =
        crate::media::probe(&mut input).map_err(|e| PackageError::new(e.code, e.message))?;
    if probe.codec != codec || probe.encoded_width != width || probe.encoded_height != height {
        return Err(invalid("图片结构与调用方探测不一致"));
    }
    let format = match codec {
        "png" => ImageFormat::Png,
        "jpeg" => ImageFormat::Jpeg,
        "webp" => ImageFormat::WebP,
        _ => return Err(unsupported("仅准备静态 PNG/JPEG/WebP")),
    };
    // 在通用 decoder 构造前限制 PNG 元数据解压，避免大 iCCP/text 绕过工作区估算。
    let png_orientation = if format == ImageFormat::Png {
        Some(validate_png_color(path, cancel)?)
    } else {
        None
    };
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    limits.max_alloc = Some(max_alloc);
    let mut reader = ImageReader::with_format(BufReader::new(open(path)?), format);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(invalid)?;
    if decoder.dimensions() != (width, height) {
        return Err(invalid("decoder 尺寸与结构探测不一致"));
    }
    let orientation = png_orientation.unwrap_or(decoder.orientation().map_err(invalid)?.to_exif());
    let icc = decoder.icc_profile().map_err(invalid)?;
    if icc
        .as_ref()
        .is_some_and(|profile| profile.len() > 1024 * 1024)
    {
        return Err(unsupported("ICC profile 超过 1 MiB 上限"));
    }
    cancelled(cancel)?;
    let mut pixels = image::DynamicImage::from_decoder(decoder)
        .map_err(invalid)?
        .into_rgba8();
    if let Some(icc) = icc {
        convert_icc(&mut pixels, &icc, cancel)?;
    }
    cancelled(cancel)?;
    Ok((pixels, orientation))
}
fn convert_icc(pixels: &mut RgbaImage, icc: &[u8], cancel: &AtomicBool) -> Result<()> {
    use moxcms::{ColorProfile, DataColorSpace, Layout, ParsingOptions};
    let profile = ColorProfile::new_from_slice_with_options(
        icc,
        ParsingOptions {
            max_profile_size: 1024 * 1024,
            max_allowed_clut_size: 65536,
            max_allowed_trc_size: 4096,
        },
    )
    .map_err(invalid)?;
    if profile.color_space != DataColorSpace::Rgb {
        return Err(unsupported(
            "当前图片准备器仅转换 RGB ICC；不支持的色彩布局需先转为 sRGB",
        ));
    }
    let transform = profile
        .create_transform_8bit(
            Layout::Rgba,
            &ColorProfile::new_srgb(),
            Layout::Rgba,
            Default::default(),
        )
        .map_err(invalid)?;
    let mut row = vec![0; pixels.width() as usize * 4];
    for src in pixels.as_mut().chunks_exact_mut(row.len()) {
        cancelled(cancel)?;
        transform.transform(src, &mut row).map_err(invalid)?;
        // ICC 只变换颜色，明确保留原始直通 alpha。
        for (original, converted) in src
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(row.as_chunks::<4>().0.iter())
        {
            original[..3].copy_from_slice(&converted[..3]);
        }
    }
    Ok(())
}

fn validate_png_color(path: &Path, cancel: &AtomicBool) -> Result<u8> {
    let decoder = png::Decoder::new_with_limits(
        BufReader::new(open(path)?),
        png::Limits {
            bytes: 8 * 1024 * 1024,
        },
    );
    let mut reader = decoder.read_info().map_err(invalid)?;
    // 包含最后 IDAT/结束块的 CRC，以及可能位于 IDAT 后的 eXIf。
    while reader.next_row().map_err(invalid)?.is_some() {
        cancelled(cancel)?;
    }
    reader.finish().map_err(invalid)?;
    let info = reader.info();
    if info.coding_independent_code_points.is_some_and(|c| {
        c.color_primaries != 1
            || c.transfer_function != 13
            || c.matrix_coefficients != 0
            || !c.is_video_full_range_image
    }) {
        return Err(unsupported("PNG 的 HDR/非 sRGB cICP 暂无转换器"));
    }
    let non_srgb = info
        .gamma()
        .is_some_and(|g| (g.into_value() - 0.45455).abs() > 0.0001)
        || info.chromaticities().is_some_and(|c| {
            c != png::SourceChromaticities::new(
                (0.3127, 0.329),
                (0.64, 0.33),
                (0.3, 0.6),
                (0.15, 0.06),
            )
        });
    if info.icc_profile.is_none() && info.srgb.is_none() && non_srgb {
        return Err(unsupported("PNG 声明了非 sRGB gamma/色度但没有可转换 ICC"));
    }
    Ok(info
        .exif_metadata
        .as_ref()
        .and_then(|exif| image::metadata::Orientation::from_exif_chunk(exif))
        .map_or(1, |value| value.to_exif()))
}

fn source_xy(x: u32, y: u32, width: u32, height: u32, orientation: u8) -> (u32, u32) {
    match orientation {
        2 => (width - 1 - x, y),
        3 => (width - 1 - x, height - 1 - y),
        4 => (x, height - 1 - y),
        5 => (y, x),
        6 => (y, height - 1 - x),
        7 => (width - 1 - y, height - 1 - x),
        8 => (width - 1 - y, x),
        _ => (x, y),
    }
}

pub fn resample(
    source: &RgbaImage,
    orientation: u8,
    width: u32,
    height: u32,
    cancel: &AtomicBool,
) -> Result<RgbaImage> {
    let (sw, sh) = source.dimensions();
    let (dw, dh) = if orientation >= 5 { (sh, sw) } else { (sw, sh) };
    let mut output = RgbaImage::new(width, height);
    let linear: [f64; 256] = std::array::from_fn(|v| {
        let v = v as f64 / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    });
    for y in 0..height {
        cancelled(cancel)?;
        let y0 = f64::from(y) * f64::from(dh) / f64::from(height);
        let y1 = f64::from(y + 1) * f64::from(dh) / f64::from(height);
        for x in 0..width {
            let x0 = f64::from(x) * f64::from(dw) / f64::from(width);
            let x1 = f64::from(x + 1) * f64::from(dw) / f64::from(width);
            let mut sum = [0.0; 4];
            for sy in y0.floor() as u32..(y1.ceil() as u32).min(dh) {
                let wy = y1.min(f64::from(sy + 1)) - y0.max(f64::from(sy));
                for sx in x0.floor() as u32..(x1.ceil() as u32).min(dw) {
                    let weight = wy * (x1.min(f64::from(sx + 1)) - x0.max(f64::from(sx)));
                    let (px, py) = source_xy(sx, sy, sw, sh, orientation);
                    let pixel = source.get_pixel(px, py).0;
                    let alpha = f64::from(pixel[3]) / 255.0;
                    for channel in 0..3 {
                        sum[channel] += linear[usize::from(pixel[channel])] * alpha * weight;
                    }
                    sum[3] += alpha * weight;
                }
            }
            let mut pixel = [0; 4];
            if sum[3] > 0.0 {
                for channel in 0..3 {
                    let v = (sum[channel] / sum[3]).clamp(0.0, 1.0);
                    let v = if v <= 0.0031308 {
                        v * 12.92
                    } else {
                        1.055 * v.powf(1.0 / 2.4) - 0.055
                    };
                    pixel[channel] = (v * 255.0).round() as u8;
                }
            }
            pixel[3] = (sum[3] / ((x1 - x0) * (y1 - y0)) * 255.0).round() as u8;
            output.put_pixel(x, y, image::Rgba(pixel));
        }
    }
    Ok(output)
}

struct LimitedWriter<'a> {
    file: &'a mut std::fs::File,
    bytes: u64,
}
impl Write for LimitedWriter<'_> {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        if data.len() as u64 > MAX_FILE.saturating_sub(self.bytes) {
            return Err(std::io::Error::other("派生 PNG 超过 32 MiB"));
        }
        let written = self.file.write(data)?;
        self.bytes += written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

pub fn write_png(path: &Path, pixels: &RgbaImage, cancel: &AtomicBool) -> Result<Output> {
    let mut file = std::fs::File::create(path).map_err(invalid)?;
    let mut encoder = png::Encoder::new(
        LimitedWriter {
            file: &mut file,
            bytes: 0,
        },
        pixels.width(),
        pixels.height(),
    );
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(invalid)?;
    let mut stream = writer.stream_writer().map_err(invalid)?;
    for row in pixels.as_raw().chunks_exact(pixels.width() as usize * 4) {
        cancelled(cancel)?;
        stream.write_all(row).map_err(invalid)?;
    }
    stream.finish().map_err(invalid)?;
    writer.finish().map_err(invalid)?;
    file.sync_all().map_err(invalid)?;
    drop(file);
    let (bytes, sha256) = hash(path)?;
    Ok(Output {
        sha256,
        bytes,
        width: pixels.width(),
        height: pixels.height(),
    })
}

fn open(path: &Path) -> Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    options.open(path).map_err(invalid)
}

pub fn hash(path: &Path) -> Result<(u64, String)> {
    let mut file = open(path)?;
    let bytes = file.metadata().map_err(invalid)?.len();
    if bytes == 0 || bytes > MAX_FILE {
        return Err(invalid("派生文件大小错误"));
    }
    let mut digest = Sha256::new();
    std::io::copy(&mut file, &mut digest).map_err(invalid)?;
    Ok((bytes, format!("{:x}", digest.finalize())))
}

#[cfg(test)]
#[path = "image_prepare_tests.rs"]
mod tests;
