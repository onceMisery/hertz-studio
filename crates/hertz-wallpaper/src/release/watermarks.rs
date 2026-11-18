// SPDX-License-Identifier: MIT
//! Pure decisions for the independent trust store. An update is not persisted
//! acceptance: callers must commit it in their trust transaction before activation.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{
    invalid, validate_hash, validate_positive_integer, validate_uuid, RevocationReason,
    VerifiedRelease, VerifiedRevocations, MAX_REVOCATIONS_BYTES,
};
use crate::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Stable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseWatermark {
    pub source_id: String,
    pub hub_id: String,
    pub work_id: String,
    pub channel: Channel,
    pub version: u64,
    pub package_hash: String,
    pub canonical_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevocationsWatermark {
    pub source_id: String,
    pub hub_id: String,
    pub sequence: u64,
    pub canonical_digest: String,
    pub issued_at: u64,
    pub security: BTreeMap<String, u64>,
}

pub enum Update<T> {
    Replay,
    Advance(T),
}

impl ReleaseWatermark {
    pub fn validate(&self) -> Result<()> {
        validate_uuid(&self.source_id)?;
        validate_uuid(&self.hub_id)?;
        validate_uuid(&self.work_id)?;
        validate_positive_integer(self.version)?;
        validate_hash(&self.package_hash)?;
        validate_hash(&self.canonical_digest)
    }
}

impl RevocationsWatermark {
    pub fn validate(&self) -> Result<()> {
        validate_uuid(&self.source_id)?;
        validate_uuid(&self.hub_id)?;
        validate_positive_integer(self.sequence)?;
        validate_positive_integer(self.issued_at)?;
        validate_hash(&self.canonical_digest)?;
        if self.security.len() > MAX_REVOCATIONS_BYTES / 64 {
            return Err(invalid(
                "revocations_too_large",
                "完整安全撤销记录超出协议上限",
            ));
        }
        for (hash, effective_at) in &self.security {
            validate_hash(hash)?;
            validate_positive_integer(*effective_at)?;
        }
        Ok(())
    }
}

/// source_id comes from the caller's root/origin trust record, never from a
/// community response. A lower version cannot become an automatic candidate;
/// explicit rollback of already installed content follows a separate owner.
pub fn release_update(
    previous: Option<&ReleaseWatermark>,
    source_id: &str,
    document: &VerifiedRelease,
) -> Result<Update<ReleaseWatermark>> {
    validate_uuid(source_id)?;
    let body = document.body();
    if let Some(previous) = previous {
        previous.validate()?;
        if previous.source_id != source_id
            || previous.hub_id != body.hub_id
            || previous.work_id != body.work_id
        {
            return Err(invalid(
                "release_source_mismatch",
                "发布水位与受信来源或作品不匹配",
            ));
        }
        if body.version < previous.version {
            return Err(invalid(
                "release_version_rollback",
                "发布版本低于已保存安全水位",
            ));
        }
        if body.version == previous.version {
            if previous.package_hash == body.package_hash
                && previous.canonical_digest == document.canonical_digest()
            {
                return Ok(Update::Replay);
            }
            return Err(invalid(
                "release_version_conflict",
                "同一发布版本不能更换包或签名正文",
            ));
        }
    }
    Ok(Update::Advance(ReleaseWatermark {
        source_id: source_id.to_owned(),
        hub_id: body.hub_id.clone(),
        work_id: body.work_id.clone(),
        channel: Channel::Stable,
        version: body.version,
        package_hash: body.package_hash.clone(),
        canonical_digest: document.canonical_digest().to_owned(),
    }))
}

/// A correctly signed expired snapshot can still add known security hashes.
/// Freshness is a separate prerequisite for activating any new community Web
/// hash. Neither replay nor an Advance value grants activation permission.
pub fn revocations_update(
    previous: Option<&RevocationsWatermark>,
    source_id: &str,
    document: &VerifiedRevocations,
) -> Result<Update<RevocationsWatermark>> {
    validate_uuid(source_id)?;
    let body = document.body();
    if let Some(previous) = previous {
        previous.validate()?;
        if previous.source_id != source_id || previous.hub_id != body.hub_id {
            return Err(invalid(
                "release_source_mismatch",
                "撤销水位与受信来源不匹配",
            ));
        }
        if body.sequence < previous.sequence {
            return Err(invalid(
                "revocations_sequence_rollback",
                "撤销序号低于已保存安全水位",
            ));
        }
        if body.sequence == previous.sequence {
            if previous.canonical_digest == document.canonical_digest() {
                return Ok(Update::Replay);
            }
            return Err(invalid(
                "revocations_sequence_conflict",
                "同一撤销序号不能更换正文",
            ));
        }
        if body.issued_at < previous.issued_at {
            return Err(invalid(
                "revocations_clock_rollback",
                "撤销签发时间低于已保存可信水位",
            ));
        }
    }
    let security: BTreeMap<_, _> = body
        .entries
        .iter()
        .filter(|entry| entry.reason == RevocationReason::Security)
        .map(|entry| (entry.package_hash.clone(), entry.effective_at))
        .collect();
    if let Some(previous) = previous {
        // An omission, downgrade to copyright or postponed effective time must
        // not remove a known security restriction from the full v1 snapshot.
        for (hash, effective_at) in &previous.security {
            if security.get(hash) != Some(effective_at) {
                return Err(invalid(
                    "security_revocation_removed",
                    "完整安全撤销记录不能删除或更改",
                ));
            }
        }
    }
    Ok(Update::Advance(RevocationsWatermark {
        source_id: source_id.to_owned(),
        hub_id: body.hub_id.clone(),
        sequence: body.sequence,
        canonical_digest: document.canonical_digest().to_owned(),
        issued_at: body.issued_at,
        security,
    }))
}
