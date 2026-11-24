// SPDX-License-Identifier: MIT
//! Playback adoption of verified source handles by the original playback owner.
use crate::{
    audio_loudness::GainSelection,
    error::{bad_request, ApiError},
    state::AppState,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use vmusic_core::{
    audio_quality::{LoudnessSource, QualityConfig},
    CoreError, PlayerSnapshot,
};

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Applied {
    pub generation: u64,
    pub source_generation: u64,
    pub track_id: String,
    pub gain_db: f32,
    pub state: String,
    pub target_lufs: f32,
    pub album: bool,
    pub selection: Option<GainSelection>,
}
impl Applied {
    pub(crate) fn matches(&self, snapshot: &PlayerSnapshot) -> bool {
        self.source_generation == snapshot.source_generation
            && snapshot.track_id.as_deref() == Some(&self.track_id)
    }
    pub(crate) fn from_selection(
        snapshot: &PlayerSnapshot,
        selection: GainSelection,
        config: &QualityConfig,
    ) -> Self {
        Self {
            generation: snapshot.generation,
            source_generation: snapshot.source_generation,
            track_id: snapshot.track_id.clone().unwrap_or_default(),
            gain_db: selection.gain_db as f32,
            state: selection.state.clone(),
            target_lufs: config.target_lufs,
            album: config.loudness_mode == "album",
            selection: Some(selection),
        }
    }
}

async fn core_config(state: &AppState) -> Result<QualityConfig, CoreError> {
    let settings = vmusic_store::settings::get_all(&state.db).await?;
    Ok(vmusic_store::audio_quality::from_settings(&settings)?.0)
}
pub(crate) async fn config(state: &AppState) -> Result<QualityConfig, ApiError> {
    core_config(state).await.map_err(ApiError::from)
}

pub(crate) struct LoadDecision {
    pub source: Option<(Box<dyn vmusic_core::AudioSource>, Option<String>)>,
    pub gain_db: f32,
    pub measured: Option<(GainSelection, QualityConfig)>,
}

/// Caller holds play_commit. Settings updates use that same lock, so source,
/// mode and candidate selection are one decision immediately before Load.
/// Atomic Load-with-gain prevents changing the outgoing track during I/O.
pub(crate) async fn for_load_locked(
    state: &AppState,
    id: &str,
    complete_path: Option<&Path>,
) -> Result<LoadDecision, CoreError> {
    let mut decision = LoadDecision {
        source: None,
        gain_db: 0.0,
        measured: None,
    };
    let Ok(config) = core_config(state).await else {
        return Ok(decision);
    };
    if config.loudness_mode == "off" {
        return Ok(decision);
    }
    if config.loudness_source == LoudnessSource::FileTags {
        decision.gain_db = state
            .loudness_for(id, &config.loudness_mode)
            .await
            .map_or(0.0, |(gain, _)| gain as f32);
    } else if state.scan.lock().await.running {
        state.loudness_candidates.invalidate();
    } else if let Some(candidate) = complete_path.and_then(|path| {
        state
            .loudness_candidates
            .take_for_load(id, &config.revision, path)
    }) {
        let (source, ext, gain) = candidate.into_parts();
        decision.gain_db = gain.gain_db as f32;
        decision.source = Some((source, ext));
        decision.measured = Some((gain, config));
    }
    Ok(decision)
}

pub(crate) async fn committed(state: &AppState, measured: Option<(GainSelection, QualityConfig)>) {
    let snapshot = state.audio.snapshot();
    *state.measured_loudness.lock().await =
        measured.map(|(gain, config)| Applied::from_selection(&snapshot, gain, &config));
}

pub(crate) async fn current_complete_path(
    state: &AppState,
    id: &str,
) -> Result<Option<PathBuf>, ApiError> {
    if crate::online::split_virtual_id(id).is_some() {
        return Ok(state.project_online_media(id).await);
    }
    Ok(vmusic_store::get_track(&state.db, &id.to_owned())
        .await
        .map_err(CoreError::from)?
        .filter(|track| track.source == vmusic_core::TrackSource::Local)
        .map(|track| PathBuf::from(track.path)))
}

pub(crate) fn schedule_current(state: &Arc<AppState>) {
    let state = state.clone();
    tokio::spawn(async move {
        let Ok(config) = config(&state).await else {
            return;
        };
        if config.loudness_source != LoudnessSource::R128 || config.loudness_mode == "off" {
            return;
        }
        if let Some(id) = state.audio.snapshot().track_id.clone() {
            crate::audio_loudness::schedule_candidate(
                &state,
                id,
                config.revision,
                config.target_lufs as f64,
                config.loudness_mode == "album",
            );
        }
    });
}

/// Caller holds play_commit. Current source-bound gain remains fixed; only
/// unstarted preparation and candidate identities are invalidated.
pub(crate) async fn invalidate_pending_locked(state: &AppState) {
    state.loudness_candidates.invalidate();
    state.cancel_unstarted_loudness_preparation().await;
}
pub(crate) fn invalidate_on_library_changes(state: &Arc<AppState>) {
    let mut events = state.events.subscribe();
    let weak = Arc::downgrade(state);
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(crate::state::WsEvent::LibraryChanged)
                | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let Some(state) = weak.upgrade() else {
                        break;
                    };
                    let _commit = state.play_commit.lock().await;
                    invalidate_pending_locked(&state).await;
                }
                Ok(crate::state::WsEvent::Scan { .. }) => {
                    let Some(state) = weak.upgrade() else {
                        break;
                    };
                    if state.scan.lock().await.running {
                        let _commit = state.play_commit.lock().await;
                        invalidate_pending_locked(&state).await;
                    }
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

pub(crate) async fn apply_current(state: &Arc<AppState>) -> Result<Value, ApiError> {
    state.require_local_playback()?;
    let generation = state
        .play_generation
        .load(std::sync::atomic::Ordering::SeqCst);
    let snapshot = state.audio.snapshot();
    let id = snapshot
        .track_id
        .clone()
        .ok_or_else(|| bad_request("当前没有可应用的曲目"))?;
    let config = config(state).await?;
    if config.loudness_source != LoudnessSource::R128 || config.loudness_mode == "off" {
        return Err(bad_request("先选择本机测量响度来源及模式"));
    }
    let index = (*state.cursor.lock().await).ok_or_else(|| bad_request("当前播放游标不可用"))?;
    let path = current_complete_path(state, &id).await?;
    if !path.as_deref().is_some_and(|path| {
        state
            .loudness_candidates
            .ready_for_load(&id, &config.revision, path)
    }) {
        schedule_current(state);
        return Ok(
            json!({"applied":false,"state":"preparing","message":"完整媒体尚未核验，请稍后再点应用；本次未改变播放增益"}),
        );
    }
    let outcome = state
        .replay_measured_expected(index, generation, snapshot)
        .await?;
    if !outcome.committed {
        return Ok(
            json!({"applied":false,"state":"superseded","message":"当前播放意图已改变，本次未应用"}),
        );
    }
    let now = state.audio.snapshot();
    let applied = state
        .measured_loudness
        .lock()
        .await
        .as_ref()
        .is_some_and(|a| a.matches(&now) && a.track_id == id);
    Ok(
        json!({"applied":applied,"state":if applied{"reloaded"}else{"superseded"},"message":if applied{"已通过原播放流程重新载入并接续位置"}else{"播放请求已被后续操作替代"}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn remove_dir_settled(root: std::path::PathBuf) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            match std::fs::remove_dir_all(&root) {
                Ok(()) => return,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(_) if std::time::Instant::now() < deadline => {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Err(error) => panic!("fixture directory must be removable: {error}"),
            }
        }
    }

    #[test]
    fn identity_preserves_transport_but_rejects_same_id_reload() {
        let mut snapshot = PlayerSnapshot {
            track_id: Some("same".into()),
            generation: 3,
            source_generation: 2,
            ..Default::default()
        };
        let selection = GainSelection {
            state: "ready".into(),
            gain_db: 3.0,
            requested_gain_db: Some(3.0),
            integrated_lufs: Some(-21.0),
            limited_by: None,
            album: false,
        };
        let config = vmusic_store::audio_quality::from_settings(&std::collections::BTreeMap::new())
            .unwrap()
            .0;
        let applied = Applied::from_selection(&snapshot, selection, &config);
        snapshot.generation += 4;
        assert!(applied.matches(&snapshot));
        snapshot.source_generation += 1;
        assert!(!applied.matches(&snapshot));
    }

    #[tokio::test]
    async fn load_decision_uses_current_config_without_tag_fallback_or_outgoing_mutation() {
        let dir = std::env::temp_dir().join(format!("loudness-config-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let (state, actor) = crate::state::tests::playback_state_with_db(db).await;
        let id = "online:ccmixter:measured";
        state
            .audio
            .load("outgoing.wav", Some("outgoing".into()))
            .await
            .unwrap();
        let old = state.audio.snapshot();
        state.dsp.lock().await.loudness_mode = "track".into();
        state
            .remember_online_meta(
                id.into(),
                crate::state::OnlineMetaSnap {
                    title: "tag".into(),
                    artist: None,
                    album: None,
                    cover: None,
                    duration_ms: None,
                    rg_gain_db: Some(9.0),
                    rg_peak: Some(0.1),
                    origin: None,
                },
            )
            .await;
        let mut config = vmusic_store::audio_quality::from_settings(&Default::default())
            .unwrap()
            .0;
        config.schema_version = 3;
        config.revision = "1".into();
        config.loudness_mode = "track".into();
        config.loudness_source = LoudnessSource::R128;
        config.limiter = vmusic_core::audio_quality::LimiterMode::TruePeak;
        vmusic_store::settings::set(
            &state.db,
            vmusic_store::audio_quality::KEY,
            &serde_json::to_value(&config).unwrap(),
        )
        .await
        .unwrap();
        let _commit = state.play_commit.lock().await;
        let missing = for_load_locked(&state, id, None).await.unwrap();
        assert_eq!(missing.gain_db, 0.0);
        assert!(missing.measured.is_none());
        config.revision = "2".into();
        config.loudness_source = LoudnessSource::FileTags;
        vmusic_store::settings::set(
            &state.db,
            vmusic_store::audio_quality::KEY,
            &serde_json::to_value(&config).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            for_load_locked(&state, id, None).await.unwrap().gain_db,
            9.0
        );
        config.revision = "3".into();
        config.loudness_mode = "off".into();
        vmusic_store::settings::set(
            &state.db,
            vmusic_store::audio_quality::KEY,
            &serde_json::to_value(&config).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            for_load_locked(&state, id, None).await.unwrap().gain_db,
            0.0
        );
        let current = state.audio.snapshot();
        assert_eq!(current.source_generation, old.source_generation);
        assert_eq!(current.generation, old.generation);
        assert_eq!(current.track_id, old.track_id);
        drop(_commit);
        state.audio.shutdown();
        actor.join().unwrap();
        state.db.close().await;
        remove_dir_settled(dir).await;
    }
}
