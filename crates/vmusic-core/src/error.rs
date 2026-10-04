// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Error types for the whole workspace.
//!
//! Every crate maps its own failures into [`CoreError`] at its boundary, and
//! `hertz-studio` turns that into an HTTP status plus a stable machine-readable
//! code (see `docs` in the main crate).

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AudioError {
    #[error("no output device available: {0}")]
    DeviceUnavailable(String),
    #[error("cannot decode: {0}")]
    DecodeFailed(String),
    #[error("unsupported format: {0}")]
    UnsupportedFormat(String),
    #[error("audio backend failed to start: {0}")]
    BackendInit(String),
    #[error("seek failed: {0}")]
    SeekFailed(String),
    /// Transport control was issued while nothing was loaded.
    ///
    /// Backends are free to treat "play with no source" as a no-op, but the
    /// service must not report success: a client that POSTs `/player/play` on an
    /// empty queue would otherwise see `playing: true` with no track attached.
    #[error("nothing is loaded")]
    NothingLoaded,
    #[error("audio error: {0}")]
    Other(String),
}

#[derive(Debug, Error)]
pub enum LibraryError {
    #[error("track not found: {0}")]
    TrackNotFound(String),
    #[error("invalid library root: {0}")]
    InvalidRoot(String),
    #[error("scan aborted: {0}")]
    ScanAborted(String),
    #[error("metadata could not be read for {path}: {reason}")]
    MetadataFailed { path: String, reason: String },
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Database(String),
    #[error("serialization error: {0}")]
    Serialization(String),
}

#[derive(Debug, Error)]
pub enum CoreError {
    #[error(transparent)]
    Audio(#[from] AudioError),
    #[error(transparent)]
    Library(#[from] LibraryError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("unauthorized: {0}")]
    Unauthorized(String),
    #[error("internal error: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;

impl CoreError {
    /// Stable, machine-readable token used in the `error.code` field.
    pub fn code(&self) -> &'static str {
        match self {
            CoreError::Audio(AudioError::DeviceUnavailable(_)) => "device_unavailable",
            CoreError::Audio(AudioError::DecodeFailed(_)) => "decode_failed",
            CoreError::Audio(AudioError::UnsupportedFormat(_)) => "unsupported_format",
            CoreError::Audio(AudioError::NothingLoaded) => "nothing_loaded",
            CoreError::Audio(_) => "audio_error",
            CoreError::Library(LibraryError::TrackNotFound(_)) => "track_not_found",
            CoreError::Library(LibraryError::InvalidRoot(_)) => "invalid_root",
            CoreError::Library(_) => "library_error",
            CoreError::Store(_) => "store_error",
            CoreError::NotFound(_) => "not_found",
            CoreError::Invalid(_) => "bad_request",
            CoreError::Unauthorized(_) => "unauthorized",
            CoreError::Internal(_) => "internal",
        }
    }

    /// HTTP status used by the boundary layer.
    ///
    /// Lives in `vmusic-core` (rather than in `hertz-studio`) so the mapping is
    /// next to the error definition and cannot drift out of sync with it.
    pub fn status(&self) -> u16 {
        http_status(self)
    }
}

/// Standalone so the mapping can be unit-tested without an HTTP stack.
pub fn http_status(err: &CoreError) -> u16 {
    match err {
        CoreError::NotFound(_) | CoreError::Library(LibraryError::TrackNotFound(_)) => 404,
        CoreError::Invalid(_) | CoreError::Library(LibraryError::InvalidRoot(_)) => 400,
        CoreError::Unauthorized(_) => 401,
        CoreError::Audio(AudioError::UnsupportedFormat(_)) => 415,
        CoreError::Audio(AudioError::DeviceUnavailable(_)) => 503,
        // Nothing is loaded, so the request is valid but conflicts with the
        // current transport state — not a server fault.
        CoreError::Audio(AudioError::NothingLoaded) => 409,
        _ => 500,
    }
}
