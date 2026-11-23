// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Local device adapter for the shared headless playback renderer.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, SupportedStreamConfig};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use vmusic_core::{
    AudioBackend, AudioError, AudioSource, DeviceInfo, DspParams, MediaInfo, NextEvent, NextTrack,
    PrepareResult,
};

pub use crate::render::EQ_BANDS;
use crate::render::{RenderCore, RenderFormat, RenderOutput};
use crate::sleep_deadline::SleepDeadline;

pub struct CpalBackend {
    renderer: RenderCore,
    device: Option<Device>,
    config: Option<SupportedStreamConfig>,
    stream: Option<Stream>,
    stream_failed: Arc<AtomicBool>,
}

impl CpalBackend {
    pub fn new() -> Result<Self, AudioError> {
        Self::with_sleep_deadline(std::sync::Arc::new(SleepDeadline::new()))
    }

    pub(crate) fn with_sleep_deadline(
        sleep_deadline: std::sync::Arc<SleepDeadline>,
    ) -> Result<Self, AudioError> {
        let device = cpal::default_host()
            .default_output_device()
            .ok_or_else(|| AudioError::DeviceUnavailable("no default output device".into()))?;
        let config = pick_config(&device)?;
        let renderer = RenderCore::with_sleep_deadline(
            RenderFormat {
                sample_rate: config.sample_rate().0,
                channels: config.channels(),
            },
            Some(sleep_deadline),
        )?;
        Ok(Self {
            renderer,
            device: Some(device),
            config: Some(config),
            stream: None,
            stream_failed: Arc::new(AtomicBool::new(false)),
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
        let device = self.device.as_ref().ok_or_else(no_device)?;
        let config = self.config.as_ref().ok_or_else(no_device)?;
        let output = self.renderer.prepare_output(self.renderer.format())?;
        let id = output.id();
        let failed = Arc::new(AtomicBool::new(false));
        let stream = Self::build_stream(device, config, output, failed.clone())?;
        let previous = self.renderer.activate_output(id)?;
        if let Err(error) = stream.play() {
            self.renderer.activate_output(previous)?;
            return Err(AudioError::BackendInit(error.to_string()));
        }
        self.stream = Some(stream);
        self.stream_failed = failed;
        Ok(())
    }

    fn build_stream(
        device: &Device,
        config: &SupportedStreamConfig,
        mut output: RenderOutput,
        failed: Arc<AtomicBool>,
    ) -> Result<Stream, AudioError> {
        let channels = config.channels();
        device
            .build_output_stream(
                &config.config(),
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    output.render(data, channels);
                },
                move |err| {
                    failed.store(true, Ordering::Release);
                    tracing::warn!("audio output error: {err}");
                },
                None,
            )
            .map_err(|e| AudioError::BackendInit(e.to_string()))
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
        let host = cpal::default_host();
        let device = match id {
            None => host.default_output_device().ok_or_else(no_device)?,
            Some(name) => host
                .output_devices()
                .into_iter()
                .flatten()
                .find(|d| d.name().map(|n| n == name).unwrap_or(false))
                .ok_or_else(|| AudioError::DeviceUnavailable(name.into()))?,
        };
        let config = pick_config(&device)?;

        let next_format = RenderFormat {
            sample_rate: config.sample_rate().0,
            channels: config.channels(),
        };
        self.renderer.validate_format_change(next_format)?;

        if let Some(current) = &self.stream {
            let output = self.renderer.prepare_output(next_format)?;
            let next_id = output.id();
            let failed = Arc::new(AtomicBool::new(false));
            let next_stream = Self::build_stream(&device, &config, output, failed.clone())?;
            if !self.stream_failed.load(Ordering::Acquire) {
                current
                    .pause()
                    .map_err(|error| AudioError::BackendInit(error.to_string()))?;
            }
            let old_format = self.renderer.format();
            let previous = match self.renderer.activate_output(0) {
                Ok(previous) => previous,
                Err(error) => {
                    if let Err(restore) = current.play() {
                        let message = format!("{error}; resume failed: {restore}");
                        self.stream_failed.store(true, Ordering::Release);
                        self.renderer.output_failed(message.clone());
                        return Err(AudioError::BackendInit(message));
                    }
                    return Err(error);
                }
            };
            let start = (|| {
                self.renderer.set_format(next_format)?;
                self.renderer.activate_output(next_id)?;
                next_stream
                    .play()
                    .map_err(|error| AudioError::BackendInit(error.to_string()))
            })();
            if let Err(error) = start {
                let restore = (|| {
                    self.renderer.activate_output(0)?;
                    self.renderer.set_format(old_format)?;
                    self.renderer.activate_output(previous)?;
                    current
                        .play()
                        .map_err(|error| AudioError::BackendInit(error.to_string()))
                })();
                return Err(match restore {
                    Ok(()) => error,
                    Err(restore) => {
                        let message =
                            format!("{error}; previous output could not be restored: {restore}");
                        self.stream_failed.store(true, Ordering::Release);
                        self.renderer.output_failed(message.clone());
                        AudioError::BackendInit(message)
                    }
                });
            }
            self.stream = Some(next_stream);
            self.stream_failed = failed;
        } else {
            self.renderer.set_format(next_format)?;
        }
        self.device = Some(device);
        self.config = Some(config);
        Ok(())
    }

    fn load(&mut self, uri: &str) -> Result<MediaInfo, AudioError> {
        self.ensure_stream()?;
        self.renderer.load(uri)
    }

    fn load_source(
        &mut self,
        source: Box<dyn AudioSource>,
        ext: Option<String>,
    ) -> Result<MediaInfo, AudioError> {
        self.ensure_stream()?;
        self.renderer.load_source(source, ext)
    }

    fn play(&mut self) -> Result<(), AudioError> {
        self.ensure_stream()?;
        self.renderer.play()
    }

    fn pause(&mut self) -> Result<(), AudioError> {
        self.renderer.pause()
    }

    fn stop(&mut self) -> Result<(), AudioError> {
        self.renderer.stop()
    }

    fn seek(&mut self, position_ms: u64) -> Result<(), AudioError> {
        let previous = self.renderer.activate_output(0)?;
        let result = self.renderer.seek(position_ms);
        self.renderer.activate_output(previous)?;
        result
    }

    fn set_volume(&mut self, volume: f32) -> Result<(), AudioError> {
        self.renderer.set_volume(volume)
    }

    fn set_dsp(&mut self, params: DspParams) -> Result<(), AudioError> {
        self.renderer.set_dsp(params)
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
        if self.stream_failed.load(Ordering::Acquire)
            && self
                .renderer
                .eq_status()
                .is_some_and(|status| status.active)
        {
            self.renderer
                .output_failed("音频输出已失效，请重新选择输出设备后播放".into());
        }
        self.renderer.maintain()
    }
}

impl Drop for CpalBackend {
    fn drop(&mut self) {
        // Stop callbacks before the renderer retires its decoder threads.
        self.stream = None;
    }
}

fn no_device() -> AudioError {
    AudioError::DeviceUnavailable("output device not initialised".into())
}

fn pick_config(device: &Device) -> Result<SupportedStreamConfig, AudioError> {
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
