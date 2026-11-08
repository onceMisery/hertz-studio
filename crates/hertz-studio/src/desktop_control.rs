// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 播放器 → 桌面宿主的控制面。
//!
//! 旧实现是命名管道客户端（`management::request`），命令要转给另一个 exe。
//! 现在宿主就在本进程：这里只把 JSON 意图交给 `desktop_host`，由它送进
//! 宿主的事件循环。模块名保留，传输与转发整体退役。

pub(crate) fn send(payload: serde_json::Value) -> anyhow::Result<serde_json::Value> {
    let command = payload
        .get("command")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("桌面控制命令缺失"))?;
    let value = payload.get("value").cloned();
    crate::desktop_host::command(command, value)
}

#[cfg(test)]
mod tests {
    #[test]
    fn commands_without_a_name_never_reach_the_host() {
        assert!(super::send(serde_json::json!({ "value": 1 })).is_err());
    }
}
