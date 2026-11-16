// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! V2 settlement uses the existing jobs/usage transactions and monthly owner.

use super::*;
use crate::ai::pricing::tests::{image_quote, image_usage};

#[tokio::test(start_paused = true)]
async fn frozen_execution_budget_includes_reload_wait_and_preserves_text_deadline() {
    let started = tokio::time::Instant::now();
    let image_deadline = execution_deadline(started, IMAGE_GENERATION.run_deadline_ms);
    let text_deadline = execution_deadline(
        started,
        generation_capability(CAPABILITY).unwrap().run_deadline_ms,
    );
    tokio::time::advance(std::time::Duration::from_secs(35)).await;
    assert!(text_deadline < tokio::time::Instant::now());
    assert_eq!(
        image_deadline.duration_since(tokio::time::Instant::now()),
        std::time::Duration::from_secs(145)
    );
    tokio::time::advance(std::time::Duration::from_secs(145)).await;
    assert_eq!(image_deadline, tokio::time::Instant::now());
}

#[tokio::test]
async fn invalid_image_receipt_cannot_change_token_only_unknown_amount_to_reported_zero() {
    let (state, handle) = jobs_state().await;
    state
        .ai_runtime
        .install_provider(Arc::new(TokenOnlyProvider))
        .await;
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "unpriced receipt mismatch", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    let mut row = store::find_job_by_id(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    row.dispatch_state = "may_have_been_sent".into();
    row.attempt_id = Some("receipt-mismatch-attempt".into());
    row.state = "cancelled".into();
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    usage::settle_terminal(&mut tx, &row, Some(&image_usage()), now_ms())
        .await
        .unwrap();
    let entry = store::find_usage_entry(&mut *tx, &row.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.usage_state, "unpriced");
    tx.commit().await.unwrap();
    let view = JobView::with_usage(&row, &state.db).await.unwrap();
    assert_eq!(view.usage.accounted_micro_usd, None);
    cancel(&state, "local-owner", &job.job_id, job.state_revision)
        .await
        .unwrap();
    drop(slot);
    state.audio.shutdown();
    handle.join().unwrap();
    state.db.close().await;
}

async fn image_job(state: &Arc<AppState>, id: &str, dispatched: bool) -> store::JobRow {
    let snapshot = PricingSnapshot {
        provider: "image-fixture".into(),
        model: "image-fixture-v1".into(),
        quote: image_quote(),
        credential: None,
    };
    let row = store::JobRow {
        job_id: id.into(),
        owner_instance_id: instance_owner(state).await.unwrap(),
        principal: "local-owner".into(),
        capability: WALLPAPER_CAPABILITY.into(),
        key: id.into(),
        input_hash: "test-hash".into(),
        state: "cancelled".into(),
        state_revision: 2,
        dispatch_state: if dispatched {
            "may_have_been_sent"
        } else {
            "not_dispatched"
        }
        .into(),
        attempt_id: dispatched.then(|| format!("attempt-{id}")),
        provider: snapshot.provider.clone(),
        model: snapshot.model.clone(),
        reservation_micro_usd: snapshot.quote.reservation_micro_usd,
        pricing_snapshot: serde_json::to_string(&snapshot).unwrap(),
        queue_deadline_ms: 60_000,
        run_deadline_ms: 180_000,
        reservation_limit_micro_usd: 500_000,
        created_at: now_ms(),
        updated_at: now_ms(),
        result_proposal_id: None,
        failure_code: None,
        provider_http_status: None,
    };
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    store::reserve(
        &mut tx,
        &utc_month_key(row.created_at),
        row.reservation_micro_usd,
        MONTHLY_LIMIT_MICRO_USD,
    )
    .await
    .unwrap();
    store::insert_job(&mut *tx, &row).await.unwrap();
    tx.commit().await.unwrap();
    row
}

#[tokio::test]
async fn cancelled_image_reserves_unknown_fees_then_reconciles_one_late_receipt_after_job_purge() {
    let (state, handle) = jobs_state().await;
    let job = image_job(&state, "late-image", true).await;
    let month = utc_month_key(job.created_at);
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    usage::settle_terminal(&mut tx, &job, None, now_ms())
        .await
        .unwrap();
    usage::settle_terminal(&mut tx, &job, None, now_ms())
        .await
        .unwrap();
    let entry = store::find_usage_entry(&mut *tx, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.usage_state, "unknown");
    assert_eq!(entry.accounted_micro_usd, 200_002);
    let budget = store::get_or_create_month(&mut tx, &month).await.unwrap();
    assert_eq!(
        (budget.reserved_micro_usd, budget.charged_micro_usd),
        (0, 200_002)
    );
    sqlx::query("DELETE FROM ai_jobs WHERE job_id=?1")
        .bind(&job.job_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let mut receipt = image_usage();
    receipt.metering.as_mut().unwrap()[0].quantity = 0;
    let attempt = job.attempt_id.as_deref().unwrap();
    assert!(
        !usage::reconcile(&mut tx, "wrong-owner", &job.job_id, attempt, 1, &receipt)
            .await
            .unwrap()
    );
    assert!(!usage::reconcile(
        &mut tx,
        &job.owner_instance_id,
        &job.job_id,
        "wrong-attempt",
        1,
        &receipt
    )
    .await
    .unwrap());
    assert!(usage::reconcile(
        &mut tx,
        &job.owner_instance_id,
        &job.job_id,
        attempt,
        1,
        &receipt
    )
    .await
    .unwrap());
    assert!(usage::reconcile(
        &mut tx,
        &job.owner_instance_id,
        &job.job_id,
        attempt,
        1,
        &receipt
    )
    .await
    .unwrap());
    assert!(!usage::reconcile(
        &mut tx,
        &job.owner_instance_id,
        &job.job_id,
        attempt,
        2,
        &image_usage()
    )
    .await
    .unwrap());
    let entry = store::find_usage_entry(&mut *tx, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            entry.usage_state.as_str(),
            entry.accounted_micro_usd,
            entry.revision
        ),
        ("reported", 200_001, 2)
    );
    let budget = store::get_or_create_month(&mut tx, &month).await.unwrap();
    assert_eq!(
        (budget.reserved_micro_usd, budget.charged_micro_usd),
        (0, 200_001)
    );
    tx.commit().await.unwrap();
    state.audio.shutdown();
    handle.join().unwrap();
    state.db.close().await;
}

#[tokio::test]
async fn pending_image_receipt_survives_cancellation_and_pre_dispatch_image_releases_reservation() {
    let (state, handle) = jobs_state().await;
    let sent = image_job(&state, "pending-image", true).await;
    usage::persist_pending_usage(&state.db, &sent, &image_usage())
        .await
        .unwrap();
    let unsent = image_job(&state, "unsent-image", false).await;
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    usage::settle_terminal(&mut tx, &sent, None, now_ms())
        .await
        .unwrap();
    usage::settle_terminal(&mut tx, &unsent, None, now_ms())
        .await
        .unwrap();
    let entry = store::find_usage_entry(&mut *tx, &sent.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.usage_state, "reported");
    assert_eq!(entry.accounted_micro_usd, 200_002);
    assert_eq!(
        serde_json::from_str::<TrustedUsage>(entry.reported_usage.as_deref().unwrap()).unwrap(),
        image_usage()
    );
    assert!(
        store::find_pending_usage(&mut tx, &sent.job_id, sent.attempt_id.as_deref().unwrap())
            .await
            .unwrap()
            .is_none()
    );
    let entry = store::find_usage_entry(&mut *tx, &unsent.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (entry.usage_state.as_str(), entry.accounted_micro_usd),
        ("released", 0)
    );
    let budget = store::get_or_create_month(&mut tx, &utc_month_key(sent.created_at))
        .await
        .unwrap();
    assert_eq!(
        (budget.reserved_micro_usd, budget.charged_micro_usd),
        (0, 200_002)
    );
    tx.commit().await.unwrap();
    state.audio.shutdown();
    handle.join().unwrap();
    state.db.close().await;
}

#[tokio::test]
async fn mismatched_image_usage_keeps_reserved_estimate_and_latches_original_budget_guard() {
    let (state, handle) = jobs_state().await;
    let job = image_job(&state, "mismatched-image", true).await;
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    usage::settle_terminal(&mut tx, &job, Some(&TrustedUsage::free()), now_ms())
        .await
        .unwrap();
    let entry = store::find_usage_entry(&mut *tx, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (entry.usage_state.as_str(), entry.accounted_micro_usd),
        ("unknown", 200_002)
    );
    assert!(store::budget_guard(&mut *tx).await.unwrap().unwrap().halted);
    tx.commit().await.unwrap();
    state.audio.shutdown();
    handle.join().unwrap();
    state.db.close().await;
}

#[tokio::test]
async fn over_reservation_image_usage_is_charged_in_full_and_stops_new_admission() {
    let (state, handle) = jobs_state().await;
    let job = image_job(&state, "over-image", true).await;
    let mut receipt = image_usage();
    receipt.metering.as_mut().unwrap()[2].quantity = 3;
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    usage::settle_terminal(&mut tx, &job, Some(&receipt), now_ms())
        .await
        .unwrap();
    let entry = store::find_usage_entry(&mut *tx, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (entry.usage_state.as_str(), entry.accounted_micro_usd),
        ("reported", 600_002)
    );
    assert!(store::budget_guard(&mut *tx).await.unwrap().unwrap().halted);
    tx.commit().await.unwrap();
    assert!(submit(&state, "local-owner", "new text task", None)
        .await
        .is_err());
    state.audio.shutdown();
    handle.join().unwrap();
    state.db.close().await;
}

#[tokio::test]
async fn image_and_text_share_one_month_and_sqlite_rejects_invalid_or_changed_policy() {
    let (state, handle) = jobs_state().await;
    let job = image_job(&state, "policy-image", false).await;
    for mutation in 0..17 {
        let mut invalid = job.clone();
        invalid.job_id = format!("invalid-{mutation}");
        invalid.key = invalid.job_id.clone();
        match mutation {
            0 => invalid.capability = CAPABILITY.into(),
            1 => invalid.reservation_micro_usd = 500_001,
            2 => invalid.reservation_micro_usd = -1,
            3 => invalid.pricing_snapshot = "{}".into(),
            4 => invalid.pricing_snapshot = "not-json".into(),
            5 => invalid.reservation_limit_micro_usd = 50_000,
            6 => {
                invalid.pricing_snapshot = serde_json::to_string(&PricingSnapshot {
                    provider: "fake".into(),
                    model: "fake".into(),
                    quote: PriceQuote::fake(),
                    credential: None,
                })
                .unwrap()
            }
            7 => {
                let mut snapshot: Value = serde_json::from_str(&invalid.pricing_snapshot).unwrap();
                snapshot["dimensions"] = json!([null, null, null]);
                invalid.pricing_snapshot = snapshot.to_string();
            }
            8 => {
                invalid.run_deadline_ms = 30_000;
                invalid.reservation_limit_micro_usd = 50_000;
                invalid.reservation_micro_usd = 0;
            }
            9 => {
                invalid.run_deadline_ms = 30_000;
                invalid.reservation_limit_micro_usd = 50_000;
                invalid.reservation_micro_usd = 0;
                invalid.pricing_snapshot = json!({"pricingVersion":"metered-v3"}).to_string();
            }
            _ => {
                let mut snapshot: Value = serde_json::from_str(&invalid.pricing_snapshot).unwrap();
                match mutation {
                    10 => snapshot["dimensions"][1]["dimension"] = json!("inputTokens"),
                    11 => snapshot["dimensions"][2]["quantityLimit"] = json!(2),
                    12 => snapshot["dimensions"][0]["unitScale"] = json!(0),
                    13 => {
                        snapshot["dimensions"][0]
                            .as_object_mut()
                            .unwrap()
                            .remove("unitPriceMicroUsd");
                    }
                    14 => snapshot["dimensions"][2]["imageSku"] = json!({}),
                    15 => snapshot["inputMicroUsdPerMillion"] = json!(0),
                    _ => {
                        snapshot["dimensions"][0]["imageSku"] =
                            snapshot["dimensions"][2]["imageSku"].clone()
                    }
                }
                invalid.pricing_snapshot = snapshot.to_string();
            }
        }
        assert!(
            store::insert_job(&state.db, &invalid).await.is_err(),
            "policy mutation {mutation}"
        );
    }
    assert!(
        sqlx::query("UPDATE ai_jobs SET run_deadline_ms=30000 WHERE job_id=?1")
            .bind(&job.job_id)
            .execute(&state.db)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE ai_jobs SET reservation_micro_usd=0 WHERE job_id=?1")
            .bind(&job.job_id)
            .execute(&state.db)
            .await
            .is_err()
    );
    let month = utc_month_key(job.created_at);
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    store::settle(
        &mut tx,
        &month,
        0,
        MONTHLY_LIMIT_MICRO_USD - job.reservation_micro_usd - 49_999,
    )
    .await
    .unwrap();
    assert!(
        store::reserve(&mut tx, &month, 50_000, MONTHLY_LIMIT_MICRO_USD)
            .await
            .is_err()
    );
    assert!(
        store::reserve(&mut tx, &month, 49_999, MONTHLY_LIMIT_MICRO_USD)
            .await
            .is_ok()
    );
    tx.commit().await.unwrap();
    state.audio.shutdown();
    handle.join().unwrap();
    state.db.close().await;
}
