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
