// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! One-use native output capabilities. Selecting a destination never creates it.

use std::fs::File;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

use serde::Serialize;
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
};

use super::jobs::JobError;

type Result<T> = std::result::Result<T, JobError>;
const TTL: Duration = Duration::from_secs(60);
const CAPACITY: usize = 4;

pub(crate) struct SelectedOutput {
    path: PathBuf,
    pub(crate) name: String,
    // Deny renaming every ancestor while this native capability is alive.
    _directories: Vec<File>,
}

impl SelectedOutput {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        Self::pin(path, true)
    }

    pub(super) fn pin(path: &Path, require_missing: bool) -> Result<Self> {
        validate_path(path)?;
        let parent = path.parent().ok_or_else(invalid_path)?;
        let mut directories = Vec::new();
        let mut current = PathBuf::new();
        for component in parent.components() {
            current.push(component.as_os_str());
            if matches!(component, Component::Prefix(_)) {
                continue;
            }
            let file = File::options()
                .read(true)
                .share_mode(3)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&current)
                .map_err(|_| {
                    JobError::new(
                        "output_unavailable",
                        "无法固定导出目录，请选择可写的本地目录",
                    )
                })?;
            let metadata = file.metadata().map_err(io)?;
            if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(JobError::new(
                    "invalid_output_path",
                    "导出目录不能经过链接或 junction",
                ));
            }
            directories.push(file);
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(invalid_path)?
            .to_owned();
        let path = std::fs::canonicalize(parent).map_err(io)?.join(&name);
        if require_missing {
            ensure_missing(&path)?;
        }
        Ok(Self {
            path,
            name,
            _directories: directories,
        })
    }

    pub(super) fn path(&self) -> &Path {
        &self.path
    }
}

pub(super) fn ensure_missing(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Err(JobError::new(
            "target_exists",
            "目标已存在，请选择新的文件名；导出不会覆盖文件",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(JobError::new("output_unavailable", "无法检查导出位置")),
    }
}

fn validate_path(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(invalid_path());
    }
    let mut components = path.components();
    match components.next() {
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) => {}
        _ => {
            return Err(JobError::new(
                "invalid_output_path",
                "请选择本地磁盘上的导出位置",
            ))
        }
    }
    if !matches!(components.next(), Some(Component::RootDir)) {
        return Err(invalid_path());
    }
    let mut count = 0;
    for component in components {
        let Component::Normal(name) = component else {
            return Err(invalid_path());
        };
        let name = name.to_str().ok_or_else(invalid_path)?;
        if name.is_empty()
            || name.encode_utf16().count() > 255
            || name.ends_with(['.', ' '])
            || name
                .chars()
                .any(|ch| ch.is_control() || "<>:\"/\\|?*".contains(ch))
        {
            return Err(invalid_path());
        }
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(
                &stem[3..],
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            ))
        {
            return Err(invalid_path());
        }
        count += 1;
    }
    if count == 0
        || !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("hwpkg"))
    {
        return Err(JobError::new(
            "invalid_output_path",
            "导出文件名必须以 .hwpkg 结尾",
        ));
    }
    Ok(())
}

fn invalid_path() -> JobError {
    JobError::new("invalid_output_path", "导出位置不是有效的普通文件路径")
}
fn io(error: impl std::fmt::Display) -> JobError {
    JobError::io(format!("导出位置不可用：{error}"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputTicket {
    pub output_token: String,
    pub name: String,
    pub expires_in_ms: u64,
}

struct Entry {
    owner: u64,
    token: String,
    package_hash: String,
    expires: Instant,
    selected: SelectedOutput,
}

#[derive(Default)]
pub(crate) struct OutputTokens {
    entries: Mutex<Vec<Entry>>,
    owner: AtomicU64,
}

impl OutputTokens {
    pub(crate) fn is_owner(&self, owner: u64) -> bool {
        owner != 0 && self.owner.load(Ordering::Acquire) == owner
    }
    pub(crate) fn set_owner(&self, owner: u64) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        self.owner.store(owner, Ordering::Release);
        entries.retain(|entry| owner != 0 && entry.owner == owner);
    }
    pub(crate) fn issue(
        &self,
        owner: u64,
        package_hash: String,
        selected: SelectedOutput,
        now: Instant,
    ) -> Result<OutputTicket> {
        if !hertz_wallpaper::valid_sha256_hex(&package_hash) {
            return Err(JobError::invalid_input("包 hash 格式无效"));
        }
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if !self.is_owner(owner) {
            return Err(JobError::new(
                "settings_session_required",
                "导出位置不属于当前设置会话",
            ));
        }
        entries.retain(|entry| entry.expires > now);
        if entries.len() >= CAPACITY {
            return Err(JobError::new(
                "budget_busy",
                "待处理的导出位置已满，请完成导出后重试",
            ));
        }
        let token = super::file_tokens::random_token()?;
        let ticket = OutputTicket {
            output_token: token.clone(),
            name: selected.name.clone(),
            expires_in_ms: TTL.as_millis() as u64,
        };
        entries.push(Entry {
            owner,
            token,
            package_hash,
            expires: now + TTL,
            selected,
        });
        Ok(ticket)
    }
    pub(crate) fn consume(
        &self,
        owner: u64,
        token: &str,
        package_hash: &str,
        now: Instant,
    ) -> Result<SelectedOutput> {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|entry| entry.expires > now);
        let index = entries
            .iter()
            .position(|entry| {
                self.is_owner(owner)
                    && entry.owner == owner
                    && entry.token == token
                    && entry.package_hash == package_hash
            })
            .ok_or_else(|| {
                JobError::new(
                    "invalid_output_token",
                    "导出令牌已过期、已使用或不属于当前会话及版本",
                )
            })?;
        Ok(entries.swap_remove(index).selected)
    }
    #[cfg(test)]
    pub(crate) fn revoke(&self, owner: u64) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if self.is_owner(owner) {
            self.owner.store(0, Ordering::Release);
        }
        entries.retain(|entry| entry.owner != owner);
    }
    pub(crate) fn prune(&self, now: Instant) {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|entry| entry.expires > now);
    }
    pub(crate) fn next_expiry(&self) -> Option<Instant> {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|entry| entry.expires)
            .min()
    }
}

/// OFN_NOTESTFILECREATE prevents even the common dialog's writeability test file.
pub(crate) fn pick(owner_hwnd: isize, suggested_name: &str) -> Result<Option<SelectedOutput>> {
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetSaveFileNameW, OFN_DONTADDTORECENT, OFN_EXPLORER, OFN_NOCHANGEDIR,
        OFN_NOTESTFILECREATE, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    let filter: Vec<u16> = "壁纸包 (*.hwpkg)\0*.hwpkg\0\0".encode_utf16().collect();
    let title: Vec<u16> = "导出壁纸包（请选择新的文件名）\0".encode_utf16().collect();
    let extension: Vec<u16> = "hwpkg\0".encode_utf16().collect();
    let suggested: String = suggested_name
        .chars()
        .filter(|ch| !ch.is_control() && !"<>:\"/\\|?*".contains(*ch))
        .take(120)
        .collect();
    let suggested = suggested.trim_matches(['.', ' ']);
    let suggested = if suggested.is_empty() {
        "壁纸作品.hwpkg"
    } else {
        suggested
    };
    let mut path = vec![0u16; 32768];
    for (slot, unit) in path.iter_mut().zip(suggested.encode_utf16()) {
        *slot = unit;
    }
    let mut dialog: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    dialog.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    dialog.hwndOwner = owner_hwnd as _;
    dialog.lpstrFilter = filter.as_ptr();
    dialog.lpstrTitle = title.as_ptr();
    dialog.lpstrDefExt = extension.as_ptr();
    dialog.lpstrFile = path.as_mut_ptr();
    dialog.nMaxFile = path.len() as u32;
    dialog.Flags = OFN_DONTADDTORECENT
        | OFN_EXPLORER
        | OFN_NOCHANGEDIR
        | OFN_NOTESTFILECREATE
        | OFN_PATHMUSTEXIST;
    if unsafe { GetSaveFileNameW(&mut dialog) } == 0 {
        let error = unsafe { CommDlgExtendedError() };
        return if error == 0 {
            Ok(None)
        } else {
            Err(JobError::new(
                "file_pick_failed",
                format!("导出对话框失败：{error}"),
            ))
        };
    }
    let length = path
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(path.len());
    let path = String::from_utf16(&path[..length]).map_err(|_| invalid_path())?;
    SelectedOutput::open(Path::new(&path)).map(Some)
}

#[cfg(test)]
mod tests {
    use super::super::library::tempfileish;
    use super::*;

    #[test]
    fn selection_never_creates_final_and_pins_parent_until_expiry() {
        let root = tempfileish::temp_dir("output-token");
        let parent = root.path().join("destination");
        std::fs::create_dir(&parent).unwrap();
        let path = parent.join("result.hwpkg");
        let tokens = OutputTokens::default();
        tokens.set_owner(1);
        let now = Instant::now();
        let ticket = tokens
            .issue(1, "a".repeat(64), SelectedOutput::open(&path).unwrap(), now)
            .unwrap();
        assert!(!path.exists());
        assert!(std::fs::rename(&parent, root.path().join("renamed")).is_err());
        assert!(tokens
            .consume(2, &ticket.output_token, &"a".repeat(64), now)
            .is_err());
        assert!(tokens
            .consume(1, &ticket.output_token, &"b".repeat(64), now)
            .is_err());
        tokens.prune(now + TTL);
        assert!(tokens
            .consume(1, &ticket.output_token, &"a".repeat(64), now + TTL)
            .is_err());
        std::fs::rename(&parent, root.path().join("renamed")).unwrap();
    }

    #[test]
    fn tokens_are_single_use_and_late_dialog_cannot_authorize() {
        let root = tempfileish::temp_dir("output-single");
        let path = root.path().join("result.hwpkg");
        let tokens = OutputTokens::default();
        tokens.set_owner(1);
        let now = Instant::now();
        let ticket = tokens
            .issue(1, "a".repeat(64), SelectedOutput::open(&path).unwrap(), now)
            .unwrap();
        let selected = tokens
            .consume(1, &ticket.output_token, &"a".repeat(64), now)
            .unwrap();
        assert!(tokens
            .consume(1, &ticket.output_token, &"a".repeat(64), now)
            .is_err());
        tokens.set_owner(2);
        assert!(tokens.issue(1, "a".repeat(64), selected, now).is_err());
        let ticket = tokens
            .issue(2, "a".repeat(64), SelectedOutput::open(&path).unwrap(), now)
            .unwrap();
        tokens.revoke(2);
        assert!(tokens
            .consume(2, &ticket.output_token, &"a".repeat(64), now)
            .is_err());
        assert!(!path.exists());
    }

    #[test]
    fn existing_files_ads_devices_and_parent_traversal_are_rejected() {
        let root = tempfileish::temp_dir("output-path");
        let path = root.path().join("keep.hwpkg");
        std::fs::write(&path, b"keep").unwrap();
        assert_eq!(
            SelectedOutput::open(&path).err().unwrap().code,
            "target_exists"
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"keep");
        for name in [
            "file:stream.hwpkg",
            "NUL.hwpkg",
            "COM1.hwpkg",
            "file.hwpkg.",
            "../escape.hwpkg",
        ] {
            assert!(
                SelectedOutput::open(&root.path().join(name)).is_err(),
                "{name}"
            );
        }
    }

    #[test]
    fn junction_destination_is_rejected_without_creating_any_file() {
        use std::os::windows::process::CommandExt;
        let root = tempfileish::temp_dir("output-junction");
        let outside = root.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let link = root.path().join("junction");
        let result = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:HERTZ_OUTPUT_TEST_LINK -Target $env:HERTZ_OUTPUT_TEST_TARGET | Out-Null"])
            .env("HERTZ_OUTPUT_TEST_LINK", &link).env("HERTZ_OUTPUT_TEST_TARGET", &outside)
            .creation_flags(0x0800_0000).output().unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            SelectedOutput::open(&link.join("result.hwpkg"))
                .err()
                .unwrap()
                .code,
            "invalid_output_path"
        );
        assert!(!outside.join("result.hwpkg").exists());
        std::fs::remove_dir(&link).unwrap();
    }
}
