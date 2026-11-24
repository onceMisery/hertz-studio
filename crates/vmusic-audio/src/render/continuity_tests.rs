use super::*;
use vmusic_core::DspParams;

thread_local! {
    static SOURCE_BARRIERS: std::cell::RefCell<Option<(Arc<std::sync::Barrier>, Arc<std::sync::Barrier>)>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn after_source_consumption() {
    if let Some((entered, release)) = SOURCE_BARRIERS.with(|slot| slot.borrow_mut().take()) {
        entered.wait();
        release.wait();
    }
}

#[test]
fn eof_resume_waits_for_inflight_terminal_publication() {
    let mut renderer = playing_renderer();
    let q = vmusic_core::audio_quality::QualityParams {
        limiter: vmusic_core::audio_quality::LimiterMode::TruePeak,
        ..Default::default()
    };
    renderer.set_quality(q).unwrap();
    renderer
        .shared
        .current_deck()
        .samples
        .lock()
        .unwrap()
        .clear();
    renderer
        .shared
        .current_deck()
        .samples
        .lock()
        .unwrap()
        .extend([0.1; 17]);
    renderer
        .shared
        .current_deck()
        .eof
        .store(true, Ordering::Release);
    let entered = Arc::new(std::sync::Barrier::new(2));
    let release = Arc::new(std::sync::Barrier::new(2));
    let mut output = renderer.output();
    let a = entered.clone();
    let b = release.clone();
    let callback = std::thread::spawn(move || {
        SOURCE_BARRIERS.with(|slot| *slot.borrow_mut() = Some((a, b)));
        output.render(&mut [0.0; 32], 1);
        output
    });
    entered.wait();
    renderer.pause().unwrap();
    let epoch = renderer.shared.dsp.reset_epoch.load(Ordering::Acquire);
    let result = renderer.play();
    let next_epoch = renderer.shared.dsp.reset_epoch.load(Ordering::Acquire);
    release.wait();
    let mut output = callback.join().unwrap();
    result.unwrap();
    assert_eq!(epoch, next_epoch);
    let mut count = 0;
    for _ in 0..32 {
        let end = output.render(&mut [0.0; 16], 1);
        count += end.saturating_sub(output.leading_silence_samples());
        if renderer.finished() {
            break;
        }
    }
    assert_eq!(count, 17);
}

#[test]
#[ignore = "release-only isolated stage timing diagnosis"]
fn quality_stage_cost_probe() {
    if cfg!(debug_assertions) {
        panic!("run this probe with --release");
    }
    // Stage diagnosis must use the same qualified scope as the complete-chain probe.
    let rate = 48_000;
    let n = rate as usize;
    let samples: Vec<_> = (0..n).map(|i| [0.3 * (i as f32 * 0.71).sin(); 2]).collect();
    let mut tone = super::tone::Tone::new(rate, 2);
    tone.configure(vmusic_core::audio_quality::ToneParams {
        crossfeed: true,
        loudness_compensation: true,
        saturation: true,
        drive: 1.0,
        mix: 1.0,
        ..Default::default()
    });
    let mut fir = super::impulse::Impulse::new();
    let mut taps = vec![0.001; 257];
    taps[128] = 0.744;
    fir.install(Some(
        super::impulse::PreparedImpulse::prepare(vmusic_core::impulse::ImpulseKernel {
            resource_id: "a".repeat(64),
            sample_rate: rate,
            channels: vec![taps],
            delay_frames: 128,
            attenuation_db: 0.0,
        })
        .unwrap(),
    ));
    let mut peak = crate::true_peak::Detector::new(rate, 2);
    let mut limiter = crate::true_peak::Limiter::new(rate, 2);
    let mut terminal = super::terminal::Terminal::new(rate, 2, true);
    terminal.configure(
        vmusic_core::audio_quality::LimiterMode::TruePeak,
        vmusic_core::audio_quality::ToneParams {
            crossfeed: true,
            loudness_compensation: true,
            saturation: true,
            drive: 1.0,
            mix: 1.0,
            ..Default::default()
        },
    );
    let mut taps = vec![0.001; 257];
    taps[128] = 0.744;
    terminal.configure_impulse(
        Some(
            super::impulse::PreparedImpulse::prepare(vmusic_core::impulse::ImpulseKernel {
                resource_id: "a".repeat(64),
                sample_rate: rate,
                channels: vec![taps],
                delay_frames: 128,
                attenuation_db: 0.0,
            })
            .unwrap(),
        ),
        true,
    );
    let mut renderer = RenderCore::new(RenderFormat {
        sample_rate: rate,
        channels: 2,
    })
    .unwrap();
    let mut q = vmusic_core::audio_quality::QualityParams::default();
    q.eq.enabled = true;
    for b in &mut q.eq.bands {
        b.gain_db = 12.0;
    }
    q.headroom_mode = vmusic_core::audio_quality::HeadroomMode::Auto;
    renderer.set_quality(q).unwrap();
    let mut dsp = DspRuntime::new(rate, 2);
    dsp.begin_block(&renderer.shared.dsp);
    for stage in [
        "tone",
        "fir",
        "detector",
        "limiter",
        "terminal",
        "eq_history",
    ] {
        let started = std::time::Instant::now();
        for s in &samples {
            let mut out = *s;
            match stage {
                "tone" => tone.process(&mut out, 0.5),
                "fir" => fir.process(&mut out),
                "detector" => {
                    std::hint::black_box(peak.push(s));
                }
                "terminal" => {
                    terminal.push(
                        s,
                        &mut out,
                        super::terminal::FrameTag {
                            position: 0,
                            transition: false,
                            audible: true,
                            volume: 1.0,
                            fade: 1.0,
                        },
                    );
                }
                "eq_history" => dsp.process(&mut out),
                _ => {
                    limiter.push(s, &mut out);
                }
            }
            std::hint::black_box(out);
        }
        eprintln!(
            "STAGE_COST {stage} at {rate} Hz: {} ns/frame",
            started.elapsed().as_nanos() / n as u128
        );
    }
}

fn playing_renderer() -> RenderCore {
    let mut renderer = RenderCore::new(RenderFormat {
        sample_rate: 48_000,
        channels: 1,
    })
    .unwrap();
    renderer
        .set_dsp(DspParams {
            eq_gains_db: [0.0, 0.0, 0.0, 9.0, 0.0, 0.0],
            ..DspParams::default()
        })
        .unwrap();
    renderer.shared.playing.store(true, Ordering::Relaxed);
    let deck = renderer.shared.current_deck();
    deck.samples.lock().unwrap().extend(
        (0..8192).map(|n| 0.08 * (n as f32 * std::f32::consts::TAU * 1000.0 / 48000.0).sin()),
    );
    renderer
}

#[test]
fn control_contention_keeps_the_previous_eq_and_its_history() {
    let mut renderer = playing_renderer();
    let mut reference = playing_renderer();
    let mut actual = [0.0; 512];
    let mut expected = [0.0; 512];
    renderer.render(&mut actual);
    reference.render(&mut expected);
    assert_eq!(actual, expected);

    let shared = renderer.shared.clone();
    let control_guard = shared.dsp.parameters.lock().unwrap();
    renderer.render(&mut actual);
    reference.render(&mut expected);
    drop(control_guard);
    assert_eq!(actual, expected, "control contention must not bypass EQ");

    renderer.render(&mut actual);
    reference.render(&mut expected);
    assert_eq!(actual, expected, "history must continue through contention");
}

#[test]
fn terminal_prefix_stops_exactly_at_pause_fade_zero() {
    let mut renderer = playing_renderer();
    renderer
        .shared
        .fade_from
        .store(1.0f32.to_bits(), Ordering::Relaxed);
    renderer
        .shared
        .fade_to
        .store(0.0f32.to_bits(), Ordering::Relaxed);
    renderer
        .shared
        .fade_gain
        .store(1.0f32.to_bits(), Ordering::Relaxed);
    renderer.shared.fade_frames.store(8, Ordering::Relaxed);
    renderer.shared.fade_done.store(0, Ordering::Relaxed);
    let mut output = renderer.output();
    let mut samples = [0.0; 32];
    assert_eq!(output.render(&mut samples, 1), 7);
    assert!(samples[7..].iter().all(|s| *s == 0.0));
}

#[test]
fn true_peak_tail_and_position_follow_real_submitted_frames() {
    let mut renderer = RenderCore::new(RenderFormat {
        sample_rate: 48_000,
        channels: 1,
    })
    .unwrap();
    let params = vmusic_core::audio_quality::QualityParams {
        limiter: vmusic_core::audio_quality::LimiterMode::TruePeak,
        ..Default::default()
    };
    renderer.set_quality(params).unwrap();
    renderer
        .shared
        .current_deck()
        .samples
        .lock()
        .unwrap()
        .extend([0.1; 17]);
    renderer
        .shared
        .current_deck()
        .eof
        .store(true, Ordering::Release);
    renderer.shared.playing.store(true, Ordering::Release);
    let mut output = renderer.output();
    let mut presented = Vec::new();
    let mut first = true;
    for _ in 0..40 {
        let mut data = [0.0; 16];
        let end = output.render(&mut data, 1);
        let start = output.leading_silence_samples();
        if first {
            assert_eq!(renderer.position_frames(), 0);
            assert!(!renderer.finished());
            first = false;
        }
        if end > start {
            presented.extend_from_slice(&data[start..end]);
        }
        if renderer.finished() {
            break;
        }
    }
    assert_eq!(presented, vec![0.1; 17]);
    assert_eq!(renderer.position_frames(), 17);
    assert!(renderer.finished());
}

#[test]
fn limiter_change_is_deferred_until_discontinuity_without_misreporting_adoption() {
    let mut renderer = playing_renderer();
    let mut output = renderer.output();
    output.render(&mut [0.0; 64], 1);
    let mut params = renderer.quality_status().unwrap().requested;
    params.limiter = vmusic_core::audio_quality::LimiterMode::TruePeak;
    params.configuration_revision = 2;
    renderer.set_quality(params).unwrap();
    output.render(&mut [0.0; 64], 1);
    let status = renderer.quality_status().unwrap();
    assert_eq!(status.eq.state, vmusic_core::EqApplicationState::Deferred);
    assert_eq!(
        status.deferred_reason,
        Some("processing_latency_change_waits_for_seek_or_load")
    );
    renderer.shared.dsp.reset();
    output.render(&mut [0.0; 512], 1);
    let status = renderer.quality_status().unwrap();
    assert_eq!(status.applied, Some(params));
    assert!(status.latency_frames > 0);
}

#[test]
fn hard_mute_covers_populated_delay_and_eof_meter_flushes() {
    let mut renderer = RenderCore::new(RenderFormat {
        sample_rate: 48_000,
        channels: 1,
    })
    .unwrap();
    let q = vmusic_core::audio_quality::QualityParams {
        limiter: vmusic_core::audio_quality::LimiterMode::TruePeak,
        ..Default::default()
    };
    renderer.set_quality(q).unwrap();
    renderer.shared.playing.store(true, Ordering::Release);
    renderer
        .shared
        .current_deck()
        .samples
        .lock()
        .unwrap()
        .extend([0.8; 1000]);
    let mut output = renderer.output();
    output.render(&mut [0.0; 512], 1);
    renderer.set_volume(0.0).unwrap();
    let mut muted = [1.0; 512];
    assert_eq!(output.render(&mut muted, 1), 0);
    assert!(muted.iter().all(|x| *x == 0.0));
    renderer
        .shared
        .current_deck()
        .eof
        .store(true, Ordering::Release);
    for _ in 0..4 {
        output.render(&mut muted, 1);
    }
    let status = renderer.quality_status().unwrap();
    assert!(status.true_peak.unwrap() > 0.79);
}

#[test]
fn complete_local_chain_first_callback_and_tail_allocate_nothing() {
    let mut renderer = RenderCore::new(RenderFormat {
        sample_rate: 48_000,
        channels: 2,
    })
    .unwrap();
    let id = "a".repeat(64);
    let mut taps = vec![0.0; 257];
    taps[128] = 1.0;
    renderer
        .prepare_impulse(vmusic_core::impulse::ImpulseKernel {
            resource_id: id.clone(),
            sample_rate: 48_000,
            channels: vec![taps],
            delay_frames: 128,
            attenuation_db: 0.0,
        })
        .unwrap();
    let mut q = vmusic_core::audio_quality::QualityParams {
        limiter: vmusic_core::audio_quality::LimiterMode::TruePeak,
        ..Default::default()
    };
    q.tone.crossfeed = true;
    q.tone.loudness_compensation = true;
    q.tone.saturation = true;
    q.impulse_id = vmusic_core::audio_quality::decode_id(&id);
    renderer.set_quality(q).unwrap();
    renderer
        .shared
        .current_deck()
        .samples
        .lock()
        .unwrap()
        .extend([0.5; 2048]);
    renderer
        .shared
        .current_deck()
        .eof
        .store(true, Ordering::Release);
    renderer.shared.playing.store(true, Ordering::Release);
    let mut output = renderer.output();
    let memory = std::thread::spawn(move || {
        let mut block = [0.0; 256];
        let (_, memory) = super::tests::measure_memory(|| {
            for _ in 0..24 {
                output.render(&mut block, 2);
            }
        });
        memory
    })
    .join()
    .unwrap();
    assert_eq!(memory.allocs, 0);
    assert_eq!(memory.frees, 0);
}

#[test]
fn output_change_preserves_delayed_media_and_failure_cancels_pending_resume() {
    let mut renderer = RenderCore::new(RenderFormat {
        sample_rate: 48_000,
        channels: 1,
    })
    .unwrap();
    let q = vmusic_core::audio_quality::QualityParams {
        limiter: vmusic_core::audio_quality::LimiterMode::TruePeak,
        ..Default::default()
    };
    renderer.set_quality(q).unwrap();
    renderer
        .shared
        .current_deck()
        .samples
        .lock()
        .unwrap()
        .extend([0.2; 1024]);
    renderer.shared.playing.store(true, Ordering::Release);
    let mut output = renderer.output();
    output.render(&mut [0.0; 64], 1);
    assert!(renderer.validate_format_change(renderer.format()).is_err());
    let (opened, info) = super::tests::open_pcm(&[100; 16], 48_000, 1);
    renderer.pending_load = Some(PendingLoad {
        opened,
        info,
        play_after: true,
        track_gain_db: None,
    });
    renderer.shared.fade_frames.store(0, Ordering::Relaxed);
    renderer.output_failed("synthetic output loss".into());
    renderer.maintain();
    assert!(!renderer.shared.playing.load(Ordering::Acquire));
    assert!(renderer
        .pending_load
        .as_ref()
        .is_none_or(|pending| !pending.play_after));
}

#[test]
fn pending_source_gain_updates_target_without_changing_outgoing_gain() {
    let mut renderer = playing_renderer();
    renderer
        .shared
        .current_deck()
        .gain_db
        .store((-3.0f32).to_bits(), Ordering::Relaxed);
    let (opened, info) = super::tests::open_pcm(&[100; 16], 48_000, 1);
    renderer.pending_load = Some(PendingLoad {
        opened,
        info,
        play_after: false,
        track_gain_db: Some(6.0),
    });
    renderer
        .set_dsp(DspParams {
            track_gain_db: 0.0,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        f32::from_bits(
            renderer
                .shared
                .current_deck()
                .gain_db
                .load(Ordering::Relaxed)
        ),
        -3.0
    );
    assert_eq!(
        renderer.pending_load.as_ref().unwrap().track_gain_db,
        Some(0.0)
    );
    renderer.spawn_pending();
    assert_eq!(
        f32::from_bits(
            renderer
                .shared
                .current_deck()
                .gain_db
                .load(Ordering::Relaxed)
        ),
        0.0
    );
}

#[test]
fn legacy_format_is_not_withdrawn_and_output_switch_invalidates_adoption() {
    let mut renderer = RenderCore::new(RenderFormat {
        sample_rate: 192_000,
        channels: 2,
    })
    .unwrap();
    let mut q = vmusic_core::audio_quality::QualityParams {
        preamp_db: -3.0,
        ..Default::default()
    };
    renderer.validate_quality(q).unwrap();
    renderer.set_quality(q).unwrap();
    q.eq.enabled = true;
    q.eq.bands[0].frequency_hz = 80.0;
    q.eq.bands[0].gain_db = 2.0;
    assert!(renderer.validate_quality(q).is_err());
    let mut renderer = playing_renderer();
    let mut output = renderer.output();
    output.render(&mut [0.0; 64], 1);
    assert!(renderer.quality_status().unwrap().applied.is_some());
    renderer.shared.playing.store(false, Ordering::Release);
    renderer.activate_output(0).unwrap();
    assert!(renderer.quality_status().unwrap().applied.is_none());
}

#[test]
fn correction_rate_admission_preserves_requested_quality_on_rejection() {
    use vmusic_core::audio_quality::{HeadroomMode, LimiterMode, QualityParams};
    for rate in [44_100, 48_000, 96_000] {
        let mut renderer = RenderCore::new(RenderFormat {
            sample_rate: rate,
            channels: 2,
        })
        .unwrap();
        let mut base = QualityParams {
            limiter: LimiterMode::TruePeak,
            headroom_mode: HeadroomMode::Auto,
            ..Default::default()
        };
        base.eq.enabled = true;
        base.eq.bands[0].gain_db = 3.0;
        base.tone.crossfeed = true;
        base.tone.loudness_compensation = true;
        renderer.validate_quality(base).unwrap();
        renderer.set_quality(base).unwrap();

        let mut saturated = base;
        saturated.tone.saturation = true;
        let kernel = vmusic_core::impulse::ImpulseKernel {
            resource_id: "b".repeat(64),
            sample_rate: rate,
            channels: vec![vec![0.25, 0.5, 0.25]],
            delay_frames: 1,
            attenuation_db: 0.0,
        };
        let mut corrected = base;
        corrected.impulse_id = vmusic_core::audio_quality::decode_id(&kernel.resource_id);
        if rate == 96_000 {
            for candidate in [saturated, corrected] {
                assert!(renderer
                    .validate_quality(candidate)
                    .unwrap_err()
                    .to_string()
                    .contains("44.1/48 kHz"));
                assert!(renderer.set_quality(candidate).is_err());
                assert_eq!(renderer.quality_status().unwrap().requested, base);
            }
            assert!(renderer
                .prepare_impulse(kernel)
                .unwrap_err()
                .to_string()
                .contains("44.1/48 kHz"));
            assert!(renderer.shared.dsp.impulse.lock().unwrap().is_none());
        } else {
            renderer.set_quality(saturated).unwrap();
            renderer.prepare_impulse(kernel).unwrap();
            renderer.set_quality(corrected).unwrap();
            assert_eq!(renderer.quality_status().unwrap().requested, corrected);
        }
    }
}

#[test]
fn output_rate_change_requires_explicit_removal_of_heavy_effects() {
    use vmusic_core::audio_quality::{LimiterMode, QualityParams};
    for correction in [false, true] {
        let format = RenderFormat {
            sample_rate: 48_000,
            channels: 2,
        };
        let mut renderer = RenderCore::new(format).unwrap();
        let mut q = QualityParams {
            limiter: LimiterMode::TruePeak,
            ..Default::default()
        };
        if correction {
            let kernel = vmusic_core::impulse::ImpulseKernel {
                resource_id: "b".repeat(64),
                sample_rate: 48_000,
                channels: vec![vec![0.25, 0.5, 0.25]],
                delay_frames: 1,
                attenuation_db: 0.0,
            };
            q.impulse_id = vmusic_core::audio_quality::decode_id(&kernel.resource_id);
            renderer.prepare_impulse(kernel).unwrap();
        } else {
            q.tone.saturation = true;
        }
        renderer.set_quality(q).unwrap();
        let candidate = RenderFormat {
            sample_rate: 96_000,
            channels: 2,
        };
        assert!(renderer.validate_format_change(candidate).is_err());
        assert!(renderer.set_format(candidate).is_err());
        assert_eq!(renderer.format(), format);
        assert_eq!(renderer.quality_status().unwrap().requested, q);
        q.tone.saturation = false;
        q.impulse_id = None;
        renderer.set_quality(q).unwrap();
        renderer.set_format(candidate).unwrap();
        assert_eq!(renderer.format(), candidate);
        assert_eq!(renderer.quality_status().unwrap().requested, q);
    }
}

#[test]
fn pause_at_short_eof_preserves_delayed_tail_and_non_eof_stall_allows_replacement() {
    let mut renderer = RenderCore::new(RenderFormat {
        sample_rate: 48_000,
        channels: 1,
    })
    .unwrap();
    let q = vmusic_core::audio_quality::QualityParams {
        limiter: vmusic_core::audio_quality::LimiterMode::TruePeak,
        ..Default::default()
    };
    renderer.set_quality(q).unwrap();
    renderer
        .shared
        .current_deck()
        .samples
        .lock()
        .unwrap()
        .extend([0.1; 17]);
    renderer
        .shared
        .current_deck()
        .eof
        .store(true, Ordering::Release);
    renderer.shared.playing.store(true, Ordering::Release);
    let mut output = renderer.output();
    output.render(&mut [0.0; 32], 1);
    renderer.pause().unwrap();
    let epoch = renderer.shared.dsp.reset_epoch.load(Ordering::Acquire);
    renderer.play().unwrap();
    assert_eq!(
        renderer.shared.dsp.reset_epoch.load(Ordering::Acquire),
        epoch
    );
    let mut count = 0;
    for _ in 0..32 {
        let mut samples = [0.0; 16];
        let end = output.render(&mut samples, 1);
        let start = output.leading_silence_samples();
        count += end.saturating_sub(start);
        if renderer.finished() {
            break;
        }
    }
    assert_eq!(count, 17);

    renderer.shared.dsp.reset();
    renderer
        .shared
        .current_deck()
        .eof
        .store(false, Ordering::Release);
    renderer
        .shared
        .current_deck()
        .samples
        .lock()
        .unwrap()
        .extend([0.1; 32]);
    output.render(&mut [0.0; 32], 1);
    renderer.pause().unwrap();
    output.render(&mut [0.0; 16], 1);
    renderer.maintain();
    assert!(!renderer.shared.playing.load(Ordering::Acquire));
    let (opened, info) = super::tests::open_pcm(&[100; 16], 48_000, 1);
    renderer.pending_load = Some(PendingLoad {
        opened,
        info,
        play_after: false,
        track_gain_db: None,
    });
    renderer.maintain();
    assert!(renderer.pending_load.is_none());
}

#[test]
#[ignore = "release-only local complete-chain timing qualification"]
fn complete_quality_chain_probe() {
    if cfg!(debug_assertions) {
        panic!("run this probe with --release");
    }
    let paced = std::env::var_os("HERTZ_AUDIO_PROBE_PACED").is_some();
    let changes = std::env::var_os("HERTZ_AUDIO_PROBE_CHANGES").is_some();
    let seconds: usize = std::env::var("HERTZ_AUDIO_PROBE_SECONDS")
        .ok()
        .map(|s| s.parse().expect("probe seconds integer"))
        .unwrap_or(10);
    assert!((1..=120).contains(&seconds));
    #[cfg(windows)]
    struct Scheduling(Option<windows::Win32::Foundation::HANDLE>);
    #[cfg(windows)]
    impl Drop for Scheduling {
        fn drop(&mut self) {
            if let Some(handle) = self.0 {
                unsafe {
                    let _ =
                        windows::Win32::System::Threading::AvRevertMmThreadCharacteristics(handle);
                }
            }
        }
    }
    #[cfg(windows)]
    let _scheduling = Scheduling(if paced {
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
            Some(handle)
        }
    } else {
        None
    });
    let mut over_budget = Vec::new();
    for rate in [44_100, 48_000, 96_000] {
        let correction = vmusic_core::audio_quality::CORRECTION_PROCESSING_RATES.contains(&rate);
        for frames in [128usize, 512] {
            let mut renderer = RenderCore::new(RenderFormat {
                sample_rate: rate,
                channels: 2,
            })
            .unwrap();
            let id = "b".repeat(64);
            let mut taps = vec![0.001; 257];
            taps[128] = 0.744;
            if correction {
                renderer
                    .prepare_impulse(vmusic_core::impulse::ImpulseKernel {
                        resource_id: id.clone(),
                        sample_rate: rate,
                        channels: vec![taps],
                        delay_frames: 128,
                        attenuation_db: 0.0,
                    })
                    .unwrap();
            }
            let mut q = vmusic_core::audio_quality::QualityParams::default();
            q.eq.enabled = true;
            for b in &mut q.eq.bands {
                b.gain_db = 12.0;
            }
            q.headroom_mode = vmusic_core::audio_quality::HeadroomMode::Auto;
            q.limiter = vmusic_core::audio_quality::LimiterMode::TruePeak;
            q.tone.crossfeed = true;
            q.tone.loudness_compensation = true;
            q.tone.saturation = correction;
            q.tone.drive = 1.0;
            q.tone.mix = 1.0;
            q.impulse_id = if correction {
                vmusic_core::audio_quality::decode_id(&id)
            } else {
                None
            };
            renderer.set_quality(q).unwrap();
            let samples = (rate as usize * seconds) * 2;
            renderer
                .shared
                .current_deck()
                .samples
                .lock()
                .unwrap()
                .extend((0..samples).map(|i| 0.9 * (i as f32 * 0.71).sin()));
            renderer.shared.playing.store(true, Ordering::Release);
            let mut output = renderer.output();
            let mut block = vec![0.0; frames * 2];
            let mut timings = Vec::with_capacity(samples / (frames * 2) + 1);
            let interval = std::time::Duration::from_secs_f64(frames as f64 / rate as f64);
            let started = std::time::Instant::now();
            for index in 0..samples / (frames * 2) {
                if changes && index > 0 && index % (rate as usize / frames / 2).max(1) == 0 {
                    let alternate = (index / (rate as usize / frames / 2).max(1)).is_multiple_of(2);
                    q.eq.bands[0].frequency_hz = if alternate { 60.0 } else { 90.0 };
                    q.eq.bands[0].gain_db = if alternate { 12.0 } else { -12.0 };
                    q.tone.drive = if alternate { 1.0 } else { 0.15 };
                    q.tone.mix = if alternate { 1.0 } else { 0.1 };
                    let id = if alternate { "b" } else { "c" }.repeat(64);
                    let mut taps = vec![0.001; 257];
                    taps[128] = if alternate { 0.744 } else { 0.7 };
                    if correction {
                        renderer
                            .prepare_impulse(vmusic_core::impulse::ImpulseKernel {
                                resource_id: id.clone(),
                                sample_rate: rate,
                                channels: vec![taps],
                                delay_frames: 128,
                                attenuation_db: 0.0,
                            })
                            .unwrap();
                        q.impulse_id = vmusic_core::audio_quality::decode_id(&id);
                    }
                    renderer.set_quality(q).unwrap();
                }
                let begin = std::time::Instant::now();
                output.render(&mut block, 2);
                timings.push(begin.elapsed().as_nanos());
                if paced {
                    let next = started + interval * (index as u32 + 1);
                    std::thread::sleep(next.saturating_duration_since(std::time::Instant::now()));
                }
            }
            timings.sort_unstable();
            let p99 = timings[timings.len() * 99 / 100];
            let max = *timings.last().unwrap();
            let deadline = frames as f64 / rate as f64 * 1e9;
            eprintln!(
                "FULL_QUALITY_PROBE {}",
                serde_json::json!({"rate":rate,"frames":frames,"seconds":seconds,"continuous_changes":changes,"p99_ns":p99,"max_ns":max,"deadline_ns":deadline,"p99_fraction":p99 as f64/deadline,"over_deadline":timings.iter().filter(|n|**n as f64>deadline).count(),"real_device":false,"paced":paced,"audio_priority":paced&&cfg!(windows),"ir_taps":if correction {257} else {0},"saturation_oversample":if correction {4} else {1},"scope":if correction {"qualified_full_chain"} else {"qualified_without_ir_saturation"},"detector_taps":128,"detector_phases":8,"delay_frames":renderer.quality_status().map(|s|s.latency_frames)})
            );
            if (p99 as f64) >= deadline * 0.25 {
                over_budget.push((rate, frames, p99 as f64 / deadline));
            }
        }
    }
    assert!(
        over_budget.is_empty(),
        "complete chain exceeds CPU budget: {over_budget:?}"
    );
}

#[test]
fn nonfinite_dsp_requests_are_rejected_before_mutating_audio() {
    for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut renderer = playing_renderer();
        let mut params = DspParams::default();
        params.eq_gains_db[2] = invalid;
        assert!(renderer.set_dsp(params).is_err(), "invalid EQ accepted");
        params = DspParams {
            preamp_db: invalid,
            ..DspParams::default()
        };
        assert!(renderer.set_dsp(params).is_err(), "invalid preamp accepted");
        params = DspParams {
            track_gain_db: invalid,
            ..DspParams::default()
        };
        assert!(
            renderer.set_dsp(params).is_err(),
            "invalid track gain accepted"
        );
    }
}

#[test]
fn repeated_identical_request_preserves_filter_history() {
    let mut renderer = playing_renderer();
    let mut reference = playing_renderer();
    let mut actual = [0.0; 512];
    let mut expected = [0.0; 512];
    renderer.render(&mut actual);
    reference.render(&mut expected);
    renderer
        .set_dsp(DspParams {
            eq_gains_db: [0.0, 0.0, 0.0, 9.0, 0.0, 0.0],
            ..DspParams::default()
        })
        .unwrap();
    renderer.render(&mut actual);
    reference.render(&mut expected);
    assert_eq!(actual, expected);
}

#[test]
fn successful_seek_discards_the_previous_eq_history() {
    let create = || {
        let (opened, info) = super::tests::open_pcm(&vec![4_000; 4096], 48_000, 1);
        let mut renderer = super::tests::decoded_opened_fixture(opened, info, 48_000, 1);
        renderer
            .set_dsp(DspParams {
                eq_gains_db: [0.0, 0.0, 0.0, 9.0, 0.0, 0.0],
                ..DspParams::default()
            })
            .unwrap();
        renderer
            .shared
            .fade_gain
            .store(1.0f32.to_bits(), Ordering::Relaxed);
        renderer.shared.playing.store(true, Ordering::Relaxed);
        renderer
    };
    let mut renderer = create();
    let mut reference = create();
    renderer.render(&mut [0.0; 2048]);
    renderer.seek(0).unwrap();
    super::tests::wait_for_eof(&renderer);
    let mut actual = [0.0; 128];
    let mut expected = [0.0; 128];
    renderer.render(&mut actual);
    reference.render(&mut expected);
    assert!(
        actual
            .iter()
            .zip(expected)
            .all(|(a, b)| a.to_bits() == b.to_bits()),
        "successful seek must match fresh filter history"
    );
}

#[test]
fn only_the_active_output_can_consume_or_acknowledge_pcm() {
    let mut renderer = playing_renderer();
    let mut first = renderer.output();
    let mut samples = [0.0; 128];
    first.render(&mut samples, 1);
    let position = renderer.position_frames();
    let mut next = renderer.prepare_output(renderer.format()).unwrap();
    next.render(&mut samples, 1);
    assert!(samples.iter().all(|value| *value == 0.0));
    assert_eq!(renderer.position_frames(), position);
    renderer.activate_output(next.id()).unwrap();
    first.render(&mut samples, 1);
    assert!(samples.iter().all(|value| *value == 0.0));
    assert_eq!(renderer.position_frames(), position);
    next.render(&mut samples, 1);
    assert!(samples.iter().any(|value| *value != 0.0));
    assert_eq!(renderer.position_frames(), position + 128);
}

#[test]
fn changing_eq_acknowledges_only_after_the_real_transition() {
    use vmusic_core::EqApplicationState;
    let mut renderer = playing_renderer();
    let mut buffer = [0.0; 128];
    renderer.shared.playing.store(false, Ordering::Relaxed);
    assert_eq!(
        renderer.eq_status().unwrap().state,
        EqApplicationState::Deferred
    );
    renderer.render(&mut buffer);
    assert!(renderer.eq_status().unwrap().applied_revision.is_none());
    renderer.shared.playing.store(true, Ordering::Relaxed);
    renderer.render(&mut buffer);
    assert_eq!(
        renderer.eq_status().unwrap().state,
        EqApplicationState::Applied
    );
    renderer
        .set_dsp(DspParams {
            eq_gains_db: [4.0; 6],
            ..DspParams::default()
        })
        .unwrap();
    assert_eq!(
        renderer.eq_status().unwrap().state,
        EqApplicationState::Applying
    );
    renderer.render(&mut buffer);
    assert_eq!(
        renderer.eq_status().unwrap().state,
        EqApplicationState::Applying
    );
    for _ in 0..20 {
        renderer.render(&mut buffer);
    }
    assert_eq!(
        renderer.eq_status().unwrap().state,
        EqApplicationState::Applied
    );
}

#[test]
fn first_output_contention_waits_without_consuming_unfiltered_audio() {
    let mut renderer = playing_renderer();
    let shared = renderer.shared.clone();
    let guard = shared.dsp.parameters.lock().unwrap();
    let mut output = [1.0; 128];
    renderer.render(&mut output);
    assert_eq!(renderer.position_frames(), 0);
    assert_eq!(output, [0.0; 128]);
    drop(guard);
    renderer.render(&mut output);
    assert_eq!(renderer.position_frames(), 128);
    assert!(output.iter().any(|value| *value != 0.0));
}

#[test]
fn combined_eq_preamp_transition_stays_within_the_endpoint_peak_bounds() {
    for clamp_edge in [false, true] {
        let mut renderer = RenderCore::new(RenderFormat {
            sample_rate: 48_000,
            channels: 1,
        })
        .unwrap();
        let (old_eq, old_preamp, new_preamp, track, amplitude) = if clamp_edge {
            ([0.0; 6], -24.0, 12.0, 12.0, 0.1)
        } else {
            ([0.0, 0.0, 0.0, 12.0, 0.0, 0.0], -12.0, 0.0, 0.0, 0.9)
        };
        renderer
            .set_dsp(DspParams {
                eq_gains_db: old_eq,
                preamp_db: old_preamp,
                track_gain_db: track,
            })
            .unwrap();
        let samples: Vec<_> = (0..36_000)
            .map(|n| amplitude * (std::f32::consts::TAU * 1000.0 * n as f32 / 48_000.0).sin())
            .collect();
        renderer
            .shared
            .current_deck()
            .samples
            .lock()
            .unwrap()
            .extend(samples);
        renderer.shared.playing.store(true, Ordering::Relaxed);
        renderer.render(&mut vec![0.0; 24_000]);
        renderer
            .set_dsp(DspParams {
                eq_gains_db: [0.0; 6],
                preamp_db: new_preamp,
                track_gain_db: track,
            })
            .unwrap();
        let mut output = vec![0.0; 8_000];
        renderer.render(&mut output);
        let peak = output.into_iter().map(f32::abs).fold(0.0, f32::max);
        let bound = if clamp_edge { 0.795 } else { 0.901 };
        assert!(
            peak <= bound,
            "clamp_edge={clamp_edge}: transition peak {peak} exceeds {bound}"
        );
    }
}

#[test]
fn stale_captured_epoch_never_contaminates_new_stream_history() {
    let control = DspControl::new();
    control.publish(48_000, [12.0; 6]).unwrap();
    let mut runtime = DspRuntime::new(48_000, 1);
    let old_epoch = control.reset_epoch.load(Ordering::Acquire);
    control.reset();
    runtime.begin_epoch(&control, old_epoch);
    runtime.process(&mut [0.5]);
    runtime.finish_block(&control);
    assert!(control.status(true, 0).applied_revision.is_none());
    runtime.begin_block(&control);
    let mut silence = [0.0];
    runtime.process(&mut silence);
    assert_eq!(silence, [0.0]);
}
