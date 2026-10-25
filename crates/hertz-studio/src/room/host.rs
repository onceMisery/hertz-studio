// SPDX-License-Identifier: MIT
//! Single room business owner. AppState retains the only playback queue.
use super::contract::*;
use super::host_jobs::{self, Completion, PreparedAction, Reply};
use super::manager::{Envelope, Session};
use super::presentation::{
    Boundaries, Boundary, MixSettings, MixerTimeline, PresentationCatalog, PresentedTrack,
};
use super::producer::{FailureStage, Producer, ProducerEvent, Source};
use super::receiver::{self, ReceiverEvent, ReceiverHandle, ReceiverRegistry};
use super::resources::SharedLibrary;
use crate::state::AppState;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;
use vmusic_core::room::{
    self as timeline, EndpointId, MemberId, OperationKey, PlanScheduler, PlanTarget, Revision,
    TrackInstanceId,
};
use vmusic_core::{DspParams, PlayMode};
use vmusic_lan::clock::{ClockMapping, MonotonicClock};
use vmusic_lan::members::Permissions;
use vmusic_lan::protocol::{AudioFormat, ControlFrame, Counter, PcmBlock, Plan, StreamIdentity};
use vmusic_lan::server::{Inbound, RoomServer};

type ChatJob = std::pin::Pin<Box<dyn std::future::Future<Output = RoomResult<Value>> + Send>>;
const LEAD_NS: u64 = 1_000_000_000;
const MIN_COMMIT_NS: u64 = 250_000_000;
const OWNER: Uuid = Uuid::nil();
struct Endpoint {
    identity: StreamIdentity,
    index: u32,
    audio: bool,
    last_output: Option<u64>,
    plan: Option<Plan>,
    committed: bool,
    ready: bool,
    rejoin: JoinRetry,
}
#[derive(Default)]
struct JoinRetry {
    requested: bool,
    not_before_ns: u64,
}

impl JoinRetry {
    fn take(&mut self, now: u64, available: bool) -> bool {
        self.requested = true;
        if !available || now < self.not_before_ns {
            return false;
        }
        self.requested = false;
        self.not_before_ns = now.saturating_add(250_000_000);
        true
    }
}
struct Candidate {
    wire: Plan,
    scheduler_plan: timeline::PlanId,
    target: PlanTarget,
    prepared: bool,
    ready: bool,
    materialized: bool,
    loading: bool,
    preserve_position: bool,
    creator: Uuid,
    session: Option<StreamIdentity>,
}
struct Audible {
    plan: Plan,
    target: PlanTarget,
    position_frames: u64,
    position_at_ns: u64,
    preserve_position: bool,
}
struct Recorded {
    member: Uuid,
    seq: u64,
    body: Value,
    result: Value,
    key: Option<OperationKey>,
    at: u64,
}
#[derive(PartialEq, Eq)]
struct SuccessorTarget {
    current: u64,
    next: u64,
}
struct Owner {
    state: Arc<AppState>,
    server: RoomServer,
    clock: MonotonicClock,
    name: String,
    format: AudioFormat,
    library: SharedLibrary,
    chat: Option<super::chat::ChatService>,
    chat_error: Option<String>,
    producer: Producer,
    scheduler: PlanScheduler,
    render_heads: HashMap<u64, u64>,
    rendered_until: HashMap<u64, u64>,
    history: super::history_writer::HistoryWriter,
    jobs: tokio::task::JoinSet<Completion>,
    source_jobs: HashMap<(u8, u64), tokio::task::AbortHandle>,
    successor_tokens: HashMap<u64, u64>,
    successor_targets: HashMap<u64, SuccessorTarget>,
    prepared_successors: HashMap<u64, u64>,
    pending_successors: HashMap<u64, VecDeque<Option<u64>>>,
    next_job: u64,
    request_jobs: usize,
    mutation_preparing: bool,
    collaboration: super::collaboration::Collaboration,
    started_at_ms: u64,
    instances: Vec<u64>,
    next_instance: u64,
    next_wire_plan: u64,
    candidate: Option<Candidate>,
    audible: Option<Audible>,
    scheduled: Option<Audible>,
    boundaries: Boundaries,
    presentation_catalog: PresentationCatalog,
    endpoints: HashMap<Uuid, Endpoint>,
    next_endpoint: u32,
    local: Option<ReceiverHandle>,
    local_identity: StreamIdentity,
    local_events: mpsc::Receiver<ReceiverEvent>,
    receiver_registry: ReceiverRegistry,
    output: OutputSettings,
    preferences: super::output_preferences::Preferences,
    output_preparing: bool,
    dsp: DspParams,
    crossfade_ms: u64,
    loudness_mode: String,
    volume: f32,
    mixer: MixerTimeline,
    mode: PlayMode,
    records: VecDeque<Recorded>,
    high_water: HashMap<Uuid, u64>,
    projection: Arc<RwLock<Value>>,
    error: Option<String>,
    no_output_since: Option<u64>,
    sleep_timer: super::sleep_timer::SleepTimer,
    next_internal_op: u64,
    advertisement: Option<vmusic_lan::discovery::Advertisement>,
    discoverable: bool,
}
fn transport_error(error: impl std::fmt::Display) -> RoomError {
    RoomError::new("room_transport", error.to_string())
}
fn local_mapping(now: u64) -> ClockMapping {
    ClockMapping {
        reference_local_ns: now,
        offset_ns: 0,
        drift_ppm: 0.0,
        uncertainty_ns: 1,
        min_rtt_ns: 1,
        samples: 8,
        residual_mad_ns: 0,
        observation_span_ns: 1_000_000_000,
    }
}
fn output_options(
    settings: &OutputSettings,
    clock: &MonotonicClock,
    rate: u32,
) -> vmusic_audio::OutputOptions {
    vmusic_audio::OutputOptions {
        device_id: settings.device_id.clone(),
        preferred_rate: rate,
        channels: 2,
        clock_origin: clock.origin(),
        latency_correction_ns: i64::from(settings.latency_correction_ms) * 1_000_000,
        calibration_binding: settings.calibration_binding.clone(),
    }
}
pub(super) struct HostOptions {
    pub name: String,
    pub address: SocketAddr,
    pub sample_rate: u32,
    pub local_output: bool,
    pub discoverable: bool,
}
pub(crate) async fn start(
    state: Arc<AppState>,
    options: HostOptions,
    lease: super::manager::ModeLease,
    projection: Arc<RwLock<Value>>,
    active: Arc<AtomicBool>,
) -> RoomResult<Session> {
    let HostOptions {
        name,
        address,
        sample_rate,
        local_output,
        discoverable,
    } = options;
    if name.trim().is_empty()
        || name.len() > 128
        || name.chars().count() > 64
        || name.chars().any(char::is_control)
    {
        return Err(RoomError::invalid("房间名称无效"));
    }
    let format = AudioFormat {
        id: 1,
        sample_rate,
        channels: 2,
    };
    format
        .validate()
        .map_err(|_| RoomError::invalid("请选择受支持的房间采样率"))?;
    if !vmusic_lan::discovery::interface_present(address).map_err(transport_error)? {
        return Err(RoomError::invalid("监听地址不属于可用网卡"));
    }
    let secrets =
        super::credentials::ProfileSecrets::new(&state.data_dir, crate::secrets::backend());
    let identity = secrets.host_identity().await.map_err(transport_error)?;
    let room = Uuid::new_v4();
    let instance = Uuid::new_v4();
    let clock = MonotonicClock::default();
    let (server, inbound) = RoomServer::bind(address, room, instance, &identity, clock.clone())
        .await
        .map_err(transport_error)?;
    let local_identity = StreamIdentity {
        room_id: room,
        instance_id: instance,
        session_id: Uuid::new_v4(),
    };
    server
        .transport
        .reserve_local_output(local_output)
        .map_err(transport_error)?;
    let output = super::output_preferences::load(&state.db).await?;
    let preferences = super::output_preferences::Preferences::spawn(state.db.clone());
    let (local, local_events) = if local_output {
        let (handle, events) = receiver::spawn(
            output_options(&output, &clock, sample_rate),
            local_identity,
            clock.clone(),
            lease.receiver.clone(),
        )
        .await
        .map_err(transport_error)?;
        handle.set_volume(output.volume).map_err(transport_error)?;
        handle
            .mapping(local_mapping(clock.now_ns()))
            .map_err(transport_error)?;
        (Some(handle), events)
    } else {
        let (_sender, events) = mpsc::channel(1);
        (None, events)
    };
    let cleanup = lease.completion.clone();
    let chat_transport = server.transport.clone();
    let notify = Arc::new(move |value: Value| {
        let topic = value["topic"].as_str().unwrap_or("chat_gap").to_owned();
        let _ = chat_transport.notify_chat(&ControlFrame::Notification { topic, body: value });
    });
    let library = SharedLibrary::with_reference_secret(identity.private_key_der());
    let (chat, chat_error) = match super::chat::ChatService::open_with_library(
        &state.data_dir,
        room,
        notify,
        library.clone(),
    )
    .await
    {
        Ok(chat) => (Some(chat), None),
        Err(e) => (None, Some(e.message)),
    };
    let (producer, render) = Producer::spawn(clock.clone()).map_err(transport_error)?;
    let advertisement = if discoverable {
        vmusic_lan::discovery::Advertisement::start(&name, server.address, room, server.fingerprint)
            .ok()
    } else {
        None
    };
    let current = state.audio.snapshot();
    let dsp = state.dsp.lock().await.clone();
    let history = super::history_writer::HistoryWriter::spawn(state.clone());
    let mut owner = Owner {
        state,
        server,
        clock,
        name,
        format,
        library,
        chat,
        chat_error,
        producer,
        scheduler: PlanScheduler::new(PlanTarget {
            track: TrackInstanceId(0),
            position_ms: 0,
            playing: false,
        }),
        render_heads: HashMap::new(),
        rendered_until: HashMap::new(),
        history,
        jobs: tokio::task::JoinSet::new(),
        source_jobs: HashMap::new(),
        successor_tokens: HashMap::new(),
        successor_targets: HashMap::new(),
        prepared_successors: HashMap::new(),
        pending_successors: HashMap::new(),
        next_job: 1,
        request_jobs: 0,
        mutation_preparing: false,
        collaboration: Default::default(),
        started_at_ms: wall_ms(),
        instances: Vec::new(),
        next_instance: 1,
        next_wire_plan: 1,
        candidate: None,
        audible: None,
        scheduled: None,
        boundaries: Boundaries::default(),
        presentation_catalog: PresentationCatalog::default(),
        endpoints: HashMap::new(),
        next_endpoint: 1,
        local,
        local_identity,
        local_events,
        receiver_registry: lease.receiver.clone(),
        output,
        preferences,
        output_preparing: false,
        dsp: DspParams {
            eq_gains_db: dsp.eq_gains_db,
            preamp_db: dsp.preamp_db,
            track_gain_db: 0.0,
        },
        crossfade_ms: dsp.crossfade_ms,
        loudness_mode: dsp.loudness_mode,
        volume: current.volume,
        mixer: MixerTimeline::default(),
        mode: current.mode,
        records: VecDeque::new(),
        high_water: HashMap::new(),
        projection,
        error: None,
        no_output_since: None,
        sleep_timer: super::sleep_timer::SleepTimer::default(),
        next_internal_op: 1,
        advertisement,
        discoverable,
    };
    owner.publish().await;
    let (commands, rx) = mpsc::channel(32);
    let (stop, stopped) = watch::channel(false);
    let done = tokio::spawn(async move {
        if let Err(error) = owner.run(rx, inbound, render, stopped).await {
            owner.error = Some(error.message);
            owner.publish().await;
        }
        // No UI lifetime participates in these native output leases.
        owner.receiver_registry.begin_close();
        owner.local.take();
        if let Err(error) = owner.receiver_registry.close_current().await {
            owner.error = Some(error.to_string());
            owner.publish().await;
        }
        owner.server.transport.end();
        drop(owner.advertisement.take());
        owner.jobs.abort_all();
        while owner.jobs.join_next().await.is_some() {}
        if let Some(chat) = &owner.chat {
            chat.shutdown().await;
        }
        owner.history.shutdown().await;
        owner.preferences.shutdown().await;
        owner.producer.shutdown().await;
        owner.server.shutdown().await;
        *owner.projection.write().unwrap_or_else(|e| e.into_inner()) =
            json!({"mode":"local","last_error":owner.error});
        lease.finish().await;
        active.store(false, Ordering::Release);
    });
    Ok(Session {
        commands,
        stop,
        done,
        cleanup,
    })
}
fn wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}
impl Owner {
    fn requester(&self, member: Uuid) -> super::collaboration::Requester {
        super::collaboration::Requester {
            member_id: member,
            name: if member == OWNER {
                "房主".into()
            } else {
                self.server
                    .transport
                    .members()
                    .into_iter()
                    .find(|m| m.id == member)
                    .map(|m| m.name)
                    .unwrap_or_else(|| "已离开成员".into())
            },
        }
    }
    fn frozen_prefix(&self) -> usize {
        let current = self.position(self.clock.now_ns()).0;
        self.presentation_instances()
            .into_iter()
            .chain([current])
            .filter_map(|id| self.instances.iter().position(|v| *v == id))
            .max()
            .map_or(0, |i| i + 1)
    }
    fn queue_item(&self, instance: u64, resource: Uuid, member: Uuid, votable: bool) -> Value {
        let mut value = self.collaboration.projection(instance, member, votable);
        value["instance_id"] = json!(instance.to_string());
        value["resource_id"] = json!(resource);
        value
    }
    async fn apply_social(
        &mut self,
        member: Uuid,
        session: Option<StreamIdentity>,
        vote: Option<(u64, bool)>,
        mode: Option<QueueOrder>,
    ) -> RoomResult<bool> {
        let _commit = self.state.play_commit.lock().await;
        let mut queue = self.state.queue.lock().await;
        self.check_access(member, session, |p| p.queue)?;
        if queue.len() != self.instances.len() {
            return Err(RoomError::new("room_queue_invariant", "队列身份状态不一致"));
        }
        let changed = match vote {
            Some((id, voted)) => self.collaboration.vote(id, member, voted)?,
            None => true,
        };
        if let Some(mode) = mode {
            self.collaboration.order = mode;
        }
        if self.collaboration.order == QueueOrder::Votes {
            let order = self
                .collaboration
                .sorted_suffix(&self.instances, self.frozen_prefix());
            let old = queue.clone();
            let old_instances = self.instances.clone();
            *queue = order.iter().map(|&i| old[i].clone()).collect();
            self.instances = order.iter().map(|&i| old_instances[i]).collect();
        }
        // The frozen prefix includes the presented instance and all distributed,
        // prepared and in-flight successors. No renderer work is displaced.
        Ok(changed)
    }
    fn presentation_instances(&self) -> Vec<u64> {
        let mut instances = self.boundaries.instances();
        instances.extend(self.render_heads.values().copied());
        instances.extend(self.prepared_successors.values().copied());
        instances.extend(
            self.pending_successors
                .values()
                .flatten()
                .filter_map(|instance| *instance),
        );
        instances.extend(
            self.successor_targets
                .values()
                .flat_map(|s| [s.current, s.next]),
        );
        instances.extend(self.audible.as_ref().map(|a| a.target.track.0));
        instances.extend(self.scheduled.as_ref().map(|a| a.target.track.0));
        instances.extend(self.candidate.as_ref().map(|a| a.target.track.0));
        instances
    }
    fn send_successor(
        &mut self,
        epoch: u64,
        source: Option<Source>,
        crossfade_ms: u64,
    ) -> RoomResult<()> {
        if self
            .pending_successors
            .values()
            .map(VecDeque::len)
            .sum::<usize>()
            >= 128
        {
            return Err(RoomError::new(
                "room_boundary_capacity",
                "后继准备回执积压，请重新创建房间",
            ));
        }
        let instance = source.as_ref().map(|source| source.instance);
        self.producer
            .next(epoch, source, crossfade_ms)
            .map_err(transport_error)?;
        // Commands and acknowledgments use FIFO channels. Retain every sent
        // identity until its acknowledgment installs the actual prepared deck.
        self.pending_successors
            .entry(epoch)
            .or_default()
            .push_back(instance);
        Ok(())
    }
    async fn remember_presentation(&mut self, instance: u64, track: &str) -> RoomResult<()> {
        let view = if let Some(resource) = self.library.resource_for(track).await {
            self.library.view(resource).await
        } else {
            None
        };
        self.presentation_catalog.remember(
            instance,
            PresentedTrack {
                track_id: track.to_owned(),
                view,
            },
        )
    }
    async fn change_mix(
        &mut self,
        member: Uuid,
        session: Option<StreamIdentity>,
        settings: MixSettings,
    ) -> RoomResult<Value> {
        if self.sleep_timer.is_due(self.clock.now_ns())
            || self.candidate.is_some()
            || self.scheduled.is_some()
            || self.mutation_preparing
            || self.request_jobs >= 8
        {
            return Err(RoomError::new("room_busy", "请等待当前准备或切换完成"));
        }
        let mode = settings.loudness_mode.clone();
        let refresh_gains = mode != self.loudness_mode;
        let mut tracks = HashMap::new();
        if refresh_gains {
            tracks.extend(
                self.instances
                    .iter()
                    .copied()
                    .zip(self.state.queue.lock().await.iter().cloned()),
            );
            // A removed successor may still contribute immutable overlap PCM.
            // Its presentation identity survives outside the playback queue.
            for instance in self
                .presentation_instances()
                .into_iter()
                .filter(|id| *id != 0)
            {
                if let std::collections::hash_map::Entry::Vacant(entry) = tracks.entry(instance) {
                    entry.insert(self.track_for(instance).await?);
                }
            }
        }
        let change = self.mixer.begin(settings)?;
        self.scheduler
            .control_changed()
            .ok_or_else(RoomError::exhausted)?;
        let state = self.state.clone();
        self.request_jobs += 1;
        self.jobs.spawn(async move {
            let result = host_jobs::bounded(async {
                let mut gains = HashMap::new();
                for (instance, track) in tracks {
                    gains.insert(instance, host_jobs::gain(&state, &track, &mode).await);
                }
                Ok(gains)
            })
            .await;
            Completion::Mixer {
                change,
                member,
                session,
                result,
            }
        });
        self.publish().await;
        Ok(
            json!({"state":self.mixer.outcome(change),"revision":self.scheduler.revision().0.to_string()}),
        )
    }
    async fn dispatch_local(&mut self, envelope: Envelope) -> RoomResult<()> {
        match envelope.request {
            LocalRequest::TestOutput => {
                let receiver = self.local.clone().filter(|_| {
                    self.request_jobs < 8
                        && !self.output_preparing
                        && !self.position(self.clock.now_ns()).2
                        && self.candidate.is_none()
                        && self.scheduled.is_none()
                });
                let Some(receiver) = receiver else {
                    let _ = envelope
                        .reply
                        .send(Err(RoomError::invalid("请先暂停播放并启用本机输出")));
                    return Ok(());
                };
                self.request_jobs += 1;
                self.jobs.spawn(async move {
                    let result = receiver
                        .test_output()
                        .await
                        .map_err(transport_error)
                        .map(|()| json!({"state":"applied"}));
                    Completion::Diagnostic {
                        reply: Reply::Local(envelope.reply),
                        result,
                    }
                });
                Ok(())
            }
            LocalRequest::Peer { request } => {
                self.dispatch_peer(
                    OWNER,
                    None,
                    owner_permissions(),
                    request,
                    Reply::Local(envelope.reply),
                )
                .await
            }
            LocalRequest::Output { settings, enabled } => {
                if let Err(e) = validate_output(&settings) {
                    let _ = envelope.reply.send(Err(e));
                    return Ok(());
                }
                if self.output_preparing {
                    let _ = envelope
                        .reply
                        .send(Err(RoomError::new("room_busy", "声卡正在切换，请稍候")));
                    return Ok(());
                }
                if enabled {
                    if let Err(e) = self.server.transport.reserve_local_output(true) {
                        let _ = envelope.reply.send(Err(transport_error(e)));
                        return Ok(());
                    }
                }
                if enabled
                    && self.local.is_some()
                    && settings.device_id == self.output.device_id
                    && settings.latency_correction_ms == self.output.latency_correction_ms
                {
                    let result = self
                        .local_request(LocalRequest::Output { settings, enabled })
                        .await;
                    let _ = envelope.reply.send(result);
                    return Ok(());
                }
                self.output_preparing = true;
                self.local.take();
                self.endpoints.remove(&OWNER);
                let options = output_options(&settings, &self.clock, self.format.sample_rate);
                let clock = self.clock.clone();
                let identity = self.local_identity;
                let registry = self.receiver_registry.clone();
                self.jobs.spawn(async move {
                    let _ = registry.close_current().await;
                    let result = if enabled {
                        receiver::spawn(options, identity, clock, registry)
                            .await
                            .map(Some)
                            .map_err(transport_error)
                    } else {
                        Ok(None)
                    };
                    Completion::Output {
                        settings,
                        reply: Reply::Local(envelope.reply),
                        result,
                    }
                });
                Ok(())
            }
            LocalRequest::Share { track_ids } => {
                if self.mutation_preparing
                    || self.candidate.is_some()
                    || self.scheduled.is_some()
                    || self.mixer.pending.is_some()
                {
                    envelope
                        .reply
                        .send(Err(RoomError::new("room_busy", "请等待当前准备或切换完成")))
                        .ok();
                    return Ok(());
                }
                self.mutation_preparing = true;
                self.request_jobs += 1;
                let revision = self.scheduler.revision().0;
                let library = self.library.clone();
                let library_revision = library.revision().await;
                let state = self.state.clone();
                self.jobs.spawn(async move {
                    let result = host_jobs::bounded(library.prepare_replace(&state, track_ids))
                        .await
                        .map(PreparedAction::Share);
                    Completion::Request {
                        member: OWNER,
                        session: None,
                        permissions: owner_permissions(),
                        revision,
                        library_revision,
                        mutation: true,
                        reply: Reply::Local(envelope.reply),
                        result,
                    }
                });
                Ok(())
            }
            request => {
                let result = self.local_request(request).await;
                let _ = envelope.reply.send(result);
                Ok(())
            }
        }
    }
    async fn dispatch_peer(
        &mut self,
        member: Uuid,
        session: Option<StreamIdentity>,
        permissions: Permissions,
        request: PeerRequest,
        reply: Reply,
    ) -> RoomResult<()> {
        let mutation = matches!(request, PeerRequest::Queue { .. });
        if let PeerRequest::Queue { operation_id, .. } = &request {
            if operation_id.0 <= self.high_water.get(&member).copied().unwrap_or(0) {
                let result = self.peer(member, session, permissions, request, None).await;
                reply.send(result);
                return Ok(());
            }
        }
        if matches!(
            request,
            PeerRequest::Resource { .. } | PeerRequest::Queue { .. }
        ) {
            if self.request_jobs >= 8 || (mutation && self.mutation_preparing) {
                reply.send(Err(RoomError::new("room_busy", "本地资源准备队列繁忙")));
                return Ok(());
            }
            let permission = match request {
                PeerRequest::Queue { .. } => permissions.queue,
                _ => permissions.listen || permissions.queue || permissions.transport,
            };
            if !permission {
                reply.send(Err(RoomError::denied()));
                return Ok(());
            }
            if let PeerRequest::Queue {
                expected_revision, ..
            } = &request
            {
                if expected_revision.0 != self.scheduler.revision().0 {
                    reply.send(Err(RoomError::new(
                        "revision_conflict",
                        "队列状态已改变，请刷新后重试",
                    )));
                    return Ok(());
                }
                if self.candidate.is_some() || self.scheduled.is_some() {
                    reply.send(Err(RoomError::new("room_busy", "请等待当前切换完成")));
                    return Ok(());
                }
            }
            self.request_jobs += 1;
            if mutation {
                self.mutation_preparing = true;
            }
            let revision = self.scheduler.revision().0;
            let state = self.state.clone();
            let library = self.library.clone();
            let library_revision = library.revision().await;
            self.jobs.spawn(async move {
                let result = host_jobs::bounded(async {
                    match request {
                        PeerRequest::Queue { ref items, .. } => {
                            if items.len() > 2000 {
                                return Err(RoomError::invalid("队列最多2000项"));
                            }
                            let mut tracks = Vec::with_capacity(items.len());
                            for item in items {
                                tracks.push(library.source(&state, item.resource_id).await?.0);
                            }
                            Ok(PreparedAction::Queue { request, tracks })
                        }
                        PeerRequest::Resource {
                            resource_id,
                            kind,
                            offset,
                            revision,
                        } => serde_json::to_value(
                            library
                                .read(&state, resource_id, kind, offset, revision)
                                .await?,
                        )
                        .map(PreparedAction::Resource)
                        .map_err(|_| RoomError::storage()),
                        _ => unreachable!(),
                    }
                })
                .await;
                Completion::Request {
                    member,
                    session,
                    permissions,
                    revision,
                    library_revision,
                    mutation,
                    reply,
                    result,
                }
            });
            return Ok(());
        }
        let result = self.peer(member, session, permissions, request, None).await;
        reply.send(result);
        Ok(())
    }
    async fn complete(&mut self, completion: Completion) -> RoomResult<()> {
        match completion {
            Completion::Mixer {
                change,
                member,
                session,
                result,
            } => {
                self.request_jobs = self.request_jobs.saturating_sub(1);
                if let Some(pending) = self.mixer.pending.as_ref().filter(|p| p.id == change) {
                    let settings = pending.settings.clone();
                    let result = result.and_then(|gains| {
                        self.check_access(member, session, |permissions| permissions.volume)?;
                        self.producer
                            .dsp(
                                change,
                                settings.dsp,
                                settings.volume,
                                gains,
                                settings.crossfade_ms,
                            )
                            .map_err(transport_error)
                    });
                    if let Err(error) = result {
                        self.mixer.fail(change, error.message.clone());
                        self.error = Some(error.message);
                    }
                }
            }
            Completion::Diagnostic { reply, result } => {
                self.request_jobs = self.request_jobs.saturating_sub(1);
                reply.send(result);
            }
            Completion::Request {
                member,
                session,
                permissions,
                revision,
                library_revision,
                mutation,
                reply,
                result,
            } => {
                self.request_jobs = self.request_jobs.saturating_sub(1);
                // Only one mutation preparation is admitted at a time. Resource
                // reads do not occupy that slot or depend on control revision.
                if mutation {
                    self.mutation_preparing = false;
                }
                let result=async{
                    let action=result?;
                    if self.library.revision().await!=library_revision{return Err(RoomError::new("revision_conflict","分享范围已改变，准备结果已丢弃"))}
                    match action{
                        PreparedAction::Resource(value)=>{self.check_access(member,session,|p|p.listen||p.queue||p.transport)?;Ok(value)},
                        PreparedAction::Queue{request,tracks}=>{
                            self.check_access(member,session,|p|p.queue)?;
                            if revision!=self.scheduler.revision().0{return Err(RoomError::new("revision_conflict","准备期间队列状态已改变，操作未提交"))}
                            self.peer(member,session,permissions,request,Some(tracks)).await
                        },
                        PreparedAction::Share(prepared)=>{
                            if revision!=self.scheduler.revision().0||self.candidate.is_some()||self.scheduled.is_some(){return Err(RoomError::new("revision_conflict","准备期间房间状态已改变，分享范围未提交"))}
                            let views=self.library.commit_replace(prepared).await?;
                            self.scheduler.control_changed().ok_or_else(RoomError::exhausted)?;
                            // Already distributed PCM remains immutable. Revoke
                            // future starts immediately, then suspend this prefix
                            // at the same approved future boundary on every output.
                            let mut rendered=self.boundaries.instances();
                            rendered.extend(self.render_heads.values().copied());
                            // A prepared successor may already contribute to a
                            // crossfade before its promotion boundary is emitted.
                            rendered.extend(self.successor_targets.values().map(|s|s.next));
                            rendered.extend(self.prepared_successors.values().copied());
                            rendered.extend(self.pending_successors.values().flatten().filter_map(|instance|*instance));
                            if let Some(a)=&self.audible{if a.target.playing{rendered.push(a.target.track.0);}}
                            let mut revoked=false;
                            for instance in rendered {
                                let authorized=match self.track_for(instance).await{Ok(track)=>self.library.resource_for(&track).await.is_some(),Err(_)=>false};
                                revoked|=!authorized;
                            }
                            if revoked {self.internal(Playback::Pause).await?;}
                            else {self.prepare_successor().await?;}
                            self.publish().await;Ok(json!({"tracks":views,"revision":self.scheduler.revision().0.to_string()}))
                        },
                    }
                }.await;
                reply.send(result);
            }
            Completion::Source {
                epoch,
                instance,
                position_ms,
                loudness_mode,
                library_revision,
                result,
            } => {
                self.source_jobs.remove(&(0, epoch));
                if self.candidate.as_ref().is_none_or(|c| {
                    c.wire.epoch.0 != epoch
                        || c.target.track.0 != instance
                        || c.target.position_ms != position_ms
                }) {
                    return Ok(());
                }
                if self.library.revision().await != library_revision
                    || self.loudness_mode != loudness_mode
                {
                    self.candidate.as_mut().unwrap().loading = false;
                    return self.materialize().await;
                }
                match result {
                    Ok(source) => self.install_source(epoch, Some(source))?,
                    Err(error) => {
                        let c = self.candidate.take().unwrap();
                        self.scheduler
                            .fail_preparing(c.scheduler_plan, timeline::PlanFailure::DecodeFailed);
                        self.error = Some(error.message);
                    }
                }
            }
            Completion::Successor {
                epoch,
                current,
                token,
                library_revision,
                result,
            } => {
                if self.successor_tokens.get(&epoch) != Some(&token)
                    || self.render_heads.get(&epoch) != Some(&current)
                    || self.epoch_plan(epoch).is_none()
                {
                    return Ok(());
                }
                self.source_jobs.remove(&(1, epoch));
                if library_revision != self.library.revision().await {
                    self.successor_targets.remove(&epoch);
                    return self.prepare_successor_for(epoch, current).await;
                }
                match result {
                    Ok(source) => self.send_successor(epoch, Some(source), self.crossfade_ms)?,
                    Err(e) => {
                        self.successor_targets.remove(&epoch);
                        self.error = Some(e.message);
                        self.send_successor(epoch, None, 0)?;
                    }
                }
            }
            Completion::Output {
                settings,
                reply,
                result,
            } => {
                self.output_preparing = false;
                self.output = settings;
                if !matches!(&result, Ok(Some(_))) {
                    self.server
                        .transport
                        .reserve_local_output(false)
                        .map_err(transport_error)?;
                }
                let result = match result {
                    Ok(Some((receiver, events))) => {
                        receiver
                            .set_volume(self.output.volume)
                            .map_err(transport_error)?;
                        receiver
                            .mapping(local_mapping(self.clock.now_ns()))
                            .map_err(transport_error)?;
                        self.local = Some(receiver);
                        self.local_events = events;
                        self.join(OWNER)?;
                        Ok(json!({"state":"applied"}))
                    }
                    Ok(None) => Ok(json!({"state":"applied"})),
                    Err(e) => {
                        self.error = Some(e.message.clone());
                        Err(e)
                    }
                };
                if result.is_ok() {
                    self.preferences.save(&self.output);
                }
                self.publish().await;
                reply.send(result);
            }
        }
        Ok(())
    }
    fn wire_id(&mut self) -> RoomResult<u64> {
        let id = self.next_wire_plan;
        self.next_wire_plan = id.checked_add(1).ok_or_else(RoomError::exhausted)?;
        Ok(id)
    }
    fn time(plan: &Plan, frame: u64) -> RoomResult<u64> {
        plan.anchor_ns
            .0
            .checked_add(
                u64::try_from(
                    u128::from(frame) * 1_000_000_000 / u128::from(plan.format.sample_rate),
                )
                .map_err(|_| RoomError::exhausted())?,
            )
            .ok_or_else(RoomError::exhausted)
    }
    fn position(&self, at: u64) -> (u64, u64, bool) {
        let Some(audible) = &self.audible else {
            return (0, 0, false);
        };
        let elapsed = if audible.target.playing {
            at.saturating_sub(audible.position_at_ns)
        } else {
            0
        };
        (
            audible.target.track.0,
            audible
                .target
                .position_ms
                .saturating_add(elapsed / 1_000_000),
            audible.target.playing,
        )
    }
    async fn run(
        &mut self,
        mut local: mpsc::Receiver<Envelope>,
        mut inbound: mpsc::Receiver<Inbound>,
        mut render: mpsc::Receiver<ProducerEvent>,
        mut stop: watch::Receiver<bool>,
    ) -> RoomResult<()> {
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(20));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_publish = 0;
        let mut last_interface = 0;
        let mut failure = self.producer.failure.clone();
        let mut exiting = self.state.exiting_signal();
        loop {
            if *stop.borrow() || *exiting.borrow() {
                break;
            }
            tokio::select! {
                biased;
                _=stop.changed()=>break,
                _=exiting.changed()=>break,
                _=failure.changed()=>{return Err(RoomError::new("room_render",failure.borrow().clone().unwrap_or_else(||"共享渲染已停止".into())));},
                _=tick.tick()=>{
                    let now=self.clock.now_ns();self.advance(now).await?;
                    if now.saturating_sub(last_publish)>=250_000_000{last_publish=now;self.publish().await;}
                    if now.saturating_sub(last_interface)>=1_000_000_000{last_interface=now;if !vmusic_lan::discovery::interface_present(self.server.address).unwrap_or(false){return Err(RoomError::new("room_interface_lost","房间网卡已离线，请重新选择网卡创建房间"));}}
                },
                completion=self.jobs.join_next(),if !self.jobs.is_empty()=>{match completion{Some(Ok(completion))=>self.complete(completion).await?,Some(Err(e)) if e.is_cancelled()=>{},Some(Err(_))=>return Err(RoomError::new("room_preparation_failed","资源准备任务意外停止")),None=>{}}},
                event=self.local_events.recv(),if self.local.is_some()=>{let Some(event)=event else{return Err(RoomError::new("room_output_closed","本机输出线程意外停止"))};self.local_event(event).await?;},
                event=inbound.recv()=>{let Some(event)=event else{break};self.network(event).await?;},
                event=render.recv()=>{let Some(event)=event else{break};self.render(event).await?;},
                envelope=local.recv()=>{let Some(envelope)=envelope else{break};if let LocalRequest::Peer{request}=&envelope.request {
                        if let Some(job)=self.chat_job(OWNER,None,request.clone()) {tokio::spawn(async move{let _=envelope.reply.send(job.await);});continue;}
                    }
                    if let LocalRequest::ChatAdmin{command}=&envelope.request{
                        let job=self.chat_admin(command.clone());tokio::spawn(async move{let _=envelope.reply.send(job.await);});continue;
                    }
                    self.dispatch_local(envelope).await?;},
            }
        }
        Ok(())
    }
    async fn advance(&mut self, now: u64) -> RoomResult<()> {
        self.scheduler.advance(now);
        if let Some(settings) = self.mixer.take_due(now) {
            self.dsp = settings.dsp;
            self.volume = settings.volume;
            self.crossfade_ms = settings.crossfade_ms;
            self.loudness_mode = settings.loudness_mode;
            self.prepare_successor().await?;
        }
        if self.sleep_timer.is_due(now) {
            match self.internal(Playback::Pause).await {
                Ok(_) => self.sleep_timer.complete(),
                Err(error) => self.error = Some(format!("睡眠定时暂停失败：{}", error.message)),
            }
        }
        let epochs = [
            self.candidate.as_ref().map(|c| c.wire.epoch.0),
            self.scheduled.as_ref().map(|a| a.plan.epoch.0),
            self.audible.as_ref().map(|a| a.plan.epoch.0),
        ];
        self.render_heads
            .retain(|epoch, _| epochs.contains(&Some(*epoch)));
        self.rendered_until
            .retain(|epoch, _| epochs.contains(&Some(*epoch)));
        self.boundaries.retain_epochs(&epochs);
        let retained = self.presentation_instances();
        self.presentation_catalog.retain(&retained);
        self.source_jobs.retain(|(_, epoch), task| {
            let keep = epochs.contains(&Some(*epoch));
            if !keep {
                task.abort();
            }
            keep
        });
        self.successor_tokens
            .retain(|epoch, _| epochs.contains(&Some(*epoch)));
        self.successor_targets
            .retain(|epoch, _| epochs.contains(&Some(*epoch)));
        self.prepared_successors
            .retain(|epoch, _| epochs.contains(&Some(*epoch)));
        self.pending_successors
            .retain(|epoch, _| epochs.contains(&Some(*epoch)));
        let members = self.server.transport.members();
        self.collaboration
            .retain_members(&members.iter().map(|m| m.id).collect::<Vec<_>>());
        self.high_water
            .retain(|id, _| *id == OWNER || members.iter().any(|m| m.id == *id));
        // Merge presentation events by audible time, across both epochs.
        loop {
            let switch = self
                .scheduled
                .as_ref()
                .map(|p| p.plan.anchor_ns.0)
                .filter(|at| *at <= now);
            let boundary = self
                .boundaries
                .front()
                .map(|b| b.at)
                .filter(|at| *at <= now);
            match (switch, boundary) {
                (Some(at), other) if other.is_none_or(|b| at <= b) => {
                    let previous = self
                        .audible
                        .as_ref()
                        .map(|a| (a.target.track, a.target.playing));
                    self.audible = self.scheduled.take();
                    if let Some(a) = &self.audible {
                        self.scheduler.observe_transition(a.target);
                    }
                    if let Some(a) = &self.audible {
                        self.record_presentation(
                            a.target.track.0,
                            a.target.playing && previous != Some((a.target.track, true)),
                        )
                        .await;
                    }
                    if self.candidate.as_ref().is_some_and(|c| !c.materialized) {
                        self.materialize().await?;
                    }
                }
                (_, Some(_)) => {
                    let boundary = self.boundaries.pop().unwrap();
                    if self
                        .audible
                        .as_ref()
                        .is_none_or(|a| a.plan.epoch.0 != boundary.epoch)
                    {
                        continue;
                    }
                    if boundary.ended {
                        // EOF is an audible fact even if the next source fails.
                        if let Some(a) = &mut self.audible {
                            let elapsed = boundary.at.saturating_sub(a.position_at_ns);
                            a.target.position_ms =
                                a.target.position_ms.saturating_add(elapsed / 1_000_000);
                            a.position_frames = a.position_frames.saturating_add(
                                (u128::from(elapsed) * u128::from(self.format.sample_rate)
                                    / 1_000_000_000) as u64,
                            );
                            a.target.playing = false;
                            a.position_at_ns = boundary.at;
                            self.scheduler.observe_transition(a.target);
                        }
                        if self.scheduled.is_none() && self.candidate.is_none() {
                            if let Err(error) = self.internal(Playback::Next).await {
                                self.error = Some(error.message);
                            }
                        }
                    } else {
                        if let Some(a) = &mut self.audible {
                            a.target.track = TrackInstanceId(boundary.instance);
                            a.target.position_ms = boundary.position_frames * 1000
                                / u64::from(self.format.sample_rate);
                            a.position_at_ns = boundary.at;
                            a.position_frames = boundary.position_frames;
                            self.scheduler.observe_transition(a.target);
                        }
                        self.record_presentation(boundary.instance, true).await;
                    }
                }
                _ => break,
            }
        }
        if let Some(error) = self.history.error.borrow().clone() {
            self.error = Some(error);
        }
        if let Some(local) = &self.local {
            let _ = local.mapping(local_mapping(now));
        }
        if self
            .candidate
            .as_ref()
            .is_some_and(|c| c.prepared && (c.ready || !c.target.playing))
        {
            self.try_commit().await?;
        }
        if self.candidate.as_ref().is_some_and(|c| {
            c.materialized && now.saturating_add(MIN_COMMIT_NS) > c.wire.anchor_ns.0
        }) {
            let candidate = self.candidate.take().unwrap();
            self.scheduler.fail_preparing(
                candidate.scheduler_plan,
                timeline::PlanFailure::OutputNotReady,
            );
            self.producer
                .cancel(candidate.wire.epoch.0)
                .map_err(transport_error)?;
            self.error = Some("输出端尚未就绪，操作未生效；检查声卡与网络后可以重新播放".into());
        }
        let output_present = self.local.as_ref().is_some_and(|r| r.status().output_ready)
            || self.endpoints.iter().any(|(member, e)| {
                *member != OWNER
                    && e.audio
                    && self
                        .server
                        .transport
                        .authorize(*member, e.identity)
                        .is_ok_and(|p| p.listen)
                    && e.last_output
                        .is_some_and(|t| now.saturating_sub(t) <= 5_000_000_000)
            });
        if output_present {
            self.no_output_since = None;
        } else if self.position(now).2 {
            let since = *self.no_output_since.get_or_insert(now);
            if now.saturating_sub(since) >= 3_000_000_000 && self.scheduled.is_none() {
                self.halt_presentation("所有音频输出均已离线，房间播放已暂停")?;
            }
        }
        let retries = self
            .endpoints
            .iter()
            .filter_map(|(member, endpoint)| {
                (endpoint.rejoin.requested && now >= endpoint.rejoin.not_before_ns)
                    .then_some(*member)
            })
            .collect::<Vec<_>>();
        for member in retries {
            self.join(member)?;
        }
        Ok(())
    }
    async fn local_event(&mut self, event: ReceiverEvent) -> RoomResult<()> {
        match event {
            ReceiverEvent::Ready { epoch, plan_id } => {
                self.ready(OWNER, self.local_identity, epoch, plan_id)?
            }
            ReceiverEvent::Resync { reason } => {
                self.error = Some(reason);
                self.resync(OWNER)?;
            }
            ReceiverEvent::Status(status) => {
                let ready = status.output_ready;
                let prior = self
                    .endpoints
                    .get(&OWNER)
                    .is_some_and(|e| e.last_output.is_some());
                if let Some(e) = self.endpoints.get_mut(&OWNER) {
                    e.last_output = ready.then(|| self.clock.now_ns());
                    if !ready {
                        e.ready = false;
                    }
                }
                if ready && !prior {
                    let _ = self.join(OWNER);
                }
            }
        }
        Ok(())
    }
    fn ready(
        &mut self,
        member: Uuid,
        identity: StreamIdentity,
        epoch: u64,
        plan_id: u64,
    ) -> RoomResult<()> {
        let Some(endpoint) = self
            .endpoints
            .get_mut(&member)
            .filter(|e| e.identity == identity && e.audio)
        else {
            return Ok(());
        };
        let Some(plan) = endpoint
            .plan
            .as_ref()
            .filter(|p| p.epoch.0 == epoch && p.plan_id.0 == plan_id)
        else {
            return Ok(());
        };
        if Self::time(plan, plan.join_frame.0)? < self.clock.now_ns().saturating_add(MIN_COMMIT_NS)
        {
            return self.resync(member);
        }
        endpoint.ready = true;
        if let Some(c) = self.candidate.as_mut().filter(|c| c.wire.epoch.0 == epoch) {
            c.ready = true;
            self.scheduler
                .report_ready(EndpointId(endpoint.index), c.scheduler_plan);
        } else {
            self.join_commit(member, epoch, plan_id)?;
        }
        Ok(())
    }
    async fn network(&mut self, event: Inbound) -> RoomResult<()> {
        match event {
            Inbound::Connected {
                member_id,
                identity,
            } => {
                let index = self.next_endpoint;
                self.next_endpoint = self
                    .next_endpoint
                    .checked_add(1)
                    .ok_or_else(RoomError::exhausted)?;
                self.collaboration
                    .event("join", self.requester(member_id), None, wall_ms());
                self.endpoints.insert(
                    member_id,
                    Endpoint {
                        identity,
                        index,
                        audio: false,
                        last_output: None,
                        plan: None,
                        committed: false,
                        ready: false,
                        rejoin: JoinRetry::default(),
                    },
                );
            }
            Inbound::AudioAttached {
                member_id,
                identity,
            } => {
                if let Some(endpoint) = self
                    .endpoints
                    .get_mut(&member_id)
                    .filter(|e| e.identity == identity)
                {
                    endpoint.audio = true;
                }
                self.join(member_id)?;
            }
            Inbound::Disconnected {
                member_id,
                identity,
            } => {
                if self
                    .endpoints
                    .get(&member_id)
                    .is_some_and(|e| e.identity == identity)
                {
                    self.endpoints.remove(&member_id);
                    self.collaboration
                        .event("leave", self.requester(member_id), None, wall_ms());
                }
            }
            Inbound::Heartbeat {
                member_id,
                identity,
                output_ready,
                ..
            } => {
                let mut became_ready = false;
                let authorized = self
                    .server
                    .transport
                    .authorize(member_id, identity)
                    .is_ok_and(|p| p.listen);
                if let Some(endpoint) = self
                    .endpoints
                    .get_mut(&member_id)
                    .filter(|e| e.identity == identity && e.audio && authorized)
                {
                    became_ready = output_ready && endpoint.last_output.is_none();
                    endpoint.last_output = output_ready.then(|| self.clock.now_ns());
                    if !output_ready {
                        endpoint.ready = false;
                    }
                }
                if became_ready {
                    let _ = self.join(member_id);
                }
            }
            Inbound::Ready {
                member_id,
                identity,
                epoch,
                plan_id,
            } => {
                if self.server.transport.authorize(member_id, identity).is_ok() {
                    let _ = self.ready(member_id, identity, epoch, plan_id);
                }
            }
            Inbound::Resync {
                member_id,
                identity,
            } => {
                if self.server.transport.authorize(member_id, identity).is_ok() {
                    self.resync(member_id)?;
                }
            }
            Inbound::Request {
                member_id,
                identity,
                body,
                reply,
            } => {
                let result: RoomResult<Value> =
                    match self.server.transport.authorize(member_id, identity) {
                        Ok(permissions) => match serde_json::from_value::<PeerRequest>(body) {
                            Ok(request) => {
                                if let Some(job) =
                                    self.chat_job(member_id, Some(identity), request.clone())
                                {
                                    tokio::spawn(async move {
                                        let value = match job.await {
                                            Ok(v) => json!({"ok":true,"result":v}),
                                            Err(e) => json!({"ok":false,"error":e}),
                                        };
                                        let _ = reply.send(value);
                                    });
                                    return Ok(());
                                }
                                self.dispatch_peer(
                                    member_id,
                                    Some(identity),
                                    permissions,
                                    request,
                                    Reply::Remote(reply),
                                )
                                .await?;
                                return Ok(());
                            }
                            Err(_) => Err(RoomError::invalid("不支持的房间请求")),
                        },
                        Err(_) => Err(RoomError::denied()),
                    };
                let value = match result {
                    Ok(value) => json!({"ok":true,"result":value}),
                    Err(error) => json!({"ok":false,"error":error}),
                };
                let _ = reply.send(value);
            }
        }
        Ok(())
    }
    fn send(&self, member: Uuid, frame: &ControlFrame) -> RoomResult<()> {
        if member == OWNER {
            let Some(receiver) = &self.local else {
                return Ok(());
            };
            match frame {
                ControlFrame::Prepare { plan } => {
                    receiver.prepare(self.local_identity, plan.clone())
                }
                ControlFrame::Commit {
                    epoch,
                    plan_id,
                    effective_at,
                } => receiver.commit(self.local_identity, epoch.0, plan_id.0, effective_at.0),
                ControlFrame::Suspend {
                    epoch,
                    plan_id,
                    effective_at,
                } => receiver.suspend(self.local_identity, epoch.0, plan_id.0, effective_at.0),
                ControlFrame::Resync { .. } => {
                    receiver.invalidate();
                    Ok(())
                }
                _ => Ok(()),
            }
            .map_err(transport_error)
        } else {
            let endpoint = self.endpoints.get(&member).ok_or_else(RoomError::denied)?;
            self.server
                .transport
                .send(member, endpoint.identity, frame)
                .map_err(transport_error)
        }
    }
    fn broadcast(&self, frame: &ControlFrame) {
        let _ = self.send(OWNER, frame);
        for member in self.endpoints.keys().filter(|m| **m != OWNER) {
            let _ = self.send(*member, frame);
        }
    }
    fn send_plan_frame(&mut self, member: Uuid, frame: &ControlFrame) -> RoomResult<bool> {
        if member == OWNER {
            self.send(member, frame)?;
            return Ok(true);
        }
        let Some(identity) = self
            .endpoints
            .get(&member)
            .map(|endpoint| endpoint.identity)
        else {
            return Ok(false);
        };
        match self.server.transport.send(member, identity, frame) {
            Ok(()) => Ok(true),
            Err(vmusic_lan::server::TransportError::Closed)
            | Err(vmusic_lan::server::TransportError::Access(
                vmusic_lan::members::AccessError::Denied,
            )) => {
                // Congestion and disconnect races retire only this output.
                // The shared candidate and healthy endpoints keep their prefix.
                self.endpoints.remove(&member);
                Ok(false)
            }
            Err(error) => Err(transport_error(error)),
        }
    }
    fn resync(&mut self, member: Uuid) -> RoomResult<()> {
        // A receiver has discarded this prefix. Keep its old plan as a token
        // fence until the shared candidate commits or expires; re-sending its
        // frame-zero Prepare cannot recover PCM that has already been sent.
        // Other healthy endpoints still authorize the shared operation.
        if let Some(endpoint) = self.endpoints.get_mut(&member) {
            endpoint.ready = false;
            endpoint.committed = false;
            endpoint.rejoin.requested = true;
        }
        self.join(member)
    }
    fn join(&mut self, member: Uuid) -> RoomResult<()> {
        if member == OWNER && self.local.is_none() {
            return Ok(());
        }
        if self.candidate.as_ref().is_some_and(|c| !c.target.playing)
            || self.scheduled.as_ref().is_some_and(|s| !s.target.playing)
        {
            return Ok(());
        }
        let base = self
            .candidate
            .as_ref()
            .filter(|c| c.materialized)
            .map(|c| c.wire.clone())
            .or_else(|| self.scheduled.as_ref().map(|s| s.plan.clone()))
            .or_else(|| {
                self.audible
                    .as_ref()
                    .filter(|a| a.target.playing)
                    .map(|s| s.plan.clone())
            });
        let Some(mut plan) = base else { return Ok(()) };
        let candidate = self
            .candidate
            .as_ref()
            .is_some_and(|c| c.materialized && c.wire.epoch == plan.epoch);
        if candidate && plan.anchor_ns.0 < self.clock.now_ns().saturating_add(MIN_COMMIT_NS) {
            return Ok(());
        }
        if candidate
            && self
                .endpoints
                .get(&member)
                .and_then(|e| e.plan.as_ref())
                .is_some_and(|previous| previous.epoch == plan.epoch)
        {
            return Ok(());
        }
        if !candidate {
            // Beyond the producer's 500ms future watermark: no old PCM replay
            // or per-endpoint retransmission queue is required for joining.
            let target = self
                .clock
                .now_ns()
                .saturating_add(800_000_000)
                .max(plan.anchor_ns.0);
            plan.join_frame = Counter(
                u64::try_from(
                    u128::from(target.saturating_sub(plan.anchor_ns.0))
                        * u128::from(self.format.sample_rate)
                        / 1_000_000_000,
                )
                .map_err(|_| RoomError::exhausted())?,
            );
        }
        if member == OWNER && !self.endpoints.contains_key(&OWNER) {
            self.endpoints.insert(
                OWNER,
                Endpoint {
                    identity: self.local_identity,
                    index: 0,
                    audio: true,
                    last_output: self
                        .local
                        .as_ref()
                        .filter(|r| r.status().output_ready)
                        .map(|_| self.clock.now_ns()),
                    plan: None,
                    committed: false,
                    ready: false,
                    rejoin: JoinRetry::default(),
                },
            );
        }
        let now = self.clock.now_ns();
        let available = self
            .endpoints
            .get(&member)
            .is_some_and(|e| self.endpoint_clock_ready(member, e, now));
        let Some(endpoint) = self.endpoints.get_mut(&member) else {
            return Ok(());
        };
        endpoint.ready = false;
        if !endpoint.rejoin.take(now, available) {
            return Ok(());
        }
        plan.plan_id = Counter(self.wire_id()?);
        let endpoint = self
            .endpoints
            .get_mut(&member)
            .ok_or_else(RoomError::denied)?;
        if !endpoint.audio {
            return Ok(());
        }
        endpoint.plan = Some(plan.clone());
        endpoint.committed = false;
        endpoint.ready = false;
        self.send_plan_frame(member, &ControlFrame::Prepare { plan })?;
        Ok(())
    }
    fn join_commit(&mut self, member: Uuid, epoch: u64, plan_id: u64) -> RoomResult<()> {
        let Some(endpoint) = self.endpoints.get(&member) else {
            return Ok(());
        };
        if !self.endpoint_output_ready(member, endpoint, self.clock.now_ns()) {
            return Ok(());
        }
        let Some(plan) = endpoint
            .plan
            .as_ref()
            .filter(|p| p.epoch.0 == epoch && p.plan_id.0 == plan_id)
        else {
            return Ok(());
        };
        let at = Self::time(plan, plan.join_frame.0)?;
        if endpoint.committed || !endpoint.ready {
            return Ok(());
        }
        if self.clock.now_ns().saturating_add(MIN_COMMIT_NS) > at {
            return self.join(member);
        }
        if !self.send_plan_frame(
            member,
            &ControlFrame::Commit {
                epoch: Counter(epoch),
                plan_id: Counter(plan_id),
                effective_at: Counter(at),
            },
        )? {
            return Ok(());
        }
        self.endpoints.get_mut(&member).unwrap().committed = true;
        Ok(())
    }

    fn endpoint_output_ready(&self, member: Uuid, endpoint: &Endpoint, now: u64) -> bool {
        endpoint.ready && self.endpoint_clock_ready(member, endpoint, now)
    }
    fn endpoint_clock_ready(&self, member: Uuid, endpoint: &Endpoint, now: u64) -> bool {
        endpoint.audio
            && if member == OWNER {
                self.local.as_ref().is_some_and(|r| r.status().output_ready)
            } else {
                endpoint
                    .last_output
                    .is_some_and(|at| now.saturating_sub(at) <= 5_000_000_000)
                    && self
                        .server
                        .transport
                        .authorize(member, endpoint.identity)
                        .is_ok_and(|p| p.listen)
            }
    }
    async fn materialize(&mut self) -> RoomResult<()> {
        let Some(candidate) = self.candidate.as_ref() else {
            return Ok(());
        };
        if candidate.materialized || candidate.loading {
            return Ok(());
        }
        let epoch = candidate.wire.epoch.0;
        let target = candidate.target;
        if !target.playing {
            return self.install_source(epoch, None);
        }
        let track = match self.track_for(target.track.0).await {
            Ok(track) => track,
            Err(e) => {
                let c = self.candidate.take().unwrap();
                self.scheduler
                    .fail_preparing(c.scheduler_plan, timeline::PlanFailure::DecodeFailed);
                self.error = Some(e.message);
                return Ok(());
            }
        };
        self.remember_presentation(target.track.0, &track).await?;
        let library_revision = self.library.revision().await;
        let state = self.state.clone();
        let library = self.library.clone();
        let loudness_mode = self.loudness_mode.clone();
        self.candidate.as_mut().unwrap().loading = true;
        let task = self.jobs.spawn(async move {
            let result = host_jobs::bounded(host_jobs::source(
                state,
                library,
                track,
                target.track.0,
                target.position_ms,
                loudness_mode.clone(),
            ))
            .await;
            Completion::Source {
                epoch,
                instance: target.track.0,
                position_ms: target.position_ms,
                loudness_mode,
                library_revision,
                result,
            }
        });
        if let Some(old) = self.source_jobs.insert((0, epoch), task) {
            old.abort();
        }
        Ok(())
    }
    fn install_source(&mut self, epoch: u64, source: Option<Source>) -> RoomResult<()> {
        if self
            .candidate
            .as_ref()
            .is_none_or(|c| c.wire.epoch.0 != epoch)
        {
            return Ok(());
        }
        let token = self.wire_id()?;
        let now = self.clock.now_ns();
        let position = self.position(now.saturating_add(LEAD_NS));
        let c = self.candidate.as_mut().unwrap();
        if c.preserve_position && position.0 == c.target.track.0 {
            c.target.position_ms = position.1;
        }
        c.wire.anchor_ns = Counter(now.checked_add(LEAD_NS).ok_or_else(RoomError::exhausted)?);
        c.wire.plan_id = Counter(token);
        c.materialized = true;
        c.loading = false;
        self.scheduler
            .retarget_preparing(c.scheduler_plan, c.target);
        let plan = c.wire.clone();
        let playing = c.target.playing;
        self.producer
            .prepare(plan, source, self.dsp, self.volume)
            .map_err(transport_error)?;
        if playing {
            if self.local.is_some() {
                self.join(OWNER)?;
            }
            let members = self
                .endpoints
                .keys()
                .copied()
                .filter(|m| *m != OWNER)
                .collect::<Vec<_>>();
            for member in members {
                let _ = self.join(member);
            }
        }
        Ok(())
    }
    async fn render(&mut self, event: ProducerEvent) -> RoomResult<()> {
        match event {
            ProducerEvent::SuccessorPrepared { epoch, instance } => {
                if let Some(pending) = self.pending_successors.get_mut(&epoch) {
                    pending.pop_front();
                    if pending.is_empty() {
                        self.pending_successors.remove(&epoch);
                    }
                }
                if self.epoch_plan(epoch).is_none() {
                    return Ok(());
                }
                if let Some(instance) = instance {
                    self.prepared_successors.insert(epoch, instance);
                } else {
                    self.prepared_successors.remove(&epoch);
                }
            }
            ProducerEvent::MixApplied { change, at } => self.mixer.acknowledge(change, at),
            ProducerEvent::Suspended {
                epoch,
                instance,
                position_frames,
            } => {
                if let Some(scheduled) = self
                    .scheduled
                    .as_mut()
                    .filter(|s| s.plan.epoch.0 == epoch && s.preserve_position)
                {
                    scheduled.target.track = TrackInstanceId(instance);
                    scheduled.target.position_ms =
                        position_frames * 1000 / u64::from(self.format.sample_rate);
                    scheduled.position_frames = position_frames;
                }
            }
            ProducerEvent::Prepared { epoch } => {
                let target = self
                    .candidate
                    .as_mut()
                    .filter(|c| c.wire.epoch.0 == epoch)
                    .map(|c| {
                        c.prepared = true;
                        c.target
                    });
                if let Some(target) = target.filter(|t| t.playing) {
                    self.render_heads.insert(epoch, target.track.0);
                    self.prepare_successor_for(epoch, target.track.0).await?;
                }
            }
            ProducerEvent::Pcm {
                epoch,
                sequence,
                frame,
                format,
                samples,
            } => {
                if self.epoch_plan(epoch).is_none() {
                    return Ok(());
                }
                let end = frame
                    .checked_add((samples.len() / usize::from(format.channels)) as u64)
                    .ok_or_else(RoomError::exhausted)?;
                self.rendered_until.insert(epoch, end);
                self.server
                    .transport
                    .broadcast_pcm(epoch, sequence, frame, format, samples.clone())
                    .map_err(transport_error)?;
                if let Some(local) = &self.local {
                    let _ = local.pcm(PcmBlock {
                        identity: self.local_identity,
                        epoch,
                        sequence,
                        frame_index: frame,
                        format_id: format.id,
                        channels: format.channels,
                        samples,
                    });
                }
            }
            ProducerEvent::Boundary {
                epoch,
                frame,
                instance,
                position_frames,
            } => {
                self.prepared_successors.remove(&epoch);
                if let Some(plan) = self.epoch_plan(epoch) {
                    let at = Self::time(&plan, frame)?;
                    self.boundaries.push(Boundary {
                        at,
                        epoch,
                        instance,
                        position_frames,
                        ended: false,
                    })?;
                    self.render_heads.insert(epoch, instance);
                    self.prepare_successor_for(epoch, instance).await?;
                    if !self.instances.contains(&instance)
                        && self.candidate.is_none()
                        && self.scheduled.is_none()
                    {
                        self.internal(Playback::Pause).await?;
                    }
                }
            }
            ProducerEvent::End {
                epoch,
                frame,
                instance,
            } => {
                if let Some(plan) = self.epoch_plan(epoch) {
                    let at = Self::time(&plan, frame)?;
                    self.boundaries.push(Boundary {
                        at,
                        epoch,
                        instance,
                        position_frames: 0,
                        ended: true,
                    })?;
                }
            }
            ProducerEvent::Error {
                epoch,
                stage,
                message,
            } => {
                self.error = Some(message.clone());
                if matches!(stage, FailureStage::Successor) {
                    self.send_successor(epoch, None, 0)?;
                    return Ok(());
                }
                if let Some(change) = self.mixer.pending.as_ref().map(|p| p.id) {
                    self.mixer.fail(change, message.clone());
                }
                if self
                    .candidate
                    .as_ref()
                    .is_some_and(|c| c.wire.epoch.0 == epoch)
                {
                    let c = self.candidate.take().unwrap();
                    self.scheduler
                        .fail_preparing(c.scheduler_plan, timeline::PlanFailure::DecodeFailed);
                    self.producer.cancel(epoch).map_err(transport_error)?;
                } else if self
                    .scheduled
                    .as_ref()
                    .is_some_and(|a| a.plan.epoch.0 == epoch)
                {
                    return Err(RoomError::new("room_render", message));
                } else if self
                    .audible
                    .as_ref()
                    .is_some_and(|a| a.plan.epoch.0 == epoch)
                {
                    self.halt_presentation(&message)?;
                }
            }
        }
        Ok(())
    }
    /// A dead renderer or an empty output lease cannot acknowledge another
    /// future plan. Install the terminal fact immediately and invalidate audio.
    fn halt_presentation(&mut self, reason: &str) -> RoomResult<()> {
        self.broadcast(&ControlFrame::Resync {
            reason: "presentation_halted".into(),
        });
        if let Some(c) = self.candidate.take() {
            self.scheduler
                .fail_preparing(c.scheduler_plan, timeline::PlanFailure::OutputNotReady);
            self.producer
                .cancel(c.wire.epoch.0)
                .map_err(transport_error)?;
        }
        let now = self.clock.now_ns();
        if let Some(a) = &mut self.audible {
            let (instance, frames, _) = self.boundaries.projected(
                a.plan.epoch.0,
                now,
                a.target.track.0,
                a.position_frames,
                a.position_at_ns,
                self.format.sample_rate,
            );
            a.target = PlanTarget {
                track: TrackInstanceId(instance),
                position_ms: frames * 1000 / u64::from(self.format.sample_rate),
                playing: false,
            };
            a.position_at_ns = now;
            a.position_frames = frames;
            self.scheduler.observe_transition(a.target);
            self.producer
                .halt(a.plan.epoch.0)
                .map_err(transport_error)?;
        }
        self.boundaries
            .retain_epochs(&[self.scheduled.as_ref().map(|a| a.plan.epoch.0)]);
        self.scheduler
            .control_changed()
            .ok_or_else(RoomError::exhausted)?;
        self.error = Some(reason.into());
        Ok(())
    }
    fn epoch_plan(&self, epoch: u64) -> Option<Plan> {
        self.candidate
            .as_ref()
            .map(|c| &c.wire)
            .into_iter()
            .chain(self.scheduled.as_ref().map(|p| &p.plan))
            .chain(self.audible.as_ref().map(|p| &p.plan))
            .find(|p| p.epoch.0 == epoch)
            .cloned()
    }
    async fn track_for(&self, instance: u64) -> RoomResult<String> {
        let index = self.instances.iter().position(|id| *id == instance);
        let Some(index) = index else {
            return self
                .presentation_catalog
                .get(instance)
                .map(|track| track.track_id.clone())
                .ok_or_else(RoomError::denied);
        };
        self.state
            .queue
            .lock()
            .await
            .get(index)
            .cloned()
            .ok_or_else(RoomError::denied)
    }
    async fn prepare_successor(&mut self) -> RoomResult<()> {
        let heads = self
            .render_heads
            .iter()
            .map(|(e, i)| (*e, *i))
            .collect::<Vec<_>>();
        for (epoch, current) in heads {
            if self.epoch_plan(epoch).is_some() {
                self.prepare_successor_for(epoch, current).await?;
            } else {
                self.render_heads.remove(&epoch);
            }
        }
        Ok(())
    }
    async fn prepare_successor_for(&mut self, epoch: u64, current: u64) -> RoomResult<()> {
        let Some(index) = self.instances.iter().position(|id| *id == current) else {
            self.successor_targets.remove(&epoch);
            if let Some(task) = self.source_jobs.remove(&(1, epoch)) {
                task.abort();
            }
            self.successor_tokens.remove(&epoch);
            return self.send_successor(epoch, None, 0);
        };
        let next = match self.mode {
            PlayMode::RepeatOne => index,
            PlayMode::Shuffle => random_next(self.instances.len(), index),
            _ => (index + 1) % self.instances.len(),
        };
        let mut selected = None;
        for offset in 0..self.instances.len() {
            let index = (next + offset) % self.instances.len();
            let instance = self.instances[index];
            let track = self.track_for(instance).await?;
            if self.library.resource_for(&track).await.is_some() {
                selected = Some((instance, track));
                break;
            }
        }
        let Some((instance, track)) = selected else {
            if let Some(task) = self.source_jobs.remove(&(1, epoch)) {
                task.abort();
            }
            self.successor_tokens.remove(&epoch);
            self.successor_targets.remove(&epoch);
            return self.send_successor(epoch, None, 0);
        };
        let desired = SuccessorTarget {
            current,
            next: instance,
        };
        if self.successor_targets.get(&epoch) == Some(&desired) {
            return Ok(());
        }
        self.remember_presentation(instance, &track).await?;
        self.successor_targets.insert(epoch, desired);
        let state = self.state.clone();
        let library = self.library.clone();
        let mode = self.loudness_mode.clone();
        let library_revision = library.revision().await;
        let token = self.next_job;
        self.next_job = token.checked_add(1).ok_or_else(RoomError::exhausted)?;
        self.successor_tokens.insert(epoch, token);
        let task = self.jobs.spawn(async move {
            let result =
                host_jobs::bounded(host_jobs::source(state, library, track, instance, 0, mode))
                    .await;
            Completion::Successor {
                epoch,
                current,
                token,
                library_revision,
                result,
            }
        });
        if let Some(old) = self.source_jobs.insert((1, epoch), task) {
            old.abort();
        }
        Ok(())
    }
    async fn internal(&mut self, command: Playback) -> RoomResult<Value> {
        let operation_id = self.next_internal_op;
        self.next_internal_op = operation_id
            .checked_add(1)
            .ok_or_else(RoomError::exhausted)?;
        self.playback(
            Uuid::from_u128(1),
            None,
            operation_id,
            self.scheduler.revision().0,
            command,
        )
        .await
    }
    async fn playback(
        &mut self,
        member: Uuid,
        session: Option<StreamIdentity>,
        seq: u64,
        expected: u64,
        command: Playback,
    ) -> RoomResult<Value> {
        if self.mixer.pending.is_some() && !matches!(command, Playback::Pause | Playback::Stop) {
            return Err(RoomError::new("room_busy", "请等待混音设置生效后控制播放"));
        }
        let preserve_position = matches!(command, Playback::Pause)
            && self.candidate.as_ref().is_none_or(|c| c.preserve_position);
        let now = self.clock.now_ns();
        let effective = now.checked_add(LEAD_NS).ok_or_else(RoomError::exhausted)?;
        let (current, position, playing) = self.position(effective);
        self.scheduler
            .observe_position(TrackInstanceId(current), position);
        let base = self.scheduler.pending_target();
        let member_index = if member == OWNER {
            0
        } else if member == Uuid::from_u128(1) {
            u32::MAX
        } else {
            self.endpoints
                .get(&member)
                .map(|e| e.index)
                .ok_or_else(RoomError::denied)?
        };
        let content = match command {
            Playback::Play => {
                if base.track.0 == 0 || !self.instances.contains(&base.track.0) {
                    let instance = self
                        .instances
                        .first()
                        .copied()
                        .ok_or_else(|| RoomError::invalid("请先分享本地歌曲并加入队列"))?;
                    timeline::Command::Next {
                        to: TrackInstanceId(instance),
                    }
                } else {
                    timeline::Command::Play
                }
            }
            Playback::Pause => timeline::Command::Pause,
            Playback::Stop => timeline::Command::Stop,
            Playback::Seek {
                instance_id,
                position_ms,
            } => {
                if instance_id.0 != base.track.0 {
                    return Err(RoomError::new(
                        "stale_track_instance",
                        "歌曲已经切换，请刷新后重试",
                    ));
                }
                timeline::Command::Seek {
                    track: TrackInstanceId(instance_id.0),
                    position_ms: position_ms.0,
                }
            }
            Playback::Pick { instance_id } => {
                if !self.instances.contains(&instance_id.0) {
                    return Err(RoomError::denied());
                }
                timeline::Command::Next {
                    to: TrackInstanceId(instance_id.0),
                }
            }
            Playback::Next | Playback::Previous => {
                if self.instances.is_empty() {
                    return Err(RoomError::invalid("共享队列为空"));
                }
                let index = self
                    .instances
                    .iter()
                    .position(|id| *id == base.track.0)
                    .unwrap_or(0);
                let next = match command {
                    Playback::Previous => (index + self.instances.len() - 1) % self.instances.len(),
                    _ if self.mode == PlayMode::Shuffle => random_next(self.instances.len(), index),
                    _ => (index + 1) % self.instances.len(),
                };
                timeline::Command::Next {
                    to: TrackInstanceId(self.instances[next]),
                }
            }
        };
        self.check_access(member, session, |p| p.transport)?;
        let key = OperationKey {
            member: MemberId(member_index),
            namespace: 1,
            seq,
        };
        let outcome = self
            .scheduler
            .submit(now, key, Some(Revision(expected)), content)
            .map_err(|e| RoomError::new(e.code(), "房间控制状态已更新，请刷新后重试"))?;
        if matches!(outcome, timeline::Outcome::Preparing { .. }) {
            if let Some(old) = self.candidate.take() {
                self.producer
                    .cancel(old.wire.epoch.0)
                    .map_err(transport_error)?;
                if let Some(task) = self.source_jobs.remove(&(0, old.wire.epoch.0)) {
                    task.abort();
                }
            }
            let plan = self.scheduler.preparing().ok_or_else(RoomError::inactive)?;
            let target = plan.target;
            let wire = Plan {
                epoch: Counter(plan.epoch.0),
                plan_id: Counter(self.wire_id()?),
                anchor_ns: Counter(effective),
                join_frame: Counter(0),
                format: self.format,
            };
            self.candidate = Some(Candidate {
                wire,
                scheduler_plan: plan.id,
                target,
                prepared: false,
                ready: false,
                materialized: false,
                loading: false,
                preserve_position,
                creator: member,
                session,
            });
            if self.scheduled.is_none() {
                self.materialize().await?;
            }
        }
        let _ = (position, playing);
        self.publish().await;
        Ok(
            json!({"state":outcome_json(outcome),"revision":self.scheduler.revision().0.to_string()}),
        )
    }
    async fn record_presentation(&mut self, instance: u64, history: bool) {
        if let Some(index) = self.instances.iter().position(|id| *id == instance) {
            *self.state.cursor.lock().await = Some(index);
        }
        if history {
            self.collaboration
                .event("playback", self.requester(OWNER), Some(instance), wall_ms());
            if let Ok(track) = self.track_for(instance).await {
                if self.history.record(track).is_err() {
                    self.error = Some("播放历史队列已满，部分记录可能未保存".into());
                }
            }
        }
    }
    async fn try_commit(&mut self) -> RoomResult<()> {
        if self.scheduled.is_some() {
            return Ok(());
        };
        // Pause resumes from the actual rendered boundary, including natural
        // transitions that arrived after command acceptance. Wait until the old
        // producer has frozen every sample up to the suspension point.
        if let Some(c) = self.candidate.as_ref().filter(|c| c.preserve_position) {
            if let Some(a) = &self.audible {
                let end = self
                    .rendered_until
                    .get(&a.plan.epoch.0)
                    .copied()
                    .unwrap_or(0);
                let fade_start = c
                    .wire
                    .anchor_ns
                    .0
                    .saturating_sub(super::producer::FADE_OUT_NS);
                let needed = (u128::from(fade_start.saturating_sub(a.plan.anchor_ns.0))
                    * u128::from(self.format.sample_rate)
                    / 1_000_000_000) as u64;
                if a.target.playing && end < needed {
                    return Ok(());
                }
                let (instance, frames, _) = if a.target.playing {
                    self.boundaries.projected(
                        a.plan.epoch.0,
                        c.wire.anchor_ns.0,
                        a.target.track.0,
                        a.position_frames,
                        a.position_at_ns,
                        self.format.sample_rate,
                    )
                } else {
                    (a.target.track.0, a.position_frames, false)
                };
                let c = self.candidate.as_mut().unwrap();
                c.target.track = TrackInstanceId(instance);
                c.target.position_ms = frames * 1000 / u64::from(self.format.sample_rate);
                self.scheduler
                    .retarget_preparing(c.scheduler_plan, c.target);
            }
        }
        let Some(candidate) = self.candidate.as_ref() else {
            return Ok(());
        };
        if self
            .check_access(candidate.creator, candidate.session, |p| p.transport)
            .is_err()
        {
            let c = self.candidate.take().unwrap();
            self.scheduler
                .fail_preparing(c.scheduler_plan, timeline::PlanFailure::OutputNotReady);
            self.producer
                .cancel(c.wire.epoch.0)
                .map_err(transport_error)?;
            return Ok(());
        }
        let now = self.clock.now_ns();
        let at = candidate.wire.anchor_ns.0;
        if candidate.target.playing
            && !self.endpoints.iter().any(|(member, e)| {
                self.endpoint_output_ready(*member, e, now)
                    && e.plan
                        .as_ref()
                        .is_some_and(|p| p.epoch == candidate.wire.epoch)
            })
        {
            return Ok(());
        }
        if at < now.saturating_add(MIN_COMMIT_NS) {
            return Ok(());
        }
        let wire = candidate.wire.clone();
        let target = candidate.target;
        let preserve_position = candidate.preserve_position;
        self.scheduler
            .commit(now, at, MIN_COMMIT_NS)
            .map_err(|e| RoomError::new(e.code(), "房间计划不能提交"))?;
        self.producer
            .commit(wire.epoch.0)
            .map_err(transport_error)?;
        if target.playing {
            let members = self
                .endpoints
                .iter()
                .filter_map(|(id, e)| {
                    (e.ready && e.plan.as_ref().is_some_and(|p| p.epoch == wire.epoch))
                        .then_some(*id)
                })
                .collect::<Vec<_>>();
            for member in members {
                let p = self.endpoints[&member].plan.as_ref().unwrap();
                let _ = self.join_commit(member, p.epoch.0, p.plan_id.0);
            }
        } else {
            let token = self.wire_id()?;
            self.broadcast(&ControlFrame::Suspend {
                epoch: wire.epoch,
                plan_id: Counter(token),
                effective_at: Counter(at),
            });
        }
        self.scheduled = Some(Audible {
            plan: wire,
            target,
            position_frames: target.position_ms * u64::from(self.format.sample_rate) / 1000,
            position_at_ns: at,
            preserve_position,
        });
        self.candidate = None;
        self.error = None;
        Ok(())
    }
    fn check_access(
        &self,
        member: Uuid,
        identity: Option<StreamIdentity>,
        permission: impl FnOnce(Permissions) -> bool,
    ) -> RoomResult<()> {
        if member == OWNER || member == Uuid::from_u128(1) {
            return Ok(());
        }
        let identity = identity.ok_or_else(RoomError::denied)?;
        let permissions = self
            .server
            .transport
            .authorize(member, identity)
            .map_err(|_| RoomError::denied())?;
        if !permission(permissions) {
            return Err(RoomError::denied());
        }
        Ok(())
    }
    fn cancel_member_candidate(&mut self, member: Uuid) -> RoomResult<()> {
        if self.candidate.as_ref().is_some_and(|c| c.creator == member) {
            let c = self.candidate.take().unwrap();
            self.scheduler
                .fail_preparing(c.scheduler_plan, timeline::PlanFailure::OutputNotReady);
            if let Some(task) = self.source_jobs.remove(&(0, c.wire.epoch.0)) {
                task.abort();
            }
            self.producer
                .cancel(c.wire.epoch.0)
                .map_err(transport_error)?;
        }
        Ok(())
    }
    fn chat_access(
        &self,
        member: Uuid,
        identity: Option<StreamIdentity>,
    ) -> super::chat::ChatAccess {
        if member == OWNER {
            return super::chat::ChatAccess {
                member,
                name: "房主".into(),
                active: Arc::new(|| true),
                read: Arc::new(|| true),
                send: Arc::new(|| true),
            };
        }
        let name = self
            .server
            .transport
            .members()
            .into_iter()
            .find(|m| m.id == member)
            .map(|m| m.name)
            .unwrap_or_default();
        let read = self.server.transport.clone();
        let send = read.clone();
        let membership = read.clone();
        super::chat::ChatAccess {
            member,
            name,
            active: Arc::new(move || membership.members().iter().any(|m| m.id == member)),
            read: Arc::new(move || {
                identity.is_some_and(|id| read.authorize(member, id).is_ok_and(|p| p.chat_read))
            }),
            send: Arc::new(move || {
                identity.is_some_and(|id| send.authorize(member, id).is_ok_and(|p| p.chat_send))
            }),
        }
    }
    fn chat_job(
        &self,
        member: Uuid,
        identity: Option<StreamIdentity>,
        request: PeerRequest,
    ) -> Option<ChatJob> {
        use super::chat::ChatRequest;
        let request = match request {
            PeerRequest::ChatSong {
                operation_id,
                resource_id,
            } => ChatRequest::Song {
                operation: operation_id.0,
                resource_id,
            },
            PeerRequest::ChatSend { operation_id, text } => ChatRequest::Send {
                operation: operation_id.0,
                text,
                track: self.audible.as_ref().map(|a| a.target.track.0),
            },
            PeerRequest::ChatHistory { before, revision } => ChatRequest::History {
                before: before.map(|v| v.0),
                revision: revision.map(|v| v.0),
            },
            PeerRequest::ChatOperation { operation_id } => ChatRequest::Operation {
                operation: operation_id.0,
            },
            _ => return None,
        };
        let chat = self.chat.clone();
        let access = self.chat_access(member, identity);
        let error = self.chat_error.clone();
        Some(Box::pin(async move {
            match chat {
                Some(chat) => chat.request(access, request).await,
                None => Err(RoomError::new(
                    "chat_storage_failed",
                    error.unwrap_or_else(|| "聊天存储不可用".into()),
                )),
            }
        }))
    }
    fn chat_admin(&self, command: super::chat::ChatAdmin) -> ChatJob {
        let chat = self.chat.clone();
        let access = self.chat_access(OWNER, None);
        Box::pin(async move {
            let chat =
                chat.ok_or_else(|| RoomError::new("chat_storage_failed", "聊天存储不可用"))?;
            chat.request(access, super::chat::ChatRequest::Admin(command))
                .await
        })
    }
    fn record_result(&mut self, member: Uuid, seq: u64) -> RoomResult<Value> {
        let record = self
            .records
            .iter()
            .find(|r| r.member == member && r.seq == seq)
            .ok_or_else(|| RoomError::new("operation_unknown", "操作结果已过期"))?;
        if let Some(key) = record.key {
            let outcome = self
                .scheduler
                .poll(self.clock.now_ns(), key)
                .map_err(|_| RoomError::new("operation_unknown", "操作结果已过期"))?;
            return Ok(
                json!({"state":outcome_json(outcome),"revision":self.scheduler.revision().0.to_string()}),
            );
        }
        if let Some(id) = record.result["state"]["change_id"]
            .as_str()
            .and_then(|id| id.parse().ok())
        {
            if let Some(state) = self.mixer.outcome(id) {
                return Ok(
                    json!({"state":state,"revision":self.scheduler.revision().0.to_string()}),
                );
            }
            return Err(RoomError::new("operation_unknown", "混音操作结果已过期"));
        }
        Ok(record.result.clone())
    }
    async fn peer(
        &mut self,
        member: Uuid,
        session: Option<StreamIdentity>,
        permissions: Permissions,
        request: PeerRequest,
        resolved_queue: Option<Vec<String>>,
    ) -> RoomResult<Value> {
        match request {
            PeerRequest::Snapshot => {
                let mut snapshot = self.peer_snapshot_for(permissions, member).await;
                snapshot["next_operation_id"] = json!(self
                    .high_water
                    .get(&member)
                    .copied()
                    .unwrap_or(0)
                    .saturating_add(1)
                    .to_string());
                return Ok(snapshot);
            }
            PeerRequest::Invite => {
                self.check_access(member, session, |p| p.invite)?;
                let issued = if member == OWNER {
                    self.server
                        .transport
                        .issue_invitation(Permissions::default())
                } else {
                    self.server
                        .transport
                        .member_invite(member, session.ok_or_else(RoomError::denied)?)
                }
                .map_err(transport_error)?;
                let invitation = vmusic_lan::invitation::Invitation {
                    address: self.server.address,
                    room_id: self.local_identity.room_id,
                    fingerprint: self.server.fingerprint,
                    secret: issued.secret,
                }
                .encode();
                return Ok(
                    json!({"invitation":invitation.as_str(),"invitation_id":issued.id,"expires_in_seconds":300,"fingerprint":self.server.fingerprint.hex()}),
                );
            }
            PeerRequest::RevokeInvitation { invitation_id } => {
                self.check_access(member, session, |p| p.invite)?;
                let issuer = if member == OWNER {
                    None
                } else {
                    Some((member, session.ok_or_else(RoomError::denied)?))
                };
                self.server
                    .transport
                    .revoke_invitation(invitation_id, issuer)
                    .map_err(|_| RoomError::denied())?;
                self.publish().await;
                return Ok(json!({"state":"applied"}));
            }
            PeerRequest::ResolveFavorites { keys } => {
                self.check_access(member, session, |p| p.queue)?;
                let tracks = self.library.resolve_favorites(&keys).await?;
                return Ok(
                    json!({"tracks":tracks,"revision":self.library.revision().await.to_string()}),
                );
            }
            PeerRequest::Library {
                offset,
                limit,
                revision,
            } => {
                let current_revision = self.library.revision().await;
                if revision.is_some_and(|revision| revision.0 != current_revision) {
                    return Err(RoomError::new(
                        "revision_conflict",
                        "分享列表已更新，请重新读取",
                    ));
                }
                let views = self.library.views().await;
                return Ok(
                    json!({"total":views.len(),"offset":offset,"revision":current_revision.to_string(),"tracks":views.into_iter().skip(offset).take(limit.clamp(1,64)).collect::<Vec<_>>()}),
                );
            }
            PeerRequest::QueuePage {
                offset,
                limit,
                revision,
            } => {
                let current_revision = self.scheduler.revision().0;
                if revision.is_some_and(|revision| revision.0 != current_revision) {
                    return Err(RoomError::new(
                        "revision_conflict",
                        "队列已更新，请重新读取",
                    ));
                }
                let tracks = self.state.queue.lock().await.clone();
                let mut queue = Vec::new();
                let mut metadata = Vec::new();
                let frozen = self.frozen_prefix();
                for (index, track) in tracks
                    .iter()
                    .enumerate()
                    .skip(offset)
                    .take(limit.clamp(1, 32))
                {
                    if let (Some(instance), Some(resource)) = (
                        self.instances.get(index),
                        self.library.resource_for(track).await,
                    ) {
                        queue.push(self.queue_item(*instance, resource, member, index >= frozen));
                        if let Some(view) = self.library.view(resource).await {
                            metadata.push(view);
                        }
                    }
                }
                return Ok(
                    json!({"total":tracks.len(),"offset":offset,"revision":current_revision.to_string(),"queue":queue,"tracks":metadata}),
                );
            }
            PeerRequest::Operation { operation_id } => {
                if self
                    .records
                    .iter()
                    .any(|r| r.member == member && r.seq == operation_id.0)
                {
                    return self.record_result(member, operation_id.0);
                }
                return Err(RoomError::new(
                    "operation_unknown",
                    "操作结果已过期或不存在",
                ));
            }
            PeerRequest::Resource {
                resource_id,
                kind,
                offset,
                revision,
            } => {
                if !permissions.listen && !permissions.queue && !permissions.transport {
                    return Err(RoomError::denied());
                }
                let resource = self
                    .library
                    .read(&self.state, resource_id, kind, offset, revision)
                    .await?;
                self.check_access(member, session, |p| p.listen || p.queue || p.transport)?;
                return serde_json::to_value(resource).map_err(|_| RoomError::storage());
            }
            PeerRequest::ChatSong { .. }
            | PeerRequest::ChatSend { .. }
            | PeerRequest::ChatHistory { .. }
            | PeerRequest::ChatOperation { .. } => {
                return Err(RoomError::new(
                    "room_chat_unavailable",
                    "聊天存储尚未初始化",
                ))
            }
            _ => {}
        }
        match &request {
            PeerRequest::Vote { .. } => self.check_access(member, session, |p| p.queue)?,
            PeerRequest::QueueOrder { .. } if member != OWNER => return Err(RoomError::denied()),
            _ => {}
        }
        let seq = match &request {
            PeerRequest::Playback { operation_id, .. }
            | PeerRequest::Queue { operation_id, .. }
            | PeerRequest::Mode { operation_id, .. }
            | PeerRequest::Volume { operation_id, .. }
            | PeerRequest::Vote { operation_id, .. }
            | PeerRequest::QueueOrder { operation_id, .. } => operation_id.0,
            _ => unreachable!(),
        };
        let body =
            serde_json::to_value(&request).map_err(|_| RoomError::invalid("操作格式无效"))?;
        self.records
            .retain(|r| self.clock.now_ns().saturating_sub(r.at) < 600_000_000_000);
        if let Some(record) = self
            .records
            .iter()
            .find(|r| r.member == member && r.seq == seq)
        {
            if record.body != body {
                return Err(RoomError::new(
                    "operation_key_conflict",
                    "同一操作序号携带了不同内容",
                ));
            }
            return self.record_result(member, seq);
        }
        if seq <= self.high_water.get(&member).copied().unwrap_or(0) {
            return Err(RoomError::new(
                "operation_unknown",
                "操作序号过期，请先查询状态",
            ));
        }
        let expected = match &request {
            PeerRequest::Playback {
                expected_revision, ..
            }
            | PeerRequest::Queue {
                expected_revision, ..
            }
            | PeerRequest::Mode {
                expected_revision, ..
            }
            | PeerRequest::Volume {
                expected_revision, ..
            }
            | PeerRequest::Vote {
                expected_revision, ..
            }
            | PeerRequest::QueueOrder {
                expected_revision, ..
            } => expected_revision.0,
            _ => unreachable!(),
        };
        if expected != self.scheduler.revision().0 {
            return Err(RoomError::new(
                "revision_conflict",
                "房间状态已更新，请刷新后重试",
            ));
        }
        if self.scheduler.revision().0 == u64::MAX {
            return Err(RoomError::exhausted());
        }
        let result = match request {
            PeerRequest::Vote {
                instance_id, voted, ..
            } => {
                self.check_access(member, session, |p| p.queue)?;
                if !permissions.queue {
                    return Err(RoomError::denied());
                }
                if self.candidate.is_some() || self.scheduled.is_some() || self.mutation_preparing {
                    return Err(RoomError::new("room_busy", "请等待当前切换或队列准备完成"));
                }
                let index = self
                    .instances
                    .iter()
                    .position(|id| *id == instance_id.0)
                    .ok_or_else(|| RoomError::invalid("队列实例已失效"))?;
                if index < self.frozen_prefix() {
                    return Err(RoomError::invalid("当前或已冻结的歌曲不能投票"));
                }
                let changed = self
                    .apply_social(member, session, Some((instance_id.0, voted)), None)
                    .await?;
                if changed {
                    self.scheduler
                        .control_changed()
                        .ok_or_else(RoomError::exhausted)?;
                    self.collaboration.event(
                        if voted { "vote" } else { "unvote" },
                        self.requester(member),
                        Some(instance_id.0),
                        wall_ms(),
                    );
                }
                json!({"state":"applied","revision":self.scheduler.revision().0.to_string()})
            }
            PeerRequest::QueueOrder { mode, .. } => {
                if member != OWNER {
                    return Err(RoomError::denied());
                }
                if self.candidate.is_some() || self.scheduled.is_some() || self.mutation_preparing {
                    return Err(RoomError::new("room_busy", "请等待当前切换或队列准备完成"));
                }
                self.apply_social(member, session, None, Some(mode)).await?;
                self.scheduler
                    .control_changed()
                    .ok_or_else(RoomError::exhausted)?;
                json!({"state":"applied","revision":self.scheduler.revision().0.to_string()})
            }
            PeerRequest::Playback { command, .. } => {
                if !permissions.transport {
                    return Err(RoomError::denied());
                }
                self.playback(member, session, seq, expected, command)
                    .await?
            }
            PeerRequest::Queue { items, .. } => {
                if !permissions.queue {
                    return Err(RoomError::denied());
                }
                if self.candidate.is_some()
                    || self.scheduled.is_some()
                    || self.mixer.pending.is_some()
                {
                    return Err(RoomError::new("room_busy", "请等待当前切换生效后编辑队列"));
                }
                if items.len() > 2000 {
                    return Err(RoomError::invalid("队列最多2000项"));
                }
                let old_tracks = self.state.queue.lock().await.clone();
                let tracks = resolved_queue.ok_or_else(|| {
                    RoomError::new("room_preparation_required", "队列尚未完成资源检查")
                })?;
                if tracks.len() != items.len() {
                    return Err(RoomError::invalid("队列资源检查结果不完整"));
                }
                let mut instances = Vec::with_capacity(items.len());
                let mut retained = HashSet::with_capacity(items.len());
                let mut next_instance = self.next_instance;
                for (item, track) in items.iter().zip(&tracks) {
                    let instance = if let Some(instance) = item.instance_id {
                        let index = self
                            .instances
                            .iter()
                            .position(|id| *id == instance.0)
                            .ok_or_else(|| RoomError::invalid("队列实例已失效或不属于此房间"))?;
                        if !retained.insert(instance.0) || old_tracks.get(index) != Some(track) {
                            return Err(RoomError::invalid("队列实例重复或与资源不匹配"));
                        }
                        instance.0
                    } else {
                        let instance = next_instance;
                        next_instance = next_instance
                            .checked_add(1)
                            .ok_or_else(RoomError::exhausted)?;
                        instance
                    };
                    instances.push(instance);
                }
                // The queue only exists here, in AppState. Instance IDs are
                // parallel identity metadata, not a second playback queue.
                self.check_access(member, session, |p| p.queue)?;
                let current = self.position(self.clock.now_ns());
                let removes_rendered = self
                    .render_heads
                    .values()
                    .chain(self.boundaries.instances().iter())
                    .any(|instance| !instances.contains(instance));
                if current.2 && (!instances.contains(&current.0) || removes_rendered) {
                    let _ = self.internal(Playback::Pause).await?;
                }
                let _commit = self.state.play_commit.lock().await;
                self.check_access(member, session, |p| p.queue)?;
                if self.scheduler.revision().0 == u64::MAX {
                    return Err(RoomError::exhausted());
                }
                *self.state.queue.lock().await = tracks;
                *self.state.cursor.lock().await = instances.iter().position(|id| *id == current.0);
                self.collaboration
                    .reconcile(&instances, self.requester(member), wall_ms());
                self.instances = instances;
                self.next_instance = next_instance;
                self.scheduler
                    .control_changed()
                    .ok_or_else(RoomError::exhausted)?;
                if self.collaboration.order == QueueOrder::Votes {
                    let order = self
                        .collaboration
                        .sorted_suffix(&self.instances, self.frozen_prefix());
                    let mut queue = self.state.queue.lock().await;
                    let old = queue.clone();
                    let old_instances = self.instances.clone();
                    *queue = order.iter().map(|&i| old[i].clone()).collect();
                    self.instances = order.iter().map(|&i| old_instances[i]).collect();
                    *self.state.cursor.lock().await =
                        self.instances.iter().position(|id| *id == current.0);
                }
                drop(_commit);
                if let Err(error) = self.prepare_successor().await {
                    self.error = Some(error.message);
                }
                json!({"state":"applied","revision":self.scheduler.revision().0.to_string()})
            }
            PeerRequest::Mode { mode, .. } => {
                if !permissions.queue {
                    return Err(RoomError::denied());
                }
                if self.mixer.pending.is_some() {
                    return Err(RoomError::new("room_busy", "请等待混音设置生效"));
                }
                self.mode = mode;
                self.scheduler
                    .control_changed()
                    .ok_or_else(RoomError::exhausted)?;
                self.prepare_successor().await?;
                json!({"state":"applied","revision":self.scheduler.revision().0.to_string()})
            }
            PeerRequest::Volume { volume, .. } => {
                if !permissions.volume {
                    return Err(RoomError::denied());
                }
                if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
                    return Err(RoomError::invalid("音量范围为0到1"));
                }
                self.change_mix(
                    member,
                    session,
                    MixSettings {
                        dsp: self.dsp,
                        volume,
                        crossfade_ms: self.crossfade_ms,
                        loudness_mode: self.loudness_mode.clone(),
                    },
                )
                .await?
            }
            _ => unreachable!(),
        };
        let key = if body["action"] == "playback" {
            Some(OperationKey {
                member: MemberId(if member == OWNER {
                    0
                } else {
                    self.endpoints
                        .get(&member)
                        .map(|e| e.index)
                        .ok_or_else(RoomError::denied)?
                }),
                namespace: 1,
                seq,
            })
        } else {
            None
        };
        self.high_water.insert(member, seq);
        self.records.push_back(Recorded {
            member,
            seq,
            body,
            result: result.clone(),
            key,
            at: self.clock.now_ns(),
        });
        while self.records.len() > 256 {
            self.records.pop_front();
        }
        self.publish().await;
        Ok(result)
    }
    async fn local_request(&mut self, request: LocalRequest) -> RoomResult<Value> {
        match request {
            LocalRequest::Discoverable { enabled } => {
                if enabled && self.advertisement.is_none() {
                    self.advertisement = Some(
                        vmusic_lan::discovery::Advertisement::start(
                            &self.name,
                            self.server.address,
                            self.local_identity.room_id,
                            self.server.fingerprint,
                        )
                        .map_err(|_| {
                            RoomError::new("room_discovery", "无法发布房间，请稍后重试")
                        })?,
                    );
                } else if !enabled {
                    self.advertisement.take();
                }
                self.discoverable = enabled;
                self.publish().await;
                Ok(json!({"state":"applied"}))
            }
            LocalRequest::RevokeInvitation { invitation_id } => {
                self.server
                    .transport
                    .revoke_invitation(invitation_id, None)
                    .map_err(|_| RoomError::denied())?;
                self.publish().await;
                Ok(json!({"state":"applied"}))
            }
            LocalRequest::AdmissionReview {
                application_id,
                approve,
                permissions,
            } => {
                self.server
                    .transport
                    .review_admission(application_id, approve, permissions)
                    .map_err(transport_error)?;
                self.publish().await;
                Ok(json!({"state":"applied"}))
            }
            LocalRequest::AdmissionRevoke { application_id } => {
                self.server
                    .transport
                    .review_admission(application_id, false, Permissions::default())
                    .map_err(|_| RoomError::denied())?;
                self.publish().await;
                Ok(json!({"state":"applied"}))
            }
            LocalRequest::SleepTimer { seconds } => {
                self.sleep_timer.set(self.clock.now_ns(), seconds)?;
                self.publish().await;
                Ok(json!({"state":"applied"}))
            }
            LocalRequest::Peer { request } => {
                self.peer(OWNER, None, owner_permissions(), request, None)
                    .await
            }
            LocalRequest::Invite { permissions } => {
                let issued = self
                    .server
                    .transport
                    .issue_invitation(permissions)
                    .map_err(transport_error)?;
                let code = vmusic_lan::invitation::Invitation {
                    address: self.server.address,
                    room_id: self.local_identity.room_id,
                    fingerprint: self.server.fingerprint,
                    secret: issued.secret,
                }
                .encode();
                Ok(
                    json!({"invitation":code.as_str(),"invitation_id":issued.id,"expires_in_seconds":300,"fingerprint":self.server.fingerprint.hex()}),
                )
            }
            LocalRequest::Permissions {
                member_id,
                permissions,
            } => {
                self.server
                    .transport
                    .set_permissions(member_id, permissions)
                    .map_err(transport_error)?;
                self.cancel_member_candidate(member_id)?;
                self.publish().await;
                Ok(json!({"state":"applied"}))
            }
            LocalRequest::Remove { member_id } => {
                let requester = self.requester(member_id);
                if self.scheduler.revision().0 == u64::MAX {
                    return Err(RoomError::exhausted());
                }
                self.server
                    .transport
                    .revoke(member_id)
                    .map_err(transport_error)?;
                self.endpoints.remove(&member_id);
                self.cancel_member_candidate(member_id)?;
                self.high_water.remove(&member_id);
                let members = self
                    .server
                    .transport
                    .members()
                    .into_iter()
                    .map(|m| m.id)
                    .collect::<Vec<_>>();
                self.collaboration.retain_members(&members);
                self.collaboration
                    .event("leave", requester, None, wall_ms());
                self.scheduler
                    .control_changed()
                    .ok_or_else(RoomError::exhausted)?;
                self.apply_social(OWNER, None, None, None).await?;
                self.publish().await;
                Ok(json!({"state":"applied"}))
            }
            LocalRequest::Output { settings, enabled } => {
                validate_output(&settings)?;
                let local = self
                    .local
                    .as_ref()
                    .filter(|_| {
                        enabled
                            && settings.device_id == self.output.device_id
                            && settings.latency_correction_ms == self.output.latency_correction_ms
                    })
                    .ok_or_else(|| {
                        RoomError::new("room_preparation_required", "设备切换需要由房间所有者准备")
                    })?;
                local.set_volume(settings.volume).map_err(transport_error)?;
                self.output = settings;
                self.preferences.save(&self.output);
                self.publish().await;
                Ok(json!({"state":"applied"}))
            }
            LocalRequest::Dsp {
                params,
                crossfade_ms,
                loudness_mode,
            } => {
                if params
                    .eq_gains_db
                    .iter()
                    .any(|v| !v.is_finite() || v.abs() > 12.0)
                    || !params.preamp_db.is_finite()
                    || !(-24.0..=12.0).contains(&params.preamp_db)
                    || crossfade_ms > 8000
                    || !matches!(loudness_mode.as_str(), "off" | "track" | "album")
                {
                    return Err(RoomError::invalid("DSP参数无效"));
                }
                self.change_mix(
                    OWNER,
                    None,
                    MixSettings {
                        dsp: DspParams {
                            track_gain_db: 0.0,
                            ..params
                        },
                        volume: self.volume,
                        crossfade_ms,
                        loudness_mode,
                    },
                )
                .await
            }
            _ => Err(RoomError::denied()),
        }
    }
    async fn peer_snapshot(&self, permissions: Permissions) -> Value {
        self.peer_snapshot_for(permissions, OWNER).await
    }
    async fn peer_snapshot_for(&self, permissions: Permissions, member: Uuid) -> Value {
        let now = self.clock.now_ns();
        let (instance, position, playing) = self.position(now);
        let tracks = self.state.queue.lock().await.clone();
        let mut queue = Vec::new();
        let frozen = self.frozen_prefix();
        for (index, track) in tracks.iter().enumerate().take(64) {
            if let (Some(instance), Some(resource)) = (
                self.instances.get(index),
                self.library.resource_for(track).await,
            ) {
                queue.push(self.queue_item(*instance, resource, member, index >= frozen));
            }
        }
        let current_track =
            if let Some(index) = self.instances.iter().position(|id| *id == instance) {
                if let Some(track) = tracks.get(index) {
                    if let Some(resource) = self.library.resource_for(track).await {
                        self.library.view(resource).await
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
            .or_else(|| {
                self.presentation_catalog
                    .get(instance)
                    .and_then(|track| track.view.clone())
            });
        let mut members = self.server.transport.members().into_iter().map(|m| {
            let endpoint = self.endpoints.get(&m.id);
            json!({"id":m.id,"name":m.name,"permissions":m.permissions,"connected":m.connected,"owner":false,
                "audio":endpoint.is_some_and(|e| e.audio),"ready":endpoint.is_some_and(|e| e.ready),
                "committed":endpoint.is_some_and(|e|e.committed),"last_output_age_ms":endpoint.and_then(|e|e.last_output).map(|at|now.saturating_sub(at)/1_000_000),
                "rtt_ns":null,"acoustic_error_ms":null,"buffer_percent":null})
        }).collect::<Vec<_>>();
        let local = self.local.as_ref().map(|r| r.status());
        members.insert(0, json!({"id":OWNER,"name":"房主","permissions":owner_permissions(),"connected":true,"owner":true,
            "audio":self.local.is_some(),"ready":local.as_ref().is_some_and(|s|s.output_ready),
            "committed":local.as_ref().is_some_and(|s|s.current_epoch.is_some()),"last_output_age_ms":null,
            "rtt_ns":null,"acoustic_error_ms":null,"buffer_percent":null}));
        json!({"collaboration":{"queue_order":self.collaboration.order,"activity":self.collaboration.activity},
            "started_at_ms":self.started_at_ms.to_string(),"elapsed_ms":(now/1_000_000).to_string(),
            "member_capacity":vmusic_lan::members::MAX_MEMBERS+1,"audio_capacity":vmusic_lan::members::MAX_AUDIO_OUTPUTS,
            "online_count":members.iter().filter(|m|m["connected"]==true).count(),"members":members,"current_track":current_track,"mode":"room","room_id":self.local_identity.room_id,"instance_id":self.local_identity.instance_id,"name":self.name,"revision":self.scheduler.revision().0.to_string(),"sharing_revision":self.library.revision().await.to_string(),"host_time_ns":now.to_string(),"playing":playing,"track_instance_id":instance.to_string(),"position_ms":position.to_string(),"queue":queue,"queue_count":tracks.len(),"tracks":self.library.views().await.into_iter().take(16).collect::<Vec<_>>(),"shared_count":self.library.views().await.len(),"format":self.format,"volume":self.volume,"pending_mix":self.mixer.pending.as_ref().and_then(|p|self.mixer.outcome(p.id)),"play_mode":self.mode,"dsp":self.dsp,"crossfade_ms":self.crossfade_ms,"loudness_mode":self.loudness_mode,"permissions":permissions,"pending":self.candidate.as_ref().map(|c|json!({"epoch":c.wire.epoch,"plan_id":c.wire.plan_id,"effective_at":c.wire.anchor_ns,"ready":c.ready,"prepared":c.prepared})),"scheduled":self.scheduled.as_ref().map(|s|json!({"epoch":s.plan.epoch,"plan_id":s.plan.plan_id,"effective_at":s.plan.anchor_ns})),"chat":self.chat.as_ref().map(|c|c.status.borrow().clone()),"chat_error":self.chat_error,"error":self.error})
    }
    async fn publish(&self) {
        let mut value = self
            .peer_snapshot(Permissions {
                listen: true,
                queue: true,
                transport: true,
                volume: true,
                chat_read: true,
                chat_send: true,
                invite: true,
            })
            .await;
        value["mode"] = json!("host");
        value["member_id"] = json!(OWNER);
        value["address"] = json!(self.server.address);
        value["fingerprint"] = json!(self.server.fingerprint.hex());
        value["favorite_local_ids"] = json!(self.library.local_favorite_ids().await);
        value["output"] = output_json(self.local.as_ref(), &self.output);
        value["next_operation_id"] = json!(self
            .high_water
            .get(&OWNER)
            .copied()
            .unwrap_or(0)
            .saturating_add(1)
            .to_string());
        value["output"]["preferences_error"] = json!(*self.preferences.error.borrow());
        value["shared_track_ids"] = json!(self.library.local_ids().await);
        value["discovery_available"] = json!(self.advertisement.is_some());
        value["discoverable"] = json!(self.discoverable);
        value["invitations"] = json!(self.server.transport.invitation_views());
        value["admission"] = json!({"room_code":self.server.transport.room_code(),"pending":self.server.transport.admission_views(),"capacity":vmusic_lan::admission::MAX_APPLICATIONS});
        value["sleep_timer_remaining_seconds"] =
            json!(self.sleep_timer.remaining_seconds(self.clock.now_ns()));
        *self.projection.write().unwrap_or_else(|e| e.into_inner()) = value;
    }
}
pub(super) fn validate_output(settings: &OutputSettings) -> RoomResult<()> {
    if !settings.volume.is_finite()
        || !(0.0..=1.0).contains(&settings.volume)
        || settings.latency_correction_ms.unsigned_abs() > 500
    {
        return Err(RoomError::invalid("输出音量或补偿超出范围"));
    }
    Ok(())
}
pub(super) fn output_json(receiver: Option<&ReceiverHandle>, settings: &OutputSettings) -> Value {
    let Some(receiver) = receiver else {
        return json!({"enabled":false,"settings":settings});
    };
    let status = receiver.status();
    json!({"enabled":true,"settings":settings,"ready":status.output_ready,"connected":status.connected,"played_frame":status.played_frame.to_string(),"underrun_frames":status.underrun_frames.to_string(),"buffered_input_frames":status.buffered_input_frames,"current_epoch":status.current_epoch.map(|v|v.to_string()),"preparing_epoch":status.preparing_epoch.map(|v|v.to_string()),"discarded_blocks":status.discarded_blocks.to_string(),"resync_count":status.resync_count.to_string(),"last_resync_reason":status.last_resync_reason,"output_session_id":status.identity.session_id,"binding":status.binding,"error":status.last_error,"clock":status.network_clock.map(|m|json!({"converged":m.converged(),"uncertainty_ns":m.uncertainty_ns.to_string(),"drift_ppm":m.drift_ppm,"rtt_ns":m.min_rtt_ns.to_string()})),"device":status.output.map(|o|json!({"clock_status":format!("{:?}",o.clock_status),"timestamp_capability":format!("{:?}",o.timestamp_capability),"clock_uncertainty_ns":o.clock_uncertainty_ns.to_string(),"clock_fault_count":o.clock_fault_count.to_string(),"last_clock_fault":o.last_clock_fault.map(|f|json!({"kind":format!("{:?}",f.kind),"value":f.value})),"device_clock_ppm":o.device_clock_ppm,"queued_frames":o.queued_frames,"muted":o.muted}))})
}
fn random_next(len: usize, current: usize) -> usize {
    if len <= 1 {
        return current;
    }
    let mut bytes = [0; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return (current + 1) % len;
    }
    let n = u64::from_le_bytes(bytes) as usize % (len - 1);
    if n >= current {
        n + 1
    } else {
        n
    }
}
fn outcome_json(outcome: timeline::Outcome) -> Value {
    match outcome {
        timeline::Outcome::Preparing { plan } => {
            json!({"status":"preparing","plan_id":plan.0.to_string()})
        }
        timeline::Outcome::Scheduled { plan, effective_at } => {
            json!({"status":"scheduled","plan_id":plan.0.to_string(),"effective_at":effective_at.to_string()})
        }
        timeline::Outcome::Applied { plan, at } => {
            json!({"status":"applied","plan_id":plan.0.to_string(),"at":at.to_string()})
        }
        timeline::Outcome::Superseded { by } => {
            json!({"status":"superseded","by":by.0.to_string()})
        }
        timeline::Outcome::NoOp => json!({"status":"no_op"}),
        timeline::Outcome::Failed { reason } => json!({"status":"failed","reason":reason.code()}),
    }
}

fn owner_permissions() -> Permissions {
    Permissions {
        listen: true,
        queue: true,
        transport: true,
        volume: true,
        chat_read: true,
        chat_send: true,
        invite: true,
    }
}

#[cfg(test)]
pub(super) mod join_retry_tests {
    use super::*;
    #[test]
    fn unavailable_and_repeated_resync_requests_wait_for_a_bounded_future_retry() {
        let mut retry = JoinRetry::default();
        assert!(!retry.take(0, false));
        assert!(retry.requested);
        assert!(retry.take(1, true));
        assert!(!retry.requested);
        for now in 2..1000 {
            assert!(!retry.take(now, true));
        }
        assert!(retry.requested);
        assert!(!retry.take(250_000_001, false));
        assert!(retry.take(250_000_002, true));
        assert!(!retry.requested);
    }

    async fn playing_owner() -> (
        Owner,
        std::thread::JoinHandle<()>,
        mpsc::Receiver<ProducerEvent>,
        mpsc::Receiver<Inbound>,
    ) {
        let (state, audio) = crate::state::tests::playback_state().await;
        let state = Arc::new(state);
        *state.queue.lock().await = vec!["a".into()];
        *state.cursor.lock().await = Some(0);
        let clock = MonotonicClock::default();
        let identity = vmusic_lan::tls::HostIdentity::generate().unwrap();
        let room = Uuid::new_v4();
        let instance = Uuid::new_v4();
        let (server, inbound) = RoomServer::bind(
            "127.0.0.1:0".parse().unwrap(),
            room,
            instance,
            &identity,
            clock.clone(),
        )
        .await
        .unwrap();
        let (producer, render) = Producer::spawn(clock.clone()).unwrap();
        let (_events, local_events) = mpsc::channel(1);
        let format = AudioFormat {
            id: 1,
            sample_rate: 48_000,
            channels: 2,
        };
        let target = PlanTarget {
            track: TrackInstanceId(1),
            position_ms: 0,
            playing: true,
        };
        let mut presentation_catalog = PresentationCatalog::default();
        presentation_catalog
            .remember(
                1,
                PresentedTrack {
                    track_id: "a".into(),
                    view: Some(super::super::resources::SharedTrack {
                        resource_id: Uuid::new_v4(),
                        favorite_key: None,
                        title: "Already distributed".into(),
                        artist: None,
                        album: None,
                        duration_ms: Some(60_000),
                        sample_rate: Some(48_000),
                        channels: Some(2),
                        has_cover: false,
                    }),
                },
            )
            .unwrap();
        let mut owner = Owner {
            history: super::super::history_writer::HistoryWriter::spawn(state.clone()),
            preferences: super::super::output_preferences::Preferences::spawn(state.db.clone()),
            state: state.clone(),
            server,
            clock,
            name: "Share boundary test".into(),
            format,
            library: SharedLibrary::default(),
            chat: None,
            chat_error: None,
            producer,
            scheduler: PlanScheduler::new(target),
            render_heads: HashMap::from([(1, 1)]),
            rendered_until: HashMap::new(),
            jobs: tokio::task::JoinSet::new(),
            source_jobs: HashMap::new(),
            successor_tokens: HashMap::new(),
            successor_targets: HashMap::new(),
            prepared_successors: HashMap::new(),
            pending_successors: HashMap::new(),
            next_job: 1,
            request_jobs: 0,
            mutation_preparing: false,
            collaboration: Default::default(),
            started_at_ms: wall_ms(),
            instances: vec![1],
            next_instance: 2,
            next_wire_plan: 2,
            candidate: None,
            audible: Some(Audible {
                plan: Plan {
                    epoch: Counter(1),
                    plan_id: Counter(1),
                    anchor_ns: Counter(0),
                    join_frame: Counter(0),
                    format,
                },
                target,
                position_frames: 0,
                position_at_ns: 0,
                preserve_position: false,
            }),
            scheduled: None,
            boundaries: Boundaries::default(),
            presentation_catalog,
            endpoints: HashMap::new(),
            next_endpoint: 1,
            local: None,
            local_identity: StreamIdentity {
                room_id: room,
                instance_id: instance,
                session_id: Uuid::new_v4(),
            },
            local_events,
            receiver_registry: ReceiverRegistry::default(),
            output: OutputSettings::default(),
            output_preparing: false,
            dsp: DspParams::default(),
            crossfade_ms: 0,
            loudness_mode: "off".into(),
            volume: 1.0,
            mixer: MixerTimeline::default(),
            mode: PlayMode::default(),
            records: VecDeque::new(),
            high_water: HashMap::new(),
            projection: Arc::new(RwLock::new(Value::Null)),
            error: None,
            no_output_since: None,
            sleep_timer: super::super::sleep_timer::SleepTimer::default(),
            next_internal_op: 1,
            advertisement: None,
            discoverable: false,
        };
        owner
            .collaboration
            .reconcile(&[1], owner.requester(OWNER), wall_ms());
        (owner, audio, render, inbound)
    }
    async fn finish_owner(mut owner: Owner, audio: std::thread::JoinHandle<()>) {
        owner.jobs.abort_all();
        while owner.jobs.join_next().await.is_some() {}
        owner.history.shutdown().await;
        owner.preferences.shutdown().await;
        owner.producer.shutdown().await;
        owner.server.shutdown().await;
        owner.state.audio.shutdown();
        audio.join().unwrap();
    }

    #[tokio::test]
    async fn service_exit_already_requested_stops_host_owner() {
        let (mut owner, audio, render, inbound) = playing_owner().await;
        let (_commands, local) = mpsc::channel(1);
        let (_stop, stopped) = watch::channel(false);
        owner.state.exiting.send_replace(true);
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            owner.run(local, inbound, render, stopped),
        )
        .await;
        finish_owner(owner, audio).await;
        assert!(
            result.is_ok(),
            "Host must observe an exit requested before run starts"
        );
    }

    #[tokio::test]
    async fn removing_first_duplicate_retains_the_playing_second_instance() {
        let (mut owner, audio, _render, _inbound) = playing_owner().await;
        *owner.state.queue.lock().await = vec!["a".into(), "a".into(), "b".into()];
        *owner.state.cursor.lock().await = Some(1);
        owner.instances = vec![1, 2, 3];
        owner.next_instance = 4;
        owner.audible.as_mut().unwrap().target.track = TrackInstanceId(2);
        owner.scheduler = PlanScheduler::new(owner.audible.as_ref().unwrap().target);
        owner.render_heads.insert(1, 2);
        owner
            .peer(
                OWNER,
                None,
                owner_permissions(),
                PeerRequest::Queue {
                    operation_id: Counter(1),
                    expected_revision: Counter(owner.scheduler.revision().0),
                    items: vec![
                        QueueItem {
                            instance_id: Some(Counter(2)),
                            resource_id: Uuid::new_v4(),
                        },
                        QueueItem {
                            instance_id: Some(Counter(3)),
                            resource_id: Uuid::new_v4(),
                        },
                    ],
                },
                Some(vec!["a".into(), "b".into()]),
            )
            .await
            .unwrap();
        assert_eq!(owner.instances, [2, 3]);
        assert_eq!(*owner.state.cursor.lock().await, Some(0));
        assert!(
            owner.candidate.is_none(),
            "retaining the current instance must not schedule a pause"
        );
        owner
            .peer(
                OWNER,
                None,
                owner_permissions(),
                PeerRequest::Queue {
                    operation_id: Counter(2),
                    expected_revision: Counter(owner.scheduler.revision().0),
                    items: vec![
                        QueueItem {
                            instance_id: Some(Counter(3)),
                            resource_id: Uuid::new_v4(),
                        },
                        QueueItem {
                            instance_id: Some(Counter(2)),
                            resource_id: Uuid::new_v4(),
                        },
                        QueueItem {
                            instance_id: None,
                            resource_id: Uuid::new_v4(),
                        },
                        QueueItem {
                            instance_id: None,
                            resource_id: Uuid::new_v4(),
                        },
                    ],
                },
                Some(vec!["b".into(), "a".into(), "a".into(), "a".into()]),
            )
            .await
            .unwrap();
        assert_eq!(owner.instances, [3, 2, 4, 5]);
        assert_eq!(*owner.state.cursor.lock().await, Some(1));
        assert!(owner.candidate.is_none());
        assert_eq!(owner.position(owner.clock.now_ns()).0, 2);
        assert!(owner.position(owner.clock.now_ns()).2);
        finish_owner(owner, audio).await;
    }

    #[tokio::test]
    async fn invalid_queue_instances_do_not_change_queue_revision_or_allocate_ids() {
        let (mut owner, audio, _render, _inbound) = playing_owner().await;
        let revision = owner.scheduler.revision().0;
        let resource = Uuid::new_v4();
        for (ids, tracks, expected, code) in [
            (
                vec![Some(1), Some(1)],
                vec!["a", "a"],
                revision,
                "room_invalid",
            ),
            (vec![Some(1)], vec!["b"], revision, "room_invalid"),
            (
                vec![None, Some(999)],
                vec!["a", "a"],
                revision,
                "room_invalid",
            ),
            (vec![Some(1)], vec!["a"], revision + 1, "revision_conflict"),
        ] {
            let error = owner
                .peer(
                    OWNER,
                    None,
                    owner_permissions(),
                    PeerRequest::Queue {
                        operation_id: Counter(1),
                        expected_revision: Counter(expected),
                        items: ids
                            .into_iter()
                            .map(|id| QueueItem {
                                instance_id: id.map(Counter),
                                resource_id: resource,
                            })
                            .collect(),
                    },
                    Some(tracks.into_iter().map(String::from).collect()),
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, code);
            assert_eq!(owner.scheduler.revision().0, revision);
            assert_eq!(*owner.state.queue.lock().await, ["a"]);
            assert_eq!(owner.instances, [1]);
            assert_eq!(owner.next_instance, 2);
            assert!(owner.candidate.is_none());
        }
        // Removing the currently presented instance retains the original
        // future-pause semantics; it does not silently switch to another copy.
        owner
            .peer(
                OWNER,
                None,
                owner_permissions(),
                PeerRequest::Queue {
                    operation_id: Counter(1),
                    expected_revision: Counter(revision),
                    items: vec![QueueItem {
                        instance_id: None,
                        resource_id: resource,
                    }],
                },
                Some(vec!["a".into()]),
            )
            .await
            .unwrap();
        assert_eq!(owner.instances, [2]);
        assert_eq!(*owner.state.cursor.lock().await, None);
        assert!(
            owner.position(owner.clock.now_ns()).2,
            "old PCM remains audible before the pause boundary"
        );
        let pause = owner.candidate.as_ref().unwrap();
        assert!(!pause.target.playing);
        assert_eq!(pause.target.track.0, 1);
        assert!(pause.preserve_position);
        // An already removed ID is not reusable even at the current revision.
        owner.candidate = None;
        let revision = owner.scheduler.revision().0;
        let error = owner
            .peer(
                OWNER,
                None,
                owner_permissions(),
                PeerRequest::Queue {
                    operation_id: Counter(2),
                    expected_revision: Counter(revision),
                    items: vec![QueueItem {
                        instance_id: Some(Counter(1)),
                        resource_id: resource,
                    }],
                },
                Some(vec!["a".into()]),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "room_invalid");
        assert_eq!(owner.scheduler.revision().0, revision);
        assert_eq!(owner.instances, [2]);
        assert_eq!(owner.next_instance, 3);
        finish_owner(owner, audio).await;
    }

    #[tokio::test]
    async fn authenticated_votes_survive_reconnect_and_rank_only_unfrozen_duplicate_occurrences() {
        let (mut owner, audio, _render, mut inbound) = playing_owner().await;
        *owner.state.queue.lock().await = vec!["a".into(), "b".into(), "b".into(), "b".into()];
        owner.instances = vec![1, 2, 3, 4];
        owner.next_instance = 5;
        owner
            .collaboration
            .reconcile(&owner.instances, owner.requester(OWNER), wall_ms());
        owner
            .pending_successors
            .insert(1, VecDeque::from([Some(2)]));
        let invitation = owner
            .server
            .transport
            .invite(Permissions {
                queue: true,
                ..Default::default()
            })
            .unwrap();
        let paired = vmusic_lan::client::pair(
            owner.server.address,
            owner.server.fingerprint,
            owner.local_identity.room_id,
            &invitation,
            "Alice",
        )
        .await
        .unwrap();
        let (connection, _events) = vmusic_lan::client::ClientConnection::connect(
            owner.server.address,
            owner.server.fingerprint,
            owner.local_identity.room_id,
            paired.member_id,
            &paired.credential,
        )
        .await
        .unwrap();
        owner.network(inbound.recv().await.unwrap()).await.unwrap();
        let identity = connection.handle.identity;
        let permissions = owner
            .server
            .transport
            .authorize(paired.member_id, identity)
            .unwrap();
        let vote = PeerRequest::Vote {
            operation_id: Counter(1),
            expected_revision: Counter(owner.scheduler.revision().0),
            instance_id: Counter(4),
            voted: true,
        };
        let applied = owner
            .peer(
                paired.member_id,
                Some(identity),
                permissions,
                vote.clone(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(owner.collaboration.count(4), 1);
        assert_eq!(owner.collaboration.count(3), 0);
        assert_eq!(
            owner.collaboration.projection(4, paired.member_id, true)["voted_by_me"],
            true
        );
        assert_eq!(
            owner.collaboration.projection(4, OWNER, true)["voted_by_me"],
            false
        );
        assert_eq!(
            owner
                .peer(
                    paired.member_id,
                    Some(identity),
                    permissions,
                    vote.clone(),
                    None
                )
                .await
                .unwrap(),
            applied
        );
        let activity_len = owner.collaboration.activity.len();
        connection.shutdown().await;
        owner.network(inbound.recv().await.unwrap()).await.unwrap();
        owner.advance(owner.clock.now_ns()).await.unwrap();
        let (reconnected, _events) = vmusic_lan::client::ClientConnection::connect(
            owner.server.address,
            owner.server.fingerprint,
            owner.local_identity.room_id,
            paired.member_id,
            &paired.credential,
        )
        .await
        .unwrap();
        owner.network(inbound.recv().await.unwrap()).await.unwrap();
        assert_eq!(
            owner
                .peer(
                    paired.member_id,
                    Some(reconnected.handle.identity),
                    permissions,
                    vote,
                    None
                )
                .await
                .unwrap(),
            applied
        );
        assert_eq!(owner.collaboration.count(4), 1);
        assert_eq!(owner.collaboration.activity.len(), activity_len + 2);
        for id in [1, 2, 999] {
            let error = owner
                .peer(
                    paired.member_id,
                    Some(reconnected.handle.identity),
                    permissions,
                    PeerRequest::Vote {
                        operation_id: Counter(2),
                        expected_revision: Counter(owner.scheduler.revision().0),
                        instance_id: Counter(id),
                        voted: true,
                    },
                    None,
                )
                .await
                .unwrap_err();
            assert_eq!(error.code, "room_invalid");
        }
        let denied = owner
            .peer(
                paired.member_id,
                Some(reconnected.handle.identity),
                permissions,
                PeerRequest::QueueOrder {
                    operation_id: Counter(2),
                    expected_revision: Counter(owner.scheduler.revision().0),
                    mode: QueueOrder::Votes,
                },
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(denied.code, "room_denied");
        owner
            .peer(
                OWNER,
                None,
                owner_permissions(),
                PeerRequest::QueueOrder {
                    operation_id: Counter(1),
                    expected_revision: Counter(owner.scheduler.revision().0),
                    mode: QueueOrder::Votes,
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(owner.instances, [1, 2, 4, 3]);
        assert_eq!(*owner.state.queue.lock().await, ["a", "b", "b", "b"]);
        assert_eq!(*owner.state.cursor.lock().await, Some(0));
        assert_eq!(owner.pending_successors[&1].front(), Some(&Some(2)));
        assert!(owner.candidate.is_none());
        let revision = owner.scheduler.revision().0;
        owner
            .peer(
                paired.member_id,
                Some(reconnected.handle.identity),
                permissions,
                PeerRequest::Vote {
                    operation_id: Counter(2),
                    expected_revision: Counter(revision),
                    instance_id: Counter(4),
                    voted: false,
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(owner.instances, [1, 2, 3, 4]);
        assert_eq!(owner.collaboration.count(4), 0);
        reconnected.shutdown().await;
        finish_owner(owner, audio).await;
    }

    #[tokio::test]
    async fn failed_social_admission_does_not_publish_votes_or_activity() {
        let (mut owner, audio, _render, _inbound) = playing_owner().await;
        owner.instances.push(2);
        owner
            .collaboration
            .reconcile(&owner.instances, owner.requester(OWNER), wall_ms());
        let revision = owner.scheduler.revision().0;
        let activity = owner.collaboration.activity.len();
        let request = PeerRequest::Vote {
            operation_id: Counter(1),
            expected_revision: Counter(revision),
            instance_id: Counter(2),
            voted: true,
        };
        assert_eq!(
            owner
                .peer(OWNER, None, owner_permissions(), request, None)
                .await
                .unwrap_err()
                .code,
            "room_queue_invariant"
        );
        assert_eq!(owner.collaboration.count(2), 0);
        assert_eq!(owner.collaboration.activity.len(), activity);
        assert_eq!(owner.scheduler.revision().0, revision);
        finish_owner(owner, audio).await;
    }

    // The producer overlap regression consumes the actual Owner preflight,
    // covering the queue removal/acknowledgment race and the affected PCM.
    pub(in crate::room) async fn removed_successor_mix_gains() -> HashMap<u64, f32> {
        let (mut owner, audio, _render, _inbound) = playing_owner().await;
        *owner.state.queue.lock().await = vec!["a".into(), "b".into(), "c".into()];
        owner.instances = vec![1, 2, 3];
        owner.next_instance = 4;
        let mut incoming = owner.presentation_catalog.get(1).unwrap().clone();
        incoming.track_id = "b".into();
        incoming.view.as_mut().unwrap().title = "Retained incoming".into();
        owner.presentation_catalog.remember(2, incoming).unwrap();
        owner.successor_targets.insert(
            1,
            SuccessorTarget {
                current: 1,
                next: 2,
            },
        );
        owner.successor_tokens.insert(1, 1);
        owner
            .complete(Completion::Successor {
                epoch: 1,
                current: 1,
                token: 1,
                library_revision: 0,
                result: Ok(Source {
                    path: Default::default(),
                    instance: 2,
                    position_ms: 0,
                    track_gain_db: -12.0,
                }),
            })
            .await
            .unwrap();
        assert_eq!(owner.pending_successors[&1].front(), Some(&Some(2)));
        // Install a prevalidated queue result before consuming the producer's
        // ACK. The sent B may already be mixed even though desired is now C.
        owner
            .peer(
                OWNER,
                None,
                owner_permissions(),
                PeerRequest::Queue {
                    operation_id: Counter(1),
                    expected_revision: Counter(owner.scheduler.revision().0),
                    items: vec![
                        QueueItem {
                            instance_id: Some(Counter(1)),
                            resource_id: Uuid::new_v4(),
                        },
                        QueueItem {
                            instance_id: Some(Counter(3)),
                            resource_id: Uuid::new_v4(),
                        },
                    ],
                },
                Some(vec!["a".into(), "c".into()]),
            )
            .await
            .unwrap();
        owner.advance(owner.clock.now_ns()).await.unwrap();
        assert_eq!(owner.track_for(2).await.unwrap(), "b");
        assert!(owner.presentation_catalog.get(2).is_some());
        owner.loudness_mode = "track".into();
        owner
            .change_mix(
                OWNER,
                None,
                MixSettings {
                    dsp: DspParams::default(),
                    volume: 0.5,
                    crossfade_ms: 1000,
                    loudness_mode: "off".into(),
                },
            )
            .await
            .unwrap();
        let completion = owner.jobs.join_next().await.unwrap().unwrap();
        let gains = match completion {
            Completion::Mixer { result, .. } => result.unwrap(),
            _ => panic!("expected mixer preflight"),
        };
        assert_eq!(gains, HashMap::from([(1, 0.0), (2, 0.0), (3, 0.0)]));
        // The first ACK retires only its own sent identity. Actual B takes over
        // retention even while a newer Next(None) acknowledgment is outstanding.
        owner
            .render(ProducerEvent::SuccessorPrepared {
                epoch: 1,
                instance: Some(2),
            })
            .await
            .unwrap();
        assert_eq!(owner.pending_successors[&1].len(), 1);
        owner.advance(owner.clock.now_ns()).await.unwrap();
        assert_eq!(owner.track_for(2).await.unwrap(), "b");
        assert_eq!(
            owner
                .presentation_catalog
                .get(2)
                .unwrap()
                .view
                .as_ref()
                .unwrap()
                .title,
            "Retained incoming"
        );
        finish_owner(owner, audio).await;
        gains
    }

    #[tokio::test]
    async fn share_revocation_keeps_distributed_pcm_audible_until_future_pause() {
        let (mut owner, audio, mut render, _inbound) = playing_owner().await;
        let state = owner.state.clone();
        owner.request_jobs = 1;
        owner.mutation_preparing = true;
        let format = owner.format;
        // Seed the already distributed presentation independently of the new
        // resource capabilities: an empty replacement revokes this source.
        let prepared = owner
            .library
            .prepare_replace(&state, Vec::new())
            .await
            .unwrap();
        let (reply, result) = tokio::sync::oneshot::channel();
        let requested_at = owner.clock.now_ns();
        owner
            .complete(Completion::Request {
                member: OWNER,
                session: None,
                permissions: owner_permissions(),
                revision: owner.scheduler.revision().0,
                library_revision: owner.library.revision().await,
                mutation: true,
                reply: Reply::Local(reply),
                result: Ok(PreparedAction::Share(prepared)),
            })
            .await
            .unwrap();
        result.await.unwrap().unwrap();
        assert_eq!(owner.library.revision().await, 1);
        assert!(owner.position(owner.clock.now_ns()).2);
        let candidate = owner.candidate.as_ref().unwrap();
        assert!(!candidate.target.playing);
        assert!(candidate.preserve_position);
        let at = candidate.wire.anchor_ns.0;
        assert!(at >= requested_at + LEAD_NS);
        assert_eq!(
            owner.peer_snapshot(owner_permissions()).await["current_track"]["title"],
            "Already distributed"
        );

        let prepared = tokio::time::timeout(std::time::Duration::from_secs(2), render.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(prepared, ProducerEvent::Prepared { .. }));
        owner.render(prepared).await.unwrap();
        let fade_start = at.saturating_sub(super::super::producer::FADE_OUT_NS);
        owner.rendered_until.insert(
            1,
            (u128::from(fade_start) * u128::from(format.sample_rate) / 1_000_000_000) as u64,
        );
        owner.try_commit().await.unwrap();
        assert!(owner.candidate.is_none());
        assert_eq!(owner.scheduled.as_ref().unwrap().plan.anchor_ns.0, at);
        owner.advance(at - 1).await.unwrap();
        assert!(owner.position(at - 1).2);
        owner.advance(at).await.unwrap();
        assert!(!owner.position(at).2);
        assert_eq!(owner.position(at).0, 1);
        assert_eq!(
            owner.peer_snapshot(owner_permissions()).await["current_track"]["title"],
            "Already distributed"
        );

        finish_owner(owner, audio).await;
    }

    type TestClients = Vec<(
        Uuid,
        vmusic_lan::client::ClientConnection,
        vmusic_lan::client::ClientEvents,
    )>;
    async fn prepared_owner_with_clients() -> (
        Owner,
        std::thread::JoinHandle<()>,
        mpsc::Receiver<ProducerEvent>,
        mpsc::Receiver<Inbound>,
        TestClients,
        Plan,
    ) {
        let (mut owner, audio, render, inbound) = playing_owner().await;
        let mut clients = Vec::new();
        for name in ["Healthy", "Resyncing"] {
            let invitation = owner.server.transport.invite(Default::default()).unwrap();
            let paired = vmusic_lan::client::pair(
                owner.server.address,
                owner.server.fingerprint,
                owner.local_identity.room_id,
                &invitation,
                name,
            )
            .await
            .unwrap();
            let (connection, events) = vmusic_lan::client::ClientConnection::connect(
                owner.server.address,
                owner.server.fingerprint,
                owner.local_identity.room_id,
                paired.member_id,
                &paired.credential,
            )
            .await
            .unwrap();
            clients.push((paired.member_id, connection, events));
        }
        let now = owner.clock.now_ns();
        owner
            .scheduler
            .submit(
                now,
                OperationKey {
                    member: MemberId(0),
                    namespace: 1,
                    seq: 1,
                },
                Some(owner.scheduler.revision()),
                timeline::Command::Seek {
                    track: TrackInstanceId(1),
                    position_ms: 100,
                },
            )
            .unwrap();
        let preparing = owner.scheduler.preparing().unwrap();
        let wire = Plan {
            epoch: Counter(preparing.epoch.0),
            plan_id: Counter(owner.wire_id().unwrap()),
            anchor_ns: Counter(now + LEAD_NS),
            join_frame: Counter(0),
            format: owner.format,
        };
        owner
            .producer
            .prepare(wire.clone(), None, owner.dsp, owner.volume)
            .unwrap();
        owner.candidate = Some(Candidate {
            wire: wire.clone(),
            scheduler_plan: preparing.id,
            target: preparing.target,
            prepared: true,
            ready: true,
            materialized: true,
            loading: false,
            preserve_position: false,
            creator: OWNER,
            session: None,
        });
        for (index, (member, connection, _)) in clients.iter().enumerate() {
            owner.endpoints.insert(
                *member,
                Endpoint {
                    identity: connection.handle.identity,
                    index: index as u32 + 1,
                    audio: true,
                    last_output: Some(now),
                    plan: Some(wire.clone()),
                    committed: false,
                    ready: true,
                    rejoin: JoinRetry::default(),
                },
            );
        }
        (owner, audio, render, inbound, clients, wire)
    }

    #[tokio::test]
    async fn one_resyncing_endpoint_preserves_the_shared_candidate_and_healthy_commit() {
        let (mut owner, audio, _render, _inbound, mut clients, wire) =
            prepared_owner_with_clients().await;
        let healthy = clients[0].0;
        let resyncing = clients[1].0;
        owner.resync(resyncing).unwrap();
        assert_eq!(owner.candidate.as_ref().unwrap().wire, wire);
        assert!(owner.candidate.as_ref().unwrap().ready);
        assert!(!owner.endpoints[&resyncing].ready);
        assert!(owner.endpoints[&resyncing].rejoin.requested);
        assert_eq!(owner.endpoints[&resyncing].plan.as_ref(), Some(&wire));
        owner.try_commit().await.unwrap();
        assert!(owner.candidate.is_none());
        assert_eq!(owner.scheduled.as_ref().unwrap().plan, wire);
        assert!(owner.endpoints[&healthy].committed);
        assert!(!owner.endpoints[&resyncing].committed);
        let commit = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            clients[0].2.control.recv(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(matches!(commit, ControlFrame::Commit { epoch, .. } if epoch == wire.epoch));
        for (_, connection, _) in clients {
            connection.shutdown().await;
        }
        finish_owner(owner, audio).await;
    }

    #[tokio::test]
    async fn congested_remote_prepare_isolated_without_ending_the_shared_operation() {
        let (mut owner, audio, _render, _inbound, mut clients, wire) =
            prepared_owner_with_clients().await;
        let healthy = clients[0].0;
        let resyncing = clients[1].0;
        let identity = clients[1].1.handle.identity;
        // No await occurs between filling the transport's 32-slot priority
        // queue and Prepare. On this current-thread runtime the writer cannot
        // drain it, so the real send path deterministically disconnects only B.
        for _ in 0..32 {
            owner
                .server
                .transport
                .send(
                    resyncing,
                    identity,
                    &ControlFrame::Notification {
                        topic: "test_queue_fill".into(),
                        body: Value::Null,
                    },
                )
                .unwrap();
        }
        owner.endpoints.get_mut(&resyncing).unwrap().plan = None;
        owner.resync(resyncing).unwrap();
        assert!(!owner.endpoints.contains_key(&resyncing));
        assert!(owner
            .server
            .transport
            .authorize(resyncing, identity)
            .is_err());
        assert_eq!(owner.candidate.as_ref().unwrap().wire, wire);
        assert!(owner.candidate.as_ref().unwrap().ready);
        assert!(owner.endpoints[&healthy].ready);
        owner.try_commit().await.unwrap();
        assert_eq!(owner.scheduled.as_ref().unwrap().plan, wire);
        assert!(owner.endpoints[&healthy].committed);
        let commit = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            clients[0].2.control.recv(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(matches!(commit, ControlFrame::Commit { epoch, .. } if epoch == wire.epoch));
        // Global plan exhaustion remains an Owner error, independent of the
        // peer-local send failure handled above.
        owner.next_wire_plan = u64::MAX;
        assert_eq!(
            owner.join(healthy).unwrap_err().code,
            "room_counter_exhausted"
        );
        for (_, connection, _) in clients {
            connection.shutdown().await;
        }
        finish_owner(owner, audio).await;
    }
}
