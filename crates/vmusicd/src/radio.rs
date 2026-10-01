// SPDX-License-Identifier: MIT
//! Server-owned FM queue. Network calls never hold the playback commit lock.
use crate::{
    error::{ApiError, ApiResult},
    online,
    state::{AppState, OnlineMetaSnap},
};
use serde::Serialize;
use std::sync::atomic::Ordering;

#[derive(Default, Serialize)]
pub(crate) struct Radio {
    pub active: bool,
    pub loading: bool,
    pub error: Option<String>,
    #[serde(skip)]
    pub session: usize,
    #[serde(skip)]
    pub initial_generation: Option<usize>,
    #[serde(skip)]
    last_attempt: Option<std::time::Instant>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn track(id: &str) -> online::OnlineTrack {
        online::OnlineTrack {
            source: "netease".into(),
            id: id.into(),
            title: id.into(),
            artist: "Artist".into(),
            album: String::new(),
            cover: None,
            duration_ms: 1000,
            playable: true,
            vip_only: false,
            track_ref: serde_json::json!({"id":id}),
        }
    }

    #[tokio::test]
    async fn radio_batch_is_deduplicated_and_old_session_cannot_replace_queue() {
        let (state, handle) = crate::state::tests::playback_state().await;
        let (gen, _, _) = state.set_queue(vec!["old".into()], Some(0)).await;
        {
            let mut r = state.radio.lock().await;
            r.active = true;
            r.session = 10;
            r.initial_generation = Some(gen);
        }
        state
            .radio_accept(10, Some(gen), Ok(vec![track("1"), track("1"), track("2")]))
            .await
            .unwrap();
        assert_eq!(
            *state.queue.lock().await,
            vec!["online:netease:1", "online:netease:2"]
        );
        state
            .radio_accept(10, None, Ok(vec![track("2"), track("3")]))
            .await
            .unwrap();
        assert_eq!(state.queue.lock().await.len(), 3);
        assert!(state
            .radio_accept(10, None, Ok(vec![track("3")]))
            .await
            .is_err());
        assert!(state.radio.lock().await.error.is_some());
        state.set_queue(vec!["user-choice".into()], Some(0)).await;
        state
            .radio_accept(10, None, Ok(vec![track("4")]))
            .await
            .unwrap();
        assert_eq!(*state.queue.lock().await, vec!["user-choice"]);
        assert!(!state.radio.lock().await.active);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn failed_start_preserves_queue_and_stop_invalidates_pending_start() {
        let (state, handle) = crate::state::tests::playback_state().await;
        let (gen, _, _) = state.set_queue(vec!["old".into()], Some(0)).await;
        {
            let mut r = state.radio.lock().await;
            r.active = true;
            r.session = 10;
            r.initial_generation = Some(gen);
        }
        let error = ApiError::upstream_timeout("fixture timeout");
        assert!(state.radio_accept(10, Some(gen), Err(error)).await.is_err());
        assert_eq!(*state.queue.lock().await, vec!["old"]);
        assert_eq!(state.radio_status().await["tracks"], serde_json::json!([]));
        state.radio_stop().await;
        state
            .radio_accept(10, Some(gen), Ok(vec![track("1")]))
            .await
            .unwrap();
        assert_eq!(*state.queue.lock().await, vec!["old"]);
        assert!(state.play_generation.load(Ordering::Relaxed) > gen);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn radio_tail_does_not_wrap_or_repeat() {
        let (state, handle) = crate::state::tests::playback_state().await;
        state
            .set_queue(vec!["online:netease:1".into()], Some(0))
            .await;
        {
            let mut r = state.radio.lock().await;
            r.active = true;
            r.last_attempt = Some(std::time::Instant::now());
        }
        let gen = state.play_generation.load(Ordering::Relaxed);
        state.step(1, true).await.unwrap();
        assert_eq!(state.play_generation.load(Ordering::Relaxed), gen);
        assert_eq!(state.current_index().await, Some(0));
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn radio_history_compacts_when_advancing_and_keeps_current_track() {
        let (state, handle) = crate::state::tests::playback_state().await;
        let ids: Vec<_> = (0..81).map(|i| format!("online:netease:{i}")).collect();
        state.set_queue(ids, Some(80)).await;
        {
            let mut r = state.radio.lock().await;
            r.active = true;
            r.last_attempt = Some(std::time::Instant::now());
        }
        state.step(1, true).await.unwrap();
        assert_eq!(state.queue.lock().await.len(), 21);
        assert_eq!(state.current_index().await, Some(20));
        assert_eq!(state.queue.lock().await[20], "online:netease:80");
        state.audio.shutdown();
        handle.join().unwrap();
    }
}

impl AppState {
    pub(crate) async fn radio_status(&self) -> serde_json::Value {
        let _commit = self.play_commit.lock().await;
        let radio = self.radio.lock().await;
        let ids = self.queue.lock().await;
        let metadata = self.online_meta.lock().await;
        let tracks: Vec<_> = ids
            .iter()
            .filter_map(|id| {
                let (_, song) = online::split_virtual_id(id)?;
                let m = metadata.get(id)?;
                Some(
                    serde_json::json!({"source":"netease", "id":song, "title":m.title,
                "artist":m.artist,"album":m.album,"cover":m.cover,"duration_ms":m.duration_ms}),
                )
            })
            .collect();
        serde_json::json!({"active":radio.active,"loading":radio.loading,"error":radio.error,
            "source":"netease","tracks": if radio.active && radio.initial_generation.is_none() { tracks } else { vec![] },
            "index":*self.cursor.lock().await})
    }

    pub(crate) async fn radio_start(&self) -> ApiResult<Option<usize>> {
        let (session, generation) = {
            let _commit = self.play_commit.lock().await;
            let gen = self.play_generation.fetch_add(1, Ordering::Relaxed) + 1;
            let mut radio = self.radio.lock().await;
            let session = radio.session.wrapping_add(1);
            *radio = Radio {
                active: true,
                session,
                initial_generation: Some(gen),
                ..Default::default()
            };
            (session, gen)
        };
        self.radio_refill(true).await?;
        let _commit = self.play_commit.lock().await;
        let radio = self.radio.lock().await;
        if !radio.active
            || radio.session != session
            || radio.initial_generation.is_some()
            || self.play_generation.load(Ordering::Relaxed) != generation
        {
            return Ok(None);
        }
        Ok(Some(generation))
    }

    pub(crate) async fn radio_stop(&self) {
        let _commit = self.play_commit.lock().await;
        self.play_generation.fetch_add(1, Ordering::Relaxed);
        let mut radio = self.radio.lock().await;
        radio.session = radio.session.wrapping_add(1);
        radio.active = false;
        radio.loading = false;
        radio.initial_generation = None;
        radio.error = None;
    }

    pub(crate) async fn radio_refill(&self, force: bool) -> ApiResult<()> {
        let _fetch = self.radio_fetch.lock().await;
        let (session, initial) = {
            let _commit = self.play_commit.lock().await;
            let mut radio = self.radio.lock().await;
            if !radio.active {
                return Ok(());
            }
            let len = self.queue.lock().await.len();
            let index = self.cursor.lock().await.unwrap_or(0);
            if radio.initial_generation.is_none() && len.saturating_sub(index + 1) > 2 {
                return Ok(());
            }
            if radio.initial_generation.is_none() && len >= 120 {
                return Ok(());
            }
            if !force
                && radio
                    .last_attempt
                    .is_some_and(|t| t.elapsed().as_secs() < 15)
            {
                return Ok(());
            }
            radio.loading = true;
            radio.last_attempt = Some(std::time::Instant::now());
            (radio.session, radio.initial_generation)
        };
        let result = online::personal_fm(
            &online::Ctx {
                db: self.db.clone(),
            },
            "netease",
        )
        .await;
        self.radio_accept(session, initial, result).await
    }

    pub(crate) async fn radio_accept(
        &self,
        session: usize,
        initial: Option<usize>,
        result: ApiResult<Vec<online::OnlineTrack>>,
    ) -> ApiResult<()> {
        let _commit = self.play_commit.lock().await;
        let mut radio = self.radio.lock().await;
        if !radio.active || radio.session != session {
            return Ok(());
        }
        radio.loading = false;
        if initial.is_some_and(|gen| self.play_generation.load(Ordering::Relaxed) != gen) {
            radio.active = false;
            return Ok(());
        }
        let tracks = match result {
            Ok(tracks) => tracks,
            Err(e) => {
                radio.error = Some(e.message.clone());
                return Err(e);
            }
        };
        let mut queue = self.queue.lock().await;
        let mut cursor = self.cursor.lock().await;
        let mut meta = self.online_meta.lock().await;
        let mut fresh = Vec::new();
        for t in tracks {
            let id = online::virtual_id("netease", &t.id);
            if (initial.is_none() && queue.contains(&id)) || fresh.contains(&id) {
                continue;
            }
            meta.insert(
                id.clone(),
                OnlineMetaSnap {
                    title: t.title,
                    artist: Some(t.artist),
                    album: Some(t.album),
                    cover: t.cover,
                    duration_ms: Some(t.duration_ms),
                },
            );
            fresh.push(id);
        }
        if fresh.is_empty() {
            let e = ApiError::upstream_rejected("FM 暂无新的推荐，稍后点击重试");
            radio.error = Some(e.message.clone());
            return Err(e);
        }
        if initial.is_some() {
            queue.clear();
            *cursor = Some(0);
        }
        queue.extend(fresh);
        // History is compacted by step_for while reserving a new playback generation.
        radio.initial_generation = None;
        radio.error = None;
        Ok(())
    }
}
