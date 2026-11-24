// SPDX-License-Identifier: MIT
use super::*;
use crate::audio_quality::LimiterMode;
fn plan() -> PreviewPlan {
    let saved = QualityParams::default();
    PreviewPlan {
        request_id: "a0000000-0000-4000-8000-000000000000".into(),
        saved,
        enhanced: saved,
        impulse: None,
        matching: None,
        volume: 0.75,
        track_gain_db: 0.0,
        source_sha256: "a".repeat(64),
        reference_end_ms: 3000,
        reference_end_frame: 144_000,
    }
}
#[test]
fn exact_reference_frame_domain_includes_submillisecond_sources_and_rejects_rounded_bounds() {
    for rate in [44_100, 48_000, 96_000] {
        for frames in [1, 17, 193, u64::from(rate) * 12] {
            let mut p = plan();
            p.reference_end_frame = frames;
            p.reference_end_ms = frames * 1000 / u64::from(rate);
            assert!(p.validate(rate).is_ok());
            p.reference_end_ms += 1;
            assert!(p.validate(rate).is_err());
        }
        let mut p = plan();
        p.reference_end_frame = u64::from(rate) * 12 + 1;
        p.reference_end_ms = p.reference_end_frame * 1000 / u64::from(rate);
        assert!(p.validate(rate).is_err());
    }
    let mut p = plan();
    p.reference_end_frame = 0;
    p.reference_end_ms = 0;
    assert!(p.validate(48_000).is_err());
}
#[test]
fn preview_contract_freezes_persisted_revision_protection_and_crossfade() {
    let p = plan();
    assert!(p.validate(48_000).is_ok());
    let mut changed = p.clone();
    changed.enhanced.configuration_revision += 1;
    assert!(changed.validate(48_000).is_err());
    let mut changed = p.clone();
    changed.enhanced.crossfade_ms = 1000;
    assert!(changed.validate(48_000).is_err());
    let mut changed = p.clone();
    changed.enhanced.limiter = LimiterMode::TruePeak;
    assert!(changed.validate(48_000).is_err());
    for volume in [f32::NAN, -0.1, 1.1] {
        let mut changed = p.clone();
        changed.volume = volume;
        assert!(changed.validate(48_000).is_err());
    }
    for gain in [f32::NAN, -24.1, 12.1] {
        let mut changed = p.clone();
        changed.track_gain_db = gain;
        assert!(changed.validate(48_000).is_err());
    }
    let mut changed = p.clone();
    changed.source_sha256 = "g".repeat(64);
    assert!(changed.validate(48_000).is_err());
}
#[test]
fn match_requires_two_bounded_attenuations_safe_peak_and_nonactive_protection() {
    let mut p = plan();
    let valid = LoudnessMatch {
        enhanced_lufs: -18.0,
        bypass_lufs: -24.0,
        enhanced_attenuation_db: -6.0,
        bypass_attenuation_db: 0.0,
        common_attenuation_db: -3.0,
        residual_lu: 0.05,
        final_true_peak: 0.5,
        max_protection_reduction_db: 0.0,
        reference_start_ms: 2000,
        reference_duration_ms: 1000,
    };
    p.matching = Some(valid.clone());
    assert!(p.validate(48_000).is_ok());
    let mut invalid = valid.clone();
    invalid.residual_lu = 0.101;
    p.matching = Some(invalid);
    assert!(p.validate(48_000).is_err());
    let mut invalid = valid.clone();
    invalid.enhanced_attenuation_db = 0.1;
    p.matching = Some(invalid);
    assert!(p.validate(48_000).is_err());
    let mut invalid = valid.clone();
    invalid.final_true_peak = 1.0;
    p.matching = Some(invalid);
    assert!(p.validate(48_000).is_err());
    let mut invalid = valid.clone();
    invalid.max_protection_reduction_db = -0.1;
    p.matching = Some(invalid);
    assert!(p.validate(48_000).is_err());
    let mut invalid = valid.clone();
    invalid.max_protection_reduction_db = 0.02;
    p.matching = Some(invalid);
    assert!(p.validate(48_000).is_err());
    let mut invalid = valid.clone();
    invalid.common_attenuation_db = -70.0;
    p.matching = Some(invalid);
    assert!(p.validate(48_000).is_err());
    let mut invalid = valid.clone();
    invalid.reference_start_ms = 0;
    p.matching = Some(invalid);
    assert!(p.validate(48_000).is_err());
    let mut invalid = valid;
    invalid.reference_duration_ms = 1001;
    p.matching = Some(invalid);
    assert!(p.validate(48_000).is_err());
}
#[test]
fn unknown_phase_is_only_valid_in_the_preview_contract() {
    let mut p = plan();
    p.saved.limiter = LimiterMode::TruePeak;
    p.enhanced.limiter = LimiterMode::TruePeak;
    let id = "b".repeat(64);
    p.enhanced.impulse_id = crate::audio_quality::decode_id(&id);
    let impulse = PreviewImpulse {
        phase: ImpulsePhase::Unknown,
        kernel: ImpulseKernel {
            resource_id: id,
            sample_rate: 48_000,
            channels: vec![vec![0.7, 0.2]],
            delay_frames: 0,
            attenuation_db: 0.0,
        },
    };
    assert!(impulse.validate().is_ok());
    assert!(impulse.kernel.validate().is_err());
    p.impulse = Some(impulse.clone());
    assert!(p.validate(48_000).is_ok());
    assert!(p.validate(96_000).is_err());
    let mut missing = p.clone();
    missing.impulse = None;
    assert!(missing.validate(48_000).is_err());
    let mut mismatched = p.clone();
    mismatched.impulse.as_mut().unwrap().kernel.resource_id = "c".repeat(64);
    assert!(mismatched.validate(48_000).is_err());
    let mut invalid = impulse;
    invalid.kernel.channels[0] = vec![0.1; 258];
    assert!(invalid.validate().is_err());
    invalid.kernel.channels[0] = vec![0.1; 257];
    invalid.kernel.delay_frames = 129;
    assert!(invalid.validate().is_err());
}
