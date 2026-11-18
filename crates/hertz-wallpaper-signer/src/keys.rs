// SPDX-License-Identifier: MIT
use std::{fs::File, io::Read};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use hertz_wallpaper::release::{
    authorization::{
        AuthorizationChain, RootPin, VerifiedAuthorizationChain, MAX_AUTHORIZATION_BYTES,
    },
    KeyPurpose, SignedRelease, SignedRevocations, MAX_RELEASE_BYTES, MAX_REVOCATIONS_BYTES,
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::{
    config::{Config, KeyConfig},
    platform,
    protocol::{Document, Error, Result},
};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PublicKeys {
    pub release_key_id: String,
    pub release_public_key: String,
    pub revocations_key_id: String,
    pub revocations_public_key: String,
}

pub struct Keys {
    release: SigningKey,
    revocations: SigningKey,
    public: PublicKeys,
    authorization: VerifiedAuthorizationChain,
    _files: [File; 2],
}

impl Keys {
    pub fn load(config: &Config) -> Result<Self> {
        let (release, release_file) = load_seed(&config.release_key, &config.service_identity)?;
        let (revocations, revocations_file) =
            load_seed(&config.revocations_key, &config.service_identity)?;
        if release.verifying_key() == revocations.verifying_key() {
            return Err(Error("key_purposes_require_distinct_seeds"));
        }
        let public = PublicKeys {
            release_key_id: config.release_key.key_id.clone(),
            release_public_key: URL_SAFE_NO_PAD.encode(release.verifying_key().as_bytes()),
            revocations_key_id: config.revocations_key.key_id.clone(),
            revocations_public_key: URL_SAFE_NO_PAD.encode(revocations.verifying_key().as_bytes()),
        };
        let chain = AuthorizationChain::parse(&platform::private_bytes(
            &config.authorization_chain_file,
            &config.service_identity,
            MAX_AUTHORIZATION_BYTES,
        )?)
        .map_err(|_| Error("invalid_root_authorization_chain"))?;
        let pin = RootPin::confirm(
            config.hub_id.clone(),
            chain.bootstrap_root.clone(),
            &config.root_fingerprint,
        )
        .map_err(|_| Error("root_fingerprint_mismatch"))?;
        let authorization = chain
            .verify(&pin, None)
            .map_err(|_| Error("root_authorization_rejected"))?;
        let latest = authorization
            .generation(authorization.watermark().generation)
            .map_err(|_| Error("root_authorization_rejected"))?;
        for (purpose, key_id, bytes) in [
            (
                KeyPurpose::Release,
                &public.release_key_id,
                &public.release_public_key,
            ),
            (
                KeyPurpose::Revocations,
                &public.revocations_key_id,
                &public.revocations_public_key,
            ),
        ] {
            let key = latest
                .key(purpose)
                .map_err(|_| Error("root_authorization_rejected"))?;
            if &key.key_id != key_id || &key.public_key != bytes {
                return Err(Error(
                    "working_seed_not_authorized_by_latest_root_generation",
                ));
            }
        }
        Ok(Self {
            release,
            revocations,
            public,
            authorization,
            _files: [release_file, revocations_file],
        })
    }

    pub fn public(&self) -> &PublicKeys {
        &self.public
    }

    pub fn authorization(&self) -> &VerifiedAuthorizationChain {
        &self.authorization
    }

    pub fn bootstrap_public(&self) -> Result<PublicKeys> {
        let first = self
            .authorization
            .generation(1)
            .map_err(|_| Error("root_authorization_rejected"))?;
        let release = first
            .key(KeyPurpose::Release)
            .map_err(|_| Error("root_authorization_rejected"))?;
        let revocations = first
            .key(KeyPurpose::Revocations)
            .map_err(|_| Error("root_authorization_rejected"))?;
        Ok(PublicKeys {
            release_key_id: release.key_id.clone(),
            release_public_key: release.public_key.clone(),
            revocations_key_id: revocations.key_id.clone(),
            revocations_public_key: revocations.public_key.clone(),
        })
    }

    pub fn check_current(&self, document: &Document) -> Result<()> {
        let expected = match document {
            Document::Release(_) => &self.public.release_key_id,
            Document::Revocations(_) => &self.public.revocations_key_id,
        };
        if document.key_id() != expected {
            return Err(Error("document_uses_retired_working_key"));
        }
        Ok(())
    }

    pub fn check_record(&self, record: &crate::checkpoint::Record) -> Result<()> {
        let generation = self
            .authorization
            .generation(record.key_generation)
            .map_err(|_| Error("stored_key_generation_missing"))?;
        let purpose = match record.document {
            Document::Release(_) => KeyPurpose::Release,
            Document::Revocations(_) => KeyPurpose::Revocations,
        };
        if generation
            .canonical_digest()
            .map_err(|_| Error("stored_key_generation_invalid"))?
            != record.authorization_digest
            || generation
                .key(purpose)
                .map_err(|_| Error("stored_key_generation_invalid"))?
                .key_id
                != record.document.key_id()
        {
            return Err(Error("stored_key_generation_conflict"));
        }
        Ok(())
    }

    // The ledger calls this only after its exact intent and checkpoint are durable.
    pub fn sign(&self, document: &Document) -> Result<serde_json::Value> {
        self.check_current(document)?;
        Self::check_envelope_size(document)?;
        let key = match document {
            Document::Release(_) => &self.release,
            Document::Revocations(_) => &self.revocations,
        };
        let signature = URL_SAFE_NO_PAD.encode(key.sign(&document.signing_bytes()?).to_bytes());
        let envelope = envelope(document, signature)?;
        self.verify(
            document,
            &serde_json::to_vec(&envelope).map_err(|_| Error("signature_encoding_failed"))?,
        )?;
        Ok(envelope)
    }

    pub fn verify(&self, document: &Document, bytes: &[u8]) -> Result<()> {
        let digest = match document {
            Document::Release(_) => {
                let key = self
                    .authorization
                    .historical_key(document.key_id(), KeyPurpose::Release)
                    .map_err(|_| Error("invalid_signer_public_key"))?;
                SignedRelease::parse(bytes)
                    .and_then(|body| body.verify(&key))
                    .map_err(|_| Error("stored_signature_invalid"))?
                    .canonical_digest()
                    .to_owned()
            }
            Document::Revocations(_) => {
                let key = self
                    .authorization
                    .historical_key(document.key_id(), KeyPurpose::Revocations)
                    .map_err(|_| Error("invalid_signer_public_key"))?;
                SignedRevocations::parse(bytes)
                    .and_then(|body| body.verify(&key))
                    .map_err(|_| Error("stored_signature_invalid"))?
                    .canonical_digest()
                    .to_owned()
            }
        };
        if digest != document.digest()? {
            return Err(Error("stored_signature_body_mismatch"));
        }
        Ok(())
    }

    pub fn check_envelope_size(document: &Document) -> Result<()> {
        let value = envelope(document, "A".repeat(86))?;
        let bytes = serde_json::to_vec(&value).map_err(|_| Error("signature_encoding_failed"))?;
        let limit = match document {
            Document::Release(_) => MAX_RELEASE_BYTES,
            Document::Revocations(_) => MAX_REVOCATIONS_BYTES,
        };
        if bytes.len() > limit {
            return Err(Error("signed_document_too_large"));
        }
        Ok(())
    }
}

fn load_seed(config: &KeyConfig, identity: &str) -> Result<(SigningKey, File)> {
    let mut file = platform::private_file(&config.seed_file, identity, false)?;
    if file.metadata()?.len() != 32 {
        return Err(Error("key_seed_must_be_32_bytes"));
    }
    let mut bytes = Zeroizing::new([0u8; 32]);
    file.read_exact(&mut *bytes)?;
    let key = SigningKey::from_bytes(&bytes);
    Ok((key, file))
}

fn envelope(document: &Document, signature: String) -> Result<serde_json::Value> {
    match document {
        Document::Release(body) => serde_json::to_value(SignedRelease {
            release: body.clone(),
            signature,
        }),
        Document::Revocations(body) => serde_json::to_value(SignedRevocations {
            revocations: body.clone(),
            signature,
        }),
    }
    .map_err(|_| Error("signature_encoding_failed"))
}
