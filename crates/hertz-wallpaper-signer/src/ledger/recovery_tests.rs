// SPDX-License-Identifier: MIT
use super::{test_support::*, Ledger};

#[tokio::test]
async fn failed_watermark_transaction_rolls_back_intent_and_release_identity() {
    let fixture = Fixture::new();
    let mut ledger = fixture.open().await;
    let reviewed = approval(fixture.release(1, 'a'));
    fixture.approve(&mut ledger, &reviewed).await.unwrap();
    sqlx::raw_sql("CREATE TRIGGER interrupt_watermark BEFORE INSERT ON release_watermarks BEGIN SELECT RAISE(ABORT,'fixture interruption'); END").execute(&ledger.pool).await.unwrap();
    assert!(fixture.sign(&mut ledger, &reviewed).await.is_err());
    assert_eq!(count(&ledger, "signing_intents").await, 0);
    assert_eq!(count(&ledger, "release_identities").await, 0);
    assert_eq!(count(&ledger, "release_watermarks").await, 0);
    assert_eq!(ledger.tail().position, 0);
    sqlx::raw_sql("DROP TRIGGER interrupt_watermark")
        .execute(&ledger.pool)
        .await
        .unwrap();
    fixture.sign(&mut ledger, &reviewed).await.unwrap();
    assert_eq!(ledger.tail().position, 1);
    ledger.close().await;
}

#[tokio::test]
async fn registered_intent_resumes_after_signature_persistence_interruption() {
    let fixture = Fixture::new();
    let mut ledger = fixture.open().await;
    let reviewed = approval(fixture.release(1, 'a'));
    fixture.approve(&mut ledger, &reviewed).await.unwrap();
    interrupt_signature(&fixture, &mut ledger, &reviewed).await;
    let record = std::fs::read(
        fixture
            .config
            .checkpoint_directory
            .join(format!("{:020}.json", 1)),
    )
    .unwrap();
    ledger.close().await;
    drop(ledger);
    let mut ledger = Ledger::open(fixture.config.clone(), None).await.unwrap();
    assert_eq!(
        fixture.query(&mut ledger, &reviewed).await.unwrap().state,
        "registered"
    );
    ledger.finish_pending().await.unwrap();
    let response = fixture.query(&mut ledger, &reviewed).await.unwrap();
    assert_eq!(response.state, "signed");
    assert_eq!(
        response.operation_id.as_deref(),
        Some(reviewed.operation_id.as_str())
    );
    assert_eq!(count(&ledger, "signing_intents").await, 1);
    assert_eq!(
        std::fs::read(
            fixture
                .config
                .checkpoint_directory
                .join(format!("{:020}.json", 1))
        )
        .unwrap(),
        record
    );
    ledger.close().await;
}

#[tokio::test]
async fn unsigned_checkpoint_prefix_is_completed_from_the_committed_intent() {
    let fixture = Fixture::new();
    let mut ledger = fixture.open().await;
    let reviewed = approval(fixture.release(1, 'a'));
    fixture.approve(&mut ledger, &reviewed).await.unwrap();
    interrupt_signature(&fixture, &mut ledger, &reviewed).await;
    ledger.close().await;
    drop(ledger);
    let path = fixture
        .config
        .checkpoint_directory
        .join(format!("{:020}.json", 1));
    let complete = std::fs::read(&path).unwrap();
    std::fs::write(&path, &complete[..complete.len() / 2]).unwrap();
    let mut ledger = Ledger::open(fixture.config.clone(), None).await.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), complete);
    assert_eq!(
        fixture.query(&mut ledger, &reviewed).await.unwrap().state,
        "registered"
    );
    ledger.finish_pending().await.unwrap();
    assert_eq!(
        fixture.query(&mut ledger, &reviewed).await.unwrap().state,
        "signed"
    );
    ledger.close().await;
}

#[tokio::test]
async fn a_signed_checkpoint_must_exist_and_cannot_be_reconstructed() {
    let fixture = Fixture::new();
    let mut ledger = fixture.open().await;
    let reviewed = approval(fixture.release(1, 'a'));
    fixture.approve(&mut ledger, &reviewed).await.unwrap();
    fixture.sign(&mut ledger, &reviewed).await.unwrap();
    ledger.close().await;
    drop(ledger);
    let path = fixture
        .config
        .checkpoint_directory
        .join(format!("{:020}.json", 1));
    let complete = std::fs::read(&path).unwrap();
    std::fs::write(&path, &complete[..complete.len() / 2]).unwrap();
    assert_error(
        Ledger::open(fixture.config.clone(), None).await,
        "checkpoint_content_conflict",
    );
    std::fs::remove_file(&path).unwrap();
    assert_error(
        Ledger::open(fixture.config.clone(), None).await,
        "signed_intent_missing_checkpoint",
    );
    assert!(!path.exists());
}

#[tokio::test]
async fn restoring_an_old_database_cannot_lower_the_independent_signed_tail() {
    let fixture = Fixture::new();
    let ledger = fixture.open().await;
    ledger.close().await;
    drop(ledger);
    std::fs::copy(&fixture.config.database_path, fixture.snapshot_path()).unwrap();
    let mut ledger = Ledger::open(fixture.config.clone(), None).await.unwrap();
    let reviewed = approval(fixture.release(1, 'a'));
    fixture.approve(&mut ledger, &reviewed).await.unwrap();
    fixture.sign(&mut ledger, &reviewed).await.unwrap();
    ledger.close().await;
    drop(ledger);
    std::fs::copy(fixture.snapshot_path(), &fixture.config.database_path).unwrap();
    assert_error(
        Ledger::open(fixture.config.clone(), None).await,
        "ledger_behind_independent_checkpoint",
    );
}

#[tokio::test]
async fn root_rotation_keeps_historical_signatures_and_rejects_a_generation_rollback() {
    let fixture = Fixture::new();
    let mut ledger = fixture.open().await;
    let reviewed = approval(fixture.release(1, 'a'));
    fixture.approve(&mut ledger, &reviewed).await.unwrap();
    let first = fixture.sign(&mut ledger, &reviewed).await.unwrap();
    ledger.close().await;
    drop(ledger);
    let next = fixture.generation_config(2);
    let mut ledger = Ledger::open(next, None).await.unwrap();
    let historical = fixture.query(&mut ledger, &reviewed).await.unwrap();
    assert_eq!(historical.envelope, first.envelope);
    assert_eq!(historical.key_generation, Some(1));
    let generation: i64 = sqlx::query_scalar("SELECT generation FROM root_authorization")
        .fetch_one(&ledger.pool)
        .await
        .unwrap();
    assert_eq!(generation, 2);
    ledger.close().await;
    drop(ledger);
    assert_error(
        Ledger::open(fixture.config.clone(), None).await,
        "root_generation_rollback_or_conflict",
    );
}

#[tokio::test]
async fn old_key_intents_must_finish_before_rotating_the_working_seeds() {
    let fixture = Fixture::new();
    let mut ledger = fixture.open().await;
    let reviewed = approval(fixture.release(1, 'a'));
    fixture.approve(&mut ledger, &reviewed).await.unwrap();
    interrupt_signature(&fixture, &mut ledger, &reviewed).await;
    ledger.close().await;
    drop(ledger);
    let next = fixture.generation_config(2);
    assert_error(
        Ledger::open(next.clone(), None).await,
        "finish_old_key_intent_before_rotation",
    );
    let mut ledger = Ledger::open(fixture.config.clone(), None).await.unwrap();
    ledger.finish_pending().await.unwrap();
    ledger.close().await;
    drop(ledger);
    let mut ledger = Ledger::open(next, None).await.unwrap();
    assert_eq!(
        fixture.query(&mut ledger, &reviewed).await.unwrap().state,
        "signed"
    );
    ledger.close().await;
}

#[tokio::test]
async fn root_checkpoint_prevents_restoring_a_pre_rotation_database() {
    let fixture = Fixture::new();
    let ledger = fixture.open().await;
    ledger.close().await;
    drop(ledger);
    std::fs::copy(&fixture.config.database_path, fixture.snapshot_path()).unwrap();
    let next = fixture.generation_config(2);
    let ledger = Ledger::open(next.clone(), None).await.unwrap();
    ledger.close().await;
    drop(ledger);
    std::fs::copy(fixture.snapshot_path(), &fixture.config.database_path).unwrap();
    assert_error(
        Ledger::open(next, None).await,
        "ledger_behind_root_checkpoint",
    );
}

#[tokio::test]
async fn unsigned_root_prefix_is_repaired_but_a_signed_generation_requires_complete_history() {
    let fixture = Fixture::new();
    let ledger = fixture.open().await;
    ledger.close().await;
    drop(ledger);
    let path = fixture
        .config
        .checkpoint_directory
        .join(format!("authorization-{:020}.json", 1));
    let complete = std::fs::read(&path).unwrap();
    std::fs::write(&path, &complete[..complete.len() / 2]).unwrap();
    let mut ledger = Ledger::open(fixture.config.clone(), None).await.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), complete);
    let reviewed = approval(fixture.release(1, 'a'));
    fixture.approve(&mut ledger, &reviewed).await.unwrap();
    fixture.sign(&mut ledger, &reviewed).await.unwrap();
    ledger.close().await;
    drop(ledger);
    std::fs::remove_file(&path).unwrap();
    assert_error(
        Ledger::open(fixture.config.clone(), None).await,
        "signed_generation_missing_root_checkpoint",
    );
    assert!(!path.exists());
}
