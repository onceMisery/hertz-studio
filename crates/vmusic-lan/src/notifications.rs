// SPDX-License-Identifier: MIT
//! Lossy low-priority queue, independent from reliable control and PCM.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

#[derive(Default)]
struct Pending {
    messages: VecDeque<String>,
    bytes: usize,
    gap: bool,
}
#[derive(Default)]
pub struct Notifications {
    pending: Mutex<Pending>,
    available: Notify,
}
impl Notifications {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub(crate) fn push(&self, text: String) {
        if text.len() > 2048 {
            return;
        }
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        while pending.messages.len() >= 64 || pending.bytes + text.len() > 128 * 1024 {
            if let Some(old) = pending.messages.pop_front() {
                pending.bytes -= old.len();
                pending.gap = true;
            } else {
                break;
            }
        }
        pending.bytes += text.len();
        pending.messages.push_back(text);
        drop(pending);
        self.available.notify_one();
    }
    pub async fn recv(&self) -> String {
        loop {
            let notified = self.available.notified();
            {
                let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
                if pending.gap {
                    pending.gap = false;
                    return r#"{"type":"notification","topic":"chat_gap","body":{}}"#.into();
                }
                if let Some(text) = pending.messages.pop_front() {
                    pending.bytes -= text.len();
                    return text;
                }
            }
            notified.await;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn drops_oldest_and_announces_gap_before_retained_notifications() {
        let queue = Notifications::new();
        for i in 0..100 {
            queue.push(i.to_string());
        }
        assert!(queue.recv().await.contains("chat_gap"));
        for i in 36..100 {
            assert_eq!(queue.recv().await, i.to_string());
        }
        let pending = queue.pending.lock().unwrap();
        assert_eq!(pending.bytes, 0);
        assert!(pending.messages.is_empty());
    }
}
