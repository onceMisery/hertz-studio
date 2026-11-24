// SPDX-License-Identifier: MIT
//! Isolated release probes. Allocation accounting includes live allocations, not Vec capacities.
use super::*;
use crate::loudness::{self, Control};
use std::{
    fs::File,
    io::{BufWriter, Write},
    sync::atomic::{AtomicBool, AtomicUsize},
    time::{Duration, Instant},
};
use vmusic_core::audio_quality::{HeadroomMode, LimiterMode, QualityParams, ToneParams};

#[derive(Clone, Copy)]
struct ProcessMemory {
    working_set: usize,
    private_bytes: usize,
}

#[cfg(windows)]
fn process_memory() -> Option<ProcessMemory> {
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        cb: u32,
        faults: u32,
        peak_working_set: usize,
        working_set: usize,
        peak_paged_pool: usize,
        paged_pool: usize,
        peak_nonpaged_pool: usize,
        nonpaged_pool: usize,
        pagefile: usize,
        peak_pagefile: usize,
        private_bytes: usize,
    }
    #[link(name = "psapi")]
    unsafe extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut std::ffi::c_void,
            counters: *mut Counters,
            size: u32,
        ) -> i32;
    }
    let mut counters = Counters::default();
    let size = std::mem::size_of::<Counters>() as u32;
    counters.cb = size;
    let ok = unsafe { GetProcessMemoryInfo(-1isize as *mut std::ffi::c_void, &mut counters, size) };
    (ok != 0).then_some(ProcessMemory {
        working_set: counters.working_set,
        private_bytes: counters.private_bytes,
    })
}

#[cfg(target_os = "linux")]
fn process_memory() -> Option<ProcessMemory> {
    let text = std::fs::read_to_string("/proc/self/smaps_rollup").ok()?;
    let field = |name: &str| {
        text.lines()
            .find(|line| line.starts_with(name))?
            .split_whitespace()
            .nth(1)?
            .parse::<usize>()
            .ok()
            .map(|kb| kb * 1024)
    };
    Some(ProcessMemory {
        working_set: field("Rss:")?,
        private_bytes: field("Private_Clean:")? + field("Private_Dirty:")?,
    })
}

#[cfg(not(any(windows, target_os = "linux")))]
fn process_memory() -> Option<ProcessMemory> {
    None
}

struct MemoryWindow {
    before: ProcessMemory,
    peak: Arc<[AtomicUsize; 2]>,
    stop: Arc<AtomicBool>,
    sampler: Option<std::thread::JoinHandle<()>>,
}
impl MemoryWindow {
    fn start() -> Self {
        let before = process_memory().expect("process memory probe supports Windows/Linux");
        let peak = Arc::new([
            AtomicUsize::new(before.working_set),
            AtomicUsize::new(before.private_bytes),
        ]);
        let stop = Arc::new(AtomicBool::new(false));
        let (observed, stopped) = (peak.clone(), stop.clone());
        let sampler = std::thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                let sample = process_memory().expect("process memory sample");
                observed[0].fetch_max(sample.working_set, Ordering::Relaxed);
                observed[1].fetch_max(sample.private_bytes, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(2));
            }
        });
        Self {
            before,
            peak,
            stop,
            sampler: Some(sampler),
        }
    }
    fn finish(mut self) -> serde_json::Value {
        let sample = process_memory().unwrap();
        self.peak[0].fetch_max(sample.working_set, Ordering::Relaxed);
        self.peak[1].fetch_max(sample.private_bytes, Ordering::Relaxed);
        self.stop.store(true, Ordering::Release);
        self.sampler.take().unwrap().join().unwrap();
        let peak_working_set = self.peak[0].load(Ordering::Relaxed);
        let peak_private = self.peak[1].load(Ordering::Relaxed);
        serde_json::json!({
            "os": std::env::consts::OS, "sample_interval_ms":2,
            "private_metric":if cfg!(windows) {"private_committed_bytes"} else {"resident_private_clean_dirty"},
            "baseline_working_set_bytes":self.before.working_set,
            "baseline_private_bytes":self.before.private_bytes,
            "peak_working_set_bytes":peak_working_set,"peak_private_bytes":peak_private,
            "working_set_increase_bytes":peak_working_set.saturating_sub(self.before.working_set),
            "private_increase_bytes":peak_private.saturating_sub(self.before.private_bytes)
        })
    }
}
impl Drop for MemoryWindow {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(sampler) = self.sampler.take() {
            sampler.join().unwrap();
        }
    }
}

fn require_release() {
    assert!(
        !cfg!(debug_assertions),
        "run isolated resource probes with --release"
    );
}
fn percentile(values: &mut [u128], percent: usize) -> u128 {
    values.sort_unstable();
    values[(values.len() * percent).div_ceil(100).saturating_sub(1)]
}

#[cfg(windows)]
struct AudioScheduling(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl AudioScheduling {
    fn start() -> Self {
        unsafe {
            let mut index = 0;
            let handle = windows::Win32::System::Threading::AvSetMmThreadCharacteristicsW(
                windows::core::w!("Audio"),
                &mut index,
            )
            .unwrap();
            windows::Win32::System::Threading::AvSetMmThreadPriority(
                handle,
                windows::Win32::System::Threading::AVRT_PRIORITY_HIGH,
            )
            .unwrap();
            Self(handle)
        }
    }
}
#[cfg(windows)]
impl Drop for AudioScheduling {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::System::Threading::AvRevertMmThreadCharacteristics(self.0);
        }
    }
}

#[test]
#[ignore = "release-only paced DSP acceptance-to-adoption qualification"]
fn parameter_adoption_latency_probe() {
    require_release();
    #[cfg(windows)]
    let _priority = AudioScheduling::start();
    let attempts: usize = std::env::var("HERTZ_PARAMETER_PROBE_ATTEMPTS")
        .ok()
        .map(|s| s.parse().expect("attempt count"))
        .unwrap_or(20);
    assert!((8..=40).contains(&attempts));
    for rate in [44_100, 48_000, 96_000] {
        for frames in [128usize, 512] {
            for group in [
                "ordinary_fixed",
                "ordinary_parametric",
                "low_frequency_high_q",
                "tone",
            ] {
                let mut r = RenderCore::new(RenderFormat {
                    sample_rate: rate,
                    channels: 2,
                })
                .unwrap();
                let mut q = QualityParams {
                    limiter: LimiterMode::TruePeak,
                    ..Default::default()
                };
                r.set_quality(q).unwrap();
                r.shared.playing.store(true, Ordering::Release);
                r.shared
                    .current_deck()
                    .samples
                    .lock()
                    .unwrap()
                    .extend(std::iter::repeat_n(0.02, rate as usize * 4));
                let mut output = r.output();
                let mut block = vec![0.0; frames * 2];
                // Fill the actual two-second history before measuring any change.
                for _ in 0..(rate as usize * 2).div_ceil(frames) {
                    output.render(&mut block, 2);
                }
                let interval = Duration::from_secs_f64(frames as f64 / rate as f64);
                let mut total = Vec::with_capacity(attempts);
                let mut after_accept = Vec::with_capacity(attempts);
                let mut preparation = Vec::with_capacity(attempts);
                let mut audio_frames = Vec::with_capacity(attempts);
                let mut failed = 0;
                for attempt in 0..attempts {
                    q.configuration_revision += 1;
                    q.headroom_mode = HeadroomMode::Auto;
                    let gain = if attempt % 2 == 0 { 6.0 } else { -6.0 };
                    match group {
                        "ordinary_fixed" => {
                            q.eq.enabled = true;
                            for b in &mut q.eq.bands {
                                b.gain_db = gain;
                            }
                        }
                        "ordinary_parametric" => {
                            q.eq.enabled = true;
                            for (i, b) in q.eq.bands.iter_mut().enumerate() {
                                b.frequency_hz = 250.0 * 2.0f32.powi(i as i32);
                                b.q = 1.2;
                                b.gain_db = gain;
                            }
                        }
                        "low_frequency_high_q" => {
                            q.eq.enabled = true;
                            q.eq.bands[0].frequency_hz = 100.0;
                            q.eq.bands[0].q = 8.0;
                            q.eq.bands[0].gain_db = gain;
                        }
                        "tone" => {
                            q.tone.crossfeed = true;
                            q.tone.crossfeed_amount = if attempt % 2 == 0 { 0.25 } else { 0.5 };
                            q.tone.loudness_compensation = true;
                        }
                        _ => unreachable!(),
                    }
                    {
                        let deck = r.shared.current_deck();
                        let mut queue = deck.samples.lock().unwrap();
                        queue.clear();
                        queue.extend(std::iter::repeat_n(0.02, rate as usize * 3));
                    }
                    let requested = Instant::now();
                    if r.set_quality(q).is_err() {
                        failed += 1;
                        continue;
                    }
                    let accepted = Instant::now();
                    let mut completed = false;
                    for index in 1..=(rate as usize * 6 / 5).div_ceil(frames) {
                        std::thread::sleep(
                            (accepted + interval * index as u32)
                                .saturating_duration_since(Instant::now()),
                        );
                        output.render(&mut block, 2);
                        let status = r.quality_status().unwrap();
                        if status.applied == Some(q) {
                            total.push(requested.elapsed().as_nanos());
                            after_accept.push(accepted.elapsed().as_nanos());
                            preparation.push(accepted.duration_since(requested).as_nanos());
                            audio_frames.push((index * frames) as u128);
                            completed = true;
                            break;
                        }
                    }
                    if !completed {
                        failed += 1;
                    }
                }
                assert!(!total.is_empty());
                let p95 = percentile(&mut total, 95);
                let report = serde_json::json!({"rate":rate,"frames":frames,"group":group,
                    "attempts":attempts,"failed":failed,"failure_rate":failed as f64/attempts as f64,
                    "p95_total_ms":p95 as f64/1e6,"max_total_ms":total.last().unwrap().to_owned() as f64/1e6,
                    "p95_after_accept_ms":percentile(&mut after_accept,95) as f64/1e6,
                    "p95_prepare_ms":percentile(&mut preparation,95) as f64/1e6,
                    "p95_consumed_frames":percentile(&mut audio_frames,95),
                    "ordinary_target_ms":100,"ordinary_target_met":p95<=100_000_000,
                    "history_filled_seconds":2,"paced":true,"audio_priority":cfg!(windows),
                    "scope":"RenderCore control preparation and actual local render adoption; excludes HTTP/DBX/storage/device"});
                eprintln!("PARAMETER_ADOPTION_PROBE {report}");
                assert_eq!(failed, 0, "{report}");
                if group.starts_with("ordinary_") || group == "tone" {
                    assert!(p95 <= 100_000_000, "ordinary response budget: {report}");
                }
                let before = r.quality_status().unwrap().requested;
                let mut inadmissible = q;
                inadmissible.eq.enabled = true;
                inadmissible.eq.bands[0].frequency_hz = 20.0;
                inadmissible.eq.bands[0].q = 8.0;
                inadmissible.eq.bands[0].gain_db = 12.0;
                assert!(r.set_quality(inadmissible).is_err());
                assert_eq!(r.quality_status().unwrap().requested, before);
            }
        }
    }
}

fn kernel(rate: u32, id: char) -> super::impulse::PreparedImpulse {
    let mut taps = vec![0.001; 257];
    taps[128] = 0.744;
    super::impulse::PreparedImpulse::prepare(vmusic_core::impulse::ImpulseKernel {
        resource_id: id.to_string().repeat(64),
        sample_rate: rate,
        channels: vec![taps.clone(), taps],
        delay_frames: 128,
        attenuation_db: 0.0,
    })
    .unwrap()
}

#[test]
#[ignore = "release-only allocator high-water and actual process-memory DSP qualification"]
fn dsp_working_memory_probe() {
    require_release();
    for rate in [44_100, 48_000, 96_000] {
        let window = MemoryWindow::start();
        let ((runtime, mailbox), memory) = super::tests::measure_memory(|| {
            let mailbox = Box::new(super::dsp::DspControl::new());
            let mut runtime = Box::new(super::dsp::DspRuntime::new(rate, 2));
            let full = rate != 96_000;
            let mut q = QualityParams {
                limiter: LimiterMode::TruePeak,
                headroom_mode: HeadroomMode::Auto,
                ..Default::default()
            };
            q.eq.enabled = true;
            for b in &mut q.eq.bands {
                b.gain_db = 12.0;
            }
            q.tone = ToneParams {
                crossfeed: true,
                loudness_compensation: true,
                saturation: full,
                drive: 1.0,
                mix: 1.0,
                ..Default::default()
            };
            q.impulse_id =
                full.then(|| vmusic_core::audio_quality::decode_id(&"a".repeat(64)).unwrap());
            let first = super::dsp::PreparedEq::preview(rate, q, -3.0, 0).unwrap();
            mailbox
                .publish_preview(first, full.then(|| kernel(rate, 'a')))
                .unwrap();
            let mut frame = [0.0; 2];
            let mut out = [0.0; 2];
            for index in 0..rate as usize * 3 {
                if index == rate as usize {
                    q.eq.bands[0].frequency_hz = 90.0;
                    q.eq.bands[0].gain_db = -12.0;
                    q.impulse_id = full
                        .then(|| vmusic_core::audio_quality::decode_id(&"b".repeat(64)).unwrap());
                    mailbox
                        .publish_preview(
                            super::dsp::PreparedEq::preview(rate, q, -6.0, 0).unwrap(),
                            full.then(|| kernel(rate, 'b')),
                        )
                        .unwrap();
                }
                assert!(runtime.begin_epoch(&mailbox, mailbox.reset_epoch.load(Ordering::Acquire)));
                runtime.process_mix(&[0.05; 2], &[0.0; 2], [0.0; 2], [1.0, 0.0], &mut frame);
                runtime.terminal.push(
                    &frame,
                    &mut out,
                    super::terminal::FrameTag {
                        position: index as u64 + 1,
                        transition: false,
                        audible: true,
                        volume: 0.5,
                        fade: 1.0,
                    },
                );
                runtime.finish_block(&mailbox);
            }
            // The bypass side exercises the largest valid alignment with no IR/tone delay.
            q.eq.enabled = false;
            q.impulse_id = None;
            q.tone = ToneParams::default();
            mailbox.reset();
            mailbox
                .publish_preview(
                    super::dsp::PreparedEq::preview(
                        rate,
                        q,
                        -3.0,
                        if full {
                            vmusic_core::audio_preview::MAX_ALIGNMENT_FRAMES
                        } else {
                            0
                        },
                    )
                    .unwrap(),
                    None,
                )
                .unwrap();
            for index in 0..1024 {
                assert!(runtime.begin_epoch(&mailbox, mailbox.reset_epoch.load(Ordering::Acquire)));
                runtime.process_mix(&[0.05; 2], &[0.0; 2], [0.0; 2], [1.0, 0.0], &mut frame);
                runtime.terminal.push(
                    &frame,
                    &mut out,
                    super::terminal::FrameTag {
                        position: index + 1,
                        transition: false,
                        audible: true,
                        volume: 0.5,
                        fade: 1.0,
                    },
                );
                runtime.finish_block(&mailbox);
            }
            (runtime, mailbox)
        });
        let process = window.finish();
        let report = serde_json::json!({"rate":rate,"channels":2,"heap_peak_live_bytes":memory.peak_live_bytes,
            "heap_retained_bytes":memory.live_bytes,"heap_allocated_bytes":memory.allocated_bytes,
            "heap_freed_bytes":memory.freed_bytes,"process":process,
            "scope":"boxed local DSP and mailbox, two-second history, limiter, valid preview alignment, IR/tone transition and pending kernel; excludes decoder/PCM/device/OS"});
        eprintln!("DSP_MEMORY_PROBE {report}");
        assert!(memory.peak_live_bytes <= 16 * 1024 * 1024, "{report}");
        assert!(
            process["private_increase_bytes"].as_u64().unwrap() <= 16 * 1024 * 1024,
            "{report}"
        );
        drop((runtime, mailbox));
    }
}

fn wave_file(rate: u32, seconds: u32) -> std::path::PathBuf {
    let file = std::env::temp_dir().join(format!(
        "hertz-audio-resource-{}-{rate}.wav",
        std::process::id()
    ));
    let bytes = rate * seconds * 2 * 2;
    let mut writer = BufWriter::new(File::create(&file).unwrap());
    writer.write_all(b"RIFF").unwrap();
    writer.write_all(&(36 + bytes).to_le_bytes()).unwrap();
    writer.write_all(b"WAVEfmt ").unwrap();
    writer.write_all(&16u32.to_le_bytes()).unwrap();
    writer.write_all(&1u16.to_le_bytes()).unwrap();
    writer.write_all(&2u16.to_le_bytes()).unwrap();
    writer.write_all(&rate.to_le_bytes()).unwrap();
    writer.write_all(&(rate * 4).to_le_bytes()).unwrap();
    writer.write_all(&4u16.to_le_bytes()).unwrap();
    writer.write_all(&16u16.to_le_bytes()).unwrap();
    writer.write_all(b"data").unwrap();
    writer.write_all(&bytes.to_le_bytes()).unwrap();
    let mut chunk = Vec::with_capacity(4096);
    for i in 0..1024 {
        let sample =
            (2048.0 * (std::f64::consts::TAU * 1000.0 * i as f64 / rate as f64).sin()) as i16;
        chunk.extend_from_slice(&sample.to_le_bytes());
        chunk.extend_from_slice(&sample.to_le_bytes());
    }
    let mut remaining = bytes as usize;
    while remaining > 0 {
        let n = remaining.min(chunk.len());
        writer.write_all(&chunk[..n]).unwrap();
        remaining -= n;
    }
    writer.flush().unwrap();
    file
}

#[test]
#[ignore = "release-only streaming file analysis and comparison working-memory qualification"]
fn analysis_working_memory_probe() {
    require_release();
    let rate = 96_000;
    let path = wave_file(rate, 60);
    let control = Control {
        until: Instant::now() + Duration::from_secs(120),
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    for mode in ["streaming_analysis", "resampled_full_comparison"] {
        let window = MemoryWindow::start();
        let started = Instant::now();
        let (_, memory) = super::tests::measure_memory(|| {
            if mode == "streaming_analysis" {
                let analysis =
                    loudness::analyze_file(File::open(&path).unwrap(), &control).unwrap();
                assert_eq!(analysis.measurement.frames, rate as u64 * 60);
                std::hint::black_box(analysis);
            } else {
                let saved = QualityParams {
                    limiter: LimiterMode::TruePeak,
                    ..Default::default()
                };
                let mut enhanced = saved;
                enhanced.preamp_db = 3.0;
                enhanced.tone.saturation = true;
                enhanced.impulse_id = vmusic_core::audio_quality::decode_id(&"a".repeat(64));
                let mut taps = vec![0.0; 257];
                taps[128] = 1.0;
                let plan = vmusic_core::audio_preview::PreviewPlan {
                    request_id: "a0000000-0000-4000-8000-000000000000".into(),
                    saved,
                    enhanced,
                    impulse: Some(vmusic_core::audio_preview::PreviewImpulse {
                        phase: vmusic_core::audio_preview::ImpulsePhase::SymmetricLinear,
                        kernel: vmusic_core::impulse::ImpulseKernel {
                            resource_id: "a".repeat(64),
                            sample_rate: 44_100,
                            channels: vec![taps],
                            delay_frames: 128,
                            attenuation_db: 0.0,
                        },
                    }),
                    matching: None,
                    volume: 0.5,
                    track_gain_db: 0.0,
                    source_sha256: "a".repeat(64),
                    reference_end_ms: 12_000,
                    reference_end_frame: 44_100 * 12,
                };
                let result = super::comparison::compare_file(
                    File::open(&path).unwrap(),
                    &plan,
                    44_100,
                    2,
                    &control,
                )
                .unwrap();
                assert!(result.matching.is_some());
                assert_eq!(result.reference_end_frame, 44_100 * 12);
            }
        });
        let elapsed = started.elapsed();
        let process = window.finish();
        let report = serde_json::json!({"mode":mode,"source_rate":rate,"source_seconds":60,"channels":2,
            "elapsed_ms":elapsed.as_secs_f64()*1000.0,"heap_peak_live_bytes":memory.peak_live_bytes,
            "heap_end_bytes":memory.live_bytes,"heap_allocated_bytes":memory.allocated_bytes,
            "heap_freed_bytes":memory.freed_bytes,"process":process,
            "scope":"actual WAV decoder, ebur128, bounded prefix/resampler and four shared DSP paths; includes Rust allocator allocations and process memory, excludes file cache/DB/device"});
        eprintln!("ANALYSIS_MEMORY_PROBE {report}");
        assert!(memory.peak_live_bytes <= 32 * 1024 * 1024, "{report}");
        assert!(
            process["private_increase_bytes"].as_u64().unwrap() <= 32 * 1024 * 1024,
            "{report}"
        );
    }
    std::fs::remove_file(path).unwrap();
}
