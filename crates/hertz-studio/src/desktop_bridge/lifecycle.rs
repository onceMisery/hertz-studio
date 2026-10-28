// SPDX-License-Identifier: MIT
use super::{authorization::*, desktop_error, failure, DesktopStatus, ScopeFailure};
use crate::{error::ApiError, state::AppState};
use hertz_desktop_ipc::{
    windows::{self, Cancellation},
    Discovery, Pipes, Profile, Scope, BRIDGE_PROTOCOL, DISCOVERY_LIMIT, DISCOVERY_PROTOCOL,
};
use std::{
    collections::HashMap,
    io,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::Duration,
};
use tokio::{
    sync::{Notify, Semaphore},
    task::JoinHandle,
};
use zeroize::Zeroizing;

pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Captured only while authorized. D2 must check it after any external management wait.
/// Cancellation is latched, and carries no key or mutable playback capability.
#[derive(Clone)]
pub struct AuthorizationGeneration {
    pub(super) epoch: u64,
    pub(super) cancel: Cancellation,
}
impl AuthorizationGeneration {
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }
    pub async fn cancelled(&self) {
        self.cancel.cancelled().await
    }
}

pub(super) struct Gate {
    pub epoch: u64,
    pub open: bool,
    pub shutting_down: bool,
    pub revoking: bool,
    pub restore_allowed: bool,
    pub revision: u64,
    pub keys: [Option<Zeroizing<String>>; 2],
    pub cancel: Cancellation,
    // Unlike the authority token, a new intent token exists even while the gate is closed.
    intent_cancel: Cancellation,
    pub senders: HashMap<u64, Cancellation>,
    pub next_sender: u64,
}
impl Gate {
    fn close(&mut self) {
        self.open = false;
        self.cancel.cancel();
        self.intent_cancel.cancel();
        self.intent_cancel = Cancellation::new();
        for cancel in self.senders.values() {
            cancel.cancel();
        }
        self.keys = [None, None];
        if let Some(epoch) = self.epoch.checked_add(1) {
            self.epoch = epoch;
        } else {
            self.shutting_down = true;
        }
    }
}

struct Lifecycle {
    writer: Option<Arc<Mutex<fslock::LockFile>>>,
    tasks: Vec<JoinHandle<()>>,
    cleaning: bool,
    cleanup_keys: bool,
    status: DesktopStatus,
}

// Cleanup can be cancelled by its caller or by runtime shutdown. Never detach
// handles or leave cleaning latched when the future carrying this batch is dropped.
struct CleanupBatch<'a> {
    bridge: &'a DesktopBridge,
    tasks: Vec<JoinHandle<()>>,
    finished: bool,
}
impl Drop for CleanupBatch<'_> {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.tasks.retain(|task| !task.is_finished());
        let mut life = lock(&self.bridge.lifecycle);
        life.tasks.append(&mut self.tasks);
        life.cleaning = false;
        life.status.cleanup_incomplete = true;
        drop(life);
        self.bridge.cleanup_done.notify_waiters();
    }
}

// The operation-in-progress marker is separate from the closed authorization
// gate. Cancellation permits a later explicit retry, while restore stays disabled.
struct RevokeAttempt<'a> {
    bridge: &'a DesktopBridge,
    epoch: u64,
}
impl Drop for RevokeAttempt<'_> {
    fn drop(&mut self) {
        let mut gate = lock(&self.bridge.gate);
        if gate.epoch == self.epoch {
            gate.revoking = false;
        }
    }
}

// Field order also covers runtime/task abort and bridge Drop: listening/accepted
// handles are dropped before the final exclusive writer lease can be released.
struct ListenerTask {
    work: futures::future::BoxFuture<'static, ()>,
    _writer: Arc<Mutex<fslock::LockFile>>,
}
impl std::future::Future for ListenerTask {
    type Output = ();
    fn poll(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<()> {
        self.get_mut().work.as_mut().poll(context)
    }
}

pub struct DesktopBridge {
    pub(super) state: Weak<AppState>,
    pub(super) directory: PathBuf,
    pub(super) session: String,
    profile: Option<Profile>,
    pub(super) gate: Mutex<Gate>,
    lifecycle: Mutex<Lifecycle>,
    cleanup_done: Notify,
    pub(super) global_slots: Arc<Semaphore>,
    #[cfg(test)]
    pub(super) projection_calls: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    before_publish: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    #[cfg(test)]
    after_publish: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl DesktopBridge {
    /// Uses the already resolved business DataDir. No files, listeners, component probes,
    /// native configuration migration or process launch occur here.
    pub fn new(state: &Arc<AppState>) -> Arc<Self> {
        let profile = Profile::Dbx {
            edition: crate::edition::NAME.into(),
            data_dir: state.data_dir.to_string_lossy().into_owned(),
            plugin_id: crate::edition::PLUGIN_ID.into(),
        }
        .normalized();
        let mut status = DesktopStatus::empty(true, profile.as_ref().ok().cloned());
        if profile.is_err() {
            status.error = Some(desktop_error(&failure(
                "desktop_profile_invalid",
                "Cannot normalize DBX desktop profile",
            )));
        }
        Arc::new(Self {
            state: Arc::downgrade(state),
            directory: state.data_dir.clone(),
            session: state.server_instance_id().into(),
            profile: profile.ok(),
            gate: Mutex::new(Gate {
                epoch: 1,
                open: false,
                shutting_down: false,
                revoking: false,
                restore_allowed: true,
                revision: 0,
                keys: [None, None],
                cancel: Cancellation::new(),
                intent_cancel: Cancellation::new(),
                senders: HashMap::new(),
                next_sender: 0,
            }),
            lifecycle: Mutex::new(Lifecycle {
                writer: None,
                tasks: Vec::new(),
                cleaning: false,
                cleanup_keys: false,
                status,
            }),
            cleanup_done: Notify::new(),
            global_slots: Arc::new(Semaphore::new(4)),
            #[cfg(test)]
            projection_calls: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            before_publish: Mutex::new(None),
            #[cfg(test)]
            after_publish: Mutex::new(None),
        })
    }

    pub fn profile(&self) -> Option<Profile> {
        self.profile.clone()
    }
    pub fn status(&self) -> DesktopStatus {
        // All paths taking both locks use lifecycle -> gate. close never takes lifecycle.
        let mut status = lock(&self.lifecycle).status.clone();
        let gate = lock(&self.gate);
        status.active_scopes = if gate.open {
            SCOPES
                .into_iter()
                .filter(|scope| gate.keys[index(*scope)].is_some())
                .collect()
        } else {
            Vec::new()
        };
        status.listener_ready = !status.active_scopes.is_empty();
        status
    }
    pub fn capture_generation(&self) -> Option<AuthorizationGeneration> {
        let gate = lock(&self.gate);
        (gate.open && !gate.shutting_down && !gate.revoking).then(|| AuthorizationGeneration {
            epoch: gate.epoch,
            cancel: gate.cancel.clone(),
        })
    }
    pub fn is_current(&self, generation: &AuthorizationGeneration) -> bool {
        let gate = lock(&self.gate);
        gate.open
            && !gate.shutting_down
            && !gate.revoking
            && gate.epoch == generation.epoch
            && !generation.cancel.is_cancelled()
    }
    fn operation_epoch(&self, restoring: bool) -> Result<u64, ApiError> {
        let gate = lock(&self.gate);
        if gate.shutting_down || gate.revoking || restoring && !gate.restore_allowed {
            return Err(failure(
                "desktop_operation_cancelled",
                "Desktop authorization operation was cancelled",
            ));
        }
        Ok(gate.epoch)
    }
    fn epoch_valid(gate: &Gate, epoch: u64, restoring: bool) -> bool {
        gate.epoch == epoch
            && !gate.shutting_down
            && !gate.revoking
            && (!restoring || gate.restore_allowed)
    }
    fn record_error(&self, error: &ApiError) {
        lock(&self.lifecycle).status.error = Some(desktop_error(error));
    }

    pub async fn restore(self: &Arc<Self>) -> Result<DesktopStatus, ApiError> {
        let epoch = self.operation_epoch(true)?;
        let result = self.activate(epoch, true);
        if result.is_err() || !lock(&self.gate).open {
            self.cleanup(false, None).await;
        }
        result
    }

    /// The explicit consent entry point: initially grants both read-only scopes.
    /// Repeated valid connects reuse the authority revision, keys and listening handles.
    pub async fn connect_authorization(self: &Arc<Self>) -> Result<DesktopStatus, ApiError> {
        let epoch = self.operation_epoch(false)?;
        self.connect_authorization_at(epoch).await
    }

    /// Capture before an external compatibility probe, so a revoke during that probe wins.
    #[cfg(test)]
    pub(crate) fn admission_epoch(&self) -> Result<u64, ApiError> {
        self.operation_epoch(false)
    }

    /// Also carry cancellation while compatibility is being checked without authorization.
    pub(crate) fn admission(&self) -> Result<(u64, Cancellation), ApiError> {
        let gate = lock(&self.gate);
        if !Self::epoch_valid(&gate, gate.epoch, false) {
            return Err(failure(
                "desktop_operation_cancelled",
                "Desktop admission was cancelled",
            ));
        }
        Ok((gate.epoch, gate.intent_cancel.clone()))
    }

    pub(crate) fn admission_current(&self, epoch: u64) -> bool {
        Self::epoch_valid(&lock(&self.gate), epoch, false)
    }

    pub(crate) async fn connect_authorization_at(
        self: &Arc<Self>,
        mut epoch: u64,
    ) -> Result<DesktopStatus, ApiError> {
        if !self.admission_current(epoch) {
            return Err(failure(
                "desktop_operation_cancelled",
                "Desktop authorization operation was cancelled",
            ));
        }
        if let Some(generation) = self.capture_generation() {
            let fully_ready = SCOPES
                .into_iter()
                .all(|scope| self.validate_authority(scope, &generation, None).is_ok());
            if !fully_ready {
                let mut gate = lock(&self.gate);
                if !Self::epoch_valid(&gate, epoch, false) {
                    return Err(failure(
                        "desktop_operation_cancelled",
                        "Desktop authorization operation was cancelled",
                    ));
                }
                gate.close();
                epoch = gate.epoch;
            }
        }
        // No lifecycle mutex is held while cancelled pipe tasks release their handles.
        if !lock(&self.gate).open {
            self.cleanup(false, None).await;
        }
        let result = self.activate(epoch, false);
        if result.is_err() {
            self.cleanup(false, None).await;
        }
        result
    }

    fn acquire_writer(&self, life: &mut Lifecycle) -> Result<(), ApiError> {
        if life.writer.is_some() {
            return Ok(());
        }
        let mut writer = fslock::LockFile::open(&self.directory.join(LOCK_FILE)).map_err(|_| {
            failure(
                "desktop_source_conflict",
                "Cannot acquire desktop source writer lock",
            )
        })?;
        if !writer.try_lock().map_err(|_| {
            failure(
                "desktop_source_conflict",
                "Cannot acquire desktop source writer lock",
            )
        })? {
            return Err(failure(
                "desktop_source_conflict",
                "Another sidecar owns this desktop source",
            ));
        }
        life.writer = Some(Arc::new(Mutex::new(writer)));
        Ok(())
    }

    fn activate(self: &Arc<Self>, epoch: u64, restoring: bool) -> Result<DesktopStatus, ApiError> {
        let result = self.activate_inner(epoch, restoring);
        if let Err(error) = &result {
            let mut life = lock(&self.lifecycle);
            let mut gate = lock(&self.gate);
            if gate.epoch == epoch {
                life.status.error = Some(desktop_error(error));
                if gate.open {
                    gate.close();
                }
            }
        }
        result.map(|_| self.status())
    }

    fn activate_inner(self: &Arc<Self>, epoch: u64, restoring: bool) -> Result<(), ApiError> {
        let profile = self.profile.as_ref().ok_or_else(|| {
            failure(
                "desktop_profile_invalid",
                "Cannot normalize DBX desktop profile",
            )
        })?;
        // Ordinary startup only reads authority. Keys alone are never consent. Invalid or
        // future records are preserved, including on an explicit connect.
        let initial = Authorization::read(&self.directory).map_err(|_| {
            failure(
                "desktop_authorization_invalid",
                "Desktop authorization is invalid or not private",
            )
        })?;
        let mut life = lock(&self.lifecycle);
        if life.cleaning {
            return Err(failure(
                "desktop_cleanup_pending",
                "Desktop source is still disconnecting",
            ));
        }
        if !Self::epoch_valid(&lock(&self.gate), epoch, restoring) {
            return Err(failure(
                "desktop_operation_cancelled",
                "Desktop authorization operation was cancelled",
            ));
        }
        life.status.revision = initial.as_ref().map(|record| record.revision);
        life.status.authorized_scopes = initial
            .as_ref()
            .map(|record| record.scopes.clone())
            .unwrap_or_default();
        life.status.persistent_revoked = initial
            .as_ref()
            .is_some_and(|record| record.scopes.is_empty());
        if restoring
            && initial
                .as_ref()
                .is_none_or(|record| record.scopes.is_empty())
        {
            let mut gate = lock(&self.gate);
            if gate.open {
                gate.close();
            }
            life.status.revision = initial.as_ref().map(|record| record.revision);
            life.status.authorized_scopes.clear();
            life.status.persistent_revoked = initial.is_some();
            life.status.error = None;
            return Ok(());
        }
        if restoring {
            // Validate credentials read-only before acquiring/creating the writer lock.
            // The authoritative record and all candidate keys are read again under it.
            let record = initial.as_ref().expect("nonempty restore authority");
            let unavailable: Vec<_> = record
                .scopes
                .iter()
                .filter(|scope| read_key(&self.directory, **scope).is_err())
                .map(|scope| ScopeFailure {
                    scope: *scope,
                    error: desktop_error(&failure(
                        "desktop_credential_unavailable",
                        "Desktop scope credential is missing, invalid or not private",
                    )),
                })
                .collect();
            if unavailable.len() == record.scopes.len() {
                let mut gate = lock(&self.gate);
                if gate.open {
                    gate.close();
                }
                life.status.scope_errors = unavailable;
                life.status.error = None;
                return Ok(());
            }
        }
        self.acquire_writer(&mut life)?;
        // Another process may have changed authority/keys before this process acquired
        // the writer lock. Never use the optimistic read to publish a listener.
        let existing = Authorization::read(&self.directory).map_err(|_| {
            failure(
                "desktop_authorization_invalid",
                "Desktop authorization is invalid or not private",
            )
        })?;
        let authorization = if restoring {
            match existing {
                Some(record) if !record.scopes.is_empty() => record,
                record => {
                    life.status.revision = record.as_ref().map(|record| record.revision);
                    life.status.authorized_scopes.clear();
                    life.status.persistent_revoked = record.is_some();
                    life.writer = None;
                    return Ok(());
                }
            }
        } else {
            let unchanged = existing
                .as_ref()
                .is_some_and(|record| SCOPES.iter().all(|scope| record.scopes.contains(scope)));
            Authorization {
                schema_version: 1,
                revision: if unchanged {
                    existing.as_ref().unwrap().revision
                } else {
                    Authorization::next_revision(existing.as_ref()).map_err(|_| {
                        failure(
                            "desktop_authorization_invalid",
                            "Desktop authorization revision exhausted",
                        )
                    })?
                },
                scopes: SCOPES.to_vec(),
            }
        };
        let mut keys = [None, None];
        let mut scope_errors = Vec::new();
        for scope in &authorization.scopes {
            match read_key(&self.directory, *scope) {
                Ok(key) => keys[index(*scope)] = Some(key),
                Err(error) if !restoring && error.kind() == io::ErrorKind::NotFound => {
                    keys[index(*scope)] =
                        Some(create_key(&self.directory, *scope).map_err(|_| {
                            failure(
                                "desktop_credential_unavailable",
                                "Cannot create private desktop credential",
                            )
                        })?);
                }
                Err(_) if restoring => scope_errors.push(ScopeFailure {
                    scope: *scope,
                    error: desktop_error(&failure(
                        "desktop_credential_unavailable",
                        "Desktop scope credential is missing, invalid or not private",
                    )),
                }),
                Err(_) => {
                    return Err(failure(
                        "desktop_credential_unavailable",
                        "Desktop scope credential is invalid or not private",
                    ))
                }
            }
        }
        if !restoring
            && initial.as_ref().is_none_or(|record| {
                record.revision != authorization.revision || record.scopes != authorization.scopes
            })
        {
            authorization.write(&self.directory).map_err(|_| {
                failure(
                    "desktop_authorization_write_failed",
                    "Cannot persist desktop authorization",
                )
            })?;
        }
        life.status.revision = Some(authorization.revision);
        life.status.authorized_scopes = authorization.scopes.clone();
        life.status.persistent_revoked = false;
        life.status.scope_errors = scope_errors;
        life.status.error = None;
        life.status.cleanup_incomplete = false;
        #[cfg(test)]
        if let Some(hook) = lock(&self.before_publish).take() {
            hook();
        }
        let gate = lock(&self.gate);
        if !Self::epoch_valid(&gate, epoch, restoring) {
            return Err(failure(
                "desktop_operation_cancelled",
                "Desktop authorization operation was cancelled",
            ));
        }
        if gate.open
            && gate.revision == authorization.revision
            && SCOPES.iter().all(
                |scope| match (&gate.keys[index(*scope)], &keys[index(*scope)]) {
                    (None, None) => true,
                    (Some(a), Some(b)) => equal_key(a, b),
                    _ => false,
                },
            )
        {
            return Ok(());
        }
        if !life.tasks.is_empty() {
            return Err(failure(
                "desktop_cleanup_pending",
                "Desktop source must finish disconnecting before reconnecting",
            ));
        }
        drop(gate);
        let cancel = Cancellation::new();
        let mut servers = Vec::new();
        let mut pipes = Pipes {
            lyrics: None,
            wallpaper: None,
        };
        for scope in SCOPES {
            if keys[index(scope)].is_none() {
                continue;
            }
            let name = windows::pipe_name(profile, &self.session, scope)
                .map_err(|_| failure("desktop_listener_failed", "Cannot identify desktop pipe"))?;
            let server = windows::create_server(&name, true)
                .map_err(|_| failure("desktop_listener_failed", "Cannot reserve desktop pipe"))?;
            match scope {
                Scope::Lyrics => pipes.lyrics = Some(name.clone()),
                Scope::Wallpaper => pipes.wallpaper = Some(name.clone()),
            }
            servers.push((scope, name, server));
        }
        if servers.is_empty() {
            life.writer = None;
            return Ok(());
        }
        let identity = windows::Identity::current().map_err(|_| {
            failure(
                "desktop_listener_failed",
                "Cannot identify desktop Windows session",
            )
        })?;
        let discovery = Discovery {
            discovery_protocol: DISCOVERY_PROTOCOL,
            source: profile.clone(),
            server_instance_id: self.session.clone(),
            pid: std::process::id(),
            windows_session_id: identity.windows_session_id,
            build_id: env!("HERTZ_PLUGIN_BUILD_ID").into(),
            desktop_build_id: env!("HERTZ_DESKTOP_BUILD_ID").into(),
            bridge_protocol: BRIDGE_PROTOCOL,
            desktop_lyrics_protocol: 1,
            wallpaper_protocol: 1,
            pipes,
        };
        let bytes = hertz_desktop_ipc::frame::serialize_bounded(&discovery, DISCOVERY_LIMIT)
            .map_err(|_| {
                failure(
                    "desktop_discovery_failed",
                    "Cannot serialize desktop discovery",
                )
            })?;
        if !Self::epoch_valid(&lock(&self.gate), epoch, restoring) {
            return Err(failure(
                "desktop_operation_cancelled",
                "Desktop authorization operation was cancelled",
            ));
        }
        // Only the lifecycle writer covers file I/O. Revoke can close the small gate
        // immediately while publication runs; the final epoch check below forbids
        // opening a revoked generation and error cleanup removes its own discovery.
        windows::write_private_atomic(
            &self.directory.join(DISCOVERY_FILE),
            &bytes,
            DISCOVERY_LIMIT,
        )
        .map_err(|_| {
            failure(
                "desktop_discovery_failed",
                "Cannot publish private desktop discovery",
            )
        })?;
        #[cfg(test)]
        if let Some(hook) = lock(&self.after_publish).take() {
            hook();
        }
        let mut gate = lock(&self.gate);
        if !Self::epoch_valid(&gate, epoch, restoring) {
            return Err(failure(
                "desktop_operation_cancelled",
                "Desktop authorization operation was cancelled",
            ));
        }
        gate.revision = authorization.revision;
        gate.keys = keys;
        gate.cancel = cancel.clone();
        gate.open = true;
        for (scope, name, server) in servers {
            let work = Box::pin(super::server::listen(
                Arc::downgrade(self),
                scope,
                name,
                server,
                AuthorizationGeneration {
                    epoch,
                    cancel: cancel.clone(),
                },
            ));
            let writer = life.writer.as_ref().expect("publisher owns writer").clone();
            life.tasks.push(tokio::spawn(ListenerTask {
                work,
                _writer: writer,
            }));
        }
        Ok(())
    }

    /// The first action is synchronous gate closure/cancellation. Persistent failure never
    /// reopens this process. A later explicit connect is required after a revoke attempt.
    pub async fn disconnect(self: &Arc<Self>) -> Result<DesktopStatus, ApiError> {
        let epoch = self.close_for_revoke();
        self.disconnect_attempt(epoch).await
    }

    async fn disconnect_attempt(self: &Arc<Self>, epoch: u64) -> Result<DesktopStatus, ApiError> {
        let _attempt = RevokeAttempt {
            bridge: self,
            epoch,
        };
        let wait_deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        loop {
            let notified = self.cleanup_done.notified();
            if !lock(&self.lifecycle).cleaning {
                break;
            }
            if tokio::time::timeout_at(wait_deadline, notified)
                .await
                .is_err()
            {
                break;
            }
        }
        let persisted = {
            let mut life = lock(&self.lifecycle);
            // A newer revoke can finish and explicitly reconnect while this call
            // waits for cleanup. Only the current attempt may commit or update status.
            if !Self::revoke_current(&lock(&self.gate), epoch) {
                return Err(failure(
                    "desktop_operation_cancelled",
                    "Desktop revocation operation was superseded",
                ));
            }
            let result = if life.cleaning {
                Err(io::Error::other("cleanup in progress"))
            } else {
                self.acquire_writer(&mut life)
                    .map_err(|_| io::Error::other("writer conflict"))
                    .and_then(|_| Authorization::read(&self.directory))
                    .and_then(|existing| {
                        let revision = Authorization::next_revision(existing.as_ref())?;
                        let disabled = Authorization {
                            schema_version: 1,
                            revision,
                            scopes: Vec::new(),
                        };
                        if !Self::revoke_current(&lock(&self.gate), epoch) {
                            return Err(io::Error::new(
                                io::ErrorKind::Interrupted,
                                "revocation superseded",
                            ));
                        }
                        disabled.write(&self.directory)?;
                        if !Self::revoke_current(&lock(&self.gate), epoch) {
                            return Err(io::Error::new(
                                io::ErrorKind::Interrupted,
                                "revocation superseded",
                            ));
                        }
                        life.status.revision = Some(revision);
                        life.status.authorized_scopes.clear();
                        Ok(())
                    })
            };
            if !Self::revoke_current(&lock(&self.gate), epoch) {
                return Err(failure(
                    "desktop_operation_cancelled",
                    "Desktop revocation operation was superseded",
                ));
            }
            life.status.persistent_revoked = result.is_ok();
            if result.is_ok() {
                life.cleanup_keys = true;
                life.status.error = None;
            }
            result.is_ok()
        };
        self.cleanup(persisted, Some(epoch)).await;
        let mut life = lock(&self.lifecycle);
        if !Self::revoke_current(&lock(&self.gate), epoch) {
            return Err(failure(
                "desktop_operation_cancelled",
                "Desktop revocation operation was superseded",
            ));
        }
        if !persisted {
            let error = failure("desktop_revocation_incomplete", "Disconnected in this process, but revocation could not be persisted; restart may restore previous consent. Retry disconnect.");
            life.status.error = Some(desktop_error(&error));
            return Err(error);
        }
        drop(life);
        Ok(self.status())
    }

    fn revoke_current(gate: &Gate, epoch: u64) -> bool {
        gate.epoch == epoch && gate.revoking && !gate.open && !gate.shutting_down
    }

    fn close_for_revoke(&self) -> u64 {
        let mut gate = lock(&self.gate);
        gate.close();
        gate.revoking = true;
        gate.restore_allowed = false;
        gate.epoch
    }

    pub fn begin_shutdown(&self) {
        let mut gate = lock(&self.gate);
        gate.shutting_down = true;
        gate.close();
    }
    /// Runtime cleanup only. User consent survives shutdown. Run alongside AppState::shutdown.
    pub async fn shutdown(self: &Arc<Self>) {
        self.begin_shutdown();
        self.cleanup(false, None).await;
    }

    async fn cleanup(&self, delete_keys: bool, revoke_epoch: Option<u64>) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let mut batch = loop {
            let notified = self.cleanup_done.notified();
            let batch = {
                let mut life = lock(&self.lifecycle);
                let gate = lock(&self.gate);
                if gate.open
                    || revoke_epoch.is_some_and(|epoch| !Self::revoke_current(&gate, epoch))
                {
                    return;
                }
                drop(gate);
                life.cleanup_keys |= delete_keys;
                if life.cleaning {
                    None
                } else {
                    life.cleaning = true;
                    Some(CleanupBatch {
                        bridge: self,
                        tasks: std::mem::take(&mut life.tasks),
                        finished: false,
                    })
                }
            };
            if let Some(batch) = batch {
                break batch;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return;
            }
        };
        // No mutex held while the cancellation-aware listener futures drop all connections.
        let graceful_deadline = deadline - Duration::from_millis(50);
        if tokio::time::timeout_at(
            graceful_deadline,
            futures::future::join_all(batch.tasks.iter_mut()),
        )
        .await
        .is_err()
        {
            for task in &batch.tasks {
                task.abort();
            }
            let _ = tokio::time::timeout_at(
                deadline,
                futures::future::join_all(
                    batch.tasks.iter_mut().filter(|task| !task.is_finished()),
                ),
            )
            .await;
        }
        batch.tasks.retain(|task| !task.is_finished());
        let mut life = lock(&self.lifecycle);
        if !batch.tasks.is_empty() {
            // Keep the exclusive writer until actual handle/permit release, even if the
            // caller's cleanup budget expires. A subsequent cleanup retries the join.
            life.tasks.append(&mut batch.tasks);
            life.status.cleanup_incomplete = true;
        } else if life.writer.is_some() {
            let mut incomplete = self.remove_owned_discovery().is_err();
            if life.cleanup_keys {
                for scope in SCOPES {
                    let path = self.directory.join(key_file(scope));
                    match windows::read_private_bounded(&path, 128) {
                        Ok(_) => {
                            if std::fs::remove_file(&path).is_err() {
                                incomplete = true;
                            }
                        }
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(_) => incomplete = true,
                    }
                }
            }
            life.status.cleanup_incomplete = incomplete;
            life.cleanup_keys = false;
            life.writer = None;
        }
        life.cleaning = false;
        batch.finished = true;
        drop(life);
        self.cleanup_done.notify_waiters();
    }

    fn remove_owned_discovery(&self) -> io::Result<()> {
        let path = self.directory.join(DISCOVERY_FILE);
        let bytes = match windows::read_private_bounded(&path, DISCOVERY_LIMIT) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let record: Discovery = serde_json::from_slice(&bytes)
            .map_err(|_| io::Error::other("invalid discovery during cleanup"))?;
        if record.server_instance_id == self.session {
            std::fs::remove_file(path)?;
        }
        Ok(())
    }

    pub(super) fn listener_failed(&self) {
        lock(&self.gate).close();
        self.record_error(&failure(
            "desktop_listener_failed",
            "Desktop pipe replacement failed; reconnect the source",
        ));
    }
}

impl Drop for DesktopBridge {
    fn drop(&mut self) {
        self.begin_shutdown();
        for task in &lock(&self.lifecycle).tasks {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hertz_desktop_ipc::{Request, Response};
    use serde_json::json;
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt, sync::atomic::Ordering};
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    struct Fixture {
        state: Arc<AppState>,
        bridge: Arc<DesktopBridge>,
        audio: Option<std::thread::JoinHandle<()>>,
        directory: PathBuf,
    }
    impl Fixture {
        async fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("hertz-bridge-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&directory).unwrap();
            let db = vmusic_store::open(&directory).await.unwrap();
            let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
            state.data_dir = directory.clone();
            let state = Arc::new(state);
            let bridge = DesktopBridge::new(&state);
            Self {
                state,
                bridge,
                audio: Some(audio),
                directory,
            }
        }
        fn request(&self, scope: Scope) -> Request {
            Request {
                bridge_protocol: 1,
                request_id: "bridge-test".into(),
                server_instance_id: self.state.server_instance_id().into(),
                scope,
                key: read_key(&self.directory, scope).unwrap().to_string(),
                op: "snapshot".into(),
                params: json!({}),
            }
        }
        fn discovery(&self) -> Discovery {
            serde_json::from_slice(
                &windows::read_private_bounded(
                    &self.directory.join(DISCOVERY_FILE),
                    DISCOVERY_LIMIT,
                )
                .unwrap(),
            )
            .unwrap()
        }
        async fn call(&self, request: &Request) -> Response {
            let discovery = self.discovery();
            let name = match request.scope {
                Scope::Lyrics => discovery.pipes.lyrics.unwrap(),
                Scope::Wallpaper => discovery.pipes.wallpaper.unwrap(),
            };
            windows::request(&name, std::process::id(), request, &Cancellation::new())
                .await
                .unwrap()
        }
        async fn finish(self) {
            self.bridge.shutdown().await;
            self.state.db.close().await;
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.bridge.begin_shutdown();
            self.state.audio.shutdown();
            if let Some(audio) = self.audio.take() {
                audio.join().unwrap();
            }
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn authority_rejects_unknown_duplicate_future_and_overflow_without_defaults() {
        for bytes in [
            r#"{"schemaVersion":1,"revision":0,"scopes":[]}"#,
            r#"{"schemaVersion":2,"revision":1,"scopes":["lyrics"]}"#,
            r#"{"schemaVersion":1,"revision":1,"scopes":["lyrics","lyrics"]}"#,
            r#"{"schemaVersion":1,"revision":1,"scopes":["control"]}"#,
            r#"{"schemaVersion":1,"revision":1,"scopes":[],"enabled":true}"#,
            r#"{"schemaVersion":1,"revision":18446744073709551616,"scopes":[]}"#,
            r#"{"schemaVersion":1,"schemaVersion":1,"revision":1,"scopes":[]}"#,
        ] {
            assert!(Authorization::parse(bytes.as_bytes()).is_err());
        }
        assert!(Authorization::parse(&vec![b' '; 8193]).is_err());
        let last = Authorization {
            schema_version: 1,
            revision: u64::MAX,
            scopes: Vec::new(),
        };
        assert!(Authorization::next_revision(Some(&last)).is_err());
    }

    #[tokio::test]
    async fn no_authority_or_keys_only_creates_no_bridge_artifacts() {
        let fixture = Fixture::new().await;
        assert!(!fixture.bridge.restore().await.unwrap().listener_ready);
        for scope in SCOPES {
            create_key(&fixture.directory, scope).unwrap();
        }
        assert!(!fixture.bridge.restore().await.unwrap().listener_ready);
        assert!(fixture.bridge.capture_generation().is_none());
        for file in [AUTH_FILE, DISCOVERY_FILE, LOCK_FILE] {
            assert!(!fixture.directory.join(file).exists(), "unexpected {file}");
        }
        assert_eq!(fixture.bridge.global_slots.available_permits(), 4);
        for scope in SCOPES {
            std::fs::remove_file(fixture.directory.join(key_file(scope))).unwrap();
        }
        Authorization {
            schema_version: 1,
            revision: 1,
            scopes: SCOPES.to_vec(),
        }
        .write(&fixture.directory)
        .unwrap();
        let unavailable = fixture.bridge.restore().await.unwrap();
        assert_eq!(unavailable.authorized_scopes, SCOPES);
        assert_eq!(unavailable.scope_errors.len(), 2);
        assert!(!unavailable.listener_ready);
        assert!(!fixture.directory.join(LOCK_FILE).exists());
        assert!(!fixture.directory.join(DISCOVERY_FILE).exists());
        fixture.finish().await;
    }

    #[tokio::test]
    async fn invalid_private_and_future_authority_are_preserved_without_lock() {
        let fixture = Fixture::new().await;
        for bytes in [
            b"broken".as_slice(),
            br#"{"schemaVersion":2,"revision":1,"scopes":["lyrics"]}"#.as_slice(),
        ] {
            windows::write_private_atomic(&fixture.directory.join(AUTH_FILE), bytes, 8192).unwrap();
            assert_eq!(
                fixture.bridge.restore().await.unwrap_err().code,
                "desktop_authorization_invalid"
            );
            assert_eq!(
                fixture
                    .bridge
                    .connect_authorization()
                    .await
                    .unwrap_err()
                    .code,
                "desktop_authorization_invalid"
            );
            assert_eq!(
                windows::read_private_bounded(&fixture.directory.join(AUTH_FILE), 8192).unwrap(),
                bytes
            );
            assert!(!fixture.directory.join(LOCK_FILE).exists());
        }
        std::fs::remove_file(fixture.directory.join(AUTH_FILE)).unwrap();
        // Ordinary inherited ACL is rejected even for otherwise valid content.
        std::fs::write(
            fixture.directory.join(AUTH_FILE),
            br#"{"schemaVersion":1,"revision":1,"scopes":["lyrics"]}"#,
        )
        .unwrap();
        assert_eq!(
            fixture.bridge.restore().await.unwrap_err().code,
            "desktop_authorization_invalid"
        );
        assert!(!fixture.directory.join(LOCK_FILE).exists());
        fixture.finish().await;
    }

    #[tokio::test]
    async fn repeat_connect_reuses_keys_revision_listener_and_private_file_acl() {
        let fixture = Fixture::new().await;
        fn directory_acl(path: &std::path::Path) -> String {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::{
                Foundation::LocalFree,
                Security::{
                    Authorization::{
                        ConvertSecurityDescriptorToStringSecurityDescriptorW,
                        GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
                    },
                    DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION,
                    OWNER_SECURITY_INFORMATION,
                },
            };
            let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let flags =
                DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION;
            let mut descriptor = std::ptr::null_mut();
            let mut text = std::ptr::null_mut();
            let mut length = 0;
            unsafe {
                assert_eq!(
                    GetNamedSecurityInfoW(
                        path.as_ptr(),
                        SE_FILE_OBJECT,
                        flags,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        &mut descriptor
                    ),
                    0
                );
                let result = ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    flags,
                    &mut text,
                    &mut length,
                );
                LocalFree(descriptor);
                assert_ne!(result, 0);
                let value =
                    String::from_utf16(std::slice::from_raw_parts(text, length as usize)).unwrap();
                LocalFree(text.cast());
                value
            }
        }
        let directory_acl_before = directory_acl(&fixture.directory);
        let first = fixture.bridge.connect_authorization().await.unwrap();
        assert_eq!(first.authorized_scopes, SCOPES);
        assert_eq!(first.active_scopes, SCOPES);
        let discovery =
            windows::read_private_bounded(&fixture.directory.join(DISCOVERY_FILE), DISCOVERY_LIMIT)
                .unwrap();
        let auth = windows::read_private_bounded(&fixture.directory.join(AUTH_FILE), 8192).unwrap();
        let keys = SCOPES.map(|scope| read_key(&fixture.directory, scope).unwrap());
        let generation = fixture.bridge.capture_generation().unwrap();
        let again = fixture.bridge.connect_authorization().await.unwrap();
        assert_eq!(first.revision, again.revision);
        assert!(fixture.bridge.is_current(&generation));
        assert_eq!(
            discovery,
            windows::read_private_bounded(&fixture.directory.join(DISCOVERY_FILE), DISCOVERY_LIMIT)
                .unwrap()
        );
        assert_eq!(
            auth,
            windows::read_private_bounded(&fixture.directory.join(AUTH_FILE), 8192).unwrap()
        );
        for scope in SCOPES {
            assert!(equal_key(
                &keys[index(scope)],
                &read_key(&fixture.directory, scope).unwrap()
            ));
        }
        assert_eq!(directory_acl_before, directory_acl(&fixture.directory));
        let public = serde_json::to_string(&again).unwrap();
        for key in keys {
            assert!(!public.contains(key.as_str()));
        }
        fixture.finish().await;
    }

    #[tokio::test]
    async fn restore_missing_key_reports_partial_then_explicit_connect_repairs_it() {
        let fixture = Fixture::new().await;
        fixture.bridge.connect_authorization().await.unwrap();
        let lyric_key = read_key(&fixture.directory, Scope::Lyrics).unwrap();
        fixture.bridge.shutdown().await;
        std::fs::remove_file(fixture.directory.join(key_file(Scope::Wallpaper))).unwrap();
        let bridge = DesktopBridge::new(&fixture.state);
        let partial = bridge.restore().await.unwrap();
        assert_eq!(partial.authorized_scopes, SCOPES);
        assert_eq!(partial.active_scopes, [Scope::Lyrics]);
        assert_eq!(partial.scope_errors.len(), 1);
        assert!(fixture.discovery().pipes.wallpaper.is_none());
        assert!(!fixture.directory.join(key_file(Scope::Wallpaper)).exists());
        let repaired = bridge.connect_authorization().await.unwrap();
        assert_eq!(repaired.active_scopes, SCOPES);
        assert!(equal_key(
            &lyric_key,
            &read_key(&fixture.directory, Scope::Lyrics).unwrap()
        ));
        bridge.shutdown().await;
        fixture.finish().await;
    }

    #[tokio::test]
    async fn full_restore_uses_new_app_session_and_shutdown_preserves_newer_discovery() {
        let fixture = Fixture::new().await;
        let authorized = fixture.bridge.connect_authorization().await.unwrap();
        fixture.bridge.shutdown().await;
        assert_eq!(
            Authorization::read(&fixture.directory)
                .unwrap()
                .unwrap()
                .revision,
            authorized.revision.unwrap()
        );
        let (mut state, audio) =
            crate::state::tests::playback_state_with_db(fixture.state.db.clone()).await;
        state.data_dir = fixture.directory.clone();
        let state = Arc::new(state);
        let bridge = DesktopBridge::new(&state);
        let restored = bridge.restore().await.unwrap();
        assert_eq!(restored.active_scopes, SCOPES);
        let mut discovery = fixture.discovery();
        assert_eq!(discovery.server_instance_id, state.server_instance_id());
        assert_ne!(
            discovery.server_instance_id,
            fixture.state.server_instance_id()
        );
        // Simulate a replacement publisher's record. Cleanup may delete only its own
        // session, even if an external replacement ignores our writer lock.
        discovery.server_instance_id = uuid::Uuid::new_v4().to_string();
        let bytes = serde_json::to_vec(&discovery).unwrap();
        windows::write_private_atomic(
            &fixture.directory.join(DISCOVERY_FILE),
            &bytes,
            DISCOVERY_LIMIT,
        )
        .unwrap();
        bridge.shutdown().await;
        assert_eq!(
            windows::read_private_bounded(&fixture.directory.join(DISCOVERY_FILE), DISCOVERY_LIMIT)
                .unwrap(),
            bytes
        );
        assert!(!Authorization::read(&fixture.directory)
            .unwrap()
            .unwrap()
            .scopes
            .is_empty());
        state.audio.shutdown();
        audio.join().unwrap();
        fixture.finish().await;
    }

    #[tokio::test]
    async fn abort_keeps_writer_exclusive_until_actual_listener_handle_drop() {
        let fixture = Fixture::new().await;
        let bridge = DesktopBridge::new(&fixture.state);
        bridge.connect_authorization().await.unwrap();
        let weak = Arc::downgrade(&bridge);
        drop(bridge);
        assert!(weak.upgrade().is_none());
        // The current-thread runtime has not polled the aborted listener tasks yet.
        // Their actual pipe handles still exist, so the directory must remain exclusive.
        let replacement = DesktopBridge::new(&fixture.state);
        assert_eq!(
            replacement.restore().await.unwrap_err().code,
            "desktop_source_conflict"
        );
        tokio::task::yield_now().await;
        assert!(replacement.restore().await.unwrap().listener_ready);
        replacement.shutdown().await;
        fixture.finish().await;
    }

    #[tokio::test]
    async fn revoke_then_restart_ignores_residual_keys_and_old_generations() {
        let fixture = Fixture::new().await;
        fixture.bridge.connect_authorization().await.unwrap();
        let old = fixture.bridge.capture_generation().unwrap();
        let revoked = fixture.bridge.disconnect().await.unwrap();
        assert!(revoked.persistent_revoked && !revoked.listener_ready);
        assert!(old.is_cancelled() && !fixture.bridge.is_current(&old));
        assert!(fixture.bridge.restore().await.is_err());
        for scope in SCOPES {
            create_key(&fixture.directory, scope).unwrap();
        }
        let restarted = DesktopBridge::new(&fixture.state);
        let status = restarted.restore().await.unwrap();
        assert!(status.persistent_revoked && !status.listener_ready);
        assert!(!fixture.directory.join(DISCOVERY_FILE).exists());
        let reauthorized = fixture.bridge.connect_authorization().await.unwrap();
        assert!(reauthorized.listener_ready && reauthorized.revision > revoked.revision);
        assert!(!fixture.bridge.is_current(&old));
        restarted.shutdown().await;
        fixture.finish().await;
    }

    #[tokio::test]
    async fn failed_revocation_stays_closed_and_retry_persists_disable() {
        let fixture = Fixture::new().await;
        fixture.bridge.connect_authorization().await.unwrap();
        let before = fixture.bridge.capture_generation().unwrap();
        let busy_auth = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(fixture.directory.join(AUTH_FILE))
            .unwrap();
        let error = fixture.bridge.disconnect().await.unwrap_err();
        assert_eq!(error.code, "desktop_revocation_incomplete");
        assert!(!fixture.bridge.status().persistent_revoked);
        assert!(!fixture.bridge.status().listener_ready);
        assert!(before.is_cancelled());
        assert!(!Authorization::read(&fixture.directory)
            .unwrap()
            .unwrap()
            .scopes
            .is_empty());
        assert!(fixture.bridge.restore().await.is_err());
        drop(busy_auth);
        assert!(
            fixture
                .bridge
                .disconnect()
                .await
                .unwrap()
                .persistent_revoked
        );
        assert!(Authorization::read(&fixture.directory)
            .unwrap()
            .unwrap()
            .scopes
            .is_empty());
        fixture.finish().await;
    }

    #[tokio::test]
    async fn failed_key_cleanup_is_distinct_from_persistent_revocation() {
        let fixture = Fixture::new().await;
        fixture.bridge.connect_authorization().await.unwrap();
        let busy_key = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(fixture.directory.join(key_file(Scope::Lyrics)))
            .unwrap();
        let status = fixture.bridge.disconnect().await.unwrap();
        assert!(status.persistent_revoked && status.cleanup_incomplete);
        assert!(fixture.directory.join(key_file(Scope::Lyrics)).exists());
        let restarted = DesktopBridge::new(&fixture.state);
        assert!(!restarted.restore().await.unwrap().listener_ready);
        drop(busy_key);
        assert!(
            !fixture
                .bridge
                .disconnect()
                .await
                .unwrap()
                .cleanup_incomplete
        );
        restarted.shutdown().await;
        fixture.finish().await;
    }

    #[tokio::test]
    async fn canonical_directory_conflict_preserves_live_discovery_and_basic_state() {
        let fixture = Fixture::new().await;
        fixture.bridge.connect_authorization().await.unwrap();
        let discovery =
            windows::read_private_bounded(&fixture.directory.join(DISCOVERY_FILE), DISCOVERY_LIMIT)
                .unwrap();
        let (mut second_state, second_audio) =
            crate::state::tests::playback_state_with_db(fixture.state.db.clone()).await;
        second_state.data_dir = fixture.directory.join(".");
        let second_state = Arc::new(second_state);
        let second = DesktopBridge::new(&second_state);
        assert_eq!(fixture.bridge.profile(), second.profile());
        assert_eq!(
            second.restore().await.unwrap_err().code,
            "desktop_source_conflict"
        );
        assert!(second_state.audio.snapshot().track_id.is_none());
        second.shutdown().await;
        assert_eq!(
            discovery,
            windows::read_private_bounded(&fixture.directory.join(DISCOVERY_FILE), DISCOVERY_LIMIT)
                .unwrap()
        );
        assert!(fixture.bridge.status().listener_ready);
        second_state.audio.shutdown();
        second_audio.join().unwrap();
        fixture.finish().await;
    }

    #[tokio::test]
    async fn stale_activation_and_send_admission_cannot_cross_revoke_gate() {
        let fixture = Fixture::new().await;
        let old_restore = fixture.bridge.operation_epoch(true).unwrap();
        let old_connect = fixture.bridge.operation_epoch(false).unwrap();
        fixture.bridge.disconnect().await.unwrap();
        assert_eq!(
            fixture.bridge.activate(old_restore, true).unwrap_err().code,
            "desktop_operation_cancelled"
        );
        assert_eq!(
            fixture
                .bridge
                .activate(old_connect, false)
                .unwrap_err()
                .code,
            "desktop_operation_cancelled"
        );
        assert!(!fixture.directory.join(DISCOVERY_FILE).exists());
        fixture.bridge.connect_authorization().await.unwrap();
        let generation = fixture.bridge.capture_generation().unwrap();
        let response = Response {
            bridge_protocol: 1,
            request_id: "registered".into(),
            server_instance_id: fixture.bridge.session.clone(),
            status: 200,
            body: json!({}),
        };
        let registration = fixture
            .bridge
            .register_send(Scope::Lyrics, &generation, &response, None)
            .unwrap();
        assert_eq!(lock(&fixture.bridge.gate).senders.len(), 1);
        fixture.bridge.close_for_revoke();
        assert!(generation.is_cancelled());
        assert!(fixture
            .bridge
            .register_send(Scope::Lyrics, &generation, &response, None)
            .is_err());
        drop(registration);
        assert!(lock(&fixture.bridge.gate).senders.is_empty());
        fixture.bridge.disconnect().await.unwrap();
        fixture.finish().await;
    }

    #[tokio::test]
    async fn older_disconnect_cannot_overwrite_newer_revoke_and_explicit_connect() {
        let fixture = Fixture::new().await;
        fixture.bridge.connect_authorization().await.unwrap();
        lock(&fixture.bridge.gate).close();
        let mut cleaning = Box::pin(fixture.bridge.cleanup(false, None));
        assert!(futures::poll!(&mut cleaning).is_pending());
        // A captures its epoch and suspends behind the in-progress cleanup.
        let mut older = Box::pin(fixture.bridge.disconnect());
        assert!(futures::poll!(&mut older).is_pending());
        drop(cleaning);
        // B fully revokes, then C explicitly grants fresh consent before A resumes.
        fixture.bridge.disconnect().await.unwrap();
        fixture.bridge.connect_authorization().await.unwrap();
        let generation = fixture.bridge.capture_generation().unwrap();
        let auth = windows::read_private_bounded(&fixture.directory.join(AUTH_FILE), 8192).unwrap();
        let discovery =
            windows::read_private_bounded(&fixture.directory.join(DISCOVERY_FILE), DISCOVERY_LIMIT)
                .unwrap();
        let keys = SCOPES.map(|scope| read_key(&fixture.directory, scope).unwrap());
        let status = serde_json::to_value(fixture.bridge.status()).unwrap();
        assert_eq!(older.await.unwrap_err().code, "desktop_operation_cancelled");
        assert_eq!(
            auth,
            windows::read_private_bounded(&fixture.directory.join(AUTH_FILE), 8192).unwrap()
        );
        assert_eq!(
            discovery,
            windows::read_private_bounded(&fixture.directory.join(DISCOVERY_FILE), DISCOVERY_LIMIT)
                .unwrap()
        );
        for scope in SCOPES {
            assert!(equal_key(
                &keys[index(scope)],
                &read_key(&fixture.directory, scope).unwrap()
            ));
        }
        assert_eq!(
            status,
            serde_json::to_value(fixture.bridge.status()).unwrap()
        );
        assert!(fixture.bridge.is_current(&generation));
        fixture.finish().await;
    }

    #[tokio::test]
    async fn stale_activation_error_preserves_new_successful_connection_status() {
        let fixture = Fixture::new().await;
        let old_epoch = fixture.bridge.operation_epoch(false).unwrap();
        fixture.bridge.disconnect().await.unwrap();
        fixture.bridge.connect_authorization().await.unwrap();
        let generation = fixture.bridge.capture_generation().unwrap();
        let current_status = serde_json::to_value(fixture.bridge.status()).unwrap();
        assert!(current_status["error"].is_null());
        for restoring in [false, true] {
            assert_eq!(
                fixture
                    .bridge
                    .activate(old_epoch, restoring)
                    .unwrap_err()
                    .code,
                "desktop_operation_cancelled"
            );
            assert_eq!(
                current_status,
                serde_json::to_value(fixture.bridge.status()).unwrap()
            );
            assert!(fixture.bridge.is_current(&generation));
        }
        fixture.finish().await;
    }

    #[tokio::test]
    async fn cancelled_cleanup_returns_handles_clears_marker_and_notifies_retry() {
        let fixture = Fixture::new().await;
        fixture.bridge.connect_authorization().await.unwrap();
        lock(&fixture.bridge.gate).close();
        let mut cleaning = Box::pin(fixture.bridge.cleanup(false, None));
        assert!(futures::poll!(&mut cleaning).is_pending());
        {
            let life = lock(&fixture.bridge.lifecycle);
            assert!(life.cleaning && life.tasks.is_empty() && life.writer.is_some());
        }
        let mut notified = Box::pin(fixture.bridge.cleanup_done.notified());
        assert!(futures::poll!(&mut notified).is_pending());
        drop(cleaning);
        assert!(futures::poll!(&mut notified).is_ready());
        drop(notified);
        {
            let life = lock(&fixture.bridge.lifecycle);
            assert!(!life.cleaning && life.tasks.len() == 2 && life.writer.is_some());
            assert!(life.status.cleanup_incomplete);
        }
        // Listener futures have not run on this current-thread runtime: the actual
        // pipe handles and their writer leases remain owned until the retry drains them.
        let competitor = DesktopBridge::new(&fixture.state);
        assert_eq!(
            competitor.restore().await.unwrap_err().code,
            "desktop_source_conflict"
        );
        assert!(
            fixture
                .bridge
                .connect_authorization()
                .await
                .unwrap()
                .listener_ready
        );
        fixture.finish().await;
    }

    #[tokio::test]
    async fn cancelled_disconnect_keeps_gate_closed_but_allows_explicit_retry() {
        let fixture = Fixture::new().await;
        fixture.bridge.connect_authorization().await.unwrap();
        let mut disconnecting = Box::pin(fixture.bridge.disconnect());
        assert!(futures::poll!(&mut disconnecting).is_pending());
        assert!(lock(&fixture.bridge.lifecycle).cleaning);
        assert!(lock(&fixture.bridge.gate).revoking);
        drop(disconnecting);
        {
            let gate = lock(&fixture.bridge.gate);
            assert!(!gate.open && !gate.revoking && !gate.restore_allowed);
        }
        assert!(!lock(&fixture.bridge.lifecycle).cleaning);
        assert!(fixture.bridge.status().persistent_revoked);
        assert!(fixture.bridge.restore().await.is_err());
        assert!(
            fixture
                .bridge
                .connect_authorization()
                .await
                .unwrap()
                .listener_ready
        );
        fixture.finish().await;
    }

    #[tokio::test]
    async fn revoke_between_persist_and_publication_cancels_old_connect() {
        let fixture = Fixture::new().await;
        let weak = Arc::downgrade(&fixture.bridge);
        *lock(&fixture.bridge.before_publish) = Some(Box::new(move || {
            weak.upgrade().unwrap().close_for_revoke();
        }));
        assert_eq!(
            fixture
                .bridge
                .connect_authorization()
                .await
                .unwrap_err()
                .code,
            "desktop_operation_cancelled"
        );
        assert!(!fixture.bridge.status().listener_ready);
        assert!(!fixture.directory.join(DISCOVERY_FILE).exists());
        fixture.bridge.disconnect().await.unwrap();
        lock(&fixture.bridge.gate).revoking = false;
        let weak = Arc::downgrade(&fixture.bridge);
        *lock(&fixture.bridge.after_publish) = Some(Box::new(move || {
            // This can run while publication owns the lifecycle writer: closing gate
            // must never wait for that writer or private-file I/O.
            weak.upgrade().unwrap().close_for_revoke();
        }));
        assert_eq!(
            fixture
                .bridge
                .connect_authorization()
                .await
                .unwrap_err()
                .code,
            "desktop_operation_cancelled"
        );
        assert!(!fixture.bridge.status().listener_ready);
        assert!(!fixture.directory.join(DISCOVERY_FILE).exists());
        fixture.bridge.disconnect().await.unwrap();
        fixture.finish().await;
    }

    #[tokio::test]
    async fn invalid_request_does_not_enter_projection_and_key_changes_block_send() {
        let fixture = Fixture::new().await;
        fixture.bridge.connect_authorization().await.unwrap();
        let generation = fixture.bridge.capture_generation().unwrap();
        let request = fixture.request(Scope::Lyrics);
        let mut bad = Vec::new();
        let mut wrong = request.clone();
        wrong.scope = Scope::Wallpaper;
        bad.push(wrong);
        let mut wrong = request.clone();
        wrong.key = "0".repeat(64);
        bad.push(wrong);
        let mut wrong = request.clone();
        wrong.server_instance_id = uuid::Uuid::new_v4().to_string();
        bad.push(wrong);
        let mut wrong = request.clone();
        wrong.op = "play".into();
        bad.push(wrong);
        let mut wrong = request.clone();
        wrong.bridge_protocol = 2;
        bad.push(wrong);
        let mut wrong = request.clone();
        wrong.params = json!({"path":"C:/private"});
        bad.push(wrong);
        for request in bad {
            let response = fixture
                .bridge
                .handle_request(Scope::Lyrics, &generation, &request, &Mutex::new(None))
                .await;
            assert!(response.status >= 400);
            assert!(response.body.get("track").is_none());
            assert!(response.body["error"]["request_id"].is_string());
        }
        assert_eq!(fixture.bridge.projection_calls.load(Ordering::SeqCst), 0);
        let response = fixture
            .bridge
            .handle_request(Scope::Lyrics, &generation, &request, &Mutex::new(None))
            .await;
        assert_eq!(response.status, 200);
        std::fs::remove_file(fixture.directory.join(key_file(Scope::Lyrics))).unwrap();
        assert!(fixture
            .bridge
            .register_send(Scope::Lyrics, &generation, &response, Some(&request.key))
            .is_err());
        create_key(&fixture.directory, Scope::Lyrics).unwrap();
        assert!(fixture
            .bridge
            .register_send(Scope::Lyrics, &generation, &response, Some(&request.key))
            .is_err());
        fixture.finish().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_pipe_snapshots_and_business_document_errors_keep_existing_projection_semantics() {
        let fixture = Fixture::new().await;
        fixture.bridge.connect_authorization().await.unwrap();
        let response = fixture.call(&fixture.request(Scope::Lyrics)).await;
        assert_eq!(response.status, 200);
        assert_eq!(
            response.body["server"]["session"],
            fixture.state.server_instance_id()
        );
        assert_eq!(response.body["lyrics"]["status"], "idle");
        let wallpaper = fixture.call(&fixture.request(Scope::Wallpaper)).await;
        let expected = crate::wallpaper::snapshot(&fixture.state).await;
        assert_eq!(wallpaper.status, 200);
        assert_eq!(wallpaper.body["server"], expected["server"]);
        assert_eq!(wallpaper.body["space"], expected["space"]);
        let mut document = fixture.request(Scope::Lyrics);
        document.op = "document".into();
        document.params = json!({"key":"stale-document"});
        let result = fixture.call(&document).await;
        let original = crate::desktop_lyrics::document(&fixture.state, "stale-document")
            .await
            .unwrap_err();
        assert_eq!(result.status, original.status.as_u16());
        assert_eq!(result.body["error"]["code"], original.code);
        sqlx::query("INSERT INTO tracks(id,path,title,added_at,updated_at) VALUES('bridge-local','bridge-local.wav','Local fixture',0,0)")
            .execute(&fixture.state.db).await.unwrap();
        vmusic_store::lyrics::import(
            &fixture.state.db,
            "bridge-local",
            "[00:01.00]Local phrase\n[00:02.00]Second phrase",
        )
        .await
        .unwrap();
        vmusic_store::lyrics::set_offset(&fixture.state.db, "bridge-local", 250)
            .await
            .unwrap();
        fixture
            .state
            .audio
            .load("bridge-local.wav", Some("bridge-local".into()))
            .await
            .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let key = loop {
            let response = fixture.call(&fixture.request(Scope::Lyrics)).await;
            assert_eq!(response.body["track"]["title"], "Local fixture");
            if let Some(key) = response.body["lyrics"]["documentKey"].as_str() {
                break key.to_owned();
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "local projection did not become ready"
            );
            tokio::task::yield_now().await;
        };
        document.params = json!({"key":key});
        let result = fixture.call(&document).await;
        assert_eq!(result.status, 200);
        assert_eq!(
            result.body,
            crate::desktop_lyrics::document(&fixture.state, &key)
                .await
                .unwrap()
        );
        assert_eq!(result.body["lines"][0]["text"], "Local phrase");
        assert_eq!(result.body["lines"][0]["startMs"], 1250);
        fixture.finish().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn slow_clients_are_bounded_cancelled_and_release_all_permits() {
        let fixture = Fixture::new().await;
        fixture.bridge.connect_authorization().await.unwrap();
        let name = fixture.discovery().pipes.lyrics.unwrap();
        let mut clients = Vec::new();
        for _ in 0..3 {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
            loop {
                match tokio::net::windows::named_pipe::ClientOptions::new().open(&name) {
                    Ok(client) => {
                        clients.push(client);
                        break;
                    }
                    Err(_) if tokio::time::Instant::now() < deadline => {
                        tokio::task::yield_now().await
                    }
                    Err(error) => panic!("client could not connect: {error}"),
                }
            }
            // Wait for pipe acceptance via resource ownership, never by a timing grace period.
            tokio::task::yield_now().await;
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        while fixture.bridge.global_slots.available_permits() != 2
            && tokio::time::Instant::now() < deadline
        {
            tokio::task::yield_now().await;
        }
        assert_eq!(fixture.bridge.global_slots.available_permits(), 2);
        let started = tokio::time::Instant::now();
        fixture.bridge.disconnect().await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(fixture.bridge.global_slots.available_permits(), 4);
        assert!(!fixture.directory.join(DISCOVERY_FILE).exists());
        drop(clients);
        fixture.finish().await;
    }
}
