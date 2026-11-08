// SPDX-License-Identifier: MIT
use super::*;

fn hold() -> (Arc<BudgetCoordinator>, CaptureHold) {
    let budget = Arc::new(BudgetCoordinator::new());
    let hold =
        CaptureHold::reserve(Arc::clone(&budget), &PageBinding::new(7).unwrap(), 2, 1).unwrap();
    (budget, hold)
}
fn receipt(hold: &CaptureHold, pixels: &[u8]) -> serde_json::Value {
    serde_json::json!({"token":hold.request.token,"sessionId":hold.request.session_id,"generation":7,"width":2,"height":1,
        "rgba":base64::engine::general_purpose::STANDARD.encode(pixels)})
}
fn message(value: serde_json::Value) -> String {
    format!("{CAPTURE_PREFIX}{value}")
}

#[test]
fn unpublished_capture_rolls_back_but_published_drop_keeps_peak_reserved() {
    let (budget, hold) = hold();
    assert_eq!(budget.usage().resource_allocations, 2);
    assert_eq!(budget.usage().contexts, 0);
    drop(hold);
    assert_eq!(budget.usage(), Default::default());
    let (budget, mut hold) = self::hold();
    hold.issue_script();
    drop(hold);
    assert_eq!(budget.usage().release_pending, 1);
    assert_eq!(budget.usage().resource_release_pending, 2);
}

#[test]
fn receipt_identity_pixels_and_both_exit_barriers_are_required() {
    let (budget, mut hold) = hold();
    hold.issue_script();
    let valid = receipt(&hold, &[1, 2, 3, 255, 4, 5, 6, 255]);
    for (field, value) in [
        ("token", serde_json::json!("0".repeat(32))),
        ("sessionId", serde_json::json!("wrong")),
        ("generation", serde_json::json!(8)),
    ] {
        let mut stale = valid.clone();
        stale[field] = value;
        assert!(hold.accept(&message(stale)).is_none());
    }
    let pixels = hold.accept(&message(valid.clone())).unwrap().unwrap();
    assert_eq!(pixels, [3, 2, 1, 255, 6, 5, 4, 255]);
    assert!(hold.accept(&message(valid)).is_none());
    hold.retire();
    assert!(!hold.finish(true));
    hold.source_closed(8);
    assert!(!hold.finish(true));
    hold.source_closed(7);
    assert!(!hold.finish(false));
    assert_eq!(budget.usage().targets, 0);
    assert_eq!(budget.usage().desktop_frames, 1);
    assert!(hold.finish(true));
    assert_eq!(budget.usage(), Default::default());
}

#[test]
fn malformed_or_larger_receipts_cannot_expand_the_plan() {
    for (field, value) in [
        ("width", serde_json::json!(3)),
        ("rgba", serde_json::json!("AA==")),
        (
            "rgba",
            serde_json::json!(base64::engine::general_purpose::STANDARD.encode([0u8; 8])),
        ),
    ] {
        let (budget, mut hold) = hold();
        hold.issue_script();
        let mut value_json = receipt(&hold, &[1, 2, 3, 255, 4, 5, 6, 255]);
        value_json[field] = value;
        assert!(hold.accept(&message(value_json)).unwrap().is_err());
        assert_eq!(budget.usage().cpu_bytes, 8);
        hold.retire();
        hold.source_closed(7);
        assert!(hold.finish(true));
    }
    let (_budget, mut hold) = hold();
    hold.issue_script();
    assert!(hold.accept(&"x".repeat(MAX_CAPTURE_MESSAGE + 1)).is_none());
    hold.started = Instant::now() - CAPTURE_TIMEOUT;
    let late = receipt(&hold, &[1, 2, 3, 255, 4, 5, 6, 255]);
    assert!(hold.accept(&message(late)).is_none());
    assert!(!hold.received());
}

#[test]
fn capture_dimensions_and_workspace_are_bounded_for_large_targets() {
    let budget = Arc::new(BudgetCoordinator::new());
    let hold = CaptureHold::reserve(
        Arc::clone(&budget),
        &PageBinding::new(1).unwrap(),
        7680,
        2160,
    )
    .unwrap();
    assert_eq!((hold.request.width, hold.request.height), (960, 270));
    assert_eq!(
        budget.usage().prepare_cpu_bytes,
        64 * 1024 * 1024 + 7680 * 2160 * 4
    );
    assert_eq!(budget.usage().gpu_bytes, 960 * 270 * 12 + 7680 * 2160 * 8);
    assert!(
        CaptureHold::reserve(Arc::clone(&budget), &PageBinding::new(2).unwrap(), 0, 1080).is_err()
    );
    assert!(CaptureHold::reserve(
        Arc::clone(&budget),
        &PageBinding::new(3).unwrap(),
        7680,
        4320
    )
    .is_err());
}

#[test]
fn static_preview_frame_reserves_storage_without_another_live_preview() {
    let budget = Arc::new(BudgetCoordinator::new());
    let binding = PageBinding::new(7).unwrap();
    assert!(CaptureHold::reserve_for(Arc::clone(&budget), &binding, 641, 360, true).is_err());
    let mut hold = CaptureHold::reserve_for(Arc::clone(&budget), &binding, 640, 360, true).unwrap();
    assert_eq!(budget.usage().targets, 0);
    assert_eq!(budget.usage().preview_instances, 0);
    assert_eq!(budget.usage().contexts, 0);
    assert_eq!(budget.usage().resource_allocations, 2);
    assert_eq!(budget.usage().gpu_bytes, 640 * 360 * 20);
    hold.issue_script();
    hold.retire();
    assert!(!hold.finish(true));
    hold.source_closed(7);
    assert!(hold.finish(true));
    assert_eq!(budget.usage(), Default::default());
}

#[test]
fn captured_workspace_returns_after_source_and_staging_exit_while_bitmap_stays_charged() {
    for preview in [false, true] {
        let budget = Arc::new(BudgetCoordinator::new());
        let mut hold = CaptureHold::reserve_for(
            Arc::clone(&budget),
            &PageBinding::new(7).unwrap(),
            2,
            1,
            preview,
        )
        .unwrap();
        hold.issue_script();
        hold.accept(&message(receipt(&hold, &[1, 2, 3, 255, 4, 5, 6, 255])))
            .unwrap()
            .unwrap();
        let full = budget.usage();
        let prepare = BudgetRequest {
            owner: OwnerKind::Probe,
            session: "image-preparation".into(),
            generation: 1,
            task_id: "prepare-image".into(),
            targets: 0,
            contexts: 0,
            decoders: 0,
            transcode_slots: 0,
            decode_pixel_rate: 0,
            output_pixel_rate: 0,
            texture_upload_bytes_per_second: 0,
            cpu_bytes: 0,
            prepare_cpu_bytes: super::super::budget::MAX_PREPARE_CPU_BYTES,
            asset_cpu_bytes: 0,
            gpu_bytes: 0,
            prepare_tasks: 1,
        };
        assert_eq!(
            budget.grant(&prepare).unwrap_err().quota,
            "prepare_cpu_bytes"
        );
        hold.reap_workspace(true).unwrap();
        assert_eq!(
            budget.usage(),
            full,
            "receipt alone does not prove source exit"
        );
        hold.source_closed(8);
        hold.reap_workspace(true).unwrap();
        assert_eq!(
            budget.usage(),
            full,
            "a different generation cannot release this workspace"
        );
        hold.source_closed(7);
        hold.reap_workspace(false).unwrap();
        assert_eq!(
            budget.usage(),
            full,
            "unclosed native staging remains charged"
        );
        hold.reap_workspace(true).unwrap();
        assert!(hold.workspace_released());
        let bitmap = budget.usage();
        assert_eq!(
            (bitmap.prepare_cpu_bytes, bitmap.cpu_bytes, bitmap.gpu_bytes),
            (0, 8, 16)
        );
        assert_eq!((bitmap.targets, bitmap.preview_instances), (0, 0));
        assert_eq!(bitmap.desktop_frames, u32::from(!preview));
        assert_eq!(
            (
                bitmap.session_reservations,
                bitmap.resource_allocations,
                bitmap.resource_records
            ),
            (1, 1, 2)
        );
        hold.reap_workspace(true).unwrap();
        assert_eq!(budget.usage(), bitmap);
        let preparation = budget.grant(&prepare).unwrap();
        assert_eq!(
            budget.usage().prepare_tasks,
            1,
            "new preparation can proceed while the bitmap remains visible"
        );
        budget
            .confirm_exit(preparation, "image-preparation", 1)
            .unwrap();
        budget
            .forget_released(preparation, "image-preparation", 1)
            .unwrap();
        hold.retire();
        assert!(!hold.finish(false));
        assert_eq!(
            budget.usage().gpu_bytes,
            16,
            "source exit cannot release the retained compositor estimate"
        );
        assert!(hold.finish(true));
        assert_eq!(budget.usage(), Default::default());
    }
}

#[test]
fn unconfirmed_or_timed_out_capture_keeps_workspace_until_full_retirement() {
    let (budget, mut hold) = hold();
    hold.issue_script();
    let full = budget.usage();
    hold.source_closed(7);
    hold.reap_workspace(true).unwrap();
    assert_eq!(budget.usage(), full);
    hold.started = Instant::now() - CAPTURE_TIMEOUT;
    assert!(hold
        .accept(&message(receipt(&hold, &[1, 2, 3, 255, 4, 5, 6, 255])))
        .is_none());
    hold.reap_workspace(true).unwrap();
    assert!(!hold.workspace_released());
    assert_eq!(
        budget.usage(),
        full,
        "a timeout and late receipt cannot authorize early release"
    );
    hold.retire();
    assert!(hold.finish(true));
    assert_eq!(budget.usage(), Default::default());
}

#[test]
fn failed_capture_receipt_releases_only_after_source_and_native_staging_exit() {
    let (budget, mut hold) = hold();
    hold.issue_script();
    let mut value = receipt(&hold, &[1, 2, 3, 255, 4, 5, 6, 255]);
    value["error"] = serde_json::json!("capture failed");
    assert!(hold.accept(&message(value)).unwrap().is_err());
    hold.retire();
    hold.reap_workspace(true).unwrap();
    assert!(budget.usage().prepare_cpu_bytes > 0);
    hold.source_closed(7);
    hold.reap_workspace(false).unwrap();
    assert!(budget.usage().prepare_cpu_bytes > 0);
    hold.reap_workspace(true).unwrap();
    assert_eq!(budget.usage().prepare_cpu_bytes, 0);
    assert_eq!(budget.usage().resource_release_pending, 1);
    assert!(hold.finish(true));
    assert_eq!(budget.usage(), Default::default());
}
