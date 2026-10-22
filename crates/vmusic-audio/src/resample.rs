// SPDX-License-Identifier: MIT
//! Fixed-rate, bounded streaming conversion on the decoder thread.
//!
//! Buffers and sinc tables are prepared by `new`. Processing and reset do not
//! allocate. Counts are frames per channel; interleaved slices must be aligned.
//! `finish` zero-extends the finite source and returns exactly
//! ceil(input_frames * output_rate/input_rate)
//! frames. Filter ringing outside that media interval is deliberately trimmed.
use rubato::{
    Resampler as _, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

pub const INPUT_BLOCK: usize = 512;
pub const ALGORITHM: &str = "rubato-0.16.2-sinc256-linear256-blackmanharris2-cutoff095-v1";
const SINC_LEN: usize = 256;
const MAX_FLUSH_BLOCKS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    pub input_rate: u32,
    pub output_rate: u32,
    pub channels: usize,
}

/// A frame count is meaningful only together with its sampling-rate domain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frames {
    pub count: u64,
    pub rate: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Latency {
    pub input_block: Frames,
    pub filter_lookahead: Frames,
    /// Rubato SincFixedIn reports buffering latency here. Its centered filter
    /// already starts on the source timeline; this is NOT leading zero padding
    /// to remove from PCM. See the impulse-time regression before changing it.
    pub library_output_delay: Frames,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    NeedInput,
    NeedOutput,
    Draining,
    Finished,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub consumed_frames: usize,
    pub produced_frames: usize,
    pub state: State,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported resampling format")]
    Format,
    #[error("resampling buffers must contain complete interleaved frames")]
    Alignment,
    #[error("non-finite PCM")]
    NonFinite,
    #[error("resampler is finishing; reset before accepting another stream")]
    Finishing,
    #[error("resampling frame counter overflow")]
    Overflow,
    #[error("resampling engine failed: {0}")]
    Engine(String),
    #[error("resampling tail did not drain within its finite bound")]
    Tail,
}

struct Sinc {
    engine: SincFixedIn<f32>,
    input: Vec<Vec<f32>>,
    output: Vec<Vec<f32>>,
    filled: usize,
    output_at: usize,
    output_end: usize,
    delay: usize,
    flush_blocks: usize,
}

pub struct Converter {
    format: Format,
    sinc: Option<Sinc>,
    accepted: u64,
    produced: u64,
    target: Option<u64>,
    finished: bool,
}

impl Converter {
    pub fn new(format: Format) -> Result<Self, Error> {
        let ratio = f64::from(format.output_rate) / f64::from(format.input_rate);
        if !(1..=768_000).contains(&format.input_rate)
            || !(1..=768_000).contains(&format.output_rate)
            || !(1..=32).contains(&format.channels)
            || !(1.0 / 64.0..=64.0).contains(&ratio)
        {
            return Err(Error::Format);
        }
        let sinc = if format.input_rate == format.output_rate {
            None
        } else {
            let engine = SincFixedIn::<f32>::new(
                ratio,
                1.0,
                SincInterpolationParameters {
                    sinc_len: SINC_LEN,
                    f_cutoff: 0.95,
                    interpolation: SincInterpolationType::Linear,
                    oversampling_factor: 256,
                    window: WindowFunction::BlackmanHarris2,
                },
                INPUT_BLOCK,
                format.channels,
            )
            .map_err(|e| Error::Engine(e.to_string()))?;
            let delay = engine.output_delay();
            Some(Sinc {
                input: engine.input_buffer_allocate(true),
                output: engine.output_buffer_allocate(true),
                engine,
                filled: 0,
                output_at: 0,
                output_end: 0,
                delay,
                flush_blocks: 0,
            })
        };
        Ok(Self {
            format,
            sinc,
            accepted: 0,
            produced: 0,
            target: None,
            finished: false,
        })
    }

    pub fn format(&self) -> Format {
        self.format
    }

    pub fn latency(&self) -> Latency {
        Latency {
            input_block: Frames {
                count: if self.sinc.is_some() {
                    INPUT_BLOCK as u64
                } else {
                    0
                },
                rate: self.format.input_rate,
            },
            filter_lookahead: Frames {
                count: if self.sinc.is_some() {
                    (SINC_LEN / 2) as u64
                } else {
                    0
                },
                rate: self.format.input_rate,
            },
            library_output_delay: Frames {
                count: self.sinc.as_ref().map_or(0, |s| s.delay as u64),
                rate: self.format.output_rate,
            },
        }
    }

    /// Upper bound on zero input used to drain, not additional audible duration.
    pub fn tail_padding_bound(&self) -> Frames {
        Frames {
            count: if self.sinc.is_some() {
                (MAX_FLUSH_BLOCKS * INPUT_BLOCK) as u64
            } else {
                0
            },
            rate: self.format.input_rate,
        }
    }

    pub fn reset(&mut self) {
        if let Some(s) = &mut self.sinc {
            s.engine.reset();
            for channel in &mut s.input {
                channel.fill(0.0);
            }
            for channel in &mut s.output {
                channel.fill(0.0);
            }
            s.filled = 0;
            s.output_at = 0;
            s.output_end = 0;
            s.flush_blocks = 0;
        }
        self.accepted = 0;
        self.produced = 0;
        self.target = None;
        self.finished = false;
    }

    fn aligned(&self, len: usize) -> Result<usize, Error> {
        if !len.is_multiple_of(self.format.channels) {
            return Err(Error::Alignment);
        }
        Ok(len / self.format.channels)
    }

    pub fn process(&mut self, input: &[f32], output: &mut [f32]) -> Result<Progress, Error> {
        let frames = self.aligned(input.len())?;
        let room = self.aligned(output.len())?;
        if self.target.is_some() {
            return Err(Error::Finishing);
        }
        if room == 0 {
            return Ok(Progress {
                consumed_frames: 0,
                produced_frames: 0,
                state: State::NeedOutput,
            });
        }
        if self.sinc.is_none() {
            let n = frames.min(room);
            let samples = n * self.format.channels;
            if input[..samples].iter().any(|v| !v.is_finite()) {
                return Err(Error::NonFinite);
            }
            let accepted = self.accepted.checked_add(n as u64).ok_or(Error::Overflow)?;
            output[..samples].copy_from_slice(&input[..samples]);
            self.accepted = accepted;
            self.produced = accepted;
            return Ok(Progress {
                consumed_frames: n,
                produced_frames: n,
                state: if n < frames {
                    State::NeedOutput
                } else {
                    State::NeedInput
                },
            });
        }
        let s = self.sinc.as_mut().unwrap();
        // Drain pending output first: accepting unlimited input behind a small
        // caller output buffer would turn this bounded stream into a queue.
        if s.output_at < s.output_end {
            return self.emit(output, 0);
        }
        let n = frames.min(INPUT_BLOCK - s.filled);
        if input[..n * self.format.channels]
            .iter()
            .any(|v| !v.is_finite())
        {
            return Err(Error::NonFinite);
        }
        let accepted = self.accepted.checked_add(n as u64).ok_or(Error::Overflow)?;
        for (frame, values) in input[..n * self.format.channels]
            .chunks_exact(self.format.channels)
            .enumerate()
        {
            for (channel, value) in values.iter().enumerate() {
                s.input[channel][s.filled + frame] = *value;
            }
        }
        self.accepted = accepted;
        s.filled += n;
        if s.filled == INPUT_BLOCK {
            Self::run_block(s)?;
        }
        self.emit(output, n)
    }

    fn run_block(s: &mut Sinc) -> Result<(), Error> {
        let (consumed, produced) = s
            .engine
            .process_into_buffer(&s.input, &mut s.output, None)
            .map_err(|e| Error::Engine(e.to_string()))?;
        if consumed != INPUT_BLOCK {
            return Err(Error::Engine("unexpected input consumption".into()));
        }
        if s.output
            .iter()
            .any(|channel| channel[..produced].iter().any(|v| !v.is_finite()))
        {
            return Err(Error::NonFinite);
        }
        s.filled = 0;
        s.output_at = 0;
        s.output_end = produced;
        Ok(())
    }

    fn emit(&mut self, output: &mut [f32], consumed: usize) -> Result<Progress, Error> {
        let s = self.sinc.as_mut().unwrap();
        let mut n = (output.len() / self.format.channels).min(s.output_end - s.output_at);
        if let Some(target) = self.target {
            n = (n as u64).min(target - self.produced) as usize;
        }
        let produced = self.produced.checked_add(n as u64).ok_or(Error::Overflow)?;
        for (frame, values) in output[..n * self.format.channels]
            .chunks_exact_mut(self.format.channels)
            .enumerate()
        {
            for (channel, value) in values.iter_mut().enumerate() {
                *value = s.output[channel][s.output_at + frame];
            }
        }
        s.output_at += n;
        self.produced = produced;
        let state = if self.target == Some(self.produced) {
            self.finished = true;
            State::Finished
        } else if s.output_at < s.output_end {
            State::NeedOutput
        } else if self.target.is_some() {
            State::Draining
        } else {
            State::NeedInput
        };
        Ok(Progress {
            consumed_frames: consumed,
            produced_frames: n,
            state,
        })
    }

    pub fn finish(&mut self, output: &mut [f32]) -> Result<Progress, Error> {
        let room = self.aligned(output.len())?;
        let target = match self.target {
            Some(target) => target,
            None => {
                let frames = (u128::from(self.accepted) * u128::from(self.format.output_rate))
                    .div_ceil(u128::from(self.format.input_rate));
                let frames = u64::try_from(frames).map_err(|_| Error::Overflow)?;
                if frames < self.produced {
                    return Err(Error::Tail);
                }
                self.target = Some(frames);
                frames
            }
        };
        if self.finished || target == self.produced {
            self.finished = true;
            return Ok(Progress {
                consumed_frames: 0,
                produced_frames: 0,
                state: State::Finished,
            });
        }
        if room == 0 {
            return Ok(Progress {
                consumed_frames: 0,
                produced_frames: 0,
                state: State::NeedOutput,
            });
        }
        let s = self.sinc.as_mut().ok_or(Error::Tail)?;
        if s.output_at == s.output_end {
            if s.flush_blocks == MAX_FLUSH_BLOCKS {
                return Err(Error::Tail);
            }
            for channel in &mut s.input {
                channel[s.filled..].fill(0.0);
            }
            s.flush_blocks += 1;
            Self::run_block(s)?;
        }
        self.emit(output, 0)
    }
}
