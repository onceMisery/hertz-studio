// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 播放器偏好（音量/模式）的持久化。权威存储是 settings 表。

use serde_json::Value;
use sqlx::SqlitePool;
use vmusic_core::{PlayMode, StoreError};

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

/// 字符串数组的一般化持久化（缓存保留名单等）。坏值按空表处理。
pub async fn load_strings(pool: &SqlitePool, key: &str) -> Result<Vec<String>, StoreError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    let Some((raw,)) = row else {
        return Ok(Vec::new());
    };
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

/// 会话快照（folia 的 last_song / last_queue 合一份）：重启后恢复队列、
/// 当前曲目与播放进度。播放进度恢复是惰性的——首次 play 时才 seek 回去，
/// 启动路径不做任何网络/解码动作。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SessionSnapshot {
    pub queue: Vec<String>,
    pub cursor: Option<usize>,
    pub position_ms: u64,
    pub saved_at: i64,
}

pub const SESSION_KEY: &str = "session_snapshot";

/// 保存会话快照。写库失败只记日志：快照是尽力而为的恢复，不值得打断播放。
pub async fn save_session(pool: &SqlitePool, snap: &SessionSnapshot) {
    let value = match serde_json::to_value(snap) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("序列化会话快照失败: {e}");
            return;
        }
    };
    if let Err(e) = vmusic_store::settings::set(pool, SESSION_KEY, &value).await {
        tracing::warn!("持久化会话快照失败: {e}");
    }
}

/// 读取会话快照；坏值/缺键/全空按无会话处理（None）。
pub async fn load_session(pool: &SqlitePool) -> Option<SessionSnapshot> {
    let value = vmusic_store::settings::get(pool, SESSION_KEY)
        .await
        .ok()
        .flatten()?;
    let snap: SessionSnapshot = serde_json::from_value(value).ok()?;
    if snap.queue.is_empty() && snap.cursor.is_none() {
        return None;
    }
    Some(snap)
}

pub async fn save_strings(
    pool: &SqlitePool,
    key: &str,
    values: &[String],
) -> Result<(), StoreError> {
    let json =
        serde_json::to_string(values).map_err(|e| StoreError::Serialization(e.to_string()))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(json)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
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
