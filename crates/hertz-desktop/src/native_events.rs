// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Typed events for native loops that all use `tao::EventLoop<()>`.
//!
//! Tao 0.37 registers process-wide Win32 window classes whose callbacks depend on
//! the loop's event type. Different types in one process reuse the first loop's
//! callback and reinterpret its event data. Keep the native type `()` everywhere;
//! each loop's business events stay in its own typed channel.

use std::sync::{mpsc, Arc, Mutex};
use tao::event::Event;
use tao::event_loop::{EventLoopClosed, EventLoopProxy as WakeupProxy};

/// A typed sender paired with a unit-only native wakeup.
pub struct EventLoopProxy<T: 'static> {
    sender: mpsc::Sender<T>,
    wakeup: WakeupProxy<()>,
    gate: Arc<Mutex<bool>>,
}

impl<T> Clone for EventLoopProxy<T> {
    fn clone(&self) -> Self {
        Self {
            sender: self.sender.clone(),
            wakeup: self.wakeup.clone(),
            gate: Arc::clone(&self.gate),
        }
    }
}

impl<T> EventLoopProxy<T> {
    pub fn send_event(&self, event: T) -> Result<(), EventLoopClosed<T>> {
        send_with_wakeup(&self.sender, &self.gate, event, || {
            self.wakeup.send_event(())
        })
    }
}

/// The typed channel belongs to the thread running its native event loop.
pub struct EventReceiver<T> {
    receiver: mpsc::Receiver<T>,
    gate: Arc<Mutex<bool>>,
}

/// Pair a loop's raw proxy with its own typed event queue.
pub fn channel<T>(wakeup: WakeupProxy<()>) -> (EventLoopProxy<T>, EventReceiver<T>) {
    let (sender, receiver) = mpsc::channel();
    let gate = Arc::new(Mutex::new(true));
    (
        EventLoopProxy {
            sender,
            wakeup,
            gate: Arc::clone(&gate),
        },
        EventReceiver { receiver, gate },
    )
}

fn send_with_wakeup<T>(
    sender: &mpsc::Sender<T>,
    gate: &Mutex<bool>,
    event: T,
    wakeup: impl FnOnce() -> Result<(), EventLoopClosed<()>>,
) -> Result<(), EventLoopClosed<T>> {
    let Ok(open) = gate.lock() else {
        return Err(EventLoopClosed(event));
    };
    if !*open {
        return Err(EventLoopClosed(event));
    }
    // The shared gate preserves posting/payload order across senders. The
    // receiver cannot handle a wakeup before its payload is enqueued. Posting
    // first also leaves no orphan payload if the native loop has already closed.
    if wakeup().is_err() {
        return Err(EventLoopClosed(event));
    }
    sender.send(event).map_err(|error| EventLoopClosed(error.0))
}

impl<T> EventReceiver<T> {
    /// Replace one native wakeup with one typed event, without polling. Borrowed
    /// window events (including DPI size changes) retain their original lifetime.
    pub fn map_event<'a>(&self, event: Event<'a, ()>) -> Option<Event<'a, T>> {
        match event {
            Event::UserEvent(()) => {
                let _guard = self.gate.lock().ok()?;
                self.receiver.try_recv().ok().map(Event::UserEvent)
            }
            event => event.map_nonuser_event().ok(),
        }
    }
}

impl<T> Drop for EventReceiver<T> {
    fn drop(&mut self) {
        if let Ok(mut open) = self.gate.lock() {
            // Worker clones may outlive a host. Stop before touching Tao's HWND,
            // which Windows may reuse for a later loop after this one shuts down.
            *open = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tao::event::StartCause;

    #[test]
    fn concurrent_bursts_keep_every_event_in_sender_order() {
        let (sender, receiver) = mpsc::channel();
        let gate = Arc::new(Mutex::new(true));
        let events = EventReceiver {
            receiver,
            gate: Arc::clone(&gate),
        };
        let (wake_sender, wakes) = mpsc::channel();
        let workers: Vec<_> = (0..4)
            .map(|worker| {
                let sender = sender.clone();
                let wake_sender = wake_sender.clone();
                let gate = Arc::clone(&gate);
                std::thread::spawn(move || {
                    for sequence in 0..128 {
                        send_with_wakeup(&sender, &gate, (worker, sequence), || {
                            wake_sender.send((worker, sequence)).unwrap();
                            // Exercise the receiver waking before the typed send.
                            std::thread::yield_now();
                            Ok(())
                        })
                        .unwrap();
                    }
                })
            })
            .collect();
        let mut next = [0; 4];
        for _ in 0..512 {
            let posted = wakes.recv_timeout(Duration::from_secs(5)).unwrap();
            let Some(Event::UserEvent((worker, sequence))) = events.map_event(Event::UserEvent(()))
            else {
                panic!("posted wakeup lost its typed event");
            };
            assert_eq!((worker, sequence), posted);
            assert_eq!(sequence, next[worker]);
            next[worker] += 1;
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(next, [128; 4]);
        assert!(events.map_event(Event::UserEvent(())).is_none());
    }

    #[test]
    fn failed_wakeup_returns_payload_without_stealing_the_next_event() {
        let (sender, receiver) = mpsc::channel();
        let gate = Arc::new(Mutex::new(true));
        let events = EventReceiver {
            receiver,
            gate: Arc::clone(&gate),
        };
        assert_eq!(
            send_with_wakeup(&sender, &gate, "failed", || Err(EventLoopClosed(()))),
            Err(EventLoopClosed("failed"))
        );
        assert!(events.map_event(Event::UserEvent(())).is_none());
        send_with_wakeup(&sender, &gate, "next", || Ok(())).unwrap();
        assert_eq!(
            events.map_event(Event::UserEvent(())),
            Some(Event::UserEvent("next"))
        );
        drop(events);
        assert_eq!(
            send_with_wakeup(&sender, &gate, "closed", || {
                panic!("closed receiver must not post to its old native window");
            }),
            Err(EventLoopClosed("closed"))
        );
    }

    #[test]
    fn native_lifecycle_events_do_not_consume_typed_payloads() {
        let (sender, receiver) = mpsc::channel();
        let gate = Arc::new(Mutex::new(true));
        let events = EventReceiver {
            receiver,
            gate: Arc::clone(&gate),
        };
        send_with_wakeup(&sender, &gate, "queued", || Ok(())).unwrap();
        assert_eq!(
            events.map_event(Event::NewEvents(StartCause::Init)),
            Some(Event::NewEvents(StartCause::Init))
        );
        assert_eq!(
            events.map_event(Event::MainEventsCleared),
            Some(Event::MainEventsCleared)
        );
        assert_eq!(
            events.map_event(Event::UserEvent(())),
            Some(Event::UserEvent("queued"))
        );
        assert_eq!(
            events.map_event(Event::LoopDestroyed),
            Some(Event::LoopDestroyed)
        );
    }
}
