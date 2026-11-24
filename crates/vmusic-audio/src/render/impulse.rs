// SPDX-License-Identifier: MIT
use vmusic_core::{impulse::ImpulseKernel, AudioError};
type Convolution = unsafe fn(&[f32], &[f32]) -> f64;

fn scalar_dot(taps: &[f32], samples: &[f32]) -> f64 {
    taps.iter()
        .zip(samples)
        .map(|(a, b)| *a as f64 * *b as f64)
        .sum()
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn avx2_dot(taps: &[f32], samples: &[f32]) -> f64 {
    use std::arch::x86_64::*;
    let mut sum = _mm256_setzero_pd();
    let end = taps.len() / 4 * 4;
    // Caller supplies equal-length slices. Each load is wholly within them;
    // the final 0–3 taps use scalar double-precision accumulation.
    for i in (0..end).step_by(4) {
        sum = _mm256_add_pd(
            sum,
            _mm256_mul_pd(
                _mm256_cvtps_pd(_mm_loadu_ps(taps.as_ptr().add(i))),
                _mm256_cvtps_pd(_mm_loadu_ps(samples.as_ptr().add(i))),
            ),
        );
    }
    let half = _mm_add_pd(_mm256_castpd256_pd128(sum), _mm256_extractf128_pd(sum, 1));
    _mm_cvtsd_f64(_mm_add_sd(half, _mm_unpackhi_pd(half, half)))
        + scalar_dot(&taps[end..], &samples[end..])
}

#[derive(Clone, Copy)]
pub(super) struct PreparedImpulse {
    pub id: [u8; 32],
    pub rate: u32,
    pub taps: [[f32; 257]; 2],
    pub len: usize,
    pub delay: usize,
    pub gain: f32,
    pub preview_only: bool,
    convolve: Convolution,
}
impl PreparedImpulse {
    pub fn prepare(kernel: ImpulseKernel) -> Result<Self, AudioError> {
        kernel.validate()?;
        vmusic_core::audio_quality::validate_correction_rate(kernel.sample_rate)?;
        Self::copy(kernel, false)
    }
    pub fn prepare_preview(
        impulse: vmusic_core::audio_preview::PreviewImpulse,
    ) -> Result<Self, AudioError> {
        impulse.validate()?;
        Self::copy(
            impulse.kernel,
            impulse.phase == vmusic_core::audio_preview::ImpulsePhase::Unknown,
        )
    }
    fn copy(kernel: ImpulseKernel, preview_only: bool) -> Result<Self, AudioError> {
        let mut result = Self {
            id: vmusic_core::audio_quality::decode_id(&kernel.resource_id).unwrap(),
            rate: kernel.sample_rate,
            taps: [[0.0; 257]; 2],
            len: kernel.channels[0].len(),
            delay: kernel.delay_frames,
            gain: 10.0f32.powf(kernel.attenuation_db / 20.0),
            preview_only,
            convolve: {
                #[cfg(target_arch = "x86_64")]
                {
                    if std::is_x86_feature_detected!("avx2") {
                        avx2_dot
                    } else {
                        scalar_dot
                    }
                }
                #[cfg(not(target_arch = "x86_64"))]
                {
                    scalar_dot
                }
            },
        };
        for ch in 0..2 {
            let source = &kernel.channels[ch.min(kernel.channels.len() - 1)];
            result.taps[ch][..source.len()].copy_from_slice(source);
            result.taps[ch][..source.len()].reverse();
        }
        Ok(result)
    }
}
pub(super) struct Impulse {
    kernel: Option<PreparedImpulse>,
    next: Option<PreparedImpulse>,
    history: [[f32; 514]; 2],
    cursor: usize,
    fade: usize,
    fade_total: usize,
}
impl Impulse {
    pub fn new() -> Self {
        Self {
            kernel: None,
            next: None,
            history: [[0.0; 514]; 2],
            cursor: 0,
            fade: 0,
            fade_total: 0,
        }
    }
    pub fn configure(&mut self, kernel: Option<PreparedImpulse>, rate: u32) {
        if self.kernel.as_ref().map(|k| k.id) == kernel.as_ref().map(|k| k.id) {
            return;
        }
        if self.kernel.as_ref().map_or(0, |k| k.delay) == kernel.as_ref().map_or(0, |k| k.delay) {
            self.next = kernel;
            self.fade_total = (rate as usize / 50).max(2);
            self.fade = 0;
        } else {
            self.kernel = kernel;
            self.next = None;
            self.reset();
        }
    }
    pub fn install(&mut self, kernel: Option<PreparedImpulse>) {
        self.reset();
        self.kernel = kernel;
        self.next = None;
    }
    pub fn reset(&mut self) {
        self.history = [[0.0; 514]; 2];
        self.cursor = 0;
        if self.fade_total > 0 {
            self.kernel = self.next.take();
        }
        self.fade = 0;
        self.fade_total = 0;
    }
    pub fn delay(&self) -> usize {
        self.kernel.as_ref().map_or(0, |k| k.delay)
    }
    pub fn id(&self) -> Option<[u8; 32]> {
        if self.fade_total > 0 {
            self.next.as_ref().map(|k| k.id)
        } else {
            self.kernel.as_ref().map(|k| k.id)
        }
    }
    fn convolve(&self, kernel: Option<&PreparedImpulse>, ch: usize, input: f32) -> f32 {
        let Some(kernel) = kernel else {
            return input;
        };
        let end = self.cursor + 258;
        // Prepared taps are reversed so the oldest-to-newest window is contiguous.
        // ISA selection happens during preparation, never in the callback.
        let value = unsafe {
            (kernel.convolve)(
                &kernel.taps[ch][..kernel.len],
                &self.history[ch][end - kernel.len..end],
            )
        };
        (value * kernel.gain as f64) as f32
    }
    pub fn process(&mut self, frame: &mut [f32]) {
        for (ch, sample) in frame.iter_mut().enumerate() {
            if ch >= 2 {
                return;
            }
            self.history[ch][self.cursor] = *sample;
            self.history[ch][self.cursor + 257] = *sample;
            let old = self.convolve(self.kernel.as_ref(), ch, *sample);
            *sample = if self.fade_total > 0 {
                let w = self.fade as f64 / (self.fade_total - 1) as f64;
                let new = self.convolve(self.next.as_ref(), ch, *sample);
                ((1.0 - w) * old as f64 + w * new as f64) as f32
            } else {
                old
            };
        }
        self.cursor = (self.cursor + 1) % 257;
        if self.fade_total > 0 {
            self.fade += 1;
            if self.fade >= self.fade_total {
                self.kernel = self.next.take();
                self.fade_total = 0;
                self.fade = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_convolution_matches_causal_reference_across_wraps() {
        for len in [1, 3, 5, 127, 255, 257] {
            let mut taps: Vec<_> = (0..len)
                .map(|i| ((i.min(len - 1 - i) + 1) as f32 * 0.17).sin() / len as f32)
                .collect();
            // Validation permits this small asymmetry; preparation must retain
            // the original tap order instead of relying on perfect symmetry.
            taps[0] += 0.0000005;
            let kernel = ImpulseKernel {
                resource_id: "a".repeat(64),
                sample_rate: 48000,
                channels: vec![taps.clone()],
                delay_frames: (len - 1) / 2,
                attenuation_db: 0.0,
            };
            let mut impulse = Impulse::new();
            impulse.install(Some(PreparedImpulse::prepare(kernel).unwrap()));
            let mut history = Vec::new();
            for n in 0..1100 {
                let input = (n as f32 * 0.71).sin();
                history.push(input);
                let mut frame = [input, input];
                impulse.process(&mut frame);
                let expected: f64 = taps
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| *i <= n)
                    .map(|(i, t)| *t as f64 * history[n - i] as f64)
                    .sum();
                assert!((frame[0] as f64 - expected).abs() < 1e-6, "{len} {n}");
                assert_eq!(frame[0], frame[1]);
            }
        }
    }
}
