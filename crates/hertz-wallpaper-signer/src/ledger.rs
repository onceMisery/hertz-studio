// SPDX-License-Identifier: MIT
mod records;
#[cfg(test)]
mod recovery_tests;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
mod watermarks;

use std::{path::Path, time::Duration};

use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    SqlitePool,
};

use crate::{
    checkpoint::{Identity, Record, Store, TailProof},
    config::Config,
    keys::Keys,
    platform::{self, Locks},
    protocol::{self, Approval, Error, Request, Response, Result, MAX_OPERATIONS},
};
use records::{ApprovalRow, Intent};

pub struct Ledger {
    config: Config,
    pool: SqlitePool,
    keys: Keys,
    identity: Identity,
    checkpoints: Store,
    _locks: Locks,
}

impl Ledger {
    pub async fn initialize(config: &Config) -> Result<()> {
        if config.database_path.try_exists()? {
            return Err(Error("ledger_already_exists"));
        }
        let _locks = Locks::acquire(
            &config.database_path,
            &config.checkpoint_directory,
            &config.service_identity,
            true,
        )?;
        let keys = Keys::load(config)?;
        let identity = Identity::new(config, &keys.bootstrap_public()?);
        // Explicit initialization creates new state only. Partial initialization
        // is retained for an operator; existing files are never replaced.
        platform::create_private_file(&config.database_path, &config.service_identity)?
            .sync_all()?;
        platform::sync_directory(
            config
                .database_path
                .parent()
                .ok_or(Error("invalid_database_path"))?,
        )?;
        let pool = connect(config).await?;
        let result = async {
            let mut tx = pool.begin().await?;
            sqlx::raw_sql(include_str!("../migrations/0001_signer.sql"))
                .execute(&mut *tx)
                .await?;
            sqlx::raw_sql(include_str!("../migrations/0002_authorizations.sql"))
                .execute(&mut *tx)
                .await?;
            crate::authorization::initialize(&mut tx, keys.authorization()).await?;
            sqlx::query("INSERT INTO signer_identity(singleton,identity_json) VALUES(1,?)")
                .bind(identity.encoded()?)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            Store::initialize(config, &identity)?;
            crate::authorization::flush(config, keys.authorization(), 0)
        }
        .await;
        pool.close().await;
        result
    }

    pub async fn open(config: Config, recovery_proof: Option<&Path>) -> Result<Self> {
        let locks = Locks::acquire(
            &config.database_path,
            &config.checkpoint_directory,
            &config.service_identity,
            false,
        )?;
        let mut database =
            platform::private_file(&config.database_path, &config.service_identity, false)?;
        if database.metadata()?.len() > config.max_database_bytes {
            return Err(Error("database_budget_exhausted"));
        }
        // Reject an unrelated database before SQLite can apply journal pragmas.
        records::check_database_header(&mut database)?;
        drop(database);
        let keys = Keys::load(&config)?;
        let identity = Identity::new(&config, &keys.bootstrap_public()?);
        let pool = connect(&config).await?;
        // A rejected recovery must finish releasing SQLite's writer handle before
        // returning. Dropping a pool alone starts asynchronous cleanup and can
        // make the next valid open fail the protected-file sharing check.
        let result = async {
            let version: i64 = sqlx::query_scalar("PRAGMA user_version")
                .fetch_one(&pool)
                .await?;
            if version != 2 {
                return Err(Error("unsupported_signer_schema"));
            }
            let stored: Option<String> =
                sqlx::query_scalar("SELECT CASE WHEN length(CAST(identity_json AS BLOB)) BETWEEN 2 AND 16384 THEN identity_json ELSE NULL END FROM signer_identity WHERE singleton=1")
                    .fetch_one(&pool)
                    .await?;
            let stored = stored.ok_or(Error("stored_ledger_identity_exceeds_limit"))?;
            if stored != identity.encoded()? {
                return Err(Error("ledger_identity_or_keys_changed"));
            }
            crate::authorization::reconcile(&pool, &config, &keys).await?;
            let checkpoints =
                Store::open(&config, identity.clone(), keys.authorization().watermark())?;
            let mut ledger = Self {
                config,
                pool: pool.clone(),
                keys,
                identity,
                checkpoints,
                _locks: locks,
            };
            ledger.reconcile().await?;
            if let Some(proof) = recovery_proof {
                ledger
                    .checkpoints
                    .check_recovery_proof(&ledger.config, proof)?;
            }
            Ok(ledger)
        }
        .await;
        if result.is_err() {
            pool.close().await;
        }
        result
    }

    async fn reconcile(&mut self) -> Result<()> {
        let (count, maximum): (i64, i64) =
            sqlx::query_as("SELECT count(*),coalesce(max(position),0) FROM signing_intents")
                .fetch_one(&self.pool)
                .await?;
        if count != maximum || count > MAX_OPERATIONS {
            return Err(Error("invalid_ledger_sequence"));
        }
        if maximum < self.checkpoints.observed_tail() as i64 {
            return Err(Error("ledger_behind_independent_checkpoint"));
        }
        let approvals: i64 = sqlx::query_scalar("SELECT count(*) FROM approvals")
            .fetch_one(&self.pool)
            .await?;
        if approvals > MAX_OPERATIONS {
            return Err(Error("approval_capacity_exhausted"));
        }
        let mut audit = watermarks::Audit::default();
        for position in 1..=maximum {
            let intent: Intent = sqlx::query_as("SELECT * FROM signing_intents WHERE position=?")
                .bind(position)
                .fetch_one(&self.pool)
                .await?;
            let approval = self
                .approval(&intent.operation_id)
                .await?
                .ok_or(Error("stored_approval_missing"))?;
            let record = intent.validated(&approval, &self.config, &self.identity, &self.keys)?;
            audit.record(&record)?;
            watermarks::check_release_identity(&self.pool, &record).await?;
            self.checkpoints.ensure(
                &record,
                &intent.checkpoint_hash,
                intent.envelope_json.is_some(),
            )?;
        }
        audit.validate(&self.pool).await
    }

    pub fn peer_allowed(&self, peer: &str) -> bool {
        peer == self.config.hub_identity || self.config.is_approver(peer)
    }
    pub fn tail(&self) -> TailProof {
        self.checkpoints.tail()
    }
    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn handle(&mut self, peer: &str, request: Request) -> Result<Response> {
        match request {
            Request::Approve {
                approval,
                confirmed_digest,
            } => {
                if !self.config.is_approver(peer) {
                    return Err(Error("approval_identity_required"));
                }
                self.approve(peer, *approval, &confirmed_digest).await
            }
            Request::RevokeApproval {
                operation_id,
                body_digest,
            } => {
                if !self.config.is_approver(peer) {
                    return Err(Error("approval_identity_required"));
                }
                self.revoke(peer, &operation_id, &body_digest).await
            }
            Request::SignRelease {
                operation_id,
                body_digest,
            } => {
                if peer != self.config.hub_identity {
                    return Err(Error("hub_identity_required"));
                }
                self.sign(&operation_id, &body_digest, "release").await
            }
            Request::SignRevocations {
                operation_id,
                body_digest,
            } => {
                if peer != self.config.hub_identity {
                    return Err(Error("hub_identity_required"));
                }
                self.sign(&operation_id, &body_digest, "revocations").await
            }
            Request::Query {
                operation_id,
                body_digest,
            } => {
                if !self.peer_allowed(peer) {
                    return Err(Error("unauthorized_peer"));
                }
                self.query(peer, &operation_id, &body_digest).await
            }
        }
    }

    async fn approval(&self, operation: &str) -> Result<Option<ApprovalRow>> {
        Ok(
            sqlx::query_as("SELECT * FROM approvals WHERE operation_id=?")
                .bind(operation)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    async fn intent(&self, operation: &str) -> Result<Option<Intent>> {
        Ok(
            sqlx::query_as("SELECT * FROM signing_intents WHERE operation_id=?")
                .bind(operation)
                .fetch_optional(&self.pool)
                .await?,
        )
    }

    async fn approve(&self, peer: &str, approval: Approval, confirmed: &str) -> Result<Response> {
        approval.validate()?;
        self.config.check_document(&approval.document)?;
        self.keys.check_current(&approval.document)?;
        Keys::check_envelope_size(&approval.document)?;
        let digest = approval.document.digest()?;
        protocol::body_identity(&approval.operation_id, confirmed)?;
        if confirmed != digest {
            return Err(Error("confirmation_digest_mismatch"));
        }
        let encoded = protocol::encode(&approval)?;
        let approval_digest = protocol::hash(encoded.as_bytes());
        if let Some(previous) = self.approval(&approval.operation_id).await? {
            previous.validated(&self.config)?;
            if previous.approval_digest != approval_digest || previous.approver_identity != peer {
                return Err(Error("approval_operation_conflict"));
            }
            return self.query(peer, &approval.operation_id, &digest).await;
        }
        let mut tx = self.pool.begin().await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM approvals")
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_OPERATIONS {
            return Err(Error("approval_capacity_exhausted"));
        }
        sqlx::query("INSERT INTO approvals(operation_id,kind,body_digest,canonical_body,approval_json,approval_digest,approver_identity,state,approved_at) VALUES(?,?,?,?,?,?,?,'approved',?)")
            .bind(&approval.operation_id).bind(approval.document.kind()).bind(&digest).bind(String::from_utf8(approval.document.canonical()?).map_err(|_| Error("invalid_document_encoding"))?)
            .bind(encoded).bind(approval_digest).bind(peer).bind(protocol::now()?).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Response::state("approved"))
    }

    async fn revoke(&self, peer: &str, operation: &str, digest: &str) -> Result<Response> {
        protocol::body_identity(operation, digest)?;
        let approval = self
            .approval(operation)
            .await?
            .ok_or(Error("operation_unknown"))?;
        approval.validated(&self.config)?;
        if approval.body_digest != digest || approval.approver_identity != peer {
            return Err(Error("approval_owner_or_digest_mismatch"));
        }
        if self.intent(operation).await?.is_some() {
            return Err(Error("registered_approval_is_immutable"));
        }
        if approval.state == "revoked" {
            return Ok(Response::state("revoked"));
        }
        let at = protocol::now()?;
        if at < approval.approved_at {
            return Err(Error("approval_clock_rollback"));
        }
        let mut tx = self.pool.begin().await?;
        let changed = sqlx::query("UPDATE approvals SET state='revoked',revoked_at=? WHERE operation_id=? AND state='approved' AND NOT EXISTS(SELECT 1 FROM signing_intents WHERE operation_id=?)")
            .bind(at).bind(operation).bind(operation).execute(&mut *tx).await?.rows_affected();
        if changed != 1 {
            return Err(Error("approval_state_changed"));
        }
        tx.commit().await?;
        Ok(Response::state("revoked"))
    }

    async fn sign(&mut self, operation: &str, digest: &str, kind: &str) -> Result<Response> {
        protocol::body_identity(operation, digest)?;
        let approval = self
            .approval(operation)
            .await?
            .ok_or(Error("protected_approval_required"))?;
        let reviewed = approval.validated(&self.config)?;
        if approval.body_digest != digest || approval.kind != kind {
            return Err(Error("signing_operation_or_purpose_conflict"));
        }
        if approval.state != "approved" {
            return Err(Error("approval_revoked"));
        }
        if let Some(intent) = self.intent(operation).await? {
            intent.validated(&approval, &self.config, &self.identity, &self.keys)?;
            if intent.envelope_json.is_none() {
                self.finish_pending()
                    .await
                    .map_err(|_| Error("operation_outcome_unknown"))?;
            }
            return self
                .query(&self.config.hub_identity, operation, digest)
                .await;
        }
        self.keys.check_current(&reviewed.document)?;
        self.finish_pending()
            .await
            .map_err(|_| Error("signer_recovery_required"))?;
        let at = protocol::now()?;
        if at < approval.approved_at {
            return Err(Error("approval_clock_rollback"));
        }
        let tail = self.checkpoints.tail();
        if tail.position >= MAX_OPERATIONS as u64 {
            return Err(Error("signing_capacity_exhausted"));
        }
        let record = Record {
            format_version: 1,
            identity_digest: self.identity.digest()?,
            position: tail.position + 1,
            operation_id: operation.to_owned(),
            body_digest: digest.to_owned(),
            key_generation: self.keys.authorization().watermark().generation,
            authorization_digest: self
                .keys
                .authorization()
                .watermark()
                .canonical_digest
                .clone(),
            approval_digest: approval.approval_digest.clone(),
            document: reviewed.document,
            approver_identity: approval.approver_identity.clone(),
            registered_at: at as u64,
            previous_hash: tail.checkpoint_hash,
        };
        record.validate(&self.identity)?;
        let checkpoint_hash = record.digest()?;
        let encoded = record.encoded()?;
        let mut tx = self.pool.begin().await?;
        // Reserve identity, version/sequence and complete security facts in the
        // same FULL-synchronous transaction as the immutable signing intent.
        sqlx::query("INSERT INTO signing_intents(position,operation_id,body_digest,checkpoint_hash,record_json) VALUES(?,?,?,?,?)")
            .bind(record.position as i64).bind(operation).bind(digest).bind(&checkpoint_hash).bind(encoded).execute(&mut *tx).await?;
        watermarks::apply(&mut tx, &record).await?;
        tx.commit().await?;
        // No signature is produced before this transaction has committed and its
        // independent checkpoint is flushed. A lost reply queries this same ID.
        self.finish_pending()
            .await
            .map_err(|_| Error("operation_outcome_unknown"))?;
        self.query(&self.config.hub_identity, operation, digest)
            .await
    }

    pub async fn finish_pending(&mut self) -> Result<()> {
        loop {
            let intent: Option<Intent> = sqlx::query_as("SELECT * FROM signing_intents WHERE envelope_json IS NULL ORDER BY position LIMIT 1").fetch_optional(&self.pool).await?;
            let Some(intent) = intent else {
                return Ok(());
            };
            let approval = self
                .approval(&intent.operation_id)
                .await?
                .ok_or(Error("stored_approval_missing"))?;
            let record = intent.validated(&approval, &self.config, &self.identity, &self.keys)?;
            if record.position > self.checkpoints.tail().position {
                self.checkpoints
                    .ensure(&record, &intent.checkpoint_hash, false)?;
            }
            self.checkpoints.require(&record, &intent.checkpoint_hash)?;
            let envelope = self.keys.sign(&record.document)?;
            let at = protocol::now()?;
            if at < record.registered_at as i64 {
                return Err(Error("signature_clock_rollback"));
            }
            let mut tx = self.pool.begin().await?;
            let changed = sqlx::query("UPDATE signing_intents SET envelope_json=?,signed_at=? WHERE operation_id=? AND body_digest=? AND envelope_json IS NULL")
                .bind(protocol::encode(&envelope)?).bind(at).bind(&intent.operation_id).bind(&intent.body_digest).execute(&mut *tx).await?.rows_affected();
            if changed != 1 {
                return Err(Error("signature_state_changed"));
            }
            tx.commit().await?;
        }
    }

    async fn query(&self, peer: &str, operation: &str, digest: &str) -> Result<Response> {
        protocol::body_identity(operation, digest)?;
        let approval = self
            .approval(operation)
            .await?
            .ok_or(Error("operation_unknown"))?;
        let reviewed = approval.validated(&self.config)?;
        if approval.body_digest != digest {
            return Err(Error("operation_digest_conflict"));
        }
        if let Some(intent) = self.intent(operation).await? {
            let record = intent.validated(&approval, &self.config, &self.identity, &self.keys)?;
            let mut response = Response::state(if intent.envelope_json.is_some() {
                "signed"
            } else {
                "registered"
            });
            response.envelope = intent.envelope()?;
            response.checkpoint = Some(self.checkpoints.tail());
            response.operation_id = Some(operation.to_owned());
            response.body_digest = Some(digest.to_owned());
            response.key_generation = Some(record.key_generation);
            response.authorization_digest = Some(record.authorization_digest);
            response.approval_digest = Some(approval.approval_digest);
            response.approval_evidence = Some(reviewed.evidence);
            response.approver_identity = Some(approval.approver_identity);
            return Ok(response);
        }
        let mut response = Response::state(&approval.state);
        response.operation_id = Some(operation.to_owned());
        response.body_digest = Some(digest.to_owned());
        response.approval_digest = Some(approval.approval_digest.clone());
        response.approval_evidence = Some(reviewed.evidence.clone());
        response.approver_identity = Some(approval.approver_identity.clone());
        if self.config.is_approver(peer) {
            response.approval = Some(reviewed);
            response.approver_identity = Some(approval.approver_identity);
        }
        Ok(response)
    }
}

async fn connect(config: &Config) -> Result<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(&config.database_path)
        .create_if_missing(false)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Delete)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(Duration::from_secs(5))
        .pragma("page_size", "4096")
        .pragma("mmap_size", "0")
        .pragma(
            "max_page_count",
            (config.max_database_bytes / 4096).to_string(),
        );
    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?)
}
