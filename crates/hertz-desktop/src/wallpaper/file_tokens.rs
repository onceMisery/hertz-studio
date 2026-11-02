// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 原生文件对话框的一次性能力；页面只拿随机令牌，不携带任意本地路径。

use super::jobs::JobError;
use serde::Serialize;
use std::fs::File;
use std::path::Path;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(60);
const CAPACITY: usize = 4;
type Result<T> = std::result::Result<T, JobError>;

pub(crate) struct SelectedFile {
    pub file: File,
    pub(crate) name: String,
    bytes: u64,
}

impl SelectedFile {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
        };
        let file = File::options()
            .read(true)
            .share_mode(1)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| JobError::new("source_busy", format!("不能固定所选文件：{error}")))?;
        let metadata = file
            .metadata()
            .map_err(|error| JobError::io(error.to_string()))?;
        if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(JobError::invalid_input("选择必须是普通文件"));
        }
        hertz_wallpaper::archive::check_package_bytes(metadata.len())?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("壁纸包")
            .chars()
            .take(255)
            .collect();
        Ok(Self {
            file,
            name,
            bytes: metadata.len(),
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileTicket {
    pub file_token: String,
    pub name: String,
    pub bytes: u64,
    pub expires_in_ms: u64,
}

struct Entry {
    owner: u64,
    token: String,
    expires: Instant,
    selected: SelectedFile,
}

#[derive(Default)]
pub(crate) struct FileTokens {
    entries: Mutex<Vec<Entry>>,
    owner: AtomicU64,
}

/// Native random opaque authority shared by file tickets, settings drafts and preview leases.
pub(crate) fn random_token() -> Result<String> {
    let guid = unsafe { windows::Win32::System::Com::CoCreateGuid() }
        .map_err(|error| JobError::io(error.to_string()))?;
    Ok(format!(
        "{:08x}{:04x}{:04x}{}",
        guid.data1,
        guid.data2,
        guid.data3,
        guid.data4
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

impl FileTokens {
    pub(crate) fn is_owner(&self, owner: u64) -> bool {
        owner != 0 && self.owner.load(Ordering::Acquire) == owner
    }

    pub(crate) fn set_owner(&self, owner: u64) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.owner.store(owner, Ordering::Release);
        entries.retain(|entry| entry.owner == owner);
    }

    pub(crate) fn issue(
        &self,
        owner: u64,
        selected: SelectedFile,
        now: Instant,
    ) -> Result<FileTicket> {
        if owner == 0 {
            return Err(JobError::new(
                "settings_session_required",
                "请先打开设置中心",
            ));
        }
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !self.is_owner(owner) {
            return Err(JobError::new(
                "settings_session_required",
                "文件能力不属于当前设置会话",
            ));
        }
        entries.retain(|entry| entry.expires > now);
        if entries.len() >= CAPACITY {
            return Err(JobError::new(
                "budget_busy",
                "所选文件尚未处理，请先导入或重新打开设置中心",
            ));
        }
        let token = random_token()?;
        let ticket = FileTicket {
            file_token: token.clone(),
            name: selected.name.clone(),
            bytes: selected.bytes,
            expires_in_ms: TTL.as_millis() as u64,
        };
        entries.push(Entry {
            owner,
            token,
            expires: now + TTL,
            selected,
        });
        Ok(ticket)
    }

    pub(crate) fn consume(&self, owner: u64, token: &str, now: Instant) -> Result<SelectedFile> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        entries.retain(|entry| entry.expires > now);
        let index = entries
            .iter()
            .position(|entry| entry.owner == owner && entry.token == token)
            .ok_or_else(|| {
                JobError::new(
                    "invalid_file_token",
                    "文件令牌已过期、已使用或不属于当前设置会话",
                )
            })?;
        Ok(entries.swap_remove(index).selected)
    }

    pub(crate) fn revoke(&self, owner: u64) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if self.is_owner(owner) {
            self.owner.store(0, Ordering::Release);
        }
        entries.retain(|entry| entry.owner != owner);
    }

    pub(crate) fn prune(&self, now: Instant) {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|entry| entry.expires > now);
    }

    pub(crate) fn next_expiry(&self) -> Option<Instant> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|entry| entry.expires)
            .min()
    }
}

/// 只由设置中心的原生用户动作调用；对话框关闭不发放授权。
pub(crate) fn pick(owner_hwnd: isize) -> Result<Option<SelectedFile>> {
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetOpenFileNameW, OFN_DONTADDTORECENT, OFN_EXPLORER,
        OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    let filter: Vec<u16> = "壁纸和媒体 (*.hwpkg;*.png;*.jpg;*.jpeg;*.webp;*.mp4;*.webm)\0*.hwpkg;*.png;*.jpg;*.jpeg;*.webp;*.mp4;*.webm\0壁纸包 (*.hwpkg)\0*.hwpkg\0所有文件 (*.*)\0*.*\0\0".encode_utf16().collect();
    let title: Vec<u16> = "导入本地壁纸\0".encode_utf16().collect();
    let mut path = vec![0u16; 32768];
    let mut dialog: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    dialog.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    dialog.hwndOwner = owner_hwnd as _;
    dialog.lpstrFilter = filter.as_ptr();
    dialog.lpstrTitle = title.as_ptr();
    dialog.lpstrFile = path.as_mut_ptr();
    dialog.nMaxFile = path.len() as u32;
    dialog.Flags = OFN_DONTADDTORECENT
        | OFN_EXPLORER
        | OFN_FILEMUSTEXIST
        | OFN_NOCHANGEDIR
        | OFN_PATHMUSTEXIST;
    if unsafe { GetOpenFileNameW(&mut dialog) } == 0 {
        let error = unsafe { CommDlgExtendedError() };
        return if error == 0 {
            Ok(None)
        } else {
            Err(JobError::new(
                "file_pick_failed",
                format!("文件对话框失败：{error}"),
            ))
        };
    }
    let length = path
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(path.len());
    let path = String::from_utf16(&path[..length])
        .map_err(|_| JobError::invalid_input("所选路径无法读取"))?;
    SelectedFile::open(Path::new(&path)).map(Some)
}

#[cfg(test)]
mod tests {
    use super::super::library::tempfileish;
    use super::*;
    fn selected(path: &Path) -> SelectedFile {
        std::fs::write(path, b"package").unwrap();
        SelectedFile::open(path).unwrap()
    }

    #[test]
    fn tokens_bind_owner_are_single_use_and_hold_file_identity() {
        let root = tempfileish::temp_dir("file-token");
        let path = root.path().join("selected.hwpkg");
        let tokens = FileTokens::default();
        tokens.set_owner(1);
        let now = Instant::now();
        let ticket = tokens.issue(1, selected(&path), now).unwrap();
        assert_eq!(ticket.file_token.len(), 32);
        assert!(!ticket.file_token.contains("selected"));
        assert!(std::fs::write(&path, b"changed").is_err());
        assert!(std::fs::remove_file(&path).is_err());
        assert!(tokens.consume(2, &ticket.file_token, now).is_err());
        let file = tokens.consume(1, &ticket.file_token, now).unwrap();
        assert!(tokens.consume(1, &ticket.file_token, now).is_err());
        assert!(std::fs::write(&path, b"changed").is_err());
        drop(file);
        assert!(std::fs::write(&path, b"changed").is_ok());
    }

    #[test]
    fn late_dialog_cannot_issue_capability_after_the_owner_has_changed() {
        let root = tempfileish::temp_dir("file-token-late");
        let path = root.path().join("late.hwpkg");
        let tokens = FileTokens::default();
        tokens.set_owner(1);
        let file = selected(&path);
        tokens.set_owner(2);
        assert!(tokens.issue(1, file, Instant::now()).is_err());
        assert!(std::fs::write(&path, b"owner changed").is_ok());
    }

    #[test]
    fn expiry_and_settings_close_revoke_and_release_handles() {
        let root = tempfileish::temp_dir("file-token-expiry");
        let a = root.path().join("a.hwpkg");
        let b = root.path().join("b.hwpkg");
        let tokens = FileTokens::default();
        tokens.set_owner(1);
        let now = Instant::now();
        let ticket = tokens.issue(1, selected(&a), now).unwrap();
        tokens.prune(now + TTL);
        assert!(tokens.consume(1, &ticket.file_token, now + TTL).is_err());
        assert!(std::fs::write(&a, b"after expiry").is_ok());
        tokens.set_owner(2);
        let ticket = tokens.issue(2, selected(&b), now).unwrap();
        tokens.revoke(1);
        assert!(std::fs::write(&b, b"other owner").is_err());
        tokens.revoke(2);
        assert!(tokens.consume(2, &ticket.file_token, now).is_err());
        assert!(std::fs::write(&b, b"after close").is_ok());
    }
}
