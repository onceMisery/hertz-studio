// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
//! 桌面歌词/壁纸宿主的库入口。
//!
//! 同一套窗口、页面、配置与来源线程有两种运行形态，代码只有一份：
//! - `run()`：独立 `hertz-desktop.exe`（保留 CLI、自有托盘与管理管道，供原生回归脚本使用）；
//! - `start_embedded()`：由播放器 `hertz-studio.exe` **在本进程内**直接调用，歌词窗口、
//!   设置窗口、托盘动作与退出都由播放器持有，不再启动外部 exe、不再经命名管道转发命令。
//!
//! 非 Windows 平台只有明确的失败桩；所有 GUI 模块都不参与编译。

#[cfg(windows)]
mod app;
#[cfg(windows)]
mod bridge;
#[cfg(windows)]
mod calibration;
#[cfg(windows)]
mod component;
#[cfg(windows)]
mod config;
#[cfg(windows)]
mod config_journal;
#[cfg(windows)]
mod dbx_feed;
#[cfg(windows)]
mod feed;
#[cfg(windows)]
mod host;
#[cfg(windows)]
mod hotkey;
#[cfg(windows)]
mod management;
#[cfg(windows)]
mod mini;
#[cfg(windows)]
mod mini_feed;
#[cfg(windows)]
mod mini_native;
#[cfg(windows)]
mod native;
#[cfg(windows)]
pub mod native_events;
#[cfg(windows)]
mod pipe;
#[cfg(windows)]
mod root_owner;
#[cfg(windows)]
mod wallpaper;
#[cfg(windows)]
mod wallpaper_feed;
#[cfg(windows)]
mod wallpaper_upgrade;

#[cfg(windows)]
pub use host::{start_embedded, HostHandle, HostOptions};

/// 独立 exe 入口：命令行参数、单实例、自有托盘与管理管道都在这里解析。
#[cfg(windows)]
pub fn run() -> anyhow::Result<()> {
    app::run()
}

/// `--describe` 的组件身份（不创建窗口、不读配置）。
#[cfg(windows)]
pub fn describe() -> String {
    component::description().to_string()
}

/// Shared offline entry for the standalone thin shell and the player binary.
/// None means no wallpaper maintenance option was requested.
#[cfg(windows)]
pub fn wallpaper_maintenance(args: &[String]) -> Option<anyhow::Result<String>> {
    wallpaper_upgrade::maintenance_requested(args)
        .then(|| wallpaper_upgrade::maintenance(args).map(|value| value.to_string()))
}

/// Internal restricted worker dispatch. This runs before normal host setup.
#[cfg(windows)]
pub fn wallpaper_worker_entry(args: &[String]) -> Option<anyhow::Result<()>> {
    wallpaper::worker::entry(args)
}

/// Explicit sandbox qualification; it does not enable author Web packages.
#[cfg(windows)]
pub fn wallpaper_sandbox_probe(args: &[String]) -> Option<anyhow::Result<String>> {
    wallpaper::worker::probe_entry(args)
}

/// 独立 exe 的致命错误落宿主日志（播放器内嵌形态由 `start_embedded` 自行记录）。
#[cfg(windows)]
pub fn log(message: &str) {
    app::log(message);
}

/// 开机启动偏好：播放器据此决定是否在启动时拉起进程内宿主。
#[cfg(windows)]
pub fn autostart_enabled() -> bool {
    native::autostart_enabled().unwrap_or(false)
}

/// 非 Windows 的明确降级：播放器侧 `desktop_host` 会据此报「不支持」。
#[cfg(not(windows))]
pub fn run() -> Result<(), &'static str> {
    Err("hertz-desktop only runs on Windows")
}

#[cfg(not(windows))]
pub fn autostart_enabled() -> bool {
    false
}

#[cfg(not(windows))]
pub fn describe() -> String {
    "{}".to_string()
}

#[cfg(not(windows))]
pub fn log(_message: &str) {}
