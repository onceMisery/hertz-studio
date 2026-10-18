// SPDX-License-Identifier: MIT
#![cfg(feature = "playback")]
use vmusic_audio::resample::{Converter, Error, Format, State};

fn render(converter: &mut Converter, input: &[f32], chunk: usize, room: usize) -> Vec<f32> {
    let channels = converter.format().channels;
    let mut output = vec![0.0; room * channels];
    let mut result = Vec::new();
    for block in input.chunks(chunk * channels) {
        let mut at = 0;
        loop {
            let p = converter.process(&block[at..], &mut output).unwrap();
            at += p.consumed_frames * channels;
            result.extend_from_slice(&output[..p.produced_frames * channels]);
            if at == block.len() && p.state != State::NeedOutput {
                break;
            }
            assert!(
                p.produced_frames > 0 || p.consumed_frames > 0,
                "stream stalled"
            );
        }
    }
    // Even a one-frame caller output must reach a finite terminal state.
    let mut ended = false;
    for _ in 0..input.len() * 64 + 2048 {
        let p = converter.finish(&mut output).unwrap();
        assert_eq!(p.consumed_frames, 0);
        result.extend_from_slice(&output[..p.produced_frames * channels]);
        if p.state == State::Finished {
            ended = true;
            break;
        }
    }
    assert!(ended, "tail stalled");
    assert_eq!(converter.finish(&mut output).unwrap().produced_frames, 0);
    assert_eq!(
        converter.finish(&mut output).unwrap().state,
        State::Finished
    );
    result
}
fn converter(src: u32, dst: u32, channels: usize) -> Converter {
    Converter::new(Format {
        input_rate: src,
        output_rate: dst,
        channels,
    })
    .unwrap()
}
fn tone(rate: u32, frequency: f64, frames: usize, channels: usize) -> Vec<f32> {
    (0..frames)
        .flat_map(|i| {
            (0..channels).map(move |ch| {
                ((i as f64 * frequency * std::f64::consts::TAU / f64::from(rate)).sin()
                    * (1.0 - ch as f64 * 0.25)) as f32
            })
        })
        .collect()
}
fn amplitude(data: &[f32], rate: u32, frequency: f64) -> f64 {
    let start = rate as usize / 4;
    let n = rate as usize / 2;
    let (sin, cos) =
        data[start..start + n]
            .iter()
            .enumerate()
            .fold((0.0, 0.0), |(s, c), (i, &v)| {
                let phase =
                    std::f64::consts::TAU * frequency * (i + start) as f64 / f64::from(rate);
                (
                    s + f64::from(v) * phase.sin(),
                    c + f64::from(v) * phase.cos(),
                )
            });
    2.0 * sin.hypot(cos) / n as f64
}

#[test]
fn arbitrary_packet_and_output_boundaries_preserve_the_same_samples() {
    for src in [44100, 48000, 96000] {
        for dst in [44100, 48000, 96000] {
            for channels in [1, 2] {
                let mut r = converter(src, dst, channels);
                let input = tone(src, 997.0, 4001, channels);
                let reference = render(&mut r, &input, 4001, 4096);
                assert_eq!(
                    reference.len() / channels,
                    (4001u64 * u64::from(dst)).div_ceil(u64::from(src)) as usize
                );
                for (chunk, room) in [(1, 1), (7, 13), (511, 127), (513, 3)] {
                    r.reset();
                    assert_eq!(
                        render(&mut r, &input, chunk, room),
                        reference,
                        "{src}->{dst}, {channels}ch, {chunk}/{room}"
                    );
                }
            }
        }
    }
}

#[test]
fn empty_short_and_non_integral_eof_have_exact_finite_lengths() {
    for (src, dst) in [
        (44100, 48000),
        (96000, 44100),
        (48000, 48000),
        (8000, 512000),
        (512000, 8000),
    ] {
        let mut r = converter(src, dst, 1);
        for n in [0, 1, 2, 127, 255, 256, 511, 512, 513, 1025] {
            r.reset();
            let out = render(&mut r, &vec![0.2; n], 17, 31);
            assert_eq!(
                out.len(),
                (n as u64 * u64::from(dst)).div_ceil(u64::from(src)) as usize,
                "{src}->{dst}, N={n}"
            );
            assert!(out.iter().all(|v| v.is_finite()));
        }
    }
}

#[test]
fn passthrough_is_exact_and_format_errors_do_not_consume_valid_input() {
    let mut r = converter(48000, 48000, 2);
    let input = [-0.0, f32::MIN_POSITIVE, 0.25, -0.75, f32::from_bits(1), 0.0];
    let output = render(&mut r, &input, 1, 1);
    assert_eq!(
        output.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
        input.iter().map(|x| x.to_bits()).collect::<Vec<_>>()
    );
    assert_eq!(r.latency().library_output_delay.count, 0);
    assert_eq!(r.tail_padding_bound().count, 0);
    r.reset();
    let mut out = [0.0; 4];
    assert!(matches!(r.process(&[0.0], &mut out), Err(Error::Alignment)));
    assert!(matches!(
        r.process(&[f32::NAN, 0.0], &mut out),
        Err(Error::NonFinite)
    ));
    assert_eq!(r.process(&input, &mut []).unwrap().consumed_frames, 0);
    assert_eq!(render(&mut r, &input, 3, 3), output);
    assert!(matches!(r.process(&input, &mut out), Err(Error::Finishing)));
    for format in [
        Format {
            input_rate: 0,
            output_rate: 48000,
            channels: 1,
        },
        Format {
            input_rate: 48000,
            output_rate: 0,
            channels: 1,
        },
        Format {
            input_rate: 48000,
            output_rate: 48000,
            channels: 0,
        },
        Format {
            input_rate: 48000,
            output_rate: 48000,
            channels: 33,
        },
        Format {
            input_rate: 8000,
            output_rate: 768000,
            channels: 1,
        },
    ] {
        assert!(matches!(Converter::new(format), Err(Error::Format)));
    }
}

#[test]
fn reset_discards_partial_input_pending_output_and_finished_history() {
    for before in [3, 512, 1500] {
        let mut r = converter(44100, 96000, 2);
        let mut small = [0.0; 2];
        let _ = r.process(&vec![0.9; before * 2], &mut small).unwrap();
        r.reset();
        let silence = render(&mut r, &[0.0; 2048], 7, 3);
        assert!(silence.iter().all(|v| *v == 0.0));
        r.reset();
        let input = tone(44100, 2000.0, 1703, 2);
        let after = render(&mut r, &input, 13, 7);
        assert_eq!(
            after,
            render(&mut converter(44100, 96000, 2), &input, 1703, 4096)
        );
        assert_eq!(r.latency().input_block.rate, 44100);
        assert_eq!(r.latency().library_output_delay.rate, 96000);
        assert_eq!(r.tail_padding_bound().rate, 44100);
    }
}

#[test]
fn centered_sinc_preserves_impulse_time_within_one_output_frame() {
    for (src, dst) in [
        (44100, 48000),
        (48000, 44100),
        (96000, 48000),
        (44100, 96000),
    ] {
        let mut input = vec![0.0; 4096];
        input[1024] = 1.0;
        let output = render(&mut converter(src, dst, 1), &input, 67, 23);
        let peak = output
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
            .unwrap()
            .0 as f64;
        assert!(
            (peak - 1024.0 * f64::from(dst) / f64::from(src)).abs() <= 1.0,
            "{src}->{dst}: peak {peak}"
        );
        assert!(output.iter().all(|v| v.is_finite()));
    }
}

#[test]
fn passband_and_downsampling_alias_rejection_are_measured_after_transients() {
    for (src, dst) in [
        (44100, 48000),
        (48000, 44100),
        (96000, 48000),
        (96000, 44100),
        (44100, 96000),
    ] {
        for frequency in [1000.0, 18000.0] {
            let input = tone(src, frequency, src as usize, 1);
            let out = render(&mut converter(src, dst, 1), &input, 877, 311);
            let db = 20.0 * amplitude(&out, dst, frequency).log10();
            assert!(
                db.abs() < 0.05,
                "passband {src}->{dst} {frequency}Hz: {db}dB"
            );
        }
    }
    for dst in [44100, 48000] {
        for frequency in [27000.0, 30000.0, 40000.0] {
            let input = tone(96000, frequency, 96000, 1);
            let out = render(&mut converter(96000, dst, 1), &input, 1021, 127);
            let alias = (frequency - (frequency / f64::from(dst)).round() * f64::from(dst)).abs();
            let db = 20.0 * amplitude(&out, dst, alias).max(1e-15).log10();
            assert!(db < -80.0, "alias 96000->{dst} {frequency}Hz: {db}dB");
        }
    }
}
