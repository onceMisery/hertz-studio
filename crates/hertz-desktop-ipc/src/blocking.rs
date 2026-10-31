// SPDX-License-Identifier: MIT
//! Caller-owned Windows file work. Cancellation interrupts synchronous I/O and reaps the
//! thread before returning its resource permits; private-file helpers check every stage.
use crate::windows::Cancellation;
use std::{
    cell::RefCell,
    future::Future,
    io,
    os::windows::io::AsRawHandle,
    pin::Pin,
    task::{Context, Poll},
    thread::JoinHandle,
    time::Instant,
};
use tokio::sync::oneshot;

thread_local! {
    static BUDGET: RefCell<Option<(Cancellation, Option<Instant>)>> = const { RefCell::new(None) };
}

/// Cooperatively check the current worker's cancellation and file-stage budget.
pub fn check() -> io::Result<()> {
    BUDGET.with(|budget| {
        if let Some((cancel, deadline)) = budget.borrow().as_ref() {
            if cancel.is_cancelled() {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "desktop file work cancelled",
                ));
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "desktop file work deadline",
                ));
            }
        }
        Ok(())
    })
}

pub struct Worker<T> {
    receive: oneshot::Receiver<T>,
    worker: Option<JoinHandle<()>>,
    cancel: Cancellation,
}
impl<T: Send + 'static> Worker<T> {
    pub fn start(
        cancel: Cancellation,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> io::Result<Self> {
        Self::start_until(cancel, None, work)
    }
    pub fn start_until(
        cancel: Cancellation,
        deadline: Option<Instant>,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> io::Result<Self> {
        let (send, receive) = oneshot::channel();
        let budget_cancel = cancel.clone();
        let runtime = tokio::runtime::Handle::try_current().ok();
        let worker = std::thread::Builder::new()
            .name("desktop-io".into())
            .spawn(move || {
                let _entered = runtime.as_ref().map(|runtime| runtime.enter());
                BUDGET.with(|budget| *budget.borrow_mut() = Some((budget_cancel, deadline)));
                let _ = send.send(work());
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
                    _ => Err(io::Error::other("desktop I/O worker failed")),
                })
            }
        }
    }
}
impl<T> Drop for Worker<T> {
    fn drop(&mut self) {
        if let Some(worker) = self.worker.take() {
            self.cancel.cancel();
            // Retry closes the race between a stage's cancellation check and entering ReadFile.
            while !worker.is_finished() {
                unsafe {
                    windows_sys::Win32::System::IO::CancelSynchronousIo(worker.as_raw_handle());
                }
                std::thread::park_timeout(std::time::Duration::from_millis(1));
            }
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };

    #[tokio::test]
    async fn deadline_interrupts_real_synchronous_read_and_reaps_its_worker() {
        let name = format!(
            r"\\.\pipe\hertz-desktop-file-cancel-{}",
            uuid::Uuid::new_v4()
        );
        let server = crate::windows::create_server(&name, true).unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let worker_done = done.clone();
        let (ready, entered) = oneshot::channel();
        let worker = Worker::start(Cancellation::new(), move || {
            let mut file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(name)
                .unwrap();
            let _ = ready.send(());
            let mut byte = [0];
            let result = file.read(&mut byte);
            worker_done.store(true, Ordering::SeqCst);
            result
        })
        .unwrap();
        let cancel = Cancellation::new();
        let _connection = crate::windows::accept(server, &cancel).await.unwrap();
        entered.await.unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(50), worker)
            .await
            .is_err());
        assert!(
            done.load(Ordering::SeqCst),
            "deadline must reap the actual blocked read"
        );
    }
}
