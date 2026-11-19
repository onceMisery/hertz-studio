// SPDX-License-Identifier: MIT
use super::*;
use std::io::{Read, Write};

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

#[test]
fn receive_commit_permit_fences_profile_retirement_and_cancellation() {
    let native = NativeGeneration::new();
    let mut connected = connection();
    connected.bearer = Some("c".repeat(64));
    connected.expires = Some(Instant::now() + Duration::from_secs(60));
    lock(&native.state).connection = Some(connected);
    let cancel = AtomicBool::new(false);
    let permit = native.receive_permit(0, &cancel).unwrap();
    let retiring = native.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let mut state = lock(&retiring.state);
        state.epoch += 1;
        state.connection = None;
        sender.send(()).unwrap();
    });
    assert!(
        receiver.recv_timeout(Duration::from_millis(25)).is_err(),
        "profile retirement must wait for the commit permit"
    );
    drop(permit);
    receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    thread.join().unwrap();
    assert!(native.receive_permit(0, &cancel).is_err());
    let mut connected = connection();
    connected.bearer = Some("c".repeat(64));
    connected.expires = Some(Instant::now() + Duration::from_secs(60));
    lock(&native.state).connection = Some(connected);
    cancel.store(true, Ordering::Release);
    assert!(native.receive_permit(1, &cancel).is_err());
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
            state.submission =
                Some(json!({"requestId":"old-grant-request","idempotencyKey":"old-grant-key"}));
        }
        let mut outcome = None;
        let status = service
            .perform_with_submission(c.profile, 1, "wallpaper.ai.status", json!({}), &mut outcome)
            .unwrap();
        let outcome = outcome.unwrap();
        assert_eq!(outcome.request_id, "old-grant-request");
        assert!(outcome.interrupted);
        assert_eq!(
            outcome.retired_service_instance.as_deref(),
            Some("fixture-service")
        );
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
            specification: "内置场景 coast，仅生成公开参数".into(),
            asset_set_id: None,
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
            if let Some(header_end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                let header = std::str::from_utf8(&request[..header_end]).unwrap();
                let body_bytes = header
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if request.len() >= header_end + 4 + body_bytes {
                    break;
                }
            }
        }
        stream.write_all(&response).unwrap();
        request
    });
    (port, worker)
}

#[test]
fn listener_consumes_complete_post_before_returning_service_receipt() {
    let body = "x".repeat(8192);
    let request = format!(
        "POST /fixture HTTP/1.1\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    let (port, worker) = listener(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".to_vec());
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut reply = Vec::new();
    let _ = stream.read_to_end(&mut reply);
    assert_eq!(worker.join().unwrap(), request.as_bytes());
}

#[test]
fn uncertain_server_error_keeps_original_submission_for_recovery() {
    for (recovering, status, code, retained) in [
        (true, 500, "internal", true),
        (true, 404, "quote_unknown", false),
        (true, 409, "quote_provider_changed", false),
        (true, 403, "grant_revoked", true),
        (false, 403, "grant_revoked", false),
    ] {
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
            if !recovering {
                state.submission = None;
                state.quote = Some(Quote {
                    owner: 1,
                    token: "original".into(),
                    quote_id: "original".into(),
                    request_id: "original".into(),
                    idempotency_key: "original".into(),
                    summary: json!({}),
                    expires: Instant::now() + Duration::from_secs(60),
                    description: String::new(),
                    specification: String::new(),
                    asset_set_id: None,
                });
            }
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        service
            .run_with_submission(
                c.profile,
                1,
                if recovering {
                    "wallpaper.ai.generate.recover"
                } else {
                    "wallpaper.ai.generate.confirm"
                }
                .into(),
                if recovering {
                    json!({})
                } else {
                    json!({"confirmationToken":"original"})
                },
                move |result, submission_pending| {
                    sender.send((result, submission_pending)).unwrap();
                },
            )
            .unwrap();
        let (result, submission_pending) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(result.is_err());
        let submission_pending = submission_pending.unwrap();
        assert_eq!(submission_pending.request_id, "original");
        assert_eq!(submission_pending.pending, retained);
        assert_eq!(
            submission_pending.interrupted,
            recovering && code == "grant_revoked"
        );
        if code != "grant_revoked" {
            assert_eq!(lock(&service.state).submission.is_some(), retained);
        }
        let _ = service.retire_profile();
        // The delivery fact is independent of the retired mutable connection.
        assert_eq!(submission_pending.pending, retained);
        assert!(!worker.join().unwrap().is_empty());
    }
}

#[test]
fn expired_confirmation_reports_no_submission_to_the_external_owner() {
    let service = NativeGeneration::new();
    let mut c = connection();
    c.bearer = Some("c".repeat(64));
    c.expires = Some(Instant::now() + Duration::from_secs(120));
    lock(&service.state).connection = Some(c.clone());
    let (sender, receiver) = std::sync::mpsc::channel();
    service
        .run_with_submission(
            c.profile,
            1,
            "wallpaper.ai.generate.confirm".into(),
            json!({"confirmationToken":"expired"}),
            move |result, pending| {
                sender.send((result, pending)).unwrap();
            },
        )
        .unwrap();
    let (result, pending) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(result.unwrap_err().code, "quote_expired");
    assert!(pending.is_none());
    assert!(lock(&service.state).submission.is_none());
}

#[tokio::test]
async fn composition_confirmation_does_not_hold_native_state_while_waiting_for_sql() {
    use crate::wallpaper::{
        assets::AssetStore,
        decode_probe::ProbeClient,
        jobs::ImportJobs,
        library::{tempfileish, InstallWork, Library},
    };
    let root = tempfileish::temp_dir("generation-submit-lock-order");
    let library = Library::open(root.path()).await.unwrap();
    library
        .install(&InstallWork {
            work_key: "local-source".into(),
            remote_work_id: uuid::Uuid::new_v4().to_string(),
            title: "source".into(),
            description: String::new(),
            kind: "image".into(),
            package_hash: "b".repeat(64),
            manifest_json: "{}".into(),
            package_bytes: 3,
            version: 1,
            source_id: "local".into(),
        })
        .await
        .unwrap();
    let jobs = Arc::new(ImportJobs::start(
        library,
        AssetStore::new(root.path()).unwrap(),
        ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })),
    ));
    let mut c = connection();
    c.bearer = Some("c".repeat(64));
    c.expires = Some(Instant::now() + Duration::from_secs(120));
    let service = NativeGeneration::new();
    service.bind_jobs(Arc::clone(&jobs));
    {
        let mut state = lock(&service.state);
        state.connection = Some(c.clone());
        state.quote = Some(Quote {
            owner: 9,
            token: "confirmation".into(),
            quote_id: "quote".into(),
            request_id: "request".into(),
            idempotency_key: "original-key".into(),
            summary: json!({}),
            expires: Instant::now() + Duration::from_secs(60),
            description: String::new(),
            specification: String::new(),
            asset_set_id: Some("set".into()),
        });
    }
    sqlx::query("INSERT INTO ai_asset_sets(asset_set_id,service_identity,digest,metadata_json,selections_json,quote_id,request_id,created_at,expires_at) VALUES('set',?,?,'{}','[]','quote','request',1,?)")
        .bind(connection_identity(&c)).bind("a".repeat(64)).bind(super::super::library::now_secs()+60).execute(jobs.library().pool()).await.unwrap();
    sqlx::query("INSERT INTO ai_asset_references VALUES('set','local-source',?)")
        .bind("b".repeat(64))
        .execute(jobs.library().pool())
        .await
        .unwrap();
    let transaction = jobs
        .library()
        .pool()
        .begin_with("BEGIN IMMEDIATE")
        .await
        .unwrap();
    let before_idle = jobs.library().pool().num_idle();
    let before_size = jobs.library().pool().size();
    let working_service = Arc::clone(&service);
    let worker = std::thread::spawn(move || {
        working_service.perform(
            c.profile,
            9,
            "wallpaper.ai.generate.confirm",
            json!({"confirmationToken":"confirmation"}),
        )
    });
    let waiting = tokio::time::timeout(Duration::from_secs(3), async {
        while jobs.library().pool().num_idle() >= before_idle
            && jobs.library().pool().size() <= before_size
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .is_ok();
    let accessible = service.state.try_lock().is_ok();
    if accessible {
        service.invalidate_quote();
    }
    transaction.rollback().await.unwrap();
    let result = worker.join().unwrap();
    assert!(waiting, "confirmation must reach the real SQL wait");
    assert!(
        accessible,
        "SQL wait must not retain the native state mutex"
    );
    assert_eq!(result.unwrap_err().code, "ai_superseded");
    assert!(lock(&service.state).submission.is_none());
    let references: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_asset_references")
        .fetch_one(jobs.library().pool())
        .await
        .unwrap();
    assert_eq!(
        references, 0,
        "invalidated confirmation must release its provisional pin"
    );
    // A connection may expire while SQL admission is blocked, independently of
    // the quote's longer deadline. No request may consume that expired session.
    let profile = {
        let mut state = lock(&service.state);
        // Keep the session valid through fixture SQL and thread dispatch. Expire
        // it only after the second confirmation has reached the actual SQL wait.
        state.connection.as_mut().unwrap().expires = Some(Instant::now() + Duration::from_secs(60));
        state.quote = Some(Quote {
            owner: 9,
            token: "confirmation".into(),
            quote_id: "quote".into(),
            request_id: "request".into(),
            idempotency_key: "original-key".into(),
            summary: json!({}),
            expires: Instant::now() + Duration::from_secs(60),
            description: String::new(),
            specification: String::new(),
            asset_set_id: Some("set".into()),
        });
        state.connection.as_ref().unwrap().profile.clone()
    };
    let identity = service.service_identity().unwrap();
    sqlx::query("INSERT INTO ai_asset_sets(asset_set_id,service_identity,digest,metadata_json,selections_json,quote_id,request_id,created_at,expires_at) VALUES('set',?,?,'{}','[]','quote','request',1,?)")
        .bind(identity).bind("a".repeat(64)).bind(super::super::library::now_secs()+60).execute(jobs.library().pool()).await.unwrap();
    sqlx::query("INSERT INTO ai_asset_references VALUES('set','local-source',?)")
        .bind("b".repeat(64))
        .execute(jobs.library().pool())
        .await
        .unwrap();
    let transaction = jobs
        .library()
        .pool()
        .begin_with("BEGIN IMMEDIATE")
        .await
        .unwrap();
    let before_idle = jobs.library().pool().num_idle();
    let before_size = jobs.library().pool().size();
    let working_service = Arc::clone(&service);
    let worker = std::thread::spawn(move || {
        working_service.perform(
            profile,
            9,
            "wallpaper.ai.generate.confirm",
            json!({"confirmationToken":"confirmation"}),
        )
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while jobs.library().pool().num_idle() >= before_idle
            && jobs.library().pool().size() <= before_size
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    lock(&service.state).connection.as_mut().unwrap().expires = Some(Instant::now());
    transaction.rollback().await.unwrap();
    assert_eq!(worker.join().unwrap().unwrap_err().code, "ai_superseded");
    assert!(lock(&service.state).submission.is_none());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_asset_references")
        .fetch_one(jobs.library().pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    jobs.library().pool().close().await;
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

#[tokio::test]
async fn composition_uncertain_submission_keeps_pins_but_definite_rejection_releases_them() {
    use crate::wallpaper::{
        assets::AssetStore,
        decode_probe::ProbeClient,
        jobs::ImportJobs,
        library::{tempfileish, Library},
    };
    let root = tempfileish::temp_dir("generation-rejection-pin");
    let jobs = Arc::new(ImportJobs::start(
        Library::open(root.path()).await.unwrap(),
        AssetStore::new(root.path()).unwrap(),
        ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })),
    ));
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
        sqlx::query("INSERT INTO ai_asset_sets(asset_set_id,service_identity,digest,metadata_json,selections_json,quote_id,request_id,created_at,expires_at) VALUES('set',?,?,'{}','[]','quote','request',1,?)")
            .bind(connection_identity(&c)).bind("a".repeat(64)).bind(super::super::library::now_secs()+86400).execute(jobs.library().pool()).await.unwrap();
        sqlx::query("INSERT INTO ai_asset_references VALUES('set','local-source',?)")
            .bind("b".repeat(64))
            .execute(jobs.library().pool())
            .await
            .unwrap();
        let service = NativeGeneration::new();
        service.bind_jobs(Arc::clone(&jobs));
        {
            let mut state = lock(&service.state);
            state.connection = Some(c.clone());
            state.submission = Some(
                json!({"quoteId":"quote","requestId":"request","idempotencyKey":"original-key"}),
            );
            state.submission_asset_set = Some("set".into());
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
        let result = tokio::task::spawn_blocking(move || {
            receiver.recv_timeout(Duration::from_secs(5)).unwrap()
        })
        .await
        .unwrap();
        assert!(result.is_err());
        worker.join().unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ai_asset_references")
            .fetch_one(jobs.library().pool())
            .await
            .unwrap();
        assert_eq!(count, if retained { 1 } else { 0 });
        assert_eq!(
            lock(&service.state).submission_asset_set.is_some(),
            retained
        );
        sqlx::query("DELETE FROM ai_asset_sets")
            .execute(jobs.library().pool())
            .await
            .unwrap();
    }
    jobs.library().pool().close().await;
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

async fn retired_submission_receipt(status: u16) {
    use crate::wallpaper::{
        assets::AssetStore,
        decode_probe::ProbeClient,
        jobs::ImportJobs,
        library::{tempfileish, Library},
        work_drafts::install_composition_test_source,
    };
    let root = tempfileish::temp_dir("retired-submission-receipt");
    let library = Library::open(root.path()).await.unwrap();
    let assets = AssetStore::new(root.path()).unwrap();
    let (work, hash, _) = install_composition_test_source(&library, &assets, false, 1).await;
    let jobs = Arc::new(ImportJobs::start(
        library,
        assets,
        ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })),
    ));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (received_tx, received_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let response_body = if status == 200 {
        json!({"job":{"jobId":"accepted-original-job","state":"accepted"}})
    } else {
        json!({"error":{"code":"quote_unknown","message":"fixture"}})
    };
    let peer = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = [0u8; 4096];
        assert!(stream.read(&mut bytes).unwrap() > 0);
        received_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let body = serde_json::to_vec(&response_body).unwrap();
        write!(
            stream,
            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .unwrap();
        stream.write_all(&body).unwrap();
        let (mut revoke, _) = listener.accept().unwrap();
        revoke
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        assert!(revoke.read(&mut bytes).unwrap() > 0);
        revoke
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
            .unwrap();
    });
    let mut c = connection();
    c.origin = format!("http://127.0.0.1:{port}");
    c.bearer = Some("c".repeat(64));
    c.expires = Some(Instant::now() + Duration::from_secs(120));
    let discovery_path = std::path::Path::new(c.profile.data_dir()).join("vmusicd.json");
    let mut discovery: Value =
        serde_json::from_slice(&std::fs::read(&discovery_path).unwrap()).unwrap();
    discovery["port"] = json!(port);
    std::fs::write(discovery_path, serde_json::to_vec(&discovery).unwrap()).unwrap();
    sqlx::query("INSERT INTO ai_asset_sets(asset_set_id,service_identity,digest,metadata_json,selections_json,quote_id,request_id,created_at,expires_at) VALUES('retired-set',?,?,'{}','[]','original-quote','original-request',1,?)")
        .bind(connection_identity(&c)).bind("a".repeat(64))
        .bind(super::super::library::now_secs() + 86400).execute(jobs.library().pool()).await.unwrap();
    sqlx::query("INSERT INTO ai_asset_references VALUES('retired-set',?,?)")
        .bind(work)
        .bind(hash)
        .execute(jobs.library().pool())
        .await
        .unwrap();
    let service = NativeGeneration::new();
    service.bind_jobs(Arc::clone(&jobs));
    {
        let mut state = lock(&service.state);
        state.connection = Some(c.clone());
        state.submission = Some(
            json!({"quoteId":"original-quote","requestId":"original-request","idempotencyKey":"original-key"}),
        );
        state.submission_asset_set = Some("retired-set".into());
    }
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    service
        .run(
            c.profile,
            1,
            "wallpaper.ai.generate.recover".into(),
            json!({}),
            move |result| {
                done_tx.send(result).unwrap();
            },
        )
        .unwrap();
    tokio::task::spawn_blocking(move || received_rx.recv_timeout(Duration::from_secs(5)).unwrap())
        .await
        .unwrap();
    let _ = service.retire_profile();
    release_tx.send(()).unwrap();
    let result =
        tokio::task::spawn_blocking(move || done_rx.recv_timeout(Duration::from_secs(5)).unwrap())
            .await
            .unwrap();
    assert!(result.is_err());
    peer.join().unwrap();
    if status == 200 {
        let job: Option<String> =
            sqlx::query_scalar("SELECT job_id FROM ai_asset_sets WHERE asset_set_id='retired-set'")
                .fetch_one(jobs.library().pool())
                .await
                .unwrap();
        assert_eq!(
            job.as_deref(),
            Some("accepted-original-job"),
            "accepted HTTP fact lost its original material mapping"
        );
        assert_eq!(result.unwrap_err().code, "ai_superseded");
    } else {
        let references: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM ai_asset_references WHERE asset_set_id='retired-set'",
        )
        .fetch_one(jobs.library().pool())
        .await
        .unwrap();
        assert_eq!(
            references, 0,
            "definite HTTP rejection retained original material pins"
        );
    }
    jobs.library().pool().close().await;
}

#[tokio::test]
async fn retired_submission_rejection_releases_original_material_pins() {
    retired_submission_receipt(404).await;
}

#[tokio::test]
async fn retired_submission_acceptance_keeps_original_material_job_binding() {
    retired_submission_receipt(200).await;
}
