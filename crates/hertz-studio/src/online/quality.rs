// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 跨音源统一音质档位与逐源偏好（settings 键 online_quality）。

use serde_json::Value;
use sqlx::SqlitePool;
use vmusic_core::StoreError;

pub const PREFS_KEY: &str = "online_quality";

/// 统一四档（顺序即 rank 从低到高）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quality {
    Standard,
    Exhigh,
    Lossless,
    Hires,
}

impl Quality {
    pub fn as_str(self) -> &'static str {
        match self {
            Quality::Standard => "standard",
            Quality::Exhigh => "exhigh",
            Quality::Lossless => "lossless",
            Quality::Hires => "hires",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Quality::Standard => "标准",
            Quality::Exhigh => "高品 320k",
            Quality::Lossless => "无损",
            Quality::Hires => "Hi-Res",
        }
    }

    pub fn rank(self) -> u8 {
        match self {
            Quality::Standard => 1,
            Quality::Exhigh => 2,
            Quality::Lossless => 3,
            Quality::Hires => 4,
        }
    }

    /// 传给平台 stream(quality: Option<u32>) 的标称码率（bps）。
    pub fn bps(self) -> u32 {
        match self {
            Quality::Standard => 128_000,
            Quality::Exhigh => 320_000,
            Quality::Lossless => 740_000,
            Quality::Hires => 999_000,
        }
    }

    /// 紧邻的下一档，已是最低档时 None。运行时音质上限用它降档：一次失败只
    /// 该让这首退一格，一路退到底会把「上游抖了一下」放大成永久降级。
    pub fn one_down(self) -> Option<Quality> {
        Quality::descending_from(self).get(1).copied()
    }

    /// 别名归一化：320k/hq → exhigh，flac/sq → lossless，master/svip → hires。
    pub fn parse(raw: &str) -> Option<Quality> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "standard" | "128k" | "normal" | "lq" => Some(Quality::Standard),
            "exhigh" | "320k" | "hq" | "high" => Some(Quality::Exhigh),
            "lossless" | "flac" | "sq" => Some(Quality::Lossless),
            "hires" | "hireslossless" | "master" | "svip" => Some(Quality::Hires),
            _ => None,
        }
    }

    /// 从自己这一档起逐级向下（含自身，高→低）。
    ///
    /// 缓存查找要用它：阶梯降级或码率诚实闸门会把实际拿到的低档按**实测档位**
    /// 落盘（见 progressive::relabel_key），只查请求档位的话，「请求无损、上游
    /// 最多给 320k」的曲子每次播放都会重下一遍。
    pub fn descending_from(self) -> Vec<Quality> {
        [
            Quality::Standard,
            Quality::Exhigh,
            Quality::Lossless,
            Quality::Hires,
        ]
        .into_iter()
        .filter(|q| q.rank() <= self.rank())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
    }
}

pub fn default_for(source: &str) -> Quality {
    super::provider::find(source)
        .map(|p| p.quality.default)
        .unwrap_or(super::provider::QualityProfile::STANDARD.default)
}

/// Provider 登记的可选档位；单档源不进入音质设置列表。
pub fn allowed_for(source: &str) -> &'static [Quality] {
    super::provider::find(source)
        .map(|p| p.quality.allowed)
        .unwrap_or(super::provider::QualityProfile::STANDARD.allowed)
}

/// 不允许的档位夹到最近的合法档。
pub fn clamp_to_allowed(source: &str, q: Quality) -> Quality {
    let allowed = allowed_for(source);
    if allowed.contains(&q) {
        return q;
    }
    *allowed
        .iter()
        .filter(|cand| cand.rank() <= q.rank())
        .max_by_key(|cand| cand.rank())
        .unwrap_or(&allowed[0])
}

pub type QualityPrefs = std::collections::BTreeMap<String, Quality>;

pub fn from_value(value: Option<&Value>) -> QualityPrefs {
    let mut out = QualityPrefs::new();
    if let Some(Value::Object(map)) = value {
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                let q = Quality::parse(s).unwrap_or_else(|| default_for(k));
                out.insert(k.clone(), clamp_to_allowed(k, q));
            }
        }
    }
    out
}

pub fn to_value(prefs: &QualityPrefs) -> Value {
    let mut map = serde_json::Map::new();
    for (k, q) in prefs {
        map.insert(k.clone(), Value::from(q.as_str()));
    }
    Value::Object(map)
}

pub async fn load(pool: &SqlitePool) -> Result<QualityPrefs, StoreError> {
    Ok(from_value(
        vmusic_store::settings::get(pool, PREFS_KEY).await?.as_ref(),
    ))
}

/// 取某源当前档位（缺省 → 默认并夹到合法档）。
pub fn get(prefs: &QualityPrefs, source: &str) -> Quality {
    clamp_to_allowed(source, *prefs.get(source).unwrap_or(&default_for(source)))
}

pub async fn save_source(
    pool: &SqlitePool,
    prefs: &mut QualityPrefs,
    source: &str,
    raw: &str,
) -> Result<Quality, StoreError> {
    let q = clamp_to_allowed(
        source,
        Quality::parse(raw).unwrap_or_else(|| default_for(source)),
    );
    prefs.insert(source.to_string(), q);
    vmusic_store::settings::set(pool, PREFS_KEY, &to_value(prefs)).await?;
    Ok(q)
}

/// 平台实际返回码率反推档位（"实际档位"标注用）。
pub fn from_bitrate(bps: Option<u64>) -> Option<Quality> {
    let b = bps?;
    Some(if b >= 900_000 {
        Quality::Hires
    } else if b >= 600_000 {
        Quality::Lossless
    } else if b >= 256_000 {
        Quality::Exhigh
    } else {
        Quality::Standard
    })
}

// 每轨的**运行时**音质上限怎么动。两个纯函数放在一起，是为了让「只降不升」这条
// 能被单独钉住：它决定「按第二次重试」会不会又撞上同一档必然失败的取流。
//
// 上限只活在内存（见 `crate::state::AppState::quality_caps`），落盘的档位偏好不
// 受它影响：用户选的那一档永远是他看得见的意图，上限只是这首曲子的证据。进程
// 重启即忘记，等于给它一次重新尝试高档的机会。
//
// 记在**曲目**而不是音源：同一平台上无损对某首 VIP 曲失败、对隔壁普通曲成功，
// 按源记会把好曲子一起拖低。

/// 记一次失败后这首的上限：退到失败档的下一格。返回 `None` 表示整表不动，
/// 两种情形各有一半理由：已是最低档（下面没有档可退了），或这次失败的档位
/// 比现有上限还高（那已经是被夹住的一档，不能再「降」出一个更高的上限——
/// 抬高上限正是「弹回高档」这个要防的失败）。调用方据返回值决定要不要通知。
pub fn lower_ceiling(prev: Option<Quality>, failed_at: Quality) -> Option<Quality> {
    let next = failed_at.one_down()?;
    match prev {
        Some(p) if p.rank() <= next.rank() => None,
        _ => Some(next),
    }
}

/// 这次播放该瞄哪一档：把偏好档夹进这首已确认的上限内。播放、预取、解码失败
/// 收口三处都走它，否则预取会绕开上限把刚失败过的高档请求原样再发一遍。
pub fn clamp_request(want: Quality, ceiling: Option<Quality>) -> Quality {
    match ceiling {
        Some(c) if c.rank() < want.rank() => c,
        _ => want,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn aliases_normalize() {
        assert_eq!(Quality::parse("320k"), Some(Quality::Exhigh));
        assert_eq!(Quality::parse("FLAC"), Some(Quality::Lossless));
        assert_eq!(Quality::parse("weird"), None);
        assert!(Quality::Hires.rank() > Quality::Standard.rank());
    }

    /// 向下找缓存时的档位顺序：含自身、高→低，且不能越过请求档位。
    #[test]
    fn descending_tiers_start_at_the_requested_one() {
        assert_eq!(
            Quality::descending_from(Quality::Hires),
            vec![
                Quality::Hires,
                Quality::Lossless,
                Quality::Exhigh,
                Quality::Standard
            ]
        );
        assert_eq!(
            Quality::descending_from(Quality::Exhigh),
            vec![Quality::Exhigh, Quality::Standard]
        );
        assert_eq!(
            Quality::descending_from(Quality::Standard),
            vec![Quality::Standard]
        );
    }

    #[test]
    fn defaults_and_allowed_tables() {
        assert_eq!(default_for("netease"), Quality::Hires);
        assert_eq!(default_for("qishui"), Quality::Standard);
        assert_eq!(default_for("kuwo"), Quality::Exhigh);
        assert!(!allowed_for("kugou").contains(&Quality::Hires));
        assert!(!allowed_for("kuwo").contains(&Quality::Hires));
        assert_eq!(
            clamp_to_allowed("qishui", Quality::Hires),
            Quality::Standard
        );
        assert_eq!(clamp_to_allowed("kugou", Quality::Hires), Quality::Lossless);
        assert_eq!(clamp_to_allowed("kuwo", Quality::Hires), Quality::Lossless);
    }

    #[test]
    fn prefs_round_trip_and_drop_garbage() {
        let v = json!({"netease":"lossless","qq":"bogus"});
        let prefs = from_value(Some(&v));
        assert_eq!(prefs.get("netease"), Some(&Quality::Lossless));
        assert_eq!(prefs.get("qq"), Some(&Quality::Lossless));
        let again = from_value(Some(&to_value(&prefs)));
        assert_eq!(again.get("netease"), Some(&Quality::Lossless));
    }

    #[test]
    fn bitrate_maps_back_to_tier() {
        assert_eq!(from_bitrate(Some(128_000)), Some(Quality::Standard));
        assert_eq!(from_bitrate(Some(320_000)), Some(Quality::Exhigh));
        assert_eq!(from_bitrate(Some(740_000)), Some(Quality::Lossless));
        assert_eq!(from_bitrate(None), None);
    }

    /// 下一格只走一格，最低档没有下一格。
    #[test]
    fn one_down_steps_a_single_rung() {
        assert_eq!(Quality::Hires.one_down(), Some(Quality::Lossless));
        assert_eq!(Quality::Lossless.one_down(), Some(Quality::Exhigh));
        assert_eq!(Quality::Exhigh.one_down(), Some(Quality::Standard));
        assert_eq!(Quality::Standard.one_down(), None);
    }

    /// 上限只降不升：更低的证据来了就再退一格，比现有上限高的证据一律不动它。
    #[test]
    fn ceiling_only_moves_down() {
        assert_eq!(lower_ceiling(None, Quality::Hires), Some(Quality::Lossless));
        // 在现有上限那一档上又失败：继续往下退一格（这才是「失败即降档」）。
        assert_eq!(
            lower_ceiling(Some(Quality::Lossless), Quality::Lossless),
            Some(Quality::Exhigh)
        );
        // 更低档失败：收到再下一格。
        assert_eq!(
            lower_ceiling(Some(Quality::Lossless), Quality::Exhigh),
            Some(Quality::Standard)
        );
        // 失败发生在比现有上限更低的档：不能把它「抬」回上一格。
        assert_eq!(
            lower_ceiling(Some(Quality::Standard), Quality::Lossless),
            None,
            "现有上限更低时整表不动"
        );
        // 现有上限低于「失败档的下一格」：同样不许抬高。
        assert_eq!(lower_ceiling(Some(Quality::Exhigh), Quality::Hires), None);
        // 最低档没有下一格。
        assert_eq!(lower_ceiling(None, Quality::Standard), None);
    }

    #[test]
    fn request_is_clamped_into_the_ceiling() {
        assert_eq!(
            clamp_request(Quality::Hires, Some(Quality::Exhigh)),
            Quality::Exhigh
        );
        // 上限比偏好高不构成夹取：不能因为某首曾在无损失败过就把 320k 的偏好
        // 强行升到无损去试。
        assert_eq!(
            clamp_request(Quality::Exhigh, Some(Quality::Lossless)),
            Quality::Exhigh
        );
        assert_eq!(clamp_request(Quality::Hires, None), Quality::Hires);
        assert_eq!(
            clamp_request(Quality::Standard, Some(Quality::Standard)),
            Quality::Standard
        );
    }
}
