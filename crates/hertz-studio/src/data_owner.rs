// SPDX-License-Identifier: MIT
//! One cooperating service per physical data directory, independent of port,
//! edition or transport. Persistent lock files are never deleted to recover.
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
#[error("data_dir_busy: 资料目录已被播放器或 DBX 服务使用，请恢复原窗口或正常退出原服务：{path}")]
pub struct Busy {
    pub path: PathBuf,
}

pub(crate) struct DataOwner {
    _file: fslock::LockFile,
}

/// Serializes admission across the two historical root names, including DBX
/// descendants. The handle lives outside either directory so Windows can rename.
pub(crate) struct LegacyMigrationGuard {
    _file: fslock::LockFile,
}

impl LegacyMigrationGuard {
    pub(crate) fn acquire(base: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(base)?;
        let mut file = fslock::LockFile::open(&base.join("hertz-data-migration.lock"))?;
        if !file.try_lock()? {
            return Err(Busy {
                path: base.to_owned(),
            }
            .into());
        }
        Ok(Self { _file: file })
    }

    pub(crate) fn for_profile(path: &Path, base: Option<&Path>) -> anyhow::Result<Option<Self>> {
        let Some(base) = base else {
            return Ok(None);
        };
        let Ok(base) = std::fs::canonicalize(base) else {
            return Ok(None);
        };
        for ancestor in path.ancestors() {
            let Some(name) = ancestor.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let historical = if cfg!(windows) {
                name.eq_ignore_ascii_case("hertz-studio")
                    || name.eq_ignore_ascii_case("mmusic-studio")
            } else {
                matches!(name, "hertz-studio" | "mmusic-studio")
            };
            if historical
                && ancestor
                    .parent()
                    .and_then(|parent| std::fs::canonicalize(parent).ok())
                    .as_ref()
                    == Some(&base)
            {
                return Self::acquire(&base).map(Some);
            }
        }
        Ok(None)
    }
}

impl DataOwner {
    pub(crate) fn acquire(data_dir: &Path) -> anyhow::Result<Self> {
        let mut file = fslock::LockFile::open(&data_dir.join("service-owner.lock"))?;
        if !file.try_lock()? {
            return Err(Busy {
                path: data_dir.to_owned(),
            }
            .into());
        }
        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn legacy_namespace_gate_blocks_admission_before_creating_destination() {
        let base = std::env::temp_dir().join(format!(
            "hertz-migration-admission-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&base).unwrap();
        let gate = LegacyMigrationGuard::acquire(&base).unwrap();
        for name in ["hertz-studio", "mmusic-studio/dbx-plugin"] {
            let result =
                crate::bootstrap::prepare_in_namespace(&base.join(name), Some(&base)).await;
            assert!(result.err().unwrap().downcast_ref::<Busy>().is_some());
            assert!(!base.join(name).exists());
        }
        drop(gate);
        let ready = crate::bootstrap::prepare_in_namespace(&base.join("hertz-studio"), Some(&base))
            .await
            .unwrap();
        drop(ready);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn exclusive_before_config_and_released_on_failed_preparation() {
        let dir = std::env::temp_dir().join(format!("hertz-data-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let first = DataOwner::acquire(&dir).unwrap();
        let result = crate::bootstrap::prepare(&dir).await;
        assert!(result.err().unwrap().downcast_ref::<Busy>().is_some());
        assert!(!dir.join("config.toml").exists());
        assert!(!dir.join("ai").exists());
        drop(first);
        std::fs::write(dir.join("config.toml"), "invalid = [").unwrap();
        assert!(crate::bootstrap::prepare(&dir).await.is_err());
        assert!(
            DataOwner::acquire(&dir).is_ok(),
            "failed config cannot strand the OS lock"
        );
        assert!(dir.join("service-owner.lock").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn existing_legacy_ai_owner_prevents_new_service_before_config() {
        let dir = std::env::temp_dir().join(format!("hertz-data-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let old = crate::ai::lock::AiRunnerLock::try_acquire(&dir)
            .unwrap()
            .unwrap();
        assert!(crate::bootstrap::prepare(&dir)
            .await
            .err()
            .unwrap()
            .downcast_ref::<Busy>()
            .is_some());
        assert!(!dir.join("config.toml").exists());
        drop(old);
        let prepared = crate::bootstrap::prepare(&dir).await.unwrap();
        assert!(DataOwner::acquire(&dir).is_err());
        drop(prepared);
        assert!(DataOwner::acquire(&dir).is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
