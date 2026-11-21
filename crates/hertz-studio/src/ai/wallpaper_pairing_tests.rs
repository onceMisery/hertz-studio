// SPDX-License-Identifier: MIT
use super::*;
#[cfg(windows)]
use crate::{
    ai::{facade, jobs},
    routes,
};

#[cfg(windows)]
#[test]
#[ignore = "child process fixture, invoked only by pairing tests"]
fn native_process_helper() {
    let root = std::path::PathBuf::from(
        std::env::var_os("HERTZ_PAIRING_TEST_ROOT").expect("private fixture root"),
    );
    std::fs::write(root.join("ready"), b"ready").unwrap();
    let start = Instant::now();
    while !root.join("stop").exists() && start.elapsed() < Duration::from_secs(45) {
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(windows)]
struct NativeProcess {
    child: std::process::Child,
    root: std::path::PathBuf,
}
#[cfg(windows)]
impl NativeProcess {
    fn start() -> Self {
        let root =
            std::env::temp_dir().join(format!("hertz-pairing-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "ai::wallpaper_pairing::tests::native_process_helper",
            ])
            .env("HERTZ_PAIRING_TEST_ROOT", &root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let process = Self { child, root };
        let start = Instant::now();
        while !process.root.join("ready").exists() {
            assert!(start.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(20));
        }
        process
    }
}
#[cfg(windows)]
impl Drop for NativeProcess {
    fn drop(&mut self) {
        let _ = std::fs::write(self.root.join("stop"), b"stop");
        let start = Instant::now();
        while self.child.try_wait().ok().flatten().is_none()
            && start.elapsed() < Duration::from_secs(2)
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

fn binding() -> Binding {
    Binding {
        protocol: 1,
        user_sid: "S-1-5-21-1".into(),
        windows_session_id: 1,
        native_pid: 1,
        native_generation: "123".into(),
        desktop_build_id: "a".repeat(64),
        edition: "full".into(),
        profile_digest: "b".repeat(64),
        service_pid: 2,
        server_instance_id: "instance".into(),
    }
}
#[test]
fn pending_challenges_are_bounded_single_use_and_monotonic() {
    let mut store = PendingStore::default();
    let first = Registration {
        challenge: "c".repeat(64),
        binding: binding(),
    };
    let id = store.insert(first.clone()).unwrap();
    assert_eq!(store.insert(first).unwrap_err().code, "pairing_pending");
    let mut b = binding();
    for pid in 3..6 {
        b.native_pid = pid;
        store
            .insert(Registration {
                challenge: "d".repeat(64),
                binding: b.clone(),
            })
            .unwrap();
    }
    b.native_pid = 10;
    assert_eq!(
        store
            .insert(Registration {
                challenge: "e".repeat(64),
                binding: b
            })
            .unwrap_err()
            .code,
        "pairing_busy"
    );
    store.take(&id).unwrap();
    assert_eq!(store.take(&id).err().unwrap().code, "pairing_expired");
    store.pending[0].deadline = Instant::now() - Duration::from_secs(1);
    let expired = store.pending[0].id.clone();
    assert_eq!(store.take(&expired).err().unwrap().code, "pairing_expired");
}

#[cfg(windows)]
async fn fixture(native: &NativeProcess) -> (Arc<AppState>, std::thread::JoinHandle<()>, Binding) {
    fixture_provider(native, None).await
}
#[cfg(windows)]
async fn fixture_provider(
    native: &NativeProcess,
    provider: Option<Arc<dyn jobs::StageIntentProvider>>,
) -> (Arc<AppState>, std::thread::JoinHandle<()>, Binding) {
    let data = native.root.join("data");
    let db = vmusic_store::open(&data).await.unwrap();
    let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
    state.data_dir = data;
    state.token = "pairing-official-fixture".into();
    if let Some(provider) = provider {
        state.ai_runtime = jobs::AiRuntime::with_test_provider(provider);
    }
    state
        .ai_runner_held
        .store(true, std::sync::atomic::Ordering::Relaxed);
    vmusic_store::settings::set(&state.db, "ai_generation_consent", &json!(true))
        .await
        .unwrap();
    let profile = hertz_desktop_ipc::Profile::Standalone {
        edition: crate::edition::NAME.into(),
        data_dir: state.data_dir.to_string_lossy().into_owned(),
    }
    .normalized()
    .unwrap();
    let identity = hertz_desktop_ipc::windows::Identity::current().unwrap();
    let b = Binding {
        protocol: 1,
        user_sid: identity.user_sid,
        windows_session_id: identity.windows_session_id,
        native_pid: native.child.id(),
        native_generation: hertz_desktop_ipc::windows::process_generation(native.child.id())
            .unwrap(),
        desktop_build_id: "a".repeat(64),
        edition: crate::edition::NAME.into(),
        profile_digest: pairing::profile_digest(profile.edition(), profile.data_dir()),
        service_pid: std::process::id(),
        server_instance_id: state.server_instance_id.clone(),
    };
    (Arc::new(state), audio, b)
}

#[cfg(windows)]
struct PausedProvider {
    pause: std::sync::atomic::AtomicBool,
    entered: std::sync::atomic::AtomicBool,
    release: std::sync::Mutex<bool>,
    wake: std::sync::Condvar,
    hold_execution: bool,
    started: Arc<tokio::sync::Notify>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}
#[cfg(windows)]
impl PausedProvider {
    fn new(hold_execution: bool) -> Arc<Self> {
        Arc::new(Self {
            pause: false.into(),
            entered: false.into(),
            release: false.into(),
            wake: std::sync::Condvar::new(),
            hold_execution,
            started: Arc::new(tokio::sync::Notify::new()),
            cancelled: Arc::new(false.into()),
        })
    }
    async fn wait_for_quote(&self) {
        let start = Instant::now();
        while !self.entered.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(start.elapsed() < Duration::from_secs(5));
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    fn release_quote(&self) {
        *self.release.lock().unwrap() = true;
        self.wake.notify_all();
    }
}
#[cfg(windows)]
impl jobs::StageIntentProvider for PausedProvider {
    fn id(&self) -> &'static str {
        "fake"
    }
    fn model(&self) -> &str {
        "fake-intent-v1"
    }
    fn ready(&self) -> bool {
        true
    }
    fn supports_wallpaper_builtin(&self) -> bool {
        true
    }
    fn quote(&self, _: &str) -> std::result::Result<crate::ai::usage::PriceQuote, String> {
        if self.pause.load(std::sync::atomic::Ordering::SeqCst) {
            self.entered
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let (_guard, timeout) = self
                .wake
                .wait_timeout_while(
                    self.release.lock().unwrap(),
                    Duration::from_secs(10),
                    |released| !*released,
                )
                .unwrap();
            if timeout.timed_out() {
                return Err("fixture admission not released".into());
            }
        }
        Ok(crate::ai::usage::PriceQuote::fake())
    }
    fn generate(
        &self,
        brief: String,
        pricing: crate::ai::usage::PricingSnapshot,
        credential: Option<crate::ai::credential::ProviderCredential>,
        cancel: jobs::ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = jobs::ProviderReply> + Send>> {
        jobs::StageIntentProvider::generate(&jobs::FakeProvider, brief, pricing, credential, cancel)
    }
    fn generate_wallpaper_builtin(
        &self,
        request: &hertz_wallpaper::generation::WallpaperGenerateRequest,
        pricing: crate::ai::usage::PricingSnapshot,
        credential: Option<crate::ai::credential::ProviderCredential>,
        mut cancel: jobs::ProviderCancellation,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = jobs::WallpaperReply> + Send>> {
        if !self.hold_execution {
            return jobs::StageIntentProvider::generate_wallpaper_builtin(
                &jobs::FakeProvider,
                request,
                pricing,
                credential,
                cancel,
            );
        }
        let started = self.started.clone();
        let cancelled = self.cancelled.clone();
        Box::pin(async move {
            started.notify_one();
            cancel.cancelled().await;
            cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
            jobs::WallpaperReply {
                output: Err("fixture cancellation observed".into()),
                usage: Some(crate::ai::usage::TrustedUsage::free()),
            }
        })
    }
}
#[cfg(windows)]
async fn quoted(state: &Arc<AppState>, principal: &str) -> (String, String) {
    let snapshot = jobs::wallpaper_capabilities(state).await.unwrap();
    let request = json!({"version":1,"requestId":"pairing-race-request","brief":"柔和夜色","output":{"kind":"builtin","sceneId":"coast"},
        "registryHash":snapshot.registry_hash,"generationSchemaHash":snapshot.generation_schema_hash,"capabilitySnapshotId":snapshot.snapshot_id});
    let quote = jobs::wallpaper_quote(state, principal, &serde_json::to_vec(&request).unwrap())
        .await
        .unwrap();
    (
        quote["quoteId"].as_str().unwrap().into(),
        format!(
            "v1.{}.{}",
            vmusic_store::now_ms(),
            uuid::Uuid::new_v4().simple()
        ),
    )
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn detached_admission_keeps_revocation_guard_after_observer_is_dropped() {
    let native = NativeProcess::start();
    let provider = PausedProvider::new(false);
    let (state, audio, b) = fixture_provider(&native, Some(provider.clone())).await;
    let grant = session(&state, b, &"a".repeat(64)).await;
    let (quote, key) = quoted(&state, &grant).await;
    let slot = state
        .ai_runtime
        .completion_slots()
        .acquire_owned()
        .await
        .unwrap();
    provider
        .pause
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let owner = state.clone();
    let principal = grant.clone();
    let submit_key = key.clone();
    let observer = tokio::spawn(async move {
        jobs::wallpaper_submit(
            &owner,
            &principal,
            &quote,
            "pairing-race-request",
            Some(&submit_key),
        )
        .await
    });
    provider.wait_for_quote().await;
    observer.abort();
    let _ = observer.await;
    let owner = state.clone();
    let principal = grant.clone();
    let mut revoke = tokio::spawn(async move { facade::revoke_grant(&owner, &principal).await });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut revoke)
            .await
            .is_err(),
        "revocation must wait for the owned admission"
    );
    provider.release_quote();
    revoke.await.unwrap().unwrap();
    let job =
        vmusic_store::ai_jobs::find_job_by_key(&state.db, &grant, jobs::WALLPAPER_CAPABILITY, &key)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(job.state, "cancelled");
    assert_eq!(job.dispatch_state, "not_dispatched");
    drop(slot);
    state.audio.shutdown();
    audio.join().unwrap();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn admission_rechecks_remaining_session_time_after_waiting() {
    let native = NativeProcess::start();
    let provider = PausedProvider::new(false);
    let (state, audio, b) = fixture_provider(&native, Some(provider.clone())).await;
    let grant = session(&state, b, &"a".repeat(64)).await;
    let (quote, key) = quoted(&state, &grant).await;
    provider
        .pause
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let owner = state.clone();
    let principal = grant.clone();
    let submit_key = key.clone();
    let observer = tokio::spawn(async move {
        jobs::wallpaper_submit(
            &owner,
            &principal,
            &quote,
            "pairing-race-request",
            Some(&submit_key),
        )
        .await
    });
    provider.wait_for_quote().await;
    state
        .ai_runtime
        .wallpaper_session_deadlines
        .lock()
        .await
        .insert(grant.clone(), Instant::now() + Duration::from_secs(89));
    provider.release_quote();
    assert_eq!(
        observer.await.unwrap().unwrap_err().code,
        "wallpaper_session_expiring"
    );
    assert!(vmusic_store::ai_jobs::find_job_by_key(
        &state.db,
        &grant,
        jobs::WALLPAPER_CAPABILITY,
        &key
    )
    .await
    .unwrap()
    .is_none());
    state.audio.shutdown();
    audio.join().unwrap();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn revoking_a_running_session_signals_the_actual_provider() {
    let native = NativeProcess::start();
    let provider = PausedProvider::new(true);
    let (state, audio, b) = fixture_provider(&native, Some(provider.clone())).await;
    let grant = session(&state, b, &"a".repeat(64)).await;
    let (quote, key) = quoted(&state, &grant).await;
    let outcome =
        jobs::wallpaper_submit(&state, &grant, &quote, "pairing-race-request", Some(&key))
            .await
            .unwrap();
    let jobs::SubmitOutcome::Accepted { job } = outcome else {
        panic!("new task expected")
    };
    tokio::time::timeout(Duration::from_secs(5), provider.started.notified())
        .await
        .unwrap();
    let running = jobs::get_job(&state, &grant, &job.job_id).await.unwrap();
    assert!(running.state_revision > job.state_revision);
    facade::revoke_grant(&state, &grant).await.unwrap();
    let start = Instant::now();
    while !provider.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(start.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        jobs::get_job(&state, &grant, &job.job_id)
            .await
            .unwrap()
            .state,
        "cancelled"
    );
    state.audio.shutdown();
    audio.join().unwrap();
}
#[cfg(windows)]
async fn session(state: &Arc<AppState>, b: Binding, token: &str) -> String {
    let owner = vmusic_store::ai::get_or_create_instance(&state.db)
        .await
        .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let digest: String = Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    vmusic_store::ai::insert_session_grant(
        &state.db,
        &id,
        &digest,
        &serde_json::to_string(pairing::SCOPES).unwrap(),
        &serde_json::to_string(&Session {
            binding: b,
            owner_instance_id: owner.owner_instance_id,
            expires_at: vmusic_store::now_ms() + pairing::SESSION_MS,
        })
        .unwrap(),
    )
    .await
    .unwrap();
    state
        .ai_runtime
        .wallpaper_session_deadlines
        .lock()
        .await
        .insert(
            id.clone(),
            Instant::now() + Duration::from_millis(pairing::SESSION_MS as u64),
        );
    id
}
#[cfg(windows)]
async fn call(
    state: &Arc<AppState>,
    token: &str,
    path: &str,
    method: &str,
    body: Value,
) -> reqwest::Response {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = routes::router(state.clone()).with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let result = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
            format!("http://{address}{path}"),
        )
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap();
    server.abort();
    result
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_session_digest_scope_revocation_restart_and_ttl() {
    let native = NativeProcess::start();
    let (state, audio, b) = fixture(&native).await;
    let token = "d".repeat(64);
    let id = session(&state, b.clone(), &token).await;
    assert!(facade::authenticate_wallpaper(&state, &token).await.is_ok());
    assert_eq!(
        facade::authenticate(&state, &token).await.unwrap_err().code,
        "unauthorized"
    );
    let row = vmusic_store::ai::find_grant_by_id(&state.db, &id)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(row.credential_digest, token);
    assert!(!state
        .data_dir
        .join("ai/grants")
        .join(format!("{id}.key"))
        .exists());
    for path in [
        "/v1/player/pause",
        "/v1/ai/provider-credential",
        "/v1/ai/grants",
        "/v1/ai/capabilities/context",
    ] {
        assert!(
            !call(
                &state,
                &token,
                path,
                if path.ends_with("pause") {
                    "POST"
                } else {
                    "GET"
                },
                json!({})
            )
            .await
            .status()
            .is_success(),
            "{path}"
        );
    }
    assert!(call(
        &state,
        &token,
        "/v1/ai/wallpaper/capabilities",
        "GET",
        json!({})
    )
    .await
    .status()
    .is_success());
    state
        .ai_runtime
        .wallpaper_session_deadlines
        .lock()
        .await
        .insert(id.clone(), Instant::now() + Duration::from_secs(10));
    assert_eq!(
        require_time(&state, &id).await.unwrap_err().code,
        "wallpaper_session_expiring"
    );
    state
        .ai_runtime
        .wallpaper_session_deadlines
        .lock()
        .await
        .insert(id.clone(), Instant::now() - Duration::from_secs(1));
    assert_eq!(
        facade::authenticate_wallpaper(&state, &token)
            .await
            .unwrap_err()
            .code,
        "wallpaper_session_expired"
    );
    state
        .ai_runtime
        .wallpaper_session_deadlines
        .lock()
        .await
        .clear();
    assert_eq!(
        facade::authenticate_wallpaper(&state, &token)
            .await
            .unwrap_err()
            .code,
        "wallpaper_session_expired"
    );
    let token2 = "e".repeat(64);
    let id2 = session(&state, b.clone(), &token2).await;
    let mut wrong = b;
    wrong.server_instance_id = "old-instance".into();
    let token3 = "f".repeat(64);
    session(&state, wrong, &token3).await;
    assert_eq!(
        facade::authenticate_wallpaper(&state, &token3)
            .await
            .unwrap_err()
            .code,
        "wallpaper_session_expired"
    );
    facade::revoke_grant(&state, &id2).await.unwrap();
    assert_eq!(
        facade::authenticate_wallpaper(&state, &token2)
            .await
            .unwrap_err()
            .code,
        "grant_revoked"
    );
    assert!(!state
        .ai_runtime
        .wallpaper_session_deadlines
        .lock()
        .await
        .contains_key(&id2));
    state.audio.shutdown();
    audio.join().unwrap();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_quotes_jobs_and_cancellation_do_not_cross_principals() {
    let native = NativeProcess::start();
    let (state, audio, b) = fixture(&native).await;
    let first = session(&state, b.clone(), &"a".repeat(64)).await;
    let second = session(&state, b, &"b".repeat(64)).await;
    let snapshot = jobs::wallpaper_capabilities(&state).await.unwrap();
    let request = json!({"version":1,"requestId":"pairing-request","brief":"安静频谱","output":{"kind":"builtin","sceneId":"coast"},
        "registryHash":snapshot.registry_hash,"generationSchemaHash":snapshot.generation_schema_hash,"capabilitySnapshotId":snapshot.snapshot_id});
    let quote = jobs::wallpaper_quote(&state, &first, &serde_json::to_vec(&request).unwrap())
        .await
        .unwrap();
    let quote_id = quote["quoteId"].as_str().unwrap();
    let key = format!(
        "v1.{}.{}",
        vmusic_store::now_ms(),
        uuid::Uuid::new_v4().simple()
    );
    assert!(
        jobs::wallpaper_submit(&state, &second, quote_id, "pairing-request", Some(&key))
            .await
            .is_err()
    );
    let slot = state
        .ai_runtime
        .completion_slots()
        .acquire_owned()
        .await
        .unwrap();
    let outcome = jobs::wallpaper_submit(&state, &first, quote_id, "pairing-request", Some(&key))
        .await
        .unwrap();
    let value = serde_json::to_value(outcome).unwrap();
    let job_id = value["job"]["jobId"]
        .as_str()
        .or_else(|| value["jobId"].as_str())
        .expect("job ID");
    assert!(jobs::get_job(&state, &second, job_id).await.is_err());
    facade::revoke_grant(&state, &first).await.unwrap();
    assert_eq!(
        jobs::get_job(&state, &first, job_id).await.unwrap().state,
        "cancelled"
    );
    assert!(
        jobs::wallpaper_submit(&state, &first, quote_id, "pairing-request", Some(&key))
            .await
            .is_err()
    );
    drop(slot);
    state.audio.shutdown();
    audio.join().unwrap();
}
