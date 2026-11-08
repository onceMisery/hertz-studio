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
    #[serde(rename = "lyricsCalibration")]
    LyricsCalibration,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lyrics => "lyrics",
            Self::Wallpaper => "wallpaper",
            Self::LyricsCalibration => "lyricsCalibration",
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
            (Scope::Lyrics | Scope::Wallpaper, "snapshot") => {
                self.params.as_object().is_some_and(|p| p.is_empty())
            }
            (Scope::LyricsCalibration, "bind") => self.params.as_object().is_some_and(|p| {
                p.len() == 5
                    && p.get("deadlineClock").and_then(Value::as_str).is_some()
                    && p.get("deadlineMonotonicMs")
                        .and_then(Value::as_u64)
                        .is_some()
                    && p.get("nativeSession").and_then(Value::as_str).is_some()
                    && p.get("requestSequence").and_then(Value::as_u64).is_some()
                    && p.get("session").and_then(Value::as_str).is_some()
            }),
            (Scope::LyricsCalibration, "request") => self.params.as_object().is_some_and(|p| {
                p.keys().all(|k| {
                    matches!(
                        k.as_str(),
                        "version"
                            | "requestId"
                            | "bindingId"
                            | "requestSequence"
                            | "remainingMs"
                            | "deadlineClock"
                            | "deadlineMonotonicMs"
                            | "session"
                            | "trackId"
                            | "generation"
                    )
                })
            }),
            (Scope::LyricsCalibration, "result" | "cancel") => {
                self.params.as_object().is_some_and(|p| {
                    p.len() == 2
                        && p.get("bindingId").and_then(Value::as_str).is_some()
                        && p.get("requestId").and_then(Value::as_str).is_some()
                })
            }
            (Scope::Lyrics, "document") => self.params.as_object().is_some_and(|p| {
                p.keys()
                    .all(|key| matches!(key.as_str(), "key" | "vocalSchemaVersion"))
                    && p.get("vocalSchemaVersion")
                        .is_none_or(|version| version.as_u64().is_some())
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
            || scope == Scope::LyricsCalibration
                && serde_json::to_vec(self).map_or(true, |bytes| bytes.len() > 4096)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid desktop request envelope",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod calibration_tests {
    use super::*;
    #[test]
    fn calibration_wire_deadline_is_bounded_and_never_grants_read_ops() {
        let mut request = Request {
            bridge_protocol: BRIDGE_PROTOCOL,
            request_id: "transport-id".into(),
            server_instance_id: "source-session".into(),
            scope: Scope::LyricsCalibration,
            key: "a".repeat(64),
            op: "bind".into(),
            params: serde_json::json!({"deadlineClock":crate::monotonic::CLOCK,"deadlineMonotonicMs":5000,"nativeSession":"d558a440-4a52-4c70-9411-e4bff1fe9a7f","requestSequence":1,"session":"source-session"}),
        };
        assert!(request
            .validate(Scope::LyricsCalibration, "source-session")
            .is_ok());
        request.op = "request".into();
        request.params = serde_json::json!({"version":1,"requestId":"ui-request","bindingId":"binding","requestSequence":1,"remainingMs":5000,"deadlineClock":crate::monotonic::CLOCK,"deadlineMonotonicMs":5000,"session":"source-session","trackId":"t".repeat(512),"generation":"18446744073709551615"});
        assert!(request
            .validate(Scope::LyricsCalibration, "source-session")
            .is_ok());
        assert!(crate::frame::serialize_bounded(&request, 4096).is_ok());
        request.params["generation"] = "g".repeat(4096).into();
        assert!(request
            .validate(Scope::LyricsCalibration, "source-session")
            .is_err());
        request.op = "snapshot".into();
        request.params = serde_json::json!({});
        assert!(request
            .validate(Scope::LyricsCalibration, "source-session")
            .is_err());
        request.scope = Scope::Lyrics;
        assert!(request.validate(Scope::Lyrics, "source-session").is_ok());
        request.op = "bind".into();
        assert!(request.validate(Scope::Lyrics, "source-session").is_err());
    }
}

#[cfg(test)]
mod vocal_tests {
    use super::*;

    #[test]
    fn vocal_capability_is_a_readonly_document_parameter() {
        let mut request = Request {
            bridge_protocol: BRIDGE_PROTOCOL,
            request_id: "request".into(),
            server_instance_id: "session".into(),
            scope: Scope::Lyrics,
            key: "credential".into(),
            op: "document".into(),
            params: serde_json::json!({"key":"doc"}),
        };
        assert!(request.validate(Scope::Lyrics, "session").is_ok());
        for params in [
            serde_json::json!({"key":"doc","vocalSchemaVersion":1}),
            serde_json::json!({"key":"doc","vocalSchemaVersion":2}),
        ] {
            request.params = params;
            assert!(
                request.validate(Scope::Lyrics, "session").is_ok(),
                "integer capability reaches the shared capability adjudicator"
            );
        }
        for params in [
            serde_json::json!({"key":"doc","vocalSchemaVersion":null}),
            serde_json::json!({"key":"doc","vocalSchemaVersion":"1"}),
            serde_json::json!({"key":"doc","vocalSchemaVersion":1.0}),
            serde_json::json!({"key":"doc","vocalSchemaVersion":true}),
            serde_json::json!({"key":"doc","vocalSchemaVersion":1,"offsetMs":10}),
        ] {
            request.params = params;
            assert!(request.validate(Scope::Lyrics, "session").is_err());
        }
        request.params = serde_json::json!({"key":"doc","vocalSchemaVersion":1});
        assert!(request.validate(Scope::Wallpaper, "session").is_err());
        request.op = "snapshot".into();
        assert!(request.validate(Scope::Lyrics, "session").is_err());
        request.op = "seek".into();
        assert!(request.validate(Scope::Lyrics, "session").is_err());
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
    #[serde(
        default,
        rename = "lyricsCalibration",
        skip_serializing_if = "Option::is_none"
    )]
    pub lyrics_calibration: Option<String>,
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
            || self.pipes.lyrics.is_none()
                && self.pipes.wallpaper.is_none()
                && self.pipes.lyrics_calibration.is_none()
            || self.pipes.lyrics.is_some() && self.pipes.lyrics == self.pipes.wallpaper
            || self.pipes.lyrics_calibration.is_some()
                && (self.pipes.lyrics_calibration == self.pipes.lyrics
                    || self.pipes.lyrics_calibration == self.pipes.wallpaper)
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
        for pipe in [
            &self.pipes.lyrics,
            &self.pipes.wallpaper,
            &self.pipes.lyrics_calibration,
        ]
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
