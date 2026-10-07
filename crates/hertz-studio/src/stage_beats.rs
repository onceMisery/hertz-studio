// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 节拍地图缓存与后台调度：data/stage-beats/<sha1>.json + 进程内幂等任务表。
//!
//! 两个触发源（播放提交 detach、GET 兜底）共用同一张表，同一缓存键全局只有
//! 一个分析任务；分析跑在 spawn_blocking，不随切歌取消。三条纪律：
//!
//!   1. **总并发预算**（[`crate::state::BEAT_ANALYZE_BUDGET`]）：一首的 FFT 是
//!      几秒的满核运算，抢的是正在解码那首歌的 CPU。连切 20 首时提交路径只把
//!      前两三首真的跑起来，其余当场推迟，不排队堆积。
//!   2. **尝试上限**（[`crate::state::BEAT_ATTEMPTS_MAX`]）：一首最多试三次就
//!      放弃到进程结束，别每次播放都重算。
//!   3. **「就绪」与「已持久化」是两种状态**：落盘失败不叫失败。算出来的地图
//!      进有界的内存表（[`crate::state::BEAT_VOLATILE_CAP`]）继续服务，事件与
//!      响应都如实标出没写进去。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha1::{Digest, Sha1};

use vmusic_beats::{Beat, BeatMap};

use crate::state::{AppState, BoundedMap, WsEvent};

/// 幂等表里一格的状态。
#[derive(Debug, Clone)]
pub(crate) enum TaskState {
    /// 正在算。`attempts` = **含本次在内**已经试过几次：重试要接着数，否则每次
    /// 都从 0 起，「最多三次」这条上限永远碰不到，一首真放不出节拍图的曲子就会
    /// 每次播放都重算几秒满核 FFT。
    Analyzing { attempts: u8 },
    /// 缓存命中后记录地图文件路径，目前仅作排障信息保留：所有读取（含
    /// GET 侧）都按 key 重算路径、不读本字段，故保留 allow(dead_code)。
    #[allow(dead_code)]
    Ready(PathBuf),
    /// 分析出来了，但**没能写进磁盘**（只读数据目录、盘满、权限）。地图留在
    /// [`AppState::beat_volatile`] 里，这轮播放用得上。它刻意不是 `Failed`：
    /// 把「算出来存不住」报成「算不出来」，用户和开发者都会去查错的东西。
    NotPersisted,
    /// 试过且没成；`attempts` 记着试到第几次才放弃。
    Failed { reason: Reason, attempts: u8 },
}

/// 谁在要这张地图。两条路的耐心不一样，混成一条会出现「界面正等节拍图，被后台
/// 顺手预热挤掉」或反过来（连切歌时堆一串他早就跳走的曲子）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Caller {
    /// 播放提交后的顺手预热：拿不到并发额度就推迟，失败过的曲子允许再试。
    Commit,
    /// 界面（GET / RPC）在等它：可以等一手额度，但不许在本首播放期内反复重算。
    Demand,
}

/// GET 侧最多等一个并发额度等多久。等不到就报 `analyzing`：前端本来就有这套
/// 等待态（`stage-cinema.js` 收到 202 保持 waiting，完成事件会再来取）。
const BEAT_PERMIT_WAIT: std::time::Duration = std::time::Duration::from_secs(4);

/// 404 reason（tier0 由客户端自行兜底，服务端保留枚举以对齐协议）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reason {
    /// tier0 由客户端按性能档位自行回落，服务端保留枚举对齐 404 reason 协议。
    #[allow(dead_code)]
    Tier0,
    Failed,
    Unsupported,
    NotReady,
}

impl Reason {
    /// 404 响应体中的 reason 字符串。
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Reason::Tier0 => "tier0",
            Reason::Failed => "failed",
            Reason::Unsupported => "unsupported",
            Reason::NotReady => "not_ready",
        }
    }
}

/// 请求结果：Ready 携带地图与「这份在磁盘上吗」。
pub(crate) enum Outcome {
    /// 200 响应。`persisted=false` 是另一种状态而不是失败：地图算出来了、这轮
    /// 能用，只是没能写进磁盘缓存（响应体里仍叫 `cached`，字段名不变）。
    Ready {
        map: std::sync::Arc<BeatMap>,
        persisted: bool,
    },
    Analyzing,
    /// 404 不可用及原因。
    Unavailable(Reason),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Spawn,
    Wait,
    Fail(Reason),
}

/// 磁盘缓存格式的版本。与拍表本身的 MAP_VERSION 是两回事：这一层管的是
/// **信封**怎么编码。v1 是逐拍整对象 JSON（一首 829 拍约 53KB）；v2 把拍表
/// 换成紧凑二进制（delta varint + 量化 strength + 标志字节，约 5KB），标量
/// 字段仍是 JSON、人可读。读到低版本信封一律当未命中——分析是纯后台活，
/// 重算比写两套解码便宜，也不用给 v1 留迁移代码。
const CACHE_FORMAT_VERSION: u32 = 2;

#[derive(serde::Serialize, serde::Deserialize)]
struct CachedMap {
    version: u32,
    bpm: Option<f64>,
    offset_ms: i64,
    truncated: bool,
    /// 紧凑拍表（[`pack_beats`] 的输出，base64 标准字母表）。v1 的 `beats`
    /// 数组字段已删：旧文件 version=1，被上面的闸门直接判未命中。
    #[serde(default)]
    beats_bin: String,
    source_mtime_ms: i64,
    source_len: u64,
}

/// LEB128 varint：拍间隔（毫秒）绝大多数落在一两个字节。
fn write_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn read_varint(bytes: &[u8], i: usize) -> Option<(u64, usize)> {
    let mut v = 0u64;
    let mut shift = 0u32;
    let mut i = i;
    loop {
        let b = *bytes.get(i)?;
        i += 1;
        // The tenth byte has only one payload bit left in a u64.
        if shift == 63 && b > 1 {
            return None;
        }
        v |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Some((v, i));
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

/// 每拍 3 字节左右：varint 的 t 间隔 + u8 量化强度 + 标志字节
/// （bit0 = downbeat，bit1-2 = intensity）。t 的全表严格递增是
/// [`vmusic_beats`] 的契约，delta 因此恒为正、无符号编码无损。
fn pack_beats(beats: &[Beat]) -> Vec<u8> {
    let mut out = Vec::with_capacity(beats.len() * 4);
    let mut prev_t = 0i64;
    for b in beats {
        write_varint(&mut out, (b.t - prev_t).max(0) as u64);
        out.push((b.strength.clamp(0.0, 1.0) * 255.0).round() as u8);
        out.push((b.downbeat as u8) | (b.intensity.min(3) << 1));
        prev_t = b.t;
    }
    out
}

fn unpack_beats(bytes: &[u8]) -> Option<Vec<Beat>> {
    let mut out = Vec::new();
    let mut prev_t = 0i64;
    let mut i = 0usize;
    while i < bytes.len() {
        let (delta, next) = read_varint(bytes, i)?;
        i = next;
        let strength = *bytes.get(i)? as f32 / 255.0;
        i += 1;
        let flags = *bytes.get(i)?;
        i += 1;
        if flags & !7 != 0 || (delta == 0 && !out.is_empty()) {
            return None;
        }
        prev_t = prev_t.checked_add(i64::try_from(delta).ok()?)?;
        out.push(Beat {
            t: prev_t,
            strength,
            downbeat: flags & 1 != 0,
            intensity: (flags >> 1) & 3,
        });
    }
    Some(out)
}

struct AudioRef {
    path: PathBuf,
    mtime_ms: i64,
    len: u64,
    key: String,
    /// 展示用曲名。缓存键是 sha1，人读不懂；状态面板要说清「在算的是哪一首」，
    /// 就得在已经知道标题的这里顺手留一份（不额外查库）。
    label: String,
}

/// 播放提交触发（on_track_committed）：机会主义，额度用满就推迟。
pub(crate) fn spawn_after_commit(state: Arc<AppState>, track_id: String) {
    tokio::spawn(async move {
        let _ = request(&state, &track_id, Caller::Commit).await;
    });
}

/// GET 触发：界面在等它，可以等一手额度；失败态在本曲目播放期内不重试。
pub(crate) async fn request_on_demand(state: &Arc<AppState>, track_id: &str) -> Outcome {
    request(state, track_id, Caller::Demand).await
}

/// 手动重试这一首：先忘掉它已有的结论（包括「试过三次已放弃」和内存里那份没落盘
/// 的图），再按「界面在等」的姿势跑一次。用户改了曲文件、或换了音质档位之后想要
/// 立刻重来，不该等他先把这首听完、更不要重启进程。
pub(crate) async fn retry(state: &Arc<AppState>, track_id: &str) -> Outcome {
    let Some(audio) = resolve_audio(state, track_id).await else {
        return Outcome::Unavailable(Reason::NotReady);
    };
    if !forget(state, &audio.key).await {
        return Outcome::Analyzing;
    }
    request(state, track_id, Caller::Demand).await
}

/// 忘掉这一首的既有结论：幂等表里那一格（含「已放弃三次」）与内存里那份没落盘
/// 的图。只动这一把键——清整张表会把别首正在算的任务也判成没人生。
async fn forget(state: &Arc<AppState>, key: &str) -> bool {
    let mut table = state.stage_beats.lock().await;
    // A running spawn_blocking cannot be cancelled. Preserve its reservation:
    // deleting it would let retry start a second FFT for the same cache key.
    if matches!(table.get(key), Some(TaskState::Analyzing { .. })) {
        return false;
    }
    table.remove(key);
    state.beat_volatile.lock().await.remove(key);
    true
}

/// 状态面板：把任务表按「后台现在在忙什么」数一遍，再列最近几条；带上 `track`
/// 时另外回答「这一首此刻是什么处境」。
///
/// 这块存在的理由是清单 §9 G7：后台任务的状态要**附着在任务上**，而不是只在完成
/// 那一刻闪一条 toast。「在算 / 已落盘 / 只在这轮内存里 / 已放弃」是四种不同的
/// 用户处境，混成「没有镜头」就没人能回答「再等等还是重来」。
pub(crate) async fn status(state: &Arc<AppState>, track: Option<&str>) -> serde_json::Value {
    let (analyzing, disk, memory, failed, recent) = {
        let labels = state.beat_labels.lock().await;
        let table = state.stage_beats.lock().await;
        let (mut analyzing, mut disk, mut memory, mut failed) = (0usize, 0usize, 0usize, 0usize);
        let mut recent: Vec<serde_json::Value> = Vec::new();
        for (key, task) in table.newest_first() {
            let (state_name, reason, attempts) = match task {
                TaskState::Analyzing { attempts } => {
                    analyzing += 1;
                    ("analyzing", None, *attempts)
                }
                TaskState::Ready(_) => {
                    disk += 1;
                    ("disk", None, 0)
                }
                TaskState::NotPersisted => {
                    memory += 1;
                    ("memory", None, 0)
                }
                TaskState::Failed { reason, attempts } => {
                    failed += 1;
                    ("failed", Some(reason.as_str()), *attempts)
                }
            };
            if recent.len() < crate::state::BEAT_STATUS_RECENT {
                recent.push(serde_json::json!({
                    "key": &key[..key.len().min(8)],
                    "label": labels.get(key),
                    "state": state_name,
                    "reason": reason,
                    "attempts": attempts,
                }));
            }
        }
        (analyzing, disk, memory, failed, recent)
    }; // 上面两把锁在这里放掉：下面查「这一首」要再拿同一批锁，重入即死锁。
    let current = match track.map(str::trim).filter(|s| !s.is_empty()) {
        Some(id) => match resolve_audio(state, id).await {
            Some(audio) => verdict(state, &audio).await,
            // 后台还不认识这段音频（没播过、也不在队里）——与「播过但算过三次
            // 放弃了」是两回事，别把前者说成后者。
            None => serde_json::json!({ "state": Reason::NotReady.as_str() }),
        },
        None => serde_json::Value::Null,
    };
    serde_json::json!({
        "analyzing": analyzing,
        "on_disk": disk,
        "memory_only": memory,
        "abandoned": failed,
        "tracked": analyzing + disk + memory + failed,
        "deferred": state.beat_deferrals.load(std::sync::atomic::Ordering::Relaxed),
        "budget": crate::state::BEAT_ANALYZE_BUDGET,
        "attempts_max": crate::state::BEAT_ATTEMPTS_MAX,
        "recent": recent,
        "current": current,
    })
}

/// 某一首此刻的处境。表里没它的格子时再去看盘和内存：进程重启过、或格子被更近
/// 的曲目挤掉，图其实还在——说「还没开始」会让人白等一次重试。
async fn verdict(state: &Arc<AppState>, audio: &AudioRef) -> serde_json::Value {
    let found = match state.stage_beats.lock().await.get(&audio.key) {
        Some(TaskState::Analyzing { attempts }) => Some(("analyzing", None, *attempts as u64)),
        Some(TaskState::Ready(_)) => Some(("disk", None, 0)),
        Some(TaskState::NotPersisted) => Some(("memory", None, 0)),
        Some(TaskState::Failed { reason, attempts }) => {
            Some(("failed", Some(reason.as_str()), *attempts as u64))
        }
        None => None,
    };
    let (state_name, reason, attempts) = match found {
        Some(v) => v,
        None => {
            let cache = state.stage_beats_dir().join(format!("{}.json", audio.key));
            // 校验走 `read_cache` 而不是「文件在不在」：曲文件换过一版之后盘上那份
            // 是过期的，说「已有图」会把人引去查错的东西。
            if read_cache(&cache, audio.mtime_ms, audio.len)
                .await
                .is_some()
            {
                ("disk", None, 0)
            } else if state.beat_volatile.lock().await.get(&audio.key).is_some() {
                ("memory", None, 0)
            } else {
                ("idle", None, 0)
            }
        }
    };
    serde_json::json!({
        "state": state_name,
        "reason": reason,
        "attempts": attempts,
        "label": audio.label,
    })
}

async fn request(state: &Arc<AppState>, track_id: &str, caller: Caller) -> Outcome {
    let Some(audio) = resolve_audio(state, track_id).await else {
        return Outcome::Unavailable(Reason::NotReady);
    };
    // 键 → 曲名留一份给状态面板：面板上只写 sha1 就等于没写。
    state
        .beat_labels
        .lock()
        .await
        .insert(audio.key.clone(), audio.label.clone());
    let cache_file = state.stage_beats_dir().join(format!("{}.json", audio.key));
    if let Some(map) = read_cache(&cache_file, audio.mtime_ms, audio.len).await {
        state
            .stage_beats
            .lock()
            .await
            .insert(audio.key.clone(), TaskState::Ready(cache_file.clone()));
        return Outcome::Ready {
            map: std::sync::Arc::new(map),
            persisted: true,
        };
    }
    // 「算出来但没落盘」的那份还在内存里：直接用它。既不重算一遍几秒的 FFT，
    // 也不许把它当失败报出去。
    if let Some(map) = state.beat_volatile.lock().await.get(&audio.key).cloned() {
        return Outcome::Ready {
            map,
            persisted: false,
        };
    }
    // 先拿额度再动表：顺序反了会在表里留下一格没人真的在算的 `Analyzing`，
    // 后来者一看就在等，而这个等永远不会有结果。
    let Some(permit) = acquire_permit(state, caller, BEAT_PERMIT_WAIT).await else {
        let by = match caller {
            Caller::Commit => "commit",
            Caller::Demand => "demand",
        };
        // 让路要**可数**：面板上「因额度满被推迟 N 次」是「为什么这首歌还没镜头」
        // 的第一个答案，只写日志等于没写。
        state
            .beat_deferrals
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        crate::diaglog!("beat.defer", track = track_id, by = by);
        return Outcome::Analyzing;
    };
    let action = {
        let mut table = state.stage_beats.lock().await;
        table_decide(
            &mut table,
            &audio.key,
            matches!(caller, Caller::Commit),
            crate::state::BEAT_ATTEMPTS_MAX,
        )
    };
    match action {
        // 没真的开跑就把额度还回去（permit 在此离开作用域）。
        Action::Wait => Outcome::Analyzing,
        Action::Fail(r) => Outcome::Unavailable(r),
        Action::Spawn => {
            spawn_blocking_analysis(state.clone(), track_id.to_string(), audio, permit);
            Outcome::Analyzing
        }
    }
}

/// 拿一个分析额度。Commit 用 `try`：拿不到就推迟，**不排队**——用户在连切歌时，
/// 队列里堆的全是他已经跳走的曲子，那些 FFT 抢的正是当前这首的 CPU。Demand 等
/// 最多 `permit_wait`，等不到就回 `analyzing`（前端有这一态）。等待时长做成参数
/// 是为了让「等得到」与「等不到都测得到」，不必让测试真等四秒。
async fn acquire_permit(
    state: &Arc<AppState>,
    caller: Caller,
    permit_wait: std::time::Duration,
) -> Option<tokio::sync::OwnedSemaphorePermit> {
    let slots = state.beat_slots.clone();
    match caller {
        Caller::Commit => slots.try_acquire_owned().ok(),
        Caller::Demand => tokio::time::timeout(permit_wait, slots.acquire_owned())
            .await
            .ok()
            .and_then(|got| got.ok()),
    }
}

/// 纯状态机：磁盘未命中后，幂等表如何决策。`Ready`/`NotPersisted` 在这里出现
/// 只可能是缓存文件被删、mtime 变了、或那份内存图已被淘汰（调用方已先查过磁盘
/// 与内存表），于是重开一次任务，尝试计数从头。
pub(crate) fn table_decide(
    table: &mut BoundedMap<TaskState>,
    key: &str,
    retry_failed: bool,
    attempts_max: u8,
) -> Action {
    let attempts = match table.get_mut(key) {
        None => 1,
        Some(TaskState::Analyzing { .. }) => return Action::Wait,
        Some(TaskState::Ready(_)) => 1,
        Some(TaskState::NotPersisted) => 1,
        Some(TaskState::Failed { reason, attempts }) => {
            let reason = *reason;
            if !retry_failed || *attempts >= attempts_max {
                return Action::Fail(reason);
            }
            *attempts + 1
        }
    };
    table.insert(key.to_string(), TaskState::Analyzing { attempts });
    Action::Spawn
}

async fn resolve_audio(state: &Arc<AppState>, track_id: &str) -> Option<AudioRef> {
    if let Some((source, id)) = crate::online::split_virtual_id(track_id) {
        // 在线曲：只认下载完成 rename 后的正式缓存（CacheIndex::find 跳过
        // .part 且要求 >1024 字节）。未完成不分析、不轮询、不挂 rename。
        // 档位走 online_quality_for：那首被运行时上限夹过，落盘的文件就挂在夹后
        // 的档位下，按原始偏好找会永远找不到、节拍分析静默不跑。
        let quality = state.online_quality_for(&source, track_id).await;
        let path = state
            .cache_index
            .find(&source, &id, quality.as_str())
            .await?;
        let key = online_cache_key(track_id);
        // 在线曲的标题只认入队快照（与接力匹配同一个来源），没有就退回平台 id。
        let label = state
            .online_meta
            .lock()
            .await
            .get(track_id)
            .map(|m| m.title.clone())
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| id.clone());
        audio_ref(path, key, label).await
    } else {
        let track = vmusic_store::get_track(&state.db, &track_id.to_string())
            .await
            .ok()
            .flatten()?;
        let path = PathBuf::from(&track.path);
        let key = local_cache_key(&path)?;
        let label = format!(
            "{} - {}",
            track.title,
            track
                .artist
                .clone()
                .unwrap_or_else(|| "未知艺术家".to_string())
        );
        audio_ref(path, key, label).await
    }
}

async fn audio_ref(path: PathBuf, key: String, label: String) -> Option<AudioRef> {
    let meta = tokio::fs::metadata(&path).await.ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some(AudioRef {
        path,
        mtime_ms,
        len: meta.len(),
        key,
        label,
    })
}

/// 本地曲键：sha1(规范化绝对路径)。walkdir 入库的路径已是绝对、无 . / ..，
/// 这里统一分隔符并去尾斜杠，保证同库同键。
pub(crate) fn local_cache_key(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let s = path.to_str()?.replace('\\', "/");
    let s = s.trim_end_matches('/').trim_end_matches('.');
    if s.is_empty() {
        None
    } else {
        Some(sha1_hex(s.as_bytes()))
    }
}

/// 在线曲键：sha1(虚拟 track_id 原文)。
pub(crate) fn online_cache_key(track_id: &str) -> String {
    sha1_hex(track_id.as_bytes())
}

fn sha1_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut s = String::with_capacity(40);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// 读缓存：格式版本不符 / mtime 或长度不一致 / 坏载荷 / 空拍表均视为未命中。
pub(crate) async fn read_cache(
    file: &Path,
    source_mtime_ms: i64,
    source_len: u64,
) -> Option<BeatMap> {
    let bytes = tokio::fs::read(file).await.ok()?;
    let cached: CachedMap = serde_json::from_slice(&bytes).ok()?;
    if cached.version != CACHE_FORMAT_VERSION
        || cached.source_mtime_ms != source_mtime_ms
        || cached.source_len != source_len
        || cached.beats_bin.is_empty()
    {
        return None;
    }
    use base64::Engine as _;
    let bin = base64::engine::general_purpose::STANDARD
        .decode(cached.beats_bin.as_bytes())
        .ok()?;
    let beats = unpack_beats(&bin)?;
    if beats.is_empty() {
        return None;
    }
    Some(BeatMap {
        version: vmusic_beats::MAP_VERSION,
        bpm: cached.bpm,
        offset_ms: cached.offset_ms,
        truncated: cached.truncated,
        beats,
    })
}

/// 原子落盘：同目录 .tmp + rename。拍表走紧凑编码（见 [`pack_beats`]）。
pub(crate) async fn write_cache(
    file: &Path,
    map: &BeatMap,
    source_mtime_ms: i64,
    source_len: u64,
) -> std::io::Result<()> {
    use base64::Engine as _;
    let beats_bin = base64::engine::general_purpose::STANDARD.encode(pack_beats(&map.beats));
    let body = CachedMap {
        version: CACHE_FORMAT_VERSION,
        bpm: map.bpm,
        offset_ms: map.offset_ms,
        truncated: map.truncated,
        beats_bin,
        source_mtime_ms,
        source_len,
    };
    if let Some(dir) = file.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let tmp = file.with_extension("tmp");
    let bytes = serde_json::to_vec(&body).map_err(std::io::Error::other)?;
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, file).await
}

/// 跑一首的分析。`_permit` 在这个任务结束（含落盘那两次 await）时才 drop：
/// 额度是「一首的分析占一格」，不是「spawn_blocking 一返回就还」，否则预算在
/// 落盘阶段就形同虚设。
fn spawn_blocking_analysis(
    state: Arc<AppState>,
    track_id: String,
    audio: AudioRef,
    permit: tokio::sync::OwnedSemaphorePermit,
) {
    tokio::spawn(async move {
        // Explicit capture is required: an unused function argument is dropped
        // when this launcher returns, even though the inner block is async move.
        let _permit = permit;
        let AudioRef {
            path,
            key,
            mtime_ms,
            len,
            ..
        } = audio;
        let joined = tokio::task::spawn_blocking(move || vmusic_beats::analyze_path(&path)).await;
        match joined {
            Ok(Ok(map)) => {
                if map.beats.is_empty() {
                    mark_failed(&state, &key, Reason::Unsupported).await;
                    return;
                }
                let cache_file = state.stage_beats_dir().join(format!("{key}.json"));
                let (bpm, beats_n) = (map.bpm, map.beats.len());
                match write_cache(&cache_file, &map, mtime_ms, len).await {
                    Ok(()) => {
                        state
                            .stage_beats
                            .lock()
                            .await
                            .insert(key, TaskState::Ready(cache_file));
                        state.publish(WsEvent::BeatmapReady {
                            track_id,
                            bpm,
                            beats_n,
                            persisted: true,
                        });
                    }
                    Err(e) => {
                        // 算出来了就不要谎报成失败：这份图进内存表继续服务，
                        // 状态记 NotPersisted，事件与响应如实标出没落到磁盘。
                        tracing::warn!("beatmap 缓存落盘失败，改用内存态: {e}");
                        state
                            .beat_volatile
                            .lock()
                            .await
                            .insert(key.clone(), std::sync::Arc::new(map));
                        state
                            .stage_beats
                            .lock()
                            .await
                            .insert(key, TaskState::NotPersisted);
                        crate::diaglog!(
                            "beat.not_persisted",
                            track = track_id,
                            beats = beats_n,
                            reason = e.to_string()
                        );
                        state.publish(WsEvent::BeatmapReady {
                            track_id,
                            bpm,
                            beats_n,
                            persisted: false,
                        });
                    }
                }
            }
            Ok(Err(vmusic_beats::AnalyzeError::Unsupported(_))) => {
                mark_failed(&state, &key, Reason::Unsupported).await
            }
            Ok(Err(vmusic_beats::AnalyzeError::Failed(e))) => {
                tracing::debug!("beatmap 分析失败 {track_id}: {e}");
                mark_failed(&state, &key, Reason::Failed).await;
            }
            Err(e) => {
                tracing::warn!("beatmap 分析任务异常: {e}");
                mark_failed(&state, &key, Reason::Failed).await;
            }
        }
    });
}

async fn mark_failed(state: &Arc<AppState>, key: &str, reason: Reason) {
    let mut table = state.stage_beats.lock().await;
    if matches!(table.get(key), Some(TaskState::Ready(_))) {
        return;
    }
    // 试到第几次写在 Analyzing 格子上；放弃时带着同一个数，table_decide 才
    // 知道这首是不是已经到上限了。
    let attempts = match table.get(key) {
        Some(TaskState::Analyzing { attempts }) => *attempts,
        _ => 1,
    };
    table.insert(key.to_string(), TaskState::Failed { reason, attempts });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用的等待额度时长：短到不拖套件，长到能被 20ms 后释放的那次等赢。
    const SHORT_WAIT: std::time::Duration = std::time::Duration::from_millis(80);

    fn tmp_dir(tag: &str) -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vmusic-beats-test-{}-{}-{}",
            std::process::id(),
            n,
            tag
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn mtime_ms(p: &Path) -> i64 {
        std::fs::metadata(p)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    fn sample_map() -> BeatMap {
        BeatMap {
            version: 1,
            bpm: Some(120.0),
            offset_ms: 0,
            truncated: false,
            beats: vec![Beat {
                t: 100,
                strength: 0.5,
                downbeat: true,
                intensity: 1,
            }],
        }
    }

    #[test]
    fn local_key_is_stable_and_absolute_only() {
        // 反斜杠与正斜杠要归一到同一个键，但这件事**只在 Windows 上成立**：Unix 下
        // `\` 是合法文件名字符，而且 `C:\Music\a b.flac` 根本不是绝对路径，
        // local_cache_key 开头的 is_absolute() 判断会直接返回 None。原先这里无条件
        // 用 Windows 路径再 unwrap()，于是在 macOS/Linux 上必然 panic——CI 上表现
        // 成 windows 绿、另两个平台红在 Test。
        let (native, slashed) = if cfg!(windows) {
            (
                PathBuf::from(r"C:\Music\a b.flac"),
                PathBuf::from("C:/Music/a b.flac"),
            )
        } else {
            (
                PathBuf::from("/Music/a b.flac"),
                PathBuf::from("/Music/a b.flac"),
            )
        };
        let k1 = local_cache_key(&native).unwrap();
        let k2 = local_cache_key(&slashed).unwrap();
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 40, "sha1 hex");
        assert!(local_cache_key(Path::new("relative.flac")).is_none());
        // 在线曲用虚拟 id 原文哈希。
        assert_eq!(online_cache_key("online:qq:123").len(), 40);
        assert_ne!(
            online_cache_key("online:qq:123"),
            online_cache_key("online:qq:124")
        );
    }

    #[tokio::test]
    async fn cache_hit_misses_on_mtime_change_and_corrupt_or_empty() {
        let dir = tmp_dir("mtime");
        let file = dir.join("a.flac");
        std::fs::write(&file, b"x").unwrap();
        let cache = dir.join("m.json");
        write_cache(&cache, &sample_map(), mtime_ms(&file), 1)
            .await
            .unwrap();
        assert!(read_cache(&cache, mtime_ms(&file), 1).await.is_some());
        // 长度与 mtime 任一不符即失效（FAT 2 秒 mtime 粒度下的兜底）。
        assert!(read_cache(&cache, mtime_ms(&file), 999).await.is_none());
        assert!(read_cache(&cache, mtime_ms(&file), 1).await.is_some());
        // mtime 变化（这里模拟：改写缓存里的 source_mtime_ms）即失效。
        let mut bytes = std::fs::read(&cache).unwrap();
        let mut v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        v["source_mtime_ms"] = serde_json::json!(mtime_ms(&file) - 5000);
        bytes = serde_json::to_vec(&v).unwrap();
        std::fs::write(&cache, bytes).unwrap();
        assert!(read_cache(&cache, mtime_ms(&file), 1).await.is_none());
        // 坏 JSON。
        std::fs::write(&cache, b"{nope").unwrap();
        assert!(read_cache(&cache, mtime_ms(&file), 1).await.is_none());
    }

    #[test]
    fn beat_packing_roundtrips_strength_flags_and_big_gaps() {
        let beats = vec![
            Beat {
                t: 1,
                strength: 0.0,
                downbeat: false,
                intensity: 0,
            },
            Beat {
                t: 500,
                strength: 0.8,
                downbeat: true,
                intensity: 3,
            },
            // 跨过 2 字节、3 字节 varint 边界的大间隔。
            Beat {
                t: 500 + 16_384,
                strength: 1.0,
                downbeat: false,
                intensity: 1,
            },
            Beat {
                t: 500 + 16_384 + 2_097_152,
                strength: 0.42,
                downbeat: true,
                intensity: 2,
            },
        ];
        let back = unpack_beats(&pack_beats(&beats)).unwrap();
        assert_eq!(back.len(), beats.len());
        for (a, b) in beats.iter().zip(back.iter()) {
            assert_eq!(a.t, b.t, "时间戳毫秒级无损");
            assert!(
                (a.strength - b.strength).abs() < 1.0 / 254.0,
                "强度量化误差 ≤ 1/255"
            );
            assert_eq!(a.downbeat, b.downbeat);
            assert_eq!(a.intensity, b.intensity);
        }
        // 截断/坏尾部必须返回 None 而不是半张地图。
        let bin = pack_beats(&beats);
        assert!(unpack_beats(&bin[..bin.len() - 1]).is_none());
        assert!(unpack_beats(&bin[..bin.len() - 2]).is_none());
    }

    #[test]
    fn packed_beats_reject_overflow_duplicates_and_unknown_flags() {
        let mut overflowing_varint = vec![0x80; 9];
        overflowing_varint.extend([0x02, 255, 0]);
        assert!(
            unpack_beats(&overflowing_varint).is_none(),
            "varint exceeds u64"
        );
        let mut negative_time = Vec::new();
        write_varint(&mut negative_time, i64::MAX as u64 + 1);
        negative_time.extend([255, 0]);
        assert!(unpack_beats(&negative_time).is_none(), "time exceeds i64");
        let mut overflowing_sum = Vec::new();
        write_varint(&mut overflowing_sum, i64::MAX as u64);
        overflowing_sum.extend([255, 0, 1, 255, 0]);
        assert!(unpack_beats(&overflowing_sum).is_none(), "sum exceeds i64");
        assert!(
            unpack_beats(&[1, 255, 0, 0, 255, 0]).is_none(),
            "duplicate beat"
        );
        assert!(unpack_beats(&[1, 255, 8]).is_none(), "reserved flag bits");
        assert!(
            unpack_beats(&[0, 255, 7]).is_some(),
            "first beat may be at zero"
        );
    }

    #[tokio::test]
    async fn spawned_analysis_keeps_its_permit_until_task_finishes() {
        let state = Arc::new(crate::state::tests::playback_state().await.0);
        let dir = tmp_dir("permit-lifetime");
        let permit = state.beat_slots.clone().try_acquire_owned().unwrap();
        // Holding the task table prevents completion even when the missing-file
        // analysis returns immediately. This exercises the real spawned future.
        let table = state.stage_beats.lock().await;
        spawn_blocking_analysis(
            state.clone(),
            "missing".into(),
            probe_audio("permit", &dir, 0),
            permit,
        );
        assert_eq!(
            state.beat_slots.available_permits(),
            crate::state::BEAT_ANALYZE_BUDGET - 1
        );
        tokio::task::yield_now().await;
        assert_eq!(
            state.beat_slots.available_permits(),
            crate::state::BEAT_ANALYZE_BUDGET - 1
        );
        drop(table);
        let all = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            state
                .beat_slots
                .clone()
                .acquire_many_owned(crate::state::BEAT_ANALYZE_BUDGET as u32),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(matches!(
            state.stage_beats.lock().await.get("permit"),
            Some(TaskState::Failed { .. })
        ));
        drop(all);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn spawned_analysis_keeps_budget_through_disk_commit() {
        let mut base = crate::state::tests::playback_state().await.0;
        let dir = tmp_dir("permit-disk");
        base.data_dir = dir.clone();
        let state = Arc::new(base);
        let path = dir.join("clicks.wav");
        let sample_rate = 22_050u32;
        let samples = sample_rate * 4;
        let mut wav = Vec::new();
        wav.extend(b"RIFF");
        wav.extend((36 + samples * 2).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(sample_rate.to_le_bytes());
        wav.extend((sample_rate * 2).to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend((samples * 2).to_le_bytes());
        for i in 0..samples {
            let phase = i % (sample_rate / 2);
            let value = if phase < sample_rate / 40 {
                let t = phase as f32 / sample_rate as f32;
                ((t * 900.0 * std::f32::consts::TAU).sin() * 20_000.0) as i16
            } else {
                0
            };
            wav.extend(value.to_le_bytes());
        }
        std::fs::write(&path, wav).unwrap();
        let audio = audio_ref(path, "disk-budget".into(), "clicks".into())
            .await
            .unwrap();
        let permit = state.beat_slots.clone().try_acquire_owned().unwrap();
        let table = state.stage_beats.lock().await;
        spawn_blocking_analysis(state.clone(), "clicks".into(), audio, permit);
        let cache = state.stage_beats_dir().join("disk-budget.json");
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !cache.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("real click analysis must persist a beatmap");
        assert_eq!(
            state.beat_slots.available_permits(),
            crate::state::BEAT_ANALYZE_BUDGET - 1,
            "disk is written but the task verdict has not committed yet"
        );
        drop(table);
        let all = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            state
                .beat_slots
                .clone()
                .acquire_many_owned(crate::state::BEAT_ANALYZE_BUDGET as u32),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(matches!(
            state.stage_beats.lock().await.get("disk-budget"),
            Some(TaskState::Ready(_))
        ));
        drop(all);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn retry_cannot_forget_an_active_analysis() {
        let state = Arc::new(crate::state::tests::playback_state().await.0);
        state
            .stage_beats
            .lock()
            .await
            .insert("active".into(), TaskState::Analyzing { attempts: 2 });
        forget(&state, "active").await;
        let mut table = state.stage_beats.lock().await;
        assert_eq!(table_decide(&mut table, "active", true, 3), Action::Wait);
        assert!(matches!(
            table.get("active"),
            Some(TaskState::Analyzing { attempts: 2 })
        ));
    }

    #[tokio::test]
    async fn cache_file_stays_small_for_a_realistic_beatmap() {
        let dir = tmp_dir("size");
        let file = dir.join("a.flac");
        std::fs::write(&file, b"x").unwrap();
        // 829 拍（实测旧格式 53KB 那首的规模）：间隔 ~460ms，强度交错。
        let beats: Vec<Beat> = (0..829)
            .map(|i| Beat {
                t: 500 + i as i64 * 460,
                strength: 0.3 + (i % 7) as f32 * 0.1,
                downbeat: i % 4 == 0,
                intensity: (i % 4) as u8,
            })
            .collect();
        let map = BeatMap {
            version: 1,
            bpm: Some(130.0),
            offset_ms: 0,
            truncated: false,
            beats,
        };
        let cache = dir.join("big.json");
        write_cache(&cache, &map, mtime_ms(&file), 1).await.unwrap();
        let size = std::fs::metadata(&cache).unwrap().len();
        assert!(size < 8192, "829 拍的缓存不该超过 8KB，实测 {size}B");
        let back = read_cache(&cache, mtime_ms(&file), 1).await.unwrap();
        assert_eq!(back.beats.len(), 829);
        assert_eq!(back.beats[828].t, 500 + 828 * 460);
    }

    #[tokio::test]
    async fn legacy_v1_cache_file_is_a_miss_and_gets_replaced() {
        let dir = tmp_dir("legacy");
        let file = dir.join("a.flac");
        std::fs::write(&file, b"x").unwrap();
        // v1 形状：逐拍整对象数组、无 beats_bin、version=1。
        let legacy = serde_json::json!({
            "version": 1,
            "bpm": 120.0,
            "offset_ms": 0,
            "truncated": false,
            "beats": [{ "t": 100, "strength": 0.5, "downbeat": true, "intensity": 1 }],
            "source_mtime_ms": mtime_ms(&file),
            "source_len": 1,
        });
        let cache = dir.join("old.json");
        std::fs::write(&cache, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(
            read_cache(&cache, mtime_ms(&file), 1).await.is_none(),
            "v1 信封没有版本闸门的豁免权"
        );
        // 未命中 → 重算落盘后就是新格式，同一文件名原地升级。
        write_cache(&cache, &sample_map(), mtime_ms(&file), 1)
            .await
            .unwrap();
        assert!(read_cache(&cache, mtime_ms(&file), 1).await.is_some());
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&cache).unwrap()).unwrap();
        assert_eq!(v["version"], 2, "新落盘就是新格式版本");
        assert!(v.get("beats").is_none(), "不再逐拍写整对象数组");
    }

    #[test]
    fn idempotent_table_decisions() {
        let mut t: BoundedMap<TaskState> = BoundedMap::new(crate::state::STAGE_BEATS_CAP);
        // 首次：建任务，尝试计数落在格子上（1 = 含本次）。
        assert!(matches!(table_decide(&mut t, "k", false, 3), Action::Spawn));
        assert!(matches!(
            t.get("k"),
            Some(TaskState::Analyzing { attempts: 1 })
        ));
        // 在途：等待。
        assert!(matches!(table_decide(&mut t, "k", false, 3), Action::Wait));
        // 失败：GET 不重试，播放（retry）重试。
        t.insert(
            "k".into(),
            TaskState::Failed {
                reason: Reason::Failed,
                attempts: 1,
            },
        );
        assert!(matches!(
            table_decide(&mut t, "k", false, 3),
            Action::Fail(Reason::Failed)
        ));
        assert!(matches!(table_decide(&mut t, "k", true, 3), Action::Spawn));
        assert!(
            matches!(t.get("k"), Some(TaskState::Analyzing { attempts: 2 })),
            "重试要接着上次的次数往下数"
        );
        // 三次用完：之后连提交路径也不再重开——一首真放不出图的文件不该每次
        // 播放都重算几秒满核 FFT。
        t.insert(
            "k".into(),
            TaskState::Failed {
                reason: Reason::Failed,
                attempts: 3,
            },
        );
        assert!(matches!(
            table_decide(&mut t, "k", true, 3),
            Action::Fail(Reason::Failed)
        ));
        // unsupported 不与 failed 混淆。
        t.insert(
            "u".into(),
            TaskState::Failed {
                reason: Reason::Unsupported,
                attempts: 1,
            },
        );
        assert!(matches!(
            table_decide(&mut t, "u", false, 3),
            Action::Fail(Reason::Unsupported)
        ));
        // Ready 但磁盘文件没了（被外部删/LRU）：重开任务，计数从头。
        t.insert("r".into(), TaskState::Ready(PathBuf::from("r.json")));
        assert!(matches!(table_decide(&mut t, "r", false, 3), Action::Spawn));
        assert!(matches!(
            t.get("r"),
            Some(TaskState::Analyzing { attempts: 1 })
        ));
        // NotPersisted（算出来过、内存图也已被淘汰）：同样重开，而不是当失败。
        t.insert("m".into(), TaskState::NotPersisted);
        assert!(matches!(table_decide(&mut t, "m", false, 3), Action::Spawn));
    }

    /// 幂等表不能随「分析过的曲目数」无限长：越过上限要淘汰最老的格子，
    /// 而淘汰只影响幂等性（最坏是重开一次分析），不影响正确性。
    #[test]
    fn idempotency_table_is_bounded() {
        let mut t: BoundedMap<TaskState> = BoundedMap::new(crate::state::STAGE_BEATS_CAP);
        for i in 0..crate::state::STAGE_BEATS_CAP + 5 {
            assert!(matches!(
                table_decide(&mut t, &format!("k{i}"), false, 3),
                Action::Spawn
            ));
        }
        assert!(t.get("k0").is_none(), "最老的格子应被淘汰");
        assert!(t.get("k4").is_none(), "淘汰按写入顺序推进");
        assert!(
            matches!(
                t.get(&format!("k{}", crate::state::STAGE_BEATS_CAP + 4)),
                Some(TaskState::Analyzing { .. })
            ),
            "最新写入的格子保留"
        );
    }

    /// 并发预算（F5 的主干）：一首的分析是几秒的满核 FFT，抢的是正在解码那首歌
    /// 的 CPU。连切 20 首时提交路径只能真的开跑两三首，其余**当场推迟**而不是
    /// 排队堆积——队列里堆的全是用户已经跳走的曲子。
    #[tokio::test]
    async fn commit_path_defers_when_the_budget_is_full() {
        let state = std::sync::Arc::new(crate::state::tests::playback_state().await.0);
        let mut held = Vec::new();
        while let Ok(permit) = state.beat_slots.clone().try_acquire_owned() {
            held.push(permit);
        }
        assert_eq!(
            held.len(),
            crate::state::BEAT_ANALYZE_BUDGET,
            "预算就是这么多格，多一格都不许并行"
        );
        assert!(
            acquire_permit(&state, Caller::Commit, SHORT_WAIT)
                .await
                .is_none(),
            "满了就不该再开一首"
        );
        // 腾出一格，提交路径立刻能再用（额度不是按需排队，也不是永久收紧）。
        let last = held.pop().expect("至少占住一格");
        drop(last);
        assert!(acquire_permit(&state, Caller::Commit, SHORT_WAIT)
            .await
            .is_some());
    }

    /// 界面在等的那首与顺手预热的那首耐心不一样：Demand 要等得到额度，
    /// 但等满 `BEAT_PERMIT_WAIT` 必须放弃并回 analyzing（不许把 GET 挂死）。
    #[tokio::test]
    async fn demand_path_waits_for_a_slot_then_gives_up() {
        let state = std::sync::Arc::new(crate::state::tests::playback_state().await.0);
        let mut held = Vec::new();
        while let Ok(permit) = state.beat_slots.clone().try_acquire_owned() {
            held.push(permit);
        }
        let late = held.pop().expect("至少占住一格");
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            drop(late);
        });
        assert!(
            acquire_permit(&state, Caller::Demand, std::time::Duration::from_secs(2))
                .await
                .is_some(),
            "20ms 后腾出的额度，Demand 应当等到"
        );
        // 再占满：这一次没有会释放的持有者，等满超时就必须自己收场（调用方回
        // analyzing），而不是把 GET 无限挂着。
        while let Ok(permit) = state.beat_slots.clone().try_acquire_owned() {
            held.push(permit);
        }
        assert!(
            acquire_permit(&state, Caller::Demand, SHORT_WAIT)
                .await
                .is_none(),
            "等不到额度必须自己收场"
        );
    }

    /// 「算出来但没落盘」的那份必须留在有界内存表里：无界的话，一台数据目录
    /// 只读的设备会把内存随「放过的曲目数」一路涨上去。
    #[test]
    fn volatile_maps_table_is_bounded() {
        let mut t: BoundedMap<std::sync::Arc<BeatMap>> =
            BoundedMap::new(crate::state::BEAT_VOLATILE_CAP);
        for i in 0..crate::state::BEAT_VOLATILE_CAP + 3 {
            t.insert(format!("k{i}"), std::sync::Arc::new(sample_map()));
        }
        assert!(t.get("k0").is_none(), "最老的内存图要被淘汰");
        assert!(
            t.get(&format!("k{}", crate::state::BEAT_VOLATILE_CAP + 2))
                .is_some(),
            "最新的保留"
        );
    }

    /// 状态面板的四种计数与「最近在忙哪几首」的序。这块面板的存在理由就是让
    /// 「在算 / 已落盘 / 只在这轮内存 / 已放弃」可分辨，所以四个格子必须各自
    /// 进对应的计数，而不是糊成一个 `tracked`。
    #[tokio::test]
    async fn status_counts_every_task_state_and_lists_newest_first() {
        // 面板是 JSON 视图：读数字要走 as_u64，别让断言迁就类型的推断。
        let num = |v: &serde_json::Value| v.as_u64().expect("计数应当是数字");
        let text = |v: &serde_json::Value| v.as_str().unwrap_or("").to_string();
        let (base, _handle) = crate::state::tests::playback_state().await;
        let state = std::sync::Arc::new(base);
        {
            let mut table = state.stage_beats.lock().await;
            table.insert("k1aaaaaa".into(), TaskState::Analyzing { attempts: 1 });
            table.insert(
                "k2aaaaaa".into(),
                TaskState::Ready(PathBuf::from("k2.json")),
            );
            table.insert("k3aaaaaa".into(), TaskState::NotPersisted);
            table.insert(
                "k4aaaaaa".into(),
                TaskState::Failed {
                    reason: Reason::Unsupported,
                    attempts: 3,
                },
            );
        }
        state
            .beat_labels
            .lock()
            .await
            .insert("k4aaaaaa".into(), "一首不支持的曲".into());
        state
            .beat_deferrals
            .store(7, std::sync::atomic::Ordering::Relaxed);

        let v = status(&state, None).await;
        assert!(v["current"].is_null(), "没带 track 时不该凭空造一首的结论");
        assert_eq!(num(&v["analyzing"]), 1);
        assert_eq!(num(&v["on_disk"]), 1);
        assert_eq!(num(&v["memory_only"]), 1);
        assert_eq!(num(&v["abandoned"]), 1);
        assert_eq!(num(&v["tracked"]), 4);
        assert_eq!(
            num(&v["deferred"]),
            7,
            "让路次数要看得见，不然答不出「为什么还没图」"
        );
        assert_eq!(num(&v["budget"]), crate::state::BEAT_ANALYZE_BUDGET as u64);
        assert_eq!(
            num(&v["attempts_max"]),
            crate::state::BEAT_ATTEMPTS_MAX as u64
        );

        let recent = v["recent"].as_array().unwrap();
        assert_eq!(recent.len(), 4);
        // 面板答的是「最近在忙哪几首」：按写入序新→旧，不是哈希表的随机序。
        assert_eq!(text(&recent[0]["key"]), "k4aaaaaa");
        assert_eq!(text(&recent[3]["key"]), "k1aaaaaa");
        assert_eq!(text(&recent[0]["state"]), "failed");
        assert_eq!(text(&recent[0]["reason"]), "unsupported");
        assert_eq!(num(&recent[0]["attempts"]), 3);
        assert_eq!(
            text(&recent[0]["label"]),
            "一首不支持的曲",
            "只写 sha1 等于没写"
        );
        assert!(
            recent[1]["label"].is_null(),
            "没记到标题的格子也要出现在面板上，键本身就是线索"
        );
    }

    /// 面板只列最近若干条：一台放过几千首的机器，把整张表塞给设置页的一行会让
    /// 那行没法读。
    #[tokio::test]
    async fn status_lists_at_most_the_recent_window() {
        let (base, _handle) = crate::state::tests::playback_state().await;
        let state = std::sync::Arc::new(base);
        {
            let mut table = state.stage_beats.lock().await;
            for i in 0..crate::state::STAGE_BEATS_CAP {
                // 键取满 8 个字符：面板上留的是键的前 8 位，短于此才不会被截。
                table.insert(format!("k{:07}", i), TaskState::NotPersisted);
            }
        }
        let v = status(&state, None).await;
        assert_eq!(
            v["recent"].as_array().unwrap().len(),
            crate::state::BEAT_STATUS_RECENT
        );
        // tracked 仍是全量：被截断的是明细，不是总数。
        assert_eq!(
            v["tracked"].as_u64(),
            Some(crate::state::STAGE_BEATS_CAP as u64)
        );
        assert_eq!(
            v["recent"][0]["key"].as_str(),
            Some(format!("k{:07}", crate::state::STAGE_BEATS_CAP - 1).as_str())
        );
    }

    /// 重试「忘掉的是这一首」：整张表清空会把别首正在算的任务说成没人生，
    /// 于是同一次 FFT 被开两遍。
    #[tokio::test]
    async fn retry_forgets_only_that_track() {
        let (base, _handle) = crate::state::tests::playback_state().await;
        let state = std::sync::Arc::new(base);
        state.stage_beats.lock().await.insert(
            "k1".into(),
            TaskState::Failed {
                reason: Reason::Failed,
                attempts: crate::state::BEAT_ATTEMPTS_MAX,
            },
        );
        state
            .stage_beats
            .lock()
            .await
            .insert("k2".into(), TaskState::Analyzing { attempts: 1 });
        state
            .beat_volatile
            .lock()
            .await
            .insert("k1".into(), std::sync::Arc::new(sample_map()));

        forget(&state, "k1").await;
        assert!(state.stage_beats.lock().await.get("k1").is_none());
        assert!(state.beat_volatile.lock().await.get("k1").is_none());
        assert!(
            state.stage_beats.lock().await.get("k2").is_some(),
            "邻居格子的任务不能被一次重试抹掉"
        );

        // 认不出音频的重试：回 not_ready，既不是 500 也不是沿用旧的「已放弃」。
        match retry(&state, "no-such-track").await {
            Outcome::Unavailable(Reason::NotReady) => {}
            _ => panic!("认不出音频时必须回 not_ready"),
        }
    }

    fn probe_audio(key: &str, dir: &Path, mtime_ms: i64) -> AudioRef {
        AudioRef {
            path: dir.join("a.flac"),
            mtime_ms,
            len: 4096,
            key: key.to_string(),
            label: "一首 - 某人".to_string(),
        }
    }

    /// 面板上「这一首」那一问的落点：表里没格子不等于没图。进程重启后盘上那份
    /// 还在，说「还没开始」会让人为一首已经有图的曲子再按一次重试。
    #[tokio::test]
    async fn verdict_reports_the_disk_copy_even_with_an_empty_table() {
        let (base, _handle) = crate::state::tests::playback_state().await;
        let mut base = base;
        let dir = tmp_dir("verdict");
        base.data_dir = dir.clone();
        let state = std::sync::Arc::new(base);
        let audio = probe_audio("deadbeefcafe0000", &dir, 1_700_000_000_000);
        assert_eq!(
            verdict(&state, &audio).await["state"].as_str(),
            Some("idle"),
            "谁都没碰过它才是 idle"
        );

        let cache = state.stage_beats_dir().join("deadbeefcafe0000.json");
        write_cache(&cache, &sample_map(), audio.mtime_ms, audio.len)
            .await
            .unwrap();
        let v = verdict(&state, &audio).await;
        assert_eq!(v["state"].as_str(), Some("disk"));
        assert_eq!(v["label"].as_str(), Some("一首 - 某人"));

        // 曲文件换过一版（mtime 不符）：盘上那份是过期图，不能说「已有图」。
        let changed = probe_audio("deadbeefcafe0000", &dir, audio.mtime_ms + 5_000);
        assert_eq!(
            verdict(&state, &changed).await["state"].as_str(),
            Some("idle")
        );

        // 算出来但没落盘的那份：说 memory，不是 failed。
        let other = probe_audio("cafedeadbeef0000", &dir, 1_700_000_000_000);
        state
            .beat_volatile
            .lock()
            .await
            .insert(other.key.clone(), std::sync::Arc::new(sample_map()));
        assert_eq!(
            verdict(&state, &other).await["state"].as_str(),
            Some("memory"),
            "内存态是「这轮能用」，不是失败"
        );

        // 表里的结论优先于现场探盘：已放弃三次就得是 failed + 次数。
        state.stage_beats.lock().await.insert(
            other.key.clone(),
            TaskState::Failed {
                reason: Reason::Unsupported,
                attempts: crate::state::BEAT_ATTEMPTS_MAX,
            },
        );
        let v = verdict(&state, &other).await;
        assert_eq!(v["state"].as_str(), Some("failed"));
        assert_eq!(v["reason"].as_str(), Some("unsupported"));
        assert_eq!(
            v["attempts"].as_u64(),
            Some(crate::state::BEAT_ATTEMPTS_MAX as u64)
        );
    }

    /// 认不出音频的一首要单独说得出口：「后台不认识它」与「后台试过三次没算
    /// 出来」是两种完全不同的下一步。
    #[tokio::test]
    async fn status_answers_not_ready_for_an_unknown_track() {
        let (base, _handle) = crate::state::tests::playback_state().await;
        let state = std::sync::Arc::new(base);
        let v = status(&state, Some("  ")).await;
        assert!(
            v["current"].is_null(),
            "空白 track 等于没问，不该造一个结论"
        );
        let v = status(&state, Some("no-such-track")).await;
        assert_eq!(v["current"]["state"].as_str(), Some("not_ready"));
    }
}
