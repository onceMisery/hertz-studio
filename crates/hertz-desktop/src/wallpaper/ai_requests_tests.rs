// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::super::library::{now_secs, tempfileish};
use super::*;
use hertz_wallpaper::external_requests::parse;
use serde_json::json;
use sha2::{Digest, Sha256};

fn origin(subject: &str) -> Origin {
    Origin::new(
        &format!("{:x}", Sha256::digest(subject.as_bytes())),
        &"d".repeat(64),
        &"a".repeat(64),
        "SDK assistant",
    )
    .unwrap()
}
fn request(id: &str, brief: &str) -> Request {
    parse(
        "generate",
        &serde_json::to_vec(&json!({"operationId":id,"brief":brief,"outputKind":"builtin"}))
            .unwrap(),
    )
    .unwrap()
}

fn switch_request(id: &str) -> Request {
    parse(
        "switch",
        &serde_json::to_vec(&json!({
            "operationId": id,
            "workKey": "local-a326a8b2-b5d7-4db6-b981-fd2b5dbb9d3e",
            "packageHash": "a".repeat(64),
            "targetHandle": "b".repeat(64),
        }))
        .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn replay_reads_original_switch_after_target_handle_lifetime_without_new_admission() {
    let root = tempfileish::temp_dir("request-replay-switch");
    let library = Library::open(root.path()).await.unwrap();
    let store = AiRequests::new(&library);
    let now = now_secs();
    let original = origin("a");
    let input = switch_request("switch-one");
    let receipt = store.admit(&original, &input, now).await.unwrap();
    let fresh = Origin::new(
        &original.subject_digest,
        &original.credential_revision,
        &"c".repeat(64),
        "new native session",
    )
    .unwrap();
    let replayed = store
        .replay(&fresh, &input, now + 60)
        .await
        .unwrap()
        .expect("same request identity must remain readable after the handle's lifetime");
    assert_eq!(replayed, receipt);
    assert_eq!(replayed.state, RequestState::PendingConfirmation);
    let (records, events): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM ai_requests),(SELECT COUNT(*) FROM ai_request_frequency)",
    )
    .fetch_one(library.pool())
    .await
    .unwrap();
    assert_eq!(
        (records, events),
        (1, 0),
        "replay may expire frequency but cannot add admission rows"
    );
    library.pool().close().await;
}

#[tokio::test]
async fn replay_preserves_terminal_identity_and_rejects_conflict_or_rotated_revision() {
    let root = tempfileish::temp_dir("request-replay-terminal");
    let library = Library::open(root.path()).await.unwrap();
    let store = AiRequests::new(&library);
    let now = now_secs();
    let original = origin("a");
    let input = request("one", "original brief");
    let admitted = store.admit(&original, &input, now).await.unwrap();
    let rejected = store
        .reject(&original, &admitted.request_id, now + 1)
        .await
        .unwrap();
    let fresh = Origin::new(
        &original.subject_digest,
        &original.credential_revision,
        &"c".repeat(64),
        "new native session",
    )
    .unwrap();
    assert_eq!(
        store
            .replay(&fresh, &request("one", "different brief"), now + 2)
            .await
            .unwrap_err()
            .code,
        "ai_request_conflict"
    );
    let rotated = Origin::new(
        &original.subject_digest,
        &"e".repeat(64),
        &fresh.binding_digest,
        &fresh.label,
    )
    .unwrap();
    assert_eq!(
        store
            .replay(&rotated, &input, now + 2)
            .await
            .unwrap_err()
            .code,
        "ai_request_origin_changed"
    );
    assert_eq!(
        store.replay(&fresh, &input, now + 600).await.unwrap(),
        Some(rejected)
    );
    let records: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_requests")
        .fetch_one(library.pool())
        .await
        .unwrap();
    assert_eq!(records, 1);
    library.pool().close().await;
}

#[tokio::test]
async fn replay_of_new_operation_cannot_create_a_receipt_or_frequency_event() {
    let root = tempfileish::temp_dir("request-replay-missing");
    let library = Library::open(root.path()).await.unwrap();
    let store = AiRequests::new(&library);
    let now = now_secs();
    assert!(store
        .replay(&origin("a"), &switch_request("brand-new"), now)
        .await
        .unwrap()
        .is_none());
    let (records, events): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM ai_requests),(SELECT COUNT(*) FROM ai_request_frequency)",
    )
    .fetch_one(library.pool())
    .await
    .unwrap();
    assert_eq!((records, events), (0, 0));
    library.pool().close().await;
}

#[tokio::test]
async fn admit_is_idempotent_conflicts_and_cannot_read_another_grant() {
    let root = tempfileish::temp_dir("request-idem");
    let library = Library::open(root.path()).await.unwrap();
    let store = AiRequests::new(&library);
    let now = now_secs();
    let input = request("sdk-1", "private brief");
    let receipt = store.admit(&origin("grant-a"), &input, now).await.unwrap();
    assert_eq!(receipt.state, RequestState::PendingConfirmation);
    assert_eq!(receipt.expires_at, now + 120);
    assert_eq!(
        store
            .admit(&origin("grant-a"), &input, now + 1)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        store
            .admit(&origin("grant-a"), &request("sdk-1", "other"), now + 1)
            .await
            .unwrap_err()
            .code,
        "ai_request_conflict"
    );
    assert_eq!(
        store
            .get(&origin("grant-b"), &receipt.request_id, now)
            .await
            .unwrap_err()
            .code,
        "ai_request_not_found"
    );
    let second = store.admit(&origin("grant-b"), &input, now).await.unwrap();
    assert_ne!(receipt.request_id, second.request_id);
    let pending = store.pending(now).await.unwrap();
    assert_eq!(pending.len(), 2);
    assert!(pending.iter().any(|item| item.request_id == receipt.request_id && matches!(&item.request, Request::Generate(input) if input.brief == "private brief")));
    let raw: String = sqlx::query_scalar("SELECT group_concat(subject_digest || payload_digest || binding_digest || operation_id,'') FROM ai_requests").fetch_one(library.pool()).await.unwrap();
    assert!(!raw.contains("private brief") && !raw.contains("grant-a"));
    let columns: Vec<(i64, String, String, i64, Option<String>, i64)> =
        sqlx::query_as("PRAGMA table_info(ai_requests)")
            .fetch_all(library.pool())
            .await
            .unwrap();
    assert!(!columns
        .iter()
        .any(|column| ["brief", "request_json", "proof", "subject"].contains(&column.1.as_str())));
    library.pool().close().await;
}

#[tokio::test]
async fn fifth_global_slot_and_fifth_grant_attempt_are_independent() {
    let root = tempfileish::temp_dir("request-limits");
    let library = Library::open(root.path()).await.unwrap();
    let store = AiRequests::new(&library);
    let now = now_secs();
    let mut admitted = Vec::new();
    for index in 0..4 {
        admitted.push(
            store
                .admit(&origin("a"), &request(&format!("a-{index}"), "rain"), now)
                .await
                .unwrap(),
        );
    }
    assert_eq!(
        store
            .admit(&origin("b"), &request("b-0", "rain"), now)
            .await
            .unwrap_err()
            .code,
        "ai_request_capacity_exceeded"
    );
    store
        .reject(&origin("a"), &admitted[0].request_id, now + 1)
        .await
        .unwrap();
    assert_eq!(
        store
            .admit(&origin("a"), &request("a-4", "rain"), now + 1)
            .await
            .unwrap_err()
            .code,
        "ai_request_rate_limited"
    );
    assert!(store
        .admit(&origin("b"), &request("b-0", "rain"), now + 1)
        .await
        .is_ok());
    assert_eq!(
        store
            .admit(&origin("a"), &request("a-0", "rain"), now + 2)
            .await
            .unwrap()
            .state,
        RequestState::Rejected
    );
    store
        .reject(&origin("a"), &admitted[1].request_id, now + 61)
        .await
        .unwrap();
    assert!(store
        .admit(&origin("a"), &request("a-4", "rain"), now + 61)
        .await
        .is_ok());
    library.pool().close().await;
}

#[tokio::test]
async fn expires_at_boundary_and_never_restores_pending_input_on_restart() {
    let root = tempfileish::temp_dir("request-restart");
    let library = Library::open(root.path()).await.unwrap();
    let store = AiRequests::new(&library);
    let now = now_secs();
    let first = store
        .admit(&origin("a"), &request("first", "private"), now)
        .await
        .unwrap();
    assert_eq!(
        store
            .get(&origin("a"), &first.request_id, now + 119)
            .await
            .unwrap()
            .state,
        RequestState::PendingConfirmation
    );
    assert_eq!(
        store
            .get(&origin("a"), &first.request_id, now + 120)
            .await
            .unwrap()
            .state,
        RequestState::Expired
    );
    assert!(store.pending(now + 120).await.unwrap().is_empty());
    let second = store
        .admit(&origin("a"), &request("second", "private"), now + 121)
        .await
        .unwrap();
    library.pool().close().await;
    let reopened = Library::open(root.path()).await.unwrap();
    let store = AiRequests::new(&reopened);
    let fresh_origin = Origin::new(
        &origin("a").subject_digest,
        &origin("a").credential_revision,
        &"b".repeat(64),
        "new service session",
    )
    .unwrap();
    assert_eq!(
        store
            .get(&fresh_origin, &second.request_id, now + 122)
            .await
            .unwrap()
            .state,
        RequestState::Interrupted
    );
    assert_eq!(
        store
            .get(&origin("a"), &second.request_id, now + 122)
            .await
            .unwrap()
            .state,
        RequestState::Interrupted
    );
    assert!(store.pending(now + 122).await.unwrap().is_empty());
    assert_eq!(
        store
            .admit(&origin("a"), &request("second", "private"), now + 122)
            .await
            .unwrap()
            .state,
        RequestState::Interrupted
    );
    reopened.pool().close().await;
}

#[tokio::test]
async fn acceptance_is_bound_once_and_records_only_existing_owner_ids() {
    let root = tempfileish::temp_dir("request-accept");
    let library = Library::open(root.path()).await.unwrap();
    let store = AiRequests::new(&library);
    let now = now_secs();
    let input = request("confirm", "rain");
    let receipt = store.admit(&origin("a"), &input, now).await.unwrap();
    let changed = Origin::new(
        &origin("a").subject_digest,
        &"d".repeat(64),
        &"b".repeat(64),
        "SDK assistant",
    )
    .unwrap();
    assert_eq!(
        store.get(&changed, &receipt.request_id, now).await.unwrap(),
        receipt
    );
    assert_eq!(
        store
            .accept(
                &changed,
                &receipt.request_id,
                &input.digest(),
                "accept-1",
                now
            )
            .await
            .unwrap_err()
            .code,
        "ai_request_origin_changed"
    );
    assert_eq!(
        store
            .accept(
                &origin("a"),
                &receipt.request_id,
                &"c".repeat(64),
                "accept-1",
                now
            )
            .await
            .unwrap_err()
            .code,
        "ai_request_conflict"
    );
    assert_eq!(
        store
            .accept(
                &origin("a"),
                &receipt.request_id,
                &input.digest(),
                "accept-1",
                now
            )
            .await
            .unwrap()
            .state,
        RequestState::Accepted
    );
    assert_eq!(
        store
            .accept(
                &origin("a"),
                &receipt.request_id,
                &input.digest(),
                "accept-1",
                now
            )
            .await
            .unwrap()
            .state,
        RequestState::Accepted
    );
    assert_eq!(
        store
            .accept(
                &origin("a"),
                &receipt.request_id,
                &input.digest(),
                "accept-2",
                now
            )
            .await
            .unwrap_err()
            .code,
        "ai_request_conflict"
    );
    let done = store
        .complete(
            &origin("a"),
            &receipt.request_id,
            Outcome {
                state: RequestState::Succeeded,
                job_id: Some("native-job-1".into()),
                native_operation_id: None,
                error_code: None,
            },
            now + 1,
        )
        .await
        .unwrap();
    assert_eq!(done.job_id.as_deref(), Some("native-job-1"));
    assert!(store.pending(now + 1).await.unwrap().is_empty());
    assert_eq!(
        store
            .reject(&origin("a"), &receipt.request_id, now + 1)
            .await
            .unwrap_err()
            .code,
        "ai_request_state_changed"
    );
    library.pool().close().await;
}

#[tokio::test]
async fn retention_and_frequency_remain_bounded_without_erasing_valid_idempotency() {
    let root = tempfileish::temp_dir("request-retention");
    let library = Library::open(root.path()).await.unwrap();
    let store = AiRequests::new(&library);
    let now = now_secs();
    let first = store
        .admit(&origin("first"), &request("first", "rain"), now)
        .await
        .unwrap();
    store
        .reject(&origin("first"), &first.request_id, now + 1)
        .await
        .unwrap();
    for index in 1..256 {
        let who = origin(&format!("grant-{index}"));
        let item = store
            .admit(&who, &request("one", "rain"), now + 1)
            .await
            .unwrap();
        store.reject(&who, &item.request_id, now + 1).await.unwrap();
    }
    assert_eq!(
        store
            .admit(&origin("overflow"), &request("one", "rain"), now + 2)
            .await
            .unwrap_err()
            .code,
        "ai_request_receipt_capacity_exceeded"
    );
    assert!(store.pending(now + 600).await.unwrap().is_empty());
    assert_eq!(
        store
            .admit(&origin("first"), &request("first", "rain"), now + 600)
            .await
            .unwrap()
            .request_id,
        first.request_id
    );
    assert!(store.pending(now + 602).await.unwrap().is_empty());
    assert!(store
        .admit(&origin("overflow"), &request("one", "rain"), now + 602)
        .await
        .is_ok());
    let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_request_frequency")
        .fetch_one(library.pool())
        .await
        .unwrap();
    assert_eq!(events, 1);
    library.pool().close().await;
}

#[tokio::test]
async fn concurrent_same_key_creates_one_receipt_and_one_frequency_event() {
    let root = tempfileish::temp_dir("request-concurrent");
    let library = Library::open(root.path()).await.unwrap();
    let store = AiRequests::new(&library);
    let now = now_secs();
    let who = origin("a");
    let input = request("one", "rain");
    let (left, right) = tokio::join!(
        store.admit(&who, &input, now),
        store.admit(&who, &input, now)
    );
    assert_eq!(left.unwrap(), right.unwrap());
    let (receipts, events): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM ai_requests),(SELECT COUNT(*) FROM ai_request_frequency)",
    )
    .fetch_one(library.pool())
    .await
    .unwrap();
    assert_eq!((receipts, events), (1, 1));
    library.pool().close().await;
}

#[tokio::test]
async fn independent_frequency_capacity_and_shared_receipt_byte_budget_fail_closed() {
    let root = tempfileish::temp_dir("request-storage-budget");
    let library = Library::open(root.path()).await.unwrap();
    let store = AiRequests::new(&library);
    let now = now_secs();
    for _ in 0..1024 {
        sqlx::query("INSERT INTO ai_request_frequency VALUES(?,?,?)")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind("a".repeat(64))
            .bind(now)
            .execute(library.pool())
            .await
            .unwrap();
    }
    assert_eq!(
        store
            .admit(&origin("b"), &request("one", "rain"), now)
            .await
            .unwrap_err()
            .code,
        "ai_request_frequency_capacity_exceeded"
    );
    assert!(store.pending(now + 60).await.unwrap().is_empty());
    for index in 0..4 {
        sqlx::query("INSERT INTO ai_receipts(receipt_id,service_owner,job_id,artifact_id,output_hash,state,metadata_json,document_json,provider,model,received_at,expires_at) VALUES(?,?,?,?,?,'saved','{}',?,'fake','fake',?,?)")
            .bind(format!("legacy-{index}")).bind("legacy").bind(format!("job-{index}")).bind(format!("artifact-{index}")).bind("a".repeat(64)).bind("x".repeat(1048576)).bind(now).bind(now+86400)
            .execute(library.pool()).await.unwrap();
    }
    assert_eq!(
        store
            .admit(&origin("b"), &request("one", "rain"), now + 60)
            .await
            .unwrap_err()
            .code,
        "ai_request_receipt_capacity_exceeded"
    );
    let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_receipts")
        .fetch_one(library.pool())
        .await
        .unwrap();
    assert_eq!(existing, 4, "old saved receipts are preserved");
    library.pool().close().await;
}

#[tokio::test]
async fn pending_expiry_preserves_accepted_owner_fact_and_revision_isolation() {
    let root = tempfileish::temp_dir("request-expiry-accepted");
    let library = Library::open(root.path()).await.unwrap();
    let store = AiRequests::new(&library);
    let now = now_secs();
    let who = origin("a");
    let waiting = store
        .admit(&who, &request("waiting", "rain"), now)
        .await
        .unwrap();
    let input = request("accepted", "rain");
    let accepted = store.admit(&who, &input, now).await.unwrap();
    store
        .accept(
            &who,
            &accepted.request_id,
            &input.digest(),
            "one-acceptance",
            now,
        )
        .await
        .unwrap();
    assert!(store.pending(now + 120).await.unwrap().is_empty());
    assert_eq!(
        store
            .get(&who, &waiting.request_id, now + 120)
            .await
            .unwrap()
            .state,
        RequestState::Expired
    );
    assert_eq!(
        store
            .get(&who, &accepted.request_id, now + 120)
            .await
            .unwrap()
            .state,
        RequestState::Accepted
    );
    let rotated = Origin::new(
        &who.subject_digest,
        &"e".repeat(64),
        &who.binding_digest,
        &who.label,
    )
    .unwrap();
    assert_eq!(
        store
            .get(&rotated, &waiting.request_id, now + 120)
            .await
            .unwrap_err()
            .code,
        "ai_request_not_found"
    );
    let jobs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM install_jobs")
        .fetch_one(library.pool())
        .await
        .unwrap();
    assert_eq!(jobs, 0, "request state itself cannot create a native job");
    library.pool().close().await;
}

#[tokio::test]
async fn pending_expiry_cannot_overtake_committed_input_handoff() {
    use std::sync::Arc;
    let root = tempfileish::temp_dir("request-handoff");
    let library = Arc::new(Library::open(root.path()).await.unwrap());
    let hook = Arc::new(AdmitCommitHook::default());
    *library.ai_request_commit_hook.lock().unwrap() = Some(hook.clone());
    let now = now_secs();
    let admitting_library = library.clone();
    let admission = tokio::spawn(async move {
        AiRequests::new(&admitting_library)
            .admit(&origin("a"), &request("one", "private brief"), now)
            .await
    });
    hook.committed.notified().await;
    let expired = Arc::new(tokio::sync::Notify::new());
    let expiring_library = library.clone();
    let finished = expired.clone();
    let expiration = tokio::spawn(async move {
        let result = AiRequests::new(&expiring_library).pending(now + 120).await;
        finished.notify_one();
        result
    });
    let overtook = tokio::time::timeout(std::time::Duration::from_millis(100), expired.notified())
        .await
        .is_ok();
    hook.release.notify_one();
    let admitted = admission.await.unwrap().unwrap();
    assert!(expiration.await.unwrap().unwrap().is_empty());
    assert!(
        !overtook,
        "pending expiry must linearize after the committed input handoff"
    );
    assert!(AiRequests::new(&library)
        .pending(now + 120)
        .await
        .unwrap()
        .is_empty());
    assert!(
        library.ai_request_inputs.lock().unwrap().is_empty(),
        "expired brief cannot reappear after handoff"
    );
    assert_eq!(
        AiRequests::new(&library)
            .get(&origin("a"), &admitted.request_id, now + 120)
            .await
            .unwrap()
            .state,
        RequestState::Expired
    );
    library.pool().close().await;
}

#[tokio::test]
async fn original_candidate_receive_cannot_bypass_request_receipt_reservations() {
    use super::super::{ai_receipts::AiReceipts, generation::receive::ReceivedBuiltin};
    use hertz_wallpaper::generation::{WallpaperArtifact, WallpaperGenerationKind};
    let root = tempfileish::temp_dir("request-cross-owner-budget");
    let library = Library::open(root.path()).await.unwrap();
    let now = now_secs();
    let store = AiRequests::new(&library);
    for index in 0..256 {
        let who = origin(&format!("grant-{index}"));
        let admitted = store
            .admit(&who, &request("one", "rain"), now)
            .await
            .unwrap();
        store.reject(&who, &admitted.request_id, now).await.unwrap();
    }
    let bytes = serde_json::to_vec(
        &json!({"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{}}),
    )
    .unwrap();
    let input = ReceivedBuiltin {
        artifact: WallpaperArtifact {
            artifact_id: uuid::Uuid::new_v4().to_string(),
            job_id: "fixture-budget".into(),
            kind: WallpaperGenerationKind::Builtin,
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            mime: "application/json".into(),
            registry_hash: hertz_wallpaper::catalog().registry_hash.clone(),
            generation_schema_hash: "a".repeat(64),
            expires_at: ((now + 3600) * 1000).to_string(),
        },
        service_owner: "fixture-owner".into(),
        provider: "fake".into(),
        model: "fake-v1".into(),
        bytes,
        epoch: 0,
    };
    let result = AiReceipts::new(&library).receive(input, || Ok(())).await;
    assert_eq!(result.unwrap_err().code, "candidate_capacity_exceeded");
    let (requests, candidates): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM ai_requests),(SELECT COUNT(*) FROM ai_receipts)",
    )
    .fetch_one(library.pool())
    .await
    .unwrap();
    assert_eq!((requests, candidates), (256, 0));
    library.pool().close().await;
}
