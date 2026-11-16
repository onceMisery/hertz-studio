// SPDX-License-Identifier: MIT
//! Offline acceptance at the existing quote/runner/artifact seam.
use super::*;

fn metadata() -> Vec<u8> {
    serde_json::to_vec(
        &json!({"assets":[{"alias":"asset-1","kind":"image","width":640,"height":480}]}),
    )
    .unwrap()
}

fn composition_request(snapshot: &serde_json::Value, asset_set: &str) -> Vec<u8> {
    let mut request = wallpaper_request(snapshot, "coast");
    request["output"] = json!({"kind":"composition","assetSetId":asset_set});
    serde_json::to_vec(&request).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn composition_selected_metadata_quote_runs_once_and_publishes_artifact() {
    let (state, handle) = jobs_state().await;
    let principal = crate::idempotency::LOCAL_OWNER;
    let snapshot = wallpaper_snapshot(&state).await;
    assert!(snapshot["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|output| output["kind"] == "composition" && output["ready"] == true));
    let assets = super::super::wallpaper_asset_set(&state, principal, &metadata())
        .await
        .unwrap();
    assert_eq!(assets["digest"].as_str().unwrap().len(), 64);
    let request = composition_request(&snapshot, assets["assetSetId"].as_str().unwrap());
    let quote = super::super::wallpaper_quote(&state, principal, &request)
        .await
        .unwrap();
    assert_eq!(quote["assetSetDigest"], assets["digest"]);
    assert_eq!(quote["assetCount"], 1);
    assert!(state.ai_runtime.inputs.lock().await.is_empty());
    let key = client_key();
    let outcome = super::super::wallpaper_submit(
        &state,
        principal,
        quote["quoteId"].as_str().unwrap(),
        "wreq-1",
        Some(&key),
    )
    .await
    .unwrap();
    let SubmitOutcome::Accepted { job } = outcome else {
        panic!("new admission")
    };
    assert_eq!(await_terminal(&state, &job.job_id).await.state, "succeeded");
    let artifact = crate::ai::wallpaper_artifacts::job(&state, principal, &job.job_id)
        .await
        .unwrap();
    assert_eq!(artifact["artifact"]["kind"], "composition");
    let replay = super::super::wallpaper_submit(
        &state,
        principal,
        quote["quoteId"].as_str().unwrap(),
        "wreq-1",
        Some(&key),
    )
    .await
    .unwrap();
    assert!(matches!(replay, SubmitOutcome::Replayed { .. }));
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn composition_missing_or_private_metadata_cannot_quote_or_dispatch() {
    let (state, handle) = jobs_state().await;
    let principal = crate::idempotency::LOCAL_OWNER;
    let snapshot = wallpaper_snapshot(&state).await;
    let bad = br#"{"assets":[{"alias":"asset-1","kind":"image","width":640,"height":480,"filename":"private.png"}]}"#;
    assert!(super::super::wallpaper_asset_set(&state, principal, bad)
        .await
        .is_err());
    let missing = super::super::wallpaper_quote(
        &state,
        principal,
        &composition_request(&snapshot, "missing"),
    )
    .await
    .unwrap_err();
    assert_eq!(missing.code, "asset_set_unknown");
    assert!(state.ai_runtime.inputs.lock().await.is_empty());
    state.audio.shutdown();
    handle.join().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn composition_group_quota_survives_admission_until_terminal() {
    let (state, handle) = jobs_state().await;
    let principal = crate::idempotency::LOCAL_OWNER;
    let snapshot = wallpaper_snapshot(&state).await;
    let permit = state
        .ai_runtime
        .execution_slots
        .clone()
        .acquire_owned()
        .await
        .unwrap();
    let mut jobs = Vec::new();
    for index in 0..8 {
        let assets = super::super::wallpaper_asset_set(&state, principal, &metadata())
            .await
            .unwrap();
        let mut request: serde_json::Value = serde_json::from_slice(&composition_request(
            &snapshot,
            assets["assetSetId"].as_str().unwrap(),
        ))
        .unwrap();
        request["requestId"] = json!(format!("quota-{index}"));
        let quote = super::super::wallpaper_quote(
            &state,
            principal,
            &serde_json::to_vec(&request).unwrap(),
        )
        .await
        .unwrap();
        let outcome = super::super::wallpaper_submit(
            &state,
            principal,
            quote["quoteId"].as_str().unwrap(),
            request["requestId"].as_str().unwrap(),
            Some(&client_key()),
        )
        .await
        .unwrap();
        let SubmitOutcome::Accepted { job } = outcome else {
            panic!("new admission")
        };
        jobs.push(job.job_id);
    }
    let ninth = super::super::wallpaper_asset_set(&state, principal, &metadata()).await;
    drop(permit);
    for job in jobs {
        assert_eq!(await_terminal(&state, &job).await.state, "succeeded");
    }
    let after_terminal = super::super::wallpaper_asset_set(&state, principal, &metadata()).await;
    state.audio.shutdown();
    handle.join().unwrap();
    assert_eq!(ninth.unwrap_err().code, "asset_set_capacity_exceeded");
    assert!(after_terminal.is_ok());
}
