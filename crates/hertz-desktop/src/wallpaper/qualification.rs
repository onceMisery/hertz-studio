// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Library 持有的本机成功资格缓存，独立于安装事实、准入集合与运行预算。
//! 缓存键绑定真实被探测的字节（图片为标准化 PNG）、探测算法与完整环境指纹。

use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use super::{
    assets::DecodeInput,
    decode_probe::ProbeClient,
    jobs::JobError,
    library::{now_secs, Library},
    probe_environment::Environment,
};

// 原生探测语义改变时递增；受信页面还单独绑定源码摘要。
const ADAPTER: &str = "webview2-visible-probe-v1";
const CAP: i64 = 4096;
const TTL: i64 = 7 * 24 * 60 * 60;
type Result<T> = std::result::Result<T, JobError>;

struct Key {
    digest: String,
    content: String,
    environment: String,
}

fn key(
    entry: &hertz_wallpaper::VerifiedEntry,
    info: &super::media::MediaProbe,
    environment: &Environment,
) -> Result<Key> {
    let mut digest = Sha256::new();
    let metadata =
        serde_json::to_vec(info).map_err(|error| JobError::invalid_input(error.to_string()))?;
    for part in [
        ADAPTER.as_bytes(),
        entry.sha256.as_bytes(),
        environment.fingerprint.as_bytes(),
        environment.browser.as_bytes(),
        include_bytes!("../../assets/wallpaper-probe.js"),
        metadata.as_slice(),
        entry.mime.as_deref().unwrap_or("").as_bytes(),
    ] {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part);
    }
    Ok(Key {
        digest: format!("{:x}", digest.finalize()),
        content: entry.sha256.clone(),
        environment: environment.fingerprint.clone(),
    })
}

async fn hit(library: &Library, key: &Key, now: i64) -> Result<bool> {
    // 缓存也不跨时钟倒退复用；索引不是跨环境、永久可播的声明。
    let result = sqlx::query("UPDATE media_qualifications SET last_used = ? WHERE cache_key = ? AND content_hash = ? AND environment_hash = ? AND adapter_version = ? AND qualified_at BETWEEN ? AND ?")
        .bind(now).bind(&key.digest).bind(&key.content).bind(&key.environment).bind(ADAPTER).bind(now.saturating_sub(TTL)).bind(now)
        .execute(library.pool()).await.map_err(|error| JobError::database(error.to_string()))?;
    Ok(result.rows_affected() == 1)
}

async fn record(library: &Library, key: &Key, now: i64) -> Result<()> {
    let mut transaction = library
        .pool()
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| JobError::database(error.to_string()))?;
    sqlx::query("DELETE FROM media_qualifications WHERE qualified_at < ? OR qualified_at > ?")
        .bind(now.saturating_sub(TTL))
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|error| JobError::database(error.to_string()))?;
    sqlx::query("INSERT INTO media_qualifications VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET content_hash=excluded.content_hash, environment_hash=excluded.environment_hash, adapter_version=excluded.adapter_version, qualified_at=excluded.qualified_at, last_used=excluded.last_used")
        .bind(&key.digest).bind(&key.content).bind(&key.environment).bind(ADAPTER).bind(now).bind(now)
        .execute(&mut *transaction).await.map_err(|error| JobError::database(error.to_string()))?;
    sqlx::query("DELETE FROM media_qualifications WHERE cache_key IN (SELECT cache_key FROM media_qualifications ORDER BY last_used DESC, cache_key DESC LIMIT -1 OFFSET ?)")
        .bind(CAP).execute(&mut *transaction).await.map_err(|error| JobError::database(error.to_string()))?;
    transaction
        .commit()
        .await
        .map_err(|error| JobError::database(error.to_string()))?;
    Ok(())
}

fn cancelled(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(JobError::new("cancelled", "解码资格检查已取消"))
    } else {
        Ok(())
    }
}

impl ProbeClient {
    pub(crate) async fn qualify(
        &self,
        library: &Library,
        input: DecodeInput,
        cancel: Arc<AtomicBool>,
    ) -> Result<()> {
        cancelled(&cancel)?;
        self.check_metadata(&input.metadata)?;
        let environment = if self.cache_allowed() {
            self.environment().await
        } else {
            None
        };
        cancelled(&cancel)?;
        let key = environment
            .as_ref()
            .map(|env| key(&input.media.entry, &input.metadata, env))
            .transpose()?;
        if let Some(key) = &key {
            match hit(library, key, now_secs()).await {
                Ok(true) => {
                    cancelled(&cancel)?;
                    self.note_cache_hit();
                    return Ok(());
                }
                Ok(false) => {}
                Err(error) => {
                    crate::app::log(&format!("decode qualification lookup skipped: {error}"))
                }
            }
        }
        // 此回执等待独立 controller 关闭、文件活动归零与资源配额归还。
        let actual_browser = self.run(input, Arc::clone(&cancel)).await?;
        cancelled(&cancel)?;
        if let (Some(before), Some(key)) = (environment, key) {
            let after = self.environment().await;
            if actual_browser.as_deref() == Some(before.browser.as_str())
                && after.as_ref() == Some(&before)
            {
                cancelled(&cancel)?;
                if let Err(error) = record(library, &key, now_secs()).await {
                    // 可重建证明写失败不推翻已完成的实际解码，也不写 installed 的替代事实。
                    crate::app::log(&format!("decode qualification store skipped: {error}"));
                }
            } else {
                crate::app::log("decode qualification environment changed; success not cached");
            }
        }
        cancelled(&cancel)
    }
}

#[cfg(test)]
#[path = "qualification_tests.rs"]
mod tests;
