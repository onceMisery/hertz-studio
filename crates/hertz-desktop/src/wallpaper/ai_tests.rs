// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::{
    assets::AssetStore,
    decode_probe::ProbeClient,
    library::{InstallWork, Library, LOCAL_SOURCE},
    work_drafts::{self, Document},
};
use std::path::{Path, PathBuf};

struct Root(PathBuf);
impl Root {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("hertz-ai01-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn jobs(root: &Path) -> Arc<ImportJobs> {
    Arc::new(ImportJobs::start(
        Library::open(root).await.unwrap(),
        AssetStore::new(root).unwrap(),
        ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })),
    ))
}
fn context(native: &mut NativeAi) -> CatalogContext {
    let mut configuration = crate::config::Config::default();
    configuration.wallpaper.audio_input = config::AudioInput::None;
    native.set_owner(7);
    native.select_group(7, Some("main")).unwrap();
    let monitor = crate::native::WallpaperMonitor {
        name: "AI01 isolated monitor".into(),
        left: 0,
        top: 0,
        width: 640,
        height: 360,
        dpi: 96,
        primary: true,
        refresh_hz: 60,
        device_path: None,
        edid_digest: None,
    };
    let targets = super::super::display::DisplayTopology::default()
        .reconcile(&configuration.wallpaper.groups, &[monitor], Instant::now())
        .unwrap()
        .targets;
    let binding = native
        .binding(7, "S-1-5-21-ai01".into(), &configuration, &targets)
        .unwrap();
    CatalogContext {
        binding,
        configuration: configuration.wallpaper,
        targets,
        replaced_generations: vec![],
    }
}
async fn install(
    jobs: &ImportJobs,
    index: u32,
    title: &str,
    version: u32,
    work_id: &str,
) -> (String, String) {
    let document = Document {
        title: title.into(),
        description: "安静 海岸".into(),
        scene_id: "coast".into(),
        state_version: 1,
        params: Default::default(),
        properties: vec![],
    };
    let bytes = work_drafts::builtin_package(&document, work_id, version).unwrap();
    install_package(jobs, index, title, version, work_id, "builtin", bytes).await
}
async fn install_package(
    jobs: &ImportJobs,
    index: u32,
    title: &str,
    version: u32,
    work_id: &str,
    kind: &str,
    bytes: Vec<u8>,
) -> (String, String) {
    let id = format!("ai-fixture-{index}");
    let source = jobs.assets().root().join(format!("{id}.hwpkg"));
    std::fs::write(&source, bytes).unwrap();
    jobs.assets().snapshot_input(&id, &source, None).unwrap();
    let package = jobs.assets().validate_staged(&id).unwrap();
    jobs.assets().unpack_projection(&id, &package).unwrap();
    jobs.assets()
        .content_writer()
        .unwrap()
        .publish_staging(&id, &package.package_hash)
        .unwrap();
    let work = format!("ai-work-{work_id}");
    let hash = package.package_hash.clone();
    jobs.library()
        .install(&InstallWork {
            remote_work_id: work_id.into(),
            work_key: work.clone(),
            title: title.into(),
            description: "安静 海岸".into(),
            kind: kind.into(),
            package_hash: hash.clone(),
            manifest_json: package.manifest_json,
            package_bytes: jobs.assets().installed_bytes(&hash).unwrap(),
            version,
            source_id: LOCAL_SOURCE.into(),
        })
        .await
        .unwrap();
    std::fs::remove_file(source).unwrap();
    (work, hash)
}
fn sample_catalog(native: &mut NativeAi) -> (Binding, Catalog) {
    let binding = context(native).binding;
    let mut action = Action {
        action_id: "shown-action".into(),
        target_group_id: "main".into(),
        work_key: "work-a".into(),
        package_hash: "a".repeat(64),
        title: "静夜".into(),
        version: 1,
        permission_digest: "b".repeat(64),
        action_digest: String::new(),
        reasons: vec![],
    };
    action.action_digest = digest(
        &json!({"binding":binding.context_digest,"group":binding.target_group_id,"work":action.work_key,"package":action.package_hash,"permission":action.permission_digest,"operation":"replaceSelection"}),
    );
    let catalog = Catalog {
        binding: binding.clone(),
        actions: vec![action],
        explicit_action: Some("shown-action".into()),
        ambiguous: false,
        inspected: 1,
    };
    (binding, catalog)
}

#[test]
fn tickets_are_full_random_single_use_expiring_bounded_and_fenced() {
    let mut native = NativeAi::new();
    let (binding, catalog) = sample_catalog(&mut native);
    native.show(&catalog, &binding).unwrap();
    let now = Instant::now();
    let tokens = (0..4)
        .map(|_| {
            native
                .issue_displayed("shown-action", &binding, now)
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert!(tokens
        .iter()
        .all(|token| token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())));
    assert_ne!(tokens[0], tokens[1]);
    assert!(native
        .issue_displayed("shown-action", &binding, now)
        .is_err());
    let authority = native
        .consume(&tokens[0], &binding, "request-original", now)
        .unwrap();
    check_authority(&authority, &binding).unwrap();
    assert_eq!(authority.request_id, "request-original");
    assert!(native.consume(&tokens[0], &binding, "replay", now).is_err());
    assert!(native
        .consume(&tokens[1], &binding, "expired", now + TTL)
        .is_err());
    for changed in [0, 1, 2, 3, 4, 5, 6, 7, 8] {
        let token = native
            .issue_displayed("shown-action", &binding, now)
            .unwrap();
        let mut newer = binding.clone();
        match changed {
            0 => newer.principal.push('x'),
            1 => newer.settings_session += 1,
            2 => newer.host_generation.push('x'),
            3 => newer.profile_digest.push('x'),
            4 => newer.target_group_id.push('x'),
            5 => newer.selection_generation += 1,
            6 => newer.topology_revision.push('x'),
            7 => newer.expected_config_revision += 1,
            _ => newer.context_digest.push('x'),
        }
        assert!(native.consume(&token, &newer, "stale", now).is_err());
        // Incorrect session leaves this token inaccessible; revoke the session's
        // entries before checking the next independent binding mutation.
        native.tickets.remove(&token);
    }
    native.set_owner(8);
    assert!(native
        .issue_displayed("shown-action", &binding, now)
        .is_err());
}

#[test]
fn proposed_actions_and_untrusted_flags_cannot_create_authority() {
    let mut native = NativeAi::new();
    let (binding, catalog) = sample_catalog(&mut native);
    assert!(native
        .issue_displayed("shown-action", &binding, Instant::now())
        .is_err());
    let mut older = binding.clone();
    older.expected_config_revision += 1;
    assert!(native.show(&catalog, &older).is_err());
    for flag in ["approved", "explicit", "isTrusted"] {
        let value = json!({"brief":"切换到静夜",flag:true});
        assert!(serde_json::from_value::<RecommendInput>(value).is_err());
    }
    native.show(&catalog, &binding).unwrap();
    let token = native
        .issue_displayed("shown-action", &binding, Instant::now())
        .unwrap();
    let mut authority = native
        .consume(&token, &binding, "request", Instant::now())
        .unwrap();
    authority.action.package_hash = "c".repeat(64);
    assert!(check_authority(&authority, &binding).is_err());
}

#[tokio::test]
async fn real_catalog_cap_ambiguity_version_revocation_and_committed_snapshot() {
    let root = Root::new();
    let jobs = jobs(&root.0).await;
    let mut native = NativeAi::new();
    let context = context(&mut native);
    for index in 0..34 {
        install(
            &jobs,
            index,
            &format!("海岸-{index:02}"),
            1,
            &uuid::Uuid::new_v4().to_string(),
        )
        .await;
    }
    let one = install(&jobs, 35, "静夜", 1, &uuid::Uuid::new_v4().to_string()).await;
    let first = catalog(Arc::clone(&jobs), "切换到静夜".into(), context.clone())
        .await
        .unwrap();
    assert!(first.explicit_action.is_some());
    assert_eq!(first.actions[0].work_key, one.0);
    let many = catalog(Arc::clone(&jobs), String::new(), context.clone())
        .await
        .unwrap();
    assert_eq!(many.actions.len(), 32);
    assert_eq!(many.inspected, 35);
    let second = install(&jobs, 36, "静夜", 1, &uuid::Uuid::new_v4().to_string()).await;
    let duplicate = catalog(Arc::clone(&jobs), "切换到静夜".into(), context.clone())
        .await
        .unwrap();
    assert!(duplicate.ambiguous);
    assert!(duplicate.explicit_action.is_none());
    native.show(&duplicate, &context.binding).unwrap();
    let token = native
        .issue_displayed(
            &duplicate.actions[0].action_id,
            &context.binding,
            Instant::now(),
        )
        .unwrap();
    let mut authority = native
        .consume(&token, &context.binding, "revoked-request", Instant::now())
        .unwrap();
    authority.context = Some(context.clone());
    revalidate(&jobs, &authority).await.unwrap();
    sqlx::query("UPDATE works SET archived=1 WHERE work_key=?")
        .bind(&authority.action.work_key)
        .execute(jobs.library().pool())
        .await
        .unwrap();
    assert!(revalidate(&jobs, &authority).await.is_err());
    let version_id = uuid::Uuid::new_v4().to_string();
    install(&jobs, 37, "版本夜", 1, &version_id).await;
    install(&jobs, 38, "版本夜", 2, &version_id).await;
    assert!(
        catalog(Arc::clone(&jobs), "切换到版本夜".into(), context.clone())
            .await
            .unwrap()
            .explicit_action
            .is_none()
    );
    assert!(catalog(
        Arc::clone(&jobs),
        "切换到「版本夜 · v2」".into(),
        context.clone()
    )
    .await
    .unwrap()
    .explicit_action
    .is_some());
    sqlx::query("UPDATE packages SET state='quarantined' WHERE package_hash=?")
        .bind(&second.1)
        .execute(jobs.library().pool())
        .await
        .unwrap();
    assert!(catalog(Arc::clone(&jobs), "切换到静夜".into(), context)
        .await
        .unwrap()
        .actions
        .iter()
        .all(|action| action.package_hash != second.1));
    let committed = crate::config::Config::default();
    let mut ui = committed.clone();
    ui.lyrics.font_size = 70.;
    ui.wallpaper.enabled = true;
    let snapshot = super::super::settings_drafts::Draft::from_committed(7, &committed);
    assert_eq!(snapshot.lyrics.font_size, committed.lyrics.font_size);
    assert_ne!(snapshot.lyrics.font_size, ui.lyrics.font_size);
    assert!(!snapshot.wallpaper.enabled);
    jobs.library().pool().close().await;
}

#[test]
fn budget_projection_never_changes_or_releases_the_original_owner() {
    let ledger = budget::BudgetCoordinator::new();
    let request = budget::BudgetRequest {
        owner: budget::OwnerKind::Desktop,
        session: "owned-renderer".into(),
        generation: 77,
        task_id: "presentation".into(),
        targets: 1,
        contexts: 0,
        decoders: 0,
        transcode_slots: 0,
        decode_pixel_rate: 0,
        output_pixel_rate: 0,
        texture_upload_bytes_per_second: 0,
        cpu_bytes: 4096,
        prepare_cpu_bytes: 0,
        asset_cpu_bytes: 0,
        gpu_bytes: 2048,
        prepare_tasks: 0,
    };
    let token = ledger.grant(&request).unwrap();
    let before = ledger.usage();
    let projected = ledger.project_desktop_replacement(&[77]);
    assert_eq!(projected.usage().targets, 0);
    projected
        .check_requests(std::slice::from_ref(&request))
        .unwrap();
    assert_eq!(ledger.usage(), before);
    ledger.release(token, &request.session, 77).unwrap();
    let pending = ledger.usage();
    assert_eq!(ledger.project_desktop_replacement(&[77]).usage(), pending);
    assert_eq!(ledger.usage(), pending);
}

#[tokio::test]
async fn actual_image_video_metadata_budget_and_permission_filter_use_no_decoder() {
    use std::io::{Cursor, Write};
    let root = Root::new();
    let decodes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = Arc::clone(&decodes);
    let jobs = Arc::new(ImportJobs::start(
        Library::open(&root.0).await.unwrap(),
        AssetStore::new(&root.0).unwrap(),
        ProbeClient::testing(move |_, _| {
            observed.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Box::pin(async { Ok(()) })
        }),
    ));
    let mut native = NativeAi::new();
    let context = context(&mut native);
    let mut image_bytes = Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(32, 16, image::Rgba([38, 77, 69, 255]))
        .write_to(&mut image_bytes, image::ImageFormat::Png)
        .unwrap();
    for (index, kind, mime, bytes, permission) in [
        (0, "image", "image/png", image_bytes.into_inner(), false),
        (
            1,
            "video",
            "video/webm",
            include_bytes!("../../../../scripts/fixtures/wallpaper-vp8.webm").to_vec(),
            false,
        ),
        (2, "builtin", "", vec![], true),
    ] {
        let work_id = uuid::Uuid::new_v4().to_string();
        let title = format!("媒体-{kind}");
        let content = if kind == "builtin" {
            json!({"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{}})
        } else {
            json!({"kind":kind,"asset":"background"})
        };
        let mut manifest = json!({"formatVersion":1,"workId":work_id,"version":1,"title":title,"description":"海岸 安静","content":content,
            "assets":[],"files":[],"properties":[],"permissions":{"pointer":permission,"audioSpectrum":false},"license":{"code":"none","assets":"CC0-1.0","attribution":""}});
        if kind != "builtin" {
            manifest["assets"] = json!([{"id":"background","kind":kind,"source":"assets/background.bin","variants":[]}]);
            manifest["files"] = json!([{"path":"assets/background.bin","bytes":bytes.len(),"sha256":crate::config_journal::digest(&bytes),"mime":mime}]);
        }
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("manifest.json", options).unwrap();
        writer.write_all(manifest.to_string().as_bytes()).unwrap();
        if kind != "builtin" {
            writer.start_file("assets/background.bin", options).unwrap();
            writer.write_all(&bytes).unwrap();
        }
        install_package(
            &jobs,
            index,
            &title,
            1,
            &work_id,
            kind,
            writer.finish().unwrap().into_inner(),
        )
        .await;
    }
    let result = catalog(Arc::clone(&jobs), "媒体".into(), context)
        .await
        .unwrap();
    assert_eq!(result.actions.len(), 2);
    assert!(result
        .actions
        .iter()
        .all(|action| action.title != "媒体-builtin"));
    assert_eq!(
        decodes.load(std::sync::atomic::Ordering::Relaxed),
        0,
        "catalog must not construct a decoder or real-time preview"
    );
    jobs.library().pool().close().await;
}
