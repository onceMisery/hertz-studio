// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Same-user/session raw JSON management; one worker, real cancellable overlapped I/O.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

use anyhow::{Context, Result};
use hertz_desktop_ipc::{management, windows::Cancellation};
use serde_json::Value;

pub(crate) struct PipeRequest {
    pub(crate) body: Value,
    pub(crate) reply: mpsc::SyncSender<Value>,
    pub(crate) admission: management::Admission,
    _pending: PendingRequest,
}

struct PendingRequest(Arc<AtomicBool>);
impl Drop for PendingRequest {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub(crate) fn start(sink: impl Fn(PipeRequest) + Send + 'static) -> Result<()> {
    std::thread::Builder::new()
        .name("hertz-desktop-pipe".into())
        .spawn(move || {
            let cancel = Cancellation::new();
            let name = management::pipe_name();
            // A timed-out connection may still have an event waiting in the GUI queue.
            // Keep admission occupied until that event is dequeued/dropped; overload never
            // appends another event or creates another worker.
            let pending = Arc::new(AtomicBool::new(false));
            loop {
                let result = management::create_server(&name)
                    .and_then(|server| server.accept(&cancel))
                    .and_then(|connection| {
                        connection.serve(&cancel, |body, admission| {
                            let (reply, wait) = mpsc::sync_channel(1);
                            if pending.swap(true, Ordering::AcqRel) {
                                let _ = reply.send(crate::management::busy_reply(&body));
                                return wait;
                            }
                            sink(PipeRequest {
                                body,
                                reply,
                                admission,
                                _pending: PendingRequest(pending.clone()),
                            });
                            wait
                        })
                    });
                if let Err(error) = result {
                    crate::app::log(&format!("control pipe: {error:#}"));
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        })
        .context("启动桌面歌词管理通道失败")?;
    Ok(())
}
