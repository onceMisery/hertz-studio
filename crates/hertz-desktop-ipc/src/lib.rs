// SPDX-License-Identifier: MIT
//! Desktop-only primitives. No listener or credential is created merely by linking this crate.
//! A caller owns authorization, concurrency permits and lifetime cancellation. The user SID
//! boundary does not isolate mutually malicious processes belonging to the same user.

#[cfg(windows)]
pub mod blocking;
pub mod frame;
#[cfg(windows)]
pub mod management;
pub mod profile;
pub mod protocol;
#[cfg(windows)]
pub mod windows;

pub use profile::Profile;
pub use protocol::{Discovery, Pipes, Request, Response, Scope};

pub const BRIDGE_PROTOCOL: u32 = 1;
pub const DISCOVERY_PROTOCOL: u32 = 1;
pub const REQUEST_LIMIT: usize = 8192;
pub const RESPONSE_LIMIT: usize = 4_194_304;
pub const DISCOVERY_LIMIT: usize = 65_536;
pub const AUTHORIZATION_LIMIT: usize = 8192;
pub const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
pub const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
