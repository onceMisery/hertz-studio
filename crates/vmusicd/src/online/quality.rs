// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

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
}

pub fn default_for(source: &str) -> Quality {
    match source {
        "netease" => Quality::Hires,
        "qq" | "kugou" => Quality::Lossless,
        // 酷我匿名拿不到无损（请求会被降级/给试听），默认档避免每次必失败。
        "kuwo" => Quality::Exhigh,
        _ => Quality::Standard,
    }
}

pub fn allowed_for(source: &str) -> &'static [Quality] {
    match source {
        "netease" | "qq" => &[
            Quality::Standard,
            Quality::Exhigh,
            Quality::Lossless,
            Quality::Hires,
        ],
        "kugou" | "kuwo" => &[Quality::Standard, Quality::Exhigh, Quality::Lossless],
        // 汽水加密档不可播、ccmixter 直链无档位：只暴露标准。
        _ => &[Quality::Standard],
    }
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
}
