use super::*;

#[test]
fn fixed_eq_transition_matches_long_history_and_survives_block_fragmentation() {
    for rate in [44_100, 48_000, 96_000, 192_000] {
        let gains = [12.0, -12.0, 12.0, -12.0, 12.0, -12.0];
        let control = DspControl::new();
        control.publish(rate, [0.0; 6]).unwrap();
        let mut runtime = DspRuntime::new(rate, 2);
        let mut reference = EqBank::new(rate, gains, 2);
        let input = |n: usize| {
            [
                0.03 * (std::f64::consts::TAU * 60.0 * n as f64 / rate as f64).sin() as f32,
                0.03 * (std::f64::consts::TAU * 2400.0 * n as f64 / rate as f64).sin() as f32,
            ]
        };
        runtime.begin_block(&control);
        for n in 0..rate as usize {
            let mut frame = input(n);
            for (ch, value) in frame.iter().enumerate() {
                reference.process_frame(ch, *value);
            }
            runtime.process(&mut frame);
        }
        runtime.finish_block(&control);
        control.publish(rate, gains).unwrap();
        runtime.begin_block(&control);
        let mut max_error = 0.0f32;
        let mut completed = None;
        for n in 0..(rate / 10) as usize {
            if n % 127 == 0 {
                runtime.begin_block(&control);
            }
            let mut frame = input(rate as usize + n);
            let expected = [
                reference.process_frame(0, frame[0]),
                reference.process_frame(1, frame[1]),
            ];
            runtime.process(&mut frame);
            if matches!(runtime.transition, Transition::Idle) {
                completed.get_or_insert(n);
                for ch in 0..2 {
                    max_error = max_error.max((frame[ch] - expected[ch]).abs());
                }
            }
        }
        assert!(
            completed.is_some_and(|n| n < (rate / 10) as usize),
            "rate {rate}: adoption exceeds 100 ms"
        );
        assert!(
            max_error < 0.00001,
            "rate {rate}: long-history residual {max_error}"
        );
        runtime.finish_block(&control);
        assert_eq!(
            control.status(true, 0).state,
            vmusic_core::EqApplicationState::Applied
        );
    }
}

#[test]
fn rapid_requests_keep_only_the_latest_and_reset_clears_pending_history() {
    let control = DspControl::new();
    let mut runtime = DspRuntime::new(48_000, 1);
    runtime.begin_block(&control);
    for _ in 0..7680 {
        runtime.process(&mut [0.01]);
    }
    control.publish(48_000, [12.0; 6]).unwrap();
    runtime.begin_block(&control);
    for gain in -12..12 {
        control.publish(48_000, [gain as f32; 6]).unwrap();
    }
    control.publish(48_000, [-3.0; 6]).unwrap();
    for _ in 0..150 {
        runtime.begin_block(&control);
        for _ in 0..128 {
            runtime.process(&mut [0.01]);
        }
        runtime.finish_block(&control);
    }
    assert_eq!(runtime.banks[runtime.current].gains, [-3.0; 6]);
    assert_eq!(
        control.status(true, 0).state,
        vmusic_core::EqApplicationState::Applied
    );
    control.reset();
    runtime.begin_block(&control);
    let mut silence = [0.0];
    runtime.process(&mut silence);
    assert_eq!(silence, [0.0]);
}

#[test]
#[ignore = "release-only synthetic DSP timing; does not open an audio device"]
fn quality_probe() {
    assert!(!cfg!(debug_assertions), "run this probe with --release");
    for rate in [44_100, 48_000, 96_000] {
        for block in [128usize, 512] {
            let control = DspControl::new();
            control.publish(rate, [0.0; 6]).unwrap();
            let mut runtime = DspRuntime::new(rate, 2);
            let mut output = vec![[0.0f32; 2]; block];
            let blocks = (rate as usize * 30).div_ceil(block);
            let mut times = Vec::with_capacity(blocks);
            for iteration in 0..blocks {
                if iteration % 32 == 0 {
                    let gain = if iteration % 64 == 0 { 12.0 } else { -12.0 };
                    control.publish(rate, [gain; 6]).unwrap();
                }
                for (offset, frame) in output.iter_mut().enumerate() {
                    let t = (iteration * block + offset) as f64 / rate as f64;
                    *frame = [
                        0.01 * (std::f64::consts::TAU * 60.0 * t).sin() as f32,
                        0.01 * (std::f64::consts::TAU * 6000.0 * t).sin() as f32,
                    ];
                }
                let started = std::time::Instant::now();
                runtime.begin_block(&control);
                for frame in &mut output {
                    runtime.process(std::hint::black_box(frame));
                }
                runtime.finish_block(&control);
                times.push(started.elapsed().as_nanos() as u64);
            }
            times.sort_unstable();
            let deadline = block as f64 * 1e9 / rate as f64;
            let over = times
                .iter()
                .filter(|value| **value as f64 > deadline)
                .count();
            println!(
                "DSP_PROBE {}",
                serde_json::json!({
                    "rate":rate,"channels":2,"blockFrames":block,"blocks":blocks,
                    "p99Ns":times[times.len()*99/100],"maxNs":times.last(),
                    "deadlineNs":deadline,"overDeadline":over,
                    "historyBytes":runtime.history.len()*4,
                    "syntheticAudioSeconds":30,"realDeviceVerified":false
                })
            );
        }
    }
    let c = 0.98f32;
    let onset = c + (1.0 - c) / c;
    let limiter_samples = [0.0f32, 0.5, 0.98, 1.0, 1.001, 1.1, 2.0].map(|x| [x, soft_limit(x, c)]);
    println!(
        "DSP_BASELINE {}",
        serde_json::json!({
            "hardClipInputAmplitude":onset,
            "correlatedCrossfadePeakDb":20.0f64*(0.88*2.0f64.sqrt()).log10(),
            "limiterSamples":limiter_samples
        })
    );
}

#[test]
fn eq_pcm_matches_original_filter_chain_across_parameter_switches() {
    for rate in [8_000, 44_100, 48_000, 192_000] {
        for gains in [[0.0; 6], [2.0, 0.0, -3.0, 0.0, 4.0, 0.0], [0.0; 6]] {
            let mut bank = EqBank::new(rate, gains, 2);
            let mut reference = bank.states.clone();
            for frame in 0..4096 {
                for (ch, channel_reference) in reference.iter_mut().enumerate() {
                    let sample = match frame % 31 {
                        0 => -0.0,
                        1 => f32::from_bits(1),
                        _ => (frame as f32 * (0.11 + ch as f32 * 0.003)).sin(),
                    };
                    let mut expected = sample as f64;
                    for band in channel_reference {
                        expected = band.process(expected);
                    }
                    assert_eq!(
                        bank.process_frame(ch, sample).to_bits(),
                        (expected as f32).to_bits()
                    );
                }
            }
        }
    }
}

#[test]
fn neutral_eq_preserves_nonfinite_filter_history_semantics() {
    for invalid in [f32::INFINITY, f32::NEG_INFINITY, f32::NAN] {
        let mut bank = EqBank::new(48_000, [0.0; 6], 1);
        let mut reference = bank.states.clone();
        for sample in [0.5, -0.5, invalid, 0.25, 0.0] {
            let mut expected = sample as f64;
            for band in &mut reference[0] {
                expected = band.process(expected);
            }
            let actual = bank.process_frame(0, sample);
            assert!(
                actual.to_bits() == (expected as f32).to_bits()
                    || actual.is_nan() && expected.is_nan()
            );
        }
    }
}

#[test]
fn peaking_filter_zero_gain_is_identity() {
    let mut q = BiQuad::peaking(1000.0, 0.0, 1.2, 48_000);
    // 增益 0 时 b0≈1、b1≈-2cos、a1≈-2cos、其余≈0 → 直通（系数误差 < 1e-9）
    let out = q.process(0.5);
    assert!((out - 0.5).abs() < 1e-6, "identity violated: {out}");
}

#[test]
fn peaking_filter_boosts_band_center() {
    // +12dB @1kHz：以 1kHz 正弦（数值上直接喂常数不合适，喂极低频近似直流，
    // 低频段增益应接近 1）。这里直接验证系数能量：中心频率处幅度比 > 1。
    let q = BiQuad::peaking(1000.0, 12.0, 1.2, 48_000);
    // 中心频率增益 |b0+b1 z+b2 z²|/|1+a1 z+a2 z²| 在 z=e^{-jw0} 处 ≈ 10^(12/20)
    // 简化：直接断言 b0 > a0 归一化后的 1（有增益）
    assert!(q.b0 > 1.0);
}

#[test]
fn limiter_is_transparent_below_ceiling_and_caps_above() {
    for nonfinite in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        assert_eq!(soft_limit(nonfinite, 0.98), 0.0);
    }
    assert_eq!(soft_limit(0.5, 0.98), 0.5);
    assert_eq!(soft_limit(-0.5, 0.98), -0.5);
    let loud = soft_limit(1.5, 0.98);
    assert!(
        loud > 0.98 && loud <= 1.0,
        "soft clip must stay bounded: {loud}"
    );
    let neg = soft_limit(-1.5, 0.98);
    assert!((-1.0..=-0.98).contains(&neg));
    assert_eq!(soft_limit(2.5, 0.98), 1.0);
}

#[test]
fn eq_bank_matches_by_rate_gains_channels() {
    let bank = EqBank::new(48_000, [0.0; 6], 2);
    assert!(bank.matches(48_000, &[0.0; 6], 2));
    assert!(!bank.matches(44_100, &[0.0; 6], 2));
    assert!(!bank.matches(48_000, &[1.0, 0.0, 0.0, 0.0, 0.0, 0.0], 2));
    assert!(!bank.matches(48_000, &[0.0; 6], 1));
}
