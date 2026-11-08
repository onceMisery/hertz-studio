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
    let files:Vec<_>=entries.iter().map(|(path,bytes,mime)|json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":mime})).collect();
    let manifest = json!({"formatVersion":1,"workId":WORK_ID,"version":1,"title":"native composition", "description":"",
        "content":{"kind":"composition","document":"composition.json"},"assets":assets,"files":files,"properties":properties,
        "permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"none","attribution":""}});
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
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
    (jobs, package.package_hash, probes)
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
        let source = &plan.assets["movie"].input().metadata;
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
    let media = &plan.assets["movie"];
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
fn unsupported_text_is_rejected_without_claiming_font_qualification() {
    let manifest:hertz_wallpaper::Manifest=serde_json::from_value(json!({"formatVersion":1,"workId":WORK_ID,"version":1,"title":"text","description":"",
        "content":{"kind":"composition","document":"composition.json"},"assets":[{"id":"font","kind":"font","source":"assets/font.ttf"}],"files":[{"path":"composition.json","bytes":1,"sha256":"a".repeat(64),"mime":"application/json"},{"path":"assets/font.ttf","bytes":1,"sha256":"b".repeat(64),"mime":"font/ttf"}],
        "properties":[],"permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"none","attribution":""}})).unwrap();
    let compiled=hertz_wallpaper::document::compile_document(&serde_json::to_vec(&document(json!([{"id":"text","type":"text","stateVersion":1,"assets":{"fontAsset":"font"},"properties":{"text":"hello"}}]))).unwrap(),&manifest).unwrap();
    assert_eq!(
        validate_adapters(&compiled).unwrap_err().code,
        "font_not_prepared"
    );
}
