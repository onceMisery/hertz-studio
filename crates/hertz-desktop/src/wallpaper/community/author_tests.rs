// SPDX-License-Identifier: MIT
//! Real Library/AssetStore package preparation and native request identity checks.
use super::*;
use crate::wallpaper::community::test_support::{assert_error, Authority, Fixture, WORK_ID};
use std::sync::atomic::Ordering;

fn account(profile: &SourceProfile, subject: &str) -> super::super::auth::Account {
    super::super::auth::Account {
        source_id: profile.source_id.clone(),
        issuer: profile.auth.issuer.clone(),
        subject: subject.into(),
        expires_at: super::super::now() + 3600,
    }
}

fn permissions() -> hertz_wallpaper::Permissions {
    hertz_wallpaper::Permissions {
        audio_spectrum: false,
        pointer: false,
    }
}

#[tokio::test]
async fn installed_local_version_is_selectable_and_fixed_bytes_survive_token_renewal() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (job, package, bytes) = fixture.staged(1, permissions());
    let local = fixture.install(&job, &package, bytes, "local").await;
    // Imported community versions retain the same trusted receipt as production.
    // They must not appear among the author's local publishable packages.
    let _ = fixture.prepare_update(2, None).await;
    let (jobs, authority, root) = fixture.into_jobs();
    let auth = Auth::new().unwrap();
    let profile = &authority.profile;
    let original = auth.session_for_test(account(profile, "author-a"), "original-fixture-token");
    let list = local_packages(&jobs, None).await.unwrap();
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(list["items"][0]["workKey"], local.work_key);
    assert_eq!(list["items"][0]["packageHash"], local.package_hash);
    let draft = prepare(
        &jobs,
        &auth,
        &profile.source_id,
        &local.work_key,
        &local.package_hash,
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap();
    assert_eq!(draft.manifest.work_id, WORK_ID);
    assert_eq!(draft.bytes, bytes);
    let display = draft.display().to_string();
    assert!(!display.contains("fixture-token"));
    assert!(!display.contains(&root.path().to_string_lossy().to_string()));
    #[cfg(windows)]
    assert!(std::fs::OpenOptions::new()
        .write(true)
        .open(
            jobs.assets()
                .package_dir(&draft.hash)
                .join("original.hwpkg")
        )
        .is_err());
    let renewed = auth.session_for_test(account(profile, "author-a"), "renewed-fixture-token");
    assert!(original.same_identity(&renewed));
    assert_eq!(
        check_draft(&jobs, &auth, &draft).await.unwrap().token(),
        "renewed-fixture-token"
    );
    auth.session_for_test(account(profile, "author-b"), "another-fixture-token");
    assert_error(check_draft(&jobs, &auth, &draft).await, "account_changed");
    auth.stop();
    auth.session_for_test(account(profile, "author-a"), "returned-fixture-token");
    assert_error(check_draft(&jobs, &auth, &draft).await, "account_changed");
    drop(draft);
    drop(auth);
    jobs.library().pool().close().await;
    (*jobs.library().trust().pool).close().await;
    drop(jobs);
}

#[tokio::test]
async fn cancelled_mismatched_or_tampered_package_cannot_create_a_confirmation() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (job, package, bytes) = fixture.staged(1, permissions());
    let local = fixture.install(&job, &package, bytes, "local").await;
    let (jobs, authority, _root) = fixture.into_jobs();
    let auth = Auth::new().unwrap();
    let source = &authority.profile.source_id;
    auth.session_for_test(account(&authority.profile, "author-a"), "fixture-token");
    assert_error(
        prepare(
            &jobs,
            &auth,
            source,
            &local.work_key,
            &local.package_hash,
            Arc::new(AtomicBool::new(true)),
        )
        .await,
        "cancelled",
    );
    assert_error(
        prepare(
            &jobs,
            &auth,
            source,
            &local.work_key,
            &"0".repeat(64),
            Arc::new(AtomicBool::new(false)),
        )
        .await,
        "author_local_required",
    );
    let original_path = jobs
        .assets()
        .package_dir(&local.package_hash)
        .join("original.hwpkg");
    let mut raw = std::fs::read(&original_path).unwrap();
    raw[0] ^= 1;
    std::fs::write(&original_path, raw).unwrap();
    assert_error(
        prepare(
            &jobs,
            &auth,
            source,
            &local.work_key,
            &local.package_hash,
            Arc::new(AtomicBool::new(false)),
        )
        .await,
        "package_hash_mismatch",
    );
    drop(auth);
    jobs.library().pool().close().await;
    (*jobs.library().trust().pool).close().await;
    drop(jobs);
}

#[test]
fn every_confirmed_source_identity_field_is_preserved() {
    let original = Authority::new("https://community.example").profile;
    assert!(same_source(&original, &original));
    for change in 0..9 {
        let mut changed = original.clone();
        match change {
            0 => changed.source_id = uuid::Uuid::new_v4().to_string(),
            1 => changed.origin = "https://another.example".into(),
            2 => changed.hub_id = uuid::Uuid::new_v4().to_string(),
            3 => changed.root_fingerprint = "0".repeat(64),
            4 => changed.auth.issuer.push_str("/changed"),
            5 => changed.auth.client_id.push_str("-changed"),
            6 => changed.auth.audience.push_str("-changed"),
            7 => changed.auth.scopes.push("extra".into()),
            _ => changed.auth.algorithms = vec!["ES256".into()],
        }
        assert!(!same_source(&changed, &original), "changed field {change}");
    }
}

#[test]
fn request_session_preserves_epoch_issuer_subject_and_cancellation() {
    let auth = Auth::new().unwrap();
    let first = Authority::new("https://community.example").profile;
    let original = auth.session_for_test(account(&first, "author-a"), "first-fixture-token");
    let cancel = AtomicBool::new(false);
    net::check(&auth, &original, &cancel).unwrap();
    let other = Authority::new("https://other.example").profile;
    let other_session = auth.session_for_test(account(&other, "author-a"), "other-fixture-token");
    assert!(!original.same_identity(&other_session));
    let mut changed = account(&first, "author-a");
    changed.issuer.push_str("/changed");
    let changed = auth.session_for_test(changed, "changed-fixture-token");
    assert!(!original.same_identity(&changed));
    assert_error(net::check(&auth, &original, &cancel), "account_changed");
    let current = auth.session_for_test(account(&first, "author-a"), "current-fixture-token");
    cancel.store(true, Ordering::Release);
    assert_error(net::check(&auth, &current, &cancel), "cancelled");
    auth.stop();
    let returned = auth.session_for_test(account(&first, "author-a"), "returned-fixture-token");
    assert!(!original.same_identity(&returned));
    assert_error(auth.check_request(&original), "account_changed");
}

#[test]
fn bounded_metadata_rejects_invalid_states_ids_hashes_and_empty_report_content() {
    let valid = json!({"id":"11111111-1111-4111-8111-111111111111","workId":WORK_ID,"packageHash":"a".repeat(64),
        "expectedBytes":1234,"minEngineProtocol":1,"state":"ready","expiresAt":super::super::now()+3600,"releaseId":null});
    let upload: dto::Upload = serde_json::from_value(valid.clone()).unwrap();
    upload.validate().unwrap();
    for (key, value) in [
        ("state", json!("published")),
        ("id", json!("not-an-id")),
        ("packageHash", json!("A".repeat(64))),
        (
            "expectedBytes",
            json!(hertz_wallpaper::MAX_PACKAGE_BYTES + 1),
        ),
        ("releaseId", json!(WORK_ID)),
    ] {
        let mut altered = valid.clone();
        altered[key] = value;
        let upload: dto::Upload = serde_json::from_value(altered).unwrap();
        assert!(upload.validate().is_err(), "invalid {key}");
    }
    assert_error(dto::text(" \n ", 4000), "invalid_input");
    assert_error(dto::text(&"界".repeat(4001), 4000), "invalid_input");
    assert_error(dto::text("hidden\0control", 4000), "invalid_input");
    assert!(net::decode::<dto::Upload>(b"{malformed}").is_err());
}
