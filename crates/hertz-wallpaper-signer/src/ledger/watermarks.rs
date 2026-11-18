// SPDX-License-Identifier: MIT
use std::collections::{BTreeMap, BTreeSet};

use hertz_wallpaper::release::{RevocationEntry, RevocationReason, Revocations, MAX_SAFE_INTEGER};
use sqlx::{SqliteConnection, SqlitePool};

use crate::{
    checkpoint::Record,
    keys::Keys,
    protocol::{self, Document, Error, Result},
};

#[derive(Clone, PartialEq, Eq, sqlx::FromRow)]
struct ReleaseState {
    work_id: String,
    release_id: String,
    version: i64,
    package_hash: String,
    body_digest: String,
    published_at: i64,
    operation_id: String,
}

#[derive(Clone, PartialEq, Eq, sqlx::FromRow)]
struct RevocationsState {
    sequence: i64,
    issued_at: i64,
    body_digest: String,
    document_json: String,
    operation_id: String,
}

#[derive(Default)]
pub(super) struct Audit {
    releases: BTreeMap<String, ReleaseState>,
    release_count: i64,
    revocations: Option<RevocationsState>,
    security: BTreeMap<String, u64>,
}

impl Audit {
    pub fn record(&mut self, record: &Record) -> Result<()> {
        match &record.document {
            Document::Release(body) => {
                if self
                    .revocations
                    .as_ref()
                    .is_some_and(|previous| record.registered_at < previous.issued_at as u64)
                {
                    return Err(Error("release_clock_rollback"));
                }
                check_capacity(self.revocations.as_ref())?;
                let next = release_next(
                    self.releases.get(&body.work_id),
                    record,
                    self.security.contains_key(&body.package_hash),
                )?;
                self.releases.insert(body.work_id.clone(), next);
                self.release_count += 1;
            }
            Document::Revocations(body) => {
                self.revocations = Some(revocations_next(
                    self.revocations.as_ref(),
                    &self.security,
                    record,
                )?);
                self.security = security_entries(body);
            }
        }
        Ok(())
    }

    pub async fn validate(&self, pool: &SqlitePool) -> Result<()> {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM release_watermarks")
            .fetch_one(pool)
            .await?;
        let identities: i64 = sqlx::query_scalar("SELECT count(*) FROM release_identities")
            .fetch_one(pool)
            .await?;
        if count != self.releases.len() as i64 || identities != self.release_count {
            return Err(Error("release_watermark_mismatch"));
        }
        for (work, expected) in &self.releases {
            let actual: Option<ReleaseState> =
                sqlx::query_as("SELECT * FROM release_watermarks WHERE work_id=?")
                    .bind(work)
                    .fetch_optional(pool)
                    .await?;
            if actual.as_ref() != Some(expected) {
                return Err(Error("release_watermark_mismatch"));
            }
        }
        let revocations: Option<RevocationsState> = sqlx::query_as("SELECT sequence,issued_at,body_digest,document_json,operation_id FROM revocations_watermark WHERE singleton=1").fetch_optional(pool).await?;
        if revocations != self.revocations {
            return Err(Error("revocations_watermark_mismatch"));
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM security_revocations")
            .fetch_one(pool)
            .await?;
        if count != self.security.len() as i64 {
            return Err(Error("security_watermark_mismatch"));
        }
        for (hash, time) in &self.security {
            let actual: Option<i64> = sqlx::query_scalar(
                "SELECT effective_at FROM security_revocations WHERE package_hash=?",
            )
            .bind(hash)
            .fetch_optional(pool)
            .await?;
            if actual != Some(*time as i64) {
                return Err(Error("security_watermark_mismatch"));
            }
        }
        Ok(())
    }
}

pub(super) async fn check_release_identity(pool: &SqlitePool, record: &Record) -> Result<()> {
    if let Document::Release(body) = &record.document {
        let actual: Option<(String, i64, String)> = sqlx::query_as(
            "SELECT work_id,version,operation_id FROM release_identities WHERE release_id=?",
        )
        .bind(&body.release_id)
        .fetch_optional(pool)
        .await?;
        if actual
            != Some((
                body.work_id.clone(),
                body.version as i64,
                record.operation_id.clone(),
            ))
        {
            return Err(Error("release_identity_mismatch"));
        }
    }
    Ok(())
}

pub(super) async fn apply(connection: &mut SqliteConnection, record: &Record) -> Result<()> {
    let previous_revocations: Option<RevocationsState> = sqlx::query_as("SELECT sequence,issued_at,body_digest,document_json,operation_id FROM revocations_watermark WHERE singleton=1").fetch_optional(&mut *connection).await?;
    match &record.document {
        Document::Release(body) => {
            if previous_revocations
                .as_ref()
                .is_some_and(|previous| record.registered_at < previous.issued_at as u64)
            {
                return Err(Error("release_clock_rollback"));
            }
            check_capacity(previous_revocations.as_ref())?;
            let previous: Option<ReleaseState> =
                sqlx::query_as("SELECT * FROM release_watermarks WHERE work_id=?")
                    .bind(&body.work_id)
                    .fetch_optional(&mut *connection)
                    .await?;
            let security: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM security_revocations WHERE package_hash=?",
            )
            .bind(&body.package_hash)
            .fetch_one(&mut *connection)
            .await?;
            let next = release_next(previous.as_ref(), record, security != 0)?;
            let used: i64 = sqlx::query_scalar("SELECT count(*) FROM release_identities WHERE release_id=? OR (work_id=? AND version=?)").bind(&body.release_id).bind(&body.work_id).bind(body.version as i64).fetch_one(&mut *connection).await?;
            if used != 0 {
                return Err(Error("release_identity_already_used"));
            }
            sqlx::query("INSERT INTO release_identities(release_id,work_id,version,operation_id) VALUES(?,?,?,?)").bind(&body.release_id).bind(&body.work_id).bind(body.version as i64).bind(&record.operation_id).execute(&mut *connection).await?;
            sqlx::query("INSERT INTO release_watermarks(work_id,release_id,version,package_hash,body_digest,published_at,operation_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET release_id=excluded.release_id,version=excluded.version,package_hash=excluded.package_hash,body_digest=excluded.body_digest,published_at=excluded.published_at,operation_id=excluded.operation_id")
                .bind(next.work_id).bind(next.release_id).bind(next.version).bind(next.package_hash).bind(next.body_digest).bind(next.published_at).bind(next.operation_id).execute(&mut *connection).await?;
        }
        Document::Revocations(body) => {
            let previous_security = previous_revocations
                .as_ref()
                .map(|state| parse_revocations(state).map(|body| security_entries(&body)))
                .transpose()?
                .unwrap_or_default();
            let next = revocations_next(previous_revocations.as_ref(), &previous_security, record)?;
            for entry in &body.entries {
                if entry.reason == RevocationReason::Security {
                    // Existing security facts are immutable. check_security above
                    // required the same effectiveAt before this insert-only write.
                    sqlx::query("INSERT INTO security_revocations(package_hash,effective_at) VALUES(?,?) ON CONFLICT(package_hash) DO NOTHING").bind(&entry.package_hash).bind(entry.effective_at as i64).execute(&mut *connection).await?;
                }
            }
            sqlx::query("INSERT INTO revocations_watermark(singleton,sequence,issued_at,body_digest,document_json,operation_id) VALUES(1,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET sequence=excluded.sequence,issued_at=excluded.issued_at,body_digest=excluded.body_digest,document_json=excluded.document_json,operation_id=excluded.operation_id")
                .bind(next.sequence).bind(next.issued_at).bind(next.body_digest).bind(next.document_json).bind(next.operation_id).execute(&mut *connection).await?;
        }
    }
    Ok(())
}

fn release_next(
    previous: Option<&ReleaseState>,
    record: &Record,
    blocked: bool,
) -> Result<ReleaseState> {
    let Document::Release(body) = &record.document else {
        return Err(Error("release_document_required"));
    };
    if blocked {
        return Err(Error("security_revoked_package"));
    }
    if body.published_at > record.registered_at {
        return Err(Error("release_clock_invalid"));
    }
    if let Some(previous) = previous {
        if body.version <= previous.version as u64 {
            return Err(Error("release_version_not_monotonic"));
        }
        if body.published_at < previous.published_at as u64 {
            return Err(Error("release_clock_rollback"));
        }
    }
    Ok(ReleaseState {
        work_id: body.work_id.clone(),
        release_id: body.release_id.clone(),
        version: body.version as i64,
        package_hash: body.package_hash.clone(),
        body_digest: record.body_digest.clone(),
        published_at: body.published_at as i64,
        operation_id: record.operation_id.clone(),
    })
}

fn revocations_next(
    previous: Option<&RevocationsState>,
    security: &BTreeMap<String, u64>,
    record: &Record,
) -> Result<RevocationsState> {
    let Document::Revocations(body) = &record.document else {
        return Err(Error("revocations_document_required"));
    };
    if body.issued_at > record.registered_at || body.expires_at <= record.registered_at {
        return Err(Error("revocations_not_fresh_at_registration"));
    }
    if let Some(previous) = previous {
        if body.sequence <= previous.sequence as u64 {
            return Err(Error("revocations_sequence_not_monotonic"));
        }
        if body.issued_at < previous.issued_at as u64 {
            return Err(Error("revocations_clock_rollback"));
        }
    }
    let next = security_entries(body);
    if security
        .iter()
        .any(|(hash, time)| next.get(hash) != Some(time))
    {
        return Err(Error("security_revocations_cannot_be_removed_or_changed"));
    }
    Ok(RevocationsState {
        sequence: body.sequence as i64,
        issued_at: body.issued_at as i64,
        body_digest: record.body_digest.clone(),
        document_json: protocol::encode(body)?,
        operation_id: record.operation_id.clone(),
    })
}

fn parse_revocations(state: &RevocationsState) -> Result<Revocations> {
    let body: Revocations = protocol::parse(state.document_json.as_bytes())?;
    body.canonical_bytes()
        .map_err(|_| Error("stored_revocations_invalid"))?;
    if body.sequence != state.sequence as u64
        || body.issued_at != state.issued_at as u64
        || protocol::hash(
            &body
                .canonical_bytes()
                .map_err(|_| Error("stored_revocations_invalid"))?,
        ) != state.body_digest
    {
        return Err(Error("stored_revocations_mismatch"));
    }
    Ok(body)
}

fn security_entries(body: &Revocations) -> BTreeMap<String, u64> {
    body.entries
        .iter()
        .filter(|entry| entry.reason == RevocationReason::Security)
        .map(|entry| (entry.package_hash.clone(), entry.effective_at))
        .collect()
}

fn check_capacity(previous: Option<&RevocationsState>) -> Result<()> {
    let Some(previous) = previous else {
        return Ok(());
    };
    let mut body = parse_revocations(previous)?;
    let hashes: BTreeSet<_> = body
        .entries
        .iter()
        .map(|entry| entry.package_hash.as_str())
        .collect();
    let extra = (0..=hashes.len())
        .map(|n| format!("{n:064x}"))
        .find(|hash| !hashes.contains(hash.as_str()))
        .ok_or(Error("revocations_capacity_exhausted"))?;
    body.entries.push(RevocationEntry {
        package_hash: extra,
        reason: RevocationReason::Security,
        effective_at: MAX_SAFE_INTEGER,
    });
    Keys::check_envelope_size(&Document::Revocations(body))
        .map_err(|_| Error("revocations_capacity_exhausted"))
}
