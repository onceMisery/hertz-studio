// SPDX-License-Identifier: MIT
use super::*;

fn prepared(provider: &str) -> (Arc<NativeGeneration>, Connection) {
    let service = NativeGeneration::new();
    let mut connection = super::tests::connection();
    connection.bearer = Some("c".repeat(64));
    connection.expires = Some(Instant::now() + Duration::from_secs(120));
    let mut state = lock(&service.state);
    state.connection = Some(connection.clone());
    state.quote = Some(Quote {
        owner: 1,
        token: "confirmed".into(),
        quote_id: "quote".into(),
        request_id: "request".into(),
        idempotency_key: "original".into(),
        summary: json!({"provider":provider,"maximumWaitSeconds":90}),
        expires: Instant::now() + Duration::from_secs(60),
        description: String::new(),
        specification: String::new(),
        asset_set_id: None,
    });
    drop(state);
    (service, connection)
}

#[test]
fn pause_defaults_to_local_ollama_only_and_opt_out_does_not_dispatch() {
    for (provider, choice, expected) in [
        ("ollama-local", None, true),
        ("ollama-local", Some(false), false),
        ("ollama-local", Some(true), true),
        ("fake", Some(true), false),
        ("remote", None, false),
    ] {
        let (service, c) = prepared(provider);
        let mut payload = json!({"confirmationToken":"confirmed"});
        if let Some(choice) = choice {
            payload["pauseDynamic"] = choice.into();
        }
        service.prepare_pause(1, &payload).unwrap();
        assert_eq!(service.pause_active(), expected);
        assert!(
            lock(&service.state).submission.is_none(),
            "pausing is not a model request"
        );
        assert!(lock(&service.state).job.is_none());
        std::fs::remove_dir_all(c.profile.data_dir()).unwrap();
    }
}

#[test]
fn pause_needs_live_quote_owner_and_keeps_original_deadline_on_repeat() {
    let (service, c) = prepared("ollama-local");
    let payload = json!({"confirmationToken":"confirmed"});
    assert!(service.prepare_pause(2, &payload).is_err());
    assert!(!service.pause_active());
    service.prepare_pause(1, &payload).unwrap();
    let now = Instant::now();
    // Repeating preparation and receiving a later receipt cannot extend the bound.
    service.prepare_pause(1, &payload).unwrap();
    assert!(lock(&service.state)
        .pauses
        .active(now + Duration::from_secs(89)));
    assert!(!lock(&service.state)
        .pauses
        .active(now + Duration::from_secs(91)));
    std::fs::remove_dir_all(c.profile.data_dir()).unwrap();
}

#[test]
fn pause_cancellation_and_disconnect_remain_uncertain_until_original_deadline() {
    let now = Instant::now();
    let mut pauses = pause::Pauses::default();
    pauses
        .prepare(4, "request", now + Duration::from_secs(90), now)
        .unwrap();
    pauses.submitted(4, "request");
    pauses.observe(
        4,
        Some("request"),
        &json!({"jobId":"job","state":"running","dispatchState":"may_have_been_sent"}),
    );
    pauses.observe(
        4,
        None,
        &json!({"jobId":"job","state":"cancelled","dispatchState":"may_have_been_sent"}),
    );
    let status = pauses.snapshot(now + Duration::from_secs(20));
    assert_eq!(status["active"], true);
    assert_eq!(status["stopping"], true);
    assert_eq!(status["externalMayRun"], true);
    pauses.interrupted(4);
    assert!(pauses.active(now + Duration::from_secs(89)));
    let status = pauses.snapshot(now + Duration::from_secs(90));
    assert_eq!(status["active"], false);
    assert_eq!(status["releaseReason"], "deadline");
    assert_eq!(
        status["externalMayRun"], true,
        "lease expiry is not provider exit evidence"
    );
}

#[test]
fn released_uncertainty_survives_other_jobs_until_its_own_proven_completion() {
    let now = Instant::now();
    let mut pauses = pause::Pauses::default();
    for (request, job, seconds) in [("old", "job-old", 10), ("current", "job-current", 90)] {
        pauses
            .prepare(1, request, now + Duration::from_secs(seconds), now)
            .unwrap();
        pauses.submitted(1, request);
        pauses.observe(1, Some(request), &json!({"jobId":job,"state":"running"}));
    }
    pauses.observe(
        1,
        None,
        &json!({"jobId":"job-old","state":"cancelled","dispatchState":"may_have_been_sent"}),
    );
    let later = now + Duration::from_secs(11);
    let status = pauses.snapshot(later);
    assert_eq!(status["active"], true);
    assert_eq!(
        status["stopping"], false,
        "the current job is running normally"
    );
    assert_eq!(
        status["externalMayRun"], true,
        "old uncertainty outlives its presentation lease"
    );
    pauses.observe(1, None, &json!({"jobId":"job-current","state":"succeeded"}));
    let status = pauses.snapshot(later);
    assert_eq!(status["active"], false);
    assert_eq!(
        status["externalMayRun"], true,
        "unrelated success cannot settle the old model"
    );
    pauses
        .prepare(2, "next", later + Duration::from_secs(30), later)
        .unwrap();
    pauses.reject(2, "next");
    assert_eq!(
        pauses.snapshot(later)["externalMayRun"],
        true,
        "new quote and rejection cannot erase uncertainty"
    );
    pauses.observe(2, None, &json!({"jobId":"job-old","state":"succeeded"}));
    assert_eq!(
        pauses.snapshot(later)["externalMayRun"],
        true,
        "a different service epoch is not exit evidence"
    );
    pauses.observe(1, None, &json!({"jobId":"job-old","state":"succeeded"}));
    assert_eq!(pauses.snapshot(later)["externalMayRun"], false);
}

#[test]
fn explicit_resume_and_session_exit_keep_external_uncertainty_bounded_and_visible() {
    let now = Instant::now();
    let mut pauses = pause::Pauses::default();
    for index in 0..64 {
        let request = format!("request-{index}");
        pauses
            .prepare(1, &request, now + Duration::from_secs(30), now)
            .unwrap();
        pauses.submitted(1, &request);
        pauses.resume(&[request]);
    }
    pauses
        .prepare(2, "fresh", now + Duration::from_secs(30), now)
        .unwrap();
    pauses.observe(
        2,
        Some("fresh"),
        &json!({"jobId":"fresh-job","state":"succeeded"}),
    );
    pauses.end_session();
    let status = pauses.snapshot(now);
    assert_eq!(status["active"], false);
    assert_eq!(status["externalMayRun"], true);
    assert!(
        serde_json::to_vec(&status).unwrap().len() < 256,
        "status stays bounded after many released requests"
    );
}

#[test]
fn pause_success_and_proven_undispatched_terminal_release_only_the_matching_job() {
    let now = Instant::now();
    for (state, dispatch, releases) in [
        ("succeeded", "may_have_been_sent", true),
        ("cancelled", "not_dispatched", true),
        ("failed", "not_dispatched", true),
        ("expired", "may_have_been_sent", false),
        ("failed", "may_have_been_sent", false),
        ("cancelled", "", false),
    ] {
        let mut pauses = pause::Pauses::default();
        for (request, job) in [("first", "job-first"), ("second", "job-second")] {
            pauses
                .prepare(1, request, now + Duration::from_secs(90), now)
                .unwrap();
            pauses.submitted(1, request);
            pauses.observe(1, Some(request), &json!({"jobId":job,"state":"running"}));
        }
        pauses.observe(2, None, &json!({"jobId":"job-first","state":"succeeded"}));
        assert_eq!(
            pauses.snapshot(now)["requests"].as_array().unwrap().len(),
            2,
            "old service epoch cannot release anything"
        );
        pauses.observe(
            1,
            None,
            &json!({"jobId":"job-first","state":state,"dispatchState":dispatch}),
        );
        let status = pauses.snapshot(now);
        assert_eq!(
            status["requests"].as_array().unwrap().len(),
            if releases { 1 } else { 2 }
        );
        assert_eq!(status["active"], true, "another job still owns its pause");
        pauses.resume(&["first".into()]);
        assert_eq!(pauses.snapshot(now)["requests"][0]["requestId"], "second");
    }
}

#[test]
fn pause_explicit_resume_is_local_and_stale_resume_cannot_release_a_new_request() {
    let (service, c) = prepared("ollama-local");
    service
        .prepare_pause(1, &json!({"confirmationToken":"confirmed"}))
        .unwrap();
    {
        let mut state = lock(&service.state);
        state.pauses.submitted(0, "request");
        state.connection = None;
    }
    service.busy.store(true, Ordering::Release);
    let status = service
        .resume_pause(json!({"requestIds":["request"]}))
        .unwrap();
    assert_eq!(
        status["active"], false,
        "resume needs neither a connected service nor a free HTTP worker"
    );
    assert_eq!(status["externalMayRun"], true);
    let now = Instant::now();
    lock(&service.state)
        .pauses
        .prepare(2, "next", now + Duration::from_secs(30), now)
        .unwrap();
    assert_eq!(
        service
            .resume_pause(json!({"requestIds":["request"]}))
            .unwrap()["active"],
        true
    );
    service.end_presentation_session();
    assert!(!service.pause_active());
    assert_eq!(
        lock(&service.state).pauses.snapshot(now)["releaseReason"],
        "sessionEnded"
    );
    std::fs::remove_dir_all(c.profile.data_dir()).unwrap();
}

#[test]
fn pause_session_expiry_caps_wait_and_pre_submission_failure_releases() {
    let (service, c) = prepared("ollama-local");
    let now = Instant::now();
    lock(&service.state).connection.as_mut().unwrap().expires = Some(now + Duration::from_secs(10));
    service
        .prepare_pause(1, &json!({"confirmationToken":"confirmed"}))
        .unwrap();
    assert!(!lock(&service.state)
        .pauses
        .active(now + Duration::from_secs(10)));
    service
        .prepare_pause(1, &json!({"confirmationToken":"confirmed"}))
        .unwrap();
    service.invalidate_quote();
    let (sender, receiver) = std::sync::mpsc::channel();
    service
        .run(
            c.profile.clone(),
            1,
            "wallpaper.ai.generate.confirm".into(),
            json!({"confirmationToken":"confirmed"}),
            move |result| sender.send(result).unwrap(),
        )
        .unwrap();
    assert!(receiver
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .is_err());
    assert!(
        !service.pause_active(),
        "revoked consent before dispatch must not retain a pause"
    );
    std::fs::remove_dir_all(c.profile.data_dir()).unwrap();
}

#[test]
fn pause_native_submission_observes_loopback_receipt_and_safe_rejection() {
    for (status, body, active) in [
        (
            200,
            json!({"job":{"jobId":"service-job","state":"running","dispatchState":"may_have_been_sent"}}),
            true,
        ),
        (
            200,
            json!({"job":{"jobId":"service-job","state":"succeeded","dispatchState":"may_have_been_sent"}}),
            false,
        ),
        (
            403,
            json!({"error":{"code":"grant_revoked","message":"fixture"}}),
            false,
        ),
        (
            500,
            json!({"error":{"code":"internal","message":"fixture"}}),
            true,
        ),
    ] {
        let bytes = serde_json::to_vec(&body).unwrap();
        let mut response = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\n\r\n",
            bytes.len()
        )
        .into_bytes();
        response.extend_from_slice(&bytes);
        let (port, worker) = super::tests::listener(response);
        let (service, mut c) = prepared("ollama-local");
        c.origin = format!("http://127.0.0.1:{port}");
        let path = std::path::Path::new(c.profile.data_dir()).join("vmusicd.json");
        let mut discovery: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        discovery["port"] = port.into();
        std::fs::write(path, serde_json::to_vec(&discovery).unwrap()).unwrap();
        lock(&service.state).connection = Some(c.clone());
        let payload = json!({"confirmationToken":"confirmed","pauseDynamic":true});
        service.prepare_pause(1, &payload).unwrap();
        assert!(
            service.pause_active(),
            "lease must exist before the HTTP worker starts"
        );
        let (sender, receiver) = std::sync::mpsc::channel();
        service
            .run(
                c.profile.clone(),
                1,
                "wallpaper.ai.generate.confirm".into(),
                payload,
                move |result| sender.send(result).unwrap(),
            )
            .unwrap();
        let result = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(result.is_ok(), status == 200);
        assert_eq!(
            service.pause_active(),
            active,
            "status={status}, body={body}"
        );
        let request = String::from_utf8(worker.join().unwrap()).unwrap();
        assert!(request.starts_with("POST /v1/ai/wallpaper/jobs "));
        assert!(
            !request.contains("pauseDynamic"),
            "preference is native presentation policy, not model input"
        );
        std::fs::remove_dir_all(c.profile.data_dir()).unwrap();
    }
}
