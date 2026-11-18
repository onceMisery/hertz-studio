// SPDX-License-Identifier: MIT
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{
    platform,
    protocol::{self, Document, Error, Result},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct KeyConfig {
    pub key_id: String,
    pub seed_file: PathBuf,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub ledger_id: String,
    pub hub_id: String,
    pub service_identity: String,
    pub hub_identity: String,
    pub approver_identities: Vec<String>,
    pub endpoint: String,
    pub database_path: PathBuf,
    pub checkpoint_directory: PathBuf,
    pub release_key: KeyConfig,
    pub revocations_key: KeyConfig,
    pub authorization_chain_file: PathBuf,
    pub root_fingerprint: String,
    pub max_database_bytes: u64,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        absolute(path)?;
        let current = platform::current_identity()?;
        let bytes = protocol::read_from(platform::private_file(path, &current, false)?, 32 * 1024)?;
        let mut config: Self = toml::from_str(
            std::str::from_utf8(&bytes).map_err(|_| Error("invalid_config_encoding"))?,
        )
        .map_err(|_| Error("invalid_config_fields"))?;
        if config.service_identity != current {
            return Err(Error("service_identity_mismatch"));
        }
        config.validate()?;
        config.approver_identities.sort();
        let parent = config
            .database_path
            .parent()
            .ok_or(Error("invalid_database_path"))?;
        let parent = platform::private_directory(parent, &current)?;
        let name = config
            .database_path
            .file_name()
            .ok_or(Error("invalid_database_path"))?;
        config.database_path = parent.join(name);
        config.checkpoint_directory =
            platform::private_directory(&config.checkpoint_directory, &current)?;
        if parent.starts_with(&config.checkpoint_directory)
            || config.checkpoint_directory.starts_with(&parent)
        {
            return Err(Error("checkpoint_requires_independent_directory"));
        }
        for key in [&mut config.release_key, &mut config.revocations_key] {
            let file = platform::private_file(&key.seed_file, &current, false)?;
            if file.metadata()?.len() != 32 {
                return Err(Error("key_seed_must_be_32_bytes"));
            }
            key.seed_file = std::fs::canonicalize(&key.seed_file)?;
            if key.seed_file == config.database_path
                || key.seed_file.starts_with(&config.checkpoint_directory)
            {
                return Err(Error("key_storage_conflict"));
            }
        }
        if config.release_key.seed_file == config.revocations_key.seed_file {
            return Err(Error("key_purposes_require_distinct_seeds"));
        }
        absolute(&config.authorization_chain_file)?;
        drop(platform::private_file(
            &config.authorization_chain_file,
            &current,
            false,
        )?);
        config.authorization_chain_file = std::fs::canonicalize(&config.authorization_chain_file)?;
        if !hertz_wallpaper::valid_sha256_hex(&config.root_fingerprint) {
            return Err(Error("explicit_root_fingerprint_required"));
        }
        platform::validate_endpoint(&config.endpoint, Some(&current))?;
        Ok(config)
    }

    fn validate(&self) -> Result<()> {
        protocol::id(&self.ledger_id)?;
        protocol::id(&self.hub_id)?;
        platform::validate_identity(&self.service_identity)?;
        platform::validate_identity(&self.hub_identity)?;
        if self.service_identity == self.hub_identity
            || self.approver_identities.is_empty()
            || self.approver_identities.len() > 16
        {
            return Err(Error("independent_identities_required"));
        }
        let mut identities = std::collections::BTreeSet::new();
        for identity in &self.approver_identities {
            platform::validate_identity(identity)?;
            if identity == &self.service_identity
                || identity == &self.hub_identity
                || !identities.insert(identity)
            {
                return Err(Error("independent_identities_required"));
            }
        }
        for key in [&self.release_key, &self.revocations_key] {
            if key.key_id.is_empty()
                || key.key_id.len() > 128
                || !key
                    .key_id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
            {
                return Err(Error("invalid_key_id"));
            }
            absolute(&key.seed_file)?;
        }
        if self.release_key.key_id == self.revocations_key.key_id {
            return Err(Error("key_purposes_require_distinct_ids"));
        }
        absolute(&self.database_path)?;
        absolute(&self.checkpoint_directory)?;
        if !(16 * 1024 * 1024..=16 * 1024 * 1024 * 1024).contains(&self.max_database_bytes) {
            return Err(Error("invalid_database_budget"));
        }
        Ok(())
    }

    pub fn is_approver(&self, peer: &str) -> bool {
        self.approver_identities
            .iter()
            .any(|identity| identity == peer)
    }

    pub fn check_document(&self, document: &Document) -> Result<()> {
        if document.hub_id() != self.hub_id {
            return Err(Error("document_source_or_key_mismatch"));
        }
        document.canonical()?;
        Ok(())
    }
}

pub fn absolute(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(Error("absolute_nonredirected_path_required"));
    }
    #[cfg(windows)]
    if !matches!(path.components().next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
    {
        return Err(Error("local_disk_path_required"));
    }
    Ok(())
}
