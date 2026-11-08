// SPDX-License-Identifier: MIT
//! `--window` 原生主窗口托盘对桌面歌词的最小控制面。
//!
//! 宿主现在是播放器进程内的模块：没有组件 exe 可探测，也没有管理管道可拨。
//! 探测只问进程内宿主的存活事实；启动/命令/退出全部经 `desktop_host` 收口。
//! 面向托盘的取舍：命令只收白名单内无参数动词，其余能力（样式、预览、
//! 授权）仍走设置页的 REST，最终落到同一个宿主窗口。

use std::path::Path;

/// 托盘视角的进程内宿主状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostState {
    /// 宿主未启动（或用户已从托盘退出歌词）：模式开关可启动。
    Stopped,
    /// 宿主的歌词/设置窗口由本进程持有中。
    Running { lyrics: bool, wallpaper: bool },
    /// 宿主存活，但暂未取得功能状态；不能据此启停功能。
    Unavailable,
}

/// 探测当前状态；托盘菜单只需要事实，不区分失败原因。
pub fn probe() -> HostState {
    if !crate::desktop_host::is_running() {
        return HostState::Stopped;
    }
    match crate::desktop_control::send(serde_json::json!({"command": "status"})) {
        Ok(status) if status["ok"] == true => match (
            status["runtimeEnabled"].as_bool(),
            status["wallpaper"]["runtimeEnabled"].as_bool(),
        ) {
            (Some(lyrics), Some(wallpaper)) => HostState::Running { lyrics, wallpaper },
            _ => HostState::Unavailable,
        },
        _ => HostState::Unavailable,
    }
}

/// 在播放器进程内拉起宿主：歌词与壁纸按宿主自身配置自启。
pub fn spawn(data_dir: &Path) -> Result<(), String> {
    crate::desktop_host::ensure_started(data_dir).map_err(|error| format!("{error:#}"))?;
    command("show")
}

/// 托盘允许下发的命令（无参数动词；带值的操作请走设置页 REST）。
const TRAY_COMMANDS: &[&str] = &[
    "quit",
    "lyrics-exit",
    "wallpaper-exit",
    "unlock",
    "locate",
    "wallpaper-toggle",
    "wallpaper-settings",
    "wallpaper-retry",
    "show",
    "hide",
    "mini-toggle",
];

pub fn command(name: &str) -> Result<(), String> {
    if !TRAY_COMMANDS.contains(&name) {
        return Err(format!("托盘不支持桌面命令 {name}"));
    }
    // 退出要等宿主保存完配置再放行；其余动词直接进宿主事件循环。
    if name == "quit" {
        return crate::desktop_host::shutdown().map_err(|error| format!("{error:#}"));
    }
    crate::desktop_control::send(serde_json::json!({ "command": name }))
        .map(|_| ())
        .map_err(|error| format!("{error:#}"))
}

#[cfg(test)]
mod tests {
    use super::TRAY_COMMANDS;

    #[test]
    fn tray_commands_stay_inside_the_management_whitelist() {
        for name in TRAY_COMMANDS {
            assert!(
                crate::desktop::standalone::CONTROL_COMMANDS.contains(name),
                "托盘命令 {name} 必须也在管理命令白名单里"
            );
        }
    }
}
