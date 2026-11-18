// SPDX-License-Identifier: MIT
use crate::{
    config::{canonical_id, text},
    error::{HubError, Result},
    model::{digest, encode, now, Actor, Candidate, CANDIDATE_SELECT},
    store::Hub,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Decision {
    Approve,
    Reject,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ReviewEvidence {
    pub license_checked: bool,
    pub sources_checked: bool,
    pub static_scan_passed: bool,
    pub preview_evidence: String,
    pub reason: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ReviewInput {
    pub operation_id: String,
    pub decision: Decision,
    pub package_hash: String,
    pub permissions_digest: String,
    pub body_digest: String,
    pub evidence: ReviewEvidence,
}
impl Hub {
    pub(crate) async fn review(
        &self,
        actor: &Actor,
        id: &str,
        input: ReviewInput,
    ) -> Result<Candidate> {
        if !actor.reviewer() {
            return Err(HubError::denied());
        }
        canonical_id(id)?;
        text(&input.operation_id, 128)?;
        text(&input.evidence.reason, 4000)?;
        for hash in [
            &input.package_hash,
            &input.permissions_digest,
            &input.body_digest,
        ] {
            if !hertz_wallpaper::valid_sha256_hex(hash) {
                return Err(HubError::invalid("审核须绑定完整包、权限和发布正文摘要"));
            }
        }
        let approved = matches!(input.decision, Decision::Approve);
        if approved {
            text(&input.evidence.preview_evidence, 1024)?;
            if !input.evidence.license_checked
                || !input.evidence.sources_checked
                || !input.evidence.static_scan_passed
            {
                return Err(HubError::invalid(
                    "通过审核前须完成许可、来源、静态扫描与人工预览",
                ));
            }
        } else if input.evidence.preview_evidence.len() > 4096 {
            return Err(HubError::invalid("预览证据过长"));
        }
        let expected = digest(&(id, &input))?;
        let mut tx = self.pool.begin().await?;
        if let Some(existing) = sqlx::query("SELECT release_id,operation_digest FROM reviews WHERE reviewer_id=? AND operation_id=?")
            .bind(&actor.id).bind(&input.operation_id).fetch_optional(&mut *tx).await? {
            if existing.try_get::<String,_>("release_id")? != id || existing.try_get::<String,_>("operation_digest")? != expected {
                return Err(HubError::conflict("原审核请求不能更换结论或候选"));
            }
            let candidate = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE id=?")).bind(id).fetch_one(&mut *tx).await?;
            tx.commit().await?;
            return Ok(candidate);
        }
        let candidate: Candidate = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE id=?"))
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(HubError::missing)?;
        if candidate.owner_id == actor.id {
            return Err(HubError::denied());
        }
        if candidate.state != "pending_review"
            || candidate.package_hash != input.package_hash
            || candidate.permissions_digest != input.permissions_digest
            || candidate.body_digest != input.body_digest
        {
            return Err(HubError::conflict("待审版本已变化，请重新读取确切候选"));
        }
        if candidate.kind == "web" {
            return Err(HubError::conflict("作者网页尚未取得隔离资格"));
        }
        sqlx::query("INSERT INTO reviews(id,release_id,reviewer_id,operation_id,operation_digest,decision,package_hash,permissions_digest,body_digest,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
            .bind(uuid::Uuid::new_v4().to_string()).bind(id).bind(&actor.id).bind(&input.operation_id).bind(expected)
            .bind(if approved { "approve" } else { "reject" }).bind(input.package_hash).bind(input.permissions_digest)
            .bind(input.body_digest).bind(encode(&input.evidence)?).bind(now()).execute(&mut *tx).await?;
        // This only changes Hub display state. A protected Signer ledger must
        // independently approve the exact digest before any signing/publication.
        sqlx::query("UPDATE releases SET state=? WHERE id=? AND state='pending_review'")
            .bind(if approved {
                "approved_pending_signature"
            } else {
                "rejected"
            })
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO audit_events(actor_id,action,object_id,created_at) VALUES(?,'review_recorded',?,?)")
            .bind(&actor.id).bind(id).bind(now()).execute(&mut *tx).await?;
        let candidate = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE id=?"))
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(candidate)
    }

    pub(crate) async fn withdraw(&self, actor: &Actor, id: &str) -> Result<Candidate> {
        canonical_id(id)?;
        let mut tx = self.pool.begin().await?;
        let candidate: Candidate =
            sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE id=? AND owner_id=?"))
                .bind(id)
                .bind(&actor.id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(HubError::missing)?;
        if candidate.state == "withdrawn" {
            tx.commit().await?;
            return Ok(candidate);
        }
        // A published signature cannot be undone by a Hub state toggle. Its
        // removal/revocation belongs to the protected Signer workflow.
        if !matches!(
            candidate.state.as_str(),
            "pending_review" | "approved_pending_signature"
        ) {
            return Err(HubError::conflict(
                "只能撤回尚未签名的候选，已发布版本须走撤销流程",
            ));
        }
        let dispatched: i64 = sqlx::query_scalar("SELECT count(*) FROM publication_operations WHERE kind='release' AND object_id=? AND state IN ('requested','unknown','signed','published')")
            .bind(id).fetch_one(&mut *tx).await?;
        if dispatched != 0 {
            return Err(HubError::conflict(
                "签名请求已登记，须先查询原操作，不能用Hub撤回替代签名撤销",
            ));
        }
        sqlx::query("UPDATE releases SET state='withdrawn' WHERE id=? AND state IN ('pending_review','approved_pending_signature')")
            .bind(id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO audit_events(actor_id,action,object_id,created_at) VALUES(?,'release_withdrawn',?,?)")
            .bind(&actor.id).bind(id).bind(now()).execute(&mut *tx).await?;
        let result = sqlx::query_as(&format!("{CANDIDATE_SELECT} WHERE id=?"))
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(result)
    }
}
