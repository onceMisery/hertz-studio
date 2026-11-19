// SPDX-License-Identifier: MIT
use super::super::test_support::*;
use super::*;

struct Attempt {
    request: String,
    digest: String,
    revision: u64,
}
impl Attempt {
    fn new(binding: &Binding) -> Self {
        Self {
            request: uuid::Uuid::new_v4().to_string(),
            digest: "3".repeat(64),
            revision: binding.config_revision + 1,
        }
    }
    fn identity<'a>(&'a self, operation: &'a str) -> ApplyIdentity<'a> {
        ApplyIdentity {
            operation_id: operation,
            request_id: &self.request,
            config_digest: &self.digest,
            revision: self.revision,
        }
    }
    fn plan<'a>(
        &'a self,
        download: &'a DownloadPlan,
        binding: &'a Binding,
        candidate: &'a FixedVersion,
        rollback: bool,
        automatic: bool,
    ) -> ApplyPlan<'a> {
        ApplyPlan {
            identity: self.identity(&download.operation_id),
            subscription_id: &download.subscription_id,
            binding,
            candidate,
            rollback,
            confirmed: !automatic,
            automatic,
        }
    }
    fn receipt(&self, fixture: &Fixture, saved: bool) {
        config_receipt(
            fixture.root(),
            &self.request,
            &self.digest,
            self.revision,
            "wallpaper.community.apply",
            saved,
        );
    }
}

async fn apply(fixture: &Fixture, download: &DownloadPlan, candidate: &FixedVersion) -> Attempt {
    let attempt = Attempt::new(&download.binding);
    let subs = Subscriptions::new(&fixture.library);
    subs.stage_apply(attempt.plan(download, &download.binding, candidate, false, false))
        .await
        .unwrap();
    attempt.receipt(fixture, true);
    subs.reconcile_apply().await.unwrap();
    attempt
}

#[tokio::test]
async fn unknown_config_operation_is_not_settled_or_overwritten_by_a_new_intent() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (download, candidate) = fixture.prepare_update(1, None).await;
    let subs = Subscriptions::new(&fixture.library);
    let first = Attempt::new(&download.binding);
    subs.stage_apply(first.plan(&download, &download.binding, &candidate, false, false))
        .await
        .unwrap();
    subs.reconcile_apply().await.unwrap();
    subs.fail(&download.operation_id, "download failed later")
        .await
        .unwrap();
    subs.stale(&download.operation_id, "later selection")
        .await
        .unwrap();
    assert_eq!(
        subs.update(&download.operation_id).await.unwrap().state,
        "apply_requested"
    );
    let second = Attempt::new(&download.binding);
    assert_error(
        subs.stage_apply(second.plan(&download, &download.binding, &candidate, false, false))
            .await,
        "update_state_conflict",
    );
    assert_eq!(
        subs.update(&download.operation_id)
            .await
            .unwrap()
            .apply_request_id
            .as_deref(),
        Some(first.request.as_str())
    );
    let _root = fixture.close().await;
}

#[tokio::test]
async fn original_committed_config_receipt_is_required_for_applied_projection() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (download, candidate) = fixture.prepare_update(1, None).await;
    let attempt = apply(&fixture, &download, &candidate).await;
    let subs = Subscriptions::new(&fixture.library);
    let update = subs.update(&download.operation_id).await.unwrap();
    assert_eq!(update.state, "applied");
    assert_eq!(update.apply_config_revision, Some(attempt.revision as i64));
    assert_eq!(
        subs.get(&download.subscription_id)
            .await
            .unwrap()
            .current_hash
            .as_deref(),
        Some(candidate.package_hash.as_str())
    );
    let _root = fixture.close().await;
}

#[tokio::test]
async fn mismatched_config_digest_revision_or_command_cannot_settle_the_original_update() {
    for variant in ["digest", "revision", "command"] {
        let wrong_digest = "4".repeat(64);
        let fixture = Fixture::new().await;
        fixture.confirm().await;
        let (download, candidate) = fixture.prepare_update(1, None).await;
        let subs = Subscriptions::new(&fixture.library);
        let attempt = Attempt::new(&download.binding);
        subs.stage_apply(attempt.plan(&download, &download.binding, &candidate, false, false))
            .await
            .unwrap();
        config_receipt(
            fixture.root(),
            &attempt.request,
            if variant == "digest" {
                &wrong_digest
            } else {
                &attempt.digest
            },
            attempt.revision + u64::from(variant == "revision"),
            if variant == "command" {
                "wallpaper.apply"
            } else {
                "wallpaper.community.apply"
            },
            true,
        );
        subs.reconcile_apply().await.unwrap();
        assert_eq!(
            subs.update(&download.operation_id).await.unwrap().state,
            "apply_requested",
            "{variant}"
        );
        assert!(subs
            .get(&download.subscription_id)
            .await
            .unwrap()
            .current_hash
            .is_none());
        let _root = fixture.close().await;
    }
}

#[tokio::test]
async fn explicitly_uncommitted_config_keeps_the_installed_candidate_and_failure_fact() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (download, candidate) = fixture.prepare_update(1, None).await;
    let subs = Subscriptions::new(&fixture.library);
    let attempt = Attempt::new(&download.binding);
    subs.stage_apply(attempt.plan(&download, &download.binding, &candidate, false, false))
        .await
        .unwrap();
    attempt.receipt(&fixture, false);
    subs.reconcile_apply().await.unwrap();
    let failed = subs.update(&download.operation_id).await.unwrap();
    assert_eq!(failed.state, "failed");
    assert!(failed.error.is_some());
    assert!(subs
        .get(&download.subscription_id)
        .await
        .unwrap()
        .current_hash
        .is_none());
    assert!(fixture.assets.package_dir(&candidate.package_hash).is_dir());
    let _root = fixture.close().await;
}

#[tokio::test]
async fn apply_journal_and_subscription_projection_commit_or_roll_back_together() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (download, candidate) = fixture.prepare_update(1, None).await;
    let subs = Subscriptions::new(&fixture.library);
    let attempt = Attempt::new(&download.binding);
    subs.stage_apply(attempt.plan(&download, &download.binding, &candidate, false, false))
        .await
        .unwrap();
    attempt.receipt(&fixture, true);
    sqlx::raw_sql("CREATE TRIGGER interrupt_projection BEFORE UPDATE OF current_hash ON community_subscriptions BEGIN SELECT RAISE(ABORT,'fixture interruption'); END").execute(fixture.library.pool()).await.unwrap();
    assert!(subs.reconcile_apply().await.is_err());
    assert_eq!(
        subs.update(&download.operation_id).await.unwrap().state,
        "apply_requested"
    );
    assert!(subs
        .get(&download.subscription_id)
        .await
        .unwrap()
        .current_hash
        .is_none());
    sqlx::raw_sql("DROP TRIGGER interrupt_projection")
        .execute(fixture.library.pool())
        .await
        .unwrap();
    subs.reconcile_apply().await.unwrap();
    assert_eq!(
        subs.update(&download.operation_id).await.unwrap().state,
        "applied"
    );
    let _root = fixture.close().await;
}

#[tokio::test]
async fn a_late_error_on_an_older_apply_does_not_reproject_the_newer_selection() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (first_download, first) = fixture.prepare_update(1, None).await;
    let first_attempt = apply(&fixture, &first_download, &first).await;
    let (second_download, second) = fixture.prepare_update(2, Some(first.clone())).await;
    apply(&fixture, &second_download, &second).await;
    let subs = Subscriptions::new(&fixture.library);
    subs.finish_apply(
        first_attempt.identity(&first_download.operation_id),
        true,
        Some("late preparation failure".into()),
    )
    .await
    .unwrap();
    subs.finish_apply(
        first_attempt.identity(&first_download.operation_id),
        true,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        subs.get(&second_download.subscription_id)
            .await
            .unwrap()
            .current_hash
            .as_deref(),
        Some(second.package_hash.as_str())
    );
    let original = subs.update(&first_download.operation_id).await.unwrap();
    assert_eq!(original.state, "applied");
    assert_eq!(original.error.as_deref(), Some("late preparation failure"));
    let _root = fixture.close().await;
}

#[tokio::test]
async fn explicit_rollback_uses_a_new_request_and_revision_without_lowering_trust() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (first_download, first) = fixture.prepare_update(1, None).await;
    apply(&fixture, &first_download, &first).await;
    let (download, second) = fixture.prepare_update(2, Some(first.clone())).await;
    let applied = apply(&fixture, &download, &second).await;
    let subs = Subscriptions::new(&fixture.library);
    let row = subs.update(&download.operation_id).await.unwrap();
    assert!(row.rollback_available);
    assert_eq!(
        row.target_version(&subs.get(&download.subscription_id).await.unwrap(), true)
            .unwrap(),
        first
    );
    let mut current = download.binding.clone();
    current.config_revision = applied.revision;
    let rollback = Attempt::new(&current);
    subs.stage_apply(rollback.plan(&download, &current, &first, true, false))
        .await
        .unwrap();
    assert!(rollback.revision > applied.revision);
    assert_ne!(rollback.request, applied.request);
    rollback.receipt(&fixture, true);
    subs.reconcile_apply().await.unwrap();
    let result = subs.get(&download.subscription_id).await.unwrap();
    assert_eq!(
        result.current_hash.as_deref(),
        Some(first.package_hash.as_str())
    );
    assert_eq!(
        result.previous_hash.as_deref(),
        Some(second.package_hash.as_str())
    );
    assert_error(
        subs.finish_apply(
            applied.identity(&download.operation_id),
            true,
            Some("old reply".into()),
        )
        .await,
        "update_state_conflict",
    );
    let old = fixture
        .library
        .trust()
        .installed_receipt(&download.source_id, &first.package_hash)
        .await
        .unwrap()
        .envelope_json()
        .unwrap();
    assert_error(
        fixture
            .library
            .trust()
            .accept(
                &download.source_id,
                &fixture.authority.chain(1),
                &fixture.authority.revocations(1, vec![], 1),
                Some((old.as_bytes(), WORK_ID)),
            )
            .await,
        "release_version_rollback",
    );
    let _root = fixture.close().await;
}

#[tokio::test]
async fn known_security_revocation_disables_rollback_but_preserves_the_old_installed_files() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (first_download, first) = fixture.prepare_update(1, None).await;
    apply(&fixture, &first_download, &first).await;
    let (download, second) = fixture.prepare_update(2, Some(first.clone())).await;
    let applied = apply(&fixture, &download, &second).await;
    let a = &fixture.authority;
    let rev = a.revocations(
        2,
        vec![hertz_wallpaper::release::RevocationEntry {
            package_hash: first.package_hash.clone(),
            reason: hertz_wallpaper::release::RevocationReason::Security,
            effective_at: a.issued,
        }],
        1,
    );
    fixture
        .library
        .trust()
        .accept(&download.source_id, &a.chain(1), &rev, None)
        .await
        .unwrap();
    let subs = Subscriptions::new(&fixture.library);
    let mut current = download.binding.clone();
    current.config_revision = applied.revision;
    let rollback = Attempt::new(&current);
    assert!(
        !subs
            .update(&download.operation_id)
            .await
            .unwrap()
            .rollback_available
    );
    assert_error(
        subs.stage_apply(rollback.plan(&download, &current, &first, true, false))
            .await,
        "rollback_unavailable",
    );
    assert!(fixture
        .assets
        .package_dir(&first.package_hash)
        .join("original.hwpkg")
        .is_file());
    let _root = fixture.close().await;
}

#[tokio::test]
async fn automatic_apply_rejects_changed_selection_topology_revision_and_subscription_policy() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (first_download, first) = fixture.prepare_update(1, None).await;
    let subs = Subscriptions::new(&fixture.library);
    let sub = subs.get(&first_download.subscription_id).await.unwrap();
    subs.policy(&sub.subscription_id, sub.revision, "cutpoint", true)
        .await
        .unwrap();
    let (download, candidate) = fixture.prepare_update(2, Some(first)).await;
    assert_eq!(
        subs.update(&download.operation_id).await.unwrap().state,
        "ready"
    );
    for variant in ["selection", "topology", "revision", "group"] {
        let mut changed = download.binding.clone();
        match variant {
            "selection" => changed.selection_json = "{\"manual\":true}".into(),
            "topology" => changed.topology_digest = "5".repeat(64),
            "revision" => changed.config_revision += 1,
            _ => changed.group_id = "other-group".into(),
        }
        let attempt = Attempt::new(&changed);
        assert_error(
            subs.stage_apply(attempt.plan(&download, &changed, &candidate, false, true))
                .await,
            "update_state_conflict",
        );
    }
    let sub = subs.get(&download.subscription_id).await.unwrap();
    subs.policy(&sub.subscription_id, sub.revision, "startup", false)
        .await
        .unwrap();
    let attempt = Attempt::new(&download.binding);
    assert_error(
        subs.stage_apply(attempt.plan(&download, &download.binding, &candidate, false, true))
            .await,
        "subscription_conflict",
    );
    assert!(fixture.assets.package_dir(&candidate.package_hash).is_dir());
    let _root = fixture.close().await;
}
