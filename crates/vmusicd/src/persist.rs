// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 播放器偏好（音量/模式）的持久化。权威存储是 settings 表。

use serde_json::Value;
use sqlx::SqlitePool;
use vmusic_core::PlayMode;

pub const VOLUME_KEY: &str = "player_volume";
pub const MODE_KEY: &str = "player_mode";

/// null / 非数字 / 越界一律回落到 `fallback`。
pub fn parse_volume(value: Option<&Value>, fallback: f32) -> f32 {
    value
        .and_then(Value::as_f64)
        .map(|v| v.clamp(0.0, 1.0) as f32)
        .unwrap_or(fallback)
}

pub fn parse_mode(value: Option<&Value>, fallback: PlayMode) -> PlayMode {
    match value.and_then(Value::as_str) {
        Some("repeat") => PlayMode::Repeat,
        Some("repeat_one") => PlayMode::RepeatOne,
        Some("shuffle") => PlayMode::Shuffle,
        _ => fallback,
    }
}

async fn put(pool: &SqlitePool, key: &str, value: Value) {
    // 写库失败不阻断播放：快照仍是正确值，tracing 留痕。
    if let Err(e) = vmusic_store::settings::set(pool, key, &value).await {
        tracing::warn!("持久化 {key} 失败: {e}");
    }
}

pub async fn save_volume(pool: &SqlitePool, volume: f32) {
    put(pool, VOLUME_KEY, Value::from(volume.clamp(0.0, 1.0) as f64)).await;
}

pub async fn save_mode(pool: &SqlitePool, mode: PlayMode) {
    let s = match mode {
        PlayMode::Repeat => "repeat",
        PlayMode::RepeatOne => "repeat_one",
        PlayMode::Shuffle => "shuffle",
    };
    put(pool, MODE_KEY, Value::from(s)).await;
}

/// 启动时读偏好；缺键/坏值回落到传入默认。
pub async fn load_player_prefs(
    pool: &SqlitePool,
    fallback_volume: f32,
    fallback_mode: PlayMode,
) -> (f32, PlayMode) {
    let all = match vmusic_store::settings::get_all(pool).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("读取播放器偏好失败，使用默认值: {e}");
            return (fallback_volume, fallback_mode);
        }
    };
    (
        parse_volume(all.get(VOLUME_KEY), fallback_volume),
        parse_mode(all.get(MODE_KEY), fallback_mode),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn volume_rejects_bad_values_and_clamps() {
        assert_eq!(parse_volume(Some(&json!(0.4)), 0.8), 0.4);
        assert_eq!(parse_volume(Some(&json!(2.0)), 0.8), 1.0);
        assert_eq!(parse_volume(Some(&json!(-1.0)), 0.8), 0.0);
        assert_eq!(parse_volume(Some(&json!("0.5")), 0.8), 0.8);
        assert_eq!(parse_volume(None, 0.8), 0.8);
    }

    #[test]
    fn mode_parses_known_variants() {
        assert_eq!(
            parse_mode(Some(&json!("shuffle")), PlayMode::Repeat),
            PlayMode::Shuffle
        );
        assert_eq!(
            parse_mode(Some(&json!("repeat_one")), PlayMode::Shuffle),
            PlayMode::RepeatOne
        );
        assert_eq!(
            parse_mode(Some(&json!("bogus")), PlayMode::Shuffle),
            PlayMode::Shuffle
        );
        assert_eq!(parse_mode(None, PlayMode::RepeatOne), PlayMode::RepeatOne);
    }
}
