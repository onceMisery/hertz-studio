// SPDX-License-Identifier: MIT
//! The room's only PCM producer. No soundcard is opened on this thread.
//! Prepared control generations are bounded to current + one candidate. A
//! candidate never replaces the current renderer until its Commit is accepted.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;
use tokio::sync::{mpsc as async_mpsc, watch};
use vmusic_audio::{RenderCore, RenderFormat};
use vmusic_core::{AudioBackend, DspParams, NextEvent, NextTrack};
use vmusic_lan::clock::MonotonicClock;
use vmusic_lan::protocol::{AudioFormat, Plan};

const AHEAD_NS: u64 = 500_000_000;
const PREFILL_NS: u64 = 200_000_000;
pub(super) const FADE_OUT_NS: u64 = 200_000_000;

fn frames_at(plan: &Plan, at: u64) -> Result<u64, String> {
    u64::try_from(
        u128::from(at.saturating_sub(plan.anchor_ns.0)) * u128::from(plan.format.sample_rate)
            / 1_000_000_000,
    )
    .map_err(|_| "room timeline overflow".into())
}

#[derive(Debug, Clone)]
pub struct Source {
    pub path: PathBuf,
    pub instance: u64,
    pub position_ms: u64,
    pub track_gain_db: f32,
}
#[derive(Debug)]
pub enum FailureStage {
    Preparation,
    Successor,
    Render,
}
#[derive(Debug)]
pub enum ProducerEvent {
    SuccessorPrepared {
        epoch: u64,
        instance: Option<u64>,
    },
    MixApplied {
        change: u64,
        at: u64,
    },
    Suspended {
        epoch: u64,
        instance: u64,
        position_frames: u64,
    },
    Prepared {
        epoch: u64,
    },
    Pcm {
        epoch: u64,
        sequence: u64,
        frame: u64,
        format: AudioFormat,
        samples: Arc<[f32]>,
    },
    Boundary {
        epoch: u64,
        frame: u64,
        instance: u64,
        position_frames: u64,
    },
    End {
        epoch: u64,
        frame: u64,
        instance: u64,
    },
    Error {
        epoch: u64,
        stage: FailureStage,
        message: String,
    },
}
enum Command {
    Prepare {
        plan: Plan,
        source: Option<Source>,
        dsp: DspParams,
        volume: f32,
    },
    Commit {
        epoch: u64,
    },
    Next {
        epoch: u64,
        source: Option<Source>,
        crossfade_ms: u64,
    },
    Cancel {
        epoch: u64,
    },
    Halt {
        epoch: u64,
    },
    Dsp {
        change: u64,
        params: DspParams,
        volume: f32,
        gains: HashMap<u64, f32>,
        crossfade_ms: u64,
    },
}
struct Generation {
    plan: Plan,
    renderer: Option<RenderCore>,
    instance: u64,
    frame: u64,
    sequence: u64,
    committed: bool,
    prepared: bool,
    ended: bool,
    awaiting_next: bool,
    track_gain_db: f32,
    dsp: DspParams,
    next_gain: Option<(u64, f32)>,
    gain_overrides: HashMap<u64, f32>,
    fade: Option<FadeOut>,
    pending_mix: Option<u64>,
    crossfade_override: Option<u64>,
}
#[derive(Clone, Copy)]
struct FadeOut {
    epoch: u64,
    start: u64,
    end: u64,
}
impl FadeOut {
    fn gain(self, frame: u64) -> f32 {
        if frame < self.start {
            1.0
        } else if frame >= self.end {
            0.0
        } else {
            (self.end - frame) as f32 / (self.end - self.start).max(1) as f32
        }
    }
}
impl Generation {
    fn time(&self, frame: u64) -> Option<u64> {
        self.plan.anchor_ns.0.checked_add(
            u64::try_from(
                u128::from(frame) * 1_000_000_000 / u128::from(self.plan.format.sample_rate),
            )
            .ok()?,
        )
    }
}
pub struct Producer {
    commands: mpsc::SyncSender<Command>,
    stop: Arc<AtomicBool>,
    pub failure: watch::Receiver<Option<String>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Producer {
    pub fn spawn(
        clock: MonotonicClock,
    ) -> Result<(Self, async_mpsc::Receiver<ProducerEvent>), String> {
        let (commands, rx) = mpsc::sync_channel(16);
        let (events, event_rx) = async_mpsc::channel(128);
        let (failure, failure_rx) = watch::channel(None);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let (retire_tx, retire_rx) = mpsc::sync_channel::<Generation>(2);
        let retirement = std::thread::Builder::new()
            .name("hertz-room-retire".into())
            .spawn(move || {
                for generation in retire_rx {
                    drop(generation);
                }
            })
            .map_err(|e| e.to_string())?;
        let thread = std::thread::Builder::new()
            .name("hertz-room-render".into())
            .spawn(move || {
                let mut worker = Worker {
                    clock,
                    events,
                    stop: thread_stop,
                    current: None,
                    preparing: None,
                    retired: retire_tx,
                    deferred_mix: None,
                };
                if let Err(error) = worker.run(rx) {
                    failure.send_replace(Some(error));
                }
                drop(worker);
                let _ = retirement.join();
            })
            .map_err(|e| e.to_string())?;
        Ok((
            Self {
                commands,
                stop,
                failure: failure_rx,
                thread: Some(thread),
            },
            event_rx,
        ))
    }
    fn send(&self, command: Command) -> Result<(), String> {
        self.commands
            .try_send(command)
            .map_err(|_| "room producer is unavailable or congested".into())
    }
    pub fn prepare(
        &self,
        plan: Plan,
        source: Option<Source>,
        dsp: DspParams,
        volume: f32,
    ) -> Result<(), String> {
        plan.format.validate().map_err(|e| e.to_string())?;
        if !volume.is_finite() || !(0.0..=1.0).contains(&volume) {
            return Err("invalid room volume".into());
        }
        self.send(Command::Prepare {
            plan,
            source,
            dsp,
            volume,
        })
    }
    pub fn commit(&self, epoch: u64) -> Result<(), String> {
        self.send(Command::Commit { epoch })
    }
    pub fn next(
        &self,
        epoch: u64,
        source: Option<Source>,
        crossfade_ms: u64,
    ) -> Result<(), String> {
        self.send(Command::Next {
            epoch,
            source,
            crossfade_ms,
        })
    }
    pub fn cancel(&self, epoch: u64) -> Result<(), String> {
        self.send(Command::Cancel { epoch })
    }
    pub fn halt(&self, epoch: u64) -> Result<(), String> {
        self.send(Command::Halt { epoch })
    }
    pub fn dsp(
        &self,
        change: u64,
        params: DspParams,
        volume: f32,
        gains: HashMap<u64, f32>,
        crossfade_ms: u64,
    ) -> Result<(), String> {
        self.send(Command::Dsp {
            change,
            params,
            volume,
            gains,
            crossfade_ms,
        })
    }
    pub async fn shutdown(mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = tokio::task::spawn_blocking(move || thread.join()).await;
        }
    }
}
impl Drop for Producer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
struct Worker {
    clock: MonotonicClock,
    events: async_mpsc::Sender<ProducerEvent>,
    stop: Arc<AtomicBool>,
    current: Option<Generation>,
    preparing: Option<Generation>,
    // Drop decoder owners off the time-sensitive render loop. At most two can
    // be retiring; their decoder stop/join is bounded by the existing renderer.
    retired: mpsc::SyncSender<Generation>,
    deferred_mix: Option<Command>,
}
impl Worker {
    fn emit(&self, event: ProducerEvent) -> Result<(), String> {
        self.events
            .try_send(event)
            .map_err(|_| "room render event consumer is congested".into())
    }
    fn run(&mut self, commands: mpsc::Receiver<Command>) -> Result<(), String> {
        while !self.stop.load(Ordering::Acquire) {
            match commands.recv_timeout(Duration::from_millis(5)) {
                Ok(command) => self.command(command)?,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            // Bound work per iteration so an attacker cannot starve stop/Commit.
            for _ in 0..8 {
                let Ok(command) = commands.try_recv() else {
                    break;
                };
                self.command(command)?;
            }
            let now = self.clock.now_ns();
            if self.deferred_mix.is_some() && !self.overlap_started() {
                let change = self.deferred_mix.take().unwrap();
                self.apply(change)?;
            }
            let boundary = self
                .preparing
                .as_ref()
                .filter(|g| g.committed)
                .and_then(|g| g.time(g.plan.join_frame.0));
            // An unpublished suspension reserves its final fade region. No
            // unfaded PCM may escape before Owner freezes that region by Commit.
            if let Some(mut generation) = self.current.take() {
                let horizon = self.current_horizon(now, boundary);
                if let Err(message) = self.pull(&mut generation, horizon) {
                    self.emit(ProducerEvent::Error {
                        epoch: generation.plan.epoch.0,
                        stage: FailureStage::Render,
                        message,
                    })?;
                    generation.ended = true;
                    generation.renderer = None;
                }
                self.current = Some(generation);
            }
            if let Some(mut generation) = self.preparing.take() {
                let start = generation
                    .time(generation.plan.join_frame.0)
                    .ok_or("room timeline overflow")?;
                // Pre-Commit PCM is quarantined by every receiver. Priming it
                // permits Ready without exposing uncommitted samples to devices.
                let horizon = if generation.committed {
                    now.saturating_add(AHEAD_NS)
                        .max(start.saturating_add(PREFILL_NS))
                } else {
                    start.saturating_add(PREFILL_NS)
                };
                if let Err(message) = self.pull(&mut generation, horizon) {
                    self.emit(ProducerEvent::Error {
                        epoch: generation.plan.epoch.0,
                        stage: FailureStage::Render,
                        message,
                    })?;
                    generation.ended = true;
                    generation.renderer = None;
                }
                // A natural transition can make pull yield for its next source.
                // Reaching the render horizon does not mean that the old PCM
                // prefix has actually been produced through the Commit point.
                let old_prefix_complete = match self.current.as_ref() {
                    Some(old) => old.frame >= frames_at(&old.plan, start)?,
                    None => true,
                };
                if generation.committed
                    && boundary.is_some_and(|b| now.saturating_add(AHEAD_NS) >= b)
                    && old_prefix_complete
                {
                    if let Some(old) = self.current.replace(generation) {
                        self.retire(old)?;
                    }
                } else {
                    self.preparing = Some(generation);
                }
            }
        }
        Ok(())
    }
    fn retire(&self, generation: Generation) -> Result<(), String> {
        self.retired
            .try_send(generation)
            .map_err(|_| "decoder retirement is congested".to_string())
    }
    fn overlap_started(&self) -> bool {
        self.current
            .as_ref()
            .and_then(|g| g.renderer.as_ref())
            .is_some_and(|renderer| renderer.prepared_next_started())
    }
    fn current_horizon(&self, now: u64, boundary: Option<u64>) -> u64 {
        let reservation = self
            .preparing
            .as_ref()
            .filter(|g| !g.committed && g.renderer.is_none())
            .and_then(|g| g.time(g.plan.join_frame.0))
            .map(|at| at.saturating_sub(FADE_OUT_NS));
        now.saturating_add(AHEAD_NS)
            .min(boundary.unwrap_or(u64::MAX))
            .min(reservation.unwrap_or(u64::MAX))
    }
    fn command(&mut self, command: Command) -> Result<(), String> {
        let target = match &command {
            Command::Prepare { plan, .. } => Some((plan.epoch.0, FailureStage::Preparation)),
            Command::Next { epoch, .. } => Some((*epoch, FailureStage::Successor)),
            _ => None,
        };
        if let Err(message) = self.apply(command) {
            if let Some((epoch, stage)) = target {
                if matches!(stage, FailureStage::Successor) {
                    self.emit(ProducerEvent::SuccessorPrepared {
                        epoch,
                        instance: None,
                    })?;
                }
                self.emit(ProducerEvent::Error {
                    epoch,
                    stage,
                    message,
                })?;
            } else {
                return Err(message);
            }
        }
        Ok(())
    }
    fn apply(&mut self, command: Command) -> Result<(), String> {
        match command {
            Command::Prepare {
                plan,
                source,
                dsp,
                volume,
            } => {
                if self.preparing.as_ref().is_some_and(|g| g.committed) {
                    return Err("cannot replace an already committed render prefix".into());
                }
                let (renderer, instance, gain) = if let Some(source) = source {
                    let mut renderer = RenderCore::new(RenderFormat {
                        sample_rate: plan.format.sample_rate,
                        channels: plan.format.channels,
                    })
                    .map_err(|e| e.to_string())?;
                    renderer
                        .load(source.path.to_str().ok_or("non-Unicode source path")?)
                        .map_err(|_| "shared local track cannot be decoded")?;
                    if source.position_ms > 0 {
                        renderer
                            .seek(source.position_ms)
                            .map_err(|e| e.to_string())?;
                    }
                    renderer
                        .set_dsp(DspParams {
                            track_gain_db: source.track_gain_db,
                            ..dsp
                        })
                        .map_err(|e| e.to_string())?;
                    renderer.set_volume(volume).map_err(|e| e.to_string())?;
                    renderer.play().map_err(|e| e.to_string())?;
                    (Some(renderer), source.instance, source.track_gain_db)
                } else {
                    (None, 0, 0.0)
                };
                if let Some(old) = self.preparing.take() {
                    self.retire(old)?;
                }
                self.preparing = Some(Generation {
                    frame: plan.join_frame.0,
                    plan,
                    renderer,
                    instance,
                    sequence: 0,
                    committed: false,
                    prepared: false,
                    ended: false,
                    awaiting_next: true,
                    track_gain_db: gain,
                    dsp,
                    next_gain: None,
                    gain_overrides: HashMap::new(),
                    fade: None,
                    pending_mix: None,
                    crossfade_override: None,
                });
            }
            Command::Commit { epoch } => {
                let g = self
                    .preparing
                    .as_mut()
                    .filter(|g| g.plan.epoch.0 == epoch)
                    .ok_or("unknown render Commit")?;
                g.committed = true;
                if g.renderer.is_none() {
                    let end_ns = g
                        .time(g.plan.join_frame.0)
                        .ok_or("room timeline overflow")?;
                    if let Some(old) = self.current.as_mut().filter(|old| old.renderer.is_some()) {
                        let end = frames_at(&old.plan, end_ns)?;
                        let fade_frames =
                            u64::from(old.plan.format.sample_rate) * FADE_OUT_NS / 1_000_000_000;
                        let start = end.saturating_sub(fade_frames);
                        if old.frame > start {
                            return Err("suspension fade prefix was already rendered".into());
                        }
                        old.fade = Some(FadeOut { epoch, start, end });
                    }
                }
            }
            Command::Next {
                epoch,
                source,
                crossfade_ms,
            } => {
                let g = self
                    .current
                    .as_mut()
                    .filter(|g| g.plan.epoch.0 == epoch)
                    .or_else(|| self.preparing.as_mut().filter(|g| g.plan.epoch.0 == epoch));
                let mut actual = None;
                if let Some(g) = g {
                    g.awaiting_next = false;
                    if let Some(renderer) = g.renderer.as_mut() {
                        if renderer.prepared_next_started() {
                            // The incoming deck has already contributed to the
                            // distributed prefix. Finish that immutable overlap;
                            // Owner chooses the next successor after promotion.
                            actual = Some(g.next_gain.map(|(instance, _)| instance));
                        } else {
                            renderer.clear_next();
                            g.next_gain = None;
                            if let Some(mut source) = source {
                                if let Some(gain) = g.gain_overrides.get(&source.instance) {
                                    source.track_gain_db = *gain;
                                }
                                let result = renderer
                                    .prepare_next_with_gain(
                                        NextTrack {
                                            uri: source.path.to_string_lossy().into_owned(),
                                            track_id: source.instance.to_string(),
                                            generation: g.instance,
                                            crossfade_ms: g
                                                .crossfade_override
                                                .unwrap_or(crossfade_ms),
                                        },
                                        source.track_gain_db,
                                    )
                                    .map_err(|e| e.to_string())?;
                                if let vmusic_core::PrepareResult::Bypassed { reason } = result {
                                    return Err(format!("next track unavailable: {reason}"));
                                }
                                g.next_gain = Some((source.instance, source.track_gain_db));
                            }
                            actual = Some(g.next_gain.map(|(instance, _)| instance));
                        }
                    }
                }
                // Acknowledge every FIFO command, including a silent or retired
                // epoch, so Owner can release exactly its matching metadata.
                self.emit(ProducerEvent::SuccessorPrepared {
                    epoch,
                    instance: actual.flatten(),
                })?;
            }
            Command::Cancel { epoch } => {
                if self
                    .preparing
                    .as_ref()
                    .is_some_and(|g| g.plan.epoch.0 == epoch && !g.committed)
                {
                    let old = self.preparing.take().unwrap();
                    self.retire(old)?;
                }
            }
            Command::Halt { epoch } => {
                if self
                    .current
                    .as_ref()
                    .is_some_and(|g| g.plan.epoch.0 == epoch)
                {
                    let old = self.current.take().unwrap();
                    self.retire(old)?;
                }
                if self
                    .preparing
                    .as_ref()
                    .is_some_and(|g| g.plan.epoch.0 == epoch)
                {
                    let old = self.preparing.take().unwrap();
                    self.retire(old)?;
                }
            }
            Command::Dsp {
                change,
                params,
                volume,
                gains,
                crossfade_ms,
            } => {
                // Never rewrite the duration of an overlap whose PCM has
                // escaped. Apply the complete mixer state on its promotion.
                // Pause/Stop can still retire that prefix at their own boundary.
                if self.overlap_started() {
                    self.deferred_mix = Some(Command::Dsp {
                        change,
                        params,
                        volume,
                        gains,
                        crossfade_ms,
                    });
                    return Ok(());
                }
                let mut has_audio = false;
                let mut idle_at = self.clock.now_ns();
                for g in [&mut self.current, &mut self.preparing]
                    .into_iter()
                    .flatten()
                {
                    g.dsp = params;
                    g.crossfade_override = Some(crossfade_ms);
                    if !gains.is_empty() {
                        g.gain_overrides = gains.clone();
                    }
                    if let Some(gain) = gains.get(&g.instance) {
                        g.track_gain_db = *gain;
                    }
                    if g.renderer.is_some() && !g.ended {
                        g.pending_mix = Some(change);
                        has_audio = true;
                    } else {
                        // The producer can retire a prefix 500ms before its
                        // audible suspension/EOF. Silent render state does not
                        // make the old PCM already sent to devices disappear.
                        let frame = if g.renderer.is_none() {
                            g.plan.join_frame.0
                        } else {
                            g.frame
                        };
                        idle_at = idle_at.max(g.time(frame).ok_or("room timeline overflow")?);
                    }
                    if let Some(renderer) = g.renderer.as_mut() {
                        renderer.set_prepared_next_crossfade(crossfade_ms);
                        if let Some((instance, gain)) = g.next_gain.as_mut() {
                            if let Some(updated) = gains.get(instance) {
                                *gain = *updated;
                                renderer
                                    .set_prepared_next_gain(*updated)
                                    .map_err(|e| e.to_string())?;
                            }
                        }
                        renderer
                            .set_dsp(DspParams {
                                track_gain_db: g.track_gain_db,
                                ..params
                            })
                            .map_err(|e| e.to_string())?;
                        renderer.set_volume(volume).map_err(|e| e.to_string())?;
                    }
                }
                if !has_audio {
                    self.emit(ProducerEvent::MixApplied {
                        change,
                        at: idle_at,
                    })?;
                }
            }
        }
        Ok(())
    }
    fn pull(&self, g: &mut Generation, horizon: u64) -> Result<(), String> {
        let rate = g.plan.format.sample_rate;
        let channels = usize::from(g.plan.format.channels);
        let block_frames = (rate / 50) as usize;
        if let Some(renderer) = g.renderer.as_mut() {
            if renderer.take_decode_failure() {
                return Err("shared track decoder failed".into());
            }
            if !g.prepared && renderer.buffered_frames() < block_frames && !renderer.decoded_eof() {
                return Ok(());
            }
        }
        if g.prepared
            && g.committed
            && !g.ended
            && g.renderer.is_some()
            && g.frame < frames_at(&g.plan, horizon)?
            && g.time(g.frame)
                .is_some_and(|deadline| self.clock.now_ns() > deadline.saturating_sub(20_000_000))
        {
            return Err(format!("shared decoder or successor missed the audio preparation deadline (epoch={}, frame={}, now_ns={}, deadline_ns={}, prepared={}, awaiting_next={}, committed={})",
                g.plan.epoch.0, g.frame, self.clock.now_ns(), g.time(g.frame).unwrap_or(0), g.prepared, g.awaiting_next, g.committed));
        }
        if !g.prepared {
            self.emit(ProducerEvent::Prepared {
                epoch: g.plan.epoch.0,
            })?;
            g.prepared = true;
            return Ok(());
        }
        if g.awaiting_next {
            return Ok(());
        }
        if let Some(renderer) = g.renderer.as_mut() {
            if !renderer.prepared_next_ready(block_frames) {
                return Ok(());
            }
            renderer.maintain();
        }
        if g.renderer.is_none() {
            return Ok(());
        }
        for _ in 0..30 {
            let limit = frames_at(&g.plan, horizon)?;
            if g.frame >= limit {
                break;
            }
            let remaining = usize::try_from(limit - g.frame).unwrap_or(usize::MAX);
            let mut frames = remaining.min(block_frames);
            if frames == 0 {
                break;
            }
            let mut samples = vec![0.0; frames * channels];
            let mut retry = false;
            if let Some(renderer) = g.renderer.as_mut().filter(|_| !g.ended) {
                let report = renderer.render_until_transition(&mut samples);
                let next_event = renderer.take_next_event();
                if let Some(NextEvent::Bypassed { reason, .. }) = &next_event {
                    self.emit(ProducerEvent::Error {
                        epoch: g.plan.epoch.0,
                        stage: FailureStage::Successor,
                        message: format!("next decoder unavailable: {reason}"),
                    })?;
                    renderer.clear_next();
                    g.next_gain = None;
                }
                if let Some(NextEvent::Transitioned { track_id, .. }) = next_event {
                    let instance = track_id.parse().map_err(|_| "invalid prepared instance")?;
                    let offset = report
                        .transition_frame
                        .ok_or("missing exact render boundary")?
                        as u64;
                    let trailing = report.source_frames.saturating_sub(offset as usize) as u64;
                    self.emit(ProducerEvent::Boundary {
                        epoch: g.plan.epoch.0,
                        frame: g.frame.checked_add(offset).ok_or("timeline overflow")?,
                        instance,
                        position_frames: renderer.position_frames().saturating_sub(trailing),
                    })?;
                    g.instance = instance;
                    frames = report.source_frames;
                    samples.truncate(frames * channels);
                    g.awaiting_next = true;
                    if let Some((next, gain)) =
                        g.next_gain.take().filter(|(next, _)| *next == instance)
                    {
                        let _ = next;
                        g.track_gain_db = gain;
                    }
                    if let Some(gain) = g.gain_overrides.get(&instance) {
                        g.track_gain_db = *gain;
                        renderer
                            .set_dsp(DspParams {
                                track_gain_db: *gain,
                                ..g.dsp
                            })
                            .map_err(|e| e.to_string())?;
                    }
                }
                if !g.awaiting_next && renderer.finished() {
                    let end = g
                        .frame
                        .checked_add(report.source_frames as u64)
                        .ok_or("timeline overflow")?;
                    self.emit(ProducerEvent::End {
                        epoch: g.plan.epoch.0,
                        frame: end,
                        instance: g.instance,
                    })?;
                    // Continue silence on the same room clock until a new plan;
                    // never repeatedly emit EOF or replay decoder tail samples.
                    g.ended = true;
                } else if report.source_frames < frames && report.transition_frame.is_none() {
                    // A decoder can briefly hold the sample queue or have more
                    // data in flight. Preserve only the consumed prefix; no
                    // silence or missing frames advance the shared timeline.
                    frames = report.source_frames;
                    samples.truncate(frames * channels);
                    retry = true;
                }
            }
            if frames == 0 {
                break;
            }
            if let Some(fade) = g.fade {
                for (offset, frame) in samples.chunks_exact_mut(channels).enumerate() {
                    let gain = fade.gain(g.frame.saturating_add(offset as u64));
                    for sample in frame {
                        *sample *= gain;
                    }
                }
            }
            self.emit(ProducerEvent::Pcm {
                epoch: g.plan.epoch.0,
                sequence: g.sequence,
                frame: g.frame,
                format: g.plan.format,
                samples: samples.into(),
            })?;
            if let Some(change) = g.pending_mix.take() {
                self.emit(ProducerEvent::MixApplied {
                    change,
                    at: g.time(g.frame).ok_or("room timeline overflow")?,
                })?;
            }
            g.frame = g
                .frame
                .checked_add(frames as u64)
                .ok_or("timeline overflow")?;
            g.sequence = g.sequence.checked_add(1).ok_or("sequence overflow")?;
            if let Some(fade) = g.fade.filter(|fade| g.frame >= fade.end) {
                self.emit(ProducerEvent::Suspended {
                    epoch: fade.epoch,
                    instance: g.instance,
                    position_frames: g.renderer.as_ref().map_or(0, |r| r.position_frames()),
                })?;
                g.fade = None;
            }
            if g.awaiting_next || retry {
                break;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vmusic_lan::protocol::Counter;
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    fn wave(frames: u32, rate: u32) -> Fixture {
        let samples = frames * 2;
        let size = samples * 2;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 4).to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&size.to_le_bytes());
        for _ in 0..samples {
            bytes.extend_from_slice(&4096i16.to_le_bytes());
        }
        let path =
            std::env::temp_dir().join(format!("hertz-producer-{}.wav", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        Fixture(path)
    }
    fn wait_ready(renderer: &RenderCore, next: bool) {
        let until = std::time::Instant::now() + Duration::from_secs(3);
        while if next {
            !renderer.prepared_next_ready(96_000)
        } else {
            !renderer.decoded_eof()
        } {
            assert!(std::time::Instant::now() < until);
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    fn prepared_worker(
        fixture: &Fixture,
    ) -> (
        Worker,
        async_mpsc::Receiver<ProducerEvent>,
        mpsc::Receiver<Generation>,
    ) {
        let (events, received) = async_mpsc::channel(128);
        let (retired, _retire_rx) = mpsc::sync_channel(2);
        let mut worker = Worker {
            clock: MonotonicClock::default(),
            events,
            stop: Arc::new(AtomicBool::new(false)),
            current: None,
            preparing: None,
            retired,
            deferred_mix: None,
        };
        worker
            .apply(Command::Prepare {
                plan: Plan {
                    epoch: Counter(1),
                    plan_id: Counter(1),
                    anchor_ns: Counter(1_000_000_000),
                    join_frame: Counter(0),
                    format: AudioFormat {
                        id: 1,
                        sample_rate: 48_000,
                        channels: 2,
                    },
                },
                source: Some(Source {
                    path: fixture.0.clone(),
                    instance: 1,
                    position_ms: 0,
                    track_gain_db: 0.0,
                }),
                dsp: DspParams::default(),
                volume: 1.0,
            })
            .unwrap();
        wait_ready(
            worker
                .preparing
                .as_ref()
                .unwrap()
                .renderer
                .as_ref()
                .unwrap(),
            false,
        );
        let mut generation = worker.preparing.take().unwrap();
        worker.pull(&mut generation, 1_200_000_000).unwrap();
        worker.preparing = Some(generation);
        worker
            .apply(Command::Next {
                epoch: 1,
                source: None,
                crossfade_ms: 0,
            })
            .unwrap();
        worker.current = worker.preparing.take();
        worker.current.as_mut().unwrap().committed = true;
        (worker, received, _retire_rx)
    }
    #[test]
    fn mixer_acknowledges_first_affected_pcm_instead_of_command_receipt() {
        let fixture = wave(96_000, 48_000);
        let (mut worker, mut received, _retire) = prepared_worker(&fixture);
        let mut generation = worker.current.take().unwrap();
        // Let the renderer's existing 250ms initial fade-in finish first.
        worker.pull(&mut generation, 1_300_000_000).unwrap();
        worker.current = Some(generation);
        while received.try_recv().is_ok() {}
        worker
            .apply(Command::Dsp {
                change: 7,
                params: DspParams::default(),
                volume: 0.25,
                gains: HashMap::new(),
                crossfade_ms: 0,
            })
            .unwrap();
        assert!(
            received.try_recv().is_err(),
            "receiving a command is not an audio boundary"
        );
        let mut generation = worker.current.take().unwrap();
        worker.pull(&mut generation, 1_500_000_000).unwrap();
        let mut saw_pcm = false;
        let mut acknowledgements = 0;
        while let Ok(event) = received.try_recv() {
            match event {
                ProducerEvent::Pcm { frame, samples, .. } => {
                    if !saw_pcm {
                        assert_eq!(frame, 14_400);
                    }
                    saw_pcm = true;
                    assert!(samples
                        .iter()
                        .all(|value| (*value - 0.03125).abs() < 0.00001));
                }
                ProducerEvent::MixApplied { change, at } => {
                    assert!(saw_pcm);
                    assert_eq!((change, at), (7, 1_300_000_000));
                    acknowledgements += 1;
                }
                _ => {}
            }
        }
        assert!(saw_pcm);
        assert_eq!(acknowledgements, 1);
    }
    #[test]
    fn committed_suspension_fades_real_pcm_and_confirms_resume_position() {
        let fixture = wave(96_000, 48_000);
        let (mut worker, mut received, _retire) = prepared_worker(&fixture);
        let mut generation = worker.current.take().unwrap();
        worker.pull(&mut generation, 1_800_000_000).unwrap();
        worker.pull(&mut generation, 1_800_000_000).unwrap();
        assert_eq!(generation.frame, 38_400);
        worker.current = Some(generation);
        while received.try_recv().is_ok() {}
        worker
            .apply(Command::Prepare {
                plan: Plan {
                    epoch: Counter(2),
                    plan_id: Counter(2),
                    anchor_ns: Counter(2_000_000_000),
                    join_frame: Counter(0),
                    format: AudioFormat {
                        id: 1,
                        sample_rate: 48_000,
                        channels: 2,
                    },
                },
                source: None,
                dsp: DspParams::default(),
                volume: 1.0,
            })
            .unwrap();
        worker.apply(Command::Commit { epoch: 2 }).unwrap();
        let mut generation = worker.current.take().unwrap();
        worker.pull(&mut generation, 2_000_000_000).unwrap();
        let mut samples = Vec::new();
        let mut suspended = None;
        while let Ok(event) = received.try_recv() {
            match event {
                ProducerEvent::Pcm { samples: block, .. } => samples.extend(block.iter().copied()),
                ProducerEvent::Suspended {
                    epoch,
                    instance,
                    position_frames,
                } => suspended = Some((epoch, instance, position_frames)),
                _ => {}
            }
        }
        assert_eq!(samples.len(), 9600 * 2);
        assert!((samples[0] - 0.125).abs() < 0.00001);
        assert!((samples[4800 * 2] - 0.0625).abs() < 0.00001);
        assert!(samples.last().unwrap().abs() < 0.00002);
        assert_eq!(suspended, Some((2, 1, 48_000)));
        assert_eq!(generation.frame, 48_000);
    }
    #[test]
    fn frozen_or_uncommitted_prefix_does_not_report_a_render_deadline_failure() {
        let fixture = wave(9600, 48_000);
        let (worker, _received, _retire) = prepared_worker(&fixture);
        let mut generation = worker.current.as_ref().unwrap().plan.clone();
        generation.anchor_ns = Counter(0);
        let mut current = worker.current.unwrap();
        current.plan = generation;
        let (events, _received) = async_mpsc::channel(128);
        let (retired, _retired_rx) = mpsc::sync_channel(2);
        let worker = Worker {
            clock: MonotonicClock::default(),
            events,
            stop: Arc::new(AtomicBool::new(false)),
            current: None,
            preparing: None,
            retired,
            deferred_mix: None,
        };
        worker.pull(&mut current, 0).unwrap();
        current.committed = false;
        worker.pull(&mut current, 200_000_000).unwrap();
    }
    #[test]
    fn cancelling_a_pause_releases_its_pcm_reservation_before_a_slow_replacement_source() {
        let fixture = wave(96_000, 48_000);
        let (mut worker, mut received, _retire) = prepared_worker(&fixture);
        worker
            .apply(Command::Prepare {
                plan: Plan {
                    epoch: Counter(2),
                    plan_id: Counter(2),
                    anchor_ns: Counter(2_000_000_000),
                    join_frame: Counter(0),
                    format: AudioFormat {
                        id: 1,
                        sample_rate: 48_000,
                        channels: 2,
                    },
                },
                source: None,
                dsp: DspParams::default(),
                volume: 1.0,
            })
            .unwrap();
        assert_eq!(worker.current_horizon(1_600_000_000, None), 1_800_000_000);
        worker.apply(Command::Cancel { epoch: 2 }).unwrap();
        assert_eq!(worker.current_horizon(1_600_000_000, None), 2_100_000_000);
        // A replacement may still be loading. The original renderer remains
        // free to produce real PCM beyond the cancelled suspension point.
        let mut generation = worker.current.take().unwrap();
        for _ in 0..2 {
            worker.pull(&mut generation, 2_100_000_000).unwrap();
        }
        assert_eq!(generation.frame, 52_800);
        assert!(generation.fade.is_none());
        assert!(!std::iter::from_fn(|| received.try_recv().ok())
            .any(|event| matches!(event, ProducerEvent::Suspended { .. })));
    }
    #[tokio::test]
    async fn started_overlap_keeps_its_source_and_defers_the_whole_mixer_until_promotion() {
        let gains = super::super::host::join_retry_tests::removed_successor_mix_gains().await;
        let a = wave(48_000, 48_000);
        // Leave B outside the renderer's final 500ms natural tail fade so the
        // first post-promotion PCM measures only the requested gain and volume.
        let b = wave(96_000, 48_000);
        let c = wave(48_000, 48_000);
        let (mut worker, mut received, _retire) = prepared_worker(&a);
        let source = |fixture: &Fixture, instance| Source {
            path: fixture.0.clone(),
            instance,
            position_ms: 0,
            track_gain_db: if instance == 2 { -12.0 } else { 0.0 },
        };
        worker
            .apply(Command::Next {
                epoch: 1,
                source: Some(source(&b, 2)),
                crossfade_ms: 500,
            })
            .unwrap();
        wait_ready(
            worker.current.as_ref().unwrap().renderer.as_ref().unwrap(),
            true,
        );
        let mut generation = worker.current.take().unwrap();
        for _ in 0..2 {
            worker.pull(&mut generation, 1_750_000_000).unwrap();
        }
        worker.current = Some(generation);
        assert!(worker.overlap_started());
        while received.try_recv().is_ok() {}
        worker
            .apply(Command::Next {
                epoch: 1,
                source: Some(source(&c, 3)),
                crossfade_ms: 0,
            })
            .unwrap();
        assert_eq!(worker.current.as_ref().unwrap().next_gain.unwrap().0, 2);
        assert!(matches!(
            received.try_recv(),
            Ok(ProducerEvent::SuccessorPrepared {
                instance: Some(2),
                ..
            })
        ));
        worker
            .apply(Command::Dsp {
                change: 9,
                params: DspParams::default(),
                volume: 0.5,
                gains,
                crossfade_ms: 1000,
            })
            .unwrap();
        assert!(worker.deferred_mix.is_some());
        assert!(received.try_recv().is_err());
        let mut generation = worker.current.take().unwrap();
        worker.pull(&mut generation, 2_000_000_000).unwrap();
        assert_eq!(generation.instance, 2);
        assert_eq!(generation.frame, 48_000);
        worker.current = Some(generation);
        assert!(!worker.overlap_started());
        let mixer = worker.deferred_mix.take().unwrap();
        worker.apply(mixer).unwrap();
        worker
            .apply(Command::Next {
                epoch: 1,
                source: None,
                crossfade_ms: 0,
            })
            .unwrap();
        while received.try_recv().is_ok() {}
        let mut generation = worker.current.take().unwrap();
        worker.pull(&mut generation, 2_100_000_000).unwrap();
        let mut applied = None;
        let mut first_pcm_at = None;
        while let Ok(event) = received.try_recv() {
            match event {
                ProducerEvent::Pcm { frame, samples, .. } => {
                    first_pcm_at.get_or_insert(1_000_000_000 + frame * 1_000_000_000 / 48_000);
                    // B started at -12dB, then Owner's off-mode preflight resets
                    // it to 0dB at the first affected PCM block after promotion.
                    assert!(samples
                        .iter()
                        .all(|sample| (*sample - 0.0625).abs() < 0.00001));
                }
                ProducerEvent::MixApplied { change, at } => {
                    assert_eq!(first_pcm_at, Some(at));
                    applied = Some((change, at));
                }
                _ => {}
            }
        }
        assert_eq!(applied, Some((9, 2_000_000_000)));
        assert_eq!(generation.track_gain_db, 0.0);
        assert_eq!(generation.crossfade_override, Some(1000));
    }
    #[test]
    fn preflight_gain_change_updates_both_decks_at_one_pcm_boundary() {
        let a = wave(48_000, 48_000);
        let b = wave(48_000, 48_000);
        let (mut worker, mut received, _retire) = prepared_worker(&a);
        worker
            .apply(Command::Next {
                epoch: 1,
                source: Some(Source {
                    path: b.0.clone(),
                    instance: 2,
                    position_ms: 0,
                    track_gain_db: 0.0,
                }),
                crossfade_ms: 500,
            })
            .unwrap();
        wait_ready(
            worker.current.as_ref().unwrap().renderer.as_ref().unwrap(),
            true,
        );
        let mut generation = worker.current.take().unwrap();
        worker.pull(&mut generation, 1_300_000_000).unwrap();
        worker.current = Some(generation);
        while received.try_recv().is_ok() {}
        worker
            .apply(Command::Dsp {
                change: 3,
                params: DspParams::default(),
                volume: 1.0,
                gains: HashMap::from([(1, 0.0), (2, -12.0)]),
                crossfade_ms: 500,
            })
            .unwrap();
        let mut generation = worker.current.take().unwrap();
        worker.pull(&mut generation, 1_760_000_000).unwrap();
        let mut midpoint = None;
        while let Ok(event) = received.try_recv() {
            if let ProducerEvent::Pcm { frame, samples, .. } = event {
                if frame <= 36_000 && frame + samples.len() as u64 / 2 > 36_000 {
                    midpoint = Some(samples[(36_000 - frame) as usize * 2]);
                }
            }
        }
        let expected =
            0.125 * std::f32::consts::FRAC_1_SQRT_2 * 0.88 * (1.0 + 10.0f32.powf(-12.0 / 20.0));
        assert!((midpoint.unwrap() - expected).abs() < 0.0001);
    }
    #[test]
    fn short_three_track_chain_waits_for_successor_and_emits_contiguous_pcm() {
        for fade in [0, 500] {
            let a = wave(576, 48_000);
            let b = wave(576, 48_000);
            let c = wave(2304, 48_000);
            let (events, mut received) = async_mpsc::channel(128);
            let (retired, _retire_rx) = mpsc::sync_channel(2);
            let mut worker = Worker {
                clock: MonotonicClock::default(),
                events,
                stop: Arc::new(AtomicBool::new(false)),
                current: None,
                preparing: None,
                retired,
                deferred_mix: None,
            };
            let plan = Plan {
                epoch: Counter(1),
                plan_id: Counter(1),
                anchor_ns: Counter(1_000_000_000),
                join_frame: Counter(0),
                format: AudioFormat {
                    id: 1,
                    sample_rate: 48_000,
                    channels: 2,
                },
            };
            let source = |f: &Fixture, instance| Source {
                path: f.0.clone(),
                instance,
                position_ms: 0,
                track_gain_db: -(instance as f32),
            };
            worker
                .apply(Command::Prepare {
                    plan,
                    source: Some(source(&a, 1)),
                    dsp: DspParams::default(),
                    volume: 1.0,
                })
                .unwrap();
            wait_ready(
                worker
                    .preparing
                    .as_ref()
                    .unwrap()
                    .renderer
                    .as_ref()
                    .unwrap(),
                false,
            );
            let pull = |worker: &mut Worker| {
                let mut g = worker.preparing.take().unwrap();
                worker.pull(&mut g, 1_500_000_000).unwrap();
                worker.preparing = Some(g);
            };
            let pull_to_boundary = |worker: &mut Worker| {
                let until = std::time::Instant::now() + Duration::from_secs(3);
                while !worker.preparing.as_ref().unwrap().awaiting_next {
                    pull(worker);
                    assert!(
                        std::time::Instant::now() < until,
                        "successor did not reach its boundary"
                    );
                    std::thread::yield_now();
                }
            };
            pull(&mut worker);
            assert!(matches!(
                received.try_recv(),
                Ok(ProducerEvent::Prepared { .. })
            ));
            pull(&mut worker);
            assert!(
                received.try_recv().is_err(),
                "must wait for owner before tail maintenance"
            );
            worker
                .apply(Command::Next {
                    epoch: 1,
                    source: Some(source(&b, 2)),
                    crossfade_ms: fade,
                })
                .unwrap();
            wait_ready(
                worker
                    .preparing
                    .as_ref()
                    .unwrap()
                    .renderer
                    .as_ref()
                    .unwrap(),
                true,
            );
            pull_to_boundary(&mut worker);
            assert!(worker.preparing.as_ref().unwrap().awaiting_next);
            let frame = worker.preparing.as_ref().unwrap().frame;
            pull(&mut worker);
            assert_eq!(worker.preparing.as_ref().unwrap().frame, frame);
            worker
                .apply(Command::Next {
                    epoch: 1,
                    source: Some(source(&c, 3)),
                    crossfade_ms: fade,
                })
                .unwrap();
            wait_ready(
                worker
                    .preparing
                    .as_ref()
                    .unwrap()
                    .renderer
                    .as_ref()
                    .unwrap(),
                true,
            );
            pull_to_boundary(&mut worker);
            let g = worker.preparing.as_ref().unwrap();
            assert!(g.awaiting_next);
            assert!(!g.ended);
            assert_eq!(g.instance, 3);
            let mut boundaries = Vec::new();
            let mut expected = 0;
            let mut sequence = 0;
            while let Ok(event) = received.try_recv() {
                match event {
                    ProducerEvent::Pcm {
                        frame,
                        sequence: seq,
                        samples,
                        ..
                    } => {
                        assert_eq!(frame, expected);
                        assert_eq!(seq, sequence);
                        sequence += 1;
                        expected += samples.len() as u64 / 2;
                    }
                    ProducerEvent::Boundary { instance, .. } => boundaries.push(instance),
                    ProducerEvent::End { .. } | ProducerEvent::Error { .. } => {
                        panic!("chain ended before third successor: {event:?}")
                    }
                    _ => {}
                }
            }
            assert_eq!(boundaries, [2, 3]);
            assert_eq!(expected, worker.preparing.as_ref().unwrap().frame);
        }
    }
}
