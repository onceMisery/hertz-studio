// SPDX-License-Identifier: MIT
//! Native community transport, trust and subscriptions. Installation and Config
//! remain with ImportJobs/AssetStore/Library and the original ApplyTransaction.
pub(crate) mod auth;
pub(crate) mod author;
mod author_model;
mod author_transport;
pub(crate) mod credentials;
mod database;
pub(crate) mod gate;
pub(crate) mod model;
pub(crate) mod network;
mod network_policy;
mod receipts;
pub(crate) mod store;
pub(crate) mod subscriptions;
#[cfg(test)]
mod test_support;

pub(crate) use receipts::AcceptedRelease;
pub(crate) use store::TrustStore;

pub(crate) fn error(
    code: &'static str,
    message: impl Into<String>,
) -> crate::wallpaper::jobs::JobError {
    crate::wallpaper::jobs::JobError::new(code, message)
}

pub(crate) fn contract(error: hertz_wallpaper::PackageError) -> crate::wallpaper::jobs::JobError {
    crate::wallpaper::jobs::JobError::new(error.code, error.message)
}

pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
