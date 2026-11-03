// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
use super::*;
use std::sync::atomic::{AtomicU64, AtomicUsize};

struct Control {
    revision: AtomicU64,
    default: Mutex<String>,
    unavailable: Mutex<Option<String>>,
    format: Mutex<Vec<u8>>,
    starts: AtomicUsize,
    active: AtomicUsize,
    maximum: AtomicUsize,
    stopping: AtomicBool,
    delay_stop: Mutex<bool>,
    release: Condvar,
    failed: AtomicBool,
    first_sample_time: Mutex<Option<Instant>>,
    ring: Mutex<Option<Arc<Mutex<SampleRing>>>>,
}
impl Default for Control {
    fn default() -> Self {
        Self {
            revision: AtomicU64::new(1),
            default: Mutex::new("a".into()),
            unavailable: Mutex::new(None),
            format: Mutex::new(vec![1]),
            starts: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            maximum: AtomicUsize::new(0),
            stopping: AtomicBool::new(false),
            delay_stop: Mutex::new(false),
            release: Condvar::new(),
            failed: AtomicBool::new(false),
            first_sample_time: Mutex::new(None),
            ring: Mutex::new(None),
        }
    }
}
struct ReleaseStop(Arc<Control>);
impl Drop for ReleaseStop {
    fn drop(&mut self) {
        *self.0.delay_stop.lock().unwrap() = false;
        self.0.release.notify_all();
    }
}
struct FakeBackend(Arc<Control>);
struct FakeCapture {
    control: Arc<Control>,
    generation: u64,
    id: String,
}
impl Capture for FakeCapture {
    fn info(&self) -> Option<CaptureInfo> {
        Some(CaptureInfo {
            device_id: self.id.clone(),
            sample_rate: 96_000,
            channels: 2,
        })
    }
    fn finished(&self) -> bool {
        self.control.failed.load(Ordering::Acquire)
    }
    fn stop(self: Box<Self>) -> CaptureExit {
        self.control.stopping.store(true, Ordering::Release);
        let mut delay = self.control.delay_stop.lock().unwrap();
        while *delay {
            delay = self.control.release.wait(delay).unwrap();
        }
        self.control.active.fetch_sub(1, Ordering::AcqRel);
        CaptureExit {
            generation: self.generation,
            error: self
                .control
                .failed
                .load(Ordering::Acquire)
                .then(|| "lost endpoint".into()),
            dropped: 0,
        }
    }
}
impl Backend for FakeBackend {
    fn revision(&self) -> u64 {
        self.0.revision.load(Ordering::Acquire)
    }
    fn endpoints(&self) -> Result<Vec<Endpoint>, String> {
        Ok(vec![])
    }
    fn selection(&self, device: &AudioDevice) -> Result<EndpointKey, String> {
        let id = match device {
            AudioDevice::Default => self.0.default.lock().unwrap().clone(),
            AudioDevice::Fixed { id } => id.clone(),
        };
        if id == "missing" || self.0.unavailable.lock().unwrap().as_ref() == Some(&id) {
            Err("fixed endpoint missing".into())
        } else {
            Ok(EndpointKey {
                id,
                format: self.0.format.lock().unwrap().clone(),
            })
        }
    }
    fn start(
        &mut self,
        key: &EndpointKey,
        ring: Arc<Mutex<SampleRing>>,
        generation: u64,
    ) -> Result<Box<dyn Capture>, String> {
        self.0.starts.fetch_add(1, Ordering::AcqRel);
        let active = self.0.active.fetch_add(1, Ordering::AcqRel) + 1;
        self.0.maximum.fetch_max(active, Ordering::AcqRel);
        self.0.stopping.store(false, Ordering::Release);
        *ring.lock().unwrap() = SampleRing::new(96_000);
        let captured_at = self
            .0
            .first_sample_time
            .lock()
            .unwrap()
            .unwrap_or_else(Instant::now);
        ring.lock().unwrap().push_at(&[0.2; FFT_SIZE], captured_at);
        *self.0.ring.lock().unwrap() = Some(ring);
        Ok(Box::new(FakeCapture {
            control: Arc::clone(&self.0),
            generation,
            id: key.id.clone(),
        }))
    }
}
fn service(control: Arc<Control>) -> AudioService {
    AudioService::with_backend(Arc::new(|| {}), move |_| {
        Ok(Box::new(FakeBackend(Arc::clone(&control))))
    })
    .unwrap()
}
fn until(mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !check() {
        assert!(
            Instant::now() < deadline,
            "audio owner did not reach expected state"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[test]
fn demand_is_shared_and_static_or_paused_consumers_do_not_keep_capture() {
    let control = Arc::new(Control::default());
    let service = service(Arc::clone(&control));
    let generation = service.request(Some(AudioDevice::Default));
    until(|| service.snapshot().frame.is_some());
    for _ in 0..50 {
        assert_eq!(service.request(Some(AudioDevice::Default)), generation);
    }
    assert_eq!(control.starts.load(Ordering::Acquire), 1);
    assert_eq!(service.snapshot().info.unwrap().sample_rate, 96_000);
    service.request(None);
    assert!(
        service.snapshot().frame.is_none(),
        "switch invalidates output synchronously"
    );
    until(|| !service.snapshot().capture_active);
    assert_eq!(control.active.load(Ordering::Acquire), 0);
    assert_eq!(control.maximum.load(Ordering::Acquire), 1);
}
#[test]
fn replacement_waits_for_actual_exit_and_drops_superseded_demand() {
    let control = Arc::new(Control::default());
    let service = service(Arc::clone(&control));
    service.request(Some(AudioDevice::Fixed { id: "a".into() }));
    until(|| service.snapshot().frame.is_some());
    let _release_on_panic = ReleaseStop(Arc::clone(&control));
    *control.delay_stop.lock().unwrap() = true;
    let next = service.request(Some(AudioDevice::Fixed { id: "b".into() }));
    until(|| control.stopping.load(Ordering::Acquire));
    assert!(
        service.snapshot().capture_active,
        "requested cancellation is not a thread exit"
    );
    assert!(service.snapshot().frame.is_none());
    assert_eq!(control.starts.load(Ordering::Acquire), 1);
    assert!(service.request(Some(AudioDevice::Fixed { id: "c".into() })) > next);
    *control.delay_stop.lock().unwrap() = false;
    control.release.notify_all();
    until(|| {
        service
            .snapshot()
            .info
            .as_ref()
            .is_some_and(|info| info.device_id == "c")
    });
    assert_eq!(
        control.starts.load(Ordering::Acquire),
        2,
        "superseded b is never opened"
    );
    assert_eq!(control.maximum.load(Ordering::Acquire), 1);
}
#[test]
fn default_rebinds_but_fixed_endpoint_does_not_follow_another_device() {
    let control = Arc::new(Control::default());
    let service = service(Arc::clone(&control));
    service.request(Some(AudioDevice::Fixed { id: "a".into() }));
    until(|| service.snapshot().frame.is_some());
    let fixed_generation = service.snapshot().generation;
    *control.default.lock().unwrap() = "b".into();
    control.revision.fetch_add(1, Ordering::AcqRel);
    service.shared.wake();
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(service.snapshot().generation, fixed_generation);
    assert_eq!(control.starts.load(Ordering::Acquire), 1);
    service.request(Some(AudioDevice::Default));
    until(|| {
        service
            .snapshot()
            .info
            .as_ref()
            .is_some_and(|info| info.device_id == "b")
    });
    let generation = service.snapshot().generation;
    *control.default.lock().unwrap() = "c".into();
    control.revision.fetch_add(1, Ordering::AcqRel);
    service.shared.wake();
    until(|| {
        service
            .snapshot()
            .info
            .as_ref()
            .is_some_and(|info| info.device_id == "c")
    });
    assert!(service.snapshot().generation > generation);
    assert_eq!(control.maximum.load(Ordering::Acquire), 1);
}
#[test]
fn fixed_failure_never_falls_back_or_automatically_reopens() {
    let control = Arc::new(Control::default());
    let service = service(Arc::clone(&control));
    service.request(Some(AudioDevice::Fixed {
        id: "missing".into(),
    }));
    until(|| service.snapshot().phase == "failed");
    assert_eq!(control.starts.load(Ordering::Acquire), 0);
    assert!(service.snapshot().error.is_some());
    service.request(Some(AudioDevice::Default));
    until(|| service.snapshot().frame.is_some());
    control.failed.store(true, Ordering::Release);
    service.shared.wake();
    until(|| service.snapshot().phase == "failed");
    let starts = control.starts.load(Ordering::Acquire);
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(control.starts.load(Ordering::Acquire), starts);
    control.failed.store(false, Ordering::Release);
    service.retry();
    until(|| service.snapshot().capture_active);
    assert_eq!(control.maximum.load(Ordering::Acquire), 1);
}

#[test]
fn owner_initialization_failure_can_be_explicitly_retried() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let calls = Arc::clone(&attempts);
    let control = Arc::new(Control::default());
    let service = AudioService::with_backend(Arc::new(|| {}), move |_| {
        if calls.fetch_add(1, Ordering::AcqRel) == 0 {
            Err("device service unavailable".into())
        } else {
            Ok(Box::new(FakeBackend(Arc::clone(&control))))
        }
    })
    .unwrap();
    until(|| service.snapshot().phase == "failed");
    service.request(Some(AudioDevice::Default));
    until(|| service.snapshot().frame.is_some());
    assert_eq!(attempts.load(Ordering::Acquire), 2);
}

#[test]
fn notifications_are_coalesced_and_stale_frames_are_cleared_before_native_exit() {
    let notifications = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&notifications);
    let control = Arc::new(Control::default());
    let service = AudioService::with_backend(
        Arc::new(move || {
            count.fetch_add(1, Ordering::AcqRel);
        }),
        move |_| Ok(Box::new(FakeBackend(Arc::clone(&control)))),
    )
    .unwrap();
    let generation = service.request(Some(AudioDevice::Default));
    until(|| service.snapshot().frame.is_some());
    assert_eq!(
        notifications.load(Ordering::Acquire),
        1,
        "one queued event holds the latest state"
    );
    assert_eq!(service.take_latest().frame.unwrap().generation, generation);
    service.request(None);
    assert!(service.take_latest().frame.is_none());
    until(|| service.snapshot().phase == "idle");
    assert!(service.take_latest().frame.is_none());
}

#[test]
fn fixed_removal_restoration_and_format_changes_each_use_the_real_exit_barrier() {
    let control = Arc::new(Control::default());
    let service = service(Arc::clone(&control));
    service.request(Some(AudioDevice::Fixed { id: "a".into() }));
    until(|| service.snapshot().frame.is_some());
    let before = service.snapshot().generation;
    *control.unavailable.lock().unwrap() = Some("a".into());
    control.revision.fetch_add(1, Ordering::AcqRel);
    service.shared.wake();
    until(|| service.snapshot().phase == "failed" && !service.snapshot().capture_active);
    assert!(service.snapshot().generation > before);
    assert!(service.snapshot().frame.is_none());
    assert!(service.snapshot().info.is_none());
    *control.default.lock().unwrap() = "b".into();
    control.revision.fetch_add(1, Ordering::AcqRel);
    service.shared.wake();
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(
        control.starts.load(Ordering::Acquire),
        1,
        "lost fixed endpoint never follows default"
    );
    *control.unavailable.lock().unwrap() = None;
    control.revision.fetch_add(1, Ordering::AcqRel);
    service.shared.wake();
    until(|| service.snapshot().frame.is_some());
    assert_eq!(service.snapshot().info.unwrap().device_id, "a");
    assert_eq!(control.starts.load(Ordering::Acquire), 2);
    let restored = service.snapshot().generation;
    *control.format.lock().unwrap() = vec![2];
    control.revision.fetch_add(1, Ordering::AcqRel);
    service.shared.wake();
    until(|| control.starts.load(Ordering::Acquire) == 3 && service.snapshot().frame.is_some());
    assert!(service.snapshot().generation > restored);
    assert_eq!(control.maximum.load(Ordering::Acquire), 1);
}

#[test]
fn owner_drops_expired_pcm_and_preserves_capture_timestamp_on_recovery() {
    let control = Arc::new(Control::default());
    *control.first_sample_time.lock().unwrap() = Some(Instant::now() - Duration::from_secs(2));
    let service = service(Arc::clone(&control));
    service.request(Some(AudioDevice::Default));
    until(|| service.snapshot().dropped == FFT_SIZE as u64);
    assert!(
        service.snapshot().frame.is_none(),
        "queued stale PCM never becomes a fresh frame"
    );
    let ring = control.ring.lock().unwrap().clone().unwrap();
    let captured_at = Instant::now();
    ring.lock().unwrap().push_at(&[0.2; FFT_SIZE], captured_at);
    until(|| service.snapshot().frame.is_some());
    assert_eq!(service.snapshot().frame.unwrap().captured_at, captured_at);
    assert_eq!(control.starts.load(Ordering::Acquire), 1);
}

#[test]
fn owner_does_not_replay_filter_energy_after_a_capture_discontinuity() {
    let control = Arc::new(Control::default());
    let service = service(Arc::clone(&control));
    service.request(Some(AudioDevice::Default));
    until(|| service.snapshot().frame.is_some());
    let before = service.snapshot().frame.unwrap();
    assert!(before.bands.iter().any(|band| *band > 0.0));
    let ring = control.ring.lock().unwrap().clone().unwrap();
    {
        let mut ring = ring.lock().unwrap();
        ring.discontinue();
        ring.push_at(&[0.0; FFT_SIZE], Instant::now());
    }
    until(|| {
        service
            .snapshot()
            .frame
            .is_some_and(|frame| frame.seq > before.seq)
    });
    let after = service.snapshot().frame.unwrap();
    assert!(after.bands.iter().all(|band| *band == 0.0));
    assert_eq!(after.generation, before.generation);
}
