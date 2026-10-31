// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Player → desktop host management. Keeps the legacy name and one raw JSON message each way.

#[cfg(windows)]
pub(crate) fn send(payload: serde_json::Value) -> anyhow::Result<serde_json::Value> {
    use hertz_desktop_ipc::{management, windows::Cancellation};
    management::request(&management::pipe_name(), &payload, &Cancellation::new())
        .map_err(transport_error)
}

#[cfg(windows)]
fn transport_error(error: std::io::Error) -> anyhow::Error {
    if error.kind() == std::io::ErrorKind::NotFound {
        anyhow::anyhow!("桌面歌词未运行")
    } else {
        anyhow::Error::new(error).context("桌面歌词管理通道请求失败")
    }
}

#[cfg(not(windows))]
pub(crate) fn send(_payload: serde_json::Value) -> anyhow::Result<serde_json::Value> {
    anyhow::bail!("桌面歌词管理通道仅支持 Windows")
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn missing_listener_keeps_standalone_startup_error_mapping() {
        use std::io::{Error, ErrorKind};
        assert!(super::transport_error(Error::from(ErrorKind::NotFound))
            .to_string()
            .contains("未运行"));
        for kind in [
            ErrorKind::TimedOut,
            ErrorKind::PermissionDenied,
            ErrorKind::Interrupted,
        ] {
            assert!(!format!("{:#}", super::transport_error(Error::from(kind))).contains("未运行"));
        }
    }
}
