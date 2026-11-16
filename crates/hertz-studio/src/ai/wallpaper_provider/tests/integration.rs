// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::*;
use crate::state::AppState;
use vmusic_store::ai_jobs as store;

async fn state(provider: Ollama) -> (Arc<AppState>, std::thread::JoinHandle<()>) {
    let dir = std::env::temp_dir().join(format!("hertz-ollama-wallpaper-{}", uuid::Uuid::new_v4()));
    let db = vmusic_store::open(&dir).await.unwrap();
    let (mut state, handle) = crate::state::tests::playback_state_with_db(db).await;
    state.data_dir = dir;
    state.ai_runtime = jobs::AiRuntime::with_test_provider(Arc::new(provider));
    state.ai_runner_held.store(true, Ordering::Relaxed);
    vmusic_store::settings::set(&state.db, jobs::CONSENT_KEY, &json!(true))
        .await
        .unwrap();
    (Arc::new(state), handle)
}

async fn terminal(state: &AppState, id: &str) -> store::JobRow {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let row = store::find_job_by_id(&state.db, id).await.unwrap().unwrap();
            if !matches!(row.state.as_str(), "accepted" | "running") {
                return row;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ollama_wallpaper_jobs_quote_once_publish_original_artifact_and_replay() {
    for valid in [true, false] {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let app = axum::Router::new().route(
            "/api/chat",
            post(
                move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                    let calls = observed.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        assert!(!headers.contains_key("authorization"));
                        assert!(!headers.contains_key("cookie"));
                        assert_eq!(body["model"], "test-local");
                        assert_eq!(body["options"]["num_predict"], OUTPUT_TOKENS);
                        assert_eq!(
                            body["format"]["oneOf"][0]["properties"]["sceneId"]["const"],
                            "coast"
                        );
                        assert!(body["messages"][0]["content"]
                            .as_str()
                            .unwrap()
                            .contains("wallpaper"));
                        let mut value = output();
                        if !valid {
                            value["params"]["tod"] = json!(2);
                        }
                        Json(envelope(&value.to_string()))
                    }
                },
            ),
        );
        let (origin, server_task) = server(app).await;
        let (state, handle) = state(Ollama::new(&origin, "test-local").unwrap()).await;
        let capabilities =
            serde_json::to_value(jobs::wallpaper_capabilities(&state).await.unwrap()).unwrap();
        assert_eq!(capabilities["outputs"][0]["ready"], true);
        let mut request = input("coast");
        request.capability_snapshot_id = capabilities["snapshotId"].as_str().unwrap().into();
        let quote = jobs::wallpaper_quote(
            &state,
            crate::idempotency::LOCAL_OWNER,
            &serde_json::to_vec(&request).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(quote["provider"], "ollama-local");
        assert_eq!(quote["maximumCostMicroUsd"], 0);
        assert_eq!(quote["maxOutputTokens"], OUTPUT_TOKENS);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "quote cannot make a model request"
        );
        let key = format!(
            "v1.{}.{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
            uuid::Uuid::new_v4().simple()
        );
        let quote_id = quote["quoteId"].as_str().unwrap();
        let outcome = jobs::wallpaper_submit(
            &state,
            crate::idempotency::LOCAL_OWNER,
            quote_id,
            &request.request_id,
            Some(&key),
        )
        .await
        .unwrap();
        let id = match outcome {
            jobs::SubmitOutcome::Accepted { job } => job.job_id,
            jobs::SubmitOutcome::Replayed { .. } => panic!("new submit must create a job"),
        };
        let row = terminal(&state, &id).await;
        assert_eq!(row.state, if valid { "succeeded" } else { "failed" });
        assert_eq!(
            row.failure_code.as_deref(),
            if valid { None } else { Some("invalid_output") }
        );
        assert!(row.result_proposal_id.is_none());
        let artifact: Option<(String, String)> = sqlx::query_as("SELECT artifact_id,sha256 FROM ai_wallpaper_artifacts WHERE job_id=? AND state='available'")
            .bind(&id).fetch_optional(&state.db).await.unwrap();
        if valid {
            let (artifact_id, hash) = artifact.unwrap();
            let bytes = tokio::fs::read(
                state
                    .data_dir
                    .join("ai/wallpaper-artifacts")
                    .join(artifact_id)
                    .join("payload"),
            )
            .await
            .unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), output());
            use sha2::Digest;
            assert_eq!(format!("{:x}", sha2::Sha256::digest(bytes)), hash);
        } else {
            assert!(
                artifact.is_none(),
                "invalid output cannot become a candidate"
            );
        }
        let usage = store::find_usage_entry(&state.db, &id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(usage.accounted_micro_usd, 0);
        assert_eq!(usage.usage_state, "reported");
        let reported: Value =
            serde_json::from_str(usage.reported_usage.as_deref().unwrap()).unwrap();
        assert_eq!(reported["inputTokens"], 1234);
        assert_eq!(reported["outputTokens"], 42);
        let replay = jobs::wallpaper_submit(
            &state,
            crate::idempotency::LOCAL_OWNER,
            quote_id,
            &request.request_id,
            Some(&key),
        )
        .await
        .unwrap();
        match replay {
            jobs::SubmitOutcome::Replayed { job } => assert_eq!(job.job_id, id),
            _ => panic!("same request must replay the original job"),
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        state.audio.shutdown();
        handle.join().unwrap();
        server_task.abort();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ollama_wallpaper_job_cancel_retains_dispatch_fact_and_releases_execution_slot() {
    let started = Arc::new(tokio::sync::Notify::new());
    let observed = started.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let app = axum::Router::new().route(
        "/api/chat",
        post(move |Json(_body): Json<Value>| {
            let observed = observed.clone();
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                observed.notify_one();
                std::future::pending::<Json<Value>>().await
            }
        }),
    );
    let (origin, server_task) = server(app).await;
    let (state, handle) = state(Ollama::new(&origin, "test-local").unwrap()).await;
    let capabilities =
        serde_json::to_value(jobs::wallpaper_capabilities(&state).await.unwrap()).unwrap();
    let mut request = input("coast");
    request.capability_snapshot_id = capabilities["snapshotId"].as_str().unwrap().into();
    let quote = jobs::wallpaper_quote(
        &state,
        crate::idempotency::LOCAL_OWNER,
        &serde_json::to_vec(&request).unwrap(),
    )
    .await
    .unwrap();
    let outcome = jobs::wallpaper_submit(
        &state,
        crate::idempotency::LOCAL_OWNER,
        quote["quoteId"].as_str().unwrap(),
        &request.request_id,
        None,
    )
    .await
    .unwrap();
    let id = match outcome {
        jobs::SubmitOutcome::Accepted { job } => job.job_id,
        _ => panic!("new job required"),
    };
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    let row = store::find_job_by_id(&state.db, &id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.dispatch_state, "may_have_been_sent");
    jobs::cancel(
        &state,
        crate::idempotency::LOCAL_OWNER,
        &id,
        row.state_revision,
    )
    .await
    .unwrap();
    assert_eq!(terminal(&state, &id).await.state, "cancelled");
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.ai_runtime.completion_slots().available_permits() != 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let usage = store::find_usage_entry(&state.db, &id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(usage.usage_state, "unknown");
    assert_eq!(usage.accounted_micro_usd, 0);
    assert!(usage.reported_usage.is_none());
    let available: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ai_wallpaper_artifacts WHERE job_id=? AND state='available'",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await
    .unwrap();
    assert_eq!(available, 0);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    state.audio.shutdown();
    handle.join().unwrap();
    server_task.abort();
}
