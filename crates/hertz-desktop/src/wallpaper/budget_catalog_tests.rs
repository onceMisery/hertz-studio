// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Process catalog admission uses the original ledger and original consumers.
//! Each global case executes alone in a fresh process, never a warm suite.
use super::*;
use std::{cell::Cell, process::Command};

fn bounds() -> hertz_wallpaper::manifest::ManifestHeapBounds {
    hertz_wallpaper::manifest::ManifestHeapBounds::for_bytes(0).unwrap()
}

fn cold_child(name: &str) -> bool {
    if std::env::var("HERTZ_SCENE_CATALOG_COLD_CHILD").as_deref() == Ok(name) {
        return false;
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture", "--test-threads=1"])
        .env("HERTZ_SCENE_CATALOG_COLD_CHILD", name)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "cold child {name} failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    println!(
        "cold child {name}: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    true
}

fn request(session: &str) -> BudgetRequest {
    BudgetRequest {
        owner: OwnerKind::Desktop,
        session: session.into(),
        generation: 1,
        task_id: "catalog-budget-test".into(),
        targets: 1,
        contexts: 0,
        decoders: 0,
        transcode_slots: 0,
        decode_pixel_rate: 0,
        output_pixel_rate: 0,
        texture_upload_bytes_per_second: 0,
        cpu_bytes: 0,
        prepare_cpu_bytes: 0,
        asset_cpu_bytes: 0,
        gpu_bytes: 0,
        prepare_tasks: 0,
    }
}

fn scene_usage() -> BudgetUsage {
    BudgetUsage {
        asset_cpu_bytes: bounds().catalog_retained_requested_bytes(),
        ..Default::default()
    }
}

fn global_usage() -> BudgetUsage {
    BudgetUsage {
        asset_cpu_bytes: bootstrap::retained_requested_bytes().unwrap()
            + bounds().catalog_retained_requested_bytes()
            + hertz_wallpaper::document::catalog::CompositionCatalogHeapBounds::for_embedded_catalog().unwrap().retained_requested_bytes(),
        ..Default::default()
    }
}

// Injection exists only in this test module. Production calls only catalog().
fn initialize_for_test(
    budget: &BudgetCoordinator,
    initialize: impl FnOnce(&Ledger),
) -> Result<(), BudgetRejection> {
    let mut ledger = budget.ledger.lock().unwrap_or_else(|e| e.into_inner());
    let reservation = SceneCatalogReservation::reserve(&mut ledger, bounds())?;
    initialize(reservation.ledger);
    reservation.commit();
    Ok(())
}

#[test]
fn independent_new_has_no_process_charge() {
    assert_eq!(BudgetCoordinator::new().usage(), BudgetUsage::default());
}

#[test]
fn cold_global_concurrent_identity_and_permanent_charge() {
    const NAME: &str =
        "wallpaper::budget::catalog_tests::cold_global_concurrent_identity_and_permanent_charge";
    if cold_child(NAME) {
        return;
    }
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                let budget = global();
                (
                    budget,
                    hertz_wallpaper::catalog(),
                    hertz_wallpaper::document::catalog::composition_catalog(),
                )
            })
        })
        .collect();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    for (budget, catalog, composition) in &results {
        assert!(std::ptr::eq(*composition, results[0].2));
        assert!(Arc::ptr_eq(budget, &results[0].0));
        assert!(std::ptr::eq(*catalog, results[0].1));
        assert_eq!(budget.usage(), global_usage());
    }
    assert!(Arc::ptr_eq(&global(), &results[0].0));
    assert!(std::ptr::eq(hertz_wallpaper::catalog(), results[0].1));
    assert_eq!(BudgetCoordinator::new().usage(), BudgetUsage::default());
}

#[test]
fn cold_original_catalog_enters_after_both_bookings() {
    const NAME: &str =
        "wallpaper::budget::catalog_tests::cold_original_catalog_enters_after_both_bookings";
    if cold_child(NAME) {
        return;
    }
    let budget = BudgetCoordinator::new();
    let entered = Cell::new(0);
    initialize_for_test(&budget, |ledger| {
        entered.set(entered.get() + 1);
        let usage = ledger.active_usage();
        assert_eq!(
            usage.prepare_cpu_bytes,
            bounds().catalog_cold_requested_bytes()
        );
        assert_eq!(
            usage.asset_cpu_bytes,
            bounds().catalog_retained_requested_bytes()
        );
        assert_eq!(usage.prepare_tasks, 0);
        assert_eq!(usage.reservation_records, 0);
        let catalog = hertz_wallpaper::catalog();
        assert!(catalog.scene("zodiac").is_some());
        assert!(std::ptr::eq(catalog, hertz_wallpaper::catalog()));
        assert_eq!(ledger.active_usage(), usage);
    })
    .unwrap();
    assert_eq!(entered.get(), 1);
    assert_eq!(budget.usage(), scene_usage());
}

#[test]
fn either_cold_quota_rejects_before_initializer_without_token_changes() {
    let fees = bounds();
    for (quota, cap, fee) in [
        (
            "prepare_cpu_bytes",
            MAX_PREPARE_CPU_BYTES,
            fees.catalog_cold_requested_bytes(),
        ),
        (
            "asset_cpu_bytes",
            MAX_ASSET_CPU_BYTES,
            fees.catalog_retained_requested_bytes(),
        ),
    ] {
        for extra in [0, 1] {
            let budget = BudgetCoordinator::new();
            let mut held = request("existing-owner");
            if quota == "prepare_cpu_bytes" {
                held.prepare_cpu_bytes = cap - fee + extra;
            } else {
                held.asset_cpu_bytes = cap - fee + extra;
            }
            let token = budget.grant(&held).unwrap();
            let before = budget.planning_snapshot();
            let entered = Cell::new(0);
            let result = initialize_for_test(&budget, |ledger| {
                entered.set(entered.get() + 1);
                assert!(matches!(
                    ledger.scene_catalog,
                    SceneCatalogCharge::Constructing { .. }
                ));
                let _ = hertz_wallpaper::catalog();
            });
            if extra == 0 {
                result.unwrap();
                assert_eq!(entered.get(), 1);
            } else {
                assert_eq!(result.unwrap_err().quota, quota);
                assert_eq!(entered.get(), 0);
                assert_eq!(budget.planning_snapshot(), before);
                assert_eq!(
                    budget.ledger.lock().unwrap().scene_catalog,
                    SceneCatalogCharge::Uninitialized
                );
            }
            let ledger = budget.ledger.lock().unwrap();
            assert_eq!(ledger.next_token, token + 1);
            assert_eq!(ledger.reservations[0].token, token);
            assert_eq!(
                ledger.reservations[0].request.asset_cpu_bytes,
                held.asset_cpu_bytes
            );
            assert_eq!(
                ledger.reservations[0].request.prepare_cpu_bytes,
                held.prepare_cpu_bytes
            );
            assert_eq!(ledger.reservations[0].state, ReservationState::Active);
        }
    }
}

#[test]
fn partial_panic_drops_resources_before_refund_and_can_retry() {
    let budget = BudgetCoordinator::new();
    let mut held = request("surviving-owner");
    held.asset_cpu_bytes = 17;
    budget.grant(&held).unwrap();
    let before = budget.planning_snapshot();
    let dropped = Cell::new(false);
    struct Partial<'a> {
        ledger: &'a Ledger,
        dropped: &'a Cell<bool>,
        bytes: Vec<u8>,
    }
    impl Drop for Partial<'_> {
        fn drop(&mut self) {
            assert!(matches!(
                self.ledger.scene_catalog,
                SceneCatalogCharge::Constructing { .. }
            ));
            assert_eq!(
                self.ledger.active_usage().prepare_cpu_bytes,
                bounds().catalog_cold_requested_bytes()
            );
            assert!(!self.bytes.is_empty());
            self.dropped.set(true);
        }
    }
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        initialize_for_test(&budget, |ledger| {
            let _partial = Partial {
                ledger,
                dropped: &dropped,
                bytes: vec![1; 4096],
            };
            panic!("partial catalog construction failure");
        })
        .unwrap();
    }));
    assert!(panic.is_err());
    assert!(dropped.get());
    assert_eq!(budget.planning_snapshot(), before);
    assert_eq!(
        budget.ledger.lock().unwrap_err().into_inner().scene_catalog,
        SceneCatalogCharge::Uninitialized
    );
    initialize_for_test(&budget, |_| {
        let _ = hertz_wallpaper::catalog();
    })
    .unwrap();
    assert_eq!(
        budget.usage().asset_cpu_bytes,
        17 + bounds().catalog_retained_requested_bytes()
    );
    assert_eq!(budget.usage().prepare_cpu_bytes, 0);
}

#[test]
fn extreme_requests_use_original_overflow_safe_checks() {
    let budget = BudgetCoordinator::new();
    for quota in ["prepare_cpu_bytes", "asset_cpu_bytes"] {
        let mut oversized = request("oversized");
        if quota == "prepare_cpu_bytes" {
            oversized.prepare_cpu_bytes = u64::MAX;
        } else {
            oversized.asset_cpu_bytes = u64::MAX;
        }
        assert_eq!(budget.grant(&oversized).unwrap_err().quota, quota);
        assert_eq!(budget.usage(), BudgetUsage::default());
    }
}

#[test]
fn cold_normalize_builtin_keeps_errors_and_process_charge() {
    const NAME: &str =
        "wallpaper::budget::catalog_tests::cold_normalize_builtin_keeps_errors_and_process_charge";
    if cold_child(NAME) {
        return;
    }
    use crate::wallpaper::config::normalize_builtin;
    let mut params = serde_json::Map::new();
    assert_eq!(
        normalize_builtin("missing-scene", 1, &mut params)
            .unwrap_err()
            .to_string(),
        "场景不具备桌面资格"
    );
    assert!(params.is_empty());
    normalize_builtin("zodiac", 1, &mut params).unwrap();
    assert_eq!(global().usage(), global_usage());
    let catalog = hertz_wallpaper::catalog();
    let schema = catalog.scene("zodiac").unwrap()["params"]
        .as_object()
        .unwrap();
    for (key, spec) in schema {
        assert_eq!(params[key], spec["default"]);
    }
    assert_eq!(
        normalize_builtin("zodiac", u32::MAX, &mut params)
            .unwrap_err()
            .to_string(),
        "场景状态版本不匹配"
    );
    params.insert("unknown".into(), serde_json::Value::Null);
    assert_eq!(
        normalize_builtin("zodiac", 1, &mut params)
            .unwrap_err()
            .to_string(),
        "场景包含未知参数"
    );
    params.remove("unknown");
    if let Some((key, _)) = schema.iter().next() {
        params.insert(key.clone(), serde_json::Value::Null);
        assert_eq!(
            normalize_builtin("zodiac", 1, &mut params)
                .unwrap_err()
                .to_string(),
            format!("场景参数 {key} 无效")
        );
    }
    assert_eq!(global().usage(), global_usage());
}

#[test]
fn cold_config_default_normalizes_before_any_global_consumer() {
    const NAME: &str = "wallpaper::budget::catalog_tests::cold_config_default_normalizes_before_any_global_consumer";
    if cold_child(NAME) {
        return;
    }
    let config = crate::config::Config::default();
    assert_eq!(global().usage(), global_usage());
    match &config.wallpaper.main().selection {
        crate::wallpaper::config::Selection::FollowHertz { idle_builtin } => {
            let scene = hertz_wallpaper::catalog()
                .scene(&idle_builtin.scene_id)
                .unwrap();
            for (key, spec) in scene["params"].as_object().unwrap() {
                assert_eq!(idle_builtin.params[key], spec["default"]);
            }
        }
        _ => panic!("original default must keep its builtin selection"),
    }
}

#[test]
fn cold_global_real_consumers_preserve_retained_charge() {
    const NAME: &str =
        "wallpaper::budget::catalog_tests::cold_global_real_consumers_preserve_retained_charge";
    if cold_child(NAME) {
        return;
    }
    let budget = global();
    let retained = global_usage().asset_cpu_bytes;
    let mut full = request("full-asset");
    full.asset_cpu_bytes = MAX_ASSET_CPU_BYTES - retained;
    budget.check_requests(std::slice::from_ref(&full)).unwrap();
    let full_token = budget.grant(&full).unwrap();
    assert_eq!(budget.usage().asset_cpu_bytes, MAX_ASSET_CPU_BYTES);
    let mut plus_one = request("one-more");
    plus_one.asset_cpu_bytes = 1;
    assert_eq!(
        budget.grant(&plus_one).unwrap_err().quota,
        "asset_cpu_bytes"
    );
    assert_eq!(
        budget.check_requests(&[plus_one]).unwrap_err().quota,
        "asset_cpu_bytes"
    );
    let projection = budget.project_desktop_replacement(&[1]);
    assert_eq!(projection.usage(), global_usage());
    let mut over = full.clone();
    over.asset_cpu_bytes += 1;
    assert_eq!(
        projection.grant(&over).unwrap_err().quota,
        "asset_cpu_bytes"
    );
    let oversized_plan = SessionPlan::new(
        over,
        vec![ResourcePlan {
            id: "asset".into(),
            maximum: ResourceAmounts::default(),
        }],
    )
    .unwrap();
    assert_eq!(
        projection.grant_session(&oversized_plan).unwrap_err().code,
        "budget_busy"
    );
    budget.release(full_token, "full-asset", 1).unwrap();
    assert_eq!(budget.usage().asset_cpu_bytes, MAX_ASSET_CPU_BYTES);
    budget.confirm_exit(full_token, "full-asset", 1).unwrap();
    assert_eq!(budget.usage().asset_cpu_bytes, retained);
    budget.forget_released(full_token, "full-asset", 1).unwrap();
    assert_eq!(budget.usage(), global_usage());

    let mut session_request = request("resource-owner");
    session_request.asset_cpu_bytes = 64;
    let amounts = ResourceAmounts {
        asset_cpu_bytes: 64,
        ..Default::default()
    };
    let plan = SessionPlan::new(
        session_request,
        vec![ResourcePlan {
            id: "asset".into(),
            maximum: amounts,
        }],
    )
    .unwrap();
    let parent = budget.grant_session(&plan).unwrap();
    let child = budget
        .allocate_resource(parent, "resource-owner", 1, "asset", amounts)
        .unwrap();
    budget.release_resource(child, "resource-owner", 1).unwrap();
    assert_eq!(budget.usage().asset_cpu_bytes, retained + 64);
    budget
        .confirm_resource_exit(child, "resource-owner", 1)
        .unwrap();
    assert_eq!(budget.usage().asset_cpu_bytes, retained + 64);
    budget
        .retire_resource_plan(child, "resource-owner", 1)
        .unwrap();
    assert_eq!(budget.usage().asset_cpu_bytes, retained);
    budget.forget_resource(child, "resource-owner", 1).unwrap();
    budget.release(parent, "resource-owner", 1).unwrap();
    budget.confirm_exit(parent, "resource-owner", 1).unwrap();
    budget.forget_released(parent, "resource-owner", 1).unwrap();
    assert_eq!(budget.usage(), global_usage());
    for quota in ["prepare_cpu_bytes", "asset_cpu_bytes"] {
        let mut oversized = request("oversized");
        if quota == "prepare_cpu_bytes" {
            oversized.prepare_cpu_bytes = u64::MAX;
        } else {
            oversized.asset_cpu_bytes = u64::MAX;
        }
        assert_eq!(budget.grant(&oversized).unwrap_err().quota, quota);
        assert_eq!(
            budget
                .check_requests(std::slice::from_ref(&oversized))
                .unwrap_err()
                .quota,
            quota
        );
        assert_eq!(budget.usage(), global_usage());
    }
    let token = budget.grant(&request("purge-owner")).unwrap();
    budget.release(token, "purge-owner", 1).unwrap();
    assert_eq!(budget.purge_session("purge-owner", 1), 1);
    assert_eq!(budget.usage(), global_usage());
    let mut metadata_request = request("metadata-owner");
    metadata_request.owner = OwnerKind::Probe;
    metadata_request.targets = 0;
    for _ in 0..MAX_RESERVATIONS {
        budget.grant(&metadata_request).unwrap();
    }
    assert_eq!(
        budget.grant(&metadata_request).unwrap_err().quota,
        "reservation_metadata"
    );
    assert_eq!(budget.purge_session("metadata-owner", 1), MAX_RESERVATIONS);
    assert_eq!(budget.usage(), global_usage());
}
