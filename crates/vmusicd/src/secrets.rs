// SPDX-License-Identifier: MIT

//! 平台凭据的密文存储抽象。
//!
//! 凭据（cookie/token 等）属于秘密，绝不进 SQLite 明文，也不进可随手拷贝的
//! 备份文件。默认后端是操作系统钥匙串（Windows Credential Manager / macOS
//! 钥匙串 / freedesktop Secret Service）；`VMUSIC_SECRETS=memory` 切到进程内
//! 存储，只用于测试与无钥匙串的 CI 环境——它是真的不持久，重启即失。
//!
//! 失败语义（计划第 7 项）：钥匙串操作失败必须向上报错，绝不静默回退到
//! SQLite 明文。启动迁移失败时保留旧数据并在日志里 ERROR，等下次启动重试。

use std::collections::HashMap;
use std::sync::Mutex;

/// 一个平台的全部秘密：CredPack JSON + 非密设备身份。设备身份本来就不是
/// 秘密，但和凭据同生共灭，一起放进钥匙串最不容易出现「cookie 清了 guid
/// 还在」这类半迁移状态。
#[derive(Debug, Clone, Default)]
pub struct SecretEntry {
    pub cred: Option<String>,
    pub device: Option<String>,
}

pub trait SecretBackend: Send + Sync {
    fn put(&self, key: &str, entry: &SecretEntry) -> Result<(), String>;
    fn get(&self, key: &str) -> Result<SecretEntry, String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

/// OS 钥匙串后端。keyring v3 按 feature 编译各平台实现。
pub struct OsKeyring;

impl SecretBackend for OsKeyring {
    fn put(&self, key: &str, entry: &SecretEntry) -> Result<(), String> {
        let store = keyring::Entry::new("mmusic-studio", &format!("{key}:cred"))
            .map_err(|e| format!("cannot open keyring entry: {e}"))?;
        match &entry.cred {
            Some(value) if !value.is_empty() => store
                .set_password(value)
                .map_err(|e| format!("keyring set failed for {key}: {e}"))?,
            _ => match store.delete_credential() {
                Ok(()) => {}
                Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(format!("keyring delete failed for {key}: {e}")),
            },
        }
        put_aux(&format!("{key}:device"), &entry.device)?;
        Ok(())
    }

    fn get(&self, key: &str) -> Result<SecretEntry, String> {
        let cred = read_entry(&format!("{key}:cred"))?;
        let device = read_entry(&format!("{key}:device"))?;
        Ok(SecretEntry { cred, device })
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        for suffix in [":cred", ":device"] {
            let entry = keyring::Entry::new("mmusic-studio", &format!("{key}{suffix}"))
                .map_err(|e| format!("cannot open keyring entry: {e}"))?;
            match entry.delete_credential() {
                Ok(()) => {}
                Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(format!("keyring delete failed for {key}: {e}")),
            }
        }
        Ok(())
    }
}

fn read_entry(name: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new("mmusic-studio", name)
        .map_err(|e| format!("cannot open keyring entry: {e}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value).filter(|v| !v.is_empty())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get failed for {name}: {e}")),
    }
}

fn put_aux(name: &str, value: &Option<String>) -> Result<(), String> {
    let entry = keyring::Entry::new("mmusic-studio", name)
        .map_err(|e| format!("cannot open keyring entry: {e}"))?;
    match value {
        Some(v) if !v.is_empty() => entry
            .set_password(v)
            .map_err(|e| format!("keyring set failed for {name}: {e}")),
        _ => match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keyring delete failed for {name}: {e}")),
        },
    }
}

/// 进程内后端：测试与 CI。数据不持久，重启即失——调用方（冒烟脚本）不得
/// 断言凭据跨重启存活；那是 OS 后端 + 真实登录的验收范围。
#[derive(Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, SecretEntry>>,
}

impl SecretBackend for MemoryStore {
    fn put(&self, key: &str, entry: &SecretEntry) -> Result<(), String> {
        self.entries
            .lock()
            .expect("memory secrets poisoned")
            .insert(key.to_string(), entry.clone());
        Ok(())
    }

    fn get(&self, key: &str) -> Result<SecretEntry, String> {
        Ok(self
            .entries
            .lock()
            .expect("memory secrets poisoned")
            .get(key)
            .cloned()
            .unwrap_or_default())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.entries
            .lock()
            .expect("memory secrets poisoned")
            .remove(key);
        Ok(())
    }
}

static BACKEND: std::sync::OnceLock<std::sync::Arc<dyn SecretBackend>> = std::sync::OnceLock::new();

#[cfg(test)]
pub fn set_backend_for_tests(b: std::sync::Arc<dyn SecretBackend>) {
    BACKEND.set(b).ok();
}

/// 进程级后端单例。`VMUSIC_SECRETS=memory` 是显式降级——使用者知道它不持久。
pub fn backend() -> std::sync::Arc<dyn SecretBackend> {
    BACKEND
        .get_or_init(
            || match std::env::var("VMUSIC_SECRETS").unwrap_or_default().as_str() {
                "memory" => {
                    tracing::warn!(
                        "VMUSIC_SECRETS=memory：凭据只存进程内，重启即失（仅限测试/CI）"
                    );
                    std::sync::Arc::new(MemoryStore::default()) as std::sync::Arc<dyn SecretBackend>
                }
                _ => std::sync::Arc::new(OsKeyring) as std::sync::Arc<dyn SecretBackend>,
            },
        )
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_backend_round_trips_and_deletes() {
        let store = MemoryStore::default();
        let entry = SecretEntry {
            cred: Some(r#"{"cookie":"a=1"}"#.into()),
            device: Some("guid-1".into()),
        };
        store.put("online_cred_netease", &entry).unwrap();
        let got = store.get("online_cred_netease").unwrap();
        assert_eq!(got.cred.as_deref(), Some(r#"{"cookie":"a=1"}"#));
        assert_eq!(got.device.as_deref(), Some("guid-1"));
        store.delete("online_cred_netease").unwrap();
        assert!(store.get("online_cred_netease").unwrap().cred.is_none());
        // 重复删除是幂等的。
        assert!(store.delete("online_cred_netease").is_ok());
    }
}
