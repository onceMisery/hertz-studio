// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::{
    assets::AssetStore,
    budget::BudgetCoordinator,
    decode_probe::ProbeClient,
    image_prepare::{ImageFit, ImagePurpose},
    library::{tempfileish, InstallWork, Library, LOCAL_SOURCE},
    selection_plan::{self, ResolvedSelection},
};
use std::io::{Cursor, Write};
use std::sync::atomic::AtomicUsize;

const WORK_ID: &str = "c17ed10a-5c55-4a52-85dc-7509f9e88aae";
fn document(nodes: Value) -> Value {
    json!({"documentVersion":1,"canvas":{"width":64,"height":64,"colorSpace":"srgb","background":"#000000"},
    "nodes":nodes,"timeline":{"durationSeconds":4,"loop":true,"tracks":[]},"bindings":[],"effects":[]})
}
fn target() -> ImageTarget {
    ImageTarget {
        width: 64,
        height: 64,
        fit: ImageFit::Contain,
        purpose: ImagePurpose::Preview,
    }
}

async fn install(
    root: &std::path::Path,
    nodes: Value,
    properties: Value,
    video: bool,
) -> (Arc<ImportJobs>, String, Arc<AtomicUsize>) {
    let probes = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&probes);
    let jobs = Arc::new(ImportJobs::start(
        Library::open(root).await.unwrap(),
        AssetStore::new(root).unwrap(),
        ProbeClient::testing(move |_, _| {
            counted.fetch_add(1, Ordering::AcqRel);
            Box::pin(async { Ok(()) })
        }),
    ));
    let mut entries = vec![(
        "composition.json",
        serde_json::to_vec(&document(nodes)).unwrap(),
        "application/json",
    )];
    let mut assets = vec![];
    if video {
        entries.push((
            "assets/movie.webm",
            include_bytes!("../../../../scripts/fixtures/wallpaper-vp8.webm").to_vec(),
            "video/webm",
        ));
        assets
            .push(json!({"id":"movie","kind":"video","source":"assets/movie.webm","variants":[]}));
    }
    let hash = install_package(
        &jobs,
        root,
        entries,
        json!(assets),
        properties,
        json!({"code":"none","assets":"none","attribution":""}),
        zip::CompressionMethod::Deflated,
    )
    .await;
    (jobs, hash, probes)
}

async fn install_package(
    jobs: &ImportJobs,
    root: &std::path::Path,
    entries: Vec<(&str, Vec<u8>, &str)>,
    assets: Value,
    properties: Value,
    license: Value,
    compression: zip::CompressionMethod,
) -> String {
    let files:Vec<_>=entries.iter().map(|(path,bytes,mime)|json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":mime})).collect();
    let manifest = json!({"formatVersion":1,"workId":WORK_ID,"version":1,"title":"native composition", "description":"",
        "content":{"kind":"composition","document":"composition.json"},"assets":assets,"files":files,"properties":properties,
        "permissions":{"audioSpectrum":false,"pointer":false},"license":license});
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(compression);
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(manifest.to_string().as_bytes()).unwrap();
    for (path, bytes, _) in entries {
        zip.start_file(path, options).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    let source = root.join("native-composition.hwpkg");
    std::fs::write(&source, zip.finish().unwrap().into_inner()).unwrap();
    jobs.assets()
        .snapshot_input("composition-fixture", &source, None)
        .unwrap();
    let package = jobs
        .assets()
        .validate_staged("composition-fixture")
        .unwrap();
    jobs.assets()
        .unpack_projection("composition-fixture", &package)
        .unwrap();
    jobs.assets()
        .content_writer()
        .unwrap()
        .publish_staging("composition-fixture", &package.package_hash)
        .unwrap();
    jobs.library()
        .install(&InstallWork {
            remote_work_id: WORK_ID.into(),
            work_key: format!("local-{WORK_ID}"),
            title: package.manifest.title,
            description: String::new(),
            kind: "composition".into(),
            package_hash: package.package_hash.clone(),
            manifest_json: package.manifest_json,
            package_bytes: jobs
                .assets()
                .installed_bytes(&package.package_hash)
                .unwrap(),
            version: 1,
            source_id: LOCAL_SOURCE.into(),
        })
        .await
        .unwrap();
    package.package_hash
}
async fn selected(
    jobs: Arc<ImportJobs>,
    hash: String,
    properties: serde_json::Map<String, Value>,
) -> std::result::Result<PreparedComposition, selection_plan::Failure> {
    let content = selection_plan::resolve(
        jobs,
        selection_plan::Request {
            work_key: format!("local-{WORK_ID}"),
            package_hash: hash,
            target: target(),
            properties,
        },
        Arc::new(AtomicBool::new(false)),
    )
    .await?;
    match content {
        ResolvedSelection::Composition(plan) => Ok(plan),
        _ => panic!("production selection must resolve composition"),
    }
}

#[tokio::test]
async fn builtin_final_admission_precedes_original_media_prepare() {
    let root = tempfileish::temp_dir("builtin-admission-before-prepare");
    let (jobs, hash, probes) = install(
        root.path(),
        json!([
            {"id":"background","type":"builtinScene","stateVersion":1,
                "properties":{"sceneId":"spectrum-towers","stateVersion":1,"params":{}}},
            {"id":"movie-layer","type":"video","stateVersion":1,"assets":{"asset":"movie"},
                "properties":{"loopStartMs":0,"loopEndMs":1000}}
        ]),
        json!([{"id":"ripple","label":"Ripple","type":"number","default":0,
            "constraints":{"min":0,"max":1},
            "target":{"kind":"node","nodeId":"background","property":"ripples","component":null}}]),
        true,
    )
    .await;
    for (value, expected) in [(0.5, "parameter=ripples")] {
        let failure = selection_plan::resolve_selection_with_options(
            Arc::clone(&jobs),
            super::super::config::Selection::Package {
                work_key: format!("local-{WORK_ID}"),
                package_hash: hash.clone(),
            },
            target(),
            selection_plan::SelectionOptions {
                properties: json!({"ripple":value}).as_object().unwrap().clone(),
                composition_fit: Some(super::super::config::Fit::Contain),
                composition_target: Some(super::super::builtin_plan::TargetFacts {
                    monitor_id: "native-preview-region".into(),
                    monitor_left: 0,
                    monitor_top: 0,
                    physical_width: 64,
                    physical_height: 64,
                    device_scale: 1.0,
                    requested_quality: "high".into(),
                    requested_fps: 60,
                    refresh_hz: 60,
                    purpose: ImagePurpose::Preview,
                }),
                ..Default::default()
            },
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .err()
        .expect("unsupported builtin parameters remain closed before media");
        assert_eq!(failure.error.code, "adapter_unavailable");
        assert!(
            failure.error.message.contains(expected),
            "{}",
            failure.error.message
        );
        assert_eq!(
            probes.load(Ordering::Acquire),
            0,
            "admission/gate must precede the first media prepare"
        );
    }
}

#[tokio::test]
async fn builtin_costs_keep_constructor_peak_and_charge_the_complete_depth_target() {
    let root = tempfileish::temp_dir("builtin-complete-costs");
    let (jobs, hash, _) = install(
        root.path(),
        json!([{"id":"background","type":"builtinScene","stateVersion":1,
        "properties":{"sceneId":"spectrum-towers","stateVersion":1,"params":{}}}]),
        json!([]),
        false,
    )
    .await;
    let package = jobs.assets().read_installed_manifest(&hash).unwrap();
    let (compiled, values, _) =
        read_document(jobs.assets(), &package, &Default::default()).unwrap();
    let mut costs = geometry_costs(&compiled, &values).unwrap();
    assert_eq!(costs.buffer_bytes, 53488 + 92);
    assert_eq!(costs.private_cpu_bytes, 90248 + 92);
    assert_eq!(costs.source_cpu_retained_bytes, 53512);
    assert_eq!(costs.input_bytes, 1200);
    assert_eq!(costs.programs, 6);
    complete_costs(
        &mut costs,
        &compiled,
        &values,
        &TextRasterPlan::default(),
        target(),
        0,
    )
    .unwrap();
    assert_eq!(
        costs.gpu,
        64 * 64 * 20 + 53488 + 92 + super::super::gl_plan::THREE_BOOTSTRAP_GPU_PEAK_BYTES
    );
    assert!(costs.cpu >= 90248 + 92 + 1200);
    let mut excess = geometry_costs(&compiled, &values).unwrap();
    let profile = super::super::builtin_plan::source_costs(&compiled, &values)
        .unwrap()
        .unwrap()
        .0;
    // This fits the former 16P calculation exactly but exceeds the real 20P.
    excess.texture_bytes = profile.memory_bytes
        - 64 * 64 * 16
        - excess.buffer_bytes
        - super::super::gl_plan::THREE_BOOTSTRAP_GPU_PEAK_BYTES;
    assert_eq!(
        complete_costs(
            &mut excess,
            &compiled,
            &values,
            &TextRasterPlan::default(),
            target(),
            0
        )
        .unwrap_err()
        .code,
        "budget_exceeded"
    );
}

#[tokio::test]
async fn original_selection_preserves_all_three_canvas_fits_and_target_keys() {
    use super::super::config::Fit;
    let root = tempfileish::temp_dir("composition-output-fit");
    let (jobs, hash, probes) = install(
        root.path(),
        json!([{"id":"video","type":"video","stateVersion":1,
        "assets":{"asset":"movie"},"properties":{"x":32,"y":32,"width":32,"height":32,
        "loopStartMs":0,"loopEndMs":1000}}]),
        json!([]),
        true,
    )
    .await;
    let mut keys = BTreeSet::new();
    for (fit, name) in [
        (Fit::Contain, "contain"),
        (Fit::Cover, "cover"),
        (Fit::Stretch, "stretch"),
    ] {
        let resolved = selection_plan::resolve_selection_with_options(
            Arc::clone(&jobs),
            super::super::config::Selection::Package {
                work_key: format!("local-{WORK_ID}"),
                package_hash: hash.clone(),
            },
            ImageTarget {
                width: 64,
                height: 128,
                fit: ImageFit::Cover,
                purpose: ImagePurpose::Preview,
            },
            selection_plan::SelectionOptions {
                composition_fit: Some(fit),
                ..Default::default()
            },
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        let ResolvedSelection::Composition(plan) = resolved.content else {
            panic!("composition");
        };
        assert_eq!(plan.output_fit(), fit);
        assert_eq!(
            probes.load(Ordering::Acquire),
            keys.len() + 1,
            "each target preparation uses the original single preparer exactly once"
        );
        assert_eq!(
            plan.target().fit,
            ImageFit::Cover,
            "original media preparation fit is independent"
        );
        let gl = plan
            .gl_plan(OwnerKind::Preview, "fit-owner".into(), 1, 60, 15)
            .unwrap();
        let projection = plan
            .projection("same-fixed-session", 1, 3, &gl.limits)
            .unwrap();
        assert_eq!(projection["canvas"]["width"], 64);
        assert_eq!(projection["canvas"]["height"], 64);
        assert_eq!(projection["target"]["width"], 64);
        assert_eq!(projection["target"]["height"], 128);
        assert_eq!(projection["target"]["fit"], name);
        assert!(keys.insert(projection["targetKey"].as_str().unwrap().to_owned()));
        if let Some(output) = std::env::var_os("HERTZ_COMPOSITION_NATIVE_FIXTURE") {
            let output = std::path::PathBuf::from(output).join(name);
            std::fs::create_dir_all(&output).unwrap();
            let binding = super::super::page_events::PageBinding::new(1).unwrap();
            let access = super::super::access::MediaAccess::new();
            let mut admitted =
                super::super::gl_plan::GlAdmission::new(gl, Arc::new(BudgetCoordinator::new()))
                    .unwrap();
            admitted
                .bind_composition(plan, &access, binding.session_id())
                .unwrap();
            let uri = admitted.composition_url().unwrap();
            let payload_path = uri.split("/files/").nth(1).unwrap();
            let permit = access.permit(&hash, payload_path).unwrap();
            std::fs::write(output.join("projection.json"), permit.payload().unwrap()).unwrap();
            std::fs::write(output.join("uri.txt"), uri).unwrap();
            std::fs::write(
                output.join("native-init.js"),
                format!(
                    "{}\n{}",
                    binding.initialization_script(),
                    admitted.initialization_script()
                ),
            )
            .unwrap();
        }
    }
    assert_eq!(keys.len(), 3);
    assert_eq!(
        probes.load(Ordering::Acquire),
        3,
        "each fixed target uses the original media preparation owner"
    );
}

#[tokio::test]
async fn video_upload_rate_counts_unique_clock_textures_at_original_output_gate() {
    let root = tempfileish::temp_dir("composition-upload-domains");
    for (name, second_end, textures) in [("shared", 1000, 1), ("independent", 1500, 2)] {
        let (jobs,hash,probes)=install(&root.path().join(name),json!([
            {"id":"first","type":"video","stateVersion":1,"assets":{"asset":"movie"},"properties":{"loopStartMs":0,"loopEndMs":1000}},
            {"id":"second","type":"video","stateVersion":1,"assets":{"asset":"movie"},"properties":{"loopStartMs":0,"loopEndMs":second_end}}
        ]),json!([]),true).await;
        let plan = selected(jobs, hash, Default::default()).await.unwrap();
        let source = &plan.assets["movie"].as_media().unwrap().input().metadata;
        // The fixture's source FPS is lower than this active output cadence;
        // VideoTexture.needsUpdate currently follows every submitted output.
        let gl = plan
            .gl_plan(OwnerKind::Desktop, format!("upload-{name}"), 1, 144, 60)
            .unwrap();
        assert_eq!(gl.limits.frame_divisor, 3);
        assert_eq!(gl.session.request().decoders, textures);
        assert_eq!(
            gl.session.request().texture_upload_bytes_per_second,
            u64::from(source.display_width)
                * u64::from(source.display_height)
                * 4
                * 48
                * u64::from(textures)
        );
        assert_eq!(probes.load(Ordering::Acquire), 1);
    }
}

#[tokio::test]
async fn composition_stop_and_resume_keep_original_session_close_and_reader_barriers() {
    use super::super::session::{RecoveryLedger, WallpaperSession};
    let root = tempfileish::temp_dir("composition-hard-stop");
    let (jobs, hash, _) = install(
        root.path(),
        json!([{"id":"video","type":"video","stateVersion":1,
        "assets":{"asset":"movie"},"properties":{"loopStartMs":0,"loopEndMs":1000}}]),
        json!([]),
        true,
    )
    .await;
    let budget = Arc::new(BudgetCoordinator::new());
    let access = super::super::access::MediaAccess::new();
    let mut session = WallpaperSession::new();
    for revision in [1, 2] {
        let generation = session.apply(revision, &RecoveryLedger::new()).unwrap();
        session.resolved(generation);
        session.prepared(generation);
        let plan = selected(Arc::clone(&jobs), hash.clone(), Default::default())
            .await
            .unwrap();
        let gl = plan
            .gl_plan(
                OwnerKind::Desktop,
                format!("hard-stop-{generation}"),
                generation,
                60,
                30,
            )
            .unwrap();
        let mut admitted =
            super::super::gl_plan::GlAdmission::new(gl, Arc::clone(&budget)).unwrap();
        let binding = super::super::page_events::PageBinding::new(generation).unwrap();
        admitted
            .bind_composition(plan, &access, binding.session_id())
            .unwrap();
        session.admit_gl(admitted).unwrap();
        // Composition has no lightweight media admission. Hard policy must
        // retire its original GL owner instead of relying on media.is_some().
        assert!(session.media().is_none());
        let uri = session.gl().unwrap().composition_url().unwrap().to_owned();
        let path = uri.split("/files/").nth(1).unwrap();
        let held_reader = access.permit(&hash, path).unwrap();
        let held = budget.usage();
        assert_eq!(held.contexts, 1);
        assert_eq!(held.decoder_slots, 1);
        assert!(held.texture_upload_bytes_per_second > 0);
        session.disable();
        assert!(!held_reader.is_active());
        assert!(access.permit(&hash, path).is_none());
        assert_eq!(session.retiring_generations(), vec![generation]);
        assert!(session.reap_resources().is_empty());
        assert!(!session.controller_closed(generation + 1));
        assert!(session.controller_closed(generation));
        assert!(session.reap_resources().is_empty());
        assert_eq!(
            budget.usage().texture_upload_bytes_per_second,
            held.texture_upload_bytes_per_second
        );
        drop(held_reader);
        assert_eq!(session.reap_resources(), vec![generation]);
        assert_eq!(budget.usage().contexts, 0);
        assert_eq!(budget.usage().decoder_slots, 0);
        assert_eq!(budget.usage().texture_upload_bytes_per_second, 0);
    }
}

#[tokio::test]
async fn production_selection_projects_final_particles_into_one_native_plan() {
    let root = tempfileish::temp_dir("composition-production-plan");
    let properties = json!([{"id":"particles","type":"number","label":"Count","default":7,"constraints":{"min":1,"max":100},
        "target":{"kind":"node","nodeId":"dots","property":"count","component":null}}]);
    let (jobs,hash,probes)=install(root.path(),json!([{"id":"dots","type":"particles","stateVersion":1,"assets":{},"children":[],"properties":{"count":7}}]),properties,false).await;
    let reference = super::super::playlist::FixedVersion {
        work_key: format!("local-{WORK_ID}"),
        package_hash: hash.clone(),
    };
    let playlist = super::super::playlist::Repository::new(jobs.library())
        .save(
            None,
            None,
            "composition public values".into(),
            super::super::playlist::Mode::Sequential,
            10,
            vec![reference.clone(), reference.clone()],
        )
        .await
        .unwrap();
    for selection in [
        reference.selection(),
        super::super::config::Selection::Playlist {
            playlist_id: playlist.playlist_id,
        },
    ] {
        super::super::public_properties::validate_selections(
            &jobs,
            &[super::super::public_properties::PropertySelection {
                selection: selection.clone(),
                properties: json!({"particles":11}).as_object().unwrap().clone(),
            }],
            &AtomicBool::new(false),
        )
        .await
        .unwrap();
        assert_eq!(
            super::super::public_properties::validate_selections(
                &jobs,
                &[super::super::public_properties::PropertySelection {
                    selection,
                    properties: json!({"particles":101}).as_object().unwrap().clone(),
                }],
                &AtomicBool::new(false),
            )
            .await
            .unwrap_err()
            .code,
            "invalid_property_value"
        );
    }
    assert_eq!(probes.load(Ordering::Acquire), 0);
    assert!(jobs.active_status().is_none());
    let plan = selected(
        Arc::clone(&jobs),
        hash,
        json!({"particles":11}).as_object().unwrap().clone(),
    )
    .await
    .unwrap();
    let budget = BudgetCoordinator::new();
    let gl = plan
        .gl_plan(OwnerKind::Preview, "actual-composition".into(), 1, 60, 30)
        .unwrap();
    assert_eq!(gl.session.request().contexts, 1);
    assert_eq!(
        gl.session.request().gpu_bytes,
        64 * 64 * 16 + 92 + 11 * 20 + 96
    );
    assert_eq!(
        gl.session.request().cpu_bytes - plan.costs().unwrap().semantic_bytes,
        92 + 11 * 20
    );
    assert_eq!(gl.session.request().decoders, 0);
    assert_eq!(probes.load(Ordering::Acquire), 0);
    let token = budget.grant_session(&gl.session).unwrap();
    assert_eq!(budget.usage().contexts, 1);
    budget.release(token, "actual-composition", 1).unwrap();
    budget.confirm_exit(token, "actual-composition", 1).unwrap();
    assert_eq!(budget.usage().contexts, 0);
}

#[tokio::test]
async fn composition_scope_blocks_old_generation_and_waits_for_ir_streams_and_close() {
    let root = tempfileish::temp_dir("composition-scope");
    let (jobs,hash,_)=install(root.path(),json!([{"id":"group","type":"group","stateVersion":1,"assets":{},"children":[],"properties":{}}]),json!([]),false).await;
    let plan = selected(jobs, hash, Default::default()).await.unwrap();
    let budget = Arc::new(BudgetCoordinator::new());
    let gl = plan
        .gl_plan(OwnerKind::Preview, "scope-owner".into(), 2, 60, 15)
        .unwrap();
    let mut admitted = super::super::gl_plan::GlAdmission::new(gl, Arc::clone(&budget)).unwrap();
    let access = super::super::access::MediaAccess::new();
    admitted.bind_composition(plan, &access, "aabbcc").unwrap();
    admitted.published = true;
    let uri = admitted.composition_url().unwrap().to_owned();
    let path = uri.split("/files/").nth(1).unwrap();
    let hash = uri
        .trim_start_matches("https://")
        .split(".wallpaper.invalid")
        .next()
        .unwrap()
        .replace('.', "");
    let permit = access.permit(&hash, path).unwrap();
    assert!(permit.payload().unwrap().len() > 1024);
    assert!(super::super::access::MediaAccess::new()
        .permit(&hash, path)
        .is_none());
    let queued = permit.clone();
    admitted.retire();
    assert!(!permit.is_active());
    admitted.controller_closed();
    assert!(!admitted.finish());
    assert_eq!(budget.usage().contexts, 1);
    drop(permit);
    assert!(!admitted.finish());
    drop(queued);
    assert!(admitted.finish());
    assert_eq!(budget.usage().contexts, 0);
    assert!(access.permit(&hash, path).is_none());
}

#[tokio::test]
async fn final_video_range_uses_true_duration_and_single_preparation_owner() {
    let root = tempfileish::temp_dir("composition-real-video");
    let (jobs,hash,probes)=install(root.path(),json!([{"id":"video","type":"video","stateVersion":1,"assets":{"asset":"movie"},"properties":{"width":1234,"height":3456,"loopStartMs":0,"loopEndMs":1000}}]),json!([]),true).await;
    let plan = selected(Arc::clone(&jobs), hash, Default::default())
        .await
        .unwrap();
    let media = plan.assets["movie"].as_media().unwrap();
    let metadata = &media.input().metadata;
    assert_ne!(metadata.display_width, 1234);
    assert_ne!(metadata.display_height, 3456);
    assert_eq!(probes.load(Ordering::Acquire), 1);
    let gl = plan
        .gl_plan(OwnerKind::Preview, "video-owner".into(), 1, 60, 15)
        .unwrap();
    assert_eq!(gl.session.request().decoders, 1);
    assert_eq!(
        gl.session.request().gpu_bytes,
        64 * 64 * 16
            + u64::from(metadata.display_width) * u64::from(metadata.display_height) * 8
            + 184
            + 96
    );
    assert_eq!(
        gl.session.request().cpu_bytes - plan.costs().unwrap().semantic_bytes,
        u64::from(metadata.encoded_width) * u64::from(metadata.encoded_height) * 12 + 184
    );
    assert!(metadata.duration_ms.unwrap() >= 1000);
    if let Some(output) = std::env::var_os("HERTZ_COMPOSITION_NATIVE_FIXTURE") {
        let output = std::path::PathBuf::from(output);
        std::fs::create_dir_all(&output).unwrap();
        let binding = super::super::page_events::PageBinding::new(1).unwrap();
        let package_hash = media.reference().package_hash.clone();
        std::fs::copy(&media.input().media.path, output.join("movie.webm")).unwrap();
        let budget = Arc::new(BudgetCoordinator::new());
        let access = super::super::access::MediaAccess::new();
        let mut admission = super::super::gl_plan::GlAdmission::new(gl, budget).unwrap();
        admission
            .bind_composition(plan, &access, binding.session_id())
            .unwrap();
        let path = admission
            .composition_url()
            .unwrap()
            .split("/files/")
            .nth(1)
            .unwrap();
        let permit = access.permit(&package_hash, path).unwrap();
        std::fs::write(output.join("projection.json"), permit.payload().unwrap()).unwrap();
        std::fs::write(
            output.join("native-init.js"),
            format!(
                "{}\n{}",
                binding.initialization_script(),
                admission.initialization_script()
            ),
        )
        .unwrap();
        std::fs::write(output.join("uri.txt"), admission.composition_url().unwrap()).unwrap();
    }
}

#[tokio::test]
async fn out_of_duration_public_range_refuses_before_decode_qualification() {
    let root = tempfileish::temp_dir("composition-final-range");
    let property = json!([{"id":"end","type":"number","label":"End","default":1000,
        "constraints":{"min":0.001,"max":86400000},"target":{"kind":"node","nodeId":"video","property":"loopEndMs","component":null}}]);
    let (jobs,hash,probes)=install(root.path(),json!([{"id":"video","type":"video","stateVersion":1,"assets":{"asset":"movie"},"properties":{"loopStartMs":0,"loopEndMs":1000}}]),property,true).await;
    let error = selected(
        Arc::clone(&jobs),
        hash,
        json!({"end":3000}).as_object().unwrap().clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.error.code, "invalid_video_range");
    assert_eq!(probes.load(Ordering::Acquire), 0);
    assert!(jobs.active_status().is_none());
}

#[test]
fn text_declaration_passes_structure_without_claiming_font_qualification() {
    let manifest:hertz_wallpaper::Manifest=serde_json::from_value(json!({"formatVersion":1,"workId":WORK_ID,"version":1,"title":"text","description":"",
        "content":{"kind":"composition","document":"composition.json"},"assets":[{"id":"font","kind":"font","source":"assets/font.ttf"}],"files":[{"path":"composition.json","bytes":1,"sha256":"a".repeat(64),"mime":"application/json"},{"path":"assets/font.ttf","bytes":1,"sha256":"b".repeat(64),"mime":"font/ttf"}],
        "properties":[],"permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"none","attribution":""}})).unwrap();
    let compiled=hertz_wallpaper::document::compile_document(&serde_json::to_vec(&document(json!([{"id":"text","type":"text","stateVersion":1,"assets":{"fontAsset":"font"},"properties":{"text":"hello"}}]))).unwrap(),&manifest).unwrap();
    assert!(validate_adapters(&compiled).is_ok());
}

// Real licensed bytes and the original ImportJobs test qualifier establish
// planning/lifecycle evidence here. No callback or internal plan claims native
// text pixels, real decoder success or Windows selection eligibility.
fn licensed_font() -> Vec<u8> {
    use base64::Engine;
    let css = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../plugin/ui/fonts/brand.css"
    ));
    let encoded = css
        .split("data:font/ttf;base64,")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    assert_eq!(bytes.len(), 8336);
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        "52e207c6d3cd36d1880050598c4c31f16848575b5f419fd9a78ed486c16acbaf"
    );
    bytes
}

/// A valid private SFNT table changes byte identity/CPU cost while retaining
/// the licensed fixture's actual cmap and outlines. Metadata remains parsed.
fn font_with_private_table(payload_bytes: usize, marker: u8) -> Vec<u8> {
    let original = licensed_font();
    let count = usize::from(u16::from_be_bytes(original[4..6].try_into().unwrap()));
    let mut tables = BTreeMap::<[u8; 4], Vec<u8>>::new();
    for index in 0..count {
        let record = 12 + index * 16;
        let offset =
            u32::from_be_bytes(original[record + 8..record + 12].try_into().unwrap()) as usize;
        let len =
            u32::from_be_bytes(original[record + 12..record + 16].try_into().unwrap()) as usize;
        tables.insert(
            original[record..record + 4].try_into().unwrap(),
            original[offset..offset + len].to_vec(),
        );
    }
    tables.insert(*b"HRTZ", vec![marker; payload_bytes]);
    tables.get_mut(b"head").unwrap()[8..12].fill(0);
    let count = tables.len();
    let power = 1usize << (usize::BITS - count.leading_zeros() - 1);
    let mut bytes = vec![0; 12 + count * 16];
    bytes[..4].copy_from_slice(b"\0\x01\0\0");
    bytes[4..6].copy_from_slice(&(count as u16).to_be_bytes());
    bytes[6..8].copy_from_slice(&((power * 16) as u16).to_be_bytes());
    bytes[8..10].copy_from_slice(&(power.trailing_zeros() as u16).to_be_bytes());
    bytes[10..12].copy_from_slice(&((count * 16 - power * 16) as u16).to_be_bytes());
    let checksum = |data: &[u8]| {
        data.chunks(4).fold(0u32, |sum, chunk| {
            let mut word = [0; 4];
            word[..chunk.len()].copy_from_slice(chunk);
            sum.wrapping_add(u32::from_be_bytes(word))
        })
    };
    let mut head_offset = 0;
    for (index, (tag, table)) in tables.into_iter().enumerate() {
        let record = 12 + index * 16;
        let offset = bytes.len();
        bytes[record..record + 4].copy_from_slice(&tag);
        bytes[record + 4..record + 8].copy_from_slice(&checksum(&table).to_be_bytes());
        bytes[record + 8..record + 12].copy_from_slice(&(offset as u32).to_be_bytes());
        bytes[record + 12..record + 16].copy_from_slice(&(table.len() as u32).to_be_bytes());
        if tag == *b"head" {
            head_offset = offset;
        }
        bytes.extend_from_slice(&table);
        while !bytes.len().is_multiple_of(4) {
            bytes.push(0);
        }
    }
    let adjustment = 0xb1b0_afbau32.wrapping_sub(checksum(&bytes));
    bytes[head_offset + 8..head_offset + 12].copy_from_slice(&adjustment.to_be_bytes());
    bytes
}

async fn install_font_composition(
    root: &std::path::Path,
    nodes: Value,
    properties: Value,
    probe: ProbeClient,
    fonts: [Vec<u8>; 2],
) -> (Arc<ImportJobs>, String) {
    use base64::Engine;
    let jobs = Arc::new(ImportJobs::start(
        Library::open(root).await.unwrap(),
        AssetStore::new(root).unwrap(),
        probe,
    ));
    let ofl = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../plugin/ui/fonts/InstrumentSerif-OFL.txt"
    ));
    assert!(ofl.contains("Copyright 2022 The Instrument Serif Project Authors"));
    assert!(ofl.contains("SIL OPEN FONT LICENSE Version 1.1"));
    let [font, other] = fonts;
    let entries = vec![
        ("composition.json", serde_json::to_vec(&document(nodes)).unwrap(), "application/json"),
        ("assets/font.ttf", font, "font/ttf"),
        ("assets/font-b.ttf", other, "font/ttf"),
        ("licenses/instrument-serif-ofl.txt", ofl.as_bytes().to_vec(), "text/plain"),
        ("assets/pixel.png", base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==").unwrap(), "image/png"),
        ("assets/movie.webm", include_bytes!("../../../../scripts/fixtures/wallpaper-vp8.webm").to_vec(), "video/webm"),
    ];
    // Stored is an allowed package method with a true 1:1 ratio. The large
    // private-table fixture must reach real byte/cost checks without weakening
    // the archive's Deflated compression-ratio guard.
    let hash = install_package(&jobs, root, entries, json!([
        {"id":"font","kind":"font","source":"assets/font.ttf","variants":[]},
        {"id":"font-alias","kind":"font","source":"assets/font.ttf","variants":[]},
        {"id":"font-b","kind":"font","source":"assets/font-b.ttf","variants":[]},
        {"id":"pixel","kind":"image","source":"assets/pixel.png","variants":[]},
        {"id":"movie","kind":"video","source":"assets/movie.webm","variants":[]}
    ]), properties, json!({"code":"none","assets":"OFL-1.1","attribution":"Copyright 2022 The Instrument Serif Project Authors; licenses/instrument-serif-ofl.txt"}), zip::CompressionMethod::Stored).await;
    (jobs, hash)
}

fn text_node(id: &str, font: &str, properties: Value) -> Value {
    let mut properties = properties.as_object().unwrap().clone();
    properties.entry("text").or_insert(json!("Hertz"));
    properties.entry("width").or_insert(json!(16));
    properties.entry("height").or_insert(json!(8));
    json!({"id":id,"type":"text","stateVersion":1,"assets":{"fontAsset":font},"properties":properties})
}

fn group_request_for_test(
    jobs: &ImportJobs,
    hash: &str,
    overrides: Value,
) -> FontGroupPrepareRequest {
    let package = jobs.assets().read_installed_manifest(hash).unwrap();
    let (compiled, final_values, _) =
        read_document(jobs.assets(), &package, overrides.as_object().unwrap()).unwrap();
    let fonts = text_raster::required_texts_by_font(&compiled, &final_values)
        .unwrap()
        .into_iter()
        .map(|(id, texts)| font_prepare_request(&package, &id, texts).unwrap())
        .collect();
    FontGroupPrepareRequest {
        fonts,
        composition: FontTextPreflightContext {
            package_hash: hash.into(),
            compiled,
            final_values,
            target: target(),
            output_fit: super::super::config::Fit::Contain,
        },
    }
}

fn inspect_group_for_test(
    jobs: &ImportJobs,
    group: &FontGroupPrepareRequest,
    probe: &ProbeClient,
) -> BTreeMap<String, FontInput> {
    group
        .fonts
        .iter()
        .map(|font| {
            let workspace = probe
                .image_workspace(
                    super::super::font_prepare::prepare_workspace_bytes(font.expected_entry.bytes)
                        .unwrap(),
                )
                .unwrap();
            let input = super::super::font_prepare::pin_input(
                jobs.assets(),
                &font.reference,
                &font.expected_entry,
                &font.required_texts,
                &workspace,
                &AtomicBool::new(false),
            )
            .unwrap();
            workspace.finish();
            (font.reference.asset_id.clone(), input)
        })
        .collect()
}

async fn prepared_internal(
    jobs: &Arc<ImportJobs>,
    hash: &str,
    overrides: Value,
    target: ImageTarget,
    fit: super::super::config::Fit,
) -> Result<PreparedComposition> {
    let package = jobs.assets().read_installed_manifest(hash)?;
    let (compiled, final_values, pin) =
        read_document(jobs.assets(), &package, overrides.as_object().unwrap())?;
    validate_structure(&compiled)?;
    let assets = prepare_assets(
        jobs,
        &package,
        &compiled,
        &final_values,
        target,
        fit,
        &Arc::new(AtomicBool::new(false)),
    )
    .await?;
    PreparedComposition {
        package_hash: hash.into(),
        compiled,
        final_values,
        assets,
        text_rasters: TextRasterPlan::default(),
        _document_pin: pin,
        target,
        output_fit: fit,
        builtin_target: None,
    }
    .finish()
}

fn reproject_internal(
    plan: &PreparedComposition,
    overrides: Value,
    target: ImageTarget,
    fit: super::super::config::Fit,
) -> Result<PreparedComposition> {
    let final_values = plan
        .compiled
        .final_public_values(&overrides.as_object().unwrap().clone().into_iter().collect())
        .map_err(package_error)?;
    PreparedComposition {
        package_hash: plan.package_hash.clone(),
        compiled: Arc::clone(&plan.compiled),
        final_values,
        assets: plan.assets.clone(),
        text_rasters: TextRasterPlan::default(),
        _document_pin: Arc::clone(&plan._document_pin),
        target,
        output_fit: fit,
        builtin_target: None,
    }
    .finish()
}

fn planning_probe() -> ProbeClient {
    ProbeClient::testing_input(|_, _| Box::pin(async { Ok(()) }))
}

#[tokio::test]
async fn production_selection_projects_prepared_font_text_raster_into_one_native_plan() {
    let root = tempfileish::temp_dir("composition-production-font-text");
    let probe = planning_probe();
    let counts = probe.clone();
    let properties = json!([{"id":"caption","type":"text","label":"Caption","default":"Hertz",
        "constraints":{"maxLength":4096},"target":{"kind":"node","nodeId":"first","property":"text","component":null}}]);
    let (jobs, hash) = install_font_composition(
        root.path(),
        json!([
            text_node(
                "first",
                "font",
                json!({"x":2,"y":2,"width":60,"height":28,"anchorX":0,"anchorY":0,"fontSize":18})
            ),
            text_node(
                "second",
                "font-alias",
                json!({"x":2,"y":32,"width":60,"height":28,"anchorX":0,"anchorY":0,"fontSize":18})
            )
        ]),
        properties,
        probe,
        [licensed_font(), font_with_private_table(4, 1)],
    )
    .await;
    let plan = selected(Arc::clone(&jobs), hash.clone(), Default::default())
        .await
        .unwrap();
    assert_eq!(counts.stats(), (0, 2));
    assert_eq!(plan.assets.len(), 2);
    assert_eq!(plan.text_rasters.unique_font_count(), 1);
    assert_eq!(plan.text_rasters.unique_raster_count(), 1);
    let gl = plan
        .gl_plan(OwnerKind::Preview, "production-text".into(), 1, 60, 15)
        .unwrap();
    let projection = plan
        .projection("production-text", 1, 1, &gl.limits)
        .unwrap();
    assert_eq!(
        projection["textRasters"][0]["adapterVersion"],
        text_raster::ADAPTER_VERSION
    );
    assert_eq!(projection["textRasters"][0]["nodeIndices"], json!([0, 1]));
    assert_eq!(projection["pageLimits"]["canvases"], 1);
    assert_eq!(plan.pins().len(), 2);
    let before = counts.stats();
    let error = selected(
        Arc::clone(&jobs),
        hash.clone(),
        json!({"caption":"\u{10ffff}"}).as_object().unwrap().clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.error.code, "font_glyph_unavailable");
    assert_eq!(
        counts.stats(),
        before,
        "uncovered final text cannot enter native qualification"
    );
    assert!(jobs.active_status().is_none());
    let budget = Arc::new(BudgetCoordinator::new());
    let access = super::super::access::MediaAccess::new();
    let binding = super::super::page_events::PageBinding::new(1).unwrap();
    let pins = plan.pins();
    let mut admission = super::super::gl_plan::GlAdmission::new(gl, Arc::clone(&budget)).unwrap();
    admission
        .bind_composition(plan, &access, binding.session_id())
        .unwrap();
    if let Some(output) = std::env::var_os("HERTZ_COMPOSITION_PRODUCTION_FONT_FIXTURE") {
        export_internal_fixture(
            &std::path::PathBuf::from(output),
            &admission,
            &access,
            &binding,
            pins,
        );
    }
    admission.retire();
    admission.controller_closed();
    assert!(admission.finish());
    assert_eq!(budget.usage(), super::super::budget::BudgetUsage::default());
}

fn export_internal_fixture(
    output: &std::path::Path,
    admission: &super::super::gl_plan::GlAdmission,
    access: &super::super::access::MediaAccess,
    binding: &super::super::page_events::PageBinding,
    pins: Vec<(String, Arc<PinnedMedia>)>,
) {
    std::fs::create_dir_all(output).unwrap();
    let uri = admission.composition_url().unwrap();
    let hash = uri
        .split('/')
        .nth(2)
        .unwrap()
        .split('.')
        .take(2)
        .collect::<String>();
    let path = uri.split("/files/").nth(1).unwrap();
    let projection_reader = access.permit(&hash, path).unwrap();
    std::fs::write(
        output.join("projection.json"),
        projection_reader.payload().unwrap(),
    )
    .unwrap();
    std::fs::write(output.join("uri.txt"), uri).unwrap();
    std::fs::write(
        output.join("native-init.js"),
        format!(
            "{}\n{}",
            binding.initialization_script(),
            admission.initialization_script()
        ),
    )
    .unwrap();
    let mut closure = Vec::new();
    for (package_hash, pin) in pins {
        let relative = format!("files/{}", pin.entry.path);
        let destination = output.join(&relative);
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::fs::copy(&pin.path, &destination).unwrap();
        closure.push(json!({"packageHash":package_hash,"entry":pin.entry,"file":relative}));
    }
    std::fs::write(
        output.join("closure.json"),
        serde_json::to_vec_pretty(&closure).unwrap(),
    )
    .unwrap();
    std::fs::write(output.join("qualification.txt"), "PreparedComposition fixture: licensed immutable TTF and original ImportJobs injected qualification/lifecycle proofs. This fixture does not establish real FontFace, Windows, Apply or native pixel qualification.\n").unwrap();
}

#[tokio::test]
async fn internal_mixed_closure_keeps_alias_pins_and_deduplicates_font_and_raster_costs() {
    use super::super::config::Fit;
    use crate::wallpaper::decode_probe::ProbeInput;
    let root = tempfileish::temp_dir("composition-font-mixed");
    let fonts = Arc::new(AtomicUsize::new(0));
    let media = Arc::new(AtomicUsize::new(0));
    let seen_fonts = Arc::clone(&fonts);
    let seen_media = Arc::clone(&media);
    let probe = ProbeClient::testing_input(move |input, _| {
        match input {
            ProbeInput::Font(_) => {
                seen_fonts.fetch_add(1, Ordering::AcqRel);
            }
            ProbeInput::Media(_) => {
                seen_media.fetch_add(1, Ordering::AcqRel);
            }
        }
        Box::pin(async { Ok(()) })
    });
    let (jobs, hash) = install_font_composition(root.path(), json!([
        text_node("first", "font", json!({})),
        text_node("second", "font-alias", json!({"visible":false,"opacity":0})),
        text_node("third", "font", json!({"x":40})),
        {"id":"image","type":"image","stateVersion":1,"assets":{"asset":"pixel"},"properties":{}},
        {"id":"video","type":"video","stateVersion":1,"assets":{"asset":"movie"},"properties":{"loopStartMs":0,"loopEndMs":1000}}
    ]), json!([]), probe, [licensed_font(), font_with_private_table(4, 1)]).await;
    let plan = prepared_internal(&jobs, &hash, json!({}), target(), Fit::Contain)
        .await
        .unwrap();
    assert_eq!(plan.assets.len(), 4);
    assert_eq!(plan.pins().len(), 4);
    assert_eq!(
        fonts.load(Ordering::Acquire),
        2,
        "each alias is independently verified through the original queue and test qualifier"
    );
    assert_eq!(media.load(Ordering::Acquire), 2);
    let requests: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM install_jobs WHERE state='done'")
        .fetch_one(jobs.library().pool())
        .await
        .unwrap();
    assert_eq!(
        requests, 3,
        "one original font group job verifies both aliases before the two original media jobs"
    );
    assert!(jobs.active_status().is_none());
    assert_eq!(plan.text_rasters.unique_font_count(), 1);
    assert_eq!(plan.text_rasters.unique_raster_count(), 1);
    assert_eq!(plan.text_rasters.raster_pixels(), 128);
    assert_eq!(
        plan.text_rasters.text_rasters()[0].node_indices(),
        &[0, 1, 2]
    );
    let font = plan.assets["font"].as_font().unwrap();
    assert_eq!(
        font.content_key(),
        plan.assets["font-alias"].as_font().unwrap().content_key()
    );
    let cost = plan.costs().unwrap();
    let lower_bound = FontTextPreflightContext {
        package_hash: plan.package_hash.clone(),
        compiled: Arc::clone(&plan.compiled),
        final_values: plan.final_values.clone(),
        target: plan.target,
        output_fit: plan.output_fit,
    }
    .memory_request(
        &plan
            .assets
            .iter()
            .filter_map(|(id, asset)| {
                asset
                    .as_font()
                    .map(|font| (id.clone(), font.input().clone()))
            })
            .collect(),
        "mixed-lower-bound".into(),
        1,
    )
    .unwrap();
    assert_eq!(lower_bound.owner, OwnerKind::Probe);
    assert_eq!(lower_bound.prepare_tasks, 0);
    assert!(lower_bound.cpu_bytes <= cost.cpu);
    assert!(lower_bound.gpu_bytes <= cost.gpu);
    assert_eq!(
        lower_bound.gpu_bytes,
        cost.gpu - cost.texture_bytes - cost.video_upload_peak_bytes
    );
    assert_eq!(cost.buffer_bytes, 6 * 92);
    assert_eq!(cost.font_cpu_bytes, font.input().metadata.cpu_budget_bytes);
    assert_eq!(
        cost.cpu,
        cost.decode_bytes + cost.buffer_bytes + cost.semantic_bytes + cost.font_cpu_bytes + 512
    );
    assert_eq!(
        cost.gpu,
        64 * 64 * 16
            + cost.texture_bytes
            + 512
            + cost.buffer_bytes
            + cost.video_upload_peak_bytes
            + super::super::gl_plan::THREE_BOOTSTRAP_GPU_PEAK_BYTES
    );
    let gl = plan
        .gl_plan(OwnerKind::Preview, "font-mixed".into(), 1, 60, 15)
        .unwrap();
    assert_eq!(gl.session.request().contexts, 1);
    assert_eq!(gl.session.request().decoders, 1);
    let projection = plan.projection("font-session", 1, 7, &gl.limits).unwrap();
    let limits = &projection["pageLimits"];
    assert_eq!(limits["canvases"], 1);
    assert_eq!(limits["drawingBufferPixels"], 64 * 64 + 128);
    assert_eq!(
        limits["ownedCpuBytes"],
        cost.buffer_bytes + cost.font_cpu_bytes + 512
    );
    assert_eq!(limits["textureDeclaredBytes"], cost.texture_bytes + 512);
    assert_eq!(limits["decodeReservedBytes"], cost.decode_bytes);
    assert_eq!(limits["programs"], 2);
    assert_eq!(
        projection["textRasters"],
        serde_json::to_value(plan.text_rasters.text_rasters()).unwrap()
    );
    for asset in projection["resolvedAssets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|asset| asset["kind"] == "font")
    {
        assert_eq!(asset["adapterId"], "prepared-sfnt-font");
        assert_eq!(asset["adapterVersion"], 1);
        assert_eq!(asset["decodeOptions"]["colorSpace"], "none");
        assert_eq!(
            asset["decodeOptions"]["fontAdapterVersion"],
            font.adapter_version()
        );
        assert_eq!(
            asset["fontMetadata"],
            serde_json::to_value(&font.input().metadata).unwrap()
        );
        assert!(
            asset.get("width").is_none()
                && asset.get("height").is_none()
                && asset.get("durationMs").is_none()
        );
    }
    let budget = Arc::new(BudgetCoordinator::new());
    let access = super::super::access::MediaAccess::new();
    let fixture_pins = plan.pins();
    let binding = super::super::page_events::PageBinding::new(1).unwrap();
    let mut admission = super::super::gl_plan::GlAdmission::new(gl, Arc::clone(&budget)).unwrap();
    admission
        .bind_composition(plan, &access, binding.session_id())
        .unwrap();
    if let Some(output) = std::env::var_os("HERTZ_COMPOSITION_INTERNAL_FONT_FIXTURE") {
        let output = std::path::PathBuf::from(output);
        export_internal_fixture(&output, &admission, &access, &binding, fixture_pins);
    }
    let font_reader = access.permit(&hash, "assets/font.ttf").unwrap();
    let media_reader = access.permit(&hash, "assets/movie.webm").unwrap();
    assert!(access
        .permit(&hash, "licenses/instrument-serif-ofl.txt")
        .is_none());
    admission.retire();
    admission.controller_closed();
    assert!(!font_reader.is_active());
    assert!(!admission.finish());
    assert_eq!(budget.usage().contexts, 1);
    drop(font_reader);
    assert!(!admission.finish());
    drop(media_reader);
    assert!(admission.finish());
    assert_eq!(budget.usage().cpu_bytes, 0);
    assert_eq!(budget.usage().gpu_bytes, 0);
}

#[tokio::test]
async fn internal_final_font_and_hidden_text_coverage_reject_unverified_replacements() {
    use super::super::config::Fit;
    let root = tempfileish::temp_dir("composition-font-final");
    let properties = json!([
        {"id":"caption","type":"text","label":"Caption","default":"Hertz","constraints":{"maxLength":4096},
            "target":{"kind":"node","nodeId":"hidden","property":"text","component":null}},
        {"id":"face","type":"asset","label":"Face","default":"font-alias","constraints":{"kind":"font","options":["font","font-alias","font-b"]},
            "target":{"kind":"node","nodeId":"hidden","property":"fontAsset","component":null}}
    ]);
    let (jobs, hash) = install_font_composition(
        root.path(),
        json!([text_node(
            "hidden",
            "font",
            json!({"text":"H","visible":false,"scaleX":0,"scaleY":0})
        )]),
        properties,
        planning_probe(),
        [licensed_font(), font_with_private_table(4, 1)],
    )
    .await;
    let initial = prepared_internal(&jobs, &hash, json!({}), target(), Fit::Contain)
        .await
        .unwrap();
    assert!(initial.assets.contains_key("font-alias"));
    assert!(!initial.assets.contains_key("font"));
    let required =
        text_raster::required_texts_by_font(&initial.compiled, &initial.final_values).unwrap();
    assert_eq!(
        required["font-alias"],
        vec![RequiredText {
            node_id: "hidden".into(),
            text: "Hertz".into()
        }]
    );
    assert!(initial.assets["font-alias"]
        .as_font()
        .unwrap()
        .covers_required_texts(&required["font-alias"]));
    assert!(
        initial.text_rasters.raster_pixels() > 0,
        "hidden and zero-scale text retains bounded preparation facts"
    );
    let package = jobs.assets().read_installed_manifest(&hash).unwrap();
    for (changed, final_font, final_text, expected_error) in [
        (
            json!({"caption":"Hertz Studio"}),
            "font-alias",
            "Hertz Studio",
            "font_not_prepared",
        ),
        (json!({"face":"font"}), "font", "Hertz", "asset_not_found"),
        (
            json!({"face":"font-b"}),
            "font-b",
            "Hertz",
            "asset_not_found",
        ),
    ] {
        let overrides = changed.as_object().unwrap().clone();
        validate_public_properties(jobs.assets(), &package, &overrides).unwrap();
        let final_values = initial
            .compiled
            .final_public_values(&overrides.clone().into_iter().collect())
            .unwrap();
        let final_required =
            text_raster::required_texts_by_font(&initial.compiled, &final_values).unwrap();
        assert_eq!(final_values.resource_uses()[0].asset_id, final_font);
        assert_eq!(
            final_required[final_font],
            vec![RequiredText {
                node_id: "hidden".into(),
                text: final_text.into()
            }]
        );
        // A changed final asset must first join the prepared closure. Only an
        // existing exact asset can reach the required-text proof check.
        assert_eq!(
            initial.assets.contains_key(final_font),
            final_font == "font-alias"
        );
        assert_eq!(
            reproject_internal(&initial, changed, target(), Fit::Contain)
                .unwrap_err()
                .code,
            expected_error
        );
        // The original selection owner prepares the changed exact asset/text
        // instead of borrowing the old closure's glyph proof.
        let current = selected(Arc::clone(&jobs), hash.clone(), overrides)
            .await
            .unwrap();
        let font = current.assets[final_font].as_font().unwrap();
        assert_eq!(font.reference().asset_id, final_font);
        assert!(font.covers_required_texts(&final_required[final_font]));
        assert_eq!(current.final_values.resource_uses()[0].asset_id, final_font);
    }
    let changed = prepared_internal(
        &jobs,
        &hash,
        json!({"caption":"Hertz Studio","face":"font-b"}),
        target(),
        Fit::Contain,
    )
    .await
    .unwrap();
    assert_ne!(
        initial.assets["font-alias"].content_key(),
        changed.assets["font-b"].content_key()
    );
    assert_ne!(
        initial.text_rasters.text_rasters()[0].raster_key(),
        changed.text_rasters.text_rasters()[0].raster_key()
    );
    let initial_gl = initial
        .gl_plan(OwnerKind::Preview, "final-initial".into(), 1, 60, 15)
        .unwrap();
    let changed_gl = changed
        .gl_plan(OwnerKind::Preview, "final-changed".into(), 1, 60, 15)
        .unwrap();
    assert_ne!(
        initial
            .projection("same", 1, 1, &initial_gl.limits)
            .unwrap()["targetKey"],
        changed
            .projection("same", 1, 1, &changed_gl.limits)
            .unwrap()["targetKey"]
    );
    let error = prepared_internal(
        &jobs,
        &hash,
        json!({"caption":"\u{10ffff}"}),
        target(),
        Fit::Contain,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "font_glyph_unavailable");
    assert!(jobs.active_status().is_none());
}

#[tokio::test]
async fn internal_text_target_fit_and_scale_change_native_keys_and_costs() {
    use super::super::config::Fit;
    let root = tempfileish::temp_dir("composition-font-target");
    let (jobs, hash) = install_font_composition(root.path(), json!([
        text_node("label", "font", json!({})),
        {"id":"parent","type":"group","stateVersion":1,"children":["label"],"properties":{}}
    ]), json!([{"id":"scale","label":"Scale","type":"number","default":1,"constraints":{"min":0,"max":64},
        "target":{"kind":"node","nodeId":"parent","property":"scaleX","component":null}}]), planning_probe(), [licensed_font(), font_with_private_table(4, 1)]).await;
    let base = prepared_internal(&jobs, &hash, json!({}), target(), Fit::Contain)
        .await
        .unwrap();
    let mut target_keys = BTreeSet::new();
    let mut raster_keys = BTreeSet::new();
    for (overrides, width, height, fit, pixels) in [
        (json!({}), 64, 128, Fit::Contain, 128),
        (json!({}), 64, 128, Fit::Cover, 512),
        (json!({}), 64, 128, Fit::Stretch, 512),
        (json!({}), 128, 256, Fit::Cover, 2048),
        (json!({"scale":2}), 64, 128, Fit::Cover, 2048),
    ] {
        let plan = reproject_internal(
            &base,
            overrides,
            ImageTarget {
                width,
                height,
                ..target()
            },
            fit,
        )
        .unwrap();
        assert_eq!(plan.text_rasters.raster_pixels(), pixels);
        let gl = plan
            .gl_plan(OwnerKind::Preview, "target-font".into(), 1, 60, 15)
            .unwrap();
        let cost = plan.costs().unwrap();
        assert_eq!(
            gl.session.request().cpu_bytes
                - cost.semantic_bytes
                - cost.buffer_bytes
                - cost.font_cpu_bytes,
            4 * pixels
        );
        assert_eq!(
            gl.session.request().gpu_bytes,
            u64::from(width) * u64::from(height) * 16
                + 4 * pixels
                + cost.buffer_bytes
                + super::super::gl_plan::THREE_BOOTSTRAP_GPU_PEAK_BYTES
        );
        let projection = plan.projection("same", 1, 7, &gl.limits).unwrap();
        assert!(target_keys.insert(projection["targetKey"].as_str().unwrap().to_owned()));
        raster_keys.insert(plan.text_rasters.text_rasters()[0].raster_key().to_owned());
        assert_ne!(
            projection["targetKey"],
            plan.projection("same", 1, 8, &gl.limits).unwrap()["targetKey"]
        );
    }
    assert_eq!(
        raster_keys.len(),
        3,
        "physical text representations share equivalent scales while target identities cover fit/final values/dimensions"
    );
}

#[tokio::test]
async fn internal_visible_shared_text_exports_native_final_value_and_scale_variants() {
    use super::super::config::Fit;
    let root = tempfileish::temp_dir("composition-font-visible-fixture");
    let properties = json!([
        {"id":"caption","label":"Caption","type":"text","default":"Hertz","constraints":{"maxLength":4096},
            "target":{"kind":"node","nodeId":"first","property":"text","component":null}},
        {"id":"font-size","label":"Font size","type":"number","default":16,"constraints":{"min":1,"max":128},
            "target":{"kind":"node","nodeId":"first","property":"fontSize","component":null}},
        {"id":"scale","label":"Parent scale","type":"number","default":1,"constraints":{"min":0,"max":4},
            "target":{"kind":"node","nodeId":"parent","property":"scaleX","component":null}},
        {"id":"visible","label":"Second visible","type":"boolean","default":true,"constraints":{},
            "target":{"kind":"node","nodeId":"second","property":"visible","component":null}}
    ]);
    let (jobs, hash) = install_font_composition(root.path(), json!([
        text_node("first", "font", json!({"x":32,"y":22,"width":56,"height":20,"anchorX":0.5,"anchorY":0.5,"fontSize":16,"color":"#ffffff","visible":true,"align":"center"})),
        text_node("second", "font-alias", json!({"x":32,"y":46,"width":56,"height":20,"anchorX":0.5,"anchorY":0.5,"fontSize":16,"color":"#ffffff","visible":true,"align":"center"})),
        {"id":"parent","type":"group","stateVersion":1,"children":["first","second"],
            "properties":{"x":0,"y":0,"width":64,"height":64,"anchorX":0,"anchorY":0}}
    ]), properties, planning_probe(), [licensed_font(), font_with_private_table(4, 1)]).await;
    let binding = super::super::page_events::PageBinding::new(1).unwrap();
    let mut base_target_key = Value::Null;
    let mut base_raster_key = String::new();
    for (name, overrides, width, height, fit, scale, raster_count) in [
        ("base", json!({}), 128, 128, Fit::Contain, 2.0, 1),
        (
            "same-values",
            json!({"caption":"Hertz","font-size":16,"scale":1,"visible":true}),
            128,
            128,
            Fit::Contain,
            2.0,
            1,
        ),
        (
            "text",
            json!({"caption":"Studio"}),
            128,
            128,
            Fit::Contain,
            2.0,
            2,
        ),
        (
            "style",
            json!({"font-size":18}),
            128,
            128,
            Fit::Contain,
            2.0,
            2,
        ),
        (
            "parent-scale",
            json!({"scale":1.25}),
            128,
            128,
            Fit::Contain,
            2.5,
            1,
        ),
        (
            "hidden",
            json!({"visible":false}),
            128,
            128,
            Fit::Contain,
            2.0,
            1,
        ),
        ("larger-target", json!({}), 256, 256, Fit::Contain, 4.0, 1),
        ("wide-contain", json!({}), 256, 128, Fit::Contain, 2.0, 1),
        ("wide-cover", json!({}), 256, 128, Fit::Cover, 4.0, 1),
    ] {
        let target = ImageTarget {
            width,
            height,
            ..target()
        };
        let plan = prepared_internal(&jobs, &hash, overrides, target, fit)
            .await
            .unwrap();
        assert_eq!(plan.assets.len(), 2);
        assert!(plan.assets.values().all(|asset| asset.as_font().is_some()));
        assert_eq!(plan.text_rasters.unique_font_count(), 1);
        assert_eq!(plan.text_rasters.unique_raster_count(), raster_count);
        assert_eq!(plan.text_rasters.text_rasters()[0].scale(), scale);
        if raster_count == 1 {
            assert_eq!(plan.text_rasters.text_rasters()[0].node_indices(), &[0, 1]);
        }
        let gl = plan
            .gl_plan(OwnerKind::Preview, "visible-font-fixture".into(), 1, 60, 15)
            .unwrap();
        let budget = Arc::new(BudgetCoordinator::new());
        let access = super::super::access::MediaAccess::new();
        let pins = plan.pins();
        let raster_key = plan.text_rasters.text_rasters()[0].raster_key().to_owned();
        let mut admission =
            super::super::gl_plan::GlAdmission::new(gl, Arc::clone(&budget)).unwrap();
        admission
            .bind_composition(plan, &access, binding.session_id())
            .unwrap();
        {
            let path = admission
                .composition_url()
                .unwrap()
                .split("/files/")
                .nth(1)
                .unwrap();
            let reader = access.permit(&hash, path).unwrap();
            let projection: Value = serde_json::from_slice(reader.payload().unwrap()).unwrap();
            if name == "base" {
                base_target_key = projection["targetKey"].clone();
                base_raster_key = raster_key.clone();
            } else if name == "same-values" {
                assert_eq!(projection["targetKey"], base_target_key);
                assert_eq!(raster_key, base_raster_key);
            } else {
                assert_ne!(projection["targetKey"], base_target_key);
                if matches!(name, "hidden" | "wide-contain") {
                    assert_eq!(raster_key, base_raster_key);
                } else {
                    assert_ne!(raster_key, base_raster_key);
                }
            }
        }
        if let Some(output) = std::env::var_os("HERTZ_COMPOSITION_INTERNAL_VISIBLE_TEXT_FIXTURE") {
            export_internal_fixture(
                &std::path::PathBuf::from(output).join(name),
                &admission,
                &access,
                &binding,
                pins,
            );
        }
        admission.retire();
        admission.controller_closed();
        assert!(admission.finish());
        assert_eq!(budget.usage().contexts, 0);
        assert_eq!(budget.usage().cpu_bytes, 0);
        assert_eq!(budget.usage().gpu_bytes, 0);
    }
}

#[tokio::test]
async fn aggregate_real_font_glyph_and_raster_memory_fail_before_any_native_probe() {
    use super::super::config::Fit;
    let root = tempfileish::temp_dir("composition-font-preflight-budget");
    for kind in ["fonts", "glyphs", "rasters"] {
        let (mut nodes, fonts) = if kind == "rasters" {
            (
                Value::Array(
                    ["H", "e", "r", "t", "z"]
                        .iter()
                        .enumerate()
                        .map(|(index, text)| {
                            text_node(
                                &format!("text-{index}"),
                                "font",
                                json!({"text":text,"width":3000,"height":2600}),
                            )
                        })
                        .collect(),
                ),
                [licensed_font(), font_with_private_table(4, 1)],
            )
        } else {
            (
                json!([
                    text_node("first", "font", json!({})),
                    text_node("second", "font-b", json!({}))
                ]),
                if kind == "glyphs" {
                    [
                        super::super::font_prepare::tests::glyph_cost_font_fixture(1),
                        super::super::font_prepare::tests::glyph_cost_font_fixture(2),
                    ]
                } else {
                    [
                        font_with_private_table(14 * 1024 * 1024, 1),
                        font_with_private_table(14 * 1024 * 1024, 2),
                    ]
                },
            )
        };
        // The first final resource is media: the entire font group must still
        // inspect and reject before its original prepare_target/native path.
        nodes.as_array_mut().unwrap().insert(0, json!({"id":"image","type":"image","stateVersion":1,"assets":{"asset":"pixel"},"properties":{}}));
        let probe = ProbeClient::testing_input(|_, _| {
            panic!("native preparation preceded aggregate font preflight")
        });
        let counts = probe.clone();
        let (jobs, hash) =
            install_font_composition(&root.path().join(kind), nodes, json!([]), probe, fonts).await;
        let group = group_request_for_test(&jobs, &hash, json!({}));
        assert_eq!(
            group.composition.final_values.resource_uses()[0].asset_id,
            "pixel"
        );
        let inputs = inspect_group_for_test(&jobs, &group, &counts);
        let facts = inputs
            .iter()
            .map(|(id, input)| (id.clone(), input.plan_facts().unwrap()))
            .collect();
        let rasters = text_raster::plan_text_rasters_from_facts(
            &group.composition.compiled,
            &group.composition.final_values,
            &facts,
            target(),
            Fit::Contain,
        )
        .unwrap();
        let cap = super::super::budget::MAX_CPU_DECODED_BYTES;
        if kind == "rasters" {
            assert_eq!(rasters.unique_raster_count(), 5);
            assert_eq!(rasters.raster_pixels(), 5 * 3000 * 2600);
            assert!(rasters.raster_rgba_bytes() > cap);
        } else {
            assert_eq!(rasters.unique_font_count(), 2);
            assert!(rasters.font_cpu_bytes() > cap);
            for input in inputs.values() {
                assert!(input.metadata.cpu_budget_bytes < cap);
                assert_eq!(
                    input.metadata.cpu_budget_bytes,
                    5 * input.media.entry.bytes + 64 * u64::from(input.metadata.glyph_count) + 4096
                );
            }
            if kind == "glyphs" {
                assert!(
                    5 * inputs
                        .values()
                        .map(|input| input.media.entry.bytes)
                        .sum::<u64>()
                        < cap
                );
                assert!(inputs
                    .values()
                    .all(|input| input.metadata.glyph_count == 30_000));
            }
        }
        let lower = group
            .composition
            .memory_request(&inputs, "expected-preflight".into(), 1)
            .unwrap();
        let error = prepared_internal(&jobs, &hash, json!({}), target(), Fit::Contain)
            .await
            .unwrap_err();
        assert_eq!(error.code, "budget_busy");
        let details = error.details.unwrap();
        assert_eq!(details["quota"], "cpu_decoded_bytes");
        assert_eq!(details["cap"], cap);
        assert_eq!(details["held"], 0);
        assert_eq!(details["requested"], lower.cpu_bytes);
        assert_eq!(
            counts.stats(),
            (0, 0),
            "fixture inspection/installation never qualifies a font or media"
        );
        assert!(jobs.active_status().is_none());
        drop(jobs.assets().content_writer().unwrap());
        assert_eq!(
            counts.budget_for_test().usage(),
            super::super::budget::BudgetUsage::default()
        );
        let access = super::super::access::MediaAccess::new();
        assert!(access.permit(&hash, "assets/font.ttf").is_none());
    }
}

#[tokio::test]
async fn hidden_final_public_font_text_and_scale_overrides_preflight_before_qualification() {
    use super::super::config::Fit;
    let root = tempfileish::temp_dir("composition-font-public-preflight");
    let mut nodes: Vec<_> = ["H", "e", "r", "t", "z"]
        .iter()
        .enumerate()
        .map(|(index, text)| {
            text_node(
                &format!("text-{index}"),
                "font",
                json!({"text":text,"width":3000,"height":2600,"visible":false}),
            )
        })
        .collect();
    nodes.push(json!({"id":"parent","type":"group","stateVersion":1,
        "children":["text-0","text-1","text-2","text-3","text-4"],"properties":{"scaleX":0.01,"scaleY":0.01}}));
    let properties = json!([
        {"id":"scale","type":"number","label":"Scale","default":0.01,"constraints":{"min":0.01,"max":1},
            "target":{"kind":"node","nodeId":"parent","property":"scaleX","component":null}},
        {"id":"face","type":"asset","label":"Face","default":"font","constraints":{"kind":"font","options":["font","font-b"]},
            "target":{"kind":"node","nodeId":"text-0","property":"fontAsset","component":null}},
        {"id":"caption","type":"text","label":"Caption","default":"H","constraints":{"maxLength":4096},
            "target":{"kind":"node","nodeId":"text-0","property":"text","component":null}}
    ]);
    let probe = planning_probe();
    let counts = probe.clone();
    let (jobs, hash) = install_font_composition(
        root.path(),
        json!(nodes),
        properties,
        probe,
        [
            licensed_font(),
            font_with_private_table(14 * 1024 * 1024, 7),
        ],
    )
    .await;
    prepared_internal(&jobs, &hash, json!({}), target(), Fit::Contain)
        .await
        .unwrap();
    let before = counts.stats();
    let overrides = json!({"scale":1,"face":"font-b","caption":"Hertz"});
    let group = group_request_for_test(&jobs, &hash, overrides.clone());
    assert_eq!(group.fonts.len(), 2);
    assert_eq!(
        group
            .fonts
            .iter()
            .find(|font| font.reference.asset_id == "font-b")
            .unwrap()
            .required_texts,
        vec![RequiredText {
            node_id: "text-0".into(),
            text: "Hertz".into()
        }]
    );
    let error = prepared_internal(&jobs, &hash, overrides, target(), Fit::Contain)
        .await
        .unwrap_err();
    assert_eq!(error.details.unwrap()["quota"], "cpu_decoded_bytes");
    assert_eq!(
        counts.stats(),
        before,
        "hidden final overrides reject before any new qualifier"
    );
    let error = prepared_internal(
        &jobs,
        &hash,
        json!({"face":"font-b","caption":"\u{10ffff}"}),
        target(),
        Fit::Contain,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "font_glyph_unavailable");
    assert_eq!(counts.stats(), before);
}

#[tokio::test]
async fn later_font_inspection_failure_prevents_first_font_and_first_media_native_runs() {
    let root = tempfileish::temp_dir("composition-font-inspect-all");
    let probe =
        ProbeClient::testing_input(|_, _| panic!("inspection must finish for the whole group"));
    let counts = probe.clone();
    let (jobs, hash) = install_font_composition(root.path(), json!([
        {"id":"image","type":"image","stateVersion":1,"assets":{"asset":"pixel"},"properties":{}},
        text_node("first", "font", json!({})),
        text_node("second", "font-b", json!({"text":"\u{10ffff}"}))
    ]), json!([]), probe, [licensed_font(), font_with_private_table(4, 1)]).await;
    let error = prepared_internal(
        &jobs,
        &hash,
        json!({}),
        target(),
        super::super::config::Fit::Contain,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "font_glyph_unavailable");
    assert_eq!(error.details.unwrap()["nodeId"], "second");
    assert_eq!(counts.stats(), (0, 0));
    assert!(jobs.active_status().is_none());
    assert_eq!(
        counts.budget_for_test().usage(),
        super::super::budget::BudgetUsage::default()
    );
}

#[tokio::test]
async fn group_qualification_failure_stops_later_fonts_and_media_after_all_workspace_exit() {
    use crate::wallpaper::decode_probe::ProbeInput;
    let root = tempfileish::temp_dir("composition-font-qualifier-order");
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = Arc::clone(&seen);
    let budget_holder = Arc::new(std::sync::OnceLock::<Arc<BudgetCoordinator>>::new());
    let inspect_budget = Arc::clone(&budget_holder);
    let probe = ProbeClient::testing_input(move |input, _| {
        let ProbeInput::Font(input) = input else {
            panic!("media cannot precede successful font group")
        };
        let id = input.plan_facts().unwrap().reference().asset_id.clone();
        let usage = inspect_budget.get().unwrap().usage();
        assert_eq!(
            usage.prepare_cpu_bytes, 0,
            "all parser workspaces physically exited before first qualifier"
        );
        assert_eq!(
            usage.prepare_tasks, 1,
            "the group still owns one original slot"
        );
        observed.lock().unwrap().push(id.clone());
        Box::pin(async move {
            if id == "font-alias" {
                Err(
                    JobError::new("font_decode_failed", "second qualifier failed")
                        .with_details(json!({"fontAssetId":id})),
                )
            } else {
                Ok(())
            }
        })
    });
    let counts = probe.clone();
    assert!(budget_holder.set(probe.budget_for_test()).is_ok());
    let (jobs, hash) = install_font_composition(root.path(), json!([
        {"id":"image","type":"image","stateVersion":1,"assets":{"asset":"pixel"},"properties":{}},
        text_node("first", "font", json!({"text":"H"})),
        text_node("second", "font-alias", json!({"text":"e"})),
        text_node("third", "font-b", json!({"text":"r"}))
    ]), json!([]), probe, [licensed_font(), font_with_private_table(4, 1)]).await;
    let error = prepared_internal(
        &jobs,
        &hash,
        json!({}),
        target(),
        super::super::config::Fit::Contain,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "font_decode_failed");
    assert_eq!(error.details.unwrap()["fontAssetId"], "font-alias");
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["font".to_owned(), "font-alias".to_owned()]
    );
    assert_eq!(counts.stats(), (0, 2));
    assert!(jobs.active_status().is_none());
    assert_eq!(
        counts.budget_for_test().usage(),
        super::super::budget::BudgetUsage::default()
    );
}

#[tokio::test]
async fn group_preflight_respects_existing_active_and_release_pending_memory_on_original_budget() {
    let root = tempfileish::temp_dir("composition-font-held-memory");
    for gpu in [false, true] {
        for pending in [false, true] {
            let probe = ProbeClient::testing_input(|_, _| {
                panic!("held memory must reject before native preparation")
            });
            let counts = probe.clone();
            let (jobs, hash) = install_font_composition(
                &root.path().join(format!("{gpu}-{pending}")),
                json!([text_node("label", "font", json!({}))]),
                json!([]),
                probe,
                [licensed_font(), font_with_private_table(4, 1)],
            )
            .await;
            let group = group_request_for_test(&jobs, &hash, json!({}));
            let inputs = inspect_group_for_test(&jobs, &group, &counts);
            let mut held_request = group
                .composition
                .memory_request(&inputs, "held-memory-owner".into(), 1)
                .unwrap();
            let requested = if gpu {
                held_request.gpu_bytes
            } else {
                held_request.cpu_bytes
            };
            let cap = if gpu {
                super::super::budget::MAX_GPU_TRACKED_BYTES
            } else {
                super::super::budget::MAX_CPU_DECODED_BYTES
            };
            held_request.cpu_bytes = if gpu { 0 } else { cap - requested + 1 };
            held_request.gpu_bytes = if gpu { cap - requested + 1 } else { 0 };
            let budget = counts.budget_for_test();
            let held = budget.grant(&held_request).unwrap();
            if pending {
                budget.release(held, &held_request.session, 1).unwrap();
            }
            let usage = budget.usage();
            let error = prepared_internal(
                &jobs,
                &hash,
                json!({}),
                target(),
                super::super::config::Fit::Contain,
            )
            .await
            .unwrap_err();
            let details = error.details.unwrap();
            assert_eq!(
                details["quota"],
                if gpu {
                    "gpu_tracked_bytes"
                } else {
                    "cpu_decoded_bytes"
                }
            );
            assert_eq!(details["held"], cap - requested + 1);
            assert_eq!(details["requested"], requested);
            assert_eq!(counts.stats(), (0, 0));
            assert_eq!(
                budget.usage(),
                usage,
                "all inspection workspaces and the original prepare slot exited"
            );
            if !pending {
                budget.release(held, &held_request.session, 1).unwrap();
            }
            budget.confirm_exit(held, &held_request.session, 1).unwrap();
            budget.purge_session(&held_request.session, 1);
        }
    }
}

#[tokio::test]
async fn successful_font_preflight_still_requires_final_original_admission_after_memory_changes() {
    let root = tempfileish::temp_dir("composition-font-preflight-advisory");
    let probe = planning_probe();
    let counts = probe.clone();
    let (jobs, hash) = install_font_composition(
        root.path(),
        json!([text_node("label", "font", json!({}))]),
        json!([]),
        probe,
        [licensed_font(), font_with_private_table(4, 1)],
    )
    .await;
    let plan = prepared_internal(
        &jobs,
        &hash,
        json!({}),
        target(),
        super::super::config::Fit::Contain,
    )
    .await
    .unwrap();
    assert_eq!(counts.stats(), (0, 1));
    let gl = plan
        .gl_plan(OwnerKind::Preview, "final-advisory".into(), 1, 60, 15)
        .unwrap();
    let budget = counts.budget_for_test();
    let mut held_request = gl.session.request().clone();
    held_request.owner = OwnerKind::Probe;
    held_request.session = "later-memory-owner".into();
    held_request.contexts = 0;
    held_request.output_pixel_rate = 0;
    held_request.gpu_bytes = 0;
    held_request.cpu_bytes =
        super::super::budget::MAX_CPU_DECODED_BYTES - gl.session.request().cpu_bytes + 1;
    let held = budget.grant(&held_request).unwrap();
    let access = super::super::access::MediaAccess::new();
    let error = super::super::gl_plan::GlAdmission::new(gl, Arc::clone(&budget))
        .err()
        .unwrap();
    assert!(error.message.starts_with("cpu_decoded_bytes:"));
    assert!(access.permit(&hash, "assets/font.ttf").is_none());
    assert_eq!(budget.usage().contexts, 0);
    budget.release(held, &held_request.session, 1).unwrap();
    budget.confirm_exit(held, &held_request.session, 1).unwrap();
    budget.purge_session(&held_request.session, 1);
}

#[tokio::test]
async fn whole_same_content_font_group_cannot_replace_the_context_package_before_qualification() {
    let root = tempfileish::temp_dir("composition-font-group-package-anchor");
    let original_probe = ProbeClient::testing_input(|_, _| panic!("foreign group cannot qualify"));
    let original_counts = original_probe.clone();
    let nodes = json!([
        {"id":"image","type":"image","stateVersion":1,"assets":{"asset":"pixel"},"properties":{}},
        text_node("first", "font", json!({"text":"H"})),
        text_node("second", "font-alias", json!({"text":"e"}))
    ]);
    let (jobs, hash) = install_font_composition(
        &root.path().join("original"),
        nodes.clone(),
        json!([]),
        original_probe,
        [licensed_font(), font_with_private_table(4, 1)],
    )
    .await;
    let other_probe =
        ProbeClient::testing_input(|_, _| panic!("fixture pins need no qualification"));
    let other_counts = other_probe.clone();
    let (other_jobs, other_hash) = install_font_composition(
        &root.path().join("other"),
        nodes,
        json!([]),
        other_probe,
        [licensed_font(), font_with_private_table(4, 2)],
    )
    .await;
    assert_ne!(hash, other_hash);
    let original = group_request_for_test(&jobs, &hash, json!({}));
    let other = group_request_for_test(&other_jobs, &other_hash, json!({}));
    let original_inputs = inspect_group_for_test(&jobs, &original, &original_counts);
    let other_inputs = inspect_group_for_test(&other_jobs, &other, &other_counts);
    for (id, input) in &other_inputs {
        let facts = input.plan_facts().unwrap();
        assert_eq!(facts.reference().package_hash, other_hash);
        assert_eq!(
            facts.content_key(),
            original_inputs[id].plan_facts().unwrap().content_key()
        );
        assert!(facts.covers_required_texts(
            &other
                .fonts
                .iter()
                .find(|font| font.reference.asset_id == *id)
                .unwrap()
                .required_texts
        ));
    }
    let mut replacement = original.clone();
    replacement.fonts = other.fonts;
    assert_eq!(replacement.composition.package_hash(), hash);
    assert_eq!(
        jobs.prepare_font_group(super::super::jobs::new_job_id(), replacement)
            .err()
            .unwrap()
            .code,
        "invalid_input"
    );
    assert_eq!(
        original
            .composition
            .memory_request(&other_inputs, "foreign-facts".into(), 1)
            .unwrap_err()
            .code,
        "font_not_prepared"
    );
    assert_eq!(original_counts.stats(), (0, 0));
    assert_eq!(other_counts.stats(), (0, 0));
    assert!(jobs.active_status().is_none());
}
#[tokio::test]
async fn final_font_aliases_cannot_borrow_another_asset_or_package_receipt() {
    use super::super::config::Fit;
    let root = tempfileish::temp_dir("composition-font-exact-refs");
    let nodes = json!([
        text_node("first", "font", json!({})),
        text_node("second", "font-alias", json!({}))
    ]);
    let (jobs, hash) = install_font_composition(
        &root.path().join("one"),
        nodes.clone(),
        json!([]),
        planning_probe(),
        [licensed_font(), font_with_private_table(4, 1)],
    )
    .await;
    let mut plan = prepared_internal(&jobs, &hash, json!({}), target(), Fit::Contain)
        .await
        .unwrap();
    let original = plan.assets["font-alias"].clone();
    plan.assets
        .insert("font-alias".into(), plan.assets["font"].clone());
    assert_eq!(plan.finish().unwrap_err().code, "font_not_prepared");
    let (other_jobs, other_hash) = install_font_composition(
        &root.path().join("two"),
        nodes,
        json!([]),
        planning_probe(),
        [licensed_font(), font_with_private_table(4, 2)],
    )
    .await;
    assert_ne!(hash, other_hash);
    let mut other = prepared_internal(&other_jobs, &other_hash, json!({}), target(), Fit::Contain)
        .await
        .unwrap();
    other.assets.insert("font-alias".into(), original);
    assert_eq!(other.finish().unwrap_err().code, "font_not_prepared");
}

#[tokio::test]
async fn composition_font_cancellation_waits_for_original_typed_terminal_receipt() {
    use crate::wallpaper::decode_probe::ProbeInput;
    use std::time::Duration;
    let root = tempfileish::temp_dir("composition-font-cancel");
    let entered = Arc::new(tokio::sync::Notify::new());
    let cancelled = Arc::new(tokio::sync::Notify::new());
    let completed = Arc::new(AtomicBool::new(false));
    let (release, receive) = tokio::sync::oneshot::channel();
    let receive = Arc::new(std::sync::Mutex::new(Some(receive)));
    let probe_entered = Arc::clone(&entered);
    let probe_cancelled = Arc::clone(&cancelled);
    let probe_completed = Arc::clone(&completed);
    let probe = ProbeClient::testing_input(move |input, cancel| {
        assert!(matches!(input, ProbeInput::Font(_)));
        let receive = receive.lock().unwrap().take().unwrap();
        let entered = Arc::clone(&probe_entered);
        let cancelled = Arc::clone(&probe_cancelled);
        let completed = Arc::clone(&probe_completed);
        Box::pin(async move {
            // This callback models a physical exit barrier only in this test.
            entered.notify_one();
            while !cancel.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            cancelled.notify_one();
            let _ = receive.await;
            completed.store(true, Ordering::Release);
            Ok(())
        })
    });
    let (jobs, hash) = install_font_composition(
        root.path(),
        json!([text_node("label", "font", json!({}))]),
        json!([]),
        probe,
        [licensed_font(), font_with_private_table(4, 1)],
    )
    .await;
    let package = jobs.assets().read_installed_manifest(&hash).unwrap();
    let (compiled, values, _) =
        read_document(jobs.assets(), &package, &Default::default()).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let task_jobs = Arc::clone(&jobs);
    let task_package = package.clone();
    let task_cancel = Arc::clone(&cancel);
    let prepare = tokio::spawn(async move {
        prepare_assets(
            &task_jobs,
            &task_package,
            &compiled,
            &values,
            target(),
            super::super::config::Fit::Contain,
            &task_cancel,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), entered.notified())
        .await
        .unwrap();
    cancel.store(true, Ordering::Release);
    tokio::time::timeout(Duration::from_secs(5), cancelled.notified())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(125)).await;
    assert!(
        !prepare.is_finished(),
        "cancellation is forwarded until the real worker's typed receipt; it cannot race or drop the qualifier"
    );
    assert!(!completed.load(Ordering::Acquire));
    assert!(jobs.active_status().is_some());
    assert!(jobs.assets().content_writer().is_err());
    assert_eq!(
        jobs.prepare_font(
            super::super::jobs::new_job_id(),
            FontPrepareRequest {
                reference: AssetRef {
                    package_hash: hash,
                    asset_id: "font".into(),
                    variant_id: None
                },
                expected_entry: package
                    .entries
                    .iter()
                    .find(|entry| entry.path == "assets/font.ttf")
                    .unwrap()
                    .clone(),
                required_texts: vec![],
            }
        )
        .err()
        .unwrap()
        .code,
        "budget_busy"
    );
    release.send(()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), prepare)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.err().unwrap().code, "cancelled");
    assert!(completed.load(Ordering::Acquire));
    assert!(jobs.active_status().is_none());
    assert!(jobs.assets().content_writer().is_ok());
}

#[test]
fn composition_checked_arithmetic_rejects_overflow() {
    assert_eq!(
        checked_product(u64::MAX, 16).unwrap_err().code,
        "budget_exceeded"
    );
    assert_eq!(
        checked_sum(&[u64::MAX, 1]).unwrap_err().code,
        "budget_exceeded"
    );
}

#[tokio::test]
async fn internal_browser_font_requests_export_original_prepared_projection_and_pins() {
    use super::super::config::Fit;
    let Some(request_path) = std::env::var_os("HERTZ_COMPOSITION_BROWSER_FONT_REQUESTS") else {
        return;
    };
    let output = std::path::PathBuf::from(
        std::env::var_os("HERTZ_COMPOSITION_BROWSER_FONT_OUTPUT")
            .expect("the internal browser bridge requires an output mapping path"),
    );
    let output_root = output.parent().unwrap();
    let requests: Vec<Value> =
        serde_json::from_slice(&std::fs::read(request_path).unwrap()).unwrap();
    let root = tempfileish::temp_dir("composition-browser-font-bridge");
    let mut mapping = serde_json::Map::new();
    for (index, request) in requests.into_iter().enumerate() {
        let key = request["key"].as_str().unwrap().to_owned();
        assert!(
            !mapping.contains_key(&key),
            "browser fixture keys must be unique"
        );
        let directory = root.path().join(format!("request-{index}"));
        let jobs = Arc::new(ImportJobs::start(
            Library::open(&directory).await.unwrap(),
            AssetStore::new(&directory).unwrap(),
            planning_probe(),
        ));
        let mut owned_entries = vec![(
            "composition.json".to_owned(),
            serde_json::to_vec(&request["document"]).unwrap(),
            "application/json".to_owned(),
        )];
        for file in request["files"].as_array().unwrap() {
            owned_entries.push((
                file["path"].as_str().unwrap().to_owned(),
                std::fs::read(file["source"].as_str().unwrap()).unwrap(),
                file["mime"].as_str().unwrap().to_owned(),
            ));
        }
        let entries = owned_entries
            .iter()
            .map(|(path, bytes, mime)| (path.as_str(), bytes.clone(), mime.as_str()))
            .collect();
        let hash = install_package(
            &jobs,
            &directory,
            entries,
            request["assets"].clone(),
            request["properties"].clone(),
            json!({"code":"none","assets":"OFL-1.1",
                "attribution":"Copyright 2022 The Instrument Serif Project Authors"}),
            zip::CompressionMethod::Stored,
        )
        .await;
        let plan = if let Some(native) = request.get("nativeTarget") {
            // Synthetic target facts for browser geometry tests. Real HWND/DPI
            // qualification is performed by the separate native journey.
            let facts = super::super::builtin_plan::TargetFacts {
                monitor_id: "browser-synthetic-monitor".into(),
                monitor_left: 0,
                monitor_top: 0,
                physical_width: native["width"].as_u64().unwrap() as u32,
                physical_height: native["height"].as_u64().unwrap() as u32,
                device_scale: native["deviceScale"].as_f64().unwrap(),
                requested_quality: "low".into(),
                requested_fps: 15,
                refresh_hz: 60,
                purpose: ImagePurpose::Preview,
            };
            resolve_with_target_facts(
                Arc::clone(&jobs),
                hash.clone(),
                request["overrides"].as_object().unwrap().clone(),
                ImageTarget {
                    width: facts.physical_width,
                    height: facts.physical_height,
                    ..target()
                },
                serde_json::from_value(native["fit"].clone()).unwrap(),
                Some(facts),
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap()
        } else {
            prepared_internal(
                &jobs,
                &hash,
                request["overrides"].clone(),
                target(),
                Fit::Stretch,
            )
            .await
            .unwrap()
        };
        let case_directory = format!("case-{index}");
        let files: Vec<Value> = plan.assets.values().map(|asset| json!({"url":asset.url(),
            "entry":asset.pin().entry,"file":format!("{case_directory}/files/{}",asset.pin().entry.path)})).collect();
        let pins = plan.pins();
        let gl = plan
            .gl_plan(
                OwnerKind::Preview,
                format!("browser-font-{index}"),
                1,
                60,
                15,
            )
            .unwrap();
        let budget = Arc::new(BudgetCoordinator::new());
        let access = super::super::access::MediaAccess::new();
        let binding = super::super::page_events::PageBinding::new(1).unwrap();
        let mut admission =
            super::super::gl_plan::GlAdmission::new(gl, Arc::clone(&budget)).unwrap();
        admission
            .bind_composition(plan, &access, binding.session_id())
            .unwrap();
        export_internal_fixture(
            &output_root.join(&case_directory),
            &admission,
            &access,
            &binding,
            pins,
        );
        let projection = {
            let path = admission
                .composition_url()
                .unwrap()
                .split("/files/")
                .nth(1)
                .unwrap();
            let reader = access.permit(&hash, path).unwrap();
            serde_json::from_slice::<Value>(reader.payload().unwrap()).unwrap()
        };
        mapping.insert(key, json!({"projection":projection,"files":files}));
        admission.retire();
        admission.controller_closed();
        assert!(admission.finish());
        assert_eq!(budget.usage().cpu_bytes, 0);
        assert_eq!(budget.usage().gpu_bytes, 0);
    }
    std::fs::create_dir_all(output_root).unwrap();
    std::fs::write(output, serde_json::to_vec_pretty(&mapping).unwrap()).unwrap();
}
