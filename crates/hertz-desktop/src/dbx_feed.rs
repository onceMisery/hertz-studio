// SPDX-License-Identifier: MIT
//! Selected-source DBX reader. One contained runtime owns two snapshot operations and
//! one independent document operation. Cancellation always reaches the actual pipe I/O.
use crate::{
    app::UserEvent,
    feed::{Document, Snapshot},
    wallpaper_feed,
};
use hertz_desktop_ipc::{
    windows::{self, Cancellation},
    Discovery, Profile, Request, Scope,
};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tao::event_loop::EventLoopProxy;
use tokio::{
    sync::{mpsc, watch},
    task::JoinSet,
    time::{interval, MissedTickBehavior},
};

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Needs {
    pub lyrics: bool,
    pub wallpaper: bool,
}
pub(crate) struct Controller {
    cancel: Cancellation,
    needs: watch::Sender<Needs>,
    retry: mpsc::UnboundedSender<()>,
}
impl Controller {
    pub(crate) fn start(
        profile: Profile,
        generation: u64,
        proxy: EventLoopProxy<UserEvent>,
    ) -> Self {
        let cancel = Cancellation::new();
        let (needs, rx) = watch::channel(Needs::default());
        let (retry, retry_rx) = mpsc::unbounded_channel();
        let worker_cancel = cancel.clone();
        std::thread::Builder::new()
            .name("hertz-dbx-reader".into())
            .spawn(move || {
                if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    runtime.block_on(run(
                        profile,
                        move |message| {
                            let _ = proxy.send_event(UserEvent::Dbx(generation, Box::new(message)));
                        },
                        worker_cancel,
                        rx,
                        retry_rx,
                    ));
                }
            })
            .expect("create DBX reader thread");
        Self {
            cancel,
            needs,
            retry,
        }
    }
    pub(crate) fn set_needs(&self, needs: Needs) {
        self.needs.send_if_modified(|old| {
            if *old == needs {
                false
            } else {
                *old = needs;
                true
            }
        });
    }
    pub(crate) fn retry(&self) {
        let _ = self.retry.send(());
    }
}
impl Drop for Controller {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

pub(crate) enum Message {
    Lyrics {
        started: Instant,
        snapshot: Snapshot,
        // Native-only shared cache. The UI owner decides whether its document was
        // cleared while this request or its event waited; no large JS replay per tick.
        cached_document: Option<Arc<Document>>,
    },
    Wallpaper {
        started: Instant,
        snapshot: wallpaper_feed::Snapshot,
    },
    Document {
        session: String,
        key: String,
        document: Document,
    },
    Session(String),
    Failure {
        scope: Option<Scope>,
        message: &'static str,
    },
}
#[derive(Debug)]
struct ReadError {
    message: &'static str,
    source_invalid: bool,
    conflict: bool,
    scope_revoked: bool,
}
impl ReadError {
    fn identity() -> Self {
        Self {
            message: "DBX 来源身份或组件版本不匹配",
            source_invalid: true,
            conflict: false,
            scope_revoked: false,
        }
    }
    fn revoked() -> Self {
        Self {
            message: "DBX 桌面读取尚未授权或授权已撤销",
            source_invalid: false,
            conflict: false,
            scope_revoked: true,
        }
    }
    fn unavailable() -> Self {
        Self {
            message: "等待所选 DBX 来源启动并授权桌面读取",
            source_invalid: false,
            conflict: false,
            scope_revoked: false,
        }
    }
}
struct Prepared {
    discovery: Discovery,
    request: Request,
    pipe: String,
}
fn prepare(profile: &Profile, scope: Scope, key: Option<&str>) -> Result<Prepared, ReadError> {
    let dir = Path::new(profile.data_dir());
    let bytes = windows::read_private_bounded(
        &dir.join("desktop-source.json"),
        hertz_desktop_ipc::DISCOVERY_LIMIT,
    )
    .map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ReadError::unavailable()
        } else {
            ReadError::identity()
        }
    })?;
    let discovery: Discovery = serde_json::from_slice(&bytes).map_err(|_| ReadError::identity())?;
    validate_discovery(&discovery, profile)?;
    let (pipe, filename) = match scope {
        Scope::Lyrics => (discovery.pipes.lyrics.clone(), "desktop-lyrics-key"),
        Scope::Wallpaper => (discovery.pipes.wallpaper.clone(), "wallpaper-key"),
    };
    let pipe = pipe.ok_or_else(ReadError::revoked)?;
    let bytes = windows::read_private_bounded(&dir.join(filename), 128)
        .map_err(|_| ReadError::revoked())?;
    if !(32..=128).contains(&bytes.len()) || !bytes.iter().all(u8::is_ascii_hexdigit) {
        return Err(ReadError::revoked());
    }
    let credential = String::from_utf8(bytes).map_err(|_| ReadError::unavailable())?;
    let request = Request {
        bridge_protocol: hertz_desktop_ipc::BRIDGE_PROTOCOL,
        request_id: format!("desktop-{}", REQUEST_ID.fetch_add(1, Ordering::Relaxed)),
        server_instance_id: discovery.server_instance_id.clone(),
        scope,
        key: credential,
        op: if key.is_some() {
            "document"
        } else {
            "snapshot"
        }
        .into(),
        params: key.map_or_else(
            || serde_json::json!({}),
            |key| serde_json::json!({ "key": key }),
        ),
    };
    Ok(Prepared {
        discovery,
        request,
        pipe,
    })
}
fn validate_discovery(discovery: &Discovery, profile: &Profile) -> Result<(), ReadError> {
    discovery
        .validate(profile)
        .map_err(|_| ReadError::identity())?;
    if discovery.desktop_build_id != crate::component::BUILD_ID
        || discovery.desktop_lyrics_protocol != 1
        || discovery.wallpaper_protocol != 1
    {
        return Err(ReadError::identity());
    }
    Ok(())
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct DocIdentity {
    session: String,
    key: String,
}
struct Work {
    id: u64,
    cancel: Cancellation,
}
struct Completed {
    slot: usize,
    id: u64,
    started: Instant,
    session: String,
    document: Option<DocIdentity>,
    result: Result<serde_json::Value, ReadError>,
}
#[derive(Clone)]
struct Backoff {
    failures: u8,
    due: Instant,
}
impl Backoff {
    fn new() -> Self {
        Self {
            failures: 0,
            due: Instant::now(),
        }
    }
    fn success(&mut self) {
        self.failures = 0;
        self.due = Instant::now();
    }
    fn fail(&mut self) {
        let delay = (1u64 << self.failures.min(5)).min(30);
        self.failures = self.failures.saturating_add(1);
        self.due = Instant::now() + Duration::from_secs(delay);
    }
    fn ready(&self) -> bool {
        Instant::now() >= self.due
    }
}
fn start_job(
    jobs: &mut JoinSet<Completed>,
    slots: &mut [Option<Work>; 3],
    profile: &Profile,
    slot: usize,
    id: u64,
    document: Option<DocIdentity>,
) {
    let profile = profile.clone();
    let cancel = Cancellation::new();
    slots[slot] = Some(Work {
        id,
        cancel: cancel.clone(),
    });
    jobs.spawn(async move {
        let started = Instant::now();
        let scope = if slot == 1 {
            Scope::Wallpaper
        } else {
            Scope::Lyrics
        };
        let mut session = String::new();
        let result = async {
            let prepared = prepare(&profile, scope, document.as_ref().map(|d| d.key.as_str()))?;
            session = prepared.discovery.server_instance_id.clone();
            if document.as_ref().is_some_and(|d| d.session != session) {
                return Err(ReadError {
                    message: "DBX 歌词来源已变化",
                    source_invalid: false,
                    conflict: true,
                    scope_revoked: false,
                });
            }
            let response = windows::request(
                &prepared.pipe,
                prepared.discovery.pid,
                &prepared.request,
                &cancel,
            )
            .await
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::PermissionDenied {
                    ReadError::identity()
                } else {
                    ReadError::unavailable()
                }
            })?;
            // Never display server error bodies: they are not an authority for diagnostics.
            if response.status != 200 {
                return Err(ReadError {
                    message: "DBX 桌面读取未授权或暂不可用",
                    source_invalid: false,
                    conflict: response.status == 409,
                    scope_revoked: matches!(response.status, 401 | 403),
                });
            }
            if document.is_none() {
                // A body that cannot even carry a server block is a format failure, not an identity
                // mismatch; keep identity errors for genuine session or edition differences.
                match response
                    .body
                    .get("server")
                    .and_then(serde_json::Value::as_object)
                {
                    Some(server)
                        if server.get("session").and_then(serde_json::Value::as_str)
                            == Some(session.as_str())
                            && server.get("edition").and_then(serde_json::Value::as_str)
                                == Some(profile.edition()) => {}
                    None => return Err(ReadError::unavailable()),
                    Some(_) => return Err(ReadError::identity()),
                }
            }
            Ok(response.body)
        }
        .await;
        Completed {
            slot,
            id,
            started,
            session,
            document,
            result,
        }
    });
}
async fn run(
    profile: Profile,
    emit: impl Fn(Message),
    cancel: Cancellation,
    mut needs_rx: watch::Receiver<Needs>,
    mut retry_rx: mpsc::UnboundedReceiver<()>,
) {
    let mut lyrics_tick = interval(Duration::from_millis(500));
    let mut wallpaper_tick = interval(Duration::from_millis(250));
    lyrics_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    wallpaper_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut jobs = JoinSet::new();
    let mut slots: [Option<Work>; 3] = [None, None, None];
    let mut retries = [Backoff::new(), Backoff::new(), Backoff::new()];
    let mut needs = *needs_rx.borrow();
    let mut id = 0;
    let mut session = String::new();
    let mut seq = [None::<u64>, None];
    let mut desired_doc: Option<DocIdentity> = None;
    let mut successful_doc: Option<(DocIdentity, Arc<Document>)> = None;
    // Reconfirmation is separate from identity: 409/authorization errors must not
    // erase the same identity's independent retry history.
    let mut document_confirmation_after: Option<Instant> = None;
    let mut document_refresh = false;
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            changed = needs_rx.changed() => {
                if changed.is_err() { break; }
                needs = *needs_rx.borrow_and_update();
                for (slot, work) in slots.iter().enumerate() {
                    if (slot == 1 && !needs.wallpaper) || (slot != 1 && !needs.lyrics) {
                        if let Some(work) = &work { work.cancel.cancel(); }
                    }
                }
                if !needs.lyrics { desired_doc = None; successful_doc = None; document_confirmation_after = None; }
            }
            Some(()) = retry_rx.recv() => { retries[0].due = Instant::now(); retries[1].due = Instant::now(); retries[2].due = Instant::now(); }
            _ = lyrics_tick.tick() => {
                if needs.lyrics && slots[0].is_none() && (retries[0].ready() || document_refresh) {
                    document_refresh = false; id += 1; start_job(&mut jobs, &mut slots, &profile, 0, id, None);
                }
                if needs.lyrics && slots[2].is_none() && retries[2].ready() && document_confirmation_after.is_none() && desired_doc.is_some() && desired_doc.as_ref() != successful_doc.as_ref().map(|(identity, _)| identity) {
                    id += 1; start_job(&mut jobs, &mut slots, &profile, 2, id, desired_doc.clone());
                }
            }
            _ = wallpaper_tick.tick() => {
                if needs.wallpaper && slots[1].is_none() && retries[1].ready() {
                    id += 1; start_job(&mut jobs, &mut slots, &profile, 1, id, None);
                }
            }
            Some(completion) = jobs.join_next(), if !jobs.is_empty() => {
                let Ok(completion) = completion else { break; };
                let slot = completion.slot;
                if slots[slot].as_ref().is_none_or(|w| w.id != completion.id) { continue; }
                let cancelled = slots[slot].take().unwrap().cancel.is_cancelled();
                if cancelled { continue; }
                if slot == 2 && completion.document != desired_doc { continue; }
                match completion.result {
                    Err(error) => {
                        retries[slot].fail();
                        if slot == 0 && (error.source_invalid || error.scope_revoked) {
                            document_confirmation_after = Some(Instant::now());
                            if error.scope_revoked { successful_doc = None; }
                            if let Some(work) = &slots[2] { work.cancel.cancel(); }
                        }
                        if slot != 1 && (error.conflict || error.scope_revoked) {
                            document_confirmation_after = Some(Instant::now());
                            successful_doc = None;
                            if slot == 2 { document_refresh = true; }
                        }
                        if slot == 2 {
                            if error.source_invalid || error.scope_revoked { emit(Message::Failure { scope: if error.source_invalid { None } else { Some(Scope::Lyrics) }, message: error.message }); }
                        } else if error.source_invalid || error.scope_revoked {
                            emit(Message::Failure { scope: if error.source_invalid { None } else { Some(if slot == 0 { Scope::Lyrics } else { Scope::Wallpaper }) }, message: error.message });
                        }
                        if error.source_invalid {
                            for work in slots.iter().flatten() { work.cancel.cancel(); }
                            successful_doc = None; document_confirmation_after = Some(Instant::now());
                        }
                    }
                    Ok(value) => {
                        if slot < 2 && completion.session != session {
                            session = completion.session.clone(); seq = [None, None];
                            desired_doc = None; successful_doc = None; document_confirmation_after = None; retries[2].success();
                            for work in slots.iter().flatten() { work.cancel.cancel(); }
                            emit(Message::Session(session.clone()));
                        }
                        if slot == 0 {
                            let snapshot = serde_json::from_value::<Snapshot>(value).ok().filter(|s| s.protocol == 1 && s.timing == "presentation_applied");
                            let Some(snapshot) = snapshot else { retries[0].fail(); continue; };
                            if seq[0].is_some_and(|old| snapshot.seq <= old) { continue; }
                            seq[0] = Some(snapshot.seq); retries[0].success();
                            let wanted = if snapshot.lyrics.status == "ready" { snapshot.lyrics.document_key.as_ref().filter(|key| valid_key(key)).map(|key| DocIdentity { session: session.clone(), key: key.clone() }) } else { None };
                            if desired_doc != wanted {
                                if let Some(work) = &slots[2] { work.cancel.cancel(); }
                                desired_doc = wanted; successful_doc = None; retries[2].success();
                            }
                            if document_confirmation_after.is_some_and(|after| completion.started >= after) {
                                document_confirmation_after = None;
                            }
                            let cached_document = successful_doc.as_ref()
                                .filter(|(identity, _)| desired_doc.as_ref() == Some(identity))
                                .map(|(_, document)| document.clone());
                            emit(Message::Lyrics { started: completion.started, snapshot, cached_document });
                        } else if slot == 1 {
                            let snapshot = serde_json::from_value::<wallpaper_feed::Snapshot>(value).ok().filter(|s| wallpaper_feed::validate(s).is_ok());
                            let Some(snapshot) = snapshot else { retries[1].fail(); continue; };
                            if seq[1].is_some_and(|old| snapshot.seq <= old) { continue; }
                            seq[1] = Some(snapshot.seq); retries[1].success();
                            emit(Message::Wallpaper { started: completion.started, snapshot });
                        } else {
                            let Some(identity) = completion.document else { continue; };
                            let document = serde_json::from_value::<Document>(value).ok().filter(|d| d.protocol == 1 && d.timing == "presentation_applied" && d.document_key.as_deref() == Some(identity.key.as_str()));
                            if let Some(document) = document {
                                successful_doc = Some((identity.clone(), Arc::new(document.clone()))); retries[2].success();
                                emit(Message::Document { session: identity.session, key: identity.key, document });
                            } else { retries[2].fail(); }
                        }
                    }
                }
            }
        }
    }
    for work in slots.iter().flatten() {
        work.cancel.cancel();
    }
    // Draining ensures cancellation closes every owned OS pipe before the runtime exits.
    while jobs.join_next().await.is_some() {}
}
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hertz_desktop_ipc::{Pipes, Response};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize},
        Arc,
    };

    struct Fixture {
        directory: std::path::PathBuf,
        profile: Profile,
        discovery: Discovery,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "hertz-dbx-native-{}-{}",
                std::process::id(),
                REQUEST_ID.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&directory).unwrap();
            let profile = Profile::Dbx {
                data_dir: directory.to_string_lossy().into_owned(),
                edition: "standard".into(),
                plugin_id: hertz_desktop_ipc::profile::STANDARD_PLUGIN_ID.into(),
            }
            .normalized()
            .unwrap();
            let session = "00000000-0000-4000-8000-000000000001";
            let discovery = Discovery {
                discovery_protocol: 1,
                source: profile.clone(),
                server_instance_id: session.into(),
                pid: std::process::id(),
                windows_session_id: windows::Identity::current().unwrap().windows_session_id,
                build_id: "fixture".into(),
                desktop_build_id: crate::component::BUILD_ID.into(),
                bridge_protocol: 1,
                desktop_lyrics_protocol: 1,
                wallpaper_protocol: 1,
                pipes: Pipes {
                    lyrics: Some(windows::pipe_name(&profile, session, Scope::Lyrics).unwrap()),
                    wallpaper: Some(
                        windows::pipe_name(&profile, session, Scope::Wallpaper).unwrap(),
                    ),
                },
            };
            let fixture = Self {
                directory,
                profile,
                discovery,
            };
            fixture.publish();
            for key in ["desktop-lyrics-key", "wallpaper-key"] {
                windows::write_private_atomic(
                    &fixture.directory.join(key),
                    "a".repeat(64).as_bytes(),
                    128,
                )
                .unwrap();
            }
            fixture
        }
        fn publish(&self) {
            windows::write_private_atomic(
                &self.directory.join("desktop-source.json"),
                &serde_json::to_vec(&self.discovery).unwrap(),
                hertz_desktop_ipc::DISCOVERY_LIMIT,
            )
            .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    #[derive(Default)]
    struct State {
        sequence: AtomicU64,
        snapshots: AtomicUsize,
        wallpapers: AtomicUsize,
        documents: AtomicUsize,
        active: AtomicUsize,
        max_active: AtomicUsize,
        changed_key: AtomicBool,
        replay_sequence: AtomicBool,
        wrong_session: AtomicBool,
        fail_first_document: AtomicBool,
        snapshot_status: AtomicUsize,
        snapshot_invalid: AtomicBool,
        slow_document: AtomicBool,
        snapshot_delay_ms: AtomicU64,
        document_status: AtomicU64,
        request_log: std::sync::Mutex<Vec<(String, Instant)>>,
    }
    async fn listener(
        mut server: tokio::net::windows::named_pipe::NamedPipeServer,
        name: String,
        scope: Scope,
        state: Arc<State>,
        cancel: Cancellation,
    ) {
        let mut requests = JoinSet::new();
        loop {
            let connection = tokio::select! {
                _ = cancel.cancelled() => break,
                result = windows::accept(server, &cancel) => match result { Ok(connection) => connection, Err(_) => break },
            };
            server = windows::create_server(&name, false).unwrap();
            let state = state.clone();
            let cancel = cancel.clone();
            requests.spawn(async move {
                let _ = connection.serve(&cancel, |_, request| async move {
                    let active = state.active.fetch_add(1, Ordering::SeqCst) + 1;
                    state.max_active.fetch_max(active, Ordering::SeqCst);
                    struct Active(Arc<State>); impl Drop for Active { fn drop(&mut self) { self.0.active.fetch_sub(1, Ordering::SeqCst); } }
                    let _active = Active(state.clone());
                    state.request_log.lock().unwrap().push((request.op.clone(), Instant::now()));
                    let mut status = 200;
                    let session = if state.wrong_session.load(Ordering::SeqCst) { "wrong-session" } else { request.server_instance_id.as_str() };
                    let key = if state.changed_key.load(Ordering::SeqCst) { "new-key" } else { "same-key" };
                    let body = if request.scope != scope || request.key != "a".repeat(64) { status = 403; serde_json::json!({}) }
                    else if request.op == "document" {
                        let attempt = state.documents.fetch_add(1, Ordering::SeqCst);
                        let forced_status = state.document_status.load(Ordering::SeqCst);
                        if forced_status != 0 { status = forced_status as u16; }
                        if attempt == 0 && state.fail_first_document.load(Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(2100)).await; }
                        else if state.slow_document.load(Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(900)).await; }
                        serde_json::json!({"protocol":1,"timing":"presentation_applied","documentKey":request.params["key"],"lines":[{"startMs":0,"endMs":3000,"text":"fixture"}]})
                    } else if scope == Scope::Lyrics {
                        state.snapshots.fetch_add(1, Ordering::SeqCst);
                        let forced = state.snapshot_status.load(Ordering::SeqCst);
                        if forced != 0 { status = forced as u16; }
                        let delay = state.snapshot_delay_ms.load(Ordering::SeqCst);
                        if delay != 0 { tokio::time::sleep(Duration::from_millis(delay)).await; }
                        serde_json::json!({"protocol":if state.snapshot_invalid.load(Ordering::SeqCst) { 99 } else { 1 },"seq":if state.replay_sequence.load(Ordering::SeqCst) { 0 } else { state.sequence.fetch_add(1,Ordering::SeqCst) },"server":{"session":session,"edition":"standard","version":"fixture"},"generation":"1","positionMs":100,"durationMs":4000,"playing":true,"buffering":false,"track":{"id":"track","title":"fixture","artist":null,"album":null,"durationMs":4000},"lyrics":{"status":"ready","documentKey":key},"timing":"presentation_applied"})
                    } else {
                        state.wallpapers.fetch_add(1, Ordering::SeqCst);
                        serde_json::json!({"protocol":if state.snapshot_invalid.load(Ordering::SeqCst) { 99 } else { 1 },"seq":if state.replay_sequence.load(Ordering::SeqCst) { 0 } else { state.sequence.fetch_add(1,Ordering::SeqCst) },"server":{"session":session,"edition":"standard","version":"fixture"},"valid":true,"playing":true,"positionMs":100,"durationMs":4000,"generation":"1","spectrum":{"bands":vec![0.5;64],"energy":0.5,"ageMs":0},"timing":"presentation_applied"})
                    };
                    Ok(Response { bridge_protocol:1,request_id:request.request_id,server_instance_id:request.server_instance_id,status,body })
                }).await;
            });
        }
        while requests.join_next().await.is_some() {}
    }
    fn start_servers(
        fixture: &Fixture,
        state: Arc<State>,
    ) -> (Cancellation, Vec<tokio::task::JoinHandle<()>>) {
        let cancel = Cancellation::new();
        let tasks = [
            (
                Scope::Lyrics,
                fixture.discovery.pipes.lyrics.clone().unwrap(),
            ),
            (
                Scope::Wallpaper,
                fixture.discovery.pipes.wallpaper.clone().unwrap(),
            ),
        ]
        .into_iter()
        .map(|(scope, name)| {
            let server = windows::create_server(&name, true).unwrap();
            tokio::spawn(listener(server, name, scope, state.clone(), cancel.clone()))
        })
        .collect();
        (cancel, tasks)
    }
    #[test]
    fn discovery_rejects_wrong_build_protocol_identity_and_private_acl() {
        let fixture = Fixture::new();
        assert!(prepare(&fixture.profile, Scope::Lyrics, None).is_ok());
        for field in [
            "desktopBuildId",
            "desktopLyricsProtocol",
            "wallpaperProtocol",
        ] {
            let mut value = serde_json::to_value(&fixture.discovery).unwrap();
            value[field] = if field == "desktopBuildId" {
                "wrong".into()
            } else {
                99.into()
            };
            windows::write_private_atomic(
                &fixture.directory.join("desktop-source.json"),
                &serde_json::to_vec(&value).unwrap(),
                65536,
            )
            .unwrap();
            assert!(prepare(&fixture.profile, Scope::Lyrics, None).is_err());
        }
        fixture.publish();
        let mut wrong = fixture.profile.clone();
        if let Profile::Dbx { plugin_id, .. } = &mut wrong {
            plugin_id.push('x');
        }
        assert!(prepare(&wrong, Scope::Lyrics, None).is_err());
        std::fs::write(
            fixture.directory.join("desktop-lyrics-key"),
            "secret is malformed",
        )
        .unwrap();
        assert!(prepare(&fixture.profile, Scope::Lyrics, None).is_err());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn slow_document_does_not_block_snapshot_cadence_and_same_key_failure_recovers() {
        let fixture = Fixture::new();
        let state = Arc::new(State::default());
        state.slow_document.store(true, Ordering::SeqCst);
        state.fail_first_document.store(true, Ordering::SeqCst);
        let (server_cancel, servers) = start_servers(&fixture, state.clone());
        let (needs, rx) = watch::channel(Needs {
            lyrics: true,
            wallpaper: true,
        });
        let (_retry, retry_rx) = mpsc::unbounded_channel();
        let cancel = Cancellation::new();
        let (events, mut event_rx) = mpsc::unbounded_channel();
        let worker = tokio::spawn(run(
            fixture.profile.clone(),
            move |message| {
                let _ = events.send(message);
            },
            cancel.clone(),
            rx,
            retry_rx,
        ));
        let deadline = Instant::now() + Duration::from_secs(6);
        let mut document = false;
        let mut lyrics_before_document = 0;
        while Instant::now() < deadline {
            let message = tokio::time::timeout(Duration::from_secs(2), event_rx.recv())
                .await
                .unwrap()
                .unwrap();
            match message {
                Message::Lyrics { .. } if !document => lyrics_before_document += 1,
                Message::Document { key, .. } => {
                    assert_eq!(key, "same-key");
                    document = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(
            document,
            "same-key retry must recover without track/session change"
        );
        assert!(
            lyrics_before_document >= 5,
            "slow/failed documents must not stop 2 Hz snapshots"
        );
        assert_eq!(state.documents.load(Ordering::SeqCst), 2);
        assert!(state.wallpapers.load(Ordering::SeqCst) >= 8);
        assert!(state.max_active.load(Ordering::SeqCst) <= 3);
        needs.send(Needs::default()).unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let count =
            state.snapshots.load(Ordering::SeqCst) + state.wallpapers.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(650)).await;
        assert_eq!(
            count,
            state.snapshots.load(Ordering::SeqCst) + state.wallpapers.load(Ordering::SeqCst)
        );
        cancel.cancel();
        worker.await.unwrap();
        server_cancel.cancel();
        for task in servers {
            task.await.unwrap();
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn transient_snapshot_failure_keeps_document_and_does_not_invalidate_native_data() {
        let fixture = Fixture::new();
        let state = Arc::new(State::default());
        let (server_cancel, servers) = start_servers(&fixture, state.clone());
        let (_needs, rx) = watch::channel(Needs {
            lyrics: true,
            wallpaper: false,
        });
        let (_retry, retry_rx) = mpsc::unbounded_channel();
        let cancel = Cancellation::new();
        let (events, mut receive) = mpsc::unbounded_channel();
        let worker = tokio::spawn(run(
            fixture.profile.clone(),
            move |event| {
                let _ = events.send(event);
            },
            cancel.clone(),
            rx,
            retry_rx,
        ));
        loop {
            if matches!(
                tokio::time::timeout(Duration::from_secs(3), receive.recv())
                    .await
                    .unwrap()
                    .unwrap(),
                Message::Document { .. }
            ) {
                break;
            }
        }
        for malformed in [false, true] {
            state
                .snapshot_status
                .store(if malformed { 0 } else { 503 }, Ordering::SeqCst);
            state.snapshot_invalid.store(malformed, Ordering::SeqCst);
            let before = state.snapshots.load(Ordering::SeqCst);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
            while state.snapshots.load(Ordering::SeqCst) == before {
                assert!(tokio::time::Instant::now() < deadline);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            state.snapshot_status.store(0, Ordering::SeqCst);
            state.snapshot_invalid.store(false, Ordering::SeqCst);
            loop {
                match tokio::time::timeout(Duration::from_secs(3), receive.recv())
                    .await
                    .unwrap()
                    .unwrap()
                {
                    Message::Failure { .. } => {
                        panic!("transient snapshot failures must leave freshness to native timers")
                    }
                    Message::Lyrics {
                        cached_document: Some(_),
                        ..
                    } => break,
                    _ => {}
                }
            }
        }
        assert_eq!(state.documents.load(Ordering::SeqCst), 1);
        cancel.cancel();
        worker.await.unwrap();
        server_cancel.cancel();
        for task in servers {
            task.await.unwrap();
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn key_change_cancels_old_document_and_shutdown_closes_actual_io() {
        let fixture = Fixture::new();
        let state = Arc::new(State::default());
        state.slow_document.store(true, Ordering::SeqCst);
        let (server_cancel, servers) = start_servers(&fixture, state.clone());
        let (_needs, rx) = watch::channel(Needs {
            lyrics: true,
            wallpaper: false,
        });
        let (_retry, retry_rx) = mpsc::unbounded_channel();
        let cancel = Cancellation::new();
        let (events, mut event_rx) = mpsc::unbounded_channel();
        let worker = tokio::spawn(run(
            fixture.profile.clone(),
            move |message| {
                let _ = events.send(message);
            },
            cancel.clone(),
            rx,
            retry_rx,
        ));
        tokio::time::timeout(Duration::from_secs(2), async {
            while state.documents.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        state.changed_key.store(true, Ordering::SeqCst);
        let document = tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                if let Some(Message::Document { key, .. }) = event_rx.recv().await {
                    break key;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(document, "new-key");
        // Start another real request, then cancel the source while that request owns a pipe.
        state.changed_key.store(false, Ordering::SeqCst);
        let initial = state.documents.load(Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(2), async {
            while state.documents.load(Ordering::SeqCst) == initial {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let before = Instant::now();
        cancel.cancel();
        tokio::time::timeout(Duration::from_millis(300), worker)
            .await
            .unwrap()
            .unwrap();
        assert!(before.elapsed() < Duration::from_millis(300));
        server_cancel.cancel();
        for task in servers {
            task.await.unwrap();
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn actual_peer_pid_wrong_key_and_body_session_are_rejected() {
        let fixture = Fixture::new();
        let state = Arc::new(State::default());
        let (server_cancel, servers) = start_servers(&fixture, state.clone());
        let prepared = prepare(&fixture.profile, Scope::Lyrics, None).unwrap();
        assert!(windows::request(
            &prepared.pipe,
            std::process::id() + 10000,
            &prepared.request,
            &Cancellation::new()
        )
        .await
        .is_err());
        let mut request = prepared.request.clone();
        request.key = "b".repeat(64);
        assert_eq!(
            windows::request(
                &prepared.pipe,
                std::process::id(),
                &request,
                &Cancellation::new()
            )
            .await
            .unwrap()
            .status,
            403
        );
        request = prepared.request.clone();
        request.scope = Scope::Wallpaper;
        assert_eq!(
            windows::request(
                &prepared.pipe,
                std::process::id(),
                &request,
                &Cancellation::new()
            )
            .await
            .unwrap()
            .status,
            403
        );
        state.wrong_session.store(true, Ordering::SeqCst);
        let mut jobs = JoinSet::new();
        let mut slots = [None, None, None];
        start_job(&mut jobs, &mut slots, &fixture.profile, 0, 1, None);
        let completion = jobs.join_next().await.unwrap().unwrap();
        assert!(completion.result.unwrap_err().source_invalid);
        server_cancel.cancel();
        for task in servers {
            task.await.unwrap();
        }
    }
    #[test]
    fn dbx_controls_and_standalone_transports_reject_before_discovery() {
        let fixture = Fixture::new();
        std::fs::write(
            fixture.directory.join("vmusicd.json"),
            "this must never be opened",
        )
        .unwrap();
        let error = crate::feed::control(&fixture.profile, &serde_json::json!({"action":"play"}))
            .unwrap_err();
        assert!(error.to_string().contains("DBX"));
        assert!(crate::feed::Feed::new(fixture.profile.clone()).is_err());
        assert!(crate::wallpaper_feed::Feed::new(fixture.profile.clone()).is_err());
        assert!(crate::bridge::read_discovery(&fixture.profile).is_err());
    }
    #[tokio::test(flavor = "current_thread")]
    async fn replayed_sequences_never_emit_a_new_snapshot() {
        let fixture = Fixture::new();
        let state = Arc::new(State::default());
        state.replay_sequence.store(true, Ordering::SeqCst);
        let (server_cancel, servers) = start_servers(&fixture, state.clone());
        let (_needs, rx) = watch::channel(Needs {
            lyrics: true,
            wallpaper: false,
        });
        let (_retry, retry_rx) = mpsc::unbounded_channel();
        let cancel = Cancellation::new();
        let (events, mut event_rx) = mpsc::unbounded_channel();
        let worker = tokio::spawn(run(
            fixture.profile.clone(),
            move |message| {
                let _ = events.send(message);
            },
            cancel.clone(),
            rx,
            retry_rx,
        ));
        let mut accepted = 0;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(3250);
        while let Ok(Some(message)) = tokio::time::timeout_at(deadline, event_rx.recv()).await {
            if matches!(message, Message::Lyrics { .. }) {
                accepted += 1;
            }
        }
        assert!(state.snapshots.load(Ordering::SeqCst) >= 6);
        assert_eq!(accepted, 1);
        state.replay_sequence.store(false, Ordering::SeqCst);
        let (next, restored) = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if let Some(Message::Lyrics {
                    snapshot,
                    cached_document,
                    ..
                }) = event_rx.recv().await
                {
                    break (snapshot.seq, cached_document);
                }
            }
        })
        .await
        .unwrap();
        assert!(next > 0);
        assert_eq!(restored.unwrap().document_key.as_deref(), Some("same-key"));
        assert_eq!(
            state.documents.load(Ordering::SeqCst),
            1,
            "successful same-key document remains deduplicated after stale recovery"
        );
        cancel.cancel();
        worker.await.unwrap();
        server_cancel.cancel();
        for task in servers {
            task.await.unwrap();
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn slow_snapshot_cache_survives_native_expiry_and_queued_delivery() {
        let fixture = Fixture::new();
        let state = Arc::new(State::default());
        state.snapshot_delay_ms.store(1600, Ordering::SeqCst);
        let (server_cancel, servers) = start_servers(&fixture, state.clone());
        let (_needs, rx) = watch::channel(Needs {
            lyrics: true,
            wallpaper: false,
        });
        let (_retry, retry_rx) = mpsc::unbounded_channel();
        let cancel = Cancellation::new();
        let (events, mut messages) = mpsc::unbounded_channel();
        let worker = tokio::spawn(run(
            fixture.profile.clone(),
            move |message| {
                let _ = events.send(message);
            },
            cancel.clone(),
            rx,
            retry_rx,
        ));
        let deadline = tokio::time::Instant::now() + Duration::from_millis(6150);
        let mut ticker = interval(Duration::from_millis(100));
        let mut last_update: Option<Instant> = None;
        let mut has_document = false;
        let mut clears = 0;
        let mut restores = 0;
        let mut document_events = 0;
        let mut last_cache: Option<Arc<Document>> = None;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => break,
                _ = ticker.tick() => {
                    if last_update.is_some_and(|started| started.elapsed() > Duration::from_secs(3)) {
                        last_update = None;
                        if has_document { has_document = false; clears += 1; }
                    }
                }
                Some(message) = messages.recv() => match message {
                    Message::Lyrics { started, cached_document, .. } => {
                        if started.elapsed() >= Duration::from_secs(3) { continue; }
                        last_update = Some(started);
                        if let Some(document) = cached_document {
                            if let Some(previous) = &last_cache { assert!(Arc::ptr_eq(previous, &document), "cached events share the successful document allocation"); }
                            last_cache = Some(document.clone());
                            if !has_document { has_document = true; restores += 1; }
                        }
                    }
                    Message::Document { .. } => { has_document = true; document_events += 1; }
                    _ => {}
                }
            }
        }
        assert!(
            clears >= 1 && restores >= 1,
            "RTT=1600ms must recover after native expires old t0"
        );
        assert_eq!(
            document_events, 1,
            "the scheduler never replays full document completion events per snapshot"
        );
        // Let fresh events wait in the UI queue. Once native resumes, old t0 values
        // expire, while a newer matching snapshot can restore from its shared cache.
        state.snapshot_delay_ms.store(0, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(3700)).await;
        has_document = false;
        let mut queued_restore = false;
        while let Ok(message) = messages.try_recv() {
            if let Message::Lyrics {
                started,
                cached_document: Some(document),
                ..
            } = message
            {
                if started.elapsed() < Duration::from_secs(3) && !has_document {
                    assert!(Arc::ptr_eq(last_cache.as_ref().unwrap(), &document));
                    has_document = true;
                    queued_restore = true;
                }
            }
        }
        assert!(
            queued_restore,
            "UI queueing cannot consume the successful document completion forever"
        );
        assert_eq!(state.documents.load(Ordering::SeqCst), 1);
        cancel.cancel();
        worker.await.unwrap();
        server_cancel.cancel();
        for server in servers {
            server.await.unwrap();
        }
    }

    async fn assert_same_identity_backoff(status: u16) {
        let fixture = Fixture::new();
        let state = Arc::new(State::default());
        state
            .document_status
            .store(u64::from(status), Ordering::SeqCst);
        let (server_cancel, servers) = start_servers(&fixture, state.clone());
        let (_needs, rx) = watch::channel(Needs {
            lyrics: true,
            wallpaper: false,
        });
        let (_retry, retry_rx) = mpsc::unbounded_channel();
        let cancel = Cancellation::new();
        let worker = tokio::spawn(run(
            fixture.profile.clone(),
            |_| {},
            cancel.clone(),
            rx,
            retry_rx,
        ));
        tokio::time::sleep(Duration::from_millis(5400)).await;
        cancel.cancel();
        worker.await.unwrap();
        server_cancel.cancel();
        for server in servers {
            server.await.unwrap();
        }
        let requests = state.request_log.lock().unwrap();
        let documents: Vec<_> = requests
            .iter()
            .enumerate()
            .filter(|(_, (op, _))| op == "document")
            .collect();
        assert!((2..=3).contains(&documents.len()), "status {status}: same-key failure backoff must survive successful snapshots, got {} requests", documents.len());
        for (attempt, pair) in documents.windows(2).enumerate() {
            let ((before_index, (_, before)), (after_index, (_, after))) = (pair[0], pair[1]);
            let minimum = Duration::from_millis(if attempt == 0 { 950 } else { 1950 });
            assert!(
                after.duration_since(*before) >= minimum,
                "status {status}: attempt {attempt} lost its backoff"
            );
            assert!(requests[before_index + 1..after_index].iter().any(|(op, at)| op == "snapshot" && at > before), "status {status}: document retry requires a newly started snapshot after the failed attempt");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn conflict_and_authorization_reconfirmation_preserve_document_backoff() {
        tokio::join!(
            assert_same_identity_backoff(409),
            assert_same_identity_backoff(401),
            assert_same_identity_backoff(403)
        );
    }
}
