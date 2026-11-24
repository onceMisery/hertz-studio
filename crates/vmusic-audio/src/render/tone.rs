// SPDX-License-Identifier: MIT
//! Local tone stages, fixed buffers and coefficients prepared before output.
use vmusic_core::audio_quality::ToneParams;
const FIR: usize = 33;
#[derive(Clone)]
struct Fir {
    taps: [f64; FIR],
    history: [f64; FIR * 2],
    cursor: usize,
}
impl Fir {
    fn lowpass() -> Self {
        let mut taps = std::array::from_fn(|i| {
            let x = i as f64 - 16.0;
            let cutoff = 0.1125;
            let sinc = if x == 0.0 {
                2.0 * cutoff
            } else {
                (std::f64::consts::TAU * cutoff * x).sin() / (std::f64::consts::PI * x)
            };
            sinc * (0.42 - 0.5 * (std::f64::consts::TAU * i as f64 / 32.0).cos()
                + 0.08 * (2.0 * std::f64::consts::TAU * i as f64 / 32.0).cos())
        });
        let sum: f64 = taps.iter().sum();
        for tap in &mut taps {
            *tap /= sum;
        }
        Self {
            taps,
            history: [0.0; FIR * 2],
            cursor: 0,
        }
    }
    fn push(&mut self, x: f64, first_tap: usize, stride: usize) -> f64 {
        self.history[self.cursor] = x;
        self.history[self.cursor + FIR] = x;
        let mut y = 0.0;
        for i in (first_tap..FIR).step_by(stride) {
            y += self.taps[i] * self.history[self.cursor + FIR - i];
        }
        self.cursor = (self.cursor + 1) % FIR;
        y
    }
    fn reset(&mut self) {
        self.history.fill(0.0);
        self.cursor = 0;
    }
}

pub(super) struct Tone {
    params: ToneParams,
    channels: usize,
    low: [f64; 2],
    low_alpha: f64,
    bass: [f64; 2],
    treble_low: [f64; 2],
    bass_alpha: f64,
    treble_alpha: f64,
    compensation: f64,
    crossfeed_amount: f64,
    gain_smooth: f64,
    drive: f64,
    mix: f64,
    smooth: f64,
    up: [Fir; 2],
    down: [Fir; 2],
    dry: [[f64; 9]; 2],
    dry_cursor: usize,
}
impl Tone {
    pub fn new(rate: u32, channels: usize) -> Self {
        Self {
            params: ToneParams::default(),
            channels,
            low: [0.0; 2],
            low_alpha: 1.0 - (-std::f64::consts::TAU * 700.0 / rate as f64).exp(),
            bass: [0.0; 2],
            treble_low: [0.0; 2],
            bass_alpha: 1.0 - (-std::f64::consts::TAU * 180.0 / rate as f64).exp(),
            treble_alpha: 1.0 - (-std::f64::consts::TAU * 6000.0 / rate as f64).exp(),
            compensation: 0.0,
            crossfeed_amount: 0.0,
            drive: 0.15,
            mix: 0.1,
            gain_smooth: 1.0 - (-1.0 / (rate as f64 * 0.01)).exp(),
            smooth: 1.0 - (-1.0 / (rate as f64 * 0.05)).exp(),
            up: std::array::from_fn(|_| Fir::lowpass()),
            down: std::array::from_fn(|_| Fir::lowpass()),
            dry: [[0.0; 9]; 2],
            dry_cursor: 0,
        }
    }
    pub fn configure(&mut self, params: ToneParams) {
        if !self.params.saturation && params.saturation {
            self.drive = params.drive as f64;
            self.mix = params.mix as f64;
        }
        self.params = params;
    }
    pub fn reset(&mut self) {
        self.low = [0.0; 2];
        self.bass = [0.0; 2];
        self.treble_low = [0.0; 2];
        self.compensation = 0.0;
        self.crossfeed_amount = 0.0;
        for f in self.up.iter_mut().chain(self.down.iter_mut()) {
            f.reset();
        }
        self.dry = [[0.0; 9]; 2];
        self.dry_cursor = 0;
    }
    pub fn active(&self) -> bool {
        self.params != ToneParams::default()
            || self.crossfeed_amount.abs() > 1e-7
            || self.compensation.abs() > 1e-7
    }
    pub fn latency(&self) -> usize {
        if self.params.saturation {
            8
        } else {
            0
        }
    }
    pub fn process(&mut self, frame: &mut [f32], volume: f32) {
        if self.channels > 2 {
            return;
        }
        self.drive += self.gain_smooth * (self.params.drive as f64 - self.drive);
        self.mix += self.gain_smooth * (self.params.mix as f64 - self.mix);
        let mut input = [0.0f64; 2];
        for ch in 0..self.channels {
            input[ch] = frame[ch] as f64;
            self.low[ch] += self.low_alpha * (input[ch] - self.low[ch]);
        }
        self.crossfeed_amount += self.gain_smooth
            * ((if self.params.crossfeed {
                self.params.crossfeed_amount as f64
            } else {
                0.0
            }) - self.crossfeed_amount);
        if self.channels == 2 {
            let amount = self.crossfeed_amount;
            for ch in 0..2 {
                input[ch] += amount * (self.low[1 - ch] - self.low[ch]);
            }
        }
        let target = if self.params.loudness_compensation {
            (1.0 - volume.clamp(0.0, 1.0) as f64).powi(2)
        } else {
            0.0
        };
        self.compensation += self.smooth * (target - self.compensation);
        let bass_gain = 10.0f64.powf(6.0 * self.compensation / 20.0) - 1.0;
        let treble_gain = 10.0f64.powf(3.0 * self.compensation / 20.0) - 1.0;
        // Reserve the maximum bass+treble contribution continuously with the boost.
        let headroom = 1.0 / (1.0 + bass_gain + treble_gain);
        for ch in 0..self.channels {
            self.bass[ch] += self.bass_alpha * (input[ch] - self.bass[ch]);
            self.treble_low[ch] += self.treble_alpha * (input[ch] - self.treble_low[ch]);
            let mut sample = (input[ch]
                + bass_gain * self.bass[ch]
                + treble_gain * (input[ch] - self.treble_low[ch]))
                * headroom;
            if self.params.saturation {
                self.dry[ch][self.dry_cursor] = sample;
                let dry = self.dry[ch][(self.dry_cursor + 1) % 9];
                let drive = 1.0 + 4.0 * self.drive;
                let mut wet = 0.0;
                for phase in 0..4 {
                    // Zero insertion leaves only taps congruent to this phase.
                    // Keep the same FIR and sample history, skip exact-zero products.
                    let up =
                        self.up[ch].push(if phase == 0 { sample * 4.0 } else { 0.0 }, phase, 4);
                    let shaped = (up * drive).tanh() / drive;
                    // The other three decimator outputs are discarded. Their
                    // history still advances, but need no dot product.
                    let down = self.down[ch].push(shaped, if phase == 0 { 0 } else { FIR }, 1);
                    if phase == 0 {
                        wet = down;
                    }
                }
                sample = dry * (1.0 - self.mix) + wet * self.mix;
            }
            frame[ch] = sample as f32;
        }
        if self.params.saturation {
            self.dry_cursor = (self.dry_cursor + 1) % 9;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn polyphase_and_decimation_match_full_convolution() {
        let mut up = Fir::lowpass();
        let mut up_reference = Fir::lowpass();
        let mut down = Fir::lowpass();
        let mut down_reference = Fir::lowpass();
        for frame in 0..1200 {
            if frame == 700 {
                up.reset();
                up_reference.reset();
                down.reset();
                down_reference.reset();
            }
            for phase in 0..4 {
                let x = if phase == 0 {
                    (frame as f64 * 0.73).sin() * 4.0
                } else {
                    0.0
                };
                let a = up.push(x, phase, 4);
                let b = up_reference.push(x, 0, 1);
                assert!((a - b).abs() < 1e-14);
                let shaped = (a * 5.0).tanh() / 5.0;
                let actual = down.push(shaped, if phase == 0 { 0 } else { FIR }, 1);
                let expected = down_reference.push(shaped, 0, 1);
                if phase == 0 {
                    assert_eq!(actual, expected);
                }
            }
        }
    }
    #[test]
    fn crossfeed_symmetric_and_neutral_mono() {
        let mut a = Tone::new(48000, 2);
        let mut b = Tone::new(48000, 2);
        let p = ToneParams {
            crossfeed: true,
            ..Default::default()
        };
        a.configure(p);
        b.configure(p);
        for n in 0..4000 {
            let x = (n as f32 * 0.13).sin() * 0.1;
            let mut left = [x, 0.0];
            let mut right = [0.0, x];
            a.process(&mut left, 1.0);
            b.process(&mut right, 1.0);
            assert_eq!(left[0], right[1]);
            assert_eq!(left[1], right[0]);
        }
    }
    #[test]
    fn saturation_dry_has_exact_declared_delay_and_reset() {
        let mut tone = Tone::new(48000, 1);
        tone.configure(ToneParams {
            saturation: true,
            mix: 0.0,
            ..Default::default()
        });
        for i in 0..24 {
            let mut x = [if i == 0 { 0.5 } else { 0.0 }];
            tone.process(&mut x, 1.0);
            assert_eq!(x[0], if i == 8 { 0.5 } else { 0.0 });
        }
        tone.reset();
        let mut x = [0.0];
        tone.process(&mut x, 1.0);
        assert_eq!(x, [0.0]);
    }
    #[test]
    fn oversampled_saturation_reduces_folded_third_harmonic() {
        let mut tone = Tone::new(48000, 1);
        tone.configure(ToneParams {
            saturation: true,
            drive: 1.0,
            mix: 1.0,
            ..Default::default()
        });
        let mut actual = (0.0f64, 0.0f64);
        let mut naive = (0.0f64, 0.0f64);
        for i in 0..6000 {
            let input = (std::f64::consts::TAU * 17000.0 * i as f64 / 48000.0).sin() * 0.8;
            let mut frame = [input as f32];
            tone.process(&mut frame, 1.0);
            if i >= 1200 {
                let phase = std::f64::consts::TAU * 3000.0 * i as f64 / 48000.0;
                let (s, c) = phase.sin_cos();
                actual.0 += frame[0] as f64 * c;
                actual.1 += frame[0] as f64 * s;
                let y = (input * 5.0).tanh() / 5.0;
                naive.0 += y * c;
                naive.1 += y * s;
            }
        }
        let ratio = actual.0.hypot(actual.1) / naive.0.hypot(naive.1);
        assert!(ratio < 0.1, "folded harmonic ratio {ratio}");
    }
}
