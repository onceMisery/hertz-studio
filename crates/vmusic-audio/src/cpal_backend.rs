// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Local device adapter for the shared headless playback renderer.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, Stream, SupportedStreamConfig};
use vmusic_core::{
    AudioBackend, AudioError, AudioSource, DeviceInfo, DspParams, MediaInfo, NextEvent, NextTrack,
    PrepareResult,
};

pub use crate::render::EQ_BANDS;
use crate::render::{RenderCore, RenderFormat, RenderOutput};

pub struct CpalBackend {
    renderer: RenderCore,
    device: Option<Device>,
    config: Option<SupportedStreamConfig>,
    stream: Option<Stream>,
}

impl CpalBackend {
    pub fn new() -> Result<Self, AudioError> {
        let device = cpal::default_host()
            .default_output_device()
            .ok_or_else(|| AudioError::DeviceUnavailable("no default output device".into()))?;
        let config = pick_config(&device)?;
        let renderer = RenderCore::new(RenderFormat {
            sample_rate: config.sample_rate().0,
            channels: config.channels(),
        })?;
        Ok(Self {
            renderer,
            device: Some(device),
            config: Some(config),
            stream: None,
        })
    }

    fn ensure_stream(&mut self) -> Result<(), AudioError> {
        if self.stream.is_some() {
            return Ok(());
        }
        let device = self.device.as_ref().ok_or_else(no_device)?;
        let config = self.config.as_ref().ok_or_else(no_device)?;
        let stream = Self::build_stream(device, config, self.renderer.output())?;
        stream
            .play()
            .map_err(|e| AudioError::BackendInit(e.to_string()))?;
        self.stream = Some(stream);
        Ok(())
    }

    fn build_stream(
        device: &Device,
        config: &SupportedStreamConfig,
        output: RenderOutput,
    ) -> Result<Stream, AudioError> {
        let channels = config.channels();
        device
            .build_output_stream(
                &config.config(),
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    output.render(data, channels);
                },
                |err| tracing::warn!("audio output error: {err}"),
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

        let next_stream = if self.stream.is_some() {
            Some(Self::build_stream(
                &device,
                &config,
                self.renderer.output(),
            )?)
        } else {
            None
        };
        if let Some(stream) = &next_stream {
            if let Some(current) = &self.stream {
                current
                    .pause()
                    .map_err(|error| AudioError::BackendInit(error.to_string()))?;
            }
            if let Err(error) = stream.play() {
                if let Some(current) = &self.stream {
                    let _ = current.play();
                }
                return Err(AudioError::BackendInit(error.to_string()));
            }
        }
        self.stream = next_stream;
        self.renderer.set_format(next_format)?;
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
        self.renderer.seek(position_ms)
    }

    fn set_volume(&mut self, volume: f32) -> Result<(), AudioError> {
        self.renderer.set_volume(volume)
    }

    fn set_dsp(&mut self, params: DspParams) -> Result<(), AudioError> {
        self.renderer.set_dsp(params)
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
