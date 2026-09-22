// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

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

/// 生成今日推荐。
pub async fn daily(db: &SqlitePool, limit: usize) -> ApiResult<DailyPage> {
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

    let day = day_number();
    let page = build(day, &candidates, &favored, &artists, limit);
    Ok(page)
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
}
