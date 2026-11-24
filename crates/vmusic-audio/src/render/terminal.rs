// SPDX-License-Identifier: MIT
//! Finite terminal delay with media positions and transition markers attached to real frames.
use super::tone::Tone;
use crate::true_peak::Limiter;
use std::collections::VecDeque;
use vmusic_core::audio_quality::{LimiterMode, ToneParams};

#[derive(Clone, Copy)]
pub(super) struct FrameTag {
    pub position: u64,
    pub transition: bool,
    pub audible: bool,
    pub volume: f32,
    pub fade: f32,
}
pub(super) struct Terminal {
    pub mode: LimiterMode,
    limiter: Option<Limiter>,
    tone: Tone,
    impulse: super::impulse::Impulse,
    tone_params: ToneParams,
    tone_tags: VecDeque<FrameTag>,
    tone_frames: u64,
    tags: VecDeque<FrameTag>,
    pub position: u64,
    pub transition_pending: bool,
    pub audible_pending: u64,
    origin_set: bool,
    channels: usize,
    rate: u32,
}
impl Terminal {
    pub fn new(rate: u32, channels: usize, local: bool) -> Self {
        let limiter = (local && channels <= 2 && matches!(rate, 44_100 | 48_000 | 96_000))
            .then(|| Limiter::new(rate, channels));
        let capacity = limiter.as_ref().map_or(0, |l| l.latency_frames() + 1);
        Self {
            mode: LimiterMode::Soft,
            limiter,
            tone: Tone::new(rate, channels),
            tone_params: ToneParams::default(),
            impulse: super::impulse::Impulse::new(),
            tone_tags: VecDeque::with_capacity(if local { 137 } else { 0 }),
            tone_frames: 0,
            tags: VecDeque::with_capacity(capacity),
            position: 0,
            transition_pending: false,
            audible_pending: 0,
            origin_set: false,
            channels,
            rate,
        }
    }
    pub fn reset(&mut self) {
        if let Some(limiter) = &mut self.limiter {
            limiter.reset();
        }
        self.tone.reset();
        self.impulse.reset();
        self.tone_tags.clear();
        self.tone_frames = 0;
        self.tags.clear();
        self.transition_pending = false;
        self.audible_pending = 0;
        self.position = 0;
        self.origin_set = false;
    }
    pub fn set_origin(&mut self, position: u64) {
        if !self.origin_set {
            self.position = position;
            self.origin_set = true;
        }
    }
    pub fn configure(&mut self, mode: LimiterMode, tone: ToneParams) {
        if mode != self.mode || tone.saturation != self.tone_params.saturation {
            self.reset();
        }
        self.mode = mode;
        self.tone_params = tone;
        self.tone.configure(tone);
    }
    pub fn configure_impulse(
        &mut self,
        kernel: Option<super::impulse::PreparedImpulse>,
        initial: bool,
    ) {
        if initial {
            self.impulse.install(kernel);
        } else {
            self.impulse.configure(kernel, self.rate);
        }
    }
    pub fn impulse_id(&self) -> Option<[u8; 32]> {
        self.impulse.id()
    }
    pub fn requires_reset(&self, mode: LimiterMode, tone: ToneParams) -> bool {
        mode != self.mode || tone.saturation != self.tone_params.saturation
    }
    pub fn impulse_delay(&self) -> usize {
        self.impulse.delay()
    }
    pub fn active(&self) -> bool {
        self.mode != LimiterMode::Soft || self.tone.active() || self.impulse.id().is_some()
    }
    pub fn latency(&self) -> u64 {
        (self.tone.latency() + self.impulse.delay()) as u64
            + if self.mode == LimiterMode::Soft {
                0
            } else {
                self.limiter
                    .as_ref()
                    .map_or(0, |l| l.latency_frames() as u64)
            }
    }
    pub fn queued(&self) -> u64 {
        (self.tone_tags.len() + self.tags.len()) as u64
    }
    pub fn peak(&self) -> Option<f32> {
        if self.mode == LimiterMode::Soft {
            None
        } else {
            self.limiter.as_ref().map(|l| l.output_peak)
        }
    }
    pub fn finish_meter(&mut self) {
        if let Some(limiter) = &mut self.limiter {
            for _ in 0..128 {
                limiter.finish_meter_frame();
            }
        }
    }
    pub fn reduction(&self) -> f32 {
        if self.mode == LimiterMode::Soft {
            0.0
        } else {
            self.limiter.as_ref().map_or(0.0, |l| l.reduction_db)
        }
    }
    fn presented(&mut self, tag: FrameTag) {
        self.position = tag.position;
        if tag.transition {
            self.transition_pending = false;
        }
        if tag.audible {
            self.audible_pending -= 1;
        }
    }
    fn final_stage(&mut self, input: &[f32], out: &mut [f32], tag: FrameTag) -> Option<FrameTag> {
        let mut scaled = [0.0; 32];
        for ch in 0..self.channels {
            scaled[ch] = input[ch] * tag.volume * tag.fade;
        }
        if self.mode == LimiterMode::Soft {
            for ch in 0..self.channels {
                out[ch] = super::dsp::soft_limit(scaled[ch], 0.98);
            }
            self.presented(tag);
            return Some(tag);
        }
        self.tags.push_back(tag);
        if self
            .limiter
            .as_mut()
            .expect("validated local limiter")
            .push(&scaled[..self.channels], out)
        {
            let tag = self.tags.pop_front().expect("real output metadata");
            self.presented(tag);
            Some(tag)
        } else {
            None
        }
    }
    fn tone_step(&mut self, input: &[f32], out: &mut [f32], volume: f32) -> Option<FrameTag> {
        let mut processed = [0.0; 32];
        processed[..self.channels].copy_from_slice(input);
        self.impulse.process(&mut processed[..self.channels]);
        self.tone.process(&mut processed[..self.channels], volume);
        let ready = self.tone_frames >= (self.tone.latency() + self.impulse.delay()) as u64;
        self.tone_frames += 1;
        if ready {
            if let Some(tag) = self.tone_tags.pop_front() {
                return self.final_stage(&processed[..self.channels], out, tag);
            }
        }
        out.fill(0.0);
        None
    }
    pub fn push(&mut self, input: &[f32], out: &mut [f32], tag: FrameTag) -> Option<FrameTag> {
        if tag.transition {
            self.transition_pending = true;
        }
        if tag.audible {
            self.audible_pending += 1;
        }
        self.tone_tags.push_back(tag);
        self.tone_step(input, out, tag.volume)
    }
    pub fn finish_frame(&mut self, out: &mut [f32]) -> Option<FrameTag> {
        if !self.tone_tags.is_empty() {
            let volume = self.tone_tags.front().map_or(1.0, |t| t.volume);
            return self.tone_step(&[0.0; 32][..self.channels], out, volume);
        }
        if self.mode == LimiterMode::Soft {
            out.fill(0.0);
            return None;
        }
        if self.tags.is_empty() {
            if let Some(limiter) = &mut self.limiter {
                limiter.finish_meter_frame();
            }
            out.fill(0.0);
            return None;
        }
        if self
            .limiter
            .as_mut()
            .expect("validated local limiter")
            .finish_frame(out)
        {
            let tag = self.tags.pop_front().expect("finite tail metadata");
            self.presented(tag);
            Some(tag)
        } else {
            None
        }
    }
}
