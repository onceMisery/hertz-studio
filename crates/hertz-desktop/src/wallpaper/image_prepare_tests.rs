// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
use super::*;

fn target(width: u32, height: u32, fit: ImageFit, purpose: ImagePurpose) -> ImageTarget {
    ImageTarget {
        width,
        height,
        fit,
        purpose,
    }
}

#[test]
fn target_sizing_preserves_aspect_and_obeys_fit_and_preview_caps() {
    let cover = Options::new(Some(target(100, 100, ImageFit::Cover, ImagePurpose::Low))).unwrap();
    let contain =
        Options::new(Some(target(100, 100, ImageFit::Contain, ImagePurpose::Low))).unwrap();
    assert_eq!(cover.dimensions(400, 200), (200, 100));
    assert_eq!(contain.dimensions(400, 200), (100, 50));
    assert_eq!(cover.dimensions(200, 400), (100, 200));
    assert_eq!(contain.dimensions(200, 400), (50, 100));
    assert_eq!(cover.dimensions(30, 20), (30, 20), "不放大小图");
    let preview = Options::new(Some(target(
        3840,
        2160,
        ImageFit::Cover,
        ImagePurpose::Preview,
    )))
    .unwrap();
    assert_eq!(preview.dimensions(3840, 2160), (960, 540));
    assert_eq!(
        preview.dimensions(5000, 1000),
        (960, 192),
        "cover 仍受解码上限约束"
    );
    let high = Options::new(Some(target(
        16384,
        16384,
        ImageFit::Cover,
        ImagePurpose::High,
    )))
    .unwrap();
    assert_eq!(high.dimensions(5000, 1000), (4096, 819));
    let (w, h) = high.dimensions(8000, 8000);
    assert!(u64::from(w) * u64::from(h) <= 8_294_400);
    assert!(w.max(h) <= 4096);
    assert_eq!(
        Options::new(None).unwrap().dimensions(5000, 1000),
        (4096, 819)
    );
}

#[test]
fn target_keys_bind_canonical_pixels_fit_and_limits() {
    let options = |width, height, fit, purpose| {
        Options::new(Some(target(width, height, fit, purpose)))
            .unwrap()
            .canonical()
    };
    let input = "a".repeat(64);
    let desktop = options(1920, 1080, ImageFit::Cover, ImagePurpose::High);
    assert_ne!(
        key(&input, &desktop),
        key(
            &input,
            &options(1280, 720, ImageFit::Cover, ImagePurpose::High)
        )
    );
    assert_ne!(
        key(&input, &desktop),
        key(
            &input,
            &options(1920, 1080, ImageFit::Contain, ImagePurpose::High)
        )
    );
    assert_ne!(key(&input, &desktop), key(&"b".repeat(64), &desktop));
    // 用途标签本身不改变像素算法；已规划像素和约束一致时共享。
    assert_eq!(
        desktop,
        options(1920, 1080, ImageFit::Cover, ImagePurpose::Low)
    );
    assert_eq!(
        options(3840, 2160, ImageFit::Cover, ImagePurpose::Preview),
        options(960, 540, ImageFit::Cover, ImagePurpose::Preview)
    );
    assert_ne!(
        options(960, 540, ImageFit::Cover, ImagePurpose::Preview),
        options(960, 540, ImageFit::Cover, ImagePurpose::High)
    );
    // 无目标的导入仍使用原来的规范化参数，不创建无意义的新缓存副本。
    assert_eq!(
        Options::new(None).unwrap().canonical(),
        r#"{"alpha":"straight","codec":"png-rgba8","colorSpace":"sRGB-SDR","filter":"linear-premultiplied-area","maxPixels":8294400,"maxSide":4096,"mipmap":false,"thumbnailSide":512,"untagged":"assume-sRGB"}"#
    );
}

#[test]
fn invalid_targets_fail_before_preparation() {
    for (width, height) in [(0, 1), (1, 0), (16385, 1), (1, u32::MAX)] {
        assert_eq!(
            validate_target(Some(target(
                width,
                height,
                ImageFit::Contain,
                ImagePurpose::Medium
            )))
            .unwrap_err()
            .code,
            "invalid_input"
        );
    }
}

#[test]
fn all_eight_orientations_have_exact_pixel_placement() {
    let source = RgbaImage::from_fn(3, 2, |x, y| image::Rgba([(1 + x + y * 3) as u8, 0, 0, 255]));
    let expected: [&[u8]; 8] = [
        &[1, 2, 3, 4, 5, 6],
        &[3, 2, 1, 6, 5, 4],
        &[6, 5, 4, 3, 2, 1],
        &[4, 5, 6, 1, 2, 3],
        &[1, 4, 2, 5, 3, 6],
        &[4, 1, 5, 2, 6, 3],
        &[6, 3, 5, 2, 4, 1],
        &[3, 6, 2, 5, 1, 4],
    ];
    for orientation in 1..=8 {
        let (w, h) = if orientation >= 5 { (2, 3) } else { (3, 2) };
        let output = resample(&source, orientation, w, h, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            output.pixels().map(|p| p[0]).collect::<Vec<_>>(),
            expected[usize::from(orientation - 1)]
        );
    }
}

#[test]
fn scaling_uses_linear_light_and_premultiplied_alpha() {
    let source = RgbaImage::from_raw(2, 1, vec![255, 0, 0, 255, 0, 0, 255, 0]).unwrap();
    let result = resample(&source, 1, 1, 1, &AtomicBool::new(false)).unwrap();
    assert_eq!(result.get_pixel(0, 0).0, [255, 0, 0, 128]);
    let source = RgbaImage::from_raw(2, 1, vec![0, 0, 0, 255, 255, 255, 255, 255]).unwrap();
    let result = resample(&source, 1, 1, 1, &AtomicBool::new(false)).unwrap();
    assert_eq!(result.get_pixel(0, 0).0, [188, 188, 188, 255]);
}

#[test]
fn workspace_is_independent_and_rejects_before_decode() {
    assert!(workspace(3840, 2160, 1024 * 1024).is_ok());
    assert_eq!(
        workspace(8000, 8000, 1024).unwrap_err().code,
        "probe_budget_exceeded"
    );
    assert!(workspace(16385, 1, 1).is_err());
    assert!(workspace(100, 100, MAX_FILE + 1).is_err());
    assert_eq!(fit(10000, 8000, 4096, 8_294_400), (3219, 2575));
}

#[test]
fn icc_conversion_changes_p3_rgb_and_preserves_alpha() {
    let mut pixels = RgbaImage::from_pixel(1, 1, image::Rgba([128, 64, 32, 127]));
    let icc = moxcms::ColorProfile::new_display_p3().encode().unwrap();
    convert_icc(&mut pixels, &icc, &AtomicBool::new(false)).unwrap();
    let output = pixels.get_pixel(0, 0).0;
    assert_eq!(output[3], 127);
    assert!(
        output[0] > 135 && output[1] < 60 && output[2] < 30,
        "{output:?}"
    );
    assert!(convert_icc(&mut pixels, b"broken-icc", &AtomicBool::new(false)).is_err());
}

#[test]
fn generated_png_is_srgb_and_has_no_source_metadata() {
    let dir = super::super::library::tempfileish::temp_dir("normalized-png");
    let path = dir.path().join("render.png");
    let pixels = RgbaImage::from_pixel(4, 3, image::Rgba([32, 64, 128, 127]));
    let out = write_png(&path, &pixels, &AtomicBool::new(false)).unwrap();
    assert_eq!((out.width, out.height), (4, 3));
    let reader = png::Decoder::new(BufReader::new(open(&path).unwrap()))
        .read_info()
        .unwrap();
    assert!(reader.info().srgb.is_some());
    assert!(reader.info().icc_profile.is_none());
    assert!(reader.info().exif_metadata.is_none());
    assert_eq!(image::open(path).unwrap().into_rgba8(), pixels);
}

#[test]
fn cancellation_and_non_srgb_gamma_fail_without_a_false_ready_result() {
    let source = RgbaImage::new(2, 2);
    assert_eq!(
        resample(&source, 1, 1, 1, &AtomicBool::new(true))
            .unwrap_err()
            .code,
        "cancelled"
    );
    let dir = super::super::library::tempfileish::temp_dir("non-srgb");
    let path = dir.path().join("linear.png");
    let mut encoder = png::Encoder::new(std::fs::File::create(&path).unwrap(), 1, 1);
    encoder.set_source_gamma(png::ScaledFloat::new(1.0));
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&[128])
        .unwrap();
    assert_eq!(
        validate_png_color(&path, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "format_unsupported"
    );
}

#[test]
fn png_orientation_after_idat_is_applied_and_trailer_crc_is_checked() {
    let dir = super::super::library::tempfileish::temp_dir("trailing-exif");
    let path = dir.path().join("source.png");
    let tiff = [
        b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
    ];
    let mut writer = png::Encoder::new(std::fs::File::create(&path).unwrap(), 1, 1)
        .write_header()
        .unwrap();
    writer.write_image_data(&[128]).unwrap();
    writer.write_chunk(png::chunk::eXIf, &tiff).unwrap();
    writer.finish().unwrap();
    assert_eq!(
        validate_png_color(&path, &AtomicBool::new(false)).unwrap(),
        6
    );
    let mut bytes = std::fs::read(&path).unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    std::fs::write(&path, bytes).unwrap();
    assert!(validate_png_color(&path, &AtomicBool::new(false)).is_err());
}
