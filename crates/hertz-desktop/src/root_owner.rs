// SPDX-License-Identifier: MIT
//! Desktop-root admission precedes config.commit.lock and any data access.
//! Shared handles admit current hosts; exclusive handles admit offline upgrade
//! and recovery. Directory pins keep the canonical identity stable until drop.
use std::fs::{File, Metadata, OpenOptions};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{ensure, Context, Result};
use windows_sys::Win32::Foundation::GENERIC_READ;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_SHARE_READ, FILE_SHARE_WRITE,
};

const LOCK: &str = "desktop.root.lock";

#[derive(Debug, thiserror::Error)]
#[error("desktop_root_busy: 桌面资料正在使用或维护，请正常退出使用此目录的所有宿主后重试")]
pub(crate) struct Busy;

pub(crate) struct RootOwner {
    root: PathBuf,
    _lock: File,
    _directories: Vec<File>,
}

pub(crate) fn ordinary(metadata: &Metadata) -> Result<()> {
    ensure!(
        !metadata.file_type().is_symlink()
            && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "desktop_root_path: links and reparse points are not supported"
    );
    Ok(())
}

impl RootOwner {
    pub(crate) fn shared(root: &Path) -> Result<Arc<Self>> {
        Self::acquire(root, false)
    }

    pub(crate) fn exclusive(root: &Path) -> Result<Arc<Self>> {
        Self::acquire(root, true)
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    fn acquire(root: &Path, exclusive: bool) -> Result<Arc<Self>> {
        // Check the caller's path before canonicalization, including ancestors;
        // otherwise a junction could hide the lock's actual directory identity.
        for path in root.ancestors().filter(|path| !path.as_os_str().is_empty()) {
            match std::fs::symlink_metadata(path) {
                Ok(metadata) => ordinary(&metadata)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        if exclusive {
            ensure!(
                root.is_dir(),
                "desktop_root_missing: --desktop-root must be an existing directory"
            );
        } else {
            std::fs::create_dir_all(root).context("创建桌面资料目录")?;
        }
        let root = std::fs::canonicalize(root).context("规范化桌面资料目录")?;
        let mut directories = Vec::new();
        for path in root.ancestors() {
            let pin = OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .context("固定桌面资料目录身份")?;
            let metadata = pin.metadata()?;
            ordinary(&metadata)?;
            ensure!(metadata.is_dir(), "desktop_root_path: expected directory");
            directories.push(pin);
        }
        let path = root.join(LOCK);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) => ordinary(&metadata)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        if exclusive {
            options.share_mode(0);
        } else {
            // OPEN_ALWAYS can create the empty carrier with GENERIC_READ.
            // Every reader permits other readers, but excludes write/delete.
            options
                .access_mode(GENERIC_READ)
                .share_mode(FILE_SHARE_READ);
        }
        let file = options.open(&path).map_err(|error| {
            if matches!(error.raw_os_error(), Some(32 | 33)) {
                anyhow::Error::new(Busy)
            } else {
                anyhow::Error::new(error).context("取得桌面资料准入")
            }
        })?;
        let metadata = file.metadata()?;
        ordinary(&metadata)?;
        ensure!(
            metadata.is_file(),
            "desktop_root_path: expected regular lock file"
        );
        let owner = Arc::new(Self {
            root,
            _lock: file,
            _directories: directories,
        });
        if exclusive {
            // SQLx Drop signals its SQLite worker; physical close can happen
            // after the last PoolInner callback is dropped. Exclusive admission
            // also waits for those OS handles, including detached connections.
            probe_database_handles(owner.root())?;
        }
        Ok(owner)
    }
}

/// Read-only OS close barrier. Legacy executables must remain stopped after
/// this probe, which is released before our own SQLite connections open.
pub(crate) fn probe_database_handles(root: &Path) -> Result<()> {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let path = root.join(format!("wallpaper.db{suffix}"));
        let file = match OpenOptions::new()
            .read(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) if matches!(error.raw_os_error(), Some(5 | 32 | 33)) => {
                anyhow::bail!("desktop_legacy_busy: SQLite 文件句柄尚未关闭，请等待宿主退出；旧版或其它程序也必须保持停止")
            }
            Err(error) => return Err(error.into()),
        };
        ordinary(&file.metadata()?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::library::tempfileish;

    #[test]
    fn current_readers_exclude_maintenance_and_carrier_replacement_until_last_drop() {
        let dir = tempfileish::temp_dir("root-readers");
        let first = RootOwner::shared(dir.path()).unwrap();
        let second = RootOwner::shared(&dir.path().join(".")).unwrap();
        assert!(RootOwner::exclusive(dir.path()).err().unwrap().is::<Busy>());
        assert!(std::fs::remove_file(dir.path().join(LOCK)).is_err());
        assert!(std::fs::rename(dir.path(), dir.path().with_extension("moved")).is_err());
        drop(first);
        assert!(RootOwner::exclusive(dir.path()).is_err());
        drop(second);
        let writer = RootOwner::exclusive(dir.path()).unwrap();
        assert!(RootOwner::shared(dir.path()).err().unwrap().is::<Busy>());
        drop(writer);
        assert!(RootOwner::shared(dir.path()).is_ok());
    }

    #[test]
    fn shared_root_initialization_is_concurrent_and_junction_is_rejected() {
        let dir = tempfileish::temp_dir("root-first");
        std::thread::scope(|scope| {
            let readers: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| RootOwner::shared(dir.path()).unwrap()))
                .collect();
            let readers: Vec<_> = readers
                .into_iter()
                .map(|thread| thread.join().unwrap())
                .collect();
            assert!(RootOwner::exclusive(dir.path()).is_err());
            drop(readers);
        });
        assert!(RootOwner::exclusive(dir.path()).is_ok());
        let link = dir.path().join("alias");
        let actual = dir.path().join("real");
        std::fs::create_dir(&actual).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&actual)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(RootOwner::shared(&link)
            .err()
            .unwrap()
            .to_string()
            .contains("desktop_root_path"));
        std::fs::remove_dir(link).unwrap();
    }

    #[test]
    fn root_child_reader() {
        let Some(root) = std::env::var_os("HERTZ_ROOT_LOCK_CHILD") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let _reader = RootOwner::shared(&root).unwrap();
        std::fs::write(root.join("child.ready"), b"ready").unwrap();
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
    }

    #[test]
    fn another_process_and_abrupt_exit_obey_the_same_root_gate() {
        let dir = tempfileish::temp_dir("root-process");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "root_owner::tests::root_child_reader",
                "--nocapture",
            ])
            .env("HERTZ_ROOT_LOCK_CHILD", dir.path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        for _ in 0..100 {
            if dir.path().join("child.ready").exists() {
                break;
            }
            assert!(
                child.try_wait().unwrap().is_none(),
                "child exited before admission"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(dir.path().join("child.ready").exists());
        assert!(RootOwner::shared(dir.path()).is_ok());
        assert!(RootOwner::exclusive(dir.path()).is_err());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(RootOwner::exclusive(dir.path()).is_ok());
    }
}
