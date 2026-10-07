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
    /// 节拍分析就绪（后台任务完成）。`persisted=false` 是另一种状态：地图算出来
    /// 了、这轮能用，但没写进磁盘缓存（重启或换一轮就得重算），前端据此把
    /// 「这次有画面」和「以后也有」分开说。
    BeatmapReady {
        track_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        bpm: Option<f64>,
        beats_n: usize,
        persisted: bool,
    },
    /// 听歌打卡上报成功（网易云在线曲有效收听满 30s 已发出）。前端据此轻提示
    /// 「已提交听歌记录」——这条只证明我们发出去了，不证明平台累计播放量已增加；
    /// 其余情况保持安静。
    Scrobbled {
        track_id: String,
    },
    /// 曲源自动接力成功：原音源失效的在线曲已按标题+歌手+时长在其他音源
    /// 找到同一首并换源续播。前端据此轻提示「已切换到 XX 音源」。
    SourceSwitched {
        /// 新的虚拟 id（`新源:平台id`），队列与元数据都已迁到它名下。
        track_id: String,
        /// 这次换走的那一家（多跳接力时它是中间家，不是最初那家）。
        from_source: String,
        to_source: String,
        /// 目标音源的展示名（SOURCES 表 label），前端不必再反查清单。
        to_label: String,
        /// 原曲标题（接力候选与原曲同名，取原快照的写法展示）。
        title: String,
        /// 被换掉那一项的虚拟 id：界面拿它把自己那份元数据迁到新 id 名下
        /// （否则新 id 在前端没有 title/封面，队列行会退化成平台 id）。
        from_track_id: String,
        /// 用户**最初选中**的那一家与它的平台 id（F3 的出处身份）。与
        /// `from_source` 分开是因为多跳接力里两者不同，而详情、收藏入口、
        /// 「为什么这家放不了却由别家放」这些都要回答的是最初那一家。
        origin_source: String,
        origin_id: String,
        origin_label: String,
    },
    LibraryChanged,
    /// 在线音质自动降档：这一首在高档上失败过，它的运行时上限已收到下一档，
    /// 同一进程内不再对它尝试更高的档。降档必须让用户看见——不然「无损变成
    /// 320k」只表现为听着不太对，没人会去查是不是登录掉了或这首本来就没货。
    QualityDowngraded {
        track_id: String,
        /// 展示用标题（在线元数据快照，缺失时退化为平台 id 尾段）。
        title: String,
        source: String,
        /// 中文档位名（无损 / 高品 320k / …），前端不必再翻档位表。
        from_label: String,
        to_label: String,
    },
    /// F2 整单续载进度：服务端按页把集合（歌单）曲目补进当前队列。
    /// `done` 是终态（平台页耗尽 / 达上限 / 整页重复），`error` 只是
    /// 「这次没补上」——已准备的曲目不因一次补页失败而消失，下次切曲
    /// 会自动再试。
    CollectionLoad {
        source: String,
        id: String,
        loaded: usize,
        total: u64,
        done: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
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

    /// 只读遍历（按写入序号排序，新→旧）。给状态面板这类诊断视图用：它要的正是
    /// 「最近在忙哪几首」，而关键路径上的读取仍然走 `get`，不经过这里。
    pub(crate) fn newest_first(&self) -> Vec<(&String, &V)> {
        let mut out: Vec<(u64, (&String, &V))> = self
            .map
            .iter()
            .map(|(k, (seq, v))| (*seq, (k, v)))
            .collect();
        out.sort_unstable_by_key(|(seq, _)| std::cmp::Reverse(*seq));
        out.into_iter().map(|(_, kv)| kv).collect()
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

/// 同时跑的节拍分析数。2 = 「当前这首在算，上一首切走的那份也能收尾」，再多就
/// 开始和正在解码的音频抢 CPU；一台机器上的音频解码只需要一份。
pub(crate) const BEAT_ANALYZE_BUDGET: usize = 2;

/// 一首的节拍分析最多试几次。到顶就放弃到进程结束：一首真放不出地图的文件不该
/// 每次播放都重算几秒 FFT（参考实现同一条纪律，它给的也是三次）。
pub(crate) const BEAT_ATTEMPTS_MAX: u8 = 3;

/// 未落盘地图的保留条数（见 [`AppState::beat_volatile`]）。
pub(crate) const BEAT_VOLATILE_CAP: usize = 8;

/// 状态面板上「最近几条」的条数。再多就没法一眼读完 —— 这块是给人看后台在忙什么，
/// 不是日志替代品（完整过程在 `playback.log` 里）。
pub(crate) const BEAT_STATUS_RECENT: usize = 6;

/// 缓存键 → 曲名的留档条数。只服务于状态面板的可读性，被淘汰的键在面板上退化成
/// 短键名，不影响分析本身。
pub(crate) const BEAT_LABEL_CAP: usize = 256;

/// 接力坏流记忆上限：到顶就清空（整盘换队/成功提交也会清）。
pub(crate) const RELAY_TRIED_CAP: usize = 64;

/// 每轨运行时音质上限的条数上限。一首只占几十字节，取值远大于一次会话放过的
/// 在线曲数；被淘汰的那首等于忘掉它的失败证据，会重新试一次高档。
pub(crate) const QUALITY_CEILING_CAP: usize = 4096;

/// 曲源接力的尝试记忆。两份键各有各的用处，都是到顶整表清（不LRU：这条链
/// 只在一次故障恢复期间活着，谁先被忘掉都不影响正确性，只影响要不要多试一次）。
///
/// - `ids`：这台曲目的虚拟 id。挡住「换源搜回来还是同一个坏流」的原地回环。
/// - `providers`：`曲目身份键|音源`。**按身份而不是按 id 去重**：同一平台把同一
///   首歌以两个 id 再列一遍（重编码条目、翻唱条目）不该算第二次机会，而换一家
///   音源试同一首仍然是正当的下一档 —— 所以身份键必须带上音源。只按 id 去重的
///   话「同一家第二份同名条目」会被当成新候选，接力链能在一个平台上白等好几轮
///   数秒的取流。
#[derive(Clone, Default)]
pub(crate) struct RelayMemory {
    ids: Vec<String>,
    providers: Vec<String>,
}

impl RelayMemory {
    /// 记一次尝试。`provider_key` 为 None（拿不到可用身份）时只记 id。
    pub(crate) fn note(&mut self, id: &str, provider_key: Option<String>) {
        if !self.ids.iter().any(|x| x == id) {
            if self.ids.len() >= RELAY_TRIED_CAP {
                self.ids.clear();
            }
            self.ids.push(id.to_string());
        }
        let Some(key) = provider_key else { return };
        if self.providers.contains(&key) {
            return;
        }
        if self.providers.len() >= RELAY_TRIED_CAP {
            self.providers.clear();
        }
        self.providers.push(key);
    }

    pub(crate) fn holds_id(&self, id: &str) -> bool {
        self.ids.iter().any(|x| x == id)
    }

    pub(crate) fn holds_provider(&self, key: &str) -> bool {
        self.providers.iter().any(|x| x == key)
    }

    pub(crate) fn clear(&mut self) {
        self.ids.clear();
        self.providers.clear();
    }
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
    /// 平台随取流一起给的响度标签（见 [`crate::online::StreamInfo`] 的 rg_*）。
    /// 缓存在这里是因为**缓存命中那次播放不会再打取流接口**，值只能从上一轮
    /// 取流时留下；`serde` 对 Option 缺字段默认 None，旧客户端的 /player/load
    /// 请求体照旧能用。
    pub rg_gain_db: Option<f64>,
    pub rg_peak: Option<f64>,
    /// 用户当初选中的**出处**（哪家平台的哪个 id）。`None` = 出处就是队列里这一项
    /// 自己；只有曲源接力换过家才会有值，且换第二次仍记第一家（用户选的从来不是
    /// 「上一家」，是最初那一家）。
    ///
    /// 为什么要单独留这一份：换源之后队列项、缓存键、音质、播放历史、打卡都跟着
    /// **实际供音那家**走，于是「用户明明点的是网易云那一首」这件事在系统里再无
    /// 处可查。出处与供音必须分开放（借鉴清单 §8 F3）——本结构只负责**保留出处**，
    /// 业务策略（收藏落到哪家、换源后该不该按原平台打卡）另议，不在这里顺带改。
    ///
    /// `Option` 字段 serde 缺省即 `None`，所以旧客户端的 /player/load 请求体不带
    /// 这个字段也照样能读（那条兼容性由 `snap_without_origin_field_still_deserializes`
    /// 钉住，而不是靠这里写 `#[serde(default)]` —— 那个属性对 Option 是冗余的）。
    pub origin: Option<OnlineOrigin>,
}

/// 队列项的出处身份。字段与队列项自己的 `(source, ref_id)` 同形，调用方不必再拆
/// 虚拟 id；`label` 是当时那家的展示名，省得前端反查清单。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct OnlineOrigin {
    pub source: String,
    pub id: String,
    pub label: Option<String>,
}

impl OnlineMetaSnap {
    /// 这首的出处：没有记录就是它自己。
    pub(crate) fn origin_of(&self, source: &str, id: &str) -> (String, String, Option<String>) {
        match &self.origin {
            Some(o) => (o.source.clone(), o.id.clone(), o.label.clone()),
            None => (source.to_string(), id.to_string(), None),
        }
    }

    /// 是否被换过源（出处与当前供音那家不是同一家）。
    pub(crate) fn relayed(&self, source: &str) -> bool {
        self.origin
            .as_ref()
            .map(|o| o.source != source)
            .unwrap_or(false)
    }

    /// 换源时把出处补齐：**已经有出处就原样带着**。多跳接力
    /// （网易云 → QQ → 酷狗）记的必须还是网易云 —— 用户点的是那一家，不是
    /// 「上一家」。中间跳只在诊断日志里留痕。
    pub(crate) fn ensure_origin(&mut self, source: &str, id: &str, label: Option<String>) {
        if self.origin.is_some() {
            return;
        }
        self.origin = Some(OnlineOrigin {
            source: source.to_string(),
            id: id.to_string(),
            label,
        });
    }
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

pub(crate) struct CommittedQuality {
    track_id: String,
    play_generation: usize,
    actor_generation: u64,
    actual: Option<crate::online::quality::Quality>,
    cached_path: Option<PathBuf>,
}

/// One optional actor preparation tied to existing queue positions, not a
/// second queue. The sequence distinguishes late receipts from newer work.
#[derive(Clone)]
pub(crate) struct PreparedPlayback {
    sequence: usize,
    play_generation: usize,
    actor_generation: u64,
    from_index: usize,
    from_track_id: String,
    to_index: usize,
    to_track_id: String,
    mode: PlayMode,
    crossfade_ms: u64,
    path: PathBuf,
    actual_quality: Option<crate::online::quality::Quality>,
    track_gain_db: f32,
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
    /// F2 整单续载：活跃的集合补页意图与会话计数，owner 在 [`crate::collection`]。
    pub(crate) playlist_load: Mutex<crate::collection::PlaylistLoad>,
    pub(crate) playlist_fetch: Mutex<()>,
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
    pub(crate) prepared_playback: Mutex<Option<PreparedPlayback>>,
    pub(crate) prepare_sequence: AtomicUsize,
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
    /// 每轨的运行时音质上限（在线曲虚拟 id → 已证实可得的最高档）。只降不升，
    /// 键含音源所以换源救回来的那首不受旧源的上限影响。偏好是用户的意图，
    /// 这张表只是这首曲子在本进程里的证据。
    pub(crate) quality_caps: Mutex<BoundedMap<crate::online::quality::Quality>>,
    pub(crate) committed_quality: Mutex<Option<CommittedQuality>>,
    /// 节拍分析幂等表：缓存键 → 任务态。
    pub(crate) stage_beats: Mutex<BoundedMap<crate::stage_beats::TaskState>>,
    /// 节拍分析的总并发预算：一首的 FFT 是几秒的满核运算，快速连切歌时若每首
    /// 都立刻开跑，抢的是正在解码那首歌的 CPU（听感是声音发卡，而画面一切正常）。
    /// 额度只有这么一处，用完之后提交路径直接推迟、GET 路径等一手。
    pub(crate) beat_slots: Arc<tokio::sync::Semaphore>,
    /// 「分析出来了但没写进磁盘」的地图（缓存键 → 地图）。这是刻意保留的第二
    /// 种状态，不是失败：这轮播放能用，重启不能。表本身有界（
    /// [`BEAT_VOLATILE_CAP`]），落盘长期失败的机器最多占这几首的内存。
    pub(crate) beat_volatile: Mutex<BoundedMap<std::sync::Arc<vmusic_beats::BeatMap>>>,
    /// 缓存键 → 曲名。只为「后台节拍分析」那行状态面板服务：任务表里存的是 sha1
    /// 键，人读不懂；把请求时的标题留一份，才能说清「在算的是哪一首」。
    pub(crate) beat_labels: Mutex<BoundedMap<String>>,
    /// 因额度用满被推迟的分析次数。让路这件事必须是**可数的**，否则「为什么这首歌
    /// 没有镜头」只能靠猜。
    pub(crate) beat_deferrals: std::sync::atomic::AtomicUsize,
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
    /// 曲源接力链的已知尝试（见 [`RelayMemory`]）：虚拟 id 防回环，
    /// `身份|音源` 防同一平台换个 id 再试一遍。成功提交或整盘换队即清空。
    pub(crate) relay_tried: Mutex<RelayMemory>,
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
        self.loudness_for(&track_id, mode).await
    }

    async fn loudness_for(&self, track_id: &str, mode: &str) -> Option<(f64, &'static str)> {
        if crate::online::split_virtual_id(track_id).is_some() {
            // 在线曲的响度来自平台随取流一起给的 gain/peak，存在 online_meta 里
            // （见 play_online 的落地）；没有标签就报「没有」，调用方按 0 dB 播。
            return self.online_gain(track_id).await;
        }
        let rg = vmusic_store::get_track_rg(&self.db, &track_id.to_string())
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

    /// 队列里这一项的**出处**（F3）。第二个返回值 = 它是否被接力换过家。
    ///
    /// 两个播放门面都从这里取：刷新或换端之后，前端自己的暂存可能已经没有这一项，
    /// 而服务端的队列快照才是权威 —— 说不清「点的是谁、现在谁在放」就等于把
    /// 换源这件事藏起来。没有快照（本地曲、或内存已被淘汰）返回 `None`，调用方
    /// 按「不是换源来的」处理，不许猜一个。
    pub(crate) async fn online_origin(&self, track_id: &str) -> Option<(OnlineOrigin, bool)> {
        let snap = self.online_meta.lock().await.get(track_id).cloned()?;
        let (source, id) = crate::online::split_virtual_id(track_id)?;
        let (o_source, o_id, o_label) = snap.origin_of(&source, &id);
        Some((
            OnlineOrigin {
                source: o_source,
                id: o_id,
                label: o_label,
            },
            snap.relayed(&source),
        ))
    }

    /// 这一首本次该瞄哪一档：逐源偏好夹进该曲的运行时音质上限。
    ///
    /// 播放、预取、解码失败收口三处共用它。各算各的话，预取会绕开上限去要那个
    /// 刚失败过的高档（白跑一次数秒的取流），解码收口会按偏好档记错失败档——
    /// 两者都可能把刚退下来的一格又顶回去。
    pub(crate) async fn online_quality_for(
        &self,
        source: &str,
        track_id: &str,
    ) -> crate::online::quality::Quality {
        let want = {
            let prefs = self.quality.lock().await;
            crate::online::quality::get(&prefs, source)
        };
        let ceiling = self.quality_caps.lock().await.get(track_id).copied();
        crate::online::quality::clamp_request(want, ceiling)
    }

    /// 哪些失败算「这一档给不出来」，因而值得收紧该曲的音质上限。
    ///
    /// 不收的三类各有各的理由：上游整体超时/网络抖动——换档救不了网络，把一次
    /// 抖动记成永久上限会让这首歌在整个会话里再也拿不到高档；曲目下架
    /// （not_found）——退到哪一档都放不了，该走接力/跳曲；需登录
    /// （auth_required）——那是**账号**级的证据，owner 是登录流程与 A6 的会话
    /// 三态，记到每首歌头上会让整批 VIP 曲在一次未登录尝试后被永久压低。参考
    /// 项目同一条规则：login_required 直接不进降档重试。
    fn ceiling_eligible(code: &str) -> bool {
        matches!(code, "vip_required" | "decode_stalled")
    }

    /// 记一次「这一档放不出来」：把这首的运行时上限退到下一档，并让用户看见。
    /// 每退一格提示一次（连续三次失败就是三条，用户看得见音质在一格格掉）；
    /// 已在最低档时整表不动、也不再重复提示
    /// （见 [`crate::online::quality::lower_ceiling`]）。
    ///
    /// The actual attempted tier is immutable evidence; settings may change while a request is pending.
    async fn note_quality_failure(
        &self,
        track_id: &str,
        code: &str,
        failed_at: crate::online::quality::Quality,
    ) {
        if !Self::ceiling_eligible(code) {
            return;
        }
        let Some((source, _)) = crate::online::split_virtual_id(track_id) else {
            return;
        };
        let lowered = {
            let mut caps = self.quality_caps.lock().await;
            match crate::online::quality::lower_ceiling(caps.get(track_id).copied(), failed_at) {
                Some(ceiling) => {
                    caps.insert(track_id.to_string(), ceiling);
                    Some(ceiling)
                }
                None => None,
            }
        };
        let Some(ceiling) = lowered else {
            return;
        };
        crate::diaglog!(
            "quality.cap",
            track = track_id,
            source = source,
            code = code,
            from = failed_at.as_str(),
            to = ceiling.as_str()
        );
        // 标题优先入队时的元数据快照，缺失退化到平台 id（与跳曲提示同一取法）。
        let title = {
            let meta = self.online_meta.lock().await;
            meta.get(track_id)
                .map(|m| m.title.clone())
                .unwrap_or_else(|| track_title(track_id))
        };
        self.publish(WsEvent::QualityDowngraded {
            track_id: track_id.to_string(),
            title,
            source,
            from_label: failed_at.label().to_string(),
            to_label: ceiling.label().to_string(),
        });
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
            // 出处同理：新快照没带 origin 不等于「没换过源」，可能是前端自己的
            // 暂存里没有这一项（刷新之后常见）。已经知道的事不能被一次普通的
            // 入队/注入忘掉。
            if snap.origin.is_none() {
                snap.origin = old.origin.clone();
            }
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
        if let Some(next) = self.prepared_playback.lock().await.as_ref() {
            if let Some(name) = next.path.file_name().and_then(|name| name.to_str()) {
                all.push(name.to_string());
            }
        }
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
        self.set_queue_locked(ids, start).await
    }

    /// Caller holds play_commit; shared online preparation adds metadata in that same transaction.
    pub(crate) async fn set_queue_locked(
        &self,
        ids: Vec<String>,
        start: Option<usize>,
    ) -> (usize, Vec<String>, Option<usize>) {
        self.cancel_prepared_playback().await;
        {
            let mut radio = self.radio.lock().await;
            radio.active = false;
            radio.loading = false;
            radio.session = radio.session.wrapping_add(1);
            radio.initial_generation = None;
            radio.error = None;
        }
        // 整盘换队同样作废 F2 的整单续载意图：新队列来自新的播放意图，
        // 旧歌单的补页任务不许再往里追加（F2 验收线：旧意图不能覆盖新队列）。
        {
            let mut pl = self.playlist_load.lock().await;
            pl.session = pl.session.wrapping_add(1);
            pl.active = None;
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
        self.schedule_prepare_next();
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
        self.cancel_prepared_playback().await;
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
            let record = {
                let _commit = self.play_commit.lock().await;
                if self.attempt_alive(gen, index, &track_id).await {
                    self.on_track_committed(&track_id, outcome.actual_quality)
                        .await;
                    true
                } else {
                    false
                }
            };
            if record {
                self.record_track_commit(&track_id, gen).await;
            }
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

    /// One deadline covers both attempts. Late completions cannot lower caps or publish events.
    #[allow(clippy::too_many_arguments)]
    async fn resolve_online_stream<F, Fut>(
        &self,
        gen: usize,
        index: usize,
        track_id: &str,
        source: &str,
        mut quality: crate::online::quality::Quality,
        total: std::time::Duration,
        mut fetch: F,
    ) -> crate::error::ApiResult<Option<(crate::online::StreamInfo, crate::online::quality::Quality)>>
    where
        F: FnMut(crate::online::quality::Quality) -> Fut,
        Fut: std::future::Future<Output = crate::error::ApiResult<crate::online::StreamInfo>>,
    {
        let deadline = tokio::time::Instant::now() + total;
        for attempt in 0..2 {
            if !self.attempt_alive(gen, index, track_id).await {
                return Ok(None);
            }
            let result = tokio::time::timeout_at(deadline, fetch(quality))
                .await
                .unwrap_or_else(|_| {
                    Err(crate::error::ApiError::upstream_timeout("取流超过总时限")
                        .with_source(source))
                });
            let _commit = self.play_commit.lock().await;
            if !self.attempt_alive(gen, index, track_id).await {
                return Ok(None);
            }
            match result {
                Ok(info) => return Ok(Some((info, quality))),
                Err(e) => {
                    self.note_quality_failure(track_id, e.code, quality).await;
                    let next = self.online_quality_for(source, track_id).await;
                    if attempt == 0
                        && Self::ceiling_eligible(e.code)
                        && next.rank() < quality.rank()
                    {
                        quality = next;
                    } else {
                        return Err(e);
                    }
                }
            }
        }
        unreachable!("the final attempt always returns")
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
        // 档位 = 逐源偏好夹进这首的运行时上限（见 online_quality_for）。上限只
        // 由这一首自己的失败产生，所以「按第二次重试」不会重走同一档必然失败
        // 的取流；want 字段带的就是夹后的档，排查时看 diaglog 不必再猜。
        // mut：就地降档重试（下方 stream.fail 分支）会把这两者换到下一档，
        // 下载与缓存必须落在实测档位的键下。
        let mut quality = self.online_quality_for(&source, &track_id).await;
        let mut key = crate::online::cache::cache_key(&source, &id, quality.as_str());
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
            let resolved = self
                .resolve_online_stream(
                    gen,
                    index,
                    &track_id,
                    &source,
                    quality,
                    std::time::Duration::from_secs(20),
                    |tier| crate::online::stream(&ctx, &source, &id, None, Some(tier.bps())),
                )
                .await;
            let info = match resolved {
                Ok(Some((info, attempted))) => {
                    quality = attempted;
                    key = crate::online::cache::cache_key(&source, &id, quality.as_str());
                    info
                }
                Ok(None) => {
                    return Ok(PlayOutcome {
                        committed: false,
                        actual_quality: None,
                    })
                }
                Err(e) => {
                    return self
                        .online_failed(
                            gen,
                            index,
                            track_id,
                            prev_cursor,
                            trigger,
                            None,
                            e.with_source(source),
                        )
                        .await
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
                        .online_failed(gen, index, track_id, prev_cursor, trigger, Some(quality), e)
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
                            Some(quality),
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
                        actual,
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
                            actual,
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
                        actual,
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
                    actual,
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
        if committed && play.is_ok() {
            self.remember_committed_quality(gen, &track_id, actual, None)
                .await;
        }
        self.set_buffering(false, None).await;
        if let Err(e) = play {
            drop(commit);
            return self
                .online_failed(
                    gen,
                    index,
                    track_id,
                    prev_cursor,
                    trigger,
                    actual,
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
        if committed {
            self.remember_committed_quality(gen, track_id, actual, Some(path.to_path_buf()))
                .await;
        }
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
                    actual,
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
                    actual,
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

    /// Caller holds play_commit. Cancellation only queues an actor command;
    /// it cannot wait for the file probe performed by an earlier preparation.
    pub(crate) async fn cancel_prepared_playback(&self) {
        self.prepare_sequence.fetch_add(1, Ordering::Relaxed);
        self.prepared_playback.lock().await.take();
        let _ = self.audio.cancel_next();
    }

    pub(crate) fn schedule_prepare_next(&self) {
        if let Some(state) = self.weak_self.get().and_then(std::sync::Weak::upgrade) {
            tokio::spawn(async move {
                state.prepare_next_playback().await;
            });
        }
    }

    async fn prepare_next_playback(&self) {
        let (mut next, sequence) = {
            let _commit = self.play_commit.lock().await;
            let snapshot = self.audio.snapshot();
            if !snapshot.playing || snapshot.mode == PlayMode::Shuffle {
                return;
            }
            let queue = self.queue.lock().await;
            let Some(from_index) = *self.cursor.lock().await else {
                return;
            };
            let Some(from_track_id) = queue.get(from_index) else {
                return;
            };
            if snapshot.track_id.as_ref() != Some(from_track_id) {
                return;
            }
            let radio = self.radio.lock().await;
            let to_index = match snapshot.mode {
                PlayMode::RepeatOne => from_index,
                _ if from_index + 1 < queue.len() => from_index + 1,
                _ if !radio.active => 0,
                _ => return,
            };
            let Some(to_track_id) = queue.get(to_index) else {
                return;
            };
            let generation = self.play_generation.load(Ordering::Relaxed);
            let crossfade_ms = self.dsp.lock().await.crossfade_ms;
            if self
                .prepared_playback
                .lock()
                .await
                .as_ref()
                .is_some_and(|p| {
                    p.play_generation == generation
                        && p.actor_generation == snapshot.generation
                        && p.to_index == to_index
                        && p.to_track_id == *to_track_id
                        && p.crossfade_ms == crossfade_ms
                })
            {
                return;
            }
            let sequence = self.prepare_sequence.load(Ordering::Relaxed);
            (
                PreparedPlayback {
                    sequence,
                    play_generation: generation,
                    actor_generation: snapshot.generation,
                    from_index,
                    from_track_id: from_track_id.clone(),
                    to_index,
                    to_track_id: to_track_id.clone(),
                    mode: snapshot.mode,
                    crossfade_ms,
                    path: PathBuf::new(),
                    actual_quality: None,
                    track_gain_db: 0.0,
                },
                sequence,
            )
        };

        // No playback lock during DB lookup, filesystem access or actor probe.
        if let Some((source, id)) = crate::online::split_virtual_id(&next.to_track_id) {
            let quality = self.online_quality_for(&source, &next.to_track_id).await;
            let Some((path, actual)) = self.find_online_cached(&source, &id, quality).await else {
                return;
            };
            next.path = path;
            next.actual_quality = Some(actual);
        } else {
            let Ok(Some(track)) = vmusic_store::get_track(&self.db, &next.to_track_id).await else {
                return;
            };
            if track.source == vmusic_core::TrackSource::Remote {
                return;
            }
            next.path = PathBuf::from(track.path);
        }
        if !tokio::fs::metadata(&next.path)
            .await
            .is_ok_and(|m| m.is_file())
        {
            return;
        }
        let dsp = self.dsp.lock().await.clone();
        if dsp.loudness_enabled() {
            next.track_gain_db = self
                .loudness_for(&next.to_track_id, &dsp.loudness_mode)
                .await
                .map_or(0.0, |(gain, _)| gain as f32);
            let current_gain = self
                .loudness_for(&next.from_track_id, &dsp.loudness_mode)
                .await
                .map_or(0.0, |(gain, _)| gain as f32);
            // The output DSP is shared by both decks. Until gains can travel
            // with each deck, preserve normal per-track normalization rather
            // than apply the outgoing gain to the incoming track's first frames.
            if !current_gain.is_finite()
                || !next.track_gain_db.is_finite()
                || (current_gain - next.track_gain_db).abs() > 0.0001
            {
                crate::diaglog!(
                    "transition.bypass",
                    track = next.to_track_id,
                    reason = "track normalization changes at this boundary"
                );
                return;
            }
        }
        let Some(uri) = next.path.to_str() else {
            return;
        };
        let receipt = {
            let _commit = self.play_commit.lock().await;
            if self.prepare_sequence.load(Ordering::Relaxed) != sequence
                || !self
                    .preparation_matches(&next, &self.audio.snapshot(), false)
                    .await
            {
                return;
            }
            if self
                .prepared_playback
                .lock()
                .await
                .as_ref()
                .is_some_and(|p| {
                    p.play_generation == next.play_generation
                        && p.actor_generation == next.actor_generation
                        && p.to_index == next.to_index
                        && p.crossfade_ms == next.crossfade_ms
                })
            {
                return;
            }
            next.sequence = self.prepare_sequence.fetch_add(1, Ordering::Relaxed) + 1;
            *self.prepared_playback.lock().await = Some(next.clone());
            self.audio.begin_prepare_next(
                uri,
                next.to_track_id.clone(),
                next.actor_generation,
                next.crossfade_ms,
            )
        };
        let result = match receipt {
            Ok(receipt) => receipt.await.unwrap_or(Err(vmusic_core::AudioError::Other(
                "audio actor stopped".into(),
            ))),
            Err(error) => Err(error),
        };
        if !matches!(result, Ok(vmusic_audio::PrepareResult::Prepared(_))) {
            let mut pending = self.prepared_playback.lock().await;
            if pending
                .as_ref()
                .is_some_and(|p| p.sequence == next.sequence)
            {
                pending.take();
            }
            let reason = match result {
                Ok(vmusic_audio::PrepareResult::Bypassed { reason }) => reason,
                Err(error) => error.to_string(),
                _ => unreachable!(),
            };
            crate::diaglog!(
                "transition.bypass",
                track = next.to_track_id,
                reason = reason
            );
        }
    }

    async fn preparation_matches(
        &self,
        next: &PreparedPlayback,
        snapshot: &PlayerSnapshot,
        transitioned: bool,
    ) -> bool {
        if self.play_generation.load(Ordering::Relaxed) != next.play_generation
            || snapshot.mode != next.mode
            || snapshot.generation != next.actor_generation + u64::from(transitioned)
            || if transitioned {
                // DecodeError can clear the snapshot immediately after a
                // transition in the same actor tick. Its unchanged generation
                // still proves this transition happened before that failure.
                snapshot
                    .track_id
                    .as_ref()
                    .is_some_and(|id| id != &next.to_track_id)
            } else {
                snapshot.track_id.as_ref() != Some(&next.from_track_id)
            }
            || (!transitioned && !snapshot.playing)
        {
            return false;
        }
        let queue = self.queue.lock().await;
        *self.cursor.lock().await == Some(next.from_index)
            && queue.get(next.from_index) == Some(&next.from_track_id)
            && queue.get(next.to_index) == Some(&next.to_track_id)
    }

    /// Fast event-pump commit. Preparation already captured metadata and gain;
    /// no source opening or network request happens in this transaction.
    async fn commit_prepared_transition(
        &self,
        from_generation: u64,
        generation: u64,
        track_id: &str,
    ) -> Option<PreparedPlayback> {
        let _commit = self.play_commit.lock().await;
        let snapshot = self.audio.snapshot();
        let mut next = self.prepared_playback.lock().await.clone()?;
        if next.actor_generation != from_generation
            || generation != from_generation + 1
            || next.to_track_id != track_id
            || snapshot.generation != generation
            || !self.preparation_matches(&next, &snapshot, true).await
        {
            return None;
        }
        self.prepared_playback.lock().await.take();
        self.prepare_sequence.fetch_add(1, Ordering::Relaxed);
        let play_generation = self.play_generation.fetch_add(1, Ordering::Relaxed) + 1;
        *self.cursor.lock().await = Some(next.to_index);
        self.remember_committed_quality(
            play_generation,
            track_id,
            next.actual_quality,
            next.actual_quality.map(|_| next.path.clone()),
        )
        .await;
        self.auto_failures.store(0, Ordering::Relaxed);
        *self.skip_walk_from.lock().await = None;
        self.relay_tried.lock().await.clear();
        let mut protected = self.protected.lock().await;
        protected.clear();
        if next.actual_quality.is_some() {
            if let Some(name) = next.path.file_name().and_then(|name| name.to_str()) {
                protected.push(name.to_string());
            }
        }
        drop(protected);
        let dsp = self.dsp.lock().await.clone();
        let _ = self
            .audio
            .set_dsp(vmusic_core::DspParams {
                eq_gains_db: dsp.eq_gains_db,
                preamp_db: dsp.preamp_db,
                track_gain_db: if dsp.loudness_enabled() {
                    next.track_gain_db
                } else {
                    0.0
                },
            })
            .await;
        next.play_generation = play_generation;
        Some(next)
    }

    /// A seek/resume is still the same media file; preserve B4's observed quality.
    /// Caller holds play_commit after the successful actor transport command.
    pub(crate) async fn transport_committed(&self) {
        let snapshot = self.audio.snapshot();
        let mut quality = self.committed_quality.lock().await;
        if let Some(quality) = quality
            .as_mut()
            .filter(|q| snapshot.track_id.as_ref() == Some(&q.track_id))
        {
            quality.actor_generation = snapshot.generation;
            quality.play_generation = self.play_generation.load(Ordering::Relaxed);
        }
        drop(quality);
        if snapshot.playing {
            self.schedule_prepare_next();
        }
    }

    fn watch_prefetch_completion(&self, view: crate::online::progressive::DownloadView) {
        let Some(state) = self.weak_self.get().and_then(std::sync::Weak::upgrade) else {
            return;
        };
        let play_generation = self.play_generation.load(Ordering::Relaxed);
        let actor_generation = self.audio.snapshot().generation;
        let (_, _, abort) = view.media_parts();
        tokio::spawn(async move {
            while !view.is_finished() {
                if abort.load(Ordering::Relaxed)
                    || state.play_generation.load(Ordering::Relaxed) != play_generation
                    || state.audio.snapshot().generation != actor_generation
                {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            if state.play_generation.load(Ordering::Relaxed) == play_generation
                && state.audio.snapshot().generation == actor_generation
            {
                state.schedule_prepare_next();
            }
        });
    }

    /// 播放成功提交后的内联收口：只做快操作（清连续失败计数、写历史）。
    ///
    /// 预取与 LRU 含网络/磁盘 await（预取要发一次取流 API，最坏数秒），绝不能
    /// 内联在这里拖慢 /online/play 等 HTTP 响应与自动接力；统一由
    /// [`Self::post_commit_background`] 在调用入口 detach 出去。
    pub(crate) async fn on_track_committed(
        &self,
        _track_id: &str,
        actual: Option<crate::online::quality::Quality>,
    ) {
        self.auto_failures.store(0, Ordering::Relaxed);
        // 跳曲走结束了：起点锚只在一次「连着跳了好几首」的过程中有意义。
        *self.skip_walk_from.lock().await = None;
        // 接力链结束了：这一串已试过的坏流不再需要记忆。
        self.relay_tried.lock().await.clear();
        self.schedule_prepare_next();
        // Actual quality belongs to the earlier actor commit transaction.
        let _ = actual;
    }

    async fn record_track_commit(&self, track_id: &str, generation: usize) {
        self.record_history(track_id).await;
        if self.play_generation.load(Ordering::Relaxed) != generation
            || self.audio.snapshot().track_id.as_deref() != Some(track_id)
        {
            return;
        }
        // 节拍分析：成功起播后后台 detach，覆盖手动点播/重播/在线播放/自动接力
        // 四条提交路径（committed 是唯一收口）。不 await、不阻塞播放链路。
        if let Some(arc) = self.weak_self.get().and_then(std::sync::Weak::upgrade) {
            crate::stage_beats::spawn_after_commit(arc, track_id.to_string());
        }
        self.schedule_prepare_next();
    }

    /// Called while play_commit is held immediately after the audio actor accepted the track.
    async fn remember_committed_quality(
        &self,
        gen: usize,
        track_id: &str,
        actual: Option<crate::online::quality::Quality>,
        cached_path: Option<PathBuf>,
    ) {
        *self.committed_quality.lock().await = Some(CommittedQuality {
            track_id: track_id.to_string(),
            play_generation: gen,
            actor_generation: self.audio.snapshot().generation,
            actual,
            cached_path,
        });
    }

    /// The caller holds play_commit. Consume exactly one failure from the matching attempt.
    async fn take_failed_quality(
        &self,
        track_id: &str,
        actor_generation: u64,
    ) -> Option<CommittedQuality> {
        let mut committed = self.committed_quality.lock().await;
        if committed.as_ref().is_some_and(|c| {
            c.track_id == track_id
                && c.actor_generation == actor_generation
                && c.play_generation == self.play_generation.load(Ordering::Relaxed)
        }) {
            committed.take()
        } else {
            None
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
            let _ = tokio::join!(
                s.radio_refill(false),
                s.playlist_refill(false),
                s.spawn_prefetch()
            );
            s.schedule_prepare_next();
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
        // 预取与播放同一只夹上限的档位：绕开上限预热，等于把刚失败过的高档
        // 请求原样再发一遍，还要白花一份带宽。
        let quality = self.online_quality_for(&source, &vid).await;
        let key = crate::online::cache::cache_key(&source, &id, quality.as_str());
        if let Some(view) = self
            .downloads
            .lock()
            .await
            .get(&key)
            .map(|entry| entry.dl.view())
        {
            self.watch_prefetch_completion(view);
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
                self.watch_prefetch_completion(dl.view());
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
        let Some((failed_source, failed_id)) = crate::online::split_virtual_id(&track_id) else {
            return false;
        };
        // 匹配输入只认入队快照：重启后从歌单直播（无快照）宁可放弃接力，
        // 也不拿平台 id 当标题去搜。
        let meta = match self.online_meta.lock().await.get(&track_id).cloned() {
            Some(m) if !m.title.trim().is_empty() => m,
            _ => return false,
        };
        // 已知坏流先登记：id 防原地回头，`身份|音源` 防同平台换 id 再试一遍。
        let identity = relay_identity(&meta.title, meta.artist.as_deref());
        {
            let mut tried = self.relay_tried.lock().await;
            tried.note(&track_id, Some(format!("{identity}|{failed_source}")));
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
        let memory = self.relay_tried.lock().await.clone();
        let occupied: Vec<String> = self
            .queue
            .lock()
            .await
            .iter()
            .enumerate()
            .filter(|(slot, _)| *slot != index)
            .map(|(_, id)| id.clone())
            .collect();
        let Some((score, cand)) =
            pick_relay_candidate(&agg.results, &memory, &failed_source, &meta, &occupied)
        else {
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
        let Some(origin) = self.commit_relay_target(gen, index, &track_id, &cand).await else {
            return false;
        };
        let origin = Some(origin);
        // 换源续播：接力链再失败会重新进 online_failed，relay_tried 已把旧
        // id 登记在案，候选池单调缩小直到穷尽，无死循环。成功后新一轮播放
        // 自己完成提交收口（历史/打卡/预取），这里只补上「接力成功」的告知。
        let relayed = matches!(
            Box::pin(self.play_index_for(index, Some(gen), trigger)).await,
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
                from_track_id: track_id.clone(),
                // origin 在上面那个迁移块里必定被写过（is_none 就补），这里拿不到
                // 只可能是那条路径没走到；退回「就是失败那家」，绝不留空字段。
                origin_source: origin
                    .as_ref()
                    .map(|o| o.source.clone())
                    .unwrap_or_else(|| failed_source.clone()),
                origin_id: origin
                    .as_ref()
                    .map(|o| o.id.clone())
                    .unwrap_or_else(|| failed_id.clone()),
                origin_label: origin
                    .as_ref()
                    .and_then(|o| o.label.clone())
                    .or_else(|| crate::online::find(&failed_source).map(|s| s.label.to_string()))
                    .unwrap_or_default(),
            });
            if let Some(arc) = self.weak_self.get().and_then(std::sync::Weak::upgrade) {
                arc.post_commit_background();
            }
        }
        relayed
    }

    /// 在线曲播放失败的统一收口（取流/下载/解码失败都汇到这里）。
    /// Atomically install a relay without changing another queue entry's provenance.
    async fn commit_relay_target(
        &self,
        gen: usize,
        index: usize,
        track_id: &str,
        cand: &crate::online::OnlineTrack,
    ) -> Option<OnlineOrigin> {
        let (failed_source, failed_id) = crate::online::split_virtual_id(track_id)?;
        let new_id = crate::online::virtual_id(&cand.source, &cand.id);
        let _commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, track_id).await {
            return None;
        }
        let mut queue = self.queue.lock().await;
        if queue
            .iter()
            .enumerate()
            .any(|(slot, id)| slot != index && id == &new_id)
        {
            return None;
        }
        self.cancel_prepared_playback().await;
        queue[index] = new_id.clone();
        let mut map = self.online_meta.lock().await;
        // A repeated old id may remain elsewhere in the queue; its snapshot must survive.
        let mut snap = map
            .get(track_id)
            .cloned()
            .unwrap_or_else(|| OnlineMetaSnap {
                title: cand.title.clone(),
                artist: Some(cand.artist.clone()).filter(|s| !s.is_empty()),
                album: Some(cand.album.clone()).filter(|s| !s.is_empty()),
                cover: cand.cover.clone(),
                duration_ms: Some(cand.duration_ms).filter(|d| *d > 0),
                rg_gain_db: None,
                rg_peak: None,
                origin: None,
            });
        if cand.duration_ms > 0 {
            snap.duration_ms = Some(cand.duration_ms);
        }
        snap.ensure_origin(
            &failed_source,
            &failed_id,
            crate::online::find(&failed_source).map(|s| s.label.to_string()),
        );
        snap.rg_gain_db = None;
        snap.rg_peak = None;
        let origin = snap.origin.clone();
        map.insert(new_id, snap);
        origin
    }

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
    #[allow(clippy::too_many_arguments)]
    async fn online_failed(
        &self,
        gen: usize,
        index: usize,
        track_id: String,
        prev_cursor: Option<usize>,
        trigger: PlayTrigger,
        failed_at: Option<crate::online::quality::Quality>,
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

        // B4 播放失败即降档：这首在这一档给不出来，上限收到下一档，之后同一
        // 进程里不再对它试更高的档。放在接力之后、跳曲之前——接力成功时用户
        // 听到的是另一家音源的同一首，这时补一句「已降到 320k」是自相矛盾的
        // 假话；放在顶代际复核之后，是因为用户切走那一刀不该被当成曲子的判决。
        if let Some(tier) = failed_at {
            self.note_quality_failure(&track_id, e.code, tier).await;
        }

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
            let Some(failed) = self.take_failed_quality(&track_id, generation).await else {
                return;
            };
            // Only a matching actor generation may invalidate bytes or diagnose a tier.
            let failed_at = failed.actual;
            let key = failed_at
                .map(|q| crate::online::cache::cache_key(&source, &id, q.as_str()))
                .unwrap_or_default();
            for (_, entry) in self.downloads.lock().await.drain() {
                entry.dl.cancel();
            }
            if let Some(path) = failed
                .cached_path
                .filter(|p| p.parent().is_some_and(|d| d == self.online_cache_dir()))
            {
                let _ = tokio::fs::remove_file(path).await;
            }
            if let Some(tier) = failed_at {
                self.note_quality_failure(&track_id, "decode_stalled", tier)
                    .await;
                let next = self.online_quality_for(&source, &track_id).await;
                if next.rank() < tier.rank() {
                    let index = *self.cursor.lock().await;
                    self.set_buffering(false, None).await;
                    drop(commit);
                    if let Some(index) = index {
                        if Box::pin(self.play_index_for(
                            index,
                            Some(reservation),
                            PlayTrigger::AutoNext,
                        ))
                        .await
                        .is_ok()
                        {
                            self.post_commit_background();
                        }
                    }
                    return;
                }
            }
            // 标题优先取入队时的元数据快照，缺失退化到 id 尾段。
            let label = {
                let meta = self.online_meta.lock().await;
                meta.get(&track_id)
                    .map(|m| m.title.clone())
                    .unwrap_or_else(|| track_title(&track_id))
            };
            // 播放中断也算「这一档放不出来」：先记上限，再决定跳不跳。用户之后
            // 手动重播或列表循环回到这首时，不会再撞同一档、再断一次。
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
            let _ = self.playlist_refill(false).await;
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

/// 接力用的曲目身份键：`归一化标题|排序后的歌手集`。刻意不含时长——同一首歌的
/// 不同版本时长本就不同，把它们算成两首就会放行重复尝试；歌手缺省时键退化成
/// 只有标题，此时与 [`relay_score`] 一样保守（宁漏勿错）。
fn relay_identity(title: &str, artist: Option<&str>) -> String {
    let mut parts: Vec<String> = artist
        .map(relay_artist_keys)
        .unwrap_or_default()
        .into_iter()
        .collect();
    parts.sort();
    format!("{}|{}", normalize_relay_text(title), parts.join(","))
}

/// 从聚合搜索结果里挑接力候选。
///
/// 抽成纯函数是因为这条链的价值全在去重语义上——「同一首歌换一家音源仍算一次
/// 机会，在同一平台换个 id 不算」只有把网络那层剥掉才断言得动（不然测试要先有
/// 一个会失败的平台）。记忆与失败源都作参数传入，函数不碰任何锁。
fn pick_relay_candidate(
    pages: &[crate::online::SearchPage],
    memory: &RelayMemory,
    failed_source: &str,
    meta: &OnlineMetaSnap,
    occupied: &[String],
) -> Option<(u32, crate::online::OnlineTrack)> {
    let mut best: Option<(u32, crate::online::OnlineTrack)> = None;
    for page in pages {
        if page.source == failed_source {
            continue;
        }
        for t in &page.tracks {
            let vid = crate::online::virtual_id(&page.source, &t.id);
            if memory.holds_id(&vid) || occupied.contains(&vid) {
                continue;
            }
            // 同一身份在这一家已经试过了：换个 id 的同名条目不算第二次机会。
            if memory.holds_provider(&format!(
                "{}|{}",
                relay_identity(&t.title, Some(&t.artist)),
                page.source
            )) {
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
    best
}

/// 接力候选评分。标题归一化相等是门槛（不等直接出局）；歌手交集与/// 时长容差加分；VIP 候选降权不排除（大概率同样放不了，但取流会如实
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
                AudioEvent::Transitioned {
                    from_generation,
                    generation,
                    track_id,
                } => {
                    // Commit the queue before reading the next event: an extremely
                    // short successor can emit Ended in this very actor tick.
                    if let Some(next) = state
                        .commit_prepared_transition(from_generation, generation, &track_id)
                        .await
                    {
                        state.schedule_prepare_next();
                        let committed = state.clone();
                        tokio::spawn(async move {
                            committed
                                .record_track_commit(&next.to_track_id, next.play_generation)
                                .await;
                            committed.post_commit_background();
                        });
                    }
                }
                AudioEvent::TransitionBypassed {
                    generation,
                    track_id,
                    reason,
                } => {
                    // A delayed failure notification must not remove a newer
                    // preparation that happens to target the same track.
                    crate::diaglog!(
                        "transition.bypass",
                        gen = generation,
                        track = track_id,
                        reason = reason
                    );
                }
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
            playlist_load: Default::default(),
            playlist_fetch: Default::default(),
            scan: Default::default(),
            scan_cancel: Default::default(),
            qr: crate::online::qr::Registry::new(),
            play_generation: Default::default(),
            play_commit: Default::default(),
            prepared_playback: Default::default(),
            prepare_sequence: Default::default(),
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
            quality_caps: Mutex::new(BoundedMap::new(QUALITY_CEILING_CAP)),
            committed_quality: Default::default(),
            stage_beats: Mutex::new(BoundedMap::new(STAGE_BEATS_CAP)),
            beat_slots: Arc::new(tokio::sync::Semaphore::new(BEAT_ANALYZE_BUDGET)),
            beat_volatile: Mutex::new(BoundedMap::new(BEAT_VOLATILE_CAP)),
            beat_labels: Mutex::new(BoundedMap::new(BEAT_LABEL_CAP)),
            beat_deferrals: std::sync::atomic::AtomicUsize::new(0),
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

    async fn transition_fixture(state: &AppState, target: &str) -> PreparedPlayback {
        state
            .set_queue(vec!["first".into(), target.into(), "third".into()], Some(0))
            .await;
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        state.audio.play().await.unwrap();
        let snapshot = state.audio.snapshot();
        let next = PreparedPlayback {
            sequence: state.prepare_sequence.load(Ordering::Relaxed),
            play_generation: state.play_generation.load(Ordering::Relaxed),
            actor_generation: snapshot.generation,
            from_index: 0,
            from_track_id: "first".into(),
            to_index: 1,
            to_track_id: target.into(),
            mode: snapshot.mode,
            crossfade_ms: 0,
            path: PathBuf::from("second.wav"),
            actual_quality: None,
            track_gain_db: 0.0,
        };
        *state.prepared_playback.lock().await = Some(next.clone());
        next
    }

    #[tokio::test]
    async fn transition_commit_updates_cursor_once_and_rejects_a_replaced_queue() {
        let (state, handle) = playback_state().await;
        let first = transition_fixture(&state, "second").await;
        // Null load supplies the same new-source generation a callback promotion
        // publishes, without requiring an OS audio device in service tests.
        state
            .audio
            .load("second.wav", Some("second".into()))
            .await
            .unwrap();
        let generation = state.audio.snapshot().generation;
        assert!(state
            .commit_prepared_transition(first.actor_generation, generation, "second")
            .await
            .is_some());
        assert_eq!(state.current_index().await, Some(1));
        assert!(state
            .commit_prepared_transition(first.actor_generation, generation, "second")
            .await
            .is_none());
        let next = transition_fixture(&state, "second").await;
        state
            .audio
            .load("second.wav", Some("second".into()))
            .await
            .unwrap();
        let generation = state.audio.snapshot().generation;
        state.set_queue(vec!["replacement".into()], Some(0)).await;
        assert!(state
            .commit_prepared_transition(next.actor_generation, generation, "second")
            .await
            .is_none());
        assert_eq!(*state.queue.lock().await, vec!["replacement"]);
        assert_eq!(state.current_index().await, Some(0));
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn transition_then_immediate_end_advances_from_the_committed_successor() {
        let dir = std::env::temp_dir().join(format!("vmusic-transition-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let (state, handle) = playback_state_with_db(db).await;
        let next = transition_fixture(&state, "second").await;
        vmusic_store::upsert_track(
            &state.db,
            &vmusic_core::Track {
                id: "third".into(),
                path: "third.wav".into(),
                source: vmusic_core::TrackSource::Local,
                title: "third".into(),
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
        state
            .audio
            .load("second.wav", Some("second".into()))
            .await
            .unwrap();
        let generation = state.audio.snapshot().generation;
        assert!(state
            .commit_prepared_transition(next.actor_generation, generation, "second")
            .await
            .is_some());
        state
            .step_for(
                1,
                PlayTrigger::AutoNext,
                Some((generation, Some("second".into()))),
                None,
            )
            .await
            .unwrap();
        assert_eq!(state.current_index().await, Some(2));
        assert_eq!(state.audio.snapshot().track_id.as_deref(), Some("third"));
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn prepared_cache_is_protected_and_commits_actual_quality() {
        let (state, handle) = playback_state().await;
        let id = crate::online::virtual_id("netease", "second");
        let mut next = transition_fixture(&state, &id).await;
        next.path = PathBuf::from("netease-second-exhigh.flac");
        next.actual_quality = Some(crate::online::quality::Quality::Exhigh);
        *state.prepared_playback.lock().await = Some(next.clone());
        assert!(state
            .protected_all()
            .await
            .contains(&"netease-second-exhigh.flac".into()));
        state
            .audio
            .load("cached.flac", Some(id.clone()))
            .await
            .unwrap();
        assert!(state
            .commit_prepared_transition(
                next.actor_generation,
                state.audio.snapshot().generation,
                &id
            )
            .await
            .is_some());
        let committed = state.committed_quality.lock().await;
        assert_eq!(committed.as_ref().unwrap().actual, next.actual_quality);
        assert_eq!(
            committed.as_ref().unwrap().cached_path.as_ref(),
            Some(&next.path)
        );
        drop(committed);
        state.audio.play().await.unwrap();
        state.play_generation.fetch_add(1, Ordering::Relaxed);
        state.transport_committed().await;
        let committed = state
            .take_failed_quality(&id, state.audio.snapshot().generation)
            .await
            .unwrap();
        assert_eq!(committed.actual, next.actual_quality);
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn shuffle_preparation_and_cancelled_reservations_do_not_move_the_queue() {
        let (state, handle) = playback_state().await;
        transition_fixture(&state, "second").await;
        state.cancel_prepared_playback().await;
        state.audio.set_mode(PlayMode::Shuffle).await.unwrap();
        state.prepare_next_playback().await;
        assert!(state.prepared_playback.lock().await.is_none());
        assert_eq!(state.current_index().await, Some(0));
        assert_eq!(state.audio.snapshot().track_id.as_deref(), Some("first"));
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

    #[tokio::test]
    async fn relay_cannot_replace_a_virtual_id_already_owned_by_another_slot() {
        let (state, handle) = playback_state().await;
        let old = "online:netease:n1";
        let target = "online:qq:t1";
        let (gen, _, _) = state
            .set_queue(vec![old.into(), target.into()], Some(0))
            .await;
        state
            .remember_online_meta(old.into(), online_snap(None, None))
            .await;
        state
            .remember_online_meta(target.into(), online_snap(None, None))
            .await;
        let candidate = relay_track("song", "artist", 1000);
        assert!(state
            .commit_relay_target(gen, 0, old, &candidate)
            .await
            .is_none());
        assert_eq!(*state.queue.lock().await, vec![old, target]);
        let (origin, relayed) = state.online_origin(target).await.unwrap();
        assert_eq!(origin.source, "qq");
        assert!(!relayed);
        let page = crate::online::SearchPage {
            source: "qq".into(),
            keyword: String::new(),
            total: 1,
            tracks: vec![candidate],
            warning: None,
        };
        let mut meta = online_snap(None, None);
        meta.title = "song".into();
        meta.artist = Some("artist".into());
        assert!(pick_relay_candidate(
            &[page],
            &RelayMemory::default(),
            "netease",
            &meta,
            &[target.into()]
        )
        .is_none());
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn transition_then_immediate_decode_failure_keeps_successor_evidence() {
        let (state, handle) = playback_state().await;
        let id = crate::online::virtual_id("netease", "second");
        let mut next = transition_fixture(&state, &id).await;
        next.actual_quality = Some(crate::online::quality::Quality::Exhigh);
        *state.prepared_playback.lock().await = Some(next.clone());
        // A successful load without a track id creates exactly the snapshot
        // published by transition + immediate decoder failure: next generation,
        // stopped and no current id. Transitioned still precedes DecodeError.
        state.audio.load("second.wav", None).await.unwrap();
        let generation = state.audio.snapshot().generation;
        assert!(state
            .commit_prepared_transition(next.actor_generation, generation, &id)
            .await
            .is_some());
        assert_eq!(state.current_index().await, Some(1));
        let failure = state
            .take_failed_quality(&id, generation)
            .await
            .expect("DecodeError must receive successor evidence, not be discarded as stale");
        assert_eq!(
            failure.actual,
            Some(crate::online::quality::Quality::Exhigh)
        );
        assert!(state.take_failed_quality(&id, generation).await.is_none());
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn relay_of_one_repeated_id_preserves_the_other_slots_snapshot() {
        let (state, handle) = playback_state().await;
        let old = "online:netease:n1";
        let (gen, _, _) = state.set_queue(vec![old.into(), old.into()], Some(0)).await;
        state
            .remember_online_meta(old.into(), online_snap(Some(2.0), None))
            .await;
        let origin = state
            .commit_relay_target(gen, 0, old, &relay_track("song", "artist", 1000))
            .await
            .unwrap();
        assert_eq!(origin.source, "netease");
        assert_eq!(origin.id, "n1");
        assert_eq!(*state.queue.lock().await, vec!["online:qq:t1", old]);
        let map = state.online_meta.lock().await;
        assert_eq!(map.get(old).unwrap().rg_gain_db, Some(2.0));
        assert!(map.get(old).unwrap().origin.is_none());
        assert!(map.get("online:qq:t1").unwrap().rg_gain_db.is_none());
        state.audio.shutdown();
        handle.join().unwrap();
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
    fn relay_memory_collapses_the_same_identity_on_one_source() {
        // 身份键：同一首歌的不同写法（标点、空白、分隔符、歌手顺序）归到同一个键。
        assert_eq!(
            relay_identity("稻香", Some("周杰伦")),
            relay_identity(" 稻 香！", Some("周杰伦")),
            "标题的空白与标点不该造出第二个键"
        );
        assert_eq!(
            relay_identity("稻香", Some("A、B")),
            relay_identity("稻香", Some("B&A")),
            "歌手按集合排序，顺序不该造出第二个键"
        );
        assert_ne!(
            relay_identity("稻香", Some("周杰伦")),
            relay_identity("稻香", Some("其它人")),
            "同名不同人不是同一首，不许被去重误伤"
        );
        assert_ne!(
            relay_identity("稻香", Some("周杰伦")),
            relay_identity("稻香", Some("Jay Chou")),
            "跨语种写法归不到一起是已知边界：同一首仍可能被两家各试一次，\
             但绝不会在同一家被重复试"
        );

        // 记忆本身：同一身份在同一平台只登记一次，换平台仍是新键。
        let mut mem = RelayMemory::default();
        let key = |src: &str| format!("{}|{}", relay_identity("稻香", Some("周杰伦")), src);
        mem.note("netease:1", Some(key("netease")));
        mem.note("netease:1", Some(key("netease")));
        assert_eq!(mem.ids.len(), 1, "重复登记不涨表");
        assert_eq!(mem.providers.len(), 1, "同身份同平台只算一次尝试");
        assert!(mem.holds_provider(&key("netease")));
        assert!(
            !mem.holds_provider(&key("qq")),
            "换一家音源必须是新的尝试机会"
        );
        mem.note("netease:2", Some(key("netease")));
        assert_eq!(
            mem.providers.len(),
            1,
            "同平台换个 id 的同名条目也不增加机会"
        );
        assert_eq!(mem.ids.len(), 2, "id 那一份仍然逐条记着，防原地回头");

        // 拿不到身份时只记 id，不许把空键当成「什么都试过」。
        let mut bare = RelayMemory::default();
        bare.note("qq:9", None);
        assert_eq!(bare.providers.len(), 0);
        assert!(bare.holds_id("qq:9"));

        let mut capped = RelayMemory::default();
        for i in 0..(RELAY_TRIED_CAP + 5) {
            capped.note(&format!("qq:{i}"), Some(format!("k{i}")));
        }
        assert!(
            capped.providers.len() <= RELAY_TRIED_CAP && capped.ids.len() <= RELAY_TRIED_CAP,
            "两张表都受上限约束"
        );
        capped.clear();
        assert!(
            capped.ids.is_empty() && capped.providers.is_empty(),
            "清空一起清"
        );
    }

    /// 接力候选的去重语义（A5）：同一首歌**换一家音源**仍算一次机会，在**同一家**
    /// 换个 id 不算第二次。这条不钉住的话，记忆就退化成「按 id 记仇」——同一平台
    /// 把同一首歌以另一个 id 再列一遍（重编码、翻唱条目）会被当成全新候选，
    /// 每轮白等数秒取流。
    #[test]
    fn relay_candidates_dedup_by_identity_per_source() {
        fn track(source: &str, id: &str, title: &str, artist: &str) -> crate::online::OnlineTrack {
            crate::online::OnlineTrack {
                source: source.into(),
                id: id.into(),
                title: title.into(),
                artist: artist.into(),
                album: String::new(),
                duration_ms: 225_000,
                cover: None,
                playable: true,
                vip_only: false,
                track_ref: serde_json::Value::Null,
            }
        }
        fn page(
            source: &str,
            tracks: Vec<crate::online::OnlineTrack>,
        ) -> crate::online::SearchPage {
            crate::online::SearchPage {
                source: source.into(),
                keyword: "稻香".into(),
                total: tracks.len(),
                tracks,
                warning: None,
            }
        }
        let meta = OnlineMetaSnap {
            title: "稻香".into(),
            artist: Some("周杰伦".into()),
            album: None,
            cover: None,
            duration_ms: Some(225_000),
            rg_gain_db: None,
            rg_peak: None,
            origin: None,
        };
        // 结果顺序：qq 排在前，且它家有两份同名条目 —— 这样「是否按身份去重」
        // 会直接改变选中的是哪一家，断言才不会变成空测。
        let pages = vec![
            page(
                "qq",
                vec![
                    track("qq", "q1", "稻香", "周杰伦"),
                    // 同一家把同一首歌以另一个 id 再列一遍。
                    track("qq", "q2", "稻 香", "周杰伦"),
                ],
            ),
            page("netease", vec![track("netease", "n1", "稻香", "周杰伦")]),
        ];
        let qq_identity = relay_identity("稻香", Some("周杰伦"));

        // 干净记忆：分数相同取先出现的那条（结果顺序确定，接力才可复现）。
        let mem = RelayMemory::default();
        let hit = pick_relay_candidate(&pages, &mem, "kugou", &meta, &[]).expect("应有可用候选");
        assert_eq!((hit.1.source.as_str(), hit.1.id.as_str()), ("qq", "q1"));

        // 这一家已经试过这首歌：两份同名条目都不算第二次机会，必须落到另一家。
        let mut tried = RelayMemory::default();
        tried.note(
            &crate::online::virtual_id("qq", "q1"),
            Some(format!("{qq_identity}|qq")),
        );
        let hit = pick_relay_candidate(&pages, &tried, "kugou", &meta, &[]).expect("换家仍有机会");
        assert_eq!(
            hit.1.source, "netease",
            "同平台换个 id 的同名条目不算第二次机会"
        );

        // 只按 id 记仇挡不住这件事：这正是身份键存在的理由（记下它，别退回 id-only）。
        let mut id_only = RelayMemory::default();
        id_only.note(&crate::online::virtual_id("qq", "q1"), None);
        let hit = pick_relay_candidate(&pages, &id_only, "kugou", &meta, &[]).expect("仍有候选");
        assert_eq!(
            (hit.1.source.as_str(), hit.1.id.as_str()),
            ("qq", "q2"),
            "只挡 id 时，同一家另一份同名条目会被当成新机会"
        );

        // 失败源本身永远排除（防搜回来还是同一家）。
        let hit =
            pick_relay_candidate(&pages, &mem, "qq", &meta, &[]).expect("排除 qq 后仍有 netease");
        assert_eq!(hit.1.source, "netease");
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

    /// 音质上限只由「这一档给不出来」类失败产生。账号级与网络级必须留在门外：
    /// 前者的 owner 是登录流程（记进来会让整批 VIP 曲在一次未登录尝试后被永久
    /// 压低），后者换档救不了网络（一次抖动记成永久上限是白丢音质）。
    #[test]
    fn ceiling_eligible_keeps_account_and_network_out() {
        for code in ["vip_required", "decode_stalled"] {
            assert!(
                AppState::ceiling_eligible(code),
                "{code} should lower the tier"
            );
        }
        for code in [
            "auth_required",
            "not_found",
            "upstream_timeout",
            "upstream_rejected",
            "upstream_error",
            "internal",
            "bad_request",
            "capability_unsupported",
        ] {
            assert!(
                !AppState::ceiling_eligible(code),
                "{code} is not evidence of a bad quality tier"
            );
        }
    }

    /// B4 的验收：降一格、看得见、且不会又弹回高档。
    #[tokio::test]
    async fn quality_ceiling_drops_one_rung_and_never_bounces_back() {
        use crate::online::quality::Quality;
        let (state, _handle) = playback_state().await;
        let mut rx = state.events.subscribe();
        state
            .quality
            .lock()
            .await
            .insert("netease".to_string(), Quality::Hires);
        let vid = crate::online::virtual_id("netease", "n1");
        let other = crate::online::virtual_id("netease", "n2");

        assert_eq!(
            state.online_quality_for("netease", &vid).await,
            Quality::Hires
        );

        state
            .note_quality_failure(&vid, "vip_required", Quality::Hires)
            .await;
        assert_eq!(
            state.online_quality_for("netease", &vid).await,
            Quality::Lossless,
            "一次失败只该让这首退一格"
        );
        // 用户必须看得见：措辞带上从高到低两档，且标题不是空串。
        match rx.try_recv().expect("降档应当发一条提示") {
            WsEvent::QualityDowngraded {
                title,
                from_label,
                to_label,
                track_id,
                ..
            } => {
                assert_eq!(track_id, vid);
                assert_eq!(from_label, "Hi-Res");
                assert_eq!(to_label, "无损");
                assert!(!title.is_empty(), "提示得说清是哪首歌");
            }
            other => panic!("应当发 QualityDowngraded，收到 {other:?}"),
        }

        // 在被夹住的那一档上又失败一次：再退一格，并且再说一次——用户看得见
        // 音质在一格格往下掉，而不是听到一首越听越糊的歌。
        state
            .note_quality_failure(&vid, "decode_stalled", Quality::Lossless)
            .await;
        assert_eq!(
            state.online_quality_for("netease", &vid).await,
            Quality::Exhigh,
            "在无损上再失败一次应当退到 320k"
        );
        assert!(
            matches!(rx.try_recv(), Ok(WsEvent::QualityDowngraded { .. })),
            "每退一格都要提示一次"
        );

        // 账号级/网络级失败不改判这首；一首的失败也不牵连同源隔壁那首。
        state
            .note_quality_failure(&other, "auth_required", Quality::Hires)
            .await;
        state
            .note_quality_failure(&vid, "upstream_timeout", Quality::Exhigh)
            .await;
        assert_eq!(
            state.online_quality_for("netease", &other).await,
            Quality::Hires,
            "另一首没失败过，不该被一起压低"
        );
        assert_eq!(
            state.online_quality_for("netease", &vid).await,
            Quality::Exhigh,
            "一次网络抖动不该让它再掉一格"
        );

        // 逐级退到最低档后停住：下面没有档可退，也不许清空上限重撞高档。
        state
            .note_quality_failure(&vid, "decode_stalled", Quality::Exhigh)
            .await;
        assert_eq!(
            state.online_quality_for("netease", &vid).await,
            Quality::Standard
        );
        assert!(matches!(
            rx.try_recv(),
            Ok(WsEvent::QualityDowngraded { .. })
        ));
        state
            .note_quality_failure(&vid, "decode_stalled", Quality::Standard)
            .await;
        assert_eq!(
            state.online_quality_for("netease", &vid).await,
            Quality::Standard,
            "最低档之下没有可降的档"
        );
        assert!(
            rx.try_recv().is_err(),
            "上限没动就不该再提示，否则每次重试都多一条假降档"
        );

        // 用户把偏好调回高档也不构成「弹回」：上限只往下夹。
        state
            .quality
            .lock()
            .await
            .insert("netease".to_string(), Quality::Hires);
        assert_eq!(
            state.online_quality_for("netease", &vid).await,
            Quality::Standard,
            "改偏好不是这首能放高档的证据"
        );
    }

    /// 上限表按曲目而不是按音源记：同一平台上无损对这首失败、对隔壁那首成功，
    /// 按源记会把好曲子一起拖低。
    #[tokio::test]
    async fn quality_ceiling_is_keyed_per_track() {
        use crate::online::quality::Quality;
        let (state, _handle) = playback_state().await;
        state
            .quality
            .lock()
            .await
            .insert("netease".to_string(), Quality::Hires);
        state
            .note_quality_failure(
                &crate::online::virtual_id("netease", "a"),
                "decode_stalled",
                Quality::Hires,
            )
            .await;
        assert_eq!(
            state
                .online_quality_for("netease", &crate::online::virtual_id("netease", "b"))
                .await,
            Quality::Hires
        );
        // 接力换源后的同一首歌挂在另一个源名下，旧源的上限不跟着它：qq 的默认档
        // 是无损，若 netease 的记录串过去它会掉到高品 320k。
        assert_eq!(
            state
                .online_quality_for("qq", &crate::online::virtual_id("qq", "a"))
                .await,
            Quality::Lossless
        );
    }

    /// 出处与供音分开（借鉴清单 §8 F3）：换源之后「用户当初点的哪家」必须还查
    /// 得到，而且多跳接力记的仍是第一家。
    #[test]
    fn origin_survives_the_relay_chain_and_names_the_first_source() {
        let mut snap = online_snap(None, None);
        assert!(!snap.relayed("netease"), "没换过源不算换源");
        assert_eq!(
            snap.origin_of("netease", "n1"),
            ("netease".to_string(), "n1".to_string(), None),
            "没有出处记录时，出处就是这一项自己"
        );

        snap.ensure_origin("netease", "n1", Some("网易云音乐".into()));
        assert!(snap.relayed("qq"), "换到 QQ 供音之后，出处不再是当前家");
        assert!(!snap.relayed("netease"), "回到出处那一家就不算换源");

        // 第二跳：出处不许跟着挪到 qq —— 用户点的从来是第一家。
        snap.ensure_origin("qq", "q9", Some("QQ 音乐".into()));
        let (source, id, label) = snap.origin_of("kugou", "k3");
        assert_eq!((source.as_str(), id.as_str()), ("netease", "n1"));
        assert_eq!(label.as_deref(), Some("网易云音乐"));
    }

    /// 出处由队列快照回答（两个播放门面共用同一个入口）。
    #[tokio::test]
    async fn online_origin_answers_from_the_queue_snapshot() {
        let (state, _handle) = playback_state().await;
        let relayed_vid = crate::online::virtual_id("qq", "q9");
        let mut snap = online_snap(None, None);
        snap.ensure_origin("netease", "n1", Some("网易云音乐".into()));
        state.remember_online_meta(relayed_vid.clone(), snap).await;
        let (origin, relayed) = state.online_origin(&relayed_vid).await.expect("有快照");
        assert_eq!(
            (origin.source.as_str(), origin.id.as_str()),
            ("netease", "n1"),
            "换过源的那一项要答出最初那一家"
        );
        assert!(relayed);

        // 没换过源的曲子：出处就是它自己，且不许报成换过。
        let own = crate::online::virtual_id("netease", "n7");
        state
            .remember_online_meta(own.clone(), online_snap(None, None))
            .await;
        let (origin2, relayed2) = state.online_origin(&own).await.unwrap();
        assert_eq!(
            (origin2.source.as_str(), origin2.id.as_str()),
            ("netease", "n7")
        );
        assert!(!relayed2);

        // 再记一次（没带 origin，例如刷新后的注入）也不许把已知的出处忘掉。
        state
            .remember_online_meta(relayed_vid.clone(), online_snap(None, None))
            .await;
        let (origin3, _) = state.online_origin(&relayed_vid).await.unwrap();
        assert_eq!(origin3.source, "netease", "普通的重新入队不该抹掉出处");

        assert!(
            state.online_origin("nope").await.is_none(),
            "没快照就返回 None"
        );
        // 本地曲的 id 不是虚拟 id：同样 None，不许猜成「某家的某首」。
        assert!(state.online_origin("file:/music/a.flac").await.is_none());
    }

    /// 旧客户端的 /player/load 请求体里没有 `origin` 字段，必须照常接受。
    #[test]
    fn snap_without_origin_field_still_deserializes() {
        let v = serde_json::json!({
            "title": "稻香", "artist": null, "album": null, "cover": null,
            "duration_ms": 225000, "rg_gain_db": null, "rg_peak": null,
        });
        let snap: OnlineMetaSnap = serde_json::from_value(v).unwrap();
        assert!(snap.origin.is_none());
        assert!(!snap.relayed("netease"));
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
                    origin: None,
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
    fn stream_info_for_test() -> crate::online::StreamInfo {
        crate::online::StreamInfo {
            url: "https://example.invalid/audio".into(),
            source: "netease".into(),
            id: "test".into(),
            bitrate: Some(320_000),
            expires_in_secs: None,
            fallbacks: vec![],
            rg_gain_db: None,
            rg_peak: None,
        }
    }

    #[tokio::test]
    async fn stream_retry_succeeds_at_the_lower_tier_in_the_same_attempt() {
        use crate::online::quality::Quality;
        let (state, handle) = playback_state().await;
        let vid = "online:netease:test";
        let (gen, _, _) = state.set_queue(vec![vid.into()], Some(0)).await;
        let mut events = state.events.subscribe();
        let mut attempts = Vec::new();
        let result = state
            .resolve_online_stream(
                gen,
                0,
                vid,
                "netease",
                Quality::Hires,
                std::time::Duration::from_secs(1),
                |quality| {
                    attempts.push(quality);
                    std::future::ready(if attempts.len() == 1 {
                        Err(crate::error::ApiError::vip_required("tier unavailable"))
                    } else {
                        Ok(stream_info_for_test())
                    })
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(attempts, vec![Quality::Hires, Quality::Lossless]);
        assert_eq!(result.1, Quality::Lossless);
        assert_eq!(
            state.quality_caps.lock().await.get(vid).copied(),
            Some(Quality::Lossless)
        );
        assert!(matches!(
            events.try_recv(),
            Ok(WsEvent::QualityDowngraded { .. })
        ));
        assert!(events.try_recv().is_err());
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn final_stream_failure_is_not_charged_as_an_unattempted_third_tier() {
        use crate::online::quality::Quality;
        let (state, handle) = playback_state().await;
        let vid = "online:netease:test";
        let (gen, _, _) = state.set_queue(vec![vid.into()], Some(0)).await;
        let mut attempts = 0;
        let result = state
            .resolve_online_stream(
                gen,
                0,
                vid,
                "netease",
                Quality::Hires,
                std::time::Duration::from_secs(1),
                |_| {
                    attempts += 1;
                    std::future::ready(Err(crate::error::ApiError::vip_required("unavailable")))
                },
            )
            .await;
        assert!(result.is_err());
        assert_eq!(attempts, 2);
        assert_eq!(
            state.quality_caps.lock().await.get(vid).copied(),
            Some(Quality::Exhigh)
        );
        state
            .note_quality_failure(vid, "vip_required", Quality::Lossless)
            .await;
        assert_eq!(
            state.quality_caps.lock().await.get(vid).copied(),
            Some(Quality::Exhigh)
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn late_stream_failure_does_not_change_caps_or_new_buffering() {
        use crate::online::quality::Quality;
        let (state, handle) = playback_state().await;
        let vid = "online:netease:test";
        let (gen, _, _) = state.set_queue(vec![vid.into()], Some(0)).await;
        let mut events = state.events.subscribe();
        let result = state
            .resolve_online_stream(
                gen,
                0,
                vid,
                "netease",
                Quality::Hires,
                std::time::Duration::from_secs(1),
                |_| async {
                    state.set_queue(vec!["new-choice".into()], Some(0)).await;
                    state.set_buffering(true, Some(75)).await;
                    Err(crate::error::ApiError::vip_required("old failed"))
                },
            )
            .await
            .unwrap();
        assert!(result.is_none());
        assert!(state.quality_caps.lock().await.get(vid).is_none());
        assert_eq!(*state.buffering.lock().await, (true, Some(75)));
        while let Ok(event) = events.try_recv() {
            assert!(!matches!(event, WsEvent::QualityDowngraded { .. }));
        }
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn stream_retry_uses_one_total_deadline() {
        use crate::online::quality::Quality;
        let (state, handle) = playback_state().await;
        let vid = "online:netease:test";
        let (gen, _, _) = state.set_queue(vec![vid.into()], Some(0)).await;
        let mut attempts = 0;
        let result = state
            .resolve_online_stream(
                gen,
                0,
                vid,
                "netease",
                Quality::Hires,
                std::time::Duration::from_millis(180),
                |_| {
                    attempts += 1;
                    async {
                        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                        Err(crate::error::ApiError::vip_required("unavailable"))
                    }
                },
            )
            .await;
        // Separate 180 ms timeouts would let both 120 ms attempts fail with vip_required.
        assert_eq!(result.unwrap_err().code, "upstream_timeout");
        assert_eq!(attempts, 2);
        assert_eq!(
            state.quality_caps.lock().await.get(vid).copied(),
            Some(Quality::Lossless),
            "timeout is not quality evidence"
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn transport_rejection_neither_retries_nor_lowers_quality() {
        use crate::online::quality::Quality;
        let (state, handle) = playback_state().await;
        let vid = "online:netease:test";
        let (gen, _, _) = state.set_queue(vec![vid.into()], Some(0)).await;
        let mut attempts = 0;
        let result = state
            .resolve_online_stream(
                gen,
                0,
                vid,
                "netease",
                Quality::Hires,
                std::time::Duration::from_secs(1),
                |_| {
                    attempts += 1;
                    std::future::ready(Err(crate::error::ApiError::upstream_rejected(
                        "rate limited",
                    )))
                },
            )
            .await;
        assert_eq!(result.unwrap_err().code, "upstream_rejected");
        assert_eq!(attempts, 1);
        assert!(state.quality_caps.lock().await.get(vid).is_none());
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn cached_commit_keeps_actual_quality_despite_preference_changes() {
        use crate::online::quality::Quality;
        let (state, handle) = playback_state().await;
        let vid = "online:netease:test";
        let (gen, _, _) = state.set_queue(vec![vid.into()], Some(0)).await;
        assert!(matches!(
            state
                .try_commit_cached(gen, 0, vid, Path::new("mock.wav"), Some(Quality::Exhigh))
                .await
                .unwrap(),
            Commit::Done(_)
        ));
        state
            .quality
            .lock()
            .await
            .insert("netease".into(), Quality::Hires);
        let committed = state.committed_quality.lock().await;
        let committed = committed.as_ref().unwrap();
        assert_eq!(committed.actual, Some(Quality::Exhigh));
        assert_eq!(
            committed.actor_generation,
            state.audio.snapshot().generation
        );
        state
            .note_quality_failure(vid, "decode_stalled", committed.actual.unwrap())
            .await;
        assert_eq!(
            state.quality_caps.lock().await.get(vid).copied(),
            Some(Quality::Standard)
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn committed_quality_failure_is_consumed_once_and_rejects_a_new_attempt() {
        use crate::online::quality::Quality;
        let (state, handle) = playback_state().await;
        let vid = "online:netease:test";
        let (gen, _, _) = state.set_queue(vec![vid.into()], Some(0)).await;
        state
            .try_commit_cached(gen, 0, vid, Path::new("mock.wav"), Some(Quality::Exhigh))
            .await
            .unwrap();
        let actor_gen = state.audio.snapshot().generation;
        assert!(state.take_failed_quality(vid, actor_gen).await.is_some());
        assert!(state.take_failed_quality(vid, actor_gen).await.is_none());
        state
            .remember_committed_quality(gen, vid, Some(Quality::Exhigh), None)
            .await;
        // A new same-track intent exists but has not loaded its actor bytes yet.
        state.set_queue(vec![vid.into()], Some(0)).await;
        assert!(state.take_failed_quality(vid, actor_gen).await.is_none());
        state.audio.shutdown();
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn failed_tier_is_not_recomputed_from_preferences_changed_in_flight() {
        use crate::online::quality::Quality;
        let (state, handle) = playback_state().await;
        let vid = "online:netease:test";
        let (gen, _, _) = state.set_queue(vec![vid.into()], Some(0)).await;
        let mut events = state.events.subscribe();
        let mut attempts = 0;
        state
            .resolve_online_stream(
                gen,
                0,
                vid,
                "netease",
                Quality::Hires,
                std::time::Duration::from_secs(1),
                |_| {
                    attempts += 1;
                    let first = attempts == 1;
                    let state = &state;
                    async move {
                        if first {
                            state
                                .quality
                                .lock()
                                .await
                                .insert("netease".into(), Quality::Exhigh);
                            Err(crate::error::ApiError::vip_required("hi-res unavailable"))
                        } else {
                            Ok(stream_info_for_test())
                        }
                    }
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            state.quality_caps.lock().await.get(vid).copied(),
            Some(Quality::Lossless)
        );
        assert!(
            matches!(events.try_recv(), Ok(WsEvent::QualityDowngraded { from_label, .. }) if from_label == "Hi-Res")
        );
        state.audio.shutdown();
        handle.join().unwrap();
    }

    fn online_snap(rg_gain_db: Option<f64>, rg_peak: Option<f64>) -> OnlineMetaSnap {
        OnlineMetaSnap {
            title: "t".into(),
            artist: None,
            album: None,
            cover: None,
            duration_ms: None,
            rg_gain_db,
            rg_peak,
            origin: None,
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
