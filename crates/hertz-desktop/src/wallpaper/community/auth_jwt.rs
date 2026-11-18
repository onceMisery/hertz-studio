// SPDX-License-Identifier: MIT
use super::super::{contract, error, model::SourceProfile, network, now};
use crate::wallpaper::jobs::JobError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};

#[derive(Deserialize)]
pub(super) struct Discovery {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub jwks_uri: String,
    #[serde(default)]
    pub code_challenge_methods_supported: Vec<String>,
}

pub(super) async fn discovery(profile: &SourceProfile) -> Result<Discovery, JobError> {
    let bytes = network::get(
        &format!(
            "{}/.well-known/openid-configuration",
            profile.auth.issuer.trim_end_matches('/')
        ),
        65536,
    )
    .await?;
    let value: Discovery =
        serde_json::from_slice(&bytes).map_err(|_| error("oidc_discovery", "OIDC 发现响应无效"))?;
    let origin = network::https(&profile.auth.issuer)?.origin();
    if value.issuer != profile.auth.issuer
        || [
            &value.authorization_endpoint,
            &value.token_endpoint,
            &value.jwks_uri,
        ]
        .iter()
        .any(|s| {
            network::https(s)
                .map(|u| u.origin() != origin)
                .unwrap_or(true)
        })
        || !value
            .code_challenge_methods_supported
            .iter()
            .any(|m| m == "S256")
    {
        return Err(error(
            "oidc_discovery",
            "OIDC issuer、端点或 PKCE S256 不匹配",
        ));
    }
    Ok(value)
}

#[derive(Deserialize)]
struct Claims {
    iss: String,
    sub: String,
    exp: u64,
    nbf: u64,
    scope: String,
    aud: serde_json::Value,
    #[serde(default)]
    token_use: Option<String>,
    #[serde(default)]
    nonce: Option<String>,
}
struct KeyCache {
    keys: JwkSet,
    expires: Instant,
    attempted: Instant,
}
#[derive(Default)]
pub(super) struct Verifier {
    cache: tokio::sync::Mutex<BTreeMap<String, KeyCache>>,
}

pub(super) struct Identity {
    pub subject: String,
    pub expires: u64,
}

impl Verifier {
    pub(super) async fn verify(
        &self,
        profile: &SourceProfile,
        token: &str,
    ) -> Result<Identity, JobError> {
        if token.len() > 16384 || token.split('.').count() != 3 {
            return Err(error("access_token_invalid", "API 需要 JWT access token"));
        }
        for (index, segment) in token.split('.').take(2).enumerate() {
            let bytes = URL_SAFE_NO_PAD
                .decode(segment)
                .map_err(|_| error("access_token_invalid", "JWT 编码无效"))?;
            if bytes.len() > if index == 0 { 2048 } else { 16384 } {
                return Err(error("access_token_invalid", "JWT 字段超过上限"));
            }
            hertz_wallpaper::json::check_bounded_json(&bytes, 12).map_err(contract)?;
        }
        let header = jsonwebtoken::decode_header(token)
            .map_err(|_| error("access_token_invalid", "JWT header 无效"))?;
        let algorithm = match header.alg {
            Algorithm::RS256 if profile.auth.algorithms.iter().any(|a| a == "RS256") => {
                Algorithm::RS256
            }
            Algorithm::ES256 if profile.auth.algorithms.iter().any(|a| a == "ES256") => {
                Algorithm::ES256
            }
            _ => return Err(error("access_token_invalid", "JWT 算法未授权")),
        };
        let kid = header
            .kid
            .as_deref()
            .filter(|k| !k.is_empty() && k.len() <= 128)
            .ok_or_else(|| error("access_token_invalid", "JWT 缺少有界 kid"))?;
        let key = {
            let mut cache = self.cache.lock().await;
            let time = Instant::now();
            let refresh = cache
                .get(&profile.source_id)
                .is_none_or(|c| time >= c.expires || c.keys.find(kid).is_none());
            if refresh {
                if cache
                    .get(&profile.source_id)
                    .is_some_and(|c| time.duration_since(c.attempted) < Duration::from_secs(30))
                {
                    return Err(error("jwks_refresh_limited", "未知 kid 刷新正在限速"));
                }
                // Record an attempt even when discovery/networking fails.
                let attempted =
                    cache
                        .entry(profile.source_id.clone())
                        .or_insert_with(|| KeyCache {
                            keys: JwkSet { keys: Vec::new() },
                            expires: time,
                            attempted: time - Duration::from_secs(30),
                        });
                attempted.attempted = time;
                let discovery = discovery(profile).await?;
                let bytes = network::get(&discovery.jwks_uri, 65536).await?;
                let keys: JwkSet = serde_json::from_slice(&bytes)
                    .map_err(|_| error("jwks_invalid", "JWKS 响应无效"))?;
                if keys.keys.is_empty() || keys.keys.len() > 64 {
                    return Err(error("jwks_invalid", "JWKS 密钥数量无效"));
                }
                let mut ids = BTreeSet::new();
                for key in &keys.keys {
                    let id = key
                        .common
                        .key_id
                        .as_deref()
                        .filter(|k| !k.is_empty() && k.len() <= 128)
                        .ok_or_else(|| error("jwks_invalid", "JWKS kid 无效"))?;
                    if !ids.insert(id.to_owned()) {
                        return Err(error("jwks_invalid", "JWKS kid 重复"));
                    }
                }
                cache.insert(
                    profile.source_id.clone(),
                    KeyCache {
                        keys,
                        expires: time + Duration::from_secs(3600),
                        attempted: time,
                    },
                );
            }
            let jwk = cache
                .get(&profile.source_id)
                .and_then(|c| c.keys.find(kid))
                .ok_or_else(|| error("access_token_invalid", "JWT kid 未知"))?;
            let value =
                serde_json::to_value(jwk).map_err(|_| error("jwks_invalid", "JWKS 编码无效"))?;
            let expected = if algorithm == Algorithm::RS256 {
                "RS256"
            } else {
                "ES256"
            };
            if value["alg"].as_str().is_some_and(|a| a != expected)
                || value["use"].as_str().is_some_and(|u| u != "sig")
                || value["key_ops"]
                    .as_array()
                    .is_some_and(|ops| ops.len() != 1 || ops[0] != "verify")
                || if algorithm == Algorithm::RS256 {
                    value["kty"] != "RSA"
                } else {
                    value["kty"] != "EC" || value["crv"] != "P-256"
                }
            {
                return Err(error("jwks_invalid", "JWKS 类型、用途或曲线不匹配"));
            }
            DecodingKey::from_jwk(jwk)
                .map_err(|_| error("jwks_invalid", "JWKS 无法构造验证密钥"))?
        };
        let mut validation = Validation::new(algorithm);
        validation.set_issuer(&[profile.auth.issuer.as_str()]);
        validation.set_audience(&[profile.auth.audience.as_str()]);
        validation.set_required_spec_claims(&["iss", "sub", "aud", "exp", "nbf"]);
        validation.validate_nbf = true;
        validation.leeway = 0;
        let claims = jsonwebtoken::decode::<Claims>(token, &key, &validation)
            .map_err(|_| error("access_token_invalid", "JWT access token 验证失败"))?
            .claims;
        let audience = claims.aud.as_str() == Some(profile.auth.audience.as_str())
            || claims.aud.as_array().is_some_and(|a| {
                a.len() == 1 && a[0].as_str() == Some(profile.auth.audience.as_str())
            });
        let access = matches!(header.typ.as_deref(), Some("at+jwt" | "application/at+jwt"))
            || claims.token_use.as_deref() == Some("access");
        let scopes: BTreeSet<_> = claims.scope.split_ascii_whitespace().collect();
        if claims.iss != profile.auth.issuer
            || !audience
            || !access
            || claims.nonce.is_some()
            || claims.token_use.as_deref().is_some_and(|u| u != "access")
            || claims.nbf >= claims.exp
            || claims.exp <= now()
            || claims.exp > hertz_wallpaper::release::MAX_SAFE_INTEGER
            || claims.sub.is_empty()
            || claims.sub.len() > 255
            || claims.sub.chars().any(char::is_control)
            || claims.scope.len() > 4096
            || scopes.len() > 32
            || !profile
                .auth
                .scopes
                .iter()
                .filter(|s| !matches!(s.as_str(), "openid" | "profile" | "offline_access"))
                .all(|s| scopes.contains(s.as_str()))
        {
            return Err(error(
                "access_token_invalid",
                "JWT 用途、主体、audience、时间或 scope 不匹配",
            ));
        }
        Ok(Identity {
            subject: claims.sub,
            expires: claims.exp,
        })
    }
}
