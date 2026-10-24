// SPDX-License-Identifier: MIT
//! Native room primitives. No library paths, queue ownership or HTTP business rules.
pub mod buffer;
pub mod client;
pub mod clock;
pub mod discovery;
pub mod invitation;
pub mod members;
mod notifications;
pub use notifications::Notifications as ChatNotifications;
pub mod protocol;
pub mod server;
pub mod tls;
