// SPDX-License-Identifier: MIT
//! Bounded offline comparison through the same resampler, EQ and terminal processors.
use super::{
    dsp::{DspControl, DspRuntime, PreparedEq},
    impulse::PreparedImpulse,
    preview,
    terminal::FrameTag,
};
use crate::{
    loudness::{self, AnalyzeError, Control, Measurement, Meter},
    resample::{Converter, Format, State},
};
use std::{fs::File, sync::atomic::Ordering};
use vmusic_core::audio_preview::{
    LoudnessMatch, PreviewPlan, PreviewSide, REFERENCE_SECONDS, REFERENCE_WARMUP_SECONDS,
};

#[derive(Debug, Clone)]
pub struct Comparison {
    pub matching: Option<LoudnessMatch>,
    pub unmatched_reason: Option<&'static str>,
    pub reference_end_ms: u64,
    pub reference_end_frame: u64,
    pub processing_rate: u32,
    pub channels: usize,
}

#[cfg(test)]
mod tests;
struct OutputMeasurement {
    reference: Measurement,
    guard: Measurement,
    reduction: f32,
}

pub fn compare_file(
    file: File,
    plan: &PreviewPlan,
    rate: u32,
    channels: usize,
    control: &Control,
) -> Result<Comparison, AnalyzeError> {
    prepare_reference_file(file, plan, rate, channels, true, control)
}

pub fn prepare_reference_file(
    file: File,
    plan: &PreviewPlan,
    rate: u32,
    channels: usize,
    match_loudness: bool,
    control: &Control,
) -> Result<Comparison, AnalyzeError> {
    plan.validate(rate).map_err(|_| AnalyzeError::Unsupported)?;
    if !matches!(rate, 44_100 | 48_000 | 96_000) || !(1..=2).contains(&channels) {
        return Err(AnalyzeError::Unsupported);
    }
    let seconds = REFERENCE_WARMUP_SECONDS + REFERENCE_SECONDS;
    let prefix = loudness::prefix_file(file, seconds, control)?;
    let pcm = convert_prefix(prefix, rate, channels, seconds, control)?;
    if match_loudness {
        compare_pcm(&pcm, plan, rate, channels, control)
    } else {
        Ok(Comparison {
            matching: None,
            unmatched_reason: Some("matching_not_requested"),
            reference_end_ms: (pcm.len() / channels) as u64 * 1000 / u64::from(rate),
            reference_end_frame: (pcm.len() / channels) as u64,
            processing_rate: rate,
            channels,
        })
    }
}
fn convert_prefix(
    prefix: loudness::DecodedPrefix,
    rate: u32,
    channels: usize,
    seconds: u64,
    control: &Control,
) -> Result<Vec<f32>, AnalyzeError> {
    if prefix.rate == rate && prefix.channels == channels {
        let mut pcm = prefix.pcm;
        pcm.truncate(rate as usize * seconds as usize * channels);
        return Ok(pcm);
    }
    let mut converter = Converter::new(Format {
        input_rate: prefix.rate,
        output_rate: rate,
        channels: prefix.channels,
    })
    .map_err(|_| AnalyzeError::Unsupported)?;
    let limit = (prefix.pcm.len() / prefix.channels)
        .saturating_mul(rate as usize)
        .div_ceil(prefix.rate as usize)
        .min(rate as usize * seconds as usize);
    let mut output = Vec::with_capacity(limit * channels);
    let mut converted = vec![0.0; 512 * prefix.channels];
    let mut mapped = vec![0.0; 512 * channels];
    let mut at = 0;
    let mut finishing = false;
    let mut zero_progress = 0;
    loop {
        control.check()?;
        let progress = if finishing {
            converter.finish(&mut converted)
        } else {
            converter.process(&prefix.pcm[at..], &mut converted)
        }
        .map_err(|_| AnalyzeError::Decode)?;
        at += progress.consumed_frames * prefix.channels;
        let count = super::map_channels(
            &converted[..progress.produced_frames * prefix.channels],
            prefix.channels,
            channels,
            &mut mapped,
        );
        let take = count.min(limit * channels - output.len());
        output.extend_from_slice(&mapped[..take]);
        if output.len() == limit * channels || progress.state == State::Finished {
            break;
        }
        if !finishing && at == prefix.pcm.len() && progress.state != State::NeedOutput {
            finishing = true;
        }
        if progress.consumed_frames == 0 && progress.produced_frames == 0 {
            zero_progress += 1;
        } else {
            zero_progress = 0;
        }
        if zero_progress > 4 {
            return Err(AnalyzeError::Decode);
        }
    }
    Ok(output)
}

pub fn compare_pcm(
    pcm: &[f32],
    plan: &PreviewPlan,
    rate: u32,
    channels: usize,
    control: &Control,
) -> Result<Comparison, AnalyzeError> {
    plan.validate(rate).map_err(|_| AnalyzeError::Unsupported)?;
    if !matches!(rate, 44_100 | 48_000 | 96_000)
        || !(1..=2).contains(&channels)
        || !pcm.len().is_multiple_of(channels)
        || pcm.len()
            > (REFERENCE_SECONDS + REFERENCE_WARMUP_SECONDS) as usize * rate as usize * channels
    {
        return Err(AnalyzeError::Limit);
    }
    let end_ms = ((pcm.len() / channels) as u64 * 1000 / u64::from(rate)).min(12_000);
    let unmatched = |reason| Comparison {
        matching: None,
        unmatched_reason: Some(reason),
        reference_end_ms: end_ms,
        reference_end_frame: (pcm.len() / channels) as u64,
        processing_rate: rate,
        channels,
    };
    if end_ms < REFERENCE_WARMUP_SECONDS * 1000 + 400 {
        return Ok(unmatched("reference_too_short"));
    }
    // Each path is retired before constructing the next one. The decoded prefix
    // is the only retained PCM; comparison never retains two rendered tracks.
    let enhanced = measure_path(
        pcm,
        plan,
        PreviewSide::Enhanced,
        rate,
        channels,
        0.0,
        true,
        control,
    )?;
    let bypass = measure_path(
        pcm,
        plan,
        PreviewSide::Bypass,
        rate,
        channels,
        0.0,
        true,
        control,
    )?;
    let (Some(enhanced_lufs), Some(bypass_lufs)) = (
        enhanced.reference.integrated_lufs,
        bypass.reference.integrated_lufs,
    ) else {
        return Ok(unmatched("reference_silence_or_below_gate"));
    };
    let difference = enhanced_lufs - bypass_lufs;
    let enhanced_attenuation_db = -difference.max(0.0) as f32;
    let bypass_attenuation_db = difference.min(0.0) as f32;
    let peak = (enhanced.guard.true_peak * 10f64.powf(enhanced_attenuation_db as f64 / 20.0))
        .max(bypass.guard.true_peak * 10f64.powf(bypass_attenuation_db as f64 / 20.0));
    let common_attenuation_db = if peak > 0.0 {
        (-3.0 - 20.0 * peak.log10()).min(0.0) as f32
    } else {
        0.0
    };
    if [
        enhanced_attenuation_db,
        bypass_attenuation_db,
        common_attenuation_db,
    ]
    .iter()
    .any(|g| !g.is_finite() || *g < -72.0)
        || enhanced_attenuation_db + common_attenuation_db < -72.0
        || bypass_attenuation_db + common_attenuation_db < -72.0
    {
        return Ok(unmatched("matching_attenuation_outside_budget"));
    }
    let final_enhanced = measure_path(
        pcm,
        plan,
        PreviewSide::Enhanced,
        rate,
        channels,
        enhanced_attenuation_db + common_attenuation_db,
        false,
        control,
    )?;
    let final_bypass = measure_path(
        pcm,
        plan,
        PreviewSide::Bypass,
        rate,
        channels,
        bypass_attenuation_db + common_attenuation_db,
        false,
        control,
    )?;
    let (Some(final_e), Some(final_b)) = (
        final_enhanced.reference.integrated_lufs,
        final_bypass.reference.integrated_lufs,
    ) else {
        return Ok(unmatched("matched_reference_below_gate"));
    };
    let residual_lu = final_e - final_b;
    let reduction = final_enhanced.reduction.max(final_bypass.reduction);
    let final_peak = final_enhanced
        .guard
        .true_peak
        .max(final_bypass.guard.true_peak);
    if residual_lu.abs() > 0.1 || reduction > 0.01 || final_peak > 10f64.powf(-2.9 / 20.0) {
        return Ok(unmatched("reference_protection_or_match_failed"));
    }
    control.check()?;
    Ok(Comparison {
        matching: Some(LoudnessMatch {
            enhanced_lufs,
            bypass_lufs,
            enhanced_attenuation_db,
            bypass_attenuation_db,
            common_attenuation_db,
            residual_lu,
            final_true_peak: final_peak,
            max_protection_reduction_db: reduction,
            reference_start_ms: REFERENCE_WARMUP_SECONDS * 1000,
            reference_duration_ms: end_ms - REFERENCE_WARMUP_SECONDS * 1000,
        }),
        unmatched_reason: None,
        reference_end_ms: end_ms,
        reference_end_frame: (pcm.len() / channels) as u64,
        processing_rate: rate,
        channels,
    })
}
#[allow(clippy::too_many_arguments)] // One measured side of the same plan, plus its meters' inputs.
fn measure_path(
    pcm: &[f32],
    plan: &PreviewPlan,
    side: PreviewSide,
    rate: u32,
    channels: usize,
    gain_db: f32,
    unprotected: bool,
    control: &Control,
) -> Result<OutputMeasurement, AnalyzeError> {
    let params = match side {
        PreviewSide::Enhanced => plan.enhanced,
        PreviewSide::Bypass => preview::bypass(plan.saved),
    };
    let kernel = if side == PreviewSide::Enhanced {
        plan.impulse
            .clone()
            .map(PreparedImpulse::prepare_preview)
            .transpose()
            .map_err(|_| AnalyzeError::Unsupported)?
    } else {
        None
    };
    let prepared = PreparedEq::preview(
        rate,
        params,
        gain_db,
        if side == PreviewSide::Bypass {
            preview::alignment(plan)
        } else {
            0
        },
    )
    .map_err(|_| AnalyzeError::Unsupported)?;
    let mailbox = DspControl::new();
    mailbox
        .publish_preview(prepared, kernel)
        .map_err(|_| AnalyzeError::Limit)?;
    let mut dsp = DspRuntime::new(rate, channels);
    if !dsp.begin_epoch(&mailbox, mailbox.reset_epoch.load(Ordering::Acquire)) {
        return Err(AnalyzeError::Decode);
    }
    if unprotected {
        dsp.terminal.unprotected_analysis();
    }
    let mut reference = Meter::bounded(rate, channels as u32, REFERENCE_SECONDS + 1)?;
    let mut guard = Meter::bounded(
        rate,
        channels as u32,
        REFERENCE_SECONDS + REFERENCE_WARMUP_SECONDS + 1,
    )?;
    let mut reference_batch = Vec::with_capacity(512 * channels);
    let mut guard_batch = Vec::with_capacity(512 * channels);
    let start = REFERENCE_WARMUP_SECONDS * u64::from(rate);
    let mut reduction = 0.0f32;
    let mut record = |tag: FrameTag, out: &[f32]| -> Result<(), AnalyzeError> {
        guard_batch.extend_from_slice(out);
        if tag.position > start {
            reference_batch.extend_from_slice(out);
        }
        if guard_batch.len() >= 512 * channels {
            guard.push(&guard_batch, control)?;
            guard_batch.clear();
        }
        if reference_batch.len() >= 512 * channels {
            reference.push(&reference_batch, control)?;
            reference_batch.clear();
        }
        Ok(())
    };
    let mut processed = [0.0; 2];
    let mut output = [0.0; 2];
    for (index, input) in pcm.chunks_exact(channels).enumerate() {
        if index % 512 == 0 {
            control.check()?;
        }
        dsp.process_mix(
            input,
            &[0.0; 2][..channels],
            [plan.track_gain_db, 0.0],
            [1.0, 0.0],
            &mut processed[..channels],
        );
        if let Some(tag) = dsp.terminal.push(
            &processed[..channels],
            &mut output[..channels],
            FrameTag {
                position: index as u64 + 1,
                transition: false,
                audible: true,
                volume: plan.volume,
                fade: 1.0,
            },
        ) {
            record(tag, &output[..channels])?;
        }
        reduction = reduction.max(dsp.terminal.reduction());
    }
    for _ in 0..=dsp.terminal.latency() + 256 {
        if dsp.terminal.queued() == 0 {
            break;
        }
        control.check()?;
        if let Some(tag) = dsp.terminal.finish_frame(&mut output[..channels]) {
            record(tag, &output[..channels])?;
        }
        reduction = reduction.max(dsp.terminal.reduction());
    }
    if dsp.terminal.queued() != 0 {
        return Err(AnalyzeError::Limit);
    }
    reference.push(&reference_batch, control)?;
    guard.push(&guard_batch, control)?;
    Ok(OutputMeasurement {
        reference: reference.finish()?.measurement,
        guard: guard.finish()?.measurement,
        reduction,
    })
}
