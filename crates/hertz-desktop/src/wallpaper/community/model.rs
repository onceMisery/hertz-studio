// SPDX-License-Identifier: MIT
use super::{error, network::canonical_origin};
use crate::wallpaper::jobs::JobError;
use serde::{Deserialize, Serialize};

pub(crate) const MAX_SOURCES: usize = 16;
pub(crate) const MAX_RECEIPTS: usize = 8192;
pub(crate) const MAX_SECURITY_HASHES: usize = 65536;
pub(crate) const MAX_SUBSCRIPTIONS: usize = 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AuthProfile {
    pub issuer: String,
    pub client_id: String,
    pub audience: String,
    pub scopes: Vec<String>,
    pub algorithms: Vec<String>,
}

impl AuthProfile {
    pub(crate) fn validate(&self) -> Result<(), JobError> {
        let issuer = reqwest::Url::parse(&self.issuer)
            .map_err(|_| error("invalid_issuer", "OIDC issuer 无效"))?;
        if issuer.scheme() != "https"
            || issuer.host_str().is_none()
            || !issuer.username().is_empty()
            || issuer.password().is_some()
            || issuer.query().is_some()
            || issuer.fragment().is_some()
            || self.issuer.len() > 2048
            || self.client_id.is_empty()
            || self.client_id.len() > 256
            || self.audience.is_empty()
            || self.audience.len() > 256
            || self.audience == self.client_id
            || self.scopes.is_empty()
            || self.scopes.len() > 16
            || self.scopes.iter().any(|s| {
                s.is_empty()
                    || s.len() > 128
                    || s.chars().any(|c| c.is_whitespace() || c.is_control())
            })
            || ["openid", "profile", "wallpaper.read", "wallpaper.write"]
                .iter()
                .any(|scope| !self.scopes.iter().any(|s| s == scope))
            || self
                .scopes
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.scopes.len()
            || self.algorithms.is_empty()
            || self.algorithms.len() > 2
            || self
                .algorithms
                .iter()
                .any(|a| !matches!(a.as_str(), "RS256" | "ES256"))
        {
            return Err(error(
                "invalid_auth_profile",
                "来源的认证配置不符合社区合同",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SourceProfile {
    pub source_id: String,
    pub origin: String,
    pub hub_id: String,
    pub root_fingerprint: String,
    pub auth: AuthProfile,
}

impl SourceProfile {
    pub(crate) fn validate(&self) -> Result<(), JobError> {
        for id in [&self.source_id, &self.hub_id] {
            if uuid::Uuid::parse_str(id)
                .map(|v| v.to_string() != *id)
                .unwrap_or(true)
            {
                return Err(error("invalid_source", "来源身份必须是规范 UUID"));
            }
        }
        if canonical_origin(&self.origin)? != self.origin
            || self.root_fingerprint.len() != 64
            || !self
                .root_fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(error("invalid_source", "来源 origin 或全根指纹无效"));
        }
        self.auth.validate()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceStatus {
    pub profile: SourceProfile,
    pub key_generation: u64,
    pub last_sync: u64,
    pub revocations_fresh: bool,
    pub clock_rollback: bool,
}
