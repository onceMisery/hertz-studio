// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 校验一个 .hwpkg 并输出 JSON 判定，供 `scripts/check-wallpaper-package.js`
//! 驱动端到端检查。判定基于 crate 的同一套实现——不在 JS 里复制校验逻辑。

use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: validate_package <file.hwpkg>");
        return ExitCode::from(2);
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            println!("{{\"ok\":false,\"code\":\"io_error\",\"message\":\"{error}\"}}");
            return ExitCode::SUCCESS;
        }
    };
    if let Err(error) = hertz_wallpaper::archive::check_package_bytes(bytes.len() as u64) {
        println!(
            "{{\"ok\":false,\"code\":\"{}\",\"message\":\"{}\"}}",
            error.code, error.message
        );
        return ExitCode::SUCCESS;
    }
    match hertz_wallpaper::validate_package(std::io::Cursor::new(bytes)) {
        Ok(package) => {
            println!(
                "{{\"ok\":true,\"workId\":\"{}\",\"version\":{},\"title\":\"{}\",\"files\":{}}}",
                package.manifest.work_id,
                package.manifest.version,
                package.manifest.title.replace('\\', "\\\\").replace('"', "\\\""),
                package.entries.len()
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!(
                "{{\"ok\":false,\"code\":\"{}\",\"message\":\"{}\"}}",
                error.code,
                error.message.replace('\\', "\\\\").replace('"', "\\\"")
            );
            ExitCode::SUCCESS
        }
    }
}
