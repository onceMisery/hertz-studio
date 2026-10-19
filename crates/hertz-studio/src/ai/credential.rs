// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Provider-scoped storage and task credential lifecycle.
//! No model API or network client lives here. Status only projects configured;
//! legacy raw keys acquire a generation inside the same bounded storage work.
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock, Semaphore};

use crate::error::{ApiError, ApiResult};
use crate::secrets::{SecretBackend, SecretEntry};
use crate::state::AppState;

pub(crate) const ORIGIN: &str = "https://api.openai.com";
pub(crate) const BODY_BYTES: usize = 8 * 1024;
const MAX_KEY_BYTES: usize = 4096;
// A newline cannot occur in a legacy key (visible ASCII only), so a raw key can
// never be confused with an envelope, even if it happens to contain JSON.
const RECORD_PREFIX: &str = "hertz-ai-credential-v1\n";
const MAX_RECORD_BYTES: usize = MAX_KEY_BYTES * 2 + 512;
const KEYRING_TIMEOUT: Duration = Duration::from_secs(5);
// Process-wide, no queue. The blocking closure owns the permit until actual
// OS completion, including after timeout or a disconnected HTTP/RPC waiter.
static SERVICE: LazyLock<Arc<Service>> =
    LazyLock::new(|| Arc::new(Service::new(crate::secrets::backend())));

#[derive(Clone, Copy)]
struct Target {
    provider: &'static str,
    origin: &'static str,
}

impl Target {
    const OPENAI: Self = Self {
        provider: "openai",
        origin: ORIGIN,
    };

    fn from_config(config: &crate::config::AiConfig) -> Option<Self> {
        if config.provider == "stepfun" {
            super::stepfun::credential_origin(&config.origin)
                .ok()
                .map(|origin| Self {
                    provider: "stepfun",
                    origin,
                })
        } else {
            // Keep the existing OpenAI preparation entry while using a local
            // provider. Only explicit StepFun configuration changes the scope.
            Some(Self::OPENAI)
        }
    }

    fn scope(self, owner: &str) -> String {
        // Preserve the original OpenAI namespace, including legacy raw keys.
        let identity =
            serde_json::to_vec(&("v1", owner, self.provider, self.origin)).expect("string tuple");
        format!("ai_provider_cred_v1_{:x}", Sha256::digest(identity))
    }
}

pub(crate) struct Service {
    target: Option<Target>,
    backend: Arc<dyn SecretBackend>,
    slots: Arc<Semaphore>,
    lifecycle: Arc<RwLock<()>>,
    #[cfg(test)]
    pub(crate) mutation_started: tokio::sync::Notify,
}

/// Safe to persist in a task; never contains a key or its digest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CredentialIdentity {
    scope: String,
    generation: String,
}

// Deliberately no Debug, Clone or Serialize. Only an adapter can borrow the key.
pub(crate) struct ProviderCredential(String);
impl AsRef<str> for ProviderCredential {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
pub(crate) fn test_provider_credential(secret: &str) -> ProviderCredential {
    ProviderCredential(secret.into())
}

#[cfg(test)]
pub(crate) fn test_identity() -> CredentialIdentity {
    CredentialIdentity {
        scope: "openai/api.openai.com".into(),
        generation: "fixture-generation".into(),
    }
}

pub(crate) struct Lease {
    identity: CredentialIdentity,
    secret: ProviderCredential,
    _guard: OwnedRwLockReadGuard<()>,
}

impl Lease {
    pub(crate) fn identity(&self) -> CredentialIdentity {
        self.identity.clone()
    }

    /// The runner consumes this only after the guarded dispatch commit.
    pub(crate) fn into_secret(self) -> ProviderCredential {
        self.secret
    }
}

fn busy() -> ApiError {
    ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "ai_credential_busy",
        "钥匙串操作仍在执行，请稍后查询状态",
    )
}

fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "ai_credential_unavailable",
        "系统钥匙串不可用；请检查系统凭据服务后重新查询状态",
    )
}

impl Service {
    fn new(backend: Arc<dyn SecretBackend>) -> Self {
        Self {
            target: Some(Target::OPENAI),
            backend,
            slots: Arc::new(Semaphore::new(1)),
            lifecycle: Arc::new(RwLock::new(())),
            #[cfg(test)]
            mutation_started: tokio::sync::Notify::new(),
        }
    }

    pub(crate) fn configured(config: &crate::config::AiConfig) -> Arc<Self> {
        // All targets retain the same bounded OS executor and lifecycle lock.
        // Each runtime fixes its destination at startup; keys are never reused
        // across providers or between StepFun's plan and metered API paths.
        Arc::new(Self {
            target: Target::from_config(config),
            backend: SERVICE.backend.clone(),
            slots: SERVICE.slots.clone(),
            lifecycle: SERVICE.lifecycle.clone(),
            #[cfg(test)]
            mutation_started: tokio::sync::Notify::new(),
        })
    }

    #[cfg(test)]
    pub(crate) fn isolated() -> Arc<Self> {
        Self::isolated_for_config(&crate::config::AiConfig::default())
    }

    #[cfg(test)]
    pub(crate) fn isolated_for_config(config: &crate::config::AiConfig) -> Arc<Self> {
        Arc::new(Self {
            target: Target::from_config(config),
            ..Self::new(Arc::new(crate::secrets::MemoryStore::default()))
        })
    }

    async fn blocking<T: Send + 'static>(
        &self,
        timeout: Duration,
        work: impl FnOnce(Arc<dyn SecretBackend>) -> Result<T, ()> + Send + 'static,
    ) -> ApiResult<T> {
        let permit = self.slots.clone().try_acquire_owned().map_err(|_| busy())?;
        let backend = self.backend.clone();
        let work = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work(backend)
        });
        let result = tokio::time::timeout(timeout, work).await.map_err(|_| {
            ApiError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "ai_credential_timeout",
                "钥匙串操作尚未结束，保存或删除结果待确认；请稍后查询状态",
            )
        })?;
        result.ok().and_then(Result::ok).ok_or_else(unavailable)
    }

    fn exclusive(&self) -> ApiResult<OwnedRwLockWriteGuard<()>> {
        let guard = self
            .lifecycle
            .clone()
            .try_write_owned()
            .map_err(|_| busy())?;
        #[cfg(test)]
        self.mutation_started.notify_waiters();
        Ok(guard)
    }

    pub(crate) async fn snapshot(&self, owner: &str) -> ApiResult<Lease> {
        let guard = self
            .lifecycle
            .clone()
            .try_read_owned()
            .map_err(|_| busy())?;
        let target = self.target.ok_or_else(unavailable)?;
        let key = target.scope(owner);
        // The blocking owner retains the read guard after waiter loss/timeout.
        let (record, guard) = self
            .blocking(KEYRING_TIMEOUT, move |backend| {
                let record = CredentialRecord::load(backend.as_ref(), &key)?;
                Ok((record, guard))
            })
            .await?;
        let record = record.ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "ai_credential_missing",
                "尚未配置当前模型服务所需的密钥",
            )
        })?;
        Ok(Lease {
            identity: CredentialIdentity {
                scope: record.scope,
                generation: record.generation,
            },
            secret: ProviderCredential(record.api_key),
            _guard: guard,
        })
    }

    pub(crate) async fn for_dispatch(
        &self,
        owner: &str,
        expected: &CredentialIdentity,
    ) -> ApiResult<Lease> {
        let lease = self.snapshot(owner).await?;
        if &lease.identity != expected {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "ai_credential_changed",
                "任务绑定的模型服务密钥已变更，请重新创建任务",
            ));
        }
        Ok(lease)
    }

    async fn execute_locked(
        &self,
        owner: &str,
        action: Action,
        timeout: Duration,
        guard: OwnedRwLockWriteGuard<()>,
    ) -> ApiResult<CredentialStatus> {
        let target = self.target.ok_or_else(unavailable)?;
        let key = target.scope(owner);
        let configured = self
            .blocking(timeout, move |backend| {
                let _guard = guard;
                match action {
                    Action::Read => {
                        CredentialRecord::load(backend.as_ref(), &key).map(|r| r.is_some())
                    }
                    Action::Put(secret) => CredentialRecord::new(&key, secret)
                        .save(backend.as_ref())
                        .map(|()| true),
                    Action::Delete => backend.delete(&key).map(|()| false).map_err(|_| ()),
                }
            })
            .await?;
        Ok(CredentialStatus::new(target, configured))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialStatus {
    provider: &'static str,
    origin: &'static str,
    configured: bool,
}

impl CredentialStatus {
    fn new(target: Target, configured: bool) -> Self {
        Self {
            provider: target.provider,
            origin: target.origin,
            configured,
        }
    }
}

// Intentionally neither Debug nor Serialize: never echo submitted key material.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CredentialRequest {
    api_key: String,
}

impl CredentialRequest {
    pub(crate) fn parse(body: &[u8]) -> ApiResult<Self> {
        if body.len() > BODY_BYTES {
            return Err(invalid());
        }
        // Do not expose serde's diagnostic: unknown fields can contain secrets.
        let request: Self = serde_json::from_slice(body).map_err(|_| invalid())?;
        request.validate()?;
        Ok(request)
    }

    pub(crate) fn from_value(body: &serde_json::Value) -> ApiResult<Self> {
        let object = body
            .as_object()
            .filter(|object| object.len() == 1)
            .ok_or_else(invalid)?;
        let key = object
            .get("api_key")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(invalid)?;
        Self::validate_key(key)?;
        // Bound before cloning even if the RPC caller supplied a large Value.
        Ok(Self {
            api_key: key.to_owned(),
        })
    }

    fn validate(&self) -> ApiResult<()> {
        Self::validate_key(&self.api_key)
    }

    fn validate_key(key: &str) -> ApiResult<()> {
        // Reject whitespace/control bytes without guessing a provider key prefix
        // or accepting a value changed by implicit trimming.
        if key.is_empty() || key.len() > MAX_KEY_BYTES || !key.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err(invalid());
        }
        Ok(())
    }
}

fn invalid() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "ai_credential_invalid",
        "密钥请求不合法；请仅提交非空、无空白且不超过 4096 字节的 api_key",
    )
}

#[cfg(test)]
fn scope(owner: &str) -> String {
    Target::OPENAI.scope(owner)
}

// Key and generation are one :cred value. SecretBackend's :device write can
// fail after :cred succeeds; separate entries would allow mismatched versions.
// Intentionally no Debug: neither a parsed record nor its errors expose a key.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialRecord {
    version: u8,
    scope: String,
    generation: String,
    api_key: String,
}

impl CredentialRecord {
    fn new(key: &str, api_key: String) -> Self {
        Self {
            version: 1,
            scope: key.to_owned(),
            generation: uuid::Uuid::new_v4().to_string(),
            api_key,
        }
    }

    fn save(&self, backend: &dyn SecretBackend) -> Result<(), ()> {
        let json = serde_json::to_string(self).map_err(|_| ())?;
        backend
            .put(
                &self.scope,
                &SecretEntry {
                    cred: Some(format!("{RECORD_PREFIX}{json}")),
                    device: None,
                },
            )
            .map_err(|_| ())
    }

    fn load(backend: &dyn SecretBackend, key: &str) -> Result<Option<Self>, ()> {
        let entry = backend.get(key).map_err(|_| ())?;
        let Some(value) = entry.cred.filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        if value.len() > MAX_RECORD_BYTES {
            return Err(());
        }
        if let Some(json) = value.strip_prefix(RECORD_PREFIX) {
            let record: Self = serde_json::from_str(json).map_err(|_| ())?;
            let generation = uuid::Uuid::parse_str(&record.generation).map_err(|_| ())?;
            if record.version != 1
                || record.scope != key
                || generation.get_version_num() != 4
                || generation.get_variant() != uuid::Variant::RFC4122
                || generation.to_string() != record.generation
                || CredentialRequest::validate_key(&record.api_key).is_err()
            {
                return Err(());
            }
            return Ok(Some(record));
        }
        // Preserve previously saved raw keys. The single management slot covers
        // read + migration; later status reads preserve this generated identity.
        CredentialRequest::validate_key(&value).map_err(|_| ())?;
        let record = Self::new(key, value);
        record.save(backend)?;
        Ok(Some(record))
    }
}

enum Action {
    Read,
    Put(String),
    Delete,
}

#[cfg(test)]
async fn execute(
    backend: Arc<dyn SecretBackend>,
    slots: Arc<Semaphore>,
    owner: &str,
    action: Action,
    timeout: Duration,
) -> ApiResult<CredentialStatus> {
    let service = Service {
        target: Some(Target::OPENAI),
        backend,
        slots,
        lifecycle: Arc::new(RwLock::new(())),
        mutation_started: tokio::sync::Notify::new(),
    };
    let guard = service.exclusive()?;
    service.execute_locked(owner, action, timeout, guard).await
}

async fn manage(state: &Arc<AppState>, action: Action) -> ApiResult<CredentialStatus> {
    // Lifecycle locks are process-local. Only the DataDir's unique AI runner
    // may access/migrate these records, including status's legacy migration.
    // The generation consent toggle is deliberately independent of ownership.
    if !state.ai_runner_held() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "ai_locked",
            "本进程未持有 AI runner 锁，请在持锁的 Hertz 实例中管理模型密钥",
        ));
    }
    let owner = super::jobs::instance_owner(state).await?;
    let service = state.ai_runtime.credentials.clone();
    let credential_bound_provider = state.ai_runtime.provider().await.requires_credential();
    let guard = service.exclusive()?;
    if !matches!(&action, Action::Read) && credential_bound_provider {
        // The key can change after a completion's dispatch commit. Stop active
        // lyric requests before invalidating their durable tasks or writing the
        // new key, just as the stage-task owner stops its own workers.
        state.ai_emotion.cancel_active();
    }
    let state = state.clone();
    // One owner, acquired before spawning. Caller loss cannot skip invalidation
    // or strand the accepted mutation between DB cancellation and OS work.
    let work = tokio::spawn(async move {
        if !matches!(&action, Action::Read) {
            super::jobs::invalidate_credentials(&state, &owner).await?;
        }
        service
            .execute_locked(&owner, action, KEYRING_TIMEOUT, guard)
            .await
    });
    tokio::time::timeout(KEYRING_TIMEOUT, work)
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "ai_credential_timeout",
                "钥匙串操作尚未结束，保存或删除结果待确认；请稍后查询状态",
            )
        })?
        .map_err(|_| unavailable())?
}

pub(crate) async fn status(state: &Arc<AppState>) -> ApiResult<CredentialStatus> {
    manage(state, Action::Read).await
}

pub(crate) async fn put(
    state: &Arc<AppState>,
    request: CredentialRequest,
) -> ApiResult<CredentialStatus> {
    manage(state, Action::Put(request.api_key)).await
}

pub(crate) async fn delete(state: &Arc<AppState>) -> ApiResult<CredentialStatus> {
    manage(state, Action::Delete).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;
    use serde_json::json;

    #[tokio::test]
    async fn provider_and_api_path_scopes_never_reuse_or_delete_other_keys() {
        let backend = Arc::new(MemoryStore::default());
        let service = |provider: &str, origin: &str| Service {
            target: Target::from_config(&crate::config::AiConfig {
                provider: provider.into(),
                origin: origin.into(),
                model: "step-5-preview".into(),
            }),
            ..Service::new(backend.clone())
        };
        let openai = service("openai", ORIGIN);
        let stepfun = service("stepfun", "https://api.stepfun.com/v1/");
        let plan = service("stepfun", "https://api.stepfun.com/step_plan/v1");
        let mut identities = Vec::new();
        for (index, (service, key)) in [
            (&openai, "openai-fixture"),
            (&stepfun, "stepfun-fixture"),
            (&plan, "plan-fixture"),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(
                service.snapshot("owner").await.err().unwrap().code,
                "ai_credential_missing"
            );
            let status = service
                .execute_locked(
                    "owner",
                    Action::Put(key.into()),
                    KEYRING_TIMEOUT,
                    service.exclusive().unwrap(),
                )
                .await
                .unwrap();
            let value = serde_json::to_value(status).unwrap();
            assert_eq!(
                value["provider"],
                if index == 0 { "openai" } else { "stepfun" }
            );
            assert_eq!(value["origin"], service.target.unwrap().origin);
            let lease = service.snapshot("owner").await.unwrap();
            identities.push(lease.identity());
            assert_eq!(lease.into_secret().as_ref(), key);
        }
        for (service, expected) in [
            (&stepfun, &identities[0]),
            (&plan, &identities[1]),
            (&openai, &identities[2]),
        ] {
            assert_eq!(
                service
                    .for_dispatch("owner", expected)
                    .await
                    .err()
                    .unwrap()
                    .code,
                "ai_credential_changed"
            );
        }
        stepfun
            .execute_locked(
                "owner",
                Action::Delete,
                KEYRING_TIMEOUT,
                stepfun.exclusive().unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            openai
                .snapshot("owner")
                .await
                .unwrap()
                .into_secret()
                .as_ref(),
            "openai-fixture"
        );
        assert_eq!(
            plan.snapshot("owner").await.unwrap().into_secret().as_ref(),
            "plan-fixture"
        );
        // The old namespace is unchanged, so no migration can route an OpenAI
        // credential to the newly supported provider.
        let old_identity = serde_json::to_vec(&("v1", "owner", "openai", ORIGIN)).unwrap();
        assert_eq!(
            scope("owner"),
            format!("ai_provider_cred_v1_{:x}", Sha256::digest(old_identity))
        );
    }

    #[tokio::test]
    async fn invalid_provider_origin_cannot_read_or_store_a_credential() {
        let service = Service {
            target: Target::from_config(&crate::config::AiConfig {
                provider: "stepfun".into(),
                origin: "https://api.stepfun.com:9443/v1".into(),
                model: "step-5-preview".into(),
            }),
            ..Service::new(Arc::new(MemoryStore::default()))
        };
        assert_eq!(
            service.snapshot("owner").await.err().unwrap().code,
            "ai_credential_unavailable"
        );
        assert_eq!(
            service
                .execute_locked(
                    "owner",
                    Action::Put("fixture-key".into()),
                    KEYRING_TIMEOUT,
                    service.exclusive().unwrap()
                )
                .await
                .err()
                .unwrap()
                .code,
            "ai_credential_unavailable"
        );
    }

    #[test]
    fn configured_scopes_share_the_bounded_keyring_executor_and_lifecycle() {
        let openai = Service::configured(&crate::config::AiConfig::default());
        let stepfun = Service::configured(&crate::config::AiConfig {
            provider: "stepfun".into(),
            origin: "https://api.stepfun.com/step_plan/v1".into(),
            model: "step-5-preview".into(),
        });
        assert!(Arc::ptr_eq(&openai.slots, &stepfun.slots));
        assert!(Arc::ptr_eq(&openai.lifecycle, &stepfun.lifecycle));
        assert_ne!(
            openai.target.unwrap().scope("owner"),
            stepfun.target.unwrap().scope("owner")
        );
    }

    #[tokio::test]
    async fn storage_is_owner_scoped_write_only_and_delete_is_idempotent() {
        let backend: Arc<dyn SecretBackend> = Arc::new(MemoryStore::default());
        let slots = Arc::new(Semaphore::new(1));
        for (owner, action, expected) in [
            ("first", Action::Put("private-fixture".into()), true),
            ("other", Action::Read, false),
            ("first", Action::Read, true),
            ("first", Action::Delete, false),
            ("first", Action::Delete, false),
            ("first", Action::Read, false),
        ] {
            let status = execute(
                backend.clone(),
                slots.clone(),
                owner,
                action,
                KEYRING_TIMEOUT,
            )
            .await
            .unwrap();
            assert_eq!(
                serde_json::to_value(status).unwrap(),
                json!({ "provider":"openai", "origin":ORIGIN, "configured":expected })
            );
        }
        assert_ne!(scope("first"), scope("other"));
        assert!(!scope("first").contains("first"));
    }

    #[tokio::test]
    async fn saving_same_key_and_delete_recreate_always_change_generation() {
        let backend = Arc::new(MemoryStore::default());
        let slots = Arc::new(Semaphore::new(1));
        let key = scope("owner");
        let mut generations = std::collections::HashSet::new();
        for cycle in 0..3 {
            if cycle == 2 {
                execute(
                    backend.clone(),
                    slots.clone(),
                    "owner",
                    Action::Delete,
                    KEYRING_TIMEOUT,
                )
                .await
                .unwrap();
                assert!(CredentialRecord::load(backend.as_ref(), &key)
                    .unwrap()
                    .is_none());
            }
            let status = execute(
                backend.clone(),
                slots.clone(),
                "owner",
                Action::Put("synthetic-key".into()),
                KEYRING_TIMEOUT,
            )
            .await
            .unwrap();
            let record = CredentialRecord::load(backend.as_ref(), &key)
                .unwrap()
                .unwrap();
            assert!(generations.insert(record.generation.clone()));
            assert_eq!(record.api_key, "synthetic-key");
            assert_eq!(
                CredentialRecord::load(backend.as_ref(), &key)
                    .unwrap()
                    .unwrap()
                    .generation,
                record.generation,
            );
            let public = serde_json::to_value(status).unwrap();
            assert_eq!(public.as_object().unwrap().len(), 3);
            assert!(!public.to_string().contains(&record.generation));
        }
    }

    #[tokio::test]
    async fn legacy_key_migration_is_stable_and_preserves_maximum_escaped_key() {
        let backend = Arc::new(MemoryStore::default());
        let key = scope("owner");
        // Maximum JSON expansion for accepted visible ASCII keys.
        let secret = "\"".repeat(MAX_KEY_BYTES);
        backend
            .put(
                &key,
                &SecretEntry {
                    cred: Some(secret.clone()),
                    device: None,
                },
            )
            .unwrap();
        assert!(
            execute(
                backend.clone(),
                Arc::new(Semaphore::new(1)),
                "owner",
                Action::Read,
                KEYRING_TIMEOUT,
            )
            .await
            .unwrap()
            .configured
        );
        let stored = backend.get(&key).unwrap().cred.unwrap();
        assert!(stored.starts_with(RECORD_PREFIX));
        assert!(stored.len() <= MAX_RECORD_BYTES);
        let first = CredentialRecord::load(backend.as_ref(), &key)
            .unwrap()
            .unwrap();
        assert_eq!(first.api_key, secret);
        let second = CredentialRecord::load(backend.as_ref(), &key)
            .unwrap()
            .unwrap();
        assert_eq!(first.generation, second.generation);
        assert_eq!(backend.get(&key).unwrap().cred.unwrap(), stored);
    }

    #[tokio::test]
    async fn corrupt_or_transplanted_records_fail_closed_without_diagnostics() {
        let backend = Arc::new(MemoryStore::default());
        let key = scope("owner");
        let record = CredentialRecord::new(&key, "private-fixture".into());
        let valid = serde_json::to_value(&record).unwrap();
        let mut corrupt = Vec::new();
        for (field, value) in [
            ("version", json!(2)),
            ("scope", json!(scope("other"))),
            ("generation", json!(uuid::Uuid::nil().to_string())),
            ("api_key", json!("private-fixture\n")),
            ("private-fixture", json!(true)),
        ] {
            let mut value_record = valid.clone();
            value_record[field] = value;
            corrupt.push(format!("{RECORD_PREFIX}{value_record}"));
        }
        corrupt.extend([
            format!("{RECORD_PREFIX}{{\"private-fixture\":"),
            format!("{RECORD_PREFIX}{}", "x".repeat(MAX_RECORD_BYTES)),
            format!("{RECORD_PREFIX}{{\"version\":1,{}", &valid.to_string()[1..]),
        ]);
        for value in corrupt {
            backend
                .put(
                    &key,
                    &SecretEntry {
                        cred: Some(value),
                        device: None,
                    },
                )
                .unwrap();
            let error = execute(
                backend.clone(),
                Arc::new(Semaphore::new(1)),
                "owner",
                Action::Read,
                KEYRING_TIMEOUT,
            )
            .await
            .err()
            .unwrap();
            assert_eq!(error.code, "ai_credential_unavailable");
            assert!(!format!("{error:?}").contains("private-fixture"));
        }
    }

    struct PartialWriteBackend(MemoryStore);
    impl SecretBackend for PartialWriteBackend {
        fn get(&self, key: &str) -> Result<SecretEntry, String> {
            self.0.get(key)
        }
        fn put(&self, key: &str, entry: &SecretEntry) -> Result<(), String> {
            self.0.put(key, entry)?;
            Err("synthetic :device failure after :cred saved".into())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.0.delete(key)?;
            Err("synthetic :device failure after :cred deleted".into())
        }
    }

    #[tokio::test]
    async fn partial_backend_failure_cannot_pair_new_key_with_old_generation() {
        let backend = Arc::new(PartialWriteBackend(MemoryStore::default()));
        let key = scope("owner");
        let old = CredentialRecord::new(&key, "old-synthetic-key".into());
        assert!(old.save(backend.as_ref()).is_err());
        let error = execute(
            backend.clone(),
            Arc::new(Semaphore::new(1)),
            "owner",
            Action::Put("new-synthetic-key".into()),
            KEYRING_TIMEOUT,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.code, "ai_credential_unavailable");
        let new = CredentialRecord::load(backend.as_ref(), &key)
            .unwrap()
            .unwrap();
        assert_eq!(new.api_key, "new-synthetic-key");
        assert_ne!(new.generation, old.generation);
        assert!(execute(
            backend.clone(),
            Arc::new(Semaphore::new(1)),
            "owner",
            Action::Delete,
            KEYRING_TIMEOUT,
        )
        .await
        .is_err());
        assert!(CredentialRecord::load(backend.as_ref(), &key)
            .unwrap()
            .is_none());
    }

    #[test]
    fn request_rejects_unknown_fields_invalid_keys_and_never_echoes_them() {
        for body in [
            json!({"api_key":""}),
            json!({"api_key":" secret"}),
            json!({"api_key":"secret\n"}),
            json!({"api_key":"密钥"}),
            json!({"api_key":"x".repeat(MAX_KEY_BYTES+1)}),
            json!({"private-fixture":"secret"}),
            json!({"api_key":23}),
            json!({"api_key":"secret", "origin":"https://untrusted.example"}),
        ] {
            for error in [
                CredentialRequest::parse(&serde_json::to_vec(&body).unwrap())
                    .err()
                    .unwrap(),
                CredentialRequest::from_value(&body).err().unwrap(),
            ] {
                assert_eq!(error.code, "ai_credential_invalid");
                assert!(!error.message.contains("secret"));
                assert!(!error.message.contains("private-fixture"));
            }
        }
        assert!(CredentialRequest::parse(&vec![b'x'; BODY_BYTES + 1]).is_err());
        assert!(CredentialRequest::parse(br#"{"api_key":"one","api_key":"two"}"#).is_err());
        assert!(CredentialRequest::parse(br#"{"api_key":"synthetic-key"}"#).is_ok());
    }

    #[tokio::test]
    async fn dispatch_lease_rejects_old_or_foreign_identity_and_serializes_mutation() {
        let service = Service::isolated();
        let put = |key: &str| Action::Put(key.to_owned());
        service
            .execute_locked(
                "owner",
                put("first-fixture"),
                KEYRING_TIMEOUT,
                service.exclusive().unwrap(),
            )
            .await
            .unwrap();
        let lease = service.snapshot("owner").await.unwrap();
        let first = lease.identity();
        assert_eq!(
            service.exclusive().err().unwrap().code,
            "ai_credential_busy"
        );
        assert_eq!(lease.into_secret().as_ref(), "first-fixture");
        let guard = service.exclusive().unwrap();
        service
            .execute_locked("owner", put("second-fixture"), KEYRING_TIMEOUT, guard)
            .await
            .unwrap();
        assert_eq!(
            service
                .for_dispatch("owner", &first)
                .await
                .err()
                .unwrap()
                .code,
            "ai_credential_changed"
        );
        let second = service.snapshot("owner").await.unwrap().identity();
        assert_ne!(first, second);
        service
            .execute_locked(
                "other",
                put("second-fixture"),
                KEYRING_TIMEOUT,
                service.exclusive().unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            service
                .for_dispatch("other", &second)
                .await
                .err()
                .unwrap()
                .code,
            "ai_credential_changed"
        );
        service
            .execute_locked(
                "owner",
                Action::Delete,
                KEYRING_TIMEOUT,
                service.exclusive().unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            service
                .for_dispatch("owner", &second)
                .await
                .err()
                .unwrap()
                .code,
            "ai_credential_missing"
        );
    }

    struct FailedBackend;
    impl SecretBackend for FailedBackend {
        fn get(&self, _: &str) -> Result<SecretEntry, String> {
            Err("private-fixture".into())
        }
        fn put(&self, _: &str, _: &SecretEntry) -> Result<(), String> {
            Err("private-fixture".into())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Err("private-fixture".into())
        }
    }

    #[tokio::test]
    async fn backend_diagnostics_are_not_reflected() {
        for action in [
            Action::Read,
            Action::Put("private-fixture".into()),
            Action::Delete,
        ] {
            let error = execute(
                Arc::new(FailedBackend),
                Arc::new(Semaphore::new(1)),
                "owner",
                action,
                KEYRING_TIMEOUT,
            )
            .await
            .err()
            .unwrap();
            assert_eq!(error.code, "ai_credential_unavailable");
            assert!(!format!("{error:?}").contains("private-fixture"));
        }
    }

    struct HeldBackend {
        store: MemoryStore,
        started: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: std::sync::Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    }
    impl SecretBackend for HeldBackend {
        fn get(&self, key: &str) -> Result<SecretEntry, String> {
            self.store.get(key)
        }
        fn put(&self, key: &str, entry: &SecretEntry) -> Result<(), String> {
            if let Some(started) = self.started.lock().unwrap().take() {
                let _ = started.send(());
            }
            if let Some(release) = self.release.lock().unwrap().take() {
                release
                    .recv_timeout(Duration::from_secs(3))
                    .map_err(|_| "fixture deadline".to_string())?;
            }
            self.store.put(key, entry)
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.store.delete(key)
        }
    }

    #[tokio::test]
    async fn timeout_and_waiter_cancellation_retain_the_slot_until_os_work_exits() {
        for cancel_waiter in [false, true] {
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let backend: Arc<dyn SecretBackend> = Arc::new(HeldBackend {
                store: MemoryStore::default(),
                started: std::sync::Mutex::new(Some(started_tx)),
                release: std::sync::Mutex::new(Some(release_rx)),
            });
            let slots = Arc::new(Semaphore::new(1));
            let work_backend = backend.clone();
            let work_slots = slots.clone();
            let work = tokio::spawn(async move {
                execute(
                    work_backend,
                    work_slots,
                    "owner",
                    Action::Put("synthetic-key".into()),
                    if cancel_waiter {
                        KEYRING_TIMEOUT
                    } else {
                        Duration::from_millis(50)
                    },
                )
                .await
            });
            tokio::time::timeout(Duration::from_secs(1), started_rx)
                .await
                .unwrap()
                .unwrap();
            if cancel_waiter {
                work.abort();
                assert!(work.await.err().unwrap().is_cancelled());
            } else {
                assert_eq!(
                    work.await.unwrap().err().unwrap().code,
                    "ai_credential_timeout"
                );
            }
            assert_eq!(slots.available_permits(), 0);
            let error = execute(
                backend.clone(),
                slots.clone(),
                "owner",
                Action::Delete,
                KEYRING_TIMEOUT,
            )
            .await
            .err()
            .unwrap();
            assert_eq!(error.code, "ai_credential_busy");
            release_tx.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(1), async {
                while slots.available_permits() == 0 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(
                execute(backend, slots, "owner", Action::Read, KEYRING_TIMEOUT)
                    .await
                    .unwrap()
                    .configured
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rpc_validation_and_settings_never_persist_or_echo_model_keys() {
        use crate::rpc::{Call, Op, Rpc};
        // This checks the real settings SQL/filters, not file persistence. Use
        // the production migrations on one in-memory SQLite connection so the
        // assertion doesn't depend on immediate Windows temp-file deletion.
        let db = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("../../migrations").run(&db).await.unwrap();
        let (state, handle) = crate::state::tests::playback_state_with_db(db).await;
        let state = Arc::new(state);
        let rpc = Rpc::new(state.clone());
        let call = |op, path, body| Call {
            op,
            path,
            body,
            query: json!({}),
            raw: None,
            client_operation_id: None,
        };
        let error = rpc
            .call(call(
                Op::Put,
                "v1/ai/provider-credential",
                json!({"private-fixture":"secret"}),
            ))
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, "ai_credential_invalid");
        assert!(!error.message.contains("private-fixture"));
        for key in [
            "ai_provider_cred_v1_private-fixture",
            "openai_api_key",
            "ai_api_key",
        ] {
            let error = rpc
                .call(call(Op::Put, "v1/settings", json!({key:"private-fixture"})))
                .await
                .err()
                .unwrap();
            assert!(!error.message.contains("private-fixture"));
            assert!(vmusic_store::settings::get(&state.db, key)
                .await
                .unwrap()
                .is_none());
            // Even a legacy/accidental direct DB value must be filtered on read.
            vmusic_store::settings::set(&state.db, key, &json!("private-fixture"))
                .await
                .unwrap();
        }
        let public = rpc
            .call(call(Op::Get, "v1/settings", serde_json::Value::Null))
            .await
            .unwrap()
            .body;
        assert!(!public.to_string().contains("private-fixture"));
        state.audio.shutdown();
        handle.join().unwrap();
        state.db.close().await;
    }
}
