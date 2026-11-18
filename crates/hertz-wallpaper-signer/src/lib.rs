// SPDX-License-Identifier: MIT
//! Local Signer protocol/client shared by the deployed Hub and operator tools.
//! OS peer identities, rather than library visibility, control approval rights.
mod authorization;
pub mod checkpoint;
pub mod client;
pub mod config;
mod keys;
pub mod ledger;
pub mod platform;
pub mod protocol;
pub mod server;
