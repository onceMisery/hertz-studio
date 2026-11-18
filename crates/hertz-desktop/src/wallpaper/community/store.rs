// SPDX-License-Identifier: MIT
//! Sole owner of independent security transactions. Product rows cannot create
//! a pin, lower a watermark, or infer an activated Web hash.
use super::{
    contract, database, error,
    gate::{self, Cache, Freshness},
    model::{SourceProfile, SourceStatus, MAX_RECEIPTS, MAX_SECURITY_HASHES, MAX_SOURCES},
    now,
};
use crate::{
    wallpaper::{
        budget::{self, ControlCharge},
        jobs::JobError,
    },
    wallpaper_upgrade::AdmittedPool,
};
use hertz_wallpaper::release::authorization::{
    AuthorizationChain, AuthorizationWatermark, RootPin, VerifiedAuthorizationChain,
};
use sqlx::FromRow;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, RwLock,
    },
};

#[derive(FromRow)]
pub(super) struct SourceRow {
    pub source_id: String,
    pub origin: String,
    pub hub_id: String,
    pub root_fingerprint: String,
    pub profile_json: String,
    pub chain_json: String,
    pub generation: i64,
    pub authorization_digest: String,
    pub revocations_json: Option<String>,
    pub revocations_watermark: Option<String>,
    pub observed_at: i64,
    pub last_sync: i64,
}

const SOURCE_SELECT:&str="SELECT source_id,origin,hub_id,root_fingerprint,profile_json,chain_json,generation,authorization_digest,revocations_json,revocations_watermark,observed_at,last_sync FROM trust_sources";
const SOURCE_BOUNDS:&str=concat!(
    "length(CAST(source_id AS BLOB))=36 AND length(CAST(hub_id AS BLOB))=36 ",
    "AND length(CAST(origin AS BLOB)) BETWEEN 9 AND 2048 ",
    "AND length(CAST(root_fingerprint AS BLOB))=64 AND length(CAST(authorization_digest AS BLOB))=64 ",
    "AND length(CAST(profile_json AS BLOB)) BETWEEN 2 AND 65536 ",
    "AND length(CAST(chain_json AS BLOB)) BETWEEN 2 AND 262144 ",
    "AND coalesce(length(CAST(revocations_json AS BLOB)),0)<=1048576 ",
    "AND coalesce(length(CAST(revocations_watermark AS BLOB)),0)<=2097152 ",
    "AND typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991 ",
    "AND typeof(observed_at)='integer' AND observed_at>=0 ",
    "AND typeof(last_sync)='integer' AND last_sync>=0"
);

impl SourceRow {
    pub(super) fn verified(&self) -> Result<VerifiedAuthorizationChain, JobError> {
        let saved = AuthorizationChain::parse(self.chain_json.as_bytes()).map_err(contract)?;
        let pin = RootPin::confirm(
            self.hub_id.clone(),
            saved.bootstrap_root.clone(),
            &self.root_fingerprint,
        )
        .map_err(contract)?;
        saved
            .verify(
                &pin,
                Some(&AuthorizationWatermark {
                    hub_id: self.hub_id.clone(),
                    root_fingerprint: self.root_fingerprint.clone(),
                    generation: self.generation as u64,
                    canonical_digest: self.authorization_digest.clone(),
                }),
            )
            .map_err(contract)
    }

    pub(super) fn profile(&self) -> Result<SourceProfile, JobError> {
        let profile: SourceProfile = serde_json::from_str(&self.profile_json)
            .map_err(|_| error("trust_database_invalid", "保存的来源配置无效"))?;
        profile.validate()?;
        if profile.source_id != self.source_id
            || profile.origin != self.origin
            || profile.hub_id != self.hub_id
            || profile.root_fingerprint != self.root_fingerprint
        {
            return Err(error("trust_database_invalid", "来源配置与安全行不一致"));
        }
        Ok(profile)
    }
}

pub(crate) struct TrustStore {
    pub(super) pool: AdmittedPool,
    pub(super) cache: RwLock<Cache>,
    pub(super) writer: tokio::sync::Mutex<()>,
    revision: AtomicU64,
    observed: AtomicU64,
    // All cache nodes, all-source bounded readbacks, and a replacement cache
    // coexist before swap. Charge before the first read/allocation.
    _charge: ControlCharge,
}

impl TrustStore {
    pub(crate) async fn open(root: &Path) -> Result<Arc<Self>, JobError> {
        let charge = budget::global()
            .admit_working_bytes(32 * 1024 * 1024)
            .map_err(|e| error("budget_busy", e.message.to_string()))?;
        let pool = database::open(root).await?;
        let owner = Arc::new(Self {
            pool,
            cache: RwLock::new(Cache {
                unavailable: true,
                ..Default::default()
            }),
            writer: tokio::sync::Mutex::new(()),
            revision: AtomicU64::new(0),
            observed: AtomicU64::new(0),
            _charge: charge,
        });
        owner.reload().await?;
        Ok(owner)
    }

    pub(super) async fn row(&self, id: &str) -> Result<SourceRow, JobError> {
        super::network::canonical_uuid(id)?;
        // Retain the predicate on the materializing query as well as the scalar
        // preflight. A changed row cannot evade the allocation boundary.
        let valid:Option<bool>=sqlx::query_scalar(&format!("SELECT CASE WHEN {SOURCE_BOUNDS} THEN 1 ELSE 0 END FROM trust_sources WHERE source_id=?1"))
            .bind(id).fetch_optional(&*self.pool).await.map_err(db)?;
        match valid {
            None => return Err(error("source_not_found", "社区来源未受信")),
            Some(false) => return Err(error("trust_database_invalid", "安全库来源行超出界限")),
            Some(true) => {}
        }
        sqlx::query_as(&format!(
            "{SOURCE_SELECT} WHERE source_id=?1 AND {SOURCE_BOUNDS}"
        ))
        .bind(id)
        .fetch_one(&*self.pool)
        .await
        .map_err(db)
    }

    pub(crate) async fn profile(&self, id: &str) -> Result<SourceProfile, JobError> {
        self.row(id).await?.profile()
    }

    async fn source_ids(&self) -> Result<Vec<String>, JobError> {
        let ids:Vec<Option<String>>=sqlx::query_scalar("SELECT CASE WHEN length(CAST(source_id AS BLOB))=36 THEN source_id ELSE NULL END FROM trust_sources ORDER BY origin LIMIT 17").fetch_all(&*self.pool).await.map_err(db)?;
        if ids.len() > MAX_SOURCES {
            return Err(error("trust_database_invalid", "来源数量超出安全上限"));
        }
        ids.into_iter()
            .map(|id| {
                let id =
                    id.ok_or_else(|| error("trust_database_invalid", "安全来源身份超出界限"))?;
                super::network::canonical_uuid(&id)?;
                Ok(id)
            })
            .collect()
    }

    pub(crate) async fn sources(&self) -> Result<Vec<SourceStatus>, JobError> {
        let ids = self.source_ids().await?;
        let mut result = Vec::with_capacity(ids.len());
        for id in ids {
            let row = self.row(&id).await?;
            let profile = row.profile()?;
            row.verified()?;
            let freshness = self
                .cache
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .sources
                .get(&id)
                .copied()
                .unwrap_or_default();
            let wall_time = now();
            let observed = self.observed_time();
            result.push(SourceStatus {
                profile,
                key_generation: row.generation as u64,
                last_sync: row.last_sync as u64,
                revocations_fresh: wall_time >= observed && freshness.fresh(wall_time),
                clock_rollback: wall_time < observed.max(freshness.observed),
            });
        }
        Ok(result)
    }

    /// Caller must supply a native, owner-bound, consumed confirmation ticket.
    pub(crate) async fn confirm_source(
        &self,
        profile: &SourceProfile,
        bytes: &[u8],
        confirmed: &str,
    ) -> Result<(), JobError> {
        profile.validate()?;
        let draft = AuthorizationChain::parse(bytes).map_err(contract)?;
        let pin = RootPin::confirm(
            profile.hub_id.clone(),
            draft.bootstrap_root.clone(),
            confirmed,
        )
        .map_err(contract)?;
        if pin.fingerprint() != profile.root_fingerprint {
            return Err(error("root_fingerprint_mismatch", "来源展示的根指纹已变化"));
        }
        let chain = draft.verify(&pin, None).map_err(contract)?;
        let _writer = self.writer.lock().await;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM trust_sources")
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        if count >= MAX_SOURCES as i64 {
            return Err(error("source_limit", "社区来源达到上限"));
        }
        sqlx::query("INSERT INTO trust_sources(source_id,origin,hub_id,root_fingerprint,profile_json,chain_json,generation,authorization_digest) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)")
            .bind(&profile.source_id).bind(&profile.origin).bind(&profile.hub_id).bind(&profile.root_fingerprint).bind(serde_json::to_string(profile).map_err(json)?)
            .bind(String::from_utf8(chain.canonical_bytes().map_err(contract)?).map_err(|_|error("trust_encoding","授权链必须是 UTF8"))?).bind(chain.watermark().generation as i64).bind(&chain.watermark().canonical_digest)
            .execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        self.reload().await
    }

    pub(super) fn observed_time(&self) -> u64 {
        let time = now();
        self.observed.fetch_max(time, Ordering::AcqRel).max(time)
    }
    pub(crate) fn security_check(&self, hash: &str) -> Result<(), JobError> {
        self.cache
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .security_check(hash, self.observed_time())
    }
    pub(crate) fn activation_check(&self, hash: &str, is_web: bool) -> Result<(), JobError> {
        self.cache
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .activation_check(hash, is_web, self.observed_time())
    }

    pub(crate) async fn persist_observed_time(&self, time: u64) -> Result<(), JobError> {
        let _writer = self.writer.lock().await;
        let time = time.max(self.observed_time());
        let result =
            sqlx::query("UPDATE trust_clock SET observed_at=max(observed_at,?1) WHERE singleton=1")
                .bind(
                    i64::try_from(time)
                        .map_err(|_| error("trust_clock_invalid", "安全时间水位溢出"))?,
                )
                .execute(&*self.pool)
                .await
                .map_err(db);
        match result {
            Ok(done) if done.rows_affected() == 1 => Ok(()),
            other => {
                self.cache
                    .write()
                    .unwrap_or_else(|e| e.into_inner())
                    .unavailable = true;
                self.revision.fetch_add(1, Ordering::Release);
                Err(other
                    .err()
                    .unwrap_or_else(|| error("trust_database_invalid", "安全时间行缺失")))
            }
        }
    }

    pub(crate) fn security_snapshot(
        &self,
        revision: u64,
        next_due: u64,
    ) -> Result<Option<SecuritySnapshot>, JobError> {
        let current = self.revision.load(Ordering::Acquire);
        let time = self.observed_time();
        if current == revision && time < next_due {
            return Ok(None);
        }
        let cache = self.cache.read().unwrap_or_else(|e| e.into_inner());
        if cache.unavailable {
            return Err(error("trust_unavailable", "安全状态不可用"));
        }
        let fee = budget::global()
            .admit_working_bytes(cache.security.len() as u64 * 192 + 4096)
            .map_err(|e| error("budget_busy", e.message.to_string()))?;
        let time = time.max(cache.observed_at);
        let mut hashes = Vec::with_capacity(cache.security.len());
        let mut next = u64::MAX;
        for (key, effective) in &cache.security {
            if *effective <= time {
                hashes.push(key.iter().map(|b| format!("{b:02x}")).collect());
            } else {
                next = next.min(*effective);
            }
        }
        Ok(Some(SecuritySnapshot {
            revision: current,
            next_due: next,
            observed_at: time,
            hashes,
            _charge: fee,
        }))
    }

    pub(crate) async fn mark_web_activated(&self, hash: &str) -> Result<(), JobError> {
        let _writer = self.writer.lock().await;
        self.activation_check(hash, true)?;
        let key = gate::hash(hash)?;
        if !self
            .cache
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .community
            .contains_key(&key)
        {
            return Ok(());
        }
        sqlx::query("INSERT INTO activated_web_hashes(package_hash,activated_at) VALUES(?1,?2) ON CONFLICT(package_hash) DO NOTHING")
            .bind(hash).bind(now() as i64).execute(&*self.pool).await.map_err(db)?;
        self.cache
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .activated
            .insert(key);
        Ok(())
    }

    pub(super) async fn reload(&self) -> Result<(), JobError> {
        let result = self.read_cache().await;
        match result {
            Ok(mut next) => {
                next.observed_at = self
                    .observed
                    .fetch_max(next.observed_at, Ordering::AcqRel)
                    .max(next.observed_at);
                *self.cache.write().unwrap_or_else(|e| e.into_inner()) = next;
                self.revision.fetch_add(1, Ordering::Release);
                Ok(())
            }
            Err(e) => {
                self.cache
                    .write()
                    .unwrap_or_else(|p| p.into_inner())
                    .unavailable = true;
                self.revision.fetch_add(1, Ordering::Release);
                Err(e)
            }
        }
    }

    async fn read_cache(&self) -> Result<Cache, JobError> {
        let mut cache = Cache::default();
        let observed: i64 =
            sqlx::query_scalar("SELECT observed_at FROM trust_clock WHERE singleton=1")
                .fetch_one(&*self.pool)
                .await
                .map_err(db)?;
        if observed < 0 {
            return Err(error("trust_database_invalid", "安全时间水位无效"));
        }
        cache.observed_at = observed as u64;
        let security:Vec<(Option<String>,i64)>=sqlx::query_as("SELECT CASE WHEN length(CAST(package_hash AS BLOB))=64 THEN package_hash ELSE NULL END,effective_at FROM security_hashes LIMIT 65537").fetch_all(&*self.pool).await.map_err(db)?;
        if security.len() > MAX_SECURITY_HASHES {
            return Err(error(
                "security_capacity",
                "完整安全哈希表超出上限，必须升级协议",
            ));
        }
        for (hash, effective) in security {
            let hash =
                hash.ok_or_else(|| error("trust_database_invalid", "安全撤销哈希超出界限"))?;
            if effective <= 0 {
                return Err(error("trust_database_invalid", "安全撤销时间无效"));
            }
            cache.security.insert(gate::hash(&hash)?, effective as u64);
        }
        let receipts:Vec<(Option<String>,Option<String>)>=sqlx::query_as("SELECT CASE WHEN length(CAST(package_hash AS BLOB))=64 THEN package_hash ELSE NULL END,CASE WHEN length(CAST(source_id AS BLOB))=36 THEN source_id ELSE NULL END FROM release_receipts LIMIT 8193").fetch_all(&*self.pool).await.map_err(db)?;
        if receipts.len() > MAX_RECEIPTS {
            return Err(error("receipt_capacity", "历史可信回执达到上限"));
        }
        for (hash, source) in receipts {
            let hash =
                hash.ok_or_else(|| error("trust_database_invalid", "可信回执哈希超出界限"))?;
            let source =
                source.ok_or_else(|| error("trust_database_invalid", "可信回执来源超出界限"))?;
            super::network::canonical_uuid(&source)?;
            cache
                .community
                .entry(gate::hash(&hash)?)
                .or_default()
                .insert(source);
        }
        let activated:Vec<Option<String>>=sqlx::query_scalar("SELECT CASE WHEN length(CAST(package_hash AS BLOB))=64 THEN package_hash ELSE NULL END FROM activated_web_hashes LIMIT 8193").fetch_all(&*self.pool).await.map_err(db)?;
        if activated.len() > MAX_RECEIPTS {
            return Err(error("trust_database_invalid", "Web 激活记录超出上限"));
        }
        for hash in activated {
            cache.activated.insert(gate::hash(
                &hash.ok_or_else(|| error("trust_database_invalid", "Web 激活哈希超出界限"))?,
            )?);
        }
        let ids = self.source_ids().await?;
        for id in ids {
            let row = self.row(&id).await?;
            let chain = row.verified()?;
            row.profile()?;
            let mut freshness = Freshness {
                observed: row.observed_at.max(0) as u64,
                ..Default::default()
            };
            cache.observed_at = cache.observed_at.max(freshness.observed);
            if let Some(envelope) = row.revocations_json {
                let signed =
                    hertz_wallpaper::release::SignedRevocations::parse(envelope.as_bytes())
                        .map_err(contract)?;
                let key = chain
                    .historical_key(
                        &signed.revocations.key_id,
                        hertz_wallpaper::release::KeyPurpose::Revocations,
                    )
                    .map_err(contract)?;
                let verified = signed.verify(&key).map_err(contract)?;
                let watermark: hertz_wallpaper::release::watermarks::RevocationsWatermark =
                    serde_json::from_str(
                        row.revocations_watermark
                            .as_deref()
                            .ok_or_else(|| error("trust_database_invalid", "撤销缺少水位"))?,
                    )
                    .map_err(json)?;
                hertz_wallpaper::release::watermarks::revocations_update(
                    Some(&watermark),
                    &id,
                    &verified,
                )
                .map_err(contract)?;
                for (hash, effective) in &watermark.security {
                    if cache
                        .security
                        .get(&gate::hash(hash)?)
                        .is_none_or(|saved| *saved > *effective)
                    {
                        return Err(error("trust_database_invalid", "安全哈希表遗漏已签撤销"));
                    }
                }
                freshness.issued = verified.body().issued_at;
                freshness.expires = verified.body().expires_at;
                freshness.observed = freshness.observed.max(freshness.issued);
                cache.observed_at = cache.observed_at.max(freshness.observed);
            }
            cache.sources.insert(id, freshness);
        }
        Ok(cache)
    }
}

pub(super) fn db(e: sqlx::Error) -> JobError {
    JobError::database(e.to_string())
}
pub(super) fn json(e: serde_json::Error) -> JobError {
    error("trust_encoding", e.to_string())
}

pub(crate) struct SecuritySnapshot {
    pub revision: u64,
    pub next_due: u64,
    pub observed_at: u64,
    pub hashes: Vec<String>,
    _charge: ControlCharge,
}
