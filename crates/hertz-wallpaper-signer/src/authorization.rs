// SPDX-License-Identifier: MIT
//! Root generation checkpointing uses the same protected service identity but
//! separate append-only files, so restoring the Hub or ledger cannot lower it.
use std::{
    collections::BTreeSet,
    io::{Read, Write},
};

use hertz_wallpaper::release::authorization::{
    AuthorizationChain, AuthorizationWatermark, VerifiedAuthorizationChain,
    MAX_AUTHORIZATION_BYTES, MAX_KEY_GENERATIONS,
};
use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::{
    config::Config,
    keys::Keys,
    platform,
    protocol::{self, Error, Result},
};

pub async fn initialize(
    tx: &mut Transaction<'_, Sqlite>,
    chain: &VerifiedAuthorizationChain,
) -> Result<()> {
    let watermark = chain.watermark();
    sqlx::query("INSERT INTO root_authorization(singleton,generation,body_digest,chain_json) VALUES(1,?,?,?)")
        .bind(watermark.generation as i64).bind(&watermark.canonical_digest)
        .bind(String::from_utf8(chain.canonical_bytes().map_err(|_| Error("authorization_encoding_failed"))?)
            .map_err(|_| Error("authorization_encoding_failed"))?)
        .execute(&mut **tx).await?;
    Ok(())
}

pub async fn reconcile(pool: &SqlitePool, config: &Config, keys: &Keys) -> Result<()> {
    let (generation, body_digest, bytes, chain_json): (i64, Option<String>, i64, Option<String>) = sqlx::query_as(
        "SELECT generation,CASE WHEN length(CAST(body_digest AS BLOB))=64 THEN body_digest ELSE NULL END,length(CAST(chain_json AS BLOB)),CASE WHEN length(CAST(chain_json AS BLOB))<=262144 THEN chain_json ELSE NULL END FROM root_authorization WHERE singleton=1")
        .fetch_one(pool).await?;
    if bytes <= 0
        || bytes > MAX_AUTHORIZATION_BYTES as i64
        || !(1..=MAX_KEY_GENERATIONS as i64).contains(&generation)
    {
        return Err(Error("stored_authorization_invalid"));
    }
    let body_digest = body_digest.ok_or(Error("stored_authorization_invalid"))?;
    let chain_json = chain_json.ok_or(Error("stored_authorization_invalid"))?;
    let previous = AuthorizationWatermark {
        hub_id: config.hub_id.clone(),
        root_fingerprint: config.root_fingerprint.clone(),
        generation: generation as u64,
        canonical_digest: body_digest,
    };
    let stored = AuthorizationChain::parse(chain_json.as_bytes())
        .and_then(|chain| chain.verify(keys.authorization().pin(), Some(&previous)))
        .map_err(|_| Error("stored_authorization_invalid"))?;
    if stored.watermark() != &previous {
        return Err(Error("stored_authorization_watermark_mismatch"));
    }
    // The configured complete chain must include every previously committed
    // generation. Root/working keys are never learned from a Hub response here.
    keys.authorization()
        .chain()
        .clone()
        .verify(keys.authorization().pin(), Some(&previous))
        .map_err(|_| Error("root_generation_rollback_or_conflict"))?;
    for index in 0..generation as usize {
        if protocol::encode(&stored.chain().authorizations[index])?
            != protocol::encode(&keys.authorization().chain().authorizations[index])?
        {
            return Err(Error("stored_authorization_prefix_changed"));
        }
    }
    let observed = observed_generations(config)?;
    if observed.len() as i64 > generation {
        return Err(Error("ledger_behind_root_checkpoint"));
    }
    let signed_generation: i64 = sqlx::query_scalar(
        "SELECT coalesce(max(json_extract(record_json,'$.keyGeneration')),0) FROM signing_intents WHERE envelope_json IS NOT NULL")
        .fetch_one(pool).await?;
    // Repair only a known unsigned suffix. A signed generation with a missing
    // authorization checkpoint is a rollback/missing-history condition.
    if signed_generation > observed.len() as i64 {
        return Err(Error("signed_generation_missing_root_checkpoint"));
    }
    flush(config, &stored, signed_generation as u64)?;
    if keys.authorization().watermark().generation > previous.generation {
        // Finish pending old-key intents with their original deployment before
        // rotating away the seeds; never advance the watermark into a dead end.
        let pending: Option<Option<String>> = sqlx::query_scalar(
            "SELECT CASE WHEN length(CAST(record_json AS BLOB))<=1100000 THEN record_json ELSE NULL END FROM signing_intents WHERE envelope_json IS NULL LIMIT 1")
            .fetch_optional(pool).await?;
        if let Some(pending) = pending {
            let pending = pending.ok_or(Error("stored_intent_too_large"))?;
            let record: crate::checkpoint::Record = protocol::parse(pending.as_bytes())?;
            keys.check_current(&record.document)
                .map_err(|_| Error("finish_old_key_intent_before_rotation"))?;
        }
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE root_authorization SET generation=?,body_digest=?,chain_json=? WHERE singleton=1 AND generation=? AND body_digest=?")
            .bind(keys.authorization().watermark().generation as i64)
            .bind(&keys.authorization().watermark().canonical_digest)
            .bind(String::from_utf8(keys.authorization().canonical_bytes().map_err(|_| Error("authorization_encoding_failed"))?)
                .map_err(|_| Error("authorization_encoding_failed"))?)
            .bind(previous.generation as i64).bind(&previous.canonical_digest)
            .execute(&mut *tx).await?;
        tx.commit().await?;
        flush(config, keys.authorization(), signed_generation as u64)?;
    }
    Ok(())
}

pub fn flush(
    config: &Config,
    chain: &VerifiedAuthorizationChain,
    signed_generation: u64,
) -> Result<()> {
    for signed in &chain.chain().authorizations {
        let generation = signed.authorization.generation;
        let path = config
            .checkpoint_directory
            .join(format!("authorization-{generation:020}.json"));
        let expected = protocol::encode(signed)?;
        if path.try_exists()? {
            let bytes =
                platform::private_bytes(&path, &config.service_identity, MAX_AUTHORIZATION_BYTES)?;
            if bytes.len() > expected.len()
                || !expected.as_bytes().starts_with(&bytes)
                || (generation <= signed_generation && bytes != expected.as_bytes())
            {
                return Err(Error("root_checkpoint_conflict"));
            }
            if bytes.len() != expected.len() {
                let mut file = platform::private_file(&path, &config.service_identity, true)?;
                let mut current = Vec::new();
                (&mut file)
                    .take((MAX_AUTHORIZATION_BYTES + 1) as u64)
                    .read_to_end(&mut current)?;
                if current != bytes {
                    return Err(Error("root_checkpoint_changed"));
                }
                file.write_all(&expected.as_bytes()[bytes.len()..])?;
                file.sync_all()?;
                platform::sync_directory(&config.checkpoint_directory)?;
            }
        } else {
            if generation <= signed_generation {
                return Err(Error("signed_generation_missing_root_checkpoint"));
            }
            platform::new_private_bytes(&path, &config.service_identity, expected.as_bytes())?;
        }
    }
    Ok(())
}

fn observed_generations(config: &Config) -> Result<BTreeSet<u64>> {
    let mut generations = BTreeSet::new();
    for entry in std::fs::read_dir(&config.checkpoint_directory)? {
        let name = entry?.file_name();
        let name = name.to_str().ok_or(Error("unexpected_checkpoint_object"))?;
        if let Some(number) = name.strip_prefix("authorization-") {
            let generation: u64 = number
                .strip_suffix(".json")
                .ok_or(Error("invalid_root_checkpoint_name"))?
                .parse()
                .map_err(|_| Error("invalid_root_checkpoint_name"))?;
            if generation == 0
                || generation > MAX_KEY_GENERATIONS as u64
                || name != format!("authorization-{generation:020}.json")
                || !generations.insert(generation)
            {
                return Err(Error("invalid_root_checkpoint_sequence"));
            }
        }
    }
    if generations.last().copied().unwrap_or(0) != generations.len() as u64 {
        return Err(Error("root_checkpoint_gap"));
    }
    Ok(generations)
}
