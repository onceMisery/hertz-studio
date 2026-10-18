use serde_json::{json, Value};
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};
use vmusic_beats::pitch::{self, Control};

pub fn evaluate() -> Value {
    let started = Instant::now();
    let mut cases = Vec::new();
    for rate in [8_000, 44_100, 48_000, 96_000] {
        for hz in [55.0, 60.0, 110.0, 220.0, 440.0, 880.0, 1_200.0] {
            cases.push(run(
                &format!("sine-{hz}-{rate}"),
                rate,
                |t| (0.4 * (t * hz * std::f64::consts::TAU).sin()) as f32,
                |_| Some(hz),
            ));
        }
    }
    cases.push(run(
        "missing-fundamental-110",
        48_000,
        |t| {
            (0.3 * (t * 220.0 * std::f64::consts::TAU).sin()
                + 0.2 * (t * 330.0 * std::f64::consts::TAU).sin()) as f32
        },
        |_| Some(110.0),
    ));
    cases.push(run(
        "dc-offset-220",
        44_100,
        |t| (0.5 + 0.2 * (t * 220.0 * std::f64::consts::TAU).sin()) as f32,
        |_| Some(220.0),
    ));
    cases.push(run("silence", 8_000, |_| 0.0, |_| None));
    cases.push(run("constant-dc", 48_000, |_| 0.5, |_| None));
    cases.push(run(
        "below-floor",
        48_000,
        |t| (0.00001 * (t * 220.0 * std::f64::consts::TAU).sin()) as f32,
        |_| None,
    ));
    cases.push(run(
        "anti-alias-7500",
        48_000,
        |t| (0.4 * (t * 7500.0 * std::f64::consts::TAU).sin()) as f32,
        |_| None,
    ));
    cases.push(run(
        "above-range-1800",
        48_000,
        |t| (0.4 * (t * 1800.0 * std::f64::consts::TAU).sin()) as f32,
        |_| None,
    ));
    let mut seed = 7u32;
    cases.push(run(
        "deterministic-noise",
        48_000,
        |_| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (f64::from(seed) / f64::from(u32::MAX) * 0.6 - 0.3) as f32
        },
        |_| None,
    ));
    cases.push(run(
        "frequency-step",
        48_000,
        |t| (0.4 * (t * if t < 0.5 { 220.0 } else { 440.0 } * std::f64::consts::TAU).sin()) as f32,
        |t| {
            if (t - 0.5).abs() < 0.128 {
                None
            } else {
                Some(if t < 0.5 { 220.0 } else { 440.0 })
            }
        },
    ));
    json!({"reportVersion":1,"algorithm":pitch::ALGORITHM,"version":pitch::VERSION,
        "syntheticOnly":true,"realMusicAccepted":false,"sampleRates":[8000,44100,48000,96000],
        "windowSamples":1024,"hopMs":pitch::HOP_MS,"rangeHz":[pitch::MIN_HZ,pitch::MAX_HZ],
        "caseCount":cases.len(),"passed":cases.iter().filter(|c|c["pass"] == true).count(),
        "elapsedMs":started.elapsed().as_millis(),"cases":cases})
}

fn run(
    name: &str,
    rate: u32,
    mut sample: impl FnMut(f64) -> f32,
    expected: impl Fn(f64) -> Option<f64>,
) -> Value {
    let pcm: Vec<f32> = (0..rate)
        .map(|i| sample(f64::from(i) / f64::from(rate)))
        .collect();
    let control = Control {
        until: Instant::now() + Duration::from_secs(10),
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    let map = pitch::analyze_mono(&pcm, rate, &control).unwrap();
    let (mut scored, mut correct, mut voiced) = (0, 0, 0);
    let mut errors = Vec::new();
    for point in &map.points {
        let truth = expected(point.t as f64 / 1000.0);
        // The step transition straddles an analysis window; it is not scored.
        if name == "frequency-step" && truth.is_none() {
            continue;
        }
        scored += 1;
        match (truth, point.hz) {
            (Some(hz), Some(actual)) => {
                voiced += 1;
                let cents = (1200.0 * (actual / hz).log2()).abs();
                errors.push(cents);
                if cents <= 35.0 {
                    correct += 1;
                }
            }
            (None, None) => correct += 1,
            (_, Some(_)) => voiced += 1,
            _ => (),
        }
    }
    let mean = if errors.is_empty() {
        None
    } else {
        Some(errors.iter().sum::<f64>() / errors.len() as f64)
    };
    json!({"name":name,"frames":map.points.len(),"scored":scored,"correct":correct,
        "voiced":voiced,"meanAbsoluteCents":mean,"pass":scored>0 && correct as f64/scored as f64>=0.95})
}
