// SPDX-License-Identifier: MIT
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    config::Config,
    keys::PublicKeys,
    platform,
    protocol::{self, Document, Error, Result, MAX_FRAME, MAX_OPERATIONS},
};

const IDENTITY_DOMAIN: &[u8] = b"HERTZ-WALLPAPER-SIGNER-IDENTITY-V1\n";
const CHECKPOINT_DOMAIN: &[u8] = b"HERTZ-WALLPAPER-SIGNER-CHECKPOINT-V1\n";

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Identity {
    pub format_version: u32,
    pub ledger_id: String,
    pub hub_id: String,
    pub service_identity: String,
    pub hub_identity: String,
    pub approver_identities: Vec<String>,
    pub keys: PublicKeys,
    pub root_fingerprint: String,
}

impl Identity {
    pub fn new(config: &Config, keys: &PublicKeys) -> Self {
        Self {
            format_version: 1,
            ledger_id: config.ledger_id.clone(),
            hub_id: config.hub_id.clone(),
            service_identity: config.service_identity.clone(),
            hub_identity: config.hub_identity.clone(),
            approver_identities: config.approver_identities.clone(),
            keys: keys.clone(),
            root_fingerprint: config.root_fingerprint.clone(),
        }
    }
    pub fn encoded(&self) -> Result<String> {
        protocol::encode(self)
    }
    pub fn digest(&self) -> Result<String> {
        Ok(domain_hash(IDENTITY_DOMAIN, self.encoded()?.as_bytes()))
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Record {
    pub format_version: u32,
    pub identity_digest: String,
    pub position: u64,
    pub operation_id: String,
    pub body_digest: String,
    pub key_generation: u64,
    pub authorization_digest: String,
    pub approval_digest: String,
    pub document: Document,
    pub approver_identity: String,
    pub registered_at: u64,
    pub previous_hash: String,
}

impl Record {
    pub fn encoded(&self) -> Result<String> {
        let encoded = protocol::encode(self)?;
        if encoded.len() > MAX_FRAME {
            return Err(Error("checkpoint_too_large"));
        }
        Ok(encoded)
    }
    pub fn digest(&self) -> Result<String> {
        Ok(domain_hash(CHECKPOINT_DOMAIN, self.encoded()?.as_bytes()))
    }
    pub fn validate(&self, identity: &Identity) -> Result<()> {
        protocol::body_identity(&self.operation_id, &self.body_digest)?;
        for hash in [
            &self.approval_digest,
            &self.previous_hash,
            &self.authorization_digest,
        ] {
            if !hertz_wallpaper::valid_sha256_hex(hash) {
                return Err(Error("invalid_checkpoint_hash"));
            }
        }
        if self.format_version != 1
            || self.identity_digest != identity.digest()?
            || self.position == 0
            || self.position > MAX_OPERATIONS as u64
            || self.key_generation == 0
            || self.key_generation
                > hertz_wallpaper::release::authorization::MAX_KEY_GENERATIONS as u64
            || self.registered_at == 0
            || self.registered_at > hertz_wallpaper::release::MAX_SAFE_INTEGER
        {
            return Err(Error("checkpoint_identity_mismatch"));
        }
        if !identity
            .approver_identities
            .contains(&self.approver_identity)
            || self.document.digest()? != self.body_digest
            || self.document.hub_id() != identity.hub_id
        {
            return Err(Error("checkpoint_approval_mismatch"));
        }
        // The ledger additionally checks the exact historical root generation.
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TailProof {
    pub format_version: u32,
    pub ledger_id: String,
    pub hub_id: String,
    pub identity_digest: String,
    pub position: u64,
    pub checkpoint_hash: String,
    pub key_generation: u64,
    pub authorization_digest: String,
}

pub struct Store {
    directory: PathBuf,
    identity: Identity,
    observed_tail: u64,
    tail: TailProof,
}

impl Store {
    pub fn initialize(config: &Config, identity: &Identity) -> Result<()> {
        for entry in std::fs::read_dir(&config.checkpoint_directory)? {
            if entry?.file_name() != ".signer.lock" {
                return Err(Error("checkpoint_directory_not_empty"));
            }
        }
        platform::new_private_bytes(
            &config.checkpoint_directory.join("identity.json"),
            &config.service_identity,
            identity.encoded()?.as_bytes(),
        )
    }

    pub fn open(
        config: &Config,
        identity: Identity,
        authorization: &hertz_wallpaper::release::authorization::AuthorizationWatermark,
    ) -> Result<Self> {
        let stored: Identity = protocol::parse(&platform::private_bytes(
            &config.checkpoint_directory.join("identity.json"),
            &config.service_identity,
            32 * 1024,
        )?)?;
        if stored != identity {
            return Err(Error("checkpoint_ledger_identity_mismatch"));
        }
        let mut positions = BTreeSet::new();
        let mut entries = 0usize;
        for entry in std::fs::read_dir(&config.checkpoint_directory)? {
            entries += 1;
            if entries
                > MAX_OPERATIONS as usize
                    + 2
                    + hertz_wallpaper::release::authorization::MAX_KEY_GENERATIONS
            {
                return Err(Error("checkpoint_capacity_exhausted"));
            }
            let name = entry?.file_name();
            if name == ".signer.lock" || name == "identity.json" {
                continue;
            }
            let name = name.to_str().ok_or(Error("unexpected_checkpoint_object"))?;
            if name.starts_with("authorization-") {
                // Names, continuity and bytes are checked by the root checkpoint owner.
                continue;
            }
            let number = name
                .strip_suffix(".json")
                .ok_or(Error("unexpected_checkpoint_object"))?;
            let position: u64 = number
                .parse()
                .map_err(|_| Error("unexpected_checkpoint_object"))?;
            if position == 0
                || position > MAX_OPERATIONS as u64
                || name != format!("{position:020}.json")
                || !positions.insert(position)
            {
                return Err(Error("invalid_checkpoint_sequence"));
            }
        }
        let observed_tail = positions.last().copied().unwrap_or(0);
        if observed_tail != positions.len() as u64 {
            return Err(Error("checkpoint_gap"));
        }
        let identity_digest = identity.digest()?;
        let tail = TailProof {
            format_version: 1,
            ledger_id: identity.ledger_id.clone(),
            hub_id: identity.hub_id.clone(),
            identity_digest: identity_digest.clone(),
            position: 0,
            checkpoint_hash: identity_digest,
            key_generation: authorization.generation,
            authorization_digest: authorization.canonical_digest.clone(),
        };
        Ok(Self {
            directory: config.checkpoint_directory.clone(),
            identity,
            observed_tail,
            tail,
        })
    }

    pub fn observed_tail(&self) -> u64 {
        self.observed_tail
    }
    pub fn tail(&self) -> TailProof {
        self.tail.clone()
    }

    pub fn require(&self, record: &Record, expected_hash: &str) -> Result<()> {
        record.validate(&self.identity)?;
        if record.position > self.tail.position || record.digest()? != expected_hash {
            return Err(Error("checkpoint_not_registered"));
        }
        let path = self.directory.join(format!("{:020}.json", record.position));
        let bytes = platform::private_bytes(&path, &self.identity.service_identity, MAX_FRAME)?;
        if bytes != record.encoded()?.as_bytes() {
            return Err(Error("checkpoint_content_conflict"));
        }
        Ok(())
    }

    pub fn ensure(&mut self, record: &Record, expected_hash: &str, signed: bool) -> Result<()> {
        record.validate(&self.identity)?;
        if record.position != self.tail.position + 1
            || record.previous_hash != self.tail.checkpoint_hash
            || record.digest()? != expected_hash
        {
            return Err(Error("checkpoint_chain_conflict"));
        }
        let path = self.directory.join(format!("{:020}.json", record.position));
        let encoded = record.encoded()?;
        if path.try_exists()? {
            let bytes = platform::private_bytes(&path, &self.identity.service_identity, MAX_FRAME)?;
            if bytes.len() > encoded.len()
                || !encoded.as_bytes().starts_with(&bytes)
                || (signed && bytes != encoded.as_bytes())
            {
                return Err(Error("checkpoint_content_conflict"));
            }
            if !signed {
                // An interrupted create can only append the missing suffix of its
                // already committed unsigned intent. Existing bytes never change.
                let mut file =
                    platform::private_file(&path, &self.identity.service_identity, true)?;
                let mut current = Vec::new();
                (&mut file)
                    .take((MAX_FRAME + 1) as u64)
                    .read_to_end(&mut current)?;
                if current != bytes {
                    return Err(Error("checkpoint_changed"));
                }
                file.write_all(&encoded.as_bytes()[bytes.len()..])?;
                file.sync_all()?;
                platform::sync_directory(&self.directory)?;
            }
        } else {
            if signed {
                return Err(Error("signed_intent_missing_checkpoint"));
            }
            platform::new_private_bytes(
                &path,
                &self.identity.service_identity,
                encoded.as_bytes(),
            )?;
        }
        self.tail.position = record.position;
        self.tail.checkpoint_hash = expected_hash.to_owned();
        Ok(())
    }

    pub fn check_recovery_proof(&self, config: &Config, path: &Path) -> Result<()> {
        crate::config::absolute(path)?;
        let file = platform::private_file(path, &config.service_identity, false)?;
        let path = std::fs::canonicalize(path)?;
        let parent = config
            .database_path
            .parent()
            .ok_or(Error("invalid_database_path"))?;
        if path.starts_with(parent) || path.starts_with(&self.directory) {
            return Err(Error("recovery_proof_requires_independent_storage"));
        }
        let proof: TailProof = protocol::parse(&protocol::read_from(file, 16 * 1024)?)?;
        if proof != self.tail {
            return Err(Error("recovery_tail_not_proven"));
        }
        Ok(())
    }
}

fn domain_hash(domain: &[u8], bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(domain);
    hash.update(bytes);
    format!("{:x}", hash.finalize())
}
