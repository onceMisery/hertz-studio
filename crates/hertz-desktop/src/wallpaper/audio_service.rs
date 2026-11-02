// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! One system loopback/FFT owner for all wallpaper consumers. Requests and output each keep
//! only the latest value. Native open/join and device discovery never run on the UI thread.
use super::{
    audio::{SampleRing, SpectrumAnalyzer, BANDS, FFT_SIZE},
    audio_capture::{self, CaptureExit, CaptureHandle, CaptureInfo},
    audio_devices::{DeviceWatch, Endpoint, EndpointKey},
    config::AudioDevice,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

const FRAME_INTERVAL: Duration = Duration::from_nanos(33_333_334);

#[derive(Clone)]
pub(crate) struct Frame {
    pub generation: u64,
    pub seq: u64,
    pub bands: [f32; BANDS],
    pub captured_at: Instant,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub generation: u64,
    pub requested: Option<AudioDevice>,
    pub phase: &'static str,
    pub capture_active: bool,
    pub info: Option<CaptureInfo>,
    pub error: Option<String>,
    pub dropped: u64,
    pub endpoints: Vec<Endpoint>,
    #[serde(skip)]
    pub frame: Option<Frame>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            generation: 0,
            requested: None,
            phase: "idle",
            capture_active: false,
            info: None,
            error: None,
            dropped: 0,
            endpoints: Vec::new(),
            frame: None,
        }
    }
}
struct State {
    snapshot: Snapshot,
    shutdown: bool,
}
struct Shared {
    state: Mutex<State>,
    wake: Condvar,
    pending: AtomicBool,
    notify: Arc<dyn Fn() + Send + Sync>,
}
impl Shared {
    fn changed(&self) {
        if !self.pending.swap(true, Ordering::AcqRel) {
            (self.notify)();
        }
    }
    fn wake(&self) {
        self.wake.notify_one();
    }
}

pub(crate) struct AudioService {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}
impl AudioService {
    pub(crate) fn start(notify: Arc<dyn Fn() + Send + Sync>) -> Result<Self, String> {
        Self::with_backend(notify, |wake| {
            Ok(Box::new(NativeBackend(DeviceWatch::open(wake)?)))
        })
    }
    fn with_backend<F>(notify: Arc<dyn Fn() + Send + Sync>, mut factory: F) -> Result<Self, String>
    where
        F: FnMut(Arc<dyn Fn() + Send + Sync>) -> Result<Box<dyn Backend>, String> + Send + 'static,
    {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                snapshot: Snapshot::default(),
                shutdown: false,
            }),
            wake: Condvar::new(),
            pending: AtomicBool::new(false),
            notify,
        });
        let inner = Arc::clone(&shared);
        let worker = std::thread::Builder::new()
            .name("hertz-wallpaper-audio-owner".into())
            .spawn(move || {
                let weak = Arc::downgrade(&inner);
                let wake: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
                    if let Some(shared) = weak.upgrade() {
                        shared.wake();
                    }
                });
                loop {
                    match factory(Arc::clone(&wake)) {
                        Ok(backend) => {
                            run(Arc::clone(&inner), backend);
                            break;
                        }
                        Err(error) => {
                            let mut state = inner.state.lock().unwrap();
                            let failed_generation = state.snapshot.generation;
                            state.snapshot.phase = "failed";
                            state.snapshot.error = Some(error);
                            drop(state);
                            inner.changed();
                            let mut state = inner.state.lock().unwrap();
                            while !state.shutdown && state.snapshot.generation == failed_generation
                            {
                                state = inner.wake.wait(state).unwrap();
                            }
                            if state.shutdown {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|error| format!("启动系统音频 owner 失败：{error}"))?;
        Ok(Self {
            shared,
            worker: Some(worker),
        })
    }
    /// Changing consumer demand clears old output immediately; native joining follows in the owner.
    pub(crate) fn request(&self, device: Option<AudioDevice>) -> u64 {
        let mut state = self.shared.state.lock().unwrap();
        if state.snapshot.requested != device {
            state.snapshot.generation += 1;
            state.snapshot.requested = device;
            state.snapshot.frame = None;
            state.snapshot.error = None;
            state.snapshot.phase = if state.snapshot.capture_active {
                "stopping"
            } else {
                "pending"
            };
            self.shared.wake();
        }
        state.snapshot.generation
    }
    pub(crate) fn retry(&self) {
        let mut state = self.shared.state.lock().unwrap();
        if state.snapshot.requested.is_some() {
            state.snapshot.generation += 1;
            state.snapshot.frame = None;
            state.snapshot.error = None;
            self.shared.wake();
        }
    }
    pub(crate) fn snapshot(&self) -> Snapshot {
        self.shared.state.lock().unwrap().snapshot.clone()
    }
    pub(crate) fn take_latest(&self) -> Snapshot {
        let state = self.shared.state.lock().unwrap();
        self.shared.pending.store(false, Ordering::Release);
        state.snapshot.clone()
    }
}
impl Drop for AudioService {
    fn drop(&mut self) {
        {
            let mut state = self.shared.state.lock().unwrap();
            state.shutdown = true;
            self.shared.wake();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

trait Capture {
    fn info(&self) -> Option<CaptureInfo>;
    fn finished(&self) -> bool;
    fn stop(self: Box<Self>) -> CaptureExit;
}
impl Capture for CaptureHandle {
    fn info(&self) -> Option<CaptureInfo> {
        self.info()
    }
    fn finished(&self) -> bool {
        self.is_finished()
    }
    fn stop(self: Box<Self>) -> CaptureExit {
        self.stop_and_join()
    }
}
trait Backend {
    fn revision(&self) -> u64;
    fn endpoints(&self) -> Result<Vec<Endpoint>, String>;
    fn selection(&self, device: &AudioDevice) -> Result<EndpointKey, String>;
    fn start(
        &mut self,
        key: &EndpointKey,
        ring: Arc<Mutex<SampleRing>>,
        generation: u64,
    ) -> Result<Box<dyn Capture>, String>;
}
struct NativeBackend(DeviceWatch);
impl Backend for NativeBackend {
    fn revision(&self) -> u64 {
        self.0.revision()
    }
    fn endpoints(&self) -> Result<Vec<Endpoint>, String> {
        self.0.endpoints()
    }
    fn selection(&self, device: &AudioDevice) -> Result<EndpointKey, String> {
        self.0.selection(match device {
            AudioDevice::Default => None,
            AudioDevice::Fixed { id } => Some(id),
        })
    }
    fn start(
        &mut self,
        key: &EndpointKey,
        ring: Arc<Mutex<SampleRing>>,
        generation: u64,
    ) -> Result<Box<dyn Capture>, String> {
        // Resolve default once, then open that exact endpoint. A change is handled as a new generation.
        Ok(Box::new(audio_capture::spawn_loopback(
            Some(key.id.clone()),
            ring,
            generation,
        )?))
    }
}

fn run(shared: Arc<Shared>, mut backend: Box<dyn Backend>) {
    let mut capture: Option<Box<dyn Capture>> = None;
    let mut current_generation = 0;
    let mut observed_revision = 0;
    let mut key: Option<Result<EndpointKey, String>> = None;
    let ring = Arc::new(Mutex::new(SampleRing::new(48_000)));
    let mut analyzer = SpectrumAnalyzer::new();
    let mut window = [0.0; FFT_SIZE];
    let mut last_analysis = Instant::now();
    let mut sequence = 0;
    loop {
        let (shutdown, generation, requested) = {
            let state = shared.state.lock().unwrap();
            (
                state.shutdown,
                state.snapshot.generation,
                state.snapshot.requested.clone(),
            )
        };
        if shutdown {
            break;
        }
        let revision = backend.revision();
        let devices_changed = revision != observed_revision;
        if devices_changed {
            observed_revision = revision;
            let endpoints = backend.endpoints();
            let mut state = shared.state.lock().unwrap();
            match endpoints {
                Ok(endpoints) => state.snapshot.endpoints = endpoints,
                Err(error) => state.snapshot.error = Some(error),
            }
            drop(state);
            shared.changed();
        }
        let requested_key = if generation != current_generation || devices_changed {
            requested.as_ref().map(|device| backend.selection(device))
        } else {
            key.clone()
        };
        let source_changed = requested_key != key;
        if generation != current_generation || source_changed {
            let generation = {
                let mut state = shared.state.lock().unwrap();
                if state.snapshot.generation != generation {
                    continue;
                }
                if source_changed && generation == current_generation {
                    state.snapshot.generation += 1;
                }
                state.snapshot.frame = None;
                state.snapshot.error = None;
                state.snapshot.phase = "stopping";
                state.snapshot.generation
            };
            shared.changed();
            if let Some(old) = capture.take() {
                let exit = old.stop();
                let mut state = shared.state.lock().unwrap();
                state.snapshot.capture_active = false;
                state.snapshot.info = None;
                state.snapshot.dropped = exit.dropped;
            }
            current_generation = generation;
            key = requested_key;
            analyzer.reset();
            ring.lock().unwrap().clear();
            let still_current = {
                let state = shared.state.lock().unwrap();
                !state.shutdown && state.snapshot.generation == generation
            };
            if !still_current {
                continue;
            }
            let opened = match key.as_ref() {
                Some(Ok(key)) => backend.start(key, Arc::clone(&ring), generation).map(Some),
                Some(Err(error)) => Err(error.clone()),
                None => Ok(None),
            };
            let mut state = shared.state.lock().unwrap();
            if let Ok(Some(opened)) = opened {
                capture = Some(opened);
                state.snapshot.capture_active = true;
            } else if let Err(error) = opened {
                if state.snapshot.generation == generation {
                    state.snapshot.error = Some(error);
                }
            }
            if state.snapshot.generation == generation {
                state.snapshot.phase = if capture.is_some() {
                    "starting"
                } else if state.snapshot.error.is_some() {
                    "failed"
                } else {
                    "idle"
                };
            }
            drop(state);
            shared.changed();
        }
        if capture.as_ref().is_some_and(|capture| capture.finished()) {
            let exit = capture.take().unwrap().stop();
            let mut state = shared.state.lock().unwrap();
            state.snapshot.capture_active = false;
            state.snapshot.info = None;
            state.snapshot.frame = None;
            state.snapshot.dropped = exit.dropped;
            if state.snapshot.generation == current_generation {
                state.snapshot.phase = "failed";
                state.snapshot.error = Some(
                    exit.error
                        .unwrap_or_else(|| "系统采集意外退出，请明确重试".into()),
                );
            }
            drop(state);
            shared.changed();
        }
        if last_analysis.elapsed() >= FRAME_INTERVAL {
            last_analysis = Instant::now();
            if let Some(capture) = capture.as_ref() {
                let info = capture.info();
                let (fresh, dropped) = {
                    let mut ring = ring.lock().unwrap();
                    (
                        info.is_some() && ring.take_window(&mut window),
                        ring.dropped(),
                    )
                };
                let frame = if fresh {
                    let mut bands = [0.0; BANDS];
                    analyzer.analyze(&window, &mut bands);
                    sequence += 1;
                    Some(Frame {
                        generation: current_generation,
                        seq: sequence,
                        bands,
                        captured_at: Instant::now(),
                    })
                } else {
                    None
                };
                let mut state = shared.state.lock().unwrap();
                if state.snapshot.generation == current_generation {
                    state.snapshot.info = info;
                    state.snapshot.dropped = dropped;
                    if let Some(frame) = frame {
                        state.snapshot.phase = "running";
                        state.snapshot.frame = Some(frame);
                        drop(state);
                        shared.changed();
                    }
                }
            }
        }
        let state = shared.state.lock().unwrap();
        if state.shutdown || state.snapshot.generation != current_generation {
            continue;
        }
        let timeout = if capture.is_some() {
            FRAME_INTERVAL.saturating_sub(last_analysis.elapsed())
        } else {
            Duration::from_secs(1)
        };
        drop(shared.wake.wait_timeout(state, timeout).unwrap());
    }
    if let Some(capture) = capture {
        let _ = capture.stop();
    }
}

#[cfg(test)]
#[path = "audio_service_tests.rs"]
mod tests;
