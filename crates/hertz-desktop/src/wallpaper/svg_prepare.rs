// SPDX-License-Identifier: MIT
//! Native static SVG preparation inside the existing import/workspace/cache owner.
//! A vector source is never given raster metadata or sent to the browser.
use super::{
    assets::{AssetStore, DecodeInput, PinnedMedia, StagedPackage},
    decode_probe::ProbeClient,
    derived_cache,
    image_prepare::{ImageFit, ImagePurpose, ImageTarget, Output},
    jobs::JobError,
    library::{now_secs, Library},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
mod cache;
mod fonts;
mod render;
mod validate;
pub(crate) const MAX_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const PIPELINE: &str = "svg-static-resvg-049-usvg-049-v1";
// A preparation-policy identity inside the original canonical options/key.
// Legacy WIP receipts without this policy cannot qualify a cache hit.
pub(crate) const CLIP_POLICY: &str = "flat-clip-subtree-v1";
pub(crate) const ADAPTER_ID: &str = "prepared-svg-png";
type Result<T> = std::result::Result<T, JobError>;
pub(crate) use fonts::FontIdentity;
pub(crate) use validate::{Facts, CLIP_SHAPES};

pub(crate) struct Input {
    pub package_hash: String,
    pub source: Arc<PinnedMedia>,
    fonts: Vec<(String, Arc<PinnedMedia>)>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Receipt {
    pub cache_key: String,
    pub input_hash: String,
    pub pipeline: String,
    pub options: String,
    pub source: Facts,
    pub fonts: Vec<FontIdentity>,
    pub prepare_cpu_bytes: u64,
    pub render: Output,
    pub thumbnail: Output,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    dpi: u32,
    languages: Vec<String>,
    target: ImageTarget,
    usage: String,
    width: u32,
    height: u32,
    color_space: String,
    alpha: String,
    mipmaps: bool,
    wrap: String,
    target_format: String,
    clip_policy: String,
}
impl Options {
    fn new(facts: &Facts, target: ImageTarget, usage: &str) -> Result<Self> {
        if !matches!(usage, "color" | "sprite") {
            return Err(error("SVG 仅用于 image.asset / particles.spriteAsset"));
        }
        let target = super::image_prepare::normalize_target(target)?;
        let (width, height) = dimensions(facts.width, facts.height, target)?;
        Ok(Self {
            dpi: 96,
            languages: vec!["en".into()],
            target,
            usage: usage.into(),
            width,
            height,
            color_space: "sRGB-SDR".into(),
            alpha: "straight".into(),
            mipmaps: false,
            wrap: "clamp".into(),
            target_format: "png-rgba8".into(),
            clip_policy: CLIP_POLICY.into(),
        })
    }
    fn canonical(&self) -> Result<String> {
        serde_json::to_string(self).map_err(error)
    }
}
pub(crate) struct PreparedSvg {
    pub receipt: Receipt,
    directory: PathBuf,
    relative: PathBuf,
    staged: bool,
    lease: Option<Arc<std::fs::File>>,
}
pub(super) fn error(e: impl std::fmt::Display) -> JobError {
    JobError::new("svg_unsupported", format!("受限 SVG：{e}"))
}
pub(super) fn limit(e: impl std::fmt::Display) -> JobError {
    JobError::new("svg_complexity_exceeded", format!("SVG 超过有界输入：{e}"))
}
fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(JobError::new("cancelled", "SVG 准备已取消并退出"))
    } else {
        Ok(())
    }
}
pub(crate) fn inspect(bytes: &[u8]) -> Result<Facts> {
    validate::validate(bytes).map(|v| v.facts)
}
pub(crate) fn dimensions(width: f64, height: f64, target: ImageTarget) -> Result<(u32, u32)> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err(error("SVG 逻辑尺寸无效"));
    }
    let t = super::image_prepare::normalize_target(target)?;
    let requested = match t.fit {
        ImageFit::Cover => (t.width as f64 / width).max(t.height as f64 / height),
        ImageFit::Contain => (t.width as f64 / width).min(t.height as f64 / height),
    };
    let (side, pixels) = if t.purpose == ImagePurpose::Preview {
        (960f64, 518400f64)
    } else {
        (4096f64, 8294400f64)
    };
    let scale = requested
        .min(side / width.max(height))
        .min((pixels / (width * height)).sqrt());
    Ok((
        (width * scale).floor().max(1.0) as u32,
        (height * scale).floor().max(1.0) as u32,
    ))
}
pub(crate) fn pin_input(
    store: &AssetStore,
    package: &StagedPackage,
    asset_id: &str,
    job: Option<&str>,
    cancel: &AtomicBool,
) -> Result<Input> {
    cancelled(cancel)?;
    let asset = package
        .manifest
        .assets
        .iter()
        .find(|a| a.id == asset_id && a.kind == hertz_wallpaper::AssetKind::Vector)
        .ok_or_else(|| error("需要同包 vector 源"))?;
    if !asset.variants.is_empty() {
        return Err(error("SVG vector variants 尚未支持"));
    }
    let entry = package
        .entries
        .iter()
        .find(|e| e.path == asset.source)
        .ok_or_else(|| error("SVG 原稿未通过固定包核验"))?;
    if entry.bytes == 0 || entry.bytes > MAX_BYTES || entry.mime.as_deref() != Some("image/svg+xml")
    {
        return Err(error("SVG MIME 或原稿字节限制无效"));
    }
    let source = store.pin_source_entry(package, entry, job, cancel)?;
    let fonts = package
        .manifest
        .assets
        .iter()
        .filter(|a| a.kind == hertz_wallpaper::AssetKind::Font)
        .map(|a| {
            let entry = package
                .entries
                .iter()
                .find(|e| e.path == a.source)
                .ok_or_else(|| error("SVG 字体不属于固定包"))?;
            Ok((
                a.id.clone(),
                store.pin_source_entry(package, entry, job, cancel)?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    cancelled(cancel)?;
    Ok(Input {
        package_hash: package.package_hash.clone(),
        source,
        fonts,
    })
}
fn key(input: &Input, options: &Options, fonts: &[FontIdentity]) -> Result<String> {
    let mut digest = Sha256::new();
    for bytes in [
        input.source.entry.sha256.as_bytes(),
        b"hertz-native-svg",
        PIPELINE.as_bytes(),
        options.canonical()?.as_bytes(),
        serde_json::to_vec(fonts).map_err(error)?.as_slice(),
    ] {
        digest.update(bytes);
        digest.update([0]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn read(input: &Input, cancel: &AtomicBool) -> Result<Vec<u8>> {
    cancelled(cancel)?;
    let mut bytes = Vec::new();
    super::assets::open_immutable(&input.source.path)?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() as u64 != input.source.entry.bytes
        || format!("{:x}", Sha256::digest(&bytes)) != input.source.entry.sha256
    {
        return Err(JobError::new("hash_mismatch", "SVG 固定源字节变化"));
    }
    cancelled(cancel)?;
    Ok(bytes)
}
/// A fixed upper reservation is obtained before parsing/copying/loading fonts.
/// The actual conservative proof is checked before entering synchronous render.
#[allow(clippy::too_many_arguments)] // Original job, storage and workspace owners are explicit.
pub(crate) async fn prepare(
    store: &AssetStore,
    library: &Library,
    probe: &ProbeClient,
    job: &str,
    input: &Input,
    target: ImageTarget,
    usage: &str,
    cancel: &AtomicBool,
) -> Result<PreparedSvg> {
    cancelled(cancel)?;
    let preflight = input
        .fonts
        .iter()
        .try_fold(64 * 1024 * 1024u64, |total, (_, font)| {
            total
                .checked_add(
                    font.entry
                        .bytes
                        .checked_mul(5)
                        .and_then(|v| v.checked_add(8 * 1024 * 1024))
                        .ok_or_else(|| limit("SVG 字体工作区溢出"))?,
                )
                .ok_or_else(|| limit("SVG 字体工作区溢出"))
        })?;
    if preflight > super::budget::MAX_PREPARE_CPU_BYTES {
        return Err(JobError::new(
            "probe_budget_exceeded",
            "SVG 字体闭包超过 320 MiB 前置工作区",
        ));
    }
    let reservation = probe.image_workspace(super::budget::MAX_PREPARE_CPU_BYTES)?;
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    probe.svg_event_for_test("workspace_reserved", Some(&input.source.entry.sha256));
    let result = async {
        let bytes = read(input, cancel)?;
        let svg = validate::validate(&bytes)?;
        let fonts = fonts::load(input, &svg, cancel)?;
        let options = Options::new(&svg.facts, target, usage)?;
        let cache_key = key(input, &options, &fonts.identities)?;
        if let Some(cached) = cache::cached(
            store,
            library,
            input,
            &svg.facts,
            &fonts.identities,
            &options,
            &cache_key,
            cancel,
        )
        .await?
        {
            return Ok(cached);
        }
        render::generate(
            store, job, input, svg, fonts, options, cache_key, probe, cancel,
        )
    }
    .await;
    // Dropping all parser/render work precedes returning workspace and the job slot.
    reservation.finish();
    #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
    probe.svg_event_for_test("workspace_finished", None);
    result
}
impl PreparedSvg {
    pub(crate) fn content_key(&self) -> String {
        format!("{}:{}", self.receipt.cache_key, self.receipt.render.sha256)
    }
    pub(crate) fn decode_input(&self, store: &AssetStore, input: &Input) -> Result<DecodeInput> {
        let decoded = store.pin_svg_png(
            &input.package_hash,
            &input.source,
            self.directory.join("render.png"),
            hertz_wallpaper::VerifiedEntry {
                path: format!("prepared/{}/render.png", self.receipt.cache_key),
                bytes: self.receipt.render.bytes,
                sha256: self.receipt.render.sha256.clone(),
                mime: Some("image/png".into()),
            },
            self.lease.clone(),
        )?;
        if (
            decoded.metadata.encoded_width,
            decoded.metadata.encoded_height,
        ) != (self.receipt.render.width, self.receipt.render.height)
        {
            return Err(error("SVG PNG 尺寸与收据不一致"));
        }
        Ok(decoded)
    }
    pub(crate) async fn publish(&mut self, store: &AssetStore, library: &Library) -> Result<()> {
        let cache = derived_cache::Writer::acquire(store)?;
        if self.staged {
            let target = store.root().join("derived").join(&self.relative);
            cache
                .reclaim(
                    library,
                    derived_cache::directory_bytes(&self.directory)?,
                    derived_cache::CAP,
                )
                .await?;
            std::fs::create_dir_all(target.parent().expect("SVG generation parent"))
                .map_err(error)?;
            std::fs::rename(&self.directory, &target).map_err(error)?;
            self.directory = target;
            self.staged = false;
            self.lease = Some(derived_cache::pin(store, &self.relative)?);
        }
        sqlx::query("INSERT INTO derived_entries (cache_key,path,bytes,pipeline_version,last_used) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(cache_key) DO UPDATE SET path=excluded.path,bytes=excluded.bytes,pipeline_version=excluded.pipeline_version,last_used=excluded.last_used")
            .bind(&self.receipt.cache_key).bind(self.relative.to_string_lossy().as_ref()).bind(derived_cache::directory_bytes(&self.directory)? as i64).bind(PIPELINE).bind(now_secs()).execute(library.pool()).await.map_err(error)?;
        cache.reclaim(library, 0, derived_cache::CAP).await?;
        Ok(())
    }
}
#[cfg(test)]
#[path = "svg_prepare_tests.rs"]
mod tests;
