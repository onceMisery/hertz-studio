// SPDX-License-Identifier: MIT
//! Exit intent is separate from the service-thread completion fact. A request
//! can arrive before bootstrap returns, and never terminates the event loop.

use tao::event_loop::ControlFlow;

pub(super) enum ServiceEvent {
    Ready(Box<dyn Fn()>),
    Quit,
    Exited,
}

#[derive(Default)]
pub(super) struct Lifecycle {
    request: Option<Box<dyn Fn()>>,
    quit_pending: bool,
}

impl Lifecycle {
    pub fn handle(&mut self, event: ServiceEvent) -> ControlFlow {
        match event {
            ServiceEvent::Ready(request) => {
                if self.quit_pending {
                    request();
                }
                self.request = Some(request);
            }
            ServiceEvent::Quit => {
                if !self.quit_pending {
                    self.quit_pending = true;
                    if let Some(request) = &self.request {
                        request();
                    }
                }
            }
            ServiceEvent::Exited => return ControlFlow::Exit,
        }
        ControlFlow::Wait
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn quit_before_ready_latches_and_only_completion_exits() {
        let calls = Arc::new(AtomicUsize::new(0));
        let called = calls.clone();
        let mut lifecycle = Lifecycle::default();
        assert_eq!(lifecycle.handle(ServiceEvent::Quit), ControlFlow::Wait);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            lifecycle.handle(ServiceEvent::Ready(Box::new(move || {
                called.fetch_add(1, Ordering::SeqCst);
            }))),
            ControlFlow::Wait
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(lifecycle.handle(ServiceEvent::Quit), ControlFlow::Wait);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(lifecycle.handle(ServiceEvent::Exited), ControlFlow::Exit);
    }

    #[test]
    fn quit_with_live_or_closed_watch_never_fabricates_service_completion() {
        for close_receiver in [false, true] {
            let (sender, receiver) = tokio::sync::watch::channel(false);
            let mut receiver = Some(receiver);
            if close_receiver {
                receiver.take();
            }
            let mut lifecycle = Lifecycle::default();
            assert_eq!(
                lifecycle.handle(ServiceEvent::Ready(Box::new(move || {
                    sender.send_replace(true);
                }))),
                ControlFlow::Wait
            );
            assert_eq!(lifecycle.handle(ServiceEvent::Quit), ControlFlow::Wait);
            if let Some(receiver) = receiver {
                assert!(*receiver.borrow());
            }
            assert_eq!(lifecycle.handle(ServiceEvent::Exited), ControlFlow::Exit);
        }
    }
}
