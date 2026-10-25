// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! The sole scheduled-output WASAPI session. Every COM interface is created,
//! used and released on this dedicated MTA thread. Only the cancellation event
//! crosses threads. There is no second stream, queue, converter or timer poll.

use super::wasapi_clock::{qpc_100ns, DeviceSample, NativeClock};
use super::*;
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use windows::core::{w, Interface, PCWSTR, PWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
use windows::Win32::System::Com::StructuredStorage::{
    PropVariantClear, PropVariantToStringAlloc, PROPVARIANT,
};
use windows::Win32::System::Com::*;
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, AvSetMmThreadPriority,
    CreateEventW, SetEvent, WaitForMultipleObjects, AVRT_PRIORITY_HIGH,
};

struct Event(HANDLE);
// Kernel event handles are explicitly usable across threads; ownership remains
// in this Arc and CloseHandle runs only after the render thread has joined.
unsafe impl Send for Event {}
unsafe impl Sync for Event {}
impl Event {
    fn new(manual: bool) -> windows::core::Result<Self> {
        // SAFETY: unnamed event, default security, valid booleans.
        unsafe { CreateEventW(None, manual, false, PCWSTR::null()).map(Self) }
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

/// An unexpected return or panic must never leave a live producer believing
/// that a terminated device thread can still present its queued PCM.
struct RenderHealth<'a> {
    shared: &'a Shared,
    cancel: &'a Cancel,
}
impl Drop for RenderHealth<'_> {
    fn drop(&mut self) {
        if !self.cancel.stop.load(Ordering::Acquire) {
            self.shared.muted.store(true, Ordering::Release);
            self.shared.device_error.store(true, Ordering::Release);
            self.shared.status(ClockStatus::DeviceError);
            self.shared
                .clear(self.shared.written.load(Ordering::Acquire));
        }
    }
}

pub(super) struct NativeStream {
    cancel: Arc<Cancel>,
    thread: Option<JoinHandle<()>>,
}
impl Drop for NativeStream {
    fn drop(&mut self) {
        self.cancel.stop.store(true, Ordering::Release);
        // The cancellation event has priority over the render-ready event.
        unsafe {
            let _ = SetEvent(self.cancel.event.0);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct ComApartment;
impl ComApartment {
    fn new() -> windows::core::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        }
        Ok(Self)
    }
}
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
struct AudioScheduling(HANDLE);
impl AudioScheduling {
    fn new() -> windows::core::Result<Self> {
        unsafe {
            let mut index = 0;
            let scheduling = Self(AvSetMmThreadCharacteristicsW(w!("Audio"), &mut index)?);
            AvSetMmThreadPriority(scheduling.0, AVRT_PRIORITY_HIGH)?;
            Ok(scheduling)
        }
    }
}
impl Drop for AudioScheduling {
    fn drop(&mut self) {
        unsafe {
            let _ = AvRevertMmThreadCharacteristics(self.0);
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

fn backend(error: windows::core::Error) -> AudioError {
    AudioError::BackendInit(error.to_string())
}

pub(super) fn open(options: OutputOptions) -> Result<ScheduledOutput, AudioError> {
    let cancel = Arc::new(Cancel {
        event: Event::new(true).map_err(backend)?,
        stop: AtomicBool::new(false),
    });
    let render_cancel = Arc::clone(&cancel);
    let clock_origin = options.clock_origin;
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let thread = thread::Builder::new()
        .name("scheduled-wasapi".into())
        .spawn(move || {
            let apartment = ComApartment::new().map_err(backend);
            let setup = apartment
                .as_ref()
                .map_err(|error| AudioError::BackendInit(error.to_string()))
                .and_then(|_| Session::new(&options));
            match setup {
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                }
                Ok((mut session, queue, binding)) => {
                    let shared = Arc::clone(&queue.shared);
                    match unsafe { session.client.Start() } {
                        Err(error) => {
                            let _ = ready_tx.send(Err(backend(error)));
                        }
                        Ok(()) => {
                            if ready_tx.send(Ok((queue, binding))).is_ok() {
                                let _health = RenderHealth {
                                    shared: &shared,
                                    cancel: &render_cancel,
                                };
                                let _ = session.run(&render_cancel);
                            }
                        }
                    }
                }
            }
            drop(apartment);
        })
        .map_err(|error| AudioError::BackendInit(error.to_string()))?;
    let stream = NativeStream {
        cancel,
        thread: Some(thread),
    };
    let (queue, binding) = ready_rx.recv().map_err(|_| {
        AudioError::BackendInit("WASAPI render thread exited during setup".into())
    })??;
    Ok(ScheduledOutput {
        stream: Some(stream),
        queue,
        clock_origin,
        binding,
    })
}

fn device_name(device: &IMMDevice) -> windows::core::Result<String> {
    unsafe {
        let properties = device.OpenPropertyStore(STGM_READ)?;
        let value = Variant(properties.GetValue(&PKEY_Device_FriendlyName)?);
        let text = PropVariantToStringAlloc(&value.0)?;
        let owned = TaskMem(text.0);
        let name = PWSTR(owned.0).to_string()?;
        Ok(name)
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
            if device_name(&device).map_err(backend)? == name {
                if found.is_some() {
                    return Err(AudioError::DeviceUnavailable(
                        "ambiguous scheduled output device name".into(),
                    ));
                }
                found = Some(device);
            }
        }
        found.ok_or_else(|| {
            AudioError::DeviceUnavailable("scheduled output device not found".into())
        })
    }
}

struct QpcOrigin {
    frequency: i64,
    qpc_100ns: u64,
    local_ns: u64,
    uncertainty_ns: u64,
}
impl QpcOrigin {
    fn new(origin: Instant) -> windows::core::Result<Self> {
        let mut frequency = 0;
        unsafe {
            QueryPerformanceFrequency(&mut frequency)?;
        }
        let mut best = None;
        for _ in 0..16 {
            let mut before = 0;
            let mut after = 0;
            unsafe {
                QueryPerformanceCounter(&mut before)?;
            }
            let local_ns = u64::try_from(origin.elapsed().as_nanos())
                .map_err(|_| windows::core::Error::from_win32())?;
            unsafe {
                QueryPerformanceCounter(&mut after)?;
            }
            let before =
                qpc_100ns(before, frequency).ok_or_else(windows::core::Error::from_win32)?;
            let after = qpc_100ns(after, frequency).ok_or_else(windows::core::Error::from_win32)?;
            if let Some(span) = after.checked_sub(before) {
                if best.is_none_or(|(old, _, _)| span < old) {
                    best = Some((span, before, local_ns));
                }
            }
        }
        let (span, before, local_ns) = best
            .filter(|(span, _, _)| *span <= 100)
            .ok_or_else(windows::core::Error::from_win32)?;
        Ok(Self {
            frequency,
            qpc_100ns: before + span / 2,
            local_ns,
            uncertainty_ns: span * 50 + 100,
        })
    }
    fn now(&self) -> windows::core::Result<(u64, u64)> {
        let mut counter = 0;
        unsafe {
            QueryPerformanceCounter(&mut counter)?;
        }
        let qpc =
            qpc_100ns(counter, self.frequency).ok_or_else(windows::core::Error::from_win32)?;
        let local = qpc
            .checked_sub(self.qpc_100ns)
            .and_then(|delta| delta.checked_mul(100))
            .and_then(|delta| self.local_ns.checked_add(delta))
            .ok_or_else(windows::core::Error::from_win32)?;
        Ok((qpc, local))
    }
}

struct Session {
    client: IAudioClient,
    render: IAudioRenderClient,
    clock: IAudioClock,
    event: Event,
    consumer: PresentationConsumer,
    model: NativeClock,
    qpc: QpcOrigin,
    buffer_frames: u32,
    channels: usize,
    submitted: u64,
    consecutive_faults: u32,
    _scheduling: AudioScheduling,
}
impl Drop for Session {
    fn drop(&mut self) {
        // Also covers thread unwinding; stop before COM interfaces/events and
        // finally the apartment are released, all on their owning MTA thread.
        unsafe {
            let _ = self.client.Stop();
        }
    }
}
impl Session {
    fn new(
        options: &OutputOptions,
    ) -> Result<(Self, ScheduledPcmQueue, OutputBinding), AudioError> {
        // SAFETY: every COM object and CoTaskMem pointer below is owned on this
        // initialized MTA thread; all native formats are checked before casting.
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(backend)?;
            let device = select_device(&enumerator, options.device_id.as_deref())?;
            let name = device_name(&device).map_err(backend)?;
            let endpoint = device.GetId().map_err(backend)?;
            let endpoint_mem = TaskMem(endpoint.0);
            let endpoint_id = PWSTR(endpoint_mem.0)
                .to_string()
                .map_err(|error| AudioError::BackendInit(error.to_string()))?;
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(backend)?;
            let mix = TaskMem(client.GetMixFormat().map_err(backend)?);
            let format = &*mix.0;
            let sample_rate = format.nSamplesPerSec;
            let (extensible_float, channel_mask, valid_bits) = if format.wFormatTag == 0xfffe
                && format.cbSize as usize
                    >= std::mem::size_of::<WAVEFORMATEXTENSIBLE>()
                        - std::mem::size_of::<WAVEFORMATEX>()
            {
                let extensible = &*mix.0.cast::<WAVEFORMATEXTENSIBLE>();
                let sub_format = extensible.SubFormat;
                (
                    sub_format == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
                    extensible.dwChannelMask,
                    extensible.Samples.wValidBitsPerSample,
                )
            } else {
                (false, 0, format.wBitsPerSample)
            };
            let float = format.wFormatTag == 3 || extensible_float;
            if !float
                || format.wBitsPerSample != 32
                || format.nChannels != options.channels
                || valid_bits != 32
                || format.nBlockAlign != format.nChannels * 4
                || !(1..=768_000).contains(&sample_rate)
                || (format.nChannels == 2 && channel_mask != 0 && channel_mask != 3)
                || format.nAvgBytesPerSec != format.nSamplesPerSec * u32::from(format.nBlockAlign)
            {
                return Err(AudioError::UnsupportedFormat("native scheduled WASAPI requires an f32 mix format with the requested channels".into()));
            }
            let render_format = RenderFormat {
                sample_rate: format.nSamplesPerSec,
                channels: format.nChannels,
            };
            // Shared event mode uses the engine's normal period/buffer. The
            // actual mix rate is returned to the Receiver's single converter.
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    0,
                    0,
                    mix.0,
                    None,
                )
                .map_err(backend)?;
            let buffer_frames = client.GetBufferSize().map_err(backend)?;
            let render: IAudioRenderClient = client.GetService().map_err(backend)?;
            let clock: IAudioClock = client.GetService().map_err(backend)?;
            let frequency = clock.GetFrequency().map_err(backend)?;
            let maximum_latency_ns = u64::try_from(client.GetStreamLatency().map_err(backend)?)
                .ok()
                .and_then(|ticks| ticks.checked_mul(100))
                .ok_or_else(|| {
                    AudioError::BackendInit("invalid WASAPI maximum stream latency".into())
                })?;
            let mut engine_period_100ns = 0;
            client
                .GetDevicePeriod(Some(&mut engine_period_100ns), None)
                .map_err(backend)?;
            let engine_period_ns = u64::try_from(engine_period_100ns)
                .ok()
                .filter(|period| *period > 0)
                .and_then(|period| period.checked_mul(100))
                .ok_or_else(|| AudioError::BackendInit("invalid WASAPI engine period".into()))?;
            let binding = OutputBinding {
                backend: "WASAPI/native-iaudioclock-v1".into(), device: name,
                sample_rate: render_format.sample_rate, channels: render_format.channels,
                configuration: format!("shared-event/f32/mix-rate/mask={channel_mask}/buffer={buffer_frames}/clock-frequency={frequency}/max-latency={maximum_latency_ns}ns/engine-period={engine_period_ns}ns/endpoint={endpoint_id}"),
            };
            if !binding.accepts_correction(
                options.calibration_binding.as_ref(),
                options.latency_correction_ns,
            ) {
                return Err(AudioError::UnsupportedFormat("output configuration changed; set correction to zero, reopen and confirm calibration for this device".into()));
            }
            let (queue, consumer) = ScheduledPcmQueue::with_capability(
                render_format,
                TimestampCapability::NativeDeviceClock,
            )
            .map_err(|error| AudioError::BackendInit(error.to_string()))?;
            let event = Event::new(false).map_err(backend)?;
            client.SetEventHandle(event.0).map_err(backend)?;
            let model = NativeClock::new(
                render_format.sample_rate,
                frequency,
                buffer_frames,
                options.latency_correction_ns,
            )
            .ok_or_else(|| {
                AudioError::UnsupportedFormat("invalid native device clock configuration".into())
            })?;
            let scheduling = AudioScheduling::new().map_err(backend)?;
            // Prime silence before Start so the first event never races an
            // initially empty buffer. This counts on the same submitted grid.
            render.GetBuffer(buffer_frames).map_err(backend)?;
            render
                .ReleaseBuffer(buffer_frames, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
                .map_err(backend)?;
            Ok((
                Self {
                    client,
                    render,
                    clock,
                    event,
                    consumer,
                    model,
                    qpc: QpcOrigin::new(options.clock_origin).map_err(backend)?,
                    buffer_frames,
                    channels: usize::from(render_format.channels),
                    submitted: u64::from(buffer_frames),
                    consecutive_faults: 0,
                    _scheduling: scheduling,
                },
                queue,
                binding,
            ))
        }
    }

    fn run(&mut self, cancel: &Cancel) -> windows::core::Result<()> {
        loop {
            if cancel.stop.load(Ordering::Acquire) {
                return Ok(());
            }
            let ready =
                unsafe { WaitForMultipleObjects(&[cancel.event.0, self.event.0], false, 250) };
            if ready == WAIT_OBJECT_0 {
                return Ok(());
            }
            if ready.0 != WAIT_OBJECT_0.0 + 1 {
                return Err(windows::core::Error::from_win32());
            }
            if cancel.stop.load(Ordering::Acquire) {
                return Ok(());
            }
            unsafe {
                self.render_ready()?;
            }
        }
    }

    unsafe fn render_ready(&mut self) -> windows::core::Result<()> {
        let (padding_start, _) = self.qpc.now()?;
        let padding = self.client.GetCurrentPadding()?;
        let (padding_end, _) = self.qpc.now()?;
        let Some(frames) = self.buffer_frames.checked_sub(padding) else {
            return Err(windows::core::Error::from_win32());
        };
        if frames == 0 {
            return Ok(());
        }
        let (before_qpc, _) = self.qpc.now()?;
        let mut position = 0;
        let mut clock_qpc = 0;
        // The generated GetPosition wrapper discards S_FALSE. Preserve it:
        // WASAPI explicitly marks a long, imprecise clock acquisition S_FALSE.
        let hr = (Interface::vtable(&self.clock).GetPosition)(
            Interface::as_raw(&self.clock),
            &mut position,
            &mut clock_qpc,
        );
        hr.ok()?;
        let (callback_qpc, callback_local_ns) = self.qpc.now()?;
        let mut reading = if hr.0 != 0 || callback_qpc.saturating_sub(before_qpc) > 10_000 {
            self.model.reject(
                ClockFaultKind::InvalidDeviceSample,
                callback_qpc.saturating_sub(before_qpc) as f64 * 100.0,
            )
        } else {
            self.model.observe(DeviceSample {
                position,
                qpc_100ns: clock_qpc,
                callback_qpc_100ns: callback_qpc,
                callback_local_ns,
                padding_qpc_start_100ns: padding_start,
                padding_qpc_end_100ns: padding_end,
                submitted: self.submitted,
                padding,
                frames: frames as usize,
            })
        };
        reading.uncertainty_ns = reading
            .uncertainty_ns
            .saturating_add(self.qpc.uncertainty_ns);
        let reset_stream = reading.fault_count
            > self
                .consumer
                .shared
                .clock_fault_count
                .load(Ordering::Relaxed);
        let data = self.render.GetBuffer(frames)?;
        // WASAPI guarantees buffer_frames*block_align writable bytes until
        // ReleaseBuffer; verified f32/block alignment makes this slice valid.
        let samples =
            std::slice::from_raw_parts_mut(data.cast::<f32>(), frames as usize * self.channels);
        self.consumer
            .render_clocked(samples, reading, Some(callback_local_ns));
        self.render.ReleaseBuffer(frames, 0)?;
        if reset_stream {
            // render(None) has already muted and cleared the old queue epoch.
            // Reset the actual device grid instead of guessing a frame offset
            // from padding. Sustained faults close the session after 3 attempts.
            self.consecutive_faults += 1;
            if self.consecutive_faults >= 3 {
                return Err(windows::core::Error::from_hresult(
                    AUDCLNT_E_DEVICE_INVALIDATED,
                ));
            }
            self.client.Stop()?;
            self.client.Reset()?;
            self.model.reset_stream_grid();
            self.render.GetBuffer(self.buffer_frames)?;
            self.render
                .ReleaseBuffer(self.buffer_frames, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)?;
            self.submitted = u64::from(self.buffer_frames);
            self.client.Start()?;
            return Ok(());
        }
        if reading.status == ClockStatus::Valid {
            self.consecutive_faults = 0;
        }
        self.submitted = self
            .submitted
            .checked_add(u64::from(frames))
            .ok_or_else(windows::core::Error::from_win32)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn cancellation_wakes_and_joins_without_a_device_callback() {
        let cancel = Arc::new(Cancel {
            event: Event::new(true).unwrap(),
            stop: AtomicBool::new(false),
        });
        let worker_cancel = Arc::clone(&cancel);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let thread = thread::spawn(move || {
            let render_event = Event::new(false).unwrap();
            ready_tx.send(()).unwrap();
            let ready = unsafe {
                WaitForMultipleObjects(&[worker_cancel.event.0, render_event.0], false, 250)
            };
            assert_eq!(ready, WAIT_OBJECT_0);
            assert!(worker_cancel.stop.load(Ordering::Acquire));
        });
        ready_rx.recv().unwrap();
        let stream = NativeStream {
            cancel,
            thread: Some(thread),
        };
        let start = Instant::now();
        drop(stream);
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn unexpected_render_thread_exit_mutes_and_retires_queued_pcm() {
        let (mut queue, _consumer) = ScheduledPcmQueue::new(RenderFormat {
            sample_rate: 48_000,
            channels: 2,
        })
        .unwrap();
        queue.unmute();
        queue.write_at(10_000_000, &[0.25; 960], 0).unwrap();
        let cancel = Cancel {
            event: Event::new(true).unwrap(),
            stop: AtomicBool::new(false),
        };
        drop(RenderHealth {
            shared: &queue.shared,
            cancel: &cancel,
        });
        let reading = queue.telemetry();
        assert!(reading.muted && reading.device_error);
        assert_eq!(reading.clock_status, ClockStatus::DeviceError);
        assert_eq!(reading.queued_frames, 0);
        assert_eq!(
            queue.write_at(20_000_000, &[0.25; 960], 0),
            Err(OutputError::DeviceError)
        );
    }

    fn wait_and_render(session: &mut Session) {
        let ready = unsafe { WaitForMultipleObjects(&[session.event.0], false, 250) };
        assert_eq!(ready, WAIT_OBJECT_0);
        unsafe {
            session.render_ready().unwrap();
        }
    }

    fn pump_to_valid(session: &mut Session, queue: &ScheduledPcmQueue) -> OutputTelemetry {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            wait_and_render(session);
            let telemetry = queue.telemetry();
            if telemetry.clock_status == ClockStatus::Valid {
                return telemetry;
            }
            assert!(Instant::now() < deadline, "{telemetry:?}");
        }
    }

    #[test]
    #[ignore = "requires exclusive coordination of a real Windows audio endpoint"]
    fn injected_native_fault_resets_the_real_grid_and_preserves_its_revoke_generation() {
        let _apartment = ComApartment::new().unwrap();
        let options = OutputOptions {
            device_id: std::env::var("HERTZ_WASAPI_TEST_DEVICE").ok(),
            preferred_rate: 48_000,
            channels: 2,
            clock_origin: Instant::now(),
            latency_correction_ns: 0,
            calibration_binding: None,
        };
        let (mut session, mut queue, binding) = Session::new(&options).unwrap();
        unsafe {
            session.client.Start().unwrap();
        }
        let before = pump_to_valid(&mut session, &queue);
        assert!(before.muted && before.clock_fault_count == 0);
        let now = session.qpc.now().unwrap().1;
        queue
            .unmute_at_clock_generation(now + 200_000_000, 0)
            .unwrap();
        queue.write_at(now + 200_000_000, &[0.0; 960], now).unwrap();
        assert_eq!(queue.telemetry().queued_frames, 480);
        let old_submitted = session.submitted;
        // Test-only direct model injection. No production fault switch or
        // environment hook: the next real render transaction must execute the
        // exact Stop/Reset/prime/Start branch used by a rejected device sample.
        session
            .model
            .reject(ClockFaultKind::InvalidDeviceSample, 42.0);
        wait_and_render(&mut session);
        let reset = queue.telemetry();
        assert!(reset.muted);
        assert_eq!(reset.clock_fault_count, 1);
        assert_eq!(reset.queued_frames, 0);
        assert_eq!(session.submitted, u64::from(session.buffer_frames));
        assert!(old_submitted > session.submitted);
        assert_eq!(session.consecutive_faults, 1);
        let recovered = pump_to_valid(&mut session, &queue);
        assert!(recovered.muted && !recovered.device_error);
        assert_eq!(recovered.clock_fault_count, 1);
        assert_eq!(recovered.played_frames, 0);
        assert_eq!(recovered.last_clock_fault.unwrap().value, 42.0);
        assert_eq!(
            queue.unmute_at_clock_generation(now + 400_000_000, 0),
            Err(OutputError::ClockChanged)
        );
        eprintln!("injected native recovery binding={binding:?}; before={before:?}; reset={reset:?}; recovered={recovered:?}; submitted_before={old_submitted}; submitted_after_reset={}", session.buffer_frames);
    }

    #[test]
    #[ignore = "requires exclusive coordination of a real default Windows audio endpoint"]
    fn native_default_device_stays_muted_advances_clock_and_joins() {
        for _ in 0..2 {
            let output = open(OutputOptions {
                device_id: std::env::var("HERTZ_WASAPI_TEST_DEVICE").ok(),
                preferred_rate: 48_000,
                channels: 2,
                clock_origin: Instant::now(),
                latency_correction_ns: 0,
                calibration_binding: None,
            })
            .unwrap();
            eprintln!("native binding {:?}", output.binding());
            assert_eq!(
                output.telemetry().timestamp_capability,
                TimestampCapability::NativeDeviceClock
            );
            assert_eq!(output.binding().backend, "WASAPI/native-iaudioclock-v1");
            let deadline = Instant::now() + Duration::from_secs(3);
            let first = loop {
                let reading = output.telemetry();
                assert!(!reading.device_error, "{reading:?}");
                assert!(reading.muted);
                if reading.clock_status == ClockStatus::Valid {
                    break reading;
                }
                assert!(Instant::now() < deadline, "{reading:?}");
                thread::sleep(Duration::from_millis(10));
            };
            thread::sleep(Duration::from_millis(500));
            let after = output.telemetry();
            assert_eq!(after.clock_status, ClockStatus::Valid, "{after:?}");
            assert_eq!(
                after.clock_fault_count, first.clock_fault_count,
                "{after:?}"
            );
            assert!(after.last_presentation_local_ns > first.last_presentation_local_ns);
            assert_eq!(after.played_frames, 0);
            let stopping = Instant::now();
            drop(output);
            assert!(stopping.elapsed() < Duration::from_secs(1));
        }
    }
}
