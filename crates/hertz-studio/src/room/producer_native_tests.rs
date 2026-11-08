// SPDX-License-Identifier: MIT
use super::*;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::time::Instant;
use vmusic_audio::render::{NativePcmBudget, PreparedMedia};
use vmusic_core::AudioSource;
use vmusic_lan::protocol::Counter;

struct WaveSource(Cursor<Vec<u8>>);
impl Read for WaveSource {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(out)
    }
}
impl Seek for WaveSource {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.0.seek(pos)
    }
}
impl AudioSource for WaveSource {
    fn media_len(&self) -> Option<u64> {
        Some(self.0.get_ref().len() as u64)
    }
}

fn source(budget: &NativePcmBudget, instance: u64, frames: u32, rate: u32) -> Source {
    source_with_sample(budget, instance, frames, rate, 4096)
}

fn source_with_sample(
    budget: &NativePcmBudget,
    instance: u64,
    frames: u32,
    rate: u32,
    sample: i16,
) -> Source {
    let bytes = frames * 4;
    let mut wave = Vec::with_capacity(44 + bytes as usize);
    wave.extend_from_slice(b"RIFF");
    wave.extend_from_slice(&(36 + bytes).to_le_bytes());
    wave.extend_from_slice(b"WAVEfmt ");
    wave.extend_from_slice(&16u32.to_le_bytes());
    wave.extend_from_slice(&1u16.to_le_bytes());
    wave.extend_from_slice(&2u16.to_le_bytes());
    wave.extend_from_slice(&rate.to_le_bytes());
    wave.extend_from_slice(&(rate * 4).to_le_bytes());
    wave.extend_from_slice(&4u16.to_le_bytes());
    wave.extend_from_slice(&16u16.to_le_bytes());
    wave.extend_from_slice(b"data");
    wave.extend_from_slice(&bytes.to_le_bytes());
    for _ in 0..frames * 2 {
        wave.extend_from_slice(&sample.to_le_bytes());
    }
    let mut media =
        PreparedMedia::open(Box::new(WaveSource(Cursor::new(wave))), Some("wav")).unwrap();
    assert_eq!(
        media
            .validate_native(budget.clone(), Instant::now() + Duration::from_secs(3))
            .unwrap()
            .sample_rate,
        rate
    );
    Source {
        path: PathBuf::from(format!("validated-native-{instance}.wav")),
        media: Some(media),
        instance,
        position_ms: 0,
        track_gain_db: 0.0,
    }
}

fn worker(
    frames: u32,
    rate: u32,
) -> (
    Worker,
    async_mpsc::Receiver<ProducerEvent>,
    mpsc::Receiver<Retired>,
) {
    let (events, received) = async_mpsc::channel(128);
    let (retired, retirement) = mpsc::sync_channel(2);
    let budget = NativePcmBudget::default();
    let prepared = source(&budget, 1, frames, rate);
    let mut worker = Worker {
        clock: MonotonicClock::default(),
        events,
        stop: Arc::new(AtomicBool::new(false)),
        current: None,
        preparing: None,
        retired,
        deferred_mix: None,
        format_mode: FormatMode::Native,
        native_budget: budget,
    };
    worker
        .apply(Command::Prepare {
            plan: Plan {
                epoch: Counter(1),
                plan_id: Counter(1),
                anchor_ns: Counter(1_000_000_000),
                join_frame: Counter(0),
                format: AudioFormat {
                    id: 1,
                    sample_rate: rate,
                    channels: 2,
                },
            },
            source: Some(prepared),
            dsp: DspParams::default(),
            volume: 1.0,
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !worker
        .preparing
        .as_ref()
        .unwrap()
        .renderer
        .as_ref()
        .unwrap()
        .decoded_eof()
    {
        assert!(Instant::now() < deadline, "native decoder failed to finish");
        std::thread::sleep(Duration::from_millis(1));
    }
    let mut generation = worker.preparing.take().unwrap();
    worker.pull(&mut generation, 2_000_000_000).unwrap();
    worker.preparing = Some(generation);
    (worker, received, retirement)
}

fn drain(events: &mut async_mpsc::Receiver<ProducerEvent>) -> Vec<ProducerEvent> {
    let mut out = Vec::new();
    while let Ok(event) = events.try_recv() {
        out.push(event);
    }
    out
}

#[test]
fn one_frame_44100_seals_exact_pcm_without_idle_fill_and_pending_events_remain_charged() {
    let (mut worker, mut events, retirement) = worker(1, 44_100);
    worker
        .apply(Command::Next {
            epoch: 1,
            source: None,
            crossfade_ms: 0,
        })
        .unwrap();
    let mut generation = worker.preparing.take().unwrap();
    worker.pull(&mut generation, 2_000_000_000).unwrap();
    assert!(generation.ended);
    assert_eq!(generation.frame, 1);
    assert_eq!(generation.sequence, 1);
    let events = drain(&mut events);
    let pcm = events
        .iter()
        .filter_map(|event| match event {
            ProducerEvent::Pcm {
                frame,
                samples,
                reservation,
                ..
            } => Some((*frame, samples, reservation)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(pcm.len(), 1);
    assert_eq!(pcm[0].0, 0);
    assert_eq!(pcm[0].1.len(), 2);
    // RenderCore preserves its 250 ms linear startup fade. One real source
    // frame advances that fade once; Preparing/awaiting-next consume none.
    let expected = 0.125f32 * (1.0 / 11_025.0);
    assert!(
        pcm[0]
            .1
            .iter()
            .all(|sample| sample.to_bits() == expected.to_bits()),
        "published first frame: {:?}, expected {expected}",
        pcm[0].1
    );
    assert!(pcm[0].2.is_some());
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event,
                ProducerEvent::EpochEnd {
                    epoch: 1,
                    end_frame: 1,
                    ..
                }
            ))
            .count(),
        1
    );
    assert!(events.iter().any(|event| matches!(
        event,
        ProducerEvent::End {
            frame: 1,
            position_frames: 1,
            ..
        }
    )));
    worker.pull(&mut generation, 100_000_000_000).unwrap();
    assert_eq!(generation.frame, 1);
    drop(retirement.try_recv().unwrap());
    assert!(
        worker.native_budget.usage().bytes > 0,
        "pending PCM event must retain its allocation charge"
    );
    drop(pcm);
    drop(events);
    drop(generation);
    assert_eq!(worker.native_budget.usage().bytes, 0);
    assert_eq!(worker.native_budget.usage().duration_ns, 0);
}

#[test]
fn sealed_late_next_returns_the_exact_prepared_owner_without_reopening_or_extending_epoch() {
    let (mut worker, mut events, retirement) = worker(1, 44_100);
    worker
        .apply(Command::Next {
            epoch: 1,
            source: None,
            crossfade_ms: 0,
        })
        .unwrap();
    let mut generation = worker.preparing.take().unwrap();
    worker.pull(&mut generation, 2_000_000_000).unwrap();
    worker.preparing = Some(generation);
    drop(drain(&mut events));
    drop(retirement.try_recv().unwrap());
    let next = source(&worker.native_budget, 9, 1, 44_100);
    let path = next.path.clone();
    worker
        .apply(Command::Next {
            epoch: 1,
            source: Some(next),
            crossfade_ms: 300,
        })
        .unwrap();
    let events = drain(&mut events);
    let returned = events
        .into_iter()
        .find_map(|event| match event {
            ProducerEvent::SuccessorDeferred { epoch: 1, source } => Some(source),
            _ => None,
        })
        .unwrap();
    assert_eq!(returned.instance, 9);
    assert_eq!(returned.path, path);
    assert_eq!(
        returned
            .media
            .as_ref()
            .unwrap()
            .decoded_format()
            .unwrap()
            .sample_rate,
        44_100
    );
    assert!(worker.preparing.as_ref().unwrap().ended);
    assert_eq!(worker.preparing.as_ref().unwrap().frame, 1);
    assert!(worker.preparing.as_ref().unwrap().renderer.is_none());
}

#[test]
fn open_cross_rate_next_defers_the_exact_source_and_releases_old_awaiting_next() {
    let (mut worker, mut events, retirement) = worker(2000, 44_100);
    let next = source(&worker.native_budget, 2, 23, 96_000);
    let path = next.path.clone();
    worker
        .apply(Command::Next {
            epoch: 1,
            source: Some(next),
            crossfade_ms: 300,
        })
        .unwrap();
    let returned = drain(&mut events)
        .into_iter()
        .find_map(|event| match event {
            ProducerEvent::SuccessorDeferred { epoch: 1, source } => Some(source),
            _ => None,
        })
        .unwrap();
    assert_eq!(returned.path, path);
    assert_eq!(returned.instance, 2);
    assert_eq!(
        returned
            .media
            .as_ref()
            .unwrap()
            .decoded_format()
            .unwrap()
            .sample_rate,
        96_000
    );
    let mut generation = worker.preparing.take().unwrap();
    assert!(!generation.awaiting_next);
    assert!(generation.next_gain.is_none());
    worker.pull(&mut generation, 2_000_000_000).unwrap();
    assert!(generation.ended);
    assert_eq!(generation.frame, 2000);
    assert_eq!(generation.plan.format.sample_rate, 44_100);
    let events = drain(&mut events);
    assert!(events.iter().any(|event| matches!(
        event,
        ProducerEvent::EpochEnd {
            end_frame: 2000,
            ..
        }
    )));
    assert!(!events
        .iter()
        .any(|event| matches!(event, ProducerEvent::Error { .. })));
    drop(events);
    drop(returned);
    drop(retirement.try_recv().unwrap());
    assert_eq!(worker.native_budget.usage().bytes, 0);
}

#[test]
fn three_same_rate_wavs_share_one_open_epoch_until_the_final_source_ends() {
    let (mut worker, mut events, retirement) = worker(64, 44_100);
    let mut pcm_frames = 0;
    let mut boundaries = Vec::new();
    for next in [2, 3] {
        let prepared = source(&worker.native_budget, next, 64, 44_100);
        worker
            .apply(Command::Next {
                epoch: 1,
                source: Some(prepared),
                crossfade_ms: 0,
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !worker
            .preparing
            .as_ref()
            .unwrap()
            .renderer
            .as_ref()
            .unwrap()
            .prepared_next_ready(882)
        {
            assert!(
                Instant::now() < deadline,
                "same-rate successor failed to decode"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        let mut generation = worker.preparing.take().unwrap();
        worker.pull(&mut generation, 2_000_000_000).unwrap();
        assert!(!generation.ended);
        assert_eq!(generation.instance, next);
        assert!(generation.awaiting_next);
        worker.preparing = Some(generation);
        for event in drain(&mut events) {
            match event {
                ProducerEvent::Boundary {
                    epoch,
                    frame,
                    instance,
                    ..
                } => {
                    assert_eq!(epoch, 1);
                    boundaries.push((frame, instance));
                }
                ProducerEvent::Pcm { epoch, samples, .. } => {
                    assert_eq!(epoch, 1);
                    pcm_frames += samples.len() / 2;
                }
                ProducerEvent::EpochEnd { .. } | ProducerEvent::End { .. } => {
                    panic!("track EOF sealed a still-open same-rate epoch")
                }
                ProducerEvent::SuccessorDeferred { .. } | ProducerEvent::Error { .. } => {
                    panic!("qualified same-rate successor was rejected")
                }
                _ => {}
            }
        }
    }
    worker
        .apply(Command::Next {
            epoch: 1,
            source: None,
            crossfade_ms: 0,
        })
        .unwrap();
    let mut generation = worker.preparing.take().unwrap();
    worker.pull(&mut generation, 2_000_000_000).unwrap();
    assert!(generation.ended);
    assert_eq!(generation.frame, 192);
    let events = drain(&mut events);
    for event in &events {
        if let ProducerEvent::Pcm { samples, .. } = event {
            pcm_frames += samples.len() / 2;
        }
    }
    assert_eq!(pcm_frames, 192);
    assert_eq!(boundaries, vec![(64, 2), (128, 3)]);
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event,
                ProducerEvent::EpochEnd {
                    epoch: 1,
                    end_frame: 192,
                    ..
                }
            ))
            .count(),
        1
    );
    drop(events);
    drop(retirement.try_recv().unwrap());
    assert_eq!(worker.native_budget.usage().bytes, 0);
}

#[test]
fn same_rate_crossfade_keeps_exact_overlap_positions_and_a_single_finite_epoch() {
    // Two 50 ms tracks overlap for 20 ms on their native 44.1 kHz grid.
    let (mut worker, mut events, retirement) = worker(2205, 44_100);
    let next = source_with_sample(&worker.native_budget, 2, 2205, 44_100, 8192);
    worker
        .apply(Command::Next {
            epoch: 1,
            source: Some(next),
            crossfade_ms: 20,
        })
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !worker
        .preparing
        .as_ref()
        .unwrap()
        .renderer
        .as_ref()
        .unwrap()
        .prepared_next_ready(882)
    {
        assert!(
            Instant::now() < deadline,
            "crossfade successor failed to decode"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    let mut generation = worker.preparing.take().unwrap();
    worker.pull(&mut generation, 2_000_000_000).unwrap();
    assert_eq!(generation.frame, 2205);
    assert_eq!(generation.instance, 2);
    assert!(generation.awaiting_next);
    assert!(!generation.ended);
    worker.preparing = Some(generation);
    let mut published = drain(&mut events);
    assert!(!published.iter().any(|event| matches!(
        event,
        ProducerEvent::EpochEnd { .. } | ProducerEvent::End { .. }
    )));
    assert_eq!(
        published
            .iter()
            .filter_map(|event| match event {
                ProducerEvent::Boundary {
                    epoch,
                    frame,
                    instance,
                    position_frames,
                } => Some((*epoch, *frame, *instance, *position_frames)),
                _ => None,
            })
            .collect::<Vec<_>>(),
        vec![(1, 2205, 2, 882)],
        "promotion reports the outgoing end and the incoming overlap position"
    );
    worker
        .apply(Command::Next {
            epoch: 1,
            source: None,
            crossfade_ms: 0,
        })
        .unwrap();
    let mut generation = worker.preparing.take().unwrap();
    worker.pull(&mut generation, 2_000_000_000).unwrap();
    assert!(generation.ended);
    assert_eq!(generation.frame, 3528);
    published.extend(drain(&mut events));
    let mut pcm = Vec::new();
    let mut sequence = 0;
    for event in &published {
        if let ProducerEvent::Pcm {
            epoch,
            sequence: actual_sequence,
            format,
            frame,
            samples,
            reservation,
        } = event
        {
            assert_eq!(*epoch, 1);
            assert_eq!(*actual_sequence, sequence);
            assert_eq!(format.sample_rate, 44_100);
            assert_eq!(*frame, pcm.len() as u64 / 2);
            assert!(reservation.is_some());
            pcm.extend_from_slice(samples);
            sequence += 1;
        }
    }
    assert_eq!(pcm.len(), 3528 * 2, "overlap must not be published twice");
    // This short epoch lies wholly inside the renderer's 250 ms startup
    // fade. Promotion must keep advancing the same fade on the epoch grid.
    let fade_gain = |frame: usize| (frame + 1) as f32 / 11_025.0;
    for (frame, stereo) in pcm.as_chunks::<2>().0.iter().enumerate() {
        let source = if frame < 1323 {
            0.125
        } else if frame >= 2205 {
            0.25
        } else {
            continue;
        };
        let expected = source * fade_gain(frame);
        assert!(
            stereo
                .iter()
                .all(|sample| sample.to_bits() == expected.to_bits()),
            "frame {frame}: {stereo:?}, expected {expected}"
        );
    }
    assert!((pcm[1323 * 2] - 0.125 * fade_gain(1323)).abs() < 1e-6);
    assert!((pcm[2204 * 2] - 0.25 * fade_gain(2204)).abs() < 1e-6);
    let middle = pcm[(1323 + 441) * 2] / fade_gain(1323 + 441);
    assert!(
        middle > 0.20 && middle < 0.25,
        "both decks must contribute in the overlap"
    );
    assert!(pcm
        .as_chunks::<2>()
        .0
        .iter()
        .all(|frame| frame[0] == frame[1]));
    assert_eq!(
        published
            .iter()
            .filter(|event| matches!(
                event,
                ProducerEvent::EpochEnd {
                    epoch: 1,
                    end_frame: 3528,
                    ..
                }
            ))
            .count(),
        1
    );
    assert!(published.iter().any(|event| matches!(
        event,
        ProducerEvent::End {
            epoch: 1,
            frame: 3528,
            instance: 2,
            position_frames: 2205,
        }
    )));
    assert!(!published.iter().any(|event| matches!(
        event,
        ProducerEvent::SuccessorDeferred { .. } | ProducerEvent::Error { .. }
    )));
    drop(retirement.try_recv().unwrap());
    drop(published);
    drop(generation);
    assert_eq!(worker.native_budget.usage().bytes, 0);
    assert_eq!(worker.native_budget.usage().duration_ns, 0);
}

#[test]
fn a_native_render_deadline_failure_preserves_published_pcm_and_reports_interruption_without_eof() {
    let (mut worker, mut events, retirement) = worker(5000, 44_100);
    worker
        .apply(Command::Next {
            epoch: 1,
            source: None,
            crossfade_ms: 0,
        })
        .unwrap();
    let mut generation = worker.preparing.take().unwrap();
    generation.plan.anchor_ns = Counter(0);
    worker.pull(&mut generation, 20_000_000).unwrap();
    assert_eq!(generation.frame, 882);
    generation.committed = true;
    worker.current = Some(generation);
    let stop = worker.stop.clone();
    let budget = worker.native_budget.clone();
    let (commands, inbox) = mpsc::sync_channel(1);
    let thread = std::thread::spawn(move || worker.run(inbox));
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut published = Vec::new();
    loop {
        if let Ok(event) = events.try_recv() {
            let interrupted = matches!(event, ProducerEvent::Interrupted { .. });
            published.push(event);
            if interrupted {
                break;
            }
        } else {
            assert!(
                Instant::now() < deadline,
                "deadline failure was not reported"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    stop.store(true, Ordering::Release);
    drop(commands);
    thread.join().unwrap().unwrap();
    published.extend(drain(&mut events));
    assert!(published.iter().any(|event| matches!(
        event,
        ProducerEvent::Interrupted {
            epoch: 1,
            frame: 882,
            position_frames: 882,
            ..
        }
    )));
    assert_eq!(
        published
            .iter()
            .filter_map(|event| match event {
                ProducerEvent::Pcm { samples, .. } => Some(samples.len() / 2),
                _ => None,
            })
            .sum::<usize>(),
        882
    );
    assert!(!published.iter().any(|event| matches!(
        event,
        ProducerEvent::EpochEnd { .. } | ProducerEvent::End { .. }
    )));
    while let Ok(resource) = retirement.try_recv() {
        drop(resource);
    }
    assert!(
        budget.usage().bytes > 0,
        "the published prefix retains its event reservation"
    );
    drop(published);
    assert_eq!(budget.usage().bytes, 0);
}
