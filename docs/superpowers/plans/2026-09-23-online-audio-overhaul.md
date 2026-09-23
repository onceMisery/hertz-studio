# 在线音源全面优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在线曲目边下边播秒开、音质档位可选且持久、失败可恢复自动跳曲、音量/模式/播放历史重启可恢复、切歌无爆音。

**Architecture:** 服务端（Rust）新增渐进式下载器（后台 tokio 任务写 `.part` + Condvar 桥接同步解码线程），通过新的 actor 命令 `LoadSource(Box<dyn symphonia MediaSource>)` 直接喂给 symphonia；下载完成原子 rename 进 LRU 缓存。音质/音量/模式存 settings 表，播放历史新增 `play_history` 表。cpal 输出循环加增益斜坡实现淡入淡出。前端零新增依赖。

**Tech Stack:** Rust（tokio / reqwest / sqlx / symphonia 0.5 / cpal / futures）、SQLite migrations、零构建裸 JS、Node 无头契约检查。

**Spec:** [docs/superpowers/specs/2026-09-23-online-audio-overhaul-design.md](../specs/2026-09-23-online-audio-overhaul-design.md)

**相对 spec §13 的一处细化：** 音量/模式/音质偏好的读写助手放进新文件 `crates/vmusicd/src/persist.rs`（spec 只列了 history.rs；persist.rs 承担更贴切），`history.rs` 只管历史表。

**全局约定：**
- 每个任务结束跑 `cargo test -p <crate>` 与相关 `node scripts/check-*.js`，全绿才进下一个任务。
- Windows + PowerShell；测试命令用 `cargo test -p <crate> <name>`。
- 提交粒度跟任务走；提交信息用中文短句（与 git log 风格一致）。
- 不拷贝 Mineradio 任何代码（GPL-3.0），只按本计划写新代码。

---

## Task 1: 迁移 0003 + play_history 数据层

**Files:**
- Create: `migrations/0003_playback_state.sql`
- Create: `crates/vmusicd/src/history.rs`
- Modify: `crates/vmusicd/src/main.rs:12`（加 `mod history;`）

- [ ] **Step 1: 写迁移文件**

```sql
-- 播放历史：本地曲与在线曲统一记录。在线曲的 URL 会过期，所以这里只存
-- 元数据快照，重播时重新实时取流。
CREATE TABLE IF NOT EXISTS play_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id    TEXT NOT NULL UNIQUE,
    source      TEXT NOT NULL,
    ref_id      TEXT NOT NULL,
    title       TEXT NOT NULL,
    artist      TEXT,
    album       TEXT,
    cover_url   TEXT,
    duration_ms INTEGER,
    played_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_play_history_played ON play_history(played_at DESC);
```

- [ ] **Step 2: 新建 `crates/vmusicd/src/history.rs`**

```rust
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 播放历史：upsert 置顶、上限截断、查询与删除。

use serde::Serialize;
use sqlx::SqlitePool;

/// 历史保留条数。超出后删最旧。
pub const HISTORY_LIMIT: i64 = 500;

/// 写入一条历史所需的信息。
#[derive(Debug, Clone)]
pub struct HistoryEntry<'a> {
    /// 本地曲目 id，或 `online:{source}:{ref_id}`。
    pub track_id: &'a str,
    /// `local` / `netease` / `qq` / `kugou` / ...
    pub source: &'a str,
    pub ref_id: &'a str,
    pub title: &'a str,
    pub artist: Option<&'a str>,
    pub album: Option<&'a str>,
    pub cover_url: Option<&'a str>,
    pub duration_ms: Option<u64>,
}

/// 读出形状（驼峰序列化，前端直接消费）。
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct HistoryItem {
    pub id: i64,
    pub track_id: String,
    pub source: String,
    pub ref_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover_url: Option<String>,
    pub duration_ms: Option<i64>,
    pub played_at: i64,
}

/// 插入或把同一曲目顶到最前，然后截断到 [`HISTORY_LIMIT`]。
pub async fn upsert(pool: &SqlitePool, e: HistoryEntry<'_>) -> Result<(), String> {
    let now = vmusic_store::now_ms();
    sqlx::query(
        r#"INSERT INTO play_history
             (track_id, source, ref_id, title, artist, album, cover_url, duration_ms, played_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT(track_id) DO UPDATE SET
             source=excluded.source, ref_id=excluded.ref_id, title=excluded.title,
             artist=excluded.artist, album=excluded.album, cover_url=excluded.cover_url,
             duration_ms=excluded.duration_ms, played_at=excluded.played_at"#,
    )
    .bind(e.track_id)
    .bind(e.source)
    .bind(e.ref_id)
    .bind(e.title)
    .bind(e.artist)
    .bind(e.album)
    .bind(e.cover_url)
    .bind(e.duration_ms.map(|v| v as i64))
    .bind(now)
    .execute(pool)
    .await
    .map_err(|err| err.to_string())?;

    // 保留最近 N 条：先按偏移定位边界，再双条件删除（OFFSET 不能直接配合 DELETE）。
    sqlx::query(
        r#"DELETE FROM play_history WHERE id NOT IN (
             SELECT id FROM play_history ORDER BY played_at DESC, id DESC LIMIT ?1
           )"#,
    )
    .bind(HISTORY_LIMIT)
    .execute(pool)
    .await
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// 倒序取最近 `limit` 条（1..=100）。
pub async fn list_recent(pool: &SqlitePool, limit: i64) -> Result<Vec<HistoryItem>, String> {
    sqlx::query_as::<_, HistoryItem>(
        "SELECT id, track_id, source, ref_id, title, artist, album, cover_url, \
         duration_ms, played_at FROM play_history ORDER BY played_at DESC, id DESC LIMIT ?1",
    )
    .bind(limit.clamp(1, 100))
    .fetch_all(pool)
    .await
    .map_err(|err| err.to_string())
}

pub async fn clear(pool: &SqlitePool) -> Result<u64, String> {
    sqlx::query("DELETE FROM play_history")
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .map_err(|err| err.to_string())
}

pub async fn remove(pool: &SqlitePool, id: i64) -> Result<u64, String> {
    sqlx::query("DELETE FROM play_history WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map(|r| r.rows_affected())
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> SqlitePool {
        let dir = std::env::temp_dir().join(format!("vmusic-history-{}", uuid::Uuid::new_v4()));
        vmusic_store::open(&dir).await.expect("open db")
    }

    fn entry(n: u8) -> HistoryEntry<'static> {
        HistoryEntry {
            track_id: Box::leak(format!("online:netease:{n}").into_boxed_str()),
            source: "netease",
            ref_id: Box::leak(format!("id{n}").into_boxed_str()),
            title: Box::leak(format!("歌曲{n}").into_boxed_str()),
            artist: Some("歌手"),
            album: None,
            cover_url: None,
            duration_ms: Some(200_000),
        }
    }

    #[tokio::test]
    async fn upsert_moves_track_to_top_and_updates_fields() {
        let pool = db().await;
        upsert(&pool, entry(1)).await.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        upsert(&pool, entry(2)).await.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let mut e1 = entry(1);
        e1.title = "歌曲1-改名";
        upsert(&pool, e1).await.unwrap();

        let items = list_recent(&pool, 10).await.unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "歌曲1-改名");
        assert_eq!(items[1].title, "歌曲2");
    }

    #[tokio::test]
    async fn truncates_to_limit() {
        let pool = db().await;
        let total = (HISTORY_LIMIT + 5) as u16;
        for n in 0..total {
            let mut e = entry((n % 250) as u8);
            e.track_id = Box::leak(format!("online:netease:song{n}").into_boxed_str());
            e.ref_id = Box::leak(format!("ref{n}").into_boxed_str());
            upsert(&pool, e).await.unwrap();
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM play_history")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, HISTORY_LIMIT);
    }

    #[tokio::test]
    async fn remove_and_clear_work() {
        let pool = db().await;
        upsert(&pool, entry(9)).await.unwrap();
        let items = list_recent(&pool, 10).await.unwrap();
        assert_eq!(remove(&pool, items[0].id).await.unwrap(), 1);
        assert_eq!(list_recent(&pool, 10).await.unwrap().len(), 0);
        upsert(&pool, entry(8)).await.unwrap();
        assert!(clear(&pool).await.unwrap() >= 1);
    }
}
```

- [ ] **Step 3: 注册模块** —— main.rs 在 `mod online;`（第 12 行）后加 `mod history;`。

- [ ] **Step 4: 跑测试（迁移由 vmusic-store::open 自动执行）**

Run: `cargo test -p vmusicd history::`
Expected: 3 PASS。

- [ ] **Step 5: Commit**

```bash
git add migrations/0003_playback_state.sql crates/vmusicd/src/history.rs crates/vmusicd/src/main.rs
git commit -m "播放历史：迁移与数据层"
```

---

## Task 2: 音量/播放模式持久化与启动恢复

**Files:**
- Create: `crates/vmusicd/src/persist.rs`
- Modify: `crates/vmusicd/src/main.rs:12,110-112`
- Modify: `crates/vmusicd/src/routes.rs:324-354`

- [ ] **Step 1: 新建 persist.rs**

```rust
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
        assert_eq!(parse_mode(Some(&json!("shuffle")), PlayMode::Repeat), PlayMode::Shuffle);
        assert_eq!(parse_mode(Some(&json!("repeat_one")), PlayMode::Shuffle), PlayMode::RepeatOne);
        assert_eq!(parse_mode(Some(&json!("bogus")), PlayMode::Shuffle), PlayMode::Shuffle);
        assert_eq!(parse_mode(None, PlayMode::RepeatOne), PlayMode::RepeatOne);
    }
}
```

- [ ] **Step 2: 注册模块** —— main.rs 在 `mod history;` 后加 `mod persist;`。

- [ ] **Step 3: 跑纯函数测试**

Run: `cargo test -p vmusicd persist::`
Expected: 2 PASS。

- [ ] **Step 4: 启动恢复** —— main.rs:110 的 `audio.set_volume(config.audio.volume).await.ok();` 替换为（仍在 `let state = Arc::new(AppState {..})` 之前）：

```rust
    // 音量/模式以服务端 settings 为权威；缺键才回落到 config 默认。
    let (restore_volume, restore_mode) =
        persist::load_player_prefs(&db, config.audio.volume, vmusic_core::PlayMode::Repeat).await;
    audio.set_volume(restore_volume).await.ok();
    audio.set_mode(restore_mode).await.ok();
```

- [ ] **Step 5: volume handler 落库** —— routes.rs `volume` 函数（324-337 行），在 `state.audio.set_volume(body.volume).await...?;` 之后、`Ok(get_state(...).await)` 之前加：

```rust
    crate::persist::save_volume(&state.db, body.volume).await;
```

- [ ] **Step 6: mode handler 落库** —— `mode` 函数（344-354 行）同样在 set_mode 成功后加：

```rust
    crate::persist::save_mode(&state.db, body.mode).await;
```

- [ ] **Step 7: 编译 + 测试**

Run: `cargo test -p vmusicd`
Expected: 编译通过、全绿。

- [ ] **Step 8: Commit**

```bash
git add crates/vmusicd/src/persist.rs crates/vmusicd/src/main.rs crates/vmusicd/src/routes.rs
git commit -m "播放器偏好持久化：音量与模式重启恢复"
```

---

## Task 3: 音质档位枚举、偏好 API

**Files:**
- Create: `crates/vmusicd/src/online/quality.rs`
- Modify: `crates/vmusicd/src/online/mod.rs`（模块声明区）
- Modify: `crates/vmusicd/src/routes.rs:89`（路由）、约 1205 行前（handler）

- [ ] **Step 1: 新建 quality.rs**

```rust
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 跨音源统一音质档位与逐源偏好（settings 键 online_quality）。

use serde_json::{json, Value};
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
        "kugou" => &[Quality::Standard, Quality::Exhigh, Quality::Lossless],
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
    let q = clamp_to_allowed(source, Quality::parse(raw).unwrap_or_else(|| default_for(source)));
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
        assert!(!allowed_for("kugou").contains(&Quality::Hires));
        assert_eq!(clamp_to_allowed("qishui", Quality::Hires), Quality::Standard);
        assert_eq!(clamp_to_allowed("kugou", Quality::Hires), Quality::Lossless);
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
```

- [ ] **Step 2: 注册模块** —— online/mod.rs 顶部模块声明区加 `pub mod quality;`。

- [ ] **Step 3: 跑模块测试**

Run: `cargo test -p vmusicd online::quality::`
Expected: 4 PASS。

- [ ] **Step 4: 加路由** —— routes.rs 第 89 行 `.route("/v1/online/play", post(online_play))` 下一行加：

```rust
        .route("/v1/online/quality", get(online_quality_get).post(online_quality_set))
```

- [ ] **Step 5: 加两个 handler** —— 放在 `async fn online_play`（约 1205 行）上方：

```rust
async fn online_quality_get(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<serde_json::Value>> {
    let prefs = online::quality::load(&state.db)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let sources = ["netease", "qq", "kugou", "qishui", "ccmixter"];
    Ok(Json(serde_json::json!({
        "prefs": sources.iter().map(|s| {
            let q = online::quality::get(&prefs, s);
            serde_json::json!({
                "source": s,
                "selected": q.as_str(),
                "options": online::quality::allowed_for(s).iter().map(|c|
                    serde_json::json!({"value": c.as_str(), "label": c.label()})
                ).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>()
    })))
}

#[derive(Debug, Deserialize)]
struct OnlineQualityRequest {
    source: String,
    quality: String,
}

async fn online_quality_set(
    State(state): State<Arc<AppState>>,
    Json(body): Json<OnlineQualityRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    if !["netease", "qq", "kugou", "qishui", "ccmixter"].contains(&body.source.as_str()) {
        return Err(bad_request("不支持的音源"));
    }
    let mut prefs = online::quality::load(&state.db)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    let q = online::quality::save_source(&state.db, &mut prefs, &body.source, &body.quality)
        .await
        .map_err(|e| ApiError::from(vmusic_core::CoreError::Store(e)))?;
    state.quality.lock().await.insert(body.source.clone(), q);
    Ok(Json(serde_json::json!({ "source": body.source, "selected": q.as_str() })))
}
```

注：`state.quality` 字段在 Task 9 才加入 AppState；本任务先编译会报错。因此**本任务把 Step 5 的最后一行 `state.quality...` 先省略**，Task 9 Step 3 再补回该行并加字段。此时 Step 5 handler 末行为：

```rust
    Ok(Json(serde_json::json!({ "source": body.source, "selected": q.as_str() })))
```

- [ ] **Step 6: 编译测试**

Run: `cargo test -p vmusicd`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add crates/vmusicd/src/online/quality.rs crates/vmusicd/src/online/mod.rs crates/vmusicd/src/routes.rs
git commit -m "在线音质：统一档位枚举与逐源偏好 API"
```

---

## Task 4: 酷狗取流通道顺序修复（高码率优先）

**Files:**
- Modify: `crates/vmusicd/src/online/kugou.rs:436-600`

- [ ] **Step 1: 加通道顺序纯函数测试** —— kugou.rs 末尾 `#[cfg(test)] mod tests`（若无则新建）加：

```rust
    #[test]
    fn channel_order_prefers_gateway_for_high_quality_when_signed_in() {
        assert_eq!(channel_plan(false, 128_000), vec!["mobile", "h5", "h5_retry"]);
        assert_eq!(channel_plan(false, 740_000), vec!["mobile", "h5", "h5_retry"]);
        assert_eq!(channel_plan(true, 320_000), vec!["gateway", "mobile", "h5", "h5_retry"]);
        assert_eq!(channel_plan(true, 740_000), vec!["gateway", "mobile", "h5", "h5_retry"]);
        assert_eq!(channel_plan(true, 128_000), vec!["mobile", "h5", "h5_retry"]);
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p vmusicd channel_order_prefers`
Expected: 编译错误 `cannot find function channel_plan`。

- [ ] **Step 3: 实现 channel_plan** —— 放在 `pub async fn stream`（455 行）上方：

```rust
/// 通道尝试顺序。已登录且请求 ≥320k 时登录网关排第一（能给 320/flac）；
/// 其余情况维持「移动匿名 → H5 → retry」。
fn channel_plan(signed_in: bool, quality: u32) -> Vec<&'static str> {
    if signed_in && quality >= 320_000 {
        vec!["gateway", "mobile", "h5", "h5_retry"]
    } else {
        vec!["mobile", "h5", "h5_retry"]
    }
}
```

- [ ] **Step 4: 重构 stream() 为通道表驱动**。把现有 485-600 行的三段顺序代码（① 移动、② H5 for 循环、③ 登录网关）整体替换为下列宏 + 循环（各段请求构造保持与旧代码逐字一致，仅抽出复用；`pick_url`/`status_ok`/`status_digest`/`h5_base`/`signed_url`/`quality_param`/`WEB_APPID`/`GATEWAY`/`PLAY_*` 均为现有项）。在 `let mut last_transport ...` 与 `let mut business_seen ...` 声明之后插入：

```rust
    let plan = channel_plan(signed_in, quality);

    macro_rules! try_mobile {
        () => {{
            let mut mobile_url = reqwest::Url::parse(PLAY_MOBILE).unwrap();
            mobile_url
                .query_pairs_mut()
                .append_pair("cmd", "playInfo")
                .append_pair("hash", hash)
                .append_pair("key", &kugou::mobile_key(hash))
                .append_pair("album_id", album_id)
                .append_pair("pid", "1")
                .append_pair("forceDown", "0")
                .append_pair("vip", "65530");
            let h = super::http::headers(Some(&cookie), Some("https://m.kugou.com/"));
            match super::http::get_json(&http, mobile_url.as_str(), h).await {
                Ok(b) => {
                    business_seen = true;
                    if status_ok(b.get("status")) {
                        if let Some(url) = pick_url(&b) {
                            return Ok(stream_info_with_fallback(url, hash, quality));
                        }
                    }
                    tracing::debug!(channel = "kugou_mobile", status = %status_digest(&b), "酷狗取流通道失败");
                }
                Err(e) => {
                    tracing::debug!(channel = "kugou_mobile", error = %e.message, "酷狗取流通道失败");
                    last_transport = Some(e);
                }
            }
        }};
    }

    macro_rules! try_h5 {
        ($endpoint:expr, $channel:literal) => {{
            let mut params = h5_base(&cred, &mid, &dfid);
            params.insert("platid".into(), "4".into());
            params.insert("hash".into(), hash.to_lowercase());
            params.insert("album_id".into(), album_id.into());
            let url = signed_url($endpoint, params);
            let h = super::http::headers(Some(&cookie), Some("https://www.kugou.com/"));
            match super::http::get_json(&http, &url, h).await {
                Ok(b) => {
                    business_seen = true;
                    if status_ok(b.get("status")) {
                        if let Some(u) = pick_url(&b) {
                            return Ok(stream_info_with_fallback(u, hash, quality));
                        }
                    }
                    tracing::debug!(channel = $channel, status = %status_digest(&b), "酷狗取流通道失败");
                }
                Err(e) => {
                    tracing::debug!(channel = $channel, error = %e.message, "酷狗取流通道失败");
                    last_transport = Some(e);
                }
            }
        }};
    }

    macro_rules! try_gateway {
        () => {{
            let mut params = h5_base(&cred, &mid, &dfid);
            params.insert("album_id".into(), album_id.into());
            params.insert("area_code".into(), "1".into());
            params.insert("hash".into(), hash.to_lowercase());
            params.insert("behavior".into(), "play".into());
            params.insert("pid".into(), "2".into());
            params.insert("cmd".into(), "26".into());
            params.insert("quality".into(), quality_param(quality).to_string());
            params.insert("key".into(), kugou::play_key(hash, &mid, &cred.userid, WEB_APPID));
            let url = signed_url(&format!("{GATEWAY}/v5/url"), params);
            let mut h = super::http::headers(Some(&cookie), Some("https://www.kugou.com/"));
            h.insert(
                "x-router",
                reqwest::header::HeaderValue::from_static("trackercdn.kugou.com"),
            );
            match super::http::get_json(&http, &url, h).await {
                Ok(b) => {
                    business_seen = true;
                    if status_ok(b.get("status")) {
                        if let Some(u) = pick_url(&b) {
                            return Ok(stream_info_with_fallback(u, hash, quality));
                        }
                    }
                    tracing::debug!(channel = "kugou_gateway", status = %status_digest(&b), "酷狗取流通道失败");
                }
                Err(e) => {
                    tracing::debug!(channel = "kugou_gateway", error = %e.message, "酷狗取流通道失败");
                    last_transport = Some(e);
                }
            }
        }};
    }

    for channel in plan {
        match channel {
            "gateway" => try_gateway!(),
            "mobile" => try_mobile!(),
            "h5" => try_h5!(PLAY_WEB, "kugou_h5"),
            "h5_retry" => try_h5!(PLAY_WEB_RETRY, "kugou_h5_retry"),
            _ => {}
        }
    }
```

其后保留原有的「business_seen → auth_required/vip_required 归类，否则透传 last_transport」收尾。删除被替换的旧三段代码与其旧顺序注释。若编译器警告 `business_seed needs mut`，给 `let mut business_seen` 加 mut（宏内赋值需要）。

- [ ] **Step 5: 新增 stream_info_with_fallback** —— 在现有 `fn stream_info(...)`（约 436 行）旁加：

```rust
/// 回填实际请求码率，便于上层标注「实际档位」。酷狗无备用直链，fallback
/// 由 progressive 下载器在传输层处理。
fn stream_info_with_fallback(url: String, hash: &str, quality: u32) -> StreamInfo {
    let mut info = stream_info(url, hash);
    info.bitrate = Some(quality as u64);
    info
}
```

- [ ] **Step 6: 测试 + 编译**

Run: `cargo test -p vmusicd kugou`
Expected: 新测试 PASS、既有 kugou 测试保持通过。

- [ ] **Step 7: Commit**

```bash
git add crates/vmusicd/src/online/kugou.rs
git commit -m "酷狗取流：登录高码率通道优先，修复始终 128k"
```

---

## Task 5: 缓存命名（音质/容器）、共享 Client、LRU、.part 清理、配置项

**Files:**
- Modify: `crates/vmusicd/src/config.rs`
- Create: `crates/vmusicd/src/online/cache.rs`
- Modify: `crates/vmusicd/src/online/mod.rs:88-95,881-908`、`914-994`（fetch_to_cache 改名兼容）

- [ ] **Step 1: config 增加 OnlineConfig** —— config.rs 在 `LogConfig` 前插入：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OnlineConfig {
    /// 在线音频缓存上限（字节），默认 2 GiB。
    pub cache_max_bytes: u64,
}

impl Default for OnlineConfig {
    fn default() -> Self {
        Self { cache_max_bytes: 2 * 1024 * 1024 * 1024 }
    }
}
```

`Config` 结构体加字段 `pub online: OnlineConfig,`；`Config::default()` 里加 `online: OnlineConfig::default(),`。

- [ ] **Step 2: 新建 cache.rs**

```rust
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 在线音频缓存：音质/容器分键命名、旧名回退、LRU 淘汰、.part 清理。

use std::path::{Path, PathBuf};

use tokio::fs;

/// 正式缓存文件名：`{stem}-{quality}.{ext}`。
pub fn cache_name(source: &str, id: &str, quality: &str, ext: &str) -> String {
    format!("{}-{quality}.{}", stem(source, id), ext_clean(ext))
}

/// 旧版命名（无音质、恒 .mp3），一次性回退命中。
pub fn legacy_cache_name(source: &str, id: &str) -> String {
    format!("{}.mp3", stem(source, id))
}

fn stem(source: &str, id: &str) -> String {
    let raw = format!("{source}-{id}");
    let safe: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if safe.len() <= 96 {
        safe
    } else {
        format!("{}-{:08x}", &safe[..96], fnv1a(&raw))
    }
}

fn ext_clean(ext: &str) -> String {
    let e: String = ext
        .trim()
        .trim_start_matches('.')
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect();
    if e.is_empty() { "mp3".into() } else { e }
}

fn fnv1a(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// 正式名优先；缺失时回退旧名。返回 (路径, 是否旧名)。
pub async fn find_cached(
    dir: &Path,
    source: &str,
    id: &str,
    quality: &str,
    ext: &str,
) -> Option<(PathBuf, bool)> {
    let fresh = dir.join(cache_name(source, id, quality, ext));
    if is_ready(&fresh).await {
        return Some((fresh, false));
    }
    let legacy = dir.join(legacy_cache_name(source, id));
    if is_ready(&legacy).await {
        return Some((legacy, true));
    }
    None
}

async fn is_ready(path: &Path) -> bool {
    matches!(fs::metadata(path).await, Ok(m) if m.len() > 1024)
}

/// 删除目录内残留 `.part`（上次进程被杀的残骸）。启动时调用。
pub async fn clean_parts(dir: &Path) {
    let Ok(mut it) = fs::read_dir(dir).await else { return };
    while let Ok(Some(entry)) = it.next_entry().await {
        if entry.file_name().to_string_lossy().ends_with(".part") {
            let _ = fs::remove_file(entry.path()).await;
        }
    }
}

/// 总量超 max_bytes 时按 mtime 从旧到新删到上限的 90%；.part 与 protected 跳过。
pub async fn enforce_limit(
    dir: &Path,
    max_bytes: u64,
    protected: &[String],
) -> std::io::Result<u64> {
    let mut files: Vec<(PathBuf, std::time::SystemTime, u64)> = Vec::new();
    let mut total = 0u64;
    let Ok(mut it) = fs::read_dir(dir).await else { return Ok(0) };
    while let Ok(Some(entry)) = it.next_entry().await {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".part") || protected.contains(&name) {
            continue;
        }
        if let Ok(meta) = fs::metadata(&path).await {
            if meta.is_file() {
                let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
                files.push((path, mtime, meta.len()));
                total += meta.len();
            }
        }
    }
    if total <= max_bytes {
        return Ok(0);
    }
    let target = (max_bytes as f64 * 0.9) as u64;
    files.sort_by_key(|(_, mtime, _)| *mtime);
    let mut removed = 0u64;
    for (path, _, len) in files {
        if total <= target {
            break;
        }
        if fs::remove_file(&path).await.is_ok() {
            total -= len;
            removed += len;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn naming_and_legacy_fallback() {
        assert_eq!(cache_name("qq", "a1", "lossless", "m4a"), "qq-a1-lossless.m4a");
        assert_eq!(cache_name("qq", "a1", "standard", ".MP3"), "qq-a1-standard.mp3");
        assert_eq!(legacy_cache_name("qq", "a1"), "qq-a1.mp3");

        let dir = std::env::temp_dir().join(format!("vmusic-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        let legacy = dir.join(legacy_cache_name("qq", "a1"));
        fs::write(&legacy, vec![0u8; 2048]).await.unwrap();
        let hit = find_cached(&dir, "qq", "a1", "lossless", "m4a").await;
        assert!(hit.is_some());
        assert!(hit.unwrap().1);
    }

    #[tokio::test]
    async fn cleans_parts_and_evicts_oldest() {
        let dir = std::env::temp_dir().join(format!("vmusic-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        fs::write(dir.join(".x-1.part"), vec![0u8; 100]).await.unwrap();
        clean_parts(&dir).await;
        let mut count = 0;
        let mut it = fs::read_dir(&dir).await.unwrap();
        while it.next_entry().await.unwrap().is_some() { count += 1; }
        assert_eq!(count, 0);

        for n in 0..3u8 {
            fs::write(dir.join(format!("song{n}.mp3")), vec![0u8; 10_000]).await.unwrap();
            std::thread::sleep(std::time::Duration::from_millis(12));
        }
        let removed = enforce_limit(&dir, 25_000, &[]).await.unwrap();
        assert!(removed >= 10_000);
        let mut remaining = 0;
        let mut it = fs::read_dir(&dir).await.unwrap();
        while it.next_entry().await.unwrap().is_some() { remaining += 1; }
        assert_eq!(remaining, 2);
    }
}
```

- [ ] **Step 3: 注册模块 + 共享 client** —— mod.rs 模块声明区加 `pub mod cache;`。把 `pub fn client()`（88-95 行）替换为：

```rust
/// 进程级共享 API 客户端（连接池复用）。
fn shared_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .user_agent(UA)
            .build()
            .expect("reqwest client")
    })
}

pub fn client() -> ApiResult<reqwest::Client> {
    Ok(shared_client().clone())
}

/// 下载用客户端：读空闲超时放宽到 30s，不设整体超时（长曲目慢链路保活）。
pub fn download_client() -> ApiResult<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    Ok(CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT)
                .read_timeout(Duration::from_secs(30))
                .user_agent(UA)
                .build()
                .expect("reqwest download client")
        })
        .clone())
}
```

- [ ] **Step 4: 删除旧 cache_name/fnv1a，fetch_to_cache 改用兼容名** —— 删除 mod.rs 881-908 的旧 `cache_name` 与 `fnv1a`；`fetch_to_cache` 内两处 `cache_name(source, id)` 改为 `cache::legacy_cache_name(source, id)`。该函数在 Task 9 被渐进式流程取代后删除；本任务保持其可用以维持编译。

- [ ] **Step 5: 测试**

Run: `cargo test -p vmusicd online::cache::` 然后 `cargo test -p vmusicd`
Expected: 2 PASS；全量编译通过、全绿。

- [ ] **Step 6: Commit**

```bash
git add crates/vmusicd/src/config.rs crates/vmusicd/src/online/cache.rs crates/vmusicd/src/online/mod.rs
git commit -m "在线缓存：音质分键命名、共享连接池、LRU 与 part 清理"
```

---

## Task 6: 渐进式下载器 + HttpMediaSource + 容器探测

**Files:**
- Create: `crates/vmusicd/src/online/progressive.rs`
- Modify: `crates/vmusicd/src/online/mod.rs`（模块声明）
- Modify: `crates/vmusicd/Cargo.toml`（加 symphonia + futures）

- [ ] **Step 1: 加依赖** —— vmusicd/Cargo.toml `[dependencies]` 中加：

```toml
symphonia = { workspace = true }
```

（`futures` 与 `tokio` 已存在。）

- [ ] **Step 2: 注册模块** —— online/mod.rs 模块声明区加 `pub mod progressive;`。

- [ ] **Step 3: 新建 progressive.rs（完整实现 + 测试）**

```rust
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! 渐进式下载：后台 tokio 任务顺序把远程音频写入 `.part`；同步解码线程经
//! [`HttpMediaSource`] 读到哪等到哪。下载完成原子 rename 成正式缓存。
//!
//! 桥接边界：下载是 async（reqwest 流），解码是 OS 线程上的同步 Read。
//! 两者只通过 Inner 的 Condvar + 已下载字节数通信，互不持有对方运行时。

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use futures::StreamExt;
use tokio::task::JoinHandle;

use crate::error::ApiError;
use crate::online::download_client;

/// 预读基础块与封顶：max(256KB, 总长 8%)，封顶 1.5MB。
pub const FLUSH_STEP: u64 = 256 * 1024;
const PREBUFFER_CAP: u64 = 3 * 512 * 1024;
const MAX_AUDIO_BYTES: u64 = 64 * 1024 * 1024;

/// 开播模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamMode {
    /// 头部已含解复用元数据（mp3/flac/ogg/early-moov m4a）。
    Progressive,
    /// 元数据在文件尾（late-moov m4a），等整首下载完再播。
    WaitFull,
}

struct Inner {
    downloaded: Mutex<u64>,
    cv: Condvar,
    total: Mutex<Option<u64>>,
    finished: Mutex<bool>,
    error: Mutex<Option<String>>,
    /// 首块嗅探出的容器扩展名；下载完成时据此命名正式缓存。
    ext: Mutex<&'static str>,
}

impl Inner {
    fn new() -> Self {
        Self {
            downloaded: Mutex::new(0),
            cv: Condvar::new(),
            total: Mutex::new(None),
            finished: Mutex::new(false),
            error: Mutex::new(None),
            ext: Mutex::new("mp3"),
        }
    }

    fn ext(&self) -> &'static str {
        *self.ext.lock().unwrap()
    }
    fn set_ext(&self, ext: &'static str) {
        *self.ext.lock().unwrap() = ext;
    }

    fn total(&self) -> Option<u64> {
        *self.total.lock().unwrap()
    }
    fn set_total(&self, t: Option<u64>) {
        *self.total.lock().unwrap() = t;
        self.cv.notify_all();
    }
    fn advance(&self, n: u64) {
        *self.downloaded.lock().unwrap() += n;
        self.cv.notify_all();
    }
    fn reset(&self) {
        *self.downloaded.lock().unwrap() = 0;
        *self.finished.lock().unwrap() = false;
        self.cv.notify_all();
    }
    fn finish(&self) {
        *self.finished.lock().unwrap() = true;
        self.cv.notify_all();
    }
    fn is_finished(&self) -> bool {
        *self.finished.lock().unwrap()
    }
    fn fail(&self, msg: String) {
        *self.error.lock().unwrap() = Some(msg);
        self.cv.notify_all();
    }
    fn pct(&self) -> Option<u8> {
        let t = self.total()?;
        if t == 0 {
            return None;
        }
        Some(((*self.downloaded.lock().unwrap() as u128 * 100 / t as u128) as u8).min(99))
    }

    /// 阻塞等待已下载达到 want；250ms 醒一次响应 abort；提前完成/出错也返回。
    fn wait_for(&self, want: u64, abort: &AtomicBool) -> Result<u64, WaitError> {
        let mut g = self.downloaded.lock().unwrap();
        loop {
            if abort.load(Ordering::Relaxed) {
                return Err(WaitError::Aborted);
            }
            if let Some(e) = self.error.lock().unwrap().clone() {
                return Err(WaitError::Failed(e));
            }
            if *g >= want || *self.finished.lock().unwrap() {
                return Ok(*g);
            }
            let (ng, _) = self.cv.wait_timeout(g, Duration::from_millis(250)).unwrap();
            g = ng;
        }
    }
}

#[derive(Debug)]
pub enum WaitError {
    Aborted,
    Failed(String),
}

/// 解码线程读的同步源。
pub struct HttpMediaSource {
    file: File,
    pos: u64,
    inner: Arc<Inner>,
    abort: Arc<AtomicBool>,
}

impl HttpMediaSource {
    pub fn open(part: &Path, inner: Arc<Inner>, abort: Arc<AtomicBool>) -> io::Result<Self> {
        Ok(Self { file: OpenOptions::new().read(true).open(part)?, pos: 0, inner, abort })
    }
}

impl Read for HttpMediaSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let available = self
            .inner
            .wait_for(self.pos + 1, &self.abort)
            .map_err(|e| match e {
                WaitError::Aborted => io::Error::new(io::ErrorKind::Interrupted, "download aborted"),
                WaitError::Failed(m) => io::Error::new(io::ErrorKind::BrokenPipe, m),
            })?;
        let readable = available.saturating_sub(self.pos) as usize;
        if readable == 0 {
            return Ok(0); // 干净 EOF
        }
        self.file.seek(SeekFrom::Start(self.pos))?;
        let n = self.file.read(&mut buf[..readable.min(buf.len())])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpMediaSource {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let target = match pos {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::Current(n) => self.pos as i64 + n,
            SeekFrom::End(n) => {
                // 相对尾定位需要整首（late-moov 走 WaitFull，正常不到这）。
                let t = self
                    .inner
                    .total()
                    .ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported, "length unknown"))?;
                self.inner
                    .wait_for(t, &self.abort)
                    .map_err(|_| io::Error::new(io::ErrorKind::Interrupted, "aborted"))?;
                t as i64 + n
            }
        };
        if target < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "negative seek"));
        }
        let target = target as u64;
        self.inner
            .wait_for(target, &self.abort)
            .map_err(|_| io::Error::new(io::ErrorKind::Interrupted, "download aborted"))?;
        self.pos = target;
        Ok(target)
    }
}

impl symphonia::core::io::MediaSource for HttpMediaSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        self.inner.total()
    }
}

/// 一次进行中的下载。缓存键不含扩展名（扩展名首块才知道）。
pub struct Download {
    pub inner: Arc<Inner>,
    pub abort: Arc<AtomicBool>,
    pub part_path: PathBuf,
    key: String,
    dir: PathBuf,
    task: JoinHandle<Result<PathBuf, String>>,
}

impl Download {
    /// 嗅探出的容器扩展名（预读完成后一定可用）。
    pub fn ext(&self) -> &'static str {
        self.inner.ext()
    }

    /// 后台下载是否已跑到完成态（WaitFull 轮询用，不取 JoinHandle）。
    pub fn is_finished(&self) -> bool {
        self.inner.is_finished()
    }

    /// 正式缓存路径（扩展名以当前嗅探结果为准）。
    pub fn final_path(&self) -> PathBuf {
        self.dir.join(format!("{}.{}", self.key, self.inner.ext()))
    }
}

pub fn prebuffer_target(total: Option<u64>) -> u64 {
    match total {
        Some(t) => ((t * 8 / 100).max(FLUSH_STEP)).min(PREBUFFER_CAP),
        None => FLUSH_STEP,
    }
}

impl Download {
    pub fn pct(&self) -> Option<u8> {
        self.inner.pct()
    }

    /// 等预读阈值（spawn_blocking 里阻塞，不卡 async 运行时）。
    pub async fn wait_prebuffer(&self) -> Result<u64, String> {
        let inner = self.inner.clone();
        let abort = self.abort.clone();
        let need = prebuffer_target(inner.total());
        tokio::task::spawn_blocking(move || {
            inner.wait_for(need, &abort).map_err(|e| match e {
                WaitError::Aborted => "download aborted".to_string(),
                WaitError::Failed(m) => m,
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// WaitFull：等整首下完。
    pub async fn wait_full(&self) -> Result<(), String> {
        loop {
            if self.abort.load(Ordering::Relaxed) {
                return Err("download aborted".into());
            }
            if let Some(t) = self.inner.total() {
                let inner = self.inner.clone();
                let abort = self.abort.clone();
                return tokio::task::spawn_blocking(move || {
                    inner.wait_for(t, &abort).map(|_| ()).map_err(|e| match e {
                        WaitError::Aborted => "download aborted".to_string(),
                        WaitError::Failed(m) => m,
                    })
                })
                .await
                .map_err(|e| e.to_string())?;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    pub async fn join(self) -> Result<PathBuf, String> {
        self.task.await.map_err(|e| e.to_string())?
    }

    /// 中止并删除 .part。
    pub fn cancel(&self) {
        self.abort.store(true, Ordering::Relaxed);
        self.task.abort();
        let _ = std::fs::remove_file(&self.part_path);
    }
}

/// 启动下载。`key` 不含扩展名（如 `qq-a1-lossless`）；urls = [主 url, fallback...]。
pub fn start(
    dir: PathBuf,
    key: String,
    urls: Vec<String>,
    referer: Option<String>,
) -> Result<Download, ApiError> {
    let part_path = dir.join(format!(".{key}.part"));
    let _ = std::fs::remove_file(&part_path);
    std::fs::create_dir_all(&dir)
        .map_err(|e| ApiError::internal(format!("创建缓存目录失败: {e}")))?;
    std::fs::File::create(&part_path)
        .map_err(|e| ApiError::internal(format!("创建缓存文件失败: {e}")))?;

    let inner = Arc::new(Inner::new());
    let abort = Arc::new(AtomicBool::new(false));
    let client = download_client()?;

    let task = tokio::task::spawn({
        let inner = inner.clone();
        let abort = abort.clone();
        let dir2 = dir.clone();
        let key2 = key.clone();
        async move {
            let mut written: u64 = 0;
            // 累计前 32 字节用于容器嗅探。
            let mut head: Vec<u8> = Vec::with_capacity(32);
            for url in &urls {
                if abort.load(Ordering::Relaxed) {
                    let _ = std::fs::remove_file(&part_path);
                    return Err("download aborted".to_string());
                }
                let mut req = client.get(url);
                if written > 0 {
                    req = req.header(reqwest::header::RANGE, format!("bytes={written}-"));
                }
                if let Some(rf) = &referer {
                    req = req.header(reqwest::header::REFERER, rf);
                }
                let resp = match req.send().await {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::debug!("下载连接失败，尝试下一地址: {e}");
                        continue;
                    }
                };
                let status = resp.status();
                if status == reqwest::StatusCode::OK && written > 0 {
                    // 服务器无视 Range：从头重下。
                    written = 0;
                    head.clear();
                    inner.reset();
                } else if status != reqwest::StatusCode::OK
                    && status != reqwest::StatusCode::PARTIAL_CONTENT
                {
                    tracing::debug!("下载返回 {status}，尝试下一地址");
                    continue;
                }
                if written == 0 {
                    let total = resp.content_length();
                    if let Some(t) = total {
                        if t > MAX_AUDIO_BYTES {
                            inner.fail("内容过大".into());
                            let _ = std::fs::remove_file(&part_path);
                            return Err("内容过大".to_string());
                        }
                    }
                    inner.set_total(total);
                }

                // 阻塞写在专用下载任务里，8-64KB 的 write 不构成运行时压力。
                let mut file = OpenOptions::new().write(true).open(&part_path)
                    .map_err(|e| e.to_string())?;
                file.seek(SeekFrom::Start(written)).map_err(|e| e.to_string())?;
                let mut stream = resp.bytes_stream();
                let mut broke = false;
                while let Some(chunk) = stream.next().await {
                    if abort.load(Ordering::Relaxed) {
                        drop(file);
                        let _ = std::fs::remove_file(&part_path);
                        return Err("download aborted".to_string());
                    }
                    match chunk {
                        Ok(bytes) => {
                            if written + bytes.len() as u64 > MAX_AUDIO_BYTES {
                                inner.fail("内容过大".into());
                                let _ = std::fs::remove_file(&part_path);
                                return Err("内容过大".to_string());
                            }
                            if head.len() < 32 {
                                let take = 32 - head.len();
                                head.extend_from_slice(&bytes[..bytes.len().min(take)]);
                                if let Some(ext) = sniff_ext(&head) {
                                    inner.set_ext(ext);
                                }
                            }
                            file.write_all(&bytes).map_err(|e| {
                                inner.fail(e.to_string());
                                e.to_string()
                            })?;
                            written += bytes.len() as u64;
                            inner.advance(bytes.len() as u64);
                        }
                        Err(e) => {
                            tracing::debug!("下载中断，尝试续传: {e}");
                            broke = true;
                            break;
                        }
                    }
                }
                drop(file);
                if broke {
                    continue; // 下一个 URL 带 Range 续传
                }
                if written <= 1024 {
                    let msg = "内容过小，可能已被版权限制".to_string();
                    inner.fail(msg.clone());
                    let _ = std::fs::remove_file(&part_path);
                    return Err(msg);
                }
                // 完成：按嗅探扩展名落正式名。Windows 终文件已存在则复用。
                let final_path = dir2.join(format!("{}.{}", key2, inner.ext()));
                match tokio::fs::rename(&part_path, &final_path).await {
                    Ok(()) => {}
                    Err(_) => {
                        let ok = matches!(tokio::fs::metadata(&final_path).await, Ok(m) if m.len() > 1024);
                        let _ = tokio::fs::remove_file(&part_path).await;
                        if !ok {
                            return Err("落盘缓存失败".to_string());
                        }
                    }
                }
                inner.finish();
                return Ok(final_path);
            }
            let msg = "所有试听地址均失败".to_string();
            inner.fail(msg.clone());
            let _ = std::fs::remove_file(&part_path);
            Err(msg)
        }
    });

    Ok(Download { inner, abort, part_path, key, dir, task })
}

// ---------------------------------------------------------------------------
// 容器探测
// ---------------------------------------------------------------------------

/// 嗅探真实容器扩展名；认不出返回 None（调用方按 WaitFull 保守处理）。
pub fn sniff_ext(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"fLaC") {
        Some("flac")
    } else if head.starts_with(b"OggS") {
        Some("ogg")
    } else if head.starts_with(b"ID3")
        || (head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0)
    {
        Some("mp3")
    } else if head.len() > 11 && &head[4..8] == b"ftyp" {
        Some("m4a")
    } else {
        None
    }
}

/// 在 ISO BMFF 顶层 box 序列里找 moov。
pub fn mp4_has_moov(buf: &[u8]) -> bool {
    let mut i = 0usize;
    while i + 8 <= buf.len() {
        let size = u32::from_be_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
        if size < 8 {
            return false;
        }
        if &buf[i + 4..i + 8] == b"moov" {
            return true;
        }
        // size==1 是 64 位 largesize，头部场景遇不到；遇不到就停。
        if size == 1 {
            return false;
        }
        i += size;
    }
    false
}

/// 预读后判定开播模式。
pub fn plan_mode(head: &[u8]) -> (StreamMode, &'static str) {
    match sniff_ext(head) {
        Some("m4a") => {
            if mp4_has_moov(head) {
                (StreamMode::Progressive, "m4a")
            } else {
                (StreamMode::WaitFull, "m4a")
            }
        }
        Some(ext) => (StreamMode::Progressive, ext),
        None => (StreamMode::WaitFull, "mp3"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prebuffer_math() {
        assert_eq!(prebuffer_target(None), FLUSH_STEP);
        // 40MB 的 8% = 3.2MB → 被 1.5MB 封顶。
        assert_eq!(prebuffer_target(Some(40_000_000)), PREBUFFER_CAP);
        // 1MB 的 8% = 80KB → 取 256KB 下限。
        assert_eq!(prebuffer_target(Some(1_000_000)), FLUSH_STEP);
    }

    #[test]
    fn sniff_containers() {
        assert_eq!(sniff_ext(b"fLaC...."), Some("flac"));
        assert_eq!(sniff_ext(b"OggS...."), Some("ogg"));
        assert_eq!(sniff_ext(b"ID3\x03...."), Some("mp3"));
        assert_eq!(sniff_ext(&[0xFF, 0xFB, 0x90]), Some("mp3"));
        let mut mp4 = vec![0u8; 64];
        mp4[4..8].copy_from_slice(b"ftyp");
        assert_eq!(sniff_ext(&mp4), Some("m4a"));
        assert_eq!(sniff_ext(b"xxxx"), None);
    }

    #[test]
    fn moov_detection() {
        // ftyp(32) + free(16) + moov(40)
        let mut buf = vec![0u8; 88];
        buf[4..8].copy_from_slice(b"ftyp");
        buf[0..4].copy_from_slice(&32u32.to_be_bytes());
        buf[32..36].copy_from_slice(&16u32.to_be_bytes());
        buf[36..40].copy_from_slice(b"free");
        buf[48..52].copy_from_slice(&40u32.to_be_bytes());
        buf[52..56].copy_from_slice(b"moov");
        assert!(mp4_has_moov(&buf));
        assert_eq!(plan_mode(&buf).0, StreamMode::Progressive);

        // moov 不在前缀里 → WaitFull。
        let mut late = vec![0u8; 88];
        late[4..8].copy_from_slice(b"ftyp");
        late[0..4].copy_from_slice(&88u32.to_be_bytes());
        assert_eq!(plan_mode(&late).0, StreamMode::WaitFull);
    }

    #[test]
    fn media_source_blocks_until_bytes_arrive() {
        let dir = std::env::temp_dir().join(format!("vmusic-prog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("x.part");
        std::fs::write(&part, b"").unwrap();
        let inner = Arc::new(Inner::new());
        inner.set_total(Some(20));
        let abort = Arc::new(AtomicBool::new(false));

        let writer_part = part.clone();
        let w_inner = inner.clone();
        let h = std::thread::spawn(move || {
            use std::io::Write;
            std::thread::sleep(Duration::from_millis(40));
            let mut f = OpenOptions::new().append(true).open(&writer_part).unwrap();
            f.write_all(&[1u8; 10]).unwrap();
            f.flush().unwrap();
            w_inner.advance(10);
            std::thread::sleep(Duration::from_millis(40));
            f.write_all(&[2u8; 10]).unwrap();
            f.flush().unwrap();
            w_inner.advance(10);
            w_inner.finish();
        });

        let mut src = HttpMediaSource::open(&part, inner, abort).unwrap();
        let mut out = [0u8; 20];
        src.read_exact(&mut out).unwrap();
        assert_eq!(&out[..10], &[1u8; 10]);
        assert_eq!(&out[10..], &[2u8; 10]);
        h.join().unwrap();
    }

    #[test]
    fn media_source_aborts_fast() {
        let dir = std::env::temp_dir().join(format!("vmusic-prog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("y.part");
        std::fs::write(&part, b"").unwrap();
        let inner = Arc::new(Inner::new());
        inner.set_total(Some(100));
        let abort = Arc::new(AtomicBool::new(false));
        let abort2 = abort.clone();
        std::thread::spawn(move || std::thread::sleep(Duration::from_millis(50)))
            .join()
            .unwrap();
        abort2.store(true, Ordering::Relaxed);
        let mut src = HttpMediaSource::open(&part, inner, abort).unwrap();
        let mut out = [0u8; 10];
        assert!(src.read(&mut out).is_err());
    }
}
```

- [ ] **Step 4: 跑测试**

Run: `cargo test -p vmusicd online::progressive::`
Expected: 5 PASS（prebuffer、sniff、moov、阻塞读、abort）。

- [ ] **Step 5: Commit**

```bash
git add crates/vmusicd/Cargo.toml crates/vmusicd/src/online/progressive.rs crates/vmusicd/src/online/mod.rs Cargo.lock
git commit -m "边下边播：渐进式下载器与可阻塞 MediaSource"
```

---

## Task 7: audio actor 的 LoadSource 接缝（后端直接吃 MediaSource）

**Files:**
- Modify: `crates/vmusic-core/src/audio.rs`（trait 加默认方法）
- Modify: `crates/vmusic-audio/src/actor.rs`（Command 变体 + handle + apply）
- Modify: `crates/vmusic-audio/src/cpal_backend.rs`（open_media 重构、load_source）

- [ ] **Step 1: trait 加默认方法** —— vmusic-core/src/audio.rs 在 `fn load(...)` 后加：

```rust
    /// 直接打开一个媒体源（边下边播用）。默认不支持，真实后端按需实现。
    fn load_source(
        &mut self,
        _source: Box<dyn std::io::Read + std::io::Seek + Send>,
        _ext: Option<String>,
    ) -> Result<MediaInfo, AudioError> {
        Err(AudioError::UnsupportedFormat("该后端不支持流式媒体源".into()))
    }
```

注意：这里不能直接在 vmusic-core 写 `symphonia::core::io::MediaSource`（core 不依赖 symphonia）。`Read + Seek + Send` 超集在 CpalBackend 内再转成 MediaSource 使用。

- [ ] **Step 2: 跑编译确认 trait 改动不破坏现有实现**

Run: `cargo check -p vmusic-core`
Expected: 通过（默认方法，NullBackend/CpalBackend 无需改动即编译）。

- [ ] **Step 3: actor 增加 LoadSource 命令** —— actor.rs：

(a) Command enum 在 `Load {...}` 变体后加：

```rust
    LoadSource {
        source: Box<dyn std::io::Read + std::io::Seek + Send>,
        ext: Option<String>,
        track_id: Option<String>,
        reply: Reply<Result<MediaInfo, AudioError>>,
    },
```

（命令只携带标准库 `Read+Seek+Send`：actor 层不认识 symphonia，trait 对象也能直接经 std mpsc 传递。HttpMediaSource 同时实现 Read+Seek，装箱时可直接转成该类型。）

(b) AudioHandle 在 `pub async fn load(...)` 后加：

```rust
    pub async fn load_source(
        &self,
        source: Box<dyn std::io::Read + std::io::Seek + Send>,
        ext: Option<String>,
        track_id: Option<String>,
    ) -> Result<MediaInfo, AudioError> {
        let (tx, rx) = oneshot::channel();
        self.send(Command::LoadSource { source, ext, track_id, reply: tx })?;
        rx.await
            .unwrap_or(Err(AudioError::Other("actor gone".into())))
    }
```

(c) `apply` 的 `Command::Load {...}` 臂之后加一个结构相同的臂，调用 trait 的 `load_source`：

```rust
        Command::LoadSource { source, ext, track_id, reply } => {
            let info = backend.load_source(source, ext);
            if let Ok(info) = &info {
                state.track_id = track_id;
                state.duration_ms = info.duration_ms;
                state.position_ms = 0;
                state.playing = false;
                state.generation += 1;
            }
            publish(sink, state);
            let reset = info.is_ok();
            let _ = reply.send(info);
            Ok(reset)
        }
```

- [ ] **Step 4: 后端把 Read+Seek 输入统一为 open_media** —— cpal_backend.rs：

(a) 同文件加适配结构体（文件尾部工具函数区）：

```rust
/// 把 Read+Seek+Send 适配成 symphonia MediaSource。
struct DynMediaSource {
    inner: Box<dyn std::io::Read + std::io::Seek + Send>,
}
impl std::io::Read for DynMediaSource {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.inner.read(buf)
    }
}
impl std::io::Seek for DynMediaSource {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}
impl symphonia::core::io::MediaSource for DynMediaSource {
    fn is_seekable(&self) -> bool {
        true
    }
}
```

(c) 把现有 `fn load(&mut self, uri: &str)` 的函数体（268-302 行）整体替换为：

```rust
    fn load(&mut self, uri: &str) -> Result<MediaInfo, AudioError> {
        let path = uri_to_path(uri);
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_string);
        let file = std::fs::File::open(&path)
            .map_err(|e| AudioError::DecodeFailed(e.to_string()))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        self.open_and_spawn(mss, ext.as_deref())
    }

    fn load_source(
        &mut self,
        source: Box<dyn std::io::Read + std::io::Seek + Send>,
        ext: Option<String>,
    ) -> Result<MediaInfo, AudioError> {
        let mss = MediaSourceStream::new(
            Box::new(DynMediaSource { inner: source }),
            Default::default(),
        );
        self.open_and_spawn(mss, ext.as_deref())
    }
```

(c) 在 `impl CpalBackend`（非 trait impl 块）中新增统一换装函数（紧邻 load 上方）：

```rust
    /// probe 时长 → 起解码线程。两种 load 入口共用，杜绝双份打开逻辑。
    fn open_and_spawn(
        &mut self,
        mss: MediaSourceStream,
        ext: Option<&str>,
    ) -> Result<MediaInfo, AudioError> {
        self.ensure_stream()?;
        self.stop_decoder();
        self.clear_buffers();
        self.shared.frames_played.store(0, Ordering::Relaxed);
        self.shared.playing.store(false, Ordering::Relaxed);
        self.reset_fade();

        let mut hint = Hint::new();
        if let Some(e) = ext {
            if !e.is_empty() {
                hint.with_extension(e);
            }
        }
        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
            .map_err(|e| AudioError::UnsupportedFormat(e.to_string()))?;

        let track = probed
            .format
            .default_track()
            .ok_or_else(|| AudioError::UnsupportedFormat("no audio track".into()))?;
        let duration_ms = track.codec_params.time_base.zip(track.codec_params.n_frames).map(
            |(tb, frames)| {
                let time = tb.calc_time(frames);
                ((time.seconds as f64 + time.frac) * 1000.0).round() as u64
            },
        );
        let sample_rate = track.codec_params.sample_rate;
        let channels = track.codec_params.channels.map(|c| c.count() as u8);
        let track_id = track.id;
        let decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| AudioError::UnsupportedFormat(e.to_string()))?;
        self.duration_ms = duration_ms;

        let stop = Arc::new(AtomicBool::new(false));
        let seek_to = Arc::new(Mutex::new(None));
        let ctl = DecoderCtl { stop: stop.clone(), seek_to: seek_to.clone() };
        let shared = self.shared.clone();
        let device_rate = self.device_rate;
        let device_channels = self.device_channels.max(1) as usize;
        let opened = (probed.format, decoder, track_id);
        let handle = std::thread::Builder::new()
            .name("vmusic-decoder".into())
            .spawn(move || {
                decode_loop_opened(opened, shared, stop, seek_to, device_rate, device_channels);
            })
            .map_err(|e| AudioError::BackendInit(e.to_string()))?;
        self.decoder = Some((handle, ctl));

        Ok(MediaInfo { duration_ms, sample_rate, channels })
    }
```

(d) 把旧 `fn decode_loop(path: PathBuf, ...)` 改名为 `decode_loop_opened`，签名第一参数换成：

```rust
#[allow(clippy::too_many_arguments)]
fn decode_loop_opened(
    opened: OpenedReader,
    shared: Arc<Shared>,
    stop: Arc<AtomicBool>,
    seek_to: Arc<Mutex<Option<u64>>>,
    device_rate: u32,
    device_channels: usize,
) {
    let (mut reader, mut decoder, track_id) = opened;
    // 函数体其余部分（reader.next_packet() 循环等）原样保留，删掉开头的
    // open_reader(&path) 三行与结尾日志里的 path.display()（改成 "stream"）。
```

删除旧 `probe_info` 与 `open_reader` 两个函数（逻辑已并入 open_and_spawn）。`use std::fs::File;` 保留（load 仍用）。

(e) `reset_fade` 由 Task 8 加入；为让本任务编译通过，先在 `impl CpalBackend` 加一个空方法占位，Task 8 Step 1 会替换它：

```rust
    fn reset_fade(&mut self) {}
```

- [ ] **Step 5: actor 测试** —— actor.rs tests 模块末尾加（验证新命令更新状态）：

```rust
    /// LoadSource 的最小可用后端：记录 track_id，不做真解码。
    struct SourceBackend {
        loaded: std::cell::Cell<Option<String>>,
    }
    impl AudioBackend for SourceBackend {
        fn name(&self) -> &'static str { "source-test" }
        fn devices(&self) -> Result<Vec<DeviceInfo>, AudioError> { Ok(vec![]) }
        fn select_device(&mut self, _: Option<&str>) -> Result<(), AudioError> { Ok(()) }
        fn load(&mut self, _uri: &str) -> Result<MediaInfo, AudioError> {
            Ok(MediaInfo::default())
        }
        fn load_source(
            &mut self,
            _s: Box<dyn std::io::Read + std::io::Seek + Send>,
            _ext: Option<String>,
        ) -> Result<MediaInfo, AudioError> {
            self.loaded.set(Some("stream".into()));
            Ok(MediaInfo::default())
        }
        fn play(&mut self) -> Result<(), AudioError> { Ok(()) }
        fn pause(&mut self) -> Result<(), AudioError> { Ok(()) }
        fn stop(&mut self) -> Result<(), AudioError> { Ok(()) }
        fn seek(&mut self, _: u64) -> Result<(), AudioError> { Ok(()) }
        fn set_volume(&mut self, _: f32) -> Result<(), AudioError> { Ok(()) }
        fn position_ms(&self) -> u64 { 0 }
        fn duration_ms(&self) -> Option<u64> { None }
        fn finished(&self) -> bool { false }
        fn spectrum(&self, _: &mut [f32]) -> bool { false }
    }
```

由于 `run()` 在内部构造后端、无法注入该假后端，改为在 `apply()` 层验证：用 SourceBackend 直接调 apply。若 apply 当前是私有函数但测试在同模块 `mod tests`（同文件），可直接访问。新增测试：

```rust
    #[test]
    fn load_source_command_updates_track_id() {
        let mut backend = SourceBackend { loaded: std::cell::Cell::new(None) };
        let mut state = PlayerSnapshot::default();
        let sink = ArcSwap::from_pointee(PlayerSnapshot::default());
        let ok = apply(
            &mut backend,
            &mut state,
            &sink,
            Command::LoadSource {
                source: Box::new(std::io::Cursor::new(b"ID3fake".to_vec())),
                ext: Some("mp3".into()),
                track_id: Some("online:qq:1".into()),
                reply: unit_reply(),
            },
        )
        .unwrap();
        assert!(ok);
        assert_eq!(state.track_id.as_deref(), Some("online:qq:1"));
        assert_eq!(backend.loaded.get(), Some("stream".to_string()));
    }
```

`std::io::Cursor<Vec<u8>>` 满足 `Read+Seek+Send`，无需额外包装。

- [ ] **Step 6: 全量构建测试**

Run: `cargo test -p vmusic-audio`
Expected: 含新测试在内全绿；null backend 因默认方法保持编译。

- [ ] **Step 7: Commit**

```bash
git add crates/vmusic-core/src/audio.rs crates/vmusic-audio/src/actor.rs crates/vmusic-audio/src/cpal_backend.rs
git commit -m "音频后端：LoadSource 接缝支持流式媒体源"
```

---

## Task 8: 淡入淡出增益斜坡

**Files:**
- Modify: `crates/vmusic-core/src/audio.rs`（trait 加 maintain 默认方法）
- Modify: `crates/vmusic-audio/src/actor.rs`（run 循环每 tick 调 maintain）
- Modify: `crates/vmusic-audio/src/cpal_backend.rs`（Shared 斜坡、pending 换装、尾部淡出）

- [ ] **Step 1: Shared 增加斜坡原子量与常量** —— cpal_backend.rs：

顶部常量区（`TAP_LEN` 附近）加：

```rust
const FADE_IN_MS: u64 = 250;
const FADE_OUT_MS: u64 = 200;
const TAIL_FADE_MS: u64 = 500;
```

`struct Shared` 的字段区加：

```rust
    /// 增益斜坡（单位：设备声道帧）。fade_frames=0 表示无斜坡，增益恒为 fade_gain。
    fade_gain: AtomicU32,
    fade_from: AtomicU32,
    fade_to: AtomicU32,
    fade_frames: AtomicU64,
    fade_done: AtomicU64,
```

`Shared::new()` 对应初始化：`fade_gain: AtomicU32::new(1.0f32.to_bits()), fade_from: AtomicU32::new(1.0f32.to_bits()), fade_to: AtomicU32::new(1.0f32.to_bits()), fade_frames: AtomicU64::new(0), fade_done: AtomicU64::new(0),`。

impl Shared 加方法：

```rust
    /// 每帧增益的纯函数（便于单测）。
    fn ramp_value(from: f32, to: f32, total: u64, done: u64) -> f32 {
        if total == 0 {
            return to;
        }
        let t = (done as f32 / total as f32).clamp(0.0, 1.0);
        from + (to - from) * t
    }

    fn arm_fade(&self, to: f32, ms: u64, rate: u32) {
        let from = f32::from_bits(self.fade_gain.load(Ordering::Relaxed));
        let frames = (ms as u128 * rate as u128 / 1000) as u64;
        self.fade_from.store(from.to_bits(), Ordering::Relaxed);
        self.fade_to.store(to.to_bits(), Ordering::Relaxed);
        self.fade_frames.store(frames, Ordering::Relaxed);
        self.fade_done.store(0, Ordering::Relaxed);
    }

    fn fade_active(&self) -> bool {
        self.fade_frames.load(Ordering::Relaxed) > 0
    }

    /// 换装/新曲：增益立即归 1，清掉一切斜坡与尾部淡出状态。
    fn reset_fade_shared(&self) {
        self.fade_gain.store(1.0f32.to_bits(), Ordering::Relaxed);
        self.fade_from.store(1.0f32.to_bits(), Ordering::Relaxed);
        self.fade_to.store(1.0f32.to_bits(), Ordering::Relaxed);
        self.fade_frames.store(0, Ordering::Relaxed);
        self.fade_done.store(0, Ordering::Relaxed);
    }
```

- [ ] **Step 2: write_samples 改为逐帧应用增益、tap 取淡变前** —— 替换现有 `write_samples` 函数体（169-213 行）为：

```rust
fn write_samples(data: &mut [f32], shared: &Shared, channels: usize) {
    if !shared.playing.load(Ordering::Relaxed) {
        for sample in data.iter_mut() {
            *sample = 0.0;
        }
        return;
    }

    let volume = f32::from_bits(shared.volume.load(Ordering::Relaxed));
    let mut copied = 0usize;
    if let Ok(mut queue) = shared.samples.lock() {
        copied = data.len().min(queue.len());
        for (i, sample) in queue.drain(..copied).enumerate() {
            data[i] = sample; // 先放原始样本，tap 要在淡变前取
        }
    }

    // 频谱 tap：淡变前信号（舞台可视化不随淡出塌陷）。
    if let Ok(mut tap) = shared.tap.try_lock() {
        let mut i = 0;
        while i + channels <= copied {
            let sum: f32 = data[i..i + channels].iter().sum();
            if tap.len() >= TAP_LEN {
                tap.pop_front();
            }
            tap.push_back(sum / channels as f32);
            i += channels * TAP_STRIDE;
        }
    }

    // 逐帧乘 用户音量 × 斜坡增益，每帧推进斜坡。
    let mut fade_total = shared.fade_frames.load(Ordering::Relaxed);
    let mut fade_done = shared.fade_done.load(Ordering::Relaxed);
    let fade_from = f32::from_bits(shared.fade_from.load(Ordering::Relaxed));
    let fade_to = f32::from_bits(shared.fade_to.load(Ordering::Relaxed));
    let mut gain = f32::from_bits(shared.fade_gain.load(Ordering::Relaxed));
    let frames = copied / channels.max(1);
    for f in 0..frames {
        if fade_total > 0 {
            fade_done += 1;
            gain = Shared::ramp_value(fade_from, fade_to, fade_total, fade_done);
            if fade_done >= fade_total {
                fade_total = 0;
                gain = fade_to;
            }
        }
        for c in 0..channels {
            let idx = f * channels + c;
            data[idx] = data[idx] * volume * gain;
        }
    }
    shared.fade_gain.store(gain.to_bits(), Ordering::Relaxed);
    shared.fade_done.store(fade_done, Ordering::Relaxed);
    shared.fade_frames.store(fade_total, Ordering::Relaxed);

    for sample in data.iter_mut().skip(copied) {
        *sample = 0.0;
    }
    if copied > 0 {
        shared
            .frames_played
            .fetch_add((copied / channels.max(1)) as u64, Ordering::Relaxed);
    }
}
```

- [ ] **Step 3: 斜坡纯函数 + 回调测试** —— cpal_backend.rs tests 模块加：

```rust
    #[test]
    fn ramp_value_is_linear_and_clamped() {
        assert_eq!(Shared::ramp_value(0.0, 1.0, 100, 0), 0.0);
        assert!((Shared::ramp_value(0.0, 1.0, 100, 50) - 0.5).abs() < 1e-6);
        assert_eq!(Shared::ramp_value(0.0, 1.0, 100, 100), 1.0);
        assert_eq!(Shared::ramp_value(0.0, 1.0, 100, 500), 1.0);
        assert_eq!(Shared::ramp_value(0.0, 1.0, 0, 0), 1.0);
    }

    #[test]
    fn fade_in_callback_grows_sample_gain_across_frames() {
        let shared = Shared::new();
        shared.playing.store(true, Ordering::Relaxed);
        // 2 声道、48k：200ms 淡入 = 9600 帧；放 4 帧数据验证趋势。
        shared.arm_fade(1.0, FADE_IN_MS, 48_000);
        shared.reset_fade_shared();
        shared.arm_fade(1.0, FADE_IN_MS, 48_000);
        // 队列里放 8 个样本（4 帧），全为 1。
        shared.samples.lock().unwrap().extend([1.0f32; 8]);
        let mut buf = vec![0.0f32; 8];
        write_samples(&mut buf, &shared, 2);
        // 淡入起点增益≈0：首帧样本幅值小于末帧。
        assert!(buf[0].abs() < buf[6].abs());
        assert!(buf[0] >= 0.0 && buf[0] < 0.01);
        assert!(shared.fade_active());
    }
```

- [ ] **Step 4: trait 与 actor 接入 maintain** —— vmusic-core/src/audio.rs 在 trait 末尾（`fn spectrum` 后）加默认方法：

```rust
    /// 每 20ms 由 actor 调一次：让后端在自己线程上完成延迟状态机
    /// （淡出后再暂停/停止、换装、尾部淡出）。默认空操作。
    fn maintain(&mut self) {}
```

actor.rs 的 run 主循环里，在 `Ok(cmd) => match apply(...)` 与 timeout 分支**之后**、`if !ended_emitted ...` 之前（约 256 行）加：

```rust
        backend.maintain();
```

- [ ] **Step 5: CpalBackend 的 pending 状态机** —— cpal_backend.rs：

(a) 文件顶部 use 加 `use std::io::Cursor;`（本任务不需要；跳过）。在 `DecoderCtl` 下方加 pending 载荷类型：

```rust
/// 换装的"半完成态"：probe 已做完，等旧源淡出到 0 再由 maintain 换。
struct PendingLoad {
    opened: OpenedReader,
    info: MediaInfo,
    play_after: bool,
}
```

（`OpenedReader` 与 `MediaInfo` 已在本文件定义/导入。）

(b) `struct CpalBackend` 字段区加：

```rust
    pending_pause: bool,
    pending_stop: bool,
    tail_armed: bool,
    pending_load: Option<PendingLoad>,
```

`CpalBackend::new()` 返回结构体里补四个初值 `pending_pause: false, pending_stop: false, tail_armed: false, pending_load: None,`。

(c) 把 Task 7 的占位 `fn reset_fade(&mut self) {}` 替换为：

```rust
    fn reset_fade(&mut self) {
        self.shared.reset_fade_shared();
        self.tail_armed = false;
        self.pending_pause = false;
        self.pending_stop = false;
        // pending_load 不在此清：换装路径自己决定存不存。
    }
```

(d) 重写 play/pause/stop（替换现有三个 trait 方法体）：

```rust
    fn play(&mut self) -> Result<(), AudioError> {
        self.ensure_stream()?;
        self.pending_pause = false;
        self.pending_stop = false;
        if let Some(pending) = self.pending_load.as_mut() {
            pending.play_after = true;
        }
        // 从淡出中点恢复也走淡入，不硬拉满。
        if self.shared.fade_active() || f32::from_bits(self.shared.fade_gain.load(Ordering::Relaxed)) < 0.999 {
            self.shared.arm_fade(1.0, FADE_IN_MS, self.device_rate);
        }
        self.shared.playing.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn pause(&mut self) -> Result<(), AudioError> {
        if self.shared.playing.load(Ordering::Relaxed) && !self.pending_pause {
            self.shared.arm_fade(0.0, FADE_OUT_MS, self.device_rate);
            self.pending_pause = true;
        }
        Ok(())
    }

    fn stop(&mut self) -> Result<(), AudioError> {
        if self.shared.playing.load(Ordering::Relaxed) && !self.pending_stop {
            self.shared.arm_fade(0.0, FADE_OUT_MS, self.device_rate);
            self.pending_stop = true;
        } else if !self.pending_stop {
            // 已暂停：立刻复位，不等斜坡。
            self.do_stop_reset();
        }
        Ok(())
    }
```

(e) 在 impl CpalBackend 加内部方法与 maintain：

```rust
    fn do_stop_reset(&mut self) {
        let _ = self.seek(0);
        self.clear_buffers();
        self.shared.frames_played.store(0, Ordering::Relaxed);
    }

    fn spawn_pending(&mut self) {
        let Some(pending) = self.pending_load.take() else { return };
        self.stop_decoder();
        self.clear_buffers();
        self.shared.frames_played.store(0, Ordering::Relaxed);
        self.duration_ms = pending.info.duration_ms;
        let PendingLoad { opened, info, play_after } = pending;
        let (format, decoder, track_id) = opened;
        let stop = Arc::new(AtomicBool::new(false));
        let seek_to = Arc::new(Mutex::new(None));
        let ctl = DecoderCtl { stop: stop.clone(), seek_to: seek_to.clone() };
        let shared = self.shared.clone();
        let device_rate = self.device_rate;
        let device_channels = self.device_channels.max(1) as usize;
        let handle = std::thread::Builder::new()
            .name("vmusic-decoder".into())
            .spawn(move || {
                decode_loop_opened((format, decoder, track_id), shared, stop, seek_to, device_rate, device_channels);
            })
            .expect("spawn decoder");
        self.decoder = Some((handle, ctl));
        let _ = info;
        self.shared.reset_fade_shared();
        if play_after {
            self.shared.arm_fade(1.0, FADE_IN_MS, self.device_rate);
            self.shared.playing.store(true, Ordering::Relaxed);
        } else {
            self.shared.playing.store(false, Ordering::Relaxed);
        }
    }

    fn maintain(&mut self) {
        let fading = self.shared.fade_active();

        if self.pending_pause && !fading {
            self.shared.playing.store(false, Ordering::Relaxed);
            self.pending_pause = false;
        }
        if self.pending_stop && !fading {
            self.pending_stop = false;
            self.do_stop_reset();
        }
        if self.pending_load.is_some() && !fading {
            self.spawn_pending();
        }

        // 自然结束前 500ms 尾部淡出（仅一次；seek 回去可重新武装）。
        if self.shared.playing.load(Ordering::Relaxed)
            && self.pending_load.is_none()
            && !self.pending_stop
        {
            if let Some(d) = self.duration_ms {
                let pos = self.position_ms();
                let remain = d.saturating_sub(pos);
                if !self.tail_armed && remain <= TAIL_FADE_MS && remain > 0 {
                    let frames = (remain as u128 * self.device_rate as u128 / 1000) as u64;
                    // 直接按剩余帧数装斜坡（不用 arm_fade 的固定毫秒）。
                    self.shared.fade_from
                        .store(f32::from_bits(self.shared.fade_gain.load(Ordering::Relaxed)).to_bits(),
                               Ordering::Relaxed);
                    self.shared.fade_to.store(0.0f32.to_bits(), Ordering::Relaxed);
                    self.shared.fade_frames.store(frames.max(1), Ordering::Relaxed);
                    self.shared.fade_done.store(0, Ordering::Relaxed);
                    self.tail_armed = true;
                }
                // 用户拖回主体段：允许再次武装。
                if pos + 100 < d.saturating_sub(TAIL_FADE_MS) {
                    self.tail_armed = false;
                }
            }
        }
    }
```

并在 `impl AudioBackend for CpalBackend` 块内加（trait 方法，委托给固有方法）：

```rust
    fn maintain(&mut self) {
        CpalBackend::maintain(self);
    }
```

(f) 改 open_and_spawn（Task 7 所写）的尾部：probe 成功后根据当前是否在播放决定"立即换装"还是"等淡出"。在 `let opened = (probed.format, decoder, track_id);` 这一行**之前**（decoder/track 已 move 进 opened，注意借用顺序），把"立即 spawn"的整段改为：

```rust
        let opened = (probed.format, decoder, track_id);
        let info = MediaInfo {
            duration_ms,
            sample_rate: params.sample_rate,
            channels: params.channels.map(|c| c.count() as u8),
        };
        let was_playing = self.shared.playing.load(Ordering::Relaxed);
        if was_playing {
            // 旧源先淡出 200ms，maintain 到点换装并淡入。
            self.shared.arm_fade(0.0, FADE_OUT_MS, self.device_rate);
            self.pending_load = Some(PendingLoad { opened, info, play_after: true });
            return Ok(info);
        }
        self.duration_ms = duration_ms;
        let (format, decoder, track_id) = opened;
        // 暂停态立即换装（下面沿用原 spawn 代码）。
        let opened = (format, decoder, track_id);
```

随后保留原本构造 stop/seek_to/handle/spawn 的代码（即把原来 `let opened = ...` 到 `self.decoder = Some(...)` 之间的 spawn 逻辑接到这里），最后 `Ok(info)`。要点：暂停态换装走立即 spawn、播放态走 pending；两条路都返回同一个 `info`。若实现时发现重复代码过多，把"立即 spawn"那 15 行抽成 `fn spawn_now(&mut self, opened: OpenedReader) -> ()` 供 open_and_spawn 与 spawn_pending 共用（spawn_pending 内联即可，不强制重构）。

- [ ] **Step 6: NullBackend 补 maintain** —— null.rs 若因 trait 新默认方法无需改动（默认空实现），跳过；若它显式 impl 了全部方法，加一个空 `fn maintain(&mut self) {}`。

- [ ] **Step 7: 构建测试**

Run: `cargo test -p vmusic-audio`
Expected: 全部 PASS（含两条新测试）。cpal 设备相关状态机（pending 换装、尾部淡出）由 Task 16 真机耳测覆盖。

- [ ] **Step 8: Commit**

```bash
git add crates/vmusic-core/src/audio.rs crates/vmusic-audio/src/actor.rs crates/vmusic-audio/src/cpal_backend.rs crates/vmusic-audio/src/null.rs
git commit -m "播放淡变：开播淡入、暂停/切歌/尾段淡出"
```

---

## Task 9: state.rs 接入边下边播、失败自动跳曲、历史、预取、buffering

**Files:**
- Modify: `crates/vmusicd/src/state.rs`（AppState、play_index_for、step、event pump）
- Modify: `crates/vmusicd/src/online/cache.rs`（加前缀查找）

- [ ] **Step 1: cache.rs 加不知扩展名的缓存查找** —— cache.rs 追加并加测试：

```rust
/// 不知道扩展名时按缓存键前缀查正式文件（跳过 .part 与旧名）。
/// 先精确匹配任意 `{key}.*`，找不到再回退旧名 `{stem}.mp3`。
pub async fn find_cached_by_key(
    dir: &Path,
    source: &str,
    id: &str,
    quality: &str,
) -> Option<PathBuf> {
    let stem = stem(source, id);
    let key = format!("{stem}-{quality}.");
    let legacy = dir.join(legacy_cache_name(source, id));
    if is_ready(&legacy).await {
        // 正式名优先，旧名其次。
    }
    let Ok(mut it) = fs::read_dir(dir).await else {
        return is_ready(&legacy).await.then_some(legacy);
    };
    while let Ok(Some(entry)) = it.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".part") && name.starts_with(&key) {
            let p = entry.path();
            if is_ready(&p).await {
                return Some(p);
            }
        }
    }
    is_ready(&legacy).await.then_some(legacy)
}
```

注意上面"先精确后旧名"的写法：删掉那个空 `if` 残留，正式逻辑是"扫描 key.* 命中即返回；扫描完无果再返回 legacy（若就绪）"。测试：

```rust
    #[tokio::test]
    async fn find_by_prefix_matches_any_ext_then_legacy() {
        let dir = std::env::temp_dir().join(format!("vmusic-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).await.unwrap();
        // 新键 m4a 存在 → 命中它。
        fs::write(dir.join("qq-a1-lossless.m4a"), vec![0u8; 2000]).await.unwrap();
        let hit = find_cached_by_key(&dir, "qq", "a1", "lossless").await.unwrap();
        assert!(hit.to_string_lossy().ends_with("qq-a1-lossless.m4a"));
        // 只有旧名时回退。
        let dir2 = std::env::temp_dir().join(format!("vmusic-cache-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir2).await.unwrap();
        fs::write(dir2.join("qq-a2.mp3"), vec![0u8; 2000]).await.unwrap();
        let hit2 = find_cached_by_key(&dir2, "qq", "a2", "lossless").await.unwrap();
        assert!(hit2.to_string_lossy().ends_with("qq-a2.mp3"));
    }
```

Run: `cargo test -p vmusicd online::cache::`，Expected: 3 PASS。

- [ ] **Step 2: AppState 新字段与类型** —— state.rs 顶部 use 区加：

```rust
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
```

`WsEvent` enum 在 `LibraryChanged` 前加变体：

```rust
    Buffering {
        active: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pct: Option<u8>,
    },
```

AppState 结构体在 `play_commit` 字段后加：

```rust
    /// 下载缓冲覆盖态（WS 与 /v1/state 共用）。
    pub(crate) buffering: Mutex<(bool, Option<u8>)>,
    /// /online/play 入队时随 tracks 带来的元数据快照（虚拟 id → 快照）。
    pub(crate) online_meta: Mutex<HashMap<String, OnlineMetaSnap>>,
    /// 进行中的下载器（缓存键 → Download），供预取接管与切歌中止。
    pub(crate) downloads: Mutex<HashMap<String, crate::online::progressive::Download>>,
    /// 自动接力连续失败计数，任一曲成功即清零；到 3 停止。
    pub(crate) auto_failures: AtomicUsize,
    /// 逐源音质偏好（启动加载、POST 即时更新）。
    pub(crate) quality: Mutex<crate::online::quality::QualityPrefs>,
```

文件中（AppState 外）加类型：

```rust
/// 在线曲目元数据快照（仅在内存，与队列同生命周期）。
#[derive(Debug, Clone)]
pub(crate) struct OnlineMetaSnap {
    pub source: String,
    pub ref_id: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover: Option<String>,
    pub duration_ms: Option<u64>,
}

/// 播放提交结果。
pub(crate) struct PlayOutcome {
    pub committed: bool,
    pub actual_quality: Option<crate::online::quality::Quality>,
}
```

main.rs 构造 AppState 的字面量补五个字段：`buffering: Default::default(), online_meta: Default::default(), downloads: Default::default(), auto_failures: Default::default(), quality: Default::default(),`（本任务先用 Default 让编译过；Task 11 改为 load 出的偏好值。）

- [ ] **Step 3: 缓冲/下载/历史辅助方法** —— state.rs impl AppState 内加：

```rust
    pub(crate) async fn set_buffering(&self, active: bool, pct: Option<u8>) {
        *self.buffering.lock().await = (active, pct);
        self.publish(WsEvent::Buffering { active, pct });
    }

    /// 中止全部在途下载（切歌/换队预留区调用）。
    pub(crate) async fn cancel_all_downloads(&self) {
        let mut map = self.downloads.lock().await;
        for (_, dl) in map.drain() {
            dl.cancel();
        }
    }

    /// 播放成功后的统一收口：清失败计数、写历史、触发预取。
    pub(crate) async fn on_track_committed(
        &self,
        track_id: &str,
        actual: Option<crate::online::quality::Quality>,
    ) {
        self.auto_failures.store(0, Ordering::Relaxed);
        self.record_history(track_id).await;
        self.spawn_prefetch().await;
        let _ = actual;
    }

    async fn record_history(&self, track_id: &str) {
        if let Some((source, ref_id)) = crate::online::split_virtual_id(track_id) {
            let snap = self.online_meta.lock().await.get(track_id).cloned();
            let (title, artist, album, cover, duration) = match snap {
                Some(m) => (m.title, m.artist, m.album, m.cover, m.duration_ms),
                None => (ref_id.clone(), None, None, None, None),
            };
            if let Err(e) = crate::history::upsert(&self.db, crate::history::HistoryEntry {
                track_id, source: &source, ref_id: &ref_id, title: &title,
                artist: artist.as_deref(), album: album.as_deref(),
                cover_url: cover.as_deref(), duration_ms: duration,
            }).await {
                tracing::warn!("写播放历史失败: {e}");
            }
        } else {
            // 本地曲：从库里取字段。
            if let Ok(Some(t)) = vmusic_store::get_track(&self.db, track_id).await {
                if let Err(e) = crate::history::upsert(&self.db, crate::history::HistoryEntry {
                    track_id: &t.id, source: "local", ref_id: &t.id, title: &t.title,
                    artist: t.artist.as_deref(), album: t.album.as_deref(),
                    cover_url: None, duration_ms: t.duration_ms,
                }).await {
                    tracing::warn!("写播放历史失败: {e}");
                }
            }
        }
    }
```

- [ ] **Step 4: 重写 play_index_for** —— 用下面版本整体替换现有 140-277 行函数（签名返回值改为 PlayOutcome）：

```rust
    pub(crate) async fn play_index_for(
        &self,
        index: usize,
        reserve_gen: Option<usize>,
        auto: bool,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        let commit = self.play_commit.lock().await;
        if let Some(expected) = reserve_gen {
            if self.play_generation.load(Ordering::Relaxed) != expected {
                return Ok(PlayOutcome { committed: false, actual_quality: None });
            }
        }
        let track_id = {
            let queue = self.queue.lock().await;
            match queue.get(index).cloned() {
                Some(t) => t,
                None => return Err(vmusic_core::CoreError::NotFound("queue index".into())),
            }
        };
        let gen = self
            .play_generation
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        let prev_cursor = *self.cursor.lock().await;
        *self.cursor.lock().await = Some(index);
        drop(commit);

        let outcome = if let Some((source, id)) = crate::online::split_virtual_id(&track_id) {
            self.play_online(gen, index, track_id.clone(), source, id, auto).await
        } else {
            self.play_local(gen, index, track_id.clone()).await
        }?;

        if outcome.committed {
            *self.cursor.lock().await = Some(index);
            self.on_track_committed(&track_id, outcome.actual_quality).await;
        }
        Ok(outcome)
    }

    async fn play_local(
        &self,
        gen: usize,
        index: usize,
        track_id: String,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        // 切到本地曲：在途在线下载（含预取）全部作废。
        self.cancel_all_downloads().await;
        let track = vmusic_store::get_track(&self.db, &track_id)
            .await
            .map_err(vmusic_core::CoreError::Store)?
            .ok_or_else(|| vmusic_core::CoreError::NotFound(track_id.clone()))?;
        let _commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            return Ok(PlayOutcome { committed: false, actual_quality: None });
        }
        self.audio
            .load(&track.path, Some(track_id.clone()))
            .await
            .map_err(vmusic_core::CoreError::Audio)?;
        if !self.attempt_alive(gen, index, &track_id).await {
            return Ok(PlayOutcome { committed: false, actual_quality: None });
        }
        self.audio.play().await.map_err(vmusic_core::CoreError::Audio)?;
        Ok(PlayOutcome {
            committed: self.attempt_alive(gen, index, &track_id).await,
            actual_quality: None,
        })
    }

    async fn play_online(
        &self,
        gen: usize,
        index: usize,
        track_id: String,
        source: String,
        id: String,
        auto: bool,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        self.set_buffering(true, None).await;

        let dir = self.online_cache_dir();
        let quality = {
            let prefs = self.quality.lock().await;
            crate::online::quality::get(&prefs, &source)
        };
        let qname = quality.as_str(); // &'static str
        let stem_key = crate::online::cache::cache_key(&source, &id, qname);

        // 只中止"别的"在途下载；同键说明是预取已在跑，下面直接接管，不重下。
        {
            let mut map = self.downloads.lock().await;
            let others: Vec<String> =
                map.keys().filter(|k| k.as_str() != stem_key).cloned().collect();
            for k in others {
                if let Some(old) = map.remove(&k) {
                    old.cancel();
                }
            }
        }

        // 快路径：缓存已就绪（任意扩展名 / 旧名回退）。
        let cached = {
            let dir = dir.clone();
            let source2 = source.clone();
            let id2 = id.clone();
            let qn = qname.to_string();
            tokio::task::spawn_blocking(move || {
                crate::online::cache::find_cached_by_key(&dir, &source2, &id2, &qn)
            })
            .await
            .unwrap_or(None)
        };
        if let Some(path) = cached {
            // 命中缓存：同键下载（如刚完成的预取）从注册表摘掉，句柄随 drop 释放。
            self.downloads.lock().await.remove(&stem_key);
            return self.commit_file(gen, index, track_id, path, None).await;
        }

        // 未缓存：若同键预取已在跑则直接接管；否则取流并新开下载。
        let (dl, actual) = {
            let existing = self.downloads.lock().await.remove(&stem_key);
            if let Some(dl) = existing {
                // 预取接管：actual 档位无法回填（预取时未保留 bitrate），不影响播放。
                (dl, None)
            } else {
                let ctx = crate::online::Ctx { db: self.db.clone() };
                let info = match crate::online::stream(
                    &ctx, &source, &id, None, Some(quality.bps()),
                ).await {
                    Ok(v) => v,
                    Err(e) => {
                        self.set_buffering(false, None).await;
                        return self
                            .online_failed(gen, index, track_id, prev_cursor, auto, e.with_source(source))
                            .await;
                    }
                };
                let actual = crate::online::quality::from_bitrate(info.bitrate);
                let urls: Vec<String> = std::iter::once(info.url.clone())
                    .chain(info.fallback_urls.iter().cloned())
                    .collect();
                let referer = crate::online::referer(&source).map(str::to_string);
                let dl = match crate::online::progressive::start(
                    dir.clone(), stem_key.clone(), urls, referer,
                ) {
                    Ok(dl) => dl,
                    Err(e) => {
                        self.set_buffering(false, None).await;
                        return self.online_failed(gen, index, track_id, prev_cursor, auto, e).await;
                    }
                };
                (dl, actual)
            }
        };

        // 预读等待（期间不断复核代际）。
        match dl.wait_prebuffer().await {
            Ok(_) => {}
            Err(e) => {
                self.set_buffering(false, None).await;
                dl.cancel();
                return self.online_failed(
                    gen, index, track_id, prev_cursor, auto,
                    crate::error::ApiError::upstream_timeout(e).with_source(source),
                ).await;
            }
        }

        // 容器探测：读 .part 头部 1MB（在 blocking 里）。
        let (mode, ext) = {
            let part = dl.part_path.clone();
            let sniffed = dl.ext();
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

        if mode == crate::online::progressive::StreamMode::WaitFull {
            // 推百分比直到下完；每 200ms 复核代际。
            loop {
                if !self.attempt_alive(gen, index, &track_id).await {
                    self.set_buffering(false, None).await;
                    dl.cancel();
                    return Ok(PlayOutcome { committed: false, actual_quality: None });
                }
                self.set_buffering(true, dl.pct()).await;
                if dl.is_finished() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let path = match dl.join().await {
                Ok(p) => p,
                Err(e) => {
                    self.set_buffering(false, None).await;
                    return self.online_failed(gen, index, track_id, prev_cursor, auto,
                        crate::error::ApiError::upstream_rejected(e).with_source(source)).await;
                }
            };
            self.set_buffering(false, None).await;
            return self.commit_file(gen, index, track_id, path, actual).await;
        }

        // Progressive：直接用 owned Download 构造解码源。
        let source_media = crate::online::progressive::HttpMediaSource::open(
            &dl.part_path, dl.inner.clone(), dl.abort.clone(),
        );
        let media = match source_media {
            Ok(m) => m,
            Err(e) => {
                self.set_buffering(false, None).await;
                dl.cancel();
                return self.online_failed(gen, index, track_id, prev_cursor, auto,
                    crate::error::ApiError::internal(e.to_string()).with_source(source)).await;
            }
        };

        let _commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            self.set_buffering(false, None).await;
            dl.cancel();
            return Ok(PlayOutcome { committed: false, actual_quality: None });
        }
        let info = match self.audio
            .load_source(Box::new(media), Some(ext.to_string()), Some(track_id.clone()))
            .await
        {
            Ok(v) => v,
            Err(e) => {
                self.set_buffering(false, None).await;
                dl.cancel();
                return self.online_failed(gen, index, track_id, prev_cursor, auto,
                    crate::error::ApiError::internal(e.to_string()).with_source(source)).await;
            }
        };
        if !self.attempt_alive(gen, index, &track_id).await {
            self.set_buffering(false, None).await;
            dl.cancel();
            return Ok(PlayOutcome { committed: false, actual_quality: None });
        }
        self.audio.play().await.map_err(vmusic_core::CoreError::Audio)?;
        let committed = self.attempt_alive(gen, index, &track_id).await;
        self.set_buffering(false, None).await;
        let _ = info;
        // 下载任务在后台继续到完成并 rename；Download 无 Drop 中止语义，
        // drop(handle) 不会取消 tokio 任务（handle 只是接收端）。
        drop(dl);
        Ok(PlayOutcome { committed, actual_quality: actual })
    }
```

本函数依赖的两个 progressive.rs 配套项（写代码时一并加上，已含在 Task 6 的修改里则跳过）：

1. `impl Download` 加 `pub fn is_finished(&self) -> bool { *self.inner.finished.lock().unwrap() }`（WaitFull 轮询用）。
2. `cache::cache_key(source,id,quality) -> String`（见 Step 1，已给代码）。

`/online/play` 占队列预取失败仍走 routes 里的旧 `online_play_failed`（还原队列快照），与本函数的 `online_failed`（播放时收口/跳曲）是两条路径，不要合并。

两点设计取舍（与 spec 措辞的显式偏差，按此实现）：

1. **解码失败不做"同曲立即重取一次"**：probe 失败时 `.part` 已由 `dl.cancel()` 删除（满足"不留坏缓存"）；自动接力直接跳下一首，手动点播由前端错误条的「重试」按钮打 `/v1/player/replay` 做一次全新取流。传输层的"续传/换 URL 重试"在下载器内部已完整覆盖。
2. **预取竞态的窄窗口接受**：spawn_prefetch 在 `stream()` await 期间、正式播放同键切入时，双方可能各发一次取流（窗口数百毫秒）；`progressive::start` 会先 truncate 同名 `.part`，败者任务写入失败后走自身错误路径，不影响赢家。不为此引入第二张 in-progress 表（YAGNI）。

- [ ] **Step 5: commit_file 与 online_failed（含自动跳曲）** —— state.rs impl AppState 加：

```rust
    /// 缓存就绪曲目的提交（本地路径，走原 load 快路径）。
    async fn commit_file(
        &self,
        gen: usize,
        index: usize,
        track_id: String,
        path: std::path::PathBuf,
        actual: Option<crate::online::quality::Quality>,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        let _commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            self.set_buffering(false, None).await;
            return Ok(PlayOutcome { committed: false, actual_quality: None });
        }
        let uri = path.to_str().ok_or_else(|| {
            vmusic_core::CoreError::NotFound("路径含非 UTF-8 字符".into())
        })?;
        self.audio
            .load(uri, Some(track_id.clone()))
            .await
            .map_err(vmusic_core::CoreError::Audio)?;
        if !self.attempt_alive(gen, index, &track_id).await {
            self.set_buffering(false, None).await;
            return Ok(PlayOutcome { committed: false, actual_quality: None });
        }
        self.audio.play().await.map_err(vmusic_core::CoreError::Audio)?;
        let committed = self.attempt_alive(gen, index, &track_id).await;
        self.set_buffering(false, None).await;
        Ok(PlayOutcome { committed, actual_quality: actual })
    }

    /// 在线曲播放失败收口。`auto=true`（自然结束接力）按连续失败计数自动跳曲；
    /// `auto=false`（用户手动点播）停在当前曲并推可操作错误。
    async fn online_failed(
        &self,
        gen: usize,
        index: usize,
        track_id: String,
        prev_cursor: Option<usize>,
        auto: bool,
        e: crate::error::ApiError,
    ) -> Result<PlayOutcome, vmusic_core::CoreError> {
        let _commit = self.play_commit.lock().await;
        if !self.attempt_alive(gen, index, &track_id).await {
            return Ok(PlayOutcome { committed: false, actual_quality: None });
        }
        *self.cursor.lock().await = prev_cursor;

        if auto {
            let n = self.auto_failures.fetch_add(1, Ordering::Relaxed) + 1;
            self.publish(WsEvent::Error {
                message: format!("《{}》暂不可用，已跳过", track_title(&track_id)),
                code: Some(e.code.to_string()),
                source: e.source.clone(),
            });
            if n >= 3 {
                self.publish(WsEvent::Error {
                    message: "连续多首无法播放，已停止。可检查音源登录或网络后重试。".into(),
                    code: Some("online_unavailable_streak".into()),
                    source: e.source.clone(),
                });
                return Err(vmusic_core::CoreError::NotFound(e.message));
            }
            drop(_commit);
            // 自动跳下一首（仍按当前模式 step）。
            let _ = self.step(1, true).await;
            return Ok(PlayOutcome { committed: false, actual_quality: None });
        }

        // 手动：停在当前曲，推可操作错误（前端给 重试/下一首）。
        self.publish(WsEvent::Error {
            message: e.message.clone(),
            code: Some(e.code.to_string()),
            source: e.source.clone(),
        });
        Err(vmusic_core::CoreError::NotFound(e.message))
    }
```

`track_title` 小工具（文件底部自由函数）：

```rust
fn track_title(track_id: &str) -> String {
    // 失败 toast 用标题更好，但 state 层此刻拿不到锁外快照；退而显示 id 尾段。
    track_id.rsplit(':').next().unwrap_or(track_id).to_string()
}
```

`auto` 已沿 `play_index_for(auto) → play_online(auto) → online_failed(auto)` 显式传参（Step 4 签名已定）；三个调用方：`play_index` 传 false、`step` 传 true、`/online/play` 传 false（见 Step 7 与 Task 10）。routes 里的旧 `online_play_failed`（占队预取失败、还原队列快照）保留不动。

- [ ] **Step 6: 预取** —— impl AppState 加：

```rust
    /// 当前曲提交后按当前模式 peek 下一首，在线且未缓存则后台预热（最多 1 个）。
    async fn spawn_prefetch(&self) {
        let mode = self.audio.snapshot().mode;
        let queue = self.queue.lock().await.clone();
        let len = queue.len();
        if len < 2 {
            return;
        }
        let current = self.cursor.lock().await.unwrap_or(0);
        let next = match mode {
            vmusic_core::PlayMode::RepeatOne => return, // 单曲循环不预取
            // 与 step() 同一条随机规则（不推进游标，只 peek）。
            vmusic_core::PlayMode::Shuffle => random_index(len, Some(current)),
            _ => {
                if current + 1 >= len { 0 } else { current + 1 }
            }
        };
        let Some((source, id)) = queue.get(next).and_then(|v| crate::online::split_virtual_id(v)) else {
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
        let ctx = crate::online::Ctx { db: self.db.clone() };
        let Ok(info) = crate::online::stream(&ctx, &source, &id, None, Some(quality.bps())).await else {
            return;
        };
        let urls: Vec<String> = std::iter::once(info.url).chain(info.fallback_urls).collect();
        let referer = crate::online::referer(&source).map(str::to_string);
        match crate::online::progressive::start(dir, key.clone(), urls, referer) {
            Ok(dl) => {
                self.downloads.lock().await.insert(key, dl);
            }
            Err(e) => tracing::debug!("预取启动失败: {e}"),
        }
    }
```

shuffle 预取要用与 step() 相同的随机规则但不推进。把 state.rs 里 `random_index` 复用即可（自由函数已存在）：直接 `random_index(len, Some(current))`，删掉对 `state_peek::shuffle_peek` 的引用，`use` 不需要新增模块。

- [ ] **Step 7: 更新调用点与 step()** —— `play_index` 改：

```rust
    pub async fn play_index(&self, index: usize) -> Result<(), vmusic_core::CoreError> {
        self.play_index_for(index, None, false).await.map(|_| ())
    }
```

`step()` 末尾的 `self.play_index(next).await` 改为 `self.play_index_for(next, None, true).await.map(|_| ())`。

routes.rs 里 `state.play_index_for(index, Some(gen))` 的调用（约 1286 行）改为接收 PlayOutcome：

```rust
    let outcome = state.play_index_for(index, Some(gen), false).await?;
    if !outcome.committed {
        return Ok(get_state(State(state.clone())).await);
    }
```

同时**删除 online_play 里旧的整首预热块**（现 1272-1280 行：`let dir = state.online_cache_dir();` 到 `if let Err(e) = tagged(... fetch_to_cache ...) { return settle_online_play(...) }`）。取流/下载已全部由 play_index_for 内部按音质偏好完成；保留它会导致首曲被下载两遍，且 Task 11 删除 fetch_to_cache 后编译失败。删除后，`info`（stream 结果）在该路由函数里不再被使用——把它前面 `let ctx = online_ctx(&state);` 与 `let info = match tagged(online::stream(...))` 那一整段（1245-1271 行）一并删除；settle_online_play 仍用于其他失败路径，保留。

并在成功响应 JSON 里加实际档位（在现有 `Ok(Json(json!({...})))` 对象中加一行）：

```rust
        "actual_quality": outcome.actual_quality.map(|q| q.as_str()),
```

- [ ] **Step 8: 编译并逐个修完借用/签名错误**

Run: `cargo build -p vmusicd`
Expected: 第一次会有若干借用检查错误（最可能：持锁跨 await、`dl` move 顺序、auto 参数漏传）。按本任务的"实现说明"逐条修正，直到编译通过。不要用 `unwrap()` 掩盖 `downloads` 取键 None——取出前一定先 insert。

- [ ] **Step 9: 全量测试**

Run: `cargo test`
Expected: 全绿（既有 qq/kugou/store 测试不回归）。

- [ ] **Step 10: Commit**

```bash
git add crates/vmusicd/src/state.rs crates/vmusicd/src/online/cache.rs crates/vmusicd/src/online/progressive.rs crates/vmusicd/src/main.rs crates/vmusicd/src/routes.rs
git commit -m "在线播放：边下边播接入、失败自动跳曲、历史写入与下一首预取"
```

---

## Task 10: 历史 API、/state 合并 buffering、/online/play 元数据入暂存

**Files:**
- Modify: `crates/vmusicd/src/routes.rs`

- [ ] **Step 1: 注册历史路由** —— router() 在 `.route("/v1/recommend/daily", ...)` 下一行加：

```rust
        .route("/v1/history", get(history_list).delete(history_clear))
        .route("/v1/history/{id}", axum::routing::delete(history_remove))
        .route("/v1/player/replay", post(replay_index))
```

- [ ] **Step 2: 三个历史/重放 handler** —— 放在 daily_recommend handler 附近：

```rust
#[derive(Debug, Deserialize)]
struct HistoryQuery {
    limit: Option<i64>,
}

async fn history_list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 100);
    let items = crate::history::list_recent(&state.db, limit)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "items": items })))
}

async fn history_clear(
    State(state): State<Arc<AppState>>,
) -> ApiResult<Json<serde_json::Value>> {
    let n = crate::history::clear(&state.db)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(serde_json::json!({ "removed": n })))
}

async fn history_remove(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<i64>,
) -> ApiResult<Json<serde_json::Value>> {
    let n = crate::history::remove(&state.db, id)
        .await
        .map_err(ApiError::internal)?;
    if n == 0 {
        return Err(bad_request("历史记录不存在"));
    }
    Ok(Json(serde_json::json!({ "removed": n })))
}

#[derive(Debug, Deserialize)]
struct ReplayRequest {
    index: usize,
}

/// 错误条「重试」：重新播放当前队列指定下标（在线曲重新取流）。
async fn replay_index(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ReplayRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    state
        .play_index_for(body.index, None, false)
        .await
        .map_err(|e| crate::error::ApiError::internal(e.to_string()))?;
    Ok(get_state(State(state)).await)
}
```

- [ ] **Step 3: /v1/state 合并 buffering** —— `get_state`（195-197 行）替换为：

```rust
async fn get_state(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let mut v = serde_json::to_value(state.audio.snapshot()).unwrap_or_default();
    if let Some(obj) = v.as_object_mut() {
        let (active, pct) = *state.buffering.lock().await;
        obj.insert("buffering".into(), serde_json::Value::Bool(active));
        if let Some(p) = pct {
            obj.insert("buffer_pct".into(), serde_json::Value::from(p));
        }
    }
    Json(v)
}
```

- [ ] **Step 4: /online/play 把 tracks 元数据写入 online_meta** —— online_play 函数在 `let (gen, prev_queue, prev_cursor) = state.set_queue(...).await;`（1243 行）之后加：

```rust
    // 整盘元数据入内存暂存：play_index_for 提交成功后据此写历史。
    {
        let mut meta = state.online_meta.lock().await;
        for (t, vid) in tracks.iter().zip(vids.iter()) {
            meta.insert(vid.clone(), crate::state::OnlineMetaSnap {
                source: source.clone(),
                ref_id: t.id.clone(),
                title: t.title.clone().unwrap_or_else(|| t.id.clone()),
                artist: t.artist.clone(),
                album: t.album.clone(),
                cover: t.cover.clone(),
                duration_ms: Some(t.duration_ms).filter(|v| *v > 0),
            });
        }
    }
```

`OnlineMetaSnap` 当前是 `pub(crate)`，routes 同 crate 可见。若字段可见性报错，保持 pub(crate) 即可（同 crate）。

- [ ] **Step 5: 音质热切换端点补回 state.quality 更新** —— Task 3 Step 5 省略的那一行，现在补到 online_quality_set 成功返回前：

```rust
    state.quality.lock().await.insert(body.source.clone(), q);
```

- [ ] **Step 6: 编译测试**

Run: `cargo test -p vmusicd`
Expected: 全绿。用 curl 烟测三个历史端点（服务启动方式见 Task 16；本步至少 `cargo build` 成功）。

- [ ] **Step 7: Commit**

```bash
git add crates/vmusicd/src/routes.rs
git commit -m "历史 API 与缓冲状态：history 端点、replay、state 合并、元数据暂存"
```

---

## Task 11: 启动接线：偏好装载、.part 清理、LRU、配置生效

**Files:**
- Modify: `crates/vmusicd/src/main.rs`
- Modify: `crates/vmusicd/src/state.rs`（AppState::new 辅助或在 main 填充）

- [ ] **Step 1: 启动时装载音质偏好** —— main.rs 在 `let state = Arc::new(AppState {...})` **之前**加：

```rust
    let quality_prefs = crate::online::quality::load(&db).await.unwrap_or_default();
```

AppState 字面量里 `quality: Default::default()` 改为 `quality: tokio::sync::Mutex::new(quality_prefs),`。

- [ ] **Step 2: 清理残留 .part + 启动一次 LRU** —— 在 `spawn_event_pump(state.clone());`（127 行）之后加：

```rust
    // 清掉上次崩溃留下的半截下载，并按配置做一次缓存容量回收。
    {
        let cache_dir = state.online_cache_dir();
        crate::online::cache::clean_parts(&cache_dir).await;
        let max = state.config.online.cache_max_bytes;
        if let Err(e) = crate::online::cache::enforce_limit(&cache_dir, max, &[]).await {
            tracing::warn!("缓存 LRU 回收失败: {e}");
        }
    }
```

- [ ] **Step 3: 每次下载落盘后 LRU（后台，不阻塞播放）** —— state.rs 的 `on_track_committed` 末尾（spawn_prefetch 之后）加：

```rust
        // 落盘后做一次容量回收（缓存文件可能是预取/边播刚 rename 的）。
        let cache_dir = self.online_cache_dir();
        let max = self.config.online.cache_max_bytes;
        tokio::spawn(async move {
            if let Err(e) = crate::online::cache::enforce_limit(&cache_dir, max, &[]).await {
                tracing::warn!("缓存 LRU 回收失败: {e}");
            }
        });
```

注意 LRU 不能删掉"正在播放/正在下载"文件：传给 enforce_limit 的 protected 应包含当前下载键对应的正式文件名与全部 .part（.part 已内置跳过）。把当前播放 track 对应的缓存文件名算出传入：若 track_id 是 online id，用 `cache_key + 任意扩展名` 无法精确给名——enforce_limit 内部按全名匹配。简化：LRU 仅在**下载任务完成后**跑，且 .part 全部受保护；当前曲刚 rename 的正式文件理论上可能被立刻删（超容量极严重时）。为安全，给 enforce_limit 增加"最新 mtime 的文件始终保留最近 1 个"的策略过于隐晦——直接在调用点把 downloads map 中所有 key 的可能文件名传入不现实（扩展名不定）。采用：protected 传当前播放 track 对应文件全名——从 audio snapshot track_id + quality + 已知 ext（历史/快照没有 ext）。

落实为最小安全实现：**enforce_limit 始终保留 mtime 最新的 1 个文件**（刚落盘的就是最新），在 cache.rs enforce_limit 排序后、删除循环中跳过排序最后一个。修改 Task 5 所写函数：排序后记录 `let newest = files.last().map(|(p,..)| p.clone());`，删除时 `if Some(path)==newest { continue; }`。给 Task 5 的 evicts_oldest 测试补一条断言"3 个文件、上限 25KB（2.5 个文件）时，删除 1 个且最新的保留"（原测试已隐含：删后剩 2，最新两个保留）。无需新增测试。

- [ ] **Step 4: 删除旧 fetch_to_cache** —— Task 9 后在线播放不再走它；确认全仓 grep 无调用（`rg fetch_to_cache`），删除 online/mod.rs 的 `fetch_to_cache` 与 Task 5 留的 `cache_name_legacy`（若已无引用）。`cache::legacy_cache_name` 保留（find_cached_by_key 用）。

Run: `rg "fetch_to_cache|cache_name_legacy" crates/` → 期望无结果后再删。

- [ ] **Step 5: 全量构建测试**

Run: `cargo test`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add crates/vmusicd/src/main.rs crates/vmusicd/src/state.rs crates/vmusicd/src/online/cache.rs crates/vmusicd/src/online/mod.rs
git commit -m "启动接线：音质偏好装载、part 清理与缓存 LRU 生效"
```

---

## Task 12: 前端「最近播放」区块

**Files:**
- Modify: `crates/vmusicd/web/index.html:331-336`
- Modify: `crates/vmusicd/web/online.js`（initOnline 与 window.Online 导出）
- Modify: `crates/vmusicd/web/online.css`

- [ ] **Step 1: index.html 加容器** —— 在 `<div id="online-plugins" ...>` 内、`<div class="op-section-title">我的账号</div>`（332 行）**之前**插入：

```html
      <div id="op-history" class="op-history" hidden>
        <div class="op-section-title op-history-head">
          <span>最近播放</span>
          <button id="op-history-clear" class="op-history-clear" type="button">清空</button>
        </div>
        <div id="op-history-list" class="op-history-list"></div>
      </div>
```

- [ ] **Step 2: online.css 加样式**（文件末尾追加，全部使用现有令牌）：

```css
/* 最近播放 */
.op-history{margin:8px 0 4px}
.op-history-head{display:flex;align-items:center;justify-content:space-between}
.op-history-clear{background:none;border:none;color:var(--muted);font:inherit;font-size:12px;
  cursor:pointer;padding:2px 6px;border-radius:6px}
.op-history-clear:hover{color:var(--text);background:rgba(255,255,255,.06)}
.op-history-list{display:flex;flex-direction:column;gap:2px;margin:4px 0 8px}
.op-history-item{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:10px;
  cursor:pointer;transition:background .15s var(--ease)}
.op-history-item:hover{background:rgba(var(--accent-rgb),.1)}
.op-history-item .op-h-cover{width:34px;height:34px;flex:none;border-radius:7px;
  background:var(--panel-2) center/cover no-repeat;
  display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--muted)}
.op-history-item .op-h-main{flex:1;min-width:0}
.op-history-item .op-h-title{font-size:13px;color:var(--text);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.op-history-item .op-h-sub{font-size:11px;color:var(--muted);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.op-history-item .op-h-time{font-size:11px;color:var(--muted);flex:none}
.op-history-item .op-h-del{background:none;border:none;color:var(--muted);cursor:pointer;
  font-size:14px;line-height:1;padding:2px 6px;border-radius:6px;opacity:0}
.op-history-item:hover .op-h-del{opacity:1}
.op-history-item .op-h-del:hover{color:#ff8a8a;background:rgba(255,90,90,.12)}
.op-h-src{font-size:10px;padding:1px 6px;border-radius:999px;
  background:rgba(var(--accent-rgb),.14);color:var(--text);flex:none}
```

- [ ] **Step 3: online.js 加历史逻辑** —— 在 `function initOnline()` 之前插入：

```javascript
  // ---- 最近播放（服务端 play_history，个人区区块）----
  function relTime(ms) {
    var d = new Date(ms);
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    if (sameDay) {
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
    var yesterday = new Date(today.getTime() - 86400000);
    if (d.toDateString() === yesterday.toDateString()) return '昨天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  async function loadHistory() {
    var host = H.ui.opHistory;
    if (!host) return;
    var data;
    try {
      data = await T.get('/v1/history?limit=20');
    } catch (e) {
      host.hidden = true;
      return;
    }
    var items = (data && data.items) || [];
    host.hidden = items.length === 0;
    var list = H.ui.opHistoryList;
    list.textContent = '';
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'op-history-item';

      var cover = document.createElement('div');
      cover.className = 'op-h-cover';
      if (it.cover_url) {
        cover.style.backgroundImage = 'url("' + safeCoverUrl(it.cover_url) + '")';
      } else {
        cover.textContent = '♪';
      }

      var main = document.createElement('div');
      main.className = 'op-h-main';
      var title = document.createElement('div');
      title.className = 'op-h-title';
      title.textContent = it.title || it.ref_id;
      var sub = document.createElement('div');
      sub.className = 'op-h-sub';
      sub.textContent = [it.artist, it.album].filter(Boolean).join(' · ') || '未知艺术家';
      main.append(title, sub);

      var src = document.createElement('span');
      src.className = 'op-h-src';
      src.textContent = it.source === 'local' ? '本地' : sourceLabel(it.source);

      var time = document.createElement('span');
      time.className = 'op-h-time';
      time.textContent = relTime(it.played_at);

      var del = document.createElement('button');
      del.className = 'op-h-del';
      del.type = 'button';
      del.title = '移除';
      del.textContent = '×';
      del.onclick = async function (e) {
        e.stopPropagation();
        try {
          await T.delete('/v1/history/' + it.id);
          loadHistory();
        } catch (err) {
          H.toast('移除失败', 'error');
        }
      };

      row.append(cover, main, src, time, del);
      row.addEventListener('click', function () {
        replayHistory(it);
      });
      list.appendChild(row);
    });
  }

  // 点击历史行：在线曲按整盘单曲重新入队（服务端实时取流，URL 不过期问题）；
  // 本地曲放进本地队列播放。
  function replayHistory(it) {
    if (it.source === 'local') {
      // 本地曲走与曲库行相同的入口：/v1/player/load（PUT /queue 不会起播）。
      T.post('/v1/player/load', { track_id: it.track_id, queue: [it.track_id] })
        .then(function () { H.toast('播放《' + it.title + '》'); })
        .catch(function (err) { H.toast(H.errText('播放失败', err), 'error'); });
      return;
    }
    var track = {
      source: it.source,
      id: it.ref_id,
      title: it.title,
      artist: it.artist || '',
      album: it.album || '',
      duration_ms: it.duration_ms || 0,
      cover: it.cover_url || '',
      playable: true,
    };
    playAll([track], 0);
  }
```

注意：transport 已有 get/post/put（app.js:619 已用 put）。`delete` 大概率缺失——Task 14 Step 3 统一补上，本任务直接用 `T.delete(...)`。本地重听走 `/v1/player/load`（已核实，PUT /queue 不起播）。

- [ ] **Step 4: 接线 init 与导出** —— initOnline() 末尾（`loadSources();` 旁）加 `loadHistory();`。window.Online 导出对象加 `reloadHistory: loadHistory,`。

- [ ] **Step 5: host 注入新 DOM 引用** —— app.js 中构造 Online.bind(host) 的 host 对象（grep `Online.bind({`），确认 host 即含 `ui`；新元素通过 `document.getElementById` 取即可。在 online.js 顶部 H 注释所列 ui 用法处，用局部 helper：

```javascript
  function $(id) { return document.getElementById(id); }
```

（若文件内无 `$`，在 IIFE 顶部加；已有则复用。）把 loadHistory 内 `H.ui.opHistory / H.ui.opHistoryList` 改为 `$('op-history') / $('op-history-list')`，清空按钮绑定：

```javascript
    var clearBtn = $('op-history-clear');
    if (clearBtn) {
      clearBtn.onclick = async function () {
        try {
          await T.delete('/v1/history');
          loadHistory();
        } catch (e) {
          H.toast('清空失败', 'error');
        }
      };
    }
```

- [ ] **Step 6: 切回在线视图时刷新** —— `onViewEnter` 内加 `loadHistory();`（与 search 并列）。

- [ ] **Step 7: 跑契约检查与手测**

Run: `node scripts/check-online.js`
Expected: 现有断言不回归（本任务不改既有函数行为）。
浏览器：在线面板个人区出现"最近播放"；播一首在线曲后切走再回来，行置顶；清空/单删可用。

- [ ] **Step 8: Commit**

```bash
git add crates/vmusicd/web/index.html crates/vmusicd/web/online.js crates/vmusicd/web/online.css
git commit -m "在线面板：最近播放区块（重听/单删/清空）"
```

---

## Task 13: 前端音质档位选择器、缓冲态、实际档位标

**Files:**
- Modify: `crates/vmusicd/web/index.html:297-301`
- Modify: `crates/vmusicd/web/online.js`
- Modify: `crates/vmusicd/web/online.css`
- Modify: `crates/vmusicd/web/app.js`（WS buffering/error 分支在 Task 14，本任务先做面板内 UI）

- [ ] **Step 1: index.html 工具区加档位选择与错误条** —— `<div class="col-tools">`（297 行）内在 `#online-source` select 之后加：

```html
        <select id="online-quality" class="online-quality" aria-label="音质档位" title="音质档位"></select>
```

在在线滚动容器顶部（`#online-scroll` 内、`.online-search` 之前）加错误条：

```html
      <div id="online-errorbar" class="online-errorbar" hidden>
        <span id="online-error-text" class="online-error-text"></span>
        <span class="online-error-actions">
          <button id="online-error-retry" class="btn" type="button">重试</button>
          <button id="online-error-next" class="btn primary" type="button">下一首</button>
          <button id="online-error-close" class="iconbtn" type="button" aria-label="关闭">×</button>
        </span>
      </div>
```

- [ ] **Step 2: online.css 加样式**：

```css
.online-quality{height:32px;border-radius:8px;border:1px solid var(--line);
  background:var(--panel-2);color:var(--text);font:inherit;font-size:12px;padding:0 8px}
.online-errorbar{display:flex;align-items:center;gap:10px;margin:8px 0;padding:9px 12px;
  border-radius:10px;border:1px solid rgba(255,150,120,.4);
  background:rgba(255,120,80,.1);font-size:13px;color:var(--text)}
.online-error-text{flex:1;min-width:0}
.online-error-actions{display:flex;gap:6px;align-items:center}
.online-error-actions .btn{padding:4px 12px;font-size:12px}
.actual-q{font-size:10px;color:#ffc46b;margin-left:6px}
```

- [ ] **Step 3: online.js 加载档位选项** —— 新增：

```javascript
  var qualityMap = {}; // source -> "standard"/...

  async function loadQualityPrefs() {
    var data = await T.get('/v1/online/quality').catch(function () { return null; });
    var prefs = (data && data.prefs) || [];
    qualityMap = {};
    prefs.forEach(function (p) { qualityMap[p.source] = p.selected; });
    renderQualityOptions();
  }

  function renderQualityOptions() {
    var sel = document.getElementById('online-quality');
    if (!sel) return;
    var src = onlineState.source;
    var data = null;
    // 选项表来自 /v1/online/quality 的描述（缓存在 qualityDesc）。
    (window.__qualityDesc || []).forEach(function (p) {
      if (p.source === src) data = p;
    });
    if (!data) { sel.hidden = true; return; }
    sel.hidden = false;
    var keep = qualityMap[src] || data.selected;
    sel.textContent = '';
    (data.options || []).forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    sel.value = keep;
  }
```

`loadSources` 成功后（拿到 sources 的同一处）调用 `loadQualityPrefs()`；并在 loadQualityPrefs 里把原始描述挂到 `window.__qualityDesc = data.prefs`。音源下拉 onchange 处理函数里（已有分支末尾）加 `renderQualityOptions();`。

- [ ] **Step 4: 档位切换（保存 + 热切换）** —— initOnline 内绑定：

```javascript
    var qSel = document.getElementById('online-quality');
    if (qSel) {
      qSel.onchange = async function () {
        var src = onlineState.source;
        var q = qSel.value;
        try {
          await T.post('/v1/online/quality', { source: src, quality: q });
          qualityMap[src] = q;
          // 正在播该音源在线曲 → 服务端热切换（按当前队列下标重新取流，接续进度）。
          var snap = H.state.snapshot || {};
          if (snap.track_id && snap.track_id.indexOf('online:' + src + ':') === 0) {
            var ids = (H.state.queueIds || []);
            var idx = ids.indexOf(snap.track_id);
            if (idx >= 0) {
              H.ui.playpause.classList.add('is-loading');
              try {
                await T.post('/v1/player/replay', { index: idx });
                H.toast('已切换到' + qSel.options[qSel.selectedIndex].textContent);
              } finally {
                H.ui.playpause.classList.remove('is-loading');
              }
            }
          }
        } catch (err) {
          H.toast(H.errText('音质切换失败', err), 'error');
          renderQualityOptions();
        }
      };
    }
```

`H.state.queueIds` 需要 app.js 暴露队列 id 数组：grep `setStateQueue`（它已接收 ids）——在 app.js 该函数里把 ids 存到 `state.queueIds = ids`（Task 14 Step 2 做；本任务按该约定写）。

- [ ] **Step 5: 实际档位标** —— playAll 成功响应处理里（现有 `var res = await T.post('/v1/online/play', ...)` 之后）加：

```javascript
    if (res.actual_quality) {
      var labelMap = { standard: '标准', exhigh: '高品 320k', lossless: '无损', hires: 'Hi-Res' };
      var requested = qualityMap[source];
      if (requested && requested !== res.actual_quality && !window.__qtoast) {
        window.__qtoast = true;
        H.toast('该曲目实际可用：' + (labelMap[res.actual_quality] || res.actual_quality));
      }
      var tech = H.ui.nowTech;
      if (tech) tech.textContent = '在线 · ' + (labelMap[res.actual_quality] || res.actual_quality);
    }
```

- [ ] **Step 6: 错误条显示/隐藏 helper + 重试/下一首按钮** —— online.js 加并导出给 app.js Task 14 调用：

```javascript
  function showOnlineError(message, retryIndex) {
    var bar = document.getElementById('online-errorbar');
    if (!bar) { H.toast(message, 'error'); return; }
    document.getElementById('online-error-text').textContent = message;
    bar.hidden = false;
    bar.dataset.index = retryIndex == null ? '' : String(retryIndex);
    document.getElementById('online-error-retry').onclick = function () {
      bar.hidden = true;
      var idx = Number(bar.dataset.index);
      if (bar.dataset.index !== '' && !Number.isNaN(idx)) {
        T.post('/v1/player/replay', { index: idx }).catch(function () {});
      }
    };
    document.getElementById('online-error-next').onclick = function () {
      bar.hidden = true;
      T.post('/v1/player/next', {}).catch(function (e) { H.toast(H.errText('下一首失败', e), 'error'); });
    };
    document.getElementById('online-error-close').onclick = function () { bar.hidden = true; };
  }
  function hideOnlineError() {
    var bar = document.getElementById('online-errorbar');
    if (bar) bar.hidden = true;
  }
```

window.Online 导出加 `showOnlineError: showOnlineError, hideOnlineError: hideOnlineError,`。

- [ ] **Step 7: 缓冲视觉** —— app.js 播放按钮已有 `is-loading` 类（playAll 在用）。Task 14 的 buffering 事件会复用它；本任务先确认 style.css / stage.css 里 `.is-loading` 已有旋转样式（grep）；WaitFull 百分比通过按钮 title 展示，无需新增 CSS。

- [ ] **Step 8: 契约检查**

Run: `node scripts/check-online.js`
Expected: 全绿（若 checker 对 DOM 桩有严格枚举，新 getElementById 走桩的 `makeEl(id)` 返回通用元素即可，参考既有 `online-source` 的取法）。

- [ ] **Step 9: Commit**

```bash
git add crates/vmusicd/web/index.html crates/vmusicd/web/online.js crates/vmusicd/web/online.css
git commit -m "在线：音质档位选择与热切换、实际档位标、错误条"
```

---

## Task 14: app.js 接 buffering/error WS 事件与 transport 补全

**Files:**
- Modify: `crates/vmusicd/web/app.js`

- [ ] **Step 1: WS 事件分支** —— handleEvent（365-379 行）的 switch 加两个 case：

```javascript
    case 'buffering':
      ui.playpause.classList.toggle('is-loading', !!msg.active);
      ui.playpause.title = msg.active && msg.pct != null
        ? `缓冲中 ${msg.pct}%`
        : (msg.active ? '缓冲中…' : '');
      break;
    case 'error':
      // 在线音源错误（带 source）：错误条 + 自动跳过 toast；其余维持原 toast。
      if (msg.source && window.Online && Online.showOnlineError) {
        var isAutoSkip = /已跳过/.test(msg.message || '');
        if (isAutoSkip) {
          toast(msg.message);
        } else {
          var idx = state.snapshot && state.queueIds
            ? state.queueIds.indexOf(state.snapshot.track_id)
            : -1;
          Online.showOnlineError(msg.message, idx >= 0 ? idx : null);
        }
      } else {
        toast(`播放异常：${msg.message}`, 'error');
      }
      break;
```

删掉旧的 `case 'error': toast(...)` 单行（被上面取代）。

- [ ] **Step 2: 队列 id 暴露** —— grep 找到 `function setStateQueue`（约 app.js:1296 附近注释提到 setQueue），在其保存 ids 的地方确保：

```javascript
  state.queueIds = ids;
```

若该函数签名是 `(ids, startId)`，直接加这一行即可（Task 13 的热切换依赖它）。

- [ ] **Step 3: transport 补 delete/put（若缺）** —— grep `VMusicTransport` 定义，确认存在 `get/post`。若没有 `delete`/`put`，按现有 `post` 同形补：

```javascript
  delete: (url) => request('DELETE', url),
  put: (url, body) => request('PUT', url, body),
```

（`request` 是 transport 内部现有的 fetch 封装名，以实际名字为准。）

- [ ] **Step 4: 状态恢复核对** —— applySnapshot 已由服务端快照驱动音量/模式（650-675 行）。确认没有在 WS 重连后用本地值覆盖滑块：grep `ui.volume.value =`，除用户输入处理外不应有快照外的写。无需改代码则记录"已核对"。

- [ ] **Step 5: 手测** —— 启动服务（Task 16 命令）：播放在线曲观察 `is-loading`；kill 网络验证错误条出现、点「下一首」生效；再恢复网络点「重试」。

- [ ] **Step 6: Commit**

```bash
git add crates/vmusicd/web/app.js
git commit -m "前端 WS：buffering 状态与在线错误条接线"
```

---

## Task 15: 契约检查脚本

**Files:**
- Modify: `scripts/check-online.js`

把渐进式播放的结构断言并入现有 check-online.js（不新增文件：检查点都围绕同一批 web/state/actor 文件，集中一个 runner 更易维护）。

- [ ] **Step 1: 扩展 check-online.js** —— 在文件末尾的最终统计之前新增一节（沿用其 ok/eq/section 与 vm 桩风格）：

断言要点（用读源码字符串的方式钉，不跑浏览器；该 checker 已有读文件的 fs）：

```javascript
section('在线音源增强（2026-09）');
const appJs = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const onlineJs = fs.readFileSync(path.join(WEB, 'online.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const stateRs = fs.readFileSync(
  path.join(__dirname, '..', 'crates', 'vmusicd', 'src', 'state.rs'), 'utf8');
const actorRs = fs.readFileSync(
  path.join(__dirname, '..', 'crates', 'vmusic-audio', 'src', 'actor.rs'), 'utf8');

ok(indexHtml.includes('id="op-history"'), '历史区块容器存在');
ok(indexHtml.includes('id="online-quality"'), '音质选择器存在');
ok(indexHtml.includes('id="online-errorbar"'), '错误条容器存在');
ok(onlineJs.includes("/v1/history"), 'online.js 引用历史端点');
ok(onlineJs.includes("/v1/online/quality"), 'online.js 引用音质端点');
ok(onlineJs.includes('/v1/player/replay'), 'online.js 支持重试重播');
ok(appJs.includes("case 'buffering'"), 'app.js 处理 buffering 事件');
ok(appJs.includes('state.queueIds'), 'app.js 暴露队列 ids 供热切换');
ok(actorRs.includes('LoadSource'), 'actor 定义 LoadSource 命令');
ok(stateRs.includes('load_source'), 'state.rs 经 handle 调用 load_source');
ok(!stateRs.includes('Some(320_000)'), '播放取流不再硬编码 320k');
ok(stateRs.includes('progressive::start'), 'state.rs 接入渐进式下载');
ok(stateRs.includes('cancel_all_downloads'), '统一下载中止入口存在');
ok(!stateRs.includes('fetch_to_cache'), '旧整曲下载路径已移除');
ok(stateRs.includes('auto_failures'), '连续失败计数与自动跳曲存在');
```

- [ ] **Step 2: 运行**

Run: `node scripts/check-online.js`
Expected: 全绿（若某条断言与实际命名不符，以真实命名修正断言，不允许注释掉断言放水）。

- [ ] **Step 3: Commit（与下一步合并提交也可）**

- [ ] **Step 4: 跑全部无头检查确认无回归**

Run（PowerShell）：

```powershell
Get-ChildItem scripts\check-*.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw "FAIL $($_.Name)" } }
```

Expected: 全部 exit 0。

- [ ] **Step 5: Commit**

```bash
git add scripts/check-online.js
git commit -m "契约检查：覆盖历史、音质、buffering 与渐进式播放接缝"
```

---

## Task 16: 全量验证与真机烟测

- [ ] **Step 1: 格式化与静态检查**

Run: `cargo fmt --all`；`cargo clippy --workspace --all-targets -- -D warnings`
Expected: 无警告（项目 CI 同标准）。对 clippy 提出的合理项就地修正。

- [ ] **Step 2: 全量 Rust 测试**

Run: `cargo test --workspace`
Expected: 全绿。

- [ ] **Step 3: 全部前端契约检查**

Run: `Get-ChildItem scripts\check-*.js | ForEach-Object { node $_.FullName }`
Expected: 全绿。

- [ ] **Step 4: 构建并启动服务**

Run: `cargo run -p vmusicd`（从启动日志/discovery 文件取端口与 token；浏览器开 `http://127.0.0.1:<port>/?token=<token>`）。

- [ ] **Step 5: 烟测清单（逐条过，失败即修）**

1. **秒开**：清掉缓存目录后点一首未播放过的网易 mp3——应在 1-2s 内出声（不再等整首）；再点一首 QQ m4a，观察是否秒开或显式"缓冲中 xx%"后开播。
2. **弱网**：DevTools 无法限服务端速时，用 NetLimiter/路由器限速或找慢网络：播放中拔网线几秒再恢复——不崩、恢复后续播；彻底断网时自动跳曲并有 toast。
3. **切歌中止**：连点 5 次下一首；检查缓存目录没有持续增长的废弃 `.part`（只有当前/预取各最多 1 个），任务管理器里无残留大流量。
4. **酷狗高码率**（如可登录）：登录后选 lossless，播放酷狗曲，now-tech 显示无损；未登录选标准可正常播。
5. **音质热切换**：正在播放时把档位从标准切到无损——重新缓冲后继续播，进度接续。
6. **重启恢复**：改音量 0.4、切随机、播几首 → 停服务 → `cargo run` 再起：`GET /v1/state` 的 volume≈0.4、mode=shuffle；在线面板"最近播放"列出刚听的曲，点击可重听；清空/单删生效。
7. **失败跳曲**：把某音源 cookie 改坏或选一首确定 VIP 的曲自动接力：toast"已跳过"；连续构造 3 首失败时停止并给终态提示；手动点播失败时错误条出现，重试/下一可用。
8. **淡变**：暂停/继续、快速连点下一首、等一首自然结束——无爆音、无硬切；淡出时舞台粒子/星河不随音乐消失而塌陷。
9. **LRU**：把 config.toml 的 `[online] cache_max_bytes` 临时设为 30000000（30MB），播若干首后重启：缓存目录总量被压到约 27MB 以下，当前曲与最新文件保留。
10. **回归**：本地曲目播放、进度拖动、歌词、每日推荐、收藏、3D 舞台全部正常。

- [ ] **Step 6: 更新 spec 状态行** —— 把 spec 第 3 行"状态：已与用户逐节确认，待最终审阅"改为"状态：已实施（见 plan 2026-09-23）"。

- [ ] **Step 7: 最终提交**

```bash
git add -A
git commit -m "在线音源优化：真机烟测收尾"
```

- [ ] **Step 8: 通知用户进入舞台线设计周期** —— 音源线已交付；3D 舞台对标（节拍相机/自由相机/焦点跟拍/玻璃化 UI/存量打磨）按 brainstorming → spec → plan 流程另开一轮（需求已在本次对话确认，可直接复用）。


