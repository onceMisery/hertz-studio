// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Hertz 桌面歌词宿主（独立形态）。
//!
//! 窗口、页面、配置与业务实现都在 `hertz_desktop` 库里；播放器
//! `hertz-studio.exe` 直接调用同一个库在本进程内开窗。这个 exe 只保留
//! CLI/单实例/原生回归脚本需要的独立入口，不再由播放器启动。

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    #[cfg(not(windows))]
    {
        eprintln!("{}", hertz_desktop::run().unwrap_err());
        std::process::exit(2);
    }

    #[cfg(windows)]
    {
        if std::env::args_os().skip(1).any(|arg| arg == "--describe") {
            println!("{}", hertz_desktop::describe());
            return;
        }
        let args: Vec<String> = std::env::args().skip(1).collect();
        if let Some(result) = hertz_desktop::wallpaper_maintenance(&args) {
            match result {
                Ok(value) => println!("{value}"),
                Err(error) => {
                    eprintln!("wallpaper maintenance failed: {error:#}");
                    std::process::exit(1);
                }
            }
            return;
        }
        if let Err(error) = hertz_desktop::run() {
            let message = format!("hertz-desktop failed: {error:#}");
            hertz_desktop::log(&message);
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}
