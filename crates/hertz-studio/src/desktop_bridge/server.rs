// SPDX-License-Identifier: MIT
use super::{
    authorization::*,
    lifecycle::{lock, AuthorizationGeneration},
    DesktopBridge,
};
use crate::error::{ApiError, ErrorBody, ErrorDetail};
use axum::http::StatusCode;
use futures::{future::BoxFuture, stream::FuturesUnordered, StreamExt};
use hertz_desktop_ipc::{windows, Request, Response, Scope, BRIDGE_PROTOCOL};
use std::{
    io,
    sync::{Arc, Mutex, Weak},
};
use tokio::{net::windows::named_pipe::NamedPipeServer, sync::Semaphore};
use zeroize::Zeroizing;

pub(super) async fn listen(
    bridge: Weak<DesktopBridge>,
    scope: Scope,
    name: String,
    server: NamedPipeServer,
    generation: AuthorizationGeneration,
) {
    let slots = Arc::new(Semaphore::new(2));
    // Connections are futures owned by the listener, not detached spawned tasks. Dropping
    // the collection closes every overlapped pipe before returning all resource permits.
    let mut clients: FuturesUnordered<BoxFuture<'static, ()>> = FuturesUnordered::new();
    let mut pending = Box::pin(windows::accept(server, &generation.cancel));
    loop {
        let connection = tokio::select! {
            biased;
            _ = generation.cancel.cancelled() => break,
            _ = clients.next(), if !clients.is_empty() => continue,
            connection = &mut pending => match connection {
                Ok(connection) => connection,
                Err(_) => {
                    if !generation.cancel.is_cancelled() {
                        if let Some(bridge) = bridge.upgrade() { bridge.listener_failed(); }
                    }
                    break;
                }
            },
        };
        // Preserve an existing instance while reserving its replacement. first_instance
        // is used once, before discovery publication, never during replacement.
        let server = match windows::create_server(&name, false) {
            Ok(server) => server,
            Err(_) => {
                if let Some(bridge) = bridge.upgrade() {
                    bridge.listener_failed();
                }
                break;
            }
        };
        pending = Box::pin(windows::accept(server, &generation.cancel));
        let Some(bridge) = bridge.upgrade() else {
            break;
        };
        let Ok(scope_permit) = slots.clone().try_acquire_owned() else {
            drop(connection);
            continue;
        };
        let Ok(global_permit) = bridge.global_slots.clone().try_acquire_owned() else {
            drop(connection);
            continue;
        };
        let generation = generation.clone();
        clients.push(Box::pin(async move {
            let _scope_permit = scope_permit;
            let _global_permit = global_permit;
            let requested_key: Arc<Mutex<Option<Zeroizing<String>>>> = Arc::new(Mutex::new(None));
            let handler_key = requested_key.clone();
            let handler_bridge = bridge.clone();
            let handler_generation = generation.clone();
            let _ = connection
                .serve_with_admission(
                    &generation.cancel,
                    move |_, request| async move {
                        let response = handler_bridge
                            .handle_request(scope, &handler_generation, &request, &handler_key)
                            .await;
                        Ok(response)
                    },
                    |response| {
                        bridge.register_send(
                            scope,
                            &generation,
                            response,
                            lock(&requested_key).as_deref().map(String::as_str),
                        )
                    },
                )
                .await;
        }));
    }
    drop(clients);
}

pub(super) struct SendRegistration {
    bridge: Arc<DesktopBridge>,
    id: u64,
}
impl Drop for SendRegistration {
    fn drop(&mut self) {
        lock(&self.bridge.gate).senders.remove(&self.id);
    }
}

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "desktop source authorization rejected",
    )
}
impl DesktopBridge {
    pub(super) fn validate_authority(
        &self,
        scope: Scope,
        generation: &AuthorizationGeneration,
        requested_key: Option<&str>,
    ) -> io::Result<(u64, Zeroizing<String>)> {
        let record = Authorization::read(&self.directory)?.ok_or_else(denied)?;
        if !record.scopes.contains(&scope) {
            return Err(denied());
        }
        let key = read_key(&self.directory, scope)?;
        if requested_key.is_some_and(|requested| !equal_key(&key, requested)) {
            return Err(denied());
        }
        let gate = lock(&self.gate);
        if !gate.open
            || gate.shutting_down
            || gate.revoking
            || gate.epoch != generation.epoch
            || generation.cancel.is_cancelled()
            || gate.revision != record.revision
            || !gate.keys[index(scope)]
                .as_ref()
                .is_some_and(|active| equal_key(active, &key))
        {
            return Err(denied());
        }
        Ok((record.revision, key))
    }

    pub(super) async fn handle_request(
        &self,
        scope: Scope,
        generation: &AuthorizationGeneration,
        request: &Request,
        requested_key: &Mutex<Option<Zeroizing<String>>>,
    ) -> Response {
        let result = if request.validate(scope, &self.session).is_err() {
            Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "desktop_request_invalid",
                "Invalid desktop read request",
            ))
        } else if self
            .validate_authority(scope, generation, Some(&request.key))
            .is_err()
        {
            Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "desktop_authorization_required",
                "Desktop source authorization rejected",
            ))
        } else if let Some(state) = self
            .state
            .upgrade()
            .filter(|state| state.server_instance_id() == self.session)
        {
            *lock(requested_key) = Some(Zeroizing::new(request.key.clone()));
            #[cfg(test)]
            self.projection_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            match (scope, request.op.as_str()) {
                (Scope::Lyrics, "snapshot") => Ok(crate::desktop_lyrics::snapshot(&state).await),
                (Scope::Lyrics, "document") => {
                    crate::desktop_lyrics::document(&state, request.params["key"].as_str().unwrap())
                        .await
                }
                (Scope::Wallpaper, "snapshot") => Ok(crate::wallpaper::snapshot(&state).await),
                _ => unreachable!("request validated before projection"),
            }
        } else {
            Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "desktop_source_unavailable",
                "Desktop source is unavailable",
            ))
        };
        let (status, body) = match result {
            Ok(body) => (200, body),
            Err(error) => (
                error.status.as_u16(),
                serde_json::to_value(ErrorBody {
                    error: ErrorDetail {
                        code: error.code,
                        message: error.message,
                        request_id: error.request_id,
                        source: error.source,
                    },
                })
                .expect("error envelope is serializable"),
            ),
        };
        Response {
            bridge_protocol: BRIDGE_PROTOCOL,
            request_id: request.request_id.clone(),
            server_instance_id: request.server_instance_id.clone(),
            status,
            body,
        }
    }

    pub(super) fn register_send(
        self: &Arc<Self>,
        scope: Scope,
        generation: &AuthorizationGeneration,
        response: &Response,
        requested_key: Option<&str>,
    ) -> io::Result<SendRegistration> {
        let (revision, key) = self.validate_authority(scope, generation, requested_key)?;
        // Gate closure and first-byte admission use the same short mutex. The returned
        // guard holds no mutex across client I/O; revoke cancels its registered token.
        let mut gate = lock(&self.gate);
        if !gate.open
            || gate.shutting_down
            || gate.revoking
            || gate.epoch != generation.epoch
            || generation.cancel.is_cancelled()
            || gate.revision != revision
            || response.server_instance_id != self.session
            || !gate.keys[index(scope)]
                .as_ref()
                .is_some_and(|active| equal_key(active, &key))
        {
            return Err(denied());
        }
        let id = gate.next_sender.checked_add(1).ok_or_else(denied)?;
        gate.next_sender = id;
        gate.senders.insert(id, generation.cancel.clone());
        Ok(SendRegistration {
            bridge: self.clone(),
            id,
        })
    }
}
