// SPDX-License-Identifier: MIT
//! Subscription projection and recoverable update journal on the original library.
use super::{
    error,
    model::{SourceProfile, MAX_SUBSCRIPTIONS},
    network::canonical_uuid,
    now,
    store::{db, json},
    AcceptedRelease,
};
use crate::wallpaper::{
    budget::{self, ControlCharge},
    jobs::JobError,
    library::{InstallWork, Library},
    playlist::FixedVersion,
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Sqlite, Transaction};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Binding {
    pub config_revision: u64,
    pub config_digest: String,
    pub topology_digest: String,
    pub group_id: String,
    pub selection_json: String,
    pub previous: Option<FixedVersion>,
    pub subscription_revision: i64,
    #[serde(default)]
    pub playlist_revision: Option<u64>,
}

pub(crate) struct ApplyIdentity<'a> {
    pub operation_id: &'a str,
    pub request_id: &'a str,
    pub config_digest: &'a str,
    pub revision: u64,
}

pub(crate) struct ApplyPlan<'a> {
    pub identity: ApplyIdentity<'a>,
    pub subscription_id: &'a str,
    pub binding: &'a Binding,
    pub candidate: &'a FixedVersion,
    pub rollback: bool,
    pub confirmed: bool,
    pub automatic: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadPlan {
    pub operation_id: String,
    pub request_id: String,
    pub subscription_id: String,
    pub source_id: String,
    pub remote_work_id: String,
    pub binding: Binding,
}

pub(crate) struct DownloadIntent {
    pub plan: DownloadPlan,
    _charge: ControlCharge,
}

impl DownloadIntent {
    pub(crate) fn new(plan: DownloadPlan) -> Result<Self, JobError> {
        for id in [
            &plan.operation_id,
            &plan.request_id,
            &plan.subscription_id,
            &plan.source_id,
            &plan.remote_work_id,
        ] {
            canonical_uuid(id)?;
        }
        if plan.binding.selection_json.len() > 8192
            || plan.binding.group_id.len() > 256
            || plan.binding.config_digest.len() != 64
            || plan.binding.topology_digest.len() != 64
        {
            return Err(error("invalid_update_binding", "更新意图超出原配置界限"));
        }
        let charge = budget::global()
            .admit_working_bytes(32 * 1024)
            .map_err(|e| error("budget_busy", e.message.to_string()))?;
        Ok(Self {
            plan,
            _charge: charge,
        })
    }
}

#[derive(Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Subscription {
    pub subscription_id: String,
    pub source_id: String,
    pub remote_work_id: String,
    pub policy: String,
    pub enabled: i64,
    pub revision: i64,
    pub work_key: Option<String>,
    pub current_hash: Option<String>,
    pub previous_hash: Option<String>,
    pub last_sync: i64,
    pub last_error: Option<String>,
    pub title: Option<String>,
}

#[derive(Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateRow {
    pub operation_id: String,
    pub request_id: String,
    pub subscription_id: String,
    pub job_id: String,
    pub binding_json: String,
    pub state: String,
    pub candidate_hash: Option<String>,
    pub previous_hash: Option<String>,
    pub rollback_available: bool,
    pub delta_json: Option<String>,
    pub apply_request_id: Option<String>,
    pub apply_config_revision: Option<i64>,
    pub apply_config_digest: Option<String>,
    pub apply_package_hash: Option<String>,
    pub apply_work_key: Option<String>,
    pub apply_rollback: bool,
    pub error: Option<String>,
    pub updated_at: i64,
}

const SUB_SELECT:&str="SELECT subscription_id,source_id,remote_work_id,policy,enabled,revision,work_key,current_hash,previous_hash,last_sync,last_error,(SELECT CASE WHEN length(CAST(title AS BLOB))<=512 THEN title ELSE NULL END FROM works WHERE works.work_key=community_subscriptions.work_key) AS title FROM community_subscriptions";
const UPDATE_SELECT: &str = concat!(
    "SELECT operation_id,request_id,subscription_id,job_id,binding_json,state,",
    "candidate_hash,previous_hash,delta_json,apply_request_id,apply_config_revision,",
    "apply_config_digest,apply_package_hash,apply_work_key,apply_rollback,error,updated_at,",
    "EXISTS(SELECT 1 FROM versions v JOIN packages p ON p.package_hash=v.package_hash ",
    "WHERE v.package_hash=community_updates.previous_hash AND p.state='installed' ",
    "AND v.work_key=CASE WHEN json_valid(community_updates.binding_json) ",
    "THEN json_extract(community_updates.binding_json,'$.previous.workKey') ELSE NULL END) ",
    "AS rollback_available FROM community_updates"
);
const SUB_BOUNDS: &str = concat!(
    "length(CAST(subscription_id AS BLOB))=36 AND length(CAST(source_id AS BLOB))=36 ",
    "AND length(CAST(remote_work_id AS BLOB))=36 AND policy IN ('prompt','cutpoint','startup') ",
    "AND enabled IN (0,1) AND typeof(revision)='integer' AND revision>0 ",
    "AND coalesce(length(CAST(work_key AS BLOB)),0)<=256 ",
    "AND (current_hash IS NULL OR length(CAST(current_hash AS BLOB))=64) ",
    "AND (previous_hash IS NULL OR length(CAST(previous_hash AS BLOB))=64) ",
    "AND coalesce(length(CAST(last_error AS BLOB)),0)<=4096 ",
    "AND typeof(last_sync)='integer' AND last_sync>=0"
);
const UPDATE_BOUNDS:&str=concat!(
    "length(CAST(operation_id AS BLOB))=36 AND length(CAST(request_id AS BLOB))=36 ",
    "AND length(CAST(subscription_id AS BLOB))=36 AND length(CAST(job_id AS BLOB)) BETWEEN 1 AND 64 ",
    "AND length(CAST(payload_digest AS BLOB))=64 ",
    "AND length(CAST(binding_json AS BLOB)) BETWEEN 2 AND 16384 ",
    "AND state IN ('queued','downloading','installed','ready','awaiting_confirmation','apply_requested','applied','failed','stale') ",
    "AND (candidate_hash IS NULL OR length(CAST(candidate_hash AS BLOB))=64) ",
    "AND (previous_hash IS NULL OR length(CAST(previous_hash AS BLOB))=64) ",
    "AND coalesce(length(CAST(delta_json AS BLOB)),0)<=16384 ",
    "AND (apply_request_id IS NULL OR length(CAST(apply_request_id AS BLOB))=36) ",
    "AND (apply_config_digest IS NULL OR length(CAST(apply_config_digest AS BLOB))=64) ",
    "AND (apply_package_hash IS NULL OR length(CAST(apply_package_hash AS BLOB))=64) ",
    "AND coalesce(length(CAST(apply_work_key AS BLOB)),0)<=256 ",
    "AND typeof(apply_rollback)='integer' AND apply_rollback IN (0,1) ",
    "AND (apply_config_revision IS NULL OR (typeof(apply_config_revision)='integer' AND apply_config_revision>0)) ",
    "AND coalesce(length(CAST(error AS BLOB)),0)<=4096 ",
    "AND typeof(updated_at)='integer' AND updated_at>=0"
);

impl Subscription {
    fn validate(&self) -> Result<(), JobError> {
        for id in [&self.subscription_id, &self.source_id, &self.remote_work_id] {
            canonical_uuid(id)?;
        }
        for hash in [&self.current_hash, &self.previous_hash]
            .into_iter()
            .flatten()
        {
            super::gate::hash(hash)?;
        }
        Ok(())
    }
}

impl UpdateRow {
    fn validate(&self) -> Result<(), JobError> {
        for id in [&self.operation_id, &self.request_id, &self.subscription_id] {
            canonical_uuid(id)?;
        }
        if let Some(id) = &self.apply_request_id {
            canonical_uuid(id)?;
        }
        for hash in [
            &self.candidate_hash,
            &self.previous_hash,
            &self.apply_config_digest,
            &self.apply_package_hash,
        ]
        .into_iter()
        .flatten()
        {
            super::gate::hash(hash)?;
        }
        let binding: Binding = serde_json::from_str(&self.binding_json).map_err(json)?;
        if binding.selection_json.len() > 8192
            || binding.group_id.len() > 256
            || binding.subscription_revision <= 0
            || binding
                .playlist_revision
                .is_some_and(|v| v == 0 || v > i64::MAX as u64)
        {
            return Err(error("update_binding_invalid", "保存的更新意图超出界限"));
        }
        super::gate::hash(&binding.config_digest)?;
        super::gate::hash(&binding.topology_digest)?;
        if binding.previous.as_ref().map(|v| v.package_hash.as_str())
            != self.previous_hash.as_deref()
            || binding
                .previous
                .as_ref()
                .is_some_and(|v| v.work_key.is_empty() || v.work_key.len() > 256)
            || self
                .apply_work_key
                .as_ref()
                .is_some_and(|key| key.is_empty() || key.len() > 256)
        {
            return Err(error(
                "update_binding_invalid",
                "保存的固定版本与更新 journal 不一致",
            ));
        }
        Ok(())
    }

    pub(crate) fn target_version(
        &self,
        subscription: &Subscription,
        rollback: bool,
    ) -> Result<FixedVersion, JobError> {
        if self.subscription_id != subscription.subscription_id {
            return Err(error("subscription_conflict", "版本与订阅不一致"));
        }
        if rollback {
            if !self.rollback_available {
                return Err(error(
                    "rollback_unavailable",
                    "保留的上一版本不可用或安全检查未通过，请核对版本并同步来源",
                ));
            }
            let original: Binding = serde_json::from_str(&self.binding_json).map_err(json)?;
            original
                .previous
                .ok_or_else(|| error("rollback_unavailable", "原更新没有保留上一有效选择"))
        } else {
            Ok(FixedVersion {
                work_key: subscription
                    .work_key
                    .clone()
                    .ok_or_else(|| error("update_not_installed", "候选还未建立作品索引"))?,
                package_hash: self
                    .candidate_hash
                    .clone()
                    .ok_or_else(|| error("update_not_installed", "候选还未安装"))?,
            })
        }
    }
}

pub(crate) struct Subscriptions<'a> {
    library: &'a Library,
}

impl<'a> Subscriptions<'a> {
    pub(crate) fn new(library: &'a Library) -> Self {
        Self { library }
    }
    async fn check_rows(
        &self,
        table: &'static str,
        bounds: &'static str,
        maximum: i64,
    ) -> Result<(), JobError> {
        // These table/predicate inputs are private constants. Restored rows are
        // rejected using scalar queries before any text reaches SQLx allocations.
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(self.library.pool())
            .await
            .map_err(db)?;
        if count > maximum {
            return Err(error("community_database_invalid", "社区记录数量超出界限"));
        }
        let invalid: bool = sqlx::query_scalar(&format!(
            "SELECT EXISTS(SELECT 1 FROM {table} WHERE NOT coalesce(({bounds}),0) LIMIT 1)"
        ))
        .fetch_one(self.library.pool())
        .await
        .map_err(db)?;
        if invalid {
            return Err(error(
                "community_database_invalid",
                "保存的社区记录超出有界读取合同",
            ));
        }
        Ok(())
    }
    pub(crate) async fn project_source(&self, profile: &SourceProfile) -> Result<(), JobError> {
        // Only a profile read from trust.db reaches this projection.
        let trusted = self.library.trust().profile(&profile.source_id).await?;
        if trusted.origin != profile.origin || trusted.root_fingerprint != profile.root_fingerprint
        {
            return Err(error("source_conflict", "来源投影与信任记录冲突"));
        }
        let old:Option<(Option<String>,Option<String>,Option<String>)>=sqlx::query_as("SELECT CASE WHEN length(CAST(kind AS BLOB))<=16 THEN kind ELSE NULL END,CASE WHEN length(CAST(canonical_origin AS BLOB))<=2048 THEN canonical_origin ELSE NULL END,CASE WHEN length(CAST(root_fingerprint AS BLOB))=64 THEN root_fingerprint ELSE NULL END FROM sources WHERE source_id=?1").bind(&profile.source_id).fetch_optional(self.library.pool()).await.map_err(db)?;
        if let Some((kind, origin, pin)) = old {
            if kind.as_deref() != Some("hub")
                || origin.as_deref() != Some(profile.origin.as_str())
                || pin.as_deref() != Some(profile.root_fingerprint.as_str())
            {
                return Err(error("source_conflict", "作品库来源与独立信任记录冲突"));
            }
            return Ok(());
        }
        sqlx::query("INSERT INTO sources(source_id,kind,canonical_origin,root_fingerprint) VALUES(?1,'hub',?2,?3)").bind(&profile.source_id).bind(&profile.origin).bind(&profile.root_fingerprint).execute(self.library.pool()).await.map_err(db)?;
        Ok(())
    }

    pub(crate) async fn list(&self) -> Result<Vec<Subscription>, JobError> {
        self.check_rows(
            "community_subscriptions",
            SUB_BOUNDS,
            MAX_SUBSCRIPTIONS as i64,
        )
        .await?;
        let rows: Vec<Subscription> = sqlx::query_as(&format!(
            "{SUB_SELECT} WHERE {SUB_BOUNDS} ORDER BY subscription_id LIMIT 1025"
        ))
        .fetch_all(self.library.pool())
        .await
        .map_err(db)?;
        if rows.len() > MAX_SUBSCRIPTIONS {
            return Err(error("subscription_limit", "订阅记录超出上限"));
        }
        for row in &rows {
            row.validate()?;
        }
        Ok(rows)
    }
    pub(crate) async fn get(&self, id: &str) -> Result<Subscription, JobError> {
        canonical_uuid(id)?;
        let valid:Option<bool>=sqlx::query_scalar(&format!("SELECT CASE WHEN {SUB_BOUNDS} THEN 1 ELSE 0 END FROM community_subscriptions WHERE subscription_id=?1")).bind(id).fetch_optional(self.library.pool()).await.map_err(db)?;
        match valid {
            None => return Err(error("subscription_not_found", "订阅不存在")),
            Some(false) => return Err(error("community_database_invalid", "保存的订阅超出界限")),
            Some(true) => {}
        }
        let row: Subscription = sqlx::query_as(&format!(
            "{SUB_SELECT} WHERE subscription_id=?1 AND {SUB_BOUNDS}"
        ))
        .bind(id)
        .fetch_one(self.library.pool())
        .await
        .map_err(db)?;
        row.validate()?;
        Ok(row)
    }

    pub(crate) async fn subscribe(
        &self,
        source: &str,
        work: &str,
    ) -> Result<Subscription, JobError> {
        canonical_uuid(work)?;
        let profile = self.library.trust().profile(source).await?;
        self.project_source(&profile).await?;
        let mut tx = self
            .library
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        let old:Option<Option<String>>=sqlx::query_scalar("SELECT CASE WHEN length(CAST(subscription_id AS BLOB))=36 THEN subscription_id ELSE NULL END FROM community_subscriptions WHERE source_id=?1 AND remote_work_id=?2 AND channel='stable'").bind(source).bind(work).fetch_optional(&mut *tx).await.map_err(db)?;
        let old = old
            .map(|id| {
                id.ok_or_else(|| error("community_database_invalid", "保存的订阅身份超出界限"))
            })
            .transpose()?;
        let id = if let Some(old) = old {
            old
        } else {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM community_subscriptions")
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
            if count >= MAX_SUBSCRIPTIONS as i64 {
                return Err(error("subscription_limit", "订阅达到上限"));
            }
            let id = uuid::Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO community_subscriptions(subscription_id,source_id,remote_work_id) VALUES(?1,?2,?3)").bind(&id).bind(source).bind(work).execute(&mut *tx).await.map_err(db)?;
            id
        };
        tx.commit().await.map_err(db)?;
        self.get(&id).await
    }

    pub(crate) async fn policy(
        &self,
        id: &str,
        revision: i64,
        policy: &str,
        enabled: bool,
    ) -> Result<Subscription, JobError> {
        canonical_uuid(id)?;
        if revision <= 0
            || revision == i64::MAX
            || !matches!(policy, "prompt" | "cutpoint" | "startup")
        {
            return Err(error("invalid_policy", "更新策略或订阅 revision 无效"));
        }
        let changed=sqlx::query("UPDATE community_subscriptions SET policy=?3,enabled=?4,revision=revision+1 WHERE subscription_id=?1 AND revision=?2")
            .bind(id).bind(revision).bind(policy).bind(i64::from(enabled)).execute(self.library.pool()).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(error("subscription_conflict", "订阅已变化，请重新读取"));
        }
        self.get(id).await
    }

    pub(crate) async fn update(&self, id: &str) -> Result<UpdateRow, JobError> {
        canonical_uuid(id)?;
        let valid:Option<bool>=sqlx::query_scalar(&format!("SELECT CASE WHEN {UPDATE_BOUNDS} THEN 1 ELSE 0 END FROM community_updates WHERE operation_id=?1")).bind(id).fetch_optional(self.library.pool()).await.map_err(db)?;
        match valid {
            None => return Err(error("update_not_found", "更新操作不存在")),
            Some(false) => {
                return Err(error(
                    "community_database_invalid",
                    "保存的更新操作超出界限",
                ))
            }
            Some(true) => {}
        }
        let mut row: UpdateRow = sqlx::query_as(&format!(
            "{UPDATE_SELECT} WHERE operation_id=?1 AND {UPDATE_BOUNDS}"
        ))
        .bind(id)
        .fetch_one(self.library.pool())
        .await
        .map_err(db)?;
        row.validate()?;
        row.rollback_available &= row
            .previous_hash
            .as_ref()
            .is_some_and(|hash| self.library.trust().security_check(hash).is_ok());
        Ok(row)
    }

    pub(crate) async fn recent(&self) -> Result<Vec<UpdateRow>, JobError> {
        self.check_rows("community_updates", UPDATE_BOUNDS, 8192)
            .await?;
        let mut rows: Vec<UpdateRow> = sqlx::query_as(&format!(
            "{UPDATE_SELECT} WHERE {UPDATE_BOUNDS} ORDER BY updated_at DESC,operation_id LIMIT 100"
        ))
        .fetch_all(self.library.pool())
        .await
        .map_err(db)?;
        for row in &mut rows {
            row.validate()?;
            row.rollback_available &= row
                .previous_hash
                .as_ref()
                .is_some_and(|hash| self.library.trust().security_check(hash).is_ok());
        }
        Ok(rows)
    }

    pub(crate) async fn register(
        &self,
        plan: &DownloadPlan,
        job: &str,
        digest: &str,
    ) -> Result<UpdateRow, JobError> {
        let subscription = self.get(&plan.subscription_id).await?;
        if subscription.enabled != 1
            || subscription.source_id != plan.source_id
            || subscription.remote_work_id != plan.remote_work_id
            || subscription.revision != plan.binding.subscription_revision
        {
            return Err(error("subscription_conflict", "下载意图与订阅不一致"));
        }
        let existing:Option<(Option<String>,Option<String>)>=sqlx::query_as("SELECT CASE WHEN length(CAST(operation_id AS BLOB))=36 THEN operation_id ELSE NULL END,CASE WHEN length(CAST(payload_digest AS BLOB))=64 THEN payload_digest ELSE NULL END FROM community_updates WHERE request_id=?1").bind(&plan.request_id).fetch_optional(self.library.pool()).await.map_err(db)?;
        if let Some((id, saved)) = existing {
            let id = id.ok_or_else(|| error("community_database_invalid", "更新身份超出界限"))?;
            let saved =
                saved.ok_or_else(|| error("community_database_invalid", "更新摘要超出界限"))?;
            if saved != digest {
                return Err(error("request_id_conflict", "原请求已绑定另一更新意图"));
            }
            return self.update(&id).await;
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM community_updates")
            .fetch_one(self.library.pool())
            .await
            .map_err(db)?;
        if count >= 8192 {
            return Err(error(
                "update_journal_limit",
                "更新 journal 达到上限，保留已有操作",
            ));
        }
        sqlx::query("INSERT INTO community_updates(operation_id,request_id,subscription_id,payload_digest,job_id,binding_json,state,previous_hash,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'queued',?7,?8,?8)")
            .bind(&plan.operation_id).bind(&plan.request_id).bind(&plan.subscription_id).bind(digest).bind(job).bind(serde_json::to_string(&plan.binding).map_err(json)?).bind(plan.binding.previous.as_ref().map(|v|v.package_hash.as_str())).bind(now() as i64)
            .execute(self.library.pool()).await.map_err(db)?;
        self.update(&plan.operation_id).await
    }

    pub(crate) async fn save_release(
        &self,
        plan: &DownloadPlan,
        release: &AcceptedRelease,
    ) -> Result<(), JobError> {
        let profile = self.library.trust().profile(&plan.source_id).await?;
        self.project_source(&profile).await?;
        let changed=sqlx::query("UPDATE community_updates SET state='downloading',release_json=?2,candidate_hash=?3,updated_at=?4 WHERE operation_id=?1 AND state='queued'")
            .bind(&plan.operation_id).bind(release.envelope_json()?).bind(&release.body().package_hash).bind(now() as i64).execute(self.library.pool()).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(error("update_state_conflict", "已登记更新不能更换发布正文"));
        }
        Ok(())
    }

    pub(crate) async fn delta(
        &self,
        operation: &str,
        new: &crate::wallpaper::assets::StagedPackage,
        release: &AcceptedRelease,
    ) -> Result<(), JobError> {
        let update = self.update(operation).await?;
        let binding: Binding = serde_json::from_str(&update.binding_json).map_err(json)?;
        let delta = self.difference(&binding, new, Some(release)).await?;
        sqlx::query("UPDATE community_updates SET delta_json=?2,updated_at=?3 WHERE operation_id=?1 AND state='downloading'").bind(operation).bind(delta.to_string()).bind(now() as i64).execute(self.library.pool()).await.map_err(db)?;
        Ok(())
    }

    pub(crate) async fn difference(
        &self,
        binding: &Binding,
        new: &crate::wallpaper::assets::StagedPackage,
        release: Option<&AcceptedRelease>,
    ) -> Result<serde_json::Value, JobError> {
        let previous = match binding.previous.as_ref() {
            Some(p) => self
                .library
                .cover_manifest(&p.work_key, &p.package_hash)
                .await
                .ok(),
            None => None,
        };
        let added_audio = new.manifest.permissions.audio_spectrum
            && previous
                .as_ref()
                .is_none_or(|p| !p.permissions.audio_spectrum);
        let added_pointer = new.manifest.permissions.pointer
            && previous.as_ref().is_none_or(|p| !p.permissions.pointer);
        let is_web = matches!(new.manifest.content, hertz_wallpaper::Content::Web { .. });
        let became_web = is_web
            && previous
                .as_ref()
                .is_none_or(|p| !matches!(p.content, hertz_wallpaper::Content::Web { .. }));
        let old_protocol = if let Some(p) = binding.previous.as_ref() {
            if let Some(work) = self.library.get_work(&p.work_key).await? {
                self.library
                    .trust()
                    .installed_receipt(&work.source_id, &p.package_hash)
                    .await
                    .ok()
                    .map(|r| r.body().min_engine_protocol)
            } else {
                None
            }
        } else {
            None
        };
        let protocol = release.map_or(1, |r| r.body().min_engine_protocol);
        let protocol_changed = old_protocol.is_none_or(|p| p != protocol);
        let delta = serde_json::json!({"oldVersion":previous.as_ref().map(|p|p.version),"newVersion":new.manifest.version,"oldHash":binding.previous.as_ref().map(|p|p.package_hash.as_str()),"newHash":new.package_hash,
            "permissionsAdded":{"audioSpectrum":added_audio,"pointer":added_pointer},"becameWeb":became_web,"protocolChanged":protocol_changed,"minEngineProtocol":protocol,
            "requiresConfirmation":added_audio||added_pointer||became_web||protocol_changed,"permissions":new.manifest.permissions,"kind":crate::wallpaper::jobs::manifest_kind(&new.manifest)});
        Ok(delta)
    }

    pub(crate) async fn fail(&self, id: &str, reason: &str) -> Result<(), JobError> {
        let reason: String = reason.chars().take(1024).collect();
        // A download failure cannot settle an unknown Config operation.
        sqlx::query("UPDATE community_updates SET state='failed',error=?2,updated_at=?3 WHERE operation_id=?1 AND state IN ('queued','downloading')").bind(id).bind(reason).bind(now() as i64).execute(self.library.pool()).await.map_err(db)?;
        Ok(())
    }

    pub(crate) async fn stale(&self, id: &str, reason: &str) -> Result<(), JobError> {
        canonical_uuid(id)?;
        let reason: String = reason.chars().take(1024).collect();
        sqlx::query("UPDATE community_updates SET state='stale',error=?2,updated_at=?3 WHERE operation_id=?1 AND state IN ('installed','ready','awaiting_confirmation')").bind(id).bind(reason).bind(now() as i64).execute(self.library.pool()).await.map_err(db)?;
        Ok(())
    }

    pub(crate) async fn stage_apply(&self, plan: ApplyPlan<'_>) -> Result<(), JobError> {
        let identity = &plan.identity;
        for id in [
            identity.operation_id,
            identity.request_id,
            plan.subscription_id,
        ] {
            canonical_uuid(id)?;
        }
        super::gate::hash(identity.config_digest)?;
        super::gate::hash(&plan.candidate.package_hash)?;
        let revision = i64::try_from(identity.revision)
            .map_err(|_| error("invalid_update_binding", "配置 revision 超出持久界限"))?;
        if plan.binding.config_revision.checked_add(1) != Some(identity.revision)
            || plan.binding.subscription_revision <= 0
            || plan.candidate.work_key.is_empty()
            || plan.candidate.work_key.len() > 256
            || plan.confirmed == plan.automatic
            || plan.rollback && !plan.confirmed
        {
            return Err(error("invalid_update_binding", "应用与本次确认意图不一致"));
        }
        let update = self.update(identity.operation_id).await?;
        if update.apply_request_id.as_deref() == Some(identity.request_id) {
            return Err(error(
                "request_id_conflict",
                "此配置请求已经登记；请查询原操作，新应用或回滚使用新请求",
            ));
        }
        let subscription = self.get(plan.subscription_id).await?;
        if subscription.revision != plan.binding.subscription_revision
            || plan.automatic && subscription.enabled != 1
        {
            return Err(error("subscription_conflict", "订阅授权已变化"));
        }
        if &update.target_version(&subscription, plan.rollback)? != plan.candidate {
            return Err(error(
                "update_binding_invalid",
                "申请不是本次核对的确切版本",
            ));
        }
        let allowed = if plan.confirmed {
            matches!(
                update.state.as_str(),
                "installed" | "awaiting_confirmation" | "ready" | "stale" | "failed"
            ) || update.state == "applied" && (plan.rollback || update.apply_rollback)
        } else {
            let original: Binding = serde_json::from_str(&update.binding_json).map_err(json)?;
            update.state == "ready"
                && update.apply_request_id.is_none()
                && !update.apply_rollback
                && &original == plan.binding
        };
        if !allowed {
            return Err(error(
                "update_state_conflict",
                "原更新正在提交、需要重新确认或已完成；请查询原操作",
            ));
        }
        self.library
            .trust()
            .security_check(&plan.candidate.package_hash)?;
        // Confirmation and the exact Config request form one durable transition.
        // Never expose rollback approval as generic ready-to-apply authority.
        // The caller holds the original content writer through this statement.
        let changed = sqlx::query(concat!(
            "UPDATE community_updates SET state='apply_requested',apply_request_id=?2,",
            "apply_config_revision=?3,apply_config_digest=?4,updated_at=?5,",
            "apply_package_hash=?6,apply_work_key=?7,apply_rollback=?8,error=NULL ",
            "WHERE operation_id=?1 AND state=?9 AND apply_request_id IS ?10 ",
            "AND EXISTS(SELECT 1 FROM community_subscriptions s ",
            "WHERE s.subscription_id=community_updates.subscription_id AND s.subscription_id=?11 ",
            "AND s.revision=?12 AND (?13=1 OR s.enabled=1) AND (?8=1 OR s.work_key=?7)) ",
            "AND EXISTS(SELECT 1 FROM versions v JOIN packages p ON p.package_hash=v.package_hash ",
            "WHERE v.work_key=?7 AND v.package_hash=?6 AND p.state='installed')"
        ))
        .bind(identity.operation_id)
        .bind(identity.request_id)
        .bind(revision)
        .bind(identity.config_digest)
        .bind(now() as i64)
        .bind(&plan.candidate.package_hash)
        .bind(&plan.candidate.work_key)
        .bind(i64::from(plan.rollback))
        .bind(&update.state)
        .bind(&update.apply_request_id)
        .bind(plan.subscription_id)
        .bind(plan.binding.subscription_revision)
        .bind(i64::from(plan.confirmed))
        .execute(self.library.pool())
        .await
        .map_err(db)?
        .rows_affected();
        if changed != 1 {
            return Err(error("update_state_conflict", "原更新意图不能重复提交配置"));
        }
        Ok(())
    }

    pub(crate) async fn finish_apply(
        &self,
        identity: ApplyIdentity<'_>,
        saved: bool,
        failure: Option<String>,
    ) -> Result<(), JobError> {
        canonical_uuid(identity.request_id)?;
        super::gate::hash(identity.config_digest)?;
        let row = self.update(identity.operation_id).await?;
        if row.apply_request_id.as_deref() != Some(identity.request_id)
            || row.apply_config_digest.as_deref() != Some(identity.config_digest)
            || row.apply_config_revision != i64::try_from(identity.revision).ok()
        {
            return Err(error(
                "update_state_conflict",
                "原配置回执的 request、digest 或 revision 与登记目标不一致",
            ));
        }
        let failure = failure.map(|text| text.chars().take(1024).collect::<String>());
        if (row.state == "applied" && saved) || (row.state == "failed" && !saved) {
            // Recovery may learn the saved fact before the GUI reports a later
            // preparation/playback error. Keep that fact without re-projecting
            // the subscription or clearing an already recorded error with None.
            if let Some(reason) = &failure {
                sqlx::query("UPDATE community_updates SET error=?2,updated_at=?3 WHERE operation_id=?1 AND state=?4 AND apply_request_id=?5 AND apply_config_digest=?6 AND apply_config_revision=?7")
                    .bind(identity.operation_id).bind(reason).bind(now() as i64).bind(&row.state).bind(identity.request_id).bind(identity.config_digest).bind(row.apply_config_revision)
                    .execute(self.library.pool()).await.map_err(db)?;
            }
            return Ok(());
        }
        if row.state != "apply_requested" {
            return Err(error(
                "update_state_conflict",
                "配置结果与更新 journal 阶段不一致",
            ));
        }
        let mut tx = self
            .library
            .pool()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(db)?;
        let changed = sqlx::query("UPDATE community_updates SET state=?2,error=?3,updated_at=?4 WHERE operation_id=?1 AND state='apply_requested' AND apply_request_id=?5 AND apply_config_digest=?6 AND apply_config_revision=?7")
            .bind(identity.operation_id).bind(if saved { "applied" } else { "failed" }).bind(&failure).bind(now() as i64).bind(identity.request_id).bind(identity.config_digest).bind(row.apply_config_revision)
            .execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(error("update_state_conflict", "更新已进入另一配置操作"));
        }
        if saved {
            // Preserve the journal's reviewed rollback target, even when another
            // display group last projected a different subscription current_hash.
            // A completed rollback retains this update's candidate for explicit reapply.
            sqlx::query("UPDATE community_subscriptions SET previous_hash=CASE WHEN ?5=1 THEN ?6 ELSE coalesce(?3,current_hash) END,current_hash=CASE WHEN work_key=(SELECT apply_work_key FROM community_updates WHERE operation_id=?2) THEN (SELECT apply_package_hash FROM community_updates WHERE operation_id=?2) ELSE NULL END,last_error=?4 WHERE subscription_id=?1")
                .bind(&row.subscription_id).bind(identity.operation_id).bind(&row.previous_hash).bind(&failure).bind(i64::from(row.apply_rollback)).bind(&row.candidate_hash).execute(&mut *tx).await.map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }

    pub(crate) async fn reconcile_apply(&self) -> Result<(), JobError> {
        // Config's original operation journal is the commit receipt. An installed
        // directory or package row cannot establish an applied update.
        self.check_rows("community_updates", UPDATE_BOUNDS, 8192)
            .await?;
        let pending:Vec<(String,String,String,i64)>=sqlx::query_as(&format!("SELECT operation_id,apply_request_id,apply_config_digest,apply_config_revision FROM community_updates WHERE {UPDATE_BOUNDS} AND state='apply_requested' AND apply_request_id IS NOT NULL AND apply_config_digest IS NOT NULL AND apply_config_revision IS NOT NULL ORDER BY updated_at LIMIT 100")).fetch_all(self.library.pool()).await.map_err(db)?;
        for (id, request, digest, revision) in pending {
            canonical_uuid(&id)?;
            canonical_uuid(&request)?;
            super::gate::hash(&digest)?;
            let receipt = crate::config::operation_at(self.library.root(), &request);
            match receipt {
                Ok(Some(op))
                    if op.state == crate::config_journal::State::Committed
                        && op.config_revision.and_then(|v| i64::try_from(v).ok())
                            == Some(revision)
                        && op.payload_digest == digest
                        && matches!(
                            op.command.as_str(),
                            "wallpaper.community.apply" | "wallpaper.community.auto"
                        ) =>
                {
                    self.finish_apply(
                        ApplyIdentity {
                            operation_id: &id,
                            request_id: &request,
                            config_digest: &digest,
                            revision: revision as u64,
                        },
                        true,
                        None,
                    )
                    .await?
                }
                Ok(Some(op))
                    if op.state == crate::config_journal::State::NotCommitted
                        && op.payload_digest == digest
                        && matches!(
                            op.command.as_str(),
                            "wallpaper.community.apply" | "wallpaper.community.auto"
                        ) =>
                {
                    self.finish_apply(
                        ApplyIdentity {
                            operation_id: &id,
                            request_id: &request,
                            config_digest: &digest,
                            revision: revision as u64,
                        },
                        false,
                        Some("原配置操作明确未提交".into()),
                    )
                    .await?
                }
                // Unknown, pending, conflicting or unavailable original proof
                // remains apply_requested. Never infer failure from a new Config.
                _ => {}
            }
        }
        Ok(())
    }

    pub(crate) async fn reconcile(
        &self,
        _configuration: &crate::config::Config,
    ) -> Result<(), JobError> {
        self.reconcile_apply().await?;
        sqlx::query("UPDATE community_updates SET state='failed',error='interrupted: 原下载任务退出，按原 job 查询；显式重试使用新请求',updated_at=?1 WHERE state IN ('queued','downloading')").bind(now() as i64).execute(self.library.pool()).await.map_err(db)?;
        Ok(())
    }

    pub(crate) async fn finish_install(
        tx: &mut Transaction<'_, Sqlite>,
        work: &InstallWork,
        work_key: &str,
    ) -> Result<(), JobError> {
        if work.source_id == crate::wallpaper::library::LOCAL_SOURCE {
            return Ok(());
        }
        sqlx::query("UPDATE community_updates SET state=CASE WHEN json_extract(delta_json,'$.requiresConfirmation')=0 THEN 'ready' ELSE 'awaiting_confirmation' END,updated_at=?4 WHERE subscription_id IN (SELECT subscription_id FROM community_subscriptions WHERE source_id=?1 AND remote_work_id=?2) AND candidate_hash=?3 AND state='downloading'")
            .bind(&work.source_id).bind(&work.remote_work_id).bind(&work.package_hash).bind(now() as i64).execute(&mut **tx).await.map_err(db)?;
        sqlx::query("UPDATE community_subscriptions SET work_key=?3,last_sync=?4,last_error=NULL WHERE source_id=?1 AND remote_work_id=?2")
            .bind(&work.source_id).bind(&work.remote_work_id).bind(work_key).bind(now() as i64).execute(&mut **tx).await.map_err(db)?;
        Ok(())
    }
}
