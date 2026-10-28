// SPDX-License-Identifier: MIT
//! Caller-owned blocking work. Dropping its future cancels the real I/O and joins the worker.
use hertz_desktop_ipc::windows::Cancellation;
use std::{
    future::Future,
    io,
    pin::Pin,
    task::{Context, Poll},
    thread::JoinHandle,
};
use tokio::sync::oneshot;

pub(super) struct Worker<T> {
    receive: oneshot::Receiver<T>,
    worker: Option<JoinHandle<()>>,
    cancel: Cancellation,
}
impl<T: Send + 'static> Worker<T> {
    pub fn start(
        cancel: Cancellation,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> io::Result<Self> {
        let (send, receive) = oneshot::channel();
        let worker = std::thread::Builder::new()
            .name("desktop-management".into())
            .spawn(move || {
                let value = work();
                let _ = send.send(value);
            })?;
        Ok(Self {
            receive,
            worker: Some(worker),
            cancel,
        })
    }
}
impl<T> Future for Worker<T> {
    type Output = io::Result<T>;
    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        match Pin::new(&mut this.receive).poll(context) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(value) => {
                let joined = this
                    .worker
                    .take()
                    .expect("worker polled after completion")
                    .join();
                Poll::Ready(match (value, joined) {
                    (Ok(value), Ok(())) => Ok(value),
                    _ => Err(io::Error::other("desktop management worker failed")),
                })
            }
        }
    }
}
impl<T> Drop for Worker<T> {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            self.cancel.cancel();
            // The transport owns and reaps every OVERLAPPED before this thread returns.
            let _ = worker.join();
        }
    }
}
