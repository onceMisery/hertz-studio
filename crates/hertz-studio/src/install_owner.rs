// SPDX-License-Identifier: MIT
//! Windows program-directory readers exclude the local package writer.
//! The persistent carrier cannot be renamed/deleted while either side owns it.

pub(super) struct InstallOwner {
    #[cfg(windows)]
    _file: std::fs::File,
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    #[test]
    fn multiple_readers_exclude_writer_and_deletion_then_release() {
        let directory =
            std::env::temp_dir().join(format!("hertz-install-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let first = InstallOwner::in_directory(&directory).unwrap();
        let second = InstallOwner::in_directory(&directory).unwrap();
        let carrier = directory.join("hertz-install.lock");
        let writer = || {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(&carrier)
        };
        assert!(writer().is_err());
        assert!(std::fs::remove_file(&carrier).is_err());
        drop(first);
        assert!(writer().is_err());
        drop(second);
        let exclusive = writer().unwrap();
        assert!(InstallOwner::in_directory(&directory).is_err());
        drop(exclusive);
        let reader = InstallOwner::in_directory(&directory).unwrap();
        drop(reader);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn shipped_readonly_carrier_works_and_incomplete_update_blocks_admission() {
        let directory =
            std::env::temp_dir().join(format!("hertz-install-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let carrier = directory.join("hertz-install.lock");
        std::fs::write(&carrier, "").unwrap();
        let original_permissions = std::fs::metadata(&carrier).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        std::fs::set_permissions(&carrier, permissions).unwrap();
        drop(InstallOwner::in_directory(&directory).unwrap());
        std::fs::write(
            directory.join("hertz-update-incomplete.json"),
            "interrupted",
        )
        .unwrap();
        assert!(InstallOwner::in_directory(&directory)
            .err()
            .unwrap()
            .to_string()
            .contains("install_recovery_required"));
        std::fs::remove_file(directory.join("hertz-update-incomplete.json")).unwrap();
        for marker in [
            "hertz-setup-incomplete.json",
            "hertz-uninstall-incomplete.json",
        ] {
            std::fs::write(directory.join(marker), "interrupted").unwrap();
            assert!(InstallOwner::in_directory(&directory)
                .err()
                .unwrap()
                .to_string()
                .contains("install_recovery_required"));
            std::fs::remove_file(directory.join(marker)).unwrap();
            drop(InstallOwner::in_directory(&directory).unwrap());
        }
        std::fs::set_permissions(&carrier, original_permissions).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}

impl InstallOwner {
    pub(super) fn acquire() -> anyhow::Result<Self> {
        #[cfg(windows)]
        {
            let executable = std::fs::canonicalize(std::env::current_exe()?)?;
            Self::in_directory(
                executable
                    .parent()
                    .ok_or_else(|| anyhow::anyhow!("no executable directory"))?,
            )
        }
        #[cfg(not(windows))]
        {
            Ok(Self {})
        }
    }

    #[cfg(windows)]
    fn in_directory(directory: &std::path::Path) -> anyhow::Result<Self> {
        use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
        use windows_sys::Win32::Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, OPEN_ALWAYS,
        };
        let path = directory.join("hertz-install.lock");
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // OPEN_ALWAYS with read access also supports a shipped, read-only carrier.
        // Null SECURITY_ATTRIBUTES prevents inheritance. Only read sharing is
        // allowed: multiple profiles can run, but a writer/deleter cannot join.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ,
                std::ptr::null(),
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(32) {
                anyhow::bail!(
                    "install_dir_busy: 程序目录正在更新，请稍后重新打开：{}",
                    directory.display()
                );
            }
            return Err(error.into());
        }
        let file = unsafe { std::fs::File::from_raw_handle(handle) };
        for marker in [
            "hertz-setup-incomplete.json",
            "hertz-uninstall-incomplete.json",
        ] {
            if directory.join(marker).try_exists()? {
                anyhow::bail!(
                    "install_recovery_required: 程序安装或卸载未完成，请重新运行安装器完成恢复：{}",
                    directory.display()
                );
            }
        }
        if directory
            .join("hertz-update-incomplete.json")
            .try_exists()?
        {
            anyhow::bail!("install_recovery_required: 上次程序更新未完成，请运行 Update-Hertz.ps1 -InstallDir <程序目录> -Recover：{}", directory.display());
        }
        Ok(Self { _file: file })
    }
}
