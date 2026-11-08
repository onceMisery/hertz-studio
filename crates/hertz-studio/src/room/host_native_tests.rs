// SPDX-License-Identifier: MIT
use super::join_retry_tests as tests;
use super::*;

#[tokio::test]
async fn native_end_uses_integer_ceil_and_rejects_a_conflicting_producer_total() {
    let (mut owner, audio, _render, _inbound) = tests::playing_owner().await;
    owner.format_mode = FormatMode::Native;
    owner.mode = PlayMode::Shuffle;
    owner.audible.as_mut().unwrap().plan.format.sample_rate = 44_100;
    owner.format = owner.audible.as_ref().unwrap().plan.format;
    let format = owner.format;
    owner.rendered_until.insert(1, 1);
    owner
        .render(ProducerEvent::EpochEnd {
            epoch: 1,
            format,
            end_frame: 1,
        })
        .await
        .unwrap();
    assert_eq!(owner.epoch_ends.get(&1), Some(&(format, 1)));
    assert_eq!(
        Owner::end_time(&owner.audible.as_ref().unwrap().plan, 1).unwrap(),
        22_676
    );
    owner
        .render(ProducerEvent::EpochEnd {
            epoch: 1,
            format,
            end_frame: 1,
        })
        .await
        .unwrap();
    let error = owner
        .render(ProducerEvent::EpochEnd {
            epoch: 1,
            format,
            end_frame: 2,
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "room_producer_end_conflict");
    assert_eq!(owner.epoch_ends.get(&1), Some(&(format, 1)));
    owner.rendered_until.insert(1, 2);
    let error = owner
        .render(ProducerEvent::EpochEnd {
            epoch: 1,
            format,
            end_frame: 2,
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "room_producer_end_conflict");
    assert_eq!(
        owner.epoch_ends.get(&1),
        Some(&(format, 1)),
        "conflicting E must not replace the original fact"
    );
    tests::finish_owner(owner, audio).await;
}

#[tokio::test]
async fn native_interruption_preserves_the_published_prefix_until_its_control_cutoff() {
    let (mut owner, audio, _render, _inbound) = tests::playing_owner().await;
    owner.format_mode = FormatMode::Native;
    owner.audible.as_mut().unwrap().plan.format.sample_rate = 44_100;
    owner.format = owner.audible.as_ref().unwrap().plan.format;
    owner.rendered_until.insert(1, 44_100);
    let plan = owner.audible.as_ref().unwrap().plan.clone();
    let at = Owner::end_time(&plan, 44_100).unwrap();
    owner
        .render(ProducerEvent::Interrupted {
            epoch: 1,
            frame: 44_100,
            instance: 1,
            position_frames: 44_100,
            message: "decoder damaged after published prefix".into(),
        })
        .await
        .unwrap();
    assert_eq!(owner.epoch_cutoffs.get(&1), Some(&44_100));
    assert!(
        !owner.epoch_ends.contains_key(&1),
        "failure is not natural EOF"
    );
    assert!(owner.audible.as_ref().unwrap().target.playing);
    assert_eq!(owner.rendered_until.get(&1), Some(&44_100));
    owner.advance(at - 1).await.unwrap();
    assert!(owner.audible.as_ref().unwrap().target.playing);
    owner.advance(at).await.unwrap();
    assert!(!owner.audible.as_ref().unwrap().target.playing);
    assert_eq!(owner.audible.as_ref().unwrap().position_frames, 44_100);
    assert!(owner.candidate.is_none());
    assert_eq!(*owner.state.cursor.lock().await, Some(0));
    assert_eq!(
        owner.error.as_deref(),
        Some("decoder damaged after published prefix")
    );
    tests::finish_owner(owner, audio).await;
}

#[tokio::test]
async fn native_rejected_successor_is_retained_and_eof_does_not_redraw_the_queue() {
    let (mut owner, audio, _render, _inbound) = tests::playing_owner().await;
    owner.format_mode = FormatMode::Native;
    owner.mode = PlayMode::Shuffle;
    owner.instances = vec![1, 2, 3];
    *owner.state.queue.lock().await = vec!["a".into(), "b".into(), "c".into()];
    owner.successor_targets.insert(
        1,
        SuccessorTarget {
            current: 1,
            next: 2,
        },
    );
    owner.deferred_successors.insert(
        1,
        DeferredSuccessor::Rejected {
            instance: 2,
            token: 1,
            library_revision: 0,
            error: RoomError::new(
                "native_source_rate_unsupported",
                "selected successor rejected",
            ),
        },
    );
    owner.epoch_ends.insert(1, (owner.format, 48_000));
    let token = owner.next_job;
    owner.prepare_successor_for(1, 1).await.unwrap();
    assert_eq!(owner.next_job, token);
    assert_eq!(owner.successor_targets.get(&1).unwrap().next, 2);
    owner
        .render(ProducerEvent::End {
            epoch: 1,
            frame: 48_000,
            instance: 1,
            position_frames: 48_000,
        })
        .await
        .unwrap();
    owner.advance(1_000_000_000).await.unwrap();
    assert!(!owner.audible.as_ref().unwrap().target.playing);
    assert_eq!(owner.audible.as_ref().unwrap().target.track.0, 1);
    assert_eq!(owner.audible.as_ref().unwrap().position_frames, 48_000);
    assert_eq!(owner.successor_targets.get(&1).unwrap().next, 2);
    assert!(matches!(
        owner.deferred_successors.get(&1),
        Some(DeferredSuccessor::Rejected { instance: 2, .. })
    ));
    assert_eq!(*owner.state.cursor.lock().await, Some(0));
    assert!(owner.candidate.is_none());
    assert_eq!(owner.error.as_deref(), Some("selected successor rejected"));
    tests::finish_owner(owner, audio).await;
}

#[tokio::test]
async fn native_current_format_changes_at_presentation_and_old_end_wins_a_same_time_tie() {
    let (mut owner, audio, _render, _inbound) = tests::playing_owner().await;
    owner.format_mode = FormatMode::Native;
    owner.instances = vec![1, 2];
    *owner.state.queue.lock().await = vec!["a".into(), "b".into()];
    owner.render_heads.clear();
    owner.audible.as_mut().unwrap().plan.format.sample_rate = 44_100;
    let old = owner.audible.as_ref().unwrap().plan.clone();
    owner.format = old.format;
    owner.source_formats.insert(1, (44_100, Some(44_100)));
    owner.source_formats.insert(2, (48_000, Some(48_000)));
    let at = Owner::end_time(&old, 1).unwrap();
    let format = AudioFormat {
        id: 2,
        sample_rate: 48_000,
        channels: 2,
    };
    owner.scheduled = Some(Audible {
        plan: Plan {
            epoch: Counter(2),
            plan_id: Counter(2),
            anchor_ns: Counter(at),
            join_frame: Counter(0),
            format,
        },
        target: PlanTarget {
            track: TrackInstanceId(2),
            position_ms: 0,
            playing: true,
        },
        position_frames: 0,
        position_at_ns: at,
        preserve_position: false,
    });
    owner.epoch_ends.insert(1, (old.format, 1));
    owner
        .render(ProducerEvent::End {
            epoch: 1,
            frame: 1,
            instance: 1,
            position_frames: 1,
        })
        .await
        .unwrap();
    owner.advance(at - 1).await.unwrap();
    assert_eq!(owner.format, old.format);
    assert_eq!(owner.audible.as_ref().unwrap().target.track.0, 1);
    assert!(owner.audible.as_ref().unwrap().target.playing);
    assert_eq!(*owner.state.cursor.lock().await, Some(0));
    owner.advance(at).await.unwrap();
    assert_eq!(owner.format, format);
    assert_eq!(owner.audible.as_ref().unwrap().target.track.0, 2);
    assert!(
        owner.audible.as_ref().unwrap().target.playing,
        "old End must not stop the new epoch"
    );
    assert_eq!(owner.audible.as_ref().unwrap().position_frames, 0);
    assert!(owner.scheduled.is_none());
    assert!(owner.boundaries.front().is_none());
    assert_eq!(*owner.state.cursor.lock().await, Some(1));
    owner.advance(at + 1).await.unwrap();
    assert_eq!(owner.audible.as_ref().unwrap().target.track.0, 2);
    tests::finish_owner(owner, audio).await;
}

struct LocalWave(std::path::PathBuf);
impl Drop for LocalWave {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn local_wave() -> LocalWave {
    let rate = 96_000u32;
    let mut wave = Vec::new();
    wave.extend_from_slice(b"RIFF");
    wave.extend_from_slice(&44u32.to_le_bytes());
    wave.extend_from_slice(b"WAVEfmt ");
    wave.extend_from_slice(&16u32.to_le_bytes());
    wave.extend_from_slice(&1u16.to_le_bytes());
    wave.extend_from_slice(&2u16.to_le_bytes());
    wave.extend_from_slice(&rate.to_le_bytes());
    wave.extend_from_slice(&(rate * 4).to_le_bytes());
    wave.extend_from_slice(&4u16.to_le_bytes());
    wave.extend_from_slice(&16u16.to_le_bytes());
    wave.extend_from_slice(b"data");
    wave.extend_from_slice(&8u32.to_le_bytes());
    for _ in 0..4 {
        wave.extend_from_slice(&4096i16.to_le_bytes());
    }
    let path = std::env::temp_dir().join(format!("hertz-native-intent-{}.wav", Uuid::new_v4()));
    std::fs::write(&path, wave).unwrap();
    LocalWave(path)
}

#[tokio::test]
async fn native_third_source_is_only_an_intent_until_a_slot_frees_then_consumes_that_choice() {
    let (mut owner, audio, _render, _inbound) = tests::playing_owner().await;
    let fixture = share_local_wave(&mut owner, "c").await;
    owner.format_mode = FormatMode::Native;
    owner.instances = vec![1, 2, 3];
    *owner.state.queue.lock().await = vec!["a".into(), "b".into(), "c".into()];
    let format = AudioFormat {
        id: 2,
        sample_rate: 48_000,
        channels: 2,
    };
    owner.scheduled = Some(Audible {
        plan: Plan {
            epoch: Counter(2),
            plan_id: Counter(2),
            anchor_ns: Counter(1_000_000_000),
            join_frame: Counter(0),
            format,
        },
        target: PlanTarget {
            track: TrackInstanceId(2),
            position_ms: 0,
            playing: true,
        },
        position_frames: 0,
        position_at_ns: 1_000_000_000,
        preserve_position: false,
    });
    owner.render_heads.insert(2, 2);
    let next_job = owner.next_job;
    owner.prepare_successor_for(2, 2).await.unwrap();
    assert_eq!(owner.successor_targets.get(&2).unwrap().next, 3);
    assert_eq!(owner.next_job, next_job);
    assert!(!owner.source_jobs.contains_key(&(1, 2)));
    assert!(!owner.successor_tokens.contains_key(&2));
    assert_eq!(
        owner.native_budget.usage().bytes,
        0,
        "third intent must not prewarm a decoder"
    );
    owner.advance(1_000_000_000).await.unwrap();
    owner.rendered_until.insert(2, 1);
    owner
        .render(ProducerEvent::EpochEnd {
            epoch: 2,
            format,
            end_frame: 1,
        })
        .await
        .unwrap();
    owner
        .render(ProducerEvent::End {
            epoch: 2,
            frame: 1,
            instance: 2,
            position_frames: 1,
        })
        .await
        .unwrap();
    owner.advance(1_000_020_834).await.unwrap();
    if owner.candidate.is_none() {
        // Presentation freed the slot and started one successor worker. Its
        // completion, rather than EOF alone, makes the prepared source usable.
        assert!(owner.source_jobs.contains_key(&(1, 2)));
        let completion =
            tokio::time::timeout(std::time::Duration::from_secs(5), owner.jobs.join_next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        owner.complete(completion).await.unwrap();
    }
    assert_eq!(
        owner
            .candidate
            .as_ref()
            .map(|candidate| candidate.target.track.0),
        Some(3),
        "finite second epoch must consume its reserved third instance after capacity frees"
    );
    assert_eq!(
        owner.next_job,
        next_job + 1,
        "the reserved third instance must be prepared exactly once"
    );
    assert_eq!(
        *owner.state.cursor.lock().await,
        Some(1),
        "uncommitted third source must not advance presentation"
    );
    tests::finish_owner(owner, audio).await;
    drop(fixture);
}

async fn share_local_wave(owner: &mut Owner, track_id: &str) -> LocalWave {
    sqlx::migrate!("../../migrations")
        .run(&owner.state.db)
        .await
        .unwrap();
    let fixture = local_wave();
    let track = vmusic_core::Track {
        id: track_id.into(),
        path: fixture.0.to_string_lossy().into(),
        source: vmusic_core::TrackSource::Local,
        title: "third native fixture".into(),
        artist: None,
        album: None,
        duration_ms: Some(0),
        bitrate: None,
        sample_rate: Some(96_000),
        channels: Some(2),
        has_cover: false,
        file_mtime: None,
        file_size: Some(52),
        added_at: 0,
    };
    vmusic_store::upsert_track(&owner.state.db, &track)
        .await
        .unwrap();
    let library = owner
        .library
        .prepare_replace(&owner.state, vec![track_id.into()])
        .await
        .unwrap();
    owner.library.commit_replace(library).await.unwrap();
    fixture
}

#[tokio::test]
async fn fixed_stale_share_completion_restarts_preparation_for_the_same_successor() {
    let (mut owner, audio, _render, _inbound) = tests::playing_owner().await;
    let fixture = share_local_wave(&mut owner, "b").await;
    owner.instances = vec![1, 2];
    *owner.state.queue.lock().await = vec!["a".into(), "b".into()];
    owner.successor_targets.insert(
        1,
        SuccessorTarget {
            current: 1,
            next: 2,
        },
    );
    owner.successor_tokens.insert(1, 42);
    let stale_revision = owner.library.revision().await.checked_add(1).unwrap();
    let next_job = owner.next_job;
    owner
        .complete(Completion::Successor {
            epoch: 1,
            current: 1,
            token: 42,
            library_revision: stale_revision,
            result: Err(RoomError::new("obsolete_job", "obsolete result")),
        })
        .await
        .unwrap();
    assert_eq!(owner.successor_targets.get(&1).unwrap().next, 2);
    assert_eq!(
        owner.successor_tokens.get(&1),
        Some(&next_job),
        "fixed must restart the source job rather than stop at desired-target equality"
    );
    assert!(owner.source_jobs.contains_key(&(1, 1)));
    tests::finish_owner(owner, audio).await;
    drop(fixture);
}

#[tokio::test]
async fn native_old_end_reaches_members_that_already_prepared_the_next_epoch() {
    old_terminal_fact_reaches_only_declared_members(true).await;
}

#[tokio::test]
async fn native_old_interruption_cannot_revoke_a_member_that_only_prepared_the_next_epoch() {
    old_terminal_fact_reaches_only_declared_members(false).await;
}

async fn old_terminal_fact_reaches_only_declared_members(natural: bool) {
    let (mut owner, audio, _render, _inbound) =
        tests::playing_owner_configured(FormatMode::Native).await;
    let old = owner.audible.as_ref().unwrap().plan.clone();
    let next = Plan {
        epoch: Counter(2),
        plan_id: Counter(2),
        anchor_ns: Counter(2_000_000_000),
        join_frame: Counter(0),
        format: AudioFormat {
            id: 2,
            sample_rate: 96_000,
            channels: 2,
        },
    };
    owner.scheduled = Some(Audible {
        plan: next.clone(),
        target: PlanTarget {
            track: TrackInstanceId(2),
            position_ms: 0,
            playing: true,
        },
        position_frames: 0,
        position_at_ns: next.anchor_ns.0,
        preserve_position: false,
    });
    let mut clients = Vec::new();
    for (index, name) in ["Old and next", "Only next"].into_iter().enumerate() {
        let invitation = owner.server.transport.invite(Default::default()).unwrap();
        let paired = vmusic_lan::client::pair(
            owner.server.address,
            owner.server.fingerprint,
            owner.local_identity.room_id,
            &invitation,
            name,
        )
        .await
        .unwrap();
        let (connection, mut events) = vmusic_lan::client::ClientConnection::connect(
            owner.server.address,
            owner.server.fingerprint,
            owner.local_identity.room_id,
            paired.member_id,
            &paired.credential,
        )
        .await
        .unwrap();
        owner
            .network(Inbound::Connected {
                member_id: paired.member_id,
                identity: connection.handle.identity,
            })
            .await
            .unwrap();
        owner.endpoints.get_mut(&paired.member_id).unwrap().audio = true;
        if index == 0 {
            assert!(owner
                .send_plan_frame(
                    paired.member_id,
                    &ControlFrame::Prepare { plan: old.clone() }
                )
                .unwrap());
            assert!(
                matches!(tokio::time::timeout(std::time::Duration::from_secs(2), events.control.recv()).await.unwrap(), Some(ControlFrame::Prepare { plan }) if plan == old)
            );
        }
        assert!(owner
            .send_plan_frame(
                paired.member_id,
                &ControlFrame::Prepare { plan: next.clone() }
            )
            .unwrap());
        owner.endpoints.get_mut(&paired.member_id).unwrap().plan = Some(next.clone());
        assert!(
            matches!(tokio::time::timeout(std::time::Duration::from_secs(2), events.control.recv()).await.unwrap(), Some(ControlFrame::Prepare { plan }) if plan == next)
        );
        clients.push((connection, events));
    }
    owner.rendered_until.insert(old.epoch.0, 48_000);
    let event = if natural {
        ProducerEvent::EpochEnd {
            epoch: old.epoch.0,
            format: old.format,
            end_frame: 48_000,
        }
    } else {
        ProducerEvent::Interrupted {
            epoch: old.epoch.0,
            frame: 48_000,
            instance: 1,
            position_frames: 48_000,
            message: "old decoder stopped".into(),
        }
    };
    owner.render(event).await.unwrap();
    let received = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        clients[0].1.control.recv(),
    )
    .await
    .unwrap();
    if natural {
        assert!(matches!(
            received,
            Some(ControlFrame::EpochEnd {
                epoch: Counter(1),
                end_frame: Counter(48_000),
                ..
            })
        ));
    } else {
        assert!(matches!(
            received,
            Some(ControlFrame::Suspend {
                epoch: Counter(1),
                ..
            })
        ));
    }
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            clients[1].1.control.recv()
        )
        .await
        .is_err(),
        "a member that never declared A must not receive A's terminal fact"
    );
    for (connection, _) in clients {
        connection.shutdown().await;
    }
    tests::finish_owner(owner, audio).await;
}

#[tokio::test]
async fn native_queue_removal_invalidates_both_rejected_and_prepared_successors() {
    for prepared in [false, true] {
        let (mut owner, audio, _render, _inbound) =
            tests::playing_owner_configured(FormatMode::Native).await;
        let fixture = local_wave();
        owner.instances = vec![1, 3];
        *owner.state.queue.lock().await = vec!["a".into(), "c".into()];
        owner.successor_targets.insert(
            1,
            SuccessorTarget {
                current: 1,
                next: 2,
            },
        );
        if prepared {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            let input = crate::online::progressive::FileMediaSource::open(&fixture.0).unwrap();
            let mut media = vmusic_audio::render::PreparedMedia::open_native_interruptible(
                Box::new(input),
                Some("wav"),
                Arc::new(AtomicBool::new(false)),
                owner.native_budget.clone(),
                deadline,
            )
            .unwrap();
            media
                .validate_native(owner.native_budget.clone(), deadline)
                .unwrap();
            owner.deferred_successors.insert(
                1,
                DeferredSuccessor::Prepared(Box::new(Source {
                    path: fixture.0.clone(),
                    media: Some(media),
                    instance: 2,
                    position_ms: 0,
                    track_gain_db: 0.0,
                })),
            );
            assert!(owner.native_budget.usage().bytes > 0);
        } else {
            owner.deferred_successors.insert(
                1,
                DeferredSuccessor::Rejected {
                    instance: 2,
                    token: 42,
                    library_revision: 0,
                    error: RoomError::new("native_successor_rejected", "old rejected target"),
                },
            );
        }
        owner.successor_tokens.insert(1, 42);
        owner.epoch_ends.insert(1, (owner.format, 48_000));
        owner.prepare_successor_for(1, 1).await.unwrap();
        assert_eq!(owner.successor_targets.get(&1).unwrap().next, 3);
        assert!(matches!(
            owner.deferred_successors.get(&1),
            Some(DeferredSuccessor::Rejected { instance: 3, .. })
        ));
        assert!(!owner.successor_tokens.contains_key(&1));
        assert_eq!(
            owner.native_budget.usage().bytes,
            0,
            "removed prepared media must release its actual reservation"
        );
        tests::finish_owner(owner, audio).await;
    }
}

#[tokio::test]
async fn native_stale_share_completion_preserves_the_selected_instance_after_sealing() {
    let (mut owner, audio, _render, _inbound) =
        tests::playing_owner_configured(FormatMode::Native).await;
    owner.mode = PlayMode::Shuffle;
    owner.instances = vec![1, 2, 3];
    *owner.state.queue.lock().await = vec!["a".into(), "b".into(), "c".into()];
    owner.successor_targets.insert(
        1,
        SuccessorTarget {
            current: 1,
            next: 3,
        },
    );
    owner.successor_tokens.insert(1, 42);
    owner.epoch_ends.insert(1, (owner.format, 48_000));
    let stale_revision = owner.library.revision().await.checked_add(1).unwrap();
    owner
        .complete(Completion::Successor {
            epoch: 1,
            current: 1,
            token: 42,
            library_revision: stale_revision,
            result: Err(RoomError::new("obsolete_job", "obsolete result")),
        })
        .await
        .unwrap();
    assert_eq!(
        owner.successor_targets.get(&1).unwrap().next,
        3,
        "revision changes must preserve the exact selection, including Shuffle after E"
    );
    assert!(
        matches!(
            owner.deferred_successors.get(&1),
            Some(DeferredSuccessor::Rejected { instance: 3, .. })
        ),
        "revoked selected source must be visibly rejected instead of lost or skipped"
    );
    assert_eq!(owner.audible.as_ref().unwrap().target.track.0, 1);
    tests::finish_owner(owner, audio).await;
}
