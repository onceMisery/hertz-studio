// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Placement persistence shares the lifecycle's settings lock and service runtime.

use super::{Event, NativeWindowOwner, WindowLifecycle};
use crate::window_placement::{WindowPlacement, PLACEMENT_KEY};
use std::sync::Arc;
use std::time::Duration;

pub(super) struct PlacementState {
    latest: Option<WindowPlacement>,
    revision: u64,
    saved_revision: u64,
    worker_running: bool,
    sealed: bool,
    protected: bool,
}

impl PlacementState {
    pub(super) async fn load(state: &crate::state::AppState) -> Self {
        // Read the exact row: the generic settings getter intentionally treats
        // malformed JSON as missing, which cannot safely authorize replacement.
        let result = sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
            .bind(PLACEMENT_KEY)
            .fetch_optional(&state.db)
            .await;
        let (latest, protected) = match result {
            Ok(None) => (None, false),
            Ok(Some(raw)) => match serde_json::from_str::<WindowPlacement>(&raw) {
                Ok(value) => (Some(value), false),
                Err(error) => {
                    tracing::warn!(%error, "native window placement rejected; preserving stored value");
                    (None, true)
                }
            },
            Err(error) => {
                tracing::warn!(%error, "native window placement unread; automatic persistence disabled");
                (None, true)
            }
        };
        Self {
            latest,
            revision: 0,
            saved_revision: 0,
            worker_running: false,
            sealed: false,
            protected,
        }
    }
}

impl NativeWindowOwner {
    /// Native host only; neither HTTP nor the renderer can supply geometry.
    pub fn record_placement(&self, value: WindowPlacement) -> Result<(), &'static str> {
        self.lifecycle.record_placement(value)
    }

    /// Called after the last capture on Tao. Subsequent native events cannot
    /// race the service's final flush by accepting another placement intent.
    pub fn seal_placement(&self) {
        self.lifecycle.seal_placement();
    }
}

impl WindowLifecycle {
    /// Latest accepted native snapshot, including dirty intent awaiting save.
    /// Unsupported or unread rows return None and remain protected from writes.
    pub fn saved_placement(&self) -> Option<WindowPlacement> {
        self.placement
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .latest
    }

    fn record_placement(self: &Arc<Self>, value: WindowPlacement) -> Result<(), &'static str> {
        let value = value.validate()?;
        let start_worker = {
            let mut placement = self
                .placement
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if placement.protected {
                return Err("native window placement is protected");
            }
            if placement.sealed {
                return Err("native window placement is sealed");
            }
            if placement.latest != Some(value) {
                placement.latest = Some(value);
                placement.revision += 1;
            }
            if placement.saved_revision == placement.revision || placement.worker_running {
                false
            } else {
                placement.worker_running = true;
                true
            }
        };
        if start_worker {
            let lifecycle = Arc::clone(self);
            self.runtime.spawn(async move {
                // One worker per burst; no database work occurs on Tao.
                tokio::time::sleep(Duration::from_millis(250)).await;
                loop {
                    let attempted_revision = lifecycle
                        .placement
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .revision;
                    let result = lifecycle.flush_placement().await;
                    let mut placement = lifecycle
                        .placement
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    // An event arriving during a failed write retains its newer
                    // revision and earns a retry. Otherwise retry on change/flush.
                    if placement.revision != placement.saved_revision
                        && (result.is_ok() || placement.revision > attempted_revision)
                    {
                        continue;
                    }
                    placement.worker_running = false;
                    break;
                }
            });
        }
        Ok(())
    }

    fn seal_placement(&self) {
        self.placement
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .sealed = true;
    }

    /// Persist the latest accepted revision under the existing settings lock.
    /// Failed writes retain dirty state and report an observable error.
    pub async fn flush_placement(&self) -> Result<(), &'static str> {
        let _write = self.settings_write.lock().await;
        loop {
            let pending = {
                let placement = self
                    .placement
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if placement.protected || placement.saved_revision == placement.revision {
                    None
                } else {
                    placement.latest.map(|value| (placement.revision, value))
                }
            };
            let Some((revision, value)) = pending else {
                return Ok(());
            };
            let state = self
                .state
                .upgrade()
                .ok_or("native window placement service unavailable")?;
            let encoded = serde_json::to_value(value)
                .map_err(|_| "native window placement serialization failed")?;
            if let Err(error) =
                vmusic_store::settings::set(&state.db, PLACEMENT_KEY, &encoded).await
            {
                tracing::warn!(%error, revision, "native window placement save failed; latest snapshot retained");
                return Err("native window placement save failed");
            }
            self.placement
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .saved_revision = revision;
        }
    }

    /// The service requests a final main-window capture before flushing. A dead
    /// GUI must not prevent audio/room shutdown or database/runtime cleanup.
    pub async fn finish_placement(&self) {
        let sink = self
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .sink
            .clone();
        if self.owner_alive.load(std::sync::atomic::Ordering::Acquire) {
            if let Some(sink) = sink {
                let (complete, received) = tokio::sync::oneshot::channel();
                sink(Event::FlushPlacement(Arc::new(std::sync::Mutex::new(
                    Some(complete),
                ))));
                match tokio::time::timeout(Duration::from_secs(1), received).await {
                    Ok(Ok(())) => {},
                    Ok(Err(_)) => tracing::warn!("native window placement final capture unavailable; flushing accepted snapshot"),
                    Err(_) => tracing::warn!("native window placement final capture timed out; flushing accepted snapshot"),
                }
            }
        }
        self.seal_placement();
        match tokio::time::timeout(Duration::from_secs(2), self.flush_placement()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(error, "native window placement final flush failed"),
            Err(_) => tracing::warn!("native window placement final flush timed out"),
        }
    }
}
