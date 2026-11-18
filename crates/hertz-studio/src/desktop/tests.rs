// SPDX-License-Identifier: MIT
use super::*;
use serde_json::json;

#[test]
fn capabilities_queries_are_strict_and_never_accept_a_page_selected_source() {
    for query in [
        json!({"refresh":"yes"}),
        json!({"refresh":1}),
        json!({"profile":"page"}),
    ] {
        assert!(crate::rpc::query_as::<CapabilitiesQuery>(&query).is_err());
    }
    for query in [
        json!({"refresh":true}),
        json!({"refresh":"false"}),
        json!({}),
    ] {
        assert!(crate::rpc::query_as::<CapabilitiesQuery>(&query).is_ok());
    }
}

#[tokio::test]
async fn dbx_rpc_rejects_every_desktop_family_and_keeps_the_standalone_owner() {
    let (state, audio) = crate::state::tests::playback_state().await;
    let state = Arc::new(state);
    let desktop = Desktop::for_state(&state);
    assert!(Arc::ptr_eq(&desktop, &Desktop::for_state(&state)));
    let rpc = crate::rpc::Rpc::new(state.clone());
    for path in [
        "v1/desktop/capabilities",
        "v1/desktop/connect",
        "v1/desktop/disconnect",
        "v1/desktop/control",
        "v1/desktop/lyrics/control",
        "v1/desktop/lyrics/launch",
        "v1/desktop/wallpaper/launch",
        "v1/desktop/calibration-authorization",
        "v1/desktop/calibration-ui",
        "v1/desktop-lyrics/snapshot",
        "v1/desktop-lyrics/document",
        "v1/desktop-lyrics/control",
        "v1/desktop-lyrics/calibration/request",
        "v1/wallpaper/snapshot",
        "v1/wallpaper/events",
        "v1/desktop-mini/snapshot",
        "v1/desktop-mini/cover",
        "v1/desktop-mini/control",
        "v1/desktop-mini/restore",
        "v1/ai/wallpaper/capabilities",
        "v1/ai/wallpaper/pairings",
        "v1/ai/wallpaper/requests/accept",
    ] {
        for op in [crate::rpc::Op::Get, crate::rpc::Op::Post] {
            let error = rpc
                .call(crate::rpc::Call {
                    op,
                    path,
                    query: json!({}),
                    body: json!({}),
                    raw: None,
                    client_operation_id: None,
                })
                .await
                .err()
                .expect(path);
            assert_eq!(error.code, "not_found", "{path}");
        }
    }
    let cached = serde_json::to_value(desktop.cached()).unwrap();
    assert_eq!(cached["source"]["kind"], "standalone");
    assert_eq!(cached["source"]["edition"], "custom");
    assert_eq!(cached["transport"], "in-process");
    assert_eq!(cached["bridgeProtocol"], 0);
    assert_eq!(
        desktop.cached().supported,
        cfg!(all(
            windows,
            target_arch = "x86_64",
            feature = "desktop-host"
        ))
    );
    assert!(desktop
        .control(ControlRequest {
            command: "exec".into(),
            value: None
        })
        .await
        .is_err());
    state.audio.shutdown();
    audio.join().unwrap();
}

#[tokio::test]
#[cfg(feature = "desktop-host")]
async fn standalone_http_preserves_authentication_capabilities_and_strict_control() {
    let (mut state, audio) = crate::state::tests::playback_state().await;
    state.token = "desktop-http-fixture".into();
    let state = Arc::new(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = crate::routes::router(state.clone()).with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let client = reqwest::Client::new();
    let url = format!("http://{address}/v1/desktop/capabilities");
    assert_eq!(client.get(&url).send().await.unwrap().status(), 401);
    let actual: Value = client
        .get(&url)
        .bearer_auth(&state.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        actual,
        serde_json::to_value(Desktop::for_state(&state).cached()).unwrap()
    );
    for query in [
        "refresh=1",
        "refresh=yes",
        "refresh=",
        "refresh=true&profile=page",
        "refresh=false&refresh=true",
    ] {
        assert_eq!(
            client
                .get(format!("{url}?{query}"))
                .bearer_auth(&state.token)
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
    }
    for path in ["connect", "disconnect"] {
        let status = client
            .post(format!("http://{address}/v1/desktop/{path}"))
            .bearer_auth(&state.token)
            .json(&json!({}))
            .send()
            .await
            .unwrap()
            .status();
        assert!(!status.is_success());
    }
    let invalid = client
        .post(format!("http://{address}/v1/desktop/control"))
        .bearer_auth(&state.token)
        .json(&json!({"command":"exec","value":"calc.exe"}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), 400);
    // Invalid commands retain the existing error envelope through the thin handler.
    assert_eq!(
        invalid.json::<Value>().await.unwrap()["error"]["code"],
        "bad_request"
    );
    server.abort();
    let _ = server.await;
    state.audio.shutdown();
    audio.join().unwrap();
}

#[tokio::test]
#[cfg(not(feature = "desktop-host"))]
async fn dbx_library_http_has_no_desktop_or_wallpaper_backchannel() {
    let (mut state, audio) = crate::state::tests::playback_state().await;
    state.token = "desktop-disabled-fixture".into();
    let state = Arc::new(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = crate::routes::router(state.clone()).with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = reqwest::Client::new();
    for path in [
        "desktop/capabilities",
        "desktop/control",
        "desktop/lyrics/launch",
        "desktop/wallpaper/launch",
        "desktop/calibration-ui",
        "desktop/calibration-authorization",
        "desktop-lyrics/snapshot",
        "desktop-lyrics/document",
        "desktop-lyrics/control",
        "desktop-lyrics/calibration/request",
        "wallpaper/snapshot",
        "wallpaper/events",
        "desktop-mini/snapshot",
        "desktop-mini/cover",
        "desktop-mini/control",
        "desktop-mini/restore",
        "ai/wallpaper/capabilities",
        "ai/wallpaper/quote",
        "ai/wallpaper/asset-sets",
        "ai/wallpaper/jobs",
        "ai/wallpaper/jobs/example",
        "ai/wallpaper/jobs/example/cancel",
        "ai/wallpaper/artifacts/example",
        "ai/wallpaper/artifacts/example/claim",
        "ai/wallpaper/pairings",
        "ai/wallpaper/pairings/register",
        "ai/wallpaper/pairings/example/confirm",
        "ai/wallpaper/requests/accept",
        "ai/wallpaper/session",
    ] {
        for method in [
            reqwest::Method::GET,
            reqwest::Method::POST,
            reqwest::Method::DELETE,
        ] {
            let status = client
                .request(method, format!("http://{address}/v1/{path}"))
                .bearer_auth(&state.token)
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status();
            assert_eq!(status, 404, "{path}");
        }
    }
    let visibility = client
        .post(format!("http://{address}/v1/ui/notice"))
        .bearer_auth(&state.token)
        .json(&json!({"action":"main-visibility","hidden":true}))
        .send().await.unwrap();
    assert_eq!(visibility.status(), 400);
    let music = client
        .get(format!("http://{address}/v1/state"))
        .bearer_auth(&state.token)
        .send()
        .await
        .unwrap();
    assert_eq!(music.status(), 200);
    server.abort();
    let _ = server.await;
    state.audio.shutdown();
    audio.join().unwrap();
}

#[test]
#[cfg(windows)]
fn capabilities_match_the_embedded_custom_source_across_windows_path_aliases() {
    let directory =
        std::env::temp_dir().join(format!("hertz-desktop-source-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let expected = Profile::Standalone {
        edition: "custom".into(),
        data_dir: directory.to_string_lossy().into_owned(),
    };
    let alias = Profile::Standalone {
        edition: "custom".into(),
        data_dir: directory.join(".").to_string_lossy().into_owned(),
    };
    assert!(is_active_source(
        &serde_json::to_value(&alias).unwrap(),
        Some(&expected)
    ));
    let different_edition = Profile::Standalone {
        edition: "standard".into(),
        data_dir: expected.data_dir().into(),
    };
    assert!(!is_active_source(
        &serde_json::to_value(different_edition).unwrap(),
        Some(&expected)
    ));
    let wrong_source = Profile::Standalone {
        edition: "custom".into(),
        data_dir: directory.join("missing").to_string_lossy().into_owned(),
    };
    assert!(!is_active_source(
        &serde_json::to_value(wrong_source).unwrap(),
        Some(&expected)
    ));
    let retired = Profile::Dbx {
        edition: "standard".into(),
        data_dir: expected.data_dir().into(),
        plugin_id: hertz_desktop_ipc::profile::STANDARD_PLUGIN_ID.into(),
    };
    assert!(!is_active_source(
        &serde_json::to_value(retired).unwrap(),
        Some(&expected)
    ));
    assert!(!is_active_source(&Value::Null, Some(&expected)));
    assert!(!is_active_source(
        &serde_json::to_value(alias).unwrap(),
        None
    ));
    std::fs::remove_dir(&directory).unwrap();
}
