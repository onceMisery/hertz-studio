// SPDX-License-Identifier: MIT
//! Profile-scoped OS secrets with a bounded executor. No plaintext fallback.
use crate::secrets::{SecretBackend, SecretEntry};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use vmusic_lan::members::Secret;
use vmusic_lan::tls::{Fingerprint, HostIdentity};
use zeroize::Zeroize;

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("room credential operation still running")]
    Busy,
    #[error("system credential service unavailable; room credentials were not saved")]
    Unavailable,
    #[error("stored room identity is invalid; explicit identity reset is required")]
    Invalid,
    #[error("没有可重新加入的房间，请向房主获取新邀请")]
    MissingRoom,
    #[error("保存的房间记录无效或版本不受支持，请使用新邀请加入")]
    InvalidRoom,
}

impl From<CredentialError> for super::contract::RoomError {
    fn from(error: CredentialError) -> Self {
        let code = match error {
            CredentialError::MissingRoom => "room_saved_missing",
            CredentialError::InvalidRoom => "room_saved_invalid",
            CredentialError::Busy => "room_busy",
            _ => "room_credentials",
        };
        Self::new(code, error.to_string())
    }
}

const MAX_RECENT_ROOM_BYTES: usize = 2048;

/// Safe local UI summary. The credential is never part of this descriptor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecentRoom {
    pub version: u16,
    pub address: SocketAddr,
    pub fingerprint: String,
    pub room_id: uuid::Uuid,
    pub member_id: uuid::Uuid,
    pub name: String,
    pub listen: bool,
}
impl RecentRoom {
    pub fn validate(&self) -> Result<Fingerprint, CredentialError> {
        if self.version != 1
            || self.room_id.is_nil()
            || self.member_id.is_nil()
            || self.address.port() == 0
            || self.address.ip().is_unspecified()
            || self.address.ip().is_multicast()
            || vmusic_lan::members::validate_name(&self.name).is_err()
        {
            return Err(CredentialError::InvalidRoom);
        }
        Fingerprint::parse(&self.fingerprint).map_err(|_| CredentialError::InvalidRoom)
    }
    fn same_membership(&self, other: &Self) -> bool {
        self.room_id == other.room_id
            && self.member_id == other.member_id
            && self.fingerprint == other.fingerprint
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecentMembership {
    descriptor: RecentRoom,
    credential: Secret,
}

fn decode_recent(text: &str) -> Result<RecentMembership, CredentialError> {
    if text.len() > MAX_RECENT_ROOM_BYTES {
        return Err(CredentialError::InvalidRoom);
    }
    let saved: RecentMembership =
        serde_json::from_str(text).map_err(|_| CredentialError::InvalidRoom)?;
    saved.descriptor.validate()?;
    Ok(saved)
}
#[derive(Clone)]
pub struct ProfileSecrets {
    backend: Arc<dyn SecretBackend>,
    slot: Arc<Semaphore>,
    scope: String,
    identity_lock: PathBuf,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentityRecord {
    version: u16,
    certificate: String,
    private_key: String,
}
impl Drop for IdentityRecord {
    fn drop(&mut self) {
        self.private_key.zeroize();
    }
}
impl ProfileSecrets {
    pub fn new(data_dir: &Path, backend: Arc<dyn SecretBackend>) -> Self {
        let scope = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(crate::edition::DATA_DIR, data_dir.to_string_lossy()))
                    .expect("string tuple")
            )
        );
        Self {
            backend,
            slot: Arc::new(Semaphore::new(1)),
            scope,
            identity_lock: data_dir.join("room-identity.lock"),
        }
    }
    async fn execute<T: Send + 'static>(
        &self,
        operation: impl FnOnce(Arc<dyn SecretBackend>) -> Result<T, CredentialError> + Send + 'static,
    ) -> Result<T, CredentialError> {
        let permit = self
            .slot
            .clone()
            .try_acquire_owned()
            .map_err(|_| CredentialError::Busy)?;
        let backend = self.backend.clone();
        let task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            operation(backend)
        });
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .map_err(|_| CredentialError::Unavailable)?
            .map_err(|_| CredentialError::Unavailable)?
    }
    pub async fn host_identity(&self) -> Result<HostIdentity, CredentialError> {
        let key = format!("lan_host_v1_{}", self.scope);
        let lock_path = self.identity_lock.clone();
        self.execute(move |backend| {
            // Coordinate multiple service instances sharing this profile. The
            // OS write is atomic for our one credential envelope.
            let mut lock =
                fslock::LockFile::open(&lock_path).map_err(|_| CredentialError::Unavailable)?;
            if !lock.try_lock().map_err(|_| CredentialError::Unavailable)? {
                return Err(CredentialError::Busy);
            }
            let mut existing = backend
                .get(&key)
                .map_err(|_| CredentialError::Unavailable)?;
            if let Some(mut encoded) = existing.cred.take() {
                let result = decode_identity(&encoded);
                encoded.zeroize();
                return result;
            }
            let identity = HostIdentity::generate().map_err(|_| CredentialError::Unavailable)?;
            let record = IdentityRecord {
                version: 1,
                certificate: STANDARD.encode(identity.certificate_der()),
                private_key: STANDARD.encode(identity.private_key_der()),
            };
            let encoded = serde_json::to_string(&record).map_err(|_| CredentialError::Invalid)?;
            let mut entry = SecretEntry {
                cred: Some(encoded),
                device: None,
            };
            let result = backend
                .put(&key, &entry)
                .map_err(|_| CredentialError::Unavailable);
            if let Some(text) = &mut entry.cred {
                text.zeroize();
            }
            result?;
            Ok(identity)
        })
        .await
    }
    fn recent_key(&self) -> String {
        format!("lan_recent_membership_v1_{}", self.scope)
    }
    /// One OS credential envelope commits both the index and token. No token
    /// is written before a successful connection, and a failed write cannot
    /// leave an unindexed per-member credential behind.
    pub async fn save_recent(
        &self,
        descriptor: RecentRoom,
        credential: Secret,
    ) -> Result<(), CredentialError> {
        descriptor.validate()?;
        #[derive(Serialize)]
        struct Record<'a> {
            descriptor: &'a RecentRoom,
            credential: &'a str,
        }
        let encoded = zeroize::Zeroizing::new(
            serde_json::to_string(&Record {
                descriptor: &descriptor,
                credential: credential.expose(),
            })
            .map_err(|_| CredentialError::InvalidRoom)?,
        );
        if encoded.len() > MAX_RECENT_ROOM_BYTES {
            return Err(CredentialError::InvalidRoom);
        }
        let key = self.recent_key();
        self.execute(move |backend| {
            let mut entry = SecretEntry {
                cred: Some(encoded.to_string()),
                device: None,
            };
            let result = backend
                .put(&key, &entry)
                .map_err(|_| CredentialError::Unavailable);
            if let Some(text) = &mut entry.cred {
                text.zeroize();
            }
            result
        })
        .await
    }
    pub async fn load_recent(&self) -> Result<Option<(RecentRoom, Secret)>, CredentialError> {
        let key = self.recent_key();
        self.execute(move |backend| {
            let mut entry = backend
                .get(&key)
                .map_err(|_| CredentialError::Unavailable)?;
            let Some(text) = entry.cred.take() else {
                return Ok(None);
            };
            let text = zeroize::Zeroizing::new(text);
            let record = decode_recent(&text)?;
            Ok(Some((record.descriptor, record.credential)))
        })
        .await
    }
    pub async fn saved_room(&self) -> Result<Option<RecentRoom>, CredentialError> {
        Ok(self
            .load_recent()
            .await?
            .map(|(descriptor, _credential)| descriptor))
    }
    pub async fn forget_recent(&self, expected: &RecentRoom) -> Result<(), CredentialError> {
        let key = self.recent_key();
        let expected = expected.clone();
        self.execute(move |backend| {
            let mut entry = backend
                .get(&key)
                .map_err(|_| CredentialError::Unavailable)?;
            let Some(text) = entry.cred.take() else {
                return Ok(());
            };
            let text = zeroize::Zeroizing::new(text);
            let saved = decode_recent(&text)?;
            // An old task must never delete a subsequently joined membership.
            if saved.descriptor.same_membership(&expected) {
                backend
                    .delete(&key)
                    .map_err(|_| CredentialError::Unavailable)?;
            }
            Ok(())
        })
        .await
    }
}
fn decode_identity(text: &str) -> Result<HostIdentity, CredentialError> {
    if text.len() > 8192 {
        return Err(CredentialError::Invalid);
    }
    let record: IdentityRecord =
        serde_json::from_str(text).map_err(|_| CredentialError::Invalid)?;
    if record.version != 1 {
        return Err(CredentialError::Invalid);
    }
    let certificate = STANDARD
        .decode(&record.certificate)
        .map_err(|_| CredentialError::Invalid)?;
    let key = STANDARD
        .decode(&record.private_key)
        .map_err(|_| CredentialError::Invalid)?;
    HostIdentity::from_der(certificate, key).map_err(|_| CredentialError::Invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn descriptor() -> RecentRoom {
        RecentRoom {
            version: 1,
            address: "127.0.0.1:43210".parse().unwrap(),
            fingerprint: Fingerprint::of(b"host").hex(),
            room_id: uuid::Uuid::new_v4(),
            member_id: uuid::Uuid::new_v4(),
            name: "收听电脑".into(),
            listen: true,
        }
    }
    #[tokio::test]
    async fn recent_membership_restores_across_owner_restart_and_summary_has_no_secret() {
        let directory =
            std::env::temp_dir().join(format!("hertz-room-secrets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let backend = Arc::new(crate::secrets::MemoryStore::default());
        let secrets = ProfileSecrets::new(&directory, backend.clone());
        let host = secrets.host_identity().await.unwrap().fingerprint();
        assert_eq!(secrets.host_identity().await.unwrap().fingerprint(), host);
        let descriptor = descriptor();
        let credential = Secret::generate().unwrap();
        let token = credential.expose().to_owned();
        secrets
            .save_recent(descriptor.clone(), credential)
            .await
            .unwrap();
        drop(secrets);
        let restarted = ProfileSecrets::new(&directory, backend.clone());
        let (saved, credential) = restarted.load_recent().await.unwrap().unwrap();
        assert_eq!(saved, descriptor);
        assert_eq!(credential.expose(), token);
        let summary = serde_json::to_string(&restarted.saved_room().await.unwrap()).unwrap();
        assert!(!summary.contains(&token));
        assert!(!summary.contains("credential"));
        assert!(
            ProfileSecrets::new(&directory.join("other-profile"), backend)
                .saved_room()
                .await
                .unwrap()
                .is_none()
        );
        let mut another_member = descriptor.clone();
        another_member.member_id = uuid::Uuid::new_v4();
        restarted.forget_recent(&another_member).await.unwrap();
        assert_eq!(
            restarted.saved_room().await.unwrap(),
            Some(descriptor.clone())
        );
        restarted.forget_recent(&descriptor).await.unwrap();
        assert!(restarted.load_recent().await.unwrap().is_none());
        std::fs::remove_file(directory.join("room-identity.lock")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
    #[tokio::test]
    async fn replacement_is_bounded_and_failed_store_preserves_previous_membership() {
        struct Store {
            memory: crate::secrets::MemoryStore,
            fail: std::sync::atomic::AtomicBool,
        }
        impl SecretBackend for Store {
            fn put(&self, key: &str, entry: &SecretEntry) -> Result<(), String> {
                if self.fail.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("unavailable".into());
                }
                self.memory.put(key, entry)
            }
            fn get(&self, key: &str) -> Result<SecretEntry, String> {
                self.memory.get(key)
            }
            fn delete(&self, key: &str) -> Result<(), String> {
                self.memory.delete(key)
            }
        }
        let backend = Arc::new(Store {
            memory: Default::default(),
            fail: false.into(),
        });
        let secrets = ProfileSecrets::new(Path::new("recent-store-test"), backend.clone());
        let first = descriptor();
        secrets
            .save_recent(first.clone(), Secret::generate().unwrap())
            .await
            .unwrap();
        backend
            .fail
            .store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(matches!(
            secrets
                .save_recent(descriptor(), Secret::generate().unwrap())
                .await,
            Err(CredentialError::Unavailable)
        ));
        assert_eq!(secrets.saved_room().await.unwrap(), Some(first.clone()));
        backend
            .fail
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let second = descriptor();
        secrets
            .save_recent(second.clone(), Secret::generate().unwrap())
            .await
            .unwrap();
        secrets.forget_recent(&first).await.unwrap();
        assert_eq!(secrets.saved_room().await.unwrap(), Some(second));
    }
    #[tokio::test]
    async fn stored_records_reject_oversize_unknown_fields_bad_identities_and_missing_credentials()
    {
        let backend = Arc::new(crate::secrets::MemoryStore::default());
        let secrets = ProfileSecrets::new(Path::new("invalid-recent-test"), backend.clone());
        assert!(secrets.saved_room().await.unwrap().is_none());
        let valid = serde_json::json!({"descriptor": descriptor(), "credential": Secret::generate().unwrap().expose()});
        let mut invalid = Vec::new();
        for (field, value) in [
            ("version", serde_json::json!(2)),
            ("address", serde_json::json!("0.0.0.0:12345")),
            ("address", serde_json::json!("127.0.0.1:0")),
            ("fingerprint", serde_json::json!("invalid")),
            ("member_id", serde_json::json!(uuid::Uuid::nil())),
            ("room_id", serde_json::json!(uuid::Uuid::nil())),
            ("name", serde_json::json!("bad\nname")),
            ("name", serde_json::json!("文".repeat(33))),
        ] {
            let mut record = valid.clone();
            record["descriptor"][field] = value;
            invalid.push(record.to_string());
        }
        let mut unknown = valid.clone();
        unknown["extra"] = true.into();
        invalid.push(unknown.to_string());
        let mut missing = valid;
        missing.as_object_mut().unwrap().remove("credential");
        invalid.push(missing.to_string());
        invalid.push(" ".repeat(MAX_RECENT_ROOM_BYTES + 1));
        for record in invalid {
            backend
                .put(
                    &secrets.recent_key(),
                    &SecretEntry {
                        cred: Some(record),
                        device: None,
                    },
                )
                .unwrap();
            assert!(matches!(
                secrets.saved_room().await,
                Err(CredentialError::InvalidRoom)
            ));
        }
    }
}
