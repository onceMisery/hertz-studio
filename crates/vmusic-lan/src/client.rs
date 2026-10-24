// SPDX-License-Identifier: MIT
//! Native pinned client. Browsers call their local service, never this TLS endpoint.
use crate::buffer::{MemoryBudget, Reservation, ENDPOINT_BYTES};
use crate::clock::{ClockMapping, Estimator, MonotonicClock, TimeSample};
use crate::members::{Paired, Permissions, Secret};
use crate::notifications::Notifications;
use crate::protocol::{ControlFrame, Counter, PcmBlock, StreamIdentity, MAX_MESSAGE, VERSION};
use crate::server::ROOM_PATH;
use crate::tls::{self, Fingerprint};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};
use tokio_tungstenite::{client_async_with_config, WebSocketStream};
use uuid::Uuid;

type Socket = WebSocketStream<TlsStream<TcpStream>>;
const TIMEOUT: Duration = Duration::from_secs(5);
const SEND_TIMEOUT: Duration = Duration::from_millis(500);
const CLOCK_PROBE_INTERVAL_NS: u64 = 1_000_000_000;

fn clock_probe_due(ticks: u64, mapping: Option<ClockMapping>, now: u64) -> bool {
    ticks <= 20
        || ticks.is_multiple_of(10)
        || mapping.is_none_or(|mapping| {
            !mapping.valid_at(now)
                || now.saturating_sub(mapping.reference_local_ns) >= CLOCK_PROBE_INTERVAL_NS
        })
}

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("room connection closed, timed out or exceeded buffer capacity")]
    Connection,
    #[error("room protocol, session or version mismatch")]
    Protocol,
    #[error("pairing rejected")]
    Pairing,
    #[error("room authorization expired; a new invitation is required")]
    AuthorizationExpired,
    #[error("room ended: {0}")]
    Ended(String),
    #[error(transparent)]
    Tls(#[from] tls::TlsError),
}
#[derive(Debug, Clone, Copy, Default)]
pub struct OutputStatus {
    pub ready: bool,
    pub played_frame: u64,
    pub underrun_frames: u64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    Connected,
    Closing { reason: String },
    Closed { reason: String, terminal: bool },
}
pub struct ReceivedPcm {
    block: PcmBlock,
    _reservation: Reservation,
}
impl ReceivedPcm {
    pub fn block(&self) -> &PcmBlock {
        &self.block
    }
    /// The receiver must reserve its own bounded queue before transferring.
    pub fn into_block(self) -> PcmBlock {
        self.block
    }
}
pub struct ClientEvents {
    pub chat: Arc<Notifications>,
    pub control: mpsc::Receiver<ControlFrame>,
    pub audio: mpsc::Receiver<ReceivedPcm>,
    pub mapping: watch::Receiver<Option<ClockMapping>>,
    pub state: watch::Receiver<ConnectionState>,
}
#[derive(Clone)]
pub struct ClientHandle {
    pub identity: StreamIdentity,
    commands: mpsc::Sender<ControlFrame>,
    output: watch::Sender<OutputStatus>,
    stop: watch::Sender<bool>,
    clock: MonotonicClock,
}
impl ClientHandle {
    pub fn send(&self, frame: ControlFrame) -> Result<(), ClientError> {
        frame.encode().map_err(|_| ClientError::Protocol)?;
        if !matches!(
            frame,
            ControlFrame::Ready { .. } | ControlFrame::Request { .. } | ControlFrame::Resync { .. }
        ) {
            return Err(ClientError::Protocol);
        }
        self.commands
            .try_send(frame)
            .map_err(|_| ClientError::Connection)
    }
    pub fn output_status(&self, status: OutputStatus) {
        self.output.send_replace(status);
    }
    pub fn clock(&self) -> MonotonicClock {
        self.clock.clone()
    }
    pub fn close(&self) {
        self.stop.send_replace(true);
    }
}
pub struct ClientConnection {
    pub handle: ClientHandle,
    task: Option<JoinHandle<()>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionMode {
    Listening,
    ControlOnly,
}

impl ClientConnection {
    pub async fn connect(
        address: SocketAddr,
        fingerprint: Fingerprint,
        room_id: Uuid,
        member_id: Uuid,
        credential: &Secret,
    ) -> Result<(Self, ClientEvents), ClientError> {
        Self::connect_mode(
            address,
            fingerprint,
            room_id,
            member_id,
            credential,
            ConnectionMode::Listening,
        )
        .await
    }

    pub async fn connect_mode(
        address: SocketAddr,
        fingerprint: Fingerprint,
        room_id: Uuid,
        member_id: Uuid,
        credential: &Secret,
        mode: ConnectionMode,
    ) -> Result<(Self, ClientEvents), ClientError> {
        let mut control = socket(address, fingerprint).await?;
        let auth = zeroize::Zeroizing::new(
            serde_json::json!({"channel":"control","version":VERSION,"room_id":room_id,
            "member_id":member_id,"credential":credential.expose()})
            .to_string(),
        );
        send(&mut control, Message::Text(auth.to_string().into())).await?;
        let message = tokio::time::timeout(TIMEOUT, control.next())
            .await
            .map_err(|_| ClientError::Connection)?;
        let Some(Ok(Message::Text(text))) = message else {
            return Err(ClientError::Protocol);
        };
        let identity = match ControlFrame::decode(&text).map_err(|_| ClientError::Protocol)? {
            ControlFrame::Hello { identity, .. } => identity,
            ControlFrame::End { reason } if reason == "room_authorization_expired" => {
                return Err(ClientError::AuthorizationExpired);
            }
            _ => return Err(ClientError::Protocol),
        };
        if identity.room_id != room_id
            || identity.session_id.is_nil()
            || identity.instance_id.is_nil()
        {
            return Err(ClientError::Protocol);
        }
        let audio = if mode == ConnectionMode::Listening {
            let mut audio = socket(address, fingerprint).await?;
            let auth = zeroize::Zeroizing::new(
                serde_json::json!({"channel":"audio","version":VERSION,"identity":identity,
                "member_id":member_id,"credential":credential.expose()})
                .to_string(),
            );
            send(&mut audio, Message::Text(auth.to_string().into())).await?;
            Some(audio)
        } else {
            None
        };
        let (commands, command_rx) = mpsc::channel(32);
        let (output, output_rx) = watch::channel(OutputStatus::default());
        let (stop, stopped) = watch::channel(false);
        let (control_tx, control_rx) = mpsc::channel(64);
        let (audio_tx, audio_rx) = mpsc::channel(150);
        let (mapping_tx, mapping_rx) = watch::channel(None);
        let chat = Notifications::new();
        let chat_tx = chat.clone();
        let (state_tx, state_rx) = watch::channel(ConnectionState::Connected);
        let clock = MonotonicClock::default();
        let task_clock = clock.clone();
        let task = tokio::spawn(async move {
            // Publish the typed terminal state before closing consumers' data
            // channels, including a connection that ends before its first poll.
            let control_lifetime = control_tx.clone();
            let audio_lifetime = audio_tx.clone();
            let mut stop_wait = stopped;
            let control = run_control(
                control, task_clock, command_rx, output_rx, control_tx, mapping_tx, chat_tx,
            );
            let audio = async move {
                if let Some(audio) = audio {
                    run_audio(audio, identity, audio_tx).await
                } else {
                    std::future::pending::<Result<(), ClientError>>().await
                }
            };
            tokio::pin!(control, audio);
            let result = tokio::select! {
                biased;
                _ = stop_wait.changed() => Ok(()),
                result = &mut control => result,
                failure = &mut audio => {
                    // Audio stops immediately. Keep control alive briefly so a
                    // normal End racing the audio EOF retains its terminal
                    // meaning; a missing control stream is still bounded.
                    state_tx.send_replace(ConnectionState::Closing { reason: "audio_connection_closed".into() });
                    tokio::select! {
                        _ = stop_wait.changed() => Ok(()),
                        result = tokio::time::timeout(Duration::from_secs(1), &mut control) => result.unwrap_or(failure),
                    }
                },
            };
            let failure = result.err();
            let terminal = matches!(
                failure,
                Some(ClientError::Ended(_) | ClientError::AuthorizationExpired)
            );
            state_tx.send_replace(ConnectionState::Closed {
                reason: failure
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "left_room".into()),
                terminal,
            });
            drop((control_lifetime, audio_lifetime));
        });
        Ok((
            Self {
                handle: ClientHandle {
                    identity,
                    commands,
                    output,
                    stop,
                    clock,
                },
                task: Some(task),
            },
            ClientEvents {
                chat,
                control: control_rx,
                audio: audio_rx,
                mapping: mapping_rx,
                state: state_rx,
            },
        ))
    }
    pub async fn shutdown(mut self) {
        self.handle.close();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for ClientConnection {
    fn drop(&mut self) {
        self.handle.close();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PairResponse {
    Paired {
        member_id: Uuid,
        credential: Secret,
        permissions: Permissions,
    },
    Rejected {
        code: String,
    },
}
pub async fn pair(
    address: SocketAddr,
    fingerprint: Fingerprint,
    room_id: Uuid,
    invitation: &Secret,
    name: &str,
) -> Result<Paired, ClientError> {
    crate::members::validate_name(name).map_err(|_| ClientError::Pairing)?;
    let mut socket = socket(address, fingerprint).await?;
    let auth = zeroize::Zeroizing::new(
        serde_json::json!({"channel":"pair","version":VERSION,"room_id":room_id,
        "invitation":invitation.expose(),"name":name})
        .to_string(),
    );
    send(&mut socket, Message::Text(auth.to_string().into())).await?;
    let response = tokio::time::timeout(TIMEOUT, socket.next())
        .await
        .map_err(|_| ClientError::Connection)?;
    let Some(Ok(Message::Text(text))) = response else {
        return Err(ClientError::Pairing);
    };
    let text = zeroize::Zeroizing::new(text.to_string());
    match serde_json::from_str(&text).map_err(|_| ClientError::Protocol)? {
        PairResponse::Paired {
            member_id,
            credential,
            permissions,
        } => Ok(Paired {
            member_id,
            credential,
            permissions,
        }),
        PairResponse::Rejected { code } => {
            drop(code);
            Err(ClientError::Pairing)
        }
    }
}
async fn socket(address: SocketAddr, fingerprint: Fingerprint) -> Result<Socket, ClientError> {
    let tls = tls::connect(address, fingerprint).await?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE))
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_MESSAGE * 2);
    let request = format!("wss://{address}{ROOM_PATH}");
    let (socket, _) = tokio::time::timeout(
        TIMEOUT,
        client_async_with_config(request, tls, Some(config)),
    )
    .await
    .map_err(|_| ClientError::Connection)?
    .map_err(|_| ClientError::Connection)?;
    Ok(socket)
}
async fn send(socket: &mut Socket, message: Message) -> Result<(), ClientError> {
    tokio::time::timeout(SEND_TIMEOUT, socket.send(message))
        .await
        .map_err(|_| ClientError::Connection)?
        .map_err(|_| ClientError::Connection)
}
async fn run_control(
    mut socket: Socket,
    clock: MonotonicClock,
    mut commands: mpsc::Receiver<ControlFrame>,
    mut output: watch::Receiver<OutputStatus>,
    controls: mpsc::Sender<ControlFrame>,
    mapping: watch::Sender<Option<ClockMapping>>,
    chat: Arc<Notifications>,
) -> Result<(), ClientError> {
    let mut estimator = Estimator::default();
    let mut sequence = 0u64;
    let mut pending = VecDeque::new();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ticks = 0u64;
    let mut last_received = tokio::time::Instant::now();
    let mut current_mapping: Option<ClockMapping> = None;
    let mut reported_output_ready = false;
    loop {
        tokio::select! {
            biased;
            _ = tick.tick() => {
                ticks += 1;
                if last_received.elapsed() > TIMEOUT { return Err(ClientError::Connection); }
                if current_mapping.is_some_and(|m| !m.valid_at(clock.now_ns())) {
                    current_mapping = None;
                    mapping.send_replace(None);
                }
                // Retry rejected measurements at the existing startup cadence
                // before the last accepted sample's freshness lease expires.
                // Only a newly accepted timestamp can renew that lease.
                if clock_probe_due(ticks, current_mapping, clock.now_ns()) {
                    sequence = sequence.checked_add(1).ok_or(ClientError::Protocol)?;
                    let t1 = clock.now_ns(); pending.push_back((sequence, t1));
                    while pending.len() > 32 { pending.pop_front(); }
                    let frame = ControlFrame::TimeRequest { sequence: Counter(sequence), t1: Counter(t1) };
                    send(&mut socket, Message::Text(frame.encode().map_err(|_| ClientError::Protocol)?.into())).await?;
                }
                if ticks.is_multiple_of(10) {
                    let status = *output.borrow();
                    reported_output_ready = status.ready;
                    let frame = ControlFrame::Heartbeat { output_ready: status.ready, played_frame: Counter(status.played_frame), underrun_frames: Counter(status.underrun_frames) };
                    send(&mut socket, Message::Text(frame.encode().unwrap().into())).await?;
                }
            },
            changed = output.changed() => {
                changed.map_err(|_| ClientError::Connection)?;
                let status = *output.borrow_and_update();
                if status.ready != reported_output_ready {
                    reported_output_ready = status.ready;
                    let frame = ControlFrame::Heartbeat { output_ready: status.ready, played_frame: Counter(status.played_frame), underrun_frames: Counter(status.underrun_frames) };
                    send(&mut socket, Message::Text(frame.encode().map_err(|_| ClientError::Protocol)?.into())).await?;
                }
            },
            frame = commands.recv() => { let Some(frame) = frame else { return Err(ClientError::Connection); };
                send(&mut socket, Message::Text(frame.encode().map_err(|_| ClientError::Protocol)?.into())).await?; },
            message = socket.next() => {
                let Some(Ok(message)) = message else { return Err(ClientError::Connection); };
                let received_at = clock.now_ns();
                last_received = tokio::time::Instant::now();
                let Message::Text(text) = message else { if matches!(message, Message::Close(_)) { return Err(ClientError::Connection); } continue; };
                let frame = ControlFrame::decode(&text).map_err(|_| ClientError::Protocol)?;
                match frame {
                    ControlFrame::TimeResponse { sequence, t1, t2, t3 } => {
                        let Some(index) = pending.iter().position(|p| *p == (sequence.0, t1.0)) else { return Err(ClientError::Protocol); };
                        pending.remove(index);
                        estimator.push(TimeSample { t1: t1.0, t2: t2.0, t3: t3.0, t4: received_at });
                        current_mapping = estimator.mapping_at(clock.now_ns());
                        mapping.send_replace(current_mapping);
                    },
                    ControlFrame::Notification { ref topic, .. } if topic.starts_with("chat_") => {
                        let text = frame.encode().map_err(|_| ClientError::Protocol)?;
                        if text.len() > 2048 { return Err(ClientError::Protocol); }
                        chat.push(text);
                    },
                    ControlFrame::Prepare { .. } | ControlFrame::Commit { .. } | ControlFrame::Suspend { .. } | ControlFrame::Resync { .. } | ControlFrame::Response { .. } | ControlFrame::Notification { .. } => {
                        controls.try_send(frame).map_err(|_| ClientError::Connection)?;
                    },
                    ControlFrame::End { reason } => return Err(ClientError::Ended(reason)),
                    _ => return Err(ClientError::Protocol),
                }
            }
        }
    }
}
async fn run_audio(
    mut socket: Socket,
    identity: StreamIdentity,
    audio: mpsc::Sender<ReceivedPcm>,
) -> Result<(), ClientError> {
    let budget = MemoryBudget::new(ENDPOINT_BYTES);
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut last_received = tokio::time::Instant::now();
    loop {
        tokio::select! {
            biased;
            _ = tick.tick() => {
                if last_received.elapsed() > TIMEOUT { return Err(ClientError::Connection); }
                send(&mut socket, Message::Ping(Vec::new().into())).await?;
            },
            message = socket.next() => {
                let Some(Ok(message)) = message else { return Err(ClientError::Connection); };
                last_received = tokio::time::Instant::now();
                match message {
                    Message::Binary(bytes) => {
                        let reservation = budget.reserve(bytes.len()).map_err(|_| ClientError::Connection)?;
                        let block = PcmBlock::decode(&bytes, identity).map_err(|_| ClientError::Protocol)?;
                        audio.try_send(ReceivedPcm { block, _reservation: reservation }).map_err(|_| ClientError::Connection)?;
                    },
                    Message::Ping(_) | Message::Pong(_) => { tokio::time::timeout(SEND_TIMEOUT, socket.flush()).await.map_err(|_| ClientError::Connection)?.map_err(|_| ClientError::Connection)?; },
                    _ => return Err(ClientError::Protocol),
                }
            }
        }
    }
}

#[cfg(test)]
mod clock_probe_tests {
    use super::*;

    fn response_at(now: u64, rtt: u64) -> TimeSample {
        let t1 = now - rtt - 1_000;
        let t2 = t1 + rtt / 2 + 500_000;
        TimeSample {
            t1,
            t2,
            t3: t2 + 1_000,
            t4: now,
        }
    }

    #[test]
    fn rejected_steady_probes_get_fresh_measurements_before_the_mapping_expires() {
        let mut estimator = Estimator::default();
        for tick in 1..=20 {
            assert!(estimator.push(response_at(tick * 100_000_000, 200_000)));
        }
        let mut mapping = estimator.mapping_at(2_000_000_000);
        assert!(mapping.is_some());
        let mut rejected = 0;
        let mut recovered = 0;
        for tick in 21..=70 {
            let now = tick * 100_000_000;
            if clock_probe_due(tick, mapping, now) {
                // Every ordinary one-second probe arrives late. The estimator
                // must keep rejecting them; fresh retry samples are required.
                if tick.is_multiple_of(10) {
                    assert!(!estimator.push(response_at(now, 3_000_000)));
                    rejected += 1;
                } else {
                    assert!(estimator.push(response_at(now, 200_000)));
                    recovered += 1;
                }
                mapping = estimator.mapping_at(now);
            }
            assert!(mapping.is_some_and(|m| m.valid_at(now)), "tick {tick}");
        }
        assert!(rejected >= 3);
        assert!(recovered > 0);
        // Retrying never refreshes the fit by itself. Without accepted samples
        // the existing three-second freshness gate still expires it.
        assert!(estimator.mapping_at(10_000_000_001).is_none());
    }
}
