// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
use super::*;
use crate::wallpaper::library::tempfileish;

#[path = "public_properties_media_tests.rs"]
mod public_properties_media_tests;

async fn input(store: &AssetStore, library: &Library) -> DecodeInput {
    let file = store.root().join("source.webm");
    std::fs::write(
        &file,
        include_bytes!("../../../../scripts/fixtures/wallpaper-vp8.webm"),
    )
    .unwrap();
    let cancel = AtomicBool::new(false);
    let snapshot = store
        .snapshot_input("source", &file, Some(&cancel))
        .unwrap();
    super::super::raw_import::ensure_package(store, library, snapshot, "source.webm", &cancel)
        .await
        .unwrap();
    let package = store.validate_staged("source").unwrap();
    store.unpack_projection("source", &package).unwrap();
    store
        .probe_staged_media("source", &package, &cancel)
        .unwrap()
        .pop()
        .unwrap()
}

#[tokio::test]
async fn poster_validation_checks_pixels_bounds_and_identity() {
    let root = tempfileish::temp_dir("poster-validation");
    let store = AssetStore::new(root.path()).unwrap();
    let library = Library::open(root.path()).await.unwrap();
    let input = input(&store, &library).await;
    let encoded = test_frame(&input.metadata).unwrap();
    let bytes = STANDARD.decode(&encoded).unwrap();
    let expected = dimensions(input.metadata.display_width, input.metadata.display_height);
    validate(&bytes, expected).unwrap();
    assert!(validate(&bytes[..20], expected).is_err());
    assert!(validate(&bytes, (321, 1)).is_err());
    assert!(validate(&bytes, (1, 1)).is_err());
    assert!(validate(&vec![0; BYTE_LIMIT + 1], expected).is_err());
    assert!(stage(&store, "bad", &input, "x".repeat(ENCODED_LIMIT + 1)).is_err());
    assert!(stage(&store, "bad", &input, "invalid!".into()).is_err());
    assert_eq!(dimensions(1920, 1080), (320, 180));
    assert_eq!(dimensions(1080, 1920), (180, 320));
    assert_eq!(dimensions(24, 16), (24, 16));
    assert_ne!(key(&"a".repeat(64)), key(&"b".repeat(64)));
}

#[tokio::test]
async fn corrupt_poster_rebuilds_immutably_and_shares_cache_leases_and_quota() {
    let root = tempfileish::temp_dir("poster-cache");
    let store = AssetStore::new(root.path()).unwrap();
    let library = Library::open(root.path()).await.unwrap();
    let input = input(&store, &library).await;
    let probe =
        ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })).environment_for_test(|| {
            Some(super::super::probe_environment::Environment {
                browser: "test-webview2".into(),
                fingerprint: "a".repeat(64),
            })
        });
    let cancel = Arc::new(AtomicBool::new(false));
    let mut first = prepare(
        &store,
        &library,
        &probe,
        "first",
        input.clone(),
        Arc::clone(&cancel),
    )
    .await
    .unwrap()
    .unwrap();
    first.publish(&store, &library).await.unwrap();
    let old = first.directory.clone();
    let second = prepare(
        &store,
        &library,
        &probe,
        "hit",
        input.clone(),
        Arc::clone(&cancel),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(second.directory, old);
    assert_eq!(
        probe.stats(),
        (1, 1),
        "valid poster and qualification reuse the existing decoder proof"
    );
    drop(second);
    std::fs::write(old.join("poster.jpg"), b"corrupted").unwrap();
    assert!(cached(&store, &library, &input.media.entry.sha256)
        .await
        .unwrap()
        .is_none());
    let mut rebuilt = prepare(&store, &library, &probe, "rebuilt", input.clone(), cancel)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        probe.stats(),
        (1, 2),
        "a missing poster bypasses only the qualification cache"
    );
    rebuilt.publish(&store, &library).await.unwrap();
    assert_ne!(rebuilt.directory, old);
    assert!(
        old.exists(),
        "an old directory lease survives replacement of its index"
    );
    let current = rebuilt.directory.clone();
    drop(first);
    derived_cache::Writer::acquire(&store)
        .unwrap()
        .reclaim(&library, 0, derived_cache::CAP)
        .await
        .unwrap();
    assert!(!old.exists());
    assert!(current.exists());
    let mut wrong: serde_json::Value =
        serde_json::from_slice(&std::fs::read(current.join("receipt.json")).unwrap()).unwrap();
    wrong["inputHash"] = serde_json::json!("b".repeat(64));
    std::fs::write(
        current.join("receipt.json"),
        serde_json::to_vec(&wrong).unwrap(),
    )
    .unwrap();
    assert!(cached(&store, &library, &input.media.entry.sha256)
        .await
        .unwrap()
        .is_none());
    assert!(
        derived_cache::Writer::acquire(&store)
            .unwrap()
            .reclaim(&library, 0, 0)
            .await
            .is_err(),
        "a lease prevents quota eviction"
    );
    drop(rebuilt);
    assert_eq!(
        derived_cache::Writer::acquire(&store)
            .unwrap()
            .reclaim(&library, 0, 0)
            .await
            .unwrap()
            .bytes,
        0
    );
}

#[tokio::test]
async fn cancellation_and_decode_failure_never_publish_a_cover() {
    let root = tempfileish::temp_dir("poster-cancel");
    let store = AssetStore::new(root.path()).unwrap();
    let library = Library::open(root.path()).await.unwrap();
    let input = input(&store, &library).await;
    let probe = ProbeClient::testing(|_, cancel| {
        Box::pin(async move {
            cancel.store(true, Ordering::Release);
            Ok(())
        })
    });
    let error = prepare(
        &store,
        &library,
        &probe,
        "cancelled",
        input.clone(),
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.code, "cancelled");
    let probe = ProbeClient::testing(|_, _| {
        Box::pin(async { Err(JobError::new("decode_failed", "test failure")) })
    });
    let error = prepare(
        &store,
        &library,
        &probe,
        "failed",
        input,
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.code, "decode_failed");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM derived_entries")
        .fetch_one(library.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(!store.staging_dir("cancelled").exists());
    assert!(!store.staging_dir("failed").exists());
}

#[tokio::test]
async fn presentation_poster_pins_verified_pixels_and_charges_only_an_image() {
    use crate::wallpaper::{
        image_prepare::{ImageFit, ImagePurpose, ImageTarget},
        target_planner::AssetRef,
    };
    let root = tempfileish::temp_dir("poster-presentation");
    let store = AssetStore::new(root.path()).unwrap();
    let library = Library::open(root.path()).await.unwrap();
    let input = input(&store, &library).await;
    let reference = AssetRef {
        package_hash: input.package_hash.clone(),
        asset_id: "video".into(),
        variant_id: None,
    };
    let target = ImageTarget {
        width: 1920,
        height: 1080,
        fit: ImageFit::Contain,
        purpose: ImagePurpose::High,
    };
    assert!(
        resolve_for_media(&store, &library, &reference, &input, target)
            .await
            .unwrap()
            .is_none()
    );
    let mut prepared = stage(
        &store,
        "poster",
        &input,
        test_frame(&input.metadata).unwrap(),
    )
    .unwrap();
    prepared.publish(&store, &library).await.unwrap();
    let resolved = resolve_for_media(&store, &library, &reference, &input, target)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        resolved.input().media.entry.mime.as_deref(),
        Some("image/jpeg")
    );
    assert_eq!(
        (
            resolved.input().metadata.display_width,
            resolved.input().metadata.display_height
        ),
        (64, 48)
    );
    assert!(
        resolved.poster().is_none(),
        "an image failure cannot start another fallback"
    );
    let request = resolved.budget_request("desktop-poster".into(), 2).unwrap();
    assert_eq!(
        (request.decoders, request.contexts, request.prepare_tasks),
        (0, 0, 0)
    );
    assert_eq!(
        (request.decode_pixel_rate, request.output_pixel_rate),
        (0, 0)
    );
    assert!(request.cpu_bytes > 0 && request.gpu_bytes > 0);
    assert!(std::fs::write(prepared.directory.join("poster.jpg"), b"tampered").is_err());
    drop(prepared);
    assert!(derived_cache::Writer::acquire(&store)
        .unwrap()
        .reclaim(&library, 0, 0)
        .await
        .is_err());
    let changed = resolved
        .retarget_static_image(ImageTarget {
            width: 1280,
            height: 720,
            ..target
        })
        .unwrap();
    assert_eq!(changed.target().width, 1280);
    drop(changed);
    assert_eq!(
        derived_cache::Writer::acquire(&store)
            .unwrap()
            .reclaim(&library, 0, 0)
            .await
            .unwrap()
            .bytes,
        0
    );
}

#[tokio::test]
async fn failed_selection_retains_only_a_verified_recorded_cover_and_recovers_restored_bytes() {
    use crate::wallpaper::{
        image_prepare::{ImageFit, ImagePurpose, ImageTarget},
        jobs::ImportJobs,
        selection_plan,
    };
    let root = tempfileish::temp_dir("poster-unavailable");
    let store = AssetStore::new(root.path()).unwrap();
    let library = Library::open(root.path()).await.unwrap();
    let source = input(&store, &library).await;
    let mut prepared = stage(
        &store,
        "poster",
        &source,
        test_frame(&source.metadata).unwrap(),
    )
    .unwrap();
    prepared.publish(&store, &library).await.unwrap();
    let poster_file = prepared.directory.join("poster.jpg");
    let package = store.validate_staged("source").unwrap();
    let request = selection_plan::Request {
        work_key: format!("local-{}", package.manifest.work_id),
        package_hash: package.package_hash.clone(),
        properties: Default::default(),
        target: ImageTarget {
            width: 1920,
            height: 1080,
            fit: ImageFit::Contain,
            purpose: ImagePurpose::High,
        },
    };
    drop(source);
    drop(prepared);
    store
        .content_writer()
        .unwrap()
        .publish_staging("source", &package.package_hash)
        .unwrap();
    library
        .install(&crate::wallpaper::library::InstallWork {
            remote_work_id: package.manifest.work_id.clone(),
            work_key: request.work_key.clone(),
            title: package.manifest.title.clone(),
            description: String::new(),
            kind: "video".into(),
            package_hash: package.package_hash.clone(),
            manifest_json: package.manifest_json.clone(),
            package_bytes: store.installed_bytes(&package.package_hash).unwrap(),
            version: package.manifest.version,
            source_id: crate::wallpaper::library::LOCAL_SOURCE.into(),
        })
        .await
        .unwrap();
    let fail_decode = Arc::new(AtomicBool::new(false));
    let fake_fail = Arc::clone(&fail_decode);
    let probe = ProbeClient::testing(move |_, _| {
        let failed = fake_fail.load(Ordering::Acquire);
        Box::pin(async move {
            if failed {
                Err(JobError::new("decode_failed", "device rejected video"))
            } else {
                Ok(())
            }
        })
    });
    let jobs = Arc::new(ImportJobs::start(library, store, probe));
    let cancel = Arc::new(AtomicBool::new(false));
    let original = jobs
        .assets()
        .package_dir(&request.package_hash)
        .join("original.hwpkg");
    let held = root.path().join("held.hwpkg");
    std::fs::rename(&original, &held).unwrap();
    let failure = selection_plan::resolve(Arc::clone(&jobs), request.clone(), Arc::clone(&cancel))
        .await
        .err()
        .unwrap();
    assert_eq!(failure.error.code, "asset_unavailable");
    let cover = failure.poster.unwrap();
    assert_eq!(
        cover.input().media.entry.mime.as_deref(),
        Some("image/jpeg")
    );
    assert!(!jobs
        .library()
        .contains_version(&request.work_key, &request.package_hash)
        .await
        .unwrap());
    assert!(read(
        jobs.assets(),
        jobs.library(),
        &request.work_key,
        &request.package_hash
    )
    .await
    .unwrap()
    .is_some());
    // Independent cover pins must allow repair of the original while the image is shown.
    std::fs::rename(&held, &original).unwrap();
    let denied = selection_plan::resolve(
        Arc::clone(&jobs),
        selection_plan::Request {
            work_key: "unrelated".into(),
            ..request.clone()
        },
        Arc::clone(&cancel),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(denied.error.code, "version_not_found");
    assert!(denied.poster.is_none());
    let cancelled = selection_plan::resolve(
        Arc::clone(&jobs),
        request.clone(),
        Arc::new(AtomicBool::new(true)),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(cancelled.error.code, "cancelled");
    assert!(cancelled.poster.is_none());
    fail_decode.store(true, Ordering::Release);
    let failure = selection_plan::resolve(Arc::clone(&jobs), request.clone(), Arc::clone(&cancel))
        .await
        .err()
        .unwrap();
    assert_eq!(failure.error.code, "prepare_failed");
    assert!(failure.poster.is_some());
    drop(failure);
    drop(cover);
    fail_decode.store(false, Ordering::Release);
    let selection_plan::ResolvedSelection::Media(media) =
        selection_plan::resolve(Arc::clone(&jobs), request.clone(), Arc::clone(&cancel))
            .await
            .unwrap()
    else {
        panic!("video work must resolve as media");
    };
    assert_ne!(
        media.input().metadata.container,
        crate::wallpaper::media::Container::Image
    );
    assert!(media.poster().is_some());
    assert!(jobs
        .library()
        .contains_version(&request.work_key, &request.package_hash)
        .await
        .unwrap());
    drop(media);
    std::fs::rename(&original, &held).unwrap();
    std::fs::write(&poster_file, b"corrupted cover").unwrap();
    let failure = selection_plan::resolve(Arc::clone(&jobs), request.clone(), Arc::clone(&cancel))
        .await
        .err()
        .unwrap();
    assert_eq!(failure.error.code, "asset_unavailable");
    assert!(failure.poster.is_none());
    let deletion = jobs
        .library()
        .plan_deletion(&request.work_key, None)
        .await
        .unwrap();
    jobs.library().delete_rows(&deletion).await.unwrap();
    let failure = selection_plan::resolve(jobs, request, cancel)
        .await
        .err()
        .unwrap();
    assert_eq!(failure.error.code, "version_not_found");
    assert!(failure.poster.is_none());
}
