// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Optional static covers captured by the existing qualification decoder. Immutable generations,
//! disk accounting and leases belong to AssetStore's shared derived cache. Browsing never decodes
//! a video or starts preparation; a missing cover is rebuilt on the next explicit preparation.

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageDecoder, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    assets::{AssetStore, DecodeInput},
    decode_probe::ProbeClient,
    derived_cache,
    jobs::{new_job_id, JobError},
    library::{now_secs, Library},
};

type Result<T> = std::result::Result<T, JobError>;
const PIPELINE: &str = "video-poster-v1";
const SIDE: u32 = 320;
const BYTE_LIMIT: usize = 24 * 1024;
pub(super) const ENCODED_LIMIT: usize = 32 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Poster {
    pub width: u32,
    pub height: u32,
    pub data: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    input_hash: String,
    cache_key: String,
    pipeline: String,
    sha256: String,
    source_width: u32,
    source_height: u32,
    width: u32,
    height: u32,
}

pub(crate) struct PreparedPoster {
    receipt: Receipt,
    directory: PathBuf,
    relative: PathBuf,
    staged: bool,
    _lease: Option<Arc<std::fs::File>>,
    poster: Poster,
}

fn invalid(error: impl std::fmt::Display) -> JobError {
    JobError::new("poster_invalid", format!("视频封面：{error}"))
}

fn dimensions(width: u32, height: u32) -> (u32, u32) {
    let scale = 1f64.min(f64::from(SIDE) / f64::from(width.max(height)));
    (
        (f64::from(width) * scale).floor().max(1.0) as u32,
        (f64::from(height) * scale).floor().max(1.0) as u32,
    )
}

fn key(input_hash: &str) -> String {
    let mut digest = Sha256::new();
    for part in [
        input_hash.as_bytes(),
        PIPELINE.as_bytes(),
        include_bytes!("../../assets/wallpaper-probe.js"),
    ] {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part);
    }
    format!("{:x}", digest.finalize())
}

fn validate(bytes: &[u8], expected: (u32, u32)) -> Result<()> {
    if bytes.is_empty()
        || bytes.len() > BYTE_LIMIT
        || expected.0 == 0
        || expected.1 == 0
        || expected.0.max(expected.1) > SIDE
    {
        return Err(invalid("图片字节或尺寸超限"));
    }
    if image::guess_format(bytes).map_err(invalid)? != ImageFormat::Jpeg {
        return Err(invalid("封面必须是 JPEG"));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(SIDE);
    limits.max_image_height = Some(SIDE);
    limits.max_alloc = Some(2 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), ImageFormat::Jpeg);
    reader.limits(limits);
    let decoder = reader.into_decoder().map_err(invalid)?;
    if decoder.dimensions() != expected {
        return Err(invalid("图片尺寸不匹配"));
    }
    // Header checks cannot prove that the compressed pixels are valid.
    image::DynamicImage::from_decoder(decoder).map_err(invalid)?;
    Ok(())
}

fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .custom_flags(0x0020_0000)
        .open(path)
        .map_err(invalid)?;
    let metadata = file.metadata().map_err(invalid)?;
    if !metadata.is_file()
        || metadata.file_attributes() & 0x400 != 0
        || metadata.len() > limit as u64
    {
        return Err(invalid("文件大小或类型无效"));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(invalid)?;
    if bytes.len() > limit {
        return Err(invalid("文件超限"));
    }
    Ok(bytes)
}

async fn cached(
    store: &AssetStore,
    library: &Library,
    input_hash: &str,
) -> Result<Option<PreparedPoster>> {
    let cache_key = key(input_hash);
    let prefix = PathBuf::from(input_hash).join(PIPELINE).join(&cache_key);
    let row: Option<(String,)> =
        sqlx::query_as("SELECT path FROM derived_entries WHERE cache_key = ?")
            .bind(&cache_key)
            .fetch_optional(library.pool())
            .await
            .map_err(|error| JobError::database(error.to_string()))?;
    let Some((path,)) = row else {
        return Ok(None);
    };
    let relative = PathBuf::from(path);
    if relative.parent() != Some(prefix.as_path()) {
        return Ok(None);
    }
    let verified = (|| {
        let lease = derived_cache::pin(store, &relative)?;
        let directory = store.root().join("derived").join(&relative);
        let receipt: Receipt =
            serde_json::from_slice(&read_bounded(&directory.join("receipt.json"), 2048)?)
                .map_err(invalid)?;
        if receipt.input_hash != input_hash
            || receipt.cache_key != cache_key
            || receipt.pipeline != PIPELINE
            || receipt.source_width == 0
            || receipt.source_height == 0
            || (receipt.width, receipt.height)
                != dimensions(receipt.source_width, receipt.source_height)
        {
            return Err(invalid("缓存身份不匹配"));
        }
        let bytes = read_bounded(&directory.join("poster.jpg"), BYTE_LIMIT)?;
        if format!("{:x}", Sha256::digest(&bytes)) != receipt.sha256 {
            return Err(invalid("缓存已损坏"));
        }
        validate(&bytes, (receipt.width, receipt.height))?;
        let poster = Poster {
            width: receipt.width,
            height: receipt.height,
            data: STANDARD.encode(bytes),
        };
        Ok(PreparedPoster {
            receipt,
            directory,
            relative,
            staged: false,
            _lease: Some(lease),
            poster,
        })
    })();
    let Ok(poster) = verified else {
        return Ok(None);
    };
    sqlx::query("UPDATE derived_entries SET last_used = ? WHERE cache_key = ? AND path = ?")
        .bind(now_secs())
        .bind(cache_key)
        .bind(poster.relative.to_string_lossy().as_ref())
        .execute(library.pool())
        .await
        .map_err(|error| JobError::database(error.to_string()))?;
    Ok(Some(poster))
}

fn stage(
    store: &AssetStore,
    job: &str,
    input: &DecodeInput,
    encoded: String,
) -> Result<PreparedPoster> {
    if encoded.len() > ENCODED_LIMIT {
        return Err(invalid("回执超限"));
    }
    let bytes = STANDARD.decode(&encoded).map_err(invalid)?;
    let (width, height) = dimensions(input.metadata.display_width, input.metadata.display_height);
    validate(&bytes, (width, height))?;
    store.check_disk_space((BYTE_LIMIT + 2048) as u64)?;
    let input_hash = input.media.entry.sha256.clone();
    let cache_key = key(&input_hash);
    let relative = PathBuf::from(&input_hash)
        .join(PIPELINE)
        .join(&cache_key)
        .join(format!("gen-{}", new_job_id()));
    let directory = store.staging_dir(job).join("derived").join(&relative);
    let receipt = Receipt {
        input_hash,
        cache_key,
        pipeline: PIPELINE.into(),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        source_width: input.metadata.display_width,
        source_height: input.metadata.display_height,
        width,
        height,
    };
    std::fs::create_dir_all(&directory).map_err(invalid)?;
    for (name, bytes) in [
        ("poster.jpg", bytes),
        (
            "receipt.json",
            serde_json::to_vec(&receipt).map_err(invalid)?,
        ),
    ] {
        let mut file = std::fs::File::create(directory.join(name)).map_err(invalid)?;
        file.write_all(&bytes).map_err(invalid)?;
        file.sync_all().map_err(invalid)?;
    }
    Ok(PreparedPoster {
        receipt,
        directory,
        relative,
        staged: true,
        _lease: None,
        poster: Poster {
            width,
            height,
            data: encoded,
        },
    })
}

/// Decode qualification is required; cover creation is optional. Both share the one prepare job.
pub(crate) async fn prepare(
    store: &AssetStore,
    library: &Library,
    probe: &ProbeClient,
    job: &str,
    input: DecodeInput,
    cancel: Arc<AtomicBool>,
) -> Result<Option<PreparedPoster>> {
    let existing = cached(store, library, &input.media.entry.sha256)
        .await
        .unwrap_or(None)
        .filter(|poster| {
            (poster.receipt.source_width, poster.receipt.source_height)
                == (input.metadata.display_width, input.metadata.display_height)
        });
    let encoded = probe
        .qualify_with_poster(
            library,
            input.clone(),
            Arc::clone(&cancel),
            existing.is_none(),
        )
        .await?;
    if cancel.load(Ordering::Acquire) {
        return Err(JobError::new("cancelled", "视频准备已取消"));
    }
    if existing.is_some() {
        return Ok(existing);
    }
    Ok(
        encoded.and_then(|encoded| match stage(store, job, &input, encoded) {
            Ok(poster) => Some(poster),
            Err(error) => {
                crate::app::log(&format!("optional video poster skipped: {error}"));
                None
            }
        }),
    )
}

impl PreparedPoster {
    async fn publish(&mut self, store: &AssetStore, library: &Library) -> Result<()> {
        if !self.staged {
            return Ok(());
        }
        let cache = derived_cache::Writer::acquire(store)?;
        let required = derived_cache::directory_bytes(&self.directory)?;
        cache.reclaim(library, required, derived_cache::CAP).await?;
        let target = store.root().join("derived").join(&self.relative);
        std::fs::create_dir_all(target.parent().expect("generation parent")).map_err(invalid)?;
        std::fs::rename(&self.directory, &target).map_err(invalid)?;
        self.directory = target;
        self.staged = false;
        self._lease = Some(derived_cache::pin(store, &self.relative)?);
        sqlx::query("INSERT INTO derived_entries (cache_key, path, bytes, pipeline_version, last_used) VALUES (?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET path=excluded.path, bytes=excluded.bytes, pipeline_version=excluded.pipeline_version, last_used=excluded.last_used")
            .bind(&self.receipt.cache_key).bind(self.relative.to_string_lossy().as_ref())
            .bind(required as i64).bind(PIPELINE).bind(now_secs()).execute(library.pool()).await
            .map_err(|error| JobError::database(error.to_string()))?;
        cache.reclaim(library, 0, derived_cache::CAP).await?;
        Ok(())
    }

    pub(crate) async fn publish_optional(&mut self, store: &AssetStore, library: &Library) {
        if let Err(error) = self.publish(store, library).await {
            crate::app::log(&format!(
                "optional video poster publication skipped: {error}"
            ));
        }
    }
}

/// Called on a bounded blocking reader. Only installed metadata selects cache content;
/// a library cover must not scan/decompress a potentially GiB-sized video archive.
pub(crate) async fn read(
    store: &AssetStore,
    library: &Library,
    work: &str,
    hash: &str,
) -> Result<Option<Poster>> {
    let manifest = library.cover_manifest(work, hash).await?;
    let hertz_wallpaper::manifest::Content::Video { asset } = &manifest.content else {
        return Ok(None);
    };
    let source = manifest
        .assets
        .iter()
        .find(|item| &item.id == asset)
        .and_then(|item| manifest.file(&item.source))
        .ok_or_else(|| invalid("视频资源缺失"))?;
    Ok(cached(store, library, &source.sha256)
        .await?
        .map(|poster| poster.poster))
}

/// Pin compressed poster bytes during the existing blocking selection, before playback begins.
/// It gets its own image budget and file scope only if the native host later presents it.
pub(super) async fn resolve_for_media(
    store: &AssetStore,
    library: &Library,
    reference: &super::target_planner::AssetRef,
    source: &DecodeInput,
    target: super::image_prepare::ImageTarget,
) -> Result<Option<super::target_planner::ResolvedMedia>> {
    let Some(poster) = cached(store, library, &source.media.entry.sha256).await? else {
        return Ok(None);
    };
    if (poster.receipt.source_width, poster.receipt.source_height)
        != (
            source.metadata.display_width,
            source.metadata.display_height,
        )
    {
        return Ok(None);
    }
    resolve_cached(store, reference, poster, target).map(Some)
}

fn resolve_cached(
    store: &AssetStore,
    reference: &super::target_planner::AssetRef,
    poster: PreparedPoster,
    target: super::image_prepare::ImageTarget,
) -> Result<super::target_planner::ResolvedMedia> {
    let input = store.pin_poster(
        &reference.package_hash,
        poster.directory.join("poster.jpg"),
        hertz_wallpaper::VerifiedEntry {
            path: format!("prepared/{}/poster.jpg", poster.receipt.cache_key),
            bytes: STANDARD.decode(&poster.poster.data).map_err(invalid)?.len() as u64,
            sha256: poster.receipt.sha256.clone(),
            mime: Some("image/jpeg".into()),
        },
        poster
            ._lease
            .clone()
            .ok_or_else(|| invalid("封面尚未发布"))?,
    )?;
    super::target_planner::ResolvedMedia::from_input(
        reference.clone(),
        input,
        format!("{}:{}", poster.receipt.cache_key, poster.receipt.sha256),
        target,
    )
}

/// Used only after selection failed. A retained installation record can identify an independent
/// cached cover, but cannot make the missing/corrupt video playable or satisfy an Apply request.
pub(super) async fn resolve_recorded(
    store: &AssetStore,
    library: &Library,
    request: &super::selection_plan::Request,
) -> Result<Option<super::target_planner::ResolvedMedia>> {
    request.validate()?;
    let manifest = library
        .cover_manifest(&request.work_key, &request.package_hash)
        .await?;
    let content = hertz_wallpaper::properties::effective_content(&manifest, &request.properties)
        .map_err(super::public_properties::property_error)?;
    let hertz_wallpaper::Content::Video { asset } = &content else {
        return Ok(None);
    };
    let source = manifest
        .assets
        .iter()
        .find(|item| &item.id == asset)
        .and_then(|item| manifest.file(&item.source))
        .ok_or_else(|| invalid("视频资源缺失"))?;
    let Some(poster) = cached(store, library, &source.sha256).await? else {
        return Ok(None);
    };
    resolve_cached(
        store,
        &super::target_planner::AssetRef {
            package_hash: request.package_hash.clone(),
            asset_id: asset.clone(),
            variant_id: None,
        },
        poster,
        request.target,
    )
    .map(Some)
}

#[cfg(test)]
pub(super) fn test_frame(metadata: &super::media::MediaProbe) -> Option<String> {
    let (width, height) = dimensions(metadata.display_width, metadata.display_height);
    let pixels = image::RgbImage::from_pixel(width, height, image::Rgb([37, 96, 128]));
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut bytes)
        .encode_image(&pixels)
        .ok()?;
    Some(STANDARD.encode(bytes))
}

#[cfg(test)]
#[path = "video_poster_tests.rs"]
mod tests;
