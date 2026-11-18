// SPDX-License-Identifier: MIT
//! Existing database users, role CAS and bounded audit pages.
use crate::{
    config::{canonical_id, https_url, text},
    error::{HubError, Result},
    management::{self, ManagementReceipt, ManagementResult, Role, MAX_SAFE_INTEGER},
    model::{digest, Actor},
    store::Hub,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct RoleChangeInput {
    pub operation_id: String,
    pub expected_role: Role,
    pub role: Role,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct User {
    pub id: String,
    pub issuer: String,
    pub subject: String,
    pub role: Role,
    pub configured_administrator: bool,
    pub created_at: i64,
}
#[derive(sqlx::FromRow)]
struct UserRow {
    id: String,
    issuer: String,
    subject: String,
    role: String,
    created_at: i64,
}
const USER_SELECT: &str = concat!(
    "SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id ELSE NULL END AS id,",
    "CASE WHEN length(CAST(issuer AS BLOB)) BETWEEN 1 AND 2048 THEN issuer ELSE NULL END AS issuer,",
    "CASE WHEN length(CAST(subject AS BLOB)) BETWEEN 1 AND 1020 AND length(subject)<=255 THEN subject ELSE NULL END AS subject,",
    "CASE WHEN role IN ('author','moderator','admin') THEN role ELSE NULL END AS role,",
    "CASE WHEN typeof(created_at)='integer' AND created_at BETWEEN 1 AND 9007199254740991 THEN created_at ELSE NULL END AS created_at FROM users"
);

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuditEvent {
    pub id: i64,
    pub actor_id: Option<String>,
    pub action: String,
    pub object_id: Option<String>,
    pub created_at: i64,
    pub operation_id: Option<String>,
    #[serde(skip)]
    valid_optional_fields: bool,
}

impl Hub {
    fn management_user(&self, row: UserRow) -> Result<User> {
        canonical_id(&row.id).map_err(|_| HubError::unavailable())?;
        text(&row.subject, 255).map_err(|_| HubError::unavailable())?;
        https_url(&row.issuer).map_err(|_| HubError::unavailable())?;
        if row.issuer != self.config.issuer {
            return Err(HubError::unavailable());
        }
        let configured_administrator = self
            .config
            .administrators
            .iter()
            .any(|subject| subject.issuer == row.issuer && subject.sub == row.subject);
        Ok(User {
            id: row.id,
            issuer: row.issuer,
            subject: row.subject,
            role: Role::from_text(&row.role)?,
            configured_administrator,
            created_at: row.created_at,
        })
    }

    pub(crate) async fn management_users(
        &self,
        actor: &Actor,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<User>> {
        management::check_page(offset, limit)?;
        let mut tx = self.pool.begin().await?;
        management::require_administrator(&mut tx, actor).await?;
        let rows: Vec<UserRow> = sqlx::query_as(&format!(
            "{USER_SELECT} ORDER BY users.created_at,users.id LIMIT ? OFFSET ?"
        ))
        .bind(limit)
        .bind(offset)
        .fetch_all(&mut *tx)
        .await?;
        let users = rows
            .into_iter()
            .map(|row| self.management_user(row))
            .collect::<Result<Vec<_>>>()?;
        tx.commit().await?;
        Ok(users)
    }

    pub(crate) async fn management_user_detail(&self, actor: &Actor, id: &str) -> Result<User> {
        canonical_id(id)?;
        let mut tx = self.pool.begin().await?;
        management::require_administrator(&mut tx, actor).await?;
        let row: UserRow = sqlx::query_as(&format!("{USER_SELECT} WHERE id=?"))
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(HubError::missing)?;
        let user = self.management_user(row)?;
        tx.commit().await?;
        Ok(user)
    }

    pub(crate) async fn change_role(
        &self,
        actor: &Actor,
        id: &str,
        input: RoleChangeInput,
    ) -> Result<ManagementReceipt> {
        canonical_id(id)?;
        canonical_id(&input.operation_id)?;
        text(&input.reason, 4000)?;
        if input.expected_role == input.role {
            return Err(HubError::invalid("新角色必须与已核对的原角色不同"));
        }
        let expected = digest(&(id, &input))?;
        let mut tx = self.pool.begin().await?;
        management::require_administrator(&mut tx, actor).await?;
        if let Some(receipt) = management::matching_operation(
            &mut tx,
            actor,
            &input.operation_id,
            "role_change",
            id,
            &expected,
        )
        .await?
        {
            tx.commit().await?;
            return Ok(receipt);
        }
        let row: UserRow = sqlx::query_as(&format!("{USER_SELECT} WHERE id=?"))
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(HubError::missing)?;
        let user = self.management_user(row)?;
        if user.role != input.expected_role {
            return Err(HubError::conflict(
                "目标角色已变化，请重新读取并用新操作UUID确认",
            ));
        }
        if user.configured_administrator && input.role != Role::Admin {
            return Err(HubError::conflict(
                "请先从部署配置移除该管理员并重启，再核对角色",
            ));
        }
        if user.role == Role::Admin && input.role != Role::Admin {
            let administrators: i64 =
                sqlx::query_scalar("SELECT count(*) FROM users WHERE role='admin'")
                    .fetch_one(&mut *tx)
                    .await?;
            if administrators <= 1 {
                return Err(HubError::conflict("不能撤销最后一个数据库管理员"));
            }
        }
        let changed = sqlx::query("UPDATE users SET role=? WHERE id=? AND role=?")
            .bind(input.role.as_str())
            .bind(id)
            .bind(input.expected_role.as_str())
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if changed != 1 {
            return Err(HubError::conflict(
                "目标角色已变化，请重新读取并用新操作UUID确认",
            ));
        }
        let receipt = management::record_operation(
            &mut tx,
            actor,
            &input.operation_id,
            &expected,
            ManagementResult::RoleChange {
                user_id: id.to_owned(),
                previous_role: user.role,
                role: input.role,
                reason: input.reason,
            },
        )
        .await?;
        tx.commit().await?;
        Ok(receipt)
    }

    pub(crate) async fn management_audit(
        &self,
        actor: &Actor,
        after: i64,
        limit: i64,
    ) -> Result<Vec<AuditEvent>> {
        if !(0..=MAX_SAFE_INTEGER).contains(&after) || !(1..=50).contains(&limit) {
            return Err(HubError::invalid("审计after须为非负安全整数，每页1–50项"));
        }
        let mut tx = self.pool.begin().await?;
        management::require_administrator(&mut tx, actor).await?;
        let events: Vec<AuditEvent> = sqlx::query_as(concat!(
            "SELECT CASE WHEN typeof(a.id)='integer' AND a.id BETWEEN 1 AND 9007199254740991 THEN a.id ELSE NULL END AS id,",
            "CASE WHEN length(CAST(a.actor_id AS BLOB))=36 THEN a.actor_id ELSE NULL END AS actor_id,",
            "CASE WHEN length(CAST(a.action AS BLOB)) BETWEEN 1 AND 128 THEN a.action ELSE NULL END AS action,",
            "CASE WHEN length(CAST(a.object_id AS BLOB))<=128 THEN a.object_id ELSE NULL END AS object_id,",
            "CASE WHEN typeof(a.created_at)='integer' AND a.created_at BETWEEN 1 AND 9007199254740991 THEN a.created_at ELSE NULL END AS created_at,",
            "CASE WHEN length(CAST(m.operation_id AS BLOB))=36 THEN m.operation_id ELSE NULL END AS operation_id,",
            "CASE WHEN (a.actor_id IS NULL OR length(CAST(a.actor_id AS BLOB))=36) ",
            "AND (a.object_id IS NULL OR length(CAST(a.object_id AS BLOB))<=128) ",
            "AND (m.operation_id IS NULL OR length(CAST(m.operation_id AS BLOB))=36) THEN 1 ELSE 0 END AS valid_optional_fields ",
            "FROM audit_events a LEFT JOIN management_operations m ON m.audit_event_id=a.id WHERE a.id>? ORDER BY a.id LIMIT ?"
        )).bind(after).bind(limit).fetch_all(&mut *tx).await?;
        for event in &events {
            if !event.valid_optional_fields
                || event
                    .action
                    .bytes()
                    .any(|byte| !(byte.is_ascii_alphanumeric() || byte == b'_'))
            {
                return Err(HubError::unavailable());
            }
            if let Some(actor_id) = &event.actor_id {
                canonical_id(actor_id).map_err(|_| HubError::unavailable())?;
            }
            if let Some(operation_id) = &event.operation_id {
                canonical_id(operation_id).map_err(|_| HubError::unavailable())?;
            }
            if event
                .object_id
                .as_ref()
                .is_some_and(|id| id.chars().any(char::is_control))
            {
                return Err(HubError::unavailable());
            }
        }
        tx.commit().await?;
        Ok(events)
    }
}
