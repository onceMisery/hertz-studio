// SPDX-License-Identifier: MIT
//! External requests cross a fixed native boundary; this owner never executes them.
use super::facade::{self, GrantContext};
use crate::{
    error::{unauthorized, ApiError, ApiResult},
    state::AppState,
};
use axum::http::StatusCode;
use hertz_wallpaper::external_requests::{self, Operation, Request};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

const PROOF_SECONDS: u64 = 120;
const MAX_PROOFS: usize = 256;

fn failure(code: &'static str, message: &str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, code, message)
}

pub(crate) fn operation(name: &str) -> Option<Operation> {
    match name {
        "wallpaper.catalog_get" | "wallpaper_catalog_get" => Some(Operation::Catalog),
        "wallpaper.switch_request" | "wallpaper_switch_request" => Some(Operation::Switch),
        "wallpaper.generate_request" | "wallpaper_generate_request" => Some(Operation::Generate),
        "wallpaper.request_get" | "wallpaper_request_get" => Some(Operation::Get),
        _ => None,
    }
}

pub(super) fn required_scopes(operation: Operation) -> &'static [&'static str] {
    match operation {
        Operation::Catalog => &["wallpaper:catalog_read"],
        Operation::Switch => &["wallpaper:request", "wallpaper:catalog_read"],
        Operation::Generate | Operation::Get => &["wallpaper:request"],
    }
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeBinding {
    native_pid: u32,
    native_generation: String,
    settings_generation: u64,
}

struct Proof {
    context: GrantContext,
    operation: Operation,
    operation_id: String,
    digest: String,
    deadline: Instant,
    binding: Option<NativeBinding>,
    request_id: Option<String>,
    // Read only by the Windows desktop-host confirmation path.
    #[cfg(all(windows, feature = "desktop-host"))]
    acceptance_id: Option<String>,
}

#[derive(Default)]
pub(super) struct ProofStore {
    entries: HashMap<String, Proof>,
}

impl ProofStore {
    fn prune(&mut self) {
        let now = Instant::now();
        self.entries.retain(|_, entry| now < entry.deadline);
    }

    fn reserve(&mut self, context: &GrantContext, request: &Request) -> ApiResult<String> {
        self.prune();
        let id = request
            .operation_id()
            .ok_or_else(|| failure("invalid_request", "需要申请身份"))?;
        let digest = request.digest();
        for (secret, entry) in &self.entries {
            if entry.context.grant_id == context.grant_id
                && entry.operation_id == id
                && entry.context.credential_revision == context.credential_revision
            {
                return if entry.digest == digest {
                    Ok(secret.clone())
                } else {
                    Err(failure(
                        "request_conflict",
                        "同一 operationId 的申请内容不能改变",
                    ))
                };
            }
        }
        if self.entries.len() >= MAX_PROOFS {
            return Err(failure("requests_full", "申请确认容量已满，请稍后重试"));
        }
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| failure("request_unavailable", "无法建立确认身份"))?;
        let secret: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        self.entries.insert(
            secret.clone(),
            Proof {
                context: context.clone(),
                operation: request.operation(),
                operation_id: id.into(),
                digest,
                deadline: Instant::now() + Duration::from_secs(PROOF_SECONDS),
                binding: None,
                request_id: None,
                #[cfg(all(windows, feature = "desktop-host"))]
                acceptance_id: None,
            },
        );
        Ok(secret)
    }

    fn bind(&mut self, secret: &str, binding: NativeBinding, request_id: &str) -> ApiResult<()> {
        self.prune();
        let entry = self
            .entries
            .get_mut(secret)
            .ok_or_else(|| failure("request_expired", "申请确认已到期"))?;
        if entry.binding.as_ref().is_some_and(|old| old != &binding)
            || entry
                .request_id
                .as_deref()
                .is_some_and(|old| old != request_id)
        {
            return Err(failure(
                "request_identity_mismatch",
                "申请的原生身份发生变化",
            ));
        }
        entry.binding = Some(binding);
        entry.request_id = Some(request_id.into());
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceIdentity {
    pid: u32,
    generation: String,
    server_instance_id: String,
    edition: String,
    profile_digest: String,
    user_sid: String,
    windows_session_id: u32,
}

#[cfg(all(windows, feature = "desktop-host"))]
fn service_identity(state: &AppState) -> ApiResult<ServiceIdentity> {
    use hertz_desktop_ipc::windows::{process_generation, Identity};
    let identity = Identity::current().map_err(|_| unauthorized())?;
    let profile = hertz_desktop_ipc::Profile::Standalone {
        edition: crate::edition::NAME.into(),
        data_dir: state.data_dir.to_string_lossy().into_owned(),
    }
    .normalized()
    .map_err(|_| unauthorized())?;
    Ok(ServiceIdentity {
        pid: std::process::id(),
        generation: process_generation(std::process::id()).map_err(|_| unauthorized())?,
        server_instance_id: state.server_instance_id.clone(),
        edition: crate::edition::NAME.into(),
        profile_digest: hertz_wallpaper::pairing::profile_digest(
            profile.edition(),
            profile.data_dir(),
        ),
        user_sid: identity.user_sid,
        windows_session_id: identity.windows_session_id,
    })
}

#[cfg(not(all(windows, feature = "desktop-host")))]
fn service_identity(_state: &AppState) -> ApiResult<ServiceIdentity> {
    Err(failure(
        "desktop_unavailable",
        "壁纸申请需要已打开的 Windows 桌面面板",
    ))
}

#[cfg(all(windows, feature = "desktop-host"))]
async fn deliver(payload: Value) -> ApiResult<Value> {
    tokio::task::spawn_blocking(move || {
        if crate::desktop_host::is_running() {
            crate::desktop_host::command("wallpaper.ai.request.forward", Some(payload)).map_err(
                |_| {
                    ApiError::new(
                        StatusCode::GATEWAY_TIMEOUT,
                        "request_forward_unknown",
                        "桌面转发结果尚未确认，请复用原 operationId 重试",
                    )
                },
            )
        } else {
            hertz_desktop_ipc::management::request_verified(
                &hertz_desktop_ipc::management::pipe_name(),
                &json!({"command":"wallpaper.ai.request.forward","value":payload}),
                &hertz_desktop_ipc::windows::Cancellation::new(),
                Some(Instant::now() + Duration::from_secs(5)),
                None,
            )
            .map_err(|error| {
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::ConnectionRefused
                        | std::io::ErrorKind::PermissionDenied
                ) {
                    failure("desktop_unavailable", "请打开当前服务对应的壁纸 AI 面板")
                } else {
                    ApiError::new(
                        StatusCode::GATEWAY_TIMEOUT,
                        "request_forward_unknown",
                        "桌面转发结果尚未确认，请复用原 operationId 重试",
                    )
                }
            })
        }
    })
    .await
    .map_err(|_| {
        ApiError::new(
            StatusCode::GATEWAY_TIMEOUT,
            "request_forward_unknown",
            "桌面申请转发结果尚未确认",
        )
    })?
}

#[cfg(not(all(windows, feature = "desktop-host")))]
async fn deliver(_payload: Value) -> ApiResult<Value> {
    Err(failure("desktop_unavailable", "壁纸申请仅支持 Windows"))
}

fn native_error(body: &Value) -> ApiError {
    let code = match body["error"]["code"]
        .as_str()
        .or_else(|| body["code"].as_str())
    {
        Some("request_conflict" | "ai_request_conflict") => "request_conflict",
        Some("request_expired" | "ai_request_expired") => "request_expired",
        Some("target_expired" | "target_stale" | "ai_target_changed") => "target_expired",
        Some("rate_limited" | "ai_request_rate_limit" | "ai_request_rate_limited") => {
            "rate_limited"
        }
        Some(
            "requests_full"
            | "ai_requests_full"
            | "ai_request_full"
            | "ai_request_capacity_exceeded"
            | "ai_request_frequency_capacity_exceeded"
            | "ai_request_receipt_capacity_exceeded",
        ) => "requests_full",
        Some("request_not_found" | "ai_request_not_found") => "request_not_found",
        _ => "desktop_unavailable",
    };
    failure(code, "桌面拒绝了该申请；请检查面板、目标、申请期限或容量")
}

pub(super) async fn forward(
    state: &Arc<AppState>,
    context: &GrantContext,
    name: &str,
    input: &Value,
) -> ApiResult<Value> {
    let operation =
        operation(name).ok_or_else(|| failure("invalid_request", "未登记的壁纸申请操作"))?;
    let bytes =
        serde_json::to_vec(input).map_err(|_| failure("invalid_request", "申请不是合法 JSON"))?;
    let request = external_requests::parse(operation.as_str(), &bytes)
        .map_err(|_| failure("invalid_request", "申请字段、类型或长度不合法"))?;
    let row = {
        let _lifecycle = facade::grant_lifecycle().lock().await;
        facade::current_file_grant(state, context, required_scopes(operation)).await?
    };
    let service = service_identity(state)?;
    let proof = if request.operation_id().is_some() {
        Some(
            state
                .ai_runtime
                .wallpaper_request_proofs
                .lock()
                .await
                .reserve(context, &request)?,
        )
    } else {
        None
    };
    let subject = format!(
        "{:x}",
        Sha256::digest(format!("{}\n{}", context.owner_instance_id, context.grant_id).as_bytes())
    );
    let mut label = row.label;
    while label.len() > 128 {
        label.pop();
    }
    let delivered = deliver(json!({"version":1,"service":service,"subject":subject,
        "credentialRevision":context.credential_revision,"label":label,
        "operation":name,"requestJson":String::from_utf8(bytes).map_err(|_| failure("invalid_request","申请编码错误"))?,
        "proof":proof})).await;
    let body = match delivered {
        Ok(body) => body,
        Err(error) => {
            if error.code == "desktop_unavailable" {
                if let Some(proof) = &proof {
                    state
                        .ai_runtime
                        .wallpaper_request_proofs
                        .lock()
                        .await
                        .entries
                        .remove(proof);
                }
            }
            return Err(error);
        }
    };
    if body["ok"] != true {
        if let Some(proof) = &proof {
            state
                .ai_runtime
                .wallpaper_request_proofs
                .lock()
                .await
                .entries
                .remove(proof);
        }
        return Err(native_error(&body));
    }
    {
        let _lifecycle = facade::grant_lifecycle().lock().await;
        facade::current_file_grant(state, context, required_scopes(operation)).await?;
    }
    let value = body["value"].clone();
    if let Some(proof) = proof {
        let receipt: external_requests::Receipt = serde_json::from_value(value.clone())
            .map_err(|_| failure("invalid_reply", "桌面申请回执不合法"))?;
        let binding: NativeBinding = serde_json::from_value(body["binding"].clone())
            .map_err(|_| failure("invalid_reply", "桌面申请身份不合法"))?;
        state
            .ai_runtime
            .wallpaper_request_proofs
            .lock()
            .await
            .bind(&proof, binding, &receipt.request_id)?;
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Confirmation {
    proof: String,
    request_id: String,
    digest: String,
    native_pid: u32,
    native_generation: String,
    settings_generation: u64,
}

pub(crate) async fn accept(state: &Arc<AppState>, input: Confirmation) -> ApiResult<Value> {
    if !hertz_wallpaper::pairing::hex64(&input.proof)
        || !hertz_wallpaper::pairing::hex64(&input.digest)
    {
        return Err(unauthorized());
    }
    let _lifecycle = facade::grant_lifecycle().lock().await;
    let (context, operation) = {
        let mut store = state.ai_runtime.wallpaper_request_proofs.lock().await;
        store.prune();
        let entry = store.entries.get(&input.proof).ok_or_else(unauthorized)?;
        let binding = NativeBinding {
            native_pid: input.native_pid,
            native_generation: input.native_generation.clone(),
            settings_generation: input.settings_generation,
        };
        if entry.digest != input.digest
            || entry.request_id.as_deref() != Some(input.request_id.as_str())
            || entry.binding.as_ref() != Some(&binding)
        {
            return Err(unauthorized());
        }
        (entry.context.clone(), entry.operation)
    };
    facade::current_file_grant(state, &context, required_scopes(operation)).await?;
    #[cfg(all(windows, feature = "desktop-host"))]
    if !hertz_desktop_ipc::windows::process_generation(input.native_pid)
        .is_ok_and(|generation| generation == input.native_generation)
    {
        return Err(unauthorized());
    }
    #[cfg(not(all(windows, feature = "desktop-host")))]
    return Err(failure("desktop_unavailable", "壁纸确认仅支持 Windows"));
    #[cfg(all(windows, feature = "desktop-host"))]
    {
        let mut store = state.ai_runtime.wallpaper_request_proofs.lock().await;
        store.prune();
        let entry = store
            .entries
            .get_mut(&input.proof)
            .ok_or_else(unauthorized)?;
        let acceptance = entry
            .acceptance_id
            .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();
        Ok(json!({"acceptanceId":acceptance,"requestId":input.request_id,"digest":input.digest}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str) -> Request {
        external_requests::parse(
            "generate",
            &serde_json::to_vec(&json!({"operationId":id,"brief":"quiet","outputKind":"builtin"}))
                .unwrap(),
        )
        .unwrap()
    }
    fn context() -> GrantContext {
        GrantContext {
            grant_id: "grant".into(),
            credential_revision: "a".repeat(64),
            scopes: ["wallpaper:request".into()].into_iter().collect(),
            policy_revision: 1,
            owner_instance_id: "owner".into(),
            server_instance_id: "server".into(),
        }
    }
    #[test]
    fn proofs_replay_one_identity_without_extending_deadline_and_refuse_rebinding() {
        let mut store = ProofStore::default();
        let ctx = context();
        let input = request("one");
        let proof = store.reserve(&ctx, &input).unwrap();
        let deadline = store.entries[&proof].deadline;
        assert_eq!(store.reserve(&ctx, &input).unwrap(), proof);
        assert_eq!(store.entries[&proof].deadline, deadline);
        let changed = external_requests::parse(
            "generate",
            &serde_json::to_vec(
                &json!({"operationId":"one","brief":"different","outputKind":"builtin"}),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            store.reserve(&ctx, &changed).unwrap_err().code,
            "request_conflict"
        );
        let binding = NativeBinding {
            native_pid: 7,
            native_generation: "generation".into(),
            settings_generation: 3,
        };
        store.bind(&proof, binding.clone(), "request").unwrap();
        assert!(store.bind(&proof, binding, "other-request").is_err());
        store.entries.get_mut(&proof).unwrap().deadline = Instant::now();
        assert_eq!(
            store
                .bind(
                    &proof,
                    NativeBinding {
                        native_pid: 7,
                        native_generation: "generation".into(),
                        settings_generation: 3
                    },
                    "request"
                )
                .unwrap_err()
                .code,
            "request_expired"
        );
    }

    #[cfg(all(windows, feature = "desktop-host"))]
    #[tokio::test]
    async fn confirmation_rechecks_grant_then_returns_one_frozen_acceptance() {
        let dir =
            std::env::temp_dir().join(format!("hertz-external-accept-{}", uuid::Uuid::new_v4()));
        let db = vmusic_store::open(&dir).await.unwrap();
        let (mut state, audio) = crate::state::tests::playback_state_with_db(db).await;
        state.data_dir = dir;
        let state = Arc::new(state);
        let grant = facade::create_grant(&state, "external", &["wallpaper:request".into()])
            .await
            .unwrap();
        let secret = std::fs::read_to_string(&grant.credential_path).unwrap();
        let ctx = facade::authenticate(&state, &secret).await.unwrap();
        let request = request("confirmed");
        let binding = NativeBinding {
            native_pid: std::process::id(),
            native_generation: hertz_desktop_ipc::windows::process_generation(std::process::id())
                .unwrap(),
            settings_generation: 11,
        };
        let proof = state
            .ai_runtime
            .wallpaper_request_proofs
            .lock()
            .await
            .reserve(&ctx, &request)
            .unwrap();
        state
            .ai_runtime
            .wallpaper_request_proofs
            .lock()
            .await
            .bind(&proof, binding.clone(), "request")
            .unwrap();
        let confirmation = || Confirmation {
            proof: proof.clone(),
            request_id: "request".into(),
            digest: request.digest(),
            native_pid: binding.native_pid,
            native_generation: binding.native_generation.clone(),
            settings_generation: binding.settings_generation,
        };
        let accepted = accept(&state, confirmation()).await.unwrap();
        assert_eq!(accept(&state, confirmation()).await.unwrap(), accepted);
        let mut wrong = confirmation();
        wrong.settings_generation += 1;
        assert!(accept(&state, wrong).await.is_err());
        facade::revoke_grant(&state, &grant.grant_id).await.unwrap();
        assert!(accept(&state, confirmation()).await.is_err());
        let (jobs,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM ai_jobs")
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(jobs, 0);
        state.audio.shutdown();
        audio.join().unwrap();
    }
}
