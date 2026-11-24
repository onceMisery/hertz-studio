// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Local device adapters consume the existing RenderOutput exactly once.
//! Device setup, allocations, and switching belong to CpalBackend's actor.

#[cfg(any(windows, test))]
mod quantize;
#[cfg(windows)]
mod wasapi;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Stream, SupportedStreamConfig};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use vmusic_core::output::{OutputActual, OutputMode, OutputPreferences, OutputSampleFormat};
use vmusic_core::AudioError;

use crate::render::{RenderFormat, RenderOutput};
use crate::sleep_deadline::{CallbackDeadline, SleepDeadline};

#[derive(Clone)]
pub(crate) enum OutputPlan {
    Shared {
        device: Device,
        config: SupportedStreamConfig,
        actual: OutputActual,
    },
    #[cfg(windows)]
    Exclusive(wasapi::Plan),
    #[cfg(test)]
    Test(TestPlan),
}

impl OutputPlan {
    pub(crate) fn prepare(
        preferences: &OutputPreferences,
        preferred: Option<RenderFormat>,
    ) -> Result<Self, AudioError> {
        preferences.validate()?;
        if preferences.mode == OutputMode::Exclusive {
            #[cfg(windows)]
            return wasapi::Plan::probe(preferences.clone(), preferred).map(Self::Exclusive);
            #[cfg(not(windows))]
            return Err(AudioError::UnsupportedFormat(
                "exclusive_output_requires_windows_wasapi".into(),
            ));
        }
        let _ = preferred;
        if !matches!(
            preferences.sample_format,
            OutputSampleFormat::Auto | OutputSampleFormat::F32
        ) {
            return Err(AudioError::UnsupportedFormat(
                "terminal_integer_output_requires_wasapi_exclusive".into(),
            ));
        }
        let host = cpal::default_host();
        let device = match preferences.device_id.as_deref() {
            None => host
                .default_output_device()
                .ok_or_else(|| AudioError::DeviceUnavailable("no default output device".into()))?,
            Some(name) => {
                let mut found = None;
                for device in host
                    .output_devices()
                    .map_err(|e| AudioError::DeviceUnavailable(e.to_string()))?
                {
                    if device.name().is_ok_and(|candidate| candidate == name) {
                        if found.is_some() {
                            return Err(AudioError::DeviceUnavailable(
                                "ambiguous output device name".into(),
                            ));
                        }
                        found = Some(device);
                    }
                }
                found.ok_or_else(|| AudioError::DeviceUnavailable(name.into()))?
            }
        };
        let config = crate::cpal_backend::pick_config(&device)?;
        let actual = OutputActual {
            device_id: device
                .name()
                .map_err(|e| AudioError::DeviceUnavailable(e.to_string()))?,
            // CPAL exposes a friendly name, not a stable native endpoint ID.
            endpoint_id: None,
            backend: format!("cpal/{:?}", host.id()),
            mode: OutputMode::Shared,
            sample_rate: config.sample_rate().0,
            channels: config.channels(),
            sample_format: OutputSampleFormat::F32,
            container_bits: 32,
            valid_bits: 32,
            dither_active: false,
            dither_reason: Some("not_applicable_float_output".into()),
        };
        Ok(Self::Shared {
            device,
            config,
            actual,
        })
    }

    pub(crate) fn format(&self) -> RenderFormat {
        let actual = self.actual();
        RenderFormat {
            sample_rate: actual.sample_rate,
            channels: actual.channels,
        }
    }

    pub(crate) fn actual(&self) -> &OutputActual {
        match self {
            Self::Shared { actual, .. } => actual,
            #[cfg(windows)]
            Self::Exclusive(plan) => &plan.actual,
            #[cfg(test)]
            Self::Test(plan) => &plan.actual,
        }
    }

    pub(crate) fn open(
        &self,
        output: RenderOutput,
        failed: Arc<AtomicBool>,
        sleep_deadline: Arc<SleepDeadline>,
    ) -> Result<OpenedOutput, AudioError> {
        let output_id = output.id();
        let control = Arc::new(OutputControl::new());
        let terminal = TerminalOutput::new(output, self.format(), control.clone(), sleep_deadline);
        let stream = match self {
            Self::Shared { device, config, .. } => {
                let mut terminal = terminal;
                let stream = device
                    .build_output_stream(
                        &config.config(),
                        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                            terminal.render(data);
                            if terminal.expired() {
                                data.fill(0.0);
                            }
                        },
                        move |error| {
                            failed.store(true, Ordering::Release);
                            tracing::warn!("local shared audio output error: {error}");
                        },
                        None,
                    )
                    .map_err(|e| AudioError::BackendInit(e.to_string()))?;
                LocalStream::Shared(stream)
            }
            #[cfg(windows)]
            Self::Exclusive(plan) => LocalStream::Exclusive(wasapi::NativeStream::open(
                plan.clone(),
                terminal,
                failed,
                output_id,
            )?),
            #[cfg(test)]
            Self::Test(plan) => {
                plan.record("open");
                let attempt = plan.opens.fetch_add(1, Ordering::Relaxed) + 1;
                if plan.fail_open_on == Some(attempt) {
                    return Err(AudioError::DeviceUnavailable(
                        "test device could not open".into(),
                    ));
                }
                control.silent.store(true, Ordering::Release);
                LocalStream::Test(Box::new(TestStream {
                    plan: plan.clone(),
                    _terminal: terminal,
                }))
            }
        };
        Ok(OpenedOutput {
            stream,
            control,
            output_id,
        })
    }
}

enum LocalStream {
    Shared(Stream),
    #[cfg(windows)]
    Exclusive(wasapi::NativeStream),
    #[cfg(test)]
    Test(Box<TestStream>),
}

pub(crate) struct OpenedOutput {
    stream: LocalStream,
    control: Arc<OutputControl>,
    pub(crate) output_id: u64,
}

impl OpenedOutput {
    pub(crate) fn start(&self) -> Result<(), AudioError> {
        match &self.stream {
            LocalStream::Shared(stream) => stream
                .play()
                .map_err(|e| AudioError::BackendInit(e.to_string())),
            #[cfg(windows)]
            LocalStream::Exclusive(stream) => stream.start(),
            #[cfg(test)]
            LocalStream::Test(stream) => {
                stream.plan.record("start");
                if stream.plan.fail_start {
                    Err(AudioError::DeviceUnavailable(
                        "test device could not start".into(),
                    ))
                } else {
                    Ok(())
                }
            }
        }
    }

    /// A bounded fade precedes the renderer's ownership barrier and stream
    /// destruction. A nonresponsive device is still stopped by that barrier.
    pub(crate) fn fade_out(&self, failed: &AtomicBool) {
        self.control.fade_out.store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_millis(100);
        while !self.control.silent.load(Ordering::Acquire)
            && !failed.load(Ordering::Acquire)
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    pub(crate) fn resume_fade(&self) {
        self.control.fade_out.store(false, Ordering::Release);
    }

    pub(crate) fn reset_quantizer(&self) {
        self.control.reset_epoch.fetch_add(1, Ordering::AcqRel);
    }
}

/// Fault injection exercises the real owner transaction without opening a
/// physical device. It is absent from production builds.
#[cfg(test)]
#[derive(Clone)]
pub(crate) struct TestPlan {
    pub(crate) actual: OutputActual,
    pub(crate) fail_open_on: Option<u32>,
    pub(crate) fail_start: bool,
    pub(crate) opens: Arc<std::sync::atomic::AtomicU32>,
    pub(crate) events: Arc<std::sync::Mutex<Vec<String>>>,
}

#[cfg(test)]
impl TestPlan {
    fn record(&self, action: &str) {
        self.events
            .lock()
            .unwrap()
            .push(format!("{}:{action}", self.actual.device_id));
    }
}

#[cfg(test)]
struct TestStream {
    plan: TestPlan,
    _terminal: TerminalOutput,
}

#[cfg(test)]
impl Drop for TestStream {
    fn drop(&mut self) {
        self.plan.record("drop");
    }
}

struct OutputControl {
    fade_out: AtomicBool,
    silent: AtomicBool,
    reset_epoch: AtomicU64,
}

impl OutputControl {
    fn new() -> Self {
        Self {
            fade_out: AtomicBool::new(false),
            silent: AtomicBool::new(false),
            reset_epoch: AtomicU64::new(0),
        }
    }
}

struct TerminalOutput {
    output: RenderOutput,
    control: Arc<OutputControl>,
    format: RenderFormat,
    gain: f32,
    step: f32,
    sleep_deadline: Arc<SleepDeadline>,
    captured_deadline: CallbackDeadline,
}

impl TerminalOutput {
    fn new(
        output: RenderOutput,
        format: RenderFormat,
        control: Arc<OutputControl>,
        sleep_deadline: Arc<SleepDeadline>,
    ) -> Self {
        let captured_deadline = sleep_deadline.callback_deadline();
        Self {
            output,
            control,
            format,
            gain: 0.0,
            step: 1.0 / (format.sample_rate as f32 * 0.005).max(1.0),
            sleep_deadline,
            captured_deadline,
        }
    }

    fn render(&mut self, data: &mut [f32]) -> usize {
        self.captured_deadline = self.sleep_deadline.callback_deadline();
        let mut live = self.output.render(data, self.format.channels);
        let fade_out = self.control.fade_out.load(Ordering::Acquire);
        let channels = usize::from(self.format.channels);
        for (frame, samples) in data.chunks_mut(channels).enumerate() {
            self.gain = if fade_out {
                (self.gain - self.step).max(0.0)
            } else {
                (self.gain + self.step).min(1.0)
            };
            if self.gain == 0.0 {
                live = live.min(frame * channels);
            }
            for sample in samples {
                *sample *= self.gain;
            }
        }
        self.control
            .silent
            .store(self.gain == 0.0, Ordering::Release);
        // A transport fade that has reached exact zero is a hard mute too.
        if data[..live.min(data.len())]
            .iter()
            .all(|sample| *sample == 0.0)
        {
            live = 0;
        }
        live
    }

    fn expired(&self) -> bool {
        self.sleep_deadline.callback_expired(self.captured_deadline)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::RenderCore;

    #[test]
    fn shared_integer_requests_do_not_claim_terminal_precision() {
        for sample_format in [OutputSampleFormat::S16, OutputSampleFormat::S24] {
            let preferences = OutputPreferences {
                sample_format,
                ..Default::default()
            };
            assert!(matches!(
                OutputPlan::prepare(&preferences, None),
                Err(AudioError::UnsupportedFormat(_))
            ));
        }
    }

    #[test]
    fn terminal_keeps_sleep_deadline_until_after_final_packing() {
        let gate = Arc::new(SleepDeadline::new());
        gate.set_test_now_ms(999);
        gate.set(Some(1000));
        let format = RenderFormat {
            sample_rate: 48_000,
            channels: 2,
        };
        let mut renderer = RenderCore::with_sleep_deadline(format, Some(gate.clone())).unwrap();
        let output = renderer.prepare_output(format).unwrap();
        renderer.activate_output(output.id()).unwrap();
        let mut terminal =
            TerminalOutput::new(output, format, Arc::new(OutputControl::new()), gate.clone());
        let mut data = [1.0; 32];
        assert_eq!(terminal.render(&mut data), 0);
        assert!(data.iter().all(|sample| *sample == 0.0));
        assert!(!terminal.expired());
        // Simulate expiry/cleanup while integer packing is in flight.
        gate.set_test_now_ms(1000);
        gate.set(None);
        assert!(terminal.expired());
    }
}
