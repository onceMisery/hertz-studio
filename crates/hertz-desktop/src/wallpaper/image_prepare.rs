// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 有界图片准备器。原包不变；派生 PNG 不携带输入 EXIF/GPS/ICC。
//! 方向与缩放合并，在线性 sRGB 中以预乘 alpha 做面积采样，输出直通 alpha。
//! 工作区采用保守估算 + decoder limits，不声称能够硬限制第三方库的进程 RSS。

use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use image::{ImageDecoder, ImageFormat, ImageReader, RgbaImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::assets::{AssetStore, DecodeInput};
use super::decode_probe::ProbeClient;
use super::jobs::{new_job_id, JobError};
use super::library::{now_secs, Library};

type Result<T> = std::result::Result<T, JobError>;
// 像素算法或 decoder/CMS 版本变更时递增；旧会话继续固定旧代际。
pub(crate) const PIPELINE: &str = "image-srgb-v1";
const IMPORTER: &str = "hertz-native-image";
const OPTIONS: &str = r#"{"alpha":"straight","codec":"png-rgba8","colorSpace":"sRGB-SDR","filter":"linear-premultiplied-area","maxPixels":8294400,"maxSide":4096,"mipmap":false,"thumbnailSide":512,"untagged":"assume-sRGB"}"#;
const MAX_FILE: u64 = 32 * 1024 * 1024;
const CACHE_CAP: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Output {
    pub sha256: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Receipt {
    pub cache_key: String,
    pub input_hash: String,
    pub pipeline: String,
    pub options: String,
    pub source_width: u32,
    pub source_height: u32,
    pub orientation: u8,
    pub render: Output,
    pub thumbnail: Output,
}

pub(crate) struct PreparedImage {
    pub receipt: Receipt,
    directory: PathBuf,
    relative: PathBuf,
    staged: bool,
}

fn invalid(error: impl std::fmt::Display) -> JobError {
    JobError::new("decode_failed", format!("图片准备失败：{error}"))
}

fn unsupported(message: &str) -> JobError {
    JobError::new("format_unsupported", message)
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(JobError::new("cancelled", "图片准备已取消"))
    } else {
        Ok(())
    }
}

fn key(input_hash: &str) -> String {
    let mut digest = Sha256::new();
    // 分隔符排除变长字段拼接歧义；OPTIONS 的字段序已固定。
    for part in [input_hash, IMPORTER, PIPELINE, OPTIONS] {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}

fn fit(width: u32, height: u32, side: u32, pixels: u64) -> (u32, u32) {
    let scale = 1.0f64
        .min(f64::from(side) / f64::from(width.max(height)))
        .min((pixels as f64 / (u64::from(width) * u64::from(height)) as f64).sqrt());
    (
        (f64::from(width) * scale).floor().max(1.0) as u32,
        (f64::from(height) * scale).floor().max(1.0) as u32,
    )
}

fn workspace(width: u32, height: u32, compressed: u64) -> Result<u64> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0
        || height == 0
        || width.max(height) > 16384
        || pixels > 64_000_000
        || compressed > MAX_FILE
    {
        return Err(unsupported("图片超过原图尺寸或压缩字节限制"));
    }
    let (w, h) = fit(width, height, 4096, 8_294_400);
    // 源像素/格式转换/decoder 内部缓冲按 32 B/px，压缩输入按两份；
    // 输出与缩略图分时生成，另留 32 MiB 给有界元数据、ICC、编码与行缓冲。
    let estimate =
        pixels * 32 + compressed * 2 + u64::from(w) * u64::from(h) * 4 + 32 * 1024 * 1024;
    if estimate > super::budget::MAX_PREPARE_CPU_BYTES {
        return Err(JobError::new("probe_budget_exceeded", format!("图片准备估计需要 {estimate} 字节，超过独立 320 MiB 工作区；当前 decoder 无缩放解码")));
    }
    Ok(estimate)
}

pub(crate) async fn prepare(
    store: &AssetStore,
    library: &Library,
    probe: &ProbeClient,
    job: &str,
    input: &DecodeInput,
    cancel: &AtomicBool,
) -> Result<PreparedImage> {
    cancelled(cancel)?;
    let cache_key = key(&input.media.entry.sha256);
    let prefix = PathBuf::from(&input.media.entry.sha256)
        .join(PIPELINE)
        .join(&cache_key);
    let cached: Option<(String,)> =
        sqlx::query_as("SELECT path FROM derived_entries WHERE cache_key = ?")
            .bind(&cache_key)
            .fetch_optional(library.pool())
            .await
            .map_err(|error| JobError::database(error.to_string()))?;
    if let Some((path,)) = cached {
        let relative = PathBuf::from(path);
        // DB/receipt 不能把本模块的缓存读取导向任意本机路径。
        if relative.parent() == Some(prefix.as_path())
            && relative
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("gen-")
                        && name.len() <= 64
                        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                })
        {
            let directory = store.root().join("derived").join(&relative);
            if let Ok(receipt) = verify(&directory, &input.media.entry.sha256, &cache_key) {
                return Ok(PreparedImage {
                    receipt,
                    directory,
                    relative,
                    staged: false,
                });
            }
        }
    }
    let estimate = workspace(
        input.metadata.encoded_width,
        input.metadata.encoded_height,
        input.media.entry.bytes,
    )?;
    let reservation = probe.image_workspace(estimate)?;
    // 同步函数返回时 decoder/像素/ICC/编码缓冲均已退出，才归还工作区。
    let result = generate(store, job, input, prefix, cancel);
    reservation.finish();
    result
}

fn generate(
    store: &AssetStore,
    job: &str,
    input: &DecodeInput,
    prefix: PathBuf,
    cancel: &AtomicBool,
) -> Result<PreparedImage> {
    store.check_disk_space(2 * MAX_FILE + 16 * 1024)?;
    let relative = prefix.join(format!("gen-{}", new_job_id()));
    let directory = store.staging_dir(job).join("derived").join(&relative);
    std::fs::create_dir_all(&directory).map_err(invalid)?;
    let format = match input.metadata.codec.as_str() {
        "png" => ImageFormat::Png,
        "jpeg" => ImageFormat::Jpeg,
        "webp" => ImageFormat::WebP,
        _ => return Err(unsupported("仅准备静态 PNG/JPEG/WebP")),
    };
    // 在通用 decoder 构造前限制 PNG 元数据解压，避免大 iCCP/text 绕过工作区估算。
    let png_orientation = if format == ImageFormat::Png {
        Some(validate_png_color(&input.media.path, cancel)?)
    } else {
        None
    };
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(input.metadata.encoded_width);
    limits.max_image_height = Some(input.metadata.encoded_height);
    limits.max_alloc = Some(
        u64::from(input.metadata.encoded_width) * u64::from(input.metadata.encoded_height) * 24
            + 8 * 1024 * 1024,
    );
    let mut reader = ImageReader::with_format(BufReader::new(open(&input.media.path)?), format);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(invalid)?;
    if decoder.dimensions() != (input.metadata.encoded_width, input.metadata.encoded_height) {
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
    let (width, height) = pixels.dimensions();
    let (dw, dh) = if orientation >= 5 {
        (height, width)
    } else {
        (width, height)
    };
    let (rw, rh) = fit(dw, dh, 4096, 8_294_400);
    let render = write_png(
        &directory.join("render.png"),
        &resample(&pixels, orientation, rw, rh, cancel)?,
        cancel,
    )?;
    let (tw, th) = fit(dw, dh, 512, 512 * 512);
    let thumbnail = write_png(
        &directory.join("thumbnail.png"),
        &resample(&pixels, orientation, tw, th, cancel)?,
        cancel,
    )?;
    let receipt = Receipt {
        cache_key: key(&input.media.entry.sha256),
        input_hash: input.media.entry.sha256.clone(),
        pipeline: PIPELINE.into(),
        options: OPTIONS.into(),
        source_width: width,
        source_height: height,
        orientation,
        render,
        thumbnail,
    };
    let mut file = std::fs::File::create(directory.join("receipt.json")).map_err(invalid)?;
    file.write_all(&serde_json::to_vec_pretty(&receipt).map_err(invalid)?)
        .map_err(invalid)?;
    file.sync_all().map_err(invalid)?;
    Ok(PreparedImage {
        receipt,
        directory,
        relative,
        staged: true,
    })
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

fn resample(
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

fn write_png(path: &Path, pixels: &RgbaImage, cancel: &AtomicBool) -> Result<Output> {
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
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(path)
        .map_err(invalid)
}

fn hash(path: &Path) -> Result<(u64, String)> {
    let mut file = open(path)?;
    let bytes = file.metadata().map_err(invalid)?.len();
    if bytes == 0 || bytes > MAX_FILE {
        return Err(invalid("派生文件大小错误"));
    }
    let mut digest = Sha256::new();
    std::io::copy(&mut file, &mut digest).map_err(invalid)?;
    Ok((bytes, format!("{:x}", digest.finalize())))
}

fn verify(directory: &Path, input_hash: &str, cache_key: &str) -> Result<Receipt> {
    let mut bytes = Vec::new();
    open(&directory.join("receipt.json"))?
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(invalid)?;
    if bytes.len() > 8192 {
        return Err(invalid("派生收据超限"));
    }
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(invalid)?;
    if receipt.cache_key != cache_key
        || receipt.input_hash != input_hash
        || receipt.pipeline != PIPELINE
        || receipt.options != OPTIONS
    {
        return Err(invalid("派生缓存身份不匹配"));
    }
    for (name, out, side, cap) in [
        ("render.png", &receipt.render, 4096, 8_294_400),
        ("thumbnail.png", &receipt.thumbnail, 512, 512 * 512),
    ] {
        if out.width == 0
            || out.height == 0
            || out.width.max(out.height) > side
            || u64::from(out.width) * u64::from(out.height) > cap
        {
            return Err(invalid("派生尺寸超限"));
        }
        let (bytes, digest) = hash(&directory.join(name))?;
        if bytes != out.bytes || digest != out.sha256 {
            return Err(invalid("派生缓存已损坏"));
        }
    }
    Ok(receipt)
}

impl PreparedImage {
    pub(crate) fn decode_input(
        &self,
        store: &AssetStore,
        source: &DecodeInput,
    ) -> Result<DecodeInput> {
        let input = store.pin_prepared(
            source,
            self.directory.join("render.png"),
            hertz_wallpaper::VerifiedEntry {
                path: format!("prepared/{}/render.png", self.receipt.cache_key),
                bytes: self.receipt.render.bytes,
                sha256: self.receipt.render.sha256.clone(),
                mime: Some("image/png".into()),
            },
        )?;
        if (input.metadata.encoded_width, input.metadata.encoded_height)
            != (self.receipt.render.width, self.receipt.render.height)
        {
            return Err(invalid("派生收据与实际尺寸不一致"));
        }
        Ok(input)
    }

    pub(crate) async fn publish(&mut self, store: &AssetStore, library: &Library) -> Result<()> {
        if self.staged {
            let target = store.root().join("derived").join(&self.relative);
            std::fs::create_dir_all(target.parent().expect("generation parent"))
                .map_err(invalid)?;
            let required = directory_bytes(&self.directory)?;
            let held = directory_bytes(&store.root().join("derived"))?;
            if required > CACHE_CAP.saturating_sub(held) {
                return Err(JobError::new(
                    "cache_full",
                    "派生缓存达到 2 GiB 上限，请清理闲置缓存后重试",
                ));
            }
            // 从不覆盖旧代际；旧 controller 的 contentKey/文件句柄仍指向旧字节。
            std::fs::rename(&self.directory, &target).map_err(invalid)?;
            self.directory = target;
            self.staged = false;
        }
        sqlx::query("INSERT INTO derived_entries (cache_key, path, bytes, pipeline_version, last_used) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(cache_key) DO UPDATE SET path=excluded.path, bytes=excluded.bytes, pipeline_version=excluded.pipeline_version, last_used=excluded.last_used")
            .bind(&self.receipt.cache_key).bind(self.relative.to_string_lossy().as_ref())
            .bind(directory_bytes(&self.directory)? as i64).bind(PIPELINE).bind(now_secs())
            .execute(library.pool()).await.map_err(|error| JobError::database(error.to_string()))?;
        Ok(())
    }
}

fn directory_bytes(root: &Path) -> Result<u64> {
    let mut stack = vec![(root.to_path_buf(), 0)];
    let mut count = 0;
    let mut bytes = 0u64;
    while let Some((path, depth)) = stack.pop() {
        for entry in std::fs::read_dir(path).map_err(invalid)? {
            let entry = entry.map_err(invalid)?;
            count += 1;
            if count > 50_000 || depth > 6 {
                return Err(invalid("派生目录枚举超限"));
            }
            let metadata = entry.metadata().map_err(invalid)?;
            if metadata.file_type().is_symlink() {
                return Err(invalid("派生缓存禁止符号链接"));
            }
            if metadata.is_dir() {
                stack.push((entry.path(), depth + 1));
            } else {
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "image_prepare_tests.rs"]
mod tests;
