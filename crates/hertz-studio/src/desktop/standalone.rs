// SPDX-License-Identifier: MIT
//! The existing Standalone launch/control contract, kept separate from DBX admission.
use crate::{
    error::{bad_request, internal, ApiError, ApiResult},
    state::AppState,
};
use anyhow::Context as _;
use axum::http::StatusCode;
use serde::Deserialize;
pub(crate) const CONTROL_BODY_BYTES: usize = 2 * 1024;
pub(crate) const CONTROL_COMMANDS: &[&str] = &[
    "status",
    "lock",
    "unlock",
    "show",
    "hide",
    "locate",
    "layout",
    "secondary",
    "font",
    "opacity",
    "quit",
    "wallpaper-status",
    "wallpaper-settings",
    "wallpaper-toggle",
    "wallpaper-show",
    "wallpaper-hide",
    "wallpaper-retry",
    "wallpaper-preview",
    "wallpaper-preview-close",
    "wallpaper-preview-renew",
    "wallpaper-apply",
    "profile-switch",
];

#[derive(Deserialize)]
pub(crate) struct ControlRequest {
    pub command: String,
    #[serde(default)]
    pub value: Option<serde_json::Value>,
}

/// 把播放器的明确动作转给正在运行的原生宿主；宿主不在时如实返回 503。
pub(crate) async fn control(request: ControlRequest) -> ApiResult<serde_json::Value> {
    if !CONTROL_COMMANDS.contains(&request.command.as_str()) {
        return Err(bad_request("不支持的桌面控制命令"));
    }
    let payload = serde_json::json!({
        "command": request.command,
        "value": request.value,
    });
    let result = tokio::task::spawn_blocking(move || crate::desktop_control::send(payload))
        .await
        .map_err(|error| internal(format!("桌面歌词控制任务失败：{error}")))?;
    match result {
        Ok(response) => Ok(response),
        Err(error) => {
            let message = format!("{error:#}");
            let code = if message.contains("未运行") {
                "desktop_not_running"
            } else {
                "desktop_unavailable"
            };
            Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                code,
                message,
            ))
        }
    }
}

pub(crate) fn launch(state: &AppState, wallpaper: bool) -> ApiResult<serde_json::Value> {
    if !wallpaper {
        return launch_desktop_host(state, &["--locate"], "locate", None);
    }
    let candidate = serde_json::json!({ "profile": {
        "dataDir": state.data_dir.to_string_lossy(), "edition": crate::edition::NAME,
    }});
    launch_desktop_host(
        state,
        &["--settings"],
        "wallpaper-settings",
        Some(candidate),
    )
}
/// 桌面组件启动失败的两类原因：安装位置缺失与真实启动失败分开，
/// 调用方各自决定报错形态（REST 404/500，托盘置灰提示）。
pub(crate) enum SpawnError {
    /// 服务 exe 同目录没有组件。
    Missing(std::path::PathBuf),
    Failed(anyhow::Error),
}

/// 桌面组件的唯一安装位置：与配对服务 exe 同目录。
pub(crate) fn host_path() -> Result<std::path::PathBuf, anyhow::Error> {
    let exe = std::env::current_exe().context("无法定位服务进程")?;
    let Some(dir) = exe.parent() else {
        anyhow::bail!("无法定位服务所在目录");
    };
    Ok(dir.join(if cfg!(windows) {
        "hertz-desktop.exe"
    } else {
        "hertz-desktop"
    }))
}

/// 以本服务的数据目录启动桌面组件；已有实例时新进程会因单实例退出。
pub(crate) fn spawn_host(
    data_dir: &std::path::Path,
    extra_args: &[&str],
) -> Result<(), SpawnError> {
    let host = host_path().map_err(SpawnError::Failed)?;
    if !host.is_file() {
        return Err(SpawnError::Missing(host));
    }
    let mut command = std::process::Command::new(&host);
    command.arg("--data-dir").arg(data_dir);
    for arg in extra_args {
        command.arg(arg);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 组件是 GUI 进程；开发构建的 console 也不要弹出来。
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|error| SpawnError::Failed(anyhow::anyhow!("启动桌面组件失败：{error}")))?;
    Ok(())
}

fn launch_desktop_host(
    state: &AppState,
    extra_args: &[&str],
    followup: &str,
    followup_value: Option<serde_json::Value>,
) -> ApiResult<serde_json::Value> {
    if let Err(error) = spawn_host(&state.data_dir, extra_args) {
        return Err(match error {
            SpawnError::Missing(host) => ApiError::new(
                StatusCode::NOT_FOUND,
                "desktop_component_missing",
                format!(
                    "未找到桌面组件 {}；请安装与本服务匹配的桌面组件",
                    host.display()
                ),
            ),
            SpawnError::Failed(message) => internal(format!("{message:#}")),
        });
    }
    // 已有宿主时新进程会因单实例退出；给正在运行的那个补一次幂等命令。
    let followup = followup.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        let mut payload = serde_json::json!({ "command": followup });
        if let Some(value) = followup_value {
            payload["value"] = value;
        }
        let _ = crate::desktop_control::send(payload);
    });
    Ok(serde_json::json!({ "started": true }))
}
