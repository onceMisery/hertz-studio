// SPDX-License-Identifier: MIT
//! Bounded reconciliation; keep terminal upload identities after reclaiming bytes.
use crate::{
    config::canonical_id,
    error::Result,
    model::now,
    store::{remove_if_present, Hub},
};
use std::time::{Duration, SystemTime};

pub(crate) struct Sweep {
    directory: usize,
    entries: Option<tokio::fs::ReadDir>,
}
impl Sweep {
    pub fn new() -> Self {
        Self {
            directory: 0,
            entries: None,
        }
    }
}
impl Hub {
    pub async fn maintain(&self) -> Result<()> {
        self.reconcile_publications().await?;
        sqlx::query("UPDATE releases SET state=CASE WHEN EXISTS(SELECT 1 FROM revocations v WHERE v.package_hash=releases.package_hash AND v.reason='security' AND v.effective_at<=?) THEN 'security_revoked' ELSE 'copyright_revoked' END WHERE state IN ('published','signed_pending_public','copyright_revoked') AND EXISTS(SELECT 1 FROM revocations v WHERE v.package_hash=releases.package_hash AND v.effective_at<=?)")
            .bind(now()).bind(now()).execute(&self.pool).await?;
        let mut sweep = self.maintenance.lock().await;
        sqlx::query("UPDATE uploads SET state='expired' WHERE expires_at<=? AND state IN ('reserved','receiving','ready','validating')")
            .bind(now()).execute(&self.pool).await?;
        let expired: Vec<String> = sqlx::query_scalar("SELECT id FROM uploads WHERE state IN ('expired','rejected') AND release_id IS NULL AND purged_at IS NULL AND created_at<? ORDER BY created_at,id LIMIT 128")
            .bind(now().saturating_sub(86400)).fetch_all(&self.pool).await?;
        for id in expired {
            remove_if_present(&self.object(&id, true)?).await?;
            remove_if_present(&self.object(&id, false)?).await?;
            // Never delete the operation receipt: retrying its key must not
            // allocate a second upload after the original object was collected.
            sqlx::query("UPDATE uploads SET purged_at=? WHERE id=? AND state IN ('expired','rejected') AND release_id IS NULL")
                .bind(now()).bind(id).execute(&self.pool).await?;
        }
        // Advance a retained cursor, so a large directory of live objects
        // cannot permanently starve later abandoned files. No recursive walk.
        for _ in 0..128 {
            let staging = sweep.directory == 0;
            if sweep.entries.is_none() {
                sweep.entries = Some(
                    tokio::fs::read_dir(self.config.content_directory.join(if staging {
                        "staging"
                    } else {
                        "quarantine"
                    }))
                    .await?,
                );
            }
            let Some(entries) = sweep.entries.as_mut() else {
                break;
            };
            let entry = match entries.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => {
                    sweep.entries = None;
                    sweep.directory = 1 - sweep.directory;
                    break;
                }
                Err(error) => {
                    sweep.entries = None;
                    return Err(error.into());
                }
            };
            if !entry.file_type().await?.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let suffix = if staging { ".part" } else { ".hwpk" };
            let Some(id) = name.strip_suffix(suffix) else {
                continue;
            };
            if canonical_id(id).is_err() {
                continue;
            }
            let modified = entry.metadata().await?.modified()?;
            if SystemTime::now()
                .duration_since(modified)
                .unwrap_or(Duration::ZERO)
                < Duration::from_secs(86400)
            {
                continue;
            }
            let referenced: i64 = sqlx::query_scalar("SELECT (SELECT count(*) FROM uploads WHERE id=? AND purged_at IS NULL)+(SELECT count(*) FROM releases WHERE upload_id=?)")
                .bind(id).bind(id).fetch_one(&self.pool).await?;
            if referenced == 0 {
                remove_if_present(&self.object(id, staging)?).await?;
            }
        }
        Ok(())
    }
}
