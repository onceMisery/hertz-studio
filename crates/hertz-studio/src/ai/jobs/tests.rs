// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! `ai::jobs` 的回归测试。

use super::*;

#[test]
fn pre_dispatch_cancellation_detects_notified_and_closed_watch_channels() {
    let (sender, receiver) = tokio::sync::watch::channel(());
    assert!(!cancellation_pending(&receiver));
    sender.send(()).unwrap();
    assert!(cancellation_pending(&receiver));

    let (sender, receiver) = tokio::sync::watch::channel(());
    drop(sender);
    assert!(cancellation_pending(&receiver));
}

struct PanickingProvider {
    panic_before_dispatch: bool,
    ready_calls: std::sync::atomic::AtomicUsize,
}

impl StageIntentProvider for PanickingProvider {
    fn id(&self) -> &'static str {
        "panic-test"
    }
    fn model(&self) -> &'static str {
        "panic-v1"
    }
    fn ready(&self) -> bool {
        if self.panic_before_dispatch
            && self
                .ready_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                > 0
        {
            panic!("fixture panic before dispatch");
        }
        true
    }
    fn quote(&self, _: &str) -> Result<PriceQuote, String> {
        Ok(PriceQuote::fake())
    }
    fn generate(
        &self,
        _: String,
        _: PricingSnapshot,
        _: Option<crate::ai::credential::ProviderCredential>,
        _: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
        Box::pin(async { panic!("fixture panic during provider call") })
    }
}

struct BlockedProvider {
    counter: Arc<std::sync::atomic::AtomicUsize>,
    gate: Arc<std::sync::atomic::AtomicBool>,
}

struct TokenOnlyProvider;

struct BlockedTokenOnlyProvider {
    counter: Arc<std::sync::atomic::AtomicUsize>,
    gate: Arc<std::sync::atomic::AtomicBool>,
}

impl StageIntentProvider for TokenOnlyProvider {
    fn id(&self) -> &'static str {
        "token-only-fixture"
    }
    fn model(&self) -> &'static str {
        "bounded-v1"
    }
    fn ready(&self) -> bool {
        true
    }
    fn quote(&self, _: &str) -> Result<PriceQuote, String> {
        Ok(PriceQuote {
            pricing_version: usage::TOKEN_ONLY_PRICING_VERSION.into(),
            reservation_micro_usd: 0,
            input_micro_usd_per_million: 0,
            output_micro_usd_per_million: 0,
            max_input_tokens: 20_000,
            max_output_tokens: 8_000,
        })
    }
    fn generate(
        &self,
        _: String,
        _: PricingSnapshot,
        _: Option<crate::ai::credential::ProviderCredential>,
        _: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
        Box::pin(async {
            ProviderReply {
                intent: Ok(json!({ "version": 1, "scene": "orb", "patch": {} })),
                usage: Some(TrustedUsage {
                    input_tokens: 345,
                    output_tokens: 67,
                }),
            }
        })
    }
}

impl StageIntentProvider for BlockedTokenOnlyProvider {
    fn id(&self) -> &'static str {
        "token-only-blocked-fixture"
    }
    fn model(&self) -> &'static str {
        "bounded-v1"
    }
    fn ready(&self) -> bool {
        true
    }
    fn quote(&self, _: &str) -> Result<PriceQuote, String> {
        Ok(PriceQuote {
            pricing_version: usage::TOKEN_ONLY_PRICING_VERSION.into(),
            reservation_micro_usd: 0,
            input_micro_usd_per_million: 0,
            output_micro_usd_per_million: 0,
            max_input_tokens: 20_000,
            max_output_tokens: 8_000,
        })
    }
    fn generate(
        &self,
        _: String,
        _: PricingSnapshot,
        _: Option<crate::ai::credential::ProviderCredential>,
        _: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
        let counter = self.counter.clone();
        let gate = self.gate.clone();
        Box::pin(async move {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            while !gate.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            ProviderReply {
                intent: Ok(json!({ "version": 1, "scene": "orb", "patch": {} })),
                usage: Some(TrustedUsage {
                    input_tokens: 345,
                    output_tokens: 67,
                }),
            }
        })
    }
}

impl StageIntentProvider for BlockedProvider {
    fn id(&self) -> &'static str {
        "test"
    }
    fn model(&self) -> &'static str {
        "test-v1"
    }
    fn ready(&self) -> bool {
        true
    }
    fn quote(&self, _: &str) -> Result<PriceQuote, String> {
        Ok(PriceQuote::fake())
    }
    fn generate(
        &self,
        _brief: String,
        _pricing: PricingSnapshot,
        _credential: Option<crate::ai::credential::ProviderCredential>,
        _cancellation: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
        let counter = self.counter.clone();
        let gate = self.gate.clone();
        Box::pin(async move {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // 轮询闸门：不依赖唤醒顺序，晚到的调用者也能等到放行。
            while !gate.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            ProviderReply {
                intent: Ok(json!({ "version": 1, "scene": "orb", "patch": {} })),
                usage: None,
            }
        })
    }
}

async fn jobs_state() -> (Arc<AppState>, std::thread::JoinHandle<()>) {
    let dir = std::env::temp_dir().join(format!("vmusic-aijobs-{}", uuid::Uuid::new_v4()));
    let db = vmusic_store::open(&dir).await.unwrap();
    let (state, handle) = crate::state::tests::playback_state_with_db(db).await;
    // 测试进程模拟「持锁服务」：生成受理的门禁打开。
    state
        .ai_runner_held
        .store(true, std::sync::atomic::Ordering::Relaxed);
    vmusic_store::settings::set(&state.db, CONSENT_KEY, &serde_json::Value::Bool(true))
        .await
        .unwrap();
    (Arc::new(state), handle)
}

struct CredentialFixture {
    calls: Arc<std::sync::atomic::AtomicUsize>,
    gate: Arc<std::sync::atomic::AtomicBool>,
    expected: &'static str,
}

impl StageIntentProvider for CredentialFixture {
    fn id(&self) -> &'static str {
        "credential-fixture"
    }
    fn model(&self) -> &'static str {
        "free-fixture-v1"
    }
    fn ready(&self) -> bool {
        true
    }
    fn requires_credential(&self) -> bool {
        true
    }
    fn quote(&self, _: &str) -> Result<PriceQuote, String> {
        Ok(PriceQuote::fake())
    }
    fn generate(
        &self,
        _: String,
        _: PricingSnapshot,
        credential: Option<crate::ai::credential::ProviderCredential>,
        _cancellation: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
        let calls = self.calls.clone();
        let gate = self.gate.clone();
        let expected = self.expected;
        Box::pin(async move {
            assert_eq!(credential.unwrap().as_ref(), expected);
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            while !gate.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            ProviderReply {
                intent: Ok(json!({"version":1,"scene":"orb","patch":{}})),
                usage: Some(TrustedUsage::free()),
            }
        })
    }
}

async fn save_fixture_key(
    state: &Arc<AppState>,
    value: &str,
) -> ApiResult<super::super::credential::CredentialStatus> {
    let request =
        super::super::credential::CredentialRequest::from_value(&json!({"api_key":value}))?;
    super::super::credential::put(state, request).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn credential_mutation_cancels_queued_jobs_and_preserves_free_jobs() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    for delete in [false, true] {
        let (state, handle) = jobs_state().await;
        save_fixture_key(&state, "old-fixture-key").await.unwrap();
        let (evaluation_cancel, evaluation_cancel_rx) = tokio::sync::watch::channel(());
        state
            .ai_runtime
            .register_evaluation("credential-rotation-test".into(), evaluation_cancel, true)
            .await;
        let (local_cancel, local_cancel_rx) = tokio::sync::watch::channel(());
        state
            .ai_runtime
            .register_evaluation("local-evaluation-test".into(), local_cancel, false)
            .await;
        let calls = Arc::new(AtomicUsize::new(0));
        state
            .ai_runtime
            .install_provider(Arc::new(CredentialFixture {
                calls: calls.clone(),
                gate: Arc::new(AtomicBool::new(true)),
                expected: "old-fixture-key",
            }))
            .await;
        let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
        let SubmitOutcome::Accepted { job } =
            submit(&state, "local-owner", "queued keyed job", None)
                .await
                .unwrap()
        else {
            panic!()
        };
        let row = store::find_job_by_id(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        let frozen: PricingSnapshot = serde_json::from_str(&row.pricing_snapshot).unwrap();
        assert!(frozen.credential.is_some());
        assert!(!row.pricing_snapshot.contains("old-fixture-key"));
        state
            .ai_runtime
            .install_provider(Arc::new(FakeProvider))
            .await;
        let SubmitOutcome::Accepted { job: free } =
            submit(&state, "local-owner", "independent free job", None)
                .await
                .unwrap()
        else {
            panic!()
        };
        if delete {
            super::super::credential::delete(&state).await.unwrap();
        } else {
            save_fixture_key(&state, "new-fixture-key").await.unwrap();
        }
        assert!(evaluation_cancel_rx.has_changed().unwrap());
        assert!(!local_cancel_rx.has_changed().unwrap());
        state
            .ai_runtime
            .remove_evaluation("credential-rotation-test")
            .await;
        state
            .ai_runtime
            .remove_evaluation("local-evaluation-test")
            .await;
        let cancelled = store::find_job_by_id(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cancelled.state, "cancelled");
        assert_eq!(cancelled.dispatch_state, "not_dispatched");
        let usage = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(usage.accounted_micro_usd, 0);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            store::find_job_by_id(&state.db, &free.job_id)
                .await
                .unwrap()
                .unwrap()
                .state,
            "accepted"
        );
        drop(slot);
        assert_eq!(
            await_terminal(&state, &free.job_id).await.state,
            "succeeded"
        );
        state.audio.shutdown();
        handle.join().unwrap();
        state.db.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn frozen_credential_is_delivered_only_to_matching_dispatch_and_missing_key_reserves_nothing()
{
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let (state, handle) = jobs_state().await;
    let calls = Arc::new(AtomicUsize::new(0));
    state
        .ai_runtime
        .install_provider(Arc::new(CredentialFixture {
            calls: calls.clone(),
            gate: Arc::new(AtomicBool::new(true)),
            expected: "exact-fixture-key",
        }))
        .await;
    assert_eq!(
        submit(&state, "local-owner", "no credential", None)
            .await
            .err()
            .unwrap()
            .code,
        "ai_credential_missing"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_jobs")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    save_fixture_key(&state, "exact-fixture-key").await.unwrap();
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "matching credential", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    assert_eq!(await_terminal(&state, &job.job_id).await.state, "succeeded");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    state.audio.shutdown();
    handle.join().unwrap();
    state.db.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn credential_rotation_keeps_sent_accounting_and_execution_owner_until_reply() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let (state, handle) = jobs_state().await;
    save_fixture_key(&state, "old-fixture-key").await.unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(CredentialFixture {
            calls: calls.clone(),
            gate: gate.clone(),
            expected: "old-fixture-key",
        }))
        .await;
    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "already sent", None)
        .await
        .unwrap()
    else {
        panic!()
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    save_fixture_key(&state, "new-fixture-key").await.unwrap();
    let cancelled = store::find_job_by_id(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cancelled.state, "cancelled");
    assert_eq!(cancelled.dispatch_state, "may_have_been_sent");
    assert_eq!(state.ai_runtime.execution_slots.available_permits(), 0);
    assert_eq!(
        store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap()
            .accounted_micro_usd,
        RESERVATION_MICRO_USD
    );
    state
        .ai_runtime
        .install_provider(Arc::new(CredentialFixture {
            calls: calls.clone(),
            gate: Arc::new(AtomicBool::new(true)),
            expected: "new-fixture-key",
        }))
        .await;
    let SubmitOutcome::Accepted { job: next } =
        submit(&state, "local-owner", "new generation", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    gate.store(true, Ordering::SeqCst);
    assert_eq!(
        await_terminal(&state, &next.job_id).await.state,
        "succeeded"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        store::find_job_by_id(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        "cancelled"
    );
    assert_eq!(
        store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap()
            .accounted_micro_usd,
        0
    );
    state.audio.shutdown();
    handle.join().unwrap();
    state.db.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn credential_mutation_survives_waiter_loss_and_db_failure_prevents_os_write() {
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    let (state, handle) = jobs_state().await;
    save_fixture_key(&state, "old-fixture-key").await.unwrap();
    state
        .ai_runtime
        .install_provider(Arc::new(CredentialFixture {
            calls: Arc::new(AtomicUsize::new(0)),
            gate: Arc::new(AtomicBool::new(true)),
            expected: "old-fixture-key",
        }))
        .await;
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "mutation rollback", None)
        .await
        .unwrap()
    else {
        panic!()
    };
    sqlx::query("CREATE TRIGGER fail_credential_cancel BEFORE UPDATE OF state ON ai_jobs BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
        .execute(&state.db).await.unwrap();
    assert!(save_fixture_key(&state, "must-not-be-written")
        .await
        .is_err());
    assert_eq!(
        store::find_job_by_id(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        "accepted"
    );
    let owner = instance_owner(&state).await.unwrap();
    assert_eq!(
        state
            .ai_runtime
            .credentials
            .snapshot(&owner)
            .await
            .unwrap()
            .into_secret()
            .as_ref(),
        "old-fixture-key"
    );
    sqlx::query("DROP TRIGGER fail_credential_cancel")
        .execute(&state.db)
        .await
        .unwrap();
    let tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    let started = state.ai_runtime.credentials.mutation_started.notified();
    tokio::pin!(started);
    started.as_mut().enable();
    let waiter_state = state.clone();
    let waiter =
        tokio::spawn(async move { save_fixture_key(&waiter_state, "new-fixture-key").await });
    // Observe acquisition without taking competing read leases ourselves.
    tokio::time::timeout(std::time::Duration::from_secs(2), started)
        .await
        .unwrap();
    waiter.abort();
    assert!(waiter.await.err().unwrap().is_cancelled());
    tx.rollback().await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            match state.ai_runtime.credentials.snapshot(&owner).await {
                Ok(lease) => {
                    assert_eq!(lease.into_secret().as_ref(), "new-fixture-key");
                    break;
                }
                Err(error) if error.code == "ai_credential_busy" => tokio::task::yield_now().await,
                Err(error) => panic!("unexpected snapshot error: {}", error.code),
            }
        }
    })
    .await
    .unwrap();
    let row = store::find_job_by_id(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.state, "cancelled");
    assert_eq!(row.dispatch_state, "not_dispatched");
    let SubmitOutcome::Replayed { job: replay } =
        submit(&state, "local-owner", "mutation rollback", Some(&row.key))
            .await
            .unwrap()
    else {
        panic!()
    };
    assert_eq!(replay.state, "cancelled");
    drop(slot);
    state.audio.shutdown();
    handle.join().unwrap();
    state.db.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stale_persisted_credential_identity_never_marks_dispatch_or_calls_provider() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let (state, handle) = jobs_state().await;
    save_fixture_key(&state, "current-fixture-key")
        .await
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    state
        .ai_runtime
        .install_provider(Arc::new(CredentialFixture {
            calls: calls.clone(),
            gate: Arc::new(AtomicBool::new(true)),
            expected: "current-fixture-key",
        }))
        .await;
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "stale restored snapshot", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    let row = store::find_job_by_id(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    let mut snapshot: Value = serde_json::from_str(&row.pricing_snapshot).unwrap();
    snapshot["credential"]["generation"] = json!(uuid::Uuid::new_v4().to_string());
    sqlx::query("UPDATE ai_jobs SET pricing_snapshot = ?1 WHERE job_id = ?2")
        .bind(snapshot.to_string())
        .bind(&job.job_id)
        .execute(&state.db)
        .await
        .unwrap();
    drop(slot);
    let terminal = await_terminal(&state, &job.job_id).await;
    assert_eq!(terminal.state, "cancelled");
    assert_eq!(terminal.dispatch_state, "not_dispatched");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap()
            .accounted_micro_usd,
        0
    );
    state.audio.shutdown();
    handle.join().unwrap();
    state.db.close().await;
}

#[tokio::test]
async fn credential_management_requires_runner_ownership_but_not_generation_consent() {
    let (state, handle) = jobs_state().await;
    vmusic_store::settings::set(&state.db, CONSENT_KEY, &Value::Bool(false))
        .await
        .unwrap();
    save_fixture_key(&state, "owner-fixture-key").await.unwrap();
    state
        .ai_runner_held
        .store(false, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(
        save_fixture_key(&state, "must-not-change")
            .await
            .err()
            .unwrap()
            .code,
        "ai_locked"
    );
    assert_eq!(
        super::super::credential::delete(&state)
            .await
            .err()
            .unwrap()
            .code,
        "ai_locked"
    );
    assert_eq!(
        super::super::credential::status(&state)
            .await
            .err()
            .unwrap()
            .code,
        "ai_locked"
    );
    state
        .ai_runner_held
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let owner = instance_owner(&state).await.unwrap();
    assert_eq!(
        state
            .ai_runtime
            .credentials
            .snapshot(&owner)
            .await
            .unwrap()
            .into_secret()
            .as_ref(),
        "owner-fixture-key"
    );
    super::super::credential::delete(&state).await.unwrap();
    state.audio.shutdown();
    handle.join().unwrap();
    state.db.close().await;
}

struct MeteredProvider {
    gate: Arc<std::sync::atomic::AtomicBool>,
    rate: Arc<std::sync::atomic::AtomicU64>,
    reply: Result<Value, String>,
    usage: Option<TrustedUsage>,
}

fn metered_quote() -> PriceQuote {
    PriceQuote {
        pricing_version: "test-prices-v1".into(),
        reservation_micro_usd: 30_000,
        input_micro_usd_per_million: 1_000_000,
        output_micro_usd_per_million: 2_000_000,
        max_input_tokens: 10_000,
        max_output_tokens: 10_000,
    }
}

impl StageIntentProvider for MeteredProvider {
    fn id(&self) -> &'static str {
        "metered-test"
    }
    fn model(&self) -> &'static str {
        "metered-v1"
    }
    fn ready(&self) -> bool {
        true
    }
    fn quote(&self, _: &str) -> Result<PriceQuote, String> {
        let mut quote = metered_quote();
        quote.input_micro_usd_per_million = self.rate.load(std::sync::atomic::Ordering::SeqCst);
        Ok(quote)
    }
    fn generate(
        &self,
        _: String,
        pricing: PricingSnapshot,
        _credential: Option<crate::ai::credential::ProviderCredential>,
        _cancellation: ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
        let gate = self.gate.clone();
        let reply = self.reply.clone();
        let usage = self.usage.clone();
        Box::pin(async move {
            assert_eq!(pricing.quote.pricing_version, "test-prices-v1");
            while !gate.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            ProviderReply {
                intent: reply,
                usage,
            }
        })
    }
}

fn metered(
    gate: bool,
    reply: Result<Value, String>,
    usage: Option<TrustedUsage>,
) -> MeteredProvider {
    MeteredProvider {
        gate: Arc::new(std::sync::atomic::AtomicBool::new(gate)),
        rate: Arc::new(std::sync::atomic::AtomicU64::new(1_000_000)),
        reply,
        usage,
    }
}

async fn await_terminal(state: &Arc<AppState>, id: &str) -> store::JobRow {
    for _ in 0..2000 {
        let row = job_row(state, id).await;
        if !matches!(row.state.as_str(), "accepted" | "running") {
            return row;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("task did not finish");
}

async fn await_usage_entry(state: &Arc<AppState>, id: &str) -> store::UsageEntryRow {
    for _ in 0..2000 {
        if let Some(entry) = store::find_usage_entry(&state.db, id).await.unwrap() {
            return entry;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("usage entry missing");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_panics_interrupt_and_settle_according_to_dispatch_state() {
    let (state, handle) = jobs_state().await;
    for (panic_before_dispatch, expected_dispatch, expected_usage, expected_charge) in [
        (true, "not_dispatched", "released", 0),
        (
            false,
            "may_have_been_sent",
            "unknown",
            RESERVATION_MICRO_USD,
        ),
    ] {
        state
            .ai_runtime
            .install_provider(Arc::new(PanickingProvider {
                panic_before_dispatch,
                ready_calls: std::sync::atomic::AtomicUsize::new(0),
            }))
            .await;
        let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "panic fixture", None)
            .await
            .unwrap()
        else {
            panic!()
        };
        let terminal = await_terminal(&state, &job.job_id).await;
        assert_eq!(terminal.state, "interrupted");
        assert_eq!(terminal.dispatch_state, expected_dispatch);
        let usage = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(usage.usage_state, expected_usage);
        assert_eq!(usage.accounted_micro_usd, expected_charge);
        assert!(!state
            .ai_runtime
            .inputs
            .lock()
            .await
            .contains_key(&job.job_id));
        assert_eq!(state.ai_runtime.execution_slots.available_permits(), 1);
    }
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closed_execution_slot_interrupts_and_releases_accepted_task() {
    let (state, handle) = jobs_state().await;
    let held_slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "closed slot fixture", None)
            .await
            .unwrap()
    else {
        panic!()
    };

    state.ai_runtime.execution_slots.close();
    let terminal = await_terminal(&state, &job.job_id).await;
    assert_eq!(terminal.state, "interrupted");
    assert_eq!(terminal.dispatch_state, "not_dispatched");
    let usage = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "released");
    assert_eq!(usage.accounted_micro_usd, 0);
    assert!(!state
        .ai_runtime
        .inputs
        .lock()
        .await
        .contains_key(&job.job_id));

    drop(held_slot);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn running_transition_storage_error_interrupts_accepted_task() {
    let (state, handle) = jobs_state().await;
    sqlx::query("CREATE TRIGGER fail_running_transition BEFORE UPDATE OF state ON ai_jobs WHEN OLD.state = 'accepted' AND NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'fixture transition failure'); END")
        .execute(&state.db)
        .await
        .unwrap();
    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "transition fixture", None)
        .await
        .unwrap()
    else {
        panic!()
    };

    let terminal = await_terminal(&state, &job.job_id).await;
    assert_eq!(terminal.state, "interrupted");
    assert_eq!(terminal.dispatch_state, "not_dispatched");
    let usage = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "released");
    assert_eq!(usage.accounted_micro_usd, 0);
    assert!(!state
        .ai_runtime
        .inputs
        .lock()
        .await
        .contains_key(&job.job_id));

    sqlx::query("DROP TRIGGER fail_running_transition")
        .execute(&state.db)
        .await
        .unwrap();
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_settlement_error_interrupts_and_conservatively_charges_dispatched_task() {
    let (state, handle) = jobs_state().await;
    state
        .ai_runtime
        .install_provider(Arc::new(metered(
            true,
            Err("fixture provider failure".into()),
            None,
        )))
        .await;
    sqlx::query("CREATE TRIGGER fail_failed_transition BEFORE UPDATE OF state ON ai_jobs WHEN OLD.state = 'running' AND NEW.state = 'failed' BEGIN SELECT RAISE(ABORT, 'fixture terminal failure'); END")
        .execute(&state.db)
        .await
        .unwrap();
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "terminal failure fixture", None)
            .await
            .unwrap()
    else {
        panic!()
    };

    let terminal = await_terminal(&state, &job.job_id).await;
    assert_eq!(terminal.state, "interrupted");
    assert_eq!(terminal.dispatch_state, "may_have_been_sent");
    let usage = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "unknown");
    assert_eq!(usage.accounted_micro_usd, terminal.reservation_micro_usd);
    assert!(!state
        .ai_runtime
        .inputs
        .lock()
        .await
        .contains_key(&job.job_id));
    assert_eq!(state.ai_runtime.execution_slots.available_permits(), 1);

    sqlx::query("DROP TRIGGER fail_failed_transition")
        .execute(&state.db)
        .await
        .unwrap();
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exhausted_connection_pool_releases_worker_after_cleanup_deadline() {
    let (state, handle) = jobs_state().await;
    let provider = metered(false, Err("fixture provider failure".into()), None);
    let gate = provider.gate.clone();
    state.ai_runtime.install_provider(Arc::new(provider)).await;
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "pool exhaustion fixture", None)
            .await
            .unwrap()
    else {
        panic!("fixture task must be accepted")
    };

    let mut dispatched = false;
    for _ in 0..400 {
        let row = job_row(&state, &job.job_id).await;
        if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
            dispatched = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(dispatched, "fixture provider must be held after dispatch");

    let mut held_connections = Vec::with_capacity(4);
    for _ in 0..4 {
        held_connections.push(state.db.acquire().await.unwrap());
    }
    assert_eq!(
        state.db.size(),
        4,
        "all production pool connections are held"
    );

    let cleanup_started = std::time::Instant::now();
    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    tokio::time::timeout(
        std::time::Duration::from_millis(TERMINAL_CLEANUP_TIMEOUT_MS + 1_500),
        async {
            loop {
                let owns_input = state
                    .ai_runtime
                    .inputs
                    .lock()
                    .await
                    .contains_key(&job.job_id);
                if !owns_input && state.ai_runtime.execution_slots.available_permits() == 1 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        },
    )
    .await
    .expect("worker must release its in-memory owner and execution slot");
    assert!(
        cleanup_started.elapsed()
            < std::time::Duration::from_millis(TERMINAL_CLEANUP_TIMEOUT_MS + 1_000),
        "cleanup must respect the shared total deadline"
    );

    drop(held_connections);
    assert_eq!(job_row(&state, &job.job_id).await.state, "running");
    sweep(&state).await.unwrap();
    let recovered = job_row(&state, &job.job_id).await;
    assert_eq!(recovered.state, "interrupted");
    assert_eq!(recovered.dispatch_state, "may_have_been_sent");
    let usage = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "unknown");

    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn transient_interruption_settlement_error_retries_before_releasing_worker() {
    let (state, handle) = jobs_state().await;
    let provider = metered(false, Err("fixture provider failure".into()), None);
    let gate = provider.gate.clone();
    state.ai_runtime.install_provider(Arc::new(provider)).await;
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "transient terminal fixture", None)
            .await
            .unwrap()
    else {
        panic!()
    };

    let mut dispatched = false;
    for _ in 0..400 {
        let row = job_row(&state, &job.job_id).await;
        if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
            dispatched = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(dispatched, "fixture provider must be held after dispatch");

    let fail_until = now_ms() + 500;
    let trigger = format!(
        "CREATE TRIGGER fail_transient_terminal BEFORE UPDATE OF state ON ai_jobs \
         WHEN OLD.state = 'running' AND NEW.state IN ('failed', 'interrupted') \
         AND NEW.updated_at < {fail_until} \
         BEGIN SELECT RAISE(ABORT, 'fixture transient terminal failure'); END"
    );
    sqlx::query(&trigger).execute(&state.db).await.unwrap();
    let retry_started = std::time::Instant::now();
    gate.store(true, std::sync::atomic::Ordering::SeqCst);

    let terminal = await_terminal(&state, &job.job_id).await;
    assert_eq!(terminal.state, "interrupted");
    assert_eq!(terminal.dispatch_state, "may_have_been_sent");
    assert!(
        retry_started.elapsed() >= std::time::Duration::from_millis(750),
        "the persisted time window must force multiple bounded attempts"
    );
    let usage = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "unknown");
    assert_eq!(usage.accounted_micro_usd, terminal.reservation_micro_usd);
    assert!(!state
        .ai_runtime
        .inputs
        .lock()
        .await
        .contains_key(&job.job_id));
    assert_eq!(state.ai_runtime.execution_slots.available_permits(), 1);

    sqlx::query("DROP TRIGGER fail_transient_terminal")
        .execute(&state.db)
        .await
        .unwrap();
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exhausted_interruption_retries_are_swept_by_status_query() {
    let (state, handle) = jobs_state().await;
    let provider = metered(false, Err("fixture provider failure".into()), None);
    let gate = provider.gate.clone();
    state.ai_runtime.install_provider(Arc::new(provider)).await;
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "persistent terminal fixture", None)
            .await
            .unwrap()
    else {
        panic!()
    };

    let mut dispatched = false;
    for _ in 0..400 {
        let row = job_row(&state, &job.job_id).await;
        if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
            dispatched = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(dispatched, "fixture provider must be held after dispatch");

    let fail_until = now_ms() + 10_000;
    let trigger = format!(
        "CREATE TRIGGER fail_persistent_terminal BEFORE UPDATE OF state ON ai_jobs \
         WHEN OLD.state = 'running' AND NEW.state IN ('failed', 'interrupted') \
         AND NEW.updated_at < {fail_until} \
         BEGIN SELECT RAISE(ABORT, 'fixture persistent terminal failure'); END"
    );
    sqlx::query(&trigger).execute(&state.db).await.unwrap();
    gate.store(true, std::sync::atomic::Ordering::SeqCst);

    let mut worker_released = false;
    for _ in 0..600 {
        let owns_input = state
            .ai_runtime
            .inputs
            .lock()
            .await
            .contains_key(&job.job_id);
        if !owns_input && state.ai_runtime.execution_slots.available_permits() == 1 {
            worker_released = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(worker_released, "worker must release after bounded retries");
    let stranded = job_row(&state, &job.job_id).await;
    assert_eq!(stranded.state, "running");
    assert_eq!(stranded.dispatch_state, "may_have_been_sent");
    assert!(store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .is_none());

    let owner = instance_owner(&state).await.unwrap();
    sqlx::query("DROP TRIGGER fail_persistent_terminal")
        .execute(&state.db)
        .await
        .unwrap();
    sqlx::query("UPDATE ai_jobs SET updated_at = ?1 WHERE job_id = ?2")
        .bind(now_ms() - RUN_DEADLINE_MS - 1)
        .bind(&job.job_id)
        .execute(&state.db)
        .await
        .unwrap();

    let snapshot = status(&state, &owner).await.unwrap();
    assert_eq!(snapshot["queue"]["incomplete"], json!(0));
    let recovered = job_row(&state, &job.job_id).await;
    assert_eq!(recovered.state, "expired");
    let usage = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "unknown");
    assert_eq!(usage.accounted_micro_usd, recovered.reservation_micro_usd);

    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wall_clock_age_does_not_expire_a_live_queued_worker() {
    let (state, handle) = jobs_state().await;
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "expired while queued", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    sqlx::query("UPDATE ai_jobs SET created_at = ?1 WHERE job_id = ?2")
        .bind(now_ms() - QUEUE_DEADLINE_MS - 1)
        .bind(&job.job_id)
        .execute(&state.db)
        .await
        .unwrap();
    sweep(&state).await.unwrap();
    assert_eq!(job_row(&state, &job.job_id).await.state, "accepted");
    drop(slot);

    let terminal = await_terminal(&state, &job.job_id).await;
    assert_eq!(terminal.state, "succeeded");
    assert_eq!(terminal.dispatch_state, "may_have_been_sent");
    let usage = await_usage_entry(&state, &job.job_id).await;
    assert_eq!(usage.usage_state, "reported");
    assert_eq!(usage.accounted_micro_usd, 0);
    assert_eq!(state.ai_runtime.execution_slots.available_permits(), 1);
    assert!(!state
        .ai_runtime
        .inputs
        .lock()
        .await
        .contains_key(&job.job_id));
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn monotonic_queue_deadline_expires_even_if_wall_clock_is_unchanged() {
    let (state, handle) = jobs_state().await;
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "monotonic deadline fixture", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    let expired_deadline = tokio::time::Instant::now() - std::time::Duration::from_millis(1);

    assert!(start_running(&state, &job.job_id, expired_deadline)
        .await
        .unwrap()
        .is_none());
    let terminal = job_row(&state, &job.job_id).await;
    assert_eq!(terminal.state, "expired");
    assert_eq!(terminal.dispatch_state, "not_dispatched");
    let usage = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "released");
    assert_eq!(usage.accounted_micro_usd, 0);

    drop(slot);
    let worker_slot = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        state.ai_runtime.execution_slots.acquire(),
    )
    .await
    .unwrap()
    .unwrap();
    drop(worker_slot);
    assert_eq!(state.ai_runtime.execution_slots.available_permits(), 1);
    assert!(!state
        .ai_runtime
        .inputs
        .lock()
        .await
        .contains_key(&job.job_id));
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn trusted_usage_charges_success_invalid_output_and_provider_error() {
    let (state, handle) = jobs_state().await;
    let valid = json!({"version":1,"scene":"orb","patch":{}});
    for (reply, expected, failure_code, counters) in [
        (
            Ok(valid.clone()),
            "succeeded",
            None,
            Some(TrustedUsage {
                input_tokens: 123,
                output_tokens: 7,
            }),
        ),
        (
            Ok(json!({"bad":"candidate"})),
            "failed",
            Some("invalid_output"),
            Some(TrustedUsage {
                input_tokens: 123,
                output_tokens: 7,
            }),
        ),
        (
            Err("truncated response".into()),
            "failed",
            Some("provider_error"),
            Some(TrustedUsage {
                input_tokens: 123,
                output_tokens: 7,
            }),
        ),
        (Ok(valid), "succeeded", None, None),
    ] {
        state
            .ai_runtime
            .install_provider(Arc::new(metered(true, reply, counters.clone())))
            .await;
        let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "metered", None)
            .await
            .unwrap()
        else {
            panic!()
        };
        let terminal = await_terminal(&state, &job.job_id).await;
        assert_eq!(terminal.state, expected);
        assert_eq!(terminal.failure_code.as_deref(), failure_code);
        let view = get_job(&state, "local-owner", &job.job_id).await.unwrap();
        assert_eq!(view.failure_code.as_deref(), failure_code);
        assert_eq!(view.usage.reservation_micro_usd, 30_000);
        assert_eq!(
            view.usage.usage_state,
            if counters.is_some() {
                "reported"
            } else {
                "unknown"
            }
        );
        assert_eq!(
            view.usage.accounted_micro_usd,
            Some(if counters.is_some() { 137 } else { 30_000 })
        );
        assert!(get_job(&state, "another-principal", &job.job_id)
            .await
            .is_err());
    }
    let budget = status(&state, &instance_owner(&state).await.unwrap())
        .await
        .unwrap();
    assert_eq!(budget["budget"]["chargedMicroUsd"], 30_411);
    assert_eq!(budget["budget"]["reservedMicroUsd"], 0);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_keeps_its_terminal_state_but_late_usage_uses_frozen_prices() {
    let (state, handle) = jobs_state().await;
    let provider = metered(
        false,
        Ok(json!({"version":1,"scene":"orb","patch":{}})),
        Some(TrustedUsage {
            input_tokens: 123,
            output_tokens: 7,
        }),
    );
    let gate = provider.gate.clone();
    let rate = provider.rate.clone();
    state.ai_runtime.install_provider(Arc::new(provider)).await;
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "cancel then bill", None)
        .await
        .unwrap()
    else {
        panic!()
    };
    rate.store(10_000_000, std::sync::atomic::Ordering::SeqCst);
    drop(slot);
    for _ in 0..400 {
        if job_row(&state, &job.job_id).await.dispatch_state == "may_have_been_sent" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let running = job_row(&state, &job.job_id).await;
    assert_eq!(running.dispatch_state, "may_have_been_sent");
    let cancelled = cancel(&state, "local-owner", &job.job_id, running.state_revision)
        .await
        .unwrap();
    assert_eq!(cancelled.usage.accounted_micro_usd, Some(30_000));
    let mut events = state.events.subscribe();
    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    let _slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let latest = get_job(&state, "local-owner", &job.job_id).await.unwrap();
    assert_eq!(latest.state, "cancelled");
    assert_eq!(latest.state_revision, cancelled.state_revision);
    assert_eq!(latest.result_proposal_id, None);
    assert_eq!(latest.usage.accounted_micro_usd, Some(137));
    assert_eq!(latest.usage.usage_revision, 2);
    assert_eq!(latest.usage.usage_state, "reported");
    while let Ok(event) = events.try_recv() {
        assert!(matches!(event, WsEvent::AiTasksResync));
    }
    let row = job_row(&state, &job.job_id).await;
    let snapshot: PricingSnapshot = serde_json::from_str(&row.pricing_snapshot).unwrap();
    assert_eq!(snapshot.quote.input_micro_usd_per_million, 1_000_000);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn cooperative_cancellation_keeps_execution_slot_until_adapter_cleanup_finishes() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;
    struct CleanupProvider {
        calls: AtomicUsize,
        started: Notify,
        observed_cancel: Arc<Notify>,
        release: Arc<Notify>,
    }
    impl StageIntentProvider for CleanupProvider {
        fn id(&self) -> &'static str {
            "cleanup-fixture"
        }
        fn model(&self) -> &str {
            "cleanup-v1"
        }
        fn ready(&self) -> bool {
            true
        }
        fn quote(&self, _: &str) -> Result<PriceQuote, String> {
            Ok(metered_quote())
        }
        fn generate(
            &self,
            _: String,
            _: PricingSnapshot,
            _: Option<crate::ai::credential::ProviderCredential>,
            mut cancellation: ProviderCancellation,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
            let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
            let observed_cancel = self.observed_cancel.clone();
            let release = self.release.clone();
            self.started.notify_one();
            Box::pin(async move {
                if first {
                    cancellation.cancelled().await;
                    observed_cancel.notify_one();
                    release.notified().await;
                    ProviderReply {
                        intent: Err("cancelled transport finished cleanup".into()),
                        usage: None,
                    }
                } else {
                    ProviderReply {
                        intent: Ok(json!({"version":1,"scene":"orb","patch":{}})),
                        usage: Some(TrustedUsage::free()),
                    }
                }
            })
        }
    }
    let (state, handle) = jobs_state().await;
    let provider = Arc::new(CleanupProvider {
        calls: AtomicUsize::new(0),
        started: Notify::new(),
        observed_cancel: Arc::new(Notify::new()),
        release: Arc::new(Notify::new()),
    });
    state.ai_runtime.install_provider(provider.clone()).await;
    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "cancel transport", None)
        .await
        .unwrap()
    else {
        panic!()
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        provider.started.notified(),
    )
    .await
    .unwrap();
    let running = job_row(&state, &job.job_id).await;
    let terminal = cancel(&state, "local-owner", &job.job_id, running.state_revision)
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        provider.observed_cancel.notified(),
    )
    .await
    .unwrap();
    assert_eq!(terminal.state, "cancelled");
    assert_eq!(terminal.usage.usage_state, "unknown");
    assert_eq!(terminal.usage.accounted_micro_usd, Some(30_000));
    assert!(state.ai_runtime.execution_slots.try_acquire().is_err());
    let SubmitOutcome::Accepted { job: next } = submit(&state, "local-owner", "next request", None)
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(job_row(&state, &next.job_id).await.state, "accepted");
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    provider.release.notify_one();
    assert_eq!(
        await_terminal(&state, &next.job_id).await.state,
        "succeeded"
    );
    let slot = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        state.ai_runtime.execution_slots.acquire(),
    )
    .await
    .unwrap()
    .unwrap();
    let latest = get_job(&state, "local-owner", &job.job_id).await.unwrap();
    assert_eq!(latest.state, "cancelled");
    assert_eq!(latest.result_proposal_id, None);
    assert_eq!(latest.usage.usage_state, "unknown");
    assert_eq!(latest.usage.accounted_micro_usd, Some(30_000));
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    drop(slot);
    state.audio.shutdown();
    handle.join().unwrap();
}

async fn estimated_entry(state: &Arc<AppState>, id: &str) {
    let snapshot = PricingSnapshot {
        provider: "metered-test".into(),
        model: "metered-v1".into(),
        quote: metered_quote(),
        credential: None,
    };
    let owner = instance_owner(state).await.unwrap();
    let pricing_snapshot = serde_json::to_string(&snapshot).unwrap();
    store::insert_job(
        &state.db,
        &store::JobRow {
            job_id: id.into(),
            owner_instance_id: owner,
            principal: "local-owner".into(),
            capability: CAPABILITY.into(),
            key: format!("fixture-{id}"),
            input_hash: "fixture-hash".into(),
            state: "cancelled".into(),
            state_revision: 2,
            dispatch_state: "may_have_been_sent".into(),
            attempt_id: Some("original-attempt".into()),
            provider: snapshot.provider.clone(),
            model: snapshot.model.clone(),
            reservation_micro_usd: 30_000,
            pricing_snapshot: pricing_snapshot.clone(),
            created_at: 0,
            updated_at: 0,
            result_proposal_id: None,
            failure_code: None,
            provider_http_status: None,
        },
    )
    .await
    .unwrap();
    store::insert_usage_entry(
        &state.db,
        &store::UsageEntryInsert {
            job_id: id.into(),
            accepted_month: "2026-09".into(),
            attempt_id: Some("original-attempt".into()),
            reservation_micro_usd: 30_000,
            accounted_micro_usd: 30_000,
            usage_state: "estimated_final".into(),
            pricing_snapshot,
            reported_usage: None,
            revision: 2,
            created_at: 0,
        },
    )
    .await
    .unwrap();
    sqlx::query("DELETE FROM ai_jobs WHERE job_id = ?1")
        .bind(id)
        .execute(&state.db)
        .await
        .unwrap();
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    store::settle(&mut tx, "2026-09", 0, 30_000).await.unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn late_usage_is_cas_idempotent_in_original_month_without_a_job() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    estimated_entry(&state, "retained-ledger").await;
    let counters = TrustedUsage {
        input_tokens: 123,
        output_tokens: 7,
    };
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    store::settle(&mut tx, "2026-10", 0, 42).await.unwrap();
    assert!(!usage::reconcile(
        &mut tx,
        "wrong-owner",
        "retained-ledger",
        "original-attempt",
        2,
        &TrustedUsage {
            input_tokens: 10_001,
            output_tokens: 7,
        }
    )
    .await
    .unwrap());
    let unchanged = store::find_usage_entry(&mut *tx, "retained-ledger")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.revision, 2);
    assert_eq!(unchanged.accounted_micro_usd, 30_000);
    assert!(store::budget_guard(&mut *tx)
        .await
        .unwrap()
        .is_none_or(|guard| !guard.halted));
    for (attempt, revision) in [("wrong-attempt", 2), ("original-attempt", 1)] {
        assert!(!usage::reconcile(
            &mut tx,
            &owner,
            "retained-ledger",
            attempt,
            revision,
            &counters
        )
        .await
        .unwrap());
    }
    assert!(usage::reconcile(
        &mut tx,
        &owner,
        "retained-ledger",
        "original-attempt",
        2,
        &counters
    )
    .await
    .unwrap());
    let revised = store::find_usage_entry(&mut *tx, "retained-ledger")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(revised.revision, 3);
    let old = store::get_or_create_month(&mut tx, "2026-09")
        .await
        .unwrap();
    assert_eq!(old.charged_micro_usd, 137);
    assert_eq!(old.reserved_micro_usd, 0);
    let revision = old.revision;
    // Same callback with stale revision is a no-op. Conflicting facts never overwrite it.
    assert!(usage::reconcile(
        &mut tx,
        &owner,
        "retained-ledger",
        "original-attempt",
        2,
        &counters
    )
    .await
    .unwrap());
    assert!(!usage::reconcile(
        &mut tx,
        &owner,
        "retained-ledger",
        "original-attempt",
        3,
        &TrustedUsage::free()
    )
    .await
    .unwrap());
    assert!(!usage::reconcile(
        &mut tx,
        &owner,
        "retained-ledger",
        "another-attempt",
        3,
        &counters
    )
    .await
    .unwrap());
    assert_eq!(
        store::get_or_create_month(&mut tx, "2026-09")
            .await
            .unwrap()
            .revision,
        revision
    );
    assert_eq!(
        store::get_or_create_month(&mut tx, "2026-10")
            .await
            .unwrap()
            .charged_micro_usd,
        42
    );
    assert!(store::find_job_by_id(&mut *tx, "retained-ledger")
        .await
        .unwrap()
        .is_none());
    tx.commit().await.unwrap();
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn late_usage_and_month_adjustment_roll_back_together() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    estimated_entry(&state, "rollback").await;
    sqlx::query("CREATE TRIGGER fail_month BEFORE UPDATE ON ai_budget_months BEGIN SELECT RAISE(ABORT, 'month failure'); END")
        .execute(&state.db).await.unwrap();
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    assert!(usage::reconcile(
        &mut tx,
        &owner,
        "rollback",
        "original-attempt",
        2,
        &TrustedUsage {
            input_tokens: 1,
            output_tokens: 1
        }
    )
    .await
    .is_err());
    tx.rollback().await.unwrap();
    let entry = store::find_usage_entry(&state.db, "rollback")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.usage_state, "estimated_final");
    assert_eq!(entry.revision, 2);
    assert_eq!(entry.accounted_micro_usd, 30_000);
    let mut conn = state.db.acquire().await.unwrap();
    assert_eq!(
        store::get_or_create_month(&mut conn, "2026-09")
            .await
            .unwrap()
            .charged_micro_usd,
        30_000
    );
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn actual_over_reservation_halts_even_below_month_limit() {
    let (state, handle) = jobs_state().await;
    state
        .ai_runtime
        .install_provider(Arc::new(metered(
            true,
            Err("invalid output".into()),
            Some(TrustedUsage {
                input_tokens: 40_000,
                output_tokens: 7,
            }),
        )))
        .await;
    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "over bound", None)
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(await_terminal(&state, &job.job_id).await.state, "failed");
    let entry = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.accounted_micro_usd, 40_014);
    assert_eq!(entry.usage_state, "reported");
    let guard = store::budget_guard(&state.db).await.unwrap().unwrap();
    assert!(guard.halted);
    assert!(!guard.token_halted);
    assert_eq!(
        submit(&state, "local-owner", "blocked", None)
            .await
            .unwrap_err()
            .code,
        "budget_halted"
    );
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn invalid_price_bound_is_rejected_before_any_reservation() {
    let (state, handle) = jobs_state().await;
    let provider = metered(true, Err("must not call".into()), None);
    provider
        .rate
        .store(10_000_000, std::sync::atomic::Ordering::SeqCst);
    state.ai_runtime.install_provider(Arc::new(provider)).await;
    assert_eq!(
        submit(&state, "local-owner", "bad quote", None)
            .await
            .unwrap_err()
            .code,
        "pricing_unavailable"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_jobs")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    let mut conn = state.db.acquire().await.unwrap();
    let budget = store::get_or_create_month(&mut conn, &utc_month_key(now_ms()))
        .await
        .unwrap();
    assert_eq!(budget.reserved_micro_usd, 0);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn late_usage_can_increase_charges_without_releasing_other_reservations() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    estimated_entry(&state, "late-over-bound").await;
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    store::reserve(&mut tx, "2026-09", 20_000, MONTHLY_LIMIT_MICRO_USD)
        .await
        .unwrap();
    assert!(usage::reconcile(
        &mut tx,
        &owner,
        "late-over-bound",
        "original-attempt",
        2,
        &TrustedUsage {
            input_tokens: 40_000,
            output_tokens: 7
        }
    )
    .await
    .unwrap());
    let month = store::get_or_create_month(&mut tx, "2026-09")
        .await
        .unwrap();
    assert_eq!(month.reserved_micro_usd, 20_000);
    assert_eq!(month.charged_micro_usd, 40_014);
    assert!(store::budget_guard(&mut *tx).await.unwrap().unwrap().halted);
    tx.commit().await.unwrap();
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn late_usage_month_total_overflow_saturates_and_keeps_estimate() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    estimated_entry(&state, "late-month-overflow").await;
    let mut reservation_tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    store::reserve(
        &mut reservation_tx,
        "2026-09",
        20_000,
        MONTHLY_LIMIT_MICRO_USD,
    )
    .await
    .unwrap();
    reservation_tx.commit().await.unwrap();
    sqlx::query("UPDATE ai_budget_months SET charged_micro_usd = ?1 WHERE month = '2026-09'")
        .bind(i64::MAX - 100)
        .execute(&state.db)
        .await
        .unwrap();

    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    assert!(!usage::reconcile(
        &mut tx,
        &owner,
        "late-month-overflow",
        "original-attempt",
        2,
        &TrustedUsage {
            input_tokens: 40_000,
            output_tokens: 7,
        }
    )
    .await
    .unwrap());
    tx.commit().await.unwrap();

    let entry = store::find_usage_entry(&state.db, "late-month-overflow")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.usage_state, "estimated_final");
    assert_eq!(
        entry.revision, 3,
        "the halted CAS still advances the ledger revision"
    );
    assert_eq!(entry.accounted_micro_usd, 30_000);
    let mut conn = state.db.acquire().await.unwrap();
    let month = store::get_or_create_month(&mut conn, "2026-09")
        .await
        .unwrap();
    assert_eq!(month.charged_micro_usd, i64::MAX);
    assert_eq!(month.reserved_micro_usd, 20_000);
    let guard = store::budget_guard(&mut *conn).await.unwrap().unwrap();
    assert!(guard.halted);
    assert_eq!(guard.reason, "usage month total overflow");
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn late_usage_adjustment_underflow_halts_and_keeps_estimate() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    estimated_entry(&state, "late-month-underflow").await;
    sqlx::query("UPDATE ai_budget_months SET charged_micro_usd = 0 WHERE month = '2026-09'")
        .execute(&state.db)
        .await
        .unwrap();

    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    assert!(!usage::reconcile(
        &mut tx,
        &owner,
        "late-month-underflow",
        "original-attempt",
        2,
        &TrustedUsage::free(),
    )
    .await
    .unwrap());
    tx.commit().await.unwrap();

    let entry = store::find_usage_entry(&state.db, "late-month-underflow")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.usage_state, "estimated_final");
    assert_eq!(
        entry.revision, 3,
        "the halted CAS still advances the ledger revision"
    );
    assert_eq!(entry.accounted_micro_usd, 30_000);
    let mut conn = state.db.acquire().await.unwrap();
    assert_eq!(
        store::get_or_create_month(&mut conn, "2026-09")
            .await
            .unwrap()
            .charged_micro_usd,
        0
    );
    let guard = store::budget_guard(&mut *conn).await.unwrap().unwrap();
    assert!(guard.halted);
    assert_eq!(guard.reason, "usage month adjustment underflow");
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_usage_callbacks_adjust_the_month_once() {
    async fn callback(state: &Arc<AppState>, owner: &str) -> bool {
        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        let applied = usage::reconcile(
            &mut tx,
            owner,
            "concurrent",
            "original-attempt",
            2,
            &TrustedUsage {
                input_tokens: 123,
                output_tokens: 7,
            },
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        applied
    }
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    estimated_entry(&state, "concurrent").await;
    assert_eq!(
        tokio::join!(callback(&state, &owner), callback(&state, &owner)),
        (true, true)
    );
    let entry = store::find_usage_entry(&state.db, "concurrent")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.revision, 3);
    let mut conn = state.db.acquire().await.unwrap();
    assert_eq!(
        store::get_or_create_month(&mut conn, "2026-09")
            .await
            .unwrap()
            .charged_micro_usd,
        137
    );
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn terminal_month_overflow_retains_estimate_and_persistent_guard() {
    let (state, handle) = jobs_state().await;
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    store::settle(&mut tx, &utc_month_key(now_ms()), 0, 1)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    state
        .ai_runtime
        .install_provider(Arc::new(metered(
            true,
            Err("oversized bill".into()),
            Some(TrustedUsage {
                input_tokens: i64::MAX as u64,
                output_tokens: 0,
            }),
        )))
        .await;
    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "aggregate overflow", None)
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(await_terminal(&state, &job.job_id).await.state, "failed");
    let entry = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.accounted_micro_usd, 30_000);
    assert_eq!(entry.usage_state, "unknown");
    let mut conn = state.db.acquire().await.unwrap();
    let month = store::get_or_create_month(&mut conn, &utc_month_key(now_ms()))
        .await
        .unwrap();
    assert_eq!(month.charged_micro_usd, i64::MAX);
    assert_eq!(month.reserved_micro_usd, 0);
    assert!(
        store::budget_guard(&mut *conn)
            .await
            .unwrap()
            .unwrap()
            .halted
    );
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unrepresentable_month_total_saturates_and_commits_terminal_state() {
    let (state, handle) = jobs_state().await;
    let provider = metered(
        false,
        Err("provider returned an oversized bill".into()),
        Some(TrustedUsage {
            input_tokens: 123,
            output_tokens: 7,
        }),
    );
    let gate = provider.gate.clone();
    state.ai_runtime.install_provider(Arc::new(provider)).await;
    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "aggregate overflow", None)
        .await
        .unwrap()
    else {
        panic!("task should be accepted before the overflow is injected");
    };
    for _ in 0..200 {
        let row = job_row(&state, &job.job_id).await;
        if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        job_row(&state, &job.job_id).await.dispatch_state,
        "may_have_been_sent"
    );

    let month = utc_month_key(now_ms());
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    store::reserve(&mut tx, &month, 20_000, MONTHLY_LIMIT_MICRO_USD)
        .await
        .unwrap();
    store::settle(&mut tx, &month, 0, i64::MAX - 100)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    gate.store(true, std::sync::atomic::Ordering::SeqCst);

    assert_eq!(await_terminal(&state, &job.job_id).await.state, "failed");
    let entry = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.accounted_micro_usd, 30_000);
    assert_eq!(entry.usage_state, "unknown");
    assert_eq!(
        serde_json::from_str::<TrustedUsage>(entry.reported_usage.as_deref().unwrap()).unwrap(),
        TrustedUsage {
            input_tokens: 123,
            output_tokens: 7,
        }
    );
    let task = job_row(&state, &job.job_id).await;
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    assert!(!usage::reconcile(
        &mut tx,
        &task.owner_instance_id,
        &job.job_id,
        task.attempt_id.as_deref().unwrap(),
        entry.revision,
        &TrustedUsage::free(),
    )
    .await
    .unwrap());
    tx.commit().await.unwrap();
    let unchanged = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.revision, entry.revision);
    assert_eq!(unchanged.accounted_micro_usd, 30_000);
    assert_eq!(unchanged.usage_state, "unknown");
    let mut conn = state.db.acquire().await.unwrap();
    let budget = store::get_or_create_month(&mut conn, &month).await.unwrap();
    assert_eq!(budget.charged_micro_usd, i64::MAX);
    assert_eq!(budget.reserved_micro_usd, 20_000);
    let guard = store::budget_guard(&mut *conn).await.unwrap().unwrap();
    assert!(guard.halted);
    assert_eq!(guard.reason, "usage month total overflow");
    drop(conn);
    let owner = instance_owner(&state).await.unwrap();
    assert_eq!(
        status(&state, &owner).await.unwrap()["budget"]["chargedTotalOverflowed"],
        true
    );
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn unrepresentable_usage_retains_estimate_and_halts() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    estimated_entry(&state, "overflow").await;
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    assert!(usage::reconcile(
        &mut tx,
        &owner,
        "overflow",
        "original-attempt",
        2,
        &TrustedUsage {
            input_tokens: u64::MAX,
            output_tokens: u64::MAX
        }
    )
    .await
    .unwrap());
    tx.commit().await.unwrap();
    let entry = store::find_usage_entry(&state.db, "overflow")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.accounted_micro_usd, 30_000);
    assert_eq!(entry.revision, 3);
    assert_eq!(
        serde_json::from_str::<TrustedUsage>(entry.reported_usage.as_deref().unwrap()).unwrap(),
        TrustedUsage {
            input_tokens: u64::MAX,
            output_tokens: u64::MAX,
        }
    );
    let guard = store::budget_guard(&state.db).await.unwrap().unwrap();
    assert!(guard.halted);
    assert!(!guard.token_halted);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn terminal_unrepresentable_usage_keeps_estimate_and_halts() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    state
        .ai_runtime
        .install_provider(Arc::new(metered(
            true,
            Err("provider returned unrepresentable usage".into()),
            Some(TrustedUsage {
                input_tokens: u64::MAX,
                output_tokens: 0,
            }),
        )))
        .await;
    let SubmitOutcome::Accepted { job } = submit(
        &state,
        "local-owner",
        "unrepresentable terminal usage",
        None,
    )
    .await
    .unwrap() else {
        panic!()
    };

    assert_eq!(await_terminal(&state, &job.job_id).await.state, "failed");
    let entry = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.usage_state, "unknown");
    assert_eq!(entry.accounted_micro_usd, 30_000);
    assert_eq!(
        serde_json::from_str::<TrustedUsage>(entry.reported_usage.as_deref().unwrap()).unwrap(),
        TrustedUsage {
            input_tokens: u64::MAX,
            output_tokens: 0,
        }
    );
    let mut conn = state.db.acquire().await.unwrap();
    let month = store::get_or_create_month(&mut conn, &utc_month_key(now_ms()))
        .await
        .unwrap();
    assert_eq!(month.charged_micro_usd, 30_000);
    assert_eq!(month.reserved_micro_usd, 0);
    let guard = store::budget_guard(&mut *conn).await.unwrap().unwrap();
    assert!(guard.halted);
    assert_eq!(guard.reason, "usage amount overflow");
    assert!(!guard.token_halted);
    drop(conn);

    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    store::halt_token_guard(&mut tx, &owner, "legacy token-only stop", "old-task")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    state
        .ai_runtime
        .install_provider(Arc::new(TokenOnlyProvider))
        .await;
    let SubmitOutcome::Accepted { job } = submit(
        &state,
        "local-owner",
        "legacy token guard does not block",
        None,
    )
    .await
    .unwrap() else {
        panic!("legacy token guard must not block admission");
    };
    assert_eq!(await_terminal(&state, &job.job_id).await.state, "succeeded");
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn retention_keeps_tasks_with_pending_trusted_usage() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    let now = now_ms();
    let created = now - 8 * 86_400_000;
    sqlx::query("INSERT INTO ai_jobs (job_id,owner_instance_id,principal,capability,key,input_hash,state,state_revision,dispatch_state,attempt_id,provider,model,created_at,updated_at) VALUES ('pending-retention',?1,'local-owner',?2,'retained-key','hash','interrupted',3,'may_have_been_sent','actual-attempt','stepfun','step-5-preview',?3,?3)")
        .bind(&owner)
        .bind(CAPABILITY)
        .bind(created)
        .execute(&state.db)
        .await
        .unwrap();
    store::insert_usage_entry(
        &state.db,
        &store::UsageEntryInsert {
            job_id: "pending-retention".into(),
            accepted_month: utc_month_key(created),
            attempt_id: Some("actual-attempt".into()),
            reservation_micro_usd: 0,
            accounted_micro_usd: 0,
            usage_state: "unpriced".into(),
            pricing_snapshot: "{}".into(),
            reported_usage: None,
            revision: 1,
            created_at: created,
        },
    )
    .await
    .unwrap();
    store::insert_pending_usage(
        &state.db,
        &store::PendingUsageInsert {
            job_id: "pending-retention".into(),
            attempt_id: "unresolved-attempt".into(),
            owner_instance_id: owner,
            usage_json: serde_json::to_string(&TrustedUsage {
                input_tokens: 345,
                output_tokens: 67,
            })
            .unwrap(),
            created_at: now,
        },
    )
    .await
    .unwrap();

    retain_history(&state.db, now).await.unwrap();
    assert!(store::find_job_by_id(&state.db, "pending-retention")
        .await
        .unwrap()
        .is_some());
    assert!(store::find_usage_entry(&state.db, "pending-retention")
        .await
        .unwrap()
        .is_some());
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn retention_clears_payloads_preserves_keys_and_keeps_ledger_attribution() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    let now = now_ms();
    for (id, age) in [("protected", 2), ("old", 8)] {
        let created = now - age * 86_400_000;
        let key = format!("v1.{created}.00000000000000000000000000000001");
        sqlx::query("INSERT INTO ai_jobs (job_id,owner_instance_id,principal,capability,key,input_hash,state,state_revision,dispatch_state,attempt_id,provider,model,created_at,updated_at) VALUES (?1,?2,'local-owner',?3,?4,'hash','cancelled',2,'may_have_been_sent','attempt','fake','fake',?5,?5)")
            .bind(id).bind(&owner).bind(CAPABILITY).bind(key).bind(created).execute(&state.db).await.unwrap();
        store::insert_proposal(
            &state.db,
            &store::ProposalRow {
                proposal_id: format!("proposal-{id}"),
                job_id: id.into(),
                validated_intent: "sensitive-validated-candidate".into(),
                schema_version: "1".into(),
                state: "pending".into(),
                revision: 1,
                created_at: created,
                expires_at: now - 1,
            },
        )
        .await
        .unwrap();
        store::insert_usage_entry(
            &state.db,
            &store::UsageEntryInsert {
                job_id: id.into(),
                accepted_month: utc_month_key(created),
                attempt_id: Some("attempt".into()),
                reservation_micro_usd: 50_000,
                accounted_micro_usd: 50_000,
                usage_state: "unknown".into(),
                pricing_snapshot: "{}".into(),
                reported_usage: None,
                revision: 1,
                created_at: created,
            },
        )
        .await
        .unwrap();
    }
    sweep(&state).await.unwrap();
    let proposal = store::find_proposal(&state.db, "proposal-protected")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(proposal.validated_intent, "null");
    assert_eq!(proposal.state, "expired");
    assert!(store::find_job_by_id(&state.db, "protected")
        .await
        .unwrap()
        .is_some());
    assert!(store::find_job_by_id(&state.db, "old")
        .await
        .unwrap()
        .is_none());
    assert!(store::find_proposal(&state.db, "proposal-old")
        .await
        .unwrap()
        .is_none());
    let entry = store::find_usage_entry(&state.db, "old")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.usage_state, "estimated_final");
    assert_eq!(
        entry.accounted_micro_usd, 50_000,
        "24h unknown is never a refund or an extra charge"
    );
    assert_eq!(entry.accepted_month, utc_month_key(now - 8 * 86_400_000));
    assert_eq!(entry.attempt_id.as_deref(), Some("attempt"));
    let revision = entry.revision;
    sweep(&state).await.unwrap();
    assert_eq!(
        store::find_usage_entry(&state.db, "old")
            .await
            .unwrap()
            .unwrap()
            .revision,
        revision
    );
    let old_key = format!(
        "v1.{}.00000000000000000000000000000001",
        now - 8 * 86_400_000
    );
    assert_eq!(
        submit(&state, "local-owner", "old retry", Some(&old_key))
            .await
            .unwrap_err()
            .code,
        "bad_request"
    );
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn protected_history_capacity_fails_closed_without_reserving() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    sqlx::query("WITH RECURSIVE ids(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM ids WHERE x < 500)
        INSERT INTO ai_jobs (job_id,owner_instance_id,principal,capability,key,input_hash,state,state_revision,dispatch_state,provider,model,created_at,updated_at)
        SELECT 'full-'||x,?1,'local-owner',?2,'key-'||x,'hash','failed',2,'not_dispatched','fake','fake',?3,?3 FROM ids")
        .bind(&owner).bind(CAPABILITY).bind(now_ms()).execute(&state.db).await.unwrap();
    assert_eq!(
        submit(&state, "local-owner", "full", None)
            .await
            .unwrap_err()
            .code,
        "history_capacity_exceeded"
    );
    let budget = {
        let mut c = state.db.acquire().await.unwrap();
        store::get_or_create_month(&mut c, &utc_month_key(now_ms()))
            .await
            .unwrap()
    };
    assert_eq!(budget.reserved_micro_usd, 0);
    sqlx::query("DELETE FROM ai_jobs")
        .execute(&state.db)
        .await
        .unwrap();
    store::insert_usage_entry(
        &state.db,
        &store::UsageEntryInsert {
            job_id: "large-ledger".into(),
            accepted_month: utc_month_key(now_ms()),
            attempt_id: None,
            reservation_micro_usd: 0,
            accounted_micro_usd: 0,
            usage_state: "reported".into(),
            pricing_snapshot: "x".repeat(HISTORY_BYTE_LIMIT as usize),
            reported_usage: None,
            revision: 1,
            created_at: now_ms(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        submit(&state, "local-owner", "large", None)
            .await
            .unwrap_err()
            .code,
        "history_capacity_exceeded"
    );
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn retention_pauses_on_clock_rollback_and_ledger_keeps_thirteen_months() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    let now = now_ms();
    store::insert_proposal(
        &state.db,
        &store::ProposalRow {
            proposal_id: "clock".into(),
            job_id: "none".into(),
            validated_intent: "keep-until-clock-stable".into(),
            schema_version: "1".into(),
            state: "pending".into(),
            revision: 1,
            created_at: now - 100,
            expires_at: now - 1,
        },
    )
    .await
    .unwrap();
    {
        let mut c = state.db.acquire().await.unwrap();
        store::advance_watermark(&mut c, &owner, now + 600_000)
            .await
            .unwrap();
    }
    sweep(&state).await.unwrap();
    assert_eq!(
        store::find_proposal(&state.db, "clock")
            .await
            .unwrap()
            .unwrap()
            .validated_intent,
        "keep-until-clock-stable"
    );
    assert_eq!(
        submit(&state, "local-owner", "clock", None)
            .await
            .unwrap_err()
            .code,
        "clock_skew"
    );
    {
        let mut c = state.db.acquire().await.unwrap();
        for (id, month) in [("past", "2025-09"), ("boundary", "2025-10")] {
            store::insert_usage_entry(
                &mut *c,
                &store::UsageEntryInsert {
                    job_id: id.into(),
                    accepted_month: month.into(),
                    attempt_id: Some("retained-attempt".into()),
                    reservation_micro_usd: 100,
                    accounted_micro_usd: 100,
                    usage_state: "estimated_final".into(),
                    pricing_snapshot: "{}".into(),
                    reported_usage: None,
                    revision: 1,
                    created_at: now,
                },
            )
            .await
            .unwrap();
        }
        sqlx::query("INSERT INTO ai_jobs (job_id,owner_instance_id,principal,capability,key,input_hash,state,state_revision,dispatch_state,provider,model,created_at,updated_at) VALUES ('held',?1,'local-owner','generate','held-key','hash','cancelled',2,'may_have_been_sent','fake','fake',0,?2)")
            .bind(&owner).bind(now).execute(&mut *c).await.unwrap();
        store::insert_usage_entry(
            &mut *c,
            &store::UsageEntryInsert {
                job_id: "held".into(),
                accepted_month: "2025-08".into(),
                attempt_id: Some("held-attempt".into()),
                reservation_micro_usd: 100,
                accounted_micro_usd: 100,
                usage_state: "estimated_final".into(),
                pricing_snapshot: "{}".into(),
                reported_usage: None,
                revision: 1,
                created_at: now,
            },
        )
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO ai_budget_months (month,charged_micro_usd) VALUES ('2025-08',100)",
        )
        .execute(&mut *c)
        .await
        .unwrap();
        store::retain_ai_history(&mut c, now, now - KEY_WINDOW_MS, "2025-10")
            .await
            .unwrap();
    }
    assert!(store::find_usage_entry(&state.db, "past")
        .await
        .unwrap()
        .is_none());
    let retained_budget: i64 = sqlx::query_scalar(
        "SELECT charged_micro_usd FROM ai_budget_months WHERE month = '2025-08'",
    )
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(
        retained_budget, 100,
        "retained usage must retain its original month's aggregate"
    );
    assert!(store::find_usage_entry(&state.db, "boundary")
        .await
        .unwrap()
        .is_some());
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn submit_is_gated_on_the_runner_lock() {
    let (state, handle) = jobs_state().await;
    state
        .ai_runner_held
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let err = submit(&state, crate::idempotency::LOCAL_OWNER, "锁失进程", None)
        .await
        .unwrap_err();
    assert_eq!(err.status.as_u16(), 503);
    assert_eq!(err.code, "ai_locked");
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn non_runner_queries_cannot_expire_or_cancel_another_process_worker() {
    let (state, handle) = jobs_state().await;
    let provider = BlockedProvider {
        counter: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        gate: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    let calls = provider.counter.clone();
    let gate = provider.gate.clone();
    state.ai_runtime.install_provider(Arc::new(provider)).await;
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "runner ownership fixture", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    for _ in 0..400 {
        let row = job_row(&state, &job.job_id).await;
        if row.state == "running"
            && row.dispatch_state == "may_have_been_sent"
            && calls.load(std::sync::atomic::Ordering::SeqCst) == 1
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

    state
        .ai_runner_held
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let error = cancel(&state, "local-owner", &job.job_id, 2)
        .await
        .unwrap_err();
    assert_eq!(error.status.as_u16(), 503);
    assert_eq!(error.code, "ai_locked");

    sqlx::query("UPDATE ai_jobs SET updated_at = ?1 WHERE job_id = ?2")
        .bind(now_ms() - RUN_DEADLINE_MS - 1)
        .bind(&job.job_id)
        .execute(&state.db)
        .await
        .unwrap();
    // A second process has no in-memory owner for this row. The blocked
    // fixture ignores cancellation so the real owner remains observable.
    // Keep the sender alive: dropping it is itself a cancellation signal.
    // Removing it from the map still simulates a different process owning the row.
    let _cancel_owner = state
        .ai_runtime
        .inputs
        .lock()
        .await
        .remove(&job.job_id)
        .unwrap()
        .1;
    let observed = get_job(&state, "local-owner", &job.job_id).await.unwrap();
    assert_eq!(observed.state, "running");
    assert_eq!(observed.usage.usage_state, "reserved");

    state
        .ai_runner_held
        .store(true, std::sync::atomic::Ordering::Relaxed);
    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    let terminal = await_terminal(&state, &job.job_id).await;
    assert_eq!(terminal.state, "succeeded");
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn stale_epoch_key_is_rejected_not_treated_as_new() {
    let (state, handle) = jobs_state().await;
    // 1970 年时间戳的键：从未出现过也不能当新收费动作受理（§7.2）。
    let key = "v1.0.00000000000000000000000000000000";
    let err = submit(
        &state,
        crate::idempotency::LOCAL_OWNER,
        "太老的键",
        Some(key),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "bad_request");
    assert!(err.message.contains("7 天"));
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_works_without_runner_lock_or_ready_provider() {
    struct NotReady;
    impl StageIntentProvider for NotReady {
        fn id(&self) -> &'static str {
            "not-ready"
        }
        fn model(&self) -> &'static str {
            "none"
        }
        fn ready(&self) -> bool {
            false
        }
        fn quote(&self, _: &str) -> Result<PriceQuote, String> {
            Err("not ready".into())
        }
        fn generate(
            &self,
            _: String,
            _: PricingSnapshot,
            _credential: Option<crate::ai::credential::ProviderCredential>,
            _cancellation: ProviderCancellation,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
            Box::pin(async {
                ProviderReply {
                    intent: Err("不该被调用".into()),
                    usage: None,
                }
            })
        }
    }
    let (state, handle) = jobs_state().await;
    let key = format!("v1.{}.{:032x}", now_ms(), 42u128);
    let SubmitOutcome::Accepted { job } = submit(
        &state,
        crate::idempotency::LOCAL_OWNER,
        "先正常受理",
        Some(&key),
    )
    .await
    .unwrap() else {
        panic!("首次提交必须受理");
    };
    for _ in 0..200 {
        if job_row(&state, &job.job_id).await.state == "succeeded" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    // provider 不可用后：同键同输入仍然回放旧事实（§7.1 顺序）。
    state.ai_runtime.install_provider(Arc::new(NotReady)).await;
    state
        .ai_runner_held
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let replay = submit(
        &state,
        crate::idempotency::LOCAL_OWNER,
        "先正常受理",
        Some(&key),
    )
    .await
    .unwrap();
    let SubmitOutcome::Replayed { job: replayed } = replay else {
        panic!("回放不得依赖 provider 就绪");
    };
    assert_eq!(replayed.job_id, job.job_id);
    let locked = submit(
        &state,
        crate::idempotency::LOCAL_OWNER,
        "新任务",
        Some(&format!("v1.{}.{:032x}", now_ms(), 43u128)),
    )
    .await
    .unwrap_err();
    assert_eq!(locked.status.as_u16(), 503);
    assert_eq!(locked.code, "ai_locked");
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn expired_proposal_is_swept_and_carries_no_content() {
    let (state, handle) = jobs_state().await;
    let SubmitOutcome::Accepted { job } = submit(
        &state,
        crate::idempotency::LOCAL_OWNER,
        "过期提案候选",
        None,
    )
    .await
    .unwrap() else {
        panic!("首次提交必须受理");
    };
    for _ in 0..200 {
        if job_row(&state, &job.job_id).await.state == "succeeded" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let done = job_row(&state, &job.job_id).await;
    let proposal_id = done.result_proposal_id.clone().unwrap();
    // 把过期时间拨回过去：读取时惰性收口为 expired。
    sqlx::query("UPDATE ai_proposals SET expires_at = 0 WHERE proposal_id = ?1")
        .bind(&proposal_id)
        .execute(&state.db)
        .await
        .unwrap();
    assert!(get_proposal(&state, "other-principal", &proposal_id)
        .await
        .is_err());
    assert_eq!(
        store::find_proposal(&state.db, &proposal_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        "pending"
    );
    let mut events = state.events.subscribe();
    let view = get_proposal(&state, crate::idempotency::LOCAL_OWNER, &proposal_id)
        .await
        .unwrap();
    assert_eq!(view.state, "expired");
    assert!(view.validated_intent.is_null(), "过期提案不得携带完整内容");
    assert!(matches!(events.try_recv().unwrap(), WsEvent::AiTasksResync));
    assert!(
        get_proposal(&state, crate::idempotency::LOCAL_OWNER, &proposal_id)
            .await
            .is_ok()
    );
    assert!(events.try_recv().is_err(), "已过期提案重复读取不重复发布");
    // 过期提案不能再被拒绝（非 pending）。
    let err = reject_proposal(&state, crate::idempotency::LOCAL_OWNER, &proposal_id, 1)
        .await
        .unwrap_err();
    assert_eq!(err.code, "state_conflict");
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proposal_rejection_broadcasts_resync_only_after_cas_wins() {
    let (state, handle) = jobs_state().await;
    let SubmitOutcome::Accepted { job } = submit(
        &state,
        crate::idempotency::LOCAL_OWNER,
        "拒绝事件候选",
        None,
    )
    .await
    .unwrap() else {
        panic!("首次提交必须受理");
    };
    for _ in 0..200 {
        if job_row(&state, &job.job_id).await.state == "succeeded" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let done = job_row(&state, &job.job_id).await;
    let proposal_id = done.result_proposal_id.unwrap();
    let proposal = get_proposal(&state, crate::idempotency::LOCAL_OWNER, &proposal_id)
        .await
        .unwrap();
    let mut events = state.events.subscribe();

    let rejected = reject_proposal(
        &state,
        crate::idempotency::LOCAL_OWNER,
        &proposal_id,
        proposal.revision,
    )
    .await
    .unwrap();
    assert_eq!(rejected.state, "rejected");
    assert!(matches!(events.try_recv().unwrap(), WsEvent::AiTasksResync));

    let duplicate = reject_proposal(
        &state,
        crate::idempotency::LOCAL_OWNER,
        &proposal_id,
        proposal.revision,
    )
    .await
    .unwrap_err();
    assert_eq!(duplicate.code, "state_conflict");
    assert!(events.try_recv().is_err(), "CAS 失败不得发布状态事件");
    state.audio.shutdown();
    handle.join().unwrap();
}

async fn job_row(state: &Arc<AppState>, job_id: &str) -> store::JobRow {
    store::find_job_by_id(&state.db, job_id)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn submit_runs_to_succeeded_and_proposal_is_readable() {
    let (state, handle) = jobs_state().await;
    let outcome = submit(
        &state,
        crate::idempotency::LOCAL_OWNER,
        "写一段深空缓慢推进",
        None,
    )
    .await
    .unwrap();
    let SubmitOutcome::Accepted { job } = outcome else {
        panic!("新键必须受理");
    };
    // 等 worker 完成（fake 即时）。
    for _ in 0..100 {
        if job_row(&state, &job.job_id).await.state == "succeeded" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let done = job_row(&state, &job.job_id).await;
    assert_eq!(done.state, "succeeded");
    assert_eq!(done.dispatch_state, "may_have_been_sent");
    let proposal = get_proposal(
        &state,
        crate::idempotency::LOCAL_OWNER,
        done.result_proposal_id.as_ref().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(proposal.validated_intent["version"], 1);
    assert_eq!(proposal.state, "pending");
    // fake 免费：预留全额释放，charged 为 0。
    let status = status(&state, done.owner_instance_id.as_str())
        .await
        .unwrap();
    assert_eq!(status["budget"]["reservedMicroUsd"], json!(0));
    assert_eq!(status["budget"]["chargedMicroUsd"], json!(0));
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn idempotent_key_replays_and_conflicts() {
    let (state, handle) = jobs_state().await;
    let key = format!("v1.{}.{:032x}", now_ms(), 7u128);
    let outcome = submit(
        &state,
        crate::idempotency::LOCAL_OWNER,
        "同一个 brief",
        Some(&key),
    )
    .await
    .unwrap();
    let SubmitOutcome::Accepted { job } = outcome else {
        panic!("首次提交必须受理");
    };
    // 同键同输入：回放原任务（worker 可能还没跑完，回放返回当前事实）。
    let replay = submit(
        &state,
        crate::idempotency::LOCAL_OWNER,
        "同一个 brief",
        Some(&key),
    )
    .await
    .unwrap();
    let SubmitOutcome::Replayed { job: replayed } = replay else {
        panic!("同键同输入必须回放");
    };
    assert_eq!(replayed.job_id, job.job_id);
    // 同键异输入：冲突，不产生新任务。
    let err = submit(
        &state,
        crate::idempotency::LOCAL_OWNER,
        "另一个 brief",
        Some(&key),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "idempotency_conflict");
    // 未来键拒绝。
    let future = format!("v1.{}.{:032x}", now_ms() + 10 * 60_000, 8u128);
    let err = submit(&state, crate::idempotency::LOCAL_OWNER, "x", Some(&future))
        .await
        .unwrap_err();
    assert_eq!(err.code, "bad_request");
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queue_capacity_rejects_the_tenth_incomplete_job() {
    let (state, handle) = jobs_state().await;
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedProvider {
            counter: counter.clone(),
            gate: gate.clone(),
        }))
        .await;
    // 9 个未完结：1 running + 8 accepted（provider 全部阻塞）。
    for _ in 0..QUEUE_CAPACITY {
        submit(
            &state,
            crate::idempotency::LOCAL_OWNER,
            &format!(
                "brief-{}",
                counter.load(std::sync::atomic::Ordering::SeqCst)
            ),
            None,
        )
        .await
        .unwrap();
    }
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let err = submit(&state, crate::idempotency::LOCAL_OWNER, "第 10 个", None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "capacity_exceeded");
    assert_eq!(err.status.as_u16(), 429);
    // 放行后容量回笼：轮询等全部任务到终态，再提交第 10 个。
    let done_owner = crate::ai::jobs::instance_owner(&state).await.unwrap();
    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    for _ in 0..200 {
        if store::count_incomplete_jobs(&state.db, done_owner.as_str())
            .await
            .unwrap()
            == 0
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    submit(&state, crate::idempotency::LOCAL_OWNER, "第 10 个", None)
        .await
        .unwrap();
    for _ in 0..200 {
        if counter.load(std::sync::atomic::Ordering::SeqCst) == QUEUE_CAPACITY as usize + 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        counter.load(std::sync::atomic::Ordering::SeqCst),
        QUEUE_CAPACITY as usize + 1
    );
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_wins_by_revision_and_settles_by_dispatch_state() {
    let (state, handle) = jobs_state().await;
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedProvider {
            counter: counter.clone(),
            gate: gate.clone(),
        }))
        .await;
    let SubmitOutcome::Accepted { job } =
        submit(&state, crate::idempotency::LOCAL_OWNER, "阻塞后取消", None)
            .await
            .unwrap()
    else {
        panic!("首次提交必须受理");
    };
    // 等 worker 进入 running 且完成派发标记（两个提交点不同）。
    for _ in 0..200 {
        let row = job_row(&state, &job.job_id).await;
        if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let running = job_row(&state, &job.job_id).await;
    assert_eq!(running.dispatch_state, "may_have_been_sent");
    // 过期 revision：冲突。
    let err = cancel(
        &state,
        crate::idempotency::LOCAL_OWNER,
        &job.job_id,
        running.state_revision - 1,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "state_conflict");
    // 正确 revision：取消成功，unknown 结算（已派发 → 预留转已计）。
    let view = cancel(
        &state,
        crate::idempotency::LOCAL_OWNER,
        &job.job_id,
        running.state_revision,
    )
    .await
    .unwrap();
    assert_eq!(view.state, "cancelled");
    let status = status(&state, running.owner_instance_id.as_str())
        .await
        .unwrap();
    assert_eq!(
        status["budget"]["chargedMicroUsd"],
        json!(RESERVATION_MICRO_USD)
    );
    assert_eq!(status["budget"]["reservedMicroUsd"], json!(0));
    // 重复取消：终态冲突。
    let err = cancel(
        &state,
        crate::idempotency::LOCAL_OWNER,
        &job.job_id,
        running.state_revision,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "state_conflict");
    // 放行阻塞的 provider：worker 静默退出，不再改写终态。
    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(job_row(&state, &job.job_id).await.state, "cancelled");
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_marks_incomplete_jobs_interrupted_and_settles() {
    let (state, handle) = jobs_state().await;
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedProvider {
            counter: counter.clone(),
            gate: gate.clone(),
        }))
        .await;
    let SubmitOutcome::Accepted { job } =
        submit(&state, crate::idempotency::LOCAL_OWNER, "重启前受理", None)
            .await
            .unwrap()
    else {
        panic!("首次提交必须受理");
    };
    // 等 worker 完成「running + 已派发标记」两个提交点。
    for _ in 0..200 {
        let row = job_row(&state, &job.job_id).await;
        if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    // 模拟重启：内存输入全丢，恢复把未完结收敛为 interrupted。
    let recovered = recover(&state).await.unwrap();
    assert_eq!(recovered, 1);
    let after = job_row(&state, &job.job_id).await;
    assert_eq!(after.state, "interrupted");
    // 已派发：保守按 unknown 结算（预留转已计），不释放额度。
    let status = status(&state, after.owner_instance_id.as_str())
        .await
        .unwrap();
    assert_eq!(
        status["budget"]["chargedMicroUsd"],
        json!(RESERVATION_MICRO_USD)
    );
    // 放行：worker 的迟到 provider 结果不得改写终态。
    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(job_row(&state, &job.job_id).await.state, "interrupted");
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn token_only_recovery_marks_interrupted_without_charge_and_keeps_late_tokens() {
    let (state, handle) = jobs_state().await;
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedTokenOnlyProvider {
            counter: counter.clone(),
            gate: gate.clone(),
        }))
        .await;
    let SubmitOutcome::Accepted { job } = submit(
        &state,
        crate::idempotency::LOCAL_OWNER,
        "token-only recovery",
        None,
    )
    .await
    .unwrap() else {
        panic!("首次提交必须受理");
    };
    for _ in 0..200 {
        let row = job_row(&state, &job.job_id).await;
        if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 1);

    assert_eq!(recover(&state).await.unwrap(), 1);
    let after = job_row(&state, &job.job_id).await;
    assert_eq!(after.state, "interrupted");
    let usage = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "unpriced");
    assert_eq!(usage.accounted_micro_usd, 0);
    assert!(usage.reported_usage.is_none());
    let budget = status(&state, &after.owner_instance_id).await.unwrap();
    assert_eq!(budget["budget"]["chargedMicroUsd"], json!(0));
    assert_eq!(budget["budget"]["reservedMicroUsd"], json!(0));
    assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 1);

    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut late_usage = None;
    for _ in 0..200 {
        late_usage = store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .and_then(|entry| entry.reported_usage);
        if late_usage.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let late_usage: TrustedUsage = serde_json::from_str(&late_usage.unwrap()).unwrap();
    assert_eq!(late_usage.input_tokens, 345);
    assert_eq!(late_usage.output_tokens, 67);
    assert_eq!(job_row(&state, &job.job_id).await.state, "interrupted");
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_recovery_failure_does_not_roll_back_other_tasks() {
    let (state, handle) = jobs_state().await;
    state
        .ai_runtime
        .install_provider(Arc::new(FakeProvider))
        .await;
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let SubmitOutcome::Accepted { job: failed } =
        submit(&state, "local-owner", "recovery failure fixture", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    let SubmitOutcome::Accepted { job: healthy } =
        submit(&state, "local-owner", "healthy recovery fixture", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    let trigger = format!(
        "CREATE TRIGGER fail_one_recovery BEFORE UPDATE OF state ON ai_jobs \
         WHEN OLD.job_id = '{}' AND NEW.state = 'interrupted' \
         BEGIN SELECT RAISE(ABORT, 'fixture recovery failure'); END",
        failed.job_id
    );
    sqlx::query(&trigger).execute(&state.db).await.unwrap();

    assert!(recover(&state).await.is_err());
    assert_eq!(job_row(&state, &healthy.job_id).await.state, "interrupted");
    assert_eq!(job_row(&state, &failed.job_id).await.state, "accepted");
    let healthy_usage = store::find_usage_entry(&state.db, &healthy.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(healthy_usage.usage_state, "released");
    assert!(store::find_usage_entry(&state.db, &failed.job_id)
        .await
        .unwrap()
        .is_none());

    sqlx::query("DROP TRIGGER fail_one_recovery")
        .execute(&state.db)
        .await
        .unwrap();
    assert_eq!(recover(&state).await.unwrap(), 1);
    assert_eq!(job_row(&state, &failed.job_id).await.state, "interrupted");
    let failed_usage = store::find_usage_entry(&state.db, &failed.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed_usage.usage_state, "released");

    drop(slot);
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn expired_jobs_are_swept_and_reservation_released() {
    let (state, handle) = jobs_state().await;
    // Hold the slot so the fixture remains accepted until the sweep.
    let _slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedProvider {
            counter: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            gate: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }))
        .await;
    let SubmitOutcome::Accepted { job } =
        submit(&state, crate::idempotency::LOCAL_OWNER, "过期候选", None)
            .await
            .unwrap()
    else {
        panic!("首次提交必须受理");
    };
    let stale = now_ms() - QUEUE_DEADLINE_MS - 1000;
    sqlx::query("UPDATE ai_jobs SET created_at = ?2 WHERE job_id = ?1")
        .bind(&job.job_id)
        .bind(stale)
        .execute(&state.db)
        .await
        .unwrap();
    let cancel_owner = state
        .ai_runtime
        .inputs
        .lock()
        .await
        .remove(&job.job_id)
        .unwrap()
        .1;
    sweep(&state).await.unwrap();
    let after = job_row(&state, &job.job_id).await;
    assert_eq!(after.state, "expired");
    let status = status(&state, after.owner_instance_id.as_str())
        .await
        .unwrap();
    assert_eq!(status["budget"]["reservedMicroUsd"], json!(0));
    drop(cancel_owner);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[test]
fn intent_validation_rejects_unknown_and_oversized() {
    assert!(validate_intent(&json!({ "version": 1, "scene": "towers", "patch": {} })).is_ok());
    // 不在当前场景表里的 scene 一律失败（"space" 曾是假场景名）。
    assert!(validate_intent(&json!({ "version": 1, "scene": "space", "patch": {} })).is_err());
    assert!(validate_intent(&json!({ "version": 2, "scene": "towers", "patch": {} })).is_err());
    assert!(
        validate_intent(&json!({ "version": 1, "scene": "towers", "patch": {}, "junk": 1 }))
            .is_err()
    );
    // patch 键必须落在场景参数表内（结构合法但参数不存在也失败）。
    assert!(validate_intent(
        &json!({ "version": 1, "scene": "towers", "patch": { "intensity": 1 } })
    )
    .is_err());
    assert!(validate_intent(
        &json!({ "version": 1, "scene": "towers", "patch": { "sc.height": 5.5 } })
    )
    .is_ok());
    for bad in [
        json!({"version":1,"scene":"towers","patch":{"height":1}}),
        json!({"version":1,"scene":"towers","patch":{"sc.height":"1"}}),
        json!({"version":1,"scene":"towers","patch":{},"director":"yes"}),
        json!({"version":1,"scene":"towers","patch":{},"hand":{"on":1}}),
    ] {
        assert!(validate_intent(&bad).is_err(), "{bad}");
    }
    let deep = json!({ "version": 1, "scene": "s", "patch": { "a": { "b": { "c": { "d": { "e": { "f": { "g": { "h": { "i": 1 } } } } } } } } } });
    assert!(validate_intent(&deep).is_err());
    let oversized = json!({ "version": 1, "scene": "x".repeat(20000), "patch": {} });
    assert!(validate_intent(&oversized).is_err());
}

#[tokio::test]
async fn consent_gate_blocks_when_switch_is_off() {
    let (state, handle) = jobs_state().await;
    // jobs_state 已置位：先证明受理可用，再关掉开关验证默认拒绝。
    let owner = instance_owner(&state).await.unwrap();
    let status = status(&state, owner.as_str()).await.unwrap();
    assert_eq!(status["consent"]["inAppGeneration"], json!(true));
    vmusic_store::settings::set(&state.db, CONSENT_KEY, &serde_json::Value::Bool(false))
        .await
        .unwrap();
    let err = submit(&state, crate::idempotency::LOCAL_OWNER, "未同意", None)
        .await
        .unwrap_err();
    assert_eq!(err.status.as_u16(), 403);
    assert_eq!(err.code, "generation_disabled");
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn usage_entries_record_each_terminal_path() {
    let (state, handle) = jobs_state().await;
    // 成功路径：reported、accounted 0（fake 免费）。
    let SubmitOutcome::Accepted { job } =
        submit(&state, crate::idempotency::LOCAL_OWNER, "成功账目", None)
            .await
            .unwrap()
    else {
        panic!("受理");
    };
    let success = await_terminal(&state, &job.job_id).await;
    assert_eq!(success.state, "succeeded", "success fixture: {success:?}");
    let entry = await_usage_entry(&state, &job.job_id).await;
    assert_eq!(entry.usage_state, "reported");
    assert_eq!(entry.accounted_micro_usd, 0);

    // 已派发后取消：unknown、按预留计（§8.4）。
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedProvider {
            counter: counter.clone(),
            gate: gate.clone(),
        }))
        .await;
    let SubmitOutcome::Accepted { job: blocked } =
        submit(&state, crate::idempotency::LOCAL_OWNER, "派发后取消", None)
            .await
            .unwrap()
    else {
        panic!("受理");
    };
    for _ in 0..200 {
        let row = job_row(&state, &blocked.job_id).await;
        if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let revision = job_row(&state, &blocked.job_id).await.state_revision;
    cancel(
        &state,
        crate::idempotency::LOCAL_OWNER,
        &blocked.job_id,
        revision,
    )
    .await
    .unwrap();
    let entry = store::find_usage_entry(&state.db, &blocked.job_id)
        .await
        .unwrap()
        .expect("已派发取消必须有账目");
    assert_eq!(entry.usage_state, "unknown", "已派发取消按 unknown 计");
    assert_eq!(entry.accounted_micro_usd, RESERVATION_MICRO_USD);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn budget_guard_halts_persistently_and_resets_by_revision() {
    let (state, handle) = jobs_state().await;
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedProvider {
            counter: counter.clone(),
            gate: gate.clone(),
        }))
        .await;
    // 受理一个任务（预留先占住），然后把月账的其他部分灌到限额满——
    // 这正是「迟到 usage 越界」的形状：预留时还有余量，结算时越界。
    let SubmitOutcome::Accepted { job } =
        submit(&state, crate::idempotency::LOCAL_OWNER, "越界候选", None)
            .await
            .unwrap()
    else {
        panic!("受理");
    };
    for _ in 0..200 {
        let row = job_row(&state, &job.job_id).await;
        if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let month = utc_month_key(now_ms());
    {
        let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
        store::settle(&mut tx, &month, 0, MONTHLY_LIMIT_MICRO_USD)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    // 取消该任务 → unknown 结算 +50000 → charged 越过限额 → 持久熔断。
    let revision = job_row(&state, &job.job_id).await.state_revision;
    cancel(
        &state,
        crate::idempotency::LOCAL_OWNER,
        &job.job_id,
        revision,
    )
    .await
    .unwrap();
    let guard = store::budget_guard(&state.db).await.unwrap().unwrap();
    assert!(guard.halted, "越过限额必须置位持久熔断");
    assert_eq!(guard.trigger_job.as_deref(), Some(job.job_id.as_str()));
    let provider = state.ai_runtime.provider().await;
    let fingerprint = guard_reset_fingerprint(provider.as_ref()).unwrap();
    // 熔断期间 submit → 503 budget_halted（先于 reserve）。
    let err = submit(&state, crate::idempotency::LOCAL_OWNER, "熔断中", None)
        .await
        .unwrap_err();
    assert_eq!(err.code, "budget_halted");
    // 未确认当前配置时拒绝，不改变持久闩锁。
    let err = budget_guard_reset(&state, guard.revision, &"0".repeat(64))
        .await
        .unwrap_err();
    assert_eq!(err.code, "configuration_changed");
    let unchanged = store::budget_guard(&state.db).await.unwrap().unwrap();
    assert!(unchanged.halted);
    assert_eq!(unchanged.revision, guard.revision);
    // reset：错误 revision 冲突；正确 revision 仍需无在途工作且月账健康。
    let err = budget_guard_reset(&state, guard.revision - 1, &fingerprint)
        .await
        .unwrap_err();
    assert_eq!(err.code, "state_conflict");
    assert_eq!(
        budget_guard_reset(&state, guard.revision, &fingerprint)
            .await
            .unwrap_err()
            .code,
        "generation_in_flight"
    );
    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    drop(slot);
    assert_eq!(
        budget_guard_reset(&state, guard.revision, &fingerprint)
            .await
            .unwrap_err()
            .code,
        "budget_unhealthy"
    );
    sqlx::query("UPDATE ai_budget_months SET charged_micro_usd = 0")
        .execute(&state.db)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TRIGGER reject_guard_reset_audit BEFORE INSERT ON ai_budget_guard_reset_audit
         BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END",
    )
    .execute(&state.db)
    .await
    .unwrap();
    assert!(budget_guard_reset(&state, guard.revision, &fingerprint)
        .await
        .is_err());
    let unchanged = store::budget_guard(&state.db).await.unwrap().unwrap();
    assert!(unchanged.halted, "audit failure must roll the reset back");
    assert_eq!(unchanged.revision, guard.revision);
    let audit_count: i64 = sqlx::query_scalar("SELECT count(*) FROM ai_budget_guard_reset_audit")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(audit_count, 0);
    sqlx::query("DROP TRIGGER reject_guard_reset_audit")
        .execute(&state.db)
        .await
        .unwrap();
    let result = budget_guard_reset(&state, guard.revision, &fingerprint)
        .await
        .unwrap();
    assert_eq!(result["halted"], json!(false));
    assert_eq!(result["auditId"].as_str().unwrap().len(), 36);
    let audit: (String, i64, i64, String) = sqlx::query_as(
        "SELECT owner_instance_id, previous_revision, new_revision, config_fingerprint
         FROM ai_budget_guard_reset_audit WHERE event_id = ?1",
    )
    .bind(result["auditId"].as_str().unwrap())
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(audit.0, instance_owner(&state).await.unwrap());
    assert_eq!(audit.1, guard.revision);
    assert_eq!(audit.2, guard.revision + 1);
    assert_eq!(audit.3, fingerprint);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_state_changes_are_broadcast_as_small_events() {
    let (state, handle) = jobs_state().await;
    let mut events = state.events.subscribe();
    let SubmitOutcome::Accepted { job } =
        submit(&state, crate::idempotency::LOCAL_OWNER, "事件候选", None)
            .await
            .unwrap()
    else {
        panic!("受理");
    };
    // State transitions publish an empty hint; details stay behind the authorized API.
    let mut seen = 0;
    for _ in 0..200 {
        while let Ok(event) = events.try_recv() {
            assert!(matches!(event, WsEvent::AiTasksResync));
            assert_eq!(
                serde_json::to_string(&event).unwrap(),
                "{\"type\":\"ai_tasks_resync\"}"
            );
            seen += 1;
        }
        if seen >= 3 && job_row(&state, &job.job_id).await.state == "succeeded" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(
        seen >= 3,
        "每次任务状态变化都应发布无载荷提示 (seen={seen})"
    );
    state.audio.shutdown();
    handle.join().unwrap();
}

#[test]
fn month_key_is_utc_natural_month() {
    // 2026-10-17T00:00:00Z ≈ 1792070400000ms。
    assert_eq!(utc_month_key(1_792_070_400_000), "2026-10");
    // 2026-01-01T00:00:00Z。
    assert_eq!(utc_month_key(1_767_225_600_000), "2026-01");
    // 跨年边界：2025-12-31T23:59:59Z。
    assert_eq!(utc_month_key(1_767_225_599_000), "2025-12");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ledger_failure_does_not_block_proposal_and_pending_tokens_reconcile_later() {
    let (state, handle) = jobs_state().await;
    state
        .ai_runtime
        .install_provider(Arc::new(TokenOnlyProvider))
        .await;
    sqlx::query("CREATE TRIGGER fail_usage BEFORE INSERT ON ai_usage_entries BEGIN SELECT RAISE(ABORT, 'injected ledger failure'); END")
        .execute(&state.db).await.unwrap();
    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "ledger fault", None)
        .await
        .unwrap()
    else {
        panic!()
    };
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    // The worker may not have acquired its slot yet. Wait via DB rather than assuming spawn order.
    drop(slot);
    for _ in 0..200 {
        if job_row(&state, &job.job_id).await.state == "succeeded" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let row = job_row(&state, &job.job_id).await;
    assert_eq!(row.state, "succeeded");
    let proposal_id = row.result_proposal_id.as_deref().unwrap();
    let proposal = get_proposal(&state, "local-owner", proposal_id)
        .await
        .unwrap();
    assert_eq!(proposal.state, "pending");
    assert!(!proposal.validated_intent.is_null());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_proposals")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let attempt = row.attempt_id.as_deref().unwrap();
    {
        let mut conn = state.db.acquire().await.unwrap();
        assert!(store::find_pending_usage(&mut conn, &job.job_id, attempt)
            .await
            .unwrap()
            .is_some());
    }
    sqlx::query("DROP TRIGGER fail_usage")
        .execute(&state.db)
        .await
        .unwrap();
    assert_eq!(drain_pending_usage(&state).await.unwrap(), 0);
    let reconciled = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reconciled.usage_state, "unpriced");
    assert_eq!(
        serde_json::from_str::<TrustedUsage>(reconciled.reported_usage.as_deref().unwrap())
            .unwrap(),
        TrustedUsage {
            input_tokens: 345,
            output_tokens: 67,
        }
    );
    let mut conn = state.db.acquire().await.unwrap();
    assert!(store::find_pending_usage(&mut conn, &job.job_id, attempt)
        .await
        .unwrap()
        .is_none());
    let budget = status(&state, &row.owner_instance_id).await.unwrap();
    assert_eq!(budget["budget"]["chargedMicroUsd"], 0);
    assert_eq!(budget["budget"]["reservedMicroUsd"], 0);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proposal_failure_preserves_token_only_usage() {
    let (state, handle) = jobs_state().await;
    state
        .ai_runtime
        .install_provider(Arc::new(TokenOnlyProvider))
        .await;
    sqlx::query("CREATE TRIGGER fail_proposal BEFORE INSERT ON ai_proposals BEGIN SELECT RAISE(ABORT, 'injected proposal failure'); END")
        .execute(&state.db)
        .await
        .unwrap();

    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "proposal fault", None)
        .await
        .unwrap()
    else {
        panic!()
    };
    let terminal = await_terminal(&state, &job.job_id).await;
    assert_eq!(terminal.state, "failed");
    assert!(terminal.result_proposal_id.is_none());
    let usage = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "unpriced");
    assert_eq!(
        serde_json::from_str::<TrustedUsage>(usage.reported_usage.as_deref().unwrap()).unwrap(),
        TrustedUsage {
            input_tokens: 345,
            output_tokens: 67,
        }
    );
    let owner = instance_owner(&state).await.unwrap();
    let budget = status(&state, &owner).await.unwrap();
    assert_eq!(budget["budget"]["chargedMicroUsd"], 0);
    assert_eq!(budget["budget"]["reservedMicroUsd"], 0);

    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_ledger_failure_does_not_undo_token_only_task_success() {
    let (state, handle) = jobs_state().await;
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedTokenOnlyProvider {
            counter: counter.clone(),
            gate: gate.clone(),
        }))
        .await;
    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "token ledger retry", None)
        .await
        .unwrap()
    else {
        panic!()
    };

    let mut dispatched = false;
    for _ in 0..400 {
        let row = job_row(&state, &job.job_id).await;
        if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
            dispatched = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(dispatched, "fixture provider must be held after dispatch");

    let fail_until = now_ms() + 750;
    let trigger = format!(
        "CREATE TRIGGER fail_initial_unpriced_ledger BEFORE INSERT ON ai_usage_entries \
         WHEN NEW.usage_state = 'unpriced' AND NEW.created_at < {fail_until} \
         BEGIN SELECT RAISE(ABORT, 'fixture transient token ledger failure'); END"
    );
    sqlx::query(&trigger).execute(&state.db).await.unwrap();
    gate.store(true, std::sync::atomic::Ordering::SeqCst);

    let terminal = await_terminal(&state, &job.job_id).await;
    assert_eq!(terminal.state, "succeeded");
    assert_eq!(terminal.dispatch_state, "may_have_been_sent");
    let row = job_row(&state, &job.job_id).await;
    let attempt = row.attempt_id.as_deref().unwrap();
    assert!(row.result_proposal_id.is_some());
    assert!(store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .is_none());
    assert!(store::find_pending_usage(
        &mut state.db.acquire().await.unwrap(),
        &job.job_id,
        attempt,
    )
    .await
    .unwrap()
    .is_some());

    sqlx::query("DROP TRIGGER fail_initial_unpriced_ledger")
        .execute(&state.db)
        .await
        .unwrap();
    assert_eq!(drain_pending_usage(&state).await.unwrap(), 0);
    let usage = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "unpriced");
    assert_eq!(usage.accounted_micro_usd, 0);
    assert_eq!(
        serde_json::from_str::<TrustedUsage>(usage.reported_usage.as_deref().unwrap()).unwrap(),
        TrustedUsage {
            input_tokens: 345,
            output_tokens: 67,
        }
    );
    assert!(counter.load(std::sync::atomic::Ordering::SeqCst) == 1);
    // 终态先落库、执行槽在 worker 收尾时才归还；并发 CI 下两者之间可能有间隙。
    let mut slot_released = false;
    for _ in 0..1000 {
        if state.ai_runtime.execution_slots.available_permits() == 1 {
            slot_released = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(
        slot_released,
        "provider worker must release its execution slot"
    );
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_usage_survives_terminal_ledger_failure_until_recovery() {
    let (state, handle) = jobs_state().await;
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedTokenOnlyProvider {
            counter: counter.clone(),
            gate: gate.clone(),
        }))
        .await;
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "persistent token ledger", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    for _ in 0..400 {
        let row = job_row(&state, &job.job_id).await;
        if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let task = job_row(&state, &job.job_id).await;
    assert_eq!(task.dispatch_state, "may_have_been_sent");
    let attempt = task.attempt_id.as_deref().unwrap();
    sqlx::query(
        "CREATE TRIGGER fail_unpriced_ledger_until_recovery
         BEFORE INSERT ON ai_usage_entries WHEN NEW.usage_state = 'unpriced'
         BEGIN SELECT RAISE(ABORT, 'fixture persistent token ledger failure'); END",
    )
    .execute(&state.db)
    .await
    .unwrap();
    gate.store(true, std::sync::atomic::Ordering::SeqCst);

    let mut worker_stopped = false;
    for _ in 0..500 {
        let live_input = state
            .ai_runtime
            .inputs
            .lock()
            .await
            .contains_key(&job.job_id);
        if state.ai_runtime.execution_slots.available_permits() == 1 && !live_input {
            worker_stopped = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert!(
        worker_stopped,
        "provider worker should stop after bounded retries"
    );
    assert_eq!(job_row(&state, &job.job_id).await.state, "succeeded");
    assert!(store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .is_none());
    let pending =
        store::find_pending_usage(&mut state.db.acquire().await.unwrap(), &job.job_id, attempt)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(
        serde_json::from_str::<TrustedUsage>(&pending.usage_json).unwrap(),
        TrustedUsage {
            input_tokens: 345,
            output_tokens: 67,
        }
    );

    sqlx::query("DROP TRIGGER fail_unpriced_ledger_until_recovery")
        .execute(&state.db)
        .await
        .unwrap();
    assert_eq!(recover(&state).await.unwrap(), 0);
    let terminal = job_row(&state, &job.job_id).await;
    assert_eq!(terminal.state, "succeeded");
    let usage = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "unpriced");
    assert_eq!(
        serde_json::from_str::<TrustedUsage>(usage.reported_usage.as_deref().unwrap()).unwrap(),
        TrustedUsage {
            input_tokens: 345,
            output_tokens: 67,
        }
    );
    assert!(store::find_pending_usage(
        &mut state.db.acquire().await.unwrap(),
        &job.job_id,
        attempt,
    )
    .await
    .unwrap()
    .is_none());
    assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 1);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pending_usage_drain_continues_after_one_settlement_failure() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    let now = now_ms();
    let month = utc_month_key(now);
    let pricing_snapshot = serde_json::to_string(&PricingSnapshot {
        provider: "stepfun".into(),
        model: "step-5-preview".into(),
        quote: PriceQuote {
            pricing_version: usage::TOKEN_ONLY_PRICING_VERSION.into(),
            reservation_micro_usd: 0,
            input_micro_usd_per_million: 0,
            output_micro_usd_per_million: 0,
            max_input_tokens: 20_000,
            max_output_tokens: 8_000,
        },
        credential: None,
    })
    .unwrap();
    let trusted = TrustedUsage {
        input_tokens: 345,
        output_tokens: 67,
    };

    for job_id in ["pending-usage-01-fail", "pending-usage-02-healthy"] {
        let attempt_id = format!("{job_id}-attempt");
        store::insert_job(
            &state.db,
            &store::JobRow {
                job_id: job_id.into(),
                owner_instance_id: owner.clone(),
                principal: "local-owner".into(),
                capability: CAPABILITY.into(),
                key: format!("fixture-{job_id}"),
                input_hash: format!("hash-{job_id}"),
                state: "interrupted".into(),
                state_revision: 3,
                dispatch_state: "may_have_been_sent".into(),
                attempt_id: Some(attempt_id.clone()),
                provider: "stepfun".into(),
                model: "step-5-preview".into(),
                reservation_micro_usd: 0,
                pricing_snapshot: pricing_snapshot.clone(),
                created_at: now,
                updated_at: now,
                result_proposal_id: None,
                failure_code: None,
                provider_http_status: None,
            },
        )
        .await
        .unwrap();
        store::insert_usage_entry(
            &state.db,
            &store::UsageEntryInsert {
                job_id: job_id.into(),
                accepted_month: month.clone(),
                attempt_id: Some(attempt_id.clone()),
                reservation_micro_usd: 0,
                accounted_micro_usd: 0,
                usage_state: "unpriced".into(),
                pricing_snapshot: pricing_snapshot.clone(),
                reported_usage: None,
                revision: 1,
                created_at: now,
            },
        )
        .await
        .unwrap();
        store::insert_pending_usage(
            &state.db,
            &store::PendingUsageInsert {
                job_id: job_id.into(),
                attempt_id,
                owner_instance_id: owner.clone(),
                usage_json: serde_json::to_string(&trusted).unwrap(),
                created_at: now,
            },
        )
        .await
        .unwrap();
    }

    sqlx::query(
        "CREATE TRIGGER fail_one_pending_usage_reconcile
         BEFORE UPDATE OF reported_usage ON ai_usage_entries
         WHEN OLD.job_id = 'pending-usage-01-fail'
         BEGIN SELECT RAISE(ABORT, 'fixture pending usage failure'); END",
    )
    .execute(&state.db)
    .await
    .unwrap();

    assert!(recover(&state).await.is_err());
    for (job_id, pending, expected_usage) in [
        ("pending-usage-01-fail", true, None),
        ("pending-usage-02-healthy", false, Some(trusted.clone())),
    ] {
        let mut conn = state.db.acquire().await.unwrap();
        let entry = store::find_usage_entry(&mut *conn, job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.usage_state, "unpriced");
        assert_eq!(
            entry
                .reported_usage
                .as_deref()
                .map(serde_json::from_str::<TrustedUsage>)
                .transpose()
                .unwrap(),
            expected_usage
        );
        assert_eq!(
            store::find_pending_usage(&mut conn, job_id, &format!("{job_id}-attempt"))
                .await
                .unwrap()
                .is_some(),
            pending
        );
    }

    sqlx::query("DROP TRIGGER fail_one_pending_usage_reconcile")
        .execute(&state.db)
        .await
        .unwrap();
    assert_eq!(recover(&state).await.unwrap(), 0);
    assert_eq!(recover(&state).await.unwrap(), 0);
    for job_id in ["pending-usage-01-fail", "pending-usage-02-healthy"] {
        let mut conn = state.db.acquire().await.unwrap();
        let entry = store::find_usage_entry(&mut *conn, job_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.usage_state, "unpriced");
        assert_eq!(entry.revision, 2);
        assert_eq!(
            serde_json::from_str::<TrustedUsage>(entry.reported_usage.as_deref().unwrap()).unwrap(),
            trusted
        );
        assert!(
            store::find_pending_usage(&mut conn, job_id, &format!("{job_id}-attempt"))
                .await
                .unwrap()
                .is_none()
        );
    }

    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_proceeds_when_unrelated_orphan_sweep_fails() {
    let (state, handle) = jobs_state().await;
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedProvider {
            counter,
            gate: gate.clone(),
        }))
        .await;
    let SubmitOutcome::Accepted { job: running } =
        submit(&state, "local-owner", "cancel despite orphan failure", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    for _ in 0..200 {
        let row = job_row(&state, &running.job_id).await;
        if row.state == "running" && row.dispatch_state == "may_have_been_sent" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let running_row = job_row(&state, &running.job_id).await;
    assert_eq!(running_row.state, "running");
    assert_eq!(running_row.dispatch_state, "may_have_been_sent");

    let SubmitOutcome::Accepted { job: orphan } =
        submit(&state, "local-owner", "unrelated orphan", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    sqlx::query("UPDATE ai_jobs SET created_at = ?1 WHERE job_id = ?2")
        .bind(now_ms() - QUEUE_DEADLINE_MS - 1000)
        .bind(&orphan.job_id)
        .execute(&state.db)
        .await
        .unwrap();
    let cancel_owner = state
        .ai_runtime
        .inputs
        .lock()
        .await
        .remove(&orphan.job_id)
        .unwrap()
        .1;
    let trigger = format!(
        "CREATE TRIGGER fail_cancel_orphan_sweep BEFORE INSERT ON ai_usage_entries \
         WHEN NEW.job_id = '{}' AND NEW.usage_state = 'released' \
         BEGIN SELECT RAISE(ABORT, 'fixture sweep failure'); END",
        orphan.job_id
    );
    sqlx::query(&trigger).execute(&state.db).await.unwrap();
    let mut events = state.events.subscribe();

    let cancelled = cancel(
        &state,
        "local-owner",
        &running.job_id,
        running_row.state_revision,
    )
    .await
    .unwrap();
    assert_eq!(cancelled.state, "cancelled");
    assert_eq!(job_row(&state, &running.job_id).await.state, "cancelled");
    assert_eq!(job_row(&state, &orphan.job_id).await.state, "accepted");
    assert!(store::find_usage_entry(&state.db, &orphan.job_id)
        .await
        .unwrap()
        .is_none());
    assert!(matches!(events.try_recv().unwrap(), WsEvent::AiTasksResync));
    assert!(events.try_recv().is_err());

    sqlx::query("DROP TRIGGER fail_cancel_orphan_sweep")
        .execute(&state.db)
        .await
        .unwrap();
    sweep(&state).await.unwrap();
    assert_eq!(job_row(&state, &orphan.job_id).await.state, "expired");
    assert_eq!(
        store::find_usage_entry(&state.db, &orphan.job_id)
            .await
            .unwrap()
            .unwrap()
            .usage_state,
        "released"
    );
    assert!(matches!(events.try_recv().unwrap(), WsEvent::AiTasksResync));

    drop(cancel_owner);
    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recent_ownerless_task_recovers_after_lazy_sweep_failure() {
    let (state, handle) = jobs_state().await;
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedProvider {
            counter: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            gate: gate.clone(),
        }))
        .await;
    let SubmitOutcome::Accepted { job: orphan } =
        submit(&state, "local-owner", "query despite orphan failure", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    let cancel_owner = state
        .ai_runtime
        .inputs
        .lock()
        .await
        .remove(&orphan.job_id)
        .unwrap()
        .1;
    let trigger = format!(
        "CREATE TRIGGER fail_query_orphan_sweep BEFORE INSERT ON ai_usage_entries \
         WHEN NEW.job_id = '{}' AND NEW.usage_state = 'released' \
         BEGIN SELECT RAISE(ABORT, 'fixture sweep failure'); END",
        orphan.job_id
    );
    sqlx::query(&trigger).execute(&state.db).await.unwrap();

    let fetched = get_job(&state, "local-owner", &orphan.job_id)
        .await
        .unwrap();
    assert_eq!(fetched.state, "accepted");
    let owner = instance_owner(&state).await.unwrap();
    let listed = list_jobs(&state, "local-owner", &owner, None, None, 10)
        .await
        .unwrap();
    assert!(listed.iter().any(|job| job.job_id == orphan.job_id));
    let snapshot = status(&state, &owner).await.unwrap();
    assert_eq!(snapshot["queue"]["incomplete"], 1);

    sqlx::query("DROP TRIGGER fail_query_orphan_sweep")
        .execute(&state.db)
        .await
        .unwrap();
    sweep(&state).await.unwrap();
    let recovered = job_row(&state, &orphan.job_id).await;
    assert_eq!(recovered.state, "interrupted");
    assert_eq!(
        store::find_usage_entry(&state.db, &orphan.job_id)
            .await
            .unwrap()
            .unwrap()
            .usage_state,
        "released"
    );

    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    drop(cancel_owner);
    drop(slot);
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn orphan_sweep_continues_after_one_ledger_failure() {
    let (state, handle) = jobs_state().await;
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedProvider {
            counter: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            gate: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }))
        .await;
    let SubmitOutcome::Accepted { job: failed } =
        submit(&state, "local-owner", "orphan sweep failure fixture", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    let SubmitOutcome::Accepted { job: healthy } =
        submit(&state, "local-owner", "orphan sweep healthy fixture", None)
            .await
            .unwrap()
    else {
        panic!()
    };

    let stale = now_ms() - QUEUE_DEADLINE_MS - 1000;
    for job in [&failed, &healthy] {
        sqlx::query("UPDATE ai_jobs SET created_at = ?1 WHERE job_id = ?2")
            .bind(stale)
            .bind(&job.job_id)
            .execute(&state.db)
            .await
            .unwrap();
    }
    let cancel_owners = {
        let mut inputs = state.ai_runtime.inputs.lock().await;
        [&failed, &healthy]
            .into_iter()
            .map(|job| inputs.remove(&job.job_id).unwrap().1)
            .collect::<Vec<_>>()
    };
    let trigger = format!(
        "CREATE TRIGGER fail_one_orphan_sweep BEFORE INSERT ON ai_usage_entries \
         WHEN NEW.job_id = '{}' AND NEW.usage_state = 'released' \
         BEGIN SELECT RAISE(ABORT, 'fixture sweep failure'); END",
        failed.job_id
    );
    sqlx::query(&trigger).execute(&state.db).await.unwrap();
    let mut events = state.events.subscribe();

    assert!(sweep(&state).await.is_err());
    assert_eq!(job_row(&state, &failed.job_id).await.state, "accepted");
    assert_eq!(job_row(&state, &healthy.job_id).await.state, "expired");
    assert!(store::find_usage_entry(&state.db, &failed.job_id)
        .await
        .unwrap()
        .is_none());
    let healthy_usage = store::find_usage_entry(&state.db, &healthy.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(healthy_usage.usage_state, "released");
    let month = utc_month_key(stale);
    let reserved: i64 =
        sqlx::query_scalar("SELECT reserved_micro_usd FROM ai_budget_months WHERE month = ?1")
            .bind(month)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(reserved, failed.usage.reservation_micro_usd);
    let mut expired_events = 0;
    while let Ok(event) = events.try_recv() {
        assert!(matches!(event, WsEvent::AiTasksResync));
        expired_events += 1;
    }
    assert_eq!(expired_events, 1);

    sqlx::query("DROP TRIGGER fail_one_orphan_sweep")
        .execute(&state.db)
        .await
        .unwrap();
    sweep(&state).await.unwrap();
    assert_eq!(job_row(&state, &failed.job_id).await.state, "expired");
    let failed_usage = store::find_usage_entry(&state.db, &failed.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(failed_usage.usage_state, "released");
    let reserved: i64 =
        sqlx::query_scalar("SELECT reserved_micro_usd FROM ai_budget_months WHERE month = ?1")
            .bind(utc_month_key(stale))
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(reserved, 0);
    assert!(matches!(events.try_recv().unwrap(), WsEvent::AiTasksResync));

    drop(cancel_owners);
    drop(slot);
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn failed_terminal_transactions_publish_no_events_and_orphan_sweep_rolls_back() {
    let (state, handle) = jobs_state().await;
    let _slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "atomic expiry", None)
        .await
        .unwrap()
    else {
        panic!()
    };
    let mut events = state.events.subscribe();
    sqlx::query("CREATE TRIGGER fail_usage BEFORE INSERT ON ai_usage_entries BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
        .execute(&state.db).await.unwrap();
    assert!(cancel(&state, "local-owner", &job.job_id, 1).await.is_err());
    assert!(recover(&state).await.is_err());
    assert!(state
        .ai_runtime
        .inputs
        .lock()
        .await
        .contains_key(&job.job_id));
    sqlx::query("UPDATE ai_jobs SET created_at = ?1 WHERE job_id = ?2")
        .bind(now_ms() - QUEUE_DEADLINE_MS - 1000)
        .bind(&job.job_id)
        .execute(&state.db)
        .await
        .unwrap();
    let cancel_owner = state
        .ai_runtime
        .inputs
        .lock()
        .await
        .remove(&job.job_id)
        .unwrap()
        .1;
    assert!(sweep(&state).await.is_err());
    assert_eq!(job_row(&state, &job.job_id).await.state, "accepted");
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(event, WsEvent::AiTasksResync));
    }
    sqlx::query("DROP TRIGGER fail_usage")
        .execute(&state.db)
        .await
        .unwrap();
    assert_eq!(recover(&state).await.unwrap(), 1);
    assert_eq!(job_row(&state, &job.job_id).await.state, "interrupted");
    assert!(matches!(events.try_recv().unwrap(), WsEvent::AiTasksResync));
    drop(cancel_owner);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disabled_generation_replays_but_does_not_dispatch_queued_jobs() {
    let (state, handle) = jobs_state().await;
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedProvider {
            counter: counter.clone(),
            gate: gate.clone(),
        }))
        .await;
    submit(&state, "local-owner", "active", None).await.unwrap();
    for _ in 0..200 {
        if counter.load(std::sync::atomic::Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let key = format!("v1.{}.{}", now_ms(), uuid::Uuid::new_v4().simple());
    let SubmitOutcome::Accepted { job } = submit(&state, "local-owner", "queued", Some(&key))
        .await
        .unwrap()
    else {
        panic!()
    };
    vmusic_store::settings::set(&state.db, CONSENT_KEY, &json!(false))
        .await
        .unwrap();
    assert!(matches!(
        submit(&state, "local-owner", "queued", Some(&key))
            .await
            .unwrap(),
        SubmitOutcome::Replayed { .. }
    ));
    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    for _ in 0..200 {
        if job_row(&state, &job.job_id).await.state == "failed" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let row = job_row(&state, &job.job_id).await;
    assert_eq!(row.state, "failed");
    assert_eq!(row.dispatch_state, "not_dispatched");
    assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        store::find_usage_entry(&state.db, &job.job_id)
            .await
            .unwrap()
            .unwrap()
            .usage_state,
        "released"
    );
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn consent_revoked_before_success_commit_cannot_create_proposal() {
    let (state, handle) = jobs_state().await;
    let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(BlockedProvider {
            counter: counter.clone(),
            gate: gate.clone(),
        }))
        .await;
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "revoke before commit", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    for _ in 0..200 {
        if counter.load(std::sync::atomic::Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(counter.load(std::sync::atomic::Ordering::SeqCst), 1);
    vmusic_store::settings::set(&state.db, CONSENT_KEY, &json!(false))
        .await
        .unwrap();
    gate.store(true, std::sync::atomic::Ordering::SeqCst);

    let terminal = await_terminal(&state, &job.job_id).await;
    assert_eq!(terminal.state, "cancelled");
    assert_eq!(terminal.result_proposal_id, None);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn consent_revocation_signals_provider_before_ledger_failure() {
    use tokio::sync::Notify;

    struct CancellationObserver {
        started: Arc<Notify>,
        observed: Arc<Notify>,
        release: Arc<Notify>,
    }
    impl StageIntentProvider for CancellationObserver {
        fn id(&self) -> &'static str {
            "consent-revoke-fixture"
        }
        fn model(&self) -> &str {
            "consent-revoke-v1"
        }
        fn ready(&self) -> bool {
            true
        }
        fn quote(&self, _: &str) -> Result<PriceQuote, String> {
            Ok(metered_quote())
        }
        fn generate(
            &self,
            _: String,
            _: PricingSnapshot,
            _: Option<crate::ai::credential::ProviderCredential>,
            mut cancellation: ProviderCancellation,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProviderReply> + Send>> {
            let started = self.started.clone();
            let observed = self.observed.clone();
            let release = self.release.clone();
            started.notify_one();
            Box::pin(async move {
                cancellation.cancelled().await;
                observed.notify_one();
                release.notified().await;
                ProviderReply {
                    intent: Err("cancelled transport finished cleanup".into()),
                    usage: None,
                }
            })
        }
    }

    let (state, handle) = jobs_state().await;
    let provider = Arc::new(CancellationObserver {
        started: Arc::new(Notify::new()),
        observed: Arc::new(Notify::new()),
        release: Arc::new(Notify::new()),
    });
    state.ai_runtime.install_provider(provider.clone()).await;
    let SubmitOutcome::Accepted { job } =
        submit(&state, "local-owner", "revoke under ledger failure", None)
            .await
            .unwrap()
    else {
        panic!()
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        provider.started.notified(),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_revoke_settlement BEFORE INSERT ON ai_usage_entries BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
        .execute(&state.db)
        .await
        .unwrap();
    vmusic_store::settings::set(&state.db, CONSENT_KEY, &json!(false))
        .await
        .unwrap();

    assert!(revoke_generation_consent(&state).await.is_err());
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        provider.observed.notified(),
    )
    .await
    .unwrap();
    sqlx::query("DROP TRIGGER fail_revoke_settlement")
        .execute(&state.db)
        .await
        .unwrap();
    sweep(&state).await.unwrap();
    assert_eq!(job_row(&state, &job.job_id).await.state, "running");
    assert!(state
        .ai_runtime
        .inputs
        .lock()
        .await
        .contains_key(&job.job_id));
    provider.release.notify_one();

    let terminal = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        await_terminal(&state, &job.job_id),
    )
    .await
    .unwrap();
    assert_eq!(terminal.state, "cancelled");
    assert_eq!(terminal.result_proposal_id, None);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn consent_revocation_cancels_queued_worker_after_ledger_failure() {
    let (state, handle) = jobs_state().await;
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let gate = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_runtime
        .install_provider(Arc::new(MeteredProvider {
            gate: gate.clone(),
            rate: Arc::new(std::sync::atomic::AtomicU64::new(1_000_000)),
            reply: Ok(json!({ "version": 1, "scene": "orb", "patch": {} })),
            usage: None,
        }))
        .await;
    let SubmitOutcome::Accepted { job } = submit(
        &state,
        "local-owner",
        "queued revoke under ledger failure",
        None,
    )
    .await
    .unwrap() else {
        panic!()
    };
    assert_eq!(job_row(&state, &job.job_id).await.state, "accepted");
    assert_eq!(
        job_row(&state, &job.job_id).await.dispatch_state,
        "not_dispatched"
    );

    sqlx::query("CREATE TRIGGER fail_queued_revoke_settlement BEFORE INSERT ON ai_usage_entries BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
        .execute(&state.db)
        .await
        .unwrap();
    vmusic_store::settings::set(&state.db, CONSENT_KEY, &json!(false))
        .await
        .unwrap();
    assert!(revoke_generation_consent(&state).await.is_err());

    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    assert_eq!(job_row(&state, &job.job_id).await.state, "accepted");
    sqlx::query("DROP TRIGGER fail_queued_revoke_settlement")
        .execute(&state.db)
        .await
        .unwrap();

    let terminal = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        await_terminal(&state, &job.job_id),
    )
    .await
    .unwrap();
    assert_eq!(terminal.state, "cancelled");
    assert_eq!(terminal.dispatch_state, "not_dispatched");
    assert_eq!(terminal.result_proposal_id, None);
    let usage = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "released");
    assert_eq!(usage.accounted_micro_usd, 0);
    assert!(!state
        .ai_runtime
        .inputs
        .lock()
        .await
        .contains_key(&job.job_id));

    gate.store(true, std::sync::atomic::Ordering::SeqCst);
    drop(slot);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acceptance_survives_waiter_abort_and_history_filters_before_limit() {
    let (state, handle) = jobs_state().await;
    let slot = state.ai_runtime.execution_slots.acquire().await.unwrap();
    let owner = instance_owner(&state).await.unwrap();
    let inputs = state.ai_runtime.inputs.lock().await;
    let task_state = state.clone();
    let waiter = tokio::spawn(async move { submit(&task_state, "alice", "detached", None).await });
    // Admission is detached and blocked on the handoff mutex. Abort only the caller.
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    waiter.abort();
    let _ = waiter.await;
    drop(inputs);
    let mut rows = Vec::new();
    for _ in 0..200 {
        rows = store::list_jobs(&state.db, &owner, "alice", None, None, 1)
            .await
            .unwrap();
        if !rows.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let job = rows.first().unwrap().clone();
    submit(&state, "bob", "newer", None).await.unwrap();
    sqlx::query("UPDATE ai_jobs SET created_at = created_at + 1 WHERE principal = 'bob'")
        .execute(&state.db)
        .await
        .unwrap();
    let listed = list_jobs(&state, "alice", &owner, None, None, 1)
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].job_id, job.job_id);
    drop(slot);
    for _ in 0..200 {
        if job_row(&state, &job.job_id).await.state == "succeeded" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(job_row(&state, &job.job_id).await.state, "succeeded");
    state.audio.shutdown();
    handle.join().unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn official_rpc_exposes_the_same_persistent_job_lifecycle() {
    use crate::rpc::{Call, Op, Rpc};
    async fn call(rpc: &Rpc, op: Op, path: &str, body: Value) -> Value {
        rpc.call(Call {
            op,
            path,
            query: json!({}),
            body,
            raw: None,
            client_operation_id: None,
        })
        .await
        .unwrap()
        .body
    }
    let (state, handle) = jobs_state().await;
    let rpc = Rpc::new(state.clone());
    assert_eq!(
        call(&rpc, Op::Get, "v1/ai/status", Value::Null).await["consent"]["inAppGeneration"],
        true
    );
    let result = call(&rpc, Op::Post, "v1/ai/jobs", json!({"brief":"RPC stage"})).await;
    let id = result["job"]["jobId"].as_str().unwrap();
    let mut done = Value::Null;
    for _ in 0..200 {
        done = call(&rpc, Op::Get, &format!("v1/ai/jobs/{id}"), Value::Null).await;
        if done["state"] == "succeeded" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(done["state"], "succeeded");
    assert_eq!(
        call(&rpc, Op::Get, "v1/ai/jobs", Value::Null).await["jobs"][0]["jobId"],
        id
    );
    let proposal_id = done["resultProposalId"].as_str().unwrap();
    let path = format!("v1/ai/proposals/{proposal_id}");
    let proposal = call(&rpc, Op::Get, &path, Value::Null).await;
    assert_eq!(proposal["state"], "pending");
    assert_eq!(
        call(
            &rpc,
            Op::Post,
            &(path + "/reject"),
            json!({"expected_revision":proposal["revision"]})
        )
        .await["state"],
        "rejected"
    );
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn token_only_settlement_records_over_bound_usage_without_claiming_cost() {
    let (state, handle) = jobs_state().await;
    let owner = instance_owner(&state).await.unwrap();
    let month = utc_month_key(now_ms());
    let pricing = PricingSnapshot {
        provider: "stepfun".into(),
        model: "step-5-preview".into(),
        quote: PriceQuote {
            pricing_version: super::super::usage::TOKEN_ONLY_PRICING_VERSION.into(),
            reservation_micro_usd: 0,
            input_micro_usd_per_million: 0,
            output_micro_usd_per_million: 0,
            max_input_tokens: 20_000,
            max_output_tokens: 8_000,
        },
        credential: None,
    };
    let make_job = |id: &str| store::JobRow {
        job_id: id.into(),
        owner_instance_id: owner.clone(),
        principal: "local-owner".into(),
        capability: CAPABILITY.into(),
        key: id.into(),
        input_hash: "fixture-hash".into(),
        state: "running".into(),
        state_revision: 2,
        dispatch_state: "may_have_been_sent".into(),
        attempt_id: Some(format!("{id}-attempt")),
        provider: pricing.provider.clone(),
        model: pricing.model.clone(),
        reservation_micro_usd: 0,
        pricing_snapshot: serde_json::to_string(&pricing).unwrap(),
        created_at: now_ms(),
        updated_at: now_ms(),
        result_proposal_id: None,
        failure_code: None,
        provider_http_status: None,
    };
    let immediate_usage = TrustedUsage {
        input_tokens: 20_001,
        output_tokens: 321,
    };
    let late_usage = TrustedUsage {
        input_tokens: 1_234,
        output_tokens: 8_001,
    };
    let first = make_job("token-only-immediate");
    let late = make_job("token-only-late");
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    store::get_or_create_month(&mut tx, &month).await.unwrap();
    store::insert_job(&mut *tx, &first).await.unwrap();
    store::insert_job(&mut *tx, &late).await.unwrap();
    assert!(
        !store::ensure_budget_guard(&mut tx, &owner)
            .await
            .unwrap()
            .token_halted
    );
    usage::settle_terminal(&mut tx, &first, Some(&immediate_usage), now_ms())
        .await
        .unwrap();
    let guard = store::budget_guard(&mut *tx).await.unwrap().unwrap();
    assert!(!guard.token_halted);
    assert!(!guard.halted);
    usage::settle_terminal(&mut tx, &late, None, now_ms())
        .await
        .unwrap();
    assert!(usage::reconcile(
        &mut tx,
        &owner,
        &late.job_id,
        late.attempt_id.as_deref().unwrap(),
        1,
        &late_usage,
    )
    .await
    .unwrap());
    tx.commit().await.unwrap();

    for (id, expected_usage) in [
        (&first.job_id, &immediate_usage),
        (&late.job_id, &late_usage),
    ] {
        let entry = store::find_usage_entry(&state.db, id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.usage_state, "unpriced");
        assert_eq!(entry.accounted_micro_usd, 0);
        assert_eq!(
            serde_json::from_str::<TrustedUsage>(entry.reported_usage.as_deref().unwrap()).unwrap(),
            expected_usage.clone()
        );
    }
    let mut conn = state.db.acquire().await.unwrap();
    let budget = store::get_or_create_month(&mut conn, &month).await.unwrap();
    assert_eq!(budget.charged_micro_usd, 0);
    assert_eq!(budget.reserved_micro_usd, 0);
    let guard = store::ensure_budget_guard(&mut conn, &owner).await.unwrap();
    assert!(!guard.token_halted);
    assert!(!guard.halted);
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test]
async fn token_only_generation_ignores_legacy_accounting_guards() {
    let (state, handle) = jobs_state().await;
    state
        .ai_runtime
        .install_provider(Arc::new(TokenOnlyProvider))
        .await;
    let owner = instance_owner(&state).await.unwrap();
    let mut tx = vmusic_store::begin_immediate(&state.db).await.unwrap();
    store::halt_budget_guard(&mut tx, &owner, "metered fixture", "priced-task")
        .await
        .unwrap();
    store::halt_token_guard(&mut tx, &owner, "legacy token fixture", "old-task")
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let state_view = status(&state, &owner).await.unwrap();
    assert_eq!(state_view["provider"]["pricingMode"], "token_only");
    assert_eq!(
        state_view["provider"]["resetConfigFingerprint"]
            .as_str()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(state_view["guard"]["halted"], true);
    assert_eq!(state_view["guard"]["tokenHalted"], true);
    let SubmitOutcome::Accepted { job } =
        submit(&state, crate::idempotency::LOCAL_OWNER, "继续生成", None)
            .await
            .unwrap()
    else {
        panic!("token-only 请求应被受理");
    };
    let mut view = get_job(&state, crate::idempotency::LOCAL_OWNER, &job.job_id)
        .await
        .unwrap();
    for _ in 0..1000 {
        if view.state == "succeeded" {
            break;
        }
        // CI 并行跑完整测试套件时，SQLite 争用会让一次假 provider 任务超过 1s；
        // 给到 5s 只放宽等待上限，不改变「最终必须成功」的断言。
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        view = get_job(&state, crate::idempotency::LOCAL_OWNER, &job.job_id)
            .await
            .unwrap();
    }
    assert_eq!(view.state, "succeeded");
    let entry = store::find_usage_entry(&state.db, &job.job_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.usage_state, "unpriced");
    let usage: TrustedUsage =
        serde_json::from_str(entry.reported_usage.as_deref().unwrap()).unwrap();
    assert_eq!(usage.input_tokens, 345);
    assert_eq!(usage.output_tokens, 67);
    let mut conn = state.db.acquire().await.unwrap();
    let budget = store::get_or_create_month(&mut conn, &utc_month_key(now_ms()))
        .await
        .unwrap();
    assert_eq!(budget.charged_micro_usd, 0);
    assert_eq!(budget.reserved_micro_usd, 0);
    let guard = store::budget_guard(&mut *conn).await.unwrap().unwrap();
    assert!(
        guard.halted,
        "token-only dispatch must not reset a metered guard"
    );
    state.audio.shutdown();
    handle.join().unwrap();
}
