// SPDX-License-Identifier: MIT
//! Coalesced explicit operations. No state mutex crosses management I/O or bridge waits.
use super::super::{
    api_error, error, Capabilities, DesktopError, OperationResult, SourceScopes, Tab,
};
use super::{
    check, detect, io_error, lock, protocol, worker, Authority, Completion, Desktop, Environment,
    Flight, TOTAL,
};
use futures::FutureExt;
use hertz_desktop_ipc::{management, windows::Cancellation};
use serde_json::{json, Value};
use std::{
    io,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::OwnedSemaphorePermit;
impl Desktop {
    fn flight(self: &Arc<Self>, connect: Option<Tab>) -> Arc<Flight> {
        let mut operations = lock(&self.runtime.operations);
        let previous = if connect.is_some() {
            &operations.connect
        } else {
            &operations.refresh
        };
        if let Some(flight) = previous.upgrade().filter(|f| !f.cancel.is_cancelled()) {
            return flight;
        }
        operations.next_id = operations.next_id.wrapping_add(1);
        let (id, epoch) = (operations.next_id, operations.epoch);
        let desktop = self.clone();
        let cancel = Cancellation::new();
        let work_cancel = cancel.clone();
        let deadline = Instant::now() + TOTAL;
        // Admission is captured now, BEFORE the compatibility probe or any await.
        let admission = self.bridge.get().map(|bridge| bridge.admission());
        let future = async move {
            desktop
                .run(epoch, id, connect, admission, work_cancel, deadline)
                .await
        }
        .boxed()
        .shared();
        let flight = Arc::new(Flight { future, cancel });
        if connect.is_some() {
            operations.connect = Arc::downgrade(&flight);
            operations.connect_cancel = Some(flight.cancel.clone());
        } else {
            operations.refresh = Arc::downgrade(&flight);
            operations.refresh_cancel = Some(flight.cancel.clone());
        }
        flight
    }
    pub(in crate::desktop) async fn refresh(self: &Arc<Self>) -> Capabilities {
        let flight = self.flight(None);
        let completion = flight.future.clone().await;
        self.finish(completion).capabilities
    }
    pub(in crate::desktop) async fn connect_windows(self: &Arc<Self>, tab: Tab) -> OperationResult {
        let flight = self.flight(Some(tab));
        let completion = flight.future.clone().await;
        self.finish(completion)
    }
    pub(super) fn finish(&self, completion: Completion) -> OperationResult {
        let mut capabilities = self.cached();
        let current = lock(&self.runtime.operations).epoch == completion.epoch
            && completion
                .authority
                .as_ref()
                .is_none_or(|authority| authority.is_current(self));
        if !current {
            capabilities = self.cached();
            let failure = error(
                "desktop_operation_cancelled",
                "Desktop intent or authorization was superseded",
            );
            capabilities.error = Some(failure.clone());
            return OperationResult {
                ok: false,
                error: Some(failure),
                center_opened: false,
                capabilities,
            };
        }
        if let Some((native, observed)) = completion.native {
            // Native reports booleans, not scope ages. Do not extend native's freshness window
            // by caching true; only this live response can confirm a source. Under scheduling
            // delay we conservatively report unconfirmed as well.
            if observed.elapsed() < Duration::from_millis(50) && capabilities.authorization.gate {
                if let Some(source) = capabilities.source.as_ref() {
                    let scopes = protocol::scopes(&native, source);
                    capabilities.source_scopes = SourceScopes {
                        lyrics: scopes.lyrics
                            && capabilities
                                .authorization
                                .scopes
                                .contains(&hertz_desktop_ipc::Scope::Lyrics),
                        wallpaper: scopes.wallpaper
                            && capabilities
                                .authorization
                                .scopes
                                .contains(&hertz_desktop_ipc::Scope::Wallpaper),
                    };
                    capabilities.source_connected =
                        capabilities.source_scopes.lyrics || capabilities.source_scopes.wallpaper;
                }
            }
        }
        OperationResult {
            ok: completion.error.is_none(),
            error: completion.error,
            center_opened: completion.center_opened,
            capabilities,
        }
    }
    async fn permit(
        &self,
        cancel: &Cancellation,
        deadline: Instant,
        admission: Option<&Cancellation>,
    ) -> Result<OwnedSemaphorePermit, DesktopError> {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(io_error(&io::Error::from(io::ErrorKind::Interrupted))),
            _ = async { match admission { Some(cancel) => cancel.cancelled().await, None => std::future::pending().await } } => Err(io_error(&io::Error::from(io::ErrorKind::Interrupted))),
            _ = tokio::time::sleep_until(deadline.into()) => Err(io_error(&io::Error::from(io::ErrorKind::TimedOut))),
            permit = self.runtime.slot.clone().acquire_owned() => permit.map_err(|_| error("desktop_unavailable", "Desktop operation budget is closed")),
        }
    }
    async fn request(
        &self,
        environment: &Environment,
        payload: Value,
        cancel: &Cancellation,
        deadline: Instant,
        authority: Option<&Authority>,
    ) -> Result<Value, DesktopError> {
        check(cancel, deadline).map_err(|e| io_error(&e))?;
        if authority.is_some_and(|authority| !authority.is_current(self)) {
            return Err(error(
                "desktop_operation_cancelled",
                "Desktop management authority was superseded",
            ));
        }
        let name = environment.pipe.clone();
        let worker_cancel = cancel.clone();
        let worker = worker::Worker::start(cancel.clone(), move || {
            management::request_until(&name, &payload, &worker_cancel, Some(deadline))
        })
        .map_err(|e| io_error(&e))?;
        let result = if let Some(authority) = authority {
            tokio::select! { biased;
                _ = authority.cancelled() => return Err(error("desktop_operation_cancelled", "Desktop admission or authorization was revoked during management I/O")),
                result = worker => result,
            }
        } else {
            worker.await
        };
        result.map_err(|e| io_error(&e))?.map_err(|e| io_error(&e))
    }
    async fn run(
        self: Arc<Self>,
        epoch: u64,
        id: u64,
        tab: Option<Tab>,
        admission: Option<Result<(u64, Cancellation), crate::error::ApiError>>,
        cancel: Cancellation,
        deadline: Instant,
    ) -> Completion {
        let mut completion = Completion {
            epoch,
            error: None,
            center_opened: false,
            authority: None,
            native: None,
        };
        completion.error = self
            .run_inner(
                epoch,
                id,
                tab,
                admission,
                &cancel,
                deadline,
                &mut completion,
            )
            .await
            .err();
        if let Some(failure) = &completion.error {
            self.runtime
                .publish_error(&self, epoch, id, completion.authority.clone(), failure);
        }
        completion
    }
    #[allow(clippy::too_many_arguments)]
    async fn run_inner(
        self: &Arc<Self>,
        epoch: u64,
        id: u64,
        tab: Option<Tab>,
        admission: Option<Result<(u64, Cancellation), crate::error::ApiError>>,
        cancel: &Cancellation,
        deadline: Instant,
        completion: &mut Completion,
    ) -> Result<(), DesktopError> {
        if tab.is_some() && self.bridge.get().is_none() {
            return Err(error(
                "desktop_dbx_required",
                "Desktop source authorization requires a DBX sidecar",
            ));
        }
        let admission = admission.transpose().map_err(|e| api_error(&e))?;
        completion.authority = admission
            .as_ref()
            .map(|(epoch, cancel)| Authority::Admission {
                epoch: *epoch,
                cancel: cancel.clone(),
            });
        let _permit = self
            .permit(
                cancel,
                deadline,
                admission.as_ref().map(|(_, cancel)| cancel),
            )
            .await?;
        self.runtime.current(epoch, cancel)?;
        let environment = self.runtime.environment();
        let worker_environment = environment.clone();
        let worker_cancel = cancel.clone();
        let worker = worker::Worker::start(cancel.clone(), move || {
            detect(&worker_environment, &worker_cancel, deadline)
        })
        .map_err(|e| io_error(&e))?;
        let detection = if let Some((_, admission_cancel)) = &admission {
            tokio::select! { biased;
                _ = admission_cancel.cancelled() => return Err(error("desktop_operation_cancelled", "Desktop admission was revoked during detection")),
                result = worker => result,
            }
        } else { worker.await }.map_err(|e| io_error(&e))??;
        self.runtime.current(epoch, cancel)?;
        if let Some(bridge) = self.bridge.get() {
            if !admission
                .as_ref()
                .is_some_and(|(epoch, _)| bridge.admission_current(*epoch))
            {
                return Err(error(
                    "desktop_operation_cancelled",
                    "Desktop admission was revoked during detection",
                ));
            }
        }
        self.runtime
            .publish(self, epoch, id, &detection, completion.authority.clone());
        if !detection.running {
            return Err(detection.error.expect("non-running diagnostic"));
        }
        let Some(bridge) = self.bridge.get() else {
            return Ok(());
        };
        let target = bridge.profile().ok_or_else(|| {
            error(
                "desktop_profile_invalid",
                "Cannot identify this DBX desktop source",
            )
        })?;
        if let Some(tab) = tab {
            check(cancel, deadline).map_err(|e| io_error(&e))?;
            bridge
                .connect_authorization_at(admission.expect("DBX admission").0)
                .await
                .map_err(|e| api_error(&e))?;
            self.runtime.current(epoch, cancel)?;
            let generation = bridge.capture_generation().ok_or_else(|| {
                error(
                    "desktop_listener_failed",
                    "Desktop authorization has no active listener",
                )
            })?;
            // Scope repair may legitimately close the old gate. After authorization succeeds,
            // only its new generation governs I/O and publication, never the old admission.
            completion.authority = Some(Authority::Authorized(generation));
            self.validate_current(epoch, cancel, completion.authority.as_ref())?;
            let (request_id, payload) =
                protocol::envelope(&target, "open-center", json!({"tab":tab.name()}));
            let response = self
                .request(
                    &environment,
                    payload,
                    cancel,
                    deadline,
                    completion.authority.as_ref(),
                )
                .await?;
            self.validate_current(epoch, cancel, completion.authority.as_ref())?;
            protocol::validate(&response, &request_id, &target)?;
            completion.center_opened = true;
        } else {
            if let Some(generation) = bridge.capture_generation() {
                completion.authority = Some(Authority::Authorized(generation));
            }
        }
        self.validate_current(epoch, cancel, completion.authority.as_ref())?;
        let (request_id, payload) = protocol::envelope(&target, "status", Value::Null);
        let response = self
            .request(
                &environment,
                payload,
                cancel,
                deadline,
                completion.authority.as_ref(),
            )
            .await?;
        self.validate_current(epoch, cancel, completion.authority.as_ref())?;
        protocol::validate(&response, &request_id, &target)?;
        self.runtime
            .publish(self, epoch, id, &detection, completion.authority.clone());
        completion.native = Some((response, Instant::now()));
        Ok(())
    }
    fn validate_current(
        &self,
        epoch: u64,
        cancel: &Cancellation,
        authority: Option<&Authority>,
    ) -> Result<(), DesktopError> {
        self.runtime.current(epoch, cancel)?;
        if authority.is_some_and(|authority| !authority.is_current(self)) {
            return Err(error(
                "desktop_operation_cancelled",
                "Desktop authorization was revoked during management I/O",
            ));
        }
        Ok(())
    }
}
