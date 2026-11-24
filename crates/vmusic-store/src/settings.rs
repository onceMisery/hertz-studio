// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Key/value settings persisted as JSON strings.
//!
//! UI preferences live here rather than in `localStorage`: the same UI also
//! runs inside the DBX sandbox where storage is not guaranteed to exist.

use std::collections::BTreeMap;

use serde_json::Value;
use sqlx::SqlitePool;
use vmusic_core::StoreError;

use crate::now_ms;

pub async fn get_all(pool: &SqlitePool) -> Result<BTreeMap<String, Value>, StoreError> {
    get_all_from(pool).await
}

pub(crate) async fn get_all_from<'e, E>(executor: E) -> Result<BTreeMap<String, Value>, StoreError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    #[derive(sqlx::FromRow)]
    struct Row {
        key: String,
        value: String,
    }
    let rows = sqlx::query_as::<_, Row>("SELECT key, value FROM settings")
        .fetch_all(executor)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

    let mut out = BTreeMap::new();
    for row in rows {
        let parsed: Value = serde_json::from_str(&row.value).unwrap_or(Value::Null);
        out.insert(row.key, parsed);
    }
    Ok(out)
}

pub async fn set_all(
    pool: &SqlitePool,
    values: &BTreeMap<String, Value>,
) -> Result<(), StoreError> {
    if values.keys().any(|key| crate::stage_presets::managed(key)) {
        return Err(StoreError::Serialization(
            "舞台预设必须通过版本化保存接口修改".into(),
        ));
    }
    for (key, value) in values {
        let encoded =
            serde_json::to_string(value).map_err(|e| StoreError::Serialization(e.to_string()))?;
        sqlx::query(
            r#"INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"#,
        )
        .bind(key)
        .bind(encoded)
        .bind(now_ms())
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    }
    Ok(())
}

pub async fn set(pool: &SqlitePool, key: &str, value: &Value) -> Result<(), StoreError> {
    let mut single = BTreeMap::new();
    single.insert(key.to_string(), value.clone());
    set_all(pool, &single).await
}

/// Save a related set of preferences as a unit without changing the legacy keys.
pub async fn set_atomic(
    pool: &SqlitePool,
    values: &BTreeMap<String, Value>,
) -> Result<(), StoreError> {
    if values.keys().any(|key| crate::stage_presets::managed(key)) {
        return Err(StoreError::Serialization(
            "舞台预设必须通过版本化保存接口修改".into(),
        ));
    }
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| StoreError::Database(error.to_string()))?;
    for (key, value) in values {
        let encoded = serde_json::to_string(value)
            .map_err(|error| StoreError::Serialization(error.to_string()))?;
        sqlx::query("INSERT INTO settings (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
            .bind(key).bind(encoded).bind(now_ms()).execute(&mut *transaction).await
            .map_err(|error| StoreError::Database(error.to_string()))?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| StoreError::Database(error.to_string()))
}

pub async fn get(pool: &SqlitePool, key: &str) -> Result<Option<Value>, StoreError> {
    let encoded: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    match encoded {
        Some(raw) => Ok(serde_json::from_str(&raw).ok()),
        None => Ok(None),
    }
}

/// Replace one canonical settings object and retire its predecessor keys in one transaction.
pub async fn replace_atomic(
    pool: &SqlitePool,
    key: &str,
    value: &Value,
    retired: &[&str],
) -> Result<(), StoreError> {
    let encoded =
        serde_json::to_string(value).map_err(|e| StoreError::Serialization(e.to_string()))?;
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    sqlx::query("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .bind(key).bind(encoded).bind(now_ms()).execute(&mut *tx).await.map_err(|e|StoreError::Database(e.to_string()))?;
    for old in retired {
        sqlx::query("DELETE FROM settings WHERE key=?1")
            .bind(old)
            .execute(&mut *tx)
            .await
            .map_err(|e| StoreError::Database(e.to_string()))?;
    }
    tx.commit()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))
}
