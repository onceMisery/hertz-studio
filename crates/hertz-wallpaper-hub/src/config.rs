// SPDX-License-Identifier: MIT
use crate::error::{HubError, Result};
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Subject {
    pub issuer: String,
    pub sub: String,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Config {
    pub hub_id: String,
    pub public_origin: String,
    pub listen: SocketAddr,
    pub issuer: String,
    pub desktop_client_id: String,
    pub api_audience: String,
    pub scopes: Vec<String>,
    pub allowed_signing_algorithms: Vec<String>,
    pub database_path: PathBuf,
    pub content_directory: PathBuf,
    pub trusted_proxies: Vec<IpAddr>,
    pub signer_endpoint: String,
    pub signer_service_identity: String,
    pub signer_ledger_id: String,
    pub authorization_chain_file: PathBuf,
    pub root_fingerprint: String,
    pub release_key_id: String,
    pub revocations_key_id: String,
    pub administrators: Vec<Subject>,
    #[serde(default)]
    pub oidc_fixed_addresses: Vec<IpAddr>,
    #[serde(default)]
    pub clock_leeway_seconds: u64,
}

impl Config {
    pub fn validate(&self) -> Result<()> {
        canonical_id(&self.hub_id)?;
        let origin = https_url(&self.public_origin)?;
        if origin.path() != "/"
            || origin.as_str().trim_end_matches('/') != self.public_origin.trim_end_matches('/')
        {
            return Err(HubError::invalid("社区地址须为明确的 HTTPS origin"));
        }
        https_url(&self.issuer)?;
        text(&self.desktop_client_id, 255)?;
        text(&self.api_audience, 255)?;
        if self.desktop_client_id == self.api_audience || self.clock_leeway_seconds > 60 {
            return Err(HubError::invalid(
                "API audience须独立于桌面clientId，时钟容忍不能超过60秒",
            ));
        }
        let scopes: BTreeSet<_> = self.scopes.iter().map(String::as_str).collect();
        if self.scopes.len() > 32
            || scopes.len() != self.scopes.len()
            || !["openid", "profile", "wallpaper.read", "wallpaper.write"]
                .iter()
                .all(|scope| scopes.contains(scope))
        {
            return Err(HubError::invalid("部署须显式注册社区读写和OIDC scopes"));
        }
        for scope in &self.scopes {
            text(scope, 128)?;
            if scope.contains(char::is_whitespace) {
                return Err(HubError::invalid("scope不能含空白"));
            }
        }
        if self.allowed_signing_algorithms.is_empty()
            || self.allowed_signing_algorithms.len() > 2
            || self
                .allowed_signing_algorithms
                .iter()
                .any(|alg| !matches!(alg.as_str(), "RS256" | "ES256"))
        {
            return Err(HubError::invalid("JWT算法只允许显式配置RS256/ES256"));
        }
        if !self.database_path.is_absolute()
            || !self.content_directory.is_absolute()
            || !self.authorization_chain_file.is_absolute()
            || self
                .database_path
                .extension()
                .is_none_or(|extension| extension != "db")
            || self.database_path.starts_with(&self.content_directory)
            || self.trusted_proxies.is_empty()
            || self.trusted_proxies.len() > 16
            || self.administrators.is_empty()
            || self.administrators.len() > 32
            || self.oidc_fixed_addresses.len() > 16
        {
            return Err(HubError::invalid(
                "需明确独立数据库、隔离内容目录、Signer入口、代理及管理员",
            ));
        }
        if self.listen.port() == 0
            || self
                .trusted_proxies
                .iter()
                .any(|ip| ip.is_unspecified() || ip.is_multicast())
            || self
                .oidc_fixed_addresses
                .iter()
                .any(|ip| ip.is_unspecified() || ip.is_multicast())
        {
            return Err(HubError::invalid(
                "监听端口与固定代理/OIDC地址须明确且为单播地址",
            ));
        }
        text(&self.release_key_id, 128)?;
        text(&self.revocations_key_id, 128)?;
        canonical_id(&self.signer_ledger_id)?;
        if !hertz_wallpaper::valid_sha256_hex(&self.root_fingerprint)
            || self.release_key_id == self.revocations_key_id
        {
            return Err(HubError::invalid("须配置完整根指纹与独立用途的工作密钥"));
        }
        hertz_wallpaper_signer::client::HubClient::new(
            self.signer_endpoint.clone(),
            self.signer_service_identity.clone(),
        )
        .map_err(|_| HubError::invalid("须配置本机Signer端点和规范服务SID/UID"))?;
        if !self
            .release_key_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        {
            return Err(HubError::invalid("发布keyId无效"));
        }
        for administrator in &self.administrators {
            if administrator.issuer != self.issuer {
                return Err(HubError::invalid("管理员必须绑定本部署issuer"));
            }
            text(&administrator.sub, 255)?;
        }
        Ok(())
    }
}

pub(crate) fn https_url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value).map_err(|_| HubError::invalid("HTTPS地址无效"))?;
    if value.len() > 2048
        || url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err(HubError::invalid(
            "地址须为不含凭据、查询或片段的HTTPS 443地址",
        ));
    }
    Ok(url)
}

pub(crate) fn canonical_id(value: &str) -> Result<()> {
    if uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value) {
        Ok(())
    } else {
        Err(HubError::invalid("身份须为规范小写UUID"))
    }
}
pub(crate) fn text(value: &str, limit: usize) -> Result<()> {
    if value.trim().is_empty()
        || value.chars().count() > limit
        || value.chars().any(char::is_control)
    {
        Err(HubError::invalid("字段为空、过长或包含控制字符"))
    } else {
        Ok(())
    }
}
