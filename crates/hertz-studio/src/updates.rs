// SPDX-License-Identifier: MIT
//! One bounded release check/download owner shared by HTTP and the plugin facade.
mod release;
mod windows;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use release::{Candidate, Context, Distribution, InstallKind, ReleaseView, Version};

pub(crate) const AUTO_CHECK_KEY: &str = "updates_check_on_startup";
const LAST_AUTO_CHECK_KEY: &str = "updates_last_auto_check_ms";
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
pub(super) const MAX_PACKAGE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FEED_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn api(self) -> ApiError {
        ApiError::new(StatusCode::BAD_GATEWAY, self.code, self.message)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    #[default]
    Idle,
    Checking,
    Current,
    Available,
    Unavailable,
    Downloading,
    Verifying,
    Ready,
    Installing,
    Cancelling,
    Cancelled,
    Failed,
}

impl Phase {
    fn busy(self) -> bool {
        matches!(
            self,
            Self::Checking
                | Self::Downloading
                | Self::Verifying
                | Self::Installing
                | Self::Cancelling
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    current_version: String,
    edition: String,
    distribution: Distribution,
    target: String,
    phase: Phase,
    check_on_startup: bool,
    checked_at: Option<u64>,
    release: Option<ReleaseView>,
    operation_id: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    can_download: bool,
    can_install: bool,
    install_kind: Option<InstallKind>,
    install_unavailable_reason: Option<String>,
    error: Option<Failure>,
    last_install: Option<windows::InstallResult>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CheckRequest {
    #[serde(default)]
    pub automatic: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Preferences {
    pub check_on_startup: bool,
}

#[derive(Default)]
struct Inner {
    shutting_down: bool,
    phase: Phase,
    checked_at: Option<u64>,
    operation_id: Option<String>,
    candidate: Option<Candidate>,
    downloaded_bytes: u64,
    cancel: Option<watch::Sender<bool>>,
    prepared: Option<windows::Prepared>,
    handoff: Option<windows::Handoff>,
    error: Option<Failure>,
}

impl Inner {
    fn require_running(&self, state: &AppState) -> ApiResult<()> {
        if self.shutting_down || *state.exiting.borrow() {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "update_shutdown",
                "播放器正在退出，请重新打开后更新",
            ));
        }
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct Updates {
    inner: Mutex<Inner>,
    client: OnceLock<Result<reqwest::Client, Failure>>,
    installation: OnceLock<Result<windows::Installation, String>>,
    last_install: OnceLock<Option<windows::InstallResult>>,
    restart_port: OnceLock<u16>,
}

impl Updates {
    pub(crate) fn set_restart_port(&self, port: u16) {
        let _ = self.restart_port.set(port);
    }

    fn distribution(&self) -> Distribution {
        // The standalone listener supplies its actual restart port before serving.
        // Desktop capabilities may also be feature-unified into the plugin library.
        if self.restart_port.get().is_some() {
            Distribution::Standalone
        } else {
            Distribution::Plugin
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn installation(&self, state: &AppState) -> Result<windows::Installation, String> {
        if state.native_window.get().is_none() {
            return Err("在 Windows 独立播放器中安装更新；当前运行方式请使用下载页".into());
        }
        self.installation
            .get_or_init(|| windows::Installation::discover(state))
            .clone()
    }

    fn context(&self, state: &AppState) -> Context {
        Context::compiled(
            self.distribution(),
            self.installation(state)
                .ok()
                .map(|installation| installation.kind),
        )
    }

    fn client(&self) -> Result<reqwest::Client, Failure> {
        self.client
            .get_or_init(|| {
                reqwest::Client::builder()
                    .user_agent(concat!("Hertz-Studio/", env!("CARGO_PKG_VERSION")))
                    .https_only(true)
                    .connect_timeout(Duration::from_secs(10))
                    .timeout(Duration::from_secs(30))
                    .redirect(reqwest::redirect::Policy::custom(|attempt| {
                        if attempt.previous().len() >= 5 {
                            attempt.error("too many update redirects")
                        } else if release::allowed_url(attempt.url()) {
                            attempt.follow()
                        } else {
                            attempt.error("update redirect outside GitHub")
                        }
                    }))
                    .build()
                    .map_err(|_| {
                        Failure::new(
                            "update_network_unavailable",
                            "无法初始化更新连接，请稍后重试",
                        )
                    })
            })
            .clone()
    }

    fn snapshot(&self, state: &AppState, check_on_startup: bool) -> Snapshot {
        let installation = self.installation(state);
        let last_install = self
            .last_install
            .get_or_init(|| windows::last_result(&state.data_dir))
            .clone();
        let inner = self.lock();
        let asset = inner
            .candidate
            .as_ref()
            .and_then(|candidate| candidate.asset.as_ref());
        let newer = inner.candidate.as_ref().is_some_and(|candidate| {
            Version::parse(&candidate.view.version) > Version::parse(env!("CARGO_PKG_VERSION"))
        });
        Snapshot {
            current_version: env!("CARGO_PKG_VERSION").into(),
            edition: crate::edition::NAME.into(),
            distribution: self.distribution(),
            target: env!("HERTZ_BUILD_TARGET").into(),
            phase: inner.phase,
            check_on_startup,
            checked_at: inner.checked_at,
            release: inner
                .candidate
                .as_ref()
                .map(|candidate| candidate.view.clone()),
            operation_id: inner.operation_id.clone(),
            downloaded_bytes: inner.downloaded_bytes,
            total_bytes: asset.map(|asset| asset.size),
            can_download: newer
                && installation.is_ok()
                && asset.is_some_and(|asset| asset.has_checksum()),
            can_install: inner.phase == Phase::Ready
                && inner.prepared.is_some()
                && installation.is_ok(),
            install_kind: installation
                .as_ref()
                .ok()
                .map(|installation| installation.kind),
            install_unavailable_reason: installation.err(),
            error: inner.error.clone(),
            last_install,
        }
    }

    fn finish(&self, operation: &str, result: Result<Option<Candidate>, Failure>, current: &str) {
        let mut inner = self.lock();
        if inner.operation_id.as_deref() == Some(operation) && inner.phase == Phase::Cancelling {
            inner.phase = Phase::Cancelled;
            inner.cancel = None;
            return;
        }
        if inner.operation_id.as_deref() != Some(operation) || inner.phase != Phase::Checking {
            return;
        }
        inner.cancel = None;
        match result {
            Ok(candidate) => {
                inner.checked_at = Some(now_ms());
                inner.phase = match candidate.as_ref() {
                    Some(candidate)
                        if Version::parse(&candidate.view.version) > Version::parse(current) =>
                    {
                        Phase::Available
                    }
                    Some(_) => Phase::Current,
                    None => Phase::Unavailable,
                };
                inner.candidate = candidate;
                inner.error = None;
            }
            Err(error) => {
                inner.phase = Phase::Failed;
                inner.error = Some(error);
            }
        }
    }

    fn fail(&self, operation: &str, failure: Failure) {
        let mut inner = self.lock();
        if inner.operation_id.as_deref() == Some(operation)
            && !matches!(inner.phase, Phase::Cancelled | Phase::Cancelling)
        {
            inner.phase = Phase::Failed;
            inner.error = Some(failure);
            inner.cancel = None;
        }
    }

    fn cancellation_finished(&self, operation: &str) {
        let mut inner = self.lock();
        if inner.operation_id.as_deref() == Some(operation) && inner.phase == Phase::Cancelling {
            inner.phase = Phase::Cancelled;
            inner.cancel = None;
        }
    }

    pub(crate) fn arm_install(&self, state: &AppState, operation: &str) -> ApiResult<()> {
        let mut inner = self.lock();
        inner.require_running(state)?;
        if inner.phase != Phase::Ready || inner.operation_id.as_deref() != Some(operation) {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "update_not_ready",
                "更新包尚未准备好，请先下载更新",
            ));
        }
        let prepared = inner.prepared.as_ref().ok_or_else(|| {
            ApiError::new(StatusCode::CONFLICT, "update_not_ready", "请重新下载更新包")
        })?;
        let handoff = windows::arm(prepared, state).map_err(Failure::api)?;
        inner.handoff = Some(handoff);
        inner.phase = Phase::Installing;
        Ok(())
    }

    pub(crate) async fn begin_install_exit(
        &self,
        operation: &str,
        lifecycle: &crate::window_lifecycle::WindowLifecycle,
    ) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            {
                let mut inner = self.lock();
                if inner.phase != Phase::Installing
                    || inner.operation_id.as_deref() != Some(operation)
                {
                    return;
                }
                let Some(handoff) = inner.handoff.as_ref() else {
                    return;
                };
                if windows::is_ready(handoff) {
                    // Hold the update admission until the quit request is bound;
                    // cancellation cannot slip between readiness and this request.
                    let snapshot =
                        lifecycle.request_exit(crate::window_lifecycle::QuitSource::Update);
                    if snapshot.source == Some(crate::window_lifecycle::QuitSource::Update)
                        && snapshot.phase == crate::window_lifecycle::Phase::Pending
                    {
                        inner.handoff.as_mut().unwrap().exit_request = snapshot.request_id;
                    } else {
                        windows::disarm(handoff);
                        inner.handoff = None;
                        inner.phase = Phase::Ready;
                        inner.error = Some(Failure::new(
                            "update_exit_busy",
                            "另一次退出正在处理，请返回播放器后重试安装",
                        ));
                    }
                    return;
                }
                if tokio::time::Instant::now() >= deadline {
                    windows::disarm(handoff);
                    inner.handoff = None;
                    inner.phase = Phase::Ready;
                    inner.error = Some(Failure::new(
                        "update_helper_unavailable",
                        "更新工具未能就绪，播放器继续运行，请重试安装或使用发布页面",
                    ));
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    pub(crate) fn disarm_install(&self) {
        let mut inner = self.lock();
        if let Some(handoff) = inner.handoff.take() {
            windows::disarm(&handoff);
            inner.phase = Phase::Ready;
        }
    }

    pub(crate) fn validate_install_exit(&self, request: &str) -> ApiResult<()> {
        let mut inner = self.lock();
        if inner.phase == Phase::Installing
            && inner.handoff.as_ref().is_some_and(|handoff| {
                handoff.exit_request.as_deref() == Some(request) && windows::is_ready(handoff)
            })
        {
            return Ok(());
        }
        if let Some(handoff) = inner.handoff.take() {
            windows::disarm(&handoff);
        }
        inner.phase = Phase::Ready;
        inner.error = Some(Failure::new(
            "update_helper_unavailable",
            "更新工具已退出，播放器继续运行，请重新安装",
        ));
        Err(ApiError::new(
            StatusCode::CONFLICT,
            "update_helper_unavailable",
            "更新工具已退出，请重新安装",
        ))
    }

    /// A helper cannot apply its package until the exact approved exit reaches this barrier.
    pub(crate) fn commit_exit(&self, state: &AppState) {
        let directory = {
            let inner = self.lock();
            if let (Some(handoff), Some(window)) =
                (inner.handoff.as_ref(), state.native_window.get())
            {
                let snapshot = window.snapshot();
                if snapshot.phase == crate::window_lifecycle::Phase::Exiting
                    && snapshot.source == Some(crate::window_lifecycle::QuitSource::Update)
                    && snapshot.request_id.as_deref() == handoff.exit_request.as_deref()
                {
                    if let Err(error) = windows::commit(handoff) {
                        tracing::error!("update handoff commit: {}", error.message);
                    }
                    return;
                }
                windows::disarm(handoff);
            }
            inner
                .prepared
                .as_ref()
                .map(|prepared| prepared.directory.clone())
        };
        if let Some(directory) = directory {
            windows::remove_stage(&directory, &state.data_dir);
        }
    }

    pub(crate) fn shutdown(&self) {
        let mut inner = self.lock();
        inner.shutting_down = true;
        if let Some(cancel) = inner.cancel.as_ref() {
            cancel.send_replace(true);
        }
        if matches!(
            inner.phase,
            Phase::Checking | Phase::Downloading | Phase::Verifying
        ) {
            inner.phase = Phase::Cancelling;
        }
    }
}

async fn auto_enabled(state: &AppState) -> ApiResult<bool> {
    Ok(vmusic_store::settings::get(&state.db, AUTO_CHECK_KEY)
        .await
        .map_err(|error| crate::error::internal(error.to_string()))?
        == Some(serde_json::Value::Bool(true)))
}

pub(crate) async fn status(state: &Arc<AppState>) -> ApiResult<Snapshot> {
    Ok(state.updates.snapshot(state, auto_enabled(state).await?))
}

pub(crate) async fn preferences(
    state: &Arc<AppState>,
    request: Preferences,
) -> ApiResult<Snapshot> {
    vmusic_store::settings::set_all(
        &state.db,
        &BTreeMap::from([(
            AUTO_CHECK_KEY.into(),
            serde_json::Value::Bool(request.check_on_startup),
        )]),
    )
    .await
    .map_err(|error| crate::error::internal(error.to_string()))?;
    Ok(state.updates.snapshot(state, request.check_on_startup))
}

pub(crate) async fn check(state: &Arc<AppState>, automatic: bool) -> ApiResult<Snapshot> {
    let enabled = auto_enabled(state).await?;
    if automatic {
        let last = vmusic_store::settings::get(&state.db, LAST_AUTO_CHECK_KEY)
            .await
            .map_err(|error| crate::error::internal(error.to_string()))?
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let now = now_ms();
        if !enabled || (last <= now && now - last < DAY_MS) {
            return Ok(state.updates.snapshot(state, enabled));
        }
    }
    let operation = uuid::Uuid::new_v4().to_string();
    let (cancel, mut cancelled) = watch::channel(false);
    {
        let mut inner = state.updates.lock();
        inner.require_running(state)?;
        if inner.phase.busy()
            || inner.phase == Phase::Ready
            || (inner.error.is_none()
                && inner
                    .checked_at
                    .is_some_and(|time| now_ms().saturating_sub(time) < 5 * 60 * 1000))
        {
            drop(inner);
            return Ok(state.updates.snapshot(state, enabled));
        }
        inner.phase = Phase::Checking;
        inner.operation_id = Some(operation.clone());
        inner.cancel = Some(cancel);
        inner.error = None;
        inner.downloaded_bytes = 0;
        inner.candidate = None;
    }
    // Persist the automatic-attempt throttle before networking, including failed checks.
    if automatic {
        if let Err(error) = vmusic_store::settings::set_all(
            &state.db,
            &BTreeMap::from([(LAST_AUTO_CHECK_KEY.into(), serde_json::json!(now_ms()))]),
        )
        .await
        {
            state.updates.fail(
                &operation,
                Failure::new("update_settings_failed", "启动检查时间未能保存，请重试"),
            );
            state.updates.cancellation_finished(&operation);
            return Err(crate::error::internal(error.to_string()));
        }
    }
    let state_task = state.clone();
    tokio::spawn(async move {
        let mut exiting = state_task.exiting_signal();
        if *cancelled.borrow() || *exiting.borrow() {
            state_task.updates.cancellation_finished(&operation);
            return;
        }
        let context = state_task.updates.context(&state_task);
        let result = tokio::select! {
            biased;
            _ = cancelled.changed() => { state_task.updates.cancellation_finished(&operation); return; },
            _ = exiting.changed() => return,
            result = fetch_candidate(&state_task.updates, &context) => result,
        };
        state_task
            .updates
            .finish(&operation, result, &context.version);
    });
    Ok(state.updates.snapshot(state, enabled))
}

async fn fetch_candidate(
    updates: &Updates,
    context: &Context,
) -> Result<Option<Candidate>, Failure> {
    let bytes = limited_get(&updates.client()?, release::RELEASES_API, MAX_FEED_BYTES).await?;
    let releases = serde_json::from_slice(&bytes)
        .map_err(|_| Failure::new("update_feed_invalid", "更新信息格式无效，请稍后重试"))?;
    release::select(releases, context)
}

async fn limited_get(
    client: &reqwest::Client,
    url: &str,
    maximum: usize,
) -> Result<Vec<u8>, Failure> {
    let mut response = checked_response(
        client
            .get(url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await,
    )
    .await?;
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(Failure::new(
            "update_response_too_large",
            "更新信息超过允许大小",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > maximum.saturating_sub(bytes.len()) {
            return Err(Failure::new(
                "update_response_too_large",
                "更新信息超过允许大小",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn checked_response(
    result: Result<reqwest::Response, reqwest::Error>,
) -> Result<reqwest::Response, Failure> {
    let response = result.map_err(network_error)?;
    if response.status() == StatusCode::FORBIDDEN
        || response.status() == StatusCode::TOO_MANY_REQUESTS
    {
        return Err(Failure::new(
            "update_rate_limited",
            "GitHub 暂时限制了检查频率，请稍后重试或打开发布页面",
        ));
    }
    if !response.status().is_success() {
        return Err(Failure::new(
            "update_http_failed",
            format!(
                "更新服务返回 HTTP {}，请稍后重试",
                response.status().as_u16()
            ),
        ));
    }
    Ok(response)
}

fn network_error(error: reqwest::Error) -> Failure {
    if error.is_timeout() {
        Failure::new("update_timeout", "更新连接超时，请检查网络后重试")
    } else {
        Failure::new(
            "update_network_failed",
            "无法连接 GitHub 更新服务，请检查网络后重试",
        )
    }
}

pub(crate) async fn download(state: &Arc<AppState>) -> ApiResult<Snapshot> {
    let enabled = auto_enabled(state).await?;
    let installation = state.updates.installation(state).map_err(|reason| {
        ApiError::new(StatusCode::CONFLICT, "update_install_unavailable", reason)
    })?;
    let (operation, candidate, mut cancelled) = {
        let mut inner = state.updates.lock();
        inner.require_running(state)?;
        if inner.phase.busy() || inner.phase == Phase::Ready {
            drop(inner);
            return Ok(state.updates.snapshot(state, enabled));
        }
        let candidate = inner
            .candidate
            .clone()
            .filter(|candidate| {
                Version::parse(&candidate.view.version) > Version::parse(env!("CARGO_PKG_VERSION"))
            })
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::CONFLICT,
                    "update_no_candidate",
                    "请先检查是否有新版本",
                )
            })?;
        if !candidate
            .asset
            .as_ref()
            .is_some_and(|asset| asset.has_checksum())
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "update_checksum_missing",
                "此发布没有可校验的更新包，请使用发布页面",
            ));
        }
        let operation = uuid::Uuid::new_v4().to_string();
        let (cancel, receiver) = watch::channel(false);
        inner.operation_id = Some(operation.clone());
        inner.phase = Phase::Downloading;
        inner.cancel = Some(cancel);
        inner.error = None;
        inner.downloaded_bytes = 0;
        (operation, candidate, receiver)
    };
    let state_task = state.clone();
    tokio::spawn(async move {
        let mut exiting = state_task.exiting_signal();
        if *cancelled.borrow() || *exiting.borrow() {
            state_task.updates.cancellation_finished(&operation);
            return;
        }
        let directory = match windows::create_stage(&state_task.data_dir, &installation, &operation)
        {
            Ok(directory) => directory,
            Err(error) => {
                state_task.updates.fail(&operation, error);
                state_task.updates.cancellation_finished(&operation);
                return;
            }
        };
        let result = tokio::select! {
            biased;
            _ = cancelled.changed() => Err(Failure::new("update_cancelled", "已取消下载")),
            _ = exiting.changed() => Err(Failure::new("update_cancelled", "播放器正在退出")),
            result = download_candidate(&state_task.updates, &operation, &candidate, &installation, &directory) => result,
        };
        match result {
            Ok(prepared) => {
                let mut inner = state_task.updates.lock();
                if inner.operation_id.as_deref() == Some(&operation)
                    && !inner.shutting_down
                    && !*state_task.exiting.borrow()
                    && !matches!(inner.phase, Phase::Cancelled | Phase::Cancelling)
                {
                    inner.prepared = Some(prepared);
                    inner.phase = Phase::Ready;
                    inner.cancel = None;
                    return;
                }
            }
            Err(error) => state_task.updates.fail(&operation, error),
        }
        windows::remove_stage(&directory, &state_task.data_dir);
        state_task.updates.cancellation_finished(&operation);
    });
    Ok(state.updates.snapshot(state, enabled))
}

async fn download_candidate(
    updates: &Updates,
    operation: &str,
    candidate: &Candidate,
    installation: &windows::Installation,
    directory: &std::path::Path,
) -> Result<windows::Prepared, Failure> {
    let asset = candidate.asset.as_ref().unwrap();
    let client = updates.client()?;
    let checksum = match &asset.sha256 {
        Some(hash) => hash.clone(),
        None => {
            let url = asset
                .checksum_url
                .as_deref()
                .ok_or_else(|| Failure::new("update_checksum_missing", "更新包缺少摘要"))?;
            let bytes = limited_get(&client, url, 16 * 1024).await?;
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| Failure::new("update_checksum_invalid", "更新摘要格式无效"))?;
            release::parse_checksum(text, &asset.name)?
        }
    };
    let mut response = checked_response(
        client
            .get(&asset.url)
            .header("Accept-Encoding", "identity")
            .timeout(Duration::from_secs(15 * 60))
            .send()
            .await,
    )
    .await?;
    if response
        .content_length()
        .is_some_and(|length| length != asset.size)
    {
        return Err(Failure::new(
            "update_size_mismatch",
            "更新包大小与发布信息不一致，请重新检查更新",
        ));
    }
    let temporary = directory.join("download.part");
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await
        .map_err(|_| {
            Failure::new(
                "update_write_failed",
                "无法保存更新包，请检查磁盘空间后重试",
            )
        })?;
    let mut hash = Sha256::new();
    let mut total = 0_u64;
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        total = total
            .checked_add(chunk.len() as u64)
            .filter(|total| *total <= asset.size && *total <= MAX_PACKAGE_BYTES)
            .ok_or_else(|| Failure::new("update_size_mismatch", "更新包超过发布信息中的大小"))?;
        file.write_all(&chunk).await.map_err(|_| {
            Failure::new(
                "update_write_failed",
                "更新包保存失败，请检查磁盘空间后重试",
            )
        })?;
        hash.update(&chunk);
        let mut inner = updates.lock();
        if inner.operation_id.as_deref() == Some(operation)
            && !matches!(inner.phase, Phase::Cancelled | Phase::Cancelling)
        {
            inner.downloaded_bytes = total;
        }
    }
    {
        let mut inner = updates.lock();
        if inner.operation_id.as_deref() == Some(operation)
            && !matches!(inner.phase, Phase::Cancelled | Phase::Cancelling)
        {
            inner.phase = Phase::Verifying;
        }
    }
    if total != asset.size || format!("{:x}", hash.finalize()) != checksum {
        return Err(Failure::new(
            "update_checksum_mismatch",
            "更新包校验失败，已丢弃下载，请重试",
        ));
    }
    file.sync_all()
        .await
        .map_err(|_| Failure::new("update_write_failed", "更新包未能完整写入磁盘，请重试"))?;
    drop(file);
    let package = directory.join(&asset.name);
    tokio::fs::rename(&temporary, &package)
        .await
        .map_err(|_| Failure::new("update_write_failed", "更新包保存失败，请重试"))?;
    windows::prepare(
        directory,
        package,
        checksum,
        candidate.view.version.clone(),
        installation.clone(),
    )
}

pub(crate) async fn cancel(state: &Arc<AppState>) -> ApiResult<Snapshot> {
    let enabled = auto_enabled(state).await?;
    {
        let mut inner = state.updates.lock();
        if inner.phase == Phase::Installing {
            if inner
                .handoff
                .as_ref()
                .is_some_and(|handoff| handoff.exit_request.is_none())
            {
                if let Some(handoff) = inner.handoff.take() {
                    windows::disarm(&handoff);
                }
                inner.phase = Phase::Ready;
                drop(inner);
                return Ok(state.updates.snapshot(state, enabled));
            }
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "update_exit_pending",
                "请在退出确认中选择返回播放器以取消安装",
            ));
        }
        if let Some(cancel) = inner.cancel.take() {
            cancel.send_replace(true);
        }
        if matches!(
            inner.phase,
            Phase::Checking | Phase::Downloading | Phase::Verifying
        ) {
            inner.phase = Phase::Cancelling;
            inner.error = None;
        }
    }
    Ok(state.updates.snapshot(state, enabled))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn open_release_page(text: &str) -> ApiResult<()> {
    let url =
        reqwest::Url::parse(text).map_err(|_| crate::error::bad_request("发布页面地址无效"))?;
    if text.len() > 1024
        || !release::allowed_url(&url)
        || url.host_str() != Some("github.com")
        || !url.path().starts_with("/onceMisery/hertz-studio/releases/")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(crate::error::bad_request(
            "只能打开 Hertz Studio 的发布页面",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let system = std::env::var_os("SystemRoot")
            .ok_or_else(|| crate::error::internal("无法打开系统浏览器"))?;
        std::process::Command::new(std::path::PathBuf::from(system).join("explorer.exe"))
            .arg(url.as_str())
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|_| crate::error::internal("无法打开系统浏览器，请复制下载链接"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err(crate::error::bad_request("请在浏览器中打开此发布页面"))
    }
}
