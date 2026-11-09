// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
//! 桌面歌词/设置窗口的**播放器进程内**唯一 owner。
//!
//! 旧链路：`/v1/desktop/*` → `Command::new("hertz-desktop.exe")` → 命名管道补发命令。
//! 新链路：REST / 托盘 / 退出都调用这里的 `ensure_started` / `command` / `shutdown`，
//! 由 `hertz_desktop` 库在**本进程**直接创建歌词窗口与设置窗口，命令经 `mpsc`
//! 送进同一个 tao 事件循环。没有子进程、没有管理管道、没有启动后的等待重试。

use serde_json::Value;
use std::path::Path;

#[cfg(windows)]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};

#[cfg(windows)]
static HOST: OnceLock<Mutex<Option<Arc<hertz_desktop::HostHandle>>>> = OnceLock::new();
/// 播放器 `--window` 自己有托盘时，宿主不再建第二个托盘图标。
#[cfg(windows)]
static PLAYER_TRAY: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static SETTINGS_EVENTS: OnceLock<hertz_desktop::settings_embedding::SettingsEvents> =
    OnceLock::new();

#[cfg(windows)]
pub fn set_settings_events(events: hertz_desktop::settings_embedding::SettingsEvents) {
    let _ = SETTINGS_EVENTS.set(events);
}

#[cfg(windows)]
pub fn place_settings(
    placement: Option<hertz_desktop::settings_embedding::SettingsPlacement>,
) -> anyhow::Result<()> {
    if let Some(handle) = current_handle() {
        handle.place_settings(placement).map_err(anyhow::Error::msg)
    } else if placement.is_some() {
        anyhow::bail!("桌面宿主未运行，请重新打开壁纸设置")
    } else {
        Ok(())
    }
}

/// 由原生主窗口在启动托盘时声明所有权；进程内只会有一个宿主。
pub fn set_player_tray(enabled: bool) {
    #[cfg(windows)]
    PLAYER_TRAY.store(enabled, Ordering::Release);
    #[cfg(not(windows))]
    let _ = enabled;
}

#[cfg(windows)]
fn registry() -> &'static Mutex<Option<Arc<hertz_desktop::HostHandle>>> {
    HOST.get_or_init(|| Mutex::new(None))
}

#[cfg(windows)]
fn current_handle() -> Option<Arc<hertz_desktop::HostHandle>> {
    registry()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().filter(|handle| handle.is_running()).cloned())
}

/// 确保宿主在**当前进程**运行；已运行则原样复用，退出过则重新拉起。
#[cfg(windows)]
pub fn ensure_started(data_dir: &Path) -> anyhow::Result<()> {
    let mut guard = registry()
        .lock()
        .map_err(|_| anyhow::anyhow!("桌面宿主状态锁不可用"))?;
    if guard.as_ref().is_some_and(|handle| handle.is_running()) {
        return Ok(());
    }
    *guard = None;

    // 开机启动项也归播放器：写的是本进程 exe（带窗口与数据目录），
    // 而不是已经退役的桌面组件 exe。
    let player_tray = PLAYER_TRAY.load(Ordering::Acquire);
    let autostart_command = std::env::current_exe().ok().map(|exe| {
        // 有原生主窗口时才带 --window；无窗口服务形态不能凭空要求一个窗口。
        let window = if player_tray { " --window" } else { "" };
        format!(
            "\"{}\"{} --data-dir \"{}\"",
            exe.display(),
            window,
            data_dir.display()
        )
    });
    let handle = hertz_desktop::start_embedded(hertz_desktop::HostOptions {
        data_dir: data_dir.to_path_buf(),
        player_tray,
        autostart_command,
        settings_tab: None,
        locate: false,
        settings_events: SETTINGS_EVENTS.get().cloned(),
    })
    .map_err(anyhow::Error::msg)?;
    *guard = Some(Arc::new(handle));
    Ok(())
}

/// 直接下发一条管理命令；宿主没在跑时如实回「未运行」（REST 映射成
/// `desktop_not_running`，UI 会走 launch 入口在同一进程里把它拉起来）。
#[cfg(windows)]
pub fn command(name: &str, value: Option<Value>) -> anyhow::Result<Value> {
    let handle = current_handle().ok_or_else(|| anyhow::anyhow!("桌面歌词未运行"))?;
    handle.command(name, value).map_err(anyhow::Error::msg)
}

#[cfg(windows)]
pub fn is_running() -> bool {
    current_handle().is_some()
}

/// `--window` 形态下播放器的托盘线程代收了宿主自建菜单（小窗右键）的点击，
/// 原样转回宿主自己的 `handle_menu`，不让这类动作因托盘合并而消失。
#[cfg(windows)]
pub fn menu_event(id: &str) -> anyhow::Result<()> {
    let handle = current_handle().ok_or_else(|| anyhow::anyhow!("桌面歌词未运行"))?;
    handle.menu_event(id).map_err(anyhow::Error::msg)
}

#[cfg(not(windows))]
pub fn menu_event(_id: &str) -> anyhow::Result<()> {
    Ok(())
}

/// 播放器退出前收口：先让宿主自己保存配置并销毁窗口，再继续服务优雅停机。
#[cfg(windows)]
pub fn shutdown() -> anyhow::Result<()> {
    let handle = registry().lock().ok().and_then(|mut guard| guard.take());
    let Some(handle) = handle else { return Ok(()) };
    let _ = handle.command("quit", None);
    if !handle.wait_stopped(std::time::Duration::from_secs(2)) {
        anyhow::bail!("桌面宿主未在 2 秒内完成退出收尾");
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn ensure_started(_data_dir: &Path) -> anyhow::Result<()> {
    anyhow::bail!("桌面歌词窗口仅支持 Windows")
}

#[cfg(not(windows))]
pub fn command(_name: &str, _value: Option<Value>) -> anyhow::Result<Value> {
    anyhow::bail!("桌面歌词未运行")
}

#[cfg(not(windows))]
pub fn is_running() -> bool {
    false
}

#[cfg(not(windows))]
pub fn shutdown() -> anyhow::Result<()> {
    Ok(())
}
