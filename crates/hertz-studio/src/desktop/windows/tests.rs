// SPDX-License-Identifier: MIT
use super::super::Tab;
use super::*;
use crate::desktop_bridge::DesktopBridge;
use crate::state::AppState;
use hertz_desktop_ipc::{windows, Profile, Scope};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread,
};

struct Fixture {
    state: Arc<AppState>,
    desktop: Arc<Desktop>,
    bridge: Arc<DesktopBridge>,
    directory: PathBuf,
    audio: Option<thread::JoinHandle<()>>,
}
impl Fixture {
    async fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("hertz-facade-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let (mut state, audio) = crate::state::tests::playback_state().await;
        state.data_dir = directory.clone();
        let state = Arc::new(state);
        let bridge = DesktopBridge::new(&state);
        let desktop = Desktop::for_state(&state);
        desktop.attach_bridge(bridge.clone());
        let environment = Environment {
            pipe: format!(
                r"\\.\pipe\hertz-desktop-control-test-{}",
                uuid::Uuid::new_v4()
            ),
            installation: Some(directory.join("installation")),
        };
        *lock(&desktop.runtime.environment) = Some(environment);
        Self {
            state,
            desktop,
            bridge,
            directory,
            audio: Some(audio),
        }
    }
    fn environment(&self) -> Environment {
        self.desktop.runtime.environment()
    }
    fn consent(&self) -> Option<Value> {
        fs::read(self.directory.join("desktop-authorization.json"))
            .ok()
            .map(|b| serde_json::from_slice(&b).unwrap())
    }
    fn keys(&self) -> Vec<Vec<u8>> {
        ["desktop-lyrics-key", "wallpaper-key"]
            .iter()
            .map(|name| fs::read(self.directory.join(name)).unwrap())
            .collect()
    }
    async fn finish(self) {
        self.bridge.shutdown().await;
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.bridge.begin_shutdown();
        self.state.audio.shutdown();
        if let Some(audio) = self.audio.take() {
            audio.join().unwrap();
        }
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn response(request: &Value, active: Option<Profile>, connected: bool) -> Value {
    json!({"ok":true, "requestId":request["requestId"], "managementProtocol":2, "bridgeProtocol":1,
        "desktopBuildId":env!("HERTZ_DESKTOP_BUILD_ID"),
        "capabilities":{"targetProfile":true,"requestId":true,"requiredDesktopBuildId":true,
            "commands":["status","open-center"],"sourceFreshnessMs":3000,"sourceSwitch":"native-center"},
        "targetProfile":request["targetProfile"], "activeProfile":active,
        "sourceConnected":connected, "sourceScopes":{"lyrics":connected,"wallpaper":connected}})
}
fn reply(value: Value) -> mpsc::Receiver<Value> {
    let (send, receive) = mpsc::channel();
    send.send(value).unwrap();
    receive
}

struct Host {
    cancel: Cancellation,
    worker: Option<thread::JoinHandle<Vec<io::Result<()>>>>,
    calls: Arc<AtomicUsize>,
}
impl Host {
    fn start(
        name: String,
        count: usize,
        mut handler: impl FnMut(Value, management::Admission) -> mpsc::Receiver<Value> + Send + 'static,
    ) -> Self {
        let cancel = Cancellation::new();
        let worker_cancel = cancel.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_calls = calls.clone();
        let (ready, wait) = mpsc::channel();
        let worker = thread::spawn(move || {
            let mut results = Vec::new();
            for index in 0..count {
                if worker_cancel.is_cancelled() {
                    break;
                }
                let server = management::create_server(&name).unwrap();
                if index == 0 {
                    ready.send(()).unwrap();
                }
                let connection = match server.accept(&worker_cancel) {
                    Ok(c) => c,
                    Err(_) => break,
                };
                results.push(connection.serve(&worker_cancel, |value, admission| {
                    worker_calls.fetch_add(1, Ordering::SeqCst);
                    handler(value, admission)
                }));
            }
            results
        });
        wait.recv_timeout(Duration::from_secs(2)).unwrap();
        Self {
            cancel,
            worker: Some(worker),
            calls,
        }
    }
    fn successful(name: String, count: usize, active: Option<Profile>, connected: bool) -> Self {
        Self::start(name, count, move |request, _| {
            reply(response(&request, active.clone(), connected))
        })
    }
    fn join(mut self) -> Vec<io::Result<()>> {
        self.worker.take().unwrap().join().unwrap()
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

fn install(directory: &std::path::Path) -> Value {
    fs::create_dir_all(directory).unwrap();
    let bytes = b"fixture bytes are never executable";
    fs::write(directory.join("hertz-desktop.exe"), bytes).unwrap();
    let manifest = json!({"componentProtocol":1,"version":"0.3.0","target":"windows-x64",
        "desktopBuildId":env!("HERTZ_DESKTOP_BUILD_ID"),"managementProtocol":2,"bridgeProtocol":1,"launchMode":"manual",
        "file":"hertz-desktop.exe","size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))});
    fs::write(
        directory.join("desktop-component.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    manifest
}

#[test]
fn installed_manifest_is_strict_bounded_and_errors_are_not_missing() {
    let directory =
        std::env::temp_dir().join(format!("hertz-component-fixture-{}", uuid::Uuid::new_v4()));
    let cancel = Cancellation::new();
    let deadline = Instant::now() + TOTAL;
    let inspect = || component::discover(Some(&directory), &cancel, deadline);
    assert_eq!(inspect().state, "missing");
    let manifest = install(&directory);
    assert_eq!(inspect().state, "ready");
    for (key, value) in [
        ("extra", json!(true)),
        ("file", json!("other.exe")),
        ("launchMode", json!("spawn")),
        ("target", json!("windows-arm64")),
        ("bridgeProtocol", Value::Null),
        ("size", json!(0)),
        ("sha256", json!("f".repeat(64))),
        ("desktopBuildId", json!("f".repeat(64))),
    ] {
        let mut invalid = manifest.clone();
        invalid[key] = value;
        fs::write(
            directory.join("desktop-component.json"),
            serde_json::to_vec(&invalid).unwrap(),
        )
        .unwrap();
        assert_eq!(inspect().state, "incompatible", "{key}");
    }
    fs::write(directory.join("desktop-component.json"), vec![b' '; 16385]).unwrap();
    assert_eq!(inspect().state, "incompatible");
    fs::remove_file(directory.join("desktop-component.json")).unwrap();
    fs::create_dir(directory.join("desktop-component.json")).unwrap();
    assert_eq!(
        inspect().state,
        "unknown",
        "read errors must not look like a missing component"
    );
    assert_eq!(
        component::discover(None, &cancel, deadline).state,
        "unknown"
    );
    cancel.cancel();
    assert_eq!(inspect().state, "unknown");
    fs::remove_dir_all(directory).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn construction_cached_calls_and_restore_do_not_probe_components_or_create_authority() {
    let fixture = Fixture::new().await;
    let host = Host::successful(fixture.environment().pipe, 1, None, false);
    for _ in 0..20 {
        let capabilities = fixture.desktop.capabilities(false).await;
        assert_eq!(capabilities.component.state, "unknown");
        assert_eq!(
            capabilities.source.as_ref(),
            fixture.bridge.profile().as_ref()
        );
        assert!(!capabilities.management_ready && !capabilities.authorization.gate);
    }
    fixture.bridge.restore().await.unwrap();
    assert_eq!(host.calls.load(Ordering::SeqCst), 0);
    assert!(fs::read_dir(&fixture.directory).unwrap().next().is_none());
    drop(host);
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compatible_running_host_outranks_missing_install_and_connects_coalesce_reusing_authority()
{
    let fixture = Fixture::new().await;
    let host = Host::successful(
        fixture.environment().pipe,
        6,
        fixture.bridge.profile(),
        true,
    );
    let (left, right) = tokio::join!(
        fixture.desktop.connect(Tab::Lyrics),
        fixture.desktop.connect(Tab::Wallpaper)
    );
    assert!(left.ok && right.ok && left.center_opened);
    assert_eq!(host.calls.load(Ordering::SeqCst), 3);
    assert_eq!(left.capabilities.component.origin, Some("running"));
    assert!(left.capabilities.management_ready && left.capabilities.source_connected);
    assert!(left.capabilities.authorization.listener_ready && left.capabilities.authorization.gate);
    assert_eq!(left.capabilities.authorization.scopes.len(), 2);
    let discovery: hertz_desktop_ipc::Discovery = serde_json::from_slice(
        &windows::read_private_bounded(
            &fixture.directory.join("desktop-source.json"),
            hertz_desktop_ipc::DISCOVERY_LIMIT,
        )
        .unwrap(),
    )
    .unwrap();
    let key = String::from_utf8(
        windows::read_private_bounded(&fixture.directory.join("desktop-lyrics-key"), 128).unwrap(),
    )
    .unwrap();
    let data = windows::request(
        discovery.pipes.lyrics.as_ref().unwrap(),
        std::process::id(),
        &hertz_desktop_ipc::Request {
            bridge_protocol: 1,
            request_id: "facade-authenticated-read".into(),
            server_instance_id: fixture.state.server_instance_id().into(),
            scope: Scope::Lyrics,
            key,
            op: "snapshot".into(),
            params: json!({}),
        },
        &Cancellation::new(),
    )
    .await
    .unwrap();
    assert_eq!(data.status, 200);
    let revision = left.capabilities.authorization.revision;
    let keys = fixture.keys();
    assert!(!fixture.desktop.cached().source_connected);
    let again = fixture.desktop.connect(Tab::Runtime).await;
    assert!(again.ok);
    assert_eq!(again.capabilities.authorization.revision, revision);
    assert_eq!(fixture.keys(), keys);
    assert_eq!(host.calls.load(Ordering::SeqCst), 6);
    assert!(host.join().into_iter().all(|r| r.is_ok()));
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn installed_ready_requires_manual_start_and_incompatible_host_never_receives_target_or_consent(
) {
    let fixture = Fixture::new().await;
    install(fixture.environment().installation.as_ref().unwrap());
    let result = fixture.desktop.connect(Tab::Runtime).await;
    assert!(!result.ok);
    assert_eq!(
        result.error.unwrap().code,
        "desktop_component_start_required"
    );
    assert_eq!(result.capabilities.component.state, "ready");
    assert!(!result.capabilities.management_ready && !result.capabilities.launch_requested);
    assert!(fixture.consent().is_none());
    let host = Host::start(fixture.environment().pipe, 1, |request, _| {
        assert_eq!(request, json!({"command":"status"}));
        reply(json!({"ok":true,"managementProtocol":1}))
    });
    let result = fixture.desktop.connect(Tab::Runtime).await;
    assert_eq!(result.error.unwrap().code, "desktop_component_incompatible");
    assert!(fixture.consent().is_none());
    assert_eq!(host.join().len(), 1);
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_a_is_not_source_b_and_revoke_masks_an_earlier_true_response() {
    let fixture = Fixture::new().await;
    let other_dir = fixture.directory.join("other");
    fs::create_dir(&other_dir).unwrap();
    let other = Profile::Dbx {
        edition: crate::edition::NAME.into(),
        data_dir: other_dir.to_string_lossy().into_owned(),
        plugin_id: crate::edition::PLUGIN_ID.into(),
    }
    .normalized()
    .unwrap();
    let host = Host::successful(fixture.environment().pipe, 3, Some(other), true);
    let result = fixture.desktop.connect(Tab::Runtime).await;
    assert!(result.ok && !result.capabilities.source_connected);
    host.join();
    let generation = fixture.bridge.capture_generation().unwrap();
    let epoch = lock(&fixture.desktop.runtime.operations).epoch;
    let native = response(
        &json!({"targetProfile":fixture.bridge.profile()}),
        fixture.bridge.profile(),
        true,
    );
    assert!(fixture.desktop.disconnect().await.ok);
    let late = fixture.desktop.finish(Completion {
        epoch,
        authority: Some(Authority::Authorized(generation)),
        native: Some((native, Instant::now())),
        error: None,
        center_opened: true,
    });
    assert!(
        !late.ok && !late.capabilities.source_connected && !late.capabilities.authorization.gate
    );
    assert!(late.capabilities.authorization.persistent_revoked);
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_during_probe_cannot_reauthorize_and_never_waits_for_management() {
    let fixture = Fixture::new().await;
    let (entered, wait) = tokio::sync::oneshot::channel();
    let mut entered = Some(entered);
    let (send, receive) = mpsc::channel();
    let mut receive = Some(receive);
    let host = Host::start(fixture.environment().pipe, 1, move |request, _| {
        assert_eq!(request, json!({"command":"status"}));
        entered.take().unwrap().send(()).unwrap();
        receive.take().unwrap()
    });
    let desktop = fixture.desktop.clone();
    let connecting = tokio::spawn(async move { desktop.connect(Tab::Runtime).await });
    wait.await.unwrap();
    let started = Instant::now();
    let result = fixture.desktop.disconnect().await;
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(result.ok && !result.capabilities.authorization.gate);
    let _ = send.send(response(&json!({}), fixture.bridge.profile(), true));
    assert!(!connecting.await.unwrap().ok);
    assert!(fixture.keys_if_any().is_empty());
    assert_eq!(fixture.consent().unwrap()["scopes"], json!([]));
    host.join();
    fixture.finish().await;
}

impl Fixture {
    fn keys_if_any(&self) -> Vec<Vec<u8>> {
        ["desktop-lyrics-key", "wallpaper-key"]
            .iter()
            .filter_map(|name| fs::read(self.directory.join(name)).ok())
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_last_connect_waiter_cancels_and_reaps_probe_then_allows_a_new_call() {
    let fixture = Fixture::new().await;
    let (entered, wait) = tokio::sync::oneshot::channel();
    let mut entered = Some(entered);
    let mut held = Vec::new();
    let host = Host::start(fixture.environment().pipe, 4, move |request, _| {
        if let Some(entered) = entered.take() {
            entered.send(()).unwrap();
            let (send, receive) = mpsc::channel();
            held.push(send);
            receive
        } else {
            let active = serde_json::from_value(request["targetProfile"].clone()).ok();
            reply(response(&request, active, false))
        }
    });
    let mut connecting = Box::pin(fixture.desktop.connect(Tab::Runtime));
    tokio::select! { _ = &mut connecting => panic!("probe should be pending"), result = wait => result.unwrap() }
    let started = Instant::now();
    drop(connecting);
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(fixture.consent().is_none());
    assert!(fixture.desktop.connect(Tab::Runtime).await.ok);
    let results = host.join();
    assert!(results[0].is_err());
    assert!(results[1..].iter().all(|r| r.is_ok()));
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_failure_preserves_authorization_and_disconnect_cancels_late_open() {
    let fixture = Fixture::new().await;
    let (entered, wait) = tokio::sync::oneshot::channel();
    let mut entered = Some(entered);
    let mut held = Vec::new();
    let host = Host::start(fixture.environment().pipe, 2, move |request, _| {
        if request["command"] == "open-center" {
            entered.take().unwrap().send(()).unwrap();
            let (send, receive) = mpsc::channel();
            held.push(send);
            receive
        } else {
            reply(response(&request, None, false))
        }
    });
    let desktop = fixture.desktop.clone();
    let connecting = tokio::spawn(async move { desktop.connect(Tab::Runtime).await });
    wait.await.unwrap();
    assert!(fixture.bridge.status().listener_ready);
    let result = fixture.desktop.disconnect().await;
    assert!(result.ok && !result.capabilities.authorization.gate);
    let late = connecting.await.unwrap();
    assert!(!late.ok && !late.capabilities.authorization.gate);
    host.join();
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_management_failure_keeps_real_consent_for_revoke_or_retry() {
    let fixture = Fixture::new().await;
    let host = Host::start(fixture.environment().pipe, 2, move |request, _| {
        let mut value = response(&request, None, false);
        if request["command"] == "open-center" {
            value["requestId"] = json!("wrong-id");
        }
        reply(value)
    });
    let result = fixture.desktop.connect(Tab::Runtime).await;
    assert!(!result.ok);
    assert_eq!(result.error.unwrap().code, "desktop_response_invalid");
    assert!(
        result.capabilities.authorization.gate && result.capabilities.authorization.listener_ready
    );
    assert_eq!(result.capabilities.authorization.scopes.len(), 2);
    assert!(result.capabilities.authorization.revision.is_some());
    host.join();
    assert!(fixture.desktop.disconnect().await.ok);
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn multiple_management_requests_share_the_five_second_deadline_and_reap_timeout() {
    let fixture = Fixture::new().await;
    let delay_workers = Arc::new(Mutex::new(Vec::new()));
    let server_delays = delay_workers.clone();
    let host = Host::start(fixture.environment().pipe, 3, move |request, admission| {
        let value = response(
            &request,
            serde_json::from_value(request["targetProfile"].clone()).ok(),
            false,
        );
        let (send, receive) = mpsc::channel();
        let delayed = request["command"] == "open-center" || request.get("targetProfile").is_none();
        if delayed {
            lock(&server_delays).push(thread::spawn(move || {
                thread::sleep(Duration::from_millis(1600));
                if admission.is_valid() {
                    let _ = send.send(value);
                }
            }));
        } else {
            lock(&server_delays).push(thread::spawn(move || {
                while admission.is_valid() {
                    thread::sleep(Duration::from_millis(10));
                }
                drop(send);
            }));
        }
        receive
    });
    let started = Instant::now();
    let result = fixture.desktop.connect(Tab::Runtime).await;
    assert!(!result.ok);
    assert_eq!(result.error.unwrap().code, "desktop_timeout");
    assert!(started.elapsed() >= Duration::from_millis(4800));
    assert!(started.elapsed() < Duration::from_millis(5500));
    assert!(result.capabilities.authorization.listener_ready);
    let results = host.join();
    assert_eq!(results.len(), 3);
    assert!(results[2].is_err());
    for worker in std::mem::take(&mut *lock(&delay_workers)) {
        worker.join().unwrap();
    }
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refreshes_coalesce_without_authorization_and_management_cache_expires() {
    let fixture = Fixture::new().await;
    let host = Host::successful(
        fixture.environment().pipe,
        2,
        fixture.bridge.profile(),
        false,
    );
    let pending = (0..16).map(|_| fixture.desktop.capabilities(true));
    let results = futures::future::join_all(pending).await;
    assert!(results
        .iter()
        .all(|r| r.management_ready && !r.authorization.gate));
    assert_eq!(host.calls.load(Ordering::SeqCst), 2);
    assert!(fixture.consent().is_none());
    lock(&fixture.desktop.runtime.cache).management_at =
        Some(Instant::now() - Duration::from_secs(4));
    assert!(!fixture.desktop.cached().management_ready);
    host.join();
    fixture.finish().await;
}

#[tokio::test]
async fn old_preauthorization_admission_cannot_commit_after_a_completed_disconnect() {
    let fixture = Fixture::new().await;
    let epoch = fixture.bridge.admission_epoch().unwrap();
    assert!(fixture.desktop.disconnect().await.ok);
    assert!(fixture
        .bridge
        .connect_authorization_at(epoch)
        .await
        .is_err());
    assert!(fixture.keys_if_any().is_empty());
    assert_eq!(fixture.consent().unwrap()["scopes"], json!([]));
    let host = Host::successful(
        fixture.environment().pipe,
        3,
        fixture.bridge.profile(),
        false,
    );
    assert!(
        fixture.desktop.connect(Tab::Runtime).await.ok,
        "a NEW explicit intent can authorize after revocation"
    );
    host.join();
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_cancels_unauthorized_probe_without_changing_the_existing_barrier() {
    let fixture = Fixture::new().await;
    let (entered, wait) = tokio::sync::oneshot::channel();
    let mut entered = Some(entered);
    let mut held = Vec::new();
    let host = Host::start(fixture.environment().pipe, 1, move |_, _| {
        entered.take().unwrap().send(()).unwrap();
        let (send, receive) = mpsc::channel();
        held.push(send);
        receive
    });
    let desktop = fixture.desktop.clone();
    let connecting = tokio::spawn(async move { desktop.connect(Tab::Runtime).await });
    wait.await.unwrap();
    let started = Instant::now();
    fixture.bridge.begin_shutdown();
    assert!(!connecting.await.unwrap().ok);
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(fixture.consent().is_none());
    assert!(host.join()[0].is_err());
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_cancels_unauthorized_second_status_and_late_results_cannot_publish() {
    let fixture = Fixture::new().await;
    let (admission_epoch, admission_cancel) = fixture.bridge.admission().unwrap();
    let authority = Authority::Admission {
        epoch: admission_epoch,
        cancel: admission_cancel,
    };
    let (entered, wait) = tokio::sync::oneshot::channel();
    let mut entered = Some(entered);
    let (send, receive) = mpsc::channel();
    let mut receive = Some(receive);
    let host = Host::start(fixture.environment().pipe, 2, move |request, _| {
        if request.get("targetProfile").is_some() {
            assert_eq!(request["command"], "status");
            assert_eq!(request["managementProtocol"], 2);
            entered.take().unwrap().send(request).unwrap();
            receive.take().unwrap()
        } else {
            reply(response(&request, None, false))
        }
    });
    let desktop = fixture.desktop.clone();
    let refreshing = tokio::spawn(async move { desktop.capabilities(true).await });
    let request = wait.await.unwrap();
    assert!(fixture.bridge.capture_generation().is_none());
    let before = lock(&fixture.desktop.runtime.cache).management_at;
    assert!(
        before.is_some(),
        "legacy compatibility was observed before the second request"
    );
    let epoch = lock(&fixture.desktop.runtime.operations).epoch;
    let started = Instant::now();
    fixture.bridge.begin_shutdown();
    let result = refreshing.await.unwrap();
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(!result.management_ready && !result.source_connected);
    assert_eq!(result.error.unwrap().code, "desktop_operation_cancelled");
    assert!(!fixture.desktop.cached().management_ready);
    assert_eq!(lock(&fixture.desktop.runtime.cache).management_at, before);
    assert!(fixture.consent().is_none());
    // A reply supplied after actual client cancellation has no receiver and no publication.
    let native = response(&request, fixture.bridge.profile(), true);
    assert!(host.join()[1].is_err());
    assert!(send.send(native.clone()).is_err());
    let late = fixture.desktop.finish(Completion {
        epoch,
        authority: Some(authority),
        native: Some((native, Instant::now())),
        error: None,
        center_opened: false,
    });
    assert!(!late.ok && !late.capabilities.management_ready && !late.capabilities.source_connected);
    assert_eq!(late.error.unwrap().code, "desktop_operation_cancelled");
    assert_eq!(lock(&fixture.desktop.runtime.cache).management_at, before);
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_scope_repair_promotes_new_generation_instead_of_cancelled_old_admission() {
    let fixture = Fixture::new().await;
    let original = fixture.bridge.connect_authorization().await.unwrap();
    let old_generation = fixture.bridge.capture_generation().unwrap();
    let (_, old_admission) = fixture.bridge.admission().unwrap();
    let keys = fixture.keys();
    fs::remove_file(fixture.directory.join("wallpaper-key")).unwrap();
    let host = Host::successful(
        fixture.environment().pipe,
        3,
        fixture.bridge.profile(),
        false,
    );
    let result = fixture.desktop.connect(Tab::Wallpaper).await;
    assert!(result.ok && result.center_opened, "{:?}", result.error);
    assert!(old_admission.is_cancelled() && old_generation.is_cancelled());
    assert!(fixture.bridge.capture_generation().unwrap().epoch() > old_generation.epoch());
    assert!(
        result.capabilities.authorization.gate && result.capabilities.authorization.listener_ready
    );
    assert!(result.capabilities.management_ready);
    assert_eq!(result.capabilities.authorization.scopes.len(), 2);
    assert_eq!(
        result.capabilities.authorization.revision,
        original.revision
    );
    let repaired = fixture.keys();
    assert_eq!(repaired[0], keys[0]);
    assert_ne!(repaired[1], keys[1]);
    assert!(host.join().into_iter().all(|r| r.is_ok()));
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_connect_after_authorization_keeps_consented_resources_and_can_retry() {
    let fixture = Fixture::new().await;
    let (entered, wait) = tokio::sync::oneshot::channel();
    let mut entered = Some(entered);
    let mut held = Vec::new();
    let host = Host::start(fixture.environment().pipe, 5, move |request, _| {
        if request["command"] == "open-center" && entered.is_some() {
            entered.take().unwrap().send(()).unwrap();
            let (send, receive) = mpsc::channel();
            held.push(send);
            receive
        } else {
            let active = serde_json::from_value(request["targetProfile"].clone()).ok();
            reply(response(&request, active, false))
        }
    });
    let mut connecting = Box::pin(fixture.desktop.connect(Tab::Runtime));
    tokio::select! { _ = &mut connecting => panic!("open should be pending"), result = wait => result.unwrap() }
    let revision = fixture.bridge.status().revision;
    let keys = fixture.keys();
    let started = Instant::now();
    drop(connecting);
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(fixture.desktop.cached().authorization.listener_ready);
    let retry = fixture.desktop.connect(Tab::Runtime).await;
    assert!(retry.ok && !retry.capabilities.source_connected);
    assert_eq!(retry.capabilities.authorization.revision, revision);
    assert_eq!(fixture.keys(), keys);
    let results = host.join();
    assert!(results[1].is_err());
    assert!(results[2..].iter().all(|r| r.is_ok()));
    fixture.finish().await;
}

#[tokio::test]
async fn disconnect_result_distinguishes_persistence_failure_from_cleanup_failure() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
    let fixture = Fixture::new().await;
    fixture.bridge.connect_authorization().await.unwrap();
    let busy_auth = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(fixture.directory.join("desktop-authorization.json"))
        .unwrap();
    let result = fixture.desktop.disconnect().await;
    assert!(!result.ok);
    assert_eq!(result.error.unwrap().code, "desktop_revocation_incomplete");
    assert!(
        !result.capabilities.authorization.gate
            && !result.capabilities.authorization.persistent_revoked
    );
    assert!(!result.capabilities.source_connected);
    drop(busy_auth);
    assert!(fixture.desktop.disconnect().await.ok);
    fixture.bridge.connect_authorization().await.unwrap();
    let busy_key = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(fixture.directory.join("desktop-lyrics-key"))
        .unwrap();
    let result = fixture.desktop.disconnect().await;
    assert!(
        result.ok
            && result.capabilities.authorization.persistent_revoked
            && result.capabilities.authorization.cleanup_incomplete
    );
    assert!(!result.capabilities.authorization.gate && !result.capabilities.source_connected);
    drop(busy_key);
    assert!(
        !fixture
            .desktop
            .disconnect()
            .await
            .capabilities
            .authorization
            .cleanup_incomplete
    );
    fixture.finish().await;
}

#[tokio::test]
async fn admission_before_probe_cancels_while_waiting_for_the_single_worker_budget() {
    let fixture = Fixture::new().await;
    let permit = fixture
        .desktop
        .runtime
        .slot
        .clone()
        .acquire_owned()
        .await
        .unwrap();
    let mut connecting = Box::pin(fixture.desktop.connect(Tab::Runtime));
    tokio::select! { _ = &mut connecting => panic!("worker budget should be held"), _ = tokio::time::sleep(Duration::from_millis(10)) => {} }
    fixture.desktop.disconnect().await;
    drop(permit);
    let result = connecting.await;
    assert!(!result.ok && !result.capabilities.authorization.gate);
    assert!(fixture.keys_if_any().is_empty());
    fixture.finish().await;
}

#[test]
fn reply_identity_protocol_target_and_required_capabilities_are_validated() {
    let profile = Profile::Dbx {
        edition: crate::edition::NAME.into(),
        data_dir: r"C:\fixture".into(),
        plugin_id: crate::edition::PLUGIN_ID.into(),
    };
    let (id, envelope) = protocol::envelope(&profile, "status", Value::Null);
    let valid = response(&envelope, Some(profile.clone()), true);
    assert!(id.bytes().all(|b| b.is_ascii_graphic()) && id.len() <= 128);
    assert!(protocol::validate(&valid, &id, &profile).is_ok());
    for (key, bad) in [
        ("requestId", json!("wrong")),
        ("desktopBuildId", json!("wrong")),
        ("managementProtocol", json!(1)),
        ("targetProfile", Value::Null),
        ("bridgeProtocol", Value::Null),
    ] {
        let mut invalid = valid.clone();
        invalid[key] = bad;
        assert!(
            protocol::validate(&invalid, &id, &profile).is_err(),
            "{key}"
        );
    }
    let mut invalid = valid;
    invalid["capabilities"]["commands"] = json!(["status"]);
    assert!(!protocol::compatible(&invalid));
}
