// SPDX-License-Identifier: MIT
use super::*;
use hertz_wallpaper::{document::compile_document, validate_manifest_bytes};
use serde_json::json;

fn document(nodes: Value) -> Value {
    json!({"documentVersion":1,"canvas":{"width":1920,"height":1080,"colorSpace":"srgb","background":"#000000"},
        "nodes":nodes,"timeline":{"durationSeconds":4,"loop":true,"tracks":[]},"bindings":[],"effects":[]})
}

fn builtin(scene: &str) -> Value {
    json!({"id":"background","type":"builtinScene","stateVersion":1,
        "properties":{"sceneId":scene,"stateVersion":1,"params":{}}})
}

fn compile(document: Value, properties: Value) -> CompiledDocument {
    let bytes = serde_json::to_vec(&document).unwrap();
    let manifest = validate_manifest_bytes(&serde_json::to_vec(&json!({
        "formatVersion":1,"workId":"c17ed10a-5c55-4a52-85dc-7509f9e88aae","version":1,"title":"builtin native plan",
        "content":{"kind":"composition","document":"composition.json"},"assets":[],
        "files":[{"path":"composition.json","bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"mime":"application/json"}],
        "properties":properties,"permissions":{"audioSpectrum":false,"pointer":false},
        "license":{"code":"none","assets":"none","attribution":""}
    })).unwrap()).unwrap();
    compile_document(&bytes, &manifest).unwrap()
}

fn facts(width: u32, height: u32, scale: f64) -> TargetFacts {
    TargetFacts {
        monitor_id: "native-monitor-1".into(),
        monitor_left: -2560,
        monitor_top: 80,
        physical_width: width,
        physical_height: height,
        device_scale: scale,
        requested_quality: "high".into(),
        requested_fps: 60,
        refresh_hz: 144,
        purpose: ImagePurpose::High,
    }
}

fn target(facts: &TargetFacts) -> ImageTarget {
    ImageTarget {
        width: facts.physical_width,
        height: facts.physical_height,
        fit: image_prepare::ImageFit::Cover,
        purpose: facts.purpose,
    }
}

fn resolved(
    compiled: &CompiledDocument,
    facts: &TargetFacts,
    fit: Fit,
    budget: &BudgetCoordinator,
) -> BuiltinTargetPlan {
    let final_values = compiled.final_public_values(&Default::default()).unwrap();
    plan(
        compiled,
        &final_values,
        target(facts),
        fit,
        Some(facts),
        budget,
    )
    .unwrap()
    .unwrap()
}

#[test]
fn dpr_and_portrait_use_one_floor_raster_and_source_low() {
    let compiled = compile(document(json!([builtin("spectrum-towers")])), json!([]));
    let budget = BudgetCoordinator::new();
    for (width, height, scale, raster) in [
        (2560, 1600, 1.0, (1264, 790)),
        (2560, 1600, 1.5, (1264, 790)),
        (2560, 1600, 2.0, (1088, 680)),
        (1600, 2560, 1.5, (790, 1264)),
    ] {
        let facts = facts(width, height, scale);
        let result = resolved(&compiled, &facts, Fit::Cover, &budget);
        assert_eq!((result.target.width, result.target.height), raster);
        assert!(u64::from(result.target.width) * u64::from(result.target.height) <= 1_000_000);
        assert!(result.effective_dpr <= scale && result.effective_dpr <= result.profile.dpr_cap);
        assert_eq!(result.actual_quality, "low");
        assert_eq!(result.requested_quality, "high");
        assert!(result.downgrade_reason.is_some());
        assert_eq!(result.allowance.effective_fps, 30);
        assert_eq!(result.allowance.frame_divisor, 5);
        assert_eq!(result.profile.source_resources.cpu_peak_bytes, 90248);
        assert_eq!(result.profile.source_resources.cpu_retained_bytes, 53512);
        assert_eq!(result.profile.source_resources.buffer_bytes, 53488);
    }
    assert_eq!(budget.planning_snapshot(), (1, Default::default()));
}

#[test]
fn final_public_values_reject_nonzero_predicate_and_keep_all_constants() {
    let compiled = compile(
        document(json!([builtin("spectrum-towers")])),
        json!([
            {"id":"ripple","label":"Ripple","type":"number","default":0,"constraints":{"min":0,"max":1},
                "target":{"kind":"node","nodeId":"background","property":"ripples","component":null}},
            {"id":"director","label":"Director","type":"boolean","default":false,"constraints":{},
                "target":{"kind":"node","nodeId":"background","property":"director","component":null}},
            {"id":"cue","label":"Cue","type":"select","default":"auto","constraints":{"options":[{"value":"auto","label":"Auto"},{"value":"bridge","label":"Bridge"}]},
                "target":{"kind":"node","nodeId":"background","property":"cue","component":null}}
        ]),
    );
    let facts = facts(2560, 1600, 1.5);
    let budget = BudgetCoordinator::new();
    let final_values = compiled
        .final_public_values(&BTreeMap::from([
            ("director".into(), json!(true)),
            ("cue".into(), json!("bridge")),
        ]))
        .unwrap();
    let result = plan(
        &compiled,
        &final_values,
        target(&facts),
        Fit::Contain,
        Some(&facts),
        &budget,
    )
    .unwrap()
    .unwrap();
    assert_eq!(result.final_params["director"], true);
    assert_eq!(result.final_params["cue"], "bridge");
    assert_eq!(result.final_params["ripples"].as_f64(), Some(0.0));
    assert!(result.final_params.contains_key("density"));
    assert!(!result.final_params.contains_key("x"));
    let invalid = compiled
        .final_public_values(&BTreeMap::from([("ripple".into(), json!(0.5))]))
        .unwrap();
    let error = plan(
        &compiled,
        &invalid,
        target(&facts),
        Fit::Contain,
        Some(&facts),
        &budget,
    )
    .unwrap_err();
    assert_eq!(error.code, "adapter_unavailable");
    for part in [
        "node=background",
        "scene=spectrum-towers",
        "parameter=ripples",
    ] {
        assert!(error.message.contains(part), "{}", error.message);
    }
}

#[test]
fn metadata_absence_versions_profiles_and_bad_resources_fail_closed() {
    let compiled = compile(document(json!([builtin("spectrum-towers")])), json!([]));
    let final_values = compiled.final_public_values(&Default::default()).unwrap();
    let facts = facts(2560, 1600, 1.5);
    let budget = BudgetCoordinator::new();
    for edit in 0..7 {
        let mut catalog = hertz_wallpaper::catalog().clone();
        let scene = catalog
            .scenes
            .iter_mut()
            .find(|scene| scene["id"] == "spectrum-towers")
            .unwrap();
        match edit {
            0 => {
                scene.as_object_mut().unwrap().remove("composition");
            }
            1 => scene["composition"]["contractVersion"] = json!(2),
            2 => scene["composition"]["adapterVersion"] = json!(2),
            3 => scene["composition"]["supportedStateVersions"] = json!([2]),
            4 => {
                scene["composition"]["qualities"]
                    .as_object_mut()
                    .unwrap()
                    .remove("low");
            }
            5 => {
                scene["composition"]["qualities"]["low"]["sourceResources"]["cpuPeakBytes"] =
                    json!(1)
            }
            _ => scene["composition"]["clock"]["version"] = json!(2),
        }
        assert_eq!(
            plan_with_catalog(
                &compiled,
                &final_values,
                target(&facts),
                Fit::Cover,
                Some(&facts),
                &budget,
                &catalog
            )
            .unwrap_err()
            .code,
            "adapter_unavailable"
        );
    }
    let other = compile(document(json!([builtin("zodiac")])), json!([]));
    let other_final = other.final_public_values(&Default::default()).unwrap();
    assert!(plan(
        &other,
        &other_final,
        target(&facts),
        Fit::Cover,
        Some(&facts),
        &budget
    )
    .unwrap_err()
    .message
    .contains("未发布 composition"));
    assert_eq!(budget.usage(), Default::default());
}

#[test]
fn missing_nonfinite_zero_and_out_of_range_native_facts_are_rejected() {
    let compiled = compile(document(json!([builtin("spectrum-towers")])), json!([]));
    let final_values = compiled.final_public_values(&Default::default()).unwrap();
    let facts = facts(2560, 1600, 1.5);
    let budget = BudgetCoordinator::new();
    assert!(plan(
        &compiled,
        &final_values,
        target(&facts),
        Fit::Cover,
        None,
        &budget
    )
    .unwrap_err()
    .message
    .contains("DPI"));
    for scale in [0.0, f64::NAN, f64::INFINITY, 0.4, 8.1] {
        let mut invalid = facts.clone();
        invalid.device_scale = scale;
        assert!(plan(
            &compiled,
            &final_values,
            target(&invalid),
            Fit::Cover,
            Some(&invalid),
            &budget
        )
        .is_err());
    }
    for invalid in [
        TargetFacts {
            physical_width: 0,
            ..facts.clone()
        },
        TargetFacts {
            physical_height: 0,
            ..facts.clone()
        },
        TargetFacts {
            monitor_id: String::new(),
            ..facts.clone()
        },
        TargetFacts {
            requested_quality: "ultra".into(),
            ..facts.clone()
        },
        TargetFacts {
            purpose: ImagePurpose::Preview,
            ..facts.clone()
        },
    ] {
        assert!(plan(
            &compiled,
            &final_values,
            target(&facts),
            Fit::Cover,
            Some(&invalid),
            &budget
        )
        .is_err());
    }
}

#[test]
fn target_identity_covers_fit_monitor_dpi_quality_params_and_budget_revision() {
    let compiled = compile(document(json!([builtin("spectrum-towers")])), json!([]));
    let budget = BudgetCoordinator::new();
    let facts = facts(2560, 1600, 1.5);
    let base = resolved(&compiled, &facts, Fit::Contain, &budget);
    let mut digests = BTreeSet::from([base.identity_digest().unwrap()]);
    for fit in [Fit::Cover, Fit::Stretch] {
        let result = resolved(&compiled, &facts, fit, &budget);
        assert_eq!(result.target, base.target);
        assert!(digests.insert(result.identity_digest().unwrap()));
    }
    for edit in 0..5 {
        let mut changed = base.clone();
        match edit {
            0 => changed.target_facts.monitor_id = "native-monitor-2".into(),
            1 => changed.target_facts.monitor_left += 1,
            2 => changed.target_facts.device_scale = 1.0,
            3 => changed.requested_quality = "medium".into(),
            _ => changed
                .final_params
                .insert("speed".into(), json!(0.8))
                .map(|_| ())
                .unwrap(),
        }
        assert!(digests.insert(changed.identity_digest().unwrap()));
    }
    let mut changed = base;
    changed.allowance.budget_revision += 1;
    assert!(digests.insert(changed.identity_digest().unwrap()));
}

#[test]
fn smaller_native_budget_replans_before_any_reservation_and_counts_retiring_owner() {
    let compiled = compile(document(json!([builtin("spectrum-towers")])), json!([]));
    let budget = BudgetCoordinator::new();
    let facts = facts(2560, 1600, 1.5);
    let first = resolved(&compiled, &facts, Fit::Cover, &budget);
    let held = gl_plan::GlPlan::new(
        &budget.usage(),
        OwnerKind::Desktop,
        "held".into(),
        1,
        1920,
        1080,
        60,
        30,
        "low",
    )
    .unwrap();
    let mut request = held.session.request().clone();
    request.gpu_bytes = 0;
    request.asset_cpu_bytes = 0;
    request.output_pixel_rate = 110_000_000;
    let token = budget.grant(&request).unwrap();
    budget.release(token, "held", 1).unwrap();
    let before = budget.planning_snapshot();
    let smaller = resolved(&compiled, &facts, Fit::Cover, &budget);
    assert_eq!(smaller.native_pixel_allowance, 66_666);
    assert!(smaller.target.width < first.target.width);
    assert!(u64::from(smaller.target.width) * u64::from(smaller.target.height) <= 66_666);
    assert_ne!(
        smaller.identity_digest().unwrap(),
        first.identity_digest().unwrap()
    );
    assert_eq!(
        budget.planning_snapshot(),
        before,
        "planning reserves nothing"
    );
    budget.confirm_exit(token, "held", 1).unwrap();
    let restored = resolved(&compiled, &facts, Fit::Cover, &budget);
    assert_eq!(restored.target, first.target);
    assert_ne!(
        restored.identity_digest().unwrap(),
        first.identity_digest().unwrap()
    );
}

#[test]
fn preview_uses_actual_region_dpi_and_existing_fifteen_fps_owner() {
    let compiled = compile(document(json!([builtin("spectrum-towers")])), json!([]));
    let mut facts = facts(640, 360, 1.5);
    facts.purpose = ImagePurpose::Preview;
    let result = resolved(&compiled, &facts, Fit::Stretch, &BudgetCoordinator::new());
    assert_eq!((result.target.width, result.target.height), (362, 204));
    assert_eq!(result.allowance.effective_fps, 15);
    assert_eq!(
        image_prepare::normalize_target(result.target).unwrap(),
        result.target
    );
}

#[test]
fn requested_quality_downgrade_is_explicit_and_native_fps_can_be_lower() {
    let compiled = compile(document(json!([builtin("spectrum-towers")])), json!([]));
    for (quality, purpose) in [
        ("low", ImagePurpose::Low),
        ("medium", ImagePurpose::Medium),
        ("high", ImagePurpose::High),
    ] {
        let mut facts = facts(2560, 1600, 1.5);
        facts.requested_quality = quality.into();
        facts.purpose = purpose;
        facts.requested_fps = 10;
        let result = resolved(&compiled, &facts, Fit::Cover, &BudgetCoordinator::new());
        assert_eq!(result.requested_quality, quality);
        assert_eq!(result.actual_quality, "low");
        assert_eq!(result.downgrade_reason.is_some(), quality != "low");
        assert_eq!(result.allowance.effective_fps, 10);
    }
}

#[test]
fn root_only_and_3d_group_restrictions_do_not_change_pure_2d() {
    let grouped = compile(
        document(json!([
            {"id":"parent","type":"group","stateVersion":1,"children":["background"],"properties":{"space":"3d"}},
            builtin("spectrum-towers")
        ])),
        json!([]),
    );
    let facts = facts(2560, 1600, 1.5);
    let final_values = grouped.final_public_values(&Default::default()).unwrap();
    assert!(plan(
        &grouped,
        &final_values,
        target(&facts),
        Fit::Cover,
        Some(&facts),
        &BudgetCoordinator::new()
    )
    .unwrap_err()
    .message
    .contains("root"));
    let group3d = compile(
        document(json!([builtin("spectrum-towers"),
            {"id":"other","type":"group","stateVersion":1,"properties":{"space":"3d"}}
        ])),
        json!([]),
    );
    let final_values = group3d.final_public_values(&Default::default()).unwrap();
    assert!(plan(
        &group3d,
        &final_values,
        target(&facts),
        Fit::Cover,
        Some(&facts),
        &BudgetCoordinator::new()
    )
    .unwrap_err()
    .message
    .contains("3D group"));
    let plain = compile(
        document(json!([{"id":"flat","type":"group","stateVersion":1,"properties":{}}])),
        json!([]),
    );
    let final_values = plain.final_public_values(&Default::default()).unwrap();
    assert!(plan(
        &plain,
        &final_values,
        target(&facts),
        Fit::Stretch,
        None,
        &BudgetCoordinator::new()
    )
    .unwrap()
    .is_none());
}
