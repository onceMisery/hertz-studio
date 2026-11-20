// SPDX-License-Identifier: MIT
//! Fixed renderer qualification data and parent-owned loopback controls.
//! Neither page claims nor quiet listeners grant OS/network qualification.
use super::protocol::{invalid, ProbeMode};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener, TcpStream, UdpSocket};
use std::time::Duration;

pub const GRAPHICS_ROUNDS: u32 = 8;
pub const RENDERER_DEADLINE_SECONDS: u64 = 20;
pub const NETWORK_CASES: &[&str] = &[
    "http4",
    "https4",
    "http6",
    "https6",
    "xhr",
    "beacon",
    "eventSource",
    "webSocket",
    "secureWebSocket",
    "webTransport",
    "rtcStun",
    "worker",
    "blobWorker",
    "sharedWorker",
    "serviceWorker",
    "image",
    "iframe",
    "form",
    "dnsPrefetch",
    "preconnect",
    "redirect",
    "download",
    "popup",
    "externalUri",
    "navigation",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkTargets {
    pub tcp4: u16,
    pub tcp6: u16,
    pub udp4: u16,
}
impl NetworkTargets {
    pub fn validate(&self) -> io::Result<()> {
        if self.tcp4 == 0 || self.tcp6 == 0 || self.udp4 == 0 {
            return invalid("missing owned loopback port");
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AttemptOutcome {
    Fulfilled,
    Rejected,
    TimedOut,
    Unavailable,
    Dispatched,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkAttempt {
    pub id: String,
    pub outcome: AttemptOutcome,
    pub elapsed_ms: u32,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RtcPhase {
    NotStarted,
    Unavailable,
    CreatePeer,
    CreateOffer,
    SetLocalDescription,
    Gathering,
    Completed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CspViolation {
    pub directive: String,
    pub blocked: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum RendererReceipt {
    #[serde(rename_all = "camelCase")]
    Network {
        attempts: Vec<NetworkAttempt>,
        violations: Vec<CspViolation>,
        rtc_phase: RtcPhase,
    },
    #[serde(rename_all = "camelCase")]
    Graphics {
        canvas_rounds: u32,
        web_gl_rounds: u32,
        image_decode_rounds: u32,
        video_decode_rounds: u32,
        failure: Option<String>,
    },
}
impl RendererReceipt {
    pub fn mode(&self) -> ProbeMode {
        match self {
            Self::Network { .. } => ProbeMode::RendererNetwork,
            Self::Graphics { .. } => ProbeMode::GraphicsPressure,
        }
    }
    pub fn validate(&self) -> io::Result<()> {
        match self {
            Self::Network {
                attempts,
                violations,
                ..
            } => {
                if attempts.len() != NETWORK_CASES.len()
                    || !attempts
                        .iter()
                        .zip(NETWORK_CASES)
                        .all(|(a, id)| a.id == *id)
                    || violations.len() > 32
                    || attempts.iter().any(|a| a.elapsed_ms > 20_000)
                    || violations
                        .iter()
                        .any(|v| v.directive.len() > 64 || v.blocked.len() > 256)
                {
                    return invalid("invalid fixed network coverage receipt");
                }
            }
            Self::Graphics {
                canvas_rounds,
                web_gl_rounds,
                image_decode_rounds,
                video_decode_rounds,
                failure,
            } => {
                if [
                    canvas_rounds,
                    web_gl_rounds,
                    image_decode_rounds,
                    video_decode_rounds,
                ]
                .iter()
                .any(|rounds| **rounds > GRAPHICS_ROUNDS)
                    || failure
                        .as_ref()
                        .is_some_and(|f| f.is_empty() || f.len() > 128)
                {
                    return invalid("invalid fixed graphics receipt");
                }
            }
        }
        Ok(())
    }
    /// Only the bounded software workload. Native close and OS qualification are separate.
    pub fn workload_passed(&self, denials: &NativeDenials) -> bool {
        if self.validate().is_err() {
            return false;
        }
        match self {
            Self::Graphics {
                canvas_rounds,
                web_gl_rounds,
                image_decode_rounds,
                video_decode_rounds,
                failure,
            } => {
                failure.is_none()
                    && [
                        canvas_rounds,
                        web_gl_rounds,
                        image_decode_rounds,
                        video_decode_rounds,
                    ]
                    .iter()
                    .all(|rounds| **rounds == GRAPHICS_ROUNDS)
            }
            Self::Network {
                attempts,
                violations,
                rtc_phase,
            } => {
                // Dispatch/timing alone cannot prove denial. Require actual policy
                // observations as well as the independent final transport control.
                attempts.iter().all(|a| {
                    matches!(
                        a.outcome,
                        AttemptOutcome::Rejected | AttemptOutcome::Dispatched
                    )
                }) && [
                    "connect-src",
                    "worker-src",
                    "img-src",
                    "frame-src",
                    "form-action",
                ]
                .iter()
                .all(|d| violations.iter().any(|v| v.directive == *d))
                    && denials.navigation >= 2
                    && denials.new_window >= 1
                    && denials.download >= 1
                    && matches!(rtc_phase, RtcPhase::Completed)
            }
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeDenials {
    pub resource: u32,
    pub navigation: u32,
    pub new_window: u32,
    pub external_uri: u32,
    pub permission: u32,
    pub download: u32,
}

struct TcpControl {
    listener: TcpListener,
    accepted: u32,
}
struct UdpControl {
    socket: UdpSocket,
    received: u32,
}
pub struct NetworkFixture {
    tcp4: TcpControl,
    tcp6: TcpControl,
    udp4: UdpControl,
}
impl TcpControl {
    fn new(ip: IpAddr) -> Result<Self> {
        let listener = TcpListener::bind((ip, 0))?;
        listener.set_nonblocking(true)?;
        let positive = TcpStream::connect_timeout(&listener.local_addr()?, Duration::from_secs(1))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        loop {
            match listener.accept() {
                Ok(_) => break,
                Err(e)
                    if e.kind() == io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(e) => return Err(e.into()),
            }
        }
        drop(positive);
        Ok(Self {
            listener,
            accepted: 0,
        })
    }
    fn poll(&mut self) -> Result<()> {
        // Monotonic observations: later sampling cannot erase an earlier escape.
        for _ in 0..32 {
            match self.listener.accept() {
                Ok(_) => self.accepted = self.accepted.saturating_add(1),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }
}
impl NetworkFixture {
    pub fn create() -> Result<Self> {
        let tcp4 = TcpControl::new(Ipv4Addr::LOCALHOST.into())?;
        let tcp6 = TcpControl::new(Ipv6Addr::LOCALHOST.into())?;
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?;
        socket.set_read_timeout(Some(Duration::from_secs(1)))?;
        let positive = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))?;
        positive.send_to(b"g3s-loopback", socket.local_addr()?)?;
        let mut buffer = [0; 64];
        let (len, _) = socket.recv_from(&mut buffer)?;
        if &buffer[..len] != b"g3s-loopback" {
            bail!("UDP positive control mismatch");
        }
        socket.set_nonblocking(true)?;
        Ok(Self {
            tcp4,
            tcp6,
            udp4: UdpControl {
                socket,
                received: 0,
            },
        })
    }
    pub fn targets(&self) -> Result<NetworkTargets> {
        Ok(NetworkTargets {
            tcp4: self.tcp4.listener.local_addr()?.port(),
            tcp6: self.tcp6.listener.local_addr()?.port(),
            udp4: self.udp4.socket.local_addr()?.port(),
        })
    }
    pub fn sample(&mut self) -> Result<serde_json::Value> {
        self.tcp4.poll()?;
        self.tcp6.poll()?;
        let mut buffer = [0; 2048];
        for _ in 0..32 {
            match self.udp4.socket.recv_from(&mut buffer) {
                Ok(_) => self.udp4.received = self.udp4.received.saturating_add(1),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => return Err(e.into()),
            }
        }
        Ok(serde_json::json!({"parentPositiveControls":true,
            "tcp4Connections":self.tcp4.accepted,"tcp6Connections":self.tcp6.accepted,
            "udp4Datagrams":self.udp4.received,
            "listenersQuiet":self.tcp4.accepted == 0 && self.tcp6.accepted == 0 && self.udp4.received == 0,
            "scope":"owned loopback transports only; no DNS/TLS/QUIC/STUN handshake or private/public routing qualification"}))
    }
}

#[cfg(test)]
mod tests {
    use super::super::protocol::{Identity, WorkerControl};
    use super::*;

    fn network_receipt() -> RendererReceipt {
        RendererReceipt::Network {
            attempts: NETWORK_CASES
                .iter()
                .map(|id| NetworkAttempt {
                    id: (*id).into(),
                    outcome: AttemptOutcome::Rejected,
                    elapsed_ms: 1,
                })
                .collect(),
            rtc_phase: RtcPhase::Completed,
            violations: [
                "connect-src",
                "worker-src",
                "img-src",
                "frame-src",
                "form-action",
            ]
            .iter()
            .map(|d| CspViolation {
                directive: (*d).into(),
                blocked: "http://127.0.0.1:1".into(),
            })
            .collect(),
        }
    }

    #[test]
    fn fixed_receipt_requires_complete_coverage_and_actual_policy_observations() {
        let denials = NativeDenials {
            navigation: 2,
            new_window: 1,
            download: 1,
            ..Default::default()
        };
        let good = network_receipt();
        assert!(good.workload_passed(&denials));
        assert!(!good.workload_passed(&NativeDenials::default()));
        let mut missing = good.clone();
        if let RendererReceipt::Network { attempts, .. } = &mut missing {
            attempts.pop();
        }
        assert!(missing.validate().is_err());
        let mut duplicate = good.clone();
        if let RendererReceipt::Network { attempts, .. } = &mut duplicate {
            attempts[1].id = attempts[0].id.clone();
        }
        assert!(duplicate.validate().is_err());
        let mut escaped = good.clone();
        if let RendererReceipt::Network { attempts, .. } = &mut escaped {
            attempts[0].outcome = AttemptOutcome::Fulfilled;
        }
        assert!(!escaped.workload_passed(&denials));
        for outcome in [AttemptOutcome::TimedOut, AttemptOutcome::Unavailable] {
            let mut incomplete = good.clone();
            if let RendererReceipt::Network { attempts, .. } = &mut incomplete {
                attempts[9].outcome = outcome;
            }
            assert!(!incomplete.workload_passed(&denials));
        }
        let mut unfinished_rtc = good.clone();
        if let RendererReceipt::Network { rtc_phase, .. } = &mut unfinished_rtc {
            *rtc_phase = RtcPhase::CreateOffer;
        }
        assert!(!unfinished_rtc.workload_passed(&denials));
        let mut excessive_time = good.clone();
        if let RendererReceipt::Network { attempts, .. } = &mut excessive_time {
            attempts[0].elapsed_ms = 20_001;
        }
        assert!(excessive_time.validate().is_err());
        let mut quiet = good.clone();
        if let RendererReceipt::Network { violations, .. } = &mut quiet {
            violations.clear();
        }
        assert!(!quiet.workload_passed(&denials));
        let mut overflow = good;
        if let RendererReceipt::Network { violations, .. } = &mut overflow {
            violations[0].blocked = "x".repeat(257);
        }
        assert!(overflow.validate().is_err());
    }

    #[test]
    fn renderer_receipt_keeps_generation_and_control_size_bounds() {
        let identity = Identity {
            session_id: uuid::Uuid::new_v4().to_string(),
            generation: 1,
            package_hash: "a".repeat(64),
        };
        let message = WorkerControl::RendererCompleted {
            identity: identity.clone(),
            receipt: network_receipt(),
            denials: NativeDenials::default(),
        };
        assert!(message.validate(&identity).is_ok());
        let mut stale = identity.clone();
        stale.generation += 1;
        assert!(message.validate(&stale).is_err());
        let encoded = serde_json::to_vec(&message).unwrap();
        assert!(encoded.len() < super::super::protocol::CONTROL_LIMIT);
        let decoded: WorkerControl = serde_json::from_slice(&encoded).unwrap();
        assert!(decoded.validate(&identity).is_ok());
        let mut wrong = serde_json::to_value(message).unwrap();
        wrong["receipt"]["arbitraryCommand"] = serde_json::json!(true);
        assert!(serde_json::from_value::<WorkerControl>(wrong).is_err());
    }

    #[test]
    fn partial_graphics_and_failed_cleanup_never_pass() {
        for (rounds, failure, expected) in [
            (8, None, true),
            (7, None, false),
            (8, Some("cleanup failed".to_owned()), false),
        ] {
            let receipt = RendererReceipt::Graphics {
                canvas_rounds: 8,
                web_gl_rounds: rounds,
                image_decode_rounds: 8,
                video_decode_rounds: 8,
                failure,
            };
            assert_eq!(receipt.workload_passed(&NativeDenials::default()), expected);
        }
        let excessive = RendererReceipt::Graphics {
            canvas_rounds: 9,
            web_gl_rounds: 8,
            image_decode_rounds: 8,
            video_decode_rounds: 8,
            failure: None,
        };
        assert!(excessive.validate().is_err());
    }

    #[test]
    fn listener_observations_survive_repeated_sampling() {
        let mut fixture = NetworkFixture::create().unwrap();
        assert_eq!(fixture.sample().unwrap()["listenersQuiet"], true);
        let ports = fixture.targets().unwrap();
        let tcp4 = TcpStream::connect((Ipv4Addr::LOCALHOST, ports.tcp4)).unwrap();
        let tcp6 = TcpStream::connect((Ipv6Addr::LOCALHOST, ports.tcp6)).unwrap();
        let udp = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        udp.send_to(b"observed", (Ipv4Addr::LOCALHOST, ports.udp4))
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        let first = loop {
            let sample = fixture.sample().unwrap();
            if sample["tcp4Connections"] == 1
                && sample["tcp6Connections"] == 1
                && sample["udp4Datagrams"] == 1
            {
                break sample;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        };
        drop((tcp4, tcp6));
        assert_eq!(first, fixture.sample().unwrap());
        assert_eq!(first["listenersQuiet"], false);
    }
}
