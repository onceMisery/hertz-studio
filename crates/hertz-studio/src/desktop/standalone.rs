// SPDX-License-Identifier: MIT
//! Standalone 形态的启动/控制契约，与 DBX 授权准入分开。
//!
//! 这里不再启动任何外部 exe：歌词窗口、设置窗口与托盘都由播放器进程内的
//! `desktop_host` 直接调用 `hertz_desktop` 库创建，命令也不再经命名管道转发。

use crate::{
    error::{bad_request, internal, ApiError, ApiResult},
    state::AppState,
};
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
    "lyrics-settings",
    "lyrics-apply",
    "lyrics-position-begin",
    "lyrics-position-done",
    "lyrics-position-cancel",
    "quit",
    "lyrics-exit",
    "wallpaper-exit",
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
    // 桌面宠物（小窗）与素材目录由宿主在同一进程内执行。
    "mini-toggle",
    "open-pet-assets",
];

#[derive(Deserialize)]
pub(crate) struct ControlRequest {
    pub command: String,
    #[serde(default)]
    pub value: Option<serde_json::Value>,
}

/// 主程序内联歌词设置按需初始化宿主，不打开设置中心或启用歌词。
/// 其余命令维持原合同：宿主不在时返回 503，由显式 launch 入口启动。
pub(crate) async fn control(
    state: &AppState,
    request: ControlRequest,
) -> ApiResult<serde_json::Value> {
    if !CONTROL_COMMANDS.contains(&request.command.as_str()) {
        return Err(bad_request("不支持的桌面控制命令"));
    }
    let inline_lyrics = matches!(
        request.command.as_str(),
        "lyrics-settings"
            | "lyrics-apply"
            | "lyrics-position-begin"
            | "lyrics-position-done"
            | "lyrics-position-cancel"
    );
    let payload = serde_json::json!({
        "command": request.command,
        "value": request.value,
    });
    let data_dir = state.data_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        if inline_lyrics {
            // Initialize the in-process host without opening the settings center
            // or locating/enabling lyrics. Saved disabled intent stays disabled.
            crate::desktop_host::ensure_started(&data_dir)?;
        }
        crate::desktop_control::send(payload)
    })
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

/// 在**本进程**拉起桌面宿主并直接完成用户刚点的动作。
///
/// 旧实现要先 spawn exe、sleep 400ms、再从管道补发一次幂等命令；现在
/// `ensure_started` 等宿主初始化就绪后，命令直接进同一个事件循环，没有
/// 子进程、没有延迟重试，也没有「组件文件缺失」这一类安装态错误。
pub(crate) async fn launch(state: &AppState, wallpaper: bool) -> ApiResult<serde_json::Value> {
    let data_dir = state.data_dir.clone();
    let profile = serde_json::json!({
        "dataDir": state.data_dir.to_string_lossy(),
        "edition": crate::edition::NAME,
    });
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        crate::desktop_host::ensure_started(&data_dir)?;
        if wallpaper {
            crate::desktop_control::send(serde_json::json!({
                "command": "wallpaper-settings",
                "value": { "tab": "wallpaper", "profile": profile },
            }))
        } else {
            crate::desktop_control::send(serde_json::json!({ "command": "locate" }))
        }
    })
    .await
    .map_err(|error| internal(format!("桌面歌词启动任务失败：{error}")))?;
    match result {
        Ok(_) => Ok(serde_json::json!({ "started": true })),
        Err(error) => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "desktop_unavailable",
            format!("{error:#}"),
        )),
    }
}
