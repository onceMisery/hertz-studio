// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! Shared server state, the event bus and the playback queue.

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
        self.play_index_for(index, None).await.map(|_| ())
    }

    /// 播放指定队列位置；`reserve_gen` 用于 /online/play 的「先占队列后预取」：
    /// 传入 set_queue 返回的代际，进入预留区时代际已被顶掉则返回
    /// `Ok(false)`（被取代，未提交），成功提交返回 `Ok(true)`。
    pub(crate) async fn play_index_for(
        &self,
        index: usize,
        reserve_gen: Option<usize>,
    ) -> Result<bool, vmusic_core::CoreError> {
        // 预留区整段持 commit：验代际、读曲、顶新代际、写乐观 cursor 必须相对
        // set_queue 与别的播放预留原子——否则多 worker 下「预闸后队列被换」或
        // 「同队列秒切」都可能让迟到的提交劫持正在听的曲。
        let commit = self.play_commit.lock().await;
        if let Some(expected) = reserve_gen {
            if self.play_generation.load(Ordering::Relaxed) != expected {
                return Ok(false);
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

        // 在线试听的虚拟 id 不在本地库里：它对应的是 online 缓存目录里那个
        // 已经落盘的文件。不认这个前缀的话，上一首/下一首走到在线曲目时
        // 只会在本地库里查、必然 NotFound —— 表现就是「点了下一曲没反应」。
        let path = if let Some((source, id)) = crate::online::split_virtual_id(&track_id) {
            let cached = self
                .online_cache_dir()
                .join(crate::online::cache_name(&source, &id));
            // 与 fetch_to_cache 用同一个 1KB 阈值：版权拦截页/错误 JSON 也会
            // 落出一个几百字节的「文件」，直接喂给音频后端只会得到解码失败。
            let ready = cached.exists()
                && std::fs::metadata(&cached)
                    .map(|m| m.len() > 1024)
                    .unwrap_or(false);
            if ready {
                cached
            } else {
                // 整盘入队后切到尚未播放的曲目时，缓存还不存在：现场取试听
                // 地址再落盘，播过一次之后就回到上面的零网络缓存分支。
                //
                // 队列里只存虚拟 id、不存搜索结果的 track_ref，因此这里只能
                // 用稳定 id 回落取流——QQ media_mid / 酷狗 album_id 等专有
                // 字段缺失时平台可能给不到最优音质，但链路必须可用。
                let ctx = crate::online::Ctx {
                    db: self.db.clone(),
                };
                let info =
                    match crate::online::stream(&ctx, &source, &id, None, Some(320_000)).await {
                        Ok(info) => info,
                        Err(e) => {
                            // spec §1.5：WS error 事件必须带错误码与音源 id。
                            // 平台模块构造的 ApiError 默认不标源（REST 侧由
                            // tagged 标），这里补上。
                            return self
                                .online_play_failed(
                                    gen,
                                    index,
                                    &track_id,
                                    prev_cursor,
                                    e.with_source(source.clone()),
                                )
                                .await;
                        }
                    };
                match crate::online::fetch_to_cache(
                    &self.online_cache_dir(),
                    &source,
                    &id,
                    &info.url,
                )
                .await
                {
                    Ok(path) => path,
                    Err(e) => {
                        return self
                            .online_play_failed(
                                gen,
                                index,
                                &track_id,
                                prev_cursor,
                                e.with_source(source.clone()),
                            )
                            .await;
                    }
                }
            }
        } else {
            let track = vmusic_store::get_track(&self.db, &track_id)
                .await
                .map_err(vmusic_core::CoreError::Store)?
                .ok_or_else(|| vmusic_core::CoreError::NotFound(track_id.clone()))?;
            std::path::PathBuf::from(track.path)
        };

        // 提交尾部整段持 commit 锁：多 worker 下「过闸」与「load 命令入队」
        // 分布在两条语句、两个核上，中间可以插进另一次完整切入；不串行化时
        // 交错入队会让 Play(A) 配到 Load(B) 的声音。取流在锁外，等待只发生
        // 在 actor 命令往返这种快路径上。
        let _commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            return Ok(false);
        }

        let uri = path
            .to_str()
            .ok_or_else(|| vmusic_core::CoreError::NotFound("路径含非 UTF-8 字符".into()))?;

        self.audio
            .load(uri, Some(track_id.clone()))
            .await
            .map_err(vmusic_core::CoreError::Audio)?;
        // load 已被 actor 处理：若这期间又切了歌，更新一代的命令已排在后面，
        // 本调用绝不能再 play() 或写 cursor。
        if !self.attempt_alive(gen, index, &track_id).await {
            return Ok(false);
        }
        self.audio
            .play()
            .await
            .map_err(vmusic_core::CoreError::Audio)?;
        let committed = self.attempt_alive(gen, index, &track_id).await;
        if committed {
            *self.cursor.lock().await = Some(index);
        }
        Ok(committed)
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

    /// 在线取流/落盘失败的统一收口。仍属当代时：推带码与音源的 WS 错误
    /// （CoreError 不上 WebSocket，不推前端只看到「切歌没反应」），把
    /// cursor 恢复到切入前，不让 next/prev 从一首没播起来的曲算，并把错误
    /// 交回调用方。已被用户切走的失败整体静默丢弃（连 Err 都不回）——
    /// 为一首跳过的曲子弹错、抢光标、给迟到的 HTTP 响应塞 404 都不对。
    async fn online_play_failed(
        &self,
        gen: usize,
        index: usize,
        track_id: &str,
        prev_cursor: Option<usize>,
        e: crate::error::ApiError,
    ) -> Result<bool, vmusic_core::CoreError> {
        // 与提交尾部/换队互斥：否则可能在新一代已完成提交后把 cursor 恢复旧值。
        let _commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, track_id).await {
            return Ok(false);
        }
        self.publish(WsEvent::Error {
            message: e.message.clone(),
            code: Some(e.code.to_string()),
            source: e.source.clone(),
        });
        *self.cursor.lock().await = prev_cursor;
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

        self.play_index(next).await
    }
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
                        if let Err(e) = advance.step(1, true).await {
                            tracing::warn!("auto-advance failed: {e}");
                        }
                    });
                }
                // 音频后端自身的解码/设备错误没有音源上下文，code/source 缺省。
                AudioEvent::Error(message) => state.publish(WsEvent::Error {
                    message,
                    code: None,
                    source: None,
                }),
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
