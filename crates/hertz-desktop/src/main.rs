// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Hertz 桌面歌词宿主。Windows 11 x64 独立组件；其它平台只保留明确的退出码。

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("hertz-desktop only runs on Windows");
    std::process::exit(2);
}

#[cfg(windows)]
mod app;
#[cfg(windows)]
mod bridge;
#[cfg(windows)]
mod component;
#[cfg(windows)]
mod config;
#[cfg(windows)]
mod dbx_feed;
#[cfg(windows)]
mod feed;
#[cfg(windows)]
mod management;
#[cfg(windows)]
mod native;
#[cfg(windows)]
mod pipe;
#[cfg(windows)]
mod wallpaper_feed;

#[cfg(windows)]
fn main() {
    if std::env::args_os().skip(1).any(|arg| arg == "--describe") {
        println!("{}", component::description());
        return;
    }
    if let Err(error) = app::run() {
        app::log(&format!("fatal: {error:#}"));
        eprintln!("hertz-desktop failed: {error:#}");
        std::process::exit(1);
    }
}
