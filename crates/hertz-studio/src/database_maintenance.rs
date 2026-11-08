// SPDX-License-Identifier: MIT
//! Explicit offline commands; no service/window/credential bootstrap.
use std::path::PathBuf;

pub(super) fn requested(args: &[String]) -> bool {
    args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--list-upgrade-backups" | "--recover-upgrade" | "--restore-upgrade-backup"
        )
    })
}

pub(super) fn run(args: &[String]) -> anyhow::Result<serde_json::Value> {
    let mut data = None;
    let mut command = None;
    let mut backup = None;
    let mut accept = false;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        match arg.as_str() {
            "--data-dir" => {
                anyhow::ensure!(data.is_none(), "duplicate --data-dir");
                index += 1;
                data =
                    Some(PathBuf::from(args.get(index).ok_or_else(|| {
                        anyhow::anyhow!("missing --data-dir value")
                    })?));
            }
            "--list-upgrade-backups" | "--recover-upgrade" | "--restore-upgrade-backup" => {
                anyhow::ensure!(
                    command.is_none(),
                    "choose exactly one database maintenance command"
                );
                command = Some(arg.as_str());
                if arg == "--restore-upgrade-backup" {
                    index += 1;
                    backup = Some(
                        args.get(index)
                            .ok_or_else(|| anyhow::anyhow!("missing snapshot ID"))?
                            .as_str(),
                    );
                }
            }
            "--accept-data-loss" => {
                anyhow::ensure!(!accept, "duplicate --accept-data-loss");
                accept = true;
            }
            _ => anyhow::bail!("unsupported offline maintenance option: {arg}"),
        }
        index += 1;
    }
    let data = data.ok_or_else(|| {
        anyhow::anyhow!("offline database maintenance requires explicit --data-dir")
    })?;
    let command = command.ok_or_else(|| anyhow::anyhow!("missing database maintenance command"))?;
    anyhow::ensure!(
        command == "--restore-upgrade-backup" || !accept,
        "--accept-data-loss is only valid with historical restore"
    );
    anyhow::ensure!(
        command != "--restore-upgrade-backup" || accept,
        "database_restore_confirmation: 历史恢复需要 --accept-data-loss；备份后的逻辑修改将丢失"
    );
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async {
        let lock = hertz_studio::bootstrap::lock_for_maintenance(&data).await?;
        let data = lock.data_dir();
        let roots = &["stage-media/objects"];
        match command {
            "--list-upgrade-backups" => Ok(serde_json::json!({"snapshots": vmusic_store::upgrade::list(data, roots).await?})),
            "--recover-upgrade" => Ok(serde_json::json!({"status":"recovered", "snapshotId":vmusic_store::upgrade::recover(data, roots).await?})),
            _ => Ok(serde_json::json!({"status":"restored", "rescueSnapshotId":vmusic_store::upgrade::restore(data, backup.unwrap(), roots, accept).await?})),
        }
    });
    runtime.shutdown_timeout(std::time::Duration::from_secs(1));
    result
}
