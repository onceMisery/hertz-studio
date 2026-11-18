// SPDX-License-Identifier: MIT
//! Offline root authorizations. Parsing a chain never creates trust: its first
//! root must match an independently confirmed pin, including on every rotation.

use std::collections::{BTreeMap, BTreeSet};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

use super::{
    canonical, digest, domain_message, invalid, validate_hash, validate_key_id,
    validate_positive_integer, validate_uuid, validate_wire, KeyPurpose, VerificationKey,
};
use crate::Result;

pub const MAX_AUTHORIZATION_BYTES: usize = 256 * 1024;
pub const MAX_KEY_GENERATIONS: usize = 128;
const AUTHORIZATION_DOMAIN: &[u8] = b"HERTZ-WALLPAPER-KEY-AUTHORIZATION-V1\n";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicKey {
    pub key_id: String,
    /// Exactly 32 Ed25519 bytes in canonical, unpadded base64url.
    pub public_key: String,
}

impl PublicKey {
    pub fn from_bytes(key_id: String, bytes: &[u8; 32]) -> Result<Self> {
        let key = Self {
            key_id,
            public_key: URL_SAFE_NO_PAD.encode(bytes),
        };
        key.bytes()?;
        Ok(key)
    }

    pub fn bytes(&self) -> Result<[u8; 32]> {
        validate_key_id(&self.key_id)?;
        if self.public_key.len() != 43 {
            return Err(invalid(
                "invalid_authorization_key",
                "授权公钥须为32字节base64url",
            ));
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(&self.public_key)
            .map_err(|_| invalid("invalid_authorization_key", "授权公钥编码无效"))?;
        if URL_SAFE_NO_PAD.encode(&bytes) != self.public_key {
            return Err(invalid("invalid_authorization_key", "授权公钥编码不规范"));
        }
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| invalid("invalid_authorization_key", "授权公钥长度无效"))?;
        let key = VerifyingKey::from_bytes(&bytes)
            .map_err(|_| invalid("invalid_authorization_key", "授权公钥无效"))?;
        if key.is_weak() {
            return Err(invalid("invalid_authorization_key", "授权公钥强度无效"));
        }
        Ok(bytes)
    }

    /// Display the complete fingerprint. Labels/origins never change this value.
    pub fn fingerprint(&self) -> Result<String> {
        Ok(digest(&self.bytes()?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkingKey {
    pub purpose: KeyPurpose,
    pub key: PublicKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyAuthorization {
    pub hub_id: String,
    pub generation: u64,
    pub previous_digest: Option<String>,
    pub root_key_id: String,
    /// One release key and one revocations key; never a root signing purpose.
    pub keys: [WorkingKey; 2],
    /// Cross-signed successor, used to verify the next generation's authorization.
    pub next_root: Option<PublicKey>,
}

impl KeyAuthorization {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        validate_wire(bytes, MAX_AUTHORIZATION_BYTES)?;
        let body: Self = serde_json::from_slice(bytes)
            .map_err(|_| invalid("invalid_key_authorization", "根授权字段无效"))?;
        body.validate()?;
        Ok(body)
    }

    pub fn validate(&self) -> Result<()> {
        validate_uuid(&self.hub_id)?;
        validate_positive_integer(self.generation)?;
        validate_key_id(&self.root_key_id)?;
        if self.generation > MAX_KEY_GENERATIONS as u64 {
            return Err(invalid(
                "authorization_chain_full",
                "密钥代际达到v1上限，须升级协议",
            ));
        }
        match (&self.previous_digest, self.generation) {
            (None, 1) => {}
            (Some(hash), generation) if generation > 1 => validate_hash(hash)?,
            _ => {
                return Err(invalid(
                    "invalid_authorization_predecessor",
                    "根授权前代摘要无效",
                ))
            }
        }
        let purposes: BTreeSet<_> = self.keys.iter().map(|key| key.purpose).collect();
        if purposes.len() != 2 {
            return Err(invalid(
                "authorization_purpose_conflict",
                "发布与撤销须各有一把独立工作密钥",
            ));
        }
        for working in &self.keys {
            working.key.bytes()?;
            if working.key.key_id == self.root_key_id {
                return Err(invalid("root_key_used_for_content", "根密钥只能签署授权链"));
            }
        }
        if self.keys[0].key.key_id == self.keys[1].key.key_id
            || self.keys[0].key.public_key == self.keys[1].key.public_key
        {
            return Err(invalid(
                "authorization_purpose_conflict",
                "密钥用途不能共用身份或公钥",
            ));
        }
        if let Some(root) = &self.next_root {
            root.bytes()?;
            if root.key_id == self.root_key_id
                || self.keys.iter().any(|key| {
                    key.key.key_id == root.key_id || key.key.public_key == root.public_key
                })
            {
                return Err(invalid(
                    "root_key_used_for_content",
                    "下一根密钥须具有独立身份与公钥",
                ));
            }
        }
        Ok(())
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        canonical(self, MAX_AUTHORIZATION_BYTES)
    }

    pub fn canonical_digest(&self) -> Result<String> {
        Ok(digest(&self.canonical_bytes()?))
    }

    pub fn signing_bytes(&self) -> Result<Vec<u8>> {
        Ok(domain_message(
            AUTHORIZATION_DOMAIN,
            self.canonical_bytes()?,
        ))
    }

    pub fn key(&self, purpose: KeyPurpose) -> Result<&PublicKey> {
        self.keys
            .iter()
            .find(|key| key.purpose == purpose)
            .map(|key| &key.key)
            .ok_or_else(|| {
                invalid(
                    "authorization_purpose_missing",
                    "根授权未包含所需工作密钥用途",
                )
            })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedKeyAuthorization {
    pub authorization: KeyAuthorization,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationChain {
    pub bootstrap_root: PublicKey,
    pub authorizations: Vec<SignedKeyAuthorization>,
}

/// Cannot deserialize an API root into this object. The native confirmation
/// owner or an offline operator supplies the independently retained fingerprint.
#[derive(Clone)]
pub struct RootPin {
    hub_id: String,
    root: PublicKey,
    fingerprint: String,
}

impl RootPin {
    pub fn confirm(hub_id: String, root: PublicKey, confirmed_fingerprint: &str) -> Result<Self> {
        validate_uuid(&hub_id)?;
        validate_hash(confirmed_fingerprint)?;
        let fingerprint = root.fingerprint()?;
        if fingerprint != confirmed_fingerprint {
            return Err(invalid(
                "root_fingerprint_mismatch",
                "根公钥与已确认的完整指纹不匹配",
            ));
        }
        Ok(Self {
            hub_id,
            root,
            fingerprint,
        })
    }
    pub fn hub_id(&self) -> &str {
        &self.hub_id
    }
    pub fn root(&self) -> &PublicKey {
        &self.root
    }
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationWatermark {
    pub hub_id: String,
    pub root_fingerprint: String,
    pub generation: u64,
    pub canonical_digest: String,
}

impl AuthorizationWatermark {
    pub fn validate(&self) -> Result<()> {
        validate_uuid(&self.hub_id)?;
        validate_hash(&self.root_fingerprint)?;
        validate_hash(&self.canonical_digest)?;
        validate_positive_integer(self.generation)?;
        if self.generation > MAX_KEY_GENERATIONS as u64 {
            return Err(invalid("authorization_chain_full", "密钥代际超出v1上限"));
        }
        Ok(())
    }
}

pub struct VerifiedAuthorizationChain {
    chain: AuthorizationChain,
    pin: RootPin,
    watermark: AuthorizationWatermark,
    current_root: PublicKey,
}

impl AuthorizationChain {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        validate_wire(bytes, MAX_AUTHORIZATION_BYTES)?;
        let chain: Self = serde_json::from_slice(bytes)
            .map_err(|_| invalid("invalid_authorization_chain", "根授权链字段无效"))?;
        chain.check_bounds()?;
        Ok(chain)
    }

    fn check_bounds(&self) -> Result<()> {
        if self.authorizations.is_empty() || self.authorizations.len() > MAX_KEY_GENERATIONS {
            return Err(invalid(
                "authorization_chain_full",
                "根授权链须含1至128个完整代际",
            ));
        }
        self.bootstrap_root.bytes()?;
        for authorization in &self.authorizations {
            authorization.authorization.validate()?;
        }
        canonical(self, MAX_AUTHORIZATION_BYTES)?;
        Ok(())
    }

    pub fn verify(
        self,
        pin: &RootPin,
        previous: Option<&AuthorizationWatermark>,
    ) -> Result<VerifiedAuthorizationChain> {
        self.check_bounds()?;
        if self.bootstrap_root != *pin.root() {
            return Err(invalid(
                "root_replacement_rejected",
                "社区响应不能替换已确认的根公钥",
            ));
        }
        let mut root = pin.root().clone();
        let mut roots = BTreeMap::from([(root.key_id.clone(), root.public_key.clone())]);
        let mut working_ids: BTreeMap<String, (KeyPurpose, String)> = BTreeMap::new();
        let mut working_bytes: BTreeMap<String, KeyPurpose> = BTreeMap::new();
        let mut predecessor = None;
        for (index, signed) in self.authorizations.iter().enumerate() {
            let body = &signed.authorization;
            if body.hub_id != pin.hub_id()
                || body.generation != index as u64 + 1
                || body.previous_digest != predecessor
                || body.root_key_id != root.key_id
            {
                return Err(invalid(
                    "authorization_chain_discontinuous",
                    "根授权来源、代际或前代链不连续",
                ));
            }
            verify_root_signature(&root, &body.signing_bytes()?, &signed.signature)?;
            for working in &body.keys {
                if roots.contains_key(&working.key.key_id)
                    || roots.values().any(|bytes| bytes == &working.key.public_key)
                {
                    return Err(invalid(
                        "root_key_used_for_content",
                        "授权链根密钥不能转为工作密钥",
                    ));
                }
                if working_ids.get(&working.key.key_id).is_some_and(|prior| {
                    prior != &(working.purpose, working.key.public_key.clone())
                }) || working_bytes
                    .get(&working.key.public_key)
                    .is_some_and(|prior| *prior != working.purpose)
                {
                    return Err(invalid(
                        "authorization_key_rebound",
                        "历史密钥身份、公钥或用途不能重绑定",
                    ));
                }
                working_ids.insert(
                    working.key.key_id.clone(),
                    (working.purpose, working.key.public_key.clone()),
                );
                working_bytes.insert(working.key.public_key.clone(), working.purpose);
            }
            if let Some(next) = &body.next_root {
                if roots.contains_key(&next.key_id)
                    || roots.values().any(|bytes| bytes == &next.public_key)
                    || working_ids.contains_key(&next.key_id)
                    || working_bytes.contains_key(&next.public_key)
                {
                    return Err(invalid(
                        "authorization_root_rebound",
                        "根轮换须使用未作其它用途的新公钥身份",
                    ));
                }
                roots.insert(next.key_id.clone(), next.public_key.clone());
                root = next.clone();
            }
            predecessor = Some(body.canonical_digest()?);
        }
        let generation = self.authorizations.len() as u64;
        if let Some(previous) = previous {
            previous.validate()?;
            if previous.hub_id != pin.hub_id() || previous.root_fingerprint != pin.fingerprint() {
                return Err(invalid(
                    "authorization_source_mismatch",
                    "密钥水位与已确认来源不匹配",
                ));
            }
            if generation < previous.generation {
                return Err(invalid(
                    "authorization_generation_rollback",
                    "根授权代际低于已保存安全水位",
                ));
            }
            let prior = &self.authorizations[previous.generation as usize - 1].authorization;
            if prior.canonical_digest()? != previous.canonical_digest {
                return Err(invalid(
                    "authorization_generation_conflict",
                    "已接受的根授权代际不能更换正文",
                ));
            }
        }
        let watermark = AuthorizationWatermark {
            hub_id: pin.hub_id().to_owned(),
            root_fingerprint: pin.fingerprint().to_owned(),
            generation,
            canonical_digest: predecessor.expect("nonempty validated authorization chain"),
        };
        Ok(VerifiedAuthorizationChain {
            chain: self,
            pin: pin.clone(),
            watermark,
            current_root: root,
        })
    }
}

impl VerifiedAuthorizationChain {
    pub fn chain(&self) -> &AuthorizationChain {
        &self.chain
    }
    pub fn pin(&self) -> &RootPin {
        &self.pin
    }
    pub fn watermark(&self) -> &AuthorizationWatermark {
        &self.watermark
    }
    pub fn current_root(&self) -> &PublicKey {
        &self.current_root
    }
    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        canonical(&self.chain, MAX_AUTHORIZATION_BYTES)
    }

    pub fn generation(&self, generation: u64) -> Result<&KeyAuthorization> {
        if generation == 0 || generation > self.watermark.generation {
            return Err(invalid(
                "authorization_generation_missing",
                "所需工作密钥代际不在已验证链中",
            ));
        }
        Ok(&self.chain.authorizations[generation as usize - 1].authorization)
    }

    pub fn latest_key(&self, purpose: KeyPurpose) -> Result<VerificationKey> {
        self.key_at(self.watermark.generation, purpose)
    }

    pub fn key_at(&self, generation: u64, purpose: KeyPurpose) -> Result<VerificationKey> {
        let key = self.generation(generation)?.key(purpose)?;
        VerificationKey::from_authorized_key(key.key_id.clone(), purpose, &key.bytes()?)
    }

    /// Historical keys are for saved installed envelopes and checkpoint recovery.
    /// Network candidates must use latest_key to exclude retired working keys.
    pub fn historical_key(&self, key_id: &str, purpose: KeyPurpose) -> Result<VerificationKey> {
        for signed in self.chain.authorizations.iter().rev() {
            let key = signed.authorization.key(purpose)?;
            if key.key_id == key_id {
                return VerificationKey::from_authorized_key(
                    key.key_id.clone(),
                    purpose,
                    &key.bytes()?,
                );
            }
        }
        Err(invalid(
            "authorization_key_missing",
            "密钥不在该来源已验证的授权链中",
        ))
    }

    pub fn check_extension(&self, next: &KeyAuthorization) -> Result<()> {
        next.validate()?;
        if next.hub_id != self.pin.hub_id()
            || next.generation != self.watermark.generation + 1
            || next.previous_digest.as_deref() != Some(self.watermark.canonical_digest.as_str())
            || next.root_key_id != self.current_root.key_id
        {
            return Err(invalid(
                "authorization_extension_conflict",
                "新的离线授权须延续当前确切链尾与根",
            ));
        }
        Ok(())
    }
}

fn verify_root_signature(root: &PublicKey, message: &[u8], signature: &str) -> Result<()> {
    if signature.len() != 86 {
        return Err(invalid(
            "invalid_authorization_signature",
            "根授权签名编码长度无效",
        ));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| invalid("invalid_authorization_signature", "根授权签名须为base64url"))?;
    if bytes.len() != 64 || URL_SAFE_NO_PAD.encode(&bytes) != signature {
        return Err(invalid(
            "invalid_authorization_signature",
            "根授权签名编码不规范",
        ));
    }
    let signature = Signature::from_slice(&bytes)
        .map_err(|_| invalid("invalid_authorization_signature", "根授权签名无效"))?;
    VerifyingKey::from_bytes(&root.bytes()?)
        .map_err(|_| invalid("invalid_authorization_key", "根公钥无效"))?
        .verify_strict(message, &signature)
        .map_err(|_| invalid("authorization_signature_rejected", "离线根授权签名验证失败"))
}
