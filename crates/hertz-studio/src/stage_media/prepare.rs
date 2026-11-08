// SPDX-License-Identifier: MIT
//! All potentially expensive native media work runs on a bounded, single blocking worker.
use super::*;
use image::{ImageDecoder, ImageEncoder};
use std::io::{BufReader, Read, Write};

pub(super) struct Prepared {
    pub asset_id: String,
    pub metadata: Value,
    pub image: Option<PathBuf>,
}

pub(super) fn hash_file(path: &Path, cancel: &AtomicBool, deadline: i64) -> ApiResult<String> {
    let mut file = std::fs::File::open(path).map_err(io)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; CHUNK_BYTES];
    loop {
        if cancel.load(Ordering::Acquire) || now() > deadline {
            return Err(error("stage_cancelled", "导入已取消或超时"));
        }
        let len = file.read(&mut buffer).map_err(io)?;
        if len == 0 {
            break;
        }
        hash.update(&buffer[..len]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub(super) fn validate(
    source: &Path,
    input: &Begin,
    cancel: &AtomicBool,
    deadline: i64,
) -> ApiResult<Prepared> {
    let asset_id = hash_file(source, cancel, deadline)?;
    let probe = hertz_wallpaper::media::probe(&mut std::fs::File::open(source).map_err(io)?)
        .map_err(|e| bad_request(e.to_string()))?;
    let is_image = probe.container == hertz_wallpaper::media::Container::Image;
    if is_image != (input.media == "image") {
        return Err(bad_request("文件实际格式与所选媒体类型不符"));
    }
    if is_image {
        if !matches!(probe.codec.as_str(), "png" | "jpeg" | "webp") {
            return Err(bad_request("仅支持 PNG、JPEG 和静态 WebP 图片"));
        }
        if u64::from(probe.encoded_width) * u64::from(probe.encoded_height) > 64_000_000 {
            return Err(bad_request("原图超过 64 MP 解码预算"));
        }
    } else if !((probe.container == hertz_wallpaper::media::Container::Mp4
        && matches!(probe.codec.as_str(), "avc1" | "avc3"))
        || (probe.container == hertz_wallpaper::media::Container::Webm
            && matches!(probe.codec.as_str(), "V_VP8" | "V_VP9")))
        || u64::from(probe.encoded_width) * u64::from(probe.encoded_height) > 1920 * 1088
        || probe.encoded_width.max(probe.encoded_height) > 1920
        || !probe
            .fps_upper_bound
            .is_some_and(|fps| fps > 0.0 && fps <= 60.0)
    {
        return Err(bad_request("视频须为 H.264 MP4 或 VP8/VP9 WebM，编码尺寸不超过 1920×1088、单边不超过 1920、最高 60 fps；不做转码"));
    }
    if cancel.load(Ordering::Acquire) || now() > deadline {
        return Err(error("stage_cancelled", "导入已取消或超时"));
    }
    let prepared = if is_image {
        let output = source.with_file_name("prepared.png");
        image(
            source,
            &output,
            input.width.div_ceil(256) * 256,
            input.height.div_ceil(256) * 256,
        )?;
        Some(output)
    } else {
        None
    };
    Ok(Prepared {
        asset_id,
        metadata: serde_json::to_value(probe).map_err(io)?,
        image: prepared,
    })
}

pub(super) fn image(source: &Path, output: &Path, target_w: u32, target_h: u32) -> ApiResult<()> {
    // Native decoder allocation and dimensions are bounded before decoding any pixel buffer.
    let mut reader =
        image::ImageReader::new(BufReader::new(std::fs::File::open(source).map_err(io)?))
            .with_guessed_format()
            .map_err(io)?;
    // Bound PNG metadata inflation before the general decoder and reject unconvertible
    // HDR/gamma declarations. The trailing EXIF orientation is read through the final CRC.
    let png_orientation = if reader.format() == Some(image::ImageFormat::Png) {
        png_color(source)?
    } else {
        None
    };
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| bad_request(format!("图片解码失败：{e}")))?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > 64_000_000 {
        return Err(bad_request("原图超过 64 MP 解码预算"));
    }
    let orientation = decoder
        .orientation()
        .map_err(|e| bad_request(e.to_string()))?;
    let profile = decoder
        .icc_profile()
        .map_err(|e| bad_request(e.to_string()))?;
    if profile.as_ref().is_some_and(|icc| icc.len() > 1024 * 1024) {
        return Err(bad_request("ICC profile 超过 1 MiB 上限"));
    }
    let mut decoded = image::DynamicImage::from_decoder(decoder)
        .map_err(|e| bad_request(format!("图片解码失败：{e}")))?;
    if let Some(profile) = profile {
        let mut pixels = decoded.into_rgba8();
        convert_icc(&mut pixels, &profile)?;
        decoded = image::DynamicImage::ImageRgba8(pixels);
    }
    decoded.apply_orientation(png_orientation.unwrap_or(orientation));
    let (width, height) = (decoded.width(), decoded.height());
    let scale = 1.0f64
        .min((16_000_000.0 / (f64::from(width) * f64::from(height))).sqrt())
        .min(8192.0 / f64::from(width.max(height)))
        .min((f64::from(target_w) / f64::from(width)).max(f64::from(target_h) / f64::from(height)));
    let width = (f64::from(width) * scale).floor().max(1.0) as u32;
    let height = (f64::from(height) * scale).floor().max(1.0) as u32;
    let rgba = decoded
        .resize_exact(width, height, image::imageops::FilterType::Triangle)
        .into_rgba8();
    std::fs::create_dir_all(output.parent().unwrap()).map_err(io)?;
    let temp = output.with_extension("part");
    let mut file = std::fs::File::create(&temp).map_err(io)?;
    struct Bounded<'a> {
        file: &'a mut std::fs::File,
        used: u64,
    }
    impl Write for Bounded<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.used + bytes.len() as u64 > IMAGE_BYTES {
                return Err(std::io::Error::other("prepared image exceeds 32 MiB"));
            }
            let n = self.file.write(bytes)?;
            self.used += n as u64;
            Ok(n)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.file.flush()
        }
    }
    let result = image::codecs::png::PngEncoder::new(Bounded {
        file: &mut file,
        used: 0,
    })
    .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8);
    if let Err(e) = result {
        drop(file);
        let _ = std::fs::remove_file(&temp);
        return Err(bad_request(format!("图片准备失败：{e}")));
    }
    file.sync_all().map_err(io)?;
    drop(file);
    std::fs::rename(temp, output).map_err(io)?;
    Ok(())
}

fn png_color(source: &Path) -> ApiResult<Option<image::metadata::Orientation>> {
    let decoder = png::Decoder::new_with_limits(
        BufReader::new(std::fs::File::open(source).map_err(io)?),
        png::Limits {
            bytes: 8 * 1024 * 1024,
        },
    );
    let mut reader = decoder
        .read_info()
        .map_err(|e| bad_request(e.to_string()))?;
    while reader
        .next_row()
        .map_err(|e| bad_request(e.to_string()))?
        .is_some()
    {}
    reader.finish().map_err(|e| bad_request(e.to_string()))?;
    let info = reader.info();
    if info.coding_independent_code_points.is_some_and(|c| {
        c.color_primaries != 1
            || c.transfer_function != 13
            || c.matrix_coefficients != 0
            || !c.is_video_full_range_image
    }) {
        return Err(bad_request("PNG 的 HDR/非 sRGB cICP 暂无转换器"));
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
        return Err(bad_request("PNG 声明了非 sRGB gamma/色度但没有可转换 ICC"));
    }
    Ok(info
        .exif_metadata
        .as_ref()
        .and_then(|exif| image::metadata::Orientation::from_exif_chunk(exif)))
}

fn convert_icc(pixels: &mut image::RgbaImage, icc: &[u8]) -> ApiResult<()> {
    use moxcms::{ColorProfile, DataColorSpace, Layout, ParsingOptions};
    let profile = ColorProfile::new_from_slice_with_options(
        icc,
        ParsingOptions {
            max_profile_size: 1024 * 1024,
            max_allowed_clut_size: 65536,
            max_allowed_trc_size: 4096,
        },
    )
    .map_err(|e| bad_request(e.to_string()))?;
    if profile.color_space != DataColorSpace::Rgb {
        return Err(bad_request("仅支持 RGB ICC，请先将图片转为 sRGB"));
    }
    let transform = profile
        .create_transform_8bit(
            Layout::Rgba,
            &ColorProfile::new_srgb(),
            Layout::Rgba,
            Default::default(),
        )
        .map_err(|e| bad_request(e.to_string()))?;
    let mut row = vec![0; pixels.width() as usize * 4];
    for source in pixels.as_mut().chunks_exact_mut(row.len()) {
        transform
            .transform(source, &mut row)
            .map_err(|e| bad_request(e.to_string()))?;
        for (original, converted) in source.chunks_exact_mut(4).zip(row.chunks_exact(4)) {
            original[..3].copy_from_slice(&converted[..3]);
        }
    }
    Ok(())
}

#[test]
fn stage_media_icc_conversion_preserves_alpha() {
    let original = image::Rgba([128, 100, 50, 77]);
    let mut pixels = image::RgbaImage::from_pixel(2, 1, original);
    convert_icc(
        &mut pixels,
        &moxcms::ColorProfile::new_display_p3().encode().unwrap(),
    )
    .unwrap();
    assert_ne!(pixels.get_pixel(0, 0).0[..3], original.0[..3]);
    assert_eq!(pixels.get_pixel(0, 0).0[3], 77);
    assert!(convert_icc(&mut pixels, b"broken-icc").is_err());
}
