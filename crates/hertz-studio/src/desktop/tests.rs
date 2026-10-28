// SPDX-License-Identifier: MIT
use super::*;
use serde_json::json;

#[test]
fn requests_are_strict_and_never_accept_a_page_selected_source() {
    for value in [
        json!({"tab":"lyrics"}),
        json!({"tab":"wallpaper"}),
        json!({}),
        Value::Null,
    ] {
        assert!(parse_connect(&value).is_ok());
    }
    for value in [
        json!({"tab":"Lyrics"}),
        json!({"tab":null}),
        json!({"profile":{}}),
        json!({"path":"C:/arbitrary"}),
        json!({"command":"quit"}),
        json!([]),
    ] {
        assert!(parse_connect(&value).is_err(), "{value}");
    }
    assert!(parse_empty(&json!({})).is_ok());
    assert!(parse_empty(&json!({"force":true})).is_err());
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
async fn standalone_rpc_uses_the_same_cached_owner_and_rejects_dbx_mutations() {
    let (state, audio) = crate::state::tests::playback_state().await;
    let state = Arc::new(state);
    let desktop = Desktop::for_state(&state);
    assert!(Arc::ptr_eq(&desktop, &Desktop::for_state(&state)));
    let rpc = crate::rpc::Rpc::new(state.clone());
    let reply = rpc
        .call(crate::rpc::Call {
            op: crate::rpc::Op::Get,
            path: "v1/desktop/capabilities",
            query: json!({}),
            body: Value::Null,
            raw: None,
            client_operation_id: None,
        })
        .await
        .unwrap();
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, serde_json::to_value(desktop.cached()).unwrap());
    assert_eq!(reply.body["source"]["kind"], "standalone");
    assert!(!desktop.connect(Tab::Runtime).await.ok);
    assert!(!desktop.disconnect().await.ok);
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
async fn http_capabilities_matches_rpc_and_no_connect_disconnect_rest_routes_exist() {
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
