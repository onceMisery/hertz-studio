// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 仅 debug feature 的原生回归驱动；只从隔离配置的 probe-inputs 读取固定包名。
use super::*;
use crate::wallpaper::{
    assets::AssetStore,
    jobs::{ImportJobs, JobState},
    library::Library,
};
use std::sync::{Condvar, Mutex, OnceLock};

// Observation only: the original job and workspace retain every resource.
// Both barriers are inside raster(), never inside the later PNG qualifier.
pub(crate) const MAX_SVG_BARRIER_MS: u32 = 8_000;
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SvgBarrier {
    BeforeCancelCheck,
    AfterCancelCheckBeforeResvg,
}

struct SvgObservation {
    source_hash: Option<String>,
    phase: &'static str,
    paused: bool,
    released: bool,
    expired: bool,
    entered: bool,
    entered_at: Option<Instant>,
    pixmap_allocations: u32,
    resvg_calls: u32,
    resvg_returns: u32,
    records: Vec<serde_json::Value>,
}

pub(crate) struct SvgRenderProbe {
    job: String,
    boundary: Option<SvgBarrier>,
    token: String,
    started: Instant,
    hold: Duration,
    observation: Mutex<SvgObservation>,
    changed: Condvar,
}

impl SvgRenderProbe {
    fn new(job: String, boundary: Option<SvgBarrier>) -> Arc<Self> {
        Self::create(
            job,
            boundary,
            Duration::from_millis(MAX_SVG_BARRIER_MS.into()),
        )
    }
    fn create(job: String, boundary: Option<SvgBarrier>, hold: Duration) -> Arc<Self> {
        Arc::new(Self {
            job,
            boundary,
            token: uuid::Uuid::new_v4().simple().to_string(),
            started: Instant::now(),
            hold,
            observation: Mutex::new(SvgObservation {
                source_hash: None,
                phase: "armed",
                paused: false,
                released: false,
                expired: false,
                entered: false,
                entered_at: None,
                pixmap_allocations: 0,
                resvg_calls: 0,
                resvg_returns: 0,
                records: Vec::new(),
            }),
            changed: Condvar::new(),
        })
    }
    fn record(&self, state: &mut SvgObservation, phase: &'static str) {
        state.phase = phase;
        if state.records.len() < 32 {
            state.records.push(serde_json::json!({"phase":phase,
                "elapsedMicros":self.started.elapsed().as_micros().min(u64::MAX.into()) as u64,
                "threadId":format!("{:?}",std::thread::current().id()),
                "prepareTasks":global_budget().usage().prepare_tasks,
                "prepareCpuBytes":global_budget().usage().prepare_cpu_bytes}));
        }
    }
    pub(crate) fn event(&self, phase: &'static str, source: Option<&str>) {
        let mut state = self.observation.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(source) = source {
            state.source_hash = Some(source.into());
        }
        match phase {
            "pixmap_allocated" => state.pixmap_allocations += 1,
            "resvg_enter" => state.resvg_calls += 1,
            "resvg_exit" => state.resvg_returns += 1,
            _ => {}
        }
        self.record(&mut state, phase);
    }
    pub(crate) fn barrier(&self, boundary: SvgBarrier) {
        let mut state = self.observation.lock().unwrap_or_else(|e| e.into_inner());
        if self.boundary != Some(boundary) || state.entered {
            return;
        }
        state.entered = true;
        state.entered_at = Some(Instant::now());
        state.paused = true;
        self.record(&mut state, "raster_test_barrier_enter");
        self.changed.notify_all();
        let deadline = state.entered_at.expect("entered raster barrier") + self.hold;
        while !state.released && !state.expired {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                state.expired = true;
                self.record(&mut state, "raster_test_barrier_deadline");
                break;
            }
            state = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        state.paused = false;
        self.record(&mut state, "raster_test_barrier_exit");
    }
    fn release(&self, job: &str, token: Option<&str>) -> bool {
        let mut state = self.observation.lock().unwrap_or_else(|e| e.into_inner());
        if job != self.job || token != Some(self.token.as_str()) || !state.paused || state.expired {
            return false;
        }
        if state.entered_at.is_some_and(|at| at.elapsed() >= self.hold) {
            state.expired = true;
            self.record(&mut state, "raster_test_barrier_deadline");
            self.changed.notify_all();
            return false;
        }
        state.released = true;
        self.record(&mut state, "raster_test_barrier_release");
        self.changed.notify_all();
        true
    }
    fn snapshot(&self) -> serde_json::Value {
        let state = self.observation.lock().unwrap_or_else(|e| e.into_inner());
        serde_json::json!({"jobId":self.job,"pid":std::process::id(),
            "inputHash":state.source_hash,"boundary":self.boundary,"barrierToken":self.token,
            "maxBarrierMs":MAX_SVG_BARRIER_MS,"phase":state.phase,"paused":state.paused,
            "released":state.released,"expired":state.expired,
            "pixmapAllocations":state.pixmap_allocations,"resvgCalls":state.resvg_calls,
            "resvgReturns":state.resvg_returns,"records":state.records,
            "scope":"debug native raster test barrier; not a delay inside resvg or PNG qualification"})
    }
}

#[cfg(test)]
mod svg_lifecycle_tests {
    use super::*;
    use crate::wallpaper::{budget::MAX_PREPARE_CPU_BYTES, library::tempfileish};

    #[test]
    fn svg_barrier_expires_without_releasing_any_resource_owner() {
        let gate = SvgRenderProbe::create(
            "deadline".into(),
            Some(SvgBarrier::BeforeCancelCheck),
            Duration::from_millis(20),
        );
        gate.barrier(SvgBarrier::BeforeCancelCheck);
        let snapshot = gate.snapshot();
        assert_eq!(snapshot["expired"], true);
        assert_eq!(snapshot["paused"], false);
        assert_eq!(snapshot["released"], false);
        assert_eq!(snapshot["resvgCalls"], 0);
        assert!(!gate.release("deadline", Some(&gate.token)));
    }

    #[tokio::test]
    async fn svg_cancel_boundaries_keep_original_job_and_workspace_until_raster_exit() {
        for (boundary, calls) in [
            (SvgBarrier::BeforeCancelCheck, 0),
            (SvgBarrier::AfterCancelCheckBeforeResvg, 1),
        ] {
            let dir = tempfileish::temp_dir("svg-cancel-boundary");
            let gate = SvgRenderProbe::new("svg-cancel".into(), Some(boundary));
            let probe = ProbeClient::testing(|_, _| Box::pin(async { Ok(()) }))
                .svg_render_for_test(Some(Arc::clone(&gate)));
            let budget = probe.budget_for_test();
            let jobs = ImportJobs::start(
                Library::open(dir.path()).await.unwrap(),
                AssetStore::new(dir.path()).unwrap(),
                probe,
            );
            let source = dir.path().join("source.svg");
            std::fs::write(&source, br###"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="red"/></svg>"###).unwrap();
            let id = jobs.submit("svg-cancel".into(), source.clone()).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while gate.snapshot()["paused"] != true {
                assert!(
                    Instant::now() < deadline,
                    "the real raster must reach its barrier"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            jobs.cancel(&id);
            gate.event("cancel_requested", None);
            assert_eq!(jobs.status(&id).unwrap().state, JobState::Preparing);
            assert_eq!(budget.usage().prepare_tasks, 1);
            assert_eq!(budget.usage().prepare_cpu_bytes, MAX_PREPARE_CPU_BYTES);
            assert_eq!(
                jobs.submit("next".into(), source.clone()).unwrap_err().code,
                "budget_busy"
            );
            assert!(!gate.release("another-job", Some(&gate.token)));
            assert!(!gate.release(&id, Some("wrong-token")));
            assert_eq!(gate.snapshot()["paused"], true);
            assert!(gate.release(&id, Some(&gate.token)));
            let deadline = Instant::now() + Duration::from_secs(3);
            while jobs.status(&id).unwrap().state != JobState::Cancelled {
                assert!(
                    Instant::now() < deadline,
                    "cancellation must finish after raster exit"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let snapshot = gate.snapshot();
            assert_eq!(snapshot["resvgCalls"], calls);
            assert_eq!(snapshot["resvgReturns"], calls);
            assert_eq!(snapshot["pixmapAllocations"], calls);
            assert_eq!(snapshot["expired"], false);
            let phases: Vec<_> = snapshot["records"]
                .as_array()
                .unwrap()
                .iter()
                .map(|record| record["phase"].as_str().unwrap())
                .collect();
            assert!(
                phases.iter().position(|p| *p == "raster_exit").unwrap()
                    < phases
                        .iter()
                        .position(|p| *p == "workspace_finished")
                        .unwrap()
            );
            if calls == 1 {
                assert!(
                    phases
                        .iter()
                        .position(|p| *p == "cancel_requested")
                        .unwrap()
                        < phases.iter().position(|p| *p == "resvg_enter").unwrap()
                );
            }
            assert_eq!(budget.usage().prepare_tasks, 0);
            assert_eq!(budget.usage().prepare_cpu_bytes, 0);
            jobs.submit("next".into(), source).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while jobs.status("next").unwrap().state != JobState::Done {
                assert!(
                    Instant::now() < deadline,
                    "the original slot must accept the next input"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    }
}

#[derive(Default)]
struct State {
    running: bool,
    jobs: Option<Arc<ImportJobs>>,
    held: Option<Reservation>,
    svg: Option<Arc<SvgRenderProbe>>,
    probe: Option<ProbeClient>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

pub(crate) fn command(body: &str, proxy: EventLoopProxy<UserEvent>) {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Command {
        nonce: u64,
        action: String,
        name: String,
        #[serde(default)]
        suppress_frames: bool,
        #[serde(default)]
        force_probe: bool,
        #[serde(default)]
        block_close: bool,
        #[serde(default)]
        hold_font_ready: bool,
        #[serde(default)]
        hold_font_read_ms: Option<u32>,
        #[serde(default)]
        hold_media_ready: bool,
        #[serde(default)]
        hold_media_read_ms: Option<u32>,
        #[serde(default)]
        observe_svg: bool,
        #[serde(default)]
        svg_render_barrier: Option<SvgBarrier>,
        #[serde(default)]
        svg_barrier_token: Option<String>,
        #[serde(default)]
        content_capacity_bytes: Option<u64>,
        #[serde(default)]
        image_target: Option<super::super::image_prepare::ImageTarget>,
        #[serde(default)]
        reference: Option<super::super::target_planner::AssetRef>,
        #[serde(default)]
        font_text: Option<String>,
    }
    let Ok(command) = serde_json::from_str::<Command>(body) else {
        return;
    };
    if command.name.is_empty()
        || command.name.len() > 64
        || !command
            .name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return;
    }
    let reply_proxy = proxy.clone();
    let send = move |value| {
        let _ = reply_proxy.send_event(UserEvent::WallpaperProbeTestResult(command.nonce, value));
    };
    if command.hold_font_read_ms.is_some_and(|milliseconds| {
        command.action != "prepare-font"
            || !command.force_probe
            || !command.hold_font_ready
            || !command.block_close
            || !(super::super::istream::read_probe::MIN_HOLD_MS
                ..=super::super::istream::read_probe::MAX_HOLD_MS)
                .contains(&milliseconds)
    }) {
        send(serde_json::json!({"error":"invalid_input"}));
        return;
    }
    if command.hold_media_read_ms.is_some_and(|milliseconds| {
        !matches!(command.action.as_str(), "begin" | "prepare")
            || !command.force_probe
            || !command.hold_media_ready
            || !command.block_close
            || !(500..=MAX_SVG_BARRIER_MS).contains(&milliseconds)
    }) || (command.observe_svg && !matches!(command.action.as_str(), "begin" | "prepare"))
        || (command.svg_render_barrier.is_some() && !command.observe_svg)
    {
        send(serde_json::json!({"error":"invalid_input"}));
        return;
    }
    let mut guard = state().lock().unwrap();
    match command.action.as_str() {
        "try-begin" if guard.running => {
            // Exercise the existing active job's admission owner, rather than
            // treating this harness's running flag as proof of slot rejection.
            let Some(jobs) = guard.jobs.as_ref() else {
                send(serde_json::json!({"error":"probe_inconclusive"}));
                return;
            };
            let active = jobs.active_status();
            let result = jobs.submit_for_target(
                command.name.clone(),
                crate::config::base_dir()
                    .join("probe-inputs")
                    .join(format!("{}.hwpkg", command.name)),
                command.image_target,
            );
            send(match result {
                Ok(job) => {
                    serde_json::json!({"submitted":true,"jobId":job,"owner":"ImportJobs.reserve","activeJob":active})
                }
                Err(error) => {
                    serde_json::json!({"submitted":false,"error":error.code,"owner":"ImportJobs.reserve","activeJob":active})
                }
            });
        }
        "cancel" => {
            if let Some(jobs) = guard.jobs.as_ref() {
                jobs.cancel(&command.name);
            }
            if let Some(svg) = guard.svg.as_ref().filter(|svg| svg.job == command.name) {
                svg.event("cancel_requested", None);
            }
            send(serde_json::json!({"cancelRequested": true}));
        }
        "svg-observe" | "svg-release" => {
            let accepted = guard.svg.as_ref().is_some_and(|svg| {
                svg.job == command.name
                    && (command.action == "svg-observe"
                        || svg.release(&command.name, command.svg_barrier_token.as_deref()))
            });
            let usage = global_budget().usage();
            let job = guard
                .jobs
                .as_ref()
                .and_then(|jobs| jobs.status(&command.name));
            let (hits, runs) = guard
                .probe
                .as_ref()
                .map(ProbeClient::stats)
                .unwrap_or_default();
            send(
                serde_json::json!({"accepted":accepted,"svgRender":guard.svg.as_ref().map(|svg|svg.snapshot()),
                "job":job,"prepareTasks":usage.prepare_tasks,"prepareCpuBytes":usage.prepare_cpu_bytes,
                "cacheHits":hits,"probeRuns":runs}),
            );
        }
        "hold" => {
            let mut request = empty_request("harness-decoder-hold".into());
            request.decoders = 2;
            if guard.held.is_some() {
                send(serde_json::json!({"held": true}));
            } else {
                match Reservation::grant(global_budget(), request) {
                    Ok(reservation) => {
                        guard.held = Some(reservation);
                        send(serde_json::json!({"held": true}));
                    }
                    Err(error) => send(serde_json::json!({"error": error.to_string()})),
                }
            }
        }
        "release" => {
            if let Some(reservation) = guard.held.take() {
                reservation.finish();
            }
            send(serde_json::json!({"held": false}));
        }
        "begin" | "prepare" | "prepare-font" | "resolve" if !guard.running => {
            guard.running = true;
            guard.svg = command
                .observe_svg
                .then(|| SvgRenderProbe::new(command.name.clone(), command.svg_render_barrier));
            let svg = guard.svg.clone();
            drop(guard);
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                let result = runtime.block_on(async {
                    let base = crate::config::base_dir();
                    let library = Library::open(&base).await?;
                    let mut assets = AssetStore::new(&base)?;
                    if let Some(capacity) = command.content_capacity_bytes {
                        assets = assets.with_content_capacity(capacity);
                    }
                    let probe = ProbeClient::native(proxy.clone())
                        .suppress_frames_for_test(command.suppress_frames)
                        .force_probe_for_test(command.force_probe)
                        .block_close_for_test(command.block_close)
                        .hold_font_ready_for_test(command.hold_font_ready)
                        .hold_font_read_for_test(command.hold_font_read_ms)
                        .hold_media_read_for_test(command.hold_media_ready, command.hold_media_read_ms)
                        .svg_render_for_test(svg);
                    state().lock().unwrap().probe = Some(probe.clone());
                    if command.action == "resolve" {
                        let reference = command.reference.as_ref().ok_or_else(|| JobError::invalid_input("缺少 AssetRef"))?;
                        let target = command.image_target.ok_or_else(|| JobError::invalid_input("缺少目标"))?;
                        let resolution = super::super::target_planner::resolve(
                            &assets, &library, reference, target,
                            &["image/png".into(), "video/mp4".into(), "video/webm".into()],
                            &AtomicBool::new(false),
                        ).await?;
                        return Ok::<_, JobError>(match resolution {
                            super::super::target_planner::Resolution::PrepareRequired(request) => serde_json::json!({
                                "resolution": "prepare_required", "request": request,
                            }),
                            super::super::target_planner::Resolution::Ready(media) => {
                                let request = media.budget_request("harness-plan".into(), 1)?;
                                serde_json::json!({
                                    "resolution": "ready", "reference": media.reference(), "target": media.target(),
                                    "contentKey": media.content_key(), "url": media.url(),
                                    "width": media.input().metadata.display_width, "height": media.input().metadata.display_height,
                                    "metadata": media.input().metadata,
                                    "decoderSlotsRequired": request.decoders, "cpuBytesRequired": request.cpu_bytes,
                                    "gpuBytesRequired": request.gpu_bytes, "decodePixelRate": request.decode_pixel_rate,
                                    "outputPixelRate": request.output_pixel_rate,
                                })
                            }
                        });
                    }
                    let font_request = if command.action == "prepare-font" {
                        let reference = command.reference.as_ref().ok_or_else(|| JobError::invalid_input("缺少字体 AssetRef"))?;
                        let text = command.font_text.as_ref().ok_or_else(|| JobError::invalid_input("缺少字体检查文本"))?;
                        if text.encode_utf16().count() > 4096 {
                            return Err(JobError::invalid_input("字体检查文本超过上限"));
                        }
                        let package = assets.read_installed_manifest(&reference.package_hash)?;
                        let asset = package.manifest.assets.iter().find(|asset| asset.id == reference.asset_id)
                            .ok_or_else(|| JobError::invalid_input("字体资源不存在"))?;
                        let entry = package.entries.iter().find(|entry| entry.path == asset.source)
                            .ok_or_else(|| JobError::invalid_input("字体条目不存在"))?;
                        Some(super::super::jobs::FontPrepareRequest {
                            reference: reference.clone(), expected_entry: entry.clone(),
                            required_texts: vec![super::super::font_prepare::RequiredText { node_id: "probe-text".into(), text: text.clone() }],
                        })
                    } else { None };
                    let jobs = Arc::new(ImportJobs::start(library, assets, probe.clone()));
                    state().lock().unwrap().jobs = Some(Arc::clone(&jobs));
                    let font_reply = if let Some(request) = font_request {
                        Some(jobs.prepare_font(command.name.clone(), request)?.1)
                    } else if command.action == "prepare" {
                        jobs.prepare_asset(command.name.clone(), super::super::target_planner::PrepareRequest {
                            reference: command.reference.ok_or_else(|| JobError::invalid_input("缺少 AssetRef"))?,
                            target: command.image_target.ok_or_else(|| JobError::invalid_input("缺少目标"))?,
                        })?;
                        None
                    } else {
                        jobs.submit_for_target(
                            command.name.clone(),
                            base.join("probe-inputs").join(format!("{}.hwpkg", command.name)),
                            command.image_target,
                        )?;
                        None
                    };
                    loop {
                        if let Some(status) = jobs.status(&command.name) {
                            if matches!(
                                status.state,
                                JobState::Done | JobState::Failed | JobState::Cancelled
                            ) {
                                let mut value = serde_json::to_value(status).unwrap();
                                let (hits, runs) = probe.stats();
                                value["cacheHits"] = serde_json::json!(hits);
                                value["probeRuns"] = serde_json::json!(runs);
                                if let Some(reply) = font_reply {
                                    match reply.await.map_err(|_| JobError::new("probe_inconclusive", "字体任务回执丢失"))? {
                                        Ok(font) => {
                                            value["preparedFont"] = serde_json::json!({"reference":font.reference(),
                                                "contentKey":font.content_key(),"url":font.url(),
                                                "metadata":font.input().metadata,"adapterId":font.adapter_id(),
                                                "adapterVersion":font.adapter_version()});
                                        }
                                        Err(error) => value["fontError"] = serde_json::json!({"code":error.code,
                                            "message":error.message,"details":error.details}),
                                    }
                                }
                                if let Some(snapshot) = probe.held_read_snapshot_for_test() {
                                    value["heldIstreamRead"] = serde_json::to_value(snapshot).unwrap();
                                }
                                if let Some(svg) = &probe.svg_render {
                                    svg.event("job_terminal", None);
                                    value["svgRender"] = svg.snapshot();
                                }
                                return Ok::<_, JobError>(value);
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                });
                let mut guard = state().lock().unwrap();
                guard.jobs = None;
                guard.running = false;
                drop(guard);
                let mut value =
                    result.unwrap_or_else(|error| serde_json::json!({"error": error.to_string()}));
                let usage = global_budget().usage();
                value["activeStreams"] =
                    serde_json::json!(super::super::media_stream::global_pool().active());
                value["decoderSlots"] = serde_json::json!(usage.decoder_slots);
                value["prepareTasks"] = serde_json::json!(usage.prepare_tasks);
                value["prepareCpuBytes"] = serde_json::json!(usage.prepare_cpu_bytes);
                value["cpuBytes"] = serde_json::json!(usage.cpu_bytes);
                value["gpuBytes"] = serde_json::json!(usage.gpu_bytes);
                send(value);
            });
        }
        _ => send(serde_json::json!({"error": "budget_busy"})),
    }
}
