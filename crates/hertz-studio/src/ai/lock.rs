// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 每 DataDir 一把的 AI runner 锁（技术路线 §5.5）。
//!
//! 跨平台内核文件锁（fslock：Windows `LockFileEx`、POSIX `flock`），不是
//! 「文件存在 + PID 活着」的模拟排他。每 DataDir 的服务端 AI 初始化在启动
//! 时获取一次，持有期就是进程生命周期；CapabilityService 与将来的 AiService
//! 复用它的生命周期。失锁/拿不到锁则 AI 外部对接不可用，不做恢复、不发布
//! 发现文件。适配进程不参与锁竞争——它不打开这把锁，也不打开业务数据库。

use std::path::Path;

pub(crate) const RUNNER_LOCK_FILE: &str = "ai-runner.lock";

pub struct AiRunnerLock {
    // 持有 OS 句柄本身就是为了「活着」：字段从不被读，靠进程退出释放。
    #[allow(dead_code)]
    lock: fslock::LockFile,
}

impl AiRunnerLock {
    /// 尝试获取；`Ok(None)` 表示别的进程正持有——调用方据此停用 AI 外部
    /// 对接（不发布发现文件），而不是排队等待。
    pub fn try_acquire(data_dir: &Path) -> Result<Option<Self>, std::io::Error> {
        let dir = data_dir.join("ai");
        std::fs::create_dir_all(&dir)?;
        let lock_path = dir.join(RUNNER_LOCK_FILE).to_string_lossy().to_string();
        let mut lock =
            fslock::LockFile::open(&lock_path).map_err(|e| std::io::Error::other(e.to_string()))?;
        if lock
            .try_lock()
            .map_err(|e| std::io::Error::other(e.to_string()))?
        {
            Ok(Some(Self { lock }))
        } else {
            Ok(None)
        }
    }

    /// 进程生命周期持锁：调用方必须 `std::mem::forget` 返回值（或把它
    /// Box::leak），让 OS 在进程退出时统一释放；提前 Drop 会提前放锁。
    pub fn leak(self) {
        std::mem::forget(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_in_the_same_process_fails() {
        // Windows 的 LockFileEx 按句柄排他：同进程第二个句柄也拿不到。
        let dir = std::env::temp_dir().join(format!("vmusic-ailock-{}", uuid::Uuid::new_v4()));
        let first = AiRunnerLock::try_acquire(&dir).unwrap();
        assert!(first.is_some(), "干净目录上第一把锁必须能拿到");
        let second = AiRunnerLock::try_acquire(&dir).unwrap();
        assert!(second.is_none(), "同一 DataDir 的第二把锁必须拿不到");
        // 显式释放第一把（测试进程内模拟退出），后续获取才能成功。
        drop(first);
        let third = AiRunnerLock::try_acquire(&dir).unwrap();
        assert!(third.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
