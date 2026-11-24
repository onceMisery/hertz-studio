// SPDX-License-Identifier: MIT
use super::*;
use std::sync::{atomic::AtomicBool, Arc};
use vmusic_core::audio_preview::{ImpulsePhase, PreviewImpulse};
use vmusic_core::audio_quality::{LimiterMode, QualityParams};

fn control() -> Control {
    Control {
        until: std::time::Instant::now() + std::time::Duration::from_secs(120),
        cancelled: Arc::new(AtomicBool::new(false)),
    }
}
fn plan(rate: u32, preamp: f32) -> PreviewPlan {
    let saved = QualityParams::default();
    let mut enhanced = saved;
    enhanced.preamp_db = preamp;
    PreviewPlan {
        request_id: "a0000000-0000-4000-8000-000000000000".into(),
        saved,
        enhanced,
        impulse: None,
        matching: None,
        volume: 1.0,
        track_gain_db: 0.0,
        source_sha256: "a".repeat(64),
        reference_end_ms: 4000,
        reference_end_frame: u64::from(rate) * 4,
    }
}
fn sine(rate: u32, seconds: usize, amplitude: f32) -> Vec<f32> {
    (0..rate as usize * seconds)
        .map(|i| {
            amplitude * (std::f64::consts::TAU * 1000.0 * i as f64 / f64::from(rate)).sin() as f32
        })
        .collect()
}

#[test]
fn each_louder_side_gets_its_own_attenuation_and_analytic_gain_matches() {
    let pcm = sine(48_000, 4, 0.1);
    for preamp in [-6.0, 6.0] {
        let mut p = plan(48_000, preamp);
        let c = compare_pcm(&pcm, &p, 48_000, 1, &control()).unwrap();
        let m = c
            .matching
            .clone()
            .expect("audible steady reference should match");
        assert!((m.enhanced_lufs - m.bypass_lufs - f64::from(preamp)).abs() < 0.001);
        assert!((m.enhanced_attenuation_db + preamp.max(0.0)).abs() < 0.001);
        assert!((m.bypass_attenuation_db - preamp.min(0.0)).abs() < 0.001);
        assert_eq!(m.common_attenuation_db, 0.0);
        assert!(m.residual_lu.abs() < 0.001);
        assert_eq!(m.max_protection_reduction_db, 0.0);
        assert!(
            (m.final_true_peak - 0.1 * 10f64.powf(f64::from(preamp.min(0.0)) / 20.0)).abs()
                < 0.0002
        );
        p.matching = Some(m);
        p.validate(48_000).unwrap();
    }
}

#[test]
fn warmup_transient_is_included_in_common_safe_margin_and_actual_protection_recheck() {
    let mut pcm = sine(48_000, 4, 0.05);
    for (i, x) in pcm[..4800].iter_mut().enumerate() {
        *x = 0.95 * (i as f32 * 0.3).sin();
    }
    let mut p = plan(48_000, 6.0);
    p.saved.limiter = LimiterMode::TruePeak;
    p.enhanced.limiter = LimiterMode::TruePeak;
    let c = compare_pcm(&pcm, &p, 48_000, 1, &control()).unwrap();
    let m = c.matching.unwrap();
    assert!(
        m.common_attenuation_db < -2.0,
        "the loud warmup must also be guarded"
    );
    assert!(m.final_true_peak <= 10f64.powf(-2.9 / 20.0));
    assert!(m.residual_lu.abs() <= 0.1);
    assert!(m.max_protection_reduction_db <= 0.01);
}

#[test]
fn delayed_tone_and_known_ir_match_without_removing_real_reference_frames() {
    let rate = 48_000;
    let pcm = sine(rate, 4, 0.1);
    let mut p = plan(rate, 3.0);
    p.saved.limiter = LimiterMode::TruePeak;
    p.enhanced.limiter = LimiterMode::TruePeak;
    p.enhanced.tone.saturation = true;
    p.enhanced.tone.drive = 0.5;
    p.enhanced.tone.mix = 0.25;
    p.enhanced.impulse_id = vmusic_core::audio_quality::decode_id(&"b".repeat(64));
    p.impulse = Some(PreviewImpulse {
        phase: ImpulsePhase::SymmetricLinear,
        kernel: vmusic_core::impulse::ImpulseKernel {
            resource_id: "b".repeat(64),
            sample_rate: rate,
            channels: vec![vec![0.0, 0.0, 1.0, 0.0, 0.0]],
            delay_frames: 2,
            attenuation_db: 0.0,
        },
    });
    let c = compare_pcm(&pcm, &p, rate, 1, &control()).unwrap();
    let m = c.matching.expect("tone reference should match");
    assert!(m.residual_lu.abs() <= 0.1);
    assert_eq!(c.reference_end_frame, u64::from(rate) * 4);
    assert_eq!(m.reference_start_ms, 2000);
    assert_eq!(m.reference_duration_ms, 2000);
    assert_eq!(preview::alignment(&p), 10);
}

#[test]
fn silence_below_gate_short_source_and_protection_failure_do_not_claim_a_match() {
    let p = plan(48_000, 6.0);
    for pcm in [vec![0.0; 144_000], sine(48_000, 3, 1e-8)] {
        let c = compare_pcm(&pcm, &p, 48_000, 1, &control()).unwrap();
        assert!(c.matching.is_none());
        assert_eq!(c.unmatched_reason, Some("reference_silence_or_below_gate"));
    }
    let c = compare_pcm(&[0.1; 193], &p, 48_000, 1, &control()).unwrap();
    assert!(c.matching.is_none());
    assert_eq!(c.reference_end_frame, 193);
    assert_eq!(c.unmatched_reason, Some("reference_too_short"));
    // The protected recheck can reject a pair which falls through the absolute
    // gate after matching; the UI must retain a plain, explicitly unmatched audition.
    let mut p = plan(48_000, -24.0);
    p.enhanced.eq.enabled = true;
    p.enhanced.eq.bands[3].gain_db = -12.0;
    let c = compare_pcm(&sine(48_000, 4, 0.003), &p, 48_000, 1, &control()).unwrap();
    assert!(c.matching.is_none());
    assert!(c.unmatched_reason.is_some());
}

#[test]
fn comparison_obeys_cancellation_limits_and_frozen_protection() {
    let mut c = control();
    c.cancelled.store(true, Ordering::Release);
    assert!(matches!(
        compare_pcm(&sine(48_000, 3, 0.1), &plan(48_000, 0.0), 48_000, 1, &c),
        Err(AnalyzeError::Cancelled)
    ));
    c.cancelled.store(false, Ordering::Release);
    c.until = std::time::Instant::now() - std::time::Duration::from_millis(1);
    assert!(matches!(
        compare_pcm(&sine(48_000, 3, 0.1), &plan(48_000, 0.0), 48_000, 1, &c),
        Err(AnalyzeError::Deadline)
    ));
    assert!(compare_pcm(&[0.0; 7], &plan(48_000, 0.0), 48_000, 2, &control()).is_err());
    let mut p = plan(48_000, 0.0);
    p.enhanced.limiter = LimiterMode::TruePeak;
    assert!(compare_pcm(&sine(48_000, 3, 0.1), &p, 48_000, 1, &control()).is_err());
}

#[test]
fn unknown_intrinsic_phase_is_preserved_while_only_algorithm_delay_is_aligned() {
    let rate = 48_000;
    let pcm = sine(rate, 4, 0.1);
    let mut p = plan(rate, 0.0);
    p.saved.limiter = LimiterMode::TruePeak;
    p.enhanced.limiter = LimiterMode::TruePeak;
    p.enhanced.impulse_id = vmusic_core::audio_quality::decode_id(&"c".repeat(64));
    p.impulse = Some(PreviewImpulse {
        phase: ImpulsePhase::Unknown,
        kernel: vmusic_core::impulse::ImpulseKernel {
            resource_id: "c".repeat(64),
            sample_rate: rate,
            channels: vec![vec![0.0, 1.0, 0.0, 0.0]],
            delay_frames: 0,
            attenuation_db: 0.0,
        },
    });
    assert_eq!(preview::alignment(&p), 0);
    let c = compare_pcm(&pcm, &p, rate, 1, &control()).unwrap();
    assert!(c.matching.is_some());
    assert_eq!(p.impulse.as_ref().unwrap().phase, ImpulsePhase::Unknown);
}
