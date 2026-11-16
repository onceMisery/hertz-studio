// SPDX-License-Identifier: MIT
use super::*;

fn connection() -> Connection {
    let root = std::env::temp_dir().join(format!("hertz-native-pairing-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let profile = crate::config::Profile::Standalone {
        edition: "full".into(),
        data_dir: root.to_string_lossy().into_owned(),
    }
    .normalized()
    .unwrap();
    let identity = hertz_desktop_ipc::windows::Identity::current().unwrap();
    let generation = hertz_desktop_ipc::windows::process_generation(std::process::id()).unwrap();
    std::fs::write(
        root.join("vmusicd.json"),
        serde_json::to_vec(&json!({
            "pid":std::process::id(), "port":1, "version":"fixture",
            "protocol_version":1, "edition":"full", "server_instance_id":"fixture-service"
        }))
        .unwrap(),
    )
    .unwrap();
    Connection {
        binding: Binding {
            protocol: 1,
            user_sid: identity.user_sid,
            windows_session_id: identity.windows_session_id,
            native_pid: std::process::id(),
            native_generation: generation.clone(),
            desktop_build_id: "a".repeat(64),
            edition: "full".into(),
            profile_digest: pairing::profile_digest(profile.edition(), profile.data_dir()),
            service_pid: std::process::id(),
            server_instance_id: "fixture-service".into(),
        },
        profile,
        origin: "http://127.0.0.1:1".into(),
        service_generation: generation,
        challenge: "b".repeat(64),
        challenge_deadline: Instant::now() + Duration::from_secs(60),
        verified: false,
        bearer: None,
        grant_id: None,
        expires: None,
    }
}
fn envelope(c: &Connection, phase: &str) -> Value {
    let mut value = json!({"phase":phase,"challenge":c.challenge,"binding":c.binding});
    if phase == "deliver" {
        value["grantId"] = json!("fixture-grant");
        value["bearer"] = json!("c".repeat(64));
        value["expiresAt"] = json!(now_ms() + pairing::SESSION_MS - 1000);
    }
    value
}

#[test]
fn status_retires_missing_discovery_and_changed_service_generation() {
    for changed_generation in [false, true] {
        let mut c = connection();
        c.bearer = Some("c".repeat(64));
        c.expires = Some(Instant::now() + Duration::from_secs(60));
        if changed_generation {
            c.service_generation = "previous-process".into();
        } else {
            std::fs::remove_file(std::path::Path::new(c.profile.data_dir()).join("vmusicd.json"))
                .unwrap();
        }
        let service = NativeGeneration::new();
        {
            let mut state = lock(&service.state);
            state.connection = Some(c.clone());
            state.job = Some(json!({"jobId":"old-grant-job","state":"running"}));
            state.submission = Some(json!({"idempotencyKey":"old-grant-key"}));
        }
        let status = service
            .perform(c.profile, 1, "wallpaper.ai.status", json!({}))
            .unwrap();
        assert_eq!(status["connected"], false);
        assert_eq!(status["job"], Value::Null);
        assert_eq!(status["submissionPending"], false);
        assert!(lock(&service.state).connection.is_none());
    }
}

#[test]
fn pairing_requires_actual_peer_profile_generation_and_single_use() {
    let c = connection();
    let service = NativeGeneration::new();
    lock(&service.state).connection = Some(c.clone());
    assert_eq!(
        service
            .verify(envelope(&c, "deliver"), c.binding.service_pid, &c.profile)
            .unwrap_err()
            .code,
        "pairing_expired"
    );
    assert_eq!(
        service
            .verify(
                envelope(&c, "verify"),
                c.binding.service_pid + 1,
                &c.profile
            )
            .unwrap_err()
            .code,
        "pairing_identity_mismatch"
    );
    let mut wrong = envelope(&c, "verify");
    wrong["binding"]["nativeGeneration"] = json!("old-process");
    assert_eq!(
        service
            .verify(wrong, c.binding.service_pid, &c.profile)
            .unwrap_err()
            .code,
        "pairing_identity_mismatch"
    );
    let mut profile = c.profile.clone();
    if let crate::config::Profile::Standalone { edition, .. } = &mut profile {
        *edition = "standard".into();
    }
    assert_eq!(
        service
            .verify(envelope(&c, "verify"), c.binding.service_pid, &profile)
            .unwrap_err()
            .code,
        "pairing_identity_mismatch"
    );
    lock(&service.state)
        .connection
        .as_mut()
        .unwrap()
        .challenge_deadline = Instant::now() - Duration::from_secs(1);
    assert_eq!(
        service
            .verify(envelope(&c, "verify"), c.binding.service_pid, &c.profile)
            .unwrap_err()
            .code,
        "pairing_identity_mismatch"
    );
    lock(&service.state).connection = Some(c.clone());
    service
        .verify(envelope(&c, "verify"), c.binding.service_pid, &c.profile)
        .unwrap();
    assert_eq!(
        service
            .verify(envelope(&c, "verify"), c.binding.service_pid, &c.profile)
            .unwrap_err()
            .code,
        "pairing_expired"
    );
    let mut too_long = envelope(&c, "deliver");
    too_long["expiresAt"] = json!(now_ms() + pairing::SESSION_MS + 60000);
    assert_eq!(
        service
            .verify(too_long, c.binding.service_pid, &c.profile)
            .unwrap_err()
            .code,
        "pairing_invalid"
    );
    service
        .verify(envelope(&c, "deliver"), c.binding.service_pid, &c.profile)
        .unwrap();
    assert!(service
        .verify(envelope(&c, "deliver"), c.binding.service_pid, &c.profile)
        .is_err());
    let status = service
        .perform(c.profile.clone(), 1, "wallpaper.ai.status", json!({}))
        .unwrap();
    assert_eq!(status["connected"], true);
    let text = status.to_string();
    assert!(!text.contains(&"c".repeat(64)));
    assert!(!text.contains(&c.challenge));
}

#[test]
fn invalidating_displayed_quote_retains_confirmed_task_and_replay_authority() {
    let c = connection();
    let service = NativeGeneration::new();
    let summary = json!({"provider":"fake","model":"fixture","endpointLabel":"本地离线 fixture","dataScope":"仅本次描述与参数合同",
        "pricingMode":"free","maximumCostMicroUsd":0,"maxInputTokens":0,"maxOutputTokens":0,"maximumWaitSeconds":90});
    {
        let mut state = lock(&service.state);
        state.connection = Some(c.clone());
        state.job = Some(json!({"jobId":"fixture-job","state":"accepted"}));
        state.submission = Some(json!({"idempotencyKey":"original-key"}));
        state.quote = Some(Quote {
            owner: 9,
            token: "displayed-token".into(),
            quote_id: "quote-id".into(),
            request_id: "request-id".into(),
            idempotency_key: "original-key".into(),
            summary,
            expires: Instant::now() + Duration::from_secs(60),
            description: "柔和夜色".into(),
            scene_id: "coast".into(),
        });
    }
    assert!(service.confirmation(10, "displayed-token").is_err());
    let message = service.confirmation(9, "displayed-token").unwrap();
    for expected in [
        "免费",
        "仅本次描述",
        "coast",
        "柔和夜色",
        "90 秒",
        "不保存或切换",
    ] {
        assert!(message.contains(expected), "{expected}");
    }
    assert!(!message.contains("50000"));
    service.invalidate_quote();
    assert!(service.confirmation(9, "displayed-token").is_err());
    let status = service
        .perform(c.profile.clone(), 12, "wallpaper.ai.status", json!({}))
        .unwrap();
    assert_eq!(status["job"]["jobId"], "fixture-job");
    assert_eq!(status["submissionPending"], true);
}

fn listener(response: Vec<u8>) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 1024];
        loop {
            let n = stream.read(&mut buffer).unwrap();
            if n == 0 {
                return request;
            }
            request.extend_from_slice(&buffer[..n]);
            if request.windows(4).any(|s| s == b"\r\n\r\n") {
                break;
            }
        }
        stream.write_all(&response).unwrap();
        request
    });
    (port, worker)
}

#[test]
fn uncertain_server_error_keeps_original_submission_for_recovery() {
    for (status, code, retained) in [(500, "internal", true), (404, "quote_unknown", false)] {
        let body = serde_json::to_vec(&json!({"error":{"code":code,"message":"fixture"}})).unwrap();
        let mut response = format!(
            "HTTP/1.1 {status} Error\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(&body);
        let (port, worker) = listener(response);
        let mut c = connection();
        c.origin = format!("http://127.0.0.1:{port}");
        c.bearer = Some("c".repeat(64));
        c.expires = Some(Instant::now() + Duration::from_secs(120));
        let discovery_path = std::path::Path::new(c.profile.data_dir()).join("vmusicd.json");
        let mut discovery: Value =
            serde_json::from_slice(&std::fs::read(&discovery_path).unwrap()).unwrap();
        discovery["port"] = json!(port);
        std::fs::write(discovery_path, serde_json::to_vec(&discovery).unwrap()).unwrap();
        let service = NativeGeneration::new();
        {
            let mut state = lock(&service.state);
            state.connection = Some(c.clone());
            state.submission = Some(
                json!({"quoteId":"original","requestId":"original","idempotencyKey":"original"}),
            );
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        service
            .run(
                c.profile,
                1,
                "wallpaper.ai.generate.recover".into(),
                json!({}),
                move |result| {
                    sender.send(result).unwrap();
                },
            )
            .unwrap();
        assert!(receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .is_err());
        assert_eq!(lock(&service.state).submission.is_some(), retained);
        assert!(!worker.join().unwrap().is_empty());
    }
}

#[test]
fn connected_http_peer_is_checked_before_any_bearer_bytes() {
    let mut c = connection();
    c.bearer = Some("c".repeat(64));
    let (port, worker) =
        listener(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}".to_vec());
    let (success, body) =
        local_request(&c, port, "GET", "/v1/ai/wallpaper/capabilities", None).unwrap();
    assert!(success);
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["ok"], true);
    assert!(String::from_utf8(worker.join().unwrap())
        .unwrap()
        .contains("Authorization: Bearer"));
    for wrong in ["generation", "pid"] {
        let mut impostor = c.clone();
        if wrong == "generation" {
            impostor.service_generation = "stale-process".into();
        } else {
            impostor.binding.service_pid = impostor.binding.service_pid.wrapping_add(1);
        }
        let (port, worker) = listener(Vec::new());
        assert_eq!(
            local_request(
                &impostor,
                port,
                "GET",
                "/v1/ai/wallpaper/capabilities",
                None
            )
            .unwrap_err()
            .code,
            "service_identity_mismatch"
        );
        assert!(
            worker.join().unwrap().is_empty(),
            "credentials must not reach an unverified peer"
        );
    }
}

#[test]
fn http_response_length_truncation_and_redirect_fail_closed() {
    let c = connection();
    for response in [
        b"HTTP/1.1 200 OK\r\nContent-Length: 65537\r\n\r\n".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{}".to_vec(),
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n".to_vec(),
    ] {
        let (port, worker) = listener(response);
        assert!(local_request(&c, port, "GET", "/v1/ai/wallpaper/capabilities", None).is_err());
        worker.join().unwrap();
    }
    let (port, worker) = listener(
        b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/steal\r\nContent-Length: 2\r\n\r\n{}"
            .to_vec(),
    );
    assert!(
        !local_request(&c, port, "GET", "/v1/ai/wallpaper/capabilities", None)
            .unwrap()
            .0
    );
    worker.join().unwrap();
}
