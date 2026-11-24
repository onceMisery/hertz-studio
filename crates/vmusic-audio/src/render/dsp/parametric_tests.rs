// SPDX-License-Identifier: MIT
use super::*;
use vmusic_core::audio_quality::{HeadroomMode, QualityParams};

#[test]
fn parametric_admission_and_headroom() {
    let mut params = QualityParams::default();
    params.headroom_mode = HeadroomMode::Auto;
    let neutral = preparation::prepare(1, 48_000, params).unwrap();
    assert!((neutral.headroom.attenuation_db + 1.0).abs() < 1e-5);
    params.eq.enabled = true;
    for b in &mut params.eq.bands {
        b.frequency_hz = 1000.0;
        b.gain_db = 12.0;
    }
    params.preamp_db = 12.0;
    params.crossfade_ms = 8000;
    let boosted = preparation::prepare(2, 48_000, params).unwrap();
    assert!((boosted.headroom.eq_peak_db - 72.0).abs() < 0.01);
    assert!(boosted.headroom.attenuation_db < -86.0);
    params.eq.bands[0].frequency_hz = 20.0;
    params.eq.bands[0].q = 8.0;
    assert!(preparation::prepare(3, 48_000, params).is_err());
    params.eq.enabled = false;
    assert!(preparation::prepare(4, 8_000, params).is_ok());
    params.eq.enabled = true;
    params.eq.bands[0].frequency_hz = 20_000.0;
    params.eq.bands[0].q = 1.2;
    assert!(preparation::prepare(5, 44_100, params).is_err());
}

#[test]
fn arbitrary_low_frequency_cascade_matches_long_history_after_adoption() {
    for rate in [44_100, 48_000, 96_000] {
        let mut params = QualityParams::default();
        params.eq.enabled = true;
        for b in &mut params.eq.bands {
            b.frequency_hz = 80.0;
            b.q = 3.0;
            b.gain_db = 12.0;
        }
        let prepared = preparation::prepare(2, rate, params).unwrap();
        let mut reference = prepared.bands;
        let mut runtime = DspRuntime::new(rate, 1);
        let control = DspControl::new();
        control.publish(rate, [0.0; 6]).unwrap();
        let update = rate as usize * 3;
        let mut adopted = false;
        let mut max_error = 0.0f64;
        for n in 0..rate as usize * 5 {
            if n == update {
                control.publish_quality(rate, params).unwrap();
            }
            if n % 127 == 0 {
                runtime.begin_block(&control);
            }
            let input = (n as f64 * std::f64::consts::TAU * 79.0 / rate as f64).sin() * 0.00001;
            let mut exact = input;
            for b in &mut reference {
                exact = b.process(exact);
            }
            let mut frame = [input as f32];
            runtime.process(&mut frame);
            if n > update
                && matches!(runtime.transition, Transition::Idle)
                && runtime.configs[runtime.current] == params
            {
                adopted = true;
                max_error = max_error.max((frame[0] as f64 - exact).abs());
            }
        }
        assert!(adopted, "rate {rate}");
        assert!(max_error < 2e-4, "rate {rate}, residual {max_error}");
    }
}

#[test]
fn headroom_is_continuous_near_zero_and_does_not_enter_track_clamp() {
    let mut params = QualityParams::default();
    params.headroom_mode = HeadroomMode::Auto;
    let mut previous: Option<f32> = None;
    for preamp in [-0.01, 0.0, 0.01] {
        params.preamp_db = preamp;
        let p = preparation::prepare(2, 48_000, params).unwrap();
        if let Some(v) = previous {
            assert!((p.headroom.attenuation_db - v).abs() < 0.011);
        }
        previous = Some(p.headroom.attenuation_db);
        let mut dsp = DspRuntime::new(48_000, 1);
        dsp.configure(0, p);
        assert!((dsp.track_factors(0, [12.0, 0.0])[0] - 10.0f32.powf(12.0 / 20.0)).abs() < 1e-5);
    }
}

#[test]
fn gain_only_uses_ramp_and_reports_old_actual_during_a_b_c() {
    let rate = 48_000;
    let mut a = QualityParams::default();
    a.configuration_revision = 1;
    a.eq.enabled = true;
    a.eq.bands[0].frequency_hz = 80.0;
    a.eq.bands[0].q = 3.0;
    a.eq.bands[0].gain_db = 12.0;
    let control = DspControl::new();
    control.publish_quality(rate, a).unwrap();
    let mut runtime = DspRuntime::new(rate, 1);
    runtime.begin_block(&control);
    for _ in 0..rate {
        runtime.process(&mut [0.01]);
    }
    runtime.finish_block(&control);
    let mut b = a;
    b.configuration_revision = 2;
    b.preamp_db = -3.0;
    control.publish_quality(rate, b).unwrap();
    runtime.begin_block(&control);
    assert!(matches!(runtime.transition, Transition::Fading { done: 0 }));
    runtime.process(&mut [0.01]);
    runtime.finish_block(&control);
    let mut c = b;
    c.configuration_revision = 3;
    c.preamp_db = -6.0;
    control.publish_quality(rate, c).unwrap();
    let status = control.quality_status(true, 1);
    assert_eq!(status.applied, Some(a));
    assert_eq!(status.transition_from, Some(a));
    assert_eq!(status.transition_target, Some(b));
    assert_eq!(status.requested, c);
    for _ in 0..runtime.fade_frames {
        runtime.process(&mut [0.01]);
    }
    runtime.finish_block(&control);
    assert_eq!(control.quality_status(true, 1).applied, Some(b));
}

#[test]
fn preamp_crossing_track_clamp_rebuilds_history_instead_of_copying_wrong_state() {
    let rate = 48_000;
    let mut a = QualityParams::default();
    a.eq.enabled = true;
    a.preamp_db = 12.0;
    a.eq.bands[0].frequency_hz = 80.0;
    a.eq.bands[0].q = 3.0;
    a.eq.bands[0].gain_db = 12.0;
    let control = DspControl::new();
    control.publish_quality(rate, a).unwrap();
    let mut runtime = DspRuntime::new(rate, 1);
    runtime.begin_block(&control);
    for _ in 0..rate {
        runtime.process_mix(&[0.01], &[0.0], [12.0, 0.0], [1.0, 0.0], &mut [0.0]);
    }
    a.preamp_db = 0.0;
    control.publish_quality(rate, a).unwrap();
    runtime.begin_block(&control);
    assert!(matches!(runtime.transition, Transition::Warming { .. }));
}
