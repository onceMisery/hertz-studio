// SPDX-License-Identifier: MIT
//! Native room primitives. No library paths, queue ownership or HTTP business rules.
pub mod admission;
pub mod buffer;
pub mod client;
pub mod clock;
pub mod discovery;
pub mod invitation;
pub mod lobby;
pub mod members;
mod notifications;
pub use notifications::Notifications as ChatNotifications;
pub mod protocol;
pub mod server;
pub mod tls;

// Established peers may survive a short Wi-Fi scheduling stall. This lease
// controls socket liveness only; clock freshness and PCM bounds stay stricter.
pub(crate) const PEER_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
