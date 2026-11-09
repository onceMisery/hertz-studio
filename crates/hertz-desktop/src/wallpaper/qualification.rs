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
    font_prepare::{self, FontInput},
    jobs::JobError,
    library::{now_secs, Library},
    probe_environment::Environment,
};

// 原生探测语义改变时递增；受信页面还单独绑定源码摘要。
const ADAPTER: &str = "webview2-visible-probe-v1";
const FONT_ADAPTER: &str = "webview2-font-probe-v1";
const CAP: i64 = 4096;
const TTL: i64 = 7 * 24 * 60 * 60;
type Result<T> = std::result::Result<T, JobError>;

struct Key {
    digest: String,
    content: String,
    environment: String,
    adapter: &'static str,
}

/// Minted only by the original successful-qualification owner. Parsed SFNT
/// facts alone cannot turn into a prepared runtime font.
pub(crate) struct QualifiedFont {
    content_key: String,
}
impl QualifiedFont {
    pub(crate) fn matches(&self, input: &FontInput) -> Result<bool> {
        Ok(self.content_key == font_prepare::content_key(input)?)
    }
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
        adapter: ADAPTER,
    })
}

fn font_key(input: &FontInput, environment: &Environment) -> Result<Key> {
    let content_key = font_prepare::content_key(input)?;
    let metadata = serde_json::to_vec(&input.metadata)
        .map_err(|error| JobError::invalid_input(error.to_string()))?;
    let mut digest = Sha256::new();
    for part in [
        FONT_ADAPTER.as_bytes(),
        content_key.as_bytes(),
        environment.fingerprint.as_bytes(),
        environment.browser.as_bytes(),
        include_bytes!("../../assets/wallpaper-font-probe.js"),
        metadata.as_slice(),
        input.media.entry.mime.as_deref().unwrap_or("").as_bytes(),
    ] {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part);
    }
    Ok(Key {
        digest: format!("{:x}", digest.finalize()),
        content: input.media.entry.sha256.clone(),
        environment: environment.fingerprint.clone(),
        adapter: FONT_ADAPTER,
    })
}

fn check_font_metadata(input: &FontInput) -> Result<()> {
    // The parsed facts and file pin must still belong to the original input.
    font_prepare::content_key(input)?;
    font_prepare::ensure_native_format(input.metadata.format)?;
    let metadata = &input.metadata;
    let bytes = input.media.entry.bytes;
    let cost = bytes
        .checked_add(
            metadata
                .sfnt_bytes
                .checked_mul(4)
                .ok_or_else(|| JobError::invalid_input("字体成本溢出"))?,
        )
        .and_then(|cost| cost.checked_add(u64::from(metadata.glyph_count) * 64))
        .and_then(|cost| cost.checked_add(4096));
    if bytes == 0
        || bytes > font_prepare::MAX_FONT_BYTES
        || bytes != metadata.sfnt_bytes
        || input.media.entry.mime.as_deref() != Some(metadata.format.mime())
        || metadata.glyph_count == 0
        || metadata.glyph_count > u32::from(u16::MAX)
        || cost != Some(metadata.cpu_budget_bytes)
        || metadata.probe_text.is_empty()
        || metadata.probe_text.chars().count() > 32
    {
        return Err(JobError::new(
            "font_invalid",
            "字体准备事实与固定字节或受限探测不一致",
        ));
    }
    Ok(())
}

async fn hit(library: &Library, key: &Key, now: i64) -> Result<bool> {
    // 缓存也不跨时钟倒退复用；索引不是跨环境、永久可播的声明。
    let result = sqlx::query("UPDATE media_qualifications SET last_used = ? WHERE cache_key = ? AND content_hash = ? AND environment_hash = ? AND adapter_version = ? AND qualified_at BETWEEN ? AND ?")
        .bind(now).bind(&key.digest).bind(&key.content).bind(&key.environment).bind(key.adapter).bind(now.saturating_sub(TTL)).bind(now)
        .execute(library.pool()).await.map_err(|error| JobError::database(error.to_string()))?;
    Ok(result.rows_affected() == 1)
}

async fn record(library: &Library, key: &Key, now: i64) -> Result<()> {
    record_cancellable(library, key, now, None).await
}

async fn record_cancellable(
    library: &Library,
    key: &Key,
    now: i64,
    cancel: Option<&AtomicBool>,
) -> Result<()> {
    let mut transaction = library
        .pool()
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| JobError::database(error.to_string()))?;
    if let Some(cancel) = cancel {
        cancelled(cancel)?;
    }
    sqlx::query("DELETE FROM media_qualifications WHERE qualified_at < ? OR qualified_at > ?")
        .bind(now.saturating_sub(TTL))
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|error| JobError::database(error.to_string()))?;
    sqlx::query("INSERT INTO media_qualifications VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET content_hash=excluded.content_hash, environment_hash=excluded.environment_hash, adapter_version=excluded.adapter_version, qualified_at=excluded.qualified_at, last_used=excluded.last_used")
        .bind(&key.digest).bind(&key.content).bind(&key.environment).bind(key.adapter).bind(now).bind(now)
        .execute(&mut *transaction).await.map_err(|error| JobError::database(error.to_string()))?;
    sqlx::query("DELETE FROM media_qualifications WHERE cache_key IN (SELECT cache_key FROM media_qualifications ORDER BY last_used DESC, cache_key DESC LIMIT -1 OFFSET ?)")
        .bind(CAP).execute(&mut *transaction).await.map_err(|error| JobError::database(error.to_string()))?;
    if let Some(cancel) = cancel {
        cancelled(cancel)?;
    }
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
    pub(crate) async fn qualify_font(
        &self,
        library: &Library,
        input: FontInput,
        cancel: Arc<AtomicBool>,
    ) -> Result<QualifiedFont> {
        cancelled(&cancel)?;
        check_font_metadata(&input)?;
        let environment = if self.cache_allowed() {
            self.environment().await
        } else {
            None
        };
        cancelled(&cancel)?;
        let key = environment
            .as_ref()
            .map(|env| font_key(&input, env))
            .transpose()?;
        if let (Some(key), Some(before)) = (key.as_ref(), environment.as_ref()) {
            match hit(library, key, now_secs()).await {
                Ok(true) if self.environment().await.as_ref() == Some(before) => {
                    cancelled(&cancel)?;
                    self.note_cache_hit();
                    return Ok(QualifiedFont {
                        content_key: font_prepare::content_key(&input)?,
                    });
                }
                Ok(_) => {}
                Err(error) => {
                    crate::app::log(&format!("font qualification lookup skipped: {error}"))
                }
            }
        }
        // run_font completes only after the settled-load receipt, original
        // controller Close and file-reader drain; cancellation never races it.
        let actual = self.run_font(input.clone(), Arc::clone(&cancel)).await?;
        cancelled(&cancel)?;
        if let (Some(before), Some(key)) = (environment, key) {
            if actual.browser.as_deref() == Some(before.browser.as_str())
                && self.environment().await.as_ref() == Some(&before)
            {
                cancelled(&cancel)?;
                match record_cancellable(library, &key, now_secs(), Some(&cancel)).await {
                    Ok(()) => {
                        // Successful COMMIT publishes a completed qualification.
                        // Later user-job cancellation is still handled by ImportJobs;
                        // it cannot make this return a contradictory cancelled fact.
                        return Ok(QualifiedFont {
                            content_key: font_prepare::content_key(&input)?,
                        });
                    }
                    Err(error) if error.code == "cancelled" => return Err(error),
                    Err(error) => {
                        crate::app::log(&format!("font qualification store skipped: {error}"));
                    }
                }
            } else {
                crate::app::log("font qualification environment changed; success not cached");
            }
        }
        cancelled(&cancel)?;
        Ok(QualifiedFont {
            content_key: font_prepare::content_key(&input)?,
        })
    }

    pub(crate) async fn qualify(
        &self,
        library: &Library,
        input: DecodeInput,
        cancel: Arc<AtomicBool>,
    ) -> Result<()> {
        self.qualify_with_poster(library, input, cancel, false)
            .await
            .map(|_| ())
    }

    pub(super) async fn qualify_with_poster(
        &self,
        library: &Library,
        input: DecodeInput,
        cancel: Arc<AtomicBool>,
        poster: bool,
    ) -> Result<Option<String>> {
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
        if let Some(key) = key.as_ref().filter(|_| !poster) {
            match hit(library, key, now_secs()).await {
                Ok(true) => {
                    cancelled(&cancel)?;
                    self.note_cache_hit();
                    return Ok(None);
                }
                Ok(false) => {}
                Err(error) => {
                    crate::app::log(&format!("decode qualification lookup skipped: {error}"))
                }
            }
        }
        // 此回执等待独立 controller 关闭、文件活动归零与资源配额归还。
        let actual = self.run(input, Arc::clone(&cancel), poster).await?;
        cancelled(&cancel)?;
        if let (Some(before), Some(key)) = (environment, key) {
            let after = self.environment().await;
            if actual.browser.as_deref() == Some(before.browser.as_str())
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
        cancelled(&cancel)?;
        Ok(actual.poster)
    }
}

#[cfg(test)]
#[path = "qualification_tests.rs"]
mod tests;
