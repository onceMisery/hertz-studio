// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use std::sync::Mutex;

/// Ownership facts only. Playback and room state remain in AppState.
pub struct SystemMedia {
    status: Mutex<serde_json::Value>,
    #[cfg(all(windows, feature = "native-window"))]
    pub(super) state: std::sync::Weak<crate::state::AppState>,
    #[cfg(all(windows, feature = "native-window"))]
    pub(super) runtime: tokio::runtime::Handle,
    #[cfg(all(windows, feature = "native-window"))]
    pub(super) stopped: std::sync::atomic::AtomicBool,
    #[cfg(all(windows, feature = "native-window"))]
    started: std::sync::atomic::AtomicBool,
}

impl SystemMedia {
    pub fn status(&self) -> serde_json::Value {
        self.status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    #[cfg(all(windows, feature = "native-window"))]
    pub(super) fn publish(&self, phase: &str, owned: bool, error: Option<&'static str>) {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        status["phase"] = phase.into();
        status["owned"] = owned.into();
        status["error"] = error.into();
    }

    #[cfg(all(windows, feature = "native-window"))]
    pub(crate) fn install(state: &std::sync::Arc<crate::state::AppState>) {
        state.system_media.get_or_init(|| {
            std::sync::Arc::new(Self {
                // Reserve ownership before the first renderer can register handlers.
                status: Mutex::new(serde_json::json!({"available":true,"owned":true,
                "phase":"starting","serverInstance":state.server_instance_id(),"error":null})),
                state: std::sync::Arc::downgrade(state),
                runtime: tokio::runtime::Handle::current(),
                stopped: false.into(),
                started: false.into(),
            })
        });
    }

    #[cfg(all(windows, feature = "native-window"))]
    pub(crate) fn start(self: &std::sync::Arc<Self>, hwnd: isize) {
        use std::sync::atomic::Ordering;
        if self.started.swap(true, Ordering::AcqRel) || self.stopped.load(Ordering::Acquire) {
            return;
        }
        let media = self.clone();
        if std::thread::Builder::new()
            .name("hertz-system-media".into())
            .spawn(move || super::windows::run(media, hwnd))
            .is_err()
        {
            self.publish("failed", false, Some("smtc_thread_failed"));
        }
    }

    pub(crate) fn stop(&self) {
        #[cfg(all(windows, feature = "native-window"))]
        self.stopped
            .store(true, std::sync::atomic::Ordering::Release);
        // The worker releases Windows callbacks before publishing owned=false.
    }
}
