// SPDX-License-Identifier: MIT
use super::super::test_support::*;
use super::TrustStore;
use hertz_wallpaper::release::{RevocationEntry, RevocationReason};

#[tokio::test]
async fn an_existing_library_does_not_block_a_second_verified_trust_connection() {
    use crate::wallpaper::library::Library;

    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let second = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        Library::open(fixture.root()),
    )
    .await
    .expect("an existing pool must not be mistaken for the inspection worker")
    .unwrap();
    let source = second
        .trust()
        .profile(&fixture.authority.profile.source_id)
        .await
        .unwrap();
    assert_eq!(
        source.root_fingerprint,
        fixture.authority.profile.root_fingerprint
    );
    assert_eq!(source.origin, fixture.authority.profile.origin);
    second.pool().close().await;
    (&*second.trust().pool).close().await;
    drop(second);
    let _root = fixture.close().await;
}

#[tokio::test]
async fn concurrent_identity_inspection_still_rejects_the_wrong_database_schema() {
    use crate::wallpaper::library::Library;

    let fixture = Fixture::new().await;
    sqlx::query("PRAGMA user_version=99")
        .execute(&*fixture.library.trust().pool)
        .await
        .unwrap();
    assert_error(
        Library::open(fixture.root()).await,
        "trust_schema_unsupported",
    );
    let _root = fixture.close().await;
}

#[tokio::test]
async fn native_source_requires_the_exact_confirmed_root_fingerprint() {
    let fixture = Fixture::new().await;
    let a = &fixture.authority;
    assert_error(
        fixture
            .library
            .trust()
            .confirm_source(&a.profile, &a.chain(1), &"a".repeat(64))
            .await,
        "root_fingerprint_mismatch",
    );
    assert!(fixture.library.trust().sources().await.unwrap().is_empty());
    fixture.confirm().await;
    let source = fixture
        .library
        .trust()
        .profile(&a.profile.source_id)
        .await
        .unwrap();
    assert_eq!(source.root_fingerprint, a.profile.root_fingerprint);
    assert_eq!(source.origin, a.profile.origin);
    let _root = fixture.close().await;
}

#[tokio::test]
async fn failed_security_transaction_leaves_no_partial_watermark_or_hash() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let trust = fixture.library.trust();
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
    sqlx::raw_sql("CREATE TRIGGER interrupt_security BEFORE INSERT ON security_hashes BEGIN SELECT RAISE(ABORT,'fixture interruption'); END").execute(&*trust.pool).await.unwrap();
    assert!(trust
        .accept(&a.profile.source_id, &a.chain(1), &rev, None)
        .await
        .is_err());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM security_hashes")
        .fetch_one(&*trust.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(trust
        .row(&a.profile.source_id)
        .await
        .unwrap()
        .revocations_watermark
        .is_none());
    trust.security_check(&"a".repeat(64)).unwrap();
    sqlx::raw_sql("DROP TRIGGER interrupt_security")
        .execute(&*trust.pool)
        .await
        .unwrap();
    trust
        .accept(&a.profile.source_id, &a.chain(1), &rev, None)
        .await
        .unwrap();
    assert_error(trust.security_check(&"a".repeat(64)), "security_revoked");
    let _root = fixture.close().await;
}

#[tokio::test]
async fn failed_clock_persistence_blocks_admission_until_trust_readback_succeeds() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let trust = fixture.library.trust();
    sqlx::raw_sql("CREATE TRIGGER interrupt_clock BEFORE UPDATE ON trust_clock BEGIN SELECT RAISE(ABORT,'fixture interruption'); END").execute(&*trust.pool).await.unwrap();
    assert!(trust
        .persist_observed_time(super::super::now())
        .await
        .is_err());
    assert_error(trust.security_check(&"a".repeat(64)), "trust_unavailable");
    sqlx::raw_sql("DROP TRIGGER interrupt_clock")
        .execute(&*trust.pool)
        .await
        .unwrap();
    trust.reload().await.unwrap();
    trust.security_check(&"a".repeat(64)).unwrap();
    let _root = fixture.close().await;
}

#[tokio::test]
async fn corrupt_restored_source_is_rejected_before_materialization_and_disables_cache() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let trust = fixture.library.trust();
    sqlx::query("UPDATE trust_sources SET profile_json=?1")
        .bind("x".repeat(17000))
        .execute(&*trust.pool)
        .await
        .unwrap();
    assert_error(trust.sources().await, "trust_database_invalid");
    assert!(trust.reload().await.is_err());
    assert_error(
        trust.activation_check(&"a".repeat(64), false),
        "trust_unavailable",
    );
    let _root = fixture.close().await;
}

#[tokio::test]
async fn persisted_clock_rollback_survives_native_library_reopen() {
    let fixture = Fixture::new().await;
    fixture.confirm().await;
    let release = fixture.authority.release(1, &"a".repeat(64), 1);
    fixture.accept(&release).await;
    let source = fixture.authority.profile.source_id.clone();
    fixture
        .library
        .trust()
        .persist_observed_time(super::super::now() + 1000)
        .await
        .unwrap();
    let root = fixture.close().await;
    let trust = TrustStore::open(root.path()).await.unwrap();
    let status = trust.sources().await.unwrap();
    assert_eq!(status[0].profile.source_id, source);
    assert!(status[0].clock_rollback);
    assert!(!status[0].revocations_fresh);
    assert_error(
        trust.activation_check(&"a".repeat(64), true),
        "revocations_stale",
    );
    trust.activation_check(&"a".repeat(64), false).unwrap();
    (&*trust.pool).close().await;
}
