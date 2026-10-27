// SPDX-License-Identifier: MIT
//! Dedicated TLS/WebSocket transport. No legacy routes or filesystem access.
//! The application remains the only owner of queue, resources and command semantics.
use crate::buffer::{MemoryBudget, Reservation, ENDPOINT_BYTES, GLOBAL_BYTES};
use crate::clock::MonotonicClock;
use crate::members::{AccessError, MemberRegistry, MemberView, Permissions, Secret};
use crate::notifications::Notifications;
use crate::protocol::{
    AudioFormat, ControlFrame, Counter, PcmBlock, StreamIdentity, CAPABILITIES, MAX_MESSAGE,
    VERSION,
};
use crate::tls::{Fingerprint, HostIdentity};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio_rustls::server::TlsStream;
use tokio_tungstenite::tungstenite::{self, Message};
use tokio_tungstenite::{accept_hdr_async_with_config, WebSocketStream};
use uuid::Uuid;

pub const ROOM_PATH: &str = "/v1/room";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const SEND_TIMEOUT: Duration = Duration::from_millis(500);
const AUDIO_BLOCKS: usize = 150;
type Socket = WebSocketStream<TlsStream<TcpStream>>;

struct IngressRate {
    credit: f64,
    updated: Instant,
}
impl IngressRate {
    fn new() -> Self {
        Self {
            credit: 64.0,
            updated: Instant::now(),
        }
    }
    fn allow(&mut self) -> bool {
        let now = Instant::now();
        self.credit =
            (self.credit + now.duration_since(self.updated).as_secs_f64() * 64.0).min(64.0);
        self.updated = now;
        if self.credit < 1.0 {
            false
        } else {
            self.credit -= 1.0;
            true
        }
    }
}

// The third-party handshake callback requires this concrete error response.
#[allow(clippy::result_large_err)]
fn validate_upgrade(
    request: &tungstenite::handshake::server::Request,
    response: tungstenite::handshake::server::Response,
) -> Result<tungstenite::handshake::server::Response, tungstenite::handshake::server::ErrorResponse>
{
    if request.uri().path() != ROOM_PATH
        || request.uri().query().is_some()
        || request.headers().contains_key("origin")
    {
        return Err(tungstenite::http::Response::builder()
            .status(403)
            .body(None)
            .expect("static status"));
    }
    Ok(response)
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("room transport closed or congested")]
    Closed,
    #[error("invalid audio block")]
    Audio,
    #[error("invalid room wire message")]
    Wire,
    #[error(transparent)]
    Access(#[from] AccessError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Tls(#[from] crate::tls::TlsError),
}

#[derive(Deserialize)]
#[serde(tag = "channel", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Handshake {
    LobbyProfile {
        version: u16,
        room_id: Uuid,
    },
    Apply {
        version: u16,
        room_id: Uuid,
        room_code: String,
        name: String,
    },
    AdmissionStatus {
        version: u16,
        room_id: Uuid,
        application_id: Uuid,
        applicant_secret: Secret,
    },
    Pair {
        version: u16,
        room_id: Uuid,
        invitation: Secret,
        name: String,
    },
    Control {
        version: u16,
        room_id: Uuid,
        member_id: Uuid,
        credential: Secret,
    },
    Audio {
        version: u16,
        identity: StreamIdentity,
        member_id: Uuid,
        credential: Secret,
    },
}

/// Bounded requests go to the business owner. Check current authorization again
/// when applying a mutation; this context is an identity, not an authorization cache.
pub enum Inbound {
    Resync {
        member_id: Uuid,
        identity: StreamIdentity,
    },
    Connected {
        member_id: Uuid,
        identity: StreamIdentity,
    },
    AudioAttached {
        member_id: Uuid,
        identity: StreamIdentity,
    },
    Disconnected {
        member_id: Uuid,
        identity: StreamIdentity,
    },
    Ready {
        member_id: Uuid,
        identity: StreamIdentity,
        epoch: u64,
        plan_id: u64,
    },
    Heartbeat {
        member_id: Uuid,
        identity: StreamIdentity,
        output_ready: bool,
        played_frame: u64,
        underrun_frames: u64,
    },
    Request {
        member_id: Uuid,
        identity: StreamIdentity,
        body: Value,
        reply: oneshot::Sender<Value>,
    },
}
struct OutboundPcm {
    block: PcmBlock,
    _global: Reservation,
    _endpoint: Reservation,
}
struct Endpoint {
    session_id: Uuid,
    high: mpsc::Sender<String>,
    chat: Arc<Notifications>,
    audio: Option<mpsc::Sender<OutboundPcm>>,
    budget: Arc<MemoryBudget>,
}
struct State {
    members: MemberRegistry,
    admissions: crate::admission::Admissions,
    endpoints: HashMap<Uuid, Endpoint>,
}
struct Inner {
    room_id: Uuid,
    instance_id: Uuid,
    state: Mutex<State>,
    events: mpsc::Sender<Inbound>,
    stop: watch::Sender<bool>,
    clock: MonotonicClock,
    memory: Arc<MemoryBudget>,
    lobby: Mutex<Option<crate::lobby::LobbyProfile>>,
}
#[derive(Clone)]
pub struct Transport {
    inner: Arc<Inner>,
}
pub struct RoomServer {
    pub address: SocketAddr,
    pub fingerprint: Fingerprint,
    pub transport: Transport,
    task: Option<JoinHandle<()>>,
}
impl RoomServer {
    pub async fn bind(
        address: SocketAddr,
        room_id: Uuid,
        instance_id: Uuid,
        identity: &HostIdentity,
        clock: MonotonicClock,
    ) -> Result<(Self, mpsc::Receiver<Inbound>), TransportError> {
        // Binding an explicit interface is intentional. No wildcard fallback.
        if address.ip().is_unspecified() || address.ip().is_multicast() {
            return Err(TransportError::Wire);
        }
        let listener = TcpListener::bind(address).await?;
        let address = listener.local_addr()?;
        let acceptor = tokio_rustls::TlsAcceptor::from(identity.server_config()?);
        let (events, rx) = mpsc::channel(64);
        let (stop, mut stopped) = watch::channel(false);
        let inner = Arc::new(Inner {
            room_id,
            instance_id,
            state: Mutex::new(State {
                members: MemberRegistry::new(room_id, instance_id, Instant::now()),
                admissions: crate::admission::Admissions::new(room_id, Instant::now()),
                endpoints: HashMap::new(),
            }),
            events,
            stop,
            clock,
            memory: MemoryBudget::new(GLOBAL_BYTES),
            lobby: Mutex::new(None),
        });
        let transport = Transport {
            inner: inner.clone(),
        };
        let task = tokio::spawn(async move {
            let handshakes = Arc::new(Semaphore::new(4));
            let connections = Arc::new(Semaphore::new(36));
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = stopped.changed() => break,
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                    accepted = listener.accept() => {
                        let Ok((stream, source)) = accepted else { break; };
                        let (Ok(handshake), Ok(connection)) = (handshakes.clone().try_acquire_owned(), connections.clone().try_acquire_owned()) else { continue; };
                        let inner = inner.clone(); let acceptor = acceptor.clone();
                        tasks.spawn(async move {
                            let _connection = connection;
                            let negotiated = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
                                stream.set_nodelay(true).ok()?;
                                let tls = acceptor.accept(stream).await.ok()?;
                                let config = tungstenite::protocol::WebSocketConfig::default()
                                    .max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE))
                                    .write_buffer_size(0).max_write_buffer_size(MAX_MESSAGE * 2);
                                let mut socket = accept_hdr_async_with_config(tls, validate_upgrade, Some(config)).await.ok()?;
                                let Message::Text(text) = socket.next().await?.ok()? else { return None; };
                                let text = zeroize::Zeroizing::new(text.to_string());
                                let request: Handshake = serde_json::from_str(&text).ok()?;
                                Some((socket, request))
                            }).await;
                            drop(handshake);
                            if let Ok(Some((socket, request))) = negotiated {
                                handle(inner, socket, request, source).await;
                            }
                        });
                    }
                }
            }
            inner
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .members
                .end();
            // Let invalidated control streams flush their terminal End first.
            // One shared deadline also bounds peers stuck in TLS or a send;
            // cancellation then closes every remaining socket/request future.
            let _ = tokio::time::timeout(SEND_TIMEOUT + Duration::from_millis(100), async {
                while tasks.join_next().await.is_some() {}
            })
            .await;
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
        });
        Ok((
            Self {
                address,
                fingerprint: identity.fingerprint(),
                transport,
                task: Some(task),
            },
            rx,
        ))
    }
    pub async fn shutdown(mut self) {
        self.transport.end();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for RoomServer {
    fn drop(&mut self) {
        self.transport.end();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
impl Transport {
    /// Only the application host publishes this optional, explicitly public profile.
    pub fn set_lobby_profile(
        &self,
        profile: Option<crate::lobby::LobbyProfile>,
    ) -> Result<(), TransportError> {
        if profile.as_ref().is_some_and(|p| {
            p.room_id != self.inner.room_id
                || p.cover
                    .as_deref()
                    .is_some_and(|cover| !crate::lobby::valid_cover(cover))
        }) {
            return Err(TransportError::Wire);
        }
        *self.inner.lobby.lock().unwrap_or_else(|e| e.into_inner()) = profile;
        Ok(())
    }

    pub fn admission_views(&self) -> Vec<crate::admission::ApplicationView> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .admissions
            .views(Instant::now())
    }
    pub fn room_code(&self) -> String {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .admissions
            .code()
            .to_owned()
    }
    pub fn review_admission(
        &self,
        id: Uuid,
        approve: bool,
        permissions: Permissions,
    ) -> Result<(), TransportError> {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if approve {
            state.admissions.pending(id, now)?;
            let invitation = state.members.invite(now, permissions)?;
            state.admissions.approve(id, invitation, now)?;
        } else if let Some(invitation) = state.admissions.reject(id, now)? {
            state.members.revoke_invitation(&invitation);
        }
        Ok(())
    }
    pub fn reserve_local_output(&self, enabled: bool) -> Result<(), TransportError> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .members
            .reserve_local_output(enabled)?;
        Ok(())
    }
    pub fn clock(&self) -> MonotonicClock {
        self.inner.clock.clone()
    }
    pub fn invite(&self, permissions: Permissions) -> Result<Secret, TransportError> {
        Ok(self
            .inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .members
            .invite(Instant::now(), permissions)?)
    }
    pub fn member_invite(
        &self,
        member: Uuid,
        identity: StreamIdentity,
    ) -> Result<crate::members::IssuedInvitation, TransportError> {
        if identity.room_id != self.inner.room_id || identity.instance_id != self.inner.instance_id
        {
            return Err(AccessError::Denied.into());
        }
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let permissions = state.members.permissions(member, identity.session_id)?;
        if !permissions.invite {
            return Err(AccessError::Denied.into());
        }
        // Delegate only basic rights the inviter still holds; elevated rights
        // (including invitation delegation) remain a host decision.
        Ok(state.members.issue_invitation(
            Instant::now(),
            Permissions {
                listen: permissions.listen,
                chat_read: permissions.chat_read,
                chat_send: permissions.chat_send,
                queue: false,
                transport: false,
                volume: false,
                invite: false,
            },
            Some(member),
        )?)
    }
    pub fn issue_invitation(
        &self,
        permissions: Permissions,
    ) -> Result<crate::members::IssuedInvitation, TransportError> {
        Ok(self
            .inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .members
            .issue_invitation(Instant::now(), permissions, None)?)
    }
    pub fn invitation_views(&self) -> Vec<crate::members::InvitationView> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .members
            .invitation_views(Instant::now())
    }
    pub fn revoke_invitation(
        &self,
        id: Uuid,
        issuer: Option<(Uuid, StreamIdentity)>,
    ) -> Result<(), TransportError> {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let member = if let Some((member, identity)) = issuer {
            if identity.room_id != self.inner.room_id
                || identity.instance_id != self.inner.instance_id
                || !state
                    .members
                    .permissions(member, identity.session_id)?
                    .invite
            {
                return Err(AccessError::Denied.into());
            }
            Some(member)
        } else {
            None
        };
        state
            .members
            .revoke_invitation_id(id, member, Instant::now())?;
        Ok(())
    }
    pub fn members(&self) -> Vec<MemberView> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .members
            .members()
    }
    pub fn authorize(
        &self,
        member: Uuid,
        identity: StreamIdentity,
    ) -> Result<Permissions, TransportError> {
        if identity.room_id != self.inner.room_id || identity.instance_id != self.inner.instance_id
        {
            return Err(AccessError::Denied.into());
        }
        Ok(self
            .inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .members
            .permissions(member, identity.session_id)?)
    }
    pub fn set_permissions(
        &self,
        member: Uuid,
        permissions: Permissions,
    ) -> Result<(), TransportError> {
        Ok(self
            .inner
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .members
            .set_permissions(member, permissions)?)
    }
    pub fn revoke(&self, member: Uuid) -> Result<(), TransportError> {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.members.revoke(member)?;
        state.endpoints.remove(&member);
        Ok(())
    }
    pub fn end(&self) {
        self.inner
            .lobby
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.members.end();
        state.admissions.end();
        state.endpoints.clear();
        drop(state);
        self.inner.stop.send_replace(true);
    }
    pub fn send(
        &self,
        member: Uuid,
        identity: StreamIdentity,
        frame: &ControlFrame,
    ) -> Result<(), TransportError> {
        self.authorize(member, identity)?;
        let text = frame.encode().map_err(|_| TransportError::Wire)?;
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        state.members.permissions(member, identity.session_id)?;
        let endpoint = state
            .endpoints
            .get(&member)
            .filter(|e| e.session_id == identity.session_id)
            .ok_or(TransportError::Closed)?;
        if endpoint.high.try_send(text).is_err() {
            state.members.disconnect(member, identity.session_id);
            return Err(TransportError::Closed);
        }
        Ok(())
    }
    /// Chat overflow is lossy and cannot revoke audio or block Commit. The app
    /// includes history revision/cursor in snapshots so clients recover gaps.
    pub fn notify_chat(&self, frame: &ControlFrame) -> Result<(), TransportError> {
        let text = frame.encode().map_err(|_| TransportError::Wire)?;
        if text.len() > 2048 {
            return Err(TransportError::Wire);
        }
        let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        for (member, endpoint) in &state.endpoints {
            if state
                .members
                .permissions(*member, endpoint.session_id)
                .is_ok_and(|p| p.chat_read)
            {
                endpoint.chat.push(text.clone());
            }
        }
        Ok(())
    }
    /// Fanout accepts no device-specific PCM. Each endpoint gets a separately
    /// charged reference, independently disconnected on pressure.
    pub fn broadcast_pcm(
        &self,
        epoch: u64,
        sequence: u64,
        frame_index: u64,
        format: AudioFormat,
        samples: Arc<[f32]>,
    ) -> Result<usize, TransportError> {
        format.validate().map_err(|_| TransportError::Audio)?;
        let frames = samples.len() / usize::from(format.channels);
        if frames == 0
            || frames > format.sample_rate as usize / 50
            || !samples.len().is_multiple_of(usize::from(format.channels))
            || samples.iter().any(|s| !s.is_finite())
            || frame_index.checked_add(frames as u64).is_none()
        {
            return Err(TransportError::Audio);
        }
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut failed = Vec::new();
        let mut sent = 0;
        for (member, endpoint) in &state.endpoints {
            if !state
                .members
                .permissions(*member, endpoint.session_id)
                .is_ok_and(|p| p.listen)
            {
                continue;
            }
            let Some(tx) = &endpoint.audio else {
                continue;
            };
            let block = PcmBlock {
                identity: StreamIdentity {
                    room_id: self.inner.room_id,
                    instance_id: self.inner.instance_id,
                    session_id: endpoint.session_id,
                },
                epoch,
                sequence,
                frame_index,
                format_id: format.id,
                channels: format.channels,
                samples: samples.clone(),
            };
            let bytes = block.byte_len();
            match (
                tx.try_reserve(),
                self.inner.memory.reserve(bytes),
                endpoint.budget.reserve(bytes),
            ) {
                (Ok(slot), Ok(global), Ok(local)) => {
                    slot.send(OutboundPcm {
                        block,
                        _global: global,
                        _endpoint: local,
                    });
                    sent += 1;
                }
                _ => failed.push((*member, endpoint.session_id)),
            }
        }
        for (member, session) in failed {
            state.members.disconnect(member, session);
            state.endpoints.remove(&member);
        }
        Ok(sent)
    }
    pub fn buffered_bytes(&self) -> usize {
        self.inner.memory.used()
    }
}

async fn handle(inner: Arc<Inner>, mut socket: Socket, request: Handshake, source: SocketAddr) {
    match request {
        Handshake::LobbyProfile { version, room_id }
            if version == VERSION && room_id == inner.room_id =>
        {
            let profile = inner
                .lobby
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let response = serde_json::json!({"type":"lobby_profile","profile":profile});
            let _ = send_text(&mut socket, response.to_string()).await;
        }
        Handshake::Apply {
            version,
            room_id,
            room_code,
            name,
        } if version == VERSION && room_id == inner.room_id => {
            let result = inner
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .admissions
                .apply(source.ip(), &room_code, &name, Instant::now());
            let response = match result {
                Ok((id, secret)) => zeroize::Zeroizing::new(serde_json::json!({"type":"application","application_id":id,"applicant_secret":secret.expose(),"state":"pending","expires_in_seconds":300}).to_string()),
                Err(_) => zeroize::Zeroizing::new(serde_json::json!({"type":"rejected"}).to_string()),
            };
            let _ = send_text(&mut socket, response.to_string()).await;
        }
        Handshake::AdmissionStatus {
            version,
            room_id,
            application_id,
            applicant_secret,
        } if version == VERSION && room_id == inner.room_id => {
            let result = inner
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .admissions
                .status(
                    source.ip(),
                    application_id,
                    &applicant_secret,
                    Instant::now(),
                );
            let response = match result {
                Ok((state, secret, member_id)) => zeroize::Zeroizing::new(serde_json::json!({"type":"application_status","state":state,"invitation_secret":secret.as_ref().map(Secret::expose),"member_id":member_id}).to_string()),
                Err(_) => zeroize::Zeroizing::new(serde_json::json!({"type":"rejected"}).to_string()),
            };
            let _ = send_text(&mut socket, response.to_string()).await;
        }
        Handshake::Pair {
            version,
            room_id,
            invitation,
            name,
        } if version == VERSION && room_id == inner.room_id => {
            let paired = {
                let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
                let paired = state
                    .members
                    .pair(source.ip(), &invitation, &name, Instant::now());
                if let Ok(paired) = &paired {
                    state.admissions.consumed(&invitation, paired.member_id);
                }
                paired
            };
            match paired {
                Ok(paired) => {
                    let response = zeroize::Zeroizing::new(serde_json::json!({ "type": "paired", "member_id": paired.member_id, "credential": paired.credential.expose(), "permissions": paired.permissions }).to_string());
                    let _ = send_text(&mut socket, response.to_string()).await;
                }
                Err(error) => {
                    let _ = send_text(
                        &mut socket,
                        serde_json::json!({"type":"rejected","code":error.to_string()}).to_string(),
                    )
                    .await;
                }
            }
        }
        Handshake::Control {
            version,
            room_id,
            member_id,
            credential,
        } if version == VERSION => {
            let session = if room_id == inner.room_id {
                inner
                    .state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .members
                    .control(member_id, &credential)
            } else {
                Err(AccessError::Denied)
            };
            match session {
                Ok(session) => {
                    let identity = session.identity;
                    run_control(inner.clone(), socket, session).await;
                    disconnect(&inner, member_id, identity);
                }
                Err(AccessError::Denied) => {
                    send_end(&mut socket, "room_authorization_expired").await;
                }
                Err(_) => {}
            }
        }
        Handshake::Audio {
            version,
            identity,
            member_id,
            credential,
        } if version == VERSION => {
            let session = inner
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .members
                .audio(member_id, &credential, identity);
            if let Ok(session) = session {
                run_audio(inner.clone(), socket, session).await;
                disconnect(&inner, member_id, identity);
            }
        }
        _ => {}
    }
}
fn disconnect(inner: &Inner, member: Uuid, identity: StreamIdentity) {
    let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
    state.members.disconnect(member, identity.session_id);
    if state
        .endpoints
        .get(&member)
        .is_some_and(|e| e.session_id == identity.session_id)
    {
        state.endpoints.remove(&member);
    }
    let _ = inner.events.try_send(Inbound::Disconnected {
        member_id: member,
        identity,
    });
}
async fn send_text(socket: &mut Socket, text: String) -> Result<(), TransportError> {
    tokio::time::timeout(SEND_TIMEOUT, socket.send(Message::Text(text.into())))
        .await
        .map_err(|_| TransportError::Closed)?
        .map_err(|_| TransportError::Closed)
}
async fn send_end<S>(socket: &mut WebSocketStream<S>, reason: &str)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // Dropping TCP with unread startup requests can reset the connection and
    // discard the End we just flushed (notably on Windows). Finish the bounded
    // WebSocket close while consuming those requests without executing them.
    let _ = tokio::time::timeout(SEND_TIMEOUT, async {
        let frame = ControlFrame::End {
            reason: reason.into(),
        };
        socket
            .send(Message::Text(
                frame.encode().expect("bounded end frame").into(),
            ))
            .await
            .map_err(|_| TransportError::Closed)?;
        socket
            .close(None)
            .await
            .map_err(|_| TransportError::Closed)?;
        while let Some(Ok(message)) = socket.next().await {
            if matches!(message, Message::Close(_)) {
                break;
            }
        }
        Ok::<(), TransportError>(())
    })
    .await;
}
async fn run_control(
    inner: Arc<Inner>,
    mut socket: Socket,
    mut session: crate::members::AuthorizedSession,
) {
    let (high, mut high_rx) = mpsc::channel(32);
    let chat = Notifications::new();
    {
        let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .members
            .permissions(session.member_id, session.identity.session_id)
            .is_err()
        {
            return;
        }
        state.endpoints.insert(
            session.member_id,
            Endpoint {
                session_id: session.identity.session_id,
                high: high.clone(),
                chat: chat.clone(),
                audio: None,
                budget: MemoryBudget::new(ENDPOINT_BYTES),
            },
        );
    }
    let hello = ControlFrame::Hello {
        version: VERSION,
        identity: session.identity,
        required: CAPABILITIES.iter().map(|c| c.to_string()).collect(),
    };
    if send_text(&mut socket, hello.encode().unwrap())
        .await
        .is_err()
        || inner
            .events
            .try_send(Inbound::Connected {
                member_id: session.member_id,
                identity: session.identity,
            })
            .is_err()
    {
        return;
    }
    let mut last_received = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut requests = JoinSet::new();
    let mut request_high: Option<u64> = None;
    let mut ingress = IngressRate::new();
    loop {
        tokio::select! {
            biased;
            _ = session.invalidated.changed() => {
                // Superseding a connection or withdrawing listen permission
                // keeps membership; removal/end permanently retires it.
                let removed = !inner.state.lock().unwrap_or_else(|e| e.into_inner()).members.members().iter().any(|m| m.id == session.member_id);
                if removed {
                    send_end(&mut socket, "room_authorization_expired").await;
                }
                break;
            },
            _ = tick.tick() => { if last_received.elapsed() > HANDSHAKE_TIMEOUT { break; } },
            _ = requests.join_next(), if !requests.is_empty() => {},
            message = socket.next() => {
                let Some(Ok(message)) = message else { break; };
                if !ingress.allow() { break; }
                let received_at = inner.clock.now_ns();
                last_received = Instant::now();
                let Message::Text(text) = message else { if matches!(message, Message::Close(_)) { break; } continue; };
                let Ok(frame) = ControlFrame::decode(&text) else { break; };
                let member_id = session.member_id; let identity = session.identity;
                let event = match frame {
                    ControlFrame::TimeRequest { sequence, t1 } => {
                        let t2 = received_at;
                        let reply = ControlFrame::TimeResponse { sequence, t1, t2: Counter(t2), t3: Counter(inner.clock.now_ns()) };
                        if send_text(&mut socket, reply.encode().unwrap()).await.is_err() { break; } continue;
                    },
                    ControlFrame::Ready { epoch, plan_id } => Inbound::Ready { member_id, identity, epoch: epoch.0, plan_id: plan_id.0 },
                    ControlFrame::Heartbeat { output_ready, played_frame, underrun_frames } => Inbound::Heartbeat { member_id, identity, output_ready, played_frame: played_frame.0, underrun_frames: underrun_frames.0 },
                    ControlFrame::Resync { .. } => Inbound::Resync { member_id, identity },
                    ControlFrame::Request { request_id, body } => {
                        if requests.len() >= 8 || request_high.is_some_and(|last| request_id.0 <= last) { break; }
                        request_high = Some(request_id.0);
                        let (reply, response) = oneshot::channel();
                        if inner.events.try_send(Inbound::Request { member_id, identity, body, reply }).is_err() { break; }
                        let transport = Transport { inner: inner.clone() }; let mut invalidated = session.invalidated.clone();
                        requests.spawn(async move {
                            tokio::select! {
                                biased;
                                _ = invalidated.changed() => {},
                                response = tokio::time::timeout(Duration::from_secs(5), response) => {
                                    let body = match response { Ok(Ok(body)) => body, _ => serde_json::json!({"error":{"code":"request_timeout","outcome_unknown":true}}) };
                                    let mut frame = ControlFrame::Response { request_id, body };
                                    if frame.encode().is_err() { frame = ControlFrame::Response { request_id, body: serde_json::json!({"error":{"code":"response_too_large"}}) }; }
                                    // Reliable replies share the same bounded send and
                                    // session-invalidation policy as Prepare/Commit.
                                    let _ = transport.send(member_id, identity, &frame);
                                }
                            }
                        });
                        continue;
                    },
                    _ => break,
                };
                if inner.events.try_send(event).is_err() { break; }
            },
            text = high_rx.recv() => { let Some(text) = text else { break; }; if send_text(&mut socket, text).await.is_err() { break; } },
            text = chat.recv() => { if send_text(&mut socket, text).await.is_err() { break; } },
        }
    }
    requests.abort_all();
    while requests.join_next().await.is_some() {}
}
async fn run_audio(
    inner: Arc<Inner>,
    mut socket: Socket,
    mut session: crate::members::AuthorizedSession,
) {
    let (tx, mut rx) = mpsc::channel::<OutboundPcm>(AUDIO_BLOCKS);
    {
        let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let Some(endpoint) = state
            .endpoints
            .get_mut(&session.member_id)
            .filter(|e| e.session_id == session.identity.session_id)
        else {
            return;
        };
        endpoint.audio = Some(tx);
    }
    if inner
        .events
        .try_send(Inbound::AudioAttached {
            member_id: session.member_id,
            identity: session.identity,
        })
        .is_err()
    {
        return;
    }
    let mut last_received = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut ingress = IngressRate::new();
    loop {
        tokio::select! {
            biased;
            _ = session.invalidated.changed() => break,
            _ = tick.tick() => { if last_received.elapsed() > HANDSHAKE_TIMEOUT { break; } },
            message = socket.next() => {
                let Some(Ok(message)) = message else { break; };
                if !ingress.allow() { break; }
                if !matches!(message, Message::Ping(_) | Message::Pong(_)) { break; }
                last_received = Instant::now();
                if !matches!(tokio::time::timeout(SEND_TIMEOUT, socket.flush()).await, Ok(Ok(()))) { break; }
            },
            block = rx.recv() => {
                let Some(block) = block else { break; };
                let Ok(bytes) = block.block.encode() else { break; };
                if !matches!(tokio::time::timeout(SEND_TIMEOUT, socket.send(Message::Binary(bytes.into()))).await, Ok(Ok(()))) { break; }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tungstenite::protocol::Role;

    #[tokio::test]
    async fn terminal_end_waits_for_close_while_draining_queued_startup_frames() {
        let (host, peer) = tokio::io::duplex(4096);
        let mut host = WebSocketStream::from_raw_socket(host, Role::Server, None).await;
        let mut peer = WebSocketStream::from_raw_socket(peer, Role::Client, None).await;
        for id in 1..=2 {
            let request = ControlFrame::Request {
                request_id: Counter(id),
                body: serde_json::json!({"action":"snapshot"}),
            };
            peer.send(Message::Text(request.encode().unwrap().into()))
                .await
                .unwrap();
        }
        let closing = tokio::spawn(async move {
            send_end(&mut host, "room_authorization_expired").await;
        });
        let Message::Text(text) = peer.next().await.unwrap().unwrap() else {
            panic!("missing terminal End");
        };
        assert!(matches!(
            ControlFrame::decode(&text).unwrap(),
            ControlFrame::End { reason } if reason == "room_authorization_expired"
        ));
        assert!(
            !closing.is_finished(),
            "closed before the peer acknowledged"
        );
        assert!(matches!(
            peer.next().await.unwrap().unwrap(),
            Message::Close(_)
        ));
        peer.flush().await.unwrap();
        tokio::time::timeout(SEND_TIMEOUT, closing)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn terminal_end_bounds_both_a_blocked_send_and_an_unresponsive_peer() {
        for capacity in [1, 4096] {
            let (host, _unresponsive_peer) = tokio::io::duplex(capacity);
            let mut host = WebSocketStream::from_raw_socket(host, Role::Server, None).await;
            tokio::time::timeout(
                SEND_TIMEOUT + Duration::from_millis(250),
                send_end(&mut host, "room_authorization_expired"),
            )
            .await
            .expect("terminal close exceeded its shared send/drain deadline");
        }
    }
}
