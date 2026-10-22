// SPDX-License-Identifier: MIT
#[path = "support/pitch_cases.rs"]
mod cases;
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};
use vmusic_beats::pitch::{self, Control, PitchError};

#[test]
fn synthetic_frequency_time_and_unvoiced_matrix() {
    let report = cases::evaluate();
    for case in report["cases"].as_array().unwrap() {
        assert_eq!(case["pass"], true, "{case}");
    }
}

#[test]
fn invalid_samples_deadlines_and_cancellation_do_not_create_a_track() {
    let mut control = Control {
        until: Instant::now() + Duration::from_secs(2),
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    assert_eq!(
        pitch::analyze_mono(&[f32::NAN; 2048], 8_000, &control).unwrap_err(),
        PitchError::Decode
    );
    assert_eq!(
        pitch::analyze_mono(&[0.0; 2048], 4_000, &control).unwrap_err(),
        PitchError::Unsupported
    );
    assert!(pitch::analyze_mono(&[], 8_000, &control)
        .unwrap()
        .points
        .is_empty());
    let short = pitch::analyze_mono(&[0.0; 512], 8_000, &control).unwrap();
    assert!(short.points.is_empty());
    assert_eq!(short.analyzed_ms, 64);
    control.until = Instant::now();
    assert_eq!(
        pitch::analyze_mono(&[0.0; 2048], 8_000, &control).unwrap_err(),
        PitchError::Deadline
    );
    control.until = Instant::now() + Duration::from_secs(1);
    control
        .cancelled
        .store(true, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(
        pitch::analyze_mono(&[0.0; 2048], 8_000, &control).unwrap_err(),
        PitchError::Cancelled
    );
}

#[test]
fn duration_budget_distinguishes_exact_eof_from_an_unanalyzed_tail() {
    let control = Control {
        until: Instant::now() + Duration::from_secs(30),
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    let mut samples = vec![0.0; (pitch::MAX_MS * u64::from(pitch::RATE) / 1000) as usize];
    let exact = pitch::analyze_mono(&samples, pitch::RATE, &control).unwrap();
    assert_eq!(exact.analyzed_ms, pitch::MAX_MS);
    assert!(!exact.truncated);
    samples.push(0.0);
    let longer = pitch::analyze_mono(&samples, pitch::RATE, &control).unwrap();
    assert_eq!(longer.analyzed_ms, pitch::MAX_MS);
    assert!(longer.truncated);
    assert_eq!(longer.points.len(), exact.points.len());
    assert!(longer.points.iter().all(|p| p.hz.is_none()));
}
