// SPDX-License-Identifier: MIT
use super::super::test_support::*;

#[tokio::test]
async fn permission_expansion_requires_confirmation_after_validated_installation() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (plan, previous) = fixture.prepare_update(1, None).await;
    let (_, package, bytes) = fixture.staged(
        2,
        hertz_wallpaper::Permissions {
            audio_spectrum: true,
            pointer: true,
        },
    );
    let mut release = fixture
        .authority
        .release(2, &package.package_hash, 1)
        .release;
    release.bytes = bytes;
    release.permissions = package.manifest.permissions.clone();
    let accepted = fixture
        .accept(&fixture.authority.sign_release(release, 1))
        .await;
    accepted.validate_package(&package, bytes).unwrap();
    let delta = Subscriptions::new(&fixture.library)
        .difference(
            &binding(plan.binding.subscription_revision, Some(previous)),
            &package,
            Some(&accepted),
        )
        .await
        .unwrap();
    assert_eq!(delta["permissionsAdded"]["audioSpectrum"], true);
    assert_eq!(delta["permissionsAdded"]["pointer"], true);
    assert_eq!(delta["requiresConfirmation"], true);
    assert_eq!(delta["protocolChanged"], false);
    let _root = fixture.close().await;
}
use super::*;

#[tokio::test]
async fn subscriptions_are_idempotent_and_isolate_the_same_work_uuid_by_source() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let other = Authority::new("https://second-community.example");
    fixture
        .library
        .trust()
        .confirm_source(
            &other.profile,
            &other.chain(1),
            &other.profile.root_fingerprint,
        )
        .await
        .unwrap();
    let subs = Subscriptions::new(&fixture.library);
    let first = subs
        .subscribe(&fixture.authority.profile.source_id, WORK_ID)
        .await
        .unwrap();
    let repeated = subs
        .subscribe(&fixture.authority.profile.source_id, WORK_ID)
        .await
        .unwrap();
    let second = subs
        .subscribe(&other.profile.source_id, WORK_ID)
        .await
        .unwrap();
    assert_eq!(first.subscription_id, repeated.subscription_id);
    assert_ne!(first.subscription_id, second.subscription_id);
    assert_eq!(first.policy, "prompt");
    assert_eq!(subs.list().await.unwrap().len(), 2);
    let mut forged = fixture.authority.profile.clone();
    forged.origin = other.profile.origin;
    assert_error(subs.project_source(&forged).await, "source_conflict");
    let _root = fixture.close().await;
}

#[tokio::test]
async fn subscription_policy_uses_cas_and_fences_old_or_disabled_download_bindings() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let subs = Subscriptions::new(&fixture.library);
    let first = subs
        .subscribe(&fixture.authority.profile.source_id, WORK_ID)
        .await
        .unwrap();
    let mut plan = DownloadPlan {
        operation_id: uuid::Uuid::new_v4().to_string(),
        request_id: uuid::Uuid::new_v4().to_string(),
        subscription_id: first.subscription_id.clone(),
        source_id: first.source_id,
        remote_work_id: first.remote_work_id,
        binding: binding(first.revision, None),
    };
    let disabled = subs
        .policy(&first.subscription_id, first.revision, "cutpoint", false)
        .await
        .unwrap();
    assert_error(
        subs.policy(&first.subscription_id, first.revision, "startup", true)
            .await,
        "subscription_conflict",
    );
    assert_error(
        subs.register(&plan, "download-job", &"a".repeat(64)).await,
        "subscription_conflict",
    );
    plan.binding.subscription_revision = disabled.revision;
    assert_error(
        subs.register(&plan, "download-job", &"a".repeat(64)).await,
        "subscription_conflict",
    );
    let enabled = subs
        .policy(&first.subscription_id, disabled.revision, "cutpoint", true)
        .await
        .unwrap();
    plan.binding.subscription_revision = enabled.revision;
    assert_eq!(
        subs.register(&plan, "download-job", &"a".repeat(64))
            .await
            .unwrap()
            .state,
        "queued"
    );
    let _root = fixture.close().await;
}

#[tokio::test]
async fn repeated_download_request_returns_its_original_job_and_conflicting_digest_is_rejected() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (plan, _) = fixture.prepare_update(1, None).await;
    let subs = Subscriptions::new(&fixture.library);
    let first = subs.update(&plan.operation_id).await.unwrap();
    let repeated = subs
        .register(
            &plan,
            "different-job",
            &hash(&serde_json::to_vec(&plan).unwrap()),
        )
        .await
        .unwrap();
    assert_eq!(repeated.job_id, first.job_id);
    assert_eq!(repeated.operation_id, first.operation_id);
    assert_eq!(repeated.state, first.state);
    assert_error(
        subs.register(&plan, "different-job", &"b".repeat(64)).await,
        "request_id_conflict",
    );
    let _root = fixture.close().await;
}

#[tokio::test]
async fn immutable_installation_is_not_an_applied_config_and_download_recovery_keeps_the_candidate()
{
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (plan, fixed) = fixture.prepare_update(1, None).await;
    let subs = Subscriptions::new(&fixture.library);
    let installed = subs.update(&plan.operation_id).await.unwrap();
    assert_eq!(installed.state, "awaiting_confirmation");
    assert!(installed.apply_request_id.is_none());
    assert!(subs
        .get(&plan.subscription_id)
        .await
        .unwrap()
        .current_hash
        .is_none());
    assert!(fixture
        .assets
        .package_dir(&fixed.package_hash)
        .join("original.hwpkg")
        .is_file());
    subs.reconcile_apply().await.unwrap();
    assert_eq!(
        subs.update(&plan.operation_id).await.unwrap().state,
        "awaiting_confirmation"
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM versions WHERE package_hash=?1")
        .bind(&fixed.package_hash)
        .fetch_one(fixture.library.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
    let _root = fixture.close().await;
}

#[tokio::test]
async fn restoring_the_product_library_does_not_restore_old_trust_watermarks() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let backup = fixture.root().join("wallpaper-backup.db");
    sqlx::query("VACUUM INTO ?1")
        .bind(backup.to_str().unwrap())
        .execute(fixture.library.pool())
        .await
        .unwrap();
    let (_, first) = fixture.prepare_update(1, None).await;
    let (_, second) = fixture.prepare_update(2, Some(first.clone())).await;
    let profile = fixture.authority.profile.clone();
    let chain = fixture.authority.chain(1);
    let rev = fixture.authority.revocations(1, vec![], 1);
    let old = fixture
        .library
        .trust()
        .installed_receipt(&profile.source_id, &first.package_hash)
        .await
        .unwrap()
        .envelope_json()
        .unwrap();
    let root = fixture.close().await;
    std::fs::copy(&backup, root.path().join("wallpaper.db")).unwrap();
    let library = Library::open(root.path()).await.unwrap();
    assert!(Subscriptions::new(&library)
        .list()
        .await
        .unwrap()
        .is_empty());
    library
        .trust()
        .installed_receipt(&profile.source_id, &second.package_hash)
        .await
        .unwrap();
    assert_error(
        library
            .trust()
            .accept(
                &profile.source_id,
                &chain,
                &rev,
                Some((old.as_bytes(), WORK_ID)),
            )
            .await,
        "release_version_rollback",
    );
    library.pool().close().await;
    (&*library.trust().pool).close().await;
}
