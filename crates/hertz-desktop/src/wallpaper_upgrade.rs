// SPDX-License-Identifier: MIT
//! Wallpaper migration set, complete resources, and desktop admission binding.
use std::future::Future;
use std::path::Path;
use std::sync::Arc;

use anyhow::{ensure, Context, Result};
use hertz_sqlite_lifecycle::{self as lifecycle, Layout, ResourceSpec};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

use crate::config_journal::FileLock;
use crate::root_owner::RootOwner;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("migrations/wallpaper");
// This barrier is deliberately outside rollback resources. Old export intents
// must never delete external files after a database state has been restored.
const EXPORT_RESET: &str = "wallpaper-export-reset.pending";

#[cfg(test)]
mod tests;

pub(crate) fn layout() -> Layout<'static> {
    Layout {
        database: "wallpaper.db",
        kind: "hertz-wallpaper-upgrade",
        migrator: &MIGRATOR,
        resources: vec![
            ResourceSpec::directory("packages"),
            ResourceSpec::directory("staging"),
            ResourceSpec::directory("derived"),
            ResourceSpec::file("config.json"),
            ResourceSpec::directory("operations"),
        ],
        max_connections: 2,
    }
}

// Config is synchronous, and some internal callers already run inside Tokio.
// A scoped worker avoids nesting runtimes or blocking a runtime's own executor.
fn blocking<T: Send>(future: impl Future<Output = Result<T>> + Send) -> Result<T> {
    std::thread::scope(|scope| {
        scope
            .spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()?
                    .block_on(future)
            })
            .join()
            .map_err(|_| anyhow::anyhow!("wallpaper lifecycle worker failed"))?
    })
}

fn context(error: anyhow::Error) -> anyhow::Error {
    error.context("壁纸资料检查/恢复失败；中断恢复使用 --wallpaper-recover-upgrade --desktop-root <桌面资料目录>")
}

pub(crate) fn prepare(root: &Path) -> Result<Arc<RootOwner>> {
    blocking(prepare_async(root)).map_err(context)
}

async fn prepare_async(root: &Path) -> Result<Arc<RootOwner>> {
    let reader = RootOwner::shared(root)?;
    let status = lifecycle::inspect(reader.root(), &layout()).await?;
    if !status.pending || status.fresh {
        return Ok(reader);
    }
    let root = reader.root().to_owned();
    drop(reader);
    {
        let writer = RootOwner::exclusive(&root)?;
        let _commit = FileLock::acquire(writer.root())?;
        let _content = crate::wallpaper::content_quota::acquire_gate(writer.root())
            .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))?;
        // Recheck after changing admission: another host might have finished.
        let status = lifecycle::inspect(writer.root(), &layout()).await?;
        if status.pending {
            crate::root_owner::probe_database_handles(writer.root())?;
            let pool = lifecycle::open_with_options(
                writer.root(),
                &layout(),
                SqlitePoolOptions::new(),
                Some(revoke_external_recovery),
            )
            .await?;
            pool.close().await;
        }
    }
    let reader = RootOwner::shared(&root)?;
    let status = lifecycle::inspect(reader.root(), &layout()).await?;
    ensure!(
        !status.pending,
        "wallpaper_upgrade_pending: 请退出宿主后重新启动以升级壁纸资料"
    );
    Ok(reader)
}

/// Config can initialize a fresh root, but cannot migrate an existing library
/// under a shared guard. The app prepares it before any config read or write.
pub(crate) fn admit_config(root: &Path) -> Result<Arc<RootOwner>> {
    let reader = RootOwner::shared(root)?;
    blocking(async {
        let status = lifecycle::inspect(reader.root(), &layout()).await?;
        ensure!(
            !status.pending || status.fresh,
            "wallpaper_upgrade_pending: 请退出宿主后重新启动以升级壁纸资料"
        );
        Ok(reader)
    })
    .map_err(context)
}

pub(crate) async fn open_library(root: &Path) -> Result<SqlitePool> {
    let reader = prepare_async(root).await.map_err(context)?;
    let _commit = FileLock::acquire(reader.root())?;
    let status = lifecycle::inspect(reader.root(), &layout()).await?;
    ensure!(
        !status.pending || status.fresh,
        "wallpaper_upgrade_pending: 既有壁纸库需要独占升级"
    );
    let admission = Arc::clone(&reader);
    let options = SqlitePoolOptions::new().after_connect(move |_, _| {
        // SQLx stores this callback in PoolInner. Pool clones and checked-out
        // PoolConnections keep it alive even after Library is dropped.
        let admission = Arc::clone(&admission);
        Box::pin(async move {
            drop(admission);
            Ok(())
        })
    });
    let pool = lifecycle::open_with_options(
        reader.root(),
        &layout(),
        options,
        Some(revoke_external_recovery),
    )
    .await
    .map_err(context)?;
    if let Err(error) = reset_external_recovery(reader.root(), &pool).await {
        pool.close().await;
        return Err(error);
    }
    Ok(pool)
}

fn revoke_external_recovery(root: &Path) -> Result<()> {
    use std::io::Write;
    use std::os::windows::fs::OpenOptionsExt;
    let path = root.join(EXPORT_RESET);
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    crate::root_owner::ordinary(&file.metadata()?)?;
    file.write_all(b"external export recovery revoked\n")?;
    file.sync_all().context("保存外部导出恢复屏障")?;
    Ok(())
}

async fn reset_external_recovery(root: &Path, pool: &SqlitePool) -> Result<()> {
    let path = root.join(EXPORT_RESET);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            crate::root_owner::ordinary(&metadata)?;
            ensure!(
                metadata.is_file(),
                "wallpaper_export_reset: invalid barrier"
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    sqlx::query("UPDATE export_jobs SET state='failed',error='database_restored: 资料升级或恢复后，请重新选择输出位置；外部文件保持原样',target_path=NULL,temporary_path=NULL,file_identity=NULL WHERE target_path IS NOT NULL")
        .execute(pool).await?;
    // The DB commit precedes barrier removal; an interruption repeats only
    // this bounded DB update, never a file operation outside the desktop root.
    std::fs::remove_file(path)?;
    Ok(())
}

pub(crate) fn maintenance_requested(args: &[String]) -> bool {
    args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--wallpaper-list-upgrade-backups"
                | "--wallpaper-recover-upgrade"
                | "--wallpaper-restore-upgrade-backup"
        )
    })
}

pub(crate) fn maintenance(args: &[String]) -> Result<serde_json::Value> {
    let mut root = None;
    let mut command = None;
    let mut backup = None;
    let mut accept = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--desktop-root" => {
                ensure!(root.is_none(), "duplicate --desktop-root");
                index += 1;
                root = Some(std::path::PathBuf::from(
                    args.get(index).context("missing --desktop-root value")?,
                ));
            }
            "--wallpaper-list-upgrade-backups"
            | "--wallpaper-recover-upgrade"
            | "--wallpaper-restore-upgrade-backup" => {
                ensure!(
                    command.is_none(),
                    "choose exactly one wallpaper maintenance command"
                );
                command = Some(args[index].as_str());
                if args[index] == "--wallpaper-restore-upgrade-backup" {
                    index += 1;
                    backup = Some(
                        args.get(index)
                            .context("missing wallpaper snapshot ID")?
                            .as_str(),
                    );
                }
            }
            "--accept-data-loss" => {
                ensure!(!accept, "duplicate --accept-data-loss");
                accept = true;
            }
            arg => anyhow::bail!("unsupported offline wallpaper option: {arg}"),
        }
        index += 1;
    }
    let root = root.context("wallpaper maintenance requires explicit --desktop-root")?;
    ensure!(
        root.is_dir(),
        "desktop_root_missing: --desktop-root must be an existing directory"
    );
    let command = command.context("missing wallpaper maintenance command")?;
    ensure!(
        command == "--wallpaper-restore-upgrade-backup" || !accept,
        "--accept-data-loss requires historical wallpaper restore"
    );
    ensure!(command != "--wallpaper-restore-upgrade-backup" || accept, "database_restore_confirmation: 历史壁纸恢复需要 --accept-data-loss；数据库、原包与桌面配置将一起回退");
    blocking(async {
        let writer = RootOwner::exclusive(&root)?;
        let _commit = FileLock::acquire(writer.root())?;
        let _content = crate::wallpaper::content_quota::acquire_gate(writer.root())
            .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))?;
        crate::root_owner::probe_database_handles(writer.root())?;
        match command {
            "--wallpaper-list-upgrade-backups" => Ok(serde_json::json!({"snapshots":lifecycle::list(writer.root(), &layout()).await?})),
            "--wallpaper-recover-upgrade" => {
                Ok(serde_json::json!({"status":"recovered", "snapshotId":lifecycle::recover_with_hook(writer.root(), &layout(), Some(revoke_external_recovery)).await?}))
            }
            _ => {
                Ok(serde_json::json!({"status":"restored", "rescueSnapshotId":lifecycle::restore_with_hook(writer.root(), backup.unwrap(), &layout(), accept, Some(revoke_external_recovery)).await?}))
            }
        }
    }).map_err(context)
}
