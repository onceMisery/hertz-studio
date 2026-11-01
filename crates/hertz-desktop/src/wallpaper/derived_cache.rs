// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! AssetStore 的可重建派生缓存：实际字节计账、闲置代际 LRU 与崩溃清理。
//! 目录租约拒绝 DELETE 共享；GC 必须先原子改名，不能边删边发现活动文件。
//! 写门只协调缓存发布/回收，不把运行租约或 refcount 持久化进数据库。

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use super::assets::AssetStore;
use super::jobs::{new_job_id, JobError};
use super::library::Library;

type Result<T> = std::result::Result<T, JobError>;
pub(crate) const CAP: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 50_000;
const REPARSE_POINT: u32 = 0x400;
const BACKUP_SEMANTICS: u32 = 0x0200_0000;

fn io(error: impl std::fmt::Display) -> JobError {
    JobError::io(format!("派生缓存：{error}"))
}

fn safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 只接受本模块管理的四级代际路径；DB 中的绝对路径、父目录和 ADS 均无权限。
fn generation_path(path: &Path) -> bool {
    let parts: Option<Vec<_>> = path
        .components()
        .map(|part| match part {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect();
    parts.is_some_and(|parts| {
        parts.len() == 4
            && hash(parts[0])
            && safe_token(parts[1])
            && hash(parts[2])
            && parts[3].starts_with("gen-")
            && safe_token(parts[3])
    })
}

fn metadata(path: &Path) -> Result<std::fs::Metadata> {
    let metadata = std::fs::symlink_metadata(path).map_err(io)?;
    if metadata.file_attributes() & REPARSE_POINT != 0 {
        return Err(io("禁止符号链接、junction 和其它 reparse point"));
    }
    Ok(metadata)
}

/// 检查每层，避免中间 junction 将扫描或删除导向缓存根外。
fn checked(root: &Path, relative: &Path) -> Result<PathBuf> {
    if !metadata(root)?.is_dir() {
        return Err(io("缓存根不是目录"));
    }
    let mut path = root.to_path_buf();
    for part in relative.components() {
        let Component::Normal(part) = part else {
            return Err(io("非法缓存路径"));
        };
        path.push(part);
        if !metadata(&path)?.is_dir() {
            return Err(io("缓存路径不是目录"));
        }
    }
    Ok(path)
}

/// Arc 的最后一个持有者退出后 OS 自动释放目录锁；进程崩溃不会遗留永久引用。
pub(crate) fn pin(store: &AssetStore, relative: &Path) -> Result<Arc<File>> {
    if !generation_path(relative) {
        return Err(io("非法代际路径"));
    }
    let path = checked(&store.root().join("derived"), relative)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(3) // FILE_SHARE_READ | FILE_SHARE_WRITE，明确不共享 DELETE。
        .custom_flags(BACKUP_SEMANTICS | 0x0020_0000) // OPEN_REPARSE_POINT
        .open(path)
        .map_err(io)?;
    let meta = file.metadata().map_err(io)?;
    if !meta.is_dir() || meta.file_attributes() & REPARSE_POINT != 0 {
        return Err(io("代际目录不能是 reparse point"));
    }
    Ok(Arc::new(file))
}

#[derive(Default, Debug)]
pub(crate) struct Sweep {
    pub bytes: u64,
    pub removed: usize,
}

pub(crate) struct Writer {
    root: PathBuf,
    // share_mode(0) 使其它 AssetStore/Library 实例也遵守同一写门。
    _gate: File,
}

impl Writer {
    pub(crate) fn acquire(store: &AssetStore) -> Result<Self> {
        let root = store.root().join("derived");
        checked(&root, Path::new(""))?;
        let gate = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .custom_flags(0x0020_0000) // 不跟随被替换的锁文件链接。
            .open(root.join(".writer-lock"))
            .map_err(|error| {
                if error.raw_os_error() == Some(32) {
                    JobError::new("budget_busy", "派生缓存正在发布或回收，请稍后重试")
                } else {
                    io(error)
                }
            })?;
        if gate.metadata().map_err(io)?.file_attributes() & REPARSE_POINT != 0 {
            return Err(io("缓存写门不能是 reparse point"));
        }
        Ok(Self { root, _gate: gate })
    }

    /// 在同一写门内先清无索引旧代/回收区，再按 last_used 淘汰闲置索引代际。
    /// required 是尚在 staging 的新增字节；失败不会把仍在盘上的文件算成已释放。
    pub(crate) async fn reclaim(
        &self,
        library: &Library,
        required: u64,
        cap: u64,
    ) -> Result<Sweep> {
        if required > cap {
            return Err(JobError::new("cache_full", "派生结果超过缓存容量"));
        }
        let (mut bytes, generations) = scan(&self.root)?;
        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT cache_key, path, last_used FROM derived_entries ORDER BY last_used, path LIMIT 50001")
            .fetch_all(library.pool()).await.map_err(|error| JobError::database(error.to_string()))?;
        if rows.len() > MAX_ENTRIES {
            return Err(io("派生索引枚举超限"));
        }
        let mut indexed = HashSet::new();
        for (key, path, _) in &rows {
            let path = PathBuf::from(path);
            if generation_path(&path) && generations.contains_key(&path) {
                indexed.insert(path);
            } else {
                // 改名后崩溃或缓存缺失：只修索引，绝不按 DB 的任意路径删除文件。
                forget(library, key, &path).await?;
            }
        }
        let trash = self.root.join(".trash");
        if !trash.exists() {
            std::fs::create_dir(&trash).map_err(io)?;
        }
        checked(&self.root, Path::new(".trash"))?;
        let mut removed = 0;
        // 已改名但尚未删完的目录不再允许取得租约，按实际残余字节重新计账。
        for entry in std::fs::read_dir(&trash).map_err(io)? {
            let entry = entry.map_err(io)?;
            let name = entry.file_name();
            if name
                .to_str()
                .is_some_and(|name| name.starts_with("gc-") && safe_token(name))
                && metadata(&entry.path())?.is_dir()
            {
                let held = directory_bytes(&entry.path())?;
                if std::fs::remove_dir_all(entry.path()).is_ok() {
                    bytes -= held;
                    removed += 1;
                }
            }
        }
        let mut orphans: Vec<_> = generations
            .keys()
            .filter(|path| !indexed.contains(*path))
            .collect();
        orphans.sort();
        for path in orphans {
            if let Some(deleted) = self.retire(path)? {
                if deleted {
                    bytes -= generations[path];
                    removed += 1;
                }
            }
        }
        for (key, path, _) in rows {
            if bytes <= cap - required {
                break;
            }
            let path = PathBuf::from(path);
            if indexed.contains(&path) {
                if let Some(deleted) = self.retire(&path)? {
                    if deleted {
                        bytes -= generations[&path];
                        removed += 1;
                    }
                    // 已移入回收区即不可再解析；删除失败的实际残余字节继续计账。
                    forget(library, &key, &path).await?;
                }
            }
        }
        // 删除失败可能已删除回收区的一部分，重新测量；从不乐观提前归还空间。
        bytes = directory_bytes(&self.root)?;
        if bytes > cap - required {
            return Err(JobError::new(
                "cache_full",
                "派生缓存空间不足，活动租约或无法回收的文件仍占用容量",
            ));
        }
        Ok(Sweep { bytes, removed })
    }

    fn retire(&self, relative: &Path) -> Result<Option<bool>> {
        if !generation_path(relative) {
            return Err(io("非法回收路径"));
        }
        let source = checked(&self.root, relative)?;
        let target = self
            .root
            .join(".trash")
            .join(format!("gc-{}", new_job_id()));
        // OS 将此改名与目录租约的打开互斥；失败时原代际保持完整，不能递归尝试。
        if std::fs::rename(&source, &target).is_err() {
            return Ok(None);
        }
        // 空包装目录不永久累积到 50k 枚举上限；遇到非空/仍被持有的祖先就停止。
        let mut parent = source.parent();
        while let Some(path) = parent.filter(|path| *path != self.root) {
            if std::fs::remove_dir(path).is_err() {
                break;
            }
            parent = path.parent();
        }
        Ok(Some(std::fs::remove_dir_all(target).is_ok()))
    }
}

async fn forget(library: &Library, key: &str, path: &Path) -> Result<()> {
    sqlx::query("DELETE FROM derived_entries WHERE cache_key = ? AND path = ?")
        .bind(key)
        .bind(path.to_string_lossy().as_ref())
        .execute(library.pool())
        .await
        .map_err(|error| JobError::database(error.to_string()))?;
    Ok(())
}

/// 扫描有界且不跟随任何 reparse point；未知文件计入容量但不擅自删除。
fn scan(root: &Path) -> Result<(u64, HashMap<PathBuf, u64>)> {
    checked(root, Path::new(""))?;
    let mut stack = vec![(root.to_path_buf(), PathBuf::new())];
    let mut generations = HashMap::new();
    let mut count = 0;
    let mut bytes = 0u64;
    while let Some((path, relative)) = stack.pop() {
        for entry in std::fs::read_dir(path).map_err(io)? {
            let entry = entry.map_err(io)?;
            count += 1;
            let next = relative.join(entry.file_name());
            if count > MAX_ENTRIES || next.components().count() > 6 {
                return Err(io("派生目录枚举超限"));
            }
            let meta = metadata(&entry.path())?;
            if meta.is_dir() {
                if generation_path(&next) {
                    generations.insert(next.clone(), 0);
                }
                stack.push((entry.path(), next));
            } else if meta.is_file() {
                bytes = bytes
                    .checked_add(meta.len())
                    .ok_or_else(|| io("缓存大小溢出"))?;
                let mut parent = next.parent();
                while let Some(path) = parent {
                    if let Some(held) = generations.get_mut(path) {
                        *held += meta.len();
                        break;
                    }
                    parent = path.parent();
                }
            } else {
                return Err(io("缓存中存在非普通文件"));
            }
        }
    }
    Ok((bytes, generations))
}

pub(crate) fn directory_bytes(root: &Path) -> Result<u64> {
    scan(root).map(|(bytes, _)| bytes)
}

#[cfg(test)]
#[path = "derived_cache_tests.rs"]
mod tests;
