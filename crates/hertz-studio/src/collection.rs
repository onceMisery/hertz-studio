// SPDX-License-Identifier: MIT
//! F2 整单续载：前端只发集合意图，首页之后的服务端补页归这里。
//!
//! 形状照私人 FM（[`crate::radio`]）抄：串行锁 + 会话/代际复核 + 水位触发 +
//! 提交锁内 extend。差别有两处：取数源是 [`online::playlist_detail`] 按页翻；
//! 失效条件是 `set_queue` 即作废而**手动切曲不作废**——切曲正是需要续载的
//! 场景，所以补页任务不核播放代际，只核队列会话。
//!
//! 失败语义（评估文档 F2 的验收线）：一次补页失败不清队列、不改播放，已准备
//! 的曲目原样保留，错误随 [`WsEvent::CollectionLoad`] 发出去，下次切曲自动
//! 重试（`post_commit_background` 每次提交都会拉一遍水位）。

use std::time::{Duration, Instant};

use crate::error::ApiResult;
use crate::online;
use crate::state::{AppState, OnlineMetaSnap, WsEvent};

/// 每页抓多少首：与 HTTP 歌单端点的 clamp 上限一致，前端详情页也是这个页大小。
pub(crate) const PAGE: usize = 50;
/// 游标之后剩这么多首就提前补页：半页多一点，够几次自动切曲的反应时间，
/// 也让「播放全部」后的前几首不需要任何等待。
const WATERMARK: usize = 24;
/// 两次补页之间的最小间隔（force 绕过）：防平台抖动时的紧密重试。
const THROTTLE: Duration = Duration::from_secs(10);
/// 一张歌单最多续载多少首进队列：与前端长列表渲染上限同量级，防御平台的
/// total 异常（total=0 但页数无限的 pathological 返回）。
const LOAD_CAP: usize = 2000;

#[derive(Debug, Default)]
pub(crate) struct PlaylistLoad {
    /// 换队/关电台时 +1：补页任务每一步都要核对它，旧意图一律静默作废。
    /// 手动切曲不 bump——那不换队列，续载照常。
    pub(crate) session: usize,
    pub(crate) active: Option<ActiveLoad>,
}

#[derive(Debug)]
pub(crate) struct ActiveLoad {
    pub(crate) source: String,
    pub(crate) id: String,
    /// 下一页的 offset，也等于平台侧已翻过的曲目数（去重不入队只影响
    /// 队列长度，不影响翻页位置）。
    pub(crate) offset: usize,
    pub(crate) total: u64,
    pub(crate) last_attempt: Option<Instant>,
    pub(crate) error: Option<String>,
}

impl AppState {
    /// 登记一次整单续载意图。必须紧跟 [`AppState::set_queue`] 之后调用：
    /// set_queue 会清掉旧意图，这里凭预留代际核对「这份意图还活着」再落笔，
    /// 并发两次点播时后来者顶掉先来者。
    pub(crate) async fn begin_collection_load(
        &self,
        source: &str,
        id: &str,
        total: u64,
        loaded: usize,
        gen: usize,
    ) {
        let _commit = self.play_commit.lock().await;
        if self.play_generation.load(std::sync::atomic::Ordering::Relaxed) != gen {
            return;
        }
        self.playlist_load.lock().await.active = Some(ActiveLoad {
            source: source.to_string(),
            id: id.to_string(),
            offset: loaded,
            total,
            last_attempt: None,
            error: None,
        });
    }

    /// 起播被顶代际（用户已点别处）时撤回刚登记的意图。
    pub(crate) async fn cancel_collection_load(&self) {
        self.playlist_load.lock().await.active = None;
    }

    /// 水位不足就抓下一页并补进当前队列。`force` 供「载入中断后的手动重试」
    /// 绕过水位与节流，其余语义不变（会话失效照样作废）。
    pub(crate) async fn playlist_refill(&self, force: bool) -> ApiResult<()> {
        enum Next {
            /// 已翻满 total 或本地上限：清掉意图，等下一次集合播放重新登记。
            Exhausted,
            Fetch {
                source: String,
                id: String,
                offset: usize,
            },
        }
        let _fetch = self.playlist_fetch.lock().await;
        let next = {
            let _commit = self.play_commit.lock().await;
            let mut pl = self.playlist_load.lock().await;
            let Some(active) = pl.active.as_mut() else {
                return Ok(());
            };
            // 私人 FM 是另一种队列 owner：它在跑时补页任务让路。
            if self.radio.lock().await.active {
                return Ok(());
            }
            let queue_len = self.queue.lock().await.len();
            let cursor = *self.cursor.lock().await;
            let remaining = queue_len.saturating_sub(cursor.unwrap_or(0) + 1);
            if !force && remaining > WATERMARK {
                return Ok(());
            }
            if (active.total > 0 && active.offset as u64 >= active.total)
                || active.offset >= LOAD_CAP
            {
                Next::Exhausted
            } else if !force && active.last_attempt.is_some_and(|t| t.elapsed() < THROTTLE) {
                return Ok(());
            } else {
                active.last_attempt = Some(Instant::now());
                Next::Fetch {
                    source: active.source.clone(),
                    id: active.id.clone(),
                    offset: active.offset,
                }
            }
        };
        let (session, source, id, offset) = match next {
            Next::Exhausted => {
                self.playlist_load.lock().await.active = None;
                return Ok(());
            }
            Next::Fetch { source, id, offset } => {
                let session = self.playlist_load.lock().await.session;
                (session, source, id, offset)
            }
        };
        let result = online::playlist_detail(
            &online::Ctx {
                db: self.db.clone(),
            },
            &source,
            &id,
            offset,
            PAGE,
        )
        .await;
        self.playlist_accept(session, source, id, offset, result).await
    }

    /// 把抓到的页补进队列。进提交锁后先复核会话：期间发生过整盘换队的话，
    /// 这页数据属于旧意图，整页丢弃——宁可少补一页，不许污染新队列。
    async fn playlist_accept(
        &self,
        session: usize,
        source: String,
        id: String,
        offset: usize,
        result: ApiResult<online::PlaylistDetail>,
    ) -> ApiResult<()> {
        let _commit = self.play_commit.lock().await;
        let mut pl = self.playlist_load.lock().await;
        if pl.session != session {
            return Ok(());
        }
        let Some(active) = pl.active.as_mut() else {
            return Ok(());
        };
        if active.source != source || active.id != id {
            return Ok(());
        }
        let detail = match result {
            Ok(d) => d,
            Err(e) => {
                active.error = Some(e.message.clone());
                self.publish(WsEvent::CollectionLoad {
                    source,
                    id,
                    loaded: active.offset,
                    total: active.total,
                    done: false,
                    error: Some(e.message.clone()),
                });
                return Err(e);
            }
        };
        // 去重按完整队列（跨页重复与既已在队的请求曲都不重入），元数据与
        // 队列同一段提交锁内写入——与 radio_accept 同一姿势。
        let fetched = detail.tracks.len();
        let mut queue = self.queue.lock().await;
        let mut meta = self.online_meta.lock().await;
        let mut added = 0usize;
        for t in detail.tracks {
            let vid = online::virtual_id(&source, &t.id);
            if queue.contains(&vid) {
                continue;
            }
            meta.insert(
                vid.clone(),
                OnlineMetaSnap {
                    title: t.title,
                    artist: Some(t.artist),
                    album: Some(t.album),
                    cover: t.cover,
                    duration_ms: Some(t.duration_ms),
                    // 取流那一步才拿得到响度标签，与 FM 补页同一条注释。
                    rg_gain_db: None,
                    rg_peak: None,
                    // 补进队列的项出处就是它自己。
                    origin: None,
                },
            );
            queue.push(vid);
            added += 1;
        }
        active.offset = offset + fetched;
        active.error = None;
        // 终态判定：平台空页、整页都是重复（平台在原地打转）、翻满 total、
        // 或顶到本地上限——任何一条都算补完。
        let done = fetched == 0
            || added == 0
            || (active.total > 0 && active.offset as u64 >= active.total)
            || active.offset >= LOAD_CAP;
        let (loaded, total) = (active.offset, active.total);
        drop(queue);
        drop(meta);
        if done {
            pl.active = None;
        }
        self.publish(WsEvent::CollectionLoad {
            source,
            id,
            loaded,
            total,
            done,
            error: None,
        });
        Ok(())
    }

    /// 续载任务的当前状态，供手动重试端点回显（没有活跃意图就是 None）。
    pub(crate) async fn collection_status(&self) -> Option<(String, String, usize, u64, Option<String>)> {
        let pl = self.playlist_load.lock().await;
        pl.active.as_ref().map(|a| {
            (
                a.source.clone(),
                a.id.clone(),
                a.offset,
                a.total,
                a.error.clone(),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::tests::playback_state;

    fn track(id: &str) -> online::OnlineTrack {
        online::OnlineTrack {
            source: "netease".into(),
            id: id.into(),
            title: format!("歌 {id}"),
            artist: "Artist".into(),
            album: String::new(),
            cover: None,
            duration_ms: 1000,
            playable: true,
            vip_only: false,
            track_ref: serde_json::json!({"id": id}),
        }
    }

    /// 登记 + 直接喂一页（绕开网络），返回事件接收器供断言。
    async fn seeded(state: &AppState, gen: usize, total: u64) {
        state.begin_collection_load("netease", "pl1", total, 1, gen).await;
    }

    #[tokio::test]
    async fn accept_extends_queue_dedupes_and_publishes_progress() {
        let (state, _h) = playback_state().await;
        let mut rx = state.events.subscribe();
        let (gen, _, _) = state.set_queue(vec!["online:netease:dup".into()], Some(0)).await;
        seeded(&state, gen, 120).await;
        let session = state.playlist_load.lock().await.session;

        // 一页三首，其中一首已在队：去重后只入两首；offset 按**平台侧**页数前进。
        state
            .playlist_accept(
                session,
                "netease".into(),
                "pl1".into(),
                1,
                Ok(online::PlaylistDetail {
                    playlist: Default::default(),
                    total: 120,
                    tracks: vec![track("dup"), track("t1"), track("t2")],
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            *state.queue.lock().await,
            vec!["online:netease:dup".to_string(), "online:netease:t1".to_string(), "online:netease:t2".to_string()]
        );
        {
            let meta = state.online_meta.lock().await;
            assert!(meta.get("online:netease:t1").is_some(), "补页的曲目要带元数据");
        }
        match rx.try_recv().expect("补页要发进度事件") {
            WsEvent::CollectionLoad { source, id, loaded, total, done, error } => {
                assert_eq!((source.as_str(), id.as_str()), ("netease", "pl1"));
                assert_eq!(loaded, 4, "loaded 是平台侧已翻过的数（1 + 本页 3）");
                assert_eq!(total, 120);
                assert!(!done);
                assert!(error.is_none());
            }
            other => panic!("应当发 CollectionLoad，收到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn accept_ignores_a_page_from_a_superseded_intent() {
        let (state, _h) = playback_state().await;
        let (gen, _, _) = state.set_queue(vec!["online:netease:a".into()], Some(0)).await;
        seeded(&state, gen, 120).await;
        let stale_session = state.playlist_load.lock().await.session;

        // 同一张歌单被重新播放：set_queue 顶会话并清意图，begin 登记新意图
        // （会话号已 +1）。旧意图在途的那一页此刻才回来。
        state.set_queue(vec!["online:netease:new".into()], Some(0)).await;
        let (gen2, _, _) = state.set_queue(vec!["online:netease:a".into()], Some(0)).await;
        seeded(&state, gen2, 120).await;

        state
            .playlist_accept(
                stale_session,
                "netease".into(),
                "pl1".into(),
                77, // 旧意图翻到的位置：落进新意图会把 offset 拉回去
                Ok(online::PlaylistDetail {
                    playlist: Default::default(),
                    total: 120,
                    tracks: vec![track("late")],
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            *state.queue.lock().await,
            vec!["online:netease:a".to_string()],
            "旧意图的补页不许污染重新登记的同一集合"
        );
        {
            let pl = state.playlist_load.lock().await;
            assert_eq!(pl.active.as_ref().unwrap().offset, 1, "新意图的 offset 不被旧页拉走");
        }
        // 新会话的正常补页照常工作。
        let fresh = state.playlist_load.lock().await.session;
        state
            .playlist_accept(
                fresh,
                "netease".into(),
                "pl1".into(),
                1,
                Ok(online::PlaylistDetail {
                    playlist: Default::default(),
                    total: 120,
                    tracks: vec![track("t1")],
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            *state.queue.lock().await,
            vec!["online:netease:a".to_string(), "online:netease:t1".to_string()]
        );
    }

    #[tokio::test]
    async fn accept_marks_done_on_empty_or_all_duplicate_pages() {
        let (state, _h) = playback_state().await;
        let mut rx = state.events.subscribe();
        let (gen, _, _) = state.set_queue(vec!["online:netease:a".into()], Some(0)).await;
        seeded(&state, gen, 120).await;
        let session = state.playlist_load.lock().await.session;

        // 整页都是已在队的重复（平台在原地打转）：一次就判 done，防无限翻页。
        state
            .playlist_accept(
                session,
                "netease".into(),
                "pl1".into(),
                1,
                Ok(online::PlaylistDetail {
                    playlist: Default::default(),
                    total: 120,
                    tracks: vec![track("a"), track("a")],
                }),
            )
            .await
            .unwrap();
        match rx.try_recv().expect("要发终态事件") {
            WsEvent::CollectionLoad { done, .. } => assert!(done, "整页重复必须判终态"),
            other => panic!("应当发 CollectionLoad，收到 {other:?}"),
        }
        assert!(state.collection_status().await.is_none(), "done 后意图清空");
    }

    #[tokio::test]
    async fn accept_records_the_error_and_keeps_the_loaded_tracks() {
        let (state, _h) = playback_state().await;
        let mut rx = state.events.subscribe();
        let (gen, _, _) = state.set_queue(vec!["online:netease:a".into(), "online:netease:b".into()], Some(0)).await;
        seeded(&state, gen, 120).await;

        let session = state.playlist_load.lock().await.session;
        let err = state
            .playlist_accept(
                session,
                "netease".into(),
                "pl1".into(),
                2,
                Err(crate::error::ApiError::vip_required("上游要会员")),
            )
            .await
            .expect_err("错误要如实上抛");
        assert_eq!(err.code, "vip_required");
        assert_eq!(
            *state.queue.lock().await,
            vec!["online:netease:a".to_string(), "online:netease:b".to_string()],
            "一次补页失败不许丢已准备的曲目（F2 验收线）"
        );
        let (_, _, _, _, last_err) = state.collection_status().await.expect("意图仍在");
        assert_eq!(last_err.as_deref(), Some("上游要会员"));
        match rx.try_recv().expect("失败也要发事件") {
            WsEvent::CollectionLoad { done, error, .. } => {
                assert!(!done);
                assert_eq!(error.as_deref(), Some("上游要会员"));
            }
            other => panic!("应当发 CollectionLoad，收到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn begin_requires_a_live_generation_and_set_queue_invalidates() {
        let (state, _h) = playback_state().await;
        let (gen, _, _) = state.set_queue(vec!["online:netease:a".into()], Some(0)).await;
        // 陈旧代际（比如起播前用户又点了一次播放）不许登记。
        state.begin_collection_load("netease", "pl1", 120, 1, gen + 1).await;
        assert!(state.collection_status().await.is_none());

        // 合法登记后，一次整盘换队就作废。
        state.begin_collection_load("netease", "pl1", 120, 1, gen).await;
        assert!(state.collection_status().await.is_some());
        state.set_queue(vec!["online:netease:z".into()], Some(0)).await;
        assert!(state.collection_status().await.is_none(), "换队即作废");
    }

    #[tokio::test]
    async fn refill_is_watermarked_and_throttled_without_hitting_the_network() {
        let (state, _h) = playback_state().await;
        let (gen, _, _) = state.set_queue(
            (0..40).map(|i| format!("online:netease:t{i}")).collect::<Vec<_>>(),
            Some(0),
        ).await;
        seeded(&state, gen, 400).await;
        // 游标之后还剩 39 首 > 水位 24：不取数、意图保持。
        state.playlist_refill(false).await.unwrap();
        assert!(state.collection_status().await.is_some());

        // 已翻满 total：清意图，不发任何网络请求。
        {
            let mut pl = state.playlist_load.lock().await;
            let a = pl.active.as_mut().unwrap();
            a.offset = 400;
        }
        state.playlist_refill(true).await.unwrap();
        assert!(state.collection_status().await.is_none(), "翻满 total 即终态");
    }
}
