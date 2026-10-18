// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! `ai-discovery.json`：独立服务向适配进程公布的对接信息（技术路线 §5.5）。
//!
//! - 只由具备外部 listener（实际绑定 IPv4 `127.0.0.1`）**且**拿到 AI runner
//!   锁的独立服务发布；`0.0.0.0`、具体网卡与 IPv6 listener 不发布。
//! - 内容只有 pid、port、协议版本与两个实例 ID——**不含 token**；适配进程
//!   拿它构造 `http://127.0.0.1:<port>` 后走专用 grant 认证，发现的缺失或
//!   陈旧只意味着「未连接」，不能当成服务在线证据。
//! - 文件上限 16 KiB，原子替换（临时名 + 同目录 rename）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DISCOVERY_VERSION: i64 = 1;
pub(crate) const DISCOVERY_FILE: &str = "ai-discovery.json";
const DISCOVERY_MAX_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryDoc {
    pub version: i64,
    pub pid: u32,
    pub port: u16,
    /// 应用协议版本（`vmusic_core::PROTOCOL_VERSION`），供适配进程做兼容判断。
    pub protocol_version: String,
    pub owner_instance_id: String,
    pub server_instance_id: String,
    pub edition: String,
}

impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DiscoveryError::Unreachable(detail) => write!(f, "发现文件不可达: {detail}"),
            DiscoveryError::Malformed(detail) => write!(f, "发现文件不合法: {detail}"),
            DiscoveryError::Incompatible { found } => {
                write!(
                    f,
                    "发现文件版本不兼容: {found}（本适配器支持 {DISCOVERY_VERSION}）"
                )
            }
        }
    }
}

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join("ai").join(DISCOVERY_FILE)
}

/// `Display` 是它的真实消费点：适配进程把原因写进 stderr。
#[derive(Debug)]
pub(crate) enum DiscoveryError {
    /// 文件缺失或服务不可达——对适配进程就是「未连接」。
    Unreachable(String),
    /// 存在但读不出合法结构。
    Malformed(String),
    /// 版本不认识：明确不兼容，不默默按当前版本解释（§6.2 同一原则）。
    Incompatible { found: i64 },
}

pub fn publish(data_dir: &Path, doc: &DiscoveryDoc) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(doc).map_err(|e| format!("发现文件序列化失败: {e}"))?;
    if body.len() > DISCOVERY_MAX_BYTES {
        return Err(format!(
            "发现文件超出 {DISCOVERY_MAX_BYTES} 字节上限（{} 字节）",
            body.len()
        ));
    }
    let target = path(data_dir);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("发现目录创建失败: {e}"))?;
    }
    let tmp = target.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, &body).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("发现文件写入失败: {e}")
    })?;
    // Windows 的 rename 不能覆盖已存在目标：先移走旧文件。窗口极小且目录
    // 固定；残留最坏情况是「读不到 → 未连接」，不是错误信息。
    if target.exists() {
        let _ = std::fs::remove_file(&target);
    }
    std::fs::rename(&tmp, &target)
        .map_err(|e| format!("发现文件替换失败: {e}"))
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
}

/// 服务端主动摘除（优雅关闭时调用）。残留不会造成错误，但摘干净更好。
pub fn remove(data_dir: &Path) {
    let _ = std::fs::remove_file(path(data_dir));
}

pub(crate) fn read(data_dir: &Path) -> Result<DiscoveryDoc, DiscoveryError> {
    use std::io::Read;
    let file = std::fs::File::open(path(data_dir))
        .map_err(|e| DiscoveryError::Unreachable(e.to_string()))?;
    let mut bytes = Vec::new();
    file.take(DISCOVERY_MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| DiscoveryError::Unreachable(e.to_string()))?;
    if bytes.len() > DISCOVERY_MAX_BYTES {
        return Err(DiscoveryError::Malformed("发现文件超出字节上限".into()));
    }
    let doc: DiscoveryDoc =
        serde_json::from_slice(&bytes).map_err(|e| DiscoveryError::Malformed(e.to_string()))?;
    if doc.version != DISCOVERY_VERSION {
        return Err(DiscoveryError::Incompatible { found: doc.version });
    }
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("vmusic-aidisc-{}", uuid::Uuid::new_v4()))
    }

    fn sample(port: u16) -> DiscoveryDoc {
        DiscoveryDoc {
            version: DISCOVERY_VERSION,
            pid: 4242,
            port,
            protocol_version: "1".into(),
            owner_instance_id: "owner-1".into(),
            server_instance_id: "server-1".into(),
            edition: "standard".into(),
        }
    }

    #[test]
    fn discovery_read_enforces_the_documented_byte_limit() {
        let dir = temp_dir();
        publish(&dir, &sample(7634)).unwrap();
        let mut bytes = serde_json::to_vec(&sample(7634)).unwrap();
        bytes.resize(DISCOVERY_MAX_BYTES, b' ');
        std::fs::write(path(&dir), &bytes).unwrap();
        assert_eq!(read(&dir).unwrap(), sample(7634));
        bytes.push(b' ');
        std::fs::write(path(&dir), &bytes).unwrap();
        assert!(matches!(read(&dir), Err(DiscoveryError::Malformed(_))));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn publish_and_read_roundtrip() {
        let dir = temp_dir();
        publish(&dir, &sample(7634)).unwrap();
        let doc = read(&dir).unwrap();
        assert_eq!(doc, sample(7634));
        assert_eq!(doc.port, 7634);
        remove(&dir);
        assert!(matches!(read(&dir), Err(DiscoveryError::Unreachable(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_version_is_incompatible_not_accepted() {
        let dir = temp_dir();
        let mut doc = sample(1);
        doc.version = 99;
        publish(&dir, &doc).unwrap();
        assert!(matches!(
            read(&dir),
            Err(DiscoveryError::Incompatible { found: 99 })
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
