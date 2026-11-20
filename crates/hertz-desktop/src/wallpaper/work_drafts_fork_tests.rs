// SPDX-License-Identifier: MIT
use super::*;
use crate::wallpaper::library::{tempfileish, InstallWork};
use serde_json::json;

fn builtin() -> Document {
    serde_json::from_value(
        json!({"title":"Original","sceneId":"coast","stateVersion":1,"params":{}}),
    )
    .unwrap()
}

async fn install(
    library: &Library,
    assets: &AssetStore,
    manifest: Value,
    entries: Vec<(&str, Vec<u8>)>,
) -> (String, String) {
    let id = manifest["workId"].as_str().unwrap().to_owned();
    let work = format!("local-{id}");
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("manifest.json", options).unwrap();
    zip.write_all(&serde_json::to_vec(&manifest).unwrap())
        .unwrap();
    for (path, bytes) in entries {
        zip.start_file(path, options).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    let source = assets.root().join("fork-fixture.hwpkg");
    std::fs::write(&source, &bytes).unwrap();
    let job = format!("fork-{}", uuid::Uuid::new_v4());
    assets.snapshot_input(&job, &source, None).unwrap();
    let package = assets.validate_staged(&job).unwrap();
    assets.unpack_projection(&job, &package).unwrap();
    assets
        .content_writer()
        .unwrap()
        .publish_staging(&job, &package.package_hash)
        .unwrap();
    library
        .install(&InstallWork {
            remote_work_id: id,
            work_key: work.clone(),
            title: package.manifest.title.clone(),
            description: package.manifest.description.clone(),
            kind: manifest["content"]["kind"].as_str().unwrap().into(),
            package_hash: package.package_hash.clone(),
            manifest_json: package.manifest_json,
            package_bytes: bytes.len() as u64,
            version: 1,
            source_id: "local".into(),
        })
        .await
        .unwrap();
    (work, package.package_hash)
}

async fn imported_builtin(
    library: &Library,
    assets: &AssetStore,
    code: &str,
    license: &str,
    inventory: Option<Value>,
) -> (String, String) {
    let mut manifest = serde_json::to_value(
        builtin()
            .manifest(&uuid::Uuid::new_v4().to_string(), 1)
            .unwrap(),
    )
    .unwrap();
    manifest["license"] = json!({"code":code,"assets":license,"attribution":"Original artist; change notice must remain"});
    let entries = inventory.map(|value| {
        let bytes = serde_json::to_vec(&value).unwrap();
        manifest["files"] = json!([{"path":"documents/attribution.json","bytes":bytes.len(),"sha256":format!("{:x}", Sha256::digest(&bytes)),"mime":"application/json"}]);
        vec![("documents/attribution.json", bytes)]
    }).unwrap_or_default();
    install(library, assets, manifest, entries).await
}

fn inventory(assets: &AssetStore, hash: &str) -> Value {
    let package = assets.read_installed_manifest(hash).unwrap();
    let path = package
        .manifest
        .license
        .attribution
        .strip_prefix("Attribution and asset licenses: ")
        .unwrap();
    let pin = assets
        .pin_package_entry(&package, path, &AtomicBool::new(false))
        .unwrap();
    serde_json::from_slice(&std::fs::read(&pin.path).unwrap()).unwrap()
}

async fn reimport_through_jobs(
    root: &std::path::Path,
    source: &std::path::Path,
    hash: &str,
) -> crate::wallpaper::jobs::ImportJobs {
    use crate::wallpaper::{
        decode_probe::ProbeClient,
        jobs::{ImportJobs, JobState},
    };
    let library = Library::open(root).await.unwrap();
    let assets = AssetStore::new(root).unwrap();
    let jobs = ImportJobs::start(
        library,
        assets,
        ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })),
    );
    let id = jobs
        .submit("reimport-derived-work".into(), source.into())
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let status = jobs.status(&id).unwrap();
        if matches!(
            status.state,
            JobState::Done | JobState::Failed | JobState::Cancelled
        ) {
            assert_eq!(status.state, JobState::Done, "{:?}", status.error);
            assert_eq!(status.package_hash.as_deref(), Some(hash));
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "reimport did not finish"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    jobs
}

#[tokio::test]
async fn each_inventory_placeholder_requires_its_own_complete_licensed_closure() {
    let root = tempfileish::temp_dir("fork-scoped-license-closure");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let drafts = WorkDrafts::new(&library);
    let leaf = json!({"sourcePackageHash":"a".repeat(64),"license":"CC0-1.0"});
    let leaf_id = format!("{:x}", Sha256::digest(serde_json::to_vec(&leaf).unwrap()));
    let denied_leaf = json!({"sourcePackageHash":"c".repeat(64),"license":"CC-BY-ND-4.0"});
    let denied_id = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&denied_leaf).unwrap())
    );
    for sources in [
        vec![
            leaf.clone(),
            json!({"sourcePackageHash":"b".repeat(64),"license":"LicenseRef-inventory"}),
        ],
        vec![
            leaf.clone(),
            json!({"sourcePackageHash":"b".repeat(64),"license":"LicenseRef-inventory","licenseSources":[]}),
        ],
        vec![
            leaf.clone(),
            json!({"sourcePackageHash":"b".repeat(64),"license":"LicenseRef-inventory","licenseSources":["d".repeat(64)]}),
        ],
        vec![
            leaf.clone(),
            denied_leaf,
            json!({"sourcePackageHash":"b".repeat(64),"license":"LicenseRef-inventory","licenseSources":[denied_id]}),
        ],
        vec![
            leaf.clone(),
            json!({"sourcePackageHash":"b".repeat(64),"license":"LicenseRef-inventory","licenseSources":[leaf_id],"legal":{"license":"CC-BY-ND-4.0"}}),
        ],
        vec![
            leaf.clone(),
            json!({"sourcePackageHash":"b".repeat(64),"license":"LicenseRef-inventory","licenseSources":[leaf_id],"legal":{"codeLicense":"Unknown"}}),
        ],
    ] {
        let (work, hash) = imported_builtin(&library,&assets,"none","LicenseRef-inventory",Some(json!({"kind":"hertzAttribution","formatVersion":2,"sources":sources,"inventories":[]}))).await;
        assert_eq!(
            drafts
                .fork_from_version(&work, &hash, &assets)
                .await
                .unwrap_err()
                .code,
            "derivative_license_required"
        );
    }
    let sources = vec![
        leaf,
        json!({"sourcePackageHash":"b".repeat(64),"license":"LicenseRef-inventory","codeLicense":"none","licenseSources":[leaf_id]}),
    ];
    let (work, hash) = imported_builtin(
        &library,
        &assets,
        "none",
        "LicenseRef-inventory",
        Some(
            json!({"kind":"hertzAttribution","formatVersion":2,"sources":sources,"inventories":[]}),
        ),
    )
    .await;
    let draft = drafts
        .fork_from_version(&work, &hash, &assets)
        .await
        .unwrap();
    drafts.save(&draft.id, 1).await.unwrap();
    let first = drafts.publish(&draft.id, 1, &assets).await.unwrap();
    let next = drafts
        .fork_from_version(&first.work_key, &first.package_hash, &assets)
        .await
        .unwrap();
    drafts.save(&next.id, 1).await.unwrap();
    let second = drafts.publish(&next.id, 1, &assets).await.unwrap();
    let fresh = tempfileish::temp_dir("fork-inventory-reimport");
    let jobs = reimport_through_jobs(
        fresh.path(),
        &assets
            .package_dir(&second.package_hash)
            .join("original.hwpkg"),
        &second.package_hash,
    )
    .await;
    assert_eq!(
        inventory(jobs.assets(), &second.package_hash),
        inventory(&assets, &second.package_hash)
    );
    assert!(WorkDrafts::new(jobs.library())
        .fork_from_version(&second.work_key, &second.package_hash, jobs.assets())
        .await
        .is_ok());
    assert!(jobs
        .library()
        .versions(&second.work_key)
        .await
        .unwrap()
        .iter()
        .all(|version| !version.locally_authored));
}

#[tokio::test]
async fn legal_text_documents_survive_source_deletion_reopen_and_real_reimport() {
    let root = tempfileish::temp_dir("fork-license-text");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let license = "Copyright Original Artist\r\nCC-BY-4.0\r\nKeep this attribution, including these line endings.\r\n";
    let notice = "Separate upstream notice.\n";
    let mut manifest = serde_json::to_value(
        builtin()
            .manifest(&uuid::Uuid::new_v4().to_string(), 1)
            .unwrap(),
    )
    .unwrap();
    manifest["license"] =
        json!({"code":"none","assets":"CC-BY-4.0","attribution":"See licenses/assets.txt"});
    let entries = vec![
        ("licenses/assets.txt", license.as_bytes().to_vec()),
        ("licenses/notice.txt", notice.as_bytes().to_vec()),
    ];
    manifest["files"] = json!(entries.iter().map(|(path,bytes)| json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":"text/plain"})).collect::<Vec<_>>());
    let (work, hash) = install(&library, &assets, manifest, entries).await;
    let drafts = WorkDrafts::new(&library);
    let draft = drafts
        .fork_from_version(&work, &hash, &assets)
        .await
        .unwrap();
    drafts.save(&draft.id, 1).await.unwrap();
    let published = drafts.publish(&draft.id, 1, &assets).await.unwrap();
    let plan = library.plan_deletion(&work, None).await.unwrap();
    std::fs::remove_dir_all(assets.package_dir(&hash)).unwrap();
    library.delete_rows(&plan).await.unwrap();
    let reopened = drafts
        .create_from_version(&published.work_key, &published.package_hash, &assets)
        .await
        .unwrap();
    drafts.save(&reopened.id, 1).await.unwrap();
    let second = drafts.publish(&reopened.id, 1, &assets).await.unwrap();
    let fresh = tempfileish::temp_dir("fork-license-text-reimport");
    let original_path = assets
        .package_dir(&second.package_hash)
        .join("original.hwpkg");
    let jobs = reimport_through_jobs(fresh.path(), &original_path, &second.package_hash).await;
    assert_eq!(
        std::fs::read(
            jobs.assets()
                .package_dir(&second.package_hash)
                .join("original.hwpkg")
        )
        .unwrap(),
        std::fs::read(&original_path).unwrap()
    );
    let proof = inventory(jobs.assets(), &second.package_hash);
    for (path, text) in [
        ("licenses/assets.txt", license),
        ("licenses/notice.txt", notice),
    ] {
        let document = proof["inventories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["originalPath"] == path)
            .unwrap();
        assert_eq!(document["raw"], text);
        assert_eq!(
            document["rawSha256"],
            format!("{:x}", Sha256::digest(text.as_bytes()))
        );
        assert_eq!(document["sourcePackageHash"], hash);
    }
    let final_fork = WorkDrafts::new(jobs.library())
        .fork_from_version(&second.work_key, &second.package_hash, jobs.assets())
        .await
        .unwrap();
    assert_ne!(final_fork.work_key, second.work_key);
}

#[tokio::test]
async fn missing_explicit_or_unsupported_legal_documents_fail_closed() {
    let root = tempfileish::temp_dir("fork-license-document-denials");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let drafts = WorkDrafts::new(&library);
    for (attribution, path, mime) in [
        ("See licenses/missing.txt", None, "text/plain"),
        (
            "Attribution and asset licenses: licenses/missing.json",
            None,
            "application/json",
        ),
        (
            "See licenses/opaque.bin",
            Some("licenses/opaque.bin"),
            "application/octet-stream",
        ),
        (
            "Author",
            Some("unrecognized.bin"),
            "application/octet-stream",
        ),
    ] {
        let mut manifest = serde_json::to_value(
            builtin()
                .manifest(&uuid::Uuid::new_v4().to_string(), 1)
                .unwrap(),
        )
        .unwrap();
        manifest["license"] = json!({"code":"none","assets":"CC-BY-4.0","attribution":attribution});
        let entries = path.map(|path| {
            let bytes = b"legal data".to_vec();
            manifest["files"] = json!([{"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"mime":mime}]);
            vec![(path,bytes)]
        }).unwrap_or_default();
        let (work, hash) = install(&library, &assets, manifest, entries).await;
        assert!(drafts
            .fork_from_version(&work, &hash, &assets)
            .await
            .is_err());
        assert!(library.contains_version(&work, &hash).await.unwrap());
    }
    assert_eq!(drafts.list(20, None).await.unwrap().drafts.len(), 0);
}

#[tokio::test]
async fn composition_attachments_are_preserved_or_refused_independently_of_filename() {
    let root = tempfileish::temp_dir("composition-license-attachments");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let drafts = WorkDrafts::new(&library);
    let document = serde_json::to_vec(&json!({"documentVersion":1,"canvas":{"width":640,"height":360,"colorSpace":"srgb","background":"#000000"},"nodes":[],"effects":[],"timeline":{"durationSeconds":1,"loop":true,"tracks":[]},"bindings":[]})).unwrap();
    let license = "Copyright Alice; retained exact license terms.\r\n";
    let text = "Additional legal obligation in an unrelated filename.\n";
    for (path, mime, accepted) in [
        ("license.md", "text/markdown", true),
        ("notes/third-party-policy.txt", "text/plain", true),
        ("notes/opaque.bin", "application/octet-stream", false),
    ] {
        let entries = vec![
            ("documents/main.json", document.clone()),
            (path, license.as_bytes().to_vec()),
            ("some-other-file.txt", text.as_bytes().to_vec()),
        ];
        let files = entries.iter().map(|(name,bytes)|json!({"path":name,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":if *name == "documents/main.json" {"application/json"} else if *name == path {mime} else {"text/plain"}})).collect::<Vec<_>>();
        let manifest = json!({"formatVersion":1,"workId":uuid::Uuid::new_v4().to_string(),"version":1,"title":"Alice composition","content":{"kind":"composition","document":"documents/main.json"},"assets":[],"files":files,"permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"CC-BY-4.0","attribution":format!("Copyright Alice; terms in {path}")}});
        let (work, hash) = install(&library, &assets, manifest, entries).await;
        let result = drafts.fork_from_version(&work, &hash, &assets).await;
        if !accepted {
            assert!(result.is_err());
            continue;
        }
        let draft = result.unwrap();
        drafts.save(&draft.id, 1).await.unwrap();
        let first = drafts.publish(&draft.id, 1, &assets).await.unwrap();
        let plan = library.plan_deletion(&work, None).await.unwrap();
        std::fs::remove_dir_all(assets.package_dir(&hash)).unwrap();
        library.delete_rows(&plan).await.unwrap();
        let reopened = drafts
            .create_from_version(&first.work_key, &first.package_hash, &assets)
            .await
            .unwrap();
        drafts.save(&reopened.id, 1).await.unwrap();
        let second = drafts.publish(&reopened.id, 1, &assets).await.unwrap();
        let proof = inventory(&assets, &second.package_hash);
        for (path, original) in [(path, license), ("some-other-file.txt", text)] {
            let entry = proof["inventories"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["originalPath"] == path)
                .unwrap();
            assert_eq!(entry["raw"], original);
            assert_eq!(entry["sourcePackageHash"], hash);
        }
    }
}

#[tokio::test]
async fn excessive_inventory_source_count_is_rejected_before_draft_creation() {
    let root = tempfileish::temp_dir("fork-excess-inventory-sources");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let sources = (0..8192)
        .map(|index| json!({"sourcePackageHash":format!("{index:064x}"),"license":"CC0-1.0"}))
        .collect::<Vec<_>>();
    let (work, hash) = imported_builtin(
        &library,
        &assets,
        "none",
        "LicenseRef-inventory",
        Some(
            json!({"kind":"hertzAttribution","formatVersion":2,"sources":sources,"inventories":[]}),
        ),
    )
    .await;
    let drafts = WorkDrafts::new(&library);
    assert!(drafts
        .fork_from_version(&work, &hash, &assets)
        .await
        .unwrap_err()
        .message
        .contains("4096"));
    assert!(drafts.list(20, None).await.unwrap().drafts.is_empty());
}

#[tokio::test]
async fn licensed_builtin_fork_preserves_provenance_across_publish_reopen_and_source_deletion() {
    let root = tempfileish::temp_dir("licensed-builtin-fork");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let (work, hash) = imported_builtin(
        &library,
        &assets,
        "MIT",
        "CC-BY-SA-4.0",
        Some(json!([{"license":"CC-BY-4.0","attribution":"Earlier artist"}])),
    )
    .await;
    let original = std::fs::read(assets.package_dir(&hash).join("original.hwpkg")).unwrap();
    let drafts = WorkDrafts::new(&library);
    assert_eq!(
        drafts
            .create_from_version(&work, &hash, &assets)
            .await
            .unwrap_err()
            .code,
        "work_not_editable"
    );
    let fork = drafts
        .fork_from_version(&work, &hash, &assets)
        .await
        .unwrap();
    assert_ne!(fork.work_key, work);
    assert_ne!(
        fork.work_id,
        library
            .get_work(&work)
            .await
            .unwrap()
            .unwrap()
            .remote_work_id
            .unwrap()
    );
    let pinned: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM draft_resource_references WHERE draft_id=? AND package_hash=?",
    )
    .bind(&fork.id)
    .bind(&hash)
    .fetch_one(library.pool())
    .await
    .unwrap();
    assert_eq!(pinned, 1, "even a no-asset builtin source must be pinned");
    let edited = drafts
        .update(
            &fork.id,
            1,
            vec![Update::ReplaceMetadata {
                title: "My adaptation".into(),
                description: "Edited colors".into(),
            }],
        )
        .await
        .unwrap();
    assert_eq!(edited.document.provenance, fork.document.provenance);
    drafts.save(&fork.id, edited.revision).await.unwrap();
    let first = drafts
        .publish(&fork.id, edited.revision, &assets)
        .await
        .unwrap();
    assert_eq!(
        first,
        drafts
            .publish(&fork.id, edited.revision, &assets)
            .await
            .unwrap()
    );
    assert_eq!(
        original,
        std::fs::read(assets.package_dir(&hash).join("original.hwpkg")).unwrap()
    );
    let pinned: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM draft_resource_references WHERE package_hash=?")
            .bind(&hash)
            .fetch_one(library.pool())
            .await
            .unwrap();
    assert_eq!(
        pinned, 0,
        "independent publication must release the original source"
    );
    let plan = library.plan_deletion(&work, None).await.unwrap();
    library.delete_rows(&plan).await.unwrap();
    std::fs::remove_dir_all(assets.package_dir(&hash)).unwrap();
    let reopened = drafts
        .create_from_version(&first.work_key, &first.package_hash, &assets)
        .await
        .unwrap();
    drafts.save(&reopened.id, 1).await.unwrap();
    let second = drafts.publish(&reopened.id, 1, &assets).await.unwrap();
    assert_eq!(first.work_key, second.work_key);
    assert_eq!(second.version, 2);
    let bytes = std::fs::read(
        assets
            .package_dir(&second.package_hash)
            .join("original.hwpkg"),
    )
    .unwrap();
    let exported = hertz_wallpaper::validate_package(Cursor::new(bytes)).unwrap();
    assert_eq!(exported.manifest.license.code, "MIT");
    assert_eq!(exported.manifest.license.assets, "CC-BY-SA-4.0");
    let proof = inventory(&assets, &second.package_hash);
    let text = proof.to_string();
    assert!(text.contains("Original artist") && text.contains("Earlier artist"));
    assert!(text.contains(&hash) && text.contains("CC-BY-SA-4.0") && text.contains("MIT"));
    assert_eq!(
        inventory(&assets, &first.package_hash)["inventories"],
        proof["inventories"]
    );
}

#[tokio::test]
async fn fork_denies_unknown_nd_code_and_transitive_licenses_and_forged_provenance() {
    let root = tempfileish::temp_dir("licensed-fork-denials");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let drafts = WorkDrafts::new(&library);
    for (code, license, prior) in [
        ("none", "none", None),
        ("none", "Unknown", None),
        ("none", "CC-BY-ND-4.0", None),
        ("Unrecognized", "CC0-1.0", None),
        (
            "none",
            "LicenseRef-inventory",
            Some(
                json!({"kind":"hertzAttribution","formatVersion":2,"sources":[{"license":"CC0-1.0"}],"inventories":[]}),
            ),
        ),
        (
            "LicenseRef-inventory",
            "CC0-1.0",
            Some(
                json!({"kind":"hertzAttribution","formatVersion":2,"sources":[{"license":"CC0-1.0"}],"inventories":[]}),
            ),
        ),
        (
            "none",
            "LicenseRef-inventory",
            Some(
                json!({"kind":"hertzAttribution","formatVersion":2,"sources":[{"license":"LicenseRef-inventory"}],"inventories":[]}),
            ),
        ),
        (
            "none",
            "CC-BY-4.0",
            Some(json!([{"license":"CC-BY-ND-4.0","attribution":"Earlier artist"}])),
        ),
    ] {
        let (work, hash) = imported_builtin(&library, &assets, code, license, prior).await;
        assert_eq!(
            drafts
                .fork_from_version(&work, &hash, &assets)
                .await
                .unwrap_err()
                .code,
            "derivative_license_required"
        );
        assert!(library.contains_version(&work, &hash).await.unwrap());
    }
    let (unlicensed_work, unlicensed_hash) =
        imported_builtin(&library, &assets, "none", "none", None).await;
    // Model a native authored arrangement that already used a third-party
    // unlicensed dependency: its outer authorship cannot authorize that input.
    let mut arrangement = builtin();
    arrangement.provenance = Some(Provenance {
        work_key: unlicensed_work,
        package_hash: unlicensed_hash,
    });
    let own_arrangement = drafts.create_owned(arrangement, None, None).await.unwrap();
    drafts.save(&own_arrangement.id, 1).await.unwrap();
    let own_version = drafts
        .publish(&own_arrangement.id, 1, &assets)
        .await
        .unwrap();
    assert_eq!(
        drafts
            .fork_from_version(&own_version.work_key, &own_version.package_hash, &assets)
            .await
            .unwrap_err()
            .code,
        "derivative_license_required"
    );
    drafts.discard(&own_arrangement.id, 1).await.unwrap();
    let mut forged = builtin();
    forged.provenance = Some(Provenance {
        work_key: "local-forged".into(),
        package_hash: "a".repeat(64),
    });
    assert!(drafts.create(forged.clone()).await.is_err());
    let request = json!({"protocol":2,"requestId":"fork-forged","command":"wallpaper.draft.create","payload":{"kind":"work","document":forged}});
    assert!(crate::wallpaper::api::Request::parse(request).is_err());
    assert!(serde_json::from_value::<Update>(
        json!({"kind":"replaceProvenance","provenance":null})
    )
    .is_err());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM drafts")
        .fetch_one(library.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn own_authored_copy_has_a_distinct_identity_without_inventing_a_license() {
    let root = tempfileish::temp_dir("own-work-copy");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let drafts = WorkDrafts::new(&library);
    let own = drafts.create(builtin()).await.unwrap();
    drafts.save(&own.id, 1).await.unwrap();
    let first = drafts.publish(&own.id, 1, &assets).await.unwrap();
    let copy = drafts
        .fork_from_version(&first.work_key, &first.package_hash, &assets)
        .await
        .unwrap();
    assert_ne!(copy.work_key, own.work_key);
    assert_ne!(copy.work_id, own.work_id);
    drafts.save(&copy.id, 1).await.unwrap();
    let published = drafts.publish(&copy.id, 1, &assets).await.unwrap();
    assert_eq!(published.version, 1);
    assert_eq!(
        assets
            .read_installed_manifest(&published.package_hash)
            .unwrap()
            .manifest
            .license
            .assets,
        "none"
    );
    assert_eq!(library.versions(&own.work_key).await.unwrap().len(), 1);
    assert!(
        drafts
            .fork_from_version(&published.work_key, &published.package_hash, &assets)
            .await
            .is_ok(),
        "known authored history supports another own copy"
    );
}

#[tokio::test]
async fn licensed_composition_fork_copies_variants_and_survives_restart_and_dependency_deletion() {
    use base64::Engine;
    let root = tempfileish::temp_dir("licensed-composition-fork");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==").unwrap();
    let mut encoded_variant = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        1,
        1,
        image::Rgba([40, 80, 120, 255]),
    ))
    .write_to(&mut encoded_variant, image::ImageFormat::Png)
    .unwrap();
    let variant = encoded_variant.into_inner();
    assert_ne!(png, variant);
    let scene = serde_json::to_vec(&json!({"documentVersion":1,"canvas":{"width":640,"height":360,"colorSpace":"srgb","background":"#000000"},"nodes":[{"id":"picture","type":"image","stateVersion":1,"assets":{"asset":"pixel"},"properties":{}}],"effects":[],"timeline":{"durationSeconds":1,"loop":true,"tracks":[]},"bindings":[]})).unwrap();
    let outer = serde_json::to_vec(&json!([{"license":"CC-BY-4.0","attribution":"Composition artist","priorInventory":"licenses/inner.json"}])).unwrap();
    let inner =
        serde_json::to_vec(&json!([{"license":"CC-BY-4.0","attribution":"Pixel artist"}])).unwrap();
    let entries = vec![
        ("documents/main.json", scene),
        ("assets/original.png", png.clone()),
        ("assets/preview.png", variant.clone()),
        ("documents/attribution.json", outer),
        ("licenses/inner.json", inner),
    ];
    let files = entries.iter().map(|(path, bytes)| json!({"path":path,"bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"mime":if path.ends_with(".png") {"image/png"} else {"application/json"}})).collect::<Vec<_>>();
    let source_id = uuid::Uuid::new_v4().to_string();
    let (work, hash) = install(&library, &assets, json!({"formatVersion":1,"workId":source_id,"version":1,"title":"Composition original","content":{"kind":"composition","document":"documents/main.json"},"assets":[{"id":"pixel","kind":"image","source":"assets/original.png","variants":[{"id":"preview","file":"assets/preview.png","purpose":"low","width":1,"height":1}]}],"files":files,"permissions":{"audioSpectrum":false,"pointer":false},"license":{"code":"none","assets":"CC-BY-4.0","attribution":"Original arrangement"}}), entries).await;
    let original_bytes = std::fs::read(assets.package_dir(&hash).join("original.hwpkg")).unwrap();
    let drafts = WorkDrafts::new(&library);
    let fork = drafts
        .fork_from_version(&work, &hash, &assets)
        .await
        .unwrap();
    assert_ne!(fork.work_id, source_id);
    assert_eq!(fork.document.resources.len(), 1);
    drafts.save(&fork.id, 1).await.unwrap();
    let published = drafts.publish(&fork.id, 1, &assets).await.unwrap();
    let proof = inventory(&assets, &published.package_hash);
    assert!(proof.to_string().contains("Pixel artist"));
    assert_eq!(
        original_bytes,
        std::fs::read(assets.package_dir(&hash).join("original.hwpkg")).unwrap()
    );
    let plan = library.plan_deletion(&work, None).await.unwrap();
    std::fs::remove_dir_all(assets.package_dir(&hash)).unwrap();
    library.delete_rows(&plan).await.unwrap();
    let retained = drafts.get(&fork.id).await.unwrap();
    assert_eq!(
        retained.document.provenance.as_ref().unwrap().package_hash,
        published.package_hash
    );
    library.pool().close().await;
    drop(library);
    let library = Library::open(root.path()).await.unwrap();
    let drafts = WorkDrafts::new(&library);
    let reopened = drafts
        .create_from_version(&published.work_key, &published.package_hash, &assets)
        .await
        .unwrap();
    let edited = drafts
        .update(
            &reopened.id,
            1,
            vec![Update::ReplaceMetadata {
                title: "Adaptation after restart".into(),
                description: "Source already removed".into(),
            }],
        )
        .await
        .unwrap();
    drafts.save(&edited.id, edited.revision).await.unwrap();
    let final_version = drafts
        .publish(&edited.id, edited.revision, &assets)
        .await
        .unwrap();
    let package = assets
        .read_installed_manifest(&final_version.package_hash)
        .unwrap();
    let asset = &package.manifest.assets[0];
    assert_eq!(asset.id, "pixel");
    assert_eq!(asset.variants.len(), 1);
    for (path, expected) in [(&asset.source, &png), (&asset.variants[0].file, &variant)] {
        let pin = assets
            .pin_package_entry(&package, path, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(&std::fs::read(&pin.path).unwrap(), expected);
    }
    let exported = std::fs::read(
        assets
            .package_dir(&final_version.package_hash)
            .join("original.hwpkg"),
    )
    .unwrap();
    let mut zip = zip::ZipArchive::new(Cursor::new(exported)).unwrap();
    let mut document_bytes = Vec::new();
    if let hertz_wallpaper::Content::Composition { document } = &package.manifest.content {
        zip.by_name(document)
            .unwrap()
            .read_to_end(&mut document_bytes)
            .unwrap();
    } else {
        panic!("composition kind changed");
    }
    hertz_wallpaper::document::compile_document(&document_bytes, &package.manifest).unwrap();
    let final_proof = inventory(&assets, &final_version.package_hash);
    assert_eq!(proof["inventories"], final_proof["inventories"]);
    for required in [
        "Pixel artist",
        "Composition artist",
        "Original arrangement",
        &hash,
        &source_id,
    ] {
        assert!(final_proof.to_string().contains(required));
    }
    assert_eq!(package.manifest.license.assets, "CC-BY-4.0");
    let fresh = tempfileish::temp_dir("licensed-composition-real-reimport");
    let source_path = assets
        .package_dir(&final_version.package_hash)
        .join("original.hwpkg");
    let jobs = reimport_through_jobs(fresh.path(), &source_path, &final_version.package_hash).await;
    assert_eq!(
        std::fs::read(
            jobs.assets()
                .package_dir(&final_version.package_hash)
                .join("original.hwpkg")
        )
        .unwrap(),
        std::fs::read(&source_path).unwrap()
    );
    assert_eq!(
        inventory(jobs.assets(), &final_version.package_hash),
        final_proof
    );
    let refork = WorkDrafts::new(jobs.library())
        .fork_from_version(
            &final_version.work_key,
            &final_version.package_hash,
            jobs.assets(),
        )
        .await
        .unwrap();
    assert_eq!(refork.document.resources.len(), 1);
    assert_ne!(refork.work_key, final_version.work_key);
    library.pool().close().await;
}
