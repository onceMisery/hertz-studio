// SPDX-License-Identifier: MIT
//! Native short-session delivery through the original grant and desktop owners.
use crate::{
    error::{internal, unauthorized, ApiError, ApiResult},
    state::AppState,
};
use hertz_wallpaper::pairing::{self, Binding};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

fn failure(code: &'static str, message: &str) -> ApiError {
    ApiError::new(axum::http::StatusCode::CONFLICT, code, message)
}
fn store_error(e: vmusic_core::StoreError) -> ApiError {
    ApiError::from(vmusic_core::CoreError::Store(e))
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Registration {
    pub challenge: String,
    pub binding: Binding,
}
struct Pending {
    id: String,
    request: Registration,
    deadline: Instant,
}
#[derive(Default)]
pub(crate) struct PendingStore {
    pending: Vec<Pending>,
}
impl PendingStore {
    fn prune(&mut self) {
        self.pending.retain(|p| Instant::now() < p.deadline);
    }
    fn insert(&mut self, request: Registration) -> ApiResult<String> {
        self.prune();
        if self.pending.len() >= 4 {
            return Err(failure("pairing_busy", "待配对实例已满，请稍后重试"));
        }
        if self
            .pending
            .iter()
            .any(|p| p.request.binding == request.binding)
        {
            return Err(failure("pairing_pending", "该实例已有待确认连接"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.pending.push(Pending {
            id: id.clone(),
            request,
            deadline: Instant::now() + Duration::from_secs(pairing::CHALLENGE_SECONDS),
        });
        Ok(id)
    }
    fn take(&mut self, id: &str) -> ApiResult<Registration> {
        self.prune();
        let index = self
            .pending
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| failure("pairing_expired", "配对已到期或已使用，请重新连接"))?;
        Ok(self.pending.remove(index).request)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Session {
    binding: Binding,
    owner_instance_id: String,
    expires_at: i64,
}

#[cfg(all(windows, feature = "desktop-host"))]
fn current_binding(state: &AppState, binding: &Binding) -> bool {
    use hertz_desktop_ipc::{
        windows::{process_generation, Identity},
        Profile,
    };
    let profile = Profile::Standalone {
        edition: crate::edition::NAME.into(),
        data_dir: state.data_dir.to_string_lossy().into_owned(),
    }
    .normalized();
    let identity = Identity::current();
    binding.valid()
        && binding.service_pid == std::process::id()
        && binding.server_instance_id == state.server_instance_id
        && binding.edition == crate::edition::NAME
        && identity.is_ok_and(|id| {
            id.user_sid == binding.user_sid && id.windows_session_id == binding.windows_session_id
        })
        && profile.is_ok_and(|p| {
            pairing::profile_digest(p.edition(), p.data_dir()) == binding.profile_digest
        })
        && process_generation(binding.native_pid)
            .is_ok_and(|generation| generation == binding.native_generation)
        && (binding.native_pid != std::process::id() || crate::desktop_host::is_running())
}
#[cfg(not(all(windows, feature = "desktop-host")))]
fn current_binding(_state: &AppState, _binding: &Binding) -> bool {
    false
}

pub(crate) async fn register(state: &Arc<AppState>, request: Registration) -> ApiResult<Value> {
    if !pairing::hex64(&request.challenge) || !current_binding(state, &request.binding) {
        return Err(failure(
            "pairing_identity_mismatch",
            "桌面实例、Profile 或服务身份不匹配",
        ));
    }
    let id = state
        .ai_runtime
        .wallpaper_pairings
        .lock()
        .await
        .insert(request)?;
    Ok(json!({"pairingId":id,"expiresInSeconds":pairing::CHALLENGE_SECONDS}))
}

pub(crate) async fn pending(state: &Arc<AppState>) -> Value {
    let mut store = state.ai_runtime.wallpaper_pairings.lock().await;
    store.prune();
    json!({"pending":store.pending.iter().map(|p| json!({
        "pairingId":p.id,"edition":p.request.binding.edition,
        "nativePid":p.request.binding.native_pid,"desktopBuildId":p.request.binding.desktop_build_id,
        "expiresInSeconds":p.deadline.saturating_duration_since(Instant::now()).as_secs()
    })).collect::<Vec<_>>()})
}

#[cfg(all(windows, feature = "desktop-host"))]
async fn deliver(binding: &Binding, payload: Value) -> ApiResult<()> {
    let binding = binding.clone();
    let response = tokio::task::spawn_blocking(move || {
        if binding.native_pid == std::process::id() {
            crate::desktop_host::command("wallpaper.ai.pair.verify", Some(payload)).map_err(|_| ())
        } else {
            hertz_desktop_ipc::management::request_verified(
                &hertz_desktop_ipc::management::pipe_name(),
                &json!({"command":"wallpaper.ai.pair.verify","value":payload}),
                &hertz_desktop_ipc::windows::Cancellation::new(),
                Some(Instant::now() + Duration::from_secs(5)),
                Some(binding.native_pid),
            )
            .map_err(|_| ())
        }
    })
    .await
    .map_err(|_| failure("pairing_failed", "桌面回验未完成"))?
    .map_err(|_| failure("pairing_failed", "桌面回验未完成，请重新连接"))?;
    if response["ok"] != true {
        return Err(failure("pairing_failed", "桌面拒绝了配对，请重新连接"));
    }
    Ok(())
}
#[cfg(not(all(windows, feature = "desktop-host")))]
async fn deliver(_binding: &Binding, _payload: Value) -> ApiResult<()> {
    Err(failure("desktop_unavailable", "短会话配对仅支持 Windows"))
}

pub(crate) async fn confirm(state: &Arc<AppState>, id: &str) -> ApiResult<Value> {
    let _lifecycle = super::facade::grant_lifecycle().lock().await;
    {
        let mut deadlines = state.ai_runtime.wallpaper_session_deadlines.lock().await;
        deadlines.retain(|_, deadline| Instant::now() < *deadline);
        if deadlines.len() >= 32 {
            return Err(failure(
                "pairing_busy",
                "生成连接数量已达上限，请先断开旧连接",
            ));
        }
    }
    let request = state.ai_runtime.wallpaper_pairings.lock().await.take(id)?;
    if !current_binding(state, &request.binding) {
        return Err(failure(
            "pairing_identity_mismatch",
            "配对期间实例身份发生变化",
        ));
    }
    deliver(
        &request.binding,
        json!({"phase":"verify","challenge":request.challenge,"binding":request.binding}),
    )
    .await?;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| internal("无法生成短会话凭据"))?;
    let bearer: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let digest: String = Sha256::digest(bearer.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let owner = vmusic_store::ai::get_or_create_instance(&state.db)
        .await
        .map_err(store_error)?;
    let session = Session {
        binding: request.binding.clone(),
        owner_instance_id: owner.owner_instance_id,
        expires_at: vmusic_store::now_ms() + pairing::SESSION_MS,
    };
    let grant_id = uuid::Uuid::new_v4().to_string();
    vmusic_store::ai::insert_session_grant(
        &state.db,
        &grant_id,
        &digest,
        &serde_json::to_string(pairing::SCOPES).map_err(|_| internal("无效 scope"))?,
        &serde_json::to_string(&session).map_err(|_| internal("无效会话身份"))?,
    )
    .await
    .map_err(store_error)?;
    state
        .ai_runtime
        .wallpaper_session_deadlines
        .lock()
        .await
        .insert(
            grant_id.clone(),
            Instant::now() + Duration::from_millis(pairing::SESSION_MS as u64),
        );
    let result = deliver(&request.binding, json!({"phase":"deliver","challenge":request.challenge,
        "binding":request.binding,"grantId":grant_id,"bearer":bearer,"expiresAt":session.expires_at})).await;
    if let Err(error) = result {
        // A delivery timeout is not proof that the native side did not receive it.
        // Revoke the digest so any late receiver has no usable authority.
        vmusic_store::ai::revoke_grant(&state.db, &grant_id)
            .await
            .map_err(store_error)?;
        state
            .ai_runtime
            .wallpaper_session_deadlines
            .lock()
            .await
            .remove(&grant_id);
        return Err(error);
    }
    vmusic_store::ai::bump_policy_revision(&state.db)
        .await
        .map_err(store_error)?;
    Ok(json!({"connected":true,"grantId":grant_id,"expiresAt":session.expires_at}))
}

pub(crate) async fn validate_grant(
    state: &Arc<AppState>,
    row: &vmusic_store::ai::GrantRow,
) -> ApiResult<i64> {
    let owner = vmusic_store::ai::get_or_create_instance(&state.db)
        .await
        .map_err(store_error)?;
    validate_session(state, row, &owner.owner_instance_id).await
}

async fn validate_session(
    state: &Arc<AppState>,
    row: &vmusic_store::ai::GrantRow,
    owner: &str,
) -> ApiResult<i64> {
    let session: Session = row
        .session_binding
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok())
        .ok_or_else(unauthorized)?;
    let remaining = state
        .ai_runtime
        .wallpaper_session_deadlines
        .lock()
        .await
        .get(&row.grant_id)
        .map(|deadline| {
            deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as i64
        })
        .unwrap_or(0);
    if row.revoked
        || row.delivery_mode != "native_session"
        || remaining <= 0
        || session.expires_at <= vmusic_store::now_ms()
        || session.owner_instance_id != owner
        || !current_binding(state, &session.binding)
    {
        return Err(failure(
            "wallpaper_session_expired",
            "连接已到期或实例已变化，请重新配对",
        ));
    }
    Ok(session
        .expires_at
        .min(vmusic_store::now_ms().saturating_add(remaining)))
}

/// Revalidate inside the admission/dispatch transaction, without acquiring a
/// second database connection while the writer owns BEGIN IMMEDIATE.
pub(super) async fn require_transaction_time(
    state: &Arc<AppState>,
    conn: &mut sqlx::SqliteConnection,
    grant_id: &str,
    owner: &str,
    minimum_ms: i64,
) -> ApiResult<()> {
    let row = vmusic_store::ai::find_grant_by_id(&mut *conn, grant_id)
        .await
        .map_err(store_error)?
        .ok_or_else(unauthorized)?;
    if validate_session(state, &row, owner).await? - vmusic_store::now_ms() < minimum_ms {
        return Err(failure(
            "wallpaper_session_expiring",
            "连接剩余时间不足，请重新配对后提交",
        ));
    }
    Ok(())
}

pub(crate) async fn require_time(state: &Arc<AppState>, grant_id: &str) -> ApiResult<()> {
    let row = vmusic_store::ai::find_grant_by_id(&state.db, grant_id)
        .await
        .map_err(store_error)?
        .ok_or_else(unauthorized)?;
    if row.revoked || validate_grant(state, &row).await? - vmusic_store::now_ms() < pairing::TASK_MS
    {
        return Err(failure(
            "wallpaper_session_expiring",
            "连接剩余时间不足，请重新配对后提交",
        ));
    }
    Ok(())
}

pub(crate) async fn cancel_grant_jobs(state: &Arc<AppState>, grant_id: &str) -> ApiResult<()> {
    state
        .ai_runtime
        .wallpaper_session_deadlines
        .lock()
        .await
        .remove(grant_id);
    state.ai_runtime.discard_wallpaper_quotes(grant_id).await;
    super::jobs::cancel_principal_jobs(state, grant_id).await
}

#[cfg(all(test, feature = "desktop-host"))]
#[path = "wallpaper_pairing_tests.rs"]
mod tests;
