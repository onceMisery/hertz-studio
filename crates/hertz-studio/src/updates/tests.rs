// SPDX-License-Identifier: MIT
use super::*;
use release::{allowed_url, parse_checksum, select, GithubRelease};

fn context(distribution: Distribution, edition: &str, target: &str) -> Context {
    Context {
        version: "0.3.7".into(),
        edition: edition.into(),
        distribution,
        target: target.into(),
        install_kind: None,
    }
}

// Public download gates candidates on being newer than the running build, so
// fixtures that go through it must track version bumps instead of hardcoding.
fn future_version() -> String {
    let mut parts = env!("CARGO_PKG_VERSION")
        .split('.')
        .map(|part| part.parse::<u64>().unwrap());
    let (major, minor, patch) = (
        parts.next().unwrap(),
        parts.next().unwrap(),
        parts.next().unwrap(),
    );
    format!("{major}.{minor}.{}", patch + 1)
}

fn release(tag: &str, names: &[&str]) -> GithubRelease {
    serde_json::from_value(serde_json::json!({
        "tag_name": tag, "name": "Hertz Studio", "body": "更新说明", "draft": false, "prerelease": false,
        "assets": names.iter().map(|name| serde_json::json!({
            "name": name, "size": 10,
            "browser_download_url": format!("{}/releases/download/{tag}/{name}", release::REPOSITORY),
            "digest": format!("sha256:{}", "a".repeat(64)),
        })).collect::<Vec<_>>(),
    })).unwrap()
}

#[test]
fn versions_compare_numbers_and_stable_supersedes_preview() {
    assert!(Version::stable("0.10.0") > Version::stable("0.9.99"));
    assert!(Version::stable("0.3.7") > Version::parse("0.3.7-preview.2"));
    assert!(Version::stable("1.0.0") > Version::parse("0.99.99"));
    for text in [
        "01.2.3",
        "1.2",
        "1.2.3.4",
        "1.2.3-",
        "1.2.3-preview.01",
        "1.2.3+",
        "1.2.3 ",
        "999999999999999999999999.0.0",
    ] {
        assert_eq!(Version::parse(text), None, "{text}");
    }
    assert_eq!(Version::stable("0.3.8-preview"), None);
    assert_eq!(Version::stable("0.3.8+build"), None);
}

#[test]
fn standalone_ignores_the_more_recent_plugin_and_prerelease_tags() {
    let context = context(Distribution::Standalone, "full", "x86_64-pc-windows-msvc");
    // A tag's numeric shape alone cannot make a prerelease eligible.
    let preview = serde_json::from_value(serde_json::json!({"tag_name":"hertz-studio-v99.0.0","draft":false,"prerelease":true,"assets":[],"name":null,"body":null})).unwrap();
    let candidate = select(
        vec![
            release("hertz-plugin-full-v100.0.0", &[]),
            preview,
            release(
                "hertz-studio-v0.9.0",
                &["hertz-studio-0.9.0-x86_64-pc-windows-msvc.zip"],
            ),
            release(
                "hertz-studio-v0.10.0",
                &["hertz-studio-0.10.0-x86_64-pc-windows-msvc.zip"],
            ),
        ],
        &context,
    )
    .unwrap()
    .unwrap();
    assert_eq!(candidate.view.version, "0.10.0");
    assert!(candidate.asset.unwrap().name.ends_with(".zip"));
}

#[test]
fn plugin_edition_and_architecture_match_their_own_asset() {
    let standard = context(Distribution::Plugin, "standard", "aarch64-apple-darwin");
    let candidate = select(
        vec![
            release("hertz-plugin-full-v2.0.0", &[]),
            release(
                "hertz-plugin-standard-v0.3.8",
                &[
                    "io.github.oncemisery.hertz-studio-0.3.8-darwin-x64.dbxp",
                    "io.github.oncemisery.hertz-studio-0.3.8-darwin-arm64.dbxp",
                ],
            ),
        ],
        &standard,
    )
    .unwrap()
    .unwrap();
    assert_eq!(candidate.view.version, "0.3.8");
    assert!(candidate.asset.unwrap().name.ends_with("darwin-arm64.dbxp"));
    let full = context(Distribution::Plugin, "full", "x86_64-pc-windows-msvc");
    assert!(
        select(vec![release("hertz-plugin-standard-v0.3.8", &[])], &full)
            .unwrap()
            .is_none()
    );
}

#[test]
fn installation_kind_and_historical_full_names_are_supported() {
    let mut context = context(Distribution::Standalone, "full", "x86_64-pc-windows-msvc");
    context.install_kind = Some(InstallKind::Installer);
    let candidate = select(
        vec![release(
            "hertz-studio-v0.3.4",
            &[
                "hertz-studio-full-0.3.4-x86_64-pc-windows-msvc.zip",
                "hertz-studio-full-0.3.4-x86_64-pc-windows-msvc-setup.exe",
            ],
        )],
        &context,
    )
    .unwrap()
    .unwrap();
    assert!(candidate.asset.unwrap().name.ends_with("-setup.exe"));
}

#[test]
fn missing_or_unsafe_latest_asset_is_not_reported_as_an_older_current_release() {
    let context = context(Distribution::Standalone, "full", "x86_64-pc-windows-msvc");
    let candidate = select(
        vec![
            release(
                "hertz-studio-v0.3.7",
                &["hertz-studio-0.3.7-x86_64-pc-windows-msvc.zip"],
            ),
            release(
                "hertz-studio-v0.3.8",
                &["hertz-studio-0.3.8-aarch64-apple-darwin.tar.gz"],
            ),
        ],
        &context,
    )
    .unwrap()
    .unwrap();
    assert_eq!(candidate.view.version, "0.3.8");
    assert!(candidate.asset.is_none());
    let malicious: GithubRelease = serde_json::from_value(serde_json::json!({
        "tag_name":"hertz-studio-v0.3.8","name":null,"body":null,"draft":false,"prerelease":false,
        "assets":[{"name":"hertz-studio-0.3.8-x86_64-pc-windows-msvc.zip","size":10,"browser_download_url":"https://example.com/evil.zip","digest":null}],
    })).unwrap();
    assert!(select(vec![malicious], &context)
        .unwrap()
        .unwrap()
        .asset
        .is_none());
}

#[test]
fn duplicate_platform_packages_fail_instead_of_choosing_arbitrarily() {
    let context = context(Distribution::Standalone, "full", "x86_64-pc-windows-msvc");
    let result = select(
        vec![release(
            "hertz-studio-v0.3.8",
            &[
                "hertz-studio-0.3.8-x86_64-pc-windows-msvc.zip",
                "hertz-studio-full-0.3.8-x86_64-pc-windows-msvc.zip",
            ],
        )],
        &context,
    );
    assert_eq!(result.unwrap_err().code, "update_feed_invalid");
}

#[test]
fn checksum_is_bound_to_one_exact_filename() {
    let hash = "ab".repeat(32);
    let text = format!("{}  another.zip\n{hash} *player.zip\n", "cd".repeat(32));
    assert_eq!(parse_checksum(&text, "player.zip").unwrap(), hash);
    assert!(parse_checksum(&text, "layer.zip").is_err());
    assert!(parse_checksum(
        &format!("{hash} player.zip\n{hash} player.zip"),
        "player.zip"
    )
    .is_err());
    assert!(parse_checksum("abc player.zip", "player.zip").is_err());
}

#[test]
fn redirect_policy_rejects_credentials_ports_http_and_lookalike_domains() {
    for url in [
        "https://api.github.com/repos/onceMisery/hertz-studio/releases",
        "https://release-assets.githubusercontent.com/github-production-release-asset/file",
    ] {
        assert!(allowed_url(&url.parse().unwrap()), "{url}");
    }
    for url in [
        "http://github.com/file",
        "https://github.com.evil.test/file",
        "https://github.com:8443/file",
        "https://user:password@github.com/file",
        "https://127.0.0.1/file",
        "file:///C:/file",
    ] {
        assert!(!allowed_url(&url.parse().unwrap()), "{url}");
    }
}

#[test]
fn cancelled_or_superseded_checks_cannot_publish_a_late_result() {
    let updates = Updates::default();
    {
        let mut inner = updates.lock();
        inner.operation_id = Some("cancelled".into());
        inner.phase = Phase::Cancelled;
    }
    updates.finish("cancelled", Ok(None), "0.3.7");
    assert_eq!(updates.lock().phase, Phase::Cancelled);
    {
        let mut inner = updates.lock();
        inner.operation_id = Some("new".into());
        inner.phase = Phase::Checking;
    }
    updates.finish("old", Err(Failure::new("test", "late")), "0.3.7");
    assert_eq!(updates.lock().phase, Phase::Checking);
    assert!(updates.lock().error.is_none());
}

#[tokio::test]
async fn local_status_and_disabled_startup_check_do_not_create_a_network_client() {
    let db = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)")
        .execute(&db)
        .await
        .unwrap();
    let (state, audio) = crate::state::tests::playback_state_with_db(db).await;
    let state = Arc::new(state);
    assert_eq!(status(&state).await.unwrap().phase, Phase::Idle);
    assert!(!status(&state).await.unwrap().check_on_startup);
    assert_eq!(check(&state, true).await.unwrap().phase, Phase::Idle);
    assert!(state.updates.client.get().is_none());
    assert!(download(&state).await.is_err());
    state.shutdown().await;
    audio.join().unwrap();
    state.db.close().await;
}

#[tokio::test]
async fn persisted_startup_frequency_prevents_another_external_check() {
    let db = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)")
        .execute(&db)
        .await
        .unwrap();
    let (state, audio) = crate::state::tests::playback_state_with_db(db).await;
    let state = Arc::new(state);
    preferences(
        &state,
        Preferences {
            check_on_startup: true,
        },
    )
    .await
    .unwrap();
    vmusic_store::settings::set(&state.db, LAST_AUTO_CHECK_KEY, &serde_json::json!(now_ms()))
        .await
        .unwrap();
    let snapshot = check(&state, true).await.unwrap();
    assert_eq!(snapshot.phase, Phase::Idle);
    assert!(snapshot.check_on_startup);
    assert!(state.updates.client.get().is_none());
    state.shutdown().await;
    audio.join().unwrap();
    state.db.close().await;
}

#[tokio::test]
async fn runtime_distribution_does_not_depend_on_desktop_features() {
    let db = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)")
        .execute(&db)
        .await
        .unwrap();
    let (state, audio) = crate::state::tests::playback_state_with_db(db).await;
    let state = Arc::new(state);
    assert_eq!(
        status(&state).await.unwrap().distribution,
        Distribution::Plugin
    );
    assert_eq!(
        state.updates.context(&state).distribution,
        Distribution::Plugin
    );
    state.set_update_restart_port(43217);
    assert_eq!(
        status(&state).await.unwrap().distribution,
        Distribution::Standalone
    );
    assert_eq!(
        state.updates.context(&state).distribution,
        Distribution::Standalone
    );
    assert!(state.updates.client.get().is_none());
    state.shutdown().await;
    audio.join().unwrap();
    state.db.close().await;
}

#[tokio::test]
async fn cancelled_startup_check_recovers_when_throttle_write_fails() {
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    let directory =
        std::env::temp_dir().join(format!("hertz-update-settings-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let db = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(directory.join("settings.db"))
                .create_if_missing(true)
                .journal_mode(SqliteJournalMode::Wal)
                .busy_timeout(Duration::from_secs(5)),
        )
        .await
        .unwrap();
    sqlx::query("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)")
        .execute(&db)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER reject_throttle BEFORE INSERT ON settings WHEN NEW.key = 'updates_last_auto_check_ms' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END")
        .execute(&db).await.unwrap();
    let (state, audio) = crate::state::tests::playback_state_with_db(db).await;
    let state = Arc::new(state);
    preferences(
        &state,
        Preferences {
            check_on_startup: true,
        },
    )
    .await
    .unwrap();

    // WAL permits cancel's status read while this transaction holds the write lock.
    // Once released, the trigger fails the pending write before any network worker exists.
    let mut blocker = state.db.begin().await.unwrap();
    sqlx::query("INSERT INTO settings VALUES ('held', 'true', 0)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let checking_state = state.clone();
    let checking = tokio::spawn(async move { check(&checking_state, true).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.updates.lock().phase != Phase::Checking {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(cancel(&state).await.unwrap().phase, Phase::Cancelling);
    blocker.rollback().await.unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), checking)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert_eq!(status(&state).await.unwrap().phase, Phase::Cancelled);
    assert!(
        check(&state, true).await.is_err(),
        "a new check must be admitted after cancellation cleanup"
    );
    assert_eq!(status(&state).await.unwrap().phase, Phase::Failed);
    assert!(state.updates.client.get().is_none());
    state.shutdown().await;
    audio.join().unwrap();
    state.db.close().await;
    for entry in std::fs::read_dir(&directory).unwrap() {
        let entry = entry.unwrap();
        assert!(entry.file_type().unwrap().is_file());
        crate::state::tests::remove_file_settled(entry.path()).await;
    }
    crate::state::tests::remove_dir_settled(directory).await;
}

async fn response_fixture(data: Vec<u8>, chunked: bool) -> (String, tokio::task::JoinHandle<()>) {
    let app = axum::Router::new().route(
        "/file",
        axum::routing::get(move || {
            let data = data.clone();
            async move {
                if chunked {
                    axum::body::Body::from_stream(futures::stream::iter(
                        data.chunks(3)
                            .map(|chunk| Ok::<_, std::io::Error>(chunk.to_vec()))
                            .collect::<Vec<_>>(),
                    ))
                } else {
                    axum::body::Body::from(data)
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/file", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, server)
}

#[tokio::test]
async fn feed_size_limit_covers_both_declared_and_chunked_responses() {
    for chunked in [false, true] {
        let (url, server) = response_fixture(vec![b'x'; 48], chunked).await;
        let result = limited_get(&reqwest::Client::new(), &url, 24).await;
        assert_eq!(result.unwrap_err().code, "update_response_too_large");
        server.abort();
    }
}

#[tokio::test]
async fn downloaded_bytes_are_verified_before_preparing_an_install() {
    let directory =
        std::env::temp_dir().join(format!("hertz-update-download-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let data = directory.join("data");
    let install = directory.join("installation");
    std::fs::create_dir(&data).unwrap();
    std::fs::create_dir(&install).unwrap();
    let content = b"controlled package bytes".to_vec();
    let checksum = format!("{:x}", Sha256::digest(&content));
    let (url, server) = response_fixture(content.clone(), true).await;
    let installation = windows::Installation {
        directory: install,
        kind: InstallKind::Portable,
    };
    let updates = Updates::default();
    // Only a test can inject a loopback client/fixture asset; public discovery is pinned to GitHub.
    updates.client.set(Ok(reqwest::Client::new())).unwrap();
    for (valid, expected_size) in [
        (true, content.len() as u64),
        (false, content.len() as u64),
        (true, content.len() as u64 + 1),
    ] {
        let operation = uuid::Uuid::new_v4().to_string();
        let stage = windows::create_stage(&data, &installation, &operation).unwrap();
        {
            let mut inner = updates.lock();
            inner.operation_id = Some(operation.clone());
            inner.phase = Phase::Downloading;
        }
        let candidate = Candidate {
            view: ReleaseView {
                version: "0.3.8".into(),
                title: "Fixture".into(),
                notes: "".into(),
                release_url: "".into(),
                download_url: Some(url.clone()),
                file_name: Some("package.zip".into()),
                size: Some(expected_size),
            },
            asset: Some(release::Asset {
                name: "package.zip".into(),
                url: url.clone(),
                size: expected_size,
                sha256: Some(if valid {
                    checksum.clone()
                } else {
                    "0".repeat(64)
                }),
                checksum_url: None,
            }),
        };
        let result = download_candidate(
            &updates,
            &operation,
            &candidate,
            &installation,
            &data,
            &stage,
        )
        .await;
        if valid && expected_size == content.len() as u64 {
            let prepared = result.unwrap();
            assert_eq!(std::fs::read(stage.join("package.zip")).unwrap(), content);
            assert!(stage.join("Apply-Hertz-Update.ps1").is_file());
            assert!(!stage.join("download.part").exists());
            assert_eq!(updates.lock().downloaded_bytes, content.len() as u64);
            assert_eq!(prepared.directory, stage);
        } else {
            assert!(result.is_err());
            assert!(!stage.join("package.zip").exists());
            assert!(!stage.join("Apply-Hertz-Update.ps1").exists());
        }
        windows::remove_stage(&stage, &data);
        assert!(!stage.exists());
    }
    server.abort();
    std::fs::remove_dir(data.join("cache/updates")).unwrap();
    std::fs::remove_dir(data.join("cache")).unwrap();
    std::fs::remove_dir(&data).unwrap();
    std::fs::remove_dir(directory.join("installation")).unwrap();
    std::fs::remove_dir(directory).unwrap();
}

#[tokio::test]
async fn http_and_rpc_share_preferences_and_cannot_install_programs() {
    use crate::rpc::{Call, Op, Rpc};
    let db = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)")
        .execute(&db)
        .await
        .unwrap();
    let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
    state.token = "update-fixture-token".into();
    let state = Arc::new(state);
    let app = crate::routes::router(state.clone()).with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = reqwest::Client::new();
    assert_eq!(
        client
            .get(format!("{base}/v1/system/updates"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let response = client
        .get(format!("{base}/v1/system/updates"))
        .bearer_auth(&state.token)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let http: serde_json::Value = response.json().await.unwrap();
    let rpc = Rpc::new(state.clone());
    let call = |op, path, body| Call {
        op,
        path,
        body,
        query: serde_json::json!({}),
        raw: None,
        client_operation_id: None,
    };
    let reply = rpc
        .call(call(Op::Get, "/v1/system/updates", serde_json::json!({})))
        .await
        .unwrap();
    assert_eq!(http, reply.body);
    let response = client
        .put(format!("{base}/v1/system/updates/settings"))
        .bearer_auth(&state.token)
        .json(&serde_json::json!({"checkOnStartup":true}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let reply = rpc
        .call(call(Op::Get, "/v1/system/updates", serde_json::json!({})))
        .await
        .unwrap();
    assert_eq!(reply.body["checkOnStartup"], true);
    let reply = rpc
        .call(call(
            Op::Put,
            "/v1/system/updates/settings",
            serde_json::json!({"checkOnStartup":false}),
        ))
        .await
        .unwrap();
    assert_eq!(reply.body["checkOnStartup"], false);
    assert!(rpc
        .call(call(
            Op::Put,
            "/v1/system/updates/settings",
            serde_json::json!({"checkOnStartup":true,"path":"C:/wrong"})
        ))
        .await
        .is_err());
    let absent = client
        .post(format!("{base}/v1/system/updates/install"))
        .bearer_auth(&state.token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .status();
    // Existing narrow-route middleware rejects unmatched HTTP paths as well.
    assert!(absent.is_client_error());
    assert_eq!(
        rpc.call(call(
            Op::Post,
            "/v1/system/updates/install",
            serde_json::json!({})
        ))
        .await
        .err()
        .unwrap()
        .code,
        "not_found"
    );
    assert_eq!(
        client
            .post(format!("{base}/v1/system/updates/download"))
            .bearer_auth(&state.token)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    assert!(state.updates.client.get().is_none());
    server.abort();
    state.shutdown().await;
    audio.join().unwrap();
    state.db.close().await;
}

async fn install_fixture() -> (
    Arc<AppState>,
    std::thread::JoinHandle<()>,
    std::path::PathBuf,
) {
    let root = std::env::temp_dir().join(format!("hertz-update-handoff-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let db = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::query("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)")
        .execute(&db)
        .await
        .unwrap();
    let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
    state.data_dir = root.join("data");
    std::fs::create_dir(&state.data_dir).unwrap();
    std::fs::create_dir(root.join("install")).unwrap();
    (Arc::new(state), audio, root)
}

fn ready_handoff(
    state: &AppState,
    root: &std::path::Path,
) -> (String, std::path::PathBuf, std::path::PathBuf) {
    let operation = uuid::Uuid::new_v4().to_string();
    let installation = windows::Installation {
        directory: root.join("install"),
        kind: InstallKind::Portable,
    };
    let stage = windows::create_stage(&state.data_dir, &installation, &operation).unwrap();
    let package = stage.join("package.zip");
    std::fs::write(&package, b"fixture").unwrap();
    let prepared = windows::prepare(
        &state.data_dir,
        &stage,
        package,
        "a".repeat(64),
        "0.3.8".into(),
        installation,
    )
    .unwrap();
    let token = uuid::Uuid::new_v4().to_string();
    let handoff = stage.join(format!("handoff-{token}"));
    std::fs::create_dir(&handoff).unwrap();
    std::fs::write(
        handoff.join("ready.json"),
        serde_json::to_vec(&serde_json::json!({"token":token})).unwrap(),
    )
    .unwrap();
    let mut inner = state.updates.lock();
    inner.phase = Phase::Installing;
    inner.operation_id = Some(operation.clone());
    inner.prepared = Some(prepared);
    inner.handoff = Some(windows::test_handoff(
        handoff.clone(),
        state.data_dir.clone(),
        token,
    ));
    (operation, stage, handoff)
}

async fn finish_install_fixture(
    state: Arc<AppState>,
    audio: std::thread::JoinHandle<()>,
    root: std::path::PathBuf,
) {
    state.shutdown().await;
    audio.join().unwrap();
    state.db.close().await;
    if let Some(prepared) = state.updates.lock().prepared.as_ref() {
        if prepared.directory.exists() {
            windows::remove_stage(&prepared.directory, &state.data_dir);
        }
    }
    for cache in [
        state.data_dir.join("cache/updates"),
        state.data_dir.join("cache"),
    ] {
        if cache.exists() {
            std::fs::remove_dir(cache).unwrap();
        }
    }
    std::fs::remove_dir(&state.data_dir).unwrap();
    std::fs::remove_dir(root.join("install")).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[tokio::test]
async fn shutdown_rejects_new_operations_and_unpolled_downloads_write_nothing() {
    for accept_before_shutdown in [false, true] {
        let (state, audio, root) = install_fixture().await;
        crate::window_lifecycle::WindowLifecycle::install(&state).await;
        state
            .updates
            .installation
            .set(Ok(windows::Installation {
                directory: root.join("install"),
                kind: InstallKind::Portable,
            }))
            .unwrap();
        {
            let mut inner = state.updates.lock();
            inner.phase = Phase::Available;
            let version = future_version();
            let archive = format!("hertz-studio-{version}-x86_64-pc-windows-msvc.zip");
            inner.candidate = select(
                vec![release(&format!("hertz-studio-v{version}"), &[&archive])],
                &context(Distribution::Standalone, "full", "x86_64-pc-windows-msvc"),
            )
            .unwrap();
        }
        if accept_before_shutdown {
            assert_eq!(download(&state).await.unwrap().phase, Phase::Downloading);
        }
        // This current-thread test closes admission before the spawned worker can poll.
        state.updates.shutdown();
        assert_eq!(
            check(&state, false).await.unwrap_err().code,
            "update_shutdown"
        );
        assert_eq!(download(&state).await.unwrap_err().code, "update_shutdown");
        assert_eq!(
            state
                .updates
                .arm_install(&state, "late-install")
                .unwrap_err()
                .code,
            "update_shutdown"
        );
        if accept_before_shutdown {
            tokio::time::timeout(Duration::from_secs(2), async {
                while state.updates.lock().phase != Phase::Cancelled {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
        assert!(state.updates.client.get().is_none());
        assert!(!state.data_dir.join("cache").exists());
        assert!(state.updates.lock().prepared.is_none());
        finish_install_fixture(state, audio, root).await;
    }
}

#[tokio::test]
async fn cancelled_exit_or_invalidated_document_disarms_installation() {
    use crate::window_lifecycle::{Phase as WindowPhase, WindowLifecycle};
    let (state, audio, root) = install_fixture().await;
    let lifecycle = WindowLifecycle::install(&state).await;
    for invalidate_document in [false, true] {
        let (operation, stage, handoff) = ready_handoff(&state, &root);
        state
            .updates
            .begin_install_exit(&operation, &lifecycle)
            .await;
        let pending = lifecycle.snapshot();
        assert_eq!(pending.phase, WindowPhase::Pending);
        assert_eq!(
            pending.source,
            Some(crate::window_lifecycle::QuitSource::Update)
        );
        if invalidate_document {
            lifecycle.cancel_update_install();
        } else {
            lifecycle.confirm(pending.request_id.as_deref().unwrap(), false);
        }
        assert_eq!(lifecycle.snapshot().phase, WindowPhase::Cancelled);
        assert_eq!(state.updates.lock().phase, Phase::Ready);
        assert!(handoff.join("cancel").is_file());
        state.updates.commit_exit(&state);
        assert!(
            !stage.exists(),
            "unapproved downloads are cleaned on ordinary shutdown"
        );
    }
    finish_install_fixture(state, audio, root).await;
}

#[tokio::test]
async fn installation_does_not_adopt_another_pending_quit() {
    use crate::window_lifecycle::{QuitSource, WindowLifecycle};
    let (state, audio, root) = install_fixture().await;
    let lifecycle = WindowLifecycle::install(&state).await;
    let ordinary = lifecycle.request_exit(QuitSource::Toolbar);
    let (operation, _, handoff) = ready_handoff(&state, &root);
    state
        .updates
        .begin_install_exit(&operation, &lifecycle)
        .await;
    assert_eq!(lifecycle.snapshot().request_id, ordinary.request_id);
    assert_eq!(lifecycle.snapshot().source, Some(QuitSource::Toolbar));
    assert_eq!(
        state.updates.lock().error.as_ref().unwrap().code,
        "update_exit_busy"
    );
    assert!(handoff.join("cancel").is_file());
    assert!(!handoff.join("apply.json").exists());
    lifecycle.confirm(ordinary.request_id.as_deref().unwrap(), false);
    finish_install_fixture(state, audio, root).await;
}

#[tokio::test]
async fn missing_helper_readiness_prevents_confirmed_exit() {
    use crate::window_lifecycle::{Phase as WindowPhase, WindowLifecycle};
    let (state, audio, root) = install_fixture().await;
    let lifecycle = WindowLifecycle::install(&state).await;
    let (operation, _, handoff) = ready_handoff(&state, &root);
    state
        .updates
        .begin_install_exit(&operation, &lifecycle)
        .await;
    std::fs::remove_file(handoff.join("ready.json")).unwrap();
    let pending = lifecycle.snapshot();
    assert_eq!(
        lifecycle
            .confirm(pending.request_id.as_deref().unwrap(), true)
            .phase,
        WindowPhase::Failed
    );
    assert!(!*state.exiting.borrow());
    assert_eq!(state.updates.lock().phase, Phase::Ready);
    assert_eq!(
        state.updates.lock().error.as_ref().unwrap().code,
        "update_helper_unavailable"
    );
    assert!(handoff.join("cancel").is_file());
    assert!(!handoff.join("apply.json").exists());
    finish_install_fixture(state, audio, root).await;
}

#[tokio::test]
async fn only_the_exact_approved_quit_commits_the_update() {
    use crate::window_lifecycle::{Phase as WindowPhase, WindowLifecycle};
    let (state, audio, root) = install_fixture().await;
    let lifecycle = WindowLifecycle::install(&state).await;
    let (operation, _, handoff) = ready_handoff(&state, &root);
    state
        .updates
        .begin_install_exit(&operation, &lifecycle)
        .await;
    let pending = lifecycle.snapshot();
    assert_eq!(
        lifecycle.confirm("another-quit", true).phase,
        WindowPhase::Pending
    );
    assert!(!handoff.join("apply.json").exists());
    assert_eq!(
        lifecycle
            .confirm(pending.request_id.as_deref().unwrap(), true)
            .phase,
        WindowPhase::Exiting
    );
    assert!(
        !handoff.join("apply.json").exists(),
        "approval alone cannot replace files before normal shutdown"
    );
    state.updates.commit_exit(&state);
    let ready: serde_json::Value =
        serde_json::from_slice(&std::fs::read(handoff.join("ready.json")).unwrap()).unwrap();
    let approval: serde_json::Value =
        serde_json::from_slice(&std::fs::read(handoff.join("apply.json")).unwrap()).unwrap();
    assert_eq!(approval["token"], ready["token"]);
    finish_install_fixture(state, audio, root).await;
}

#[cfg(unix)]
#[test]
fn links_are_rejected_inside_the_data_directory_but_not_above_it() {
    use std::os::unix::fs::symlink;
    let root = std::env::temp_dir().join(format!("hertz-update-links-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(root.join("real")).unwrap();
    // macOS temp dirs live under the symlinked /var; a user-chosen data dir may
    // sit behind an alias too. Only components this process owns are checked.
    symlink(root.join("real"), root.join("alias")).unwrap();
    let data = root.join("alias/data");
    std::fs::create_dir(&data).unwrap();
    std::fs::create_dir(root.join("install")).unwrap();
    let installation = windows::Installation {
        directory: root.join("install"),
        kind: InstallKind::Portable,
    };
    let stage =
        windows::create_stage(&data, &installation, &uuid::Uuid::new_v4().to_string()).unwrap();
    assert!(stage.is_dir());

    std::fs::remove_dir_all(data.join("cache")).unwrap();
    symlink(root.join("install"), data.join("cache")).unwrap();
    let error =
        windows::create_stage(&data, &installation, &uuid::Uuid::new_v4().to_string()).unwrap_err();
    assert_eq!(error.code, "update_filesystem_failed");

    std::fs::remove_dir_all(&root).unwrap();
}
