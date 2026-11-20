// SPDX-License-Identifier: MIT
//! Original author ledgers, actual package receive/submit, restart and read bounds.
use super::*;
use crate::{
    author_operations::OperationKind,
    model::{CreateWork, UploadInput},
};
use axum::body::Body;
use sha2::{Digest, Sha256};
use std::io::Cursor;

const PACKAGE: &[u8] = include_bytes!("../tests/fixtures/author-upload.hwpk");

fn work_input(operation: &str) -> CreateWork {
    let manifest = hertz_wallpaper::validate_package(Cursor::new(PACKAGE))
        .unwrap()
        .manifest;
    CreateWork {
        operation_id: operation.into(),
        work_id: manifest.work_id,
        title: manifest.title,
        license: manifest.license,
    }
}
fn upload_input(operation: &str) -> UploadInput {
    UploadInput {
        operation_id: operation.into(),
        package_hash: format!("{:x}", Sha256::digest(PACKAGE)),
        bytes: PACKAGE.len() as u64,
        min_engine_protocol: 1,
    }
}
async fn facts(f: &Fixture) -> Vec<i64> {
    let mut counts = Vec::new();
    for table in [
        "works",
        "uploads",
        "releases",
        "reports",
        "audit_events",
        "management_operations",
        "publication_operations",
    ] {
        counts.push(
            sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&f.hub.pool)
                .await
                .unwrap(),
        );
    }
    counts
}

#[tokio::test]
async fn original_work_and_upload_request_queries_survive_restart_and_do_not_write() {
    let mut f = Fixture::new().await;
    let owner = f.user(Role::Author).await;
    let other = f.user(Role::Author).await;
    let create_id = uuid::Uuid::new_v4().to_string();
    let work = f
        .hub
        .create_work(&owner, work_input(&create_id))
        .await
        .unwrap();
    let upload_id = uuid::Uuid::new_v4().to_string();
    let upload = f
        .hub
        .reserve_upload(&owner, &work.id, upload_input(&upload_id))
        .await
        .unwrap();
    let account = f.hub.author_account(&owner).await.unwrap();
    assert_eq!(account["issuer"], "https://identity.example");
    assert_eq!(account["subject"], owner.id);
    assert_eq!(account["role"], "author");
    let before = facts(&f).await;
    let first = value(
        &f.hub
            .author_operation(&owner, OperationKind::Work, &create_id)
            .await
            .unwrap(),
    );
    assert_eq!(first["result"]["id"], work.id);
    assert_eq!(first["found"], true);
    assert!(hertz_wallpaper::valid_sha256_hex(
        first["requestDigest"].as_str().unwrap()
    ));
    let reserved = value(
        &f.hub
            .author_operation(&owner, OperationKind::Upload, &upload_id)
            .await
            .unwrap(),
    );
    assert_eq!(reserved["result"]["id"], upload.id);
    assert_eq!(reserved["result"]["state"], "reserved");
    let hidden = value(
        &f.hub
            .author_operation(&other, OperationKind::Upload, &upload_id)
            .await
            .unwrap(),
    );
    assert_eq!(hidden["found"], false);
    assert_eq!(hidden["result"], Value::Null);
    assert_eq!(hidden["requestDigest"], Value::Null);
    assert!(f.hub.author_uploads(&other, 0, 4).await.unwrap().is_empty());
    let absent = value(
        &f.hub
            .author_operation(
                &owner,
                OperationKind::Work,
                &uuid::Uuid::new_v4().to_string(),
            )
            .await
            .unwrap(),
    );
    assert_eq!(absent["found"], false);
    rejected(
        f.hub
            .author_operation(&owner, OperationKind::Work, "bad/id")
            .await,
        StatusCode::BAD_REQUEST,
    );
    assert_eq!(facts(&f).await, before);
    f.reopen().await;
    assert_eq!(
        value(
            &f.hub
                .author_operation(&owner, OperationKind::Work, &create_id)
                .await
                .unwrap()
        ),
        first
    );
    assert_eq!(
        value(
            &f.hub
                .author_operation(&owner, OperationKind::Upload, &upload_id)
                .await
                .unwrap()
        ),
        reserved
    );
    assert_eq!(facts(&f).await, before);
    f.close().await;
}

#[tokio::test]
async fn ready_upload_is_recoverable_after_successful_receipt_and_restart_then_submits_once() {
    let mut f = Fixture::new().await;
    let owner = f.user(Role::Author).await;
    let work = f
        .hub
        .create_work(&owner, work_input(&uuid::Uuid::new_v4().to_string()))
        .await
        .unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let upload = f
        .hub
        .reserve_upload(&owner, &work.id, upload_input(&operation))
        .await
        .unwrap();
    let ready = f
        .hub
        .receive(
            owner.clone(),
            upload.id.clone(),
            PACKAGE.len() as u64,
            Body::from(PACKAGE),
        )
        .await
        .unwrap();
    assert_eq!(ready.state, "ready");
    f.reopen().await;
    let before = facts(&f).await;
    let pending = f.hub.author_uploads(&owner, 0, 4).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, upload.id);
    assert_eq!(pending[0].state, "ready");
    assert_eq!(facts(&f).await, before);
    let submitted = f
        .hub
        .submit(owner.clone(), pending[0].id.clone())
        .await
        .unwrap();
    assert_eq!(submitted.state, "pending_review");
    assert_eq!(submitted.package_hash, upload.package_hash);
    assert!(submitted.signed_release.is_none());
    assert!(f.hub.author_uploads(&owner, 0, 4).await.unwrap().is_empty());
    rejected(f.hub.published(&work.id).await, StatusCode::NOT_FOUND);
    let after = facts(&f).await;
    let repeated = f
        .hub
        .submit(owner.clone(), upload.id.clone())
        .await
        .unwrap();
    assert_eq!(repeated.id, submitted.id);
    assert_eq!(facts(&f).await, after);
    f.reopen().await;
    let recovered = value(
        &f.hub
            .author_operation(&owner, OperationKind::Upload, &operation)
            .await
            .unwrap(),
    );
    assert_eq!(recovered["result"]["state"], "submitted");
    assert_eq!(recovered["result"]["releaseId"], submitted.id);
    assert_eq!(
        f.hub.candidate(&owner, &submitted.id).await.unwrap().state,
        "pending_review"
    );
    assert_eq!(facts(&f).await, after);
    f.close().await;
}

#[tokio::test]
async fn reporter_can_recover_the_original_result_but_another_author_cannot() {
    let mut f = Fixture::new().await;
    let reporter = f.user(Role::Author).await;
    let other = f.user(Role::Author).await;
    let release = f.release(&reporter).await;
    let operation = uuid::Uuid::new_v4().to_string();
    let id = f
        .hub
        .report(&reporter, report_input(&operation, &release))
        .await
        .unwrap();
    let before = facts(&f).await;
    let result = value(
        &f.hub
            .author_operation(&reporter, OperationKind::Report, &operation)
            .await
            .unwrap(),
    );
    assert_eq!(result["result"]["id"], id);
    assert_eq!(result["result"]["status"], "open");
    let hidden = value(
        &f.hub
            .author_operation(&other, OperationKind::Report, &operation)
            .await
            .unwrap(),
    );
    assert_eq!(hidden["found"], false);
    assert_eq!(facts(&f).await, before);
    f.reopen().await;
    assert_eq!(
        value(
            &f.hub
                .author_operation(&reporter, OperationKind::Report, &operation)
                .await
                .unwrap()
        ),
        result
    );
    assert_eq!(facts(&f).await, before);
    f.close().await;
}

#[tokio::test]
async fn author_reads_reject_stale_or_malformed_accounts_and_bound_recovery_fields() {
    let f = Fixture::new().await;
    let owner = f.user(Role::Author).await;
    let operation = uuid::Uuid::new_v4().to_string();
    f.hub
        .create_work(&owner, work_input(&operation))
        .await
        .unwrap();
    for (offset, limit) in [(-1, 4), (1_000_001, 4), (0, 0), (0, 51)] {
        rejected(
            f.hub.author_uploads(&owner, offset, limit).await,
            StatusCode::BAD_REQUEST,
        );
    }
    sqlx::query("UPDATE works SET license_json=? WHERE owner_id=?")
        .bind("x".repeat(4097))
        .bind(&owner.id)
        .execute(&f.hub.pool)
        .await
        .unwrap();
    rejected(
        f.hub
            .author_operation(&owner, OperationKind::Work, &operation)
            .await,
        StatusCode::SERVICE_UNAVAILABLE,
    );
    sqlx::query("UPDATE works SET operation_digest=? WHERE owner_id=?")
        .bind("x".repeat(1024 * 1024))
        .bind(&owner.id)
        .execute(&f.hub.pool)
        .await
        .unwrap();
    rejected(
        f.hub
            .author_operation(&owner, OperationKind::Work, &operation)
            .await,
        StatusCode::SERVICE_UNAVAILABLE,
    );
    // Model an invalid recovered snapshot; production schema checks stay enabled.
    sqlx::query("PRAGMA ignore_check_constraints=ON")
        .execute(&f.hub.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET role='unexpected' WHERE id=?")
        .bind(&owner.id)
        .execute(&f.hub.pool)
        .await
        .unwrap();
    rejected(
        f.hub.author_uploads(&owner, 0, 4).await,
        StatusCode::SERVICE_UNAVAILABLE,
    );
    rejected(
        f.hub.author_account(&owner).await,
        StatusCode::SERVICE_UNAVAILABLE,
    );
    let stale = Actor {
        id: uuid::Uuid::new_v4().to_string(),
        role: "admin".into(),
    };
    rejected(
        f.hub
            .author_operation(&stale, OperationKind::Work, &operation)
            .await,
        StatusCode::FORBIDDEN,
    );
    f.close().await;
}

#[tokio::test]
async fn receive_requires_the_exact_hash_before_ready_and_still_keeps_original_request_identity() {
    let f = Fixture::new().await;
    let owner = f.user(Role::Author).await;
    let work = f
        .hub
        .create_work(&owner, work_input(&uuid::Uuid::new_v4().to_string()))
        .await
        .unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    let upload = f
        .hub
        .reserve_upload(&owner, &work.id, upload_input(&operation))
        .await
        .unwrap();
    let mut corrupted = PACKAGE.to_vec();
    corrupted[0] ^= 1;
    rejected(
        f.hub
            .receive(
                owner.clone(),
                upload.id.clone(),
                PACKAGE.len() as u64,
                Body::from(corrupted),
            )
            .await,
        StatusCode::BAD_REQUEST,
    );
    let recovered = value(
        &f.hub
            .author_operation(&owner, OperationKind::Upload, &operation)
            .await
            .unwrap(),
    );
    assert_eq!(recovered["result"]["id"], upload.id);
    assert_ne!(recovered["result"]["state"], "ready");
    assert_ne!(recovered["result"]["state"], "submitted");
    f.close().await;
}
