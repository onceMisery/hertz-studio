// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
use super::*;

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[test]
fn decode_probe_read_control_requires_exact_native_identity_and_one_bounded_gate() {
    let fixture = super::super::istream::tests::held_font_fixture(
        "decode-read-parser",
        Duration::from_secs(2),
    );
    let snapshot_request = serde_json::json!({"action":"snapshot","nonce":1,"probeId":7});
    let request = ReadControl::parse(&snapshot_request.to_string()).unwrap();
    assert!(fixture.gate.handle(&request, 7, 7));
    assert!(!fixture.gate.handle(&request, 8, 7));
    assert!(!fixture.gate.handle(&request, 7, 8));
    let thread = super::super::istream::tests::read_worker(fixture.stream.clone());
    let snapshot = super::super::istream::tests::wait_held(&fixture.gate);
    let valid = serde_json::json!({"action":"release","nonce":2,"probeId":7,"generation":7,
        "session":"probe-7","nativeRequestId":19,"nativeControllerId":12,
        "streamId":snapshot.stream_id,"holdToken":snapshot.hold_token});
    for (field, value) in [
        ("probeId", serde_json::json!(8)),
        ("generation", serde_json::json!(8)),
        ("session", serde_json::json!("probe-8")),
        ("nativeRequestId", serde_json::json!(20)),
        ("nativeControllerId", serde_json::json!(13)),
        (
            "streamId",
            serde_json::json!(snapshot.stream_id.unwrap() + 1),
        ),
        ("holdToken", serde_json::json!("0".repeat(32))),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        let request = ReadControl::parse(&invalid.to_string()).unwrap();
        assert!(
            !fixture.gate.handle(&request, 7, 7),
            "rejected identity: {field}"
        );
        assert!(fixture.gate.snapshot().read_in_flight);
    }
    for field in [
        "nonce",
        "probeId",
        "generation",
        "nativeRequestId",
        "nativeControllerId",
        "streamId",
    ] {
        for invalid_id in [0, 9_007_199_254_740_992_u64] {
            let mut invalid = valid.clone();
            invalid[field] = serde_json::json!(invalid_id);
            assert!(ReadControl::parse(&invalid.to_string()).is_none());
        }
    }
    for field in [
        "generation",
        "session",
        "nativeRequestId",
        "nativeControllerId",
        "streamId",
        "holdToken",
    ] {
        let mut invalid = valid.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(ReadControl::parse(&invalid.to_string()).is_none());
    }
    for invalid in [
        serde_json::json!({"action":"rearm","nonce":1,"probeId":7}),
        serde_json::json!({"action":"snapshot","nonce":1,"probeId":7,"streamId":1}),
    ] {
        assert!(ReadControl::parse(&invalid.to_string()).is_none());
    }
    let mut invalid = valid.clone();
    invalid["unknown"] = true.into();
    assert!(ReadControl::parse(&invalid.to_string()).is_none());
    assert!(ReadControl::parse(&" ".repeat(513)).is_none());
    let request = ReadControl::parse(&valid.to_string()).unwrap();
    assert!(fixture.gate.handle(&request, 7, 7));
    let released_at = fixture.gate.snapshot().release_at_ms;
    assert!(fixture.gate.handle(&request, 7, 7));
    assert_eq!(fixture.gate.snapshot().release_at_ms, released_at);
    assert!(!fixture.gate.handle(&request, 8, 8));
    let _ = thread.join().unwrap();
    assert!(serde_json::to_vec(&fixture.gate.snapshot()).unwrap().len() < 8192);
    for milliseconds in [0, 499, 30001, u32::MAX] {
        assert!(ReadGate::new(
            fixture.gate.owner.clone(),
            milliseconds,
            std::thread::current().id()
        )
        .is_none());
    }
    assert!(ReadGate::new(fixture.gate.owner.clone(), 500, std::thread::current().id()).is_some());
    assert!(ReadGate::new(
        fixture.gate.owner.clone(),
        30000,
        std::thread::current().id()
    )
    .is_some());
    let expired = ReadGate::with_test_deadlines(
        fixture.gate.owner.clone(),
        Duration::from_millis(1),
        Duration::ZERO,
    );
    assert_eq!(expired.snapshot().phase, "expired");
    assert!(!expired.snapshot().read_in_flight);
}

#[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
#[test]
fn decode_probe_cancel_and_original_deadline_cannot_finish_budget_or_reply_while_real_read_is_held()
{
    for (cancelled, code) in [(true, "cancelled"), (false, "probe_inconclusive")] {
        let fixture = super::super::istream::tests::held_font_fixture(
            &format!("decode-held-{code}"),
            Duration::from_secs(2),
        );
        let probe = ProbeClient::testing_input(|_, _| Box::pin(async { Ok(()) }));
        let reference = super::super::target_planner::AssetRef {
            package_hash: fixture.hash.clone(),
            asset_id: "brand-font".into(),
            variant_id: None,
        };
        let workspace = probe
            .image_workspace(
                super::super::font_prepare::prepare_workspace_bytes(fixture.entry.bytes).unwrap(),
            )
            .unwrap();
        let input = super::super::font_prepare::pin_input(
            &fixture.assets,
            &reference,
            &fixture.entry,
            &[],
            &workspace,
            &AtomicBool::new(false),
        )
        .unwrap();
        workspace.finish();
        let budget = Arc::new(BudgetCoordinator::new());
        let prepare = Reservation::prepare(budget.clone(), format!("prepare-{code}")).unwrap();
        let request = ProbeInput::Font(input)
            .budget_request("probe-7".into())
            .unwrap();
        let cpu = request.cpu_bytes;
        let gpu = request.gpu_bytes;
        let reservation = Reservation::grant(budget.clone(), request).unwrap();
        let (reply, mut receiver) = oneshot::channel();
        let mut host = ProbeHost {
            current: Some(HostedProbe {
                read_drop: HostDropGuard(Some(fixture.gate.clone())),
                id: 7,
                cancel: Arc::new(AtomicBool::new(cancelled)),
                reply: Some(reply),
                browser: None,
                poster: None,
                deadline: if cancelled {
                    Instant::now() + PROBE_LIMIT
                } else {
                    Instant::now() - Duration::from_millis(1)
                },
                config: serde_json::json!({"kind":"font"}),
                started: true,
                font_settled: false,
                surface: None,
                access: fixture.access.clone(),
                drain: None,
                reservation: Some(reservation),
                outcome: None,
                close_attempts: 0,
                close_error: None,
                close_failed_since: None,
                last_close_ms: 0,
            }),
        };
        let thread = super::super::istream::tests::read_worker(fixture.stream.clone());
        super::super::istream::tests::wait_held(&fixture.gate);
        host.tick();
        let diagnostics = host.diagnostics();
        assert_eq!(diagnostics["outcome"], code);
        assert_eq!(diagnostics["scopeActive"], false);
        assert_eq!(diagnostics["scopeReaders"], 1);
        assert_eq!(diagnostics["fileReadersDrained"], false);
        assert_eq!(diagnostics["heldIstreamRead"]["readInFlight"], true);
        assert!(receiver.try_recv().is_err());
        assert_eq!(budget.usage().prepare_tasks, 1);
        assert_eq!(budget.usage().prepare_cpu_bytes, 0);
        assert_eq!(budget.usage().cpu_bytes, cpu);
        assert_eq!(budget.usage().gpu_bytes, gpu);
        assert!(budget.usage().release_pending > 0);
        fixture.gate.release(ReleaseReason::Explicit);
        assert_eq!(
            thread.join().unwrap().0,
            windows::Win32::Foundation::STG_E_ACCESSDENIED
        );
        host.tick();
        assert!(
            receiver.try_recv().is_err(),
            "release does not forge FontFace settlement or Drain"
        );
        super::super::istream::reap_revoked_streams();
        host.tick();
        assert!(
            receiver.try_recv().is_err(),
            "physical Read reclamation still requires original settlement"
        );
        host.current.as_mut().unwrap().font_settled = true;
        host.tick();
        assert_eq!(receiver.try_recv().unwrap().err().unwrap().code, code);
        prepare.finish();
        assert_eq!(budget.usage(), super::super::budget::BudgetUsage::default());
    }
}

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

#[test]
fn preflight_check_preserves_active_and_pending_usage_tokens_and_revision() {
    let probe = ProbeClient::testing_input(|_, _| panic!("a budget projection cannot decode"));
    let budget = probe.budget_for_test();
    let mut held_request = empty_request("memory-owner".into());
    held_request.cpu_bytes = super::super::budget::MAX_CPU_DECODED_BYTES - 1;
    let held = budget.grant(&held_request).unwrap();
    let mut check = empty_request("memory-preflight".into());
    check.cpu_bytes = 2;
    for pending in [false, true] {
        if pending {
            budget.release(held, &held_request.session, 1).unwrap();
        }
        let sentinel_request = empty_request(format!("sentinel-{pending}"));
        let sentinel = budget.grant(&sentinel_request).unwrap();
        let before = budget
            .allocation_snapshot(sentinel, &sentinel_request.session, 1)
            .unwrap();
        let usage = budget.usage();
        let error = probe.check_requests(&[check.clone()]).unwrap_err();
        assert_eq!(error.code, "budget_busy");
        assert_eq!(
            *error.details.unwrap(),
            serde_json::json!({
                "quota":"cpu_decoded_bytes", "cap":super::super::budget::MAX_CPU_DECODED_BYTES,
                "held":held_request.cpu_bytes, "requested":2
            })
        );
        check.cpu_bytes = 1;
        probe.check_requests(&[check.clone()]).unwrap();
        check.cpu_bytes = 2;
        assert_eq!(budget.usage(), usage);
        let after_request = empty_request(format!("after-{pending}"));
        let after = budget.grant(&after_request).unwrap();
        let snapshot = budget
            .allocation_snapshot(after, &after_request.session, 1)
            .unwrap();
        assert_eq!(snapshot.allocation_revision, before.allocation_revision + 1);
        assert_eq!(after, sentinel + 1, "check_requests publishes no token");
        for (token, request) in [(sentinel, sentinel_request), (after, after_request)] {
            budget.release(token, &request.session, 1).unwrap();
            budget.confirm_exit(token, &request.session, 1).unwrap();
            budget.purge_session(&request.session, 1);
        }
    }
    budget.confirm_exit(held, &held_request.session, 1).unwrap();
    budget.purge_session(&held_request.session, 1);
    assert_eq!(budget.usage(), super::super::budget::BudgetUsage::default());
    assert_eq!(probe.stats(), (0, 0));
}

fn font_report() -> serde_json::Value {
    serde_json::json!({"kind":"font","ok":true,"code":"","settled":true,
        "fontStatus":"loaded","alphaPixels":27,"width":256,"height":128})
}

#[test]
fn font_success_requires_loaded_face_and_bounded_actual_glyph_pixels() {
    assert!(settled_font_report(&font_report().to_string())
        .unwrap()
        .is_ok());
    for (field, value) in [
        ("fontStatus", serde_json::json!("loading")),
        ("alphaPixels", serde_json::json!(0)),
        ("alphaPixels", serde_json::json!(32769)),
        ("width", serde_json::json!(257)),
        ("height", serde_json::json!(129)),
        ("ok", serde_json::json!(false)),
    ] {
        let mut report = font_report();
        report[field] = value;
        let error = settled_font_report(&report.to_string())
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "probe_inconclusive", "{report}");
    }
    let mut report = font_report();
    report["ok"] = false.into();
    report["code"] = "font_decode_failed".into();
    assert_eq!(
        settled_font_report(&report.to_string())
            .unwrap()
            .unwrap_err()
            .code,
        "font_decode_failed"
    );
}

#[test]
fn unrelated_malformed_or_unsettled_reports_cannot_release_font_host() {
    let mut unsettled = font_report();
    unsettled["settled"] = false.into();
    let mut unrelated = font_report();
    unrelated["kind"] = "video".into();
    let mut extra = font_report();
    extra["frames"] = serde_json::json!([0, 1, 2]);
    let mut missing = font_report();
    missing.as_object_mut().unwrap().remove("settled");
    let mut negative = font_report();
    negative["alphaPixels"] = serde_json::json!(-1);
    for body in [
        unsettled.to_string(),
        unrelated.to_string(),
        extra.to_string(),
        missing.to_string(),
        negative.to_string(),
        "ready".into(),
        " ".repeat(REPORT_LIMIT + 1),
    ] {
        assert!(settled_font_report(&body).is_none());
    }
    // A settled failure is still a cleanup receipt, never a qualification.
    let mut failed = font_report();
    failed["ok"] = false.into();
    failed["fontStatus"] = "error".into();
    failed["code"] = "font_format_not_prepared".into();
    assert_eq!(
        settled_font_report(&failed.to_string())
            .unwrap()
            .unwrap_err()
            .code,
        "font_format_not_prepared"
    );
}

#[test]
fn first_font_success_after_deadline_cannot_override_failure_or_release_held_readers() {
    for (expired, cancelled, expected) in [
        (false, false, None),
        (true, false, Some("probe_inconclusive")),
        (false, true, Some("cancelled")),
    ] {
        let budget = Arc::new(BudgetCoordinator::new());
        let mut request = empty_request("font-report-order".into());
        request.cpu_bytes = 256 * 128 * 8;
        request.gpu_bytes = 256 * 128 * 4;
        let reservation = Reservation::grant(Arc::clone(&budget), request).unwrap();
        let access = MediaAccess::new();
        let hash = "a".repeat(64);
        assert!(access.replace(1, &[(hash.clone(), "assets/font.ttf".into())]));
        let reader = access.permit(&hash, "assets/font.ttf").unwrap();
        let cloned_reader = reader.clone();
        let (reply, mut receiver) = oneshot::channel();
        let mut host = ProbeHost {
            current: Some(HostedProbe {
                #[cfg(all(feature = "wallpaper-media-probe", debug_assertions))]
                read_drop: HostDropGuard(None),
                id: 1,
                cancel: Arc::new(AtomicBool::new(cancelled)),
                reply: Some(reply),
                browser: None,
                poster: None,
                deadline: if expired {
                    Instant::now() - Duration::from_secs(1)
                } else {
                    Instant::now() + Duration::from_secs(60)
                },
                config: serde_json::json!({"kind":"font"}),
                started: true,
                font_settled: false,
                surface: None,
                access,
                drain: None,
                reservation: Some(reservation),
                outcome: None,
                close_attempts: 0,
                close_error: None,
                close_failed_since: None,
                last_close_ms: 0,
            }),
        };
        // No preceding timer tick: the first loaded report itself must observe
        // the expired deadline, while still acting as a settlement receipt.
        host.page(1, &font_report().to_string());
        assert!(host.current.as_ref().unwrap().font_settled);
        assert!(receiver.try_recv().is_err());
        assert_eq!(budget.usage().cpu_bytes, 256 * 128 * 8);
        assert_eq!(budget.usage().gpu_bytes, 256 * 128 * 4);
        drop(reader);
        host.tick();
        assert!(host.current.is_some());
        assert!(receiver.try_recv().is_err());
        drop(cloned_reader);
        host.tick();
        assert!(host.current.is_none());
        let result = receiver.try_recv().unwrap();
        assert_eq!(result.err().map(|error| error.code), expected);
        assert_eq!(budget.usage(), super::super::budget::BudgetUsage::default());
    }
}

#[test]
fn typed_font_probe_uses_bounded_cpu_and_canvas_without_video_or_output_slots() {
    let (assets, _root, reference, entry) =
        super::super::font_prepare::installed("font-probe-budget");
    let probe = ProbeClient::testing_input(|_, _| Box::pin(async { Ok(()) }));
    let workspace = probe
        .image_workspace(super::super::font_prepare::prepare_workspace_bytes(entry.bytes).unwrap())
        .unwrap();
    let input = super::super::font_prepare::pin_input(
        &assets,
        &reference,
        &entry,
        &[],
        &workspace,
        &AtomicBool::new(false),
    )
    .unwrap();
    workspace.finish();
    let budget = Arc::new(BudgetCoordinator::new());
    let mut request = empty_request("all-video-slots".into());
    request.decoders = 2;
    let videos = Reservation::grant(Arc::clone(&budget), request).unwrap();
    let font = ProbeInput::Font(input.clone())
        .budget_request("font-budget".into())
        .unwrap();
    assert_eq!(font.decoders, 0);
    assert_eq!(font.contexts, 0);
    assert_eq!(font.targets, 0);
    assert_eq!(font.prepare_tasks, 0);
    assert_eq!(font.output_pixel_rate, 0);
    assert_eq!(font.decode_pixel_rate, 0);
    assert_eq!(
        font.cpu_bytes,
        input.metadata.cpu_budget_bytes + 256 * 128 * 8
    );
    assert_eq!(font.gpu_bytes, 256 * 128 * 4);
    let font = Reservation::grant(Arc::clone(&budget), font).unwrap();
    font.release();
    assert_eq!(
        budget.usage().cpu_bytes,
        input.metadata.cpu_budget_bytes + 256 * 128 * 8
    );
    font.finish();
    videos.finish();
    assert_eq!(budget.usage(), super::super::budget::BudgetUsage::default());
}
