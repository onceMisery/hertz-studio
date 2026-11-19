// SPDX-License-Identifier: MIT
use hertz_wallpaper::release::{KeyPurpose, RevocationEntry, RevocationReason, SignedRelease};

use super::{test_support::*, Ledger};
use crate::protocol::{Document, Request};

#[tokio::test]
async fn protected_ledger_reopens_with_exact_identity() {
    let fixture = Fixture::new();
    let ledger = fixture.open().await;
    assert_eq!(ledger.tail().position, 0);
    ledger.close().await;
    drop(ledger);
    let ledger = Ledger::open(fixture.config.clone(), None).await.unwrap();
    assert_eq!(ledger.tail().position, 0);
    assert_eq!(count(&ledger, "root_authorization").await, 1);
    ledger.close().await;
}

#[cfg(windows)]
#[test]
fn windows_acl_checks_keep_private_content_and_existing_paths_protected() {
    let fixture = Fixture::new();
    let identity = &fixture.config.service_identity;
    for rights in ["GR", "0x4"] {
        let path = fixture.directory_with_foreign_access(rights);
        assert_error(
            crate::platform::check_directory(&path, identity, true),
            "private_file_acl_required",
        );
    }
    let append_only = fixture.directory_with_foreign_access("0x4");
    let child = fixture.private_child(&append_only);
    crate::platform::check_directory(&child, identity, true).unwrap();
    for rights in ["0x2", "0x40", "WD", "WO", "GW"] {
        let ancestor = fixture.directory_with_foreign_access(rights);
        let child = fixture.private_child(&ancestor);
        assert_error(
            crate::platform::check_directory(&child, identity, true),
            "private_file_acl_required",
        );
    }
}

#[tokio::test]
async fn hub_cannot_forge_approval_or_sign_without_independent_review() {
    let fixture = Fixture::new();
    let mut ledger = fixture.open().await;
    let reviewed = approval(fixture.release(1, 'a'));
    assert_error(
        fixture.sign(&mut ledger, &reviewed).await,
        "protected_approval_required",
    );
    assert_error(
        ledger
            .handle(
                &fixture.config.hub_identity,
                Request::Approve {
                    approval: Box::new(reviewed.clone()),
                    confirmed_digest: reviewed.document.digest().unwrap(),
                },
            )
            .await,
        "approval_identity_required",
    );
    fixture.approve(&mut ledger, &reviewed).await.unwrap();
    assert_error(
        ledger
            .handle(
                &fixture.config.approver_identities[0],
                Request::SignRelease {
                    operation_id: reviewed.operation_id.clone(),
                    body_digest: reviewed.document.digest().unwrap(),
                },
            )
            .await,
        "hub_identity_required",
    );
    let response = fixture.sign(&mut ledger, &reviewed).await.unwrap();
    assert_eq!(response.state, "signed");
    let signed =
        SignedRelease::parse(&serde_json::to_vec(&response.envelope.unwrap()).unwrap()).unwrap();
    let verified = signed
        .verify(
            &ledger
                .keys
                .authorization()
                .latest_key(KeyPurpose::Release)
                .unwrap(),
        )
        .unwrap();
    assert_eq!(
        verified.canonical_digest(),
        reviewed.document.digest().unwrap()
    );
    ledger.close().await;
}

#[tokio::test]
async fn confirmation_digest_and_review_evidence_bind_the_approval() {
    let fixture = Fixture::new();
    let mut ledger = fixture.open().await;
    let mut reviewed = approval(fixture.release(1, 'a'));
    assert_error(
        ledger
            .handle(
                &fixture.config.approver_identities[0],
                Request::Approve {
                    approval: Box::new(reviewed.clone()),
                    confirmed_digest: "b".repeat(64),
                },
            )
            .await,
        "confirmation_digest_mismatch",
    );
    reviewed.evidence.static_scan_passed = false;
    assert_error(
        fixture.approve(&mut ledger, &reviewed).await,
        "review_evidence_required",
    );
    assert_eq!(count(&ledger, "approvals").await, 0);
    assert_eq!(count(&ledger, "signing_intents").await, 0);
    ledger.close().await;
}

#[tokio::test]
async fn lost_reply_and_restart_reuse_the_exact_signature_and_operation() {
    let fixture = Fixture::new();
    let mut ledger = fixture.open().await;
    let reviewed = approval(fixture.release(1, 'a'));
    fixture.approve(&mut ledger, &reviewed).await.unwrap();
    let first = fixture.sign(&mut ledger, &reviewed).await.unwrap();
    ledger.close().await;
    drop(ledger);
    let mut ledger = Ledger::open(fixture.config.clone(), None).await.unwrap();
    for response in [
        fixture.query(&mut ledger, &reviewed).await.unwrap(),
        fixture.sign(&mut ledger, &reviewed).await.unwrap(),
    ] {
        assert_eq!(response.state, "signed");
        assert_eq!(response.envelope, first.envelope);
        assert_eq!(response.body_digest, first.body_digest);
        assert_eq!(response.approval_digest, first.approval_digest);
        assert_eq!(response.operation_id, first.operation_id);
    }
    assert_eq!(ledger.tail().position, 1);
    assert_eq!(count(&ledger, "signing_intents").await, 1);
    let mut changed = reviewed.clone();
    changed.evidence.reason = "different approval".into();
    assert_error(
        fixture.approve(&mut ledger, &changed).await,
        "approval_operation_conflict",
    );
    assert_error(
        ledger
            .handle(
                &fixture.config.hub_identity,
                Request::Query {
                    operation_id: reviewed.operation_id.clone(),
                    body_digest: "b".repeat(64),
                },
            )
            .await,
        "operation_digest_conflict",
    );
    assert_error(
        ledger
            .handle(
                &fixture.config.hub_identity,
                Request::SignRevocations {
                    operation_id: reviewed.operation_id.clone(),
                    body_digest: reviewed.document.digest().unwrap(),
                },
            )
            .await,
        "signing_operation_or_purpose_conflict",
    );
    ledger.close().await;
}

#[tokio::test]
async fn revoked_approvals_remain_revoked_and_registered_approvals_are_immutable() {
    let fixture = Fixture::new();
    let mut ledger = fixture.open().await;
    let reviewed = approval(fixture.release(1, 'a'));
    fixture.approve(&mut ledger, &reviewed).await.unwrap();
    let request = || Request::RevokeApproval {
        operation_id: reviewed.operation_id.clone(),
        body_digest: reviewed.document.digest().unwrap(),
    };
    assert_error(
        ledger
            .handle(&fixture.config.approver_identities[1], request())
            .await,
        "approval_owner_or_digest_mismatch",
    );
    for _ in 0..2 {
        assert_eq!(
            ledger
                .handle(&fixture.config.approver_identities[0], request())
                .await
                .unwrap()
                .state,
            "revoked"
        );
    }
    assert_eq!(
        fixture.approve(&mut ledger, &reviewed).await.unwrap().state,
        "revoked"
    );
    assert_error(
        fixture.sign(&mut ledger, &reviewed).await,
        "approval_revoked",
    );
    let next = approval(fixture.release(1, 'b'));
    fixture.approve(&mut ledger, &next).await.unwrap();
    fixture.sign(&mut ledger, &next).await.unwrap();
    assert_error(
        ledger
            .handle(
                &fixture.config.approver_identities[0],
                Request::RevokeApproval {
                    operation_id: next.operation_id,
                    body_digest: next.document.digest().unwrap(),
                },
            )
            .await,
        "registered_approval_is_immutable",
    );
    ledger.close().await;
}

#[tokio::test]
async fn version_and_release_id_conflicts_do_not_reserve_an_intent() {
    let fixture = Fixture::new();
    let mut ledger = fixture.open().await;
    let first = approval(fixture.release(1, 'a'));
    fixture.approve(&mut ledger, &first).await.unwrap();
    fixture.sign(&mut ledger, &first).await.unwrap();
    let conflict = approval(fixture.release(1, 'b'));
    fixture.approve(&mut ledger, &conflict).await.unwrap();
    assert_error(
        fixture.sign(&mut ledger, &conflict).await,
        "release_version_not_monotonic",
    );
    let mut reused = fixture.release(2, 'c');
    if let (Document::Release(next), Document::Release(previous)) = (&mut reused, &first.document) {
        next.release_id.clone_from(&previous.release_id);
    }
    let reused = approval(reused);
    fixture.approve(&mut ledger, &reused).await.unwrap();
    assert_error(
        fixture.sign(&mut ledger, &reused).await,
        "release_identity_already_used",
    );
    assert_eq!(count(&ledger, "signing_intents").await, 1);
    assert_eq!(count(&ledger, "release_identities").await, 1);
    assert_eq!(ledger.tail().position, 1);
    let next = approval(fixture.release(2, 'd'));
    fixture.approve(&mut ledger, &next).await.unwrap();
    fixture.sign(&mut ledger, &next).await.unwrap();
    assert_eq!(ledger.tail().position, 2);
    ledger.close().await;
}

#[tokio::test]
async fn security_hashes_cannot_be_omitted_changed_or_republished() {
    let fixture = Fixture::new();
    let mut ledger = fixture.open().await;
    let effective_at = crate::protocol::now().unwrap() as u64 - 10;
    let entries = vec![
        RevocationEntry {
            package_hash: "a".repeat(64),
            reason: RevocationReason::Security,
            effective_at,
        },
        RevocationEntry {
            package_hash: "b".repeat(64),
            reason: RevocationReason::Copyright,
            effective_at,
        },
    ];
    let first = approval(fixture.revocations(1, entries.clone()));
    fixture.approve(&mut ledger, &first).await.unwrap();
    fixture.sign(&mut ledger, &first).await.unwrap();
    let omitted = approval(fixture.revocations(2, vec![]));
    fixture.approve(&mut ledger, &omitted).await.unwrap();
    assert_error(
        fixture.sign(&mut ledger, &omitted).await,
        "security_revocations_cannot_be_removed_or_changed",
    );
    let mut changed_entries = entries.clone();
    changed_entries[0].effective_at += 1;
    let changed = approval(fixture.revocations(2, changed_entries));
    fixture.approve(&mut ledger, &changed).await.unwrap();
    assert_error(
        fixture.sign(&mut ledger, &changed).await,
        "security_revocations_cannot_be_removed_or_changed",
    );
    let replay = approval(fixture.revocations(1, entries));
    fixture.approve(&mut ledger, &replay).await.unwrap();
    assert_error(
        fixture.sign(&mut ledger, &replay).await,
        "revocations_sequence_not_monotonic",
    );
    let blocked = approval(fixture.release(1, 'a'));
    fixture.approve(&mut ledger, &blocked).await.unwrap();
    assert_error(
        fixture.sign(&mut ledger, &blocked).await,
        "security_revoked_package",
    );
    assert_eq!(count(&ledger, "security_revocations").await, 1);
    assert_eq!(count(&ledger, "signing_intents").await, 1);
    let copyright = approval(fixture.release(1, 'b'));
    fixture.approve(&mut ledger, &copyright).await.unwrap();
    fixture.sign(&mut ledger, &copyright).await.unwrap();
    ledger.close().await;
}
