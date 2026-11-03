// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::session::{FrameKind, RecoveryLedger, WallpaperSession};

fn plan(budget: &BudgetCoordinator, owner: OwnerKind, generation: u64) -> GlPlan {
    GlPlan::new(
        budget,
        owner,
        format!("gl-{generation}"),
        generation,
        1920,
        1080,
        144,
        60,
        "high",
    )
    .unwrap()
}

#[test]
fn target_plan_uses_integer_frame_gate_and_counts_peak() {
    let budget = Arc::new(BudgetCoordinator::new());
    let first = plan(&budget, OwnerKind::Desktop, 1);
    assert_eq!(first.limits.frame_divisor, 3);
    assert_eq!(first.session.request().output_pixel_rate, 1920 * 1080 * 48);
    let held = GlAdmission::new(first, Arc::clone(&budget)).unwrap();
    let second = plan(&budget, OwnerKind::Desktop, 2);
    assert!(second.limits.pixel_budget < 1920 * 1080);
    let second = GlAdmission::new(second, Arc::clone(&budget)).unwrap();
    assert_eq!(budget.usage().contexts, 2);
    assert_eq!(budget.usage().targets, 2);
    assert_eq!(budget.usage().resource_allocations, 2);
    assert!(
        budget.usage().output_pixel_rate
            <= budget::MAX_OUTPUT_PIXEL_RATE - budget::PREVIEW_RESERVED_OUTPUT_RATE
    );
    drop((held, second));
    assert_eq!(
        budget.usage(),
        Default::default(),
        "unpublished construction rolls back"
    );
}

#[test]
fn preview_uses_reserved_rate_and_available_quality() {
    let budget = Arc::new(BudgetCoordinator::new());
    let desktop =
        GlAdmission::new(plan(&budget, OwnerKind::Desktop, 1), Arc::clone(&budget)).unwrap();
    let preview = GlPlan::new(
        &budget,
        OwnerKind::Preview,
        "preview".into(),
        2,
        640,
        360,
        144,
        60,
        "high",
    )
    .unwrap();
    assert_eq!(preview.limits.fps, 15);
    assert_eq!(preview.limits.requested_fps, 60);
    assert_eq!(preview.limits.frame_divisor, 10);
    assert!(preview.session.request().output_pixel_rate <= budget::PREVIEW_RESERVED_OUTPUT_RATE);
    let preview = GlAdmission::new(preview, Arc::clone(&budget)).unwrap();
    assert_eq!(budget.usage().preview_instances, 1);
    assert_eq!(budget.usage().targets, 1);
    drop((preview, desktop));
}

#[test]
fn published_generation_cannot_return_resources_before_controller_close() {
    let budget = Arc::new(BudgetCoordinator::new());
    let mut session = WallpaperSession::new();
    let generation = session.apply(9, &RecoveryLedger::new()).unwrap();
    session.resolved(generation);
    session.prepared(generation);
    session
        .admit_gl(
            GlAdmission::new(
                plan(&budget, OwnerKind::Desktop, generation),
                Arc::clone(&budget),
            )
            .unwrap(),
        )
        .unwrap();
    session.native_attached(generation);
    session.page_handshake(generation);
    assert!(session.frame_submitted(generation, FrameKind::Gl));
    assert!(
        !session.controller_closed(generation),
        "active controller is not retiring"
    );
    session.disable();
    assert_eq!(budget.usage().release_pending, 1);
    assert_eq!(budget.usage().resource_release_pending, 1);
    assert!(session.reap_resources().is_empty());
    assert!(!session.controller_closed(generation + 1));
    assert!(session.controller_closed(generation));
    assert_eq!(session.reap_resources(), vec![generation]);
    assert_eq!(budget.usage(), Default::default());
}

#[test]
fn dropped_published_owner_retains_charge_without_close_receipt() {
    let budget = Arc::new(BudgetCoordinator::new());
    let mut admission =
        GlAdmission::new(plan(&budget, OwnerKind::Desktop, 1), Arc::clone(&budget)).unwrap();
    admission.published = true;
    drop(admission);
    assert_eq!(budget.usage().contexts, 1);
    assert_eq!(budget.usage().release_pending, 1);
    assert_eq!(budget.usage().resource_release_pending, 1);
}

#[test]
fn invalid_target_is_rejected_before_reservation() {
    let budget = BudgetCoordinator::new();
    for (width, hz, fps, quality) in [
        (0, 60, 30, "low"),
        (32769, 60, 30, "low"),
        (1920, 0, 30, "low"),
        (1920, 60, 61, "low"),
        (1920, 60, 30, "ultra"),
    ] {
        assert!(GlPlan::new(
            &budget,
            OwnerKind::Desktop,
            "invalid".into(),
            1,
            width,
            1080,
            hz,
            fps,
            quality
        )
        .is_err());
    }
    assert_eq!(budget.usage(), Default::default());
}
