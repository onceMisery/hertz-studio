// SPDX-License-Identifier: MIT
use super::*;
use crate::ai::{credential, jobs};
use crate::config::AiConfig;
use axum::{routing::post, Json};
use reqwest::Url;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn input(composition: bool) -> WallpaperGenerateRequest {
    serde_json::from_value(json!({
        "version":1,"requestId":"cloud-wallpaper","brief":"夜色海岸，减少动态",
        "output":if composition {json!({"kind":"composition","assetSetId":"selected"})}
            else {json!({"kind":"builtin","sceneId":"coast"})},
        "registryHash":hertz_wallpaper::catalog().registry_hash,
        "generationSchemaHash":crate::ai::wallpaper_jobs::generation_schema_hash(),
        "capabilitySnapshotId":"fixture-snapshot"
    }))
    .unwrap()
}

fn assets() -> AssetSet {
    AssetSet::parse(br#"{"assets":[{"alias":"asset-1","kind":"image","width":640,"height":480}]}"#)
        .unwrap()
}

fn output(composition: bool) -> Value {
    if composition {
        json!({"kind":"composition","document":{"documentVersion":1,
            "canvas":{"width":1920,"height":1080,"colorSpace":"srgb","background":"#101010"},
            "nodes":[{"id":"picture","type":"image","stateVersion":1,"assets":{"asset":"asset-1"},"properties":{}}],
            "timeline":{"durationSeconds":10,"loop":true,"tracks":[]},"bindings":[],"effects":[]}})
    } else {
        json!({"kind":"builtin","sceneId":"coast","stateVersion":1,"params":{"tod":0.72,"reduced":true}})
    }
}

fn response(text: &str) -> Value {
    json!({"model":"gpt-6-astra","status":"completed","error":null,"incomplete_details":null,
        "output":[{"type":"message","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":text,"annotations":[]}]}],
        "usage":{"input_tokens":47,"output_tokens":15,"total_tokens":62}})
}

fn snapshot(
    provider: &OpenAi,
    input: &WallpaperGenerateRequest,
    assets: Option<&AssetSet>,
) -> PricingSnapshot {
    PricingSnapshot {
        provider: provider.id().into(),
        model: provider.model().into(),
        quote: quote(provider, input, assets).unwrap(),
        credential: Some(credential::test_identity()),
    }
}

async fn fixture(app: axum::Router) -> (OpenAi, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}/v1/responses",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let mut provider =
        OpenAi::with_test_endpoint("gpt-6-astra", endpoint, Some(openai_token_only_quote()))
            .unwrap();
    provider.id = "openai-compatible";
    (
        provider,
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() }),
    )
}

#[test]
fn compatible_configuration_is_explicit_public_and_keeps_official_destination() {
    let origin = "https://MODELS.EXAMPLE.COM:443/v1/";
    let provider = OpenAi::compatible(origin, "gpt-6-astra").unwrap();
    assert_eq!(provider.id(), "openai-compatible");
    assert_eq!(
        provider.endpoint_identity(),
        Some("https://models.example.com/v1/responses")
    );
    assert_eq!(
        super::super::compatible_origin(origin).unwrap().as_str(),
        "https://models.example.com/v1"
    );
    for origin in [
        "",
        "http://models.example.com/v1",
        "https://localhost/v1",
        "https://127.0.0.1/v1",
        "https://[::1]/v1",
        "https://10.1.2.3/v1",
        "https://[::ffff:127.0.0.1]/v1",
        "https://user:fixture@models.example.com/v1",
        "https://models.example.com/v1?key=fixture",
        "https://models.example.com/v1#secret",
        "https://models.example.com:0/v1",
        "https://models.example.com/v1/responses",
        "https://models.example.com/",
        "https://models.example.com/v1\n",
    ] {
        assert!(
            OpenAi::compatible(origin, "gpt-6-astra").is_err(),
            "{origin}"
        );
    }
    let default_compatible = super::super::configured(&AiConfig {
        provider: "openai-compatible".into(),
        model: "gpt-6-astra".into(),
        ..Default::default()
    });
    assert!(!default_compatible.ready());
    let official = super::super::configured(&AiConfig {
        provider: "openai".into(),
        origin: origin.into(),
        model: "gpt-6-astra".into(),
        ..Default::default()
    });
    assert_eq!(official.id(), "openai");
    assert_eq!(
        official.endpoint_identity(),
        Some(super::super::OPENAI_ENDPOINT)
    );
    assert_eq!(official.quote("night").unwrap().max_output_tokens, 512);
}

#[test]
fn responses_use_shared_wallpaper_contracts_and_type_specific_bounds() {
    let provider = OpenAi::new("gpt-6-astra").unwrap();
    for composition in [false, true] {
        let input = input(composition);
        let assets = composition.then(assets);
        let quote = quote(&provider, &input, assets.as_ref()).unwrap();
        assert_eq!(
            quote.pricing_version,
            crate::ai::usage::TOKEN_ONLY_PRICING_VERSION
        );
        assert_eq!(
            quote.max_output_tokens,
            if composition { 8192 } else { 4096 }
        );
        let bytes = request(&provider, &input, assets.as_ref(), &quote).unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let prepared = match &assets {
            Some(assets) => composition_provider::prepare(&input, assets).unwrap(),
            None => wallpaper_provider::prepare(&input).unwrap(),
        };
        assert_eq!(body["text"]["format"]["schema"], prepared.schema);
        assert_eq!(body["input"], prepared.user);
        assert_eq!(body["instructions"], prepared.system);
        assert_eq!(body["max_output_tokens"], quote.max_output_tokens);
        assert_eq!(body["reasoning"]["effort"], "low");
        assert_eq!(body["stream"], false);
        assert_eq!(body["store"], false);
        assert!(body.get("tools").is_none());
        assert!(body.get("messages").is_none());
        assert!(bytes.len() <= REQUEST_BYTES);
        let undersized = PriceQuote {
            max_input_tokens: bytes.len() as u64 - 1,
            ..quote
        };
        assert!(request(&provider, &input, assets.as_ref(), &undersized).is_err());
    }
    assert!(quote(&provider, &input(true), None).is_err());
    assert!(quote(&provider, &input(false), Some(&assets())).is_err());
}

#[tokio::test]
async fn mismatched_snapshot_missing_key_and_cancelled_call_never_dispatch() {
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let (provider, task) = fixture(axum::Router::new().route(
        "/v1/responses",
        post(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            async { Json(response(&output(false).to_string())) }
        }),
    ))
    .await;
    let input = input(false);
    for case in 0..5 {
        let mut pricing = snapshot(&provider, &input, None);
        let mut key = Some(credential::test_provider_credential("fixture-key"));
        let mut cancellation = ProviderCancellation::default();
        match case {
            0 => pricing.provider = "openai".into(),
            1 => pricing.quote.max_output_tokens -= 1,
            2 => pricing.credential = None,
            3 => key = None,
            _ => {
                let (sender, receiver) = tokio::sync::watch::channel(());
                drop(sender);
                cancellation = ProviderCancellation::from_receiver(receiver);
            }
        }
        assert!(provider
            .generate_wallpaper_builtin(&input, pricing, key, cancellation)
            .await
            .output
            .is_err());
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compatible_wallpaper_runner_quotes_once_validates_and_replays_both_types() {
    for composition in [false, true] {
        for valid in [false, true] {
            let calls = Arc::new(AtomicUsize::new(0));
            let observed = calls.clone();
            let (provider, task) = fixture(axum::Router::new().route(
                "/v1/responses",
                post(
                    move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                        observed.fetch_add(1, Ordering::SeqCst);
                        async move {
                            assert_eq!(
                                headers[reqwest::header::AUTHORIZATION],
                                "Bearer fixture-key"
                            );
                            assert!(!headers.contains_key(reqwest::header::COOKIE));
                            assert_eq!(body["model"], "gpt-6-astra");
                            assert_eq!(
                                body["max_output_tokens"],
                                if composition { 8192 } else { 4096 }
                            );
                            let mut output = output(composition);
                            if !valid {
                                if composition {
                                    output["document"]["nodes"][0]["assets"]["asset"] =
                                        json!("unselected");
                                } else {
                                    output["params"]["tod"] = json!(2);
                                }
                            }
                            Json(response(&output.to_string()))
                        }
                    },
                ),
            ))
            .await;
            let config = AiConfig {
                provider: "openai-compatible".into(),
                origin: "https://models.example.com/v1".into(),
                model: "gpt-6-astra".into(),
                ..Default::default()
            };
            let dir = std::env::temp_dir().join(format!(
                "hertz-compatible-wallpaper-{}",
                uuid::Uuid::new_v4()
            ));
            let db = vmusic_store::open(&dir).await.unwrap();
            let (mut state, handle) = crate::state::tests::playback_state_with_db(db).await;
            state.data_dir = dir;
            state.ai_runtime = jobs::AiRuntime::from_config(&config);
            state.ai_runtime.credentials = credential::Service::isolated_for_config(&config);
            state.ai_runtime.install_provider(Arc::new(provider)).await;
            state.ai_runner_held.store(true, Ordering::Relaxed);
            let state = Arc::new(state);
            vmusic_store::settings::set(&state.db, jobs::CONSENT_KEY, &json!(true))
                .await
                .unwrap();
            credential::put(
                &state,
                credential::CredentialRequest::from_value(&json!({"api_key":"fixture-key"}))
                    .unwrap(),
            )
            .await
            .unwrap();
            let principal = crate::idempotency::LOCAL_OWNER;
            let capabilities =
                serde_json::to_value(jobs::wallpaper_capabilities(&state).await.unwrap()).unwrap();
            let mut request = input(composition);
            request.capability_snapshot_id = capabilities["snapshotId"].as_str().unwrap().into();
            if composition {
                let selected = jobs::wallpaper_asset_set(
                    &state,
                    principal,
                    &assets().canonical_bytes().unwrap(),
                )
                .await
                .unwrap();
                request.output.asset_set_id = Some(selected["assetSetId"].as_str().unwrap().into());
            }
            let quote =
                jobs::wallpaper_quote(&state, principal, &serde_json::to_vec(&request).unwrap())
                    .await
                    .unwrap();
            assert_eq!(quote["provider"], "openai-compatible");
            assert_eq!(quote["pricingMode"], "token-only");
            assert_eq!(quote["pricingKnown"], false);
            assert!(quote["maximumCostMicroUsd"].is_null());
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            let key = format!(
                "v1.{}.{}",
                vmusic_store::now_ms(),
                uuid::Uuid::new_v4().simple()
            );
            let quote_id = quote["quoteId"].as_str().unwrap();
            let jobs::SubmitOutcome::Accepted { job } = jobs::wallpaper_submit(
                &state,
                principal,
                quote_id,
                &request.request_id,
                Some(&key),
            )
            .await
            .unwrap() else {
                panic!("new job required")
            };
            let row = tokio::time::timeout(Duration::from_secs(8), async {
                loop {
                    let row = vmusic_store::ai_jobs::find_job_by_id(&state.db, &job.job_id)
                        .await
                        .unwrap()
                        .unwrap();
                    if !matches!(row.state.as_str(), "accepted" | "running") {
                        break row;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(row.state, if valid { "succeeded" } else { "failed" });
            assert_eq!(
                row.failure_code.as_deref(),
                if valid { None } else { Some("invalid_output") }
            );
            let artifact: Option<(String,)> = sqlx::query_as("SELECT artifact_id FROM ai_wallpaper_artifacts WHERE job_id=? AND state='available'").bind(&job.job_id).fetch_optional(&state.db).await.unwrap();
            if valid {
                let artifact = artifact.unwrap().0;
                let bytes = tokio::fs::read(
                    state
                        .data_dir
                        .join("ai/wallpaper-artifacts")
                        .join(artifact)
                        .join("payload"),
                )
                .await
                .unwrap();
                assert_eq!(
                    serde_json::from_slice::<Value>(&bytes).unwrap(),
                    output(composition)
                );
            } else {
                assert!(artifact.is_none());
            }
            let usage = vmusic_store::ai_jobs::find_usage_entry(&state.db, &job.job_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(usage.usage_state, "unpriced");
            let reported: Value =
                serde_json::from_str(usage.reported_usage.as_deref().unwrap()).unwrap();
            assert_eq!(reported["inputTokens"], 47);
            assert_eq!(reported["outputTokens"], 15);
            let replay = jobs::wallpaper_submit(
                &state,
                principal,
                quote_id,
                &request.request_id,
                Some(&key),
            )
            .await
            .unwrap();
            assert!(
                matches!(replay, jobs::SubmitOutcome::Replayed {job: original} if original.job_id == job.job_id)
            );
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            state.audio.shutdown();
            handle.join().unwrap();
            state.db.close().await;
            task.abort();
        }
    }
}
