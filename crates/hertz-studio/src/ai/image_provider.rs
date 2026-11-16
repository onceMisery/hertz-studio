// SPDX-License-Identifier: MIT
//! Image-only input and file output. No text completion, runner or ledger here.
use super::{
    credential::ProviderCredential,
    jobs::{ProviderCancellation, WallpaperOutputError},
    pricing::{Dimension, ImageSku, PriceDimension, UsageDimension, METERED_V2},
    usage::{PriceQuote, PricingSnapshot, TrustedUsage},
};
use hertz_wallpaper::generation::{WallpaperGenerateRequest, WallpaperGenerationKind};
use std::{future::Future, path::PathBuf, pin::Pin, sync::Arc};

pub(crate) struct Input {
    pub brief: String,
    pub sku: ImageSku,
    pub(super) workspace: Option<Arc<super::wallpaper_artifacts::ImageWorkspace>>,
}
impl Input {
    pub(super) fn from_request(request: &WallpaperGenerateRequest) -> Result<Self, String> {
        request.validate().map_err(|e| e.message)?;
        if request.output.kind != WallpaperGenerationKind::Image {
            return Err("image provider requires image input".into());
        }
        Ok(Self {
            brief: request.brief.clone(),
            workspace: None,
            sku: ImageSku {
                width: request.output.width.ok_or("missing image width")?,
                height: request.output.height.ok_or("missing image height")?,
                quality_id: request
                    .output
                    .quality_id
                    .clone()
                    .ok_or("missing image quality")?,
            },
        })
    }
}

/// An owned temporary file. The actual I/O owner retains it even when its
/// observer is cancelled, then removes only its own fixed file and directory.
pub(crate) struct ImageFile {
    pub(super) workspace: Arc<super::wallpaper_artifacts::ImageWorkspace>,
    name: &'static str,
}
impl ImageFile {
    #[cfg(test)]
    pub(super) fn create() -> std::io::Result<Self> {
        Ok(Self::in_workspace(
            super::wallpaper_artifacts::ImageWorkspace::isolated()?,
            "image.part",
        ))
    }
    fn in_workspace(
        workspace: Arc<super::wallpaper_artifacts::ImageWorkspace>,
        name: &'static str,
    ) -> Self {
        Self { workspace, name }
    }
    pub(super) fn path(&self) -> PathBuf {
        self.workspace.directory.join(self.name)
    }
    pub(super) fn open(&self) -> std::io::Result<std::fs::File> {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.path())
    }
}
impl Drop for ImageFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.path());
    }
}

pub(crate) struct Reply {
    pub output: Result<ImageFile, WallpaperOutputError>,
    pub usage: Option<TrustedUsage>,
}
pub(crate) trait ImageProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn model(&self) -> &str;
    fn ready(&self) -> bool;
    fn diagnostic(&self) -> Option<&'static str> {
        None
    }
    fn endpoint_identity(&self) -> Option<&str> {
        None
    }
    fn requires_credential(&self) -> bool {
        false
    }
    fn quote(&self, input: &Input) -> Result<PriceQuote, String>;
    fn generate(
        &self,
        input: Input,
        pricing: PricingSnapshot,
        credential: Option<ProviderCredential>,
        cancellation: ProviderCancellation,
    ) -> Pin<Box<dyn Future<Output = Reply> + Send>>;
}

pub(super) fn configured(config: &crate::config::ImageConfig) -> Arc<dyn ImageProvider> {
    if config.provider == "fake" && config.model == "fixture-image-v1" {
        Arc::new(Fixture)
    } else {
        Arc::new(Unavailable)
    }
}
struct Unavailable;
impl ImageProvider for Unavailable {
    fn id(&self) -> &'static str {
        "unavailable"
    }
    fn model(&self) -> &str {
        ""
    }
    fn ready(&self) -> bool {
        false
    }
    fn diagnostic(&self) -> Option<&'static str> {
        Some("图像模型尚未完成型号、规格、价格与响应资格验证")
    }
    fn quote(&self, _: &Input) -> Result<PriceQuote, String> {
        Err("image provider is not qualified".into())
    }
    fn generate(
        &self,
        _: Input,
        _: PricingSnapshot,
        _: Option<ProviderCredential>,
        _: ProviderCancellation,
    ) -> Pin<Box<dyn Future<Output = Reply> + Send>> {
        Box::pin(async {
            Reply {
                output: Err("image provider is not qualified".into()),
                usage: None,
            }
        })
    }
}

pub(super) const FIXTURE_SIZES: [(u32, u32); 3] = [(1024, 1024), (1536, 1024), (1024, 1536)];
pub(super) const FIXTURE_QUALITY: &str = "fixture";
pub(super) struct Fixture;
impl ImageProvider for Fixture {
    fn id(&self) -> &'static str {
        "fake-image"
    }
    fn model(&self) -> &str {
        "fixture-image-v1"
    }
    fn ready(&self) -> bool {
        true
    }
    fn quote(&self, input: &Input) -> Result<PriceQuote, String> {
        if input.brief.trim().is_empty()
            || input.brief.len() > 4096
            || !FIXTURE_SIZES.contains(&(input.sku.width, input.sku.height))
            || input.sku.quality_id != FIXTURE_QUALITY
        {
            return Err("unsupported offline image fixture SKU".into());
        }
        Ok(PriceQuote {
            pricing_version: METERED_V2.into(),
            reservation_micro_usd: 0,
            input_micro_usd_per_million: 0,
            output_micro_usd_per_million: 0,
            max_input_tokens: 0,
            max_output_tokens: 0,
            metering: Some([
                PriceDimension {
                    dimension: Dimension::InputTokens,
                    quantity_limit: 0,
                    unit_price_micro_usd: 0,
                    unit_scale: 1,
                    image_sku: None,
                },
                PriceDimension {
                    dimension: Dimension::OutputTokens,
                    quantity_limit: 0,
                    unit_price_micro_usd: 0,
                    unit_scale: 1,
                    image_sku: None,
                },
                PriceDimension {
                    dimension: Dimension::ImageOutput,
                    quantity_limit: 1,
                    unit_price_micro_usd: 0,
                    unit_scale: 1,
                    image_sku: Some(input.sku.clone()),
                },
            ]),
        })
    }
    fn generate(
        &self,
        input: Input,
        pricing: PricingSnapshot,
        _: Option<ProviderCredential>,
        mut cancellation: ProviderCancellation,
    ) -> Pin<Box<dyn Future<Output = Reply> + Send>> {
        Box::pin(async move {
            if Fixture.quote(&input).is_err()
                || pricing.provider != "fake-image"
                || pricing.model != "fixture-image-v1"
                || Fixture.quote(&input).ok().as_ref() != Some(&pricing.quote)
            {
                return Reply {
                    output: Err(WallpaperOutputError::Rejected),
                    usage: None,
                };
            }
            if cancellation.is_cancelled() {
                return Reply {
                    output: Err("image fixture cancelled".into()),
                    usage: None,
                };
            }
            let Some(workspace) = input.workspace else {
                return Reply {
                    output: Err("image workspace missing".into()),
                    usage: None,
                };
            };
            // Fixture writes rows, without a full image/base64/JSON allocation.
            // Jobs awaits actual completion before giving its execution slot back.
            let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let worker_cancel = cancel.clone();
            let sku = input.sku.clone();
            let mut task =
                tokio::task::spawn_blocking(move || fixture_file(&sku, workspace, &worker_cancel));
            let result = tokio::select! {
                result=&mut task=>result,
                _=cancellation.cancelled()=> { cancel.store(true,std::sync::atomic::Ordering::Release); task.await }
            };
            let output = result
                .map_err(|_| WallpaperOutputError::Provider("image fixture task failed".into()))
                .and_then(|v| v.map_err(|_| WallpaperOutputError::Rejected));
            let usage = TrustedUsage {
                input_tokens: 0,
                output_tokens: 0,
                metering: Some([
                    UsageDimension {
                        dimension: Dimension::InputTokens,
                        quantity: 0,
                        image_sku: None,
                    },
                    UsageDimension {
                        dimension: Dimension::OutputTokens,
                        quantity: 0,
                        image_sku: None,
                    },
                    UsageDimension {
                        dimension: Dimension::ImageOutput,
                        quantity: u64::from(output.is_ok()),
                        image_sku: Some(input.sku),
                    },
                ]),
            };
            Reply {
                output,
                usage: Some(usage),
            }
        })
    }
}
fn fixture_file(
    sku: &ImageSku,
    workspace: Arc<super::wallpaper_artifacts::ImageWorkspace>,
    cancel: &Arc<std::sync::atomic::AtomicBool>,
) -> std::io::Result<ImageFile> {
    let generated = ImageFile::in_workspace(workspace.clone(), "source.part");
    write_fixture(generated.open()?, sku, cancel)?;
    let wire = ImageFile::in_workspace(workspace.clone(), "wire.part");
    let mut encoder =
        base64::write::EncoderWriter::new(wire.open()?, &base64::engine::general_purpose::STANDARD);
    std::io::copy(&mut std::fs::File::open(generated.path())?, &mut encoder)?;
    encoder.finish()?.sync_all()?;
    let output = ImageFile::in_workspace(workspace, "image.part");
    super::image_wire::base64_file(
        std::fs::File::open(wire.path())?,
        &mut output.open()?,
        cancel.clone(),
    )?;
    Ok(output)
}
fn write_fixture(
    mut file: std::fs::File,
    sku: &ImageSku,
    cancel: &std::sync::atomic::AtomicBool,
) -> std::io::Result<()> {
    let mut encoder = png::Encoder::new(&mut file, sku.width, sku.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
    let mut writer = encoder.write_header()?;
    let mut stream = writer.stream_writer()?;
    use std::io::Write;
    let mut row = vec![0u8; sku.width as usize * 4];
    for y in 0..sku.height {
        if cancel.load(std::sync::atomic::Ordering::Acquire) {
            return Err(std::io::Error::other("cancelled"));
        }
        for (x, pixel) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            // Deliberately recognizable diagnostic grid, not model output.
            let grid = (x as u32 / 64 + y / 64) % 2;
            pixel.copy_from_slice(&[
                24 + grid as u8 * 20,
                36 + (y * 80 / sku.height) as u8,
                54 + (x as u32 * 80 / sku.width) as u8,
                255,
            ]);
        }
        stream.write_all(&row)?;
    }
    stream.finish()?;
    writer.finish()?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    fn input() -> Input {
        Input {
            brief: "离线图片夹具".into(),
            workspace: Some(super::super::wallpaper_artifacts::ImageWorkspace::isolated().unwrap()),
            sku: ImageSku {
                width: 1024,
                height: 1024,
                quality_id: "fixture".into(),
            },
        }
    }
    #[test]
    fn image_selection_is_explicit_and_rejects_unqualified_models_and_skus() {
        assert!(!configured(&crate::config::ImageConfig::default()).ready());
        assert!(!configured(&crate::config::ImageConfig {
            provider: "openai".into(),
            model: "text-model".into()
        })
        .ready());
        assert!(!configured(&crate::config::ImageConfig {
            provider: "fake".into(),
            model: String::new()
        })
        .ready());
        let quote = Fixture.quote(&input()).unwrap();
        quote.validate().unwrap();
        assert_eq!(quote.reservation_micro_usd, 0);
        assert_eq!(quote.metering.unwrap()[2].quantity_limit, 1);
        let mut wrong = input();
        wrong.sku.quality_id = "high".into();
        assert!(Fixture.quote(&wrong).is_err());
        wrong = input();
        wrong.sku.width = 4096;
        wrong.sku.height = 2048;
        assert!(Fixture.quote(&wrong).is_err());
    }
    #[tokio::test]
    async fn fixture_delivers_file_and_full_usage_and_cleans_owned_temporary() {
        let quote = Fixture.quote(&input()).unwrap();
        let pricing = PricingSnapshot {
            provider: Fixture.id().into(),
            model: Fixture.model().into(),
            quote,
            credential: None,
        };
        let reply = Fixture
            .generate(
                input(),
                pricing.clone(),
                None,
                ProviderCancellation::default(),
            )
            .await;
        let file = reply.output.unwrap();
        let path = file.path();
        assert!(path.is_file());
        assert_eq!(pricing.quote.amount(&reply.usage.unwrap()).unwrap(), 0);
        let output = ImageFile::create().unwrap();
        let receipt = crate::ai::image_prepare::prepare(
            &path,
            &output.path(),
            (1024, 1024),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!((receipt.width, receipt.height), (1024, 1024));
        assert!(receipt.bytes > 0);
        assert!(receipt.bytes < 32 * 1024 * 1024);
        assert_eq!(
            hertz_wallpaper::image_prepare::hash(&output.path()).unwrap(),
            (receipt.bytes, receipt.sha256)
        );
        assert_eq!(
            crate::ai::image_prepare::prepare(
                &path,
                &output.path(),
                (1536, 1024),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
            "image_sku_mismatch"
        );
        drop(file);
        assert!(!path.exists());
    }
    #[test]
    fn spoofed_animated_sparse_and_workspace_bombs_are_rejected() {
        use std::io::Write;
        let source = ImageFile::create().unwrap();
        source
            .open()
            .unwrap()
            .write_all(b"<svg><script>bad</script></svg>")
            .unwrap();
        let target = ImageFile::create().unwrap();
        assert!(crate::ai::image_prepare::prepare(
            &source.path(),
            &target.path(),
            (1, 1),
            &AtomicBool::new(false)
        )
        .is_err());
        std::fs::OpenOptions::new()
            .write(true)
            .open(source.path())
            .unwrap()
            .set_len(32 * 1024 * 1024 + 1)
            .unwrap();
        assert_eq!(
            crate::ai::image_prepare::prepare(
                &source.path(),
                &target.path(),
                (1, 1),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
            "image_bounds"
        );
        std::fs::remove_file(source.path()).unwrap();
        let mut encoder = png::Encoder::new(source.open().unwrap(), 4096, 2048);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let mut stream = writer.stream_writer().unwrap();
        for _ in 0..2048 {
            stream.write_all(&[0u8; 4096]).unwrap();
        }
        stream.finish().unwrap();
        writer.finish().unwrap();
        assert_eq!(
            crate::ai::image_prepare::prepare(
                &source.path(),
                &target.path(),
                (4096, 2048),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
            "image_workspace_exceeded"
        );
        std::fs::remove_file(source.path()).unwrap();
        let mut encoder = png::Encoder::new(source.open().unwrap(), 1, 1);
        encoder.set_animated(2, 1).unwrap();
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[128]).unwrap();
        writer.write_image_data(&[64]).unwrap();
        writer.finish().unwrap();
        assert!(crate::ai::image_prepare::prepare(
            &source.path(),
            &target.path(),
            (1, 1),
            &AtomicBool::new(false)
        )
        .is_err());
    }
}
