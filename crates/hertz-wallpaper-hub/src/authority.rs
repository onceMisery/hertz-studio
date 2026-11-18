// SPDX-License-Identifier: MIT
//! Public root chain and its immutable deployment pin, never private key material.
use hertz_wallpaper::release::{
    authorization::{
        AuthorizationChain, AuthorizationWatermark, RootPin, VerifiedAuthorizationChain,
        MAX_AUTHORIZATION_BYTES,
    },
    KeyPurpose,
};
use sqlx::{Row, SqlitePool};
use tokio::io::AsyncReadExt;

use crate::{
    config::Config,
    error::{HubError, Result},
};

pub(crate) async fn load(config: &Config, pool: &SqlitePool) -> Result<VerifiedAuthorizationChain> {
    let file = tokio::fs::File::open(&config.authorization_chain_file).await?;
    if !file.metadata().await?.is_file() {
        return Err(HubError::invalid("根授权链须为普通本地文件"));
    }
    let mut bytes = Vec::new();
    file.take((MAX_AUTHORIZATION_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    let chain =
        AuthorizationChain::parse(&bytes).map_err(|_| HubError::invalid("离线根授权链无效"))?;
    let pin = RootPin::confirm(
        config.hub_id.clone(),
        chain.bootstrap_root.clone(),
        &config.root_fingerprint,
    )
    .map_err(|_| HubError::invalid("根公钥与部署确认指纹不匹配"))?;
    let mut tx = pool.begin().await?;
    let previous = sqlx::query("SELECT CASE WHEN length(CAST(root_fingerprint AS BLOB))=64 THEN root_fingerprint ELSE NULL END AS root_fingerprint,generation,CASE WHEN length(CAST(authorization_digest AS BLOB))=64 THEN authorization_digest ELSE NULL END AS authorization_digest,CASE WHEN length(CAST(signer_service_identity AS BLOB))<=256 THEN signer_service_identity ELSE NULL END AS signer_service_identity,CASE WHEN length(CAST(signer_ledger_id AS BLOB))=36 THEN signer_ledger_id ELSE NULL END AS signer_ledger_id,length(CAST(chain_json AS BLOB)) AS bytes,CASE WHEN length(CAST(chain_json AS BLOB))<=262144 THEN chain_json ELSE NULL END AS chain_json FROM publication_authority WHERE singleton=1")
        .fetch_optional(&mut *tx).await?;
    let previous_watermark = if let Some(row) = previous {
        if row.try_get::<String, _>("signer_service_identity")? != config.signer_service_identity
            || row.try_get::<String, _>("signer_ledger_id")? != config.signer_ledger_id
            || row.try_get::<i64, _>("bytes")? > MAX_AUTHORIZATION_BYTES as i64
        {
            return Err(HubError::conflict(
                "已有Hub不可替换签名账本、服务身份或信任根",
            ));
        }
        let watermark = AuthorizationWatermark {
            hub_id: config.hub_id.clone(),
            root_fingerprint: row.try_get("root_fingerprint")?,
            generation: row.try_get::<i64, _>("generation")? as u64,
            canonical_digest: row.try_get("authorization_digest")?,
        };
        let original = row.try_get::<String, _>("chain_json")?;
        let stored = AuthorizationChain::parse(original.as_bytes())
            .and_then(|chain| chain.verify(&pin, Some(&watermark)))
            .map_err(|_| HubError::conflict("已保存Hub根授权与部署链不匹配"))?;
        if stored.watermark() != &watermark {
            return Err(HubError::conflict("已保存密钥水位不一致"));
        }
        Some(watermark)
    } else {
        None
    };
    let verified = chain
        .verify(&pin, previous_watermark.as_ref())
        .map_err(|_| HubError::conflict("根授权代际回退、冲突或轮换链验证失败"))?;
    let latest = verified
        .generation(verified.watermark().generation)
        .map_err(|_| HubError::invalid("根授权代际无效"))?;
    if latest
        .key(KeyPurpose::Release)
        .map_err(|_| HubError::invalid("发布授权缺失"))?
        .key_id
        != config.release_key_id
        || latest
            .key(KeyPurpose::Revocations)
            .map_err(|_| HubError::invalid("撤销授权缺失"))?
            .key_id
            != config.revocations_key_id
    {
        return Err(HubError::invalid("Hub工作keyId须对应最新离线根授权"));
    }
    sqlx::query("INSERT INTO publication_authority(singleton,root_fingerprint,generation,authorization_digest,chain_json,signer_service_identity,signer_ledger_id) VALUES(1,?,?,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation,authorization_digest=excluded.authorization_digest,chain_json=excluded.chain_json")
        .bind(pin.fingerprint()).bind(verified.watermark().generation as i64).bind(&verified.watermark().canonical_digest)
        .bind(String::from_utf8(verified.canonical_bytes().map_err(|_| HubError::invalid("根链编码无效"))?).map_err(|_| HubError::invalid("根链编码无效"))?)
        .bind(&config.signer_service_identity).bind(&config.signer_ledger_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(verified)
}
