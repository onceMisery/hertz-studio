// SPDX-License-Identifier: MIT
//! `--window` 原生主窗口托盘对桌面组件的最小控制面。
//!
//! 组件的安装布局（与配对服务 exe 同目录）和管理管道的传输细节都只在
//! 这条链路上出现一次；DBX 桥接形态不受影响（宿主侧自行衔接同一管道）。
//! 面向托盘的取舍：探测只回答一个事实、命令只收白名单内无参数动词，
//! 其余能力（样式、预览、授权）仍走设置页的 REST。

use std::path::Path;

/// 托盘视角的桌面组件状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostState {
    /// 组件 exe 不在服务同目录：模式开关置灰并如实点名。
    Missing,
    /// 管理管道无应答：组件未运行。
    Stopped,
    /// 管理管道应答：组件运行中。
    Running,
}

/// 探测当前状态；托盘菜单只需要事实，不区分失败原因。
pub fn probe() -> HostState {
    if crate::desktop::standalone::host_path().map_or(true, |host| !host.is_file()) {
        return HostState::Missing;
    }
    let payload = serde_json::json!({ "command": "status" });
    match crate::desktop_control::send(payload) {
        Ok(_) => HostState::Running,
        Err(_) => HostState::Stopped,
    }
}

/// 以普通模式启动组件：歌词与壁纸按组件自身配置自启。
pub fn spawn(data_dir: &Path) -> Result<(), String> {
    match crate::desktop::standalone::spawn_host(data_dir, &[]) {
        Ok(()) => Ok(()),
        Err(crate::desktop::standalone::SpawnError::Missing(host)) => Err(format!(
            "未找到桌面组件 {}；请安装与本服务匹配的桌面组件",
            host.display()
        )),
        Err(crate::desktop::standalone::SpawnError::Failed(error)) => Err(format!("{error:#}")),
    }
}

/// 托盘允许下发的管理命令（无参数动词；带值的操作请走设置页 REST）。
const TRAY_COMMANDS: &[&str] = &[
    "quit",
    "unlock",
    "locate",
    "wallpaper-toggle",
    "wallpaper-settings",
];

pub fn command(name: &str) -> Result<(), String> {
    if !TRAY_COMMANDS.contains(&name) {
        return Err(format!("托盘不支持桌面命令 {name}"));
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
