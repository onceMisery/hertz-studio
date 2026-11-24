// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Exclusive local sink, owned by CpalBackend. This is an adapter around the
//! shared RenderOutput, with no decoder, mixer, presentation queue, or DSP copy.
//! All COM interfaces stay on their creating MTA thread.

use super::quantize::Quantizer;
use super::TerminalOutput;
use crate::render::RenderFormat;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use vmusic_core::output::{
    DitherMode, OutputActual, OutputMode, OutputPreferences, OutputSampleFormat,
};
use vmusic_core::AudioError;
use windows::core::{w, GUID, PCWSTR, PWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
use windows::Win32::System::Com::StructuredStorage::{
    PropVariantClear, PropVariantToStringAlloc, PROPVARIANT,
};
use windows::Win32::System::Com::*;
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, AvSetMmThreadPriority,
    CreateEventW, SetEvent, WaitForMultipleObjects, AVRT_PRIORITY_HIGH,
};

// The PCM subtype is WAVE_FORMAT_PCM encoded with the standard audio GUID tail.
const PCM_SUBTYPE: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
const MAX_BUFFER_FRAMES: usize = 65_536;

#[derive(Clone)]
pub(crate) struct Plan {
    pub(super) actual: OutputActual,
    extensible: bool,
}

impl Plan {
    pub(super) fn probe(
        preferences: OutputPreferences,
        preferred: Option<RenderFormat>,
    ) -> Result<Self, AudioError> {
        thread::Builder::new()
            .name("local-wasapi-probe".into())
            .spawn(move || {
                let _apartment = Apartment::new()?;
                Self::probe_inner(&preferences, preferred)
            })
            .map_err(|e| AudioError::BackendInit(e.to_string()))?
            .join()
            .map_err(|_| AudioError::BackendInit("WASAPI probe thread failed".into()))?
    }

    fn probe_inner(
        preferences: &OutputPreferences,
        preferred: Option<RenderFormat>,
    ) -> Result<Self, AudioError> {
        // SAFETY: COM is initialized on this thread; returned task allocations
        // are immediately wrapped and all native objects are destroyed here.
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(backend)?;
            let device = select_device(&enumerator, preferences.device_id.as_deref())?;
            let name = device_name(&device)?;
            let endpoint = endpoint_id(&device)?;
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(backend)?;
            let mix = TaskMem(client.GetMixFormat().map_err(backend)?);
            let mix_rate = (*mix.0).nSamplesPerSec;
            let mix_channels = (*mix.0).nChannels;
            let mut channel_candidates = Vec::with_capacity(2);
            for channels in [
                preferred.map(|f| f.channels).unwrap_or(mix_channels),
                mix_channels,
                2,
                1,
            ] {
                if (1..=2).contains(&channels) && !channel_candidates.contains(&channels) {
                    channel_candidates.push(channels);
                }
            }
            let mut rates = Vec::with_capacity(4);
            for rate in [
                preferred.map(|f| f.sample_rate).unwrap_or(mix_rate),
                mix_rate,
                48_000,
                44_100,
            ] {
                if (8_000..=768_000).contains(&rate) && !rates.contains(&rate) {
                    rates.push(rate);
                }
            }
            let formats: &[(OutputSampleFormat, u16, u16)] = match preferences.sample_format {
                OutputSampleFormat::Auto => &[
                    (OutputSampleFormat::F32, 32, 32),
                    (OutputSampleFormat::S24, 32, 24),
                    (OutputSampleFormat::S24, 24, 24),
                    (OutputSampleFormat::S16, 16, 16),
                ],
                OutputSampleFormat::F32 => &[(OutputSampleFormat::F32, 32, 32)],
                OutputSampleFormat::S16 => &[(OutputSampleFormat::S16, 16, 16)],
                OutputSampleFormat::S24 => &[
                    (OutputSampleFormat::S24, 32, 24),
                    (OutputSampleFormat::S24, 24, 24),
                ],
            };
            for rate in rates {
                for &channels in &channel_candidates {
                    for &(sample_format, container_bits, valid_bits) in formats {
                        for extensible in [true, false] {
                            if !extensible && container_bits != valid_bits {
                                continue;
                            }
                            let dither_active = sample_format != OutputSampleFormat::F32
                                && preferences.dither == DitherMode::Auto;
                            let plan = Self {
                                actual: OutputActual {
                                    device_id: name.clone(),
                                    endpoint_id: Some(endpoint.clone()),
                                    backend: "wasapi/local-exclusive-event".into(),
                                    mode: OutputMode::Exclusive,
                                    sample_rate: rate,
                                    channels,
                                    sample_format,
                                    container_bits,
                                    valid_bits,
                                    dither_active,
                                    dither_reason: if sample_format == OutputSampleFormat::F32 {
                                        Some("not_applicable_float_output".into())
                                    } else if !dither_active {
                                        Some("disabled_by_user".into())
                                    } else {
                                        None
                                    },
                                },
                                extensible,
                            };
                            let format = plan.wave_format();
                            // Exclusive mode requires S_OK, never the shared-mode
                            // S_FALSE/closest-match semantics or automatic conversion.
                            if client
                                .IsFormatSupported(
                                    AUDCLNT_SHAREMODE_EXCLUSIVE,
                                    &format.Format,
                                    None,
                                )
                                .0
                                == 0
                            {
                                return Ok(plan);
                            }
                        }
                    }
                }
            }
            Err(AudioError::UnsupportedFormat(
                "device_has_no_supported_exclusive_mono_stereo_pcm_format".into(),
            ))
        }
    }

    fn wave_format(&self) -> WAVEFORMATEXTENSIBLE {
        let actual = &self.actual;
        let block = actual.channels * (actual.container_bits / 8);
        let float = actual.sample_format == OutputSampleFormat::F32;
        WAVEFORMATEXTENSIBLE {
            Format: WAVEFORMATEX {
                wFormatTag: if self.extensible {
                    0xfffe
                } else if float {
                    3
                } else {
                    1
                },
                nChannels: actual.channels,
                nSamplesPerSec: actual.sample_rate,
                nAvgBytesPerSec: actual.sample_rate * u32::from(block),
                nBlockAlign: block,
                wBitsPerSample: actual.container_bits,
                cbSize: if self.extensible { 22 } else { 0 },
            },
            Samples: WAVEFORMATEXTENSIBLE_0 {
                wValidBitsPerSample: actual.valid_bits,
            },
            dwChannelMask: if actual.channels == 1 { 4 } else { 3 },
            SubFormat: if float {
                KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
            } else {
                PCM_SUBTYPE
            },
        }
    }
}

struct Apartment;
impl Apartment {
    fn new() -> Result<Self, AudioError> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(backend)?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

struct TaskMem<T>(*mut T);
impl<T> Drop for TaskMem<T> {
    fn drop(&mut self) {
        unsafe {
            CoTaskMemFree(Some(self.0.cast()));
        }
    }
}
struct Variant(PROPVARIANT);
impl Drop for Variant {
    fn drop(&mut self) {
        unsafe {
            let _ = PropVariantClear(&mut self.0);
        }
    }
}

fn endpoint_id(device: &IMMDevice) -> Result<String, AudioError> {
    unsafe {
        let text = TaskMem(device.GetId().map_err(backend)?.0);
        PWSTR(text.0)
            .to_string()
            .map_err(|error| AudioError::BackendInit(error.to_string()))
    }
}

fn device_name(device: &IMMDevice) -> Result<String, AudioError> {
    unsafe {
        let properties = device.OpenPropertyStore(STGM_READ).map_err(backend)?;
        let value = Variant(
            properties
                .GetValue(&PKEY_Device_FriendlyName)
                .map_err(backend)?,
        );
        let text = TaskMem(PropVariantToStringAlloc(&value.0).map_err(backend)?.0);
        PWSTR(text.0)
            .to_string()
            .map_err(|error| AudioError::BackendInit(error.to_string()))
    }
}

fn select_device(
    enumerator: &IMMDeviceEnumerator,
    name: Option<&str>,
) -> Result<IMMDevice, AudioError> {
    unsafe {
        let Some(name) = name else {
            return enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(backend);
        };
        let collection = enumerator
            .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
            .map_err(backend)?;
        let mut found = None;
        for index in 0..collection.GetCount().map_err(backend)? {
            let device = collection.Item(index).map_err(backend)?;
            if device_name(&device)? == name || endpoint_id(&device)? == name {
                if found.is_some() {
                    return Err(AudioError::DeviceUnavailable(
                        "ambiguous output device name".into(),
                    ));
                }
                found = Some(device);
            }
        }
        found.ok_or_else(|| {
            AudioError::DeviceUnavailable("selected WASAPI output device not found".into())
        })
    }
}

struct Event(HANDLE);
// Windows kernel event handles, unlike COM interfaces, are explicitly usable
// across threads. Arc keeps the cancellation handle alive through join().
unsafe impl Send for Event {}
unsafe impl Sync for Event {}
impl Event {
    fn new(manual: bool) -> Result<Self, AudioError> {
        unsafe {
            CreateEventW(None, manual, false, PCWSTR::null())
                .map(Self)
                .map_err(backend)
        }
    }
}
impl Drop for Event {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct Cancel {
    event: Event,
    stop: AtomicBool,
}

struct Scheduling(HANDLE);
impl Scheduling {
    fn new() -> Result<Self, AudioError> {
        unsafe {
            let mut index = 0;
            let result =
                Self(AvSetMmThreadCharacteristicsW(w!("Audio"), &mut index).map_err(backend)?);
            AvSetMmThreadPriority(result.0, AVRT_PRIORITY_HIGH).map_err(backend)?;
            Ok(result)
        }
    }
}
impl Drop for Scheduling {
    fn drop(&mut self) {
        unsafe {
            let _ = AvRevertMmThreadCharacteristics(self.0);
        }
    }
}

struct Health {
    cancel: Arc<Cancel>,
    failed: Arc<AtomicBool>,
}
impl Drop for Health {
    fn drop(&mut self) {
        if !self.cancel.stop.load(Ordering::Acquire) {
            self.failed.store(true, Ordering::Release);
        }
    }
}

type StartReply = mpsc::SyncSender<Result<(), AudioError>>;

pub(super) struct NativeStream {
    cancel: Arc<Cancel>,
    start_tx: Option<mpsc::SyncSender<StartReply>>,
    started: AtomicBool,
    worker: Option<JoinHandle<()>>,
}

impl NativeStream {
    pub(super) fn open(
        plan: Plan,
        terminal: TerminalOutput,
        failed: Arc<AtomicBool>,
        seed: u64,
    ) -> Result<Self, AudioError> {
        let cancel = Arc::new(Cancel {
            event: Event::new(true)?,
            stop: AtomicBool::new(false),
        });
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (start_tx, start_rx) = mpsc::sync_channel::<StartReply>(1);
        let worker_cancel = cancel.clone();
        let worker = thread::Builder::new()
            .name("local-wasapi-render".into())
            .spawn(move || {
                let _health = Health {
                    cancel: worker_cancel.clone(),
                    failed,
                };
                let apartment = Apartment::new();
                let setup = apartment
                    .as_ref()
                    .map_err(|error| AudioError::BackendInit(error.to_string()))
                    .and_then(|_| Session::new(plan, terminal, seed));
                match setup {
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                    }
                    Ok(mut session) => {
                        if ready_tx.send(Ok(())).is_err() {
                            return;
                        }
                        // Candidate initialization is separate from activation. No
                        // real media is submitted until the actor grants ownership.
                        let Ok(reply) = start_rx.recv() else {
                            return;
                        };
                        if worker_cancel.stop.load(Ordering::Acquire) {
                            return;
                        }
                        match unsafe { session.client.Start() } {
                            Err(error) => {
                                let _ = reply.send(Err(backend(error)));
                            }
                            Ok(()) => {
                                if reply.send(Ok(())).is_ok() {
                                    if let Err(error) = session.run(&worker_cancel) {
                                        tracing::warn!("local WASAPI output error: {error}");
                                    }
                                }
                            }
                        }
                    }
                }
            })
            .map_err(|error| AudioError::BackendInit(error.to_string()))?;
        let result = Self {
            cancel,
            start_tx: Some(start_tx),
            started: AtomicBool::new(false),
            worker: Some(worker),
        };
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| {
                AudioError::BackendInit("WASAPI device initialization did not complete".into())
            })??;
        Ok(result)
    }

    pub(super) fn start(&self) -> Result<(), AudioError> {
        if self.started.load(Ordering::Acquire) {
            return Ok(());
        }
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.start_tx
            .as_ref()
            .ok_or_else(|| AudioError::BackendInit("WASAPI output closed".into()))?
            .send(reply_tx)
            .map_err(|_| {
                AudioError::BackendInit("WASAPI output thread ended before start".into())
            })?;
        reply_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| {
                AudioError::BackendInit("WASAPI device start did not complete".into())
            })??;
        self.started.store(true, Ordering::Release);
        Ok(())
    }
}

impl Drop for NativeStream {
    fn drop(&mut self) {
        self.cancel.stop.store(true, Ordering::Release);
        self.start_tx.take();
        unsafe {
            let _ = SetEvent(self.cancel.event.0);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Session {
    client: IAudioClient,
    render: IAudioRenderClient,
    event: Event,
    terminal: TerminalOutput,
    scratch: Vec<f32>,
    quantizer: Option<Quantizer>,
    epoch: u64,
    frames: u32,
    container_bits: u16,
    _scheduling: Scheduling,
}

impl Session {
    fn new(plan: Plan, terminal: TerminalOutput, seed: u64) -> Result<Self, AudioError> {
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(backend)?;
            let endpoint =
                plan.actual.endpoint_id.as_deref().ok_or_else(|| {
                    AudioError::DeviceUnavailable("missing pinned endpoint".into())
                })?;
            let wide: Vec<u16> = endpoint.encode_utf16().chain(std::iter::once(0)).collect();
            let device = enumerator
                .GetDevice(PCWSTR(wide.as_ptr()))
                .map_err(backend)?;
            if device.GetState().map_err(backend)? != DEVICE_STATE_ACTIVE
                || endpoint_id(&device)? != endpoint
            {
                return Err(AudioError::DeviceUnavailable(
                    "prepared_output_endpoint_changed".into(),
                ));
            }
            let mut client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(backend)?;
            let format = plan.wave_format();
            let supported =
                client.IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &format.Format, None);
            if supported.0 != 0 {
                return Err(AudioError::UnsupportedFormat(format!(
                    "prepared_exclusive_format_changed: {supported:?}"
                )));
            }
            let mut period = 0;
            client
                .GetDevicePeriod(Some(&mut period), None)
                .map_err(backend)?;
            if !(1..=5_000_000).contains(&period) {
                return Err(AudioError::UnsupportedFormat(
                    "exclusive_device_period_out_of_budget".into(),
                ));
            }
            let initialized = client.Initialize(
                AUDCLNT_SHAREMODE_EXCLUSIVE,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                period,
                period,
                &format.Format,
                None,
            );
            if let Err(error) = initialized {
                if error.code() != AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED {
                    return Err(backend(error));
                }
                let frames = client.GetBufferSize().map_err(backend)?;
                // Microsoft requires releasing the failed client, activating a
                // fresh one, and retrying once with its aligned frame duration.
                drop(client);
                period = aligned_period(frames, plan.actual.sample_rate)?;
                client = device.Activate(CLSCTX_ALL, None).map_err(backend)?;
                client
                    .Initialize(
                        AUDCLNT_SHAREMODE_EXCLUSIVE,
                        AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                        period,
                        period,
                        &format.Format,
                        None,
                    )
                    .map_err(backend)?;
            }
            let frames = client.GetBufferSize().map_err(backend)?;
            if frames == 0 || frames as usize > MAX_BUFFER_FRAMES {
                return Err(AudioError::UnsupportedFormat(
                    "exclusive_buffer_exceeds_local_output_budget".into(),
                ));
            }
            let samples = frames as usize * usize::from(plan.actual.channels);
            let event = Event::new(false)?;
            client.SetEventHandle(event.0).map_err(backend)?;
            let render: IAudioRenderClient = client.GetService().map_err(backend)?;
            let quantizer = (plan.actual.sample_format != OutputSampleFormat::F32).then(|| {
                Quantizer::new(
                    plan.actual.channels,
                    plan.actual.valid_bits,
                    plan.actual.dither_active,
                    seed,
                )
            });
            let scheduling = Scheduling::new()?;
            render.GetBuffer(frames).map_err(backend)?;
            render
                .ReleaseBuffer(frames, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
                .map_err(backend)?;
            Ok(Self {
                client,
                render,
                event,
                terminal,
                scratch: vec![0.0; samples],
                quantizer,
                epoch: 0,
                frames,
                container_bits: plan.actual.container_bits,
                _scheduling: scheduling,
            })
        }
    }

    fn run(&mut self, cancel: &Cancel) -> Result<(), AudioError> {
        let mut timeouts = 0;
        loop {
            if cancel.stop.load(Ordering::Acquire) {
                return Ok(());
            }
            let ready =
                unsafe { WaitForMultipleObjects(&[cancel.event.0, self.event.0], false, 250) };
            if ready == WAIT_OBJECT_0 || cancel.stop.load(Ordering::Acquire) {
                return Ok(());
            }
            if ready == WAIT_TIMEOUT {
                timeouts += 1;
                if timeouts < 4 {
                    continue;
                }
                return Err(AudioError::DeviceUnavailable(
                    "exclusive_output_event_timeout".into(),
                ));
            }
            if ready.0 != WAIT_OBJECT_0.0 + 1 {
                return Err(backend(windows::core::Error::from_win32()));
            }
            timeouts = 0;
            self.render_ready()?;
        }
    }

    fn render_ready(&mut self) -> Result<(), AudioError> {
        let epoch = self.terminal.control.reset_epoch.load(Ordering::Acquire);
        if epoch != self.epoch {
            if let Some(quantizer) = &mut self.quantizer {
                quantizer.reset(epoch);
            }
            self.epoch = epoch;
        }
        // Exclusive event mode always consumes the whole ping-pong buffer.
        // Scratch and quantizer are allocated before the render thread starts.
        unsafe {
            let data = self.render.GetBuffer(self.frames).map_err(backend)?;
            let live = self.terminal.render(&mut self.scratch);
            if live == 0 {
                self.render
                    .ReleaseBuffer(self.frames, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
                    .map_err(backend)?;
            } else {
                if let Some(quantizer) = &mut self.quantizer {
                    let bytes = std::slice::from_raw_parts_mut(
                        data,
                        self.scratch.len() * usize::from(self.container_bits / 8),
                    );
                    quantizer.write_range(
                        &self.scratch,
                        bytes,
                        self.container_bits,
                        self.terminal.output.leading_silence_samples(),
                        live,
                    );
                } else {
                    // The exact negotiated float format has 32-bit samples and
                    // matching block alignment; no float dither is ever added.
                    let samples =
                        std::slice::from_raw_parts_mut(data.cast::<f32>(), self.scratch.len());
                    samples.copy_from_slice(&self.scratch);
                }
                // Quantization is downstream of RenderOutput, so retain and
                // recheck the same callback deadline after packing as well.
                let flags = if self.terminal.expired() {
                    AUDCLNT_BUFFERFLAGS_SILENT.0 as u32
                } else {
                    0
                };
                self.render
                    .ReleaseBuffer(self.frames, flags)
                    .map_err(backend)?;
            }
        }
        Ok(())
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Stop/reset before dropping native interfaces or the owning apartment.
        unsafe {
            let _ = self.client.Stop();
            let _ = self.client.Reset();
        }
    }
}

fn aligned_period(frames: u32, rate: u32) -> Result<i64, AudioError> {
    if frames == 0 || frames as usize > MAX_BUFFER_FRAMES || !(8_000..=768_000).contains(&rate) {
        return Err(AudioError::UnsupportedFormat(
            "invalid_exclusive_aligned_buffer".into(),
        ));
    }
    let period = (u64::from(frames) * 10_000_000 + u64::from(rate / 2)) / u64::from(rate);
    if !(1..=5_000_000).contains(&period) {
        return Err(AudioError::UnsupportedFormat(
            "exclusive_aligned_period_out_of_budget".into(),
        ));
    }
    Ok(period as i64)
}

fn backend(error: windows::core::Error) -> AudioError {
    AudioError::BackendInit(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn format_plan(
        sample_format: OutputSampleFormat,
        container_bits: u16,
        valid_bits: u16,
        channels: u16,
        extensible: bool,
    ) -> Plan {
        Plan {
            actual: OutputActual {
                device_id: "test".into(),
                endpoint_id: Some("pinned-test-endpoint".into()),
                backend: "test".into(),
                mode: OutputMode::Exclusive,
                sample_rate: 48_000,
                channels,
                sample_format,
                container_bits,
                valid_bits,
                dither_active: sample_format != OutputSampleFormat::F32,
                dither_reason: None,
            },
            extensible,
        }
    }

    #[test]
    fn native_formats_distinguish_container_width_valid_bits_and_channel_mask() {
        for (sample_format, container, valid) in [
            (OutputSampleFormat::S16, 16, 16),
            (OutputSampleFormat::S24, 24, 24),
            (OutputSampleFormat::S24, 32, 24),
            (OutputSampleFormat::F32, 32, 32),
        ] {
            for channels in [1, 2] {
                let wave =
                    format_plan(sample_format, container, valid, channels, true).wave_format();
                // Copy packed fields to aligned locals before comparing them.
                let observed = (
                    wave.Format.wFormatTag,
                    wave.Format.wBitsPerSample,
                    unsafe { wave.Samples.wValidBitsPerSample },
                    wave.Format.nBlockAlign,
                    wave.Format.nAvgBytesPerSec,
                    wave.dwChannelMask,
                    wave.Format.cbSize,
                );
                let block = channels * (container / 8);
                assert_eq!(
                    observed,
                    (
                        0xfffe,
                        container,
                        valid,
                        block,
                        48_000 * u32::from(block),
                        if channels == 1 { 4 } else { 3 },
                        22
                    )
                );
                let subtype = wave.SubFormat;
                assert_eq!(
                    subtype,
                    if sample_format == OutputSampleFormat::F32 {
                        KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
                    } else {
                        PCM_SUBTYPE
                    }
                );
            }
        }
    }

    #[test]
    fn legacy_wave_format_candidates_use_exact_float_or_pcm_tags() {
        for (sample_format, bits, tag) in [
            (OutputSampleFormat::F32, 32, 3),
            (OutputSampleFormat::S16, 16, 1),
            (OutputSampleFormat::S24, 24, 1),
        ] {
            let wave = format_plan(sample_format, bits, bits, 2, false).wave_format();
            let fields = (
                wave.Format.wFormatTag,
                wave.Format.cbSize,
                wave.Format.wBitsPerSample,
            );
            assert_eq!(fields, (tag, 0, bits));
        }
    }

    #[test]
    fn aligned_event_period_uses_documented_rounding_and_bounds() {
        assert_eq!(aligned_period(480, 48_000).unwrap(), 100_000);
        assert_eq!(aligned_period(128, 44_100).unwrap(), 29_025);
        assert!(aligned_period(0, 48_000).is_err());
        assert!(aligned_period(65_537, 48_000).is_err());
        assert!(aligned_period(65_536, 8_000).is_err());
    }

    #[test]
    fn cancellation_wakes_without_a_device_event() {
        let cancel = Arc::new(Cancel {
            event: Event::new(true).unwrap(),
            stop: AtomicBool::new(false),
        });
        let worker_cancel = cancel.clone();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let render = Event::new(false).unwrap();
            ready_tx.send(()).unwrap();
            assert_eq!(
                unsafe { WaitForMultipleObjects(&[worker_cancel.event.0, render.0], false, 1000) },
                WAIT_OBJECT_0
            );
        });
        ready_rx.recv().unwrap();
        drop(NativeStream {
            cancel,
            start_tx: None,
            started: AtomicBool::new(false),
            worker: Some(worker),
        });
    }

    #[test]
    fn unexpected_thread_exit_sets_unavailable_but_cancel_does_not() {
        let cancel = Arc::new(Cancel {
            event: Event::new(true).unwrap(),
            stop: AtomicBool::new(false),
        });
        let failed = Arc::new(AtomicBool::new(false));
        drop(Health {
            cancel: cancel.clone(),
            failed: failed.clone(),
        });
        assert!(failed.load(Ordering::Acquire));
        failed.store(false, Ordering::Release);
        cancel.stop.store(true, Ordering::Release);
        drop(Health {
            cancel,
            failed: failed.clone(),
        });
        assert!(!failed.load(Ordering::Acquire));
    }
}
