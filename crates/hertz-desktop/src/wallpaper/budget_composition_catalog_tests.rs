// SPDX-License-Identifier: MIT
//! Test-only seams inside the original initializer, before its real OnceLocks.
//! No hook exists between successful publication and the inline ledger commit.
use super::*;
use hertz_wallpaper::document::catalog::CompositionCatalogHeapBounds;
use std::{
    cell::{Cell, RefCell},
    process::Command,
};

type Hook = (CatalogKind, Box<dyn FnOnce(&Ledger)>);
thread_local! {
    static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) };
    static REJECT_SOURCE: Cell<bool> = const { Cell::new(false) };
    static SCENE_CALLS: Cell<usize> = const { Cell::new(0) };
    static COMPOSITION_CALLS: Cell<usize> = const { Cell::new(0) };
}

pub(super) fn before_construct(kind: CatalogKind, ledger: &Ledger) {
    match kind {
        CatalogKind::Scene => SCENE_CALLS.with(|count| count.set(count.get() + 1)),
        CatalogKind::Composition => COMPOSITION_CALLS.with(|count| count.set(count.get() + 1)),
    }
    let hook = HOOK.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.as_ref().is_some_and(|hook| hook.0 == kind) {
            slot.take()
        } else {
            None
        }
    });
    if let Some((_, hook)) = hook {
        hook(ledger);
    }
}

pub(super) fn qualify_composition(
    bounds: Option<CompositionCatalogHeapBounds>,
) -> Option<CompositionCatalogHeapBounds> {
    if REJECT_SOURCE.with(Cell::get) {
        None
    } else {
        bounds
    }
}

fn fees() -> CompositionCatalogHeapBounds {
    CompositionCatalogHeapBounds::for_embedded_catalog().unwrap()
}
fn scene_retained() -> u64 {
    hertz_wallpaper::manifest::ManifestHeapBounds::for_bytes(0)
        .unwrap()
        .catalog_retained_requested_bytes()
}
fn process_scene_retained() -> u64 {
    bootstrap::retained_requested_bytes().unwrap() + scene_retained()
}
fn total_retained() -> u64 {
    process_scene_retained() + fees().retained_requested_bytes()
}
fn calls() -> (usize, usize) {
    (
        SCENE_CALLS.with(Cell::get),
        COMPOSITION_CALLS.with(Cell::get),
    )
}
fn hook(kind: CatalogKind, action: impl FnOnce(&Ledger) + 'static) {
    HOOK.with(|slot| *slot.borrow_mut() = Some((kind, Box::new(action))));
}
fn child(name: &str) -> bool {
    if std::env::var("HERTZ_COMPOSITION_COLD_CHILD").as_deref() == Ok(name) {
        return false;
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture", "--test-threads=1"])
        .env("HERTZ_COMPOSITION_COLD_CHILD", name)
        .output()
        .unwrap();
    println!(
        "cold child {name}: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    true
}
fn catch_global() {
    assert!(std::panic::catch_unwind(global).is_err());
}
fn request(session: &str) -> BudgetRequest {
    BudgetRequest {
        owner: OwnerKind::Probe,
        session: session.into(),
        generation: 1,
        task_id: "composition-catalog".into(),
        targets: 0,
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

#[test]
fn cold_original_both_catalog_callbacks_follow_quota_bookings_and_publish_once() {
    const NAME: &str = "wallpaper::budget::composition_catalog_tests::cold_original_both_catalog_callbacks_follow_quota_bookings_and_publish_once";
    if child(NAME) {
        return;
    }
    hook(CatalogKind::Scene, |ledger| {
        let scene = hertz_wallpaper::manifest::ManifestHeapBounds::for_bytes(0).unwrap();
        assert_eq!(
            ledger.active_usage().prepare_cpu_bytes,
            scene.catalog_cold_requested_bytes()
        );
        assert_eq!(
            ledger.active_usage().asset_cpu_bytes,
            process_scene_retained()
        );
        assert_eq!(
            ledger.composition_catalog,
            SceneCatalogCharge::Uninitialized
        );
        // Install the second boundary hook before the first real parser runs.
        hook(CatalogKind::Composition, |ledger| {
            assert_eq!(
                ledger.active_usage().prepare_cpu_bytes,
                fees().cold_requested_bytes()
            );
            assert_eq!(ledger.active_usage().asset_cpu_bytes, total_retained());
            assert_eq!(ledger.active_usage().reservation_records, 0);
            assert_eq!(ledger.active_usage().prepare_tasks, 0);
            assert!(matches!(
                ledger.scene_catalog,
                SceneCatalogCharge::Initialized { .. }
            ));
        });
    });
    let budget = global();
    let scene = hertz_wallpaper::catalog();
    let composition = hertz_wallpaper::document::catalog::composition_catalog();
    assert_eq!(calls(), (1, 1));
    assert_eq!(budget.usage().asset_cpu_bytes, total_retained());
    assert_eq!(budget.usage().prepare_cpu_bytes, 0);
    for _ in 0..5 {
        assert!(Arc::ptr_eq(&global(), &budget));
        assert!(std::ptr::eq(hertz_wallpaper::catalog(), scene));
        assert!(std::ptr::eq(
            hertz_wallpaper::document::catalog::composition_catalog(),
            composition
        ));
    }
    assert_eq!(calls(), (1, 1));
    println!(
        "real cold scene/composition initializations=1/1, permanent={}",
        total_retained()
    );
}

#[test]
fn cold_composition_partial_drop_precedes_refund_and_same_static_arc_retries_only_composition() {
    const NAME: &str = "wallpaper::budget::composition_catalog_tests::cold_composition_partial_drop_precedes_refund_and_same_static_arc_retries_only_composition";
    if child(NAME) {
        return;
    }
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observer = Arc::clone(&dropped);
    hook(CatalogKind::Composition, move |ledger| {
        struct Partial<'a> {
            ledger: &'a Ledger,
            bytes: Vec<u8>,
            dropped: Arc<std::sync::atomic::AtomicBool>,
        }
        impl Drop for Partial<'_> {
            fn drop(&mut self) {
                assert!(matches!(
                    self.ledger.composition_catalog,
                    SceneCatalogCharge::Constructing { .. }
                ));
                assert!(matches!(
                    self.ledger.scene_catalog,
                    SceneCatalogCharge::Initialized { .. }
                ));
                assert_eq!(
                    self.ledger.active_usage().prepare_cpu_bytes,
                    fees().cold_requested_bytes()
                );
                assert_eq!(self.ledger.active_usage().asset_cpu_bytes, total_retained());
                assert_eq!(self.bytes.len(), 4096);
                self.dropped
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let _partial = Partial {
            ledger,
            bytes: vec![1; 4096],
            dropped: observer,
        };
        panic!("composition partial construction");
    });
    catch_global();
    assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    let budget = Arc::clone(BUDGET.get().unwrap());
    assert_eq!(calls(), (1, 1));
    assert_eq!(budget.usage().asset_cpu_bytes, process_scene_retained());
    assert_eq!(budget.usage().prepare_cpu_bytes, 0);
    assert!(budget.ledger.is_poisoned());
    assert_eq!(
        budget
            .ledger
            .lock()
            .unwrap_err()
            .into_inner()
            .composition_catalog,
        SceneCatalogCharge::Uninitialized
    );
    let scene = hertz_wallpaper::catalog();
    assert!(Arc::ptr_eq(&global(), &budget));
    assert!(std::ptr::eq(hertz_wallpaper::catalog(), scene));
    assert_eq!(calls(), (1, 2));
    assert_eq!(budget.usage().asset_cpu_bytes, total_retained());
    assert_eq!(global().usage(), budget.usage());
}

#[test]
fn cold_source_failure_preserves_scene_and_poison_retry_uses_same_arc() {
    const NAME: &str = "wallpaper::budget::composition_catalog_tests::cold_source_failure_preserves_scene_and_poison_retry_uses_same_arc";
    if child(NAME) {
        return;
    }
    REJECT_SOURCE.with(|flag| flag.set(true));
    catch_global();
    let budget = Arc::clone(BUDGET.get().unwrap());
    assert_eq!(calls(), (1, 0));
    assert_eq!(budget.usage().asset_cpu_bytes, process_scene_retained());
    assert_eq!(budget.usage().prepare_cpu_bytes, 0);
    REJECT_SOURCE.with(|flag| flag.set(false));
    assert!(Arc::ptr_eq(&global(), &budget));
    assert_eq!(calls(), (1, 1));
    assert_eq!(budget.usage().asset_cpu_bytes, total_retained());
}

#[test]
fn cold_scene_publish_then_composition_asset_denial_keeps_original_static_arc() {
    const NAME: &str = "wallpaper::budget::composition_catalog_tests::cold_scene_publish_then_composition_asset_denial_keeps_original_static_arc";
    if child(NAME) {
        return;
    }
    let budget = BUDGET.get_or_init(BudgetCoordinator::new_process);
    let mut held = request("same-call-denial");
    held.asset_cpu_bytes = MAX_ASSET_CPU_BYTES - total_retained() + 1;
    let token = budget.grant(&held).unwrap();
    let before = budget.planning_snapshot();
    catch_global();
    assert_eq!(calls(), (1, 0));
    assert!(std::ptr::eq(BUDGET.get().unwrap(), budget));
    assert_eq!(
        budget.usage().asset_cpu_bytes,
        held.asset_cpu_bytes + process_scene_retained()
    );
    assert_eq!(budget.usage().prepare_cpu_bytes, 0);
    let ledger = budget.ledger.lock().unwrap_err().into_inner();
    assert_eq!(ledger.next_token, token + 1);
    assert_eq!(ledger.revision, before.0);
    assert_eq!(
        ledger.composition_catalog,
        SceneCatalogCharge::Uninitialized
    );
    assert!(matches!(
        ledger.scene_catalog,
        SceneCatalogCharge::Initialized { .. }
    ));
    drop(ledger);
    budget.release(token, "same-call-denial", 1).unwrap();
    budget.confirm_exit(token, "same-call-denial", 1).unwrap();
    budget
        .forget_released(token, "same-call-denial", 1)
        .unwrap();
    assert!(Arc::ptr_eq(&global(), budget));
    assert_eq!(calls(), (1, 1));
    assert_eq!(budget.usage().asset_cpu_bytes, total_retained());
}

#[test]
fn cold_each_composition_quota_rejects_before_callback_and_retries_after_owner_exit() {
    const NAME: &str = "wallpaper::budget::composition_catalog_tests::cold_each_composition_quota_rejects_before_callback_and_retries_after_owner_exit";
    if child(NAME) {
        return;
    }
    // First obtain the real scene publication while composition is unready.
    REJECT_SOURCE.with(|flag| flag.set(true));
    catch_global();
    REJECT_SOURCE.with(|flag| flag.set(false));
    let budget = Arc::clone(BUDGET.get().unwrap());
    for quota in ["prepare_cpu_bytes", "asset_cpu_bytes"] {
        let mut held = request(quota);
        if quota == "prepare_cpu_bytes" {
            held.prepare_cpu_bytes = MAX_PREPARE_CPU_BYTES - fees().cold_requested_bytes() + 1;
        } else {
            held.asset_cpu_bytes = MAX_ASSET_CPU_BYTES - total_retained() + 1;
        }
        let token = budget.grant(&held).unwrap();
        let before = budget.planning_snapshot();
        catch_global();
        assert_eq!(calls(), (1, 0));
        assert_eq!(budget.planning_snapshot(), before);
        let ledger = budget.ledger.lock().unwrap_err().into_inner();
        assert_eq!(ledger.next_token, token + 1);
        assert_eq!(
            ledger.composition_catalog,
            SceneCatalogCharge::Uninitialized
        );
        assert!(matches!(
            ledger.scene_catalog,
            SceneCatalogCharge::Initialized { .. }
        ));
        drop(ledger);
        budget.release(token, quota, 1).unwrap();
        budget.confirm_exit(token, quota, 1).unwrap();
        budget.forget_released(token, quota, 1).unwrap();
        assert_eq!(budget.usage().asset_cpu_bytes, process_scene_retained());
    }
    assert!(Arc::ptr_eq(&global(), &budget));
    assert_eq!(calls(), (1, 1));
    assert_eq!(budget.usage().asset_cpu_bytes, total_retained());
}

#[test]
fn composition_quota_exact_boundary_and_extreme_numbers_use_original_checks() {
    for quota in ["prepare_cpu_bytes", "asset_cpu_bytes"] {
        for extra in [0, 1] {
            let budget = BudgetCoordinator::new();
            let mut held = request(quota);
            if quota == "prepare_cpu_bytes" {
                held.prepare_cpu_bytes =
                    MAX_PREPARE_CPU_BYTES - fees().cold_requested_bytes() + extra;
            } else {
                held.asset_cpu_bytes =
                    MAX_ASSET_CPU_BYTES - fees().retained_requested_bytes() + extra;
            }
            let token = budget.grant(&held).unwrap();
            let before = budget.planning_snapshot();
            let mut ledger = budget.ledger.lock().unwrap();
            let result = SceneCatalogReservation::reserve_for(
                &mut ledger,
                CatalogKind::Composition,
                fees().cold_requested_bytes(),
                fees().retained_requested_bytes(),
            );
            if extra == 1 {
                assert_eq!(result.err().unwrap().quota, quota);
            } else {
                let reservation = result.unwrap();
                assert_eq!(
                    reservation.ledger.active_usage().prepare_cpu_bytes,
                    held.prepare_cpu_bytes + fees().cold_requested_bytes()
                );
                reservation.commit();
            }
            assert_eq!(ledger.next_token, token + 1);
            drop(ledger);
            if extra == 1 {
                assert_eq!(budget.planning_snapshot(), before);
            }
        }
        let budget = BudgetCoordinator::new();
        let mut ledger = budget.ledger.lock().unwrap();
        let (cold, retained) = if quota == "prepare_cpu_bytes" {
            (u64::MAX, 1)
        } else {
            (1, u64::MAX)
        };
        assert_eq!(
            SceneCatalogReservation::reserve_for(
                &mut ledger,
                CatalogKind::Composition,
                cold,
                retained
            )
            .err()
            .unwrap()
            .quota,
            quota
        );
        assert_eq!(ledger.active_usage(), BudgetUsage::default());
    }
}

#[test]
fn cold_asset_store_factory_admits_both_before_root_and_package_paths() {
    const NAME: &str = "wallpaper::budget::composition_catalog_tests::cold_asset_store_factory_admits_both_before_root_and_package_paths";
    if child(NAME) {
        return;
    }
    let root = std::env::temp_dir().join(format!("hertz-r23-catalog-{}", std::process::id()));
    let path = root.clone();
    hook(CatalogKind::Composition, move |ledger| {
        assert!(
            !path.exists(),
            "catalog barrier must precede AssetStore filesystem work"
        );
        assert_eq!(ledger.active_usage().asset_cpu_bytes, total_retained());
    });
    let store = crate::wallpaper::assets::AssetStore::new(&root).unwrap();
    assert_eq!(calls(), (1, 1));
    assert_eq!(global().usage().asset_cpu_bytes, total_retained());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(global().usage().asset_cpu_bytes, total_retained());
}
