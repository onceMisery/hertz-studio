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
        "begin" if !guard.running => {
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
                    let assets = AssetStore::new(&base)?;
                    let jobs = Arc::new(ImportJobs::start(
                        library,
                        assets,
                        ProbeClient::native(proxy.clone())
                            .suppress_frames_for_test(command.suppress_frames),
                    ));
                    state().lock().unwrap().jobs = Some(Arc::clone(&jobs));
                    jobs.submit(
                        command.name.clone(),
                        base.join("probe-inputs")
                            .join(format!("{}.hwpkg", command.name)),
                    )?;
                    loop {
                        if let Some(status) = jobs.status(&command.name) {
                            if matches!(
                                status.state,
                                JobState::Done | JobState::Failed | JobState::Cancelled
                            ) {
                                return Ok::<_, JobError>(serde_json::to_value(status).unwrap());
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
                send(value);
            });
        }
        _ => send(serde_json::json!({"error": "budget_busy"})),
    }
}
