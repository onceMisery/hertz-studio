// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! AssetStore 的持久内容配额。原包、投影、收据及未索引目录按实际文件长度计量；
//! 不淘汰用户内容。暂存峰值由单准备槽、包大小限制及剩余磁盘空间检查约束。

use std::fs::File;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;

use super::assets::{AssetStore, StagedPackage};
use super::jobs::JobError;

type Result<T> = std::result::Result<T, JobError>;
pub(crate) const CAP: u64 = 20 * 1024 * 1024 * 1024;
const REPARSE_POINT: u32 = 0x400;
const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const BACKUP_SEMANTICS: u32 = 0x0200_0000;
const MAX_ENTRIES: usize = 1_000_000;

fn io(error: impl std::fmt::Display) -> JobError {
    JobError::io(format!("内容库配额：{error}"))
}

fn checked_metadata(file: &File) -> Result<std::fs::Metadata> {
    let metadata = file.metadata().map_err(io)?;
    if metadata.file_attributes() & REPARSE_POINT != 0 {
        return Err(io("禁止符号链接、junction 和其它 reparse point"));
    }
    Ok(metadata)
}

fn pin_directory(path: &Path) -> Result<File> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(3) // 保持祖先目录身份，禁止扫描期间改名或替换。
        .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
        .open(path)
        .map_err(io)?;
    if !checked_metadata(&file)?.is_dir() {
        return Err(io("内容路径不是目录"));
    }
    Ok(file)
}

/// 有界枚举，目录句柄随栈保留；未知普通文件也计量，不跟随链接或信任 DB bytes。
fn directory_bytes(root: &Path) -> Result<u64> {
    let pin = pin_directory(root)?;
    let mut stack = vec![(std::fs::read_dir(root).map_err(io)?, pin)];
    let mut count = 0;
    let mut bytes = 0u64;
    while let Some((entries, _pin)) = stack.last_mut() {
        let Some(entry) = entries.next() else {
            stack.pop();
            continue;
        };
        let entry = entry.map_err(io)?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err(io("内容目录枚举超限"));
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(3)
            .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
            .open(entry.path())
            .map_err(io)?;
        let metadata = checked_metadata(&file)?;
        if metadata.is_dir() {
            stack.push((std::fs::read_dir(entry.path()).map_err(io)?, file));
        } else if metadata.is_file() {
            bytes = bytes
                .checked_add(metadata.len())
                .ok_or_else(|| io("大小溢出"))?;
        } else {
            return Err(io("内容库中存在非普通文件"));
        }
    }
    Ok(bytes)
}

/// 同一资产根下的导入/恢复写门，跨 AssetStore 实例有效。持有到物理退出和暂存清理。
pub(crate) struct Writer<'a> {
    store: &'a AssetStore,
    _gate: File,
    _directories: [File; 3],
}

/// Shared carrier for content writers and exclusive offline desktop maintenance.
pub(crate) fn acquire_gate(root: &Path) -> Result<File> {
    let gate = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .custom_flags(OPEN_REPARSE_POINT)
        .open(root.join(".content-writer-lock"))
        .map_err(|error| {
            if matches!(error.raw_os_error(), Some(32 | 33)) {
                JobError::new("budget_busy", "内容库正在导入或恢复，请稍后重试")
            } else {
                io(error)
            }
        })?;
    if !checked_metadata(&gate)?.is_file() {
        return Err(io("内容写门不是普通文件"));
    }
    Ok(gate)
}

impl<'a> Writer<'a> {
    pub(crate) fn acquire(store: &'a AssetStore) -> Result<Self> {
        let directories = [
            pin_directory(store.root())?,
            pin_directory(&store.root().join("packages"))?,
            pin_directory(&store.root().join("staging"))?,
        ];
        let gate = acquire_gate(store.root())?;
        Ok(Self {
            store,
            _gate: gate,
            _directories: directories,
        })
    }

    fn check_growth(&self, required: u64) -> Result<()> {
        let held = directory_bytes(&self.store.root().join("packages"))?;
        let cap = self.store.content_capacity();
        if required > cap || held > cap - required {
            return Err(JobError::new(
                "library_full",
                format!("内容库已用 {held} 字节，新增 {required} 字节超过上限 {cap}；请先显式删除不需要的作品"),
            ));
        }
        Ok(())
    }

    /// 解包/解码前预检最终新增内容；已存在的同 hash 目录不会再发布第二份。
    pub(crate) fn preflight(&self, job_id: &str, package: &StagedPackage) -> Result<()> {
        let existing = self.store.package_dir(&package.package_hash);
        if existing.try_exists().map_err(io)? {
            directory_bytes(&existing)?;
            return Ok(());
        }
        let original = std::fs::metadata(self.store.staging_dir(job_id).join("original.hwpkg"))
            .map_err(io)?
            .len();
        let required = package
            .entries
            .iter()
            .try_fold(original, |bytes, entry| {
                bytes.checked_add(entry.bytes).ok_or_else(|| io("大小溢出"))
            })?
            .checked_add(self.store.projection_receipt_bytes(package)?.len() as u64)
            .ok_or_else(|| io("大小溢出"))?;
        self.check_growth(required)
    }

    /// 最终按真实暂存内容复核，再原子改名；拒绝覆盖和配额不足均保持旧内容完整。
    pub(crate) fn publish_staging(&self, job_id: &str, package_hash: &str) -> Result<()> {
        if job_id.is_empty()
            || job_id.len() > 64
            || !job_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
            || package_hash.len() != 64
            || !package_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(JobError::invalid_input("非法内容发布路径"));
        }
        let target = self.store.package_dir(package_hash);
        if target.try_exists().map_err(io)? {
            return Err(JobError::new(
                "target_exists",
                format!("包目录已存在：{package_hash}"),
            ));
        }
        let staging = self.store.staging_dir(job_id);
        self.check_growth(directory_bytes(&staging)?)?;
        std::fs::rename(&staging, &target).map_err(io)
    }
}

#[cfg(test)]
#[path = "content_quota_tests.rs"]
mod tests;
