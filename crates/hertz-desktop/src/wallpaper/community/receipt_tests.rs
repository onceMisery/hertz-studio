// SPDX-License-Identifier: MIT
use super::super::test_support::*;
use hertz_wallpaper::release::{RevocationEntry, RevocationReason};

#[tokio::test]
async fn the_validated_archive_must_match_all_signed_release_fields() {
    for variant in ["exact", "hash", "bytes", "version", "permissions", "work"] {
        let fixture = Fixture::new().await;
        fixture.confirm().await;
        let (_, package, bytes) = fixture.staged(
            1,
            hertz_wallpaper::Permissions {
                audio_spectrum: false,
                pointer: false,
            },
        );
        let a = &fixture.authority;
        let mut release = a.release(1, &package.package_hash, 1).release;
        release.bytes = bytes;
        match variant {
            "hash" => release.package_hash = "a".repeat(64),
            "bytes" => release.bytes += 1,
            "version" => release.version += 1,
            "permissions" => release.permissions.pointer = true,
            "work" => release.work_id = uuid::Uuid::new_v4().to_string(),
            _ => {}
        }
        let work = release.work_id.clone();
        let signed = a.sign_release(release, 1);
        let accepted = fixture
            .library
            .trust()
            .accept(
                &a.profile.source_id,
                &a.chain(1),
                &a.revocations(1, vec![], 1),
                Some((&serde_json::to_vec(&signed).unwrap(), &work)),
            )
            .await
            .unwrap()
            .unwrap();
        if variant == "exact" {
            accepted.validate_package(&package, bytes).unwrap();
        } else {
            assert_error(
                accepted.validate_package(&package, bytes),
                "release_package_mismatch",
            );
        }
        let _root = fixture.close().await;
    }
}

#[tokio::test]
async fn release_watermarks_reject_equivocation_and_keep_historical_receipts() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let a = &fixture.authority;
    let first = a.release(1, &"a".repeat(64), 1);
    fixture.accept(&first).await;
    let conflict = a.release(1, &"b".repeat(64), 1);
    assert_error(
        fixture
            .library
            .trust()
            .accept(
                &a.profile.source_id,
                &a.chain(1),
                &a.revocations(1, vec![], 1),
                Some((&serde_json::to_vec(&conflict).unwrap(), WORK_ID)),
            )
            .await,
        "release_version_conflict",
    );
    let second = a.release(2, &"c".repeat(64), 1);
    fixture.accept(&second).await;
    assert_error(
        fixture
            .library
            .trust()
            .accept(
                &a.profile.source_id,
                &a.chain(1),
                &a.revocations(1, vec![], 1),
                Some((&serde_json::to_vec(&first).unwrap(), WORK_ID)),
            )
            .await,
        "release_version_rollback",
    );
    let retained = fixture
        .library
        .trust()
        .installed_receipt(&a.profile.source_id, &first.release.package_hash)
        .await
        .unwrap();
    assert_eq!(retained.body().version, 1);
    assert_eq!(retained.body().package_hash, first.release.package_hash);
    let _root = fixture.close().await;
}

#[tokio::test]
async fn safety_facts_commit_even_when_the_candidate_signature_is_invalid() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let a = &fixture.authority;
    let rev = a.revocations(
        1,
        vec![RevocationEntry {
            package_hash: "a".repeat(64),
            reason: RevocationReason::Security,
            effective_at: a.issued,
        }],
        1,
    );
    assert!(fixture
        .library
        .trust()
        .accept(
            &a.profile.source_id,
            &a.chain(1),
            &rev,
            Some((b"{}", WORK_ID))
        )
        .await
        .is_err());
    assert_error(
        fixture.library.trust().security_check(&"a".repeat(64)),
        "security_revoked",
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM release_watermarks")
        .fetch_one(&*fixture.library.trust().pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let source = a.profile.source_id.clone();
    let root = fixture.close().await;
    let library = crate::wallpaper::library::Library::open(root.path())
        .await
        .unwrap();
    assert!(library.trust().profile(&source).await.is_ok());
    assert_error(
        library.trust().security_check(&"a".repeat(64)),
        "security_revoked",
    );
    library.pool().close().await;
    (&*library.trust().pool).close().await;
}

#[tokio::test]
async fn new_revocation_sequence_cannot_omit_or_postpone_known_security_hashes() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let a = &fixture.authority;
    let trust = fixture.library.trust();
    let entry = RevocationEntry {
        package_hash: "a".repeat(64),
        reason: RevocationReason::Security,
        effective_at: a.issued,
    };
    trust
        .accept(
            &a.profile.source_id,
            &a.chain(1),
            &a.revocations(1, vec![entry.clone()], 1),
            None,
        )
        .await
        .unwrap();
    assert_error(
        trust
            .accept(
                &a.profile.source_id,
                &a.chain(1),
                &a.revocations(2, vec![], 1),
                None,
            )
            .await,
        "security_revocation_removed",
    );
    let mut changed = entry;
    changed.effective_at += 100;
    assert_error(
        trust
            .accept(
                &a.profile.source_id,
                &a.chain(1),
                &a.revocations(2, vec![changed], 1),
                None,
            )
            .await,
        "security_revocation_removed",
    );
    assert_error(trust.security_check(&"a".repeat(64)), "security_revoked");
    let _root = fixture.close().await;
}

#[tokio::test]
async fn expired_revocations_allow_declarative_content_but_block_new_community_web_hashes() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let a = &fixture.authority;
    let release = a.release(1, &"a".repeat(64), 1);
    let stale = a.revocations_at(1, vec![], 1, a.issued - 10000, a.issued - 9990);
    fixture
        .library
        .trust()
        .accept(
            &a.profile.source_id,
            &a.chain(1),
            &stale,
            Some((&serde_json::to_vec(&release).unwrap(), WORK_ID)),
        )
        .await
        .unwrap();
    let trust = fixture.library.trust();
    trust
        .activation_check(&release.release.package_hash, false)
        .unwrap();
    assert_error(
        trust.activation_check(&release.release.package_hash, true),
        "revocations_stale",
    );
    assert_error(
        trust
            .mark_web_activated(&release.release.package_hash)
            .await,
        "revocations_stale",
    );
    trust
        .accept(
            &a.profile.source_id,
            &a.chain(1),
            &a.revocations(2, vec![], 1),
            None,
        )
        .await
        .unwrap();
    trust
        .activation_check(&release.release.package_hash, true)
        .unwrap();
    let _root = fixture.close().await;
}

#[tokio::test]
async fn key_rotation_keeps_installed_receipts_but_never_learns_a_replacement_root() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let a = &fixture.authority;
    let first = a.release(1, &"a".repeat(64), 1);
    fixture.accept(&first).await;
    let second = a.release(2, &"b".repeat(64), 2);
    fixture
        .library
        .trust()
        .accept(
            &a.profile.source_id,
            &a.chain(2),
            &a.revocations(2, vec![], 2),
            Some((&serde_json::to_vec(&second).unwrap(), WORK_ID)),
        )
        .await
        .unwrap();
    let retained = fixture
        .library
        .trust()
        .installed_receipt(&a.profile.source_id, &first.release.package_hash)
        .await
        .unwrap();
    assert_eq!(retained.body().key_id, "release-1");
    let mut replacement: hertz_wallpaper::release::authorization::AuthorizationChain =
        serde_json::from_slice(&a.chain(2)).unwrap();
    replacement.bootstrap_root.key_id = "replacement-root".into();
    assert!(fixture
        .library
        .trust()
        .accept(
            &a.profile.source_id,
            &serde_json::to_vec(&replacement).unwrap(),
            &a.revocations(3, vec![], 2),
            None
        )
        .await
        .is_err());
    assert!(fixture
        .library
        .trust()
        .accept(
            &a.profile.source_id,
            &a.chain(1),
            &a.revocations(3, vec![], 1),
            None
        )
        .await
        .is_err());
    let _root = fixture.close().await;
}

#[tokio::test]
async fn security_revocation_blocks_a_renamed_local_import_without_deleting_installed_files() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (plan, fixed) = fixture.prepare_update(1, None).await;
    let a = &fixture.authority;
    let rev = a.revocations(
        2,
        vec![RevocationEntry {
            package_hash: fixed.package_hash.clone(),
            reason: RevocationReason::Security,
            effective_at: a.issued,
        }],
        1,
    );
    fixture
        .library
        .trust()
        .accept(&a.profile.source_id, &a.chain(1), &rev, None)
        .await
        .unwrap();
    assert_error(
        fixture
            .library
            .trust()
            .installed_receipt(&a.profile.source_id, &fixed.package_hash)
            .await,
        "security_revoked",
    );
    let original = fixture
        .assets
        .package_dir(&fixed.package_hash)
        .join("original.hwpkg");
    assert!(original.is_file());
    let renamed = fixture.root().join("renamed-local.hwpkg");
    std::fs::copy(original, &renamed).unwrap();
    let job = uuid::Uuid::new_v4().to_string();
    fixture.assets.snapshot_input(&job, &renamed, None).unwrap();
    assert_error(fixture.assets.validate_staged(&job), "security_revoked");
    assert_eq!(plan.source_id, a.profile.source_id);
    let _root = fixture.close().await;
}

#[tokio::test]
async fn copyright_revocation_blocks_new_downloads_and_preserves_installed_receipts_and_files() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let (_plan, fixed) = fixture.prepare_update(1, None).await;
    let a = &fixture.authority;
    let receipt = fixture
        .library
        .trust()
        .installed_receipt(&a.profile.source_id, &fixed.package_hash)
        .await
        .unwrap();
    let rev = a.revocations(
        2,
        vec![RevocationEntry {
            package_hash: fixed.package_hash.clone(),
            reason: RevocationReason::Copyright,
            effective_at: a.issued,
        }],
        1,
    );
    fixture
        .library
        .trust()
        .accept(&a.profile.source_id, &a.chain(1), &rev, None)
        .await
        .unwrap();
    assert_error(
        fixture
            .library
            .trust()
            .accept(
                &a.profile.source_id,
                &a.chain(1),
                &rev,
                Some((receipt.envelope_json().unwrap().as_bytes(), WORK_ID)),
            )
            .await,
        "release_revoked",
    );
    fixture
        .library
        .trust()
        .installed_receipt(&a.profile.source_id, &fixed.package_hash)
        .await
        .unwrap();
    assert!(fixture
        .assets
        .package_dir(&fixed.package_hash)
        .join("original.hwpkg")
        .is_file());
    let _root = fixture.close().await;
}
