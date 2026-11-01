// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 包内相对路径规则（设计 §6.3）。manifest 的 files[].path 与 ZIP 条目名共用
//! 同一套规则：只允许小写 ASCII 字母、数字与 `-_. /`，实际不允许空格；每段
//! 非空；拒绝 `.`/`..`、反斜杠、冒号、百分号、控制字符、尾点、Windows 保留
//! 设备名、绝对路径。大小写折叠冲突由调用方在集合层查重（跨条目比较）。

use crate::{PackageError, Result, MAX_PATH_BYTES};

const RESERVED_DEVICE_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// 校验包内相对路径。`allow_trailing_slash` 供 ZIP 目录条目使用（以 `/` 结尾）。
pub fn validate_rel_path(path: &str) -> Result<()> {
    validate_rel_path_ext(path, false)
}

pub fn validate_rel_path_ext(path: &str, allow_trailing_slash: bool) -> Result<()> {
    let reject = |code: &'static str, message: String| Err(PackageError::new(code, message));
    if path.is_empty() {
        return reject("invalid_path", "路径不能为空".into());
    }
    if path.len() > MAX_PATH_BYTES {
        return reject("invalid_path", format!("路径超过 {MAX_PATH_BYTES} 个字符：{path}"));
    }
    if !path.is_ascii() {
        return reject("invalid_path", format!("路径只允许 ASCII 字符：{path}"));
    }
    if path.starts_with('/') {
        return reject("invalid_path", format!("路径不允许绝对路径：{path}"));
    }
    let body = if allow_trailing_slash {
        path.strip_suffix('/').unwrap_or(path)
    } else if let Some(stripped) = path.strip_suffix('/') {
        return reject("invalid_path", format!("文件路径不允许以 / 结尾：{stripped}/"));
    } else {
        path
    };
    if body.is_empty() {
        return reject("invalid_path", format!("路径不允许只有分隔符：{path}"));
    }
    for byte in body.bytes() {
        let ok = byte.is_ascii_lowercase()
            || byte.is_ascii_digit()
            || matches!(byte, b'-' | b'_' | b'.' | b'/');
        if !ok {
            return reject(
                "invalid_path",
                format!("路径含非法字符（只允许小写字母、数字、-_. /）：{path}"),
            );
        }
    }
    for segment in body.split('/') {
        if segment.is_empty() {
            return reject("invalid_path", format!("路径存在空段：{path}"));
        }
        if segment == "." || segment == ".." {
            return reject("invalid_path", format!("路径不允许 . / .. 段：{path}"));
        }
        if segment.ends_with('.') {
            return reject("invalid_path", format!("路径段不允许以点结尾：{path}"));
        }
        let stem = segment.split('.').next().unwrap_or(segment);
        if RESERVED_DEVICE_NAMES.contains(&stem) {
            return reject("invalid_path", format!("路径段使用 Windows 保留设备名：{path}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(path: &str) -> String {
        validate_rel_path(path).unwrap_err().code.to_string()
    }

    #[test]
    fn valid_paths_pass() {
        for path in [
            "manifest.json",
            "assets/background.png",
            "content/scene.json",
            "previews/poster.webp",
            "licenses/assets.txt",
            "a/b/c/d-1_x.tar.gz2",
        ] {
            assert!(validate_rel_path(path).is_ok(), "{path}");
        }
        assert!(validate_rel_path_ext("assets/", true).is_ok());
    }

    #[test]
    fn traversal_and_windows_traps_are_rejected() {
        // C09 家族：穿越、绝对路径、反斜杠、盘符、保留名、尾点、大小写。
        assert_eq!(err("assets/../evil.png"), "invalid_path");
        assert_eq!(err("..%2fetc.png"), "invalid_path");
        assert_eq!(err("/assets/background.png"), "invalid_path");
        assert_eq!(err(r"assets\background.png"), "invalid_path");
        assert_eq!(err("c:/assets/background.png"), "invalid_path");
        assert_eq!(err("assets/CON.png"), "invalid_path");
        assert_eq!(err("assets/com1.cfg"), "invalid_path");
        assert_eq!(err("assets/name."), "invalid_path");
        assert!(validate_rel_path("assets/name..png").is_ok()); // 内部双点合法，只禁尾点
        assert_eq!(err("assets//x.png"), "invalid_path");
        assert_eq!(err("assets/x.png/"), "invalid_path");
        assert_eq!(err("Assets/x.png"), "invalid_path");
        assert_eq!(err("assets/空格 .png"), "invalid_path");
        assert_eq!(err(""), "invalid_path");
        assert_eq!(err(&"a".repeat(181)), "invalid_path");
        assert!(validate_rel_path(&"a".repeat(180)).is_ok());
    }
}
