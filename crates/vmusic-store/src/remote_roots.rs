// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 远程来源（WebDAV）根目录登记。
//!
//! 密码不在本表：新增/更新时写入系统钥匙串（键 `remote_cred_<id>`），
//! 删除时一并清除。这里只做连接信息的增删查。

use sqlx::SqlitePool;
use vmusic_core::StoreError;

use crate::now_ms;

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct RemoteRoot {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub username: String,
    pub added_at: i64,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<RemoteRoot>, StoreError> {
    sqlx::query_as(
        "SELECT id, name, base_url, username, added_at FROM remote_roots ORDER BY added_at",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| StoreError::Database(e.to_string()))
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<RemoteRoot>, StoreError> {
    sqlx::query_as("SELECT id, name, base_url, username, added_at FROM remote_roots WHERE id = ?1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))
}

pub async fn create(
    pool: &SqlitePool,
    name: &str,
    base_url: &str,
    username: &str,
) -> Result<RemoteRoot, StoreError> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO remote_roots (id, name, base_url, username, added_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(&id)
        .bind(name.trim())
        .bind(base_url.trim_end_matches('/'))
        .bind(username)
        .bind(now_ms())
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    get(pool, &id)
        .await?
        .ok_or_else(|| StoreError::Database("远程来源创建后读不回来".into()))
}

pub async fn remove(pool: &SqlitePool, id: &str) -> Result<bool, StoreError> {
    let result = sqlx::query("DELETE FROM remote_roots WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_list_get_delete_round_trip() {
        let dir = std::env::temp_dir().join(format!("vmusic-remote-{}", uuid::Uuid::new_v4()));
        let db = crate::open(&dir).await.unwrap();
        assert!(list(&db).await.unwrap().is_empty());

        let created = create(&db, "家里 NAS", "https://nas.local/dav/", "user")
            .await
            .unwrap();
        assert_eq!(created.base_url, "https://nas.local/dav", "尾斜杠归一");

        let all = list(&db).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "家里 NAS");

        assert!(remove(&db, &created.id).await.unwrap());
        assert!(
            !remove(&db, &created.id).await.unwrap(),
            "重复删除返回 false"
        );
        assert!(list(&db).await.unwrap().is_empty());
        db.close().await;
        crate::cleanup_dir(&dir);
    }
}
