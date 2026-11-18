// SPDX-License-Identifier: MIT
//! Independent Hub: quarantine/review state is not protected Signer approval.
//! No private key, music database, desktop control or static content mount.
mod administration;
mod auth;
mod authority;
pub mod config;
mod downloads;
pub mod error;
mod http;
mod limits;
mod maintenance;
mod management;
mod model;
mod oidc_network;
mod publication;
mod publication_receipts;
mod reports;
mod review;
mod revocation;
mod store;
mod uploads;

pub use store::{Hub, ServerLease};

#[cfg(test)]
mod management_tests;
