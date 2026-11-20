// SPDX-License-Identifier: MIT
//! Private G3-S protocol. Lengths are checked before allocation on both channels.
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

pub const PROTOCOL: u32 = 1;
pub const CONTROL_LIMIT: usize = 8 * 1024;
pub const RESOURCE_CHUNK: usize = 64 * 1024;
pub const RESOURCE_STREAM_LIMIT: usize = 1024 * 1024;
pub const RESOURCE_CONCURRENCY: usize = 8;
pub const CONTROL_QUEUE_FRAMES: usize = 32;
pub const PROBE_MEMORY_BYTES: u64 = 64 * 1024 * 1024;
pub const PROBE_MEMORY_LIMIT_BYTES: u64 = 640 * 1024 * 1024;
pub const PROBE_BUSY_MS: u64 = 8_000;
// Rust 1.88 does not count the anonymous const assertion as a live reference.
#[allow(dead_code)]
pub const CONTROL_QUEUE_BYTES: usize = 256 * 1024;
const _: () = assert!(CONTROL_QUEUE_FRAMES * CONTROL_LIMIT <= CONTROL_QUEUE_BYTES);

/// Fixed, paired-binary qualification workloads. This is not an author script or command API.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProbeMode {
    #[default]
    Startup,
    OsBoundaries,
    BusySuspend,
    BoundedMemory,
    MemoryLimit,
    MessageFlood,
}
impl ProbeMode {
    pub fn from_cli(value: &str) -> io::Result<Self> {
        match value {
            "startup" => Ok(Self::Startup),
            "os-boundaries" => Ok(Self::OsBoundaries),
            "busy-suspend" => Ok(Self::BusySuspend),
            "bounded-memory" => Ok(Self::BoundedMemory),
            "memory-limit" => Ok(Self::MemoryLimit),
            "message-flood" => Ok(Self::MessageFlood),
            _ => invalid("unknown fixed qualification probe"),
        }
    }
    pub fn expects_termination(self) -> bool {
        matches!(
            self,
            Self::BusySuspend | Self::BoundedMemory | Self::MemoryLimit | Self::MessageFlood
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundaryProbe {
    pub canary_path: String,
    pub excluded_handle: u64,
    pub tcp_port: u16,
    pub udp_port: u16,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundaryReceipt {
    pub own_udf_read_write: bool,
    pub outside_read_error: Option<i32>,
    pub outside_write_error: Option<i32>,
    pub outside_create_error: Option<i32>,
    pub inherited_parent_duplicate_error: Option<i32>,
    pub parent_harmful_open_error: Option<i32>,
    pub tcp_connect_error: Option<i32>,
    pub udp_send_error: Option<i32>,
    pub udp_denial_operation: UdpProbeOperation,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UdpProbeOperation {
    Bind,
    SendTo,
}
impl BoundaryReceipt {
    pub fn passed(&self) -> bool {
        self.own_udf_read_write
            && self.outside_read_error == Some(5)
            && self.outside_write_error == Some(5)
            && self.outside_create_error == Some(5)
            && self.inherited_parent_duplicate_error == Some(5)
            && self.parent_harmful_open_error == Some(5)
            && self.tcp_connect_error == Some(10013)
            && self.udp_send_error == Some(10013)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub session_id: String,
    pub generation: u64,
    pub package_hash: String,
}
impl Identity {
    pub fn validate(&self) -> io::Result<()> {
        if uuid::Uuid::parse_str(&self.session_id).is_err()
            || self.generation == 0
            || self.package_hash.len() != 64
            || !self
                .package_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return invalid("invalid session identity");
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Viewport {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Budget {
    pub private_commit_bytes: u64,
    pub process_limit: u32,
    pub logical_cpus: u32,
    pub cpu_rate: u32,
}
impl Budget {
    pub fn validate(&self) -> io::Result<()> {
        if self.private_commit_bytes != 536_870_912
            || self.process_limit != 32
            || self.logical_cpus == 0
            || self.logical_cpus > 10_000
            || self.cpu_rate != 10_000 / self.logical_cpus
            || self.cpu_rate == 0
        {
            return invalid("budget differs from frozen G3-S limits");
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bootstrap {
    pub worker_protocol: u32,
    pub identity: Identity,
    pub entry: String,
    pub viewport: Viewport,
    pub budget: Budget,
    pub desktop_build_id: String,
    pub worker_sha256: String,
    pub app_container_sid: String,
    pub parent_pid: u32,
    pub parent_created: u64,
    pub runtime_folder: String,
    pub runtime_version: String,
    pub user_data_folder: String,
    pub probe_mode: ProbeMode,
    pub boundary_probe: Option<BoundaryProbe>,
}
impl Bootstrap {
    pub fn validate(&self) -> io::Result<()> {
        self.identity.validate()?;
        self.budget.validate()?;
        if self.worker_protocol != PROTOCOL
            || self.entry != "index.html"
            || self.viewport.width == 0
            || self.viewport.height == 0
            || self.viewport.width > 32_768
            || self.viewport.height > 32_768
            || self.desktop_build_id.is_empty()
            || self.desktop_build_id.len() > 128
            || self.worker_sha256.len() != 64
            || !self.worker_sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || !self.app_container_sid.starts_with("S-1-15-2-")
            || self.app_container_sid.len() > 256
            || self.parent_pid == 0
            || self.parent_created == 0
            || self.runtime_version.is_empty()
            || self.runtime_version.len() > 128
            || !std::path::Path::new(&self.runtime_folder).is_absolute()
            || !std::path::Path::new(&self.user_data_folder).is_absolute()
            || self.runtime_folder.len() > 4096
            || self.user_data_folder.len() > 4096
        {
            return invalid("invalid private bootstrap");
        }
        match (&self.boundary_probe, self.probe_mode) {
            (None, mode) if mode != ProbeMode::OsBoundaries => {}
            (Some(probe), ProbeMode::OsBoundaries) => {
                let expected = std::path::Path::new(&self.user_data_folder)
                    .parent()
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidData, "missing UDF parent")
                    })?
                    .join("denied-canary/existing.txt");
                if std::path::Path::new(&probe.canary_path) != expected
                    || probe.excluded_handle == 0
                    || probe.excluded_handle == u64::MAX
                    || probe.tcp_port == 0
                    || probe.udp_port == 0
                {
                    return invalid("boundary fixture differs from fixed owned scope");
                }
            }
            _ => return invalid("boundary fixture and probe mode differ"),
        }
        Ok(())
    }
    pub fn origin(&self) -> String {
        format!(
            "https://{}.{}.wallpaper.invalid",
            &self.identity.package_hash[..32],
            &self.identity.package_hash[32..]
        )
    }
    pub fn entry_url(&self) -> String {
        format!("{}/files/{}", self.origin(), self.entry)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub created: u64,
    pub kind: i32,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ParentControl {
    Bootstrap { bootstrap: Box<Bootstrap> },
    Mounted { identity: Identity, hwnd: u64 },
    Stop { identity: Identity },
    RunProbe { identity: Identity },
    SuspendProbe { identity: Identity },
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum WorkerControl {
    Boundaries {
        identity: Identity,
        receipt: BoundaryReceipt,
    },
    ProbeStarted {
        identity: Identity,
        mode: ProbeMode,
        allocated_bytes: u64,
    },
    SuspendRequested {
        identity: Identity,
    },
    SuspendResult {
        identity: Identity,
        succeeded: bool,
    },
    ProbeRejected {
        identity: Identity,
        reason: String,
    },
    Stage {
        identity: Identity,
        stage: String,
    },
    Window {
        identity: Identity,
        hwnd: u64,
        pid: u32,
        created: u64,
    },
    Environment {
        identity: Identity,
        runtime_version: String,
        browser_pid: u32,
        processes: Vec<ProcessIdentity>,
        muted: bool,
        required_interfaces: bool,
    },
    FirstFrame {
        identity: Identity,
        width: u32,
        height: u32,
        capture_sha256: String,
        capture_png: String,
    },
    Closed {
        identity: Identity,
        controller_closed: bool,
        hwnd_destroyed: bool,
    },
    Failed {
        identity: Identity,
        stage: String,
        message: String,
    },
}
impl WorkerControl {
    pub fn identity(&self) -> &Identity {
        match self {
            Self::Stage { identity, .. } => identity,
            Self::Window { identity, .. }
            | Self::Boundaries { identity, .. }
            | Self::ProbeStarted { identity, .. }
            | Self::SuspendRequested { identity }
            | Self::SuspendResult { identity, .. }
            | Self::ProbeRejected { identity, .. }
            | Self::Environment { identity, .. }
            | Self::FirstFrame { identity, .. }
            | Self::Closed { identity, .. }
            | Self::Failed { identity, .. } => identity,
        }
    }
    pub fn validate(&self, expected: &Identity) -> io::Result<()> {
        if self.identity() != expected {
            return invalid("stale worker generation");
        }
        match self {
            Self::ProbeRejected { reason, .. } if reason.len() > 128 => {
                invalid("oversize probe rejection")
            }
            Self::ProbeStarted {
                mode,
                allocated_bytes,
                ..
            } if !mode.expects_termination()
                || (*mode == ProbeMode::BoundedMemory
                    && *allocated_bytes != PROBE_MEMORY_BYTES)
                || (*mode != ProbeMode::BoundedMemory && *allocated_bytes != 0) =>
            {
                invalid("invalid fixed probe start")
            }
            Self::Stage { stage, .. } if stage.len() > 128 => invalid("oversize startup stage"),
            Self::Environment {
                runtime_version,
                processes,
                ..
            } if runtime_version.len() > 128 || processes.is_empty() || processes.len() > 32 => {
                invalid("invalid environment process set")
            }
            Self::Failed { stage, message, .. } if stage.len() > 128 || message.len() > 1024 => {
                invalid("oversize diagnostic")
            }
            Self::FirstFrame {
                capture_sha256,
                capture_png,
                width,
                height,
                ..
            } if capture_sha256.len() != 64
                || capture_png.len() > 4096
                || *width == 0
                || *height == 0 =>
            {
                invalid("invalid first frame")
            }
            _ => Ok(()),
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRequest {
    pub identity: Identity,
    pub request_id: u64,
    pub method: String,
    pub path: String,
}
impl ResourceRequest {
    pub fn validate(&self, expected: &Identity) -> io::Result<()> {
        if &self.identity != expected
            || self.request_id == 0
            || !matches!(self.method.as_str(), "GET" | "HEAD")
            || !matches!(self.path.as_str(), "index.html" | "probe.js" | "probe.css")
        {
            return invalid("resource outside fixed probe package");
        }
        Ok(())
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceResponse {
    pub identity: Identity,
    pub request_id: u64,
    pub status: u16,
    pub mime: String,
    pub body_bytes: u32,
}

pub fn invalid<T>(message: &str) -> io::Result<T> {
    Err(io::Error::new(io::ErrorKind::InvalidData, message))
}
pub fn write_json<T: Serialize>(writer: &mut impl Write, value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    write_frame(writer, &bytes, CONTROL_LIMIT)
}
pub fn read_json<T: serde::de::DeserializeOwned>(reader: &mut impl Read) -> io::Result<T> {
    let bytes = read_frame(reader, CONTROL_LIMIT)?;
    serde_json::from_slice(&bytes).map_err(Into::into)
}
pub fn write_frame(writer: &mut impl Write, bytes: &[u8], limit: usize) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > limit {
        return invalid("frame length exceeds channel limit");
    }
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(bytes)?;
    writer.flush()
}
pub fn read_frame(reader: &mut impl Read, limit: usize) -> io::Result<Vec<u8>> {
    let mut prefix = [0; 4];
    reader.read_exact(&mut prefix)?;
    let length = u32::from_le_bytes(prefix) as usize;
    if length == 0 || length > limit {
        return invalid("frame length exceeds channel limit");
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}
pub fn write_body(writer: &mut impl Write, body: &[u8]) -> io::Result<()> {
    if body.len() > RESOURCE_STREAM_LIMIT {
        return invalid("resource exceeds stream budget");
    }
    for chunk in body.chunks(RESOURCE_CHUNK) {
        write_frame(writer, chunk, RESOURCE_CHUNK)?;
    }
    Ok(())
}
pub fn read_body(reader: &mut impl Read, length: u32) -> io::Result<Vec<u8>> {
    let length = length as usize;
    if length > RESOURCE_STREAM_LIMIT {
        return invalid("resource exceeds stream budget");
    }
    let mut body = Vec::with_capacity(length);
    while body.len() < length {
        let chunk = read_frame(reader, RESOURCE_CHUNK)?;
        if chunk.len() > length - body.len() {
            return invalid("resource body exceeds declared size");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
/// Rate state belongs to the native receiver, never to a page counter.
pub struct InboundRate {
    tokens: f64,
    last: Instant,
}
impl InboundRate {
    pub fn new() -> Self {
        Self {
            tokens: 120.0,
            last: Instant::now(),
        }
    }
    pub fn admit(&mut self) -> bool {
        let now = Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f64() * 60.0).min(120.0);
        self.last = now;
        if self.tokens < 1.0 {
            false
        } else {
            self.tokens -= 1.0;
            true
        }
    }
}
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn boundary_receipts_require_access_denied_not_unreachable_or_absent() {
        let mut receipt = BoundaryReceipt {
            own_udf_read_write: true,
            outside_read_error: Some(5),
            outside_write_error: Some(5),
            outside_create_error: Some(5),
            inherited_parent_duplicate_error: Some(5),
            parent_harmful_open_error: Some(5),
            tcp_connect_error: Some(10013),
            udp_send_error: Some(10013),
            udp_denial_operation: UdpProbeOperation::SendTo,
        };
        assert!(receipt.passed());
        receipt.outside_read_error = Some(2);
        assert!(!receipt.passed());
        receipt.outside_read_error = Some(5);
        for code in [None, Some(10060), Some(10061)] {
            receipt.tcp_connect_error = code;
            assert!(!receipt.passed());
        }
        receipt.tcp_connect_error = Some(10013);
        receipt.inherited_parent_duplicate_error = None;
        assert!(!receipt.passed());
    }
    #[test]
    fn fixed_probe_modes_reject_arbitrary_commands_and_oversized_claims() {
        assert!(ProbeMode::from_cli("busy-suspend")
            .unwrap()
            .expects_termination());
        for mode in [
            "powershell",
            "javascript:alert(1)",
            "../probe",
            "",
            "STARTUP",
        ] {
            assert!(ProbeMode::from_cli(mode).is_err());
        }
        let identity = Identity {
            session_id: uuid::Uuid::new_v4().to_string(),
            generation: 1,
            package_hash: "0".repeat(64),
        };
        let receipt = WorkerControl::ProbeStarted {
            identity: identity.clone(),
            mode: ProbeMode::BoundedMemory,
            allocated_bytes: PROBE_MEMORY_BYTES + 1,
        };
        assert!(receipt.validate(&identity).is_err());
        let receipt = WorkerControl::ProbeStarted {
            identity: identity.clone(),
            mode: ProbeMode::Startup,
            allocated_bytes: 0,
        };
        assert!(receipt.validate(&identity).is_err());
    }
    #[test]
    fn rejects_length_before_body_allocation() {
        let mut bytes = std::io::Cursor::new((CONTROL_LIMIT as u32 + 1).to_le_bytes());
        assert_eq!(
            read_json::<ParentControl>(&mut bytes).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(read_frame(&mut &0u32.to_le_bytes()[..], CONTROL_LIMIT).is_err());
    }
    #[test]
    fn rejects_unknown_and_duplicate_control_fields() {
        for body in [
            r#"{"type":"stop","identity":{"sessionId":"x","generation":1,"packageHash":"x"},"extra":1}"#,
            r#"{"type":"stop","identity":{},"identity":{}}"#,
        ] {
            let mut bytes = Vec::new();
            write_frame(&mut bytes, body.as_bytes(), CONTROL_LIMIT).unwrap();
            assert!(read_json::<ParentControl>(&mut &bytes[..]).is_err());
        }
    }
    #[test]
    fn chunks_are_bounded_and_exact() {
        let original = vec![42; RESOURCE_CHUNK * 2 + 17];
        let mut bytes = Vec::new();
        write_body(&mut bytes, &original).unwrap();
        assert_eq!(
            read_body(&mut &bytes[..], original.len() as u32).unwrap(),
            original
        );
        assert!(read_body(&mut &bytes[..], 16).is_err());
        assert!(read_body(&mut &[][..], RESOURCE_STREAM_LIMIT as u32 + 1).is_err());
    }
    #[test]
    fn frozen_cpu_budget_and_flood_burst() {
        assert!(Budget {
            private_commit_bytes: 536870912,
            process_limit: 32,
            logical_cpus: 16,
            cpu_rate: 625
        }
        .validate()
        .is_ok());
        assert!(Budget {
            private_commit_bytes: 536870913,
            process_limit: 32,
            logical_cpus: 16,
            cpu_rate: 625
        }
        .validate()
        .is_err());
        let mut rate = InboundRate::new();
        for _ in 0..120 {
            assert!(rate.admit());
        }
        assert!(!rate.admit());
    }
}
