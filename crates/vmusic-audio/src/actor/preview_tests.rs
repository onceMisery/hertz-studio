// SPDX-License-Identifier: MIT
//! The command owner is tested with the production RenderCore, without a device.
use super::*;
use crate::render::{RenderCore, RenderFormat};
use std::io::{Cursor, Read, Seek, SeekFrom};
use vmusic_core::audio_preview::{PreviewPlan, PreviewSide};
use vmusic_core::audio_quality::QualityParams;

struct Wave(Cursor<Vec<u8>>);
impl Read for Wave {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(out)
    }
}
impl Seek for Wave {
    fn seek(&mut self, at: SeekFrom) -> std::io::Result<u64> {
        self.0.seek(at)
    }
}
impl AudioSource for Wave {
    fn media_len(&self) -> Option<u64> {
        Some(self.0.get_ref().len() as u64)
    }
}
fn wave() -> Box<dyn AudioSource> {
    let frames = 48_000 * 4;
    let bytes = frames * 2u32;
    let mut wav = Vec::with_capacity(bytes as usize + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&48_000u32.to_le_bytes());
    wav.extend_from_slice(&96_000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&bytes.to_le_bytes());
    for _ in 0..frames {
        wav.extend_from_slice(&4096i16.to_le_bytes());
    }
    Box::new(Wave(Cursor::new(wav)))
}
fn fixture() -> (RenderCore, PlayerSnapshot, PreviewPlan) {
    let mut core = RenderCore::new(RenderFormat {
        sample_rate: 48_000,
        channels: 1,
    })
    .unwrap();
    core.load_source(wave(), Some("wav".into())).unwrap();
    core.seek(300).unwrap();
    core.set_volume(0.75).unwrap();
    let state = PlayerSnapshot {
        generation: 7,
        source_generation: 4,
        track_id: Some("current".into()),
        position_ms: 300,
        volume: 0.75,
        ..Default::default()
    };
    let saved = QualityParams::default();
    let mut enhanced = saved;
    enhanced.preamp_db = 6.0;
    let plan = PreviewPlan {
        request_id: "a0000000-0000-4000-8000-000000000000".into(),
        saved,
        enhanced,
        impulse: None,
        matching: None,
        volume: state.volume,
        track_gain_db: 0.0,
        source_sha256: "a".repeat(64),
        reference_end_ms: 1000,
        reference_end_frame: 48_000,
    };
    (core, state, plan)
}

#[test]
fn preview_preparation_rejects_each_stale_source_intent_and_allows_position_progress() {
    let (mut core, mut state, plan) = fixture();
    let sink = ArcSwap::from_pointee(state.clone());
    let mut stale = Vec::new();
    let mut s = state.clone();
    s.generation += 1;
    stale.push(s);
    let mut s = state.clone();
    s.source_generation += 1;
    stale.push(s);
    let mut s = state.clone();
    s.track_id = Some("other".into());
    stale.push(s);
    let mut s = state.clone();
    s.track_id = None;
    stale.push(s);
    let mut s = state.clone();
    s.volume = 0.5;
    stale.push(s);
    for expected in stale {
        let (reply, mut response) = oneshot::channel();
        assert!(!apply(
            &mut core,
            &mut state,
            &sink,
            Command::PrepareQualityPreview {
                plan: plan.clone(),
                source: wave(),
                ext: Some("wav".into()),
                expected,
                reply,
            }
        )
        .unwrap());
        assert!(response.try_recv().unwrap().is_err());
        assert_eq!(state.generation, 7);
        assert_eq!(core.position_ms(), 300);
    }
    let mut expected = state.clone();
    expected.position_ms = 250;
    let (reply, mut response) = oneshot::channel();
    apply(
        &mut core,
        &mut state,
        &sink,
        Command::PrepareQualityPreview {
            plan,
            source: wave(),
            ext: Some("wav".into()),
            expected,
            reply,
        },
    )
    .unwrap();
    assert!(response.try_recv().unwrap().is_ok());
    assert_eq!(sink.load().generation, 7);
}

#[test]
fn start_select_and_matching_cancel_keep_source_and_restore_generations_distinct() {
    let (mut core, mut state, plan) = fixture();
    core.prepare_quality_preview(plan.clone(), wave(), Some("wav".into()))
        .unwrap();
    let sink = ArcSwap::from_pointee(state.clone());
    let (reply, mut response) = oneshot::channel();
    let expected = state.clone();
    assert!(apply(
        &mut core,
        &mut state,
        &sink,
        Command::StartQualityPreview {
            id: plan.request_id.clone(),
            side: PreviewSide::Enhanced,
            expected,
            reply,
        }
    )
    .unwrap());
    assert!(response.try_recv().unwrap().is_ok());
    assert_eq!(
        (state.generation, state.source_generation, state.position_ms),
        (8, 5, 0)
    );
    let (reply, mut response) = oneshot::channel();
    assert!(apply(
        &mut core,
        &mut state,
        &sink,
        Command::SelectQualityPreview(plan.request_id.clone(), PreviewSide::Bypass, reply)
    )
    .unwrap());
    assert!(response.try_recv().unwrap().is_ok());
    assert_eq!((state.generation, state.source_generation), (9, 5));
    let (reply, mut response) = oneshot::channel();
    apply(
        &mut core,
        &mut state,
        &sink,
        Command::CancelQualityPreview(Some("older".into()), reply),
    )
    .unwrap();
    assert!(!response.try_recv().unwrap().unwrap());
    assert_eq!(sink.load().generation, 9);
    let (reply, mut response) = oneshot::channel();
    apply(
        &mut core,
        &mut state,
        &sink,
        Command::CancelQualityPreview(Some(plan.request_id), reply),
    )
    .unwrap();
    assert!(response.try_recv().unwrap().unwrap());
    assert_eq!(
        (state.generation, state.source_generation, state.position_ms),
        (10, 5, 300)
    );
    assert!(
        core.take_quality_preview_restore().is_none(),
        "explicit cancellation consumes its restore event once"
    );
    assert_eq!(core.quality_status().unwrap().requested, plan.saved);
}

#[test]
fn preview_start_reserves_restore_generation_and_sleep_cannot_authorize_it() {
    let (mut core, mut state, plan) = fixture();
    core.prepare_quality_preview(plan.clone(), wave(), Some("wav".into()))
        .unwrap();
    state.generation = u64::MAX - 1;
    let sink = ArcSwap::from_pointee(state.clone());
    let expected = state.clone();
    let (reply, mut response) = oneshot::channel();
    apply(
        &mut core,
        &mut state,
        &sink,
        Command::StartQualityPreview {
            id: plan.request_id.clone(),
            side: PreviewSide::Enhanced,
            expected,
            reply,
        },
    )
    .unwrap();
    assert!(response.try_recv().unwrap().is_err());
    assert!(core.quality_status().unwrap().preview.is_none());
    assert_eq!(state.generation, u64::MAX - 1);
    state.generation = 7;
    let gate = SleepDeadline::new();
    gate.set(Some(1));
    let expected = state.clone();
    let (reply, mut response) = oneshot::channel();
    apply_with_sleep_deadline(
        &mut core,
        &mut state,
        &sink,
        Command::StartQualityPreview {
            id: plan.request_id,
            side: PreviewSide::Enhanced,
            expected,
            reply,
        },
        &gate,
    )
    .unwrap();
    assert!(response
        .try_recv()
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("sleep_timer_expired"));
    assert_eq!(state.generation, 7);
    assert_eq!(core.position_ms(), 300);
}
