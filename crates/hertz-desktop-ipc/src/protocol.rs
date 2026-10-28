// SPDX-License-Identifier: MIT
use crate::{Profile, BRIDGE_PROTOCOL, DISCOVERY_PROTOCOL};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Lyrics,
    Wallpaper,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lyrics => "lyrics",
            Self::Wallpaper => "wallpaper",
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub bridge_protocol: u32,
    pub request_id: String,
    pub server_instance_id: String,
    pub scope: Scope,
    pub key: String,
    pub op: String,
    pub params: Value,
}

impl std::fmt::Debug for Request {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Request")
            .field("bridge_protocol", &self.bridge_protocol)
            .field("request_id", &self.request_id)
            .field("server_instance_id", &self.server_instance_id)
            .field("scope", &self.scope)
            .field("key", &"<redacted>")
            .field("op", &self.op)
            .field("params", &self.params)
            .finish()
    }
}

impl Request {
    /// Structural validation only. The bridge must still authenticate key, authorization
    /// generation and session before invoking its existing projection owner.
    pub fn validate(&self, scope: Scope, session: &str) -> io::Result<()> {
        let valid_params = match (scope, self.op.as_str()) {
            (_, "snapshot") => self.params.as_object().is_some_and(|p| p.is_empty()),
            (Scope::Lyrics, "document") => self.params.as_object().is_some_and(|p| {
                p.len() == 1
                    && p.get("key")
                        .and_then(Value::as_str)
                        .is_some_and(|key| !key.is_empty())
            }),
            _ => false,
        };
        if self.bridge_protocol != BRIDGE_PROTOCOL
            || self.scope != scope
            || self.server_instance_id != session
            || self.request_id.is_empty()
            || self.request_id.len() > 128
            || self.key.is_empty()
            || !valid_params
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid desktop request envelope",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    pub bridge_protocol: u32,
    pub request_id: String,
    pub server_instance_id: String,
    pub status: u16,
    pub body: Value,
}

impl Response {
    pub fn validate(&self, request: &Request) -> io::Result<()> {
        if self.bridge_protocol != BRIDGE_PROTOCOL
            || self.request_id != request.request_id
            || self.server_instance_id != request.server_instance_id
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "desktop response identity mismatch",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pipes {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lyrics: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallpaper: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Discovery {
    pub discovery_protocol: u32,
    pub source: Profile,
    pub server_instance_id: String,
    pub pid: u32,
    pub windows_session_id: u32,
    pub build_id: String,
    pub desktop_build_id: String,
    pub bridge_protocol: u32,
    pub desktop_lyrics_protocol: u32,
    pub wallpaper_protocol: u32,
    pub pipes: Pipes,
}

impl Discovery {
    pub fn validate(&self, selected: &Profile) -> io::Result<()> {
        if self.discovery_protocol != DISCOVERY_PROTOCOL
            || self.bridge_protocol != BRIDGE_PROTOCOL
            || self.pid == 0
            || uuid::Uuid::parse_str(&self.server_instance_id).is_err()
            || self.build_id.is_empty()
            || self.desktop_build_id.is_empty()
            || self.pipes.lyrics.is_none() && self.pipes.wallpaper.is_none()
            || self.pipes.lyrics.is_some() && self.pipes.lyrics == self.pipes.wallpaper
            || self.source.normalized()? != selected.normalized()?
            || !matches!(self.source, Profile::Dbx { .. })
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid desktop discovery identity/protocol",
            ));
        }
        #[cfg(windows)]
        if self.windows_session_id != crate::windows::Identity::current()?.windows_session_id {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "desktop discovery Windows session mismatch",
            ));
        }
        for pipe in [&self.pipes.lyrics, &self.pipes.wallpaper]
            .into_iter()
            .flatten()
        {
            #[cfg(windows)]
            crate::windows::validate_pipe_name(pipe)?;
            #[cfg(not(windows))]
            let _ = pipe;
        }
        Ok(())
    }
}
