// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Local device owner for the shared headless playback renderer.

use cpal::traits::DeviceTrait;
use cpal::{Device, SampleFormat, SupportedStreamConfig};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use vmusic_core::audio_quality::{QualityParams, QualityStatus};
use vmusic_core::output::{OutputCapabilities, OutputMode, OutputPreferences, OutputStatus};
use vmusic_core::{
    AudioBackend, AudioError, AudioSource, DeviceInfo, DspParams, MediaInfo, NextEvent, NextTrack,
    PrepareResult,
};

use crate::local_output::{OpenedOutput, OutputPlan};
pub use crate::render::EQ_BANDS;
use crate::render::{RenderCore, RenderOutput};
use crate::sleep_deadline::SleepDeadline;

pub struct CpalBackend {
    renderer: RenderCore,
    plan: OutputPlan,
    stream: Option<OpenedOutput>,
    stream_failed: Arc<AtomicBool>,
    requested: OutputPreferences,
    accepted: OutputPreferences,
    last_error: Option<String>,
    sleep_deadline: Arc<SleepDeadline>,
}

impl CpalBackend {
    pub fn new() -> Result<Self, AudioError> {
        Self::with_sleep_deadline(Arc::new(SleepDeadline::new()))
    }

    pub(crate) fn with_sleep_deadline(
        sleep_deadline: Arc<SleepDeadline>,
    ) -> Result<Self, AudioError> {
        let requested = OutputPreferences::default();
        let plan = OutputPlan::prepare(&requested, None)?;
        let renderer =
            RenderCore::with_sleep_deadline(plan.format(), Some(sleep_deadline.clone()))?;
        Ok(Self {
            renderer,
            plan,
            stream: None,
            stream_failed: Arc::new(AtomicBool::new(false)),
            accepted: requested.clone(),
            requested,
            last_error: None,
            sleep_deadline,
        })
    }

    fn ensure_stream(&mut self) -> Result<(), AudioError> {
        if self.stream_failed.load(Ordering::Acquire) {
            return Err(AudioError::DeviceUnavailable(
                "音频输出已失效，请重新选择输出设备后播放".into(),
            ));
        }
        if self.stream.is_some() {
            return Ok(());
        }
        let plan = self.plan.clone();
        let output = self.renderer.prepare_output(plan.format())?;
        match self.start_plan(&plan, output) {
            Ok((stream, failed)) => {
                self.stream = Some(stream);
                self.stream_failed = failed;
                if self.requested == self.accepted {
                    self.last_error = None;
                }
                Ok(())
            }
            Err(error) => {
                self.last_error = Some(error.to_string());
                Err(error)
            }
        }
    }

    /// The old stream has been revoked and destroyed before this operation.
    /// An initialized candidate cannot consume media before activate_output.
    fn start_plan(
        &mut self,
        plan: &OutputPlan,
        output: RenderOutput,
    ) -> Result<(OpenedOutput, Arc<AtomicBool>), AudioError> {
        let failed = Arc::new(AtomicBool::new(false));
        let stream = plan.open(output, failed.clone(), self.sleep_deadline.clone())?;
        self.renderer.set_format(plan.format())?;
        let previous = self.renderer.activate_output(stream.output_id)?;
        if let Err(error) = stream.start() {
            self.renderer.activate_output(previous)?;
            return Err(error);
        }
        if failed.load(Ordering::Acquire) {
            self.renderer.activate_output(previous)?;
            return Err(AudioError::DeviceUnavailable(
                "new output failed during activation".into(),
            ));
        }
        Ok((stream, failed))
    }

    fn configure_prepared(
        &mut self,
        preferences: OutputPreferences,
        candidate: Result<OutputPlan, AudioError>,
    ) -> Result<(), AudioError> {
        self.requested = preferences.clone();
        match candidate.and_then(|plan| self.switch_prepared(plan)) {
            Ok(()) => {
                self.accepted = preferences;
                self.last_error = None;
                self.renderer.clear_output_error();
                Ok(())
            }
            Err(error) => {
                let message = error.to_string();
                if self.stream.is_none() || self.stream_failed.load(Ordering::Acquire) {
                    // A constructor's default plan is not a previously working
                    // output. Failed explicit selection must not let a later
                    // play/load silently open that different default endpoint.
                    self.fail_output(message);
                } else {
                    self.last_error = Some(message);
                }
                Err(error)
            }
        }
    }

    fn switch_prepared(&mut self, candidate: OutputPlan) -> Result<(), AudioError> {
        self.renderer.validate_format_change(candidate.format())?;
        let prepared = self.renderer.prepare_output(candidate.format())?;
        let old_plan = self.plan.clone();
        let had_stream = self.stream.is_some();
        if let Some(stream) = &self.stream {
            stream.fade_out(&self.stream_failed);
        }
        let previous = match self.renderer.activate_output(0) {
            Ok(previous) => previous,
            Err(error) => {
                if let Some(stream) = &self.stream {
                    stream.resume_fade();
                }
                return Err(error);
            }
        };
        // Validate again after the old consumer is quiescent. It may have
        // filled a new terminal delay while the candidate was prepared.
        if let Err(error) = self.renderer.validate_format_change(candidate.format()) {
            self.renderer.activate_output(previous)?;
            if let Some(stream) = &self.stream {
                stream.resume_fade();
            }
            return Err(error);
        }
        // Drop joins the native callback owner and releases the endpoint.
        // Shared/exclusive changes on the same endpoint need this barrier.
        self.stream = None;
        match self.start_plan(&candidate, prepared) {
            Ok((stream, failed)) => {
                self.plan = candidate;
                self.stream = Some(stream);
                self.stream_failed = failed;
                Ok(())
            }
            Err(error) => {
                let restore = (|| {
                    self.renderer.activate_output(0)?;
                    self.renderer.set_format(old_plan.format())?;
                    if had_stream {
                        let output = self.renderer.prepare_output(old_plan.format())?;
                        let (stream, failed) = self.start_plan(&old_plan, output)?;
                        self.stream = Some(stream);
                        self.stream_failed = failed;
                    }
                    Ok::<(), AudioError>(())
                })();
                match restore {
                    Ok(()) => Err(error),
                    Err(restore) => {
                        let message =
                            format!("{error}; previous output could not be restored: {restore}");
                        self.fail_output(message.clone());
                        Err(AudioError::BackendInit(message))
                    }
                }
            }
        }
    }

    fn reset_quantizer(&self) {
        if let Some(stream) = &self.stream {
            stream.reset_quantizer();
        }
    }

    fn fail_output(&mut self, message: String) {
        let _ = self.renderer.activate_output(0);
        self.stream = None;
        self.stream_failed.store(true, Ordering::Release);
        self.last_error = Some(message.clone());
        self.renderer.output_failed(message);
    }
}

impl AudioBackend for CpalBackend {
    fn name(&self) -> &'static str {
        "cpal"
    }

    fn devices(&self) -> Result<Vec<DeviceInfo>, AudioError> {
        crate::scheduled_output::enumerate_output_devices()
    }

    fn select_device(&mut self, id: Option<&str>) -> Result<(), AudioError> {
        let mut preferences = self.requested.clone();
        preferences.device_id = id.map(str::to_owned);
        self.configure_output(preferences)
    }

    fn configure_output(&mut self, preferences: OutputPreferences) -> Result<(), AudioError> {
        self.renderer.invalidate_preview(true)?;
        // Probe identity and format while the existing output still owns PCM.
        // The actor serializes configuration revisions and their adoption.
        let candidate = OutputPlan::prepare(&preferences, Some(self.renderer.format()));
        self.configure_prepared(preferences, candidate)
    }

    fn invalidate_output(&mut self, reason: String) {
        let _ = self.renderer.invalidate_preview(true);
        self.fail_output(reason);
    }

    fn output_status(&self) -> Option<OutputStatus> {
        let failed = self.stream_failed.load(Ordering::Acquire);
        Some(OutputStatus {
            requested: self.requested.clone(),
            accepted: self.accepted.clone(),
            actual: self.stream.as_ref().map(|_| self.plan.actual().clone()),
            active: self.stream.is_some() && !failed,
            last_error: self
                .last_error
                .clone()
                .or_else(|| failed.then(|| "audio_output_unavailable".into())),
            capabilities: OutputCapabilities::default(),
        })
    }
    fn load(&mut self, uri: &str) -> Result<MediaInfo, AudioError> {
        self.ensure_stream()?;
        self.reset_quantizer();
        self.renderer.load(uri)
    }

    fn load_source(
        &mut self,
        source: Box<dyn AudioSource>,
        ext: Option<String>,
    ) -> Result<MediaInfo, AudioError> {
        self.ensure_stream()?;
        self.reset_quantizer();
        self.renderer.load_source(source, ext)
    }

    fn load_with_gain(&mut self, uri: &str, gain: f32) -> Result<MediaInfo, AudioError> {
        self.ensure_stream()?;
        self.reset_quantizer();
        self.renderer.load_with_gain(uri, gain)
    }
    fn load_source_with_gain(
        &mut self,
        source: Box<dyn AudioSource>,
        ext: Option<String>,
        gain: f32,
    ) -> Result<MediaInfo, AudioError> {
        self.ensure_stream()?;
        self.reset_quantizer();
        self.renderer.load_source_with_gain(source, ext, gain)
    }
    fn prepare_next_source(
        &mut self,
        next: NextTrack,
        source: Box<dyn AudioSource>,
        ext: Option<String>,
        gain: f32,
    ) -> Result<PrepareResult, AudioError> {
        self.renderer.prepare_next_source(next, source, ext, gain)
    }

    fn play(&mut self) -> Result<(), AudioError> {
        self.ensure_stream()?;
        self.renderer.play()
    }

    fn pause(&mut self) -> Result<(), AudioError> {
        self.reset_quantizer();
        self.renderer.pause()
    }

    fn stop(&mut self) -> Result<(), AudioError> {
        self.reset_quantizer();
        self.renderer.stop()
    }

    fn seek(&mut self, position_ms: u64) -> Result<(), AudioError> {
        let previous = self.renderer.activate_output(0)?;
        self.reset_quantizer();
        // Exclusive hardware holds committed PCM outside the renderer. Closing
        // and reopening the same pinned endpoint discards those pre-seek frames.
        let restart = self.stream.is_some() && self.plan.actual().mode == OutputMode::Exclusive;
        if restart {
            self.stream = None;
        }
        let result = self.renderer.seek(position_ms);
        if restart {
            let plan = self.plan.clone();
            let reopen = self
                .renderer
                .prepare_output(plan.format())
                .and_then(|output| self.start_plan(&plan, output));
            match reopen {
                Ok((stream, failed)) => {
                    self.stream = Some(stream);
                    self.stream_failed = failed;
                }
                Err(error) => {
                    let message = format!("seek output could not be restored: {error}");
                    self.fail_output(message.clone());
                    return Err(AudioError::BackendInit(message));
                }
            }
        } else {
            self.renderer.activate_output(previous)?;
        }
        result
    }

    fn set_volume(&mut self, volume: f32) -> Result<(), AudioError> {
        self.renderer.set_volume(volume)
    }

    fn set_dsp(&mut self, params: DspParams) -> Result<(), AudioError> {
        self.renderer.set_dsp(params)
    }

    fn validate_quality(&self, params: QualityParams) -> Result<(), AudioError> {
        self.renderer.validate_quality(params)
    }

    fn set_quality(&mut self, params: QualityParams) -> Result<(), AudioError> {
        self.renderer.set_quality(params)
    }

    fn prepare_impulse(
        &mut self,
        kernel: vmusic_core::impulse::ImpulseKernel,
    ) -> Result<(), AudioError> {
        self.renderer.prepare_impulse(kernel)
    }

    fn prepare_quality_preview(
        &mut self,
        plan: vmusic_core::audio_preview::PreviewPlan,
        source: Box<dyn AudioSource>,
        ext: Option<String>,
    ) -> Result<MediaInfo, AudioError> {
        self.renderer.prepare_quality_preview(plan, source, ext)
    }
    fn start_quality_preview(
        &mut self,
        id: &str,
        side: vmusic_core::audio_preview::PreviewSide,
    ) -> Result<MediaInfo, AudioError> {
        self.renderer.start_quality_preview(id, side)
    }
    fn select_quality_preview(
        &mut self,
        id: &str,
        side: vmusic_core::audio_preview::PreviewSide,
    ) -> Result<(), AudioError> {
        self.renderer.select_quality_preview(id, side)
    }
    fn cancel_quality_preview(&mut self, id: Option<&str>) -> Result<bool, AudioError> {
        self.renderer.cancel_quality_preview(id)
    }
    fn refresh_quality_preview(&mut self, id: &str) -> bool {
        self.renderer.refresh_quality_preview(id)
    }
    fn take_quality_preview_restore(&mut self) -> Option<String> {
        self.renderer.take_quality_preview_restore()
    }

    fn quality_status(&self) -> Option<QualityStatus> {
        self.renderer.quality_status().map(|mut status| {
            if self.stream_failed.load(Ordering::Acquire) {
                status.eq.state = vmusic_core::EqApplicationState::Unavailable;
                status.eq.active = false;
            }
            status
        })
    }

    fn eq_status(&self) -> Option<vmusic_core::EqStatus> {
        self.renderer.eq_status().map(|mut status| {
            if self.stream_failed.load(Ordering::Acquire) {
                status.state = vmusic_core::EqApplicationState::Unavailable;
                status.active = false;
            }
            status
        })
    }

    fn set_crossfade(&mut self, ms: u64) -> Result<(), AudioError> {
        self.renderer.set_crossfade(ms)
    }

    fn prepare_next(&mut self, next: NextTrack) -> Result<PrepareResult, AudioError> {
        self.renderer.prepare_next(next)
    }

    fn clear_next(&mut self) {
        self.renderer.clear_next()
    }

    fn clear_unstarted_next(&mut self) -> bool {
        self.renderer.clear_unstarted_next()
    }

    fn take_next_event(&mut self) -> Option<NextEvent> {
        self.renderer.take_next_event()
    }

    fn position_ms(&self) -> u64 {
        self.renderer.position_ms()
    }

    fn duration_ms(&self) -> Option<u64> {
        self.renderer.duration_ms()
    }

    fn finished(&self) -> bool {
        self.renderer.finished()
    }

    fn take_decode_failure(&mut self) -> bool {
        self.renderer.take_decode_failure()
    }

    fn take_transport_error(&mut self) -> Option<AudioError> {
        self.renderer.take_transport_error()
    }

    fn spectrum(&self, out: &mut [f32]) -> bool {
        self.renderer.spectrum(out)
    }

    fn maintain(&mut self) {
        if self.stream_failed.load(Ordering::Acquire) && self.stream.is_some() {
            self.fail_output("音频输出已失效，请重新选择输出设备后播放".into());
        }
        self.renderer.maintain()
    }
}

impl Drop for CpalBackend {
    fn drop(&mut self) {
        // Stop callbacks before the renderer retires its decoder threads.
        let _ = self.renderer.activate_output(0);
        self.stream = None;
    }
}

pub(crate) fn pick_config(device: &Device) -> Result<SupportedStreamConfig, AudioError> {
    let mut best: Option<cpal::SupportedStreamConfigRange> = None;
    for range in device
        .supported_output_configs()
        .map_err(|e| AudioError::DeviceUnavailable(e.to_string()))?
    {
        if range.sample_format() != SampleFormat::F32 {
            continue;
        }
        let better = best
            .as_ref()
            .map(|b| range.max_sample_rate() > b.max_sample_rate())
            .unwrap_or(true);
        if better {
            best = Some(range);
        }
    }
    let range = best.ok_or_else(|| {
        AudioError::DeviceUnavailable("no 32-bit float output configuration".into())
    })?;
    // `SampleRate` is a newtype in cpal 0.15, hence the `.0` juggling.
    let wanted = 48_000u32;
    let min = range.min_sample_rate().0;
    let max = range.max_sample_rate().0;
    let rate = if wanted >= min && wanted <= max {
        wanted
    } else {
        max
    };
    Ok(range.with_sample_rate(cpal::SampleRate(rate)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_output::TestPlan;
    use std::sync::{atomic::AtomicU32, Mutex};
    use vmusic_core::output::{OutputActual, OutputSampleFormat};

    fn plan(
        name: &str,
        events: &Arc<Mutex<Vec<String>>>,
        fail_start: bool,
        fail_open_on: Option<u32>,
    ) -> OutputPlan {
        OutputPlan::Test(TestPlan {
            actual: OutputActual {
                device_id: name.into(),
                endpoint_id: Some(format!("endpoint:{name}")),
                backend: "test".into(),
                mode: OutputMode::Shared,
                sample_rate: 48_000,
                channels: 2,
                sample_format: OutputSampleFormat::F32,
                container_bits: 32,
                valid_bits: 32,
                dither_active: false,
                dither_reason: Some("not_applicable_float_output".into()),
            },
            fail_open_on,
            fail_start,
            opens: Arc::new(AtomicU32::new(0)),
            events: events.clone(),
        })
    }

    fn backend(plan: OutputPlan) -> CpalBackend {
        let sleep_deadline = Arc::new(SleepDeadline::new());
        CpalBackend {
            renderer: RenderCore::with_sleep_deadline(plan.format(), Some(sleep_deadline.clone()))
                .unwrap(),
            plan,
            stream: None,
            stream_failed: Arc::new(AtomicBool::new(false)),
            requested: OutputPreferences::default(),
            accepted: OutputPreferences::default(),
            last_error: None,
            sleep_deadline,
        }
    }

    #[test]
    fn switching_drops_old_device_before_new_device_starts() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut backend = backend(plan("old", &events, false, None));
        backend.ensure_stream().unwrap();
        events.lock().unwrap().clear();
        backend
            .switch_prepared(plan("new", &events, false, None))
            .unwrap();
        assert_eq!(
            *events.lock().unwrap(),
            ["old:drop", "new:open", "new:start"]
        );
        let status = backend.output_status().unwrap();
        assert!(status.active);
        assert_eq!(status.actual.unwrap().device_id, "new");
    }

    #[test]
    fn start_failure_reopens_the_pinned_old_output() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut backend = backend(plan("old", &events, false, None));
        backend.ensure_stream().unwrap();
        events.lock().unwrap().clear();
        assert!(backend
            .switch_prepared(plan("new", &events, true, None))
            .is_err());
        assert_eq!(
            *events.lock().unwrap(),
            [
                "old:drop",
                "new:open",
                "new:start",
                "new:drop",
                "old:open",
                "old:start"
            ]
        );
        let status = backend.output_status().unwrap();
        assert!(status.active);
        assert_eq!(status.actual.unwrap().device_id, "old");
    }

    #[test]
    fn failed_candidate_and_failed_restore_leave_paused_unavailable() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut backend = backend(plan("old", &events, false, Some(2)));
        backend.ensure_stream().unwrap();
        assert!(backend
            .switch_prepared(plan("new", &events, true, None))
            .is_err());
        let status = backend.output_status().unwrap();
        assert!(!status.active);
        assert!(status.actual.is_none());
        assert!(status
            .last_error
            .unwrap()
            .contains("previous output could not be restored"));
        assert!(!backend.eq_status().unwrap().active);
        assert!(backend.take_transport_error().is_some());
        assert!(backend.play().is_err());
    }

    #[test]
    fn invalid_candidate_leaves_the_old_output_untouched() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut backend = backend(plan("old", &events, false, None));
        backend.ensure_stream().unwrap();
        events.lock().unwrap().clear();
        let mut invalid = plan("new", &events, false, None);
        if let OutputPlan::Test(plan) = &mut invalid {
            plan.actual.sample_rate = 0;
        }
        assert!(backend.switch_prepared(invalid).is_err());
        assert!(events.lock().unwrap().is_empty());
        assert_eq!(
            backend.output_status().unwrap().actual.unwrap().device_id,
            "old"
        );
    }

    #[test]
    fn working_output_keeps_a_rejected_draft_reason() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut backend = backend(plan("old", &events, false, None));
        backend.ensure_stream().unwrap();
        let requested = OutputPreferences {
            mode: OutputMode::Exclusive,
            ..Default::default()
        };
        assert!(backend
            .configure_prepared(
                requested,
                Err(AudioError::DeviceUnavailable("exclusive rejected".into()))
            )
            .is_err());
        backend.ensure_stream().unwrap();
        let status = backend.output_status().unwrap();
        assert_eq!(status.requested.mode, OutputMode::Exclusive);
        assert_eq!(status.accepted.mode, OutputMode::Shared);
        assert_eq!(status.actual.unwrap().mode, OutputMode::Shared);
        assert!(status.last_error.unwrap().contains("exclusive rejected"));
        assert!(status.active);
    }

    #[test]
    fn bootstrap_missing_device_blocks_default_playback_until_explicit_reselection() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut backend = backend(plan("constructor-default-speakers", &events, false, None));
        let requested = OutputPreferences {
            device_id: Some("missing-usb".into()),
            ..Default::default()
        };
        assert!(backend
            .configure_prepared(
                requested.clone(),
                Err(AudioError::DeviceUnavailable("missing-usb".into()))
            )
            .is_err());
        assert!(matches!(
            backend.play(),
            Err(AudioError::DeviceUnavailable(_))
        ));
        assert!(matches!(
            backend.load("never-open-this-source.wav"),
            Err(AudioError::DeviceUnavailable(_))
        ));
        assert!(events.lock().unwrap().is_empty());
        let status = backend.output_status().unwrap();
        assert_eq!(status.requested, requested);
        assert!(!status.active);
        assert!(status.actual.is_none());
        assert!(!backend.eq_status().unwrap().active);

        // A second failed selection remains unavailable, but an explicit valid
        // selection installs its own healthy stream and clears the output gate.
        assert!(backend
            .configure_prepared(
                requested.clone(),
                Err(AudioError::DeviceUnavailable("missing-usb".into()))
            )
            .is_err());
        assert!(backend.play().is_err());
        backend
            .configure_prepared(
                requested.clone(),
                Ok(plan("selected-usb", &events, false, None)),
            )
            .unwrap();
        backend.ensure_stream().unwrap();
        let status = backend.output_status().unwrap();
        assert!(status.active);
        assert_eq!(status.accepted, requested);
        assert_eq!(status.actual.unwrap().device_id, "selected-usb");
        assert!(status.last_error.is_none());
        assert_eq!(
            *events.lock().unwrap(),
            ["selected-usb:open", "selected-usb:start"]
        );
    }

    #[test]
    fn bootstrap_candidate_start_failure_also_blocks_constructor_default() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut backend = backend(plan("constructor-default-speakers", &events, false, None));
        let requested = OutputPreferences {
            device_id: Some("usb".into()),
            ..Default::default()
        };
        assert!(backend
            .configure_prepared(requested, Ok(plan("usb", &events, true, None)))
            .is_err());
        assert!(matches!(
            backend.play(),
            Err(AudioError::DeviceUnavailable(_))
        ));
        assert!(matches!(
            backend.load("never-open-this-source.wav"),
            Err(AudioError::DeviceUnavailable(_))
        ));
        assert_eq!(
            *events.lock().unwrap(),
            ["usb:open", "usb:start", "usb:drop"]
        );
    }

    #[test]
    fn asynchronous_device_failure_retires_the_stream_and_reports_transport_error() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut backend = backend(plan("old", &events, false, None));
        backend.ensure_stream().unwrap();
        backend.stream_failed.store(true, Ordering::Release);
        backend.maintain();
        assert!(!backend.output_status().unwrap().active);
        assert!(backend.stream.is_none());
        assert!(backend.take_transport_error().is_some());
    }
}
