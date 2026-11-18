// SPDX-License-Identifier: MIT
use crate::{
    config::{text, Config},
    error::{HubError, Result},
    oidc_network,
};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub(crate) struct Identity {
    pub issuer: String,
    pub subject: String,
    pub scopes: BTreeSet<String>,
}
struct Cache {
    keys: Option<JwkSet>,
    expires: Instant,
    attempted: Option<Instant>,
}
pub(crate) struct Auth {
    config: Arc<Config>,
    cache: Mutex<Cache>,
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    jwks_uri: String,
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

impl Auth {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            config,
            cache: Mutex::new(Cache {
                keys: None,
                expires: Instant::now(),
                attempted: None,
            }),
        }
    }
    pub async fn authenticate(&self, token: &str) -> Result<Identity> {
        if token.len() > 16_384 || token.split('.').count() != 3 {
            return Err(HubError::unauthorized());
        }
        let header = decode_header(token).map_err(|_| HubError::unauthorized())?;
        let algorithm = match header.alg {
            Algorithm::RS256
                if self
                    .config
                    .allowed_signing_algorithms
                    .iter()
                    .any(|alg| alg == "RS256") =>
            {
                Algorithm::RS256
            }
            Algorithm::ES256
                if self
                    .config
                    .allowed_signing_algorithms
                    .iter()
                    .any(|alg| alg == "ES256") =>
            {
                Algorithm::ES256
            }
            _ => return Err(HubError::unauthorized()),
        };
        if header
            .typ
            .as_deref()
            .is_some_and(|typ| !matches!(typ, "JWT" | "at+jwt" | "application/at+jwt"))
        {
            return Err(HubError::unauthorized());
        }
        let kid = header.kid.as_deref().ok_or_else(HubError::unauthorized)?;
        text(kid, 128).map_err(|_| HubError::unauthorized())?;
        let key = {
            let mut cache = self.cache.lock().await;
            let now = Instant::now();
            if now >= cache.expires
                || cache
                    .keys
                    .as_ref()
                    .and_then(|keys| keys.find(kid))
                    .is_none()
            {
                if cache
                    .attempted
                    .is_some_and(|last| now.duration_since(last) < Duration::from_secs(30))
                {
                    return Err(HubError::unauthorized());
                }
                cache.attempted = Some(now);
                let discovery: Discovery = serde_json::from_slice(
                    &oidc_network::fetch(
                        &self.config,
                        &format!(
                            "{}/.well-known/openid-configuration",
                            self.config.issuer.trim_end_matches('/')
                        ),
                    )
                    .await?,
                )
                .map_err(|_| HubError::unavailable())?;
                if discovery.issuer != self.config.issuer {
                    return Err(HubError::unavailable());
                }
                let keys: JwkSet = serde_json::from_slice(
                    &oidc_network::fetch(&self.config, &discovery.jwks_uri).await?,
                )
                .map_err(|_| HubError::unavailable())?;
                if keys.keys.is_empty() || keys.keys.len() > 64 {
                    return Err(HubError::unavailable());
                }
                let mut ids = BTreeSet::new();
                for key in &keys.keys {
                    let id = key
                        .common
                        .key_id
                        .as_deref()
                        .ok_or_else(HubError::unavailable)?;
                    if id.len() > 128 || !ids.insert(id.to_owned()) {
                        return Err(HubError::unavailable());
                    }
                }
                cache.keys = Some(keys);
                cache.expires = Instant::now() + Duration::from_secs(3600);
            }
            let jwk = cache
                .keys
                .as_ref()
                .and_then(|keys| keys.find(kid))
                .ok_or_else(HubError::unauthorized)?;
            // Bind key type/curve, declared algorithm, use and operations; never
            // reinterpret the same JWK as a different JWT algorithm.
            let value = serde_json::to_value(jwk).map_err(|_| HubError::unauthorized())?;
            let expected = if algorithm == Algorithm::RS256 {
                "RS256"
            } else {
                "ES256"
            };
            if value["alg"].as_str().is_some_and(|alg| alg != expected)
                || value["use"].as_str().is_some_and(|usage| usage != "sig")
                || value["key_ops"]
                    .as_array()
                    .is_some_and(|ops| !ops.iter().any(|op| op.as_str() == Some("verify")))
                || (algorithm == Algorithm::RS256 && value["kty"] != "RSA")
                || (algorithm == Algorithm::ES256
                    && (value["kty"] != "EC" || value["crv"] != "P-256"))
            {
                return Err(HubError::unauthorized());
            }
            DecodingKey::from_jwk(jwk).map_err(|_| HubError::unauthorized())?
        };
        let mut validation = Validation::new(algorithm);
        validation.set_issuer(&[self.config.issuer.as_str()]);
        validation.set_audience(&[self.config.api_audience.as_str()]);
        validation.set_required_spec_claims(&["iss", "sub", "aud", "exp", "nbf"]);
        validation.validate_nbf = true;
        validation.leeway = self.config.clock_leeway_seconds;
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|_| HubError::unauthorized())?
            .claims;
        // Require an explicit access-token discriminator. An ID token with
        // a generic JWT typ is not sufficient even if misissued to this aud.
        let access_type = matches!(header.typ.as_deref(), Some("at+jwt" | "application/at+jwt"))
            || claims.token_use.as_deref() == Some("access");
        let audience_matches = claims.aud.as_str() == Some(self.config.api_audience.as_str())
            || claims.aud.as_array().is_some_and(|items| {
                items.len() == 1 && items[0].as_str() == Some(self.config.api_audience.as_str())
            });
        if !access_type
            || !audience_matches
            || claims.nbf >= claims.exp
            || claims.nonce.is_some()
            || claims
                .token_use
                .as_deref()
                .is_some_and(|usage| usage != "access")
            || claims.scope.len() > 4096
        {
            return Err(HubError::unauthorized());
        }
        text(&claims.sub, 255).map_err(|_| HubError::unauthorized())?;
        let scopes: BTreeSet<String> = claims
            .scope
            .split_ascii_whitespace()
            .map(str::to_owned)
            .collect();
        if scopes.len() > 32 || scopes.iter().any(|scope| scope.len() > 128) {
            return Err(HubError::unauthorized());
        }
        Ok(Identity {
            issuer: claims.iss,
            subject: claims.sub,
            scopes,
        })
    }
}
