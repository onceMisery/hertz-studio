// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Terminal-only PCM quantization. No allocation, feedback, or shared RNG.

const MAX_CHANNELS: usize = 32;

pub(super) struct Quantizer {
    state: [u64; MAX_CHANNELS],
    seed: u64,
    channels: usize,
    valid_bits: u16,
    dither: bool,
}

impl Quantizer {
    pub(super) fn new(channels: u16, valid_bits: u16, dither: bool, seed: u64) -> Self {
        assert!((1..=MAX_CHANNELS as u16).contains(&channels));
        assert!(valid_bits == 16 || valid_bits == 24);
        let mut result = Self {
            state: [0; MAX_CHANNELS],
            seed,
            channels: usize::from(channels),
            valid_bits,
            dither,
        };
        result.reset(0);
        result
    }

    /// Pause, seek, stop, and load advance the adapter's reset epoch; a format
    /// change creates a fresh quantizer. Gapless transitions preserve history.
    pub(super) fn reset(&mut self, epoch: u64) {
        for (channel, state) in self.state[..self.channels].iter_mut().enumerate() {
            *state = mix(self.seed
                ^ epoch.wrapping_mul(0xd134_2543_de82_ef95)
                ^ (channel as u64 + 1).wrapping_mul(0x9e37_79b9_7f4a_7c15));
            if *state == 0 {
                *state = channel as u64 + 1;
            }
        }
    }

    fn uniform(&mut self, channel: usize) -> f64 {
        let mut state = self.state[channel];
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        self.state[channel] = state;
        let value = state.wrapping_mul(0x2545_f491_4f6c_dd1d);
        (value >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    fn sample(&mut self, sample: f32, channel: usize) -> i32 {
        let scale = (1u32 << (self.valid_bits - 1)) as f64;
        let clean = if sample.is_finite() {
            f64::from(sample)
        } else {
            0.0
        };
        let noise = if self.dither {
            self.uniform(channel) - self.uniform(channel)
        } else {
            0.0
        };
        (clean
            .mul_add(scale, noise)
            .round()
            .clamp(-scale, scale - 1.0)) as i32
    }

    /// `live_samples` excludes renderer hard-mute and underrun tails. TPDF must
    /// never turn a sleep/pause/stop mute back into nonzero device samples.
    #[cfg(test)]
    pub(super) fn write(
        &mut self,
        input: &[f32],
        bytes: &mut [u8],
        container_bits: u16,
        live_samples: usize,
    ) {
        self.write_range(input, bytes, container_bits, 0, live_samples);
    }

    pub(super) fn write_range(
        &mut self,
        input: &[f32],
        bytes: &mut [u8],
        container_bits: u16,
        start: usize,
        live_samples: usize,
    ) {
        assert!(
            container_bits == self.valid_bits || (self.valid_bits == 24 && container_bits == 32)
        );
        let width = usize::from(container_bits / 8);
        assert_eq!(bytes.len(), input.len() * width);
        let live_samples = live_samples.min(input.len());
        for (index, (sample, destination)) in
            input.iter().zip(bytes.chunks_exact_mut(width)).enumerate()
        {
            let value = if index >= start && index < live_samples {
                self.sample(*sample, index % self.channels)
            } else {
                0
            };
            // WAVEFORMATEXTENSIBLE PCM valid bits occupy the most significant
            // bits of the container; 24-in-32 has eight zero low bits.
            let packed = (value << (container_bits - self.valid_bits)).to_le_bytes();
            destination.copy_from_slice(&packed[..width]);
        }
    }
}

fn mix(mut value: u64) -> u64 {
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_full_scale_rounding_and_valid_bit_alignment() {
        for (bits, width) in [(16, 16), (24, 24), (24, 32)] {
            let mut q = Quantizer::new(1, bits, false, 1);
            let half_lsb = (0.5 / (1u32 << (bits - 1)) as f64) as f32;
            let input = [-2.0, -1.0, -half_lsb, 0.0, half_lsb, 1.0, 2.0];
            let mut bytes = vec![0; input.len() * (width / 8) as usize];
            q.write(&input, &mut bytes, width, input.len());
            let expected = [
                -(1i32 << (bits - 1)),
                -(1i32 << (bits - 1)),
                -1,
                0,
                1,
                (1i32 << (bits - 1)) - 1,
                (1i32 << (bits - 1)) - 1,
            ];
            for (bytes, expected) in bytes.chunks_exact((width / 8) as usize).zip(expected) {
                let packed = (expected << (width - bits)).to_le_bytes();
                assert_eq!(bytes, &packed[..bytes.len()]);
            }
        }
    }

    #[test]
    fn hard_silence_and_padding_never_receive_dither() {
        let mut q = Quantizer::new(2, 16, true, 5);
        let mut bytes = [255; 400];
        q.write(&[0.0; 200], &mut bytes, 16, 0);
        assert!(bytes.iter().all(|value| *value == 0));
        q.write(&[0.25; 200], &mut bytes, 16, 2);
        assert!(bytes[4..].iter().all(|value| *value == 0));
    }

    #[test]
    fn independent_tpdf_has_expected_noise_and_low_channel_correlation() {
        let mut q = Quantizer::new(2, 16, true, 47);
        let mut sums = [0.0; 2];
        let mut squares = [0.0; 2];
        let mut cross = 0.0;
        let count = 200_000;
        for _ in 0..count {
            let pair = [f64::from(q.sample(0.0, 0)), f64::from(q.sample(0.0, 1))];
            for channel in 0..2 {
                sums[channel] += pair[channel];
                squares[channel] += pair[channel] * pair[channel];
            }
            cross += pair[0] * pair[1];
        }
        for channel in 0..2 {
            assert!((sums[channel] / f64::from(count)).abs() < 0.005);
            // Rounded triangular noise at zero has P(±1)=1/8: variance 1/4 LSB².
            assert!((squares[channel] / f64::from(count) - 0.25).abs() < 0.01);
        }
        assert!((cross / (squares[0] * squares[1]).sqrt()).abs() < 0.01);
    }

    #[test]
    fn reset_is_deterministic_and_channel_histories_are_independent() {
        let mut q = Quantizer::new(2, 24, true, 2);
        let first: Vec<_> = (0..64).map(|_| q.sample(0.0, 0)).collect();
        q.reset(0);
        assert_eq!(first, (0..64).map(|_| q.sample(0.0, 0)).collect::<Vec<_>>());
        q.reset(0);
        let second: Vec<_> = (0..64)
            .map(|_| {
                q.sample(0.0, 1);
                q.sample(0.0, 0)
            })
            .collect();
        assert_eq!(first, second);
        q.reset(1);
        assert_ne!(first, (0..64).map(|_| q.sample(0.0, 0)).collect::<Vec<_>>());
    }

    #[test]
    fn block_partition_does_not_change_quantized_pcm() {
        let input: Vec<_> = (0..4000).map(|i| (i as f32 * 0.013).sin() * 0.7).collect();
        let mut one = Quantizer::new(2, 24, true, 13);
        let mut split = Quantizer::new(2, 24, true, 13);
        let mut a = vec![0; input.len() * 4];
        let mut b = vec![0; input.len() * 4];
        one.write(&input, &mut a, 32, input.len());
        for (samples, bytes) in input.chunks(22).zip(b.chunks_mut(88)) {
            split.write(samples, bytes, 32, samples.len());
        }
        assert_eq!(a, b);
    }
}
