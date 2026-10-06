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

/// 有上限的内存表：插入顺序 FIFO，超限丢「最久没被写入」的那条。
///
/// 为什么要它：`AppState::online_meta` 与 `AppState::stage_beats` 都只增不减
/// ——前者每次整单播放写入一批快照，后者每分析一首歌写一格；长时间运行的实例
/// 内存会随「用过的曲目数」线性增长。上限只是安全网，取值远高于正常使用规模。
///
/// 用「写入即最新」而不是「读到即最新」：这两张表的读取都在关键路径上（写历史、
/// 打卡、接力匹配、节拍查询），在这里让读也拿写锁不划算；而写入点（入队、起播、
/// 分析完成）本来就覆盖「最近用过的曲目」。
///
/// 与 `relay_tried` 那种「满了就清空」不同：这两张表清空会一次性丢掉当前队列
/// 全部曲目的标题，所以这里逐条淘汰最旧的一条。
pub(crate) struct BoundedMap<V> {
    cap: usize,
    seq: u64,
    map: HashMap<String, (u64, V)>,
}

impl<V> BoundedMap<V> {
    pub(crate) fn new(cap: usize) -> Self {
        Self {
            cap,
            seq: 0,
            map: HashMap::new(),
        }
    }

    pub(crate) fn insert(&mut self, key: String, value: V) -> Option<V> {
        self.seq += 1;
        let seq = self.seq;
        let replaced = self.map.insert(key, (seq, value)).map(|(_, v)| v);
        if self.map.len() > self.cap {
            self.evict_oldest();
        }
        replaced
    }

    pub(crate) fn get(&self, key: &str) -> Option<&V> {
        self.map.get(key).map(|(_, value)| value)
    }

    pub(crate) fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.map.get_mut(key).map(|(_, value)| value)
    }

    pub(crate) fn remove(&mut self, key: &str) -> Option<V> {
        self.map.remove(key).map(|(_, value)| value)
    }

    /// 丢弃写入时间最早的一条。只在超限时调用：插入一次最多超一条。
    fn evict_oldest(&mut self) {
        let Some(oldest) = self
            .map
            .iter()
            .min_by_key(|(_, (seq, _))| *seq)
            .map(|(key, _)| key.clone())
        else {
            return;
        };
        self.map.remove(&oldest);
    }
}

/// 在线曲目元数据快照上限。远高于正常使用规模（一张五千首的歌单也只占一半），
/// 只为兜住「长时间运行 + 反复播放不同在线曲」的线性增长；被淘汰的曲目再次
/// 入队/起播时会重新写入，写入前它的历史标题会退化成平台 id。
pub(crate) const ONLINE_META_CAP: usize = 8192;

/// 节拍任务表上限（每格只有几十字节状态，节拍地图本体在磁盘上）。
pub(crate) const STAGE_BEATS_CAP: usize = 8192;

/// 接力坏流记忆上限：到顶就清空（整盘换队/成功提交也会清）。
pub(crate) const RELAY_TRIED_CAP: usize = 64;

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
    /// 平台随取流一起给的响度标签（见 [`crate::online::StreamInfo`] 的 rg_*）。
    /// 缓存在这里是因为**缓存命中那次播放不会再打取流接口**，值只能从上一轮
    /// 取流时留下；`serde` 对 Option 缺字段默认 None，旧客户端的 /player/load
    /// 请求体照旧能用。
    pub rg_gain_db: Option<f64>,
    pub rg_peak: Option<f64>,
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
                if legacy {
                    "track".into()
                } else {
                    "off".into()
                }
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

/// 听歌打卡频控闸门（folia `playbackReportGate` 的服务端移植）。
///
/// 打卡是写用户真实账号的动作，而一阵不合情理的突发请求正是触发平台风控
/// 的原因。上游的 [`ListenTracker`] 已经拒绝把没有真的播的声音计入时长；
/// 这里拒绝以任何真实听歌的人都做不出来的速率把报告**发**出去——不管计时
/// 器当时信了什么。
///
/// 只在内存里计数：重启即清空。持久化省不下什么（每份报告背后仍然要有
/// 30 秒真实音频），而这个上限本来就是防会话内突发，不是耐久配额。
#[derive(Default)]
pub(crate) struct ScrobbleGate {
    /// 本会话内各次「决定发送」的时刻（请求发出前记账，见 try_claim）。
    recent: std::sync::Mutex<Vec<std::time::Instant>>,
    /// 有上报在飞：窗口期内的第二份直接丢。15s 超时兜底释放，见 REPORT_TIMEOUT。
    in_flight: std::sync::atomic::AtomicBool,
}

impl ScrobbleGate {
    /// 两次上报之间的最小间隔：没人能在 5 秒内听完两首。
    const MIN_GAP: std::time::Duration = std::time::Duration::from_secs(5);
    /// 连着放一小时的 2 分钟短曲是 30 首；翻倍到 60 已是宽松。
    const MAX_PER_HOUR: usize = 60;
    /// 单次上报等待上限：reqwest 客户端本身没有总超时，死代理/黑洞防火墙
    /// 会让请求永远 pending，超时则放弃这一格（不取消请求本身——放弃的是
    /// 插槽，而插槽绝不能泄漏，否则之后的报告全被判成「在飞」静默丢弃）。
    const REPORT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
    /// 计数窗口：一小时外的记录不再占用配额。
    const HOUR: std::time::Duration = std::time::Duration::from_secs(3600);

    /// 申领一次上报资格。返回 false = 丢弃（调用方静默记账即可）。
    ///
    /// in-flight 用 CAS 抢占，与后续的间隔/计数检查合起来对并发调用保持
    /// 原子；检查不过则当即归还 in-flight 标志。记账发生在请求**之前**：
    /// 慢端点或失败端点不能被重试成突发——丢一条记录的代价永远小于账号
    /// 被风控标记。
    pub(crate) fn try_claim(&self, now: std::time::Instant) -> bool {
        use std::sync::atomic::Ordering;
        if self
            .in_flight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return false;
        }
        let mut recent = self.recent.lock().unwrap_or_else(|e| e.into_inner());
        recent.retain(|t| now.duration_since(*t) < Self::HOUR);
        let gap_ok = recent
            .last()
            .map(|l| now.duration_since(*l) >= Self::MIN_GAP)
            .unwrap_or(true);
        let cap_ok = recent.len() < Self::MAX_PER_HOUR;
        if !gap_ok || !cap_ok {
            drop(recent);
            self.in_flight.store(false, Ordering::SeqCst);
            return false;
        }
        recent.push(now);
        true
    }

    /// 归还 in-flight 插槽。请求收尾（成功/失败/超时）后调用一次。
    pub(crate) fn release(&self) {
        use std::sync::atomic::Ordering;
        self.in_flight.store(false, Ordering::SeqCst);
    }
}

pub struct AppState {
    pub db: SqlitePool,
    pub audio: AudioHandle,
    pub config: Arc<Config>,
    pub data_dir: PathBuf,
    pub token: String,
    /// 浮层只读钥匙（见 `main.rs` 的 `load_or_create_overlay_key`）。与 token
    /// 分开是因为它会被粘进 OBS 的配置：权限只到「GET + 浮层歌词 + 曲目封面」。
    /// 插件形态（stdio）没有 HTTP 通道，填空串即可。
    pub overlay_key: String,
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
    pub(crate) online_meta: Mutex<BoundedMap<OnlineMetaSnap>>,
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
    /// 在线缓存目录的内存索引（启动扫描一次，写时增量维护）。查找/统计/淘汰/
    /// 手动清理都走它，不再每次遍历目录（见 [`crate::online::cache::CacheIndex`]）。
    pub(crate) cache_index: Arc<crate::online::cache::CacheIndex>,
    /// 首跳票据（签发/兑换），见 [`crate::ticket`]。只活在内存里。
    pub(crate) tickets: crate::ticket::TicketStore,
    /// 自动接力连续失败计数，任一曲成功提交即清零；累计到 3 停止接力。
    pub(crate) auto_failures: AtomicUsize,
    /// 一轮跳曲走的起点：第一次失败时把「当时在播的那首」记下来，放弃时把游标还给
    /// 它。不记的话每跳一首都把游标还给上一首（那首也是放不了的），界面会高亮一首
    /// 根本没响的曲子。
    pub(crate) skip_walk_from: Mutex<Option<usize>>,
    /// 逐源音质偏好（启动时从 settings 装载、POST 热切换即时更新）。
    pub(crate) quality: Mutex<crate::online::quality::QualityPrefs>,
    /// 节拍分析幂等表：缓存键 → 任务态。
    pub(crate) stage_beats: Mutex<BoundedMap<crate::stage_beats::TaskState>>,
    /// 启动后由 main 注入 Weak：on_track_committed 只有 &self，detach
    /// 'static 任务时凭它拿回 Arc（不改 play_index/step 的签名链）。
    pub(crate) weak_self: std::sync::OnceLock<std::sync::Weak<AppState>>,
    /// 会话恢复的待回放进度：重启时从快照装进来，首次 play 成功提交后
    /// seek 过去并清空（只消费一次，之后的 play/seek 都是用户自己的意图）。
    pub(crate) pending_restore_seek: Mutex<Option<u64>>,
    /// 听歌打卡计时器（网易云在线曲，seek-proof，见 [`ListenTracker`]）。
    pub(crate) listen: Mutex<ListenTracker>,
    /// 打卡上报频控闸门（见 [`ScrobbleGate`]）：发送侧的最后一道防线。
    pub(crate) scrobble: ScrobbleGate,
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
    /// 缓存根目录（`cache/`），下面是 `covers/` 与 `online/` 两个子目录。
    ///
    /// 需要它而不是 `cover_dir()` 的地方只有一类：调
    /// `vmusic_library::save_cover(cache_dir, …)`——那个函数会自己接上
    /// `covers/`，传 `cover_dir()` 会写进 `covers/covers/`（曾把在线补全的
    /// 封面写到一个取不回来的地方，`has_cover` 置了位却读不到图）。
    pub fn cache_dir(&self) -> PathBuf {
        self.data_dir.join("cache")
    }

    pub fn cover_dir(&self) -> PathBuf {
        self.cache_dir().join("covers")
    }

    /// 签一张入口首跳票据（默认寿命与次数），只回票号。
    ///
    /// 给二进制入口打印/打开的 URL 用：那条 URL 会进终端 scrollback、浏览器历史
    /// 与聊天记录，所以带的是短时效、次数有限的票而不是长期 token。寿命/次数上限
    /// 留在 [`crate::ticket`] 里，bin 侧不需要知道。
    pub fn issue_entry_ticket(&self) -> String {
        self.tickets
            .issue(crate::ticket::TICKET_TTL, crate::ticket::TICKET_USES)
            .id
    }

    /// 兑一张首跳票据（未过期且还有剩余次数才成立）。`/` 的凭据闸门用。
    pub fn redeem_ticket(&self, id: &str) -> bool {
        self.tickets.redeem(id)
    }

    pub(crate) fn stage_beats_dir(&self) -> PathBuf {
        self.data_dir.join("stage-beats")
    }

    /// 在线试听的落盘位置。音频后端目前只吃本地文件路径，所以远程流先缓存到
    /// 这里再交给 audio actor —— 播放链路本身完全不变。
    /// 当前播放曲目的响度增益（dB，已含防削波）与所选标签来源；响度归一化
    /// 下发用。`mode` 是调用方持有的档位（off 时不该走到这里）。
    pub(crate) async fn current_loudness(&self, mode: &str) -> Option<(f64, &'static str)> {
        let cursor = match *self.cursor.lock().await {
            Some(i) => i,
            None => return None,
        };
        let track_id = self.queue.lock().await.get(cursor)?.clone();
        if crate::online::split_virtual_id(&track_id).is_some() {
            // 在线曲的响度来自平台随取流一起给的 gain/peak，存在 online_meta 里
            // （见 play_online 的落地）；没有标签就报「没有」，调用方按 0 dB 播。
            return self.online_gain(&track_id).await;
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

    /// 在线曲的响度标签（gain dB、peak），来自 online_meta；没记过就是 None。
    async fn online_rg(&self, track_id: &str) -> Option<(f64, Option<f64>)> {
        let map = self.online_meta.lock().await;
        let snap = map.get(track_id)?;
        snap.rg_gain_db.map(|gain| (gain, snap.rg_peak))
    }

    /// 在线曲的时长（毫秒），来自入队时写的 online_meta 快照；没记过就是 None。
    /// 取流候选的码率诚实性校验要用它做分母，缺了就跳过校验而不是按 0 算。
    async fn online_duration_ms(&self, track_id: &str) -> Option<u64> {
        let map = self.online_meta.lock().await;
        map.get(track_id).and_then(|m| m.duration_ms)
    }

    /// 这首在线曲已缓存的文件：先按请求档位，未命中再逐级向下（见
    /// [`crate::online::cache::CacheIndex::find_best`]）。返回的档位是**文件
    /// 自己名字里那档**，播放标注必须用它而不是请求档位。
    async fn find_online_cached(
        &self,
        source: &str,
        id: &str,
        want: crate::online::quality::Quality,
    ) -> Option<(std::path::PathBuf, crate::online::quality::Quality)> {
        use crate::online::quality::Quality;
        let tiers = want.descending_from();
        let names: Vec<&str> = tiers.iter().map(|q| q.as_str()).collect();
        let (path, tier) = self.cache_index.find_best(source, id, &names).await?;
        Some((path, Quality::parse(tier).unwrap_or(want)))
    }

    /// 在线曲在当前档位下应下的增益（已含防削波），与本地曲同一条规则。
    ///
    /// current_loudness（对外汇报「用了多少增益」）与播放落地（apply_online_loudness）
    /// 都走它：两处各算一遍迟早会漂成不一致的答案。
    async fn online_gain(&self, track_id: &str) -> Option<(f64, &'static str)> {
        self.online_rg(track_id)
            .await
            .map(|(gain, peak)| (anti_clip_gain(gain, peak), "online"))
    }

    /// 记下平台给的响度标签。条目不存在就什么都不做 —— 不为了存一个增益
    /// 捏一条没有标题的元数据（那会让播放历史退化成平台 id）。
    async fn store_online_rg(&self, track_id: &str, gain: Option<f64>, peak: Option<f64>) {
        if gain.is_none() && peak.is_none() {
            return;
        }
        let mut map = self.online_meta.lock().await;
        if let Some(snap) = map.get_mut(track_id) {
            snap.rg_gain_db = gain;
            snap.rg_peak = peak;
        }
    }

    /// 记一条在线元数据快照。
    ///
    /// 与直接 `insert` 的区别只有一条：**保留上一次取流拿到的响度标签**。同一首
    /// 曲重入队（用户又点了一次、前端重发整盘）时取流那一步未必再发生（文件已经
    /// 在缓存里，走 cache.hit），而入队带上来的元数据里没有响度——直接覆盖就把
    /// 它抹掉了，之后每一首都会退化成 0 dB。
    pub(crate) async fn remember_online_meta(&self, id: String, mut snap: OnlineMetaSnap) {
        let mut map = self.online_meta.lock().await;
        if let Some(old) = map.get(&id) {
            snap.rg_gain_db = old.rg_gain_db.or(snap.rg_gain_db);
            snap.rg_peak = snap.rg_peak.or(old.rg_peak);
        }
        map.insert(id, snap);
    }

    /// 把在线曲的响度增益推给 audio actor。
    ///
    /// 每次提交都要推（哪怕结果为 0 dB）：在线链路原先完全不碰 DSP，上一首
    /// 本地曲的增益会一直留在链上，切到在线曲时等于套用了别人的增益。
    /// 与 play_local 同一套规则，含 anti_clip_gain 防削波。
    async fn apply_online_loudness(&self, track_id: &str) {
        let dsp = self.dsp.lock().await.clone();
        let track_gain_db = if dsp.loudness_enabled() {
            match self.online_gain(track_id).await {
                Some((gain, from)) => {
                    crate::diaglog!(
                        "loudness.apply",
                        mode = dsp.loudness_mode.as_str(),
                        from = from,
                        gain_db = gain
                    );
                    gain as f32
                }
                None => 0.0,
            }
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
    /// 发送前先过 [`ScrobbleGate`] 频控，丢弃同样只记 diaglog（不打扰听众，
    /// 但控制台留痕）：丢一条记录的代价永远小于账号被风控标记。
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
            if !state.scrobble.try_claim(std::time::Instant::now()) {
                crate::diaglog!(
                    "scrobble.dropped",
                    track = id.as_str(),
                    reason = "rate-gate"
                );
                return;
            }
            let ctx = crate::routes::online_ctx(&state);
            crate::diaglog!("scrobble.report", track = id.as_str(), seconds = seconds);
            // 15s 超时只放弃等待、不取消请求本身；finally 语义由紧随的
            // release 保证——闸门插槽绝不能因慢请求泄漏。
            let outcome = tokio::time::timeout(
                ScrobbleGate::REPORT_TIMEOUT,
                crate::online::scrobble(&ctx, &source, &id, seconds),
            )
            .await;
            state.scrobble.release();
            match outcome {
                Ok(Ok(())) => {
                    tracing::info!("听歌打卡成功：netease:{id}（{seconds}s）");
                    state.publish(WsEvent::Scrobbled {
                        track_id: track_id.clone(),
                    });
                }
                Ok(Err(e)) => {
                    tracing::debug!("听歌打卡失败（不打扰播放）: {e:?}");
                }
                Err(_elapsed) => {
                    tracing::debug!(
                        "听歌打卡等待超过 {}s，放弃这一格",
                        ScrobbleGate::REPORT_TIMEOUT.as_secs()
                    );
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
        // 远程直链的取流准备放在提交锁外：`auth_for_url` 打 DB + 系统钥匙串，
        // `HttpRangeStream::open` 是真实网络建连——WebDAV 慢源上这两步各自都
        // 可能是秒级。原先它们连同 `load_source` 一起在 `play_commit` 锁内，
        // 慢源加载期间切歌/换队会被串行卡住；现在锁内只剩复核与 actor 入队，
        // 与 `play_online` 同一条纪律（见其文档注释）。
        //
        // 建连之前先做一次便宜的存活复核：这个请求可能已经被后续操作作废
        // （用户连点、自动下一首抢先），不该为一个死请求白付一次网络往返。
        // 真正决定成败的复核仍在锁内。
        if !self.attempt_alive(gen, index, &track_id).await {
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        let remote: Option<(String, Option<String>, Box<dyn vmusic_core::AudioSource>)> = if track
            .source
            == vmusic_core::TrackSource::Remote
        {
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
            Some((url, ext, Box::new(stream)))
        } else {
            None
        };

        // 取流已就绪：锁内只剩复核与 actor 入队。
        let _commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            return Ok(PlayOutcome {
                committed: false,
                actual_quality: None,
            });
        }
        match remote {
            Some((url, ext, stream)) => {
                // 远程直链的凭据可能在 userinfo 或 query 里，与在线流同规则脱敏。
                crate::diaglog!(
                    "play.local",
                    idx = index,
                    gen = gen,
                    via = "remote",
                    url = crate::diag::redact_url(&url)
                );
                self.audio
                    .load_source(stream, ext, Some(track_id.clone()))
                    .await
                    .map_err(vmusic_core::CoreError::Audio)?;
            }
            None => {
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

        // 快路径：正式名（任意扩展名）或旧名缓存已就绪。查找走内存索引（命中时
        // 只做一次 metadata 复核），没有目录遍历，直接 await 即可。缓存命中全程
        // 不发 buffering——本地文件 load 是毫秒级，先亮 loading 再立刻灭只会让
        // 播放键闪一下（修 M6）。
        // 向下逐级找档：降级落盘的文件挂在实测档位下，只查请求档位会让同一首
        // 曲子每次播放都重下一遍。
        if let Some((path, hit_quality)) = self.find_online_cached(&source, &id, quality).await {
            crate::diaglog!(
                "cache.hit",
                idx = index,
                gen = gen,
                key = key,
                hit_tier = hit_quality.as_str(),
                path = path.display()
            );
            // 响度先落地再提交：缓存命中不走取流接口，值来自上一轮存在
            // online_meta 里的标签（没有就是 0 dB）。
            self.apply_online_loudness(&track_id).await;
            match self
                .try_commit_cached(gen, index, &track_id, &path, Some(hit_quality))
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

        // 同键预取在跑则 owned 接管（此时请求侧的 info 根本不存在，档位只能
        // 从下载视图反查）；否则现场取流并新开渐进式下载。
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
                extra_urls = info.fallbacks.len(),
                bitrate = info.bitrate.unwrap_or(0),
                actual = actual.map(|q| q.as_str()).unwrap_or("unknown"),
                expires_secs = info.expires_in_secs.unwrap_or(0)
            );
            // 阶梯把主地址排在第一位，Referer 也已按候选填好；播放与预取都只
            // 能经 StreamInfo::ladder 组装，别在这里再拼一遍。
            let ladder = info.ladder();
            // 记下平台给的响度标签：缓存命中那次播放不会再打取流接口，值只能
            // 从这里留下（随 online_meta 与队列同生命周期）。
            self.store_online_rg(&track_id, info.rg_gain_db, info.rg_peak)
                .await;
            let duration_ms = self.online_duration_ms(&track_id).await;
            match crate::online::progressive::start(
                dir.clone(),
                key.clone(),
                ladder,
                duration_ms,
                self.cache_index.clone(),
            ) {
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

        // 档位标注跟着真正交付字节的那一档走：阶梯降级后它比请求档低，拿主地址
        // 的码率去标就是把 320k 报成无损。到这里预读已达阈值，必有候选从 0 开始
        // 交付，视图里读得到；仍为 None 才保留取流响应给的请求档。
        let actual = view.actual_quality().or(actual);

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
        //
        // 响度要在三条提交路径上都推（缓存命中 / 整首下载 / 这条渐进式），
        // 漏一条就会出现「有时归一化、有时不归一化」。位置放在存活复核之后：
        // 只有真要提交的这一首才改链上的增益。
        self.apply_online_loudness(&track_id).await;
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
        // 新鲜取流路径的响度落地：标签已在上游存进 online_meta。
        self.apply_online_loudness(&track_id).await;
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
                if let Err(e) = s.cache_index.enforce_limit(max, &protected).await {
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
        let Some(vid) = queue.get(next).cloned() else {
            return;
        };
        let Some((source, id)) = crate::online::split_virtual_id(&vid) else {
            return; // 本地曲无需预取
        };
        // 时长是码率诚实性校验与实测档位的分母，缺了就跳过校验（不猜）。
        let duration_ms = self.online_duration_ms(&vid).await;
        let quality = {
            let prefs = self.quality.lock().await;
            crate::online::quality::get(&prefs, &source)
        };
        let key = crate::online::cache::cache_key(&source, &id, quality.as_str());
        if self.downloads.lock().await.contains_key(&key) {
            return;
        }
        let dir = self.online_cache_dir();
        // 已缓存（包括只拿到更低档）就不再预热：播放那边会向下命中同一个文件。
        if self
            .find_online_cached(&source, &id, quality)
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
        match crate::online::progressive::start(
            dir,
            key.clone(),
            info.ladder(),
            duration_ms,
            self.cache_index.clone(),
        ) {
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
        let Some(failed_source) = crate::online::split_virtual_id(&track_id).map(|(s, _)| s) else {
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
                if tried.len() >= RELAY_TRIED_CAP {
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
                if let Some(score) =
                    relay_score(t, &meta.title, meta.artist.as_deref(), meta.duration_ms)
                {
                    if best.as_ref().is_none_or(|(s, _)| score > *s) {
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
                // 接力候选的元数据里没有响度（要等新源取流），留空。
                rg_gain_db: None,
                rg_peak: None,
            });
            if cand.duration_ms > 0 {
                snap.duration_ms = Some(cand.duration_ms);
            }
            // 响度标签属于「上一家音源的那份母带」，换源后不再适用：清掉，
            // 等新源第一次取流时按它的 gain/peak 重新填。不清就会把别家母带的
            // 增益套到这份音频上（缓存命中那条路尤其明显：它不会再打取流接口）。
            snap.rg_gain_db = None;
            snap.rg_peak = None;
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
        if Self::relay_eligible(e.code)
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
                    Box::pin(self.try_relay(
                        reservation,
                        index,
                        track_id.clone(),
                        PlayTrigger::AutoNext,
                    ))
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
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .connect_lazy("sqlite::memory:")
            .unwrap();
        playback_state_with_db(db).await
    }

    /// 需要真实 schema 的用例（Remote 曲目、设置读取…）自己开一个文件库传进来：
    /// 上面那个内存池没有建表，任何打 DB 的路径都会在里面失败。
    pub(crate) async fn playback_state_with_db(
        db: sqlx::SqlitePool,
    ) -> (AppState, std::thread::JoinHandle<()>) {
        let (audio, handle) = vmusic_audio::spawn(vmusic_audio::BackendKind::Null)
            .await
            .unwrap();
        let state = AppState {
            db,
            audio,
            config: Arc::new(Config::default()),
            data_dir: PathBuf::new(),
            token: String::new(),
            overlay_key: String::new(),
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
            online_meta: Mutex::new(BoundedMap::new(ONLINE_META_CAP)),
            downloads: Default::default(),
            protected: Default::default(),
            dsp: Mutex::new(DspConfig::from_settings(&Default::default())),
            keep: Default::default(),
            cache_max: Mutex::new(0),
            // 不存在的空目录即可：索引为空，测试都不碰缓存目录（cache_max=0）。
            cache_index: Arc::new(
                crate::online::cache::CacheIndex::load(
                    std::env::temp_dir()
                        .join(format!("vmusic-state-cache-{}", uuid::Uuid::new_v4())),
                )
                .await,
            ),
            auto_failures: Default::default(),
            skip_walk_from: Default::default(),
            quality: Default::default(),
            stage_beats: Mutex::new(BoundedMap::new(STAGE_BEATS_CAP)),
            weak_self: Default::default(),
            pending_restore_seek: Default::default(),
            overlay_lyric: Default::default(),
            listen: Default::default(),
            scrobble: Default::default(),
            relay_tried: Default::default(),
            tickets: crate::ticket::TicketStore::new(),
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

    /// 慢 Remote 源加载期间换队不能被卡住。
    ///
    /// 复现的是修复前的现场：`play_local` 的凭据读取 + HTTP 建连 + `load_source`
    /// 原本都在 `play_commit` 锁内，一个卡住的 WebDAV HEAD 会让同样要这把锁的
    /// `set_queue` 一直等下去。这里用一个「接受连接但永不回应」的服务端把建连
    /// 钉住 1.5s，并在**确认连接已被接受之后**才计时换队。
    #[tokio::test]
    async fn slow_remote_load_does_not_block_queue_swap() {
        let dir = std::env::temp_dir().join(format!("vmusic-lock-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let holder = tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let _ = accepted_tx.send(());
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                drop(stream);
            }
        });

        let track_id = "remote-slow".to_string();
        vmusic_store::upsert_track(
            &db,
            &vmusic_core::Track {
                id: track_id.clone(),
                path: format!("http://{addr}/slow.mp3"),
                source: vmusic_core::TrackSource::Remote,
                title: "slow".into(),
                artist: None,
                album: None,
                duration_ms: None,
                bitrate: None,
                sample_rate: None,
                channels: None,
                has_cover: false,
                file_mtime: None,
                file_size: None,
                added_at: 0,
            },
        )
        .await
        .unwrap();

        let (state, handle) = playback_state_with_db(db).await;
        let (gen, ..) = state.set_queue(vec![track_id], Some(0)).await;

        let play = state.play_index_for(0, Some(gen), PlayTrigger::Pick);
        let probe = async {
            // 等到 play_local 真的进入网络建连（服务端已接受连接）再开始计时：
            // 否则可能在它还忙着读 DB 时就量了，测不到锁的行为。
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), accepted_rx).await;
            let t0 = std::time::Instant::now();
            state.set_queue(vec!["other".into()], Some(0)).await;
            t0.elapsed()
        };
        let (_, elapsed) = tokio::join!(play, probe);
        assert!(
            elapsed < std::time::Duration::from_millis(500),
            "慢源建连期间换队被阻塞了 {elapsed:?}——锁纪律回退了"
        );

        holder.abort();
        state.db.close().await;
        state.audio.shutdown();
        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
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
        assert_eq!(
            relay_score(&dead, "晴天", Some("周杰伦"), Some(269_000)),
            None
        );
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

    #[test]
    fn bounded_map_evicts_the_oldest_write() {
        let mut map: BoundedMap<u32> = BoundedMap::new(2);
        map.insert("a".into(), 1);
        map.insert("b".into(), 2);
        assert_eq!(map.get("a"), Some(&1));
        // 超限：丢最老的 a，新写入的 c 留下。
        map.insert("c".into(), 3);
        assert!(map.get("a").is_none(), "最老的条目应被淘汰");
        assert_eq!(map.get("b"), Some(&2));
        assert_eq!(map.get("c"), Some(&3));
        // 手工删除腾出空间后，不再触发淘汰。
        assert_eq!(map.remove("b"), Some(2));
        map.insert("d".into(), 4);
        assert_eq!(map.get("c"), Some(&3));
        assert_eq!(map.get("d"), Some(&4));
        // 覆盖写算「刚写过」：被覆盖的条目不该成为下一次淘汰的对象。
        map.insert("c".into(), 30);
        map.insert("e".into(), 5);
        assert_eq!(map.get("c"), Some(&30), "被覆盖过的条目刷新了写入时间");
        assert!(map.get("d").is_none(), "此时最老的是 d");
        assert_eq!(map.insert("e".into(), 50), Some(5), "覆盖返回旧值");
        assert_eq!(map.get_mut("e"), Some(&mut 50));
    }

    /// 字段级接线：AppState 上的那张表必须是**有上限的**那一种（改了类型但忘了
    /// 换构造点、或将来有人换回 HashMap，就会在这里红）。
    #[tokio::test]
    async fn app_state_online_meta_stays_bounded() {
        let (state, _audio) = playback_state().await;
        for i in 0..ONLINE_META_CAP + 3 {
            state.online_meta.lock().await.insert(
                format!("online:netease:{i}"),
                OnlineMetaSnap {
                    title: format!("t{i}"),
                    artist: None,
                    album: None,
                    cover: None,
                    duration_ms: None,
                    rg_gain_db: None,
                    rg_peak: None,
                },
            );
        }
        let meta = state.online_meta.lock().await;
        assert!(
            meta.get("online:netease:0").is_none(),
            "超限后最老的快照被淘汰"
        );
        assert!(
            meta.get(&format!("online:netease:{}", ONLINE_META_CAP + 2))
                .is_some(),
            "最新写入的快照仍在"
        );
    }

    /// 造一条在线元数据快照（只关心响度两个字段的用例用它）。
    fn online_snap(rg_gain_db: Option<f64>, rg_peak: Option<f64>) -> OnlineMetaSnap {
        OnlineMetaSnap {
            title: "t".into(),
            artist: None,
            album: None,
            cover: None,
            duration_ms: None,
            rg_gain_db,
            rg_peak,
        }
    }

    /// F4：在线曲的响度来自平台随取流给的 gain/peak。改之前 `current_loudness`
    /// 对 `online:` 虚拟 id 直接返回 None（注释原文「在线曲没有 RG 标签」），
    /// 于是响度归一化对整条在线链路都不生效。
    #[tokio::test]
    async fn online_tracks_report_loudness_from_the_platform_tags() {
        let (state, _audio) = playback_state().await;
        let id = "online:netease:1".to_string();
        *state.queue.lock().await = vec![id.clone()];
        *state.cursor.lock().await = Some(0);

        // 还没取流（没有标签）：报「没有」，调用方按 0 dB 播。
        assert!(state.current_loudness("track").await.is_none());
        assert!(state.online_gain(&id).await.is_none());

        state
            .online_meta
            .lock()
            .await
            .insert(id.clone(), online_snap(Some(3.5), Some(0.8)));
        // peak=0.8 → 提升上限 −20·log10(0.8) ≈ 1.938 dB，3.5 被压到那儿。
        let (gain, from) = state
            .current_loudness("track")
            .await
            .expect("在线曲应当有响度");
        assert_eq!(from, "online");
        assert!(
            (gain - 1.9382).abs() < 0.001,
            "3.5 dB 的提升应被峰值余量压到约 1.94 dB，实际 {gain}"
        );

        // 防削波与本地曲同一条规则：peak=0.5 → 最多提 −20·log10(0.5) ≈ 6.02 dB。
        state
            .online_meta
            .lock()
            .await
            .insert(id.clone(), online_snap(Some(12.0), Some(0.5)));
        let (gain, from) = state
            .current_loudness("album")
            .await
            .expect("在线曲应当有响度");
        assert_eq!(from, "online", "来源要标成 online，别和本地 RG 混为一谈");
        assert!(
            (gain - 6.0206).abs() < 0.01,
            "12 dB 的提升应被峰值余量压到约 6.02 dB，实际 {gain}"
        );

        // 只有 gain、没有 peak：照常归一化，只是没有防削波余量可用。
        state
            .online_meta
            .lock()
            .await
            .insert(id, online_snap(Some(-4.0), None));
        assert_eq!(
            state.current_loudness("track").await,
            Some((-4.0, "online"))
        );
    }

    /// 存响度标签只在已有条目上改，不凭空造条目 —— 造出来的快照没有标题，
    /// 播放历史会退化成平台 id。
    #[tokio::test]
    async fn storing_online_loudness_never_invents_an_entry() {
        let (state, _audio) = playback_state().await;
        state
            .store_online_rg("online:netease:missing", Some(3.0), Some(0.9))
            .await;
        assert!(state.online_rg("online:netease:missing").await.is_none());
        assert!(state
            .online_meta
            .lock()
            .await
            .get("online:netease:missing")
            .is_none());

        let id = "online:netease:2".to_string();
        state
            .online_meta
            .lock()
            .await
            .insert(id.clone(), online_snap(None, None));
        state.store_online_rg(&id, Some(3.0), Some(0.9)).await;
        assert_eq!(state.online_rg(&id).await, Some((3.0, Some(0.9))));

        // gain 与 peak 都没给（上游没这两个字段）时不该把已有值抹掉成「有但为空」。
        state.store_online_rg(&id, None, None).await;
        assert_eq!(state.online_rg(&id).await, Some((3.0, Some(0.9))));
    }

    #[test]
    fn bounded_map_caps_the_two_tables_it_guards() {
        // 上限必须远高于正常使用规模（一张几千首的歌单不该被截断）。
        // 这三条是编译期不变量，所以放 const 块里：写成运行时断言时两边都是常量，
        // clippy::assertions_on_constants 会判它「恒真」（CI 那边是 -D warnings）。
        const {
            assert!(ONLINE_META_CAP >= 4096, "在线元数据上限太小，会误伤大歌单");
            assert!(STAGE_BEATS_CAP >= 1024, "节拍任务表上限太小，会重复分析");
            assert!(RELAY_TRIED_CAP >= 8, "接力坏流记忆太小，防不住回环");
        }
    }

    #[test]
    fn scrobble_gate_rejects_bursts_within_min_gap() {
        let gate = ScrobbleGate::default();
        let t0 = std::time::Instant::now();
        assert!(gate.try_claim(t0), "会话内第一份放行");
        gate.release();
        let one_sec = std::time::Duration::from_secs(1);
        assert!(!gate.try_claim(t0 + one_sec), "1s 内的第二份太密");
        assert!(
            !gate.try_claim(t0 + ScrobbleGate::MIN_GAP - std::time::Duration::from_millis(1)),
            "差 1ms 满 5s 也拒"
        );
        assert!(gate.try_claim(t0 + ScrobbleGate::MIN_GAP), "满 5s 放行");
        gate.release();
    }

    #[test]
    fn scrobble_gate_serializes_in_flight() {
        let gate = ScrobbleGate::default();
        let t0 = std::time::Instant::now();
        assert!(gate.try_claim(t0));
        assert!(
            !gate.try_claim(t0 + std::time::Duration::from_secs(10)),
            "上一份还在飞：即使过了间隔也不并发"
        );
        gate.release();
        assert!(
            gate.try_claim(t0 + std::time::Duration::from_secs(10)),
            "归还插槽后放行"
        );
        gate.release();
    }

    #[test]
    fn scrobble_gate_caps_hourly_quota() {
        let gate = ScrobbleGate::default();
        let now = std::time::Instant::now();
        {
            // 直接铺满一小时配额（每条都距 now 10s 以上，先绕开间隔检查，
            // 只隔离验证计数上限）。铺账用锁内写入，不经 try_claim 的间隔门；
            // 偏移刻意压在 59 分钟整、不碰一小时修剪边界。
            let mut recent = gate.recent.lock().unwrap();
            for i in 0..ScrobbleGate::MAX_PER_HOUR {
                recent.push(now - std::time::Duration::from_secs(10 + 59 * i as u64));
            }
        }
        assert!(!gate.try_claim(now), "一小时满额后拒绝");
        // 一条一小时前的旧账被窗口修剪，不占额度；配额仍满，继续拒。
        gate.recent
            .lock()
            .unwrap()
            .push(now - std::time::Duration::from_secs(3601));
        assert!(!gate.try_claim(now), "旧账修剪后配额仍满");
    }

    #[test]
    fn scrobble_gate_prunes_entries_older_than_an_hour() {
        let gate = ScrobbleGate::default();
        let now = std::time::Instant::now();
        {
            let mut recent = gate.recent.lock().unwrap();
            for i in 0..ScrobbleGate::MAX_PER_HOUR {
                recent.push(now - std::time::Duration::from_secs(3601 + 60 * i as u64));
            }
        }
        assert!(gate.try_claim(now), "记录全部过期后额度释放");
        gate.release();
    }
}
