// SPDX-License-Identifier: MIT
//! Shared online playback intent: both transports delegate preparation and start here.
use crate::{
    error::{bad_request, ApiResult},
    online,
    state::{AppState, OnlineMetaSnap, PlayTrigger},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{atomic::Ordering, Arc};

#[derive(Debug, Deserialize)]
pub(crate) struct OnlinePlayRequest {
    pub(crate) source: Option<String>,
    /// 旧单曲形态的曲目 id；新整盘形态只给 tracks。两者都缺时回 400。
    #[serde(default)]
    pub(crate) id: Option<String>,
    /// 旧单曲形态的元数据回显字段。
    pub(crate) title: Option<String>,
    pub(crate) artist: Option<String>,
    pub(crate) album: Option<String>,
    pub(crate) duration_ms: Option<u64>,
    // Task 9 起音质以服务端逐源偏好（settings online_quality）为权威，请求体
    // 里的单次 quality 不再读取；保留字段以兼容旧客户端入参，待播放端点版本
    // 演进时连同旧单曲形态一起评估移除。
    #[allow(dead_code)]
    pub(crate) quality: Option<u32>,
    /// 整盘形态：一整首歌单/专辑的曲目列表，当前曲由 index 指定。
    #[serde(default)]
    pub(crate) tracks: Option<Vec<OnlinePlayTrack>>,
    /// F2 集合意图：前端只发 {kind,id}（目前 kind 只认 "playlist"），首页与
    /// 之后的续载都由服务端取。给了 collection 就忽略 tracks/id 单曲形态。
    #[serde(default)]
    pub(crate) collection: Option<OnlinePlayCollection>,
    #[serde(default)]
    pub(crate) index: Option<usize>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::tests::playback_state;

    fn request(id: &str) -> OnlinePlayRequest {
        serde_json::from_value(json!({"source":"netease","collection":{"kind":"playlist","id":id}}))
            .unwrap()
    }

    fn page(id: &str) -> online::PlaylistDetail {
        online::PlaylistDetail {
            playlist: Default::default(),
            total: 100,
            tracks: vec![online::OnlineTrack {
                source: "netease".into(),
                id: id.into(),
                title: format!("title {id}"),
                artist: "artist".into(),
                album: String::new(),
                cover: None,
                duration_ms: 1000,
                playable: true,
                vip_only: false,
                track_ref: json!({"id":id}),
            }],
        }
    }

    #[tokio::test]
    async fn delayed_first_page_cannot_replace_a_new_queue_or_its_metadata() {
        let (state, handle) = playback_state().await;
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        let old = state.prepare_online_play(request("old"), async {
            entered.send(()).unwrap();
            release_rx.await.unwrap();
            Ok(page("old-track"))
        });
        let new = async {
            entered_rx.await.unwrap();
            state
                .prepare_online_play(request("new"), std::future::ready(Ok(page("new-track"))))
                .await
                .unwrap()
                .unwrap();
            release.send(()).unwrap();
        };
        let (old_result, ()) = tokio::join!(old, new);
        assert!(old_result.unwrap().is_none());
        assert_eq!(*state.queue.lock().await, vec!["online:netease:new-track"]);
        assert!(state
            .online_meta
            .lock()
            .await
            .get("online:netease:old-track")
            .is_none());
        assert_eq!(state.collection_status().await.unwrap().1, "new");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn stale_first_page_error_does_not_fail_the_new_intent() {
        let (state, handle) = playback_state().await;
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = tokio::sync::oneshot::channel();
        let old = state.prepare_online_play(request("same"), async {
            entered.send(()).unwrap();
            release_rx.await.unwrap();
            Err(crate::error::ApiError::upstream_rejected("late"))
        });
        let new = async {
            entered_rx.await.unwrap();
            let fresh = state
                .prepare_online_play(request("same"), std::future::ready(Ok(page("fresh"))))
                .await
                .unwrap()
                .unwrap();
            release.send(()).unwrap();
            fresh
        };
        let (old_result, fresh) = tokio::join!(old, new);
        assert!(old_result.unwrap().is_none());
        assert_eq!(
            state.play_generation.load(Ordering::Relaxed),
            fresh.generation
        );
        assert_eq!(state.collection_status().await.unwrap().1, "same");
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn a_failed_first_page_preserves_the_existing_prepared_queue() {
        let (state, handle) = playback_state().await;
        state.set_queue(vec!["kept".into()], Some(0)).await;
        let err = state
            .prepare_online_play(
                request("new"),
                std::future::ready(Err(crate::error::ApiError::upstream_rejected("offline"))),
            )
            .await;
        assert!(err.is_err());
        assert_eq!(*state.queue.lock().await, vec!["kept"]);
        assert_eq!(*state.cursor.lock().await, Some(0));
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn stale_starter_cannot_cancel_a_new_collection() {
        let (state, handle) = playback_state().await;
        let old = state
            .prepare_online_play(request("old"), std::future::ready(Ok(page("old"))))
            .await
            .unwrap()
            .unwrap();
        let new = state
            .prepare_online_play(request("new"), std::future::ready(Ok(page("new"))))
            .await
            .unwrap()
            .unwrap();
        let outcome = state
            .play_index_for(old.index, Some(old.generation), PlayTrigger::Pick)
            .await
            .unwrap();
        assert!(!outcome.committed);
        assert_eq!(state.collection_status().await.unwrap().1, "new");
        assert_eq!(*state.queue.lock().await, new.vids);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn a_new_direct_selection_resets_old_relay_provenance() {
        let (state, handle) = playback_state().await;
        state.remember_online_meta("online:qq:t1".into(), serde_json::from_value(json!({
            "title": "previous relay", "origin": {"source":"netease","id":"n1","label":"网易云音乐"}
        })).unwrap()).await;
        let request =
            serde_json::from_value(json!({"source":"qq","id":"t1","title":"direct selection"}))
                .unwrap();
        state
            .prepare_online_play(request, std::future::pending())
            .await
            .unwrap()
            .unwrap();
        let (origin, relayed) = state.online_origin("online:qq:t1").await.unwrap();
        assert_eq!(origin.source, "qq");
        assert_eq!(origin.id, "t1");
        assert!(!relayed);
        state.audio.shutdown();
        handle.join().unwrap();
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct OnlinePlayCollection {
    pub(crate) kind: String,
    pub(crate) id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct OnlinePlayTrack {
    pub(crate) id: String,
    pub(crate) title: Option<String>,
    pub(crate) artist: Option<String>,
    pub(crate) album: Option<String>,
    pub(crate) duration_ms: Option<u64>,
    pub(crate) cover: Option<String>,
    /// 搜索/歌单结果里随曲目带来的平台原始引用（QQ media_mid 等），
    /// 取流时原样透传给平台模块；JSON 字段名与 OnlineTrack 一致为 ref。
    ///
    /// Task 9 起队列只存虚拟 id、播放按稳定 id 取流，暂不读取本字段；
    /// 仍须接收以免 serde 拒绝前端载荷，后续首曲最优音质透传恢复时启用。
    #[serde(default, rename = "ref")]
    #[allow(dead_code)]
    pub(crate) track_ref: Option<online::TrackRef>,
}

pub(crate) struct PreparedOnlinePlay {
    source: String,
    tracks: Vec<OnlinePlayTrack>,
    vids: Vec<String>,
    index: usize,
    generation: usize,
    collection: Option<(String, u64)>,
}

impl AppState {
    /// Reserve before the first remote await; a delayed first page cannot replace a newer intent.
    async fn reserve_online_intent(&self) -> usize {
        let _commit = self.play_commit.lock().await;
        self.cancel_prepared_playback().await;
        let mut load = self.playlist_load.lock().await;
        load.session = load.session.wrapping_add(1);
        load.active = None;
        self.play_generation
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1)
    }

    async fn prepare_online_play<F>(
        &self,
        request: OnlinePlayRequest,
        first_page: F,
    ) -> ApiResult<Option<PreparedOnlinePlay>>
    where
        F: std::future::Future<Output = ApiResult<online::PlaylistDetail>>,
    {
        let source = request
            .source
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| online::SOURCES[0].id.to_string());
        if let Some(coll) = &request.collection {
            if coll.kind != "playlist" {
                return Err(bad_request("整单播放目前只支持歌单"));
            }
            if coll.id.trim().is_empty() {
                return Err(bad_request("缺少集合 id"));
            }
        }
        let mut tracks = request.tracks.unwrap_or_default();
        if request.collection.is_none() && tracks.is_empty() {
            let id = request.id.unwrap_or_default().trim().to_string();
            if id.is_empty() {
                return Err(bad_request("缺少曲目 id"));
            }
            tracks.push(OnlinePlayTrack {
                id,
                title: request.title,
                artist: request.artist,
                album: request.album,
                duration_ms: request.duration_ms,
                cover: None,
                track_ref: None,
            });
        }
        if request.collection.is_none() && tracks.iter().any(|t| t.id.trim().is_empty()) {
            return Err(bad_request("tracks 中存在缺少 id 的曲目"));
        }
        let reservation = self.reserve_online_intent().await;
        let collection = if let Some(coll) = request.collection {
            let result = first_page.await;
            // Stale errors must be as harmless as stale successes.
            if self.play_generation.load(Ordering::Relaxed) != reservation {
                return Ok(None);
            }
            let detail = result?;
            if detail.tracks.is_empty() {
                return Err(crate::error::not_found("歌单为空或暂不可用"));
            }
            tracks = detail
                .tracks
                .into_iter()
                .map(|t| OnlinePlayTrack {
                    id: t.id,
                    title: Some(t.title),
                    artist: Some(t.artist),
                    album: Some(t.album),
                    duration_ms: Some(t.duration_ms),
                    cover: t.cover,
                    track_ref: Some(t.track_ref),
                })
                .collect();
            Some((coll.id.trim().to_string(), detail.total))
        } else {
            None
        };
        if tracks.iter().any(|t| t.id.trim().is_empty()) {
            return Err(bad_request("tracks 中存在缺少 id 的曲目"));
        }
        let index = request
            .index
            .unwrap_or(0)
            .min(tracks.len().saturating_sub(1));
        let vids: Vec<_> = tracks
            .iter()
            .map(|t| online::virtual_id(&source, &t.id))
            .collect();
        let _commit = self.play_commit.lock().await;
        if self.play_generation.load(Ordering::Relaxed) != reservation {
            return Ok(None);
        }
        let (generation, _, _) = self.set_queue_locked(vids.clone(), Some(index)).await;
        for (t, vid) in tracks.iter().zip(&vids) {
            self.remember_online_meta(
                vid.clone(),
                OnlineMetaSnap {
                    title: t.title.clone().unwrap_or_else(|| t.id.clone()),
                    artist: t.artist.clone(),
                    album: t.album.clone(),
                    cover: t.cover.clone(),
                    duration_ms: t.duration_ms.filter(|v| *v > 0),
                    rg_gain_db: None,
                    rg_peak: None,
                    // This is a new user selection, not a restoration of an old relay.
                    origin: Some(crate::state::OnlineOrigin {
                        source: source.clone(),
                        id: t.id.clone(),
                        label: online::find(&source).map(|s| s.label.to_string()),
                    }),
                },
            )
            .await;
        }
        if let Some((id, total)) = &collection {
            self.begin_collection_load_locked(&source, id, *total, tracks.len())
                .await;
        }
        Ok(Some(PreparedOnlinePlay {
            source,
            tracks,
            vids,
            index,
            generation,
            collection,
        }))
    }

    pub(crate) async fn start_online_play(
        self: &Arc<Self>,
        request: OnlinePlayRequest,
    ) -> ApiResult<Option<Value>> {
        let source = request
            .source
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| online::SOURCES[0].id.to_string());
        let id = request
            .collection
            .as_ref()
            .map(|c| c.id.trim().to_string())
            .unwrap_or_default();
        let ctx = online::Ctx {
            db: self.db.clone(),
        };
        let first_page = online::playlist_detail(&ctx, &source, &id, 0, crate::collection::PAGE);
        let Some(prepared) = self.prepare_online_play(request, first_page).await? else {
            return Ok(None);
        };
        let PreparedOnlinePlay {
            source,
            tracks,
            vids,
            index,
            generation,
            collection,
        } = prepared;
        let outcome = self
            .play_index_for(index, Some(generation), PlayTrigger::Pick)
            .await?;
        // Replacement itself invalidates the old collection. A stale starter has nothing to cancel.
        if !outcome.committed
            || self.play_generation.load(Ordering::Relaxed) != generation.saturating_add(1)
        {
            return Ok(None);
        }
        self.post_commit_background();
        let current = &tracks[index];
        let cover = match &current.cover {
            Some(c) if !c.is_empty() => Some(c.clone()),
            _ => online::detail(&ctx, &source, &current.id)
                .await
                .ok()
                .and_then(|d| d.cover),
        };
        if self.play_generation.load(Ordering::Relaxed) != generation.saturating_add(1) {
            return Ok(None);
        }
        let (origin, relayed) = match self.online_origin(&vids[index]).await {
            Some((origin, relayed)) => (Some(origin), relayed),
            None => (None, false),
        };
        Ok(Some(json!({
            "ok": true, "track_id": vids[index], "track_ids": vids, "index": index,
            "source": source, "id": current.id, "title": current.title.clone().unwrap_or_default(),
            "artist": current.artist.clone().unwrap_or_default(), "album": current.album.clone().unwrap_or_default(),
            "duration_ms": current.duration_ms.unwrap_or(0), "cover": cover,
            "actual_quality": outcome.actual_quality.map(|q| q.as_str()), "origin": origin, "relayed": relayed,
            "collection": collection.as_ref().map(|(id, total)| json!({ "kind": "playlist", "id": id, "loaded": tracks.len(), "total": total })),
            "tracks": collection.as_ref().map(|_| tracks.iter().map(|t| json!({ "id": t.id, "title": t.title,
                "artist": t.artist, "album": t.album, "duration_ms": t.duration_ms, "cover": t.cover })).collect::<Vec<_>>()),
        })))
    }
}
