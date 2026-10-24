// SPDX-License-Identifier: MIT
//! Guest native session owner. Credentials never reach the browser projection.
use super::contract::*;
use super::credentials::{CredentialError, ProfileSecrets, RecentRoom};
use super::manager::{Envelope, Session};
use super::receiver::{self, ReceiverEvent, ReceiverHandle, ReceiverRegistry};
use crate::state::AppState;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use vmusic_lan::client::{
    ClientConnection, ClientEvents, ConnectionMode, ConnectionState, OutputStatus,
};
use vmusic_lan::protocol::{ControlFrame, Counter};

struct Pending {
    reply: Option<oneshot::Sender<RoomResult<Value>>>,
    at: std::time::Instant,
    snapshot: bool,
}
struct Guest {
    member_id: uuid::Uuid,
    recent: super::recent_chat::RecentChat,
    mode: ConnectionMode,
    output_enabled: bool,
    output_fault: bool,
    reconfigure: bool,
    terminated: bool,
    shutdown: watch::Receiver<bool>,
    connection: ClientConnection,
    events: ClientEvents,
    receiver: Option<ReceiverHandle>,
    receiver_events: mpsc::Receiver<ReceiverEvent>,
    receiver_registry: ReceiverRegistry,
    output: OutputSettings,
    preferences: super::output_preferences::Preferences,
    projection: Arc<RwLock<Value>>,
    remote: Value,
    next_request: u64,
    pending: HashMap<u64, Pending>,
    diagnostics: tokio::task::JoinSet<()>,
    error: Option<String>,
}
fn error(e: impl std::fmt::Display) -> RoomError {
    RoomError::new("room_connection", e.to_string())
}
fn terminal_connect_error(error: &vmusic_lan::client::ClientError) -> bool {
    matches!(
        error,
        vmusic_lan::client::ClientError::AuthorizationExpired
            | vmusic_lan::client::ClientError::Ended(_)
    )
}
fn options(
    settings: &OutputSettings,
    clock: vmusic_lan::clock::MonotonicClock,
) -> vmusic_audio::OutputOptions {
    vmusic_audio::OutputOptions {
        device_id: settings.device_id.clone(),
        preferred_rate: 48_000,
        channels: 2,
        clock_origin: clock.origin(),
        latency_correction_ns: i64::from(settings.latency_correction_ms) * 1_000_000,
        calibration_binding: settings.calibration_binding.clone(),
    }
}
pub(crate) async fn start(
    state: Arc<AppState>,
    invitation: String,
    name: String,
    listen: bool,
    lease: super::manager::ModeLease,
    projection: Arc<RwLock<Value>>,
    active: Arc<AtomicBool>,
) -> RoomResult<Session> {
    let invitation = zeroize::Zeroizing::new(invitation);
    let invite = vmusic_lan::invitation::Invitation::parse(&invitation).map_err(error)?;
    let paired = vmusic_lan::client::pair(
        invite.address,
        invite.fingerprint,
        invite.room_id,
        &invite.secret,
        &name,
    )
    .await
    .map_err(error)?;
    let descriptor = RecentRoom {
        version: 1,
        address: invite.address,
        fingerprint: invite.fingerprint.hex(),
        room_id: invite.room_id,
        member_id: paired.member_id,
        name,
        listen,
    };
    let secrets = ProfileSecrets::new(&state.data_dir, crate::secrets::backend());
    start_session(
        state,
        descriptor,
        paired.credential,
        secrets,
        lease,
        projection,
        active,
    )
    .await
}

pub(crate) async fn resume(
    state: Arc<AppState>,
    lease: super::manager::ModeLease,
    projection: Arc<RwLock<Value>>,
    active: Arc<AtomicBool>,
) -> RoomResult<Session> {
    let secrets = ProfileSecrets::new(&state.data_dir, crate::secrets::backend());
    let (descriptor, credential) = secrets
        .load_recent()
        .await?
        .ok_or(CredentialError::MissingRoom)?;
    start_session(
        state, descriptor, credential, secrets, lease, projection, active,
    )
    .await
}

/// Initial pairing and explicit recovery share every connection, permission,
/// clock, audio and shutdown path. A saved record never starts this on its own.
pub(super) async fn start_session(
    state: Arc<AppState>,
    descriptor: RecentRoom,
    credential: vmusic_lan::members::Secret,
    secrets: ProfileSecrets,
    lease: super::manager::ModeLease,
    projection: Arc<RwLock<Value>>,
    active: Arc<AtomicBool>,
) -> RoomResult<Session> {
    let fingerprint = descriptor.validate()?;
    let output = super::output_preferences::load(&state.db).await?;
    let mode = ConnectionMode::ControlOnly;
    let connected = ClientConnection::connect_mode(
        descriptor.address,
        fingerprint,
        descriptor.room_id,
        descriptor.member_id,
        &credential,
        mode,
    )
    .await;
    let (connection, events) = match connected {
        Ok(value) => value,
        Err(e) => {
            if terminal_connect_error(&e) {
                secrets.forget_recent(&descriptor).await?;
            }
            return Err(error(e));
        }
    };
    // Persist only after the connection succeeds and before publishing/spawning
    // the session. The single envelope cannot create an orphaned token.
    if let Err(e) = secrets.save_recent(descriptor.clone(), credential).await {
        connection.shutdown().await;
        return Err(e.into());
    }
    let preferences = super::output_preferences::Preferences::spawn(state.db.clone());
    // Audio is opened only after this new control session returns permissions.
    let (_receiver_tx, receiver_events) = mpsc::channel(1);
    let cleanup = lease.completion.clone();
    let mut guest = Guest {
        member_id: descriptor.member_id,
        diagnostics: tokio::task::JoinSet::new(),
        recent: Default::default(),
        mode,
        output_enabled: descriptor.listen,
        output_fault: false,
        reconfigure: false,
        terminated: false,
        shutdown: state.exiting.subscribe(),
        connection,
        events,
        receiver: None,
        receiver_events,
        receiver_registry: lease.receiver.clone(),
        output,
        preferences,
        projection,
        remote: json!({}),
        next_request: 1,
        pending: HashMap::new(),
        error: None,
    };
    guest.publish("guest");
    let (commands, rx) = mpsc::channel(32);
    let (stop, mut stopped) = watch::channel(false);
    let done = tokio::spawn(async move {
        let mut local = rx;
        'session: loop {
            guest.reconfigure = false;
            let result = guest.run(&mut local, &mut stopped).await;
            guest.terminated |= matches!(
                &*guest.events.state.borrow(),
                ConnectionState::Closed { terminal: true, .. }
            );
            guest.finish_pending();
            if *stopped.borrow() || *guest.shutdown.borrow() || guest.terminated {
                if guest.terminated {
                    guest.error = result.err().map(|e| e.message);
                }
                break;
            }
            let mut deliberate = guest.reconfigure;
            if !deliberate {
                guest.error = Some(
                    result
                        .err()
                        .map(|e| e.message)
                        .unwrap_or_else(|| "房间连接已关闭".into()),
                );
            }
            guest.publish("reconnecting");
            guest.receiver.take();
            let _ = guest.receiver_registry.close_current().await;
            guest.connection.handle.close();
            let mut attempts = 0u32;
            loop {
                let delay = if deliberate && attempts == 0 {
                    Duration::ZERO
                } else {
                    Duration::from_millis(
                        500u64.saturating_mul(1u64 << attempts.min(5)).min(10_000),
                    )
                };
                if guest
                    .while_offline(&mut local, &mut stopped, tokio::time::sleep(delay))
                    .await
                    .is_none()
                {
                    break 'session;
                }
                let credential = match guest
                    .while_offline(&mut local, &mut stopped, secrets.load_recent())
                    .await
                {
                    Some(Ok(Some((saved, value)))) if saved == descriptor => value,
                    Some(Ok(_)) => {
                        guest.error = Some(CredentialError::MissingRoom.to_string());
                        break 'session;
                    }
                    Some(Err(e)) => {
                        guest.error = Some(e.to_string());
                        break 'session;
                    }
                    None => break 'session,
                };
                // A network reconnect always starts without an audio lease and
                // obtains fresh permissions before reopening the output device.
                let mode = if deliberate {
                    guest.desired_mode()
                } else {
                    ConnectionMode::ControlOnly
                };
                let connect = ClientConnection::connect_mode(
                    descriptor.address,
                    fingerprint,
                    descriptor.room_id,
                    descriptor.member_id,
                    &credential,
                    mode,
                );
                match guest.while_offline(&mut local, &mut stopped, connect).await {
                    Some(Ok((connection, events))) => {
                        if mode == ConnectionMode::Listening && guest.desired_mode() != mode {
                            connection.handle.close();
                            continue;
                        }
                        guest.connection = connection;
                        guest.events = events;
                        guest.mode = mode;
                        if mode == ConnectionMode::Listening {
                            let opening_settings = guest.output.clone();
                            let opening = receiver::spawn(
                                options(&opening_settings, guest.connection.handle.clock()),
                                guest.connection.handle.identity,
                                guest.connection.handle.clock(),
                                guest.receiver_registry.clone(),
                            );
                            match guest.while_offline(&mut local, &mut stopped, opening).await {
                                Some(Ok((receiver, events))) => {
                                    if guest.desired_mode() != ConnectionMode::Listening
                                        || guest.output.device_id != opening_settings.device_id
                                        || guest.output.latency_correction_ms
                                            != opening_settings.latency_correction_ms
                                    {
                                        let _ = guest.receiver_registry.close_current().await;
                                        guest.connection.handle.close();
                                        continue 'session;
                                    }
                                    let _ = receiver.set_volume(guest.output.volume);
                                    guest.receiver = Some(receiver);
                                    guest.receiver_events = events;
                                }
                                Some(Err(e)) => {
                                    guest.error = Some(e.to_string());
                                    guest.output_fault = true;
                                    guest.connection.handle.close();
                                }
                                None => break 'session,
                            }
                        }
                        break;
                    }
                    Some(Err(e)) => {
                        if terminal_connect_error(&e) {
                            guest.terminated = true;
                            guest.error = Some(e.to_string());
                            break 'session;
                        }
                        deliberate = false;
                        guest.error = Some(e.to_string());
                        guest.publish("reconnecting");
                        attempts = attempts.saturating_add(1);
                    }
                    None => break 'session,
                }
            }
        }
        guest.receiver_registry.begin_close();
        guest.receiver.take();
        let _ = guest.receiver_registry.close_current().await;
        guest.finish_pending();
        guest.connection.handle.close();
        if *stopped.borrow() || guest.terminated {
            if let Err(e) = secrets.forget_recent(&descriptor).await {
                guest.error = Some(e.to_string());
            }
        }
        guest.preferences.shutdown().await;
        lease.finish().await;
        active.store(false, Ordering::Release);
        *guest.projection.write().unwrap_or_else(|e| e.into_inner()) =
            json!({"mode":"local","last_error":guest.error});
    });
    Ok(Session {
        commands,
        stop,
        done,
        cleanup,
    })
}
impl Guest {
    async fn while_offline<T>(
        &mut self,
        local: &mut mpsc::Receiver<Envelope>,
        stopped: &mut watch::Receiver<bool>,
        operation: impl std::future::Future<Output = T>,
    ) -> Option<T> {
        tokio::pin!(operation);
        loop {
            if *stopped.borrow() || *self.shutdown.borrow() {
                return None;
            }
            tokio::select! {
                biased;
                _=stopped.changed()=>return None,
                _=self.shutdown.changed()=>return None,
                result=&mut operation=>return Some(result),
                envelope=local.recv()=>match envelope{Some(envelope)=>self.offline_request(envelope),None=>return None},
            }
        }
    }
    fn finish_pending(&mut self) {
        for (_, pending) in self.pending.drain() {
            if let Some(reply) = pending.reply {
                let _ = reply.send(Err(RoomError::new(
                    "room_outcome_unknown",
                    "连接已关闭或切换；请查询原操作结果，勿自动重复操作",
                )));
            }
        }
    }
    fn offline_request(&mut self, envelope: Envelope) {
        let result = match envelope.request {
            LocalRequest::Output { settings, enabled } => super::host::validate_output(&settings)
                .map(|()| {
                    self.output = settings;
                    self.preferences.save(&self.output);
                    self.output_enabled = enabled;
                    self.output_fault = false;
                    json!({"state":"reconnecting"})
                }),
            _ => Err(RoomError::new(
                "room_reconnecting",
                "正在重新连接；请求未提交，请连接成功后重试",
            )),
        };
        let _ = envelope.reply.send(result);
        self.publish("reconnecting");
    }
    fn desired_mode(&self) -> ConnectionMode {
        if self.output_enabled && !self.output_fault && self.remote["permissions"]["listen"] == true
        {
            ConnectionMode::Listening
        } else {
            ConnectionMode::ControlOnly
        }
    }

    fn request(
        &mut self,
        request: PeerRequest,
        reply: Option<oneshot::Sender<RoomResult<Value>>>,
    ) -> RoomResult<()> {
        if self.pending.len() >= 8 {
            return Err(RoomError::new("room_busy", "等待中的请求过多"));
        }
        let snapshot = matches!(request, PeerRequest::Snapshot);
        let id = self.next_request;
        self.next_request = id.checked_add(1).ok_or_else(RoomError::exhausted)?;
        let body = serde_json::to_value(request).map_err(|_| RoomError::invalid("请求格式无效"))?;
        if let Err(e) = self.connection.handle.send(ControlFrame::Request {
            request_id: Counter(id),
            body,
        }) {
            let failure = error(e);
            if let Some(reply) = reply {
                let _ = reply.send(Err(failure));
                return Ok(());
            }
            return Err(failure);
        }
        self.pending.insert(
            id,
            Pending {
                reply,
                at: std::time::Instant::now(),
                snapshot,
            },
        );
        Ok(())
    }
    async fn run(
        &mut self,
        local: &mut mpsc::Receiver<Envelope>,
        stopped: &mut watch::Receiver<bool>,
    ) -> RoomResult<()> {
        if *stopped.borrow() || *self.shutdown.borrow() {
            return Ok(());
        }
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        let mut closing = matches!(
            &*self.events.state.borrow(),
            ConnectionState::Closing { .. }
        );
        if let ConnectionState::Closed { reason, terminal } = &*self.events.state.borrow() {
            self.terminated = *terminal;
            return Err(error(reason));
        }
        if closing {
            if let Some(receiver) = &self.receiver {
                receiver.invalidate();
            }
        } else {
            self.request(PeerRequest::Snapshot, None)?;
        }
        loop {
            tokio::select! {
                _=stopped.changed()=>break,
                _=self.diagnostics.join_next(),if !self.diagnostics.is_empty()=>{},
                _=self.shutdown.changed()=>break,
                changed=self.events.state.changed()=>{
                    match &*self.events.state.borrow() {
                        ConnectionState::Closed{reason,terminal}=>{self.terminated = *terminal;return Err(error(reason));},
                        ConnectionState::Closing{..}=>{closing=true;if let Some(receiver)=&self.receiver{receiver.invalidate();}},
                        ConnectionState::Connected=>{},
                    }
                    if changed.is_err(){return Err(error("连接状态通道已关闭"));}
                    if closing {self.finish_pending();self.publish("reconnecting");}
                },
                _=self.events.mapping.changed()=>{if let Some(mapping)=*self.events.mapping.borrow(){if let Some(receiver)=&self.receiver{receiver.mapping(mapping).map_err(error)?;}}},
                event=self.receiver_events.recv(),if self.receiver.is_some()=>{let Some(event)=event else{return Err(error("原生接收线程已停止"))};if closing {continue;}match event{ReceiverEvent::Ready{epoch,plan_id}=>self.connection.handle.send(ControlFrame::Ready{epoch:Counter(epoch),plan_id:Counter(plan_id)}).map_err(error)?,ReceiverEvent::Resync{reason}=>self.connection.handle.send(ControlFrame::Resync{reason}).map_err(error)?,ReceiverEvent::Status(status)=>{self.connection.handle.output_status(OutputStatus{ready:status.output_ready,played_frame:status.played_frame,underrun_frames:status.underrun_frames});}}},
                _=tick.tick()=>{
                    if closing {self.publish("reconnecting");continue;}
                    if !self.pending.values().any(|p|p.snapshot){self.request(PeerRequest::Snapshot,None)?;}
                    let expired=self.pending.iter().filter_map(|(id,p)|(p.at.elapsed()>Duration::from_secs(5)).then_some(*id)).collect::<Vec<_>>();
                    for id in expired{if let Some(pending)=self.pending.remove(&id){if let Some(reply)=pending.reply{let _=reply.send(Err(RoomError::new("room_outcome_unknown","操作结果尚未确定，请查询操作状态")));}}}
                    if let Some(receiver)=&self.receiver{let status=receiver.status();self.connection.handle.output_status(OutputStatus{ready:status.output_ready,played_frame:status.played_frame,underrun_frames:status.underrun_frames});}
                    self.publish("guest");
                },
                frame=self.events.control.recv()=>{
                    let Some(frame)=frame else{return Err(error("控制连接关闭"))};
                    if closing && !matches!(frame, ControlFrame::End { .. }) {continue;}
                    match frame{
                        ControlFrame::Prepare{plan}=>{if let Some(receiver)=&self.receiver{receiver.prepare(self.connection.handle.identity,plan).map_err(error)?;}},
                        ControlFrame::Commit{epoch,plan_id,effective_at}=>{if let Some(receiver)=&self.receiver{receiver.commit(self.connection.handle.identity,epoch.0,plan_id.0,effective_at.0).map_err(error)?;}},
                        ControlFrame::Suspend{epoch,plan_id,effective_at}=>{if let Some(receiver)=&self.receiver{receiver.suspend(self.connection.handle.identity,epoch.0,plan_id.0,effective_at.0).map_err(error)?;}},
                        ControlFrame::Resync{..}=>{if let Some(receiver)=&self.receiver{receiver.invalidate();}self.connection.handle.send(ControlFrame::Resync{reason:"host_invalidated".into()}).map_err(error)?;},
                        ControlFrame::End{reason}=>{self.terminated=true;return Err(error(reason))},
                        ControlFrame::Response{request_id,body}=>{if let Some(pending)=self.pending.remove(&request_id.0){
                            let result=response_result(body);
                            if pending.snapshot{if let Ok(value)=&result{self.remote=value.clone();if !self.output_fault {self.error=None;}self.recent.revision(self.remote["chat"]["history_revision"].as_str());if self.remote["permissions"]["chat_read"]!=true{self.recent.clear();}self.publish("guest");}}
                            if let Some(reply)=pending.reply{let _=reply.send(result);}
                            if self.desired_mode()!=self.mode{self.reconfigure=true;return Ok(());}
                        }},
                        _=>{},
                    }
                },
                block=self.events.audio.recv(),if self.receiver.is_some()=>{
                    let Some(block)=block else{return Err(error("音频连接关闭"))};
                    if closing {continue;}
                    if let Some(receiver)=&self.receiver{receiver.pcm(block.into_block()).map_err(error)?;}
                },
                text=self.events.chat.recv()=>{self.recent.notification(&text);self.publish("guest");},
                envelope=local.recv()=>{
                    let Some(envelope)=envelope else{break};
                    if closing {self.offline_request(envelope);continue;}
                    match envelope.request{
                        LocalRequest::TestOutput=>{
                            let receiver=self.receiver.clone().filter(|_|self.diagnostics.is_empty() && self.remote["playing"]==false && self.remote["scheduled"].is_null() && self.remote["pending"].is_null());
                            if let Some(receiver)=receiver {
                                self.diagnostics.spawn(async move {
                                    let result=receiver.test_output().await.map_err(error).map(|()|json!({"state":"applied"}));
                                    let _=envelope.reply.send(result);
                                });
                            } else { let _=envelope.reply.send(Err(RoomError::invalid("请先暂停播放并启用本机输出"))); }
                        },
                        LocalRequest::Peer{request}=>{
                            if self.pending.len()>=8{let _=envelope.reply.send(Err(RoomError::new("room_busy","等待中的请求过多")));}else if let Err(e)=self.request(request,Some(envelope.reply)){self.error=Some(e.message);}
                        },
                        LocalRequest::Output{settings,enabled}=>{
                            let result=async{
                                super::host::validate_output(&settings)?;
                                if enabled && !self.remote["permissions"]["listen"].as_bool().unwrap_or(false){return Err(RoomError::denied());}
                                if enabled && settings.device_id==self.output.device_id && settings.latency_correction_ms==self.output.latency_correction_ms {
                                    if let Some(receiver)=&self.receiver{receiver.set_volume(settings.volume).map_err(error)?;self.output=settings;self.preferences.save(&self.output);self.publish("guest");return Ok(json!({"state":"applied"}));}
                                }
                                self.receiver.take();
                                let _=self.receiver_registry.close_current().await;
                                self.output=settings;self.preferences.save(&self.output);self.output_enabled=enabled;self.output_fault=false;
                                self.reconfigure=true;
                                self.publish("guest");Ok(json!({"state":"applied"}))
                            }.await;let _=envelope.reply.send(result);if self.reconfigure{return Ok(());}
                        },
                        _=>{let _=envelope.reply.send(Err(RoomError::denied()));},
                    }
                }
            }
        }
        Ok(())
    }
    fn publish(&self, mode: &str) {
        let mut value = self.remote.clone();
        if !value.is_object() {
            value = json!({});
        }
        value["mode"] = json!(mode);
        value["room_id"] = json!(self.connection.handle.identity.room_id);
        value["instance_id"] = json!(self.connection.handle.identity.instance_id);
        value["member_id"] = json!(self.member_id);
        value["output"] = super::host::output_json(self.receiver.as_ref(), &self.output);
        value["local_error"] = json!(self.error);
        value["output"]["preferences_error"] = json!(*self.preferences.error.borrow());
        value["output"]["desired_enabled"] = json!(self.output_enabled);
        value["session_id"] = json!(self.connection.handle.identity.session_id);
        if self.remote["permissions"]["chat_read"] == true {
            value["recent_chat"] = self.recent.projection();
        }
        *self.projection.write().unwrap_or_else(|e| e.into_inner()) = value;
    }
}

fn response_result(body: Value) -> RoomResult<Value> {
    if body["ok"] == true {
        return Ok(body["result"].clone());
    }
    let failure = &body["error"];
    if failure["outcome_unknown"] == true || failure["code"] == "request_timeout" {
        return Err(RoomError::new(
            "room_outcome_unknown",
            "房主尚未确认操作结果，请查询原操作；勿自动重试",
        ));
    }
    Err(
        serde_json::from_value::<RoomError>(failure.clone()).unwrap_or_else(|_| {
            RoomError::new("room_request_failed", "房间请求未获确认，请查询操作状态")
        }),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transport_timeout_preserves_uncertain_outcome() {
        let e = response_result(json!({"error":{"code":"request_timeout","outcome_unknown":true}}))
            .unwrap_err();
        assert_eq!(e.code, "room_outcome_unknown");
        let e =
            response_result(json!({"ok":false,"error":{"code":"room_denied","message":"denied"}}))
                .unwrap_err();
        assert_eq!(e.code, "room_denied");
        assert_eq!(
            response_result(json!({"ok":true,"result":{"state":"applied"}})).unwrap()["state"],
            "applied"
        );
    }
}
