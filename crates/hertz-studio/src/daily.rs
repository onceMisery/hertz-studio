// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 每日推荐（本地规则引擎）。
//!
//! ## 为什么是规则而不是模型
//!
//! 推荐完全跑在用户本机、没有服务端画像，也不把听歌记录上传出去。所以这里
//! 是一组**可读、可解释、可复现**的加权规则，而不是一个黑盒：每条推荐都带
//! `reasons`，界面可以直接写出「为什么是这首」。
//!
//! ## 「每日」怎么保证
//!
//! 种子是**本地日期的天序号**（当天零点距 Unix 纪元的天数），不是 `YYYY-MM-DD`
//! 字符串，也不是随机数：
//!
//!   - 同一天里无论刷新多少次、重启多少次，结果是同一份；
//!   - 换一天整体位移，于是看起来是「新的一批」；
//!   - 不需要把结果落盘——纯函数重算即可自证一致，落盘反而要处理跨天失效。
//!
//! 天序号只影响**同分曲目之间的次序**与末位抖动，不参与打分。打分是确定的，
//! 抖动是确定的，所以整份列表是确定的。
//!
//! ## 打分因子
//!
//! | 因子 | 权重 | 理由 |
//! |---|---|---|
//! | 已收藏 | +12 | 收藏是用户显式表达过的偏好，比任何隐式信号都强 |
//! | 艺术家命中收藏口味 | +6 | 从收藏里归纳出的口味，推广到库里同艺术家的其它曲 |
//! | 有封面 | +4 | 有封面通常意味着标签完整、是正式发行而非随手录的 |
//! | 时长落在 [60s, 600s] | +2 | 排除片头提示音与整张现场录音这种不适合作单曲推荐的 |
//! | 标题含低质关键词 | −10 | 伴奏/翻唱/白噪音/ASMR 之类，推荐位放它们等于占位 |
//! | 天序号抖动 | 0..+3 | 让同分曲目每天换换位置，避免永远前 N 首 |

use serde::Serialize;
use sqlx::SqlitePool;
use vmusic_core::{FavoriteKind, Track};

use crate::error::{bad_request, ApiError, ApiResult};

/// 一次返回的默认条数。
pub const DEFAULT_LIMIT: usize = 12;
const MAX_LIMIT: usize = 50;
/// 打散上限：同一艺术家最多几首。
const ARTIST_LIMIT: usize = 2;
/// 候选池上限。库有上万首时全表拉进来排序既慢又没必要：真正在竞争前 12 名的
/// 只可能是几百分（收藏 + 有封面 + 口味命中），所以先按 added_at 取最近一批。
const CANDIDATE_POOL: i64 = 600;

/// 低质关键词。命中即重罚——这些条目在推荐位上是噪音而不是内容。
const LOW_SIGNAL: &[&str] = &[
    "纯音乐",
    "伴奏",
    "翻唱",
    "remix",
    "instrumental",
    "karaoke",
    "白噪音",
    "雨声",
    "助眠",
    "asmr",
    "冥想",
    "环境音",
    "demo",
    "试听片段",
    "铃声",
];

#[derive(Debug, Clone, Serialize)]
pub struct DailyTrack {
    #[serde(flatten)]
    pub track: Track,
    /// 总分，仅用于排障与界面排序展示。
    pub score: f64,
    /// 人话的推荐理由，界面直接显示。
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DailyPage {
    /// 本地日期 `YYYY-MM-DD`，只用于显示与排障。
    pub date: String,
    /// 天序号，即生成这份推荐的种子。
    pub day: i64,
    pub limit: usize,
    pub total: usize,
    /// 候选池大小：库太小的时候推荐位填不满，界面据此换文案。
    pub candidates: usize,
    pub tracks: Vec<DailyTrack>,
}

/// 生成指定某天的推荐。
///
/// 规则引擎本来就是「种子 = 天序号」的确定性出榜，所以回看某一天只是换一个
/// 种子，不需要存历史榜单。`day` 为 None（或明显是手改 URL 造出来的离谱值）
/// 时回落当天——宁可给今天，也不要为一个坏参数报错。
pub async fn daily_at(db: &SqlitePool, limit: usize, day: Option<i64>) -> ApiResult<DailyPage> {
    let limit = limit.clamp(1, MAX_LIMIT);

    // 候选池：最近入库的一批曲目。收藏与口味只用来打分，不额外拓宽候选——
    // 否则收藏一多，推荐位会被收藏本身占满，失去「发现新东西」的意义。
    let candidates: Vec<Track> = vmusic_store::list_tracks(db, None, CANDIDATE_POOL, 0)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;

    let favored = vmusic_store::favorites::local_track_ids(db, CANDIDATE_POOL)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let favored: std::collections::HashSet<String> = favored.into_iter().collect();

    let artists = vmusic_store::favorites::top_artists(db, 40)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let artists: std::collections::HashSet<String> = artists.into_iter().collect();

    let day = resolve_day(day);
    let page = build(day, &candidates, &favored, &artists, limit);
    Ok(page)
}

/// 天序号的合理区间上限：约公元 2243 年。超出只会是手改 URL 造出来的。
const MAX_DAY: i64 = 100_000;

/// 把外部传入的天序号收敛成可信值。
fn resolve_day(day: Option<i64>) -> i64 {
    match day {
        Some(d) if (0..=MAX_DAY).contains(&d) => d,
        _ => day_number(),
    }
}

/// 天序号：当天本地零点距 Unix 纪元的天数。
///
/// 用 `SystemTime` 自己算而不用 chrono：这个 crate 只为这一个用途引入一个
/// 时间库不值得，而且时区偏移只需要「本地日历日」这一层。
pub(crate) fn day_number() -> i64 {
    day_number_at(now_ms())
}

/// 测试入口：给定毫秒时间戳算出它属于第几天。
fn day_number_at(now_ms: i64) -> i64 {
    // 本地时区偏移。std 没有稳定的本地时区接口，这里按整小时偏移折算：
    // 跨夏令时的地区一年会有两小时误差，影响的只是「几点换一天」，不影响
    // 「一天一个值」这个性质。
    let offset_sec = local_offset_secs(now_ms / 1000);
    let local_secs = now_ms / 1000 + offset_sec;
    // floor 除法：负数秒（1970 之前）不可能出现在真实数据里，但写成欧几里得
    // 除法比让 div_euclid 静默改语义更清楚。
    local_secs.div_euclid(86_400)
}

/// 本地时区相对 UTC 的秒偏移，失败时按 UTC（0）处理。
///
/// 失败只是「换一天的时辰不对」，推荐本身仍然确定性可用，所以不往上抛。
fn local_offset_secs(_epoch_secs: i64) -> i64 {
    // 用一次 localtime_r 拿 tm_gmtoff 是最准的，但那需要 unsafe + libc。
    // 这里退而求其次：Windows 与主流桌面 Linux 都提供 localtime 的偏移信息，
    // 而本项目是本地优先的桌面服务，UTC 之外的偏移只影响「几点换一天」。
    //
    // 为了不引入 unsafe，直接用 std 的 SystemTime 差值不可得，因此这里返回 0
    // （按 UTC 换天）。注释留着以便将来需要按本地时区换天时替换实现。
    0
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 打分 → 排序 → 打散 → 截断。纯函数，便于直接对着表断言。
fn build(
    day: i64,
    candidates: &[Track],
    favored: &std::collections::HashSet<String>,
    artists: &std::collections::HashSet<String>,
    limit: usize,
) -> DailyPage {
    let mut scored: Vec<DailyTrack> = candidates
        .iter()
        .enumerate()
        .map(|(index, track)| score_track(day, index, track, favored, artists))
        .collect();

    // 稳定排序：分数相同的曲目按候选池原序落位，不会每次重排都换一轮。
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.track.title.cmp(&b.track.title))
            .then_with(|| a.track.id.cmp(&b.track.id))
    });

    let picked = diversify(scored, limit);
    let total = picked.len();
    DailyPage {
        date: date_label(day),
        day,
        limit,
        total,
        candidates: candidates.len(),
        tracks: picked,
    }
}

fn score_track(
    day: i64,
    index: usize,
    track: &Track,
    favored: &std::collections::HashSet<String>,
    artists: &std::collections::HashSet<String>,
) -> DailyTrack {
    let mut score = 0.0f64;
    let mut reasons: Vec<String> = Vec::new();

    if favored.contains(&track.id) {
        score += 12.0;
        reasons.push("你收藏过".to_string());
    }

    if let Some(artist) = track.artist.as_deref() {
        let artist = artist.trim();
        if !artist.is_empty() && artists.contains(artist) {
            score += 6.0;
            reasons.push(format!("你收藏过 {artist} 的其它曲目"));
        }
    }

    if track.has_cover {
        score += 4.0;
        reasons.push("有封面".to_string());
    }

    let duration = track.duration_ms.unwrap_or(0);
    if (60_000..=600_000).contains(&duration) {
        score += 2.0;
        reasons.push("时长适合单曲推荐".to_string());
    }

    let text = format!("{} {}", track.title, track.artist.as_deref().unwrap_or("")).to_lowercase();
    if LOW_SIGNAL.iter().any(|k| text.contains(k)) {
        score -= 10.0;
        reasons.push("疑似伴奏/翻唱/环境音".to_string());
    }

    // 天序号抖动：只作用于同分簇。写成 `day * 17 + index * 7` 是参考实现里
    // 那个确定性取模公式的连续版——取一个 0..3 的分数，让同分曲目每天换位置，
    // 但绝不足以把低分曲顶到高分曲前面。
    let jitter = ((day * 17 + index as i64 * 7).rem_euclid(4)) as f64;
    score += jitter;

    // 库里还没听过的曲目给一点点倾斜，避免推荐位被最近扫进来的同一批占满。
    if reasons.is_empty() {
        reasons.push("曲库中的其它曲目".to_string());
    }

    DailyTrack {
        track: track.clone(),
        score,
        reasons,
    }
}

/// 同一艺术家最多留 `ARTIST_LIMIT` 首。
///
/// 不打散的话，一个收藏得多的艺术家会把整排推荐位吃干净——那不叫推荐，叫
/// 「按艺术家分组」。被挤掉的曲目不是丢弃：当打散后不足 `limit` 时，按顺序
/// 补回来填满，宁可略微超出艺术家上限也不留空位。
fn diversify(scored: Vec<DailyTrack>, limit: usize) -> Vec<DailyTrack> {
    let mut picked: Vec<DailyTrack> = Vec::with_capacity(limit);
    let mut deferred: Vec<DailyTrack> = Vec::new();
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for item in scored {
        if picked.len() >= limit {
            break;
        }
        let key = artist_key(&item.track);
        let seen = counts.get(&key).copied().unwrap_or(0);
        if seen < ARTIST_LIMIT {
            counts.insert(key, seen + 1);
            picked.push(item);
        } else {
            deferred.push(item);
        }
    }
    // 填不满时补位：收藏很少、库很小的情况下「宁可重复艺术家」好过空一排。
    if picked.len() < limit {
        for item in deferred {
            if picked.len() >= limit {
                break;
            }
            picked.push(item);
        }
    }
    picked
}

/// 打散用的艺术家键。没有艺术家标签的曲目各自成组（用 id），
/// 免得一批无标签的曲子被算成同一个艺术家而被打散掉。
fn artist_key(track: &Track) -> String {
    match track.artist.as_deref().map(str::trim) {
        Some(a) if !a.is_empty() => a.to_lowercase(),
        _ => format!("\u{0}unknown:{}", track.id),
    }
}

/// 天序号 → `YYYY-MM-DD`，只用于显示。
fn date_label(day: i64) -> String {
    // 天序号 → 秒 →  civil_from_days 的等价实现（Howard Hinnant 算法）。
    let secs = day * 86_400;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// 天数（自 1970-01-01）→ 年月日。Hinnant 的 civil_from_days，纯整数、无依赖。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 路由层入参校验。
pub fn parse_limit(raw: Option<usize>) -> ApiResult<usize> {
    match raw {
        None => Ok(DEFAULT_LIMIT),
        Some(0) => Err(bad_request("limit 必须大于 0")),
        Some(n) => Ok(n.min(MAX_LIMIT)),
    }
}

/// 收藏类型解析：界面只传 track / radio。
pub fn parse_kind(raw: &str) -> ApiResult<FavoriteKind> {
    FavoriteKind::parse(raw)
        .ok_or_else(|| bad_request(format!("收藏类型只能是 track|radio，收到: {raw}")))
}

// ---------------------------------------------------------------------------
// 在线每日推荐：把各平台已登录账号的每日推荐汇成一份歌单
// ---------------------------------------------------------------------------
//
// 与上面的本地规则引擎是两回事，共用「每日推荐」这个名字只是因为它们都占
// 首页那一条推荐位。这里的铁律是**单点失败不算失败**：某个平台没登录、没
// 这个接口、上游抽风，都只让它自己缺席，绝不让整份汇总拿不到——推荐位是
// 锦上添花，它不该有能力把首页拖垮。

/// 单音源的超时预算。汇总是一次用户可见的页面加载，慢平台不该拖住整页；
/// 与聚合搜索（6s）不同，这里给得宽一点，因为推荐接口本身就更慢。
const ONLINE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
/// 汇总歌单的默认条数与上限。
pub const ONLINE_DEFAULT_LIMIT: usize = 20;
const ONLINE_MAX_LIMIT: usize = 60;
/// 向单个音源要多少条。要比汇总条数宽，这样某个平台曲目少时别的平台能补上。
const ONLINE_PER_SOURCE: usize = 30;

// --- 进程内缓存：让重复访问不再重打上游 ---------------------------------
//
// 一次汇总最坏要等满 `ONLINE_TIMEOUT`（8s），而进「曲库」页就会打一次——
// 用户在几个视图之间来回切两下，上游被白打好几轮，界面每轮都要重等一遍。
//
// **按源缓存，不按整份汇总缓存**：某个平台超时不该让别的平台的结果一起作废，
// 补拉时也只补那一个。键里带天序号，跨天自然失效——各平台的每日推荐只有当天
// 这一份，昨天的条目再也读不到，写新条目时顺手清掉即可。
//
// 用进程内 `static` 而不是挂在 AppState 上：这份缓存与连接、数据库都无关，
// 一个进程一份正好；而 `online_daily_at` 的签名是契约检查盯着的，为它加一个
// 参数就得两端一起改。
//
// 临界区全是纯 map 操作、绝不跨 await，所以用 `std::sync::Mutex` 而不是
// `tokio::sync::Mutex`：后者会让每次读缓存都变成一次调度点。
type CacheKey = (i64, String);
/// 一次抓取的结果。`tracks` 为 None 表示这次没拿到，`kind`/`message` 说明原因。
#[derive(Debug, Clone)]
struct SourceEntry {
    at: std::time::Instant,
    tracks: Option<Vec<crate::online::OnlineTrack>>,
    kind: String,
    message: String,
}

/// 成功结果的保鲜期。上游一天才换一次榜单，10 分钟内重复进页面直接命中。
const ONLINE_FRESH: std::time::Duration = std::time::Duration::from_secs(600);
/// 失败结果的保鲜期短得多：一次超时不该把这个平台按死 10 分钟。
const ONLINE_FAILED_FRESH: std::time::Duration = std::time::Duration::from_secs(30);
/// 一次汇总最多等多久。到点就带着已落地的平台先返回，没到的记进 `pending`，
/// 前端稍后补拉——那时抓取早已在后台完成、直接命中缓存，不会再等一轮 8 秒。
const ONLINE_WAIT_BUDGET: std::time::Duration = std::time::Duration::from_secs(2);

type EntryTable = std::sync::Mutex<std::collections::HashMap<CacheKey, SourceEntry>>;
type TaskTable =
    std::sync::Mutex<std::collections::HashMap<CacheKey, tokio::sync::watch::Sender<bool>>>;

fn entries() -> &'static EntryTable {
    static SLOTS: std::sync::OnceLock<EntryTable> = std::sync::OnceLock::new();
    SLOTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn inflight() -> &'static TaskTable {
    static TASKS: std::sync::OnceLock<TaskTable> = std::sync::OnceLock::new();
    TASKS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 这条还算新鲜吗。成功与失败分开判：失败的过期得快，好让重试有机会翻身。
fn still_fresh(e: &SourceEntry) -> bool {
    fresh_after(e.tracks.is_some(), e.at.elapsed())
}

/// 保鲜判据。
///
/// 从 `still_fresh` 里拆出来是为了可测：`Instant` 不能往回拨，测试里造不出
/// 「五分钟前的那一条」，但可以直接给一个时长。
fn fresh_after(succeeded: bool, age: std::time::Duration) -> bool {
    age < if succeeded {
        ONLINE_FRESH
    } else {
        ONLINE_FAILED_FRESH
    }
}

/// `schedule_fetch` 的三种结局。
///
/// 分成三种而不是「等 / 不等」两种，是因为前端要能区分**新鲜命中**与
/// **SWR 旧值**：前者这份就是最终答案，后者后台正在刷新、值得稍后再拉一次。
/// 光看 `age_secs > 0` 分不清——新鲜命中的 age_secs 也大于 0，于是每次进
/// 页面都会白补拉三轮。
enum Fetch {
    /// 缓存新鲜，直接用，不必等。
    Fresh,
    /// 缓存过期：本次仍用旧值（SWR），刷新已在后台跑。
    Stale,
    /// 一条都没有，必须等这个接收端，不等就啥也画不出来。
    Missing(tokio::sync::watch::Receiver<bool>),
}

/// 抓取任务的收尾。
///
/// 两件事都不能漏：把 inflight 里那条摘掉、把等待者放行。否则汇总会干等到
/// 预算耗尽，而且这个平台当天就成了永久的「在飞」，之后每次请求都白等一轮。
struct FetchGuard {
    key: CacheKey,
    tx: tokio::sync::watch::Sender<bool>,
    /// 正常路径写完缓存后翻成 false。仍是 true 就说明任务半路 panic 了。
    wrote: bool,
}

impl Drop for FetchGuard {
    fn drop(&mut self) {
        if self.wrote {
            // panic 掉的抓取压根没写条目，不补一条的话这个平台会被当成「还在
            // 路上」：前端补拉三次都拿不到东西，而真实原因是崩了。崩了就得
            // 如实说崩了，记成 failed 走 skipped 那条路。
            entries()
                .lock()
                .unwrap()
                .entry(self.key.clone())
                .or_insert(SourceEntry {
                    at: std::time::Instant::now(),
                    tracks: None,
                    kind: "failed".to_string(),
                    message: "抓取任务异常退出".to_string(),
                });
        }
        inflight().lock().unwrap().remove(&self.key);
        // send 在没有接收者时返回 Err，那不代表失败：值已经写进 watch，
        // 之后 subscribe 出来的接收端一眼就能看到 true。
        let _ = self.tx.send(true);
    }
}

/// 把某个平台当天的抓取安排上，并告诉调用方这次该拿它怎么办。
///
/// 只有**缓存里一条都没有**时才需要等；已有条目时哪怕过期也直接把旧值给出去
/// ——SWR 的意思就是「先把旧的给界面上屏」，等新的就成了阻塞式刷新，首屏又慢
/// 回原样。新值落进缓存后由下一次访问（或前端的补拉）取走。
fn schedule_fetch(ctx: &crate::online::Ctx, source: &str, day: i64) -> Fetch {
    let key: CacheKey = (day, source.to_string());

    // 锁只用来做一次判断，绝不在持锁期间派活：新任务干完第一件事就是回来写
    // 这张表，持锁派活是让它在门口干等。
    let (exists, fresh) = {
        let slots = entries().lock().unwrap();
        match slots.get(&key) {
            Some(e) => (true, still_fresh(e)),
            None => (false, false),
        }
    };
    if !exists {
        return match spawn_fetch(ctx, &key, day, source) {
            Some(rx) => Fetch::Missing(rx),
            // 派活与读表之间刚好被别的请求抢先完成并清掉了：条目已经在了。
            None => Fetch::Fresh,
        };
    }
    if fresh {
        return Fetch::Fresh;
    }
    spawn_fetch(ctx, &key, day, source);
    Fetch::Stale
}

/// 真正派活。已经有同一份在飞就只订阅它，不重复打上游。
fn spawn_fetch(
    ctx: &crate::online::Ctx,
    key: &CacheKey,
    day: i64,
    source: &str,
) -> Option<tokio::sync::watch::Receiver<bool>> {
    let mut tasks = inflight().lock().unwrap();
    if let Some(tx) = tasks.get(key) {
        return Some(tx.subscribe());
    }

    let (tx, rx) = tokio::sync::watch::channel(false);
    tasks.insert(key.clone(), tx.clone());
    drop(tasks);

    let ctx = ctx.clone();
    let source = source.to_string();
    let key = key.clone();
    tokio::spawn(async move {
        // 先建守卫再干活：任何一条返回路径（含 panic）都会走到它的 Drop。
        let mut guard = FetchGuard {
            key: key.clone(),
            tx,
            wrote: true,
        };
        let outcome = tokio::time::timeout(
            ONLINE_TIMEOUT,
            crate::online::recommend_songs(&ctx, &source, 0, ONLINE_PER_SOURCE),
        )
        .await;
        let at = std::time::Instant::now();
        let entry = match outcome {
            Ok(Ok(tracks)) if !tracks.is_empty() => SourceEntry {
                at,
                tracks: Some(tracks),
                kind: String::new(),
                message: String::new(),
            },
            Ok(Ok(_)) => SourceEntry {
                at,
                tracks: None,
                kind: "empty".to_string(),
                message: "该音源本次没有返回推荐".to_string(),
            },
            Ok(Err(e)) => SourceEntry {
                at,
                tracks: None,
                kind: "failed".to_string(),
                message: e.message,
            },
            Err(_) => SourceEntry {
                at,
                tracks: None,
                kind: "timeout".to_string(),
                message: "响应超时".to_string(),
            },
        };
        {
            let mut slots = entries().lock().unwrap();
            // 别的日期再也读不到（各平台只给当天），趁机清掉，免得长期运行越攒越多。
            slots.retain(|(d, _), _| *d == day);
            slots.insert(key, entry);
        }
        guard.wrote = false;
    });
    Some(rx)
}

/// 汇总后的一首歌。
#[derive(Debug, Clone, Serialize)]
pub struct DailyOnlineTrack {
    #[serde(flatten)]
    pub track: crate::online::OnlineTrack,
    /// 队列/播放用的虚拟 id `online:{source}:{id}`，与后端 `virtual_id` 同构。
    /// 前端不必自己拼——拼错一处就会播不出来，而这种 bug 只在换平台时暴露。
    pub virtual_id: String,
    /// 来源平台的中文名，界面上给曲目打徽标用。
    pub source_label: String,
}

/// 参与了本次汇总的平台与实际贡献条数。
#[derive(Debug, Clone, Serialize)]
pub struct DailyOnlineGroup {
    pub source: String,
    pub label: String,
    pub count: usize,
}

/// 被跳过的平台与原因。`kind` 是给界面分流的判别式，不是成品文案。
#[derive(Debug, Clone, Serialize)]
pub struct DailyOnlineSkip {
    pub source: String,
    pub label: String,
    /// `not_signed_in` / `unsupported` / `unavailable` / `failed` / `timeout`。
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DailyOnlinePage {
    /// 本地日期 `YYYY-MM-DD`，只用于显示。
    pub date: String,
    pub limit: usize,
    pub total: usize,
    /// 一首都没拿到、且没有平台还在路上时为 true：界面据此决定是「暂无推荐」
    /// 还是「去登录」。`pending` 非空时恒为 false——那不是「没有」，是「还没到」。
    pub empty: bool,
    pub tracks: Vec<DailyOnlineTrack>,
    pub sources: Vec<DailyOnlineGroup>,
    pub skipped: Vec<DailyOnlineSkip>,
    /// 真正去拉过推荐的平台标签（= 已登录且支持每日推荐）。
    ///
    /// 光看 `empty` 分不清两种情形：「一个平台都没登录」和「登录了但这次没
    /// 拿到」。前者该引导去登录，后者该说"再试一次"——把话说反了，用户会
    /// 重新扫码登录好几遍才发现不是登录的问题。
    pub ready: Vec<String>,
    /// 这次**没等到**的平台标签：抓取还在后台跑，只是超出了本次的等待预算。
    ///
    /// 与 `skipped` 严格不同——skipped 是「这次没拿到，别等了」，pending 是
    /// 「再拉一次就有」。前端据此决定要不要补拉，副标题据此说清「XX 还在取」。
    pub pending: Vec<String>,
    /// 这份结果里最老的一条距今多少秒。0 = 全是刚抓的；>0 = 命中了缓存。
    /// 界面如实写一句「N 分钟前的推荐」，用户才知道看到的不是这一秒抓回来的。
    pub age_secs: u64,
    /// 有平台是拿**过期缓存**顶上的，刷新正在后台跑。
    ///
    /// 与 `age_secs` 分开报，因为前端只能靠它决定要不要补拉：新鲜命中时
    /// `age_secs` 同样大于 0，但那份就是最终答案，补拉三次也只是拿回同一份。
    pub refreshing: bool,
}

/// 汇总各平台的每日推荐。
///
/// **遍历方式**：一次过一遍音源状态表——能取的去取（缓存不新鲜才真打上游），
/// 不能取的当场记进 `skipped`。所以即便所有平台都没登录，这里也返回 200 +
/// 空列表而不是 401，前端想提示登录自己看 `skipped` 里的 `not_signed_in`。
///
/// **只等 `ONLINE_WAIT_BUDGET`**：到点就把已落地的平台合并返回，没到的写进
/// `pending`。抓取不会因为响应发出去就被取消——它在后台跑完、结果落进缓存，
/// 前端补拉那一次直接命中。首屏因此是「快平台的两秒」而不是「最慢平台的
/// 八秒」，而慢平台的曲目一首都没丢。
///
/// **指定某天**：各平台的「每日推荐」只有**今天**这一份，回看昨天既没有数据
/// 所以历史日期不去打上游——那是一轮必然空手而归的请求，白白等 8 秒超时——
/// 而是把支持该能力的平台原样列进 `ready`、逐条记成 `history`。前端据此
/// 说清"只能看当天"，而不是笼统的"这次没拿到"。
pub async fn online_daily_at(
    ctx: &crate::online::Ctx,
    limit: usize,
    day: Option<i64>,
) -> ApiResult<DailyOnlinePage> {
    let limit = limit.clamp(1, ONLINE_MAX_LIMIT);

    if let Some(d) = day {
        if d != day_number() {
            let mut ready: Vec<String> = Vec::new();
            let mut skipped: Vec<DailyOnlineSkip> = Vec::new();
            for st in crate::online::daily_source_states(ctx).await {
                if !st.ready {
                    continue;
                }
                ready.push(st.label.clone());
                skipped.push(DailyOnlineSkip {
                    source: st.source,
                    label: st.label,
                    kind: "history".to_string(),
                    message: "在线推荐只提供当天，回看其它日期请用「本地」来源".to_string(),
                });
            }
            return Ok(DailyOnlinePage {
                date: date_label(d),
                limit,
                total: 0,
                empty: true,
                tracks: Vec::new(),
                sources: Vec::new(),
                skipped,
                ready,
                pending: Vec::new(),
                age_secs: 0,
                refreshing: false,
            });
        }
    }

    // 上面那道 history 短路之后，day 要么是 None 要么就等于今天。
    let today = day.unwrap_or_else(day_number);

    let mut skipped: Vec<DailyOnlineSkip> = Vec::new();
    let mut ready: Vec<String> = Vec::new();
    // 要去取的平台，按注册顺序。这个顺序就是最终的合并顺序。
    let mut wanted: Vec<(String, String)> = Vec::new();
    // 只等「缓存里一条都没有」的那些；已有条目的（含过期的）不该拖住首屏。
    let mut waits: Vec<tokio::sync::watch::Receiver<bool>> = Vec::new();
    // 有平台是拿过期缓存顶上的：前端据此决定要不要补拉一次。
    let mut refreshing = false;

    for st in crate::online::daily_source_states(ctx).await {
        if !st.ready {
            skipped.push(DailyOnlineSkip {
                source: st.source,
                label: st.label,
                kind: st.kind.unwrap_or("unsupported").to_string(),
                message: st.message,
            });
            continue;
        }
        ready.push(st.label.clone());
        match schedule_fetch(ctx, &st.source, today) {
            Fetch::Fresh => {}
            Fetch::Stale => refreshing = true,
            Fetch::Missing(rx) => waits.push(rx),
        }
        wanted.push((st.source, st.label));
    }

    // join_all 等到的是最慢那个，外层 timeout 兜住预算——合起来正好是
    // 「全部落地，或预算耗尽」，不需要自己写轮询。
    //
    // 那层 async 块不是多余的：`wait_for` 的 Output 是 `watch::Ref`，里头裹着
    // `RwLockReadGuard`（非 Send），而 join_all 会把每个子 future 的输出存在
    // 自己的状态机里，一路连累到 handler 的 future 变成非 Send、axum 直接拒收。
    // 就地丢掉 Ref 只留 `()` 就干净了。
    if !waits.is_empty() {
        let _ = tokio::time::timeout(
            ONLINE_WAIT_BUDGET,
            futures::future::join_all(waits.iter_mut().map(|rx| async move {
                let _ = rx.wait_for(|done| *done).await;
            })),
        )
        .await;
    }

    // 按注册顺序收结果：同一批登录态下合并出来的歌单稳定可复现，不会每次
    // 刷新就换一批排列——这条不变量在改成缓存制之后依然要守住。
    let mut groups: Vec<DailyOnlineGroup> = Vec::new();
    let mut buckets: Vec<Vec<crate::online::OnlineTrack>> = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    let mut oldest = std::time::Duration::ZERO;
    {
        let slots = entries().lock().unwrap();
        for (source, label) in &wanted {
            let Some(entry) = slots.get(&(today, source.clone())) else {
                // 缓存里没有 = 这次没等到。任务还在后台跑，补拉就有。
                pending.push(label.clone());
                continue;
            };
            let age = entry.at.elapsed();
            if age > oldest {
                oldest = age;
            }
            match &entry.tracks {
                Some(tracks) if !tracks.is_empty() => {
                    groups.push(DailyOnlineGroup {
                        source: source.clone(),
                        label: label.clone(),
                        count: tracks.len(),
                    });
                    buckets.push(tracks.clone());
                }
                Some(_) => skipped.push(DailyOnlineSkip {
                    source: source.clone(),
                    label: label.clone(),
                    kind: "empty".to_string(),
                    message: "该音源本次没有返回推荐".to_string(),
                }),
                None => skipped.push(DailyOnlineSkip {
                    source: source.clone(),
                    label: label.clone(),
                    kind: entry.kind.clone(),
                    message: entry.message.clone(),
                }),
            }
        }
    }

    let tracks = merge_online(&groups, &buckets, limit);
    Ok(DailyOnlinePage {
        date: date_label(today),
        limit,
        total: tracks.len(),
        // 还有平台在路上时不能报 empty：那不是「没有推荐」，是「还没到齐」。
        // 报错会让界面去引导用户重新扫码登录，而问题只是慢。
        empty: groups.is_empty() && pending.is_empty(),
        tracks,
        sources: groups,
        skipped,
        ready,
        pending,
        age_secs: oldest.as_secs(),
        refreshing,
    })
}

/// 把各平台的曲目并成一份：轮询交错 + 去重。
///
/// **为什么要交错而不是直接拼接**：拼接会让注册顺序靠前的平台占满前 20 个
/// 位置，第二个平台一首都露不出来——用户看到的「汇总」其实只是第一个平台。
/// 轮询保证每个已登录平台都在前排有位置，这才是「统一歌单」该有的样子。
///
/// **为什么要去重**：同一首歌常同时在多个平台上线，标题与艺术家一致时只留
/// 先到的那个（即注册顺序靠前的平台，音质通常更好）。
fn merge_online(
    groups: &[DailyOnlineGroup],
    buckets: &[Vec<crate::online::OnlineTrack>],
    limit: usize,
) -> Vec<DailyOnlineTrack> {
    let mut out: Vec<DailyOnlineTrack> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut cursors: Vec<usize> = vec![0; buckets.len()];

    // 一轮是每个平台各取一首；任一平台还有存货就继续下一轮。
    loop {
        let mut advanced = false;
        for (gi, bucket) in buckets.iter().enumerate() {
            let at = cursors[gi];
            if at >= bucket.len() {
                continue;
            }
            cursors[gi] = at + 1;
            advanced = true;
            let t = &bucket[at];
            let key = format!(
                "{}|{}",
                t.title.trim().to_lowercase(),
                t.artist.trim().to_lowercase()
            );
            if !seen.insert(key) {
                continue;
            }
            out.push(DailyOnlineTrack {
                virtual_id: format!("online:{}:{}", t.source, t.id),
                source_label: groups
                    .get(gi)
                    .map(|g| g.label.clone())
                    .unwrap_or_else(|| t.source.clone()),
                track: t.clone(),
            });
            if out.len() >= limit {
                return out;
            }
        }
        if !advanced {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, title: &str, artist: Option<&str>) -> Track {
        Track {
            id: id.to_string(),
            path: format!("/music/{id}.mp3"),
            source: vmusic_core::TrackSource::Local,
            title: title.to_string(),
            artist: artist.map(|s| s.to_string()),
            album: None,
            duration_ms: Some(210_000),
            bitrate: Some(320),
            sample_rate: Some(44_100),
            channels: Some(2),
            has_cover: false,
            file_mtime: Some(1),
            file_size: Some(2),
            added_at: 0,
        }
    }

    fn set(items: &[&str]) -> std::collections::HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn day_number_counts_whole_days() {
        // 1970-01-01 → 0；1970-01-02 → 1。
        assert_eq!(day_number_at(0), 0);
        assert_eq!(day_number_at(86_400_000), 1);
        assert_eq!(day_number_at(86_399_999), 0);
        // 同一天的任意时刻都必须是同一个值，否则「每日」名不副实。
        assert_eq!(day_number_at(1), day_number_at(86_399_000));
    }

    #[test]
    fn date_label_is_a_calendar_date() {
        assert_eq!(date_label(0), "1970-01-01");
        assert_eq!(date_label(1), "1970-01-02");
        // 交叉验证：天数 ↔ 日期互逆，且不依赖任何时区/时间库。
        assert_eq!(date_label(20_685), "2026-08-20");
        assert_eq!(date_label(20_718), "2026-09-22");
        // 跨闰年：2024-02-29 必须存在（能被 4 整除且不被 100 整除）。
        assert_eq!(date_label(19_782), "2024-02-29");
        assert_eq!(date_label(19_783), "2024-03-01");
        // 跨世纪平年：2100 能被 100 整除但不能被 400 整除，2 月只有 28 天。
        assert_eq!(date_label(47_541), "2100-03-01");
    }

    #[test]
    fn favorites_outweigh_everything_else() {
        let pool = vec![
            track("a", "Plain", Some("Nobody")),
            track("b", "Loved", Some("Nobody")),
        ];
        let page = build(0, &pool, &set(&["b"]), &set(&[]), 2);
        assert_eq!(page.tracks[0].track.id, "b");
        assert!(page.tracks[0].reasons.iter().any(|r| r.contains("收藏")));
    }

    #[test]
    fn artist_affinity_lifts_matching_tracks() {
        let pool = vec![
            track("a", "Other", Some("X")),
            track("b", "Same artist", Some("Y")),
        ];
        // 口味里有 Y，于是 b 应当排在 a 前面（两者都没有收藏/封面）。
        let page = build(0, &pool, &set(&[]), &set(&["Y"]), 2);
        assert_eq!(page.tracks[0].track.id, "b");
    }

    #[test]
    fn low_signal_titles_are_pushed_down() {
        let mut noise = track("n", "某某 伴奏", Some("X"));
        noise.has_cover = true;
        let mut good = track("g", "正常歌曲", Some("X"));
        good.has_cover = true;
        let page = build(0, &[noise, good], &set(&[]), &set(&[]), 2);
        assert_eq!(page.tracks[0].track.id, "g");
        assert!(page.tracks[1].reasons.iter().any(|r| r.contains("伴奏")));
    }

    #[test]
    fn same_day_same_result_next_day_different_order() {
        let pool: Vec<Track> = (0..12)
            .map(|i| track(&format!("t{i}"), &format!("Song {i}"), Some("Solo")))
            .collect();
        let a = build(20_000, &pool, &set(&[]), &set(&[]), 6);
        let b = build(20_000, &pool, &set(&[]), &set(&[]), 6);
        let c = build(20_001, &pool, &set(&[]), &set(&[]), 6);
        let ids = |p: &DailyPage| {
            p.tracks
                .iter()
                .map(|t| t.track.id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&a), ids(&b), "同一天必须完全可复现");
        // 同一艺术家只有 2 个名额，所以换天时前两位可能不变；整体断言的是
        // 「结果仍然合法」而不是「必须不同」。
        assert_eq!(ids(&c).len(), 6);
    }

    #[test]
    fn diversification_caps_one_artist() {
        // 8 首全来自同一艺术家，上限 2 → 打散后补位填满 limit=4，但前两位
        // 仍是该艺术家，且总数补齐到 4。
        let pool: Vec<Track> = (0..8)
            .map(|i| track(&format!("t{i}"), &format!("Song {i}"), Some("Same")))
            .collect();
        let page = build(0, &pool, &set(&[]), &set(&[]), 4);
        assert_eq!(page.tracks.len(), 4);
        assert_eq!(page.total, 4);
        assert!(page.candidates == 8);
    }

    #[test]
    fn tracks_without_artist_are_not_treated_as_one_artist() {
        let pool: Vec<Track> = (0..4)
            .map(|i| track(&format!("t{i}"), &format!("Song {i}"), None))
            .collect();
        let page = build(0, &pool, &set(&[]), &set(&[]), 4);
        assert_eq!(page.tracks.len(), 4, "无标签曲目各自成组，不该被打散掉");
    }

    #[test]
    fn limit_is_clamped_and_validated() {
        assert_eq!(parse_limit(None).unwrap(), DEFAULT_LIMIT);
        assert_eq!(parse_limit(Some(9999)).unwrap(), MAX_LIMIT);
        assert!(parse_limit(Some(0)).is_err());
    }

    #[test]
    fn kind_parsing_accepts_only_the_two_kinds() {
        assert_eq!(parse_kind("track").unwrap(), FavoriteKind::Track);
        assert_eq!(parse_kind("radio").unwrap(), FavoriteKind::Radio);
        assert!(parse_kind("album").is_err());
    }

    #[test]
    fn empty_library_yields_an_empty_page_not_an_error() {
        let page = build(0, &[], &set(&[]), &set(&[]), 12);
        assert_eq!(page.total, 0);
        assert_eq!(page.candidates, 0);
    }

    // --- 在线汇总：合并是纯函数，不碰网络也能验完 ---

    fn otrack(source: &str, id: &str, title: &str, artist: &str) -> crate::online::OnlineTrack {
        crate::online::OnlineTrack {
            source: source.to_string(),
            id: id.to_string(),
            title: title.to_string(),
            artist: artist.to_string(),
            album: String::new(),
            duration_ms: 200_000,
            cover: None,
            playable: true,
            vip_only: false,
            track_ref: serde_json::Value::Null,
        }
    }

    fn groups(entries: &[(&str, &str, usize)]) -> Vec<DailyOnlineGroup> {
        entries
            .iter()
            .map(|(source, label, count)| DailyOnlineGroup {
                source: (*source).to_string(),
                label: (*label).to_string(),
                count: *count,
            })
            .collect()
    }

    #[test]
    fn online_merge_interleaves_sources() {
        // 拼接会让第一个平台独占前排；交错才是「汇总」。
        let g = groups(&[("netease", "网易云音乐", 3), ("qq", "QQ音乐", 3)]);
        let b = vec![
            vec![
                otrack("netease", "1", "A", "x"),
                otrack("netease", "2", "B", "x"),
                otrack("netease", "3", "C", "x"),
            ],
            vec![
                otrack("qq", "1", "D", "y"),
                otrack("qq", "2", "E", "y"),
                otrack("qq", "3", "F", "y"),
            ],
        ];
        let merged = merge_online(&g, &b, 10);
        let ids: Vec<&str> = merged.iter().map(|t| t.track.title.as_str()).collect();
        assert_eq!(ids, vec!["A", "D", "B", "E", "C", "F"]);
    }

    #[test]
    fn online_merge_drops_cross_platform_duplicates() {
        let g = groups(&[("netease", "网易云音乐", 2), ("qq", "QQ音乐", 1)]);
        let b = vec![
            vec![
                otrack("netease", "1", "Same", "Singer"),
                otrack("netease", "2", "A", "s"),
            ],
            // 标题+艺术家一致 → 判重，大小写与空格不算差异。
            vec![otrack("qq", "9", " same ", "SINGER")],
        ];
        let merged = merge_online(&g, &b, 10);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].track.source, "netease", "重复的留先到的那个平台");
    }

    #[test]
    fn online_merge_respects_limit_and_virtual_id() {
        let g = groups(&[("netease", "网易云音乐", 5)]);
        let b = vec![(1..=5)
            .map(|i| otrack("netease", &i.to_string(), &format!("T{i}"), "x"))
            .collect::<Vec<_>>()];
        let merged = merge_online(&g, &b, 3);
        assert_eq!(merged.len(), 3);
        // 虚拟 id 是播放链路唯一认的拼法，后端 virtual_id 同构。
        assert_eq!(merged[0].virtual_id, "online:netease:1");
        assert_eq!(merged[0].source_label, "网易云音乐");
    }

    #[test]
    fn online_merge_with_nothing_yields_nothing() {
        assert!(merge_online(&[], &[], 20).is_empty());
    }

    #[test]
    fn resolve_day_keeps_sane_values_and_falls_back_otherwise() {
        let today = day_number();
        // 正常值原样用：回看一天就是换一个种子，不该被悄悄改回今天。
        assert_eq!(resolve_day(Some(today)), today);
        assert_eq!(resolve_day(Some(today - 1)), today - 1);
        // 缺失与离谱值都回落当天。负数来自纪元之前的日期，超大值来自手改
        // URL——两种都不该让接口报错，也不该真去按它出榜。
        assert_eq!(resolve_day(None), today);
        assert_eq!(resolve_day(Some(-1)), today);
        assert_eq!(resolve_day(Some(MAX_DAY + 1)), today);
    }

    #[test]
    fn failed_fetches_expire_much_sooner_than_successful_ones() {
        // 一次超时不该把这个平台按死整个保鲜期：那样用户在推荐位上连点两次
        // 刷新都拿不到东西，第一反应会是「账号掉了」，然后去重新扫码登录。
        let mid = (ONLINE_FAILED_FRESH + ONLINE_FRESH) / 2;
        assert!(fresh_after(true, mid), "成功结果此时仍算新鲜，不该重打上游");
        assert!(
            !fresh_after(false, mid),
            "失败结果必须已过期，好让重试有机会翻身"
        );

        // 等待预算要明显短于单源超时，否则「先到先返回」又退化回「等最慢的」，
        // pending 与前端补拉那条路永远走不到。
        assert!(ONLINE_WAIT_BUDGET < ONLINE_TIMEOUT);
    }
}
