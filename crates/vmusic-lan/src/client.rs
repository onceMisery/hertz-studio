// SPDX-License-Identifier: MIT
//! Native pinned client. Browsers call their local service, never this TLS endpoint.
use crate::buffer::{PcmBudget, PcmReservation, MIN_PCM_RATE};
use crate::clock::{ClockMapping, Estimator, MonotonicClock, TimeSample};
use crate::members::{Paired, Permissions, Secret};
use crate::notifications::Notifications;
use crate::protocol::{
    AudioFormat, ControlFrame, Counter, FormatMode, PcmBlock, StreamIdentity, CAPABILITIES,
    MAX_MESSAGE, PCM_HEADER, VERSION,
};
use crate::server::ROOM_PATH;
use crate::tls::{self, Fingerprint};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};
use tokio_tungstenite::{client_async_with_config, WebSocketStream};
use uuid::Uuid;

type Socket = WebSocketStream<TlsStream<TcpStream>>;
type SharedFormats = Arc<Mutex<[Option<(u64, AudioFormat)>; 2]>>;
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
    reservation: PcmReservation,
}
impl ReceivedPcm {
    pub fn block(&self) -> &PcmBlock {
        &self.block
    }
    /// Legacy extraction; new pipelines transfer the token with into_parts.
    /// A destination must reserve before invoking this method.
    pub fn into_block(self) -> PcmBlock {
        self.block
    }
    pub fn into_parts(self) -> (PcmBlock, PcmReservation) {
        (self.block, self.reservation)
    }
}
pub struct ClientEvents {
    pub pcm_budget: Arc<PcmBudget>,
    pub chat: Arc<Notifications>,
    pub control: mpsc::Receiver<ControlFrame>,
    pub audio: mpsc::Receiver<ReceivedPcm>,
    pub mapping: watch::Receiver<Option<ClockMapping>>,
    pub state: watch::Receiver<ConnectionState>,
}
#[derive(Clone)]
pub struct ClientHandle {
    pub identity: StreamIdentity,
    pub format_mode: FormatMode,
    pcm_budget: Arc<PcmBudget>,
    commands: mpsc::Sender<ControlFrame>,
    output: watch::Sender<OutputStatus>,
    stop: watch::Sender<bool>,
    clock: MonotonicClock,
}
impl ClientHandle {
    pub fn pcm_budget(&self) -> Arc<PcmBudget> {
        self.pcm_budget.clone()
    }
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
        // TLS, authentication, Hello and native confirmation share one deadline.
        let (control, identity, format_mode) = tokio::time::timeout(TIMEOUT, async {
            let mut control = socket(address, fingerprint).await?;
            let auth = zeroize::Zeroizing::new(serde_json::json!({"channel":"control","version":VERSION,"room_id":room_id,"member_id":member_id,"credential":credential.expose()}).to_string());
            send(&mut control, Message::Text(auth.to_string().into())).await?;
            let Some(Ok(Message::Text(text))) = control.next().await else { return Err(ClientError::Protocol); };
            let (identity, format_mode) = match ControlFrame::decode(&text).map_err(|_| ClientError::Protocol)? {
                ControlFrame::Hello { identity, required, .. } => (identity,
                    if required.iter().any(|c| c == "native_rate_v1") { FormatMode::Native } else { FormatMode::Fixed }),
                ControlFrame::End { reason } if reason == "room_authorization_expired" => return Err(ClientError::AuthorizationExpired),
                _ => return Err(ClientError::Protocol),
            };
            if identity.room_id != room_id || identity.session_id.is_nil() || identity.instance_id.is_nil() {
                return Err(ClientError::Protocol);
            }
            if format_mode == FormatMode::Native {
                let ack = ControlFrame::CapabilityAck { supported: CAPABILITIES.iter().map(|c| c.to_string()).collect() };
                send(&mut control, Message::Text(ack.encode().map_err(|_| ClientError::Protocol)?.into())).await?;
                let Some(Ok(Message::Text(text))) = control.next().await else { return Err(ClientError::Protocol); };
                match ControlFrame::decode(&text).map_err(|_| ClientError::Protocol)? {
                    ControlFrame::CapabilityConfirmed {} => {},
                    ControlFrame::End { reason } => return Err(ClientError::Ended(reason)),
                    _ => return Err(ClientError::Protocol),
                }
            }
            Ok((control, identity, format_mode))
        }).await.map_err(|_| ClientError::Connection)??;
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
        let pcm_budget = PcmBudget::endpoint();
        let audio_budget = pcm_budget.clone();
        let formats = Arc::new(Mutex::new([None, None]));
        let audio_formats = formats.clone();
        let clock = MonotonicClock::default();
        let task_clock = clock.clone();
        let task = tokio::spawn(async move {
            // Publish the typed terminal state before closing consumers' data
            // channels, including a connection that ends before its first poll.
            let control_lifetime = control_tx.clone();
            let audio_lifetime = audio_tx.clone();
            let mut stop_wait = stopped;
            let control = run_control(
                control,
                task_clock,
                command_rx,
                output_rx,
                ControlDelivery {
                    controls: control_tx,
                    mapping: mapping_tx,
                    chat: chat_tx,
                    format_mode,
                    formats,
                },
            );
            let audio = async move {
                if let Some(audio) = audio {
                    run_audio(audio, identity, audio_tx, audio_budget, audio_formats).await
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
                    format_mode,
                    pcm_budget: pcm_budget.clone(),
                    commands,
                    output,
                    stop,
                    clock,
                },
                task: Some(task),
            },
            ClientEvents {
                pcm_budget,
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
pub struct Applied {
    pub application_id: Uuid,
    pub applicant_secret: Secret,
}
pub enum AdmissionStatus {
    Pending,
    Rejected,
    Approved(Secret),
    Consumed(Uuid),
}
/// Restricted one-shot TLS request; this never opens a member/control session.
pub async fn apply(
    address: SocketAddr,
    fingerprint: Fingerprint,
    room_id: Uuid,
    room_code: &str,
    name: &str,
) -> Result<Applied, ClientError> {
    crate::members::validate_name(name).map_err(|_| ClientError::Pairing)?;
    #[derive(Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
    enum Response {
        Application {
            application_id: Uuid,
            applicant_secret: Secret,
            state: String,
            expires_in_seconds: u32,
        },
        Rejected,
    }
    let response = admission_exchange(address, fingerprint, serde_json::json!({"channel":"apply","version":VERSION,"room_id":room_id,"room_code":room_code,"name":name})).await?;
    match serde_json::from_str::<Response>(&response).map_err(|_| ClientError::Protocol)? {
        Response::Application {
            application_id,
            applicant_secret,
            state,
            expires_in_seconds,
        } if state == "pending" && expires_in_seconds == 300 && !application_id.is_nil() => {
            Ok(Applied {
                application_id,
                applicant_secret,
            })
        }
        _ => Err(ClientError::Pairing),
    }
}
pub async fn admission_status(
    address: SocketAddr,
    fingerprint: Fingerprint,
    room_id: Uuid,
    application_id: Uuid,
    applicant_secret: &Secret,
) -> Result<AdmissionStatus, ClientError> {
    #[derive(Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
    enum Response {
        ApplicationStatus {
            state: String,
            invitation_secret: Option<Secret>,
            member_id: Option<Uuid>,
        },
        Rejected,
    }
    let response = admission_exchange(address, fingerprint, serde_json::json!({"channel":"admission_status","version":VERSION,"room_id":room_id,"application_id":application_id,"applicant_secret":applicant_secret.expose()})).await?;
    match serde_json::from_str::<Response>(&response).map_err(|_| ClientError::Protocol)? {
        Response::ApplicationStatus {
            state,
            invitation_secret,
            member_id,
        } => match (state.as_str(), invitation_secret, member_id) {
            ("pending", None, None) => Ok(AdmissionStatus::Pending),
            ("rejected", None, None) => Ok(AdmissionStatus::Rejected),
            ("approved", Some(secret), None) => Ok(AdmissionStatus::Approved(secret)),
            ("consumed", None, Some(member)) if !member.is_nil() => {
                Ok(AdmissionStatus::Consumed(member))
            }
            _ => Err(ClientError::Protocol),
        },
        Response::Rejected => Err(ClientError::Pairing),
    }
}
/// Public artwork exchange over the same pinned, bounded room transport.
pub async fn lobby_profile(
    address: SocketAddr,
    fingerprint: Fingerprint,
    room_id: Uuid,
) -> Result<Option<crate::lobby::LobbyProfile>, ClientError> {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Response {
        r#type: String,
        profile: Option<crate::lobby::LobbyProfile>,
    }
    let response = admission_exchange(
        address,
        fingerprint,
        serde_json::json!({"channel":"lobby_profile","version":VERSION,"room_id":room_id}),
    )
    .await?;
    let response: Response = serde_json::from_str(&response).map_err(|_| ClientError::Protocol)?;
    if response.r#type != "lobby_profile"
        || response.profile.as_ref().is_some_and(|p| {
            p.room_id != room_id
                || p.cover
                    .as_deref()
                    .is_some_and(|c| !crate::lobby::valid_cover(c))
        })
    {
        return Err(ClientError::Protocol);
    }
    Ok(response.profile)
}

async fn admission_exchange(
    address: SocketAddr,
    fingerprint: Fingerprint,
    body: serde_json::Value,
) -> Result<zeroize::Zeroizing<String>, ClientError> {
    let mut socket = socket(address, fingerprint).await?;
    let text = zeroize::Zeroizing::new(body.to_string());
    send(&mut socket, Message::Text(text.to_string().into())).await?;
    match tokio::time::timeout(TIMEOUT, socket.next())
        .await
        .map_err(|_| ClientError::Connection)?
    {
        Some(Ok(Message::Text(text))) => Ok(zeroize::Zeroizing::new(text.to_string())),
        _ => Err(ClientError::Protocol),
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
struct ControlDelivery {
    controls: mpsc::Sender<ControlFrame>,
    mapping: watch::Sender<Option<ClockMapping>>,
    chat: Arc<Notifications>,
    format_mode: FormatMode,
    formats: SharedFormats,
}

async fn run_control(
    mut socket: Socket,
    clock: MonotonicClock,
    mut commands: mpsc::Receiver<ControlFrame>,
    mut output: watch::Receiver<OutputStatus>,
    delivery: ControlDelivery,
) -> Result<(), ClientError> {
    let ControlDelivery {
        controls,
        mapping,
        chat,
        format_mode,
        formats,
    } = delivery;
    let mut estimator = Estimator::default();
    let mut sequence = 0u64;
    let mut pending = VecDeque::new();
    let mut retired_probe = 0;
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ticks = 0u64;
    let mut last_received = tokio::time::Instant::now();
    let mut current_mapping: Option<ClockMapping> = None;
    let mut reported_output_ready = false;
    loop {
        tokio::select! {
            _ = tick.tick() => {
                ticks += 1;
                if last_received.elapsed() > crate::PEER_IDLE_TIMEOUT { return Err(ClientError::Connection); }
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
                    while pending.len() > 32 { if let Some((sequence, _)) = pending.pop_front() { retired_probe = sequence; } }
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
                    ControlFrame::Prepare { ref plan } => {
                        if format_mode == FormatMode::Native && plan.format.channels != 2 { return Err(ClientError::Protocol); }
                        declare_format(&formats, plan.epoch.0, plan.format)?;
                        controls.try_send(frame).map_err(|_| ClientError::Connection)?;
                    },
                    ControlFrame::EpochEnd { .. } if format_mode == FormatMode::Native => {
                        controls.try_send(frame).map_err(|_| ClientError::Connection)?;
                    },
                    ControlFrame::TimeResponse { sequence, t1, t2, t3 } => {
                        // A delayed TCP backlog can contain replies to probes
                        // evicted during a Wi-Fi stall. They cannot refresh the
                        // clock, but are not a reason to tear down membership.
                        if sequence.0 > 0 && sequence.0 <= retired_probe { continue; }
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
                    ControlFrame::Commit { .. } | ControlFrame::Suspend { .. } | ControlFrame::Resync { .. } | ControlFrame::Response { .. } | ControlFrame::Notification { .. } => {
                        controls.try_send(frame).map_err(|_| ClientError::Connection)?;
                    },
                    ControlFrame::End { reason } => return Err(ClientError::Ended(reason)),
                    _ => return Err(ClientError::Protocol),
                }
            }
        }
    }
}
fn declare_format(
    formats: &Mutex<[Option<(u64, AudioFormat)>; 2]>,
    epoch: u64,
    format: AudioFormat,
) -> Result<(), ClientError> {
    let mut formats = formats.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, previous)) = formats.iter().flatten().find(|(e, _)| *e == epoch) {
        return if *previous == format {
            Ok(())
        } else {
            Err(ClientError::Protocol)
        };
    }
    if let Some(slot) = formats.iter_mut().find(|slot| slot.is_none()) {
        *slot = Some((epoch, format));
    } else {
        let index = usize::from(formats[1].unwrap().0 < formats[0].unwrap().0);
        if epoch <= formats[index].unwrap().0 {
            return Err(ClientError::Protocol);
        }
        formats[index] = Some((epoch, format));
    }
    Ok(())
}

fn decode_received_pcm(
    bytes: &[u8],
    identity: StreamIdentity,
    budget: &Arc<PcmBudget>,
    formats: &Mutex<[Option<(u64, AudioFormat)>; 2]>,
) -> Result<ReceivedPcm, ClientError> {
    if bytes.len() < PCM_HEADER || bytes.len() > MAX_MESSAGE {
        return Err(ClientError::Protocol);
    }
    let epoch = u64::from_le_bytes(bytes[56..64].try_into().unwrap());
    let format_id = u32::from_le_bytes(bytes[80..84].try_into().unwrap());
    let frames = u32::from_le_bytes(bytes[84..88].try_into().unwrap());
    let channels = u16::from_le_bytes(bytes[88..90].try_into().unwrap());
    let payload_bytes = bytes.len() - PCM_HEADER;
    crate::protocol::validate_payload(frames, channels, payload_bytes)
        .map_err(|_| ClientError::Protocol)?;
    let rate = formats
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .flatten()
        .find(|(known_epoch, format)| {
            *known_epoch == epoch && format.id == format_id && format.channels == channels
        })
        .map_or(MIN_PCM_RATE, |(_, format)| format.sample_rate);
    let reservation = budget
        .reserve_input_pcm(frames as usize, rate, bytes.len())
        .map_err(|_| ClientError::Connection)?;
    // decode holds a Vec while copying into Arc<[f32]>. Admit both PCM
    // allocations before either is made; only the final block is input.
    let decode_copy = budget
        .reserve_pcm(frames as usize, rate, payload_bytes)
        .map_err(|_| ClientError::Connection)?;
    let block = PcmBlock::decode(bytes, identity).map_err(|_| ClientError::Protocol)?;
    drop(decode_copy);
    Ok(ReceivedPcm { block, reservation })
}

async fn run_audio(
    mut socket: Socket,
    identity: StreamIdentity,
    audio: mpsc::Sender<ReceivedPcm>,
    budget: Arc<PcmBudget>,
    formats: SharedFormats,
) -> Result<(), ClientError> {
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut last_received = tokio::time::Instant::now();
    loop {
        tokio::select! {
            biased;
            _ = tick.tick() => {
                if last_received.elapsed() > crate::PEER_IDLE_TIMEOUT { return Err(ClientError::Connection); }
                send(&mut socket, Message::Ping(Vec::new().into())).await?;
            },
            message = socket.next() => {
                let Some(Ok(message)) = message else { return Err(ClientError::Connection); };
                last_received = tokio::time::Instant::now();
                match message {
                    Message::Binary(bytes) => {
                        let received = decode_received_pcm(&bytes, identity, &budget, &formats)?;
                        audio.try_send(received).map_err(|_| ClientError::Connection)?;
                    },
                    Message::Ping(_) | Message::Pong(_) => { tokio::time::timeout(SEND_TIMEOUT, socket.flush()).await.map_err(|_| ClientError::Connection)?.map_err(|_| ClientError::Connection)?; },
                    _ => return Err(ClientError::Protocol),
                }
            }
        }
    }
}

#[cfg(test)]
mod pcm_decode_budget_tests {
    use super::*;

    fn fixture() -> (PcmBlock, SharedFormats) {
        let block = PcmBlock {
            identity: StreamIdentity {
                room_id: Uuid::from_u128(1),
                instance_id: Uuid::from_u128(2),
                session_id: Uuid::from_u128(3),
            },
            epoch: 7,
            sequence: 1,
            frame_index: 12,
            format_id: 9,
            channels: 2,
            samples: vec![-0.0, f32::from_bits(1), -0.75, 0.5]
                .into_iter()
                .cycle()
                .take(960)
                .collect::<Vec<_>>()
                .into(),
        };
        let formats = Arc::new(Mutex::new([
            Some((
                block.epoch,
                AudioFormat {
                    id: block.format_id,
                    sample_rate: 96_000,
                    channels: block.channels,
                },
            )),
            None,
        ]));
        (block, formats)
    }

    fn assert_released(budget: &PcmBudget) {
        assert_eq!(budget.frames(), 0);
        assert_eq!(budget.bytes(), 0);
        assert_eq!(budget.duration_ns(), 0);
        assert_eq!(budget.input_frames(), 0);
        assert_eq!(budget.input_bytes(), 0);
        assert_eq!(budget.input_duration_ns(), 0);
    }

    #[test]
    fn a_single_block_fitting_does_not_admit_an_over_budget_decode_copy() {
        let (block, formats) = fixture();
        let bytes = block.encode().unwrap();
        let payload = bytes.len() - PCM_HEADER;
        let duration = 5_000_000;
        for budget in [
            PcmBudget::with_limits(
                bytes.len() + payload - 1,
                duration * 2,
                bytes.len(),
                duration,
            ),
            PcmBudget::with_limits(
                bytes.len() + payload,
                duration * 2 - 1,
                bytes.len(),
                duration,
            ),
        ] {
            // One final input block fits both limits in isolation.
            let input = budget.reserve_input_pcm(480, 96_000, bytes.len()).unwrap();
            drop(input);
            assert!(matches!(
                decode_received_pcm(&bytes, block.identity, &budget, &formats),
                Err(ClientError::Connection)
            ));
            assert_released(&budget);
        }
    }

    #[test]
    fn decoded_pcm_keeps_one_input_token_through_transfer() {
        let (block, formats) = fixture();
        let bytes = block.encode().unwrap();
        let budget = PcmBudget::with_limits(
            bytes.len() * 2 - PCM_HEADER,
            10_000_000,
            bytes.len(),
            5_000_000,
        );
        let received = decode_received_pcm(&bytes, block.identity, &budget, &formats).unwrap();
        assert_eq!(budget.bytes(), bytes.len());
        assert_eq!(budget.duration_ns(), 5_000_000);
        assert_eq!(budget.input_bytes(), bytes.len());
        assert_eq!(budget.input_duration_ns(), 5_000_000);
        let (decoded, reservation) = received.into_parts();
        assert!(reservation.is_from(&budget));
        assert!(reservation.is_input());
        assert_eq!(budget.frames(), 480);
        assert_eq!(budget.input_frames(), 480);
        assert_eq!(
            decoded
                .samples
                .iter()
                .map(|s| s.to_bits())
                .collect::<Vec<_>>(),
            block
                .samples
                .iter()
                .map(|s| s.to_bits())
                .collect::<Vec<_>>()
        );
        drop((decoded, reservation));
        assert_released(&budget);
    }

    #[test]
    fn rejected_decode_copy_preserves_already_owned_pcm() {
        let (block, formats) = fixture();
        let bytes = block.encode().unwrap();
        let budget =
            PcmBudget::with_limits(bytes.len() * 2, 15_000_000, bytes.len() * 2, 10_000_000);
        let existing = budget.reserve_input_at(&block, 96_000).unwrap();
        assert!(matches!(
            decode_received_pcm(&bytes, block.identity, &budget, &formats),
            Err(ClientError::Connection)
        ));
        assert_eq!(budget.bytes(), bytes.len());
        assert_eq!(budget.duration_ns(), 5_000_000);
        assert_eq!(budget.input_bytes(), bytes.len());
        assert_eq!(budget.input_duration_ns(), 5_000_000);
        drop(existing);
        assert_released(&budget);
    }

    #[test]
    fn non_finite_decode_releases_both_reservations() {
        let (block, formats) = fixture();
        let mut bytes = block.encode().unwrap();
        bytes[PCM_HEADER + 4..PCM_HEADER + 8].copy_from_slice(&f32::NAN.to_bits().to_le_bytes());
        let budget = PcmBudget::with_limits(bytes.len() * 2, 10_000_000, bytes.len(), 5_000_000);
        assert!(matches!(
            decode_received_pcm(&bytes, block.identity, &budget, &formats),
            Err(ClientError::Protocol)
        ));
        assert_released(&budget);
    }

    #[test]
    fn undeclared_format_uses_the_conservative_rate_for_both_copies() {
        let (block, _) = fixture();
        let bytes = block.encode().unwrap();
        let budget = PcmBudget::with_limits(bytes.len() * 2, 10_000_000, bytes.len(), 20_000_000);
        assert!(matches!(
            decode_received_pcm(&bytes, block.identity, &budget, &Mutex::new([None, None])),
            Err(ClientError::Connection)
        ));
        assert_released(&budget);
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
