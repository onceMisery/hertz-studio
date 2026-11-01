// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
use super::*;

fn metadata() -> MediaProbe {
    MediaProbe {
        container: Container::Webm,
        codec: "vp8".into(),
        profile: None,
        encoded_width: 1920,
        encoded_height: 1080,
        display_width: 1920,
        display_height: 1080,
        rotation_degrees: 0,
        pixel_aspect_ratio: 1.0,
        duration_ms: Some(2000),
        source_fps: Some(30.0),
        fps_upper_bound: None,
    }
}

#[test]
fn probe_accounts_coded_pixels_and_verified_cfr_or_vfr_bound() {
    let mut info = metadata();
    let request = decode_request(&info, "cfr".into()).unwrap();
    assert_eq!(request.decoders, 1);
    assert_eq!(request.decode_pixel_rate, 1920 * 1080 * 30);
    assert_eq!(request.output_pixel_rate, 0);
    info.fps_upper_bound = Some(60.0);
    info.display_width = 480;
    info.display_height = 270;
    assert_eq!(
        decode_request(&info, "vfr".into())
            .unwrap()
            .decode_pixel_rate,
        1920 * 1080 * 60
    );
    info.fps_upper_bound = None;
    info.source_fps = None;
    assert_eq!(
        decode_request(&info, "unknown".into()).unwrap_err().code,
        "format_unsupported"
    );
    info.source_fps = Some(f64::INFINITY);
    assert!(decode_request(&info, "invalid".into()).is_err());
}

#[test]
fn probe_respects_existing_decoder_allocations_until_physical_exit() {
    let budget = Arc::new(BudgetCoordinator::new());
    let mut held = empty_request("desktop-held".into());
    held.decoders = 2;
    let held = Reservation::grant(Arc::clone(&budget), held).unwrap();
    let probe = decode_request(&metadata(), "probe".into()).unwrap();
    assert!(Reservation::grant(Arc::clone(&budget), probe.clone()).is_err());
    held.release();
    assert!(Reservation::grant(Arc::clone(&budget), probe.clone()).is_err());
    assert_eq!(budget.usage().decoder_slots, 2);
    held.finish();
    let probe = Reservation::grant(Arc::clone(&budget), probe).unwrap();
    assert_eq!(budget.usage().decoder_slots, 1);
    probe.finish();
    assert_eq!(budget.usage(), super::super::budget::BudgetUsage::default());
}

#[test]
fn image_memory_is_reserved_before_pixel_decode_and_oversized_video_is_rejected() {
    let budget = Arc::new(BudgetCoordinator::new());
    let mut info = metadata();
    info.encoded_width = 3840;
    info.encoded_height = 2160;
    assert_eq!(
        decode_request(&info, "4k".into()).unwrap_err().code,
        "format_unsupported"
    );
    info.container = Container::Image;
    info.encoded_width = 8192;
    info.encoded_height = 8192;
    let request = decode_request(&info, "large-image".into()).unwrap();
    assert_eq!(request.decoders, 0);
    assert!(Reservation::grant(Arc::clone(&budget), request).is_err());
    assert_eq!(budget.usage(), super::super::budget::BudgetUsage::default());
}
