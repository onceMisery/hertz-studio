// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Shared server state, the event bus and the playback queue.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
    /// 界面实例之间的轻量信号。浮动胶囊窗口与 tab 实例是两个 opaque-origin 的
    /// iframe，BroadcastChannel / storage 事件都不通，只能借这条已有的广播管道
    /// 绕一圈：浮窗里点胶囊时发 `expand-capsule`，tab 实例收到就解除最小化。
    UiNotice {
        action: String,
    },
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
        /// 手动点播失败时失败曲在当前队列中的下标：错误条「重试」凭它精确
        /// 重放该曲，而不是按当下快照反查（自动跳曲/本地错误不带）。
        #[serde(skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
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
    /// 节拍地图后台分析完成：前端仅当 track_id 仍是当前播放曲时拉取。
    /// bpm 低置信为 None，字段整体不序列化。
    BeatmapReady {
        track_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        bpm: Option<f64>,
        beats_n: usize,
    },
    /// 听歌打卡成功（网易云在线曲有效收听满 30s 已上报）。前端据此轻提示
    /// 「已计入播放量」，其余情况保持安静。
    Scrobbled {
        track_id: String,
    },
    /// 曲源自动接力成功：原音源失效的在线曲已按标题+歌手+时长在其他音源
    /// 找到同一首并换源续播。前端据此轻提示「已切换到 XX 音源」。
    SourceSwitched {
        /// 新的虚拟 id（`新源:平台id`），队列与元数据都已迁到它名下。
        track_id: String,
        from_source: String,
        to_source: String,
        /// 目标音源的展示名（SOURCES 表 label），前端不必再反查清单。
        to_label: String,
        /// 原曲标题（接力候选与原曲同名，取原快照的写法展示）。
        title: String,
    },
    LibraryChanged,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ScanProgress {
    pub running: bool,
    pub root: Option<String>,
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub removed: usize,
    pub failed: usize,
    pub cancelled: bool,
    pub last_error: Option<String>,
    pub errors: Vec<ScanError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanError {
    pub path: String,
    pub message: String,
}

/// 在线曲目元数据快照（仅在内存，与队列同生命周期）。
///
/// /online/play 入队时随 tracks 写入 [`AppState::online_meta`]，提交成功后
/// 据此写播放历史；/player/load 也接受随队的快照注入（重启后从歌单/收藏
/// 播放时客户端持有元数据而服务端内存已清空）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct OnlineMetaSnap {
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

/// 一次播放尝试由什么触发。取流失败后的处置全靠它分流，所以原来那个 `auto: bool`
/// 必须拆开：「用户点了这一首」和「用户按了下一曲」要的是相反的东西——前者要停在
/// 原处拿到这一首的报错，后者要跳过放不了的曲子继续找。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlayTrigger {
    /// 用户点了某一首（点播、重试、直接给队列下标）。
    Pick,
    /// 一首自然播完的接力。
    AutoNext,
    /// 用户按了上一曲/下一曲。
    Step { delta: isize },
}

impl PlayTrigger {
    /// 这一类失败要不要接着往下跳，以及往哪个方向跳；`None` = 停在原处把错误交回去。
    ///
    /// 主动换曲只跳过「这首本身放不了」的：上游整体不健康（502/504、下载后解不开）
    /// 时一首首试，等于把整支队列烧穿一遍，还会把限流踩得更深。
    fn skip_direction(&self, code: &str) -> Option<isize> {
        match self {
            PlayTrigger::Pick => None,
            PlayTrigger::AutoNext => Some(1),
            PlayTrigger::Step { delta }
                if matches!(code, "vip_required" | "auth_required" | "not_found") =>
            {
                Some(delta.signum())
            }
            PlayTrigger::Step { .. } => None,
        }
    }

    /// 连跳几只之后放弃。接力沿用既有的 3；主动换曲允许跨过队列里其他所有曲子
    /// （`n` 从 1 起计，跳到第 `len` 首即已绕完一圈），但上限必须存在——失败递归是
    /// 沿 future 链一路下来的。
    fn streak_cap(&self, queue_len: usize) -> usize {
        match self {
            PlayTrigger::AutoNext => 3,
            PlayTrigger::Step { .. } => queue_len.max(1),
            PlayTrigger::Pick => 0,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            PlayTrigger::Pick => "pick",
            PlayTrigger::AutoNext => "auto",
            PlayTrigger::Step { .. } => "step",
        }
    }
}

/// 注册表里一条下载的角色：后台预取 vs 当前播放接管。
///
/// 切歌时同键条目按角色分流：预取条目可以被新播放直接接管（下载不白跑），
/// 播放条目则说明上一代播放已在途，必须 cancel 后由新一代重开。
pub(crate) enum DlRole {
    Prefetch,
    Playback,
}

/// 下载注册表里的一个条目：下载器本体 + 它当前承担的角色。
pub(crate) struct DlEntry {
    dl: crate::online::progressive::Download,
    role: DlRole,
}

/// 缓存快路径一次提交尝试的三分结果（坏缓存自愈用）。
enum Commit {
    /// 正常提交完成（携带提交结果）。
    Done(PlayOutcome),
    /// 代际已过期：静默收束，不报错、不动缓存。
    Stale,
    /// audio.load 失败且文件位于在线缓存目录：可能是截断/损坏缓存，调用方
    /// 删除该文件后允许新鲜取流重试一次（不 toast、不计失败）。
    BadCache,
}

/// DSP 设置（服务端权威，settings 表持久化）。
#[derive(Debug, Clone, Serialize)]
pub struct DspConfig {
    pub eq_gains_db: [f32; 6],
    pub preamp_db: f32,
    /// 响度归一化档位：`off` / `track` / `album`（folia 的 ReplayGainMode 三档）。
    /// 旧布尔键 `dsp_loudness` 在 from_settings 里迁移成 track/off。
    pub loudness_mode: String,
    pub crossfade_ms: u64,
}

impl DspConfig {
    pub fn from_settings(settings: &std::collections::BTreeMap<String, serde_json::Value>) -> Self {
        let eq = settings
            .get("dsp_eq")
            .and_then(|v| serde_json::from_value::<[f32; 6]>(v.clone()).ok())
            .unwrap_or([0.0; 6]);
        let preamp = settings
            .get("dsp_preamp")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as f32;
        // 新键是三档字符串；老键是布尔（true=track）。都缺省 = off。
        let loudness_mode = settings
            .get("dsp_loudness_mode")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| matches!(s.as_str(), "off" | "track" | "album"))
            .unwrap_or_else(|| {
                let legacy = settings
                    .get("dsp_loudness")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if legacy { "track".into() } else { "off".into() }
            });
        let crossfade = settings
            .get("dsp_crossfade_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        Self {
            eq_gains_db: eq,
            preamp_db: preamp,
            loudness_mode,
            crossfade_ms: crossfade,
        }
    }

    pub fn loudness_enabled(&self) -> bool {
        self.loudness_mode != "off"
    }

    pub fn clamp_eq(&mut self) {
        for v in self.eq_gains_db.iter_mut() {
            *v = v.clamp(-12.0, 12.0);
        }
    }
}

/// 防削波（folia 同款规则）：增益为正时不得超过峰值余量 −20·log10(peak)，
/// 否则提升后的波形会顶到满幅削波。无峰值标签时原样返回，由 DSP 链尾兜底。
pub(crate) fn anti_clip_gain(gain_db: f64, peak: Option<f64>) -> f64 {
    match peak {
        Some(p) if p > 0.0 && p < 1.0 && gain_db > 0.0 => gain_db.min(-20.0 * p.log10()),
        _ => gain_db,
    }
}

/// 听歌打卡的 seek-proof 计时器（folia `PlaybackListenTracker` 的服务端移植）。
///
/// 常量语义：单帧位移正向且 ≤2s 才计入（更大或倒退 = seek，不算收听）；
/// 墙钟兜底防刷（单帧计入量 ≤ 流逝墙钟 ×1.25 + 2s）；累计满 30s、一首最多
/// 报一次。暂停时位置冻结、位移为 0，天然不累计。
#[derive(Default)]
pub(crate) struct ListenTracker {
    track_id: Option<String>,
    listened_ms: u64,
    last_pos: Option<u64>,
    last_at: Option<std::time::Instant>,
    reported: bool,
}

impl ListenTracker {
    /// 喂一帧快照。返回「应结算的旧曲」`(虚拟 id, 有效毫秒)`：换曲/停止时。
    fn feed(&mut self, snap: &PlayerSnapshot) -> Option<(String, u64)> {
        let Some(track_id) = snap.track_id.clone() else {
            return self.reset();
        };
        let now = std::time::Instant::now();
        let mut settle = None;
        if self.track_id.as_deref() != Some(track_id.as_str()) {
            settle = self.reset();
            self.track_id = Some(track_id);
            self.reported = false;
        }
        if let (Some(last_pos), Some(last_at)) = (self.last_pos, self.last_at) {
            let dpos = snap.position_ms.saturating_sub(last_pos);
            let dwell = now.duration_since(last_at).as_millis() as u64;
            if snap.playing && dpos > 0 && dpos <= 2_000 {
                self.listened_ms += dpos.min(dwell + dwell / 4 + 2_000);
            }
        }
        self.last_pos = Some(snap.position_ms);
        self.last_at = Some(now);
        settle
    }

    /// 清零并取走旧曲的结算值。
    fn reset(&mut self) -> Option<(String, u64)> {
        let out = self.harvest();
        self.track_id = None;
        self.listened_ms = 0;
        out
    }

    /// 取走当前曲的结算值（≥30s 且这一轮还没报过才返回 Some）。
    fn harvest(&mut self) -> Option<(String, u64)> {
        if self.reported || self.listened_ms < 30_000 {
            return None;
        }
        let id = self.track_id.clone()?;
        self.reported = true;
        Some((id, self.listened_ms))
    }
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
    pub(crate) radio: Mutex<crate::radio::Radio>,
    pub(crate) radio_fetch: Mutex<()>,
    pub scan: Arc<Mutex<ScanProgress>>,
    pub scan_cancel: Arc<AtomicBool>,
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
    /// 进行中的下载器（缓存键 → 带角色条目），供预取接管与切歌中止。
    pub(crate) downloads: Mutex<HashMap<String, DlEntry>>,
    /// LRU 显式保护名单：在线曲提交成功写入 `{key}.` 前缀（legacy 命中额外
    /// 写命中文件全名），切到本地曲清空；post_commit_background 回收时透传。
    pub(crate) protected: Mutex<Vec<String>>,
    /// DSP 设置（EQ/增益/响度归一化/交叉淡化）。
    pub(crate) dsp: Mutex<DspConfig>,
    /// 用户显式保留的缓存条目（`{stem}.` 前缀，含全部音质档）。启动时从
    /// settings 装载、pin/unpin 即时更新；LRU 回收与手动清理都豁免它。
    pub(crate) keep: Mutex<Vec<String>>,
    /// 在线音频缓存的运行时上限（字节，0 = 不限）。settings 表权威
    /// （`online_cache_max_bytes`），缺键回落 config.toml；设置页热改即时生效。
    pub(crate) cache_max: Mutex<u64>,
    /// 自动接力连续失败计数，任一曲成功提交即清零；累计到 3 停止接力。
    pub(crate) auto_failures: AtomicUsize,
    /// 一轮跳曲走的起点：第一次失败时把「当时在播的那首」记下来，放弃时把游标还给
    /// 它。不记的话每跳一首都把游标还给上一首（那首也是放不了的），界面会高亮一首
    /// 根本没响的曲子。
    pub(crate) skip_walk_from: Mutex<Option<usize>>,
    /// 逐源音质偏好（启动时从 settings 装载、POST 热切换即时更新）。
    pub(crate) quality: Mutex<crate::online::quality::QualityPrefs>,
    /// 节拍分析幂等表：缓存键 → 任务态。
    pub(crate) stage_beats: Mutex<HashMap<String, crate::stage_beats::TaskState>>,
    /// 启动后由 main 注入 Weak：on_track_committed 只有 &self，detach
    /// 'static 任务时凭它拿回 Arc（不改 play_index/step 的签名链）。
    pub(crate) weak_self: std::sync::OnceLock<std::sync::Weak<AppState>>,
    /// 会话恢复的待回放进度：重启时从快照装进来，首次 play 成功提交后
    /// seek 过去并清空（只消费一次，之后的 play/seek 都是用户自己的意图）。
    pub(crate) pending_restore_seek: Mutex<Option<u64>>,
    /// 听歌打卡计时器（网易云在线曲，seek-proof，见 [`ListenTracker`]）。
    pub(crate) listen: Mutex<ListenTracker>,
    /// 曲源接力链中已知放不了的虚拟 id：接力候选排除它们，防止「换源搜
    /// 回来还是同一个坏流」来回横跳。成功提交或整盘换队即清空。
    pub(crate) relay_tried: Mutex<Vec<String>>,
    /// OBS 浮层的歌词记忆化：按 track_id 单槽缓存「源解析后的原始文档」
    /// （用户/全局偏移叠加之前）。浮层页 500ms 轮询，没有缓存的话在线曲
    /// 等于每秒打两次上游歌词接口、本地曲每次重开音频文件读标签。换曲
    /// 自然失效；同一曲播放中导入新歌词要等换曲才反映（OBS 场景可接受）。
    pub(crate) overlay_lyric: Mutex<Option<(String, vmusic_core::LyricDocument)>>,
}

impl AppState {
    pub fn cover_dir(&self) -> PathBuf {
        self.data_dir.join("cache").join("covers")
    }

    pub(crate) fn stage_beats_dir(&self) -> PathBuf {
        self.data_dir.join("stage-beats")
    }

    /// 在线试听的落盘位置。音频后端目前只吃本地文件路径，所以远程流先缓存到
    /// 这里再交给 audio actor —— 播放链路本身完全不变。
    /// 当前播放曲目的响度增益（dB，已含防削波）与所选标签来源；响度归一化
    /// 下发用。`mode` 是调用方持有的档位（off 时不该走到这里）。
    pub(crate) async fn current_loudness(
        &self,
        mode: &str,
    ) -> Option<(f64, &'static str)> {
        let cursor = match *self.cursor.lock().await {
            Some(i) => i,
            None => return None,
        };
        let track_id = self.queue.lock().await.get(cursor)?.clone();
        if crate::online::split_virtual_id(&track_id).is_some() {
            return None; // 在线曲没有 RG 标签
        }
        let rg = vmusic_store::get_track_rg(&self.db, &track_id)
            .await
            .ok()
            .flatten()?;
        // 按专辑档缺专辑标签时回落曲目值（folia 的回退规则）。
        let (gain, peak, from) = if mode == "album" {
            match (rg.album_gain, rg.album_peak) {
                (Some(g), p) => (g, p.or(rg.track_peak), "album"),
                (None, _) => (rg.track_gain?, rg.track_peak, "track(fallback)"),
            }
        } else {
            (rg.track_gain?, rg.track_peak, "track")
        };
        Some((anti_clip_gain(gain, peak), from))
    }

    /// LRU 回收与手动清理的豁免名单：当前播放 + 用户保留项。
    pub(crate) async fn protected_all(&self) -> Vec<String> {
        let mut all = self.protected.lock().await.clone();
        all.extend(self.keep.lock().await.iter().cloned());
        all
    }

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
        {
            let mut radio = self.radio.lock().await;
            radio.active = false;
            radio.loading = false;
            radio.session = radio.session.wrapping_add(1);
            radio.initial_generation = None;
            radio.error = None;
        }
        let prev_queue = self.queue.lock().await.clone();
        let prev_cursor = *self.cursor.lock().await;
        // 整盘换队意味着旧接力链（跟着旧队列的曲）全部作废。
        self.relay_tried.lock().await.clear();
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

    /// 消费会话恢复的待回放进度：>3 秒才 seek（太短的重头播没有体感差），
    /// 一次性——之后的 play/seek 都是用户自己的意图，不再掺和。
    pub(crate) async fn consume_restore_seek(&self) {
        let pending = self.pending_restore_seek.lock().await.take();
        if let Some(pos) = pending {
            if pos > 3000 {
                if let Err(e) = self.audio.seek(pos).await {
                    tracing::warn!("恢复播放进度失败（从头播）: {e}");
                }
            }
        }
    }

    /// 事件泵每帧喂计时器：纯内存累积（只碰一把无争用的锁）；换曲/停止时把
    /// 旧曲的结算甩到独立任务去上报，泵自己绝不碰网络。
    pub(crate) async fn observe_listen(self: &Arc<Self>, snap: &PlayerSnapshot) {
        let settle = {
            let mut tracker = self.listen.lock().await;
            tracker.feed(snap)
        };
        if let Some((id, ms)) = settle {
            Self::spawn_scrobble(self.clone(), id, ms);
        }
    }

    /// 自然播完（Ended）时的结算点：不换曲也要收口，否则最后一首听完不报。
    pub(crate) async fn harvest_listen(self: &Arc<Self>) {
        let settle = {
            let mut tracker = self.listen.lock().await;
            tracker.harvest()
        };
        if let Some((id, ms)) = settle {
            Self::spawn_scrobble(self.clone(), id, ms);
        }
    }

    /// 结算上报（detach）：只认网易云在线曲；`scrobble_enabled` 缺省开。
    /// 失败只记 debug——打卡是增益功能，绝不能给播放链路制造错误条。
    fn spawn_scrobble(state: Arc<AppState>, track_id: String, listened_ms: u64) {
        tokio::spawn(async move {
            let Some((source, id)) = crate::online::split_virtual_id(&track_id) else {
                return;
            };
            if source != "netease" {
                return;
            }
            let enabled = vmusic_store::settings::get(&state.db, "scrobble_enabled")
                .await
                .ok()
                .flatten()
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            if !enabled {
                return;
            }
            // time 参数封顶 10 分钟：畸形计时（快进外的高频帧）也不至于离谱。
            let seconds = (listened_ms / 1000).clamp(30, 600);
            let ctx = crate::routes::online_ctx(&state);
            crate::diaglog!("scrobble.report", track = id.as_str(), seconds = seconds);
            match crate::online::scrobble(&ctx, &source, &id, seconds).await {
                Ok(()) => {
                    tracing::info!("听歌打卡成功：netease:{id}（{seconds}s）");
                    state.publish(WsEvent::Scrobbled {
                        track_id: track_id.clone(),
                    });
                }
                Err(e) => {
                    tracing::debug!("听歌打卡失败（不打扰播放）: {e:?}");
                }
            }
        });
    }

    /// Loads and starts the track at `index` of the current queue.
    pub async fn play_index(&self, index: usize) -> Result<(), vmusic_core::CoreError> {
        self.play_index_for(index, None, PlayTrigger::Pick)
            .await
            .map(|_| ())
    }

    /// 播放指定队列位置；`reserve_gen` 用于 /online/play 的「先占队列后起播」：
    /// 传入 set_queue 返回的代际，进入预留区时代际已被顶掉则返回
    /// `committed=false`（被取代，未提交）。
    ///
    /// `trigger` 决定在线曲取流失败时的处置：点播停在原处回错，接力与主动换曲
    /// 各自按 [`PlayTrigger`] 的方向跳过放不了的曲子。
    pub(crate) async fn play_index_for(
        &self,
        index: usize,
        reserve_gen: Option<usize>,
        trigger: PlayTrigger,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        // 预留区整段持 commit：验代际、读曲、顶新代际、写乐观 cursor 必须相对
        // set_queue 与别的播放预留原子——否则多 worker 下「预闸后队列被换」或
        // 「同队列秒切」都可能让迟到的提交劫持正在听的曲。
        let commit = self.play_commit.lock().await;
        if let Some(expected) = reserve_gen {
            if self.play_generation.load(Ordering::Relaxed) != expected {
                crate::diaglog!("play.stale", idx = index, reason = "队列已被替换");
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
                None => {
                    crate::diaglog!("play.fail", idx = index, reason = "队列里没有这个下标");
                    return Err(vmusic_core::CoreError::NotFound("queue index".into()));
                }
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

        // 诊断日志在这条分岔上记一次开头：在线曲带上音源与平台内 id，本地曲只
        // 有队列 id。后来者靠这一行就能把「点了没反应」分成两条路去查。
        let online_target = crate::online::split_virtual_id(&track_id);
        if let Some((source, id)) = &online_target {
            crate::diaglog!(
                "play.begin",
                idx = index,
                gen = gen,
                kind = "online",
                source = source,
                track = id,
                trigger = trigger.as_str()
            );
        } else {
            crate::diaglog!(
                "play.begin",
                idx = index,
                gen = gen,
                kind = "local",
                track = track_id,
                trigger = trigger.as_str()
            );
        }

        let outcome = if let Some((source, id)) = online_target {
            self.play_online(
                gen,
                index,
                track_id.clone(),
                source,
                id,
                prev_cursor,
                trigger,
            )
            .await
        } else {
            // 本地曲没有 online_failed 那样的收口点，错误直接回给 HTTP——在这里
            // 补一行，否则日志里只有 play.begin 没有下文。
            self.play_local(gen, index, track_id.clone())
                .await
                .inspect_err(|e| {
                    crate::diaglog!(
                        "play.fail",
                        idx = index,
                        gen = gen,
                        kind = "local",
                        code = e.code(),
                        reason = e.to_string()
                    );
                })
        }?;

        if outcome.committed {
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
        // 本地曲不占在线缓存保护位：清空名单，LRU 回归纯 mtime 规则。
        self.protected.lock().await.clear();
        self.cancel_all_downloads().await;
        let track = vmusic_store::get_track(&self.db, &track_id)
            .await
            .map_err(vmusic_core::CoreError::Store)?
            .ok_or_else(|| {
                crate::diaglog!(
                    "play.fail",
                    idx = index,
                    gen = gen,
                    kind = "local",
                    track = track_id,
                    reason = "曲目不在曲库里"
                );
                vmusic_core::CoreError::NotFound(track_id.clone())
            })?;
        // 响度归一化：按档位挑标签（album 缺专辑值回落曲目），增益为正时
        // 用峰值做防削波。失败不影响播放。
        let dsp = self.dsp.lock().await.clone();
        let track_gain_db = if dsp.loudness_enabled() {
            self.current_loudness(&dsp.loudness_mode)
                .await
                .map(|(gain, from)| {
                    crate::diaglog!(
                        "loudness.apply",
                        mode = dsp.loudness_mode.as_str(),
                        from = from,
                        gain_db = gain
                    );
                    gain
                })
                .unwrap_or(0.0) as f32
        } else {
            0.0
        };
        let _ = self
            .audio
            .set_dsp(vmusic_core::DspParams {
                eq_gains_db: dsp.eq_gains_db,
                preamp_db: dsp.preamp_db,
                track_gain_db,
            })
            .await;
        let _commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        // 远程来源：HTTP Range 直链取流（不落盘）；本地/其余走文件路径。
        if track.source == vmusic_core::TrackSource::Remote {
            let url = track.path.clone();
            let auth =
                crate::remote::auth_for_url(&self.db, crate::secrets::backend().as_ref(), &url)
                    .await;
            let ext = std::path::Path::new(&url)
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_string());
            let open_url = url.clone();
            let stream = tokio::task::spawn_blocking(move || {
                crate::remote::HttpRangeStream::open(&open_url, auth.as_ref())
            })
            .await
            .map_err(|e| {
                vmusic_core::CoreError::Audio(vmusic_core::AudioError::BackendInit(e.to_string()))
            })?
            .map_err(|e| {
                vmusic_core::CoreError::Audio(vmusic_core::AudioError::BackendInit(e.to_string()))
            })?;
            // 远程直链的凭据可能在 userinfo 或 query 里，与在线流同规则脱敏。
            crate::diaglog!(
                "play.local",
                idx = index,
                gen = gen,
                via = "remote",
                url = crate::diag::redact_url(&url)
            );
            self.audio
                .load_source(Box::new(stream), ext, Some(track_id.clone()))
                .await
                .map_err(vmusic_core::CoreError::Audio)?;
        } else {
            crate::diaglog!(
                "play.local",
                idx = index,
                gen = gen,
                via = "file",
                path = track.path
            );
            self.audio
                .load(&track.path, Some(track_id.clone()))
                .await
                .map_err(vmusic_core::CoreError::Audio)?;
        }
        // load 已被 actor 处理：若这期间又切了歌，更新一代的命令已排在后面，
        // 本调用绝不能再 play() 或写 cursor。
        if !self.attempt_alive(gen, index, &track_id).await {
            crate::diaglog!("play.stale", idx = index, gen = gen, kind = "local");
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        self.audio
            .play()
            .await
            .map_err(vmusic_core::CoreError::Audio)?;
        crate::diaglog!("play.commit", idx = index, gen = gen, via = "local");
        Ok(PlayOutcome {
            committed: self.attempt_alive(gen, index, &track_id).await,
            actual_quality: None,
        })
    }

    /// 在线曲播放：缓存快路径（不发 buffering，坏缓存自愈一次）→ 预取接管/
    /// 新开渐进式下载 → WaitFull/Progressive 两条提交路。所有网络 await 都在
    /// commit 锁外；只有复核与 actor 入队在锁内。失败一律走
    /// [`Self::online_failed`] 收口。
    //
    // 参数多是有意的分层结果：代际/下标/track_id 是乐观并发三件套，
    // source/id 是在线曲身份，prev_cursor 供失败回退，trigger 决定失败策略——
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
        trigger: PlayTrigger,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        let dir = self.online_cache_dir();
        // 读偏好只在块作用域短持锁：tokio Mutex 不能跨后面的网络 await 持有。
        let quality = {
            let prefs = self.quality.lock().await;
            crate::online::quality::get(&prefs, &source)
        };
        let key = crate::online::cache::cache_key(&source, &id, quality.as_str());
        crate::diaglog!(
            "play.online",
            idx = index,
            gen = gen,
            source = source,
            track = id,
            want = quality.as_str(),
            bps = quality.bps(),
            key = key
        );

        // 进入即收口下载注册表：他键条目一律移除（在跑的 cancel，已完成的
        // 惰性 drop——去删一个已随 rename 消失的 .part 没有意义）；同键条目
        // 按角色分流——Prefetch 取得所有权直接接管（下载不白跑），Playback
        // 说明上一代播放仍在途，cancel 后由新一代重开。
        let takeover: Option<crate::online::progressive::Download> = {
            let mut map = self.downloads.lock().await;
            let others: Vec<String> = map.keys().filter(|k| k.as_str() != key).cloned().collect();
            for k in others {
                if let Some(entry) = map.remove(&k) {
                    if entry.dl.is_finished() {
                        drop(entry);
                    } else {
                        entry.dl.cancel();
                    }
                }
            }
            match map.remove(&key) {
                // 已完成（含刚 rename 完的预取）：丢给下面的缓存快路径命中。
                Some(entry) if entry.dl.is_finished() => {
                    drop(entry);
                    None
                }
                Some(entry) => match entry.role {
                    DlRole::Prefetch => Some(entry.dl),
                    DlRole::Playback => {
                        entry.dl.cancel();
                        None
                    }
                },
                None => None,
            }
        };

        // 快路径：正式名（任意扩展名）或旧名缓存已就绪。find_cached_by_key
        // 是 tokio::fs 的 async 扫描（目录内只有少量缓存文件），直接 await，
        // 不另开 blocking 任务。缓存命中全程不发 buffering——本地文件 load
        // 是毫秒级，先亮 loading 再立刻灭只会让播放键闪一下（修 M6）。
        if let Some(path) =
            crate::online::cache::find_cached_by_key(&dir, &source, &id, quality.as_str()).await
        {
            crate::diaglog!(
                "cache.hit",
                idx = index,
                gen = gen,
                key = key,
                path = path.display()
            );
            match self
                .try_commit_cached(gen, index, &track_id, &path, None)
                .await?
            {
                Commit::Done(outcome) => {
                    if outcome.committed {
                        crate::diaglog!("play.commit", idx = index, gen = gen, via = "cached");
                        self.note_protected(&key, Some(&path)).await;
                    }
                    return Ok(outcome);
                }
                Commit::Stale => {
                    crate::diaglog!("play.stale", idx = index, gen = gen, via = "cached");
                    return Ok(PlayOutcome {
                        committed: false,
                        actual_quality: None,
                    });
                }
                // 坏缓存：删文件后落到下面的新鲜取流流程，静默重试一次
                // （不 toast、不计失败）。
                Commit::BadCache => {
                    tracing::warn!(?path, "缓存文件无法解码，删除并新鲜重取一次");
                    crate::diaglog!(
                        "cache.bad",
                        idx = index,
                        gen = gen,
                        path = path.display(),
                        action = "删除并新鲜重取"
                    );
                    let _ = tokio::fs::remove_file(&path).await;
                }
            }
        }

        // 缓存确认未命中（或刚自愈删掉坏缓存）才亮缓冲覆盖态（修 I8）。
        self.set_buffering(true, None).await;

        // 同键预取在跑则 owned 接管（实际档位无法回填）；否则现场取流并新开
        // 渐进式下载。
        let (dl, actual) = if let Some(dl) = takeover {
            crate::diaglog!(
                "download.takeover",
                idx = index,
                gen = gen,
                key = key,
                from = "prefetch"
            );
            (dl, None)
        } else {
            let ctx = crate::online::Ctx {
                db: self.db.clone(),
            };
            let info =
                match crate::online::stream(&ctx, &source, &id, None, Some(quality.bps())).await {
                    Ok(v) => v,
                    Err(e) => {
                        crate::diaglog!(
                            "stream.fail",
                            idx = index,
                            gen = gen,
                            source = source,
                            code = e.code,
                            reason = e.message
                        );
                        self.set_buffering(false, None).await;
                        return self
                            .online_failed(
                                gen,
                                index,
                                track_id,
                                prev_cursor,
                                trigger,
                                e.with_source(source),
                            )
                            .await;
                    }
                };
            let actual = crate::online::quality::from_bitrate(info.bitrate);
            // 地址只记 host+path：query 里是签名与临时 token，而这份文件要发给
            // 开发者。域名足以认出 CDN，具体参数开发者查不到也不该查。
            crate::diaglog!(
                "stream.ok",
                idx = index,
                gen = gen,
                source = source,
                url = crate::diag::redact_url(&info.url),
                extra_urls = info.fallback_urls.len(),
                bitrate = info.bitrate.unwrap_or(0),
                actual = actual.map(|q| q.as_str()).unwrap_or("unknown"),
                expires_secs = info.expires_in_secs.unwrap_or(0)
            );
            let urls: Vec<String> = std::iter::once(info.url)
                .chain(info.fallback_urls)
                .collect();
            let referer = crate::online::referer(&source).map(str::to_string);
            match crate::online::progressive::start(dir.clone(), key.clone(), urls, referer) {
                Ok(dl) => (dl, actual),
                Err(e) => {
                    crate::diaglog!(
                        "download.start_fail",
                        idx = index,
                        gen = gen,
                        key = key,
                        code = e.code,
                        reason = e.message
                    );
                    self.set_buffering(false, None).await;
                    return self
                        .online_failed(gen, index, track_id, prev_cursor, trigger, e)
                        .await;
                }
            }
        };

        // 播放流程持视图轮询；Download 所有权注册进 map，随代际可被中止/接管。
        // entry 原子落槽：开头摘同键与此处之间隔着取流 await，双击/并发预取
        // 可能已重新塞进同键条目——先 cancel 旧的再插入，槽位必须归本播放
        // 流程持有的这个 dl（后面靠 key 摘它做 cancel/join）。
        let view = dl.view();
        match self.downloads.lock().await.entry(key.clone()) {
            Entry::Vacant(v) => {
                v.insert(DlEntry {
                    dl,
                    role: DlRole::Playback,
                });
            }
            Entry::Occupied(mut o) => {
                o.get().dl.cancel();
                o.insert(DlEntry {
                    dl,
                    role: DlRole::Playback,
                });
            }
        }

        // 等预读阈值：每轮一个 200ms tick，轮间复核代际——用户切走立刻摘条目
        // 并 cancel，旧代际的等待再也拖不住新一代（修 B3）。
        loop {
            if !self.attempt_alive(gen, index, &track_id).await {
                crate::diaglog!("play.stale", idx = index, gen = gen, via = "prebuffer");
                self.cancel_download(&key).await;
                self.set_buffering(false, None).await;
                return Ok(PlayOutcome {
                    committed: false,
                    actual_quality: None,
                });
            }
            match view.prebuffer_tick().await {
                Ok(true) => break,
                Ok(false) => continue,
                Err(e) => {
                    self.cancel_download(&key).await;
                    self.set_buffering(false, None).await;
                    return self
                        .online_failed(
                            gen,
                            index,
                            track_id,
                            prev_cursor,
                            trigger,
                            crate::error::ApiError::upstream_timeout(e).with_source(source),
                        )
                        .await;
                }
            }
        }

        // 容器探测：读 .part 前 1MB（blocking 任务做同步读）；文件打不开时
        // 保守按 WaitFull + 下载器自己嗅探出的扩展名处理。
        let (mode, ext) = {
            let part = view.part_path().to_path_buf();
            let sniffed = view.ext();
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
        crate::diaglog!(
            "download.plan",
            idx = index,
            gen = gen,
            key = key,
            mode = if mode == crate::online::progressive::StreamMode::WaitFull {
                "wait-full"
            } else {
                "progressive"
            },
            ext = ext,
            pct = view.pct().unwrap_or(0)
        );

        if mode == crate::online::progressive::StreamMode::WaitFull {
            // late-moov m4a：等整首下完。每 200ms 推一次百分比并复核代际，
            // 用户切走立刻取消，不让迟到下载回来劫持新歌。
            loop {
                if !self.attempt_alive(gen, index, &track_id).await {
                    crate::diaglog!("play.stale", idx = index, gen = gen, via = "wait-full");
                    self.cancel_download(&key).await;
                    self.set_buffering(false, None).await;
                    return Ok(PlayOutcome {
                        committed: false,
                        actual_quality: None,
                    });
                }
                self.set_buffering(true, view.pct()).await;
                if view.is_finished() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            // join 消费 Download：先从注册表摘下取得所有权，成功后再提交。
            let dl = {
                let mut map = self.downloads.lock().await;
                map.remove(&key).map(|entry| entry.dl)
            };
            let Some(dl) = dl else {
                self.set_buffering(false, None).await;
                return self
                    .online_failed(
                        gen,
                        index,
                        track_id,
                        prev_cursor,
                        trigger,
                        crate::error::ApiError::upstream_rejected("下载条目已丢失")
                            .with_source(source),
                    )
                    .await;
            };
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
                            trigger,
                            crate::error::ApiError::upstream_rejected(e).with_source(source),
                        )
                        .await;
                }
            };
            self.set_buffering(false, None).await;
            // 新鲜下载不做坏缓存二次重试：提交失败删终文件后直接按失败收口。
            return self
                .commit_fresh(
                    gen,
                    index,
                    track_id,
                    &key,
                    path,
                    actual,
                    prev_cursor,
                    trigger,
                    source,
                )
                .await;
        }

        // Progressive：头部元数据已齐，解码源直接读 .part，读到哪等到哪。
        // HttpMediaSource 显式 impl AudioSource（media_len 透传 Content-Length）。
        let (part_path, src_inner, src_abort) = view.media_parts();
        let media = match crate::online::progressive::HttpMediaSource::open(
            &part_path, src_inner, src_abort,
        ) {
            Ok(m) => m,
            Err(e) => {
                self.cancel_download(&key).await;
                self.set_buffering(false, None).await;
                return self
                    .online_failed(
                        gen,
                        index,
                        track_id,
                        prev_cursor,
                        trigger,
                        crate::error::ApiError::internal(e.to_string()).with_source(source),
                    )
                    .await;
            }
        };

        let commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            // 新一代的注册表收口通常已把本条目 cancel 摘掉；这里兜底一次。
            drop(commit);
            self.cancel_download(&key).await;
            self.set_buffering(false, None).await;
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
            // 新鲜下载 load 失败：摘条目 cancel（删掉 .part）后按失败收口。
            self.cancel_download(&key).await;
            self.set_buffering(false, None).await;
            return self
                .online_failed(
                    gen,
                    index,
                    track_id,
                    prev_cursor,
                    trigger,
                    crate::error::ApiError::internal(e.to_string()).with_source(source),
                )
                .await;
        }
        if !self.attempt_alive(gen, index, &track_id).await {
            crate::diaglog!("play.stale", idx = index, gen = gen, via = "progressive");
            self.set_buffering(false, None).await;
            // 已装入 actor 但被顶代际：不取消下载也不摘条目，后台跑完照样
            // rename 落缓存（后续播放会惰性清理或按角色接管）。
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        // load_source 已成功：之后 play() 失败不再删下载/缓存，统一走失败收口。
        let play = self.audio.play().await;
        let committed = self.attempt_alive(gen, index, &track_id).await;
        self.set_buffering(false, None).await;
        if let Err(e) = play {
            return self
                .online_failed(
                    gen,
                    index,
                    track_id,
                    prev_cursor,
                    trigger,
                    crate::error::ApiError::internal(e.to_string()).with_source(source),
                )
                .await;
        }
        // Progressive 提交成功：条目留在注册表，后台任务继续到 rename 完；
        // 后续播放惰性清理已完成条目，切歌则按角色 cancel。
        if committed {
            crate::diaglog!(
                "play.commit",
                idx = index,
                gen = gen,
                via = "progressive",
                actual = actual.map(|q| q.as_str()).unwrap_or("unknown")
            );
            self.note_protected(&key, None).await;
        }
        Ok(PlayOutcome {
            committed,
            actual_quality: actual,
        })
    }

    /// 缓存文件（历史命中或刚 join 的新鲜下载终文件）的提交尝试，三分结果
    /// 见 [`Commit`]。不碰 buffering，由调用方按所处阶段收口。
    ///
    /// 仅当 load 失败且文件位于在线缓存目录时才判 [`Commit::BadCache`]；
    /// load 成功之后的 play() 失败以 Err 返回——那不是缓存损坏，调用方按
    /// online_failed 处理且不得删缓存。
    async fn try_commit_cached(
        &self,
        gen: usize,
        index: usize,
        track_id: &str,
        path: &Path,
        actual: Option<crate::online::quality::Quality>,
    ) -> Result<Commit, vmusic_core::CoreError> {
        let _commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, track_id).await {
            return Ok(Commit::Stale);
        }
        let Some(uri) = path.to_str() else {
            return Err(vmusic_core::CoreError::NotFound(
                "路径含非 UTF-8 字符".into(),
            ));
        };
        if let Err(e) = self.audio.load(uri, Some(track_id.to_string())).await {
            let in_cache_dir = path.parent().is_some_and(|p| p == self.online_cache_dir());
            if in_cache_dir {
                tracing::warn!(?path, error = %e, "缓存文件 load 失败，判为坏缓存");
                return Ok(Commit::BadCache);
            }
            return Err(vmusic_core::CoreError::Audio(e));
        }
        if !self.attempt_alive(gen, index, track_id).await {
            return Ok(Commit::Stale);
        }
        self.audio
            .play()
            .await
            .map_err(vmusic_core::CoreError::Audio)?;
        let committed = self.attempt_alive(gen, index, track_id).await;
        Ok(Commit::Done(PlayOutcome {
            committed,
            actual_quality: actual,
        }))
    }

    /// WaitFull 新鲜下载 join 完成后的提交收口：坏缓存不二次重试（只删文件
    /// + online_failed）；play() 失败保留缓存走 online_failed。
    #[allow(clippy::too_many_arguments)]
    async fn commit_fresh(
        &self,
        gen: usize,
        index: usize,
        track_id: String,
        key: &str,
        path: PathBuf,
        actual: Option<crate::online::quality::Quality>,
        prev_cursor: Option<usize>,
        trigger: PlayTrigger,
        source: String,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        match self
            .try_commit_cached(gen, index, &track_id, &path, actual)
            .await
        {
            Ok(Commit::Done(outcome)) => {
                if outcome.committed {
                    crate::diaglog!(
                        "play.commit",
                        idx = index,
                        gen = gen,
                        via = "downloaded",
                        file = path.file_name().unwrap_or_default().display(),
                        actual = actual.map(|q| q.as_str()).unwrap_or("unknown")
                    );
                    self.note_protected(key, Some(&path)).await;
                }
                Ok(outcome)
            }
            Ok(Commit::Stale) => Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            }),
            Ok(Commit::BadCache) => {
                let _ = tokio::fs::remove_file(&path).await;
                self.online_failed(
                    gen,
                    index,
                    track_id,
                    prev_cursor,
                    trigger,
                    crate::error::ApiError::internal("下载完成但无法解码").with_source(source),
                )
                .await
            }
            Err(e) => {
                self.online_failed(
                    gen,
                    index,
                    track_id,
                    prev_cursor,
                    trigger,
                    crate::error::ApiError::internal(e.to_string()).with_source(source),
                )
                .await
            }
        }
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
        for (_, entry) in map.drain() {
            entry.dl.cancel();
        }
    }

    /// 摘出指定键的下载条目并 cancel（代际过期/下载失败时调用）。短锁。
    async fn cancel_download(&self, key: &str) {
        if let Some(entry) = self.downloads.lock().await.remove(key) {
            entry.dl.cancel();
        }
    }

    /// 在线曲提交成功后登记 LRU 保护项：始终写 `{key}.` 前缀（保护同键
    /// 任意扩展名的正式缓存文件）；若命中的是 legacy 全名文件（文件名不带
    /// 该前缀），额外按全名保护。去重写入；play_local 时整体清空。
    async fn note_protected(&self, key: &str, hit: Option<&Path>) {
        let mut protected = self.protected.lock().await;
        let prefix = format!("{key}.");
        if let Some(name) = hit.and_then(|p| p.file_name()).and_then(|n| n.to_str()) {
            // legacy 全名命中（文件名不带新键前缀）：额外按全名保护。
            if !name.starts_with(&prefix) && !protected.contains(&name.to_string()) {
                protected.push(name.to_string());
            }
        }
        if !protected.contains(&prefix) {
            protected.push(prefix);
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
        // 跳曲走结束了：起点锚只在一次「连着跳了好几首」的过程中有意义。
        *self.skip_walk_from.lock().await = None;
        // 接力链结束了：这一串已试过的坏流不再需要记忆。
        self.relay_tried.lock().await.clear();
        self.record_history(track_id).await;
        // 实际档位本任务只回传给 /online/play 响应；后续统计/打点再消费。
        let _ = actual;
        // 节拍分析：成功起播后后台 detach，覆盖手动点播/重播/在线播放/自动接力
        // 四条提交路径（committed 是唯一收口）。不 await、不阻塞播放链路。
        if let Some(arc) = self.weak_self.get().and_then(std::sync::Weak::upgrade) {
            crate::stage_beats::spawn_after_commit(arc, track_id.to_string());
        }
    }

    /// 曲目确认成功起播（committed/Ok）后的后台收口：预取后一首，再做一次
    /// 缓存容量回收。必须由「成功播放入口」在提交成功后恰好调用一次：
    /// 自动接力在事件泵入口、手动点播在各路由入口。
    ///
    /// 整个流程 detach：调用方不等它，HTTP 响应与接力不被取流拖慢。
    /// 当前播放曲经 protected 名单显式豁免（外加「最新文件始终保留」兜底），
    /// 不会被 LRU 回收掉。
    pub(crate) fn post_commit_background(self: &Arc<Self>) {
        let s = self.clone();
        tokio::spawn(async move {
            let _ = tokio::join!(s.radio_refill(false), s.spawn_prefetch());
            // 显式保护当前播放曲（前缀 + 可能的 legacy 全名），避免它在容量
            // 回收时被删掉——「最新文件始终保留」只在同一次回收内成立，跨次
            // 回收后当前曲可能已不是最新。
            let protected = s.protected_all().await;
            // 0 = 不限：enforce_limit 会把 0 当成「删到什么都不剩」，这里必须挡。
            let max = *s.cache_max.lock().await;
            if max > 0 {
                if let Err(e) =
                    crate::online::cache::enforce_limit(&s.online_cache_dir(), max, &protected)
                        .await
                {
                    tracing::warn!("缓存 LRU 回收失败: {e}");
                }
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
                // entry 原子落槽：前面的 contains_key 检查与这里之间隔着
                // 取流 await，并发预取/播放接管可能已占下同键槽位——先 cancel
                // 旧的再插入本次预取。
                match self.downloads.lock().await.entry(key) {
                    Entry::Vacant(v) => {
                        v.insert(DlEntry {
                            dl,
                            role: DlRole::Prefetch,
                        });
                    }
                    Entry::Occupied(mut o) => {
                        o.get().dl.cancel();
                        o.insert(DlEntry {
                            dl,
                            role: DlRole::Prefetch,
                        });
                    }
                }
            }
            Err(e) => tracing::debug!("预取启动失败: {}", e.message),
        }
    }

    /// 这一类失败值得跨源找同一首接力（folia 失效分类的「可恢复」语义）：
    /// 曲目下架/删除、VIP 限制、需登录、流被上游拒绝、下载/解码失败——都是
    /// 「这一首在原音源放不了」。上游整体超时（网络抖动）与能力/参数错误
    /// 不接力：换一个音源救不了网络，也轮不到接力去修参数。
    fn relay_eligible(code: &str) -> bool {
        matches!(
            code,
            "not_found"
                | "vip_required"
                | "auth_required"
                | "upstream_rejected"
                | "internal"
                | "decode_stalled"
        )
    }

    /// 曲源自动接力：原音源失效的在线曲，按「标题+歌手+时长」在其余音源
    /// 找同一首，找到就把队列这一项换成新源的虚拟 id 并重新走一遍播放。
    /// 返回 true = 接力已发起（成败由新一轮播放自理，本层不再处置）；
    /// false = 开关关闭/无元数据/无候选/用户已切走，调用方走原失败路径。
    ///
    /// 时序纪律：聚合搜索（单源 6s 预算）全程不持 `play_commit`——提交尾部
    /// 的串行锁绝不被网络拖住。搜索回来后重新过 `attempt_alive` 闸门再原子
    /// 替换，用户中途切走则静默放弃。防环靠 [`Self::relay_tried`]：候选池
    /// 随每次接力单调缩小，穷尽后自然回落到既有跳曲路径。
    async fn try_relay(
        &self,
        gen: usize,
        index: usize,
        track_id: String,
        trigger: PlayTrigger,
    ) -> bool {
        let enabled = vmusic_store::settings::get(&self.db, "online_auto_relay")
            .await
            .ok()
            .flatten()
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if !enabled {
            return false;
        }
        let Some(failed_source) = crate::online::split_virtual_id(&track_id).map(|(s, _)| s)
        else {
            return false;
        };
        // 匹配输入只认入队快照：重启后从歌单直播（无快照）宁可放弃接力，
        // 也不拿平台 id 当标题去搜。
        let meta = match self.online_meta.lock().await.get(&track_id).cloned() {
            Some(m) if !m.title.trim().is_empty() => m,
            _ => return false,
        };
        // 已知坏流先登记：候选排除它自己（虚拟 id 形态），也防接力链回头。
        {
            let mut tried = self.relay_tried.lock().await;
            if !tried.contains(&track_id) {
                // 上限兜底：极端连环失败下记忆不许无限增长。
                if tried.len() >= 64 {
                    tried.clear();
                }
                tried.push(track_id.clone());
            }
        }
        let query = match meta.artist.as_deref() {
            Some(a) if !a.trim().is_empty() => format!("{} {}", meta.title, a),
            _ => meta.title.clone(),
        };
        crate::diaglog!(
            "relay.begin",
            idx = index,
            gen = gen,
            track = track_id,
            from = failed_source,
            title = meta.title,
            trigger = trigger.as_str()
        );
        self.set_buffering(true, None).await;
        let ctx = crate::online::Ctx {
            db: self.db.clone(),
        };
        let searched = crate::online::search_all(&ctx, &query, 8).await;
        let agg = match searched {
            Ok(agg) => agg,
            Err(e) => {
                crate::diaglog!("relay.miss", reason = e.message);
                self.set_buffering(false, None).await;
                return false;
            }
        };
        let tried = self.relay_tried.lock().await.clone();
        let mut best: Option<(u32, crate::online::OnlineTrack)> = None;
        for page in &agg.results {
            if page.source == failed_source {
                continue;
            }
            for t in &page.tracks {
                let vid = crate::online::virtual_id(&page.source, &t.id);
                if tried.contains(&vid) {
                    continue;
                }
                if let Some(score) = relay_score(t, &meta.title, meta.artist.as_deref(), meta.duration_ms)
                {
                    if best.as_ref().map_or(true, |(s, _)| score > *s) {
                        best = Some((score, t.clone()));
                    }
                }
            }
        }
        let Some((score, cand)) = best else {
            crate::diaglog!("relay.miss", idx = index, gen = gen, title = meta.title);
            self.set_buffering(false, None).await;
            return false;
        };
        let new_id = crate::online::virtual_id(&cand.source, &cand.id);
        crate::diaglog!(
            "relay.hit",
            idx = index,
            gen = gen,
            from = failed_source,
            to = cand.source,
            score = score,
            title = cand.title
        );
        // 搜索是数秒 await：复核 + 替换必须在提交锁内一次性完成，中途用户
        // 切走（代际被顶 / 队列该位已不是原曲）就整段放弃。
        let commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            self.set_buffering(false, None).await;
            return false;
        }
        {
            let mut queue = self.queue.lock().await;
            if queue.get(index) != Some(&track_id) {
                self.set_buffering(false, None).await;
                return false;
            }
            queue[index] = new_id.clone();
        }
        // 元数据迁到新虚拟 id 名下：title/artist/album/cover 保留原快照写法
        //（同一首歌，界面不应跳变），时长用候选的实际值校正。
        {
            let mut map = self.online_meta.lock().await;
            let mut snap = map.remove(&track_id).unwrap_or_else(|| OnlineMetaSnap {
                title: cand.title.clone(),
                artist: Some(cand.artist.clone()).filter(|s| !s.is_empty()),
                album: Some(cand.album.clone()).filter(|s| !s.is_empty()),
                cover: cand.cover.clone(),
                duration_ms: Some(cand.duration_ms).filter(|d| *d > 0),
            });
            if cand.duration_ms > 0 {
                snap.duration_ms = Some(cand.duration_ms);
            }
            map.insert(new_id.clone(), snap);
        }
        drop(commit);
        // 换源续播：接力链再失败会重新进 online_failed，relay_tried 已把旧
        // id 登记在案，候选池单调缩小直到穷尽，无死循环。成功后新一轮播放
        // 自己完成提交收口（历史/打卡/预取），这里只补上「接力成功」的告知。
        let relayed = matches!(
            Box::pin(self.play_index_for(index, None, trigger)).await,
            Ok(outcome) if outcome.committed
        );
        if relayed {
            crate::diaglog!(
                "relay.commit",
                idx = index,
                to = cand.source,
                track = new_id
            );
            self.publish(WsEvent::SourceSwitched {
                track_id: new_id,
                from_source: failed_source.clone(),
                to_source: cand.source.clone(),
                to_label: crate::online::find(&cand.source)
                    .map(|s| s.label)
                    .unwrap_or("其他音源")
                    .to_string(),
                title: meta.title,
            });
            if let Some(arc) = self.weak_self.get().and_then(std::sync::Weak::upgrade) {
                arc.post_commit_background();
            }
        }
        relayed
    }

    /// 在线曲播放失败的统一收口（取流/下载/解码失败都汇到这里）。
    /// 仍属当代时把 cursor 恢复到切入前，不让 next/prev 从一首没播起来的
    /// 曲算起；已被用户切走则整体静默（连 Err 都不回）。
    ///
    /// 是否接着往下找由 [`PlayTrigger::skip_direction`] 决定：
    /// - 接力（AutoNext）：任何失败都算这首跳过，连续 3 首发终态事件并返回 Err。
    /// - 主动换曲（Step）：只有「这首本身放不了」才同方向继续找，跨过整支队列仍
    ///   找不到才发终态事件；上游整体故障不试，免得一次限流烧穿整队。
    /// - 点播（Pick）：推原始错误（不停服务），返回 Err 交回 HTTP 调用方，由前端
    ///   错误条引导重试。
    ///
    /// 接力入口在最前面、且不持 `play_commit`：跨源搜索是数秒 await，提交
    /// 尾部的串行锁绝不被它拖住；接力失败（含用户中途切走）才落回原路径。
    async fn online_failed(
        &self,
        gen: usize,
        index: usize,
        track_id: String,
        prev_cursor: Option<usize>,
        trigger: PlayTrigger,
        e: crate::error::ApiError,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        // 所有在线播放失败的收口点：这一行就是「为什么这首没响」的答案。写在
        // 最前面，因为下面的分支会把 e 的字段逐个 move 掉。
        crate::diaglog!(
            "play.fail",
            idx = index,
            gen = gen,
            track = track_id,
            trigger = trigger.as_str(),
            code = e.code,
            source = e.source.clone().unwrap_or_default(),
            reason = e.message
        );
        // F1 曲源自动接力：这首本身放不了时先试跨源救回，救不回才按
        // trigger 的既有语义跳曲/报错。接力期间 buffering 自理。先做一次
        // 锁外代际复核（attempt_alive 允许的非提交复核）：用户已切走就不
        // 白跑数秒的跨源搜索；try_relay 内部复核与替换仍在提交锁内。
        if Self::relay_eligible(&e.code)
            && self.attempt_alive(gen, index, &track_id).await
            && Box::pin(self.try_relay(gen, index, track_id.clone(), trigger)).await
        {
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        let commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            // 被顶代际：为跳过的曲子弹错、抢光标、给迟到的 HTTP 响应塞 404
            // 都不对。
            crate::diaglog!(
                "play.stale",
                idx = index,
                gen = gen,
                reason = "失败收口时代际已过期"
            );
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        *self.cursor.lock().await = prev_cursor;

        if let Some(delta) = trigger.skip_direction(e.code) {
            let n = self.auto_failures.fetch_add(1, Ordering::Relaxed) + 1;
            // 起点锚在每轮的第一次失败时定下：那时 prev_cursor 指的是用户此刻真正在
            // 听的那首。后面几次失败的 prev_cursor 已经是刚跳空的那首了。
            if n == 1 {
                *self.skip_walk_from.lock().await = prev_cursor;
            }
            crate::diaglog!(
                "play.skip",
                idx = index,
                gen = gen,
                streak = n,
                by = trigger.as_str(),
                title = track_title(&track_id)
            );
            self.publish(WsEvent::Error {
                message: format!("《{}》暂不可用，已跳过", track_title(&track_id)),
                code: Some(e.code.to_string()),
                source: e.source.clone(),
                index: None,
            });
            let cap = trigger.streak_cap(self.queue.lock().await.len());
            if n >= cap {
                crate::diaglog!(
                    "play.streak_stop",
                    streak = n,
                    by = trigger.as_str(),
                    reason = "连续取流失败，停止跳曲"
                );
                // 放弃即结束接力链：这一串坏流记忆随跳曲走一起作废。
                self.relay_tried.lock().await.clear();
                self.publish(WsEvent::Error {
                    message: "连续多首无法播放，已停止。可检查音源登录或网络后重试。".into(),
                    code: Some("online_unavailable_streak".to_string()),
                    source: e.source,
                    index: None,
                });
                // 放弃：游标还给还在播的那首，而不是最后一首跳空的。
                let anchor = *self.skip_walk_from.lock().await;
                *self.cursor.lock().await = anchor;
                *self.skip_walk_from.lock().await = None;
                return Err(vmusic_core::CoreError::NotFound(e.message));
            }
            // 游标停在「这首」上再走一步：上面那行把它回滚成 prev_cursor 是有意的
            // （放弃时不能从一首没播起来的曲算起），但跳过必须反过来——留着回滚就
            // 等于「重试同一首三次」，接力与手动换曲都会卡在第一首都放不了的曲子前。
            *self.cursor.lock().await = Some(index);
            drop(commit);
            // 同方向再走一步（仍按当前模式 step；其成功提交会清零失败计数）。
            // step_for → play_index_for → play_online → online_failed 与本函数构成
            // async 递归，future 尺寸无限；这一边必须 Box::pin 引入间接。
            let _ = Box::pin(self.step_for(delta, trigger, None, None)).await;
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }

        // 不跳的两种情况（点播，以及主动换曲撞上上游整体故障）：错误条带失败曲的
        // 队列下标，重试不再靠快照反查（修 I5）。
        self.publish(WsEvent::Error {
            message: e.message.clone(),
            code: Some(e.code.to_string()),
            source: e.source,
            index: Some(index),
        });
        Err(vmusic_core::CoreError::NotFound(e.message))
    }

    /// actor 报「解码线程非主动中断的早夭」（[`AudioEvent::DecodeError`]）后
    /// 的收口，由事件泵甩到独立任务执行（绝不能堵住泵本身）：
    ///
    /// - 在线曲：按当前音质偏好算缓存键，取消同键在途下载（清理失败 .part），
    ///   连续失败 +1 后自动 step 到下一首；累计到 3 只发终态事件、不再跳。
    /// - 本地曲：只发一条普通错误提示。
    /// - 结束前无条件关闭缓冲覆盖态。
    ///
    pub(crate) async fn handle_decode_failure(
        self: &Arc<Self>,
        track_id: Option<String>,
        generation: u64,
    ) {
        let commit = self.play_commit.lock().await;
        let snapshot = self.audio.snapshot();
        if snapshot.generation != generation || snapshot.track_id.is_some() {
            return;
        }
        let reservation = self.play_generation.load(Ordering::Relaxed);
        let mut advance = false;
        let Some(track_id) = track_id else {
            crate::diaglog!(
                "decode.fail",
                gen = generation,
                reason = "actor 未报告在播曲目"
            );
            self.publish(WsEvent::Error {
                message: "播放中断".into(),
                code: Some("decode_stalled".into()),
                source: None,
                index: None,
            });
            self.set_buffering(false, None).await;
            return;
        };

        // 防御纵深：DecodeError 从解码线程冒到事件泵是异步的，期间用户可能
        // 已经切走、新代际正在播放。事件 track_id 必须仍是当前 cursor 指向的
        // 队列项；不一致说明这是旧曲的残留事件——直接静默返回，不发任何事件、
        // 不 step、不动连续失败计数，更不能顶掉新曲（缓冲态也由新流程自理）。
        {
            let queue = self.queue.lock().await;
            let current = *self.cursor.lock().await;
            if current.and_then(|i| queue.get(i)) != Some(&track_id) {
                tracing::debug!(?track_id, "丢弃过期 DecodeError：cursor 已指向新曲目");
                crate::diaglog!("decode.stale", track = track_id, gen = generation);
                return;
            }
        }

        if let Some((source, id)) = crate::online::split_virtual_id(&track_id) {
            let quality = {
                let prefs = self.quality.lock().await;
                crate::online::quality::get(&prefs, &source)
            };
            let key = crate::online::cache::cache_key(&source, &id, quality.as_str());
            // 失败下载随条目一并 cancel（删 .part），避免它继续落坏缓存。
            if let Some(entry) = self.downloads.lock().await.remove(&key) {
                entry.dl.cancel();
            }
            // 标题优先取入队时的元数据快照，缺失退化到 id 尾段。
            let label = {
                let meta = self.online_meta.lock().await;
                meta.get(&track_id)
                    .map(|m| m.title.clone())
                    .unwrap_or_else(|| track_title(&track_id))
            };
            let n = self.auto_failures.fetch_add(1, Ordering::Relaxed) + 1;
            crate::diaglog!(
                "decode.fail",
                kind = "online",
                gen = generation,
                source = source,
                track = id,
                key = key,
                streak = n,
                title = label
            );
            self.publish(WsEvent::Error {
                message: format!("《{label}》播放中断，已跳过"),
                code: Some("decode_stalled".into()),
                source: Some(source.clone()),
                index: None,
            });
            if n >= 3 {
                crate::diaglog!("play.streak_stop", streak = n, reason = "解码连续早夭");
                // 放弃即结束接力链：这一串坏流记忆随跳曲走一起作废。
                self.relay_tried.lock().await.clear();
                self.publish(WsEvent::Error {
                    message: "连续多首无法播放，已停止。可检查音源登录或网络后重试。".into(),
                    code: Some("online_unavailable_streak".into()),
                    source: Some(source),
                    index: None,
                });
            } else {
                advance = true;
            }
        } else {
            crate::diaglog!(
                "decode.fail",
                kind = "local",
                gen = generation,
                track = track_id
            );
            self.publish(WsEvent::Error {
                message: "播放中断".into(),
                code: Some("decode_stalled".into()),
                source: None,
                index: None,
            });
        }
        self.set_buffering(false, None).await;
        drop(commit);
        // F1 曲源接力：解码早夭的在线曲先试跨源救回（坏缓存自愈已失败过一次，
        // 这条流本身大概率有问题），救不回才按 AutoNext 跳曲。接力成功时新一轮
        // 播放自理提交收口，这里直接返回。
        if advance {
            let index = *self.cursor.lock().await;
            let relayed = match index {
                Some(index) => {
                    Box::pin(
                        self.try_relay(reservation, index, track_id.clone(), PlayTrigger::AutoNext),
                    )
                    .await
                }
                None => false,
            };
            if relayed {
                return;
            }
        }
        if advance
            && Box::pin(self.step_for(1, PlayTrigger::AutoNext, None, Some(reservation)))
                .await
                .is_ok()
        {
            self.post_commit_background();
        }
    }

    /// Moves the queue according to the current play mode.
    ///
    /// `auto` is true when the move comes from a track finishing rather than a
    /// button press: `RepeatOne` only repeats on auto, a user pressing "next"
    /// always moves forward. A failed play attempt is reported back as-is — use
    /// [`Self::step_by_user`] for the 上一曲/下一曲 buttons, which keep looking.
    pub async fn step(&self, delta: isize, auto: bool) -> Result<(), vmusic_core::CoreError> {
        self.step_for(
            delta,
            if auto {
                PlayTrigger::AutoNext
            } else {
                PlayTrigger::Pick
            },
            None,
            None,
        )
        .await
    }

    /// 用户按「上一曲/下一曲」。和 [`Self::step`] 的差别只在失败处置：按下按钮要的
    /// 是「换一首能播的」，所以撞上本身放不了的曲子（VIP、需登录、曲目已失效）会按
    /// 同一方向继续找；上游整体不健康时不试，直接把错误交回去。
    pub async fn step_by_user(&self, delta: isize) -> Result<(), vmusic_core::CoreError> {
        self.step_for(delta, PlayTrigger::Step { delta }, None, None)
            .await
    }

    async fn step_for(
        &self,
        delta: isize,
        trigger: PlayTrigger,
        ended: Option<(u64, Option<String>)>,
        reservation: Option<usize>,
    ) -> Result<(), vmusic_core::CoreError> {
        let before_refill = self.play_generation.load(Ordering::Relaxed);
        let at_tail = {
            let queue = self.queue.lock().await;
            self.cursor.lock().await.unwrap_or(0).saturating_add(1) >= queue.len()
        };
        if delta > 0 && at_tail {
            let _ = self.radio_refill(false).await;
        }
        let commit = self.play_commit.lock().await;
        if self.play_generation.load(Ordering::Relaxed) != before_refill {
            return Ok(());
        }
        if reservation
            .is_some_and(|expected| self.play_generation.load(Ordering::Relaxed) != expected)
        {
            return Ok(());
        }
        let snapshot = self.audio.snapshot();
        if let Some((generation, track_id)) = ended {
            if snapshot.generation != generation || snapshot.track_id != track_id {
                return Ok(());
            }
            let queue = self.queue.lock().await;
            let current = *self.cursor.lock().await;
            if current.and_then(|index| queue.get(index)) != track_id.as_ref() {
                return Ok(());
            }
        }
        let fm = {
            let radio = self.radio.lock().await;
            radio.active && radio.initial_generation.is_none()
        };
        if fm && self.current_index().await.unwrap_or(0) >= 80 {
            let mut queue = self.queue.lock().await;
            let mut cursor = self.cursor.lock().await;
            let remove = cursor.unwrap_or(0).saturating_sub(20);
            let mut meta = self.online_meta.lock().await;
            for id in queue.drain(..remove) {
                meta.remove(&id);
            }
            *cursor = Some(20);
            self.play_generation.fetch_add(1, Ordering::Relaxed);
        }
        let generation = self.play_generation.load(Ordering::Relaxed);
        let mode = self.audio.snapshot().mode;
        let len = self.queue.lock().await.len();
        if len == 0 {
            return Ok(());
        }
        let current = self.current_index().await.unwrap_or(0);

        if fm && delta > 0 && current + 1 >= len {
            return Ok(());
        }
        let next = if fm {
            (current as isize + delta).max(0) as usize
        } else {
            match mode {
                PlayMode::RepeatOne if trigger == PlayTrigger::AutoNext => current,
                // Shuffle must move: picking the current index again would look
                // like "next" did nothing. A pre-shuffled queue is one way to
                // guarantee movement; excluding the current index is the minimal one.
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
            }
        };

        drop(commit);
        self.play_index_for(next, Some(generation), trigger)
            .await
            .map(|_| ())
    }
}

/// 失败提示里显示的曲目名：state 层此刻拿不到锁外的在线元数据快照，退而
/// 显示虚拟 id 尾段（平台曲目 id），至少能让用户认出是哪一首。
fn track_title(track_id: &str) -> String {
    track_id.rsplit(':').next().unwrap_or(track_id).to_string()
}

/// 接力匹配的文本归一化：去空白与全部标点（中英）、折叠大小写。只求
/// 「同一首歌的不同平台写法」归到一起，不做括号内容剥离——《歌名 (Live)》
/// 与《歌名》本就不是同一首，保守归一化宁漏勿错。
fn normalize_relay_text(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// 歌手串拆键：各平台分隔符不一（逗号/斜杠/顿号/&），归一化后按集合比对。
fn relay_artist_keys(s: &str) -> std::collections::HashSet<String> {
    s.split([',', '/', '、', '&', '；', ';', ' '])
        .map(normalize_relay_text)
        .filter(|k| !k.is_empty())
        .collect()
}

/// 接力候选评分。标题归一化相等是门槛（不等直接出局）；歌手交集与
/// 时长容差加分；VIP 候选降权不排除（大概率同样放不了，但取流会如实
/// 报错，交给接力链的既有失败处置）。返回 None = 不够格当候选。
fn relay_score(
    track: &crate::online::OnlineTrack,
    title: &str,
    artist: Option<&str>,
    duration_ms: Option<u64>,
) -> Option<u32> {
    if !track.playable {
        return None;
    }
    if normalize_relay_text(&track.title) != normalize_relay_text(title) {
        return None;
    }
    let mut score: u32 = 10;
    if let Some(a) = artist.filter(|a| !a.trim().is_empty()) {
        let want = relay_artist_keys(a);
        let got = relay_artist_keys(&track.artist);
        if !want.is_empty() && want.intersection(&got).next().is_some() {
            score += 5;
        }
    }
    if let Some(d) = duration_ms.filter(|d| *d > 0) {
        let diff = track.duration_ms.abs_diff(d);
        if diff <= 5_000 {
            score += 5;
        } else if diff <= 10_000 {
            score += 2;
        }
    }
    if track.vip_only {
        score = score.saturating_sub(3);
    }
    Some(score)
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

/// 会话快照的周期保存（5 秒一拍）：队列 + 游标 + 当前进度落 settings 表。
/// 崩溃最多丢 5 秒进度。空转（无队列、无曲目、没在放）不写——恢复失败或
/// 无会话的启动里，旧快照值得原样留着，不该被空快照覆盖。
pub fn spawn_session_saver(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let snap = state.audio.snapshot();
            let queue = state.queue.lock().await.clone();
            if queue.is_empty() && snap.track_id.is_none() && !snap.playing {
                continue;
            }
            let cursor = state.current_index().await;
            let saved_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            crate::persist::save_session(
                &state.db,
                &crate::persist::SessionSnapshot {
                    queue,
                    cursor,
                    position_ms: snap.position_ms,
                    saved_at,
                },
            )
            .await;
        }
    });
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
                AudioEvent::Snapshot(snap) => {
                    state.publish(WsEvent::State(snap.clone()));
                    // 听歌打卡计时：纯内存累积，结算才 detach 网络任务。
                    state.observe_listen(&snap).await;
                }
                AudioEvent::Spectrum(bands) => state.publish(WsEvent::Spectrum { bands }),
                AudioEvent::Ended {
                    generation,
                    track_id,
                } => {
                    state.publish(WsEvent::Ended);
                    // 自然播完是听歌打卡的收口点之一（换曲帧在 Snapshot 里收）。
                    state.harvest_listen().await;
                    crate::diaglog!(
                        "play.end",
                        gen = generation,
                        track = track_id.as_deref().unwrap_or("-")
                    );
                    // 接力绝不能在泵任务里 await：未缓存在线曲的现取流要数秒，
                    // 泵一停，上面那个 64 容量的广播立刻 Lagged。甩到独立任务，
                    // 泵自己永远只做即时转发。
                    let advance = state.clone();
                    tokio::spawn(async move {
                        // 成功（含失败后内部自动跳曲成功）后在接力入口做一次
                        // 后台预取 + LRU；每首成功播放恰好这一次。
                        match advance
                            .step_for(1, PlayTrigger::AutoNext, Some((generation, track_id)), None)
                            .await
                        {
                            Ok(()) => advance.post_commit_background(),
                            Err(e) => {
                                tracing::warn!("auto-advance failed: {e}");
                                crate::diaglog!("advance.fail", reason = e.to_string());
                                // 接力彻底失败（如连续 3 首不可播之外的错误）：
                                // 只 warn 会让前端永远停在旧曲上且毫无提示，
                                // 补发一条可观测错误（不带音源/下标）。
                                advance.publish(WsEvent::Error {
                                    message: e.to_string(),
                                    code: Some("auto_advance_failed".into()),
                                    source: None,
                                    index: None,
                                });
                            }
                        }
                    });
                }
                // 音频后端自身的解码/设备错误没有音源上下文，code/source 缺省。
                AudioEvent::Error(message) => {
                    crate::diaglog!("audio.error", reason = message);
                    state.publish(WsEvent::Error {
                        message,
                        code: None,
                        source: None,
                        index: None,
                    });
                }
                // 解码线程非主动中断的早夭：收口要做下载取消/失败计数/自动跳曲，
                // 全是 await，同样甩独立任务，泵只负责即时转发。
                AudioEvent::DecodeError {
                    track_id,
                    generation,
                } => {
                    let failed = state.clone();
                    tokio::spawn(async move {
                        failed.handle_decode_failure(track_id, generation).await;
                    });
                }
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
pub(crate) mod tests {
    use super::*;

    pub(crate) async fn playback_state() -> (AppState, std::thread::JoinHandle<()>) {
        let (audio, handle) = vmusic_audio::spawn(vmusic_audio::BackendKind::Null)
            .await
            .unwrap();
        let state = AppState {
            db: sqlx::sqlite::SqlitePoolOptions::new()
                .connect_lazy("sqlite::memory:")
                .unwrap(),
            audio,
            config: Arc::new(Config::default()),
            data_dir: PathBuf::new(),
            token: String::new(),
            events: broadcast::channel(16).0,
            queue: Default::default(),
            cursor: Default::default(),
            radio: Default::default(),
            radio_fetch: Default::default(),
            scan: Default::default(),
            scan_cancel: Default::default(),
            qr: crate::online::qr::Registry::new(),
            play_generation: Default::default(),
            play_commit: Default::default(),
            buffering: Default::default(),
            online_meta: Default::default(),
            downloads: Default::default(),
            protected: Default::default(),
            dsp: Mutex::new(DspConfig::from_settings(&Default::default())),
            keep: Default::default(),
            cache_max: Mutex::new(0),
            auto_failures: Default::default(),
            skip_walk_from: Default::default(),
            quality: Default::default(),
            stage_beats: Default::default(),
            weak_self: Default::default(),
            pending_restore_seek: Default::default(),
            overlay_lyric: Default::default(),
            listen: Default::default(),
            relay_tried: Default::default(),
        };
        (state, handle)
    }

    #[tokio::test]
    async fn delayed_end_cannot_replace_a_new_track_or_restart_after_stop() {
        let (state, handle) = playback_state().await;
        state
            .set_queue(vec!["first".into(), "second".into()], Some(0))
            .await;
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        state.audio.play().await.unwrap();
        let ended = state.audio.snapshot();
        state.audio.stop().await.unwrap();
        let generation = state.play_generation.load(Ordering::Relaxed);
        state
            .step_for(
                1,
                PlayTrigger::AutoNext,
                Some((ended.generation, ended.track_id)),
                None,
            )
            .await
            .unwrap();
        assert_eq!(state.current_index().await, Some(0));
        assert_eq!(state.play_generation.load(Ordering::Relaxed), generation);
        assert!(!state.audio.snapshot().playing);

        let stopped = state.audio.snapshot();
        state.set_queue(vec!["second".into()], Some(0)).await;
        state
            .audio
            .load("second.wav", Some("second".into()))
            .await
            .unwrap();
        state.audio.play().await.unwrap();
        state
            .step_for(
                1,
                PlayTrigger::AutoNext,
                Some((stopped.generation, stopped.track_id)),
                None,
            )
            .await
            .unwrap();
        assert_eq!(state.audio.snapshot().track_id.as_deref(), Some("second"));
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn replaced_queue_rejects_a_reserved_load() {
        let (state, handle) = playback_state().await;
        let (generation, _, _) = state.set_queue(vec!["first".into()], Some(0)).await;
        state.set_queue(vec!["second".into()], Some(0)).await;
        let outcome = state
            .play_index_for(0, Some(generation), PlayTrigger::Pick)
            .await
            .unwrap();
        assert!(!outcome.committed);
        assert_eq!(*state.queue.lock().await, vec!["second"]);
        assert!(state.audio.snapshot().track_id.is_none());
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn delayed_decode_failure_cannot_interrupt_a_retry_of_the_same_track() {
        let (state, handle) = playback_state().await;
        let state = Arc::new(state);
        state.set_queue(vec!["first".into()], Some(0)).await;
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        let failed_generation = state.audio.snapshot().generation;
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        state.audio.play().await.unwrap();
        state.set_buffering(true, Some(50)).await;
        state
            .handle_decode_failure(Some("first".into()), failed_generation)
            .await;
        assert!(state.audio.snapshot().playing);
        assert_eq!(*state.buffering.lock().await, (true, Some(50)));
        assert_eq!(state.auto_failures.load(Ordering::Relaxed), 0);
        state.audio.shutdown();
        handle.join().unwrap();
    }

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

    #[test]
    fn a_user_step_walks_past_tracks_that_cannot_play() {
        // 「这首本身放不了」才接着找，方向跟着按钮走。
        for code in ["vip_required", "auth_required", "not_found"] {
            assert_eq!(PlayTrigger::Step { delta: 1 }.skip_direction(code), Some(1));
            assert_eq!(
                PlayTrigger::Step { delta: -1 }.skip_direction(code),
                Some(-1)
            );
        }
        // 上游整体不健康时一首首试等于把整支队列烧穿一遍，错误直接交回调用方。
        for code in ["upstream_rejected", "upstream_timeout", "upstream_error"] {
            assert_eq!(PlayTrigger::Step { delta: 1 }.skip_direction(code), None);
        }
        // 点播停在原处；接力任何失败都跳（沿用既有策略）。
        assert_eq!(PlayTrigger::Pick.skip_direction("vip_required"), None);
        assert_eq!(
            PlayTrigger::AutoNext.skip_direction("upstream_timeout"),
            Some(1)
        );
    }

    #[test]
    fn skip_runs_are_bounded_so_the_failure_recursion_terminates() {
        assert_eq!(PlayTrigger::AutoNext.streak_cap(24), 3);
        // 主动换曲最多把队列绕一圈；两首队里「坏+好」也必须能跳到那一首好的。
        assert_eq!(PlayTrigger::Step { delta: 1 }.streak_cap(24), 24);
        assert_eq!(PlayTrigger::Step { delta: 1 }.streak_cap(2), 2);
        assert_eq!(PlayTrigger::Step { delta: -1 }.streak_cap(1), 1);
        assert_eq!(PlayTrigger::Pick.streak_cap(24), 0);
    }

    fn relay_track(title: &str, artist: &str, duration_ms: u64) -> crate::online::OnlineTrack {
        crate::online::OnlineTrack {
            source: "qq".into(),
            id: "t1".into(),
            title: title.into(),
            artist: artist.into(),
            album: String::new(),
            duration_ms,
            cover: None,
            playable: true,
            vip_only: false,
            track_ref: serde_json::Value::Null,
        }
    }

    #[test]
    fn relay_score_demands_the_same_normalized_title() {
        // 标题归一化相等是门槛：全半角标点、空白、大小写差异都抹平。
        assert!(relay_score(
            &relay_track("Qing Tian", "周杰伦", 269_000),
            "晴 天！",
            Some("周杰伦"),
            Some(269_000),
        )
        .is_none()); // 中文对英文不算同名：归一化只抹标点与大小写，不做翻译
        assert!(relay_score(
            &relay_track("晴天", "周杰伦", 269_000),
            "晴 天！",
            Some("周杰伦"),
            Some(269_000),
        )
        .is_some());
        // 《Live》版字样保留在标题里：不是同一首，宁漏勿错。
        assert_eq!(
            relay_score(
                &relay_track("晴天 Live", "周杰伦", 269_000),
                "晴天",
                Some("周杰伦"),
                Some(269_000),
            ),
            None
        );
        // 不可播放的候选一律出局。
        let mut dead = relay_track("晴天", "周杰伦", 269_000);
        dead.playable = false;
        assert_eq!(relay_score(&dead, "晴天", Some("周杰伦"), Some(269_000)), None);
    }

    #[test]
    fn relay_score_prefers_matching_artist_and_duration() {
        let loose = relay_score(
            &relay_track("晴天", "群星", 269_000),
            "晴天",
            Some("周杰伦"),
            Some(269_000),
        )
        .unwrap();
        let exact = relay_score(
            &relay_track("晴天", "周杰伦", 269_000),
            "晴天",
            Some("周杰伦"),
            Some(269_000),
        )
        .unwrap();
        // 歌手交集与时长容差各自 +5：精确匹配（20）必须稳赢群星合辑（15）。
        assert_eq!(exact, 20);
        assert!(exact > loose);
        // 时长差超出 10s 不加分；5s 内满加。
        let far = relay_score(
            &relay_track("晴天", "周杰伦", 280_000),
            "晴天",
            Some("周杰伦"),
            Some(269_000),
        )
        .unwrap();
        assert!(far < exact);
        // VIP 候选降权：同为精确匹配时输给非 VIP。
        let mut vip = relay_track("晴天", "周杰伦", 269_000);
        vip.vip_only = true;
        assert!(relay_score(&vip, "晴天", Some("周杰伦"), Some(269_000)).unwrap() < exact);
    }

    #[test]
    fn relay_eligible_tracks_only_unplayable_songs() {
        // 这首本身放不了 → 接力；网络抖动与参数问题 → 不接力。
        for code in [
            "not_found",
            "vip_required",
            "auth_required",
            "upstream_rejected",
            "internal",
            "decode_stalled",
        ] {
            assert!(AppState::relay_eligible(code), "{code} 应当可接力");
        }
        for code in ["upstream_timeout", "bad_request", "capability_unsupported"] {
            assert!(!AppState::relay_eligible(code), "{code} 不该接力");
        }
    }
}
