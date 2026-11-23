use super::*;
use vmusic_core::DspParams;

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
