// SPDX-License-Identifier: MIT
use super::*;
use crate::render::tests::{measure_memory, CallbackMemory};
use std::io::{Cursor, Read, Seek, SeekFrom};
use vmusic_core::audio_preview::{ImpulsePhase, PreviewImpulse};
use vmusic_core::audio_quality::LimiterMode;

struct Wave(Cursor<Vec<u8>>);
impl Read for Wave {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(out)
    }
}
impl Seek for Wave {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.0.seek(pos)
    }
}
impl AudioSource for Wave {
    fn media_len(&self) -> Option<u64> {
        Some(self.0.get_ref().len() as u64)
    }
}
fn wave(rate: u32, channels: u16, frames: usize) -> Box<dyn AudioSource> {
    let bytes = (frames * channels as usize * 2) as u32;
    let mut wav = Vec::with_capacity(bytes as usize + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
    wav.extend_from_slice(&(channels * 2).to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&bytes.to_le_bytes());
    for _ in 0..frames * channels as usize {
        wav.extend_from_slice(&4096i16.to_le_bytes());
    }
    Box::new(Wave(Cursor::new(wav)))
}
fn fixture(rate: u32, channels: u16) -> RenderCore {
    let mut r = RenderCore::new(RenderFormat {
        sample_rate: rate,
        channels,
    })
    .unwrap();
    r.load_source(wave(rate, channels, rate as usize * 4), Some("wav".into()))
        .unwrap();
    wait(&r, 512);
    r.seek(300).unwrap();
    r
}
fn wait(r: &RenderCore, frames: usize) {
    let until = Instant::now() + Duration::from_secs(2);
    while r.buffered_frames() < frames && !r.decoded_eof() {
        assert!(Instant::now() < until, "decoder did not become ready");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn render_progress(r: &mut RenderCore, data: &mut [f32]) -> crate::render::RenderReport {
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        let (report, memory) = measure_memory(|| r.render_report(data));
        assert_eq!(memory, CallbackMemory::ZERO);
        if report.source_frames > 0 {
            return report;
        }
        assert!(
            Instant::now() < until,
            "ready decoder made no render progress"
        );
        // Readiness does not prohibit the decoder from briefly reacquiring its queue.
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn plan(r: &RenderCore, id: char, end: u64) -> PreviewPlan {
    let saved = r.shared.dsp.parameters.lock().unwrap().params;
    let mut enhanced = saved;
    enhanced.preamp_db = 6.0;
    PreviewPlan {
        request_id: format!("{}0000000-0000-4000-8000-000000000000", id),
        saved,
        enhanced,
        impulse: None,
        matching: None,
        volume: f32::from_bits(r.shared.volume.load(Ordering::Relaxed)),
        track_gain_db: r.track_gain_db(),
        source_sha256: "a".repeat(64),
        reference_end_ms: end * 1000 / u64::from(r.output_rate),
        reference_end_frame: end,
    }
}
fn prepare(r: &mut RenderCore, p: PreviewPlan) {
    let source = wave(r.output_rate, r.output_channels, r.output_rate as usize * 4);
    r.prepare_preview(p, source, Some("wav".into())).unwrap();
}
fn steady(r: &mut RenderCore) {
    r.shared.playing.store(true, Ordering::Release);
    r.shared.fade_gain.store(1f32.to_bits(), Ordering::Relaxed);
    r.shared.fade_from.store(1f32.to_bits(), Ordering::Relaxed);
    r.shared.fade_to.store(1f32.to_bits(), Ordering::Relaxed);
    r.shared.fade_frames.store(0, Ordering::Relaxed);
}

#[test]
fn ready_identity_and_expiry_do_not_mutate_the_saved_timeline() {
    let mut r = fixture(48_000, 1);
    let p = plan(&r, 'a', 48_000);
    let id = p.request_id.clone();
    prepare(&mut r, p);
    assert!(!r.cancel_preview(Some("other")).unwrap());
    assert_eq!(r.position_ms(), 300);
    r.preview.ready.as_mut().unwrap().expires = Instant::now() - Duration::from_millis(1);
    assert!(r.start_preview(&id, PreviewSide::Enhanced).is_err());
    assert!(r.preview.ready.is_none());
    assert!(r.preview.active.is_none());
    assert_eq!(r.position_ms(), 300);
    let p = plan(&r, 'b', 48_000);
    let id = p.request_id.clone();
    prepare(&mut r, p);
    r.shared
        .current_deck()
        .gain_db
        .store(1f32.to_bits(), Ordering::Relaxed);
    assert!(r.start_preview(&id, PreviewSide::Enhanced).is_err());
    assert_eq!(r.shared.preview_end_frame.load(Ordering::Relaxed), 0);
}

#[test]
fn paused_preview_preserves_preferences_and_first_callback_has_no_heap_operations() {
    let mut r = fixture(48_000, 2);
    let saved = QualityParams {
        configuration_revision: 7,
        preamp_db: -3.0,
        ..Default::default()
    };
    r.set_quality(saved).unwrap();
    r.set_volume(0.25).unwrap();
    r.shared
        .current_deck()
        .gain_db
        .store((-2f32).to_bits(), Ordering::Relaxed);
    let p = plan(&r, 'a', 48_000);
    let id = p.request_id.clone();
    let enhanced = p.enhanced;
    prepare(&mut r, p);
    r.start_preview(&id, PreviewSide::Enhanced).unwrap();
    assert!(!r.shared.playing.load(Ordering::Relaxed));
    let before = r.quality_status().unwrap();
    assert_eq!(before.requested, saved);
    assert!(before.eq.applied_revision.is_none());
    assert!(before.applied.is_none());
    wait(&r, 512);
    steady(&mut r);
    let mut data = [0f32; 1024];
    let report = render_progress(&mut r, &mut data);
    assert_eq!(report.source_frames, 512);
    let expected = 0.125 * 10f32.powf((6.0 - 2.0) / 20.0) * 0.25;
    assert!(data.iter().all(|x| (*x - expected).abs() < 1e-6));
    let status = r.quality_status().unwrap();
    assert_eq!(status.requested, saved);
    assert!(status.applied.is_none());
    assert_eq!(
        status.preview.as_ref().unwrap().effective_params,
        Some(enhanced)
    );
    assert_eq!(status.preview.as_ref().unwrap().state, "active");
    assert_eq!(status.track_gain_db, -2.0);
    r.pause().unwrap();
    r.cancel_preview(Some(&id)).unwrap();
    assert_eq!(r.position_ms(), 300);
    assert_eq!(r.shared.dsp.parameters.lock().unwrap().params, saved);
    assert_eq!(r.track_gain_db(), -2.0);
    assert_eq!(
        f32::from_bits(r.shared.volume.load(Ordering::Relaxed)),
        0.25
    );
    assert!(!r.cancel_preview(Some(&id)).unwrap());
    assert!(r.pending_pause || !r.shared.playing.load(Ordering::Relaxed));
}

#[test]
fn pending_preview_keeps_old_dsp_and_pause_cancel_never_installs_the_reference() {
    let mut r = fixture(48_000, 1);
    steady(&mut r);
    let saved = r.shared.dsp.parameters.lock().unwrap().params;
    let p = plan(&r, 'a', 48_000);
    let id = p.request_id.clone();
    prepare(&mut r, p);
    r.start_preview(&id, PreviewSide::Enhanced).unwrap();
    assert!(r.pending_load.is_some());
    assert!(r.preview.active.as_ref().unwrap().pending);
    assert_eq!(r.shared.dsp.parameters.lock().unwrap().params, saved);
    assert_eq!(r.shared.preview_end_frame.load(Ordering::Relaxed), 0);
    r.pause().unwrap();
    r.cancel_preview(Some(&id)).unwrap();
    assert!(r.pending_load.is_none());
    assert!(r.preview.active.is_none());
    assert_eq!(r.position_ms(), 300);
    assert_eq!(r.take_preview_restore().as_deref(), Some(id.as_str()));
    let mut data = [0.0; 512];
    for _ in 0..30 {
        r.render(&mut data);
        r.maintain();
    }
    assert!(!r.shared.playing.load(Ordering::Relaxed));
    assert_eq!(r.shared.dsp.parameters.lock().unwrap().params, saved);
}

#[test]
fn select_replays_the_same_source_and_rearms_both_deadlines() {
    let mut r = fixture(48_000, 1);
    let p = plan(&r, 'a', 48_000);
    let id = p.request_id.clone();
    prepare(&mut r, p);
    r.start_preview(&id, PreviewSide::Enhanced).unwrap();
    wait(&r, 512);
    steady(&mut r);
    let mut data = [0.0; 512];
    let deck = r.shared.current_deck();
    let held = deck.samples.lock().unwrap();
    let (report, memory) = measure_memory(|| r.render_report(&mut data));
    assert_eq!(report.source_frames, 0);
    assert_eq!(r.position_frames(), 0);
    assert_eq!(memory, CallbackMemory::ZERO);
    drop(held);
    render_progress(&mut r, &mut data);
    assert!(r.position_frames() > 0);
    let now = crate::sleep_deadline::now_ms();
    r.shared.preview_deadline.set_test_now_ms(now);
    r.shared.preview_deadline.set(Some(now + 100));
    r.select_preview(&id, PreviewSide::Bypass).unwrap();
    assert_eq!(r.position_frames(), 0);
    assert!(r.preview.active.as_ref().unwrap().expires > Instant::now());
    r.shared.preview_deadline.set_test_now_ms(now + 101);
    assert!(!r.shared.preview_deadline.expired());
    assert_eq!(r.preview.active.as_ref().unwrap().side, PreviewSide::Bypass);
    assert!(!r.refresh_preview("old"));
    assert!(r.refresh_preview(&id));
    r.shared.preview_deadline.set(Some(now + 101));
    assert!(!r.refresh_preview(&id));
    assert!(r.select_preview(&id, PreviewSide::Enhanced).is_err());
    assert!(r.preview.active.is_none());
    assert_eq!(r.position_ms(), 300);
}

#[test]
fn expired_gate_silences_first_callback_before_actor_restores_without_consuming() {
    let mut r = fixture(48_000, 1);
    let p = plan(&r, 'a', 48_000);
    let id = p.request_id.clone();
    prepare(&mut r, p);
    r.start_preview(&id, PreviewSide::Enhanced).unwrap();
    wait(&r, 512);
    steady(&mut r);
    r.shared.preview_deadline.set_test_now_ms(2000);
    r.shared.preview_deadline.set(Some(2000));
    let shared = r.shared.clone();
    let deck = shared.current_deck();
    let samples = deck.samples.lock().unwrap();
    let frames = samples.len();
    let position = r.position_frames();
    let mut data = [1.0; 512];
    let (_, memory) = measure_memory(|| r.render(&mut data));
    assert_eq!(memory, CallbackMemory::ZERO);
    assert!(data.iter().all(|x| *x == 0.0));
    assert_eq!(samples.len(), frames);
    assert_eq!(r.position_frames(), position);
    drop(samples);
    r.maintain();
    assert!(r.preview.active.is_none());
    assert_eq!(r.position_ms(), 300);
    assert_eq!(r.take_preview_restore().as_deref(), Some(id.as_str()));
}

#[test]
fn reference_boundary_drains_exact_real_frames_with_all_declared_delays() {
    for rate in [44_100, 48_000, 96_000] {
        for end in [1u64, 17, 193] {
            let mut r = fixture(rate, 1);
            let saved = QualityParams {
                limiter: LimiterMode::TruePeak,
                ..Default::default()
            };
            r.set_quality(saved).unwrap();
            let mut p = plan(&r, 'a', end);
            if rate != 96_000 {
                let mut taps = vec![0.0; 257];
                taps[128] = 1.0;
                p.enhanced.impulse_id = vmusic_core::audio_quality::decode_id(&"b".repeat(64));
                p.enhanced.tone.saturation = true;
                p.enhanced.tone.mix = 0.0;
                p.impulse = Some(PreviewImpulse {
                    phase: ImpulsePhase::SymmetricLinear,
                    kernel: vmusic_core::impulse::ImpulseKernel {
                        resource_id: "b".repeat(64),
                        sample_rate: rate,
                        channels: vec![taps],
                        delay_frames: 128,
                        attenuation_db: 0.0,
                    },
                });
            }
            let id = p.request_id.clone();
            prepare(&mut r, p);
            r.start_preview(&id, PreviewSide::Enhanced).unwrap();
            wait(&r, 512);
            steady(&mut r);
            let mut total = 0;
            let mut presented = 0;
            let mut data = [0.0; 127];
            let until = Instant::now() + Duration::from_secs(2);
            loop {
                let (report, memory) = measure_memory(|| r.render_report(&mut data));
                assert_eq!(memory, CallbackMemory::ZERO);
                assert!(report.transition_frame.is_none());
                total += report.source_frames;
                presented += report
                    .audible_frames
                    .saturating_sub(report.leading_silence_frames);
                let expected = 0.125 * 10f32.powf(6.0 / 20.0);
                if report.audible_frames > report.leading_silence_frames {
                    assert!(data[report.leading_silence_frames..report.audible_frames]
                        .iter()
                        .all(|x| (*x - expected).abs() < 2e-6));
                }
                assert!(
                    !r.finished(),
                    "reference completion must not emit natural Ended"
                );
                if r.position_frames() == end {
                    break;
                }
                assert!(
                    Instant::now() < until,
                    "reference did not reach its exact boundary"
                );
                if report.source_frames == 0 && report.audible_frames == 0 {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
            assert_eq!(total as u64, end, "{rate} / {end}");
            assert_eq!(presented as u64, end);
            assert_eq!(r.position_frames(), end);
            assert!(
                r.buffered_frames() > 0,
                "the reference end is separate from real file EOF"
            );
            assert_eq!(r.shared.dsp.terminal_queued.load(Ordering::Acquire), 0);
            r.maintain();
            assert!(r.preview.active.is_none());
            assert_eq!(r.position_ms(), 300);
        }
    }
}

#[test]
fn save_and_transport_changes_revoke_preview_and_late_uuid_cannot_restore_new_values() {
    for action in 0..4 {
        let mut r = fixture(48_000, 1);
        let p = plan(&r, 'a', 48_000);
        let id = p.request_id.clone();
        prepare(&mut r, p);
        r.start_preview(&id, PreviewSide::Enhanced).unwrap();
        wait(&r, 512);
        steady(&mut r);
        render_progress(&mut r, &mut [0.0; 512]);
        let next = QualityParams {
            configuration_revision: 8,
            preamp_db: -9.0,
            ..Default::default()
        };
        match action {
            0 => {
                r.set_quality(next).unwrap();
                assert_eq!(r.position_ms(), 300);
            }
            1 => {
                r.set_volume(0.1).unwrap();
                assert_eq!(r.position_ms(), 300);
            }
            2 => {
                r.seek(700).unwrap();
                assert_eq!(r.position_ms(), 700);
            }
            _ => {
                r.stop().unwrap();
            }
        }
        assert!(r.preview.active.is_none());
        assert!(!r.cancel_preview(Some(&id)).unwrap());
        if action == 0 {
            assert_eq!(r.shared.dsp.parameters.lock().unwrap().params, next);
        }
    }
}

#[test]
fn output_rebuild_sleep_and_revision_exhaustion_revoke_or_reject_preview() {
    let gate = Arc::new(SleepDeadline::new());
    let mut r = RenderCore::with_sleep_deadline(
        RenderFormat {
            sample_rate: 48_000,
            channels: 1,
        },
        Some(gate.clone()),
    )
    .unwrap();
    r.load_source(wave(48_000, 1, 192_000), Some("wav".into()))
        .unwrap();
    wait(&r, 512);
    r.seek(300).unwrap();
    let p = plan(&r, 'a', 48_000);
    let id = p.request_id.clone();
    prepare(&mut r, p);
    r.start_preview(&id, PreviewSide::Enhanced).unwrap();
    let output = r.prepare_output(r.format()).unwrap();
    assert!(r.preview.active.is_none());
    assert_eq!(r.position_ms(), 300);
    drop(output);
    let p = plan(&r, 'b', 48_000);
    let id = p.request_id.clone();
    prepare(&mut r, p);
    r.start_preview(&id, PreviewSide::Enhanced).unwrap();
    gate.set(Some(1));
    r.maintain();
    assert!(r.preview.active.is_none());
    assert!(!r.shared.playing.load(Ordering::Relaxed));
    gate.set(None);
    r.shared.dsp.parameters.lock().unwrap().revision = u64::MAX - 1;
    let p = plan(&r, 'c', 48_000);
    assert!(r
        .prepare_preview(p, wave(48_000, 1, 192_000), Some("wav".into()))
        .is_err());
    assert!(r.preview.active.is_none());
}
