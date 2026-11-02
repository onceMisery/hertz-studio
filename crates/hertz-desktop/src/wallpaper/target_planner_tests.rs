// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::*;
use crate::wallpaper::image_prepare::{ImageFit, ImagePurpose, ImageTarget};
use crate::wallpaper::media::{Container, MediaProbe};

fn target() -> ImageTarget {
    ImageTarget {
        width: 80,
        height: 80,
        fit: ImageFit::Cover,
        purpose: ImagePurpose::Low,
    }
}

fn metadata(width: u32, height: u32) -> MediaProbe {
    MediaProbe {
        container: Container::Image,
        codec: "png".into(),
        profile: None,
        encoded_width: width,
        encoded_height: height,
        display_width: width,
        display_height: height,
        rotation_degrees: 0,
        pixel_aspect_ratio: 1.0,
        duration_ms: None,
        source_fps: None,
        fps_upper_bound: None,
    }
}

#[test]
fn smallest_sufficient_variant_uses_measured_pixels_and_deterministic_ties() {
    let source = metadata(1280, 640);
    let small = metadata(80, 40);
    let sufficient = metadata(160, 80);
    let choices = [
        Candidate {
            variant_id: None,
            path: "source.png",
            bytes: 1,
            metadata: &source,
        },
        Candidate {
            variant_id: Some("claimed-high"),
            path: "tiny.png",
            bytes: 1,
            metadata: &small,
        },
        Candidate {
            variant_id: Some("b"),
            path: "b.png",
            bytes: 50,
            metadata: &sufficient,
        },
        Candidate {
            variant_id: Some("a"),
            path: "a.png",
            bytes: 50,
            metadata: &sufficient,
        },
    ];
    assert_eq!(
        choose(&choices, None, target(), &["image/png".into()]).unwrap(),
        3
    );
    let contain = ImageTarget {
        fit: ImageFit::Contain,
        ..target()
    };
    assert_eq!(
        choose(&choices, None, contain, &["image/png".into()]).unwrap(),
        1
    );
    assert_eq!(
        choose(&choices, Some("b"), target(), &["image/png".into()]).unwrap(),
        2
    );
    assert_eq!(
        choose(&choices, Some("missing"), target(), &["image/png".into()])
            .unwrap_err()
            .code,
        "asset_not_found"
    );
    assert_eq!(
        choose(&choices, None, target(), &["image/jpeg".into()])
            .unwrap_err()
            .code,
        "format_unsupported"
    );
}

#[test]
fn video_preview_counts_encoded_pixels_and_actual_source_rate() {
    let mut video = metadata(1920, 1080);
    video.container = Container::Webm;
    video.codec = "vp8".into();
    video.source_fps = Some(60.0);
    video.display_width = 1080;
    video.display_height = 1920;
    video.rotation_degrees = 90;
    let request = presentation_request(
        &video,
        ImageTarget {
            width: 3840,
            height: 2160,
            purpose: ImagePurpose::Preview,
            ..target()
        },
        "preview".into(),
        7,
    )
    .unwrap();
    assert_eq!(request.decoders, 1);
    assert_eq!(request.targets, 0);
    assert_eq!(request.contexts, 0);
    assert_eq!(request.decode_pixel_rate, 124_416_000);
    assert_eq!(request.output_pixel_rate, 31_104_000);
    video.fps_upper_bound = Some(120.0);
    assert_eq!(
        presentation_request(&video, target(), "live".into(), 1)
            .unwrap()
            .decode_pixel_rate,
        248_832_000
    );
    video.fps_upper_bound = Some(f64::NAN);
    assert!(presentation_request(&video, target(), "live".into(), 1).is_err());
}

#[test]
fn logical_references_reject_paths_and_invalid_hashes() {
    let reference = AssetRef {
        package_hash: "a".repeat(64),
        asset_id: "background".into(),
        variant_id: None,
    };
    assert!(reference.validate().is_ok());
    assert!(AssetRef {
        package_hash: "../packages".into(),
        ..reference.clone()
    }
    .validate()
    .is_err());
    assert!(AssetRef {
        asset_id: "../background".into(),
        ..reference.clone()
    }
    .validate()
    .is_err());
    assert!(AssetRef {
        variant_id: Some("../original".into()),
        ..reference
    }
    .validate()
    .is_err());
}

#[test]
fn video_preview_can_use_remaining_output_budget_and_does_not_overbook_live() {
    use crate::wallpaper::budget::BudgetCoordinator;
    let budget = BudgetCoordinator::new();
    let mut video = metadata(1920, 1080);
    video.container = Container::Webm;
    video.codec = "vp8".into();
    video.source_fps = Some(60.0);
    let preview = presentation_request(
        &video,
        ImageTarget {
            width: 960,
            height: 540,
            purpose: ImagePurpose::Preview,
            ..target()
        },
        "preview".into(),
        1,
    )
    .unwrap();
    let preview_token = budget.grant(&preview).unwrap();
    let mut live = presentation_request(&metadata(80, 40), target(), "live".into(), 1).unwrap();
    live.output_pixel_rate = 100_000_000;
    assert_eq!(budget.grant(&live).unwrap_err().quota, "output_pixel_rate");
    assert_eq!(budget.usage().preview_instances, 1);
    budget.release(preview_token, "preview", 1).unwrap();
    assert!(
        budget.grant(&live).is_err(),
        "取消但未退出的视频仍然占用总额"
    );
    budget.confirm_exit(preview_token, "preview", 1).unwrap();
    let live_token = budget.grant(&live).unwrap();
    assert_eq!(
        budget.grant(&preview).unwrap_err().quota,
        "output_pixel_rate"
    );
    budget.confirm_exit(live_token, "live", 1).unwrap();
    let mut gl = preview;
    gl.contexts = 1;
    assert_eq!(budget.grant(&gl).unwrap_err().quota, "preview_output_rate");
}
