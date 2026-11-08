// SPDX-License-Identifier: MIT
//! Local stage presets have their own CAS boundary. Share-code projection is deliberately
//! not used here: a local preset retains its media reference and editable project context.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::{BTreeMap, BTreeSet};

pub const CURRENT: &str = "creative_current_preset";
pub const LIBRARY: &str = "creative_presets";
pub const STATE: &str = "creative_stage_state";
pub const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
#[error("{code}: {message}")]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}
impl From<sqlx::Error> for Error {
    fn from(e: sqlx::Error) -> Self {
        Self {
            code: "stage_database",
            message: e.to_string(),
        }
    }
}
fn invalid(message: &str) -> Error {
    Error {
        code: "stage_preset_invalid",
        message: message.into(),
    }
}
pub fn managed(key: &str) -> bool {
    matches!(key, CURRENT | LIBRARY | STATE)
}
fn key(target: &str) -> Result<&'static str, Error> {
    match target {
        "current" => Ok(CURRENT),
        "library" => Ok(LIBRARY),
        _ => Err(invalid("未知预设保存目标")),
    }
}
pub fn digest(value: &Value) -> String {
    // serde_json's default Map is sorted, so serialization is canonical for JSON objects.
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub fn references(value: &Value) -> BTreeSet<(String, String)> {
    let mut out = BTreeSet::new();
    let values: Vec<&Value> = value
        .as_array()
        .map_or_else(|| vec![value], |a| a.iter().collect());
    for p in values {
        if let (Some(store), Some(id)) = (
            p["bg"]["assetRef"]["storeId"].as_str(),
            p["bg"]["assetRef"]["assetId"].as_str(),
        ) {
            out.insert((store.into(), id.into()));
        }
    }
    out
}

/// Removes only obsolete transient background data. Stable missing references survive.
pub fn migrate(value: &mut Value) -> bool {
    if let Some(items) = value.as_array_mut() {
        return items
            .iter_mut()
            .fold(false, |changed, p| migrate(p) || changed);
    }
    let Some(bg) = value.get_mut("bg").and_then(Value::as_object_mut) else {
        return false;
    };
    let obsolete =
        bg.get("type").and_then(Value::as_str) == Some("media") && !bg.contains_key("assetRef");
    let mut changed = false;
    for k in ["url", "name", "path", "token", "file", "blob", "lease"] {
        changed |= bg.remove(k).is_some();
    }
    if obsolete {
        bg.clear();
        bg.insert("type".into(), json!("theme"));
        changed = true;
    }
    changed
}

pub fn validate(target: &str, value: &Value) -> Result<(), Error> {
    key(target)?;
    if value.to_string().len() > MAX_BYTES {
        return Err(invalid("预设载荷超过 4 MiB"));
    }
    fn walk(value: &Value, depth: usize) -> bool {
        if depth > 24 {
            return false;
        }
        match value {
            Value::Object(o) => {
                o.len() <= 512 && o.iter().all(|(k, v)| k.len() <= 128 && walk(v, depth + 1))
            }
            Value::Array(a) => a.len() <= 4096 && a.iter().all(|v| walk(v, depth + 1)),
            Value::String(s) => s.len() <= 256 * 1024 && !s.starts_with("blob:"),
            _ => true,
        }
    }
    if !walk(value, 0) {
        return Err(invalid("预设嵌套、字段或文本超限，或包含临时 URL"));
    }
    let items: Vec<&Value> = if target == "library" {
        let a = value
            .as_array()
            .filter(|a| a.len() <= 40)
            .ok_or_else(|| invalid("预设库最多 40 项"))?;
        let mut ids = BTreeSet::new();
        for p in a {
            let id = p["id"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 128)
                .ok_or_else(|| invalid("预设缺少 id"))?;
            if !ids.insert(id) {
                return Err(invalid("预设 id 重复"));
            }
        }
        a.iter().collect()
    } else {
        vec![value]
    };
    for p in items {
        if !p.is_object()
            || p["version"].as_u64() != Some(1)
            || p.to_string().len() > 512 * 1024
            || !p["scene"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 128)
            || p["name"].as_str().is_some_and(|s| s.chars().count() > 128)
        {
            return Err(invalid(
                "仅支持版本 1 预设，需要场景字段，名称最多 128 字，单项最多 512 KiB",
            ));
        }
        for field in ["sc", "cam", "look", "stage", "hand", "project"] {
            if p.get(field).is_some_and(|v| !v.is_object()) {
                return Err(invalid("预设参数组必须是对象"));
            }
        }
        for (field, limit) in [("cues", 64), ("bindings", 32)] {
            if p.get(field)
                .is_some_and(|v| !v.as_array().is_some_and(|a| a.len() <= limit))
            {
                return Err(invalid("编排或绑定数量超限"));
            }
        }
        if p.get("director").is_some_and(|v| !v.is_boolean()) {
            return Err(invalid("导演开关必须是布尔值"));
        }
        if let Some(bg) = p.get("bg") {
            let b = bg.as_object().ok_or_else(|| invalid("背景必须是对象"))?;
            const FIELDS: &[&str] = &[
                "type",
                "media",
                "assetRef",
                "rate",
                "hue",
                "opacity",
                "blur",
                "blend",
                "depthMode",
            ];
            if b.keys().any(|k| !FIELDS.contains(&k.as_str())) {
                return Err(invalid("背景含临时字段或未知字段"));
            }
            if !matches!(
                bg["type"].as_str(),
                Some("theme" | "media" | "mesh" | "flow" | "spectrogram" | "cover")
            ) {
                return Err(invalid("未知背景类型"));
            }
            if bg["type"] == "media" {
                let r = bg["assetRef"]
                    .as_object()
                    .ok_or_else(|| invalid("媒体背景需要持久素材引用"))?;
                if r.len() != 2
                    || !bg["assetRef"]["assetId"].as_str().is_some_and(valid_id)
                    || !bg["assetRef"]["storeId"]
                        .as_str()
                        .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
                    || !matches!(bg["media"].as_str(), Some("image" | "video"))
                {
                    return Err(invalid("无效素材引用"));
                }
            } else if b.contains_key("assetRef") || b.contains_key("media") {
                return Err(invalid("非媒体背景不能携带素材引用"));
            }
            for (field, min, max) in [
                ("rate", 0.25, 2.0),
                ("hue", 0.0, 360.0),
                ("opacity", 0.0, 100.0),
                ("blur", 0.0, 60.0),
            ] {
                if b.get(field)
                    .is_some_and(|v| !v.as_f64().is_some_and(|n| n >= min && n <= max))
                {
                    return Err(invalid("背景参数超限"));
                }
            }
            if b.get("blend").is_some_and(|v| {
                !matches!(
                    v.as_str(),
                    Some("normal" | "screen" | "overlay" | "soft-light" | "lighten")
                )
            }) || b
                .get("depthMode")
                .is_some_and(|v| !matches!(v.as_str(), Some("flat" | "parallax" | "scene")))
            {
                return Err(invalid("背景融合/空间模式无效"));
            }
        }
    }
    Ok(())
}

pub async fn read(conn: &mut SqliteConnection, key: &str) -> Result<Option<Value>, Error> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key=?")
        .bind(key)
        .fetch_optional(conn)
        .await?;
    raw.map(|s| serde_json::from_str(&s).map_err(|_| invalid("已保存的舞台设置损坏，请恢复备份")))
        .transpose()
}
pub async fn write(conn: &mut SqliteConnection, key: &str, value: &Value) -> Result<(), Error> {
    sqlx::query("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .bind(key).bind(value.to_string()).bind(crate::now_ms()).execute(conn).await?;
    Ok(())
}

/// Existing server library wins migration, including a deliberately saved empty array.
pub async fn initialize(pool: &SqlitePool) -> Result<Value, Error> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut state = read(&mut tx, STATE).await?.unwrap_or_else(|| json!({
        "schemaVersion":1,"storeId":uuid::Uuid::new_v4().to_string(),
        "current":{"revision":0,"initialized":false},"library":{"revision":0,"initialized":false},"legacyMediaRemoved":false
    }));
    for target in ["current", "library"] {
        if state[target]["initialized"] != true {
            if let Some(mut value) = read(&mut tx, key(target)?).await? {
                if migrate(&mut value) {
                    state["legacyMediaRemoved"] = json!(true);
                }
                validate(target, &value)?;
                write(&mut tx, key(target)?, &value).await?;
                state[target] = json!({"revision":1,"initialized":true});
            }
        }
    }
    write(&mut tx, STATE, &state).await?;
    tx.commit().await?;
    Ok(state)
}

pub async fn load(pool: &SqlitePool) -> Result<Value, Error> {
    let mut tx = pool.begin().await?;
    let state = read(&mut tx, STATE)
        .await?
        .ok_or_else(|| invalid("舞台存储尚未初始化"))?;
    let current = read(&mut tx, CURRENT).await?;
    let library = read(&mut tx, LIBRARY).await?;
    Ok(json!({"state":state,"current":current,"library":library}))
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Save {
    pub target: String,
    pub request_id: String,
    pub expected_preset_revision: u64,
    pub payload: Value,
}

pub async fn save(pool: &SqlitePool, request: &Save) -> Result<Value, Error> {
    validate(&request.target, &request.payload)?;
    if request.request_id.is_empty() || request.request_id.len() > 128 {
        return Err(invalid("requestId 无效"));
    }
    let hash = digest(&serde_json::to_value(request).map_err(|_| invalid("保存请求无效"))?);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let old_receipt: Option<(String, String)> =
        sqlx::query_as("SELECT digest,receipt FROM stage_preset_commits WHERE request_id=?")
            .bind(&request.request_id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((old_hash, receipt)) = old_receipt {
        if old_hash != hash {
            return Err(Error {
                code: "stage_request_conflict",
                message: "同一 requestId 的内容发生变化".into(),
            });
        }
        return serde_json::from_str(&receipt).map_err(|_| invalid("保存回执损坏"));
    }
    let mut state = read(&mut tx, STATE)
        .await?
        .ok_or_else(|| invalid("舞台存储未初始化"))?;
    let revision = state[&request.target]["revision"].as_u64().unwrap_or(0);
    if revision != request.expected_preset_revision {
        return Err(Error {
            code: "stage_revision_conflict",
            message: "预设已在其他窗口更改；未覆盖，请重新载入或明确重试".into(),
        });
    }
    let old = read(&mut tx, key(&request.target)?)
        .await?
        .unwrap_or(Value::Null);
    for (store, id) in references(&request.payload) {
        let ready: Option<(String, String)> =
            sqlx::query_as("SELECT media,state FROM stage_media_assets WHERE asset_id=?")
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?;
        let items: Vec<&Value> = request
            .payload
            .as_array()
            .map_or_else(|| vec![&request.payload], |a| a.iter().collect());
        for p in items.into_iter().filter(|p| {
            p["bg"]["assetRef"]["assetId"] == id && p["bg"]["assetRef"]["storeId"] == store
        }) {
            let existing = if request.target == "current" {
                &old
            } else {
                old.as_array()
                    .and_then(|a| a.iter().find(|o| o["id"] == p["id"]))
                    .unwrap_or(&Value::Null)
            };
            let available = state["storeId"] == store
                && ready
                    .as_ref()
                    .is_some_and(|(media, status)| status == "ready" && p["bg"]["media"] == *media);
            if !available
                && (existing["bg"]["assetRef"] != p["bg"]["assetRef"]
                    || existing["bg"]["media"] != p["bg"]["media"])
            {
                return Err(Error {
                    code: "stage_asset_unavailable",
                    message: "素材缺失或来自其他服务，请重新导入后选择".into(),
                });
            }
        }
    }
    let receipt = json!({"requestId":request.request_id,"revision":revision+1,"digest":digest(&request.payload),"target":request.target});
    state[&request.target] = json!({"revision":revision+1,"initialized":true,"lastCommit":receipt});
    write(&mut tx, key(&request.target)?, &request.payload).await?;
    write(&mut tx, STATE, &state).await?;
    sqlx::query(
        "INSERT INTO stage_preset_commits(request_id,target,digest,receipt) VALUES(?,?,?,?)",
    )
    .bind(&request.request_id)
    .bind(&request.target)
    .bind(hash)
    .bind(receipt.to_string())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(receipt)
}

/// Backup restore participates in its caller's transaction and deliberately allows missing
/// and cross-store references. It never imports foreign store identity/revision metadata.
pub fn validate_backup(settings: &BTreeMap<String, Value>) -> Result<(), Error> {
    if settings.contains_key(STATE) {
        return Err(invalid("备份不能覆盖舞台内部版本状态"));
    }
    for (target, k) in [("current", CURRENT), ("library", LIBRARY)] {
        if let Some(value) = settings.get(k) {
            let mut value = value.clone();
            migrate(&mut value);
            validate(target, &value)?;
        }
    }
    Ok(())
}
pub async fn restore(
    conn: &mut SqliteConnection,
    settings: &BTreeMap<String, Value>,
) -> Result<(), Error> {
    if !settings.contains_key(CURRENT) && !settings.contains_key(LIBRARY) {
        return Ok(());
    }
    let mut state = read(conn, STATE)
        .await?
        .unwrap_or_else(|| json!({"schemaVersion":1,"storeId":uuid::Uuid::new_v4().to_string()}));
    for (target, k) in [("current", CURRENT), ("library", LIBRARY)] {
        if let Some(value) = settings.get(k) {
            let mut value = value.clone();
            if migrate(&mut value) {
                state["legacyMediaRemoved"] = json!(true);
            }
            let revision = state[target]["revision"].as_u64().unwrap_or(0) + 1;
            state[target] = json!({"revision":revision,"initialized":true,"lastCommit":{"requestId":uuid::Uuid::new_v4().to_string(),"revision":revision,"target":target,"digest":digest(&value)}});
            write(conn, k, &value).await?;
        }
    }
    write(conn, STATE, &state).await
}
