// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! Shared server state, the event bus and the playback queue.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, Mutex};
use vmusic_audio::{AudioEvent, AudioHandle};
use vmusic_core::{PlayMode, PlayerSnapshot, PROTOCOL_VERSION};

use crate::config::Config;

/// Everything that crosses the WebSocket boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsEvent {
    State(PlayerSnapshot),
    /// 必须是命名变体。`#[serde(tag = "type")]` 是内部标签表示法，serde 只
    /// 允许它包住 struct/map 形状的数据；newtype 变体（`Spectrum(Vec<f32>)`）
    /// 会在序列化时直接报错，而 ws.rs 对 `to_string` 失败是 `continue`，
    /// 于是整条频谱链路静默地一帧都发不出去——不崩、不报错、状态帧照发。
    Spectrum {
        bands: Vec<f32>,
    },
    Ended,
    Error {
        message: String,
        /// 机器可读错误码，与 REST 错误体的 `error.code` 一致；前端按码引导
        /// 登录/版权提示而不必解析 message（spec §1.5）。本地音频后端报错时
        /// 缺省，字段整体不序列化，老客户端不受影响。
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        /// 失败的在线音源 id；本地播放错误不带。
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
    Scan {
        phase: String,
        done: usize,
        total: usize,
    },
    /// 在线曲边下边播的缓冲覆盖态：进入播放流程先 active=true，提交/失败/
    /// 被顶代际时必须 active=false 收口；WaitFull 模式下带百分比。
    Buffering {
        active: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pct: Option<u8>,
    },
    LibraryChanged,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ScanProgress {
    pub running: bool,
    pub done: usize,
    pub total: usize,
    pub added: usize,
    pub failed: usize,
    pub last_error: Option<String>,
}

/// 在线曲目元数据快照（仅在内存，与队列同生命周期）。
///
/// /online/play 入队时随 tracks 写入 [`AppState::online_meta`]，提交成功后
/// 据此写播放历史；队列外没有任何持久化。
#[derive(Debug, Clone)]
pub(crate) struct OnlineMetaSnap {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover: Option<String>,
    pub duration_ms: Option<u64>,
}

/// 一次播放尝试的结果：是否真正提交（没被更新代际顶掉）与平台实际给到的
/// 音质档位（缓存命中/预取接管时无法回填，为 None）。
pub(crate) struct PlayOutcome {
    pub committed: bool,
    pub actual_quality: Option<crate::online::quality::Quality>,
}

pub struct AppState {
    pub db: SqlitePool,
    pub audio: AudioHandle,
    pub config: Arc<Config>,
    pub data_dir: PathBuf,
    pub token: String,
    pub events: broadcast::Sender<WsEvent>,
    /// Ordered list of track ids the "next / previous" buttons walk through.
    pub queue: Mutex<Vec<String>>,
    pub cursor: Mutex<Option<usize>>,
    pub scan: Mutex<ScanProgress>,
    /// 二维码登录会话（票 → 平台握手数据），只活在内存里、TTL 3 分钟。
    pub qr: Arc<crate::online::qr::Registry>,
    /// 播放代际：每次 `play_index` 切入或 `set_queue` 整盘替换都 +1。
    /// 在线曲目要现场取流（数秒 await），陈旧调用回来后凭它辨认「用户是否
    /// 早已切走」，决定要不要真的 load —— 否则 B 还在下载时用户切回 A，
    /// B 下完会一嗓子盖掉正在听的 A，cursor 也被带回 B。
    pub(crate) play_generation: AtomicUsize,
    /// 「代际复核 → load → play → 写 cursor」这段提交尾部的串行锁。
    /// 取流/下载在锁外（数秒 await，绝不能挡住用户下一次切入），但复核与
    /// actor 命令入队在多 worker 下不是同一个原子动作：不串行化时，两个核
    /// 上可能 B 过闸 → A 入队 Load(A) → B 入队 Load(B)，最后 Play(A) 配的
    /// 是 Load(B) 的声音。set_queue 也过这把锁，保证换队+顶代际相对提交原子。
    pub(crate) play_commit: Mutex<()>,
    /// 下载缓冲覆盖态（WS 推送与 /v1/state 读取共用）。
    pub(crate) buffering: Mutex<(bool, Option<u8>)>,
    /// /online/play 入队时随 tracks 带来的元数据快照（虚拟 id → 快照）。
    pub(crate) online_meta: Mutex<HashMap<String, OnlineMetaSnap>>,
    /// 进行中的下载器（缓存键 → Download），供预取接管与切歌中止。
    pub(crate) downloads: Mutex<HashMap<String, crate::online::progressive::Download>>,
    /// 自动接力连续失败计数，任一曲成功提交即清零；累计到 3 停止接力。
    pub(crate) auto_failures: AtomicUsize,
    /// 逐源音质偏好（启动时从 settings 装载、POST 热切换即时更新）。
    pub(crate) quality: Mutex<crate::online::quality::QualityPrefs>,
}

impl AppState {
    pub fn cover_dir(&self) -> PathBuf {
        self.data_dir.join("cache").join("covers")
    }

    /// 在线试听的落盘位置。音频后端目前只吃本地文件路径，所以远程流先缓存到
    /// 这里再交给 audio actor —— 播放链路本身完全不变。
    pub fn online_cache_dir(&self) -> PathBuf {
        self.data_dir.join("cache").join("online")
    }

    pub fn publish(&self, event: WsEvent) {
        // No receivers is the common case and is not an error.
        let _ = self.events.send(event);
    }

    /// 整盘替换队列。返回 `(新代际, 旧队列快照, 旧 cursor)`：/online/play
    /// 先占队列再花数秒预取首曲，回来后凭新代际确认自己没被后来的切入顶掉
    /// （不能事后再读计数器——多 worker 下两条语句之间别的 play_index 可能
    /// 已经 bump 过）；预取新鲜失败时凭旧快照把队列和 cursor 整体还原。旧
    /// 快照必须在本临界区内抓——锁外读 queue+cursor 再换队，中间能插进别人
    /// 的换队。
    pub async fn set_queue(
        &self,
        ids: Vec<String>,
        start: Option<usize>,
    ) -> (usize, Vec<String>, Option<usize>) {
        // 与播放预留/提交尾部互斥：整盘替换必须作废旧队列里一切在途的现场取流，
        // 且「顶代际 + 换队列 + 写 cursor」要相对某个提交原子地发生，否则旧盘
        // 的下载晚于新盘的 load 完成时，会把新歌盖掉。
        let _commit = self.play_commit.lock().await;
        let prev_queue = self.queue.lock().await.clone();
        let prev_cursor = *self.cursor.lock().await;
        let gen = self
            .play_generation
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        *self.queue.lock().await = ids;
        *self.cursor.lock().await = start;
        (gen, prev_queue, prev_cursor)
    }

    pub async fn current_index(&self) -> Option<usize> {
        *self.cursor.lock().await
    }

    /// Loads and starts the track at `index` of the current queue.
    pub async fn play_index(&self, index: usize) -> Result<(), vmusic_core::CoreError> {
        self.play_index_for(index, None, false).await.map(|_| ())
    }

    /// 播放指定队列位置；`reserve_gen` 用于 /online/play 的「先占队列后起播」：
    /// 传入 set_queue 返回的代际，进入预留区时代际已被顶掉则返回
    /// `committed=false`（被取代，未提交）。
    ///
    /// `auto` 标识自然结束接力（true）还是用户点播（false）：在线曲取流失败
    /// 时前者按连续失败计数自动跳曲，后者停在当前曲并推可操作错误。
    pub(crate) async fn play_index_for(
        &self,
        index: usize,
        reserve_gen: Option<usize>,
        auto: bool,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        // 预留区整段持 commit：验代际、读曲、顶新代际、写乐观 cursor 必须相对
        // set_queue 与别的播放预留原子——否则多 worker 下「预闸后队列被换」或
        // 「同队列秒切」都可能让迟到的提交劫持正在听的曲。
        let commit = self.play_commit.lock().await;
        if let Some(expected) = reserve_gen {
            if self.play_generation.load(Ordering::Relaxed) != expected {
                return Ok(PlayOutcome {
                    committed: false,
                    actual_quality: None,
                });
            }
        }
        let track_id = {
            let queue = self.queue.lock().await;
            match queue.get(index).cloned() {
                Some(track_id) => track_id,
                None => return Err(vmusic_core::CoreError::NotFound("queue index".into())),
            }
        };
        // 每次切入开新一代并捕获它：在线现取流的多个 await 之间用户可能已
        // 经切歌，回来后必须先过 attempt_alive 闸门才允许碰 audio actor。
        // cursor 乐观先写——下载的几秒里状态查询也该高亮这首——但失败且
        // 仍属当代时恢复到切入前。
        let gen = self
            .play_generation
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        let prev_cursor = *self.cursor.lock().await;
        *self.cursor.lock().await = Some(index);
        drop(commit);

        let outcome = if let Some((source, id)) = crate::online::split_virtual_id(&track_id) {
            self.play_online(gen, index, track_id.clone(), source, id, prev_cursor, auto)
                .await
        } else {
            self.play_local(gen, index, track_id.clone()).await
        }?;

        if outcome.committed {
            *self.cursor.lock().await = Some(index);
            // actual_quality 是 Copy 字段，这里按值传入不构成 outcome 的部分 move。
            self.on_track_committed(&track_id, outcome.actual_quality)
                .await;
        }
        Ok(outcome)
    }

    /// 本地曲提交：先作废全部在途在线下载（含预取），其余代际/锁纪律与
    /// 旧版 play_index 一致。
    async fn play_local(
        &self,
        gen: usize,
        index: usize,
        track_id: String,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        self.cancel_all_downloads().await;
        let track = vmusic_store::get_track(&self.db, &track_id)
            .await
            .map_err(vmusic_core::CoreError::Store)?
            .ok_or_else(|| vmusic_core::CoreError::NotFound(track_id.clone()))?;
        let _commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        self.audio
            .load(&track.path, Some(track_id.clone()))
            .await
            .map_err(vmusic_core::CoreError::Audio)?;
        // load 已被 actor 处理：若这期间又切了歌，更新一代的命令已排在后面，
        // 本调用绝不能再 play() 或写 cursor。
        if !self.attempt_alive(gen, index, &track_id).await {
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        self.audio
            .play()
            .await
            .map_err(vmusic_core::CoreError::Audio)?;
        Ok(PlayOutcome {
            committed: self.attempt_alive(gen, index, &track_id).await,
            actual_quality: None,
        })
    }

    /// 在线曲播放：缓存快路径 → 预取接管/新开渐进式下载 → WaitFull/Progressive
    /// 两条提交路。所有网络 await 都在 commit 锁外；只有复核与 actor 入队在
    /// 锁内。失败一律走 [`Self::online_failed`] 收口。
    //
    // 参数多是有意的分层结果：代际/下标/track_id 是乐观并发三件套，
    // source/id 是在线曲身份，prev_cursor 供失败回退，auto 决定失败策略——
    // 收成结构体只会引入一个只用一次的临时参数包。
    #[allow(clippy::too_many_arguments)]
    async fn play_online(
        &self,
        gen: usize,
        index: usize,
        track_id: String,
        source: String,
        id: String,
        prev_cursor: Option<usize>,
        auto: bool,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        self.set_buffering(true, None).await;

        let dir = self.online_cache_dir();
        // 读偏好只在块作用域短持锁：tokio Mutex 不能跨后面的网络 await 持有。
        let quality = {
            let prefs = self.quality.lock().await;
            crate::online::quality::get(&prefs, &source)
        };
        let key = crate::online::cache::cache_key(&source, &id, quality.as_str());

        // 只取消「别的键」的在途下载；同键说明预取已在跑，下面直接接管，
        // 绝不重下一遍。
        {
            let mut map = self.downloads.lock().await;
            let others: Vec<String> = map.keys().filter(|k| k.as_str() != key).cloned().collect();
            for k in others {
                if let Some(old) = map.remove(&k) {
                    old.cancel();
                }
            }
        }

        // 快路径：正式名（任意扩展名）或旧名缓存已就绪。find_cached_by_key
        // 是 tokio::fs 的 async 扫描（目录内只有少量缓存文件），直接 await，
        // 不另开 blocking 任务。
        if let Some(path) =
            crate::online::cache::find_cached_by_key(&dir, &source, &id, quality.as_str()).await
        {
            // 同键下载（如刚完成 rename 的预取）从注册表摘掉，句柄 drop 释放。
            self.downloads.lock().await.remove(&key);
            return self.commit_file(gen, index, track_id, path, None).await;
        }

        // 未缓存：同键预取在跑则 owned 接管（实际档位无法回填）；否则现场
        // 取流并新开渐进式下载。
        let (dl, actual) =
            {
                let existing = self.downloads.lock().await.remove(&key);
                if let Some(dl) = existing {
                    (dl, None)
                } else {
                    let ctx = crate::online::Ctx {
                        db: self.db.clone(),
                    };
                    let info =
                        match crate::online::stream(&ctx, &source, &id, None, Some(quality.bps()))
                            .await
                        {
                            Ok(v) => v,
                            Err(e) => {
                                self.set_buffering(false, None).await;
                                return self
                                    .online_failed(
                                        gen,
                                        index,
                                        track_id,
                                        prev_cursor,
                                        auto,
                                        e.with_source(source),
                                    )
                                    .await;
                            }
                        };
                    let actual = crate::online::quality::from_bitrate(info.bitrate);
                    let urls: Vec<String> = std::iter::once(info.url)
                        .chain(info.fallback_urls)
                        .collect();
                    let referer = crate::online::referer(&source).map(str::to_string);
                    match crate::online::progressive::start(dir.clone(), key.clone(), urls, referer)
                    {
                        Ok(dl) => (dl, actual),
                        Err(e) => {
                            self.set_buffering(false, None).await;
                            return self
                                .online_failed(gen, index, track_id, prev_cursor, auto, e)
                                .await;
                        }
                    }
                }
            };

        // 等预读阈值（下载器内部在 spawn_blocking 里阻塞，不卡运行时）。
        if let Err(e) = dl.wait_prebuffer().await {
            self.set_buffering(false, None).await;
            dl.cancel();
            return self
                .online_failed(
                    gen,
                    index,
                    track_id,
                    prev_cursor,
                    auto,
                    crate::error::ApiError::upstream_timeout(e).with_source(source),
                )
                .await;
        }

        // 容器探测：读 .part 前 1MB（blocking 任务做同步读）；文件打不开时
        // 保守按 WaitFull + 下载器自己嗅探出的扩展名处理。
        let (mode, ext) = {
            let part = dl.part_path.clone();
            let sniffed = dl.ext();
            let head = tokio::task::spawn_blocking(move || {
                let mut buf = vec![0u8; 1024 * 1024];
                use std::io::Read;
                let mut f = std::fs::File::open(&part).ok()?;
                let n = f.read(&mut buf).ok()?;
                buf.truncate(n);
                Some(buf)
            })
            .await
            .ok()
            .flatten();
            match head {
                Some(h) => crate::online::progressive::plan_mode(&h),
                None => (crate::online::progressive::StreamMode::WaitFull, sniffed),
            }
        };

        if mode == crate::online::progressive::StreamMode::WaitFull {
            // late-moov m4a：等整首下完。每 200ms 推一次百分比并复核代际，
            // 用户切走立刻取消，不让迟到下载回来劫持新歌。
            loop {
                if !self.attempt_alive(gen, index, &track_id).await {
                    self.set_buffering(false, None).await;
                    dl.cancel();
                    return Ok(PlayOutcome {
                        committed: false,
                        actual_quality: None,
                    });
                }
                self.set_buffering(true, dl.pct()).await;
                if dl.is_finished() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let path = match dl.join().await {
                Ok(p) => p,
                Err(e) => {
                    self.set_buffering(false, None).await;
                    return self
                        .online_failed(
                            gen,
                            index,
                            track_id,
                            prev_cursor,
                            auto,
                            crate::error::ApiError::upstream_rejected(e).with_source(source),
                        )
                        .await;
                }
            };
            self.set_buffering(false, None).await;
            return self.commit_file(gen, index, track_id, path, actual).await;
        }

        // Progressive：头部元数据已齐，解码源直接读 .part，读到哪等到哪。
        // HttpMediaSource 显式 impl AudioSource（media_len 透传 Content-Length）。
        let media = match crate::online::progressive::HttpMediaSource::open(
            &dl.part_path,
            dl.inner.clone(),
            dl.abort.clone(),
        ) {
            Ok(m) => m,
            Err(e) => {
                self.set_buffering(false, None).await;
                dl.cancel();
                return self
                    .online_failed(
                        gen,
                        index,
                        track_id,
                        prev_cursor,
                        auto,
                        crate::error::ApiError::internal(e.to_string()).with_source(source),
                    )
                    .await;
            }
        };

        let commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            self.set_buffering(false, None).await;
            dl.cancel();
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        if let Err(e) = self
            .audio
            .load_source(
                Box::new(media),
                Some(ext.to_string()),
                Some(track_id.clone()),
            )
            .await
        {
            // online_failed 自己要取 commit 锁，必须先释放本守卫，否则同任务
            // 重入 tokio Mutex 直接死锁。
            drop(commit);
            self.set_buffering(false, None).await;
            dl.cancel();
            return self
                .online_failed(
                    gen,
                    index,
                    track_id,
                    prev_cursor,
                    auto,
                    crate::error::ApiError::internal(e.to_string()).with_source(source),
                )
                .await;
        }
        if !self.attempt_alive(gen, index, &track_id).await {
            self.set_buffering(false, None).await;
            // 已装入 actor 但被顶代际：不取消下载，后台跑完照样落缓存。
            drop(dl);
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        let play = self.audio.play().await;
        let committed = self.attempt_alive(gen, index, &track_id).await;
        self.set_buffering(false, None).await;
        play.map_err(vmusic_core::CoreError::Audio)?;
        // 下载任务在后台继续到完成并 rename；Download 无 Drop 中止语义，
        // drop 句柄只是放弃 JoinHandle 接收端，不会 cancel 任务（不能 forget）。
        drop(dl);
        Ok(PlayOutcome {
            committed,
            actual_quality: actual,
        })
    }

    /// 缓存就绪曲目的提交（本地正式路径，走原 load 快路径）。
    async fn commit_file(
        &self,
        gen: usize,
        index: usize,
        track_id: String,
        path: PathBuf,
        actual: Option<crate::online::quality::Quality>,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        let _commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            self.set_buffering(false, None).await;
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        let Some(uri) = path.to_str() else {
            self.set_buffering(false, None).await;
            return Err(vmusic_core::CoreError::NotFound(
                "路径含非 UTF-8 字符".into(),
            ));
        };
        if let Err(e) = self.audio.load(uri, Some(track_id.clone())).await {
            self.set_buffering(false, None).await;
            return Err(vmusic_core::CoreError::Audio(e));
        }
        if !self.attempt_alive(gen, index, &track_id).await {
            self.set_buffering(false, None).await;
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        if let Err(e) = self.audio.play().await {
            self.set_buffering(false, None).await;
            return Err(vmusic_core::CoreError::Audio(e));
        }
        let committed = self.attempt_alive(gen, index, &track_id).await;
        self.set_buffering(false, None).await;
        Ok(PlayOutcome {
            committed,
            actual_quality: actual,
        })
    }

    /// 本次播放尝试是否仍代表用户的当前选择：代际没被后续切歌/换队列顶掉，
    /// 且队列该位置仍是原来那首。调用方必须已持有 `play_commit` 锁（或本身
    /// 就是锁外的非提交复核）：先取队列锁（持锁期间队列内容不可能变），再
    /// 复读代际，挡掉「读 gen 之后、拿锁之前」被 set_queue 顶代际的缝。
    pub(crate) async fn attempt_alive(&self, gen: usize, index: usize, track_id: &str) -> bool {
        let queue = self.queue.lock().await;
        self.play_generation.load(Ordering::Relaxed) == gen
            && queue.get(index).is_some_and(|id| id == track_id)
    }

    /// 写缓冲覆盖态并立即推 WS（/v1/state 轮询读同一个 [`Self::buffering`]）。
    pub(crate) async fn set_buffering(&self, active: bool, pct: Option<u8>) {
        *self.buffering.lock().await = (active, pct);
        self.publish(WsEvent::Buffering { active, pct });
    }

    /// 中止全部在途下载并清空注册表（切到本地曲/换队预留时调用）。
    /// 短锁内 drain：cancel 只是置 AtomicBool + 删 .part，不 await。
    pub(crate) async fn cancel_all_downloads(&self) {
        let mut map = self.downloads.lock().await;
        for (_, dl) in map.drain() {
            dl.cancel();
        }
    }

    /// 播放成功提交后的内联收口：只做快操作（清连续失败计数、写历史）。
    ///
    /// 预取与 LRU 含网络/磁盘 await（预取要发一次取流 API，最坏数秒），绝不能
    /// 内联在这里拖慢 /online/play 等 HTTP 响应与自动接力；统一由
    /// [`Self::post_commit_background`] 在调用入口 detach 出去。
    pub(crate) async fn on_track_committed(
        &self,
        track_id: &str,
        actual: Option<crate::online::quality::Quality>,
    ) {
        self.auto_failures.store(0, Ordering::Relaxed);
        self.record_history(track_id).await;
        // 实际档位本任务只回传给 /online/play 响应；后续统计/打点再消费。
        let _ = actual;
    }

    /// 曲目确认成功起播（committed/Ok）后的后台收口：预取后一首，再做一次
    /// 缓存容量回收。必须由「成功播放入口」在提交成功后恰好调用一次：
    /// 自动接力在事件泵入口、手动点播在各路由入口。
    ///
    /// 整个流程 detach：调用方不等它，HTTP 响应与接力不被取流拖住。
    /// enforce_limit 内置「最新文件始终保留」，不会删掉刚落盘的当前曲。
    pub(crate) fn post_commit_background(self: &Arc<Self>) {
        let s = self.clone();
        tokio::spawn(async move {
            s.spawn_prefetch().await;
            if let Err(e) = crate::online::cache::enforce_limit(
                &s.online_cache_dir(),
                s.config.online.cache_max_bytes,
                &[],
            )
            .await
            {
                tracing::warn!("缓存 LRU 回收失败: {e}");
            }
        });
    }

    /// 写一条播放历史。在线曲用 online_meta 快照（缺失则标题退化为平台 id）；
    /// 本地曲从库中取字段。失败只记日志，绝不能影响播放链路。
    async fn record_history(&self, track_id: &str) {
        if let Some((source, ref_id)) = crate::online::split_virtual_id(track_id) {
            let snap = self.online_meta.lock().await.get(track_id).cloned();
            let (title, artist, album, cover, duration) = match snap {
                Some(m) => (m.title, m.artist, m.album, m.cover, m.duration_ms),
                None => (ref_id.clone(), None, None, None, None),
            };
            if let Err(e) = crate::history::upsert(
                &self.db,
                crate::history::HistoryEntry {
                    track_id,
                    source: &source,
                    ref_id: &ref_id,
                    title: &title,
                    artist: artist.as_deref(),
                    album: album.as_deref(),
                    cover_url: cover.as_deref(),
                    duration_ms: duration,
                },
            )
            .await
            {
                tracing::warn!("写播放历史失败: {e}");
            }
        } else if let Ok(Some(t)) = vmusic_store::get_track(&self.db, &track_id.to_string()).await {
            if let Err(e) = crate::history::upsert(
                &self.db,
                crate::history::HistoryEntry {
                    track_id: &t.id,
                    source: "local",
                    ref_id: &t.id,
                    title: &t.title,
                    artist: t.artist.as_deref(),
                    album: t.album.as_deref(),
                    cover_url: None,
                    duration_ms: t.duration_ms,
                },
            )
            .await
            {
                tracing::warn!("写播放历史失败: {e}");
            }
        }
    }

    /// 当前曲提交后按当前播放模式 peek 下一首：在线、无在途同键下载、无缓存
    /// 命中时，后台预热下一首（注册表最多同时 1 个，由切歌取消逻辑保证）。
    /// 任何失败都只 debug 日志——预取绝不影响正在听的曲。
    async fn spawn_prefetch(&self) {
        let mode = self.audio.snapshot().mode;
        let queue = self.queue.lock().await.clone();
        let len = queue.len();
        if len < 2 {
            return;
        }
        let current = self.cursor.lock().await.unwrap_or(0);
        let next = match mode {
            // 单曲循环：下一首还是自己，无需预取。
            vmusic_core::PlayMode::RepeatOne => return,
            // 与 step() 同一条随机规则，但只 peek、不推进游标。
            vmusic_core::PlayMode::Shuffle => random_index(len, Some(current)),
            _ => {
                if current + 1 >= len {
                    0
                } else {
                    current + 1
                }
            }
        };
        let Some((source, id)) = queue
            .get(next)
            .and_then(|v| crate::online::split_virtual_id(v))
        else {
            return; // 本地曲无需预取
        };
        let quality = {
            let prefs = self.quality.lock().await;
            crate::online::quality::get(&prefs, &source)
        };
        let key = crate::online::cache::cache_key(&source, &id, quality.as_str());
        if self.downloads.lock().await.contains_key(&key) {
            return;
        }
        let dir = self.online_cache_dir();
        if crate::online::cache::find_cached_by_key(&dir, &source, &id, quality.as_str())
            .await
            .is_some()
        {
            return;
        }
        let ctx = crate::online::Ctx {
            db: self.db.clone(),
        };
        let Ok(info) = crate::online::stream(&ctx, &source, &id, None, Some(quality.bps())).await
        else {
            return;
        };
        let urls: Vec<String> = std::iter::once(info.url)
            .chain(info.fallback_urls)
            .collect();
        let referer = crate::online::referer(&source).map(str::to_string);
        match crate::online::progressive::start(dir, key.clone(), urls, referer) {
            Ok(dl) => {
                self.downloads.lock().await.insert(key, dl);
            }
            Err(e) => tracing::debug!("预取启动失败: {}", e.message),
        }
    }

    /// 在线曲播放失败的统一收口（取流/下载/解码失败都汇到这里）。
    /// 仍属当代时把 cursor 恢复到切入前，不让 next/prev 从一首没播起来的
    /// 曲算起；已被用户切走则整体静默（连 Err 都不回）。
    ///
    /// - `auto=true`（自然结束接力）：连续失败 +1，推「已跳过」提示后自动
    ///   step 到下一首；累计 3 首发终态事件并返回 Err，停止接力。
    /// - `auto=false`（手动点播）：推原始错误（不停服务），返回 Err 交回
    ///   HTTP 调用方，由前端错误条引导重试。
    async fn online_failed(
        &self,
        gen: usize,
        index: usize,
        track_id: String,
        prev_cursor: Option<usize>,
        auto: bool,
        e: crate::error::ApiError,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        let commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            // 被顶代际：为跳过的曲子弹错、抢光标、给迟到的 HTTP 响应塞 404
            // 都不对。
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        *self.cursor.lock().await = prev_cursor;

        if auto {
            let n = self.auto_failures.fetch_add(1, Ordering::Relaxed) + 1;
            self.publish(WsEvent::Error {
                message: format!("《{}》暂不可用，已跳过", track_title(&track_id)),
                code: Some(e.code.to_string()),
                source: e.source.clone(),
            });
            if n >= 3 {
                self.publish(WsEvent::Error {
                    message: "连续多首无法播放，已停止。可检查音源登录或网络后重试。".into(),
                    code: Some("online_unavailable_streak".to_string()),
                    source: e.source,
                });
                return Err(vmusic_core::CoreError::NotFound(e.message));
            }
            drop(commit);
            // 自动跳下一首（仍按当前模式 step；其成功提交会清零失败计数）。
            // step → play_index_for → play_online → online_failed 与本函数构成
            // async 递归，future 尺寸无限；这一边必须 Box::pin 引入间接。
            let _ = Box::pin(self.step(1, true)).await;
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }

        self.publish(WsEvent::Error {
            message: e.message.clone(),
            code: Some(e.code.to_string()),
            source: e.source,
        });
        Err(vmusic_core::CoreError::NotFound(e.message))
    }

    /// Moves the queue according to the current play mode.
    ///
    /// `auto` is true when the move comes from a track finishing rather than a
    /// button press: `RepeatOne` only repeats on auto, a user pressing "next"
    /// always moves forward.
    pub async fn step(&self, delta: isize, auto: bool) -> Result<(), vmusic_core::CoreError> {
        let mode = self.audio.snapshot().mode;
        let len = self.queue.lock().await.len();
        if len == 0 {
            return Ok(());
        }
        let current = self.current_index().await.unwrap_or(0);

        let next = match mode {
            PlayMode::RepeatOne if auto => current,
            // Shuffle must move: picking the current index again would look
            // like "next" did nothing. VCP keeps a pre-shuffled queue for the
            // same reason; excluding the current index is the minimal version.
            PlayMode::Shuffle if delta > 0 => random_index(len, Some(current)),
            _ => {
                let raw = current as isize + delta;
                if raw < 0 {
                    len - 1
                } else if raw as usize >= len {
                    0
                } else {
                    raw as usize
                }
            }
        };

        self.play_index_for(next, None, true).await.map(|_| ())
    }
}

/// 失败提示里显示的曲目名：state 层此刻拿不到锁外的在线元数据快照，退而
/// 显示虚拟 id 尾段（平台曲目 id），至少能让用户认出是哪一首。
fn track_title(track_id: &str) -> String {
    track_id.rsplit(':').next().unwrap_or(track_id).to_string()
}

/// Shuffle without pulling in an RNG crate: xorshift seeded from the clock.
///
/// `exclude` is the index that must not be returned (the one already playing),
/// honoured only when the queue has somewhere else to go.
fn random_index(len: usize, exclude: Option<usize>) -> usize {
    if len == 0 {
        return 0;
    }
    let mut x = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15);
    if x == 0 {
        x = 0x9E3779B97F4A7C15;
    }
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    let pick = (x % len as u64) as usize;
    match exclude {
        Some(skip) if len > 1 && pick == skip => (pick + 1) % len,
        _ => pick,
    }
}

/// Bridges audio-actor events onto the WebSocket bus and drives auto-advance.
pub fn spawn_event_pump(state: Arc<AppState>) {
    let mut rx = state.audio.subscribe();
    tokio::spawn(async move {
        loop {
            let event = match rx.recv().await {
                Ok(event) => event,
                // 这是状态帧/频谱/自动接力的唯一转发任务。状态+频谱约 80 条/秒，
                // 而广播容量只有 64：在线曲自动接力要在 Ended 分支里现取流数秒，
                // 一旦消费停顿必然 Lagged。丢几帧增量无所谓，退泵才是致命的——
                // 退了之后整条 WS 链路静默全灭，所以 Lagged 只 continue。
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            match event {
                AudioEvent::Snapshot(snap) => state.publish(WsEvent::State(snap)),
                AudioEvent::Spectrum(bands) => state.publish(WsEvent::Spectrum { bands }),
                AudioEvent::Ended => {
                    state.publish(WsEvent::Ended);
                    // 接力绝不能在泵任务里 await：未缓存在线曲的现取流要数秒，
                    // 泵一停，上面那个 64 容量的广播立刻 Lagged。甩到独立任务，
                    // 泵自己永远只做即时转发。
                    let advance = state.clone();
                    tokio::spawn(async move {
                        // 成功（含失败后内部自动跳曲成功）后在接力入口做一次
                        // 后台预取 + LRU；每首成功播放恰好这一次。
                        match advance.step(1, true).await {
                            Ok(()) => advance.post_commit_background(),
                            Err(e) => tracing::warn!("auto-advance failed: {e}"),
                        }
                    });
                }
                // 音频后端自身的解码/设备错误没有音源上下文，code/source 缺省。
                AudioEvent::Error(message) => state.publish(WsEvent::Error {
                    message,
                    code: None,
                    source: None,
                }),
                // 批B接入：解码早夭事件暂在此空收口（不转发）；批 B 将据此
                // 对在线曲自动跳曲、本地曲提示并清空播放状态。
                AudioEvent::DecodeError { .. } => {}
            }
        }
    });
}

/// Writes the discovery file a host reads to find us. Removed on shutdown so
/// a crashed instance does not leave a stale port behind.
pub async fn write_discovery(state: &AppState, port: u16) -> anyhow::Result<PathBuf> {
    #[derive(Serialize)]
    struct Discovery {
        pid: u32,
        port: u16,
        token: String,
        version: String,
        protocol_version: u32,
    }
    let body = Discovery {
        pid: std::process::id(),
        port,
        token: state.token.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: PROTOCOL_VERSION,
    };
    let path = state.data_dir.join("vmusicd.json");
    tokio::fs::write(&path, serde_json::to_vec_pretty(&body)?).await?;
    Ok(path)
}

pub async fn remove_discovery(data_dir: &std::path::Path) {
    let _ = tokio::fs::remove_file(data_dir.join("vmusicd.json")).await;
}

#[cfg(test)]
mod tests {
    use super::random_index;

    #[test]
    fn shuffle_never_returns_the_excluded_index() {
        for len in 2..8usize {
            for skip in 0..len {
                for _ in 0..64 {
                    assert_ne!(random_index(len, Some(skip)), skip);
                }
            }
        }
    }

    #[test]
    fn shuffle_stays_inside_the_queue() {
        for _ in 0..256 {
            assert!(random_index(5, None) < 5);
        }
        // A one-item queue has nowhere else to go; it must stay valid.
        assert_eq!(random_index(1, Some(0)), 0);
    }
}
