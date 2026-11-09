// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 仅 debug feature 的原生回归驱动；只从隔离配置的 probe-inputs 读取固定包名。
use super::*;
use crate::wallpaper::{
    assets::AssetStore,
    jobs::{ImportJobs, JobState},
    library::Library,
};
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
struct State {
    running: bool,
    jobs: Option<Arc<ImportJobs>>,
    held: Option<Reservation>,
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
    let mut guard = state().lock().unwrap();
    match command.action.as_str() {
        "cancel" => {
            if let Some(jobs) = guard.jobs.as_ref() {
                jobs.cancel(&command.name);
            }
            send(serde_json::json!({"cancelRequested": true}));
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
                        .hold_font_read_for_test(command.hold_font_read_ms);
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
