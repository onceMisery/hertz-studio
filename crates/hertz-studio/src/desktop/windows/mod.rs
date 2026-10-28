// SPDX-License-Identifier: MIT
mod component;
mod connection;
mod detection;
mod protocol;
mod worker;

use super::{error, Capabilities, Component, Desktop, DesktopError};
use crate::desktop_bridge::AuthorizationGeneration;
use futures::future::{BoxFuture, Shared};
use hertz_desktop_ipc::{management, windows::Cancellation};
use serde_json::Value;
use std::{
    io,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

use detection::{detect, Detection};

const TOTAL: Duration = Duration::from_secs(5);
fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
fn check(cancel: &Cancellation, deadline: Instant) -> io::Result<()> {
    if cancel.is_cancelled() {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "Desktop operation cancelled",
        ))
    } else if Instant::now() >= deadline {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "Desktop operation exceeded its total deadline",
        ))
    } else {
        Ok(())
    }
}
fn io_error(failure: &io::Error) -> DesktopError {
    match failure.kind() {
        io::ErrorKind::Interrupted => error(
            "desktop_operation_cancelled",
            "Desktop operation was cancelled",
        ),
        io::ErrorKind::TimedOut => error(
            "desktop_timeout",
            "Desktop management did not complete within its bounded deadline",
        ),
        io::ErrorKind::NotFound => error(
            "desktop_not_running",
            "Start the desktop component manually, then retry",
        ),
        io::ErrorKind::PermissionDenied => error(
            "desktop_access_denied",
            "Desktop component or management channel cannot be accessed",
        ),
        io::ErrorKind::InvalidData => error(
            "desktop_response_invalid",
            "Desktop management returned an invalid response",
        ),
        _ => error(
            "desktop_unavailable",
            "Desktop component or management channel is unavailable",
        ),
    }
}

#[derive(Clone)]
struct Environment {
    pipe: String,
    installation: Option<PathBuf>,
}
impl Environment {
    fn current() -> Self {
        Self {
            pipe: management::pipe_name(),
            installation: std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .map(|path| path.join("Hertz/Desktop/bin")),
        }
    }
}

#[derive(Clone)]
enum Authority {
    Admission { epoch: u64, cancel: Cancellation },
    Authorized(AuthorizationGeneration),
}
impl Authority {
    fn is_current(&self, desktop: &Desktop) -> bool {
        desktop.bridge.get().is_some_and(|bridge| match self {
            Self::Admission { epoch, cancel } => {
                !cancel.is_cancelled() && bridge.admission_current(*epoch)
            }
            Self::Authorized(generation) => bridge.is_current(generation),
        })
    }
    async fn cancelled(&self) {
        match self {
            Self::Admission { cancel, .. } => cancel.cancelled().await,
            Self::Authorized(generation) => generation.cancelled().await,
        }
    }
}

#[derive(Clone)]
struct Completion {
    epoch: u64,
    error: Option<DesktopError>,
    center_opened: bool,
    authority: Option<Authority>,
    // This response belongs only to this operation. Cached reads never recycle source true.
    native: Option<(Value, Instant)>,
}
struct Flight {
    future: Shared<BoxFuture<'static, Completion>>,
    cancel: Cancellation,
}
impl Drop for Flight {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
#[derive(Default)]
struct Operations {
    epoch: u64,
    next_id: u64,
    connect: Weak<Flight>,
    refresh: Weak<Flight>,
    connect_cancel: Option<Cancellation>,
    refresh_cancel: Option<Cancellation>,
}
#[derive(Default)]
struct Cache {
    component: Component,
    reason: Option<&'static str>,
    management_at: Option<Instant>,
    error: Option<DesktopError>,
    epoch: u64,
    id: u64,
    authority: Option<Authority>,
    launched: bool,
}
pub(super) struct Runtime {
    operations: Mutex<Operations>,
    cache: Mutex<Cache>,
    slot: Arc<Semaphore>,
    #[cfg(test)]
    environment: Mutex<Option<Environment>>,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            operations: Mutex::new(Operations::default()),
            cache: Mutex::new(Cache::default()),
            slot: Arc::new(Semaphore::new(1)),
            #[cfg(test)]
            environment: Mutex::new(None),
        }
    }
}
impl Runtime {
    pub fn cached(&self, desktop: &Desktop) -> Capabilities {
        let mut value = desktop.empty();
        let operations = lock(&self.operations);
        let cache = lock(&self.cache);
        value.component = cache.component.clone();
        value.reason = cache.reason.or(value.reason);
        value.error = cache.error.clone();
        value.launch_requested = cache.launched;
        let authority_current = cache
            .authority
            .as_ref()
            .is_none_or(|authority| authority.is_current(desktop));
        value.management_ready = cache.epoch == operations.epoch
            && authority_current
            && cache
                .management_at
                .is_some_and(|at| at.elapsed() < protocol::FRESHNESS);
        if cache.management_at.is_some() && !value.management_ready {
            value.reason = Some("management-unconfirmed");
        }
        value
    }
    pub fn launched(&self) {
        lock(&self.cache).launched = true;
    }
    pub fn invalidate(&self) {
        let mut operations = lock(&self.operations);
        operations.epoch = operations.epoch.wrapping_add(1);
        // Do not upgrade/drop a flight here: its last owner must reap its own worker.
        // A disconnect must reach gate closure without joining any management thread.
        if let Some(cancel) = &operations.connect_cancel {
            cancel.cancel();
        }
        if let Some(cancel) = &operations.refresh_cancel {
            cancel.cancel();
        }
    }
    fn current(&self, epoch: u64, cancel: &Cancellation) -> Result<(), DesktopError> {
        if cancel.is_cancelled() || lock(&self.operations).epoch != epoch {
            Err(error(
                "desktop_operation_cancelled",
                "Desktop intent was superseded by disconnect or shutdown",
            ))
        } else {
            Ok(())
        }
    }
    fn publish(
        &self,
        desktop: &Desktop,
        epoch: u64,
        id: u64,
        detection: &Detection,
        authority: Option<Authority>,
    ) {
        let operations = lock(&self.operations);
        if operations.epoch != epoch
            || authority
                .as_ref()
                .is_some_and(|authority| !authority.is_current(desktop))
        {
            return;
        }
        let mut cache = lock(&self.cache);
        if id < cache.id {
            return;
        }
        cache.id = id;
        cache.epoch = epoch;
        cache.component = detection.component.clone();
        cache.reason = Some(detection.reason);
        cache.authority = authority;
        cache.error = detection.error.clone();
        cache.management_at = detection.running.then(Instant::now);
    }
    fn publish_error(
        &self,
        desktop: &Desktop,
        epoch: u64,
        id: u64,
        authority: Option<Authority>,
        failure: &DesktopError,
    ) {
        let operations = lock(&self.operations);
        if operations.epoch != epoch
            || authority
                .as_ref()
                .is_some_and(|authority| !authority.is_current(desktop))
        {
            return;
        }
        let mut cache = lock(&self.cache);
        if id < cache.id {
            return;
        }
        cache.epoch = epoch;
        cache.id = id;
        cache.error = Some(failure.clone());
        cache.authority = authority;
        if !matches!(
            failure.code,
            "desktop_component_start_required"
                | "desktop_component_missing"
                | "desktop_component_incompatible"
        ) {
            cache.reason = Some("management-failed");
            cache.management_at = None;
        }
    }
    fn environment(&self) -> Environment {
        #[cfg(test)]
        if let Some(environment) = lock(&self.environment).clone() {
            return environment;
        }
        Environment::current()
    }
}

#[cfg(test)]
mod tests;
