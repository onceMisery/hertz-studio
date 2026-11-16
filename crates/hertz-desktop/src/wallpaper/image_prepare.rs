// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 有界图片准备器。原包不变；派生 PNG 不携带输入 EXIF/GPS/ICC。
//! 方向与缩放合并，在线性 sRGB 中以预乘 alpha 做面积采样，输出直通 alpha。
//! 工作区采用保守估算 + decoder limits，不声称能够硬限制第三方库的进程 RSS。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::assets::{AssetStore, DecodeInput};
use super::decode_probe::ProbeClient;
use super::derived_cache::{self, directory_bytes};
use super::jobs::{new_job_id, JobError};
use super::library::{now_secs, Library};

type Result<T> = std::result::Result<T, JobError>;
// 像素算法或 decoder/CMS 版本变更时递增；旧会话继续固定旧代际。
pub(crate) const PIPELINE: &str = "image-srgb-v1";
const IMPORTER: &str = "hertz-native-image";
const MAX_FILE: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ImagePurpose {
    Preview,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ImageFit {
    Cover,
    Contain,
}

/// width/height 是调用方按实际输出、画质和设备预算规划后的像素，非 CSS 尺寸。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageTarget {
    pub width: u32,
    pub height: u32,
    pub fit: ImageFit,
    pub purpose: ImagePurpose,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetPixels {
    fit: ImageFit,
    height: u32,
    width: u32,
}

// 固定字段顺序保证 canonicalOptions；用途名称不另建一套质量表。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    alpha: &'static str,
    codec: &'static str,
    color_space: &'static str,
    filter: &'static str,
    max_pixels: u64,
    max_side: u32,
    mipmap: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<TargetPixels>,
    thumbnail_side: u32,
    untagged: &'static str,
}

impl Options {
    fn new(target: Option<ImageTarget>) -> Result<Self> {
        let preview = target.is_some_and(|target| matches!(target.purpose, ImagePurpose::Preview));
        let target = target
            .map(|target| {
                if target.width == 0
                    || target.height == 0
                    || target.width.max(target.height) > 16384
                {
                    return Err(JobError::invalid_input("图片目标像素必须在 1–16384 范围内"));
                }
                let (width, height) = if preview {
                    let scale = 1f64
                        .min(960.0 / f64::from(target.width))
                        .min(540.0 / f64::from(target.height));
                    (
                        (f64::from(target.width) * scale).floor().max(1.0) as u32,
                        (f64::from(target.height) * scale).floor().max(1.0) as u32,
                    )
                } else {
                    (target.width, target.height)
                };
                Ok(TargetPixels {
                    fit: target.fit,
                    height,
                    width,
                })
            })
            .transpose()?;
        Ok(Self {
            alpha: "straight",
            codec: "png-rgba8",
            color_space: "sRGB-SDR",
            filter: "linear-premultiplied-area",
            max_pixels: if preview { 960 * 540 } else { 8_294_400 },
            max_side: if preview { 960 } else { 4096 },
            mipmap: false,
            target,
            thumbnail_side: 512,
            untagged: "assume-sRGB",
        })
    }

    fn canonical(&self) -> String {
        serde_json::to_string(self).expect("fixed image options serialize")
    }

    fn dimensions(&self, width: u32, height: u32) -> (u32, u32) {
        let cap_scale = 1f64
            .min(f64::from(self.max_side) / f64::from(width.max(height)))
            .min((self.max_pixels as f64 / (u64::from(width) * u64::from(height)) as f64).sqrt());
        let requested = self.target.as_ref().map_or(1.0, |target| {
            let x = f64::from(target.width) / f64::from(width);
            let y = f64::from(target.height) / f64::from(height);
            match target.fit {
                ImageFit::Cover => x.max(y),
                ImageFit::Contain => x.min(y),
            }
        });
        let scale = 1f64.min(cap_scale).min(requested);
        (
            (f64::from(width) * scale).floor().max(1.0) as u32,
            (f64::from(height) * scale).floor().max(1.0) as u32,
        )
    }
}

pub(crate) fn validate_target(target: Option<ImageTarget>) -> Result<()> {
    Options::new(target).map(|_| ())
}

/// 规划与准备共用相同像素约束，避免预览尺寸和派生键出现两套算法。
pub(crate) fn normalize_target(target: ImageTarget) -> Result<ImageTarget> {
    let pixels = Options::new(Some(target))?
        .target
        .expect("requested target");
    Ok(ImageTarget {
        width: pixels.width,
        height: pixels.height,
        ..target
    })
}

pub(crate) fn target_dimensions(
    width: u32,
    height: u32,
    target: ImageTarget,
) -> Result<(u32, u32)> {
    if width == 0 || height == 0 {
        return Err(JobError::invalid_input("媒体尺寸不能为零"));
    }
    Ok(Options::new(Some(target))?.dimensions(width, height))
}

pub(crate) use hertz_wallpaper::image_prepare::Output;

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
    lease: Option<std::sync::Arc<std::fs::File>>,
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

fn key(input_hash: &str, options: &str) -> String {
    let mut digest = Sha256::new();
    // 分隔符排除变长字段拼接歧义；options 的字段序已固定。
    for part in [input_hash, IMPORTER, PIPELINE, options] {
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
    target: Option<ImageTarget>,
    cancel: &AtomicBool,
) -> Result<PreparedImage> {
    cancelled(cancel)?;
    let options = Options::new(target)?;
    let canonical = options.canonical();
    let cache_key = key(&input.media.entry.sha256, &canonical);
    let prefix = PathBuf::from(&input.media.entry.sha256)
        .join(PIPELINE)
        .join(&cache_key);
    if let Some(image) = cached(store, library, input, target, cancel).await? {
        return Ok(image);
    }
    let estimate = workspace(
        input.metadata.encoded_width,
        input.metadata.encoded_height,
        input.media.entry.bytes,
    )?;
    let reservation = probe.image_workspace(estimate)?;
    // 同步函数返回时 decoder/像素/ICC/编码缓冲均已退出，才归还工作区。
    let result = generate(store, job, input, prefix, &options, cancel);
    reservation.finish();
    result
}

/// 只查询并核验既有不可变产物；缺失/损坏返回 None，不在 resolve/load 中生成。
pub(crate) async fn cached(
    store: &AssetStore,
    library: &Library,
    input: &DecodeInput,
    target: Option<ImageTarget>,
    cancel: &AtomicBool,
) -> Result<Option<PreparedImage>> {
    cancelled(cancel)?;
    let options = Options::new(target)?;
    let cache_key = key(&input.media.entry.sha256, &options.canonical());
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
            // 先取得目录租约再复核，GC 不能在复核与正式读之间移走这一代。
            if let Ok(lease) = derived_cache::pin(store, &relative) {
                if let Ok(receipt) = verify(&directory, input, &cache_key, &options) {
                    sqlx::query(
                        "UPDATE derived_entries SET last_used = ? WHERE cache_key = ? AND path = ?",
                    )
                    .bind(now_secs())
                    .bind(&cache_key)
                    .bind(relative.to_string_lossy().as_ref())
                    .execute(library.pool())
                    .await
                    .map_err(|error| JobError::database(error.to_string()))?;
                    cancelled(cancel)?;
                    return Ok(Some(PreparedImage {
                        receipt,
                        directory,
                        relative,
                        staged: false,
                        lease: Some(lease),
                    }));
                }
            }
        }
    }
    cancelled(cancel)?;
    Ok(None)
}

fn generate(
    store: &AssetStore,
    job: &str,
    input: &DecodeInput,
    prefix: PathBuf,
    options: &Options,
    cancel: &AtomicBool,
) -> Result<PreparedImage> {
    store.check_disk_space(2 * MAX_FILE + 16 * 1024)?;
    let relative = prefix.join(format!("gen-{}", new_job_id()));
    let directory = store.staging_dir(job).join("derived").join(&relative);
    std::fs::create_dir_all(&directory).map_err(invalid)?;
    let (pixels, orientation) = hertz_wallpaper::image_prepare::decode(
        &input.media.path,
        &input.metadata.codec,
        input.metadata.encoded_width,
        input.metadata.encoded_height,
        u64::from(input.metadata.encoded_width) * u64::from(input.metadata.encoded_height) * 24
            + 8 * 1024 * 1024,
        cancel,
    )
    .map_err(pixel_error)?;
    let (width, height) = pixels.dimensions();
    let (dw, dh) = if orientation >= 5 {
        (height, width)
    } else {
        (width, height)
    };
    let (rw, rh) = options.dimensions(dw, dh);
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
        cache_key: key(&input.media.entry.sha256, &options.canonical()),
        input_hash: input.media.entry.sha256.clone(),
        pipeline: PIPELINE.into(),
        options: options.canonical(),
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
        lease: None,
    })
}

fn pixel_error(error: hertz_wallpaper::PackageError) -> JobError {
    JobError::new(error.code, error.message)
}
fn resample(
    source: &image::RgbaImage,
    orientation: u8,
    width: u32,
    height: u32,
    cancel: &AtomicBool,
) -> Result<image::RgbaImage> {
    hertz_wallpaper::image_prepare::resample(source, orientation, width, height, cancel)
        .map_err(pixel_error)
}
pub(super) fn write_png(
    path: &Path,
    pixels: &image::RgbaImage,
    cancel: &AtomicBool,
) -> Result<Output> {
    hertz_wallpaper::image_prepare::write_png(path, pixels, cancel).map_err(pixel_error)
}
fn hash(path: &Path) -> Result<(u64, String)> {
    hertz_wallpaper::image_prepare::hash(path).map_err(pixel_error)
}
fn open(path: &Path) -> Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(path)
        .map_err(invalid)
}

fn verify(
    directory: &Path,
    input: &DecodeInput,
    cache_key: &str,
    options: &Options,
) -> Result<Receipt> {
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
        || receipt.input_hash != input.media.entry.sha256
        || receipt.pipeline != PIPELINE
        || receipt.options != options.canonical()
        || (receipt.source_width, receipt.source_height)
            != (input.metadata.encoded_width, input.metadata.encoded_height)
        || !(1..=8).contains(&receipt.orientation)
    {
        return Err(invalid("派生缓存身份不匹配"));
    }
    let (dw, dh) = if receipt.orientation >= 5 {
        (receipt.source_height, receipt.source_width)
    } else {
        (receipt.source_width, receipt.source_height)
    };
    for (name, out, expected) in [
        ("render.png", &receipt.render, options.dimensions(dw, dh)),
        (
            "thumbnail.png",
            &receipt.thumbnail,
            fit(dw, dh, 512, 512 * 512),
        ),
    ] {
        if (out.width, out.height) != expected {
            return Err(invalid("派生尺寸与目标不一致"));
        }
        let (bytes, digest) = hash(&directory.join(name))?;
        if bytes != out.bytes || digest != out.sha256 {
            return Err(invalid("派生缓存已损坏"));
        }
        let metadata = super::media::probe(&mut open(&directory.join(name))?).map_err(invalid)?;
        if metadata.codec != "png" || (metadata.encoded_width, metadata.encoded_height) != expected
        {
            return Err(invalid("派生实际尺寸与收据不一致"));
        }
    }
    Ok(receipt)
}

impl PreparedImage {
    /// Small static candidate image, made only in the original preparation slot.
    pub(crate) fn candidate_thumbnail(
        &self,
        store: &AssetStore,
        probe: &ProbeClient,
        job: &str,
        cancel: &AtomicBool,
    ) -> Result<Output> {
        let reservation = probe.image_workspace(16 * 1024 * 1024)?;
        let result = (|| {
            let source = &self.receipt.thumbnail;
            if source.width == 0
                || source.height == 0
                || source.width.max(source.height) > 512
                || source.bytes > 2 * 1024 * 1024
            {
                return Err(invalid("源缩略图超限"));
            }
            let path = self.directory.join("thumbnail.png");
            let source_pin = super::assets::open_immutable(&path)?;
            if source_pin.metadata().map_err(invalid)?.len() != source.bytes
                || hash(&path)? != (source.bytes, source.sha256.clone())
            {
                return Err(invalid("源缩略图与准备回执不符"));
            }
            let (pixels, orientation) = hertz_wallpaper::image_prepare::decode(
                &path,
                "png",
                source.width,
                source.height,
                8 * 1024 * 1024,
                cancel,
            )
            .map_err(pixel_error)?;
            let (width, height) = fit(source.width, source.height, 96, 96 * 96);
            write_png(
                &store.staging_dir(job).join("ai-thumbnail.png"),
                &resample(&pixels, orientation, width, height, cancel)?,
                cancel,
            )
        })();
        reservation.finish();
        result
    }

    pub(crate) fn content_key(&self) -> String {
        format!("{}:{}", self.receipt.cache_key, self.receipt.render.sha256)
    }
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
            self.lease.clone(),
        )?;
        if (input.metadata.encoded_width, input.metadata.encoded_height)
            != (self.receipt.render.width, self.receipt.render.height)
        {
            return Err(invalid("派生收据与实际尺寸不一致"));
        }
        Ok(input)
    }

    pub(crate) async fn publish(&mut self, store: &AssetStore, library: &Library) -> Result<()> {
        let cache = derived_cache::Writer::acquire(store)?;
        if self.staged {
            let target = store.root().join("derived").join(&self.relative);
            let required = directory_bytes(&self.directory)?;
            cache.reclaim(library, required, derived_cache::CAP).await?;
            std::fs::create_dir_all(target.parent().expect("generation parent"))
                .map_err(invalid)?;
            // 从不覆盖旧代际；旧 controller 的 contentKey/文件句柄仍指向旧字节。
            std::fs::rename(&self.directory, &target).map_err(invalid)?;
            self.directory = target;
            self.staged = false;
            self.lease = Some(derived_cache::pin(store, &self.relative)?);
        }
        sqlx::query("INSERT INTO derived_entries (cache_key, path, bytes, pipeline_version, last_used) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(cache_key) DO UPDATE SET path=excluded.path, bytes=excluded.bytes, pipeline_version=excluded.pipeline_version, last_used=excluded.last_used")
            .bind(&self.receipt.cache_key).bind(self.relative.to_string_lossy().as_ref())
            .bind(directory_bytes(&self.directory)? as i64).bind(PIPELINE).bind(now_secs())
            .execute(library.pool()).await.map_err(|error| JobError::database(error.to_string()))?;
        // 被新索引替换的旧代成为孤缓存；仍在使用的目录租约会阻止它被改名。
        cache.reclaim(library, 0, derived_cache::CAP).await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "image_prepare_tests.rs"]
mod tests;
