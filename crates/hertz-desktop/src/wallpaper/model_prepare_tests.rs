// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::assets::{
    installed_full_model_fixture, model_source_test_probe, model_source_writable,
};
use std::{
    fs::File,
    io::{Cursor, Read},
    time::Duration,
};

#[test]
fn original_installed_rich_triangle_variant_hash_facts_and_last_outer_clone() {
    let fixture = installed_full_model_fixture("model-input-full", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("input-full".into(), 73).unwrap();
    let sibling = probe
        .job_memory(&preparation, "model-source", 0, 17)
        .unwrap();
    let baseline = probe.budget_for_test().usage();
    let records = probe.budget_for_test().record_count_for_test();
    for variant in [None, Some("low")] {
        let mut reference = fixture.reference.clone();
        reference.variant_id = variant.map(str::to_owned);
        let input = fixture
            .store
            .prepare_canonical_model_input(
                &reference,
                &probe,
                &preparation,
                &AtomicBool::new(false),
            )
            .unwrap();
        let path = if variant.is_some() {
            "models/a/low.glb"
        } else {
            "models/a/source.glb"
        };
        let mut bytes = Vec::new();
        File::open(
            fixture
                .store
                .package_dir(&reference.package_hash)
                .join("files")
                .join(path),
        )
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
        let original = hertz_wallpaper::model_binary::inspect_glb_resource_content(
            Cursor::new(&bytes),
            bytes.len() as u64,
            &fixture.package.manifest,
            path,
        )
        .unwrap();
        assert_eq!(input.facts().structure(), &original.resource().structure);
        assert_eq!(input.facts().sha256(), original.sha256());
        assert_eq!(
            input.facts().binary(),
            original.resource().container.binary.as_ref()
        );
        assert_eq!(input.facts().bytes(), bytes.len() as u64);
        assert_eq!(
            (
                input.facts().unique_layouts(),
                input.facts().checked_elements(),
                input.facts().checked_components()
            ),
            (
                original.unique_layouts(),
                original.checked_elements(),
                original.checked_components()
            )
        );
        assert_eq!(input.facts().structure().mesh_triangles_upper_bound, 2);
        assert_eq!(input.facts().source_path(), path);
        assert_eq!(
            input.reservation_identity_for_test(),
            ("input-full", 73, "model-input")
        );
        let clone = input.clone();
        let held = probe.budget_for_test().usage();
        drop(input);
        assert_eq!(probe.budget_for_test().usage(), held);
        assert!(!model_source_writable(&fixture.store, &reference, path));
        assert_eq!(held.prepare_cpu_bytes, 0);
        drop(clone);
        assert_eq!(probe.budget_for_test().usage(), baseline);
        assert_eq!(probe.budget_for_test().record_count_for_test(), records);
        assert!(model_source_writable(&fixture.store, &reference, path));
    }
    assert!(!fixture.root.path().join("user-source.hwpkg").exists());
    sibling.finish();
    preparation.finish();
    assert!(probe.budget_for_test().stuck().is_empty());
}

#[test]
fn source_success_then_actual_model_w_rejection_keeps_source_fee_and_pins_until_error_drop() {
    let fixture = installed_full_model_fixture("model-input-W", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("model-W".into(), 19).unwrap();
    let mut held = None;
    let mut observer = |stage| {
        if stage == ModelStage::SourceReady {
            held = Some(
                probe
                    .image_workspace(budget::MAX_PREPARE_CPU_BYTES)
                    .unwrap(),
            );
        }
    };
    let error = fixture
        .store
        .prepare_model_input_inner(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
            Some(&mut observer),
        )
        .err()
        .unwrap();
    assert_eq!(error.job_error().code, "budget_busy");
    assert_eq!(
        error.reservation_identity_for_test(),
        Some(("model-W", 19, "model-source"))
    );
    assert!(probe.budget_for_test().usage().asset_cpu_bytes > 0);
    assert!(!model_source_writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    drop(error);
    assert_eq!(probe.budget_for_test().usage().asset_cpu_bytes, 0);
    assert!(model_source_writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    held.unwrap().finish();
    preparation.finish();
    assert_eq!(probe.budget_for_test().record_count_for_test(), 0);
}

#[test]
fn actual_compact_r_rejection_returns_w_only_guard_after_physical_source_exit() {
    let fixture = installed_full_model_fixture("model-input-R", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("model-R".into(), 29).unwrap();
    let sibling = probe
        .job_memory(&preparation, "model-source", 0, 17)
        .unwrap();
    let mut held = None;
    let mut observer = |stage| {
        if stage == ModelStage::Compacted {
            let available =
                budget::MAX_ASSET_CPU_BYTES - probe.budget_for_test().usage().asset_cpu_bytes;
            held = Some(
                probe
                    .job_memory(&preparation, "model-source", 0, available)
                    .unwrap(),
            );
        }
    };
    let error = fixture
        .store
        .prepare_model_input_inner(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
            Some(&mut observer),
        )
        .err()
        .unwrap();
    assert_eq!(error.job_error().code, "budget_busy");
    assert_eq!(
        error.reservation_identity_for_test(),
        Some(("model-R", 29, "model-inspection"))
    );
    assert!(probe.budget_for_test().usage().prepare_cpu_bytes > 296_000_000);
    assert!(model_source_writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    let asset = probe.budget_for_test().usage().asset_cpu_bytes;
    assert!(asset >= 17);
    drop(error);
    assert_eq!(probe.budget_for_test().usage().prepare_cpu_bytes, 0);
    assert_eq!(probe.budget_for_test().usage().asset_cpu_bytes, asset);
    held.unwrap().finish();
    assert_eq!(probe.budget_for_test().usage().asset_cpu_bytes, 17);
    sibling.finish();
    preparation.finish();
    assert_eq!(probe.budget_for_test().record_count_for_test(), 0);
    assert!(probe.budget_for_test().stuck().is_empty());
}

#[test]
fn sixty_four_record_frontier_after_source_retains_source_guard_without_extra_error_grant() {
    let fixture = installed_full_model_fixture("model-input-records", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("model-records".into(), 39).unwrap();
    let mut held = Vec::new();
    let mut observer = |stage| {
        if stage == ModelStage::SourceReady {
            while probe.budget_for_test().record_count_for_test() < 64 {
                held.push(
                    probe
                        .job_memory(&preparation, "model-source", 0, 1)
                        .unwrap(),
                );
            }
        }
    };
    let error = fixture
        .store
        .prepare_model_input_inner(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
            Some(&mut observer),
        )
        .err()
        .unwrap();
    assert_eq!(error.job_error().code, "budget_busy");
    assert!(error.job_error().message.contains("reservation_metadata"));
    assert_eq!(probe.budget_for_test().record_count_for_test(), 64);
    drop(error);
    assert_eq!(probe.budget_for_test().record_count_for_test(), 63);
    for token in held {
        token.finish();
    }
    preparation.finish();
    assert_eq!(probe.budget_for_test().record_count_for_test(), 0);
}

#[test]
fn long_invalid_resource_reaches_original_inspector_then_normalizes_under_w() {
    let fixture = installed_full_model_fixture("model-input-invalid-resource-test-install", true);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("invalid-model".into(), 49).unwrap();
    let bytes = std::fs::read(
        fixture
            .store
            .package_dir(&fixture.reference.package_hash)
            .join("files/models/a/source.glb"),
    )
    .unwrap();
    let original = hertz_wallpaper::model_binary::inspect_glb_resource_content(
        Cursor::new(&bytes),
        bytes.len() as u64,
        &fixture.package.manifest,
        "models/a/source.glb",
    )
    .err()
    .unwrap();
    assert!(original.message.len() > 20_000);
    let code = original.code;
    drop(original);
    let error = fixture
        .store
        .prepare_canonical_model_input(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .err()
        .unwrap();
    assert_eq!(error.job_error().code, code);
    assert_eq!(error.job_error().message, MODEL_DIAGNOSTIC);
    assert_eq!(error.job_error().message.capacity(), MODEL_DIAGNOSTIC.len());
    assert_eq!(
        error.reservation_identity_for_test(),
        Some(("invalid-model", 49, "model-inspection"))
    );
    assert!(probe.budget_for_test().usage().prepare_cpu_bytes > 0);
    assert!(model_source_writable(
        &fixture.store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    drop(error);
    assert_eq!(probe.budget_for_test().usage().prepare_cpu_bytes, 0);
    preparation.finish();
}

#[test]
fn unique_source_refusal_precedes_read_and_real_read_return_cancel_retains_w_until_error_drop() {
    let fixture = installed_full_model_fixture("model-input-real-read", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("model-read".into(), 59).unwrap();
    let mut source = fixture
        .store
        .pin_canonical_model_source(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let clone = source.clone();
    let mut reads = 0;
    let error = source
        .inspect_model_content_observed(&AtomicBool::new(false), &mut || reads += 1)
        .err()
        .unwrap();
    assert_eq!(error.code, "model_source_shared");
    assert_eq!(reads, 0);
    drop(clone);
    drop(source);
    let cancel = Arc::new(AtomicBool::new(false));
    let child_cancel = Arc::clone(&cancel);
    let (entered_tx, entered) = std::sync::mpsc::channel();
    let (release_tx, release) = std::sync::mpsc::channel();
    let store = fixture.store;
    let reference = fixture.reference.clone();
    let child_probe = probe.clone();
    let thread = std::thread::spawn(move || {
        let mut reads = 0;
        let mut observer = |stage| {
            if stage == ModelStage::ReadReturned {
                reads += 1;
                if reads == 1 {
                    entered_tx.send(()).unwrap();
                    release.recv_timeout(Duration::from_secs(10)).unwrap();
                }
            }
        };
        let error = store
            .prepare_model_input_inner(
                &reference,
                &child_probe,
                &preparation,
                &child_cancel,
                Some(&mut observer),
            )
            .err()
            .unwrap();
        (error, preparation, store)
    });
    entered.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(probe.budget_for_test().usage().prepare_cpu_bytes > 0);
    assert!(probe.budget_for_test().usage().asset_cpu_bytes > 0);
    cancel.store(true, Ordering::Release);
    assert!(probe.budget_for_test().usage().prepare_cpu_bytes > 0);
    release_tx.send(()).unwrap();
    let (error, preparation, store) = thread.join().unwrap();
    assert_eq!(error.job_error().code, "cancelled");
    assert_eq!(
        error.reservation_identity_for_test(),
        Some(("model-read", 59, "model-inspection"))
    );
    assert_eq!(probe.budget_for_test().usage().asset_cpu_bytes, 0);
    assert!(model_source_writable(
        &store,
        &fixture.reference,
        "models/a/source.glb"
    ));
    drop(error);
    preparation.finish();
    assert_eq!(probe.budget_for_test().record_count_for_test(), 0);
}

#[test]
fn model_controls_actual_native_layout_and_unchanged_original_max_j_equation() {
    let fixture = installed_full_model_fixture("model-input-layout", false);
    let probe = model_source_test_probe();
    let preparation = probe.prepare_for_job("layout".into(), 69).unwrap();
    let old = fixture
        .store
        .pin_canonical_model_source(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
        )
        .unwrap();
    let old_charge = old.retained_source_charge();
    drop(old);
    let new = fixture
        .store
        .pin_model_input_source(
            &fixture.reference,
            &probe,
            &preparation,
            &AtomicBool::new(false),
            model_controls().unwrap(),
        )
        .unwrap();
    assert_eq!(
        new.retained_source_charge() - old_charge,
        model_controls().unwrap()
    );
    assert_eq!(
        budget::ordinary_memory_grant_diagnostic_heap_bytes(),
        Some(987)
    );
    let model =
        ModelHeapBounds::for_json_bytes(hertz_wallpaper::MAX_TEXT_BYTES, new.manifest()).unwrap();
    let joined = model
        .workspace_with_live_base(new.retained_source_charge())
        .unwrap();
    assert_eq!(
        joined,
        model.workspace_requested_bytes() + new.retained_source_charge()
    );
    println!("native inner={} arc={} Cmodel={} query59 grant987 literal={} modelW={} sourceR={} joinedW={joined}",std::mem::size_of::<Inner>(),arc_allocation_bytes::<Inner>().unwrap(),model_controls().unwrap(),MODEL_DIAGNOSTIC.len(),model.workspace_requested_bytes(),new.retained_source_charge());
    drop(new);
    preparation.finish();
}
