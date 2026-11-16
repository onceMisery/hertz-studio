// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::*;
use crate::ai::jobs;
use axum::{routing::post, Json};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn input(scene: &str) -> WallpaperGenerateRequest {
    serde_json::from_value(json!({
        "version":1,"requestId":"fixture-wallpaper","brief":"夜色海岸，减少动态",
        "output":{"kind":"builtin","sceneId":scene},
        "registryHash":hertz_wallpaper::catalog().registry_hash,
        "generationSchemaHash":crate::ai::wallpaper_jobs::generation_schema_hash(),
        "capabilitySnapshotId":"fixture-snapshot"
    }))
    .unwrap()
}

fn output() -> Value {
    json!({"kind":"builtin","sceneId":"coast","stateVersion":1,
           "params":{"tod":0.72,"reduced":true}})
}

fn envelope(text: &str) -> Value {
    json!({"model":"test-local","done":true,"done_reason":"stop",
           "message":{"role":"assistant","content":text},
           "prompt_eval_count":1234,"eval_count":42})
}

fn pricing(provider: &Ollama, input: &WallpaperGenerateRequest) -> PricingSnapshot {
    PricingSnapshot {
        provider: provider.id().into(),
        model: provider.model().into(),
        quote: provider.quote_wallpaper_builtin(input).unwrap(),
        credential: None,
    }
}

async fn server(app: axum::Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (origin, task)
}

async fn generate_response(value: Value) -> jobs::WallpaperReply {
    let app = axum::Router::new().route(
        "/api/chat",
        post(move || {
            let value = value.clone();
            async move { Json(value) }
        }),
    );
    let (origin, task) = server(app).await;
    let provider = Ollama::new(&origin, "test-local").unwrap();
    let input = input("coast");
    let reply = provider
        .generate_wallpaper_builtin(&input, pricing(&provider, &input), None, Default::default())
        .await;
    task.abort();
    reply
}

#[test]
fn wallpaper_requests_derive_every_selected_scene_from_the_native_catalog() {
    for scene in &hertz_wallpaper::catalog().scenes {
        let mut input = input(scene["id"].as_str().unwrap());
        input.brief = "\"描述\"\n".repeat(100);
        let bytes = request("test-local", &input).unwrap();
        assert!(bytes.len() <= REQUEST_BYTES);
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["messages"][1]["content"], input.brief);
        assert_eq!(body["stream"], false);
        assert_eq!(body["think"], false);
        assert_eq!(body["options"]["num_predict"], OUTPUT_TOKENS);
        let selected = &body["format"]["oneOf"][0];
        assert_eq!(selected["properties"]["sceneId"]["const"], scene["id"]);
        assert_eq!(
            selected["properties"]["stateVersion"]["const"],
            scene["stateVersion"]
        );
        let params = &selected["properties"]["params"];
        assert_eq!(params["additionalProperties"], false);
        assert_eq!(
            params["properties"].as_object().unwrap().len(),
            scene["params"].as_object().unwrap().len()
        );
        for (name, definition) in scene["params"].as_object().unwrap() {
            let actual = &params["properties"][name];
            assert_eq!(actual["default"], definition["default"]);
            match definition["type"].as_str().unwrap() {
                "number" => {
                    assert_eq!(actual["type"], "number");
                    assert_eq!(actual["minimum"], definition["min"]);
                    assert_eq!(actual["maximum"], definition["max"]);
                }
                "boolean" => assert_eq!(actual["type"], "boolean"),
                "select" => {
                    assert_eq!(actual["type"], "string");
                    let expected: Vec<_> = definition["options"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|option| {
                            option
                                .as_str()
                                .or_else(|| option["value"].as_str())
                                .unwrap()
                        })
                        .collect();
                    assert_eq!(actual["enum"], json!(expected));
                }
                other => panic!("unqualified parameter type: {other}"),
            }
        }
        let system = body["messages"][0]["content"].as_str().unwrap();
        for secret_or_unneeded in [
            &input.request_id,
            &input.registry_hash,
            &input.generation_schema_hash,
            &input.capability_snapshot_id,
        ] {
            assert!(!system.contains(secret_or_unneeded));
        }
        assert!(body.get("tools").is_none());
        assert!(body.get("currentSong").is_none());
    }
    let mut too_large = input("coast");
    too_large.brief = "x".repeat(4097);
    assert_eq!(
        request("test-local", &too_large).unwrap_err(),
        INVALID_REQUEST
    );
    let mut wrong_kind = input("coast");
    wrong_kind.output.kind = WallpaperGenerationKind::Image;
    assert!(request("test-local", &wrong_kind).is_err());
    let provider = crate::ai::provider::configured(&crate::config::AiConfig {
        provider: "openai".into(),
        model: "explicit-model".into(),
        ..Default::default()
    });
    assert!(!provider.supports_wallpaper_builtin());
}

#[tokio::test]
async fn wallpaper_rejected_output_preserves_trusted_usage_without_repair() {
    let valid = output();
    let reply = generate_response(envelope(&valid.to_string())).await;
    assert_eq!(reply.output.unwrap(), valid);
    assert_eq!(reply.usage.unwrap().input_tokens, 1234);

    let mut invalid_values = Vec::new();
    for (field, value) in [
        ("sceneId", json!("background-spectrogram")),
        ("stateVersion", json!(2)),
        ("kind", json!("composition")),
        ("params", json!({"tod":1.01})),
        ("params", json!({"tod":"0.72"})),
        ("params", json!({"unknown":1})),
        ("url", json!("https://private.invalid/secret")),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        invalid_values.push(invalid.to_string());
    }
    invalid_values.extend([
        "{\"unsupported\":true}".into(),
        "```json\n{}\n```".into(),
        format!("{valid}{valid}"),
        "{\"kind\":\"builtin\",\"kind\":\"builtin\",\"sceneId\":\"coast\",\"stateVersion\":1,\"params\":{}}".into(),
        " ".repeat(hertz_wallpaper::generation::MAX_OUTPUT_BYTES + 1),
    ]);
    for text in invalid_values {
        let reply = generate_response(envelope(&text)).await;
        assert_eq!(reply.output.unwrap_err(), WallpaperOutputError::Rejected);
        assert_eq!(reply.usage.unwrap().output_tokens, 42);
    }
}

#[tokio::test]
async fn wallpaper_envelope_identity_finality_and_tools_remain_fail_closed() {
    for (field, value, has_usage) in [
        ("model", json!("different-model"), false),
        ("done", json!(false), false),
        ("done_reason", json!("length"), true),
        ("error", json!("private response"), false),
        (
            "message",
            json!({"role":"assistant","content":output().to_string(),"tool_calls":[{}]}),
            true,
        ),
    ] {
        let mut value_envelope = envelope(&output().to_string());
        value_envelope[field] = value;
        let reply = generate_response(value_envelope).await;
        assert!(reply.output.is_err());
        assert_eq!(reply.usage.is_some(), has_usage);
    }
    let mut missing_usage = envelope(&output().to_string());
    missing_usage["eval_count"] = json!(-1);
    let reply = generate_response(missing_usage).await;
    assert_eq!(reply.output.unwrap(), output());
    assert!(reply.usage.is_none());
}

#[tokio::test]
async fn wallpaper_quote_pricing_and_pre_dispatch_cancel_make_no_requests() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let provider = Ollama::new(
        &format!("http://{}", listener.local_addr().unwrap()),
        "test-local",
    )
    .unwrap();
    let input = input("coast");
    let good = pricing(&provider, &input);
    assert_eq!(good.quote.reservation_micro_usd, 0);
    assert_eq!(good.quote.max_output_tokens, OUTPUT_TOKENS);
    assert_eq!(provider.quote(&input.brief).unwrap().max_output_tokens, 512);
    let mut wrong_prices = Vec::new();
    let mut stage = good.clone();
    stage.quote = provider.quote(&input.brief).unwrap();
    wrong_prices.push(stage);
    let mut wrong = good.clone();
    wrong.model = "other".into();
    wrong_prices.push(wrong);
    let mut wrong = good.clone();
    wrong.provider = "fake".into();
    wrong_prices.push(wrong);
    let mut wrong = good.clone();
    wrong.quote.max_input_tokens = 1;
    wrong_prices.push(wrong);
    let mut wrong = good.clone();
    wrong.quote.reservation_micro_usd = 1;
    wrong_prices.push(wrong);
    let mut wrong = good.clone();
    wrong.quote.input_micro_usd_per_million = 1;
    wrong_prices.push(wrong);
    for wrong in wrong_prices {
        let reply = provider
            .generate_wallpaper_builtin(&input, wrong, None, Default::default())
            .await;
        assert!(reply.output.is_err());
        assert!(reply.usage.is_none());
    }
    let (sender, receiver) = tokio::sync::watch::channel(());
    drop(sender);
    let reply = provider
        .generate_wallpaper_builtin(
            &input,
            good,
            None,
            ProviderCancellation::from_receiver(receiver),
        )
        .await;
    assert_eq!(
        reply.output.unwrap_err().to_string(),
        "local model request cancelled"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(60), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn wallpaper_http_errors_redirects_encoding_and_wire_limits_are_single_requests() {
    use axum::{
        body::Body,
        http::{Response, StatusCode},
    };
    for (status, oversized, encoded) in [
        (StatusCode::TEMPORARY_REDIRECT, false, false),
        (StatusCode::SERVICE_UNAVAILABLE, false, false),
        (StatusCode::OK, true, false),
        (StatusCode::BAD_REQUEST, true, false),
        (StatusCode::OK, false, true),
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let app = axum::Router::new().route(
            "/api/chat",
            post(move || {
                let calls = observed.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    let bytes = if oversized {
                        vec![b'x'; 256 * 1024 + 1]
                    } else {
                        serde_json::to_vec(&envelope(&output().to_string())).unwrap()
                    };
                    let stream = futures::stream::iter(
                        bytes
                            .chunks(16 * 1024)
                            .map(|chunk| Ok::<_, std::io::Error>(chunk.to_vec()))
                            .collect::<Vec<_>>(),
                    );
                    Response::builder()
                        .status(status)
                        .header("location", "/api/chat")
                        .header(
                            "content-encoding",
                            if encoded { "gzip" } else { "identity" },
                        )
                        .body(Body::from_stream(stream))
                        .unwrap()
                }
            }),
        );
        let (origin, task) = server(app).await;
        let provider = Ollama::new(&origin, "test-local").unwrap();
        let input = input("coast");
        let reply = provider
            .generate_wallpaper_builtin(
                &input,
                pricing(&provider, &input),
                None,
                Default::default(),
            )
            .await;
        let error = reply.output.unwrap_err().to_string();
        assert!(if oversized {
            error.contains("256 KiB")
        } else if encoded {
            error.contains("content encoding")
        } else {
            error.contains(&status.as_u16().to_string())
        });
        assert_eq!(reply.usage.is_some(), !oversized && !encoded);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        task.abort();
    }
}

#[tokio::test]
async fn wallpaper_cancellation_drops_the_in_flight_connection_during_send_and_body() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for send_headers in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider = Ollama::new(
            &format!("http://{}", listener.local_addr().unwrap()),
            "test-local",
        )
        .unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                received.extend_from_slice(&chunk[..count]);
                if let Some(end) = received.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let header = std::str::from_utf8(&received[..end]).unwrap();
                    let length: usize = header
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|value| value.parse().ok())
                        })
                        .unwrap();
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            if send_headers {
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n")
                    .await
                    .unwrap();
            }
            started_tx.send(()).unwrap();
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), socket.read(&mut chunk))
                    .await
                    .unwrap()
                    .unwrap(),
                0
            );
        });
        let input = input("coast");
        let (sender, receiver) = tokio::sync::watch::channel(());
        let request = tokio::spawn(provider.generate_wallpaper_builtin(
            &input,
            pricing(&provider, &input),
            None,
            ProviderCancellation::from_receiver(receiver),
        ));
        tokio::time::timeout(Duration::from_secs(2), started_rx)
            .await
            .unwrap()
            .unwrap();
        drop(sender);
        let reply = tokio::time::timeout(Duration::from_secs(2), request)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply.output.unwrap_err().to_string(),
            "local model request cancelled"
        );
        assert!(reply.usage.is_none());
        peer.await.unwrap();
    }
}

mod integration;
