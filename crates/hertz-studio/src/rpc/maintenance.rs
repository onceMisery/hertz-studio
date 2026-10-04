// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 备份与播放诊断日志。
//!
//! 逐个对应 `routes.rs` 里的同名 handler，逻辑照抄（理由见 `rpc/mod.rs`）。
//! `diagnostics_json` 与 `DIAG_LOG_LIMIT` 复用 routes 那一份：日志上限与回显字段
//! 是两个宿主共用的契约，各写一份迟早漂移。
//!
//! # 日志下载与 HTTP 版不同形
//!
//! HTTP 版是 `text/plain` 附件，Content-Disposition 里带一个含日期的文件名；信封
//! 只能装 JSON，所以体是一个**裸 JSON 字符串**（与歌单的 m3u 导出同一套办法）。
//! 前端 `diagLogText()` 在插件形态下写的正是 `typeof text === 'string' ? text : ''`，
//! 拿到之后交给宿主 `saveFile` 存盘，文件名也是它自己拼的，所以服务端不必再回
//! 一个 filename 字段。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::error::{bad_request, internal};
use crate::routes::{diagnostics_json, store_err, DiagnosticsUpdate, DIAG_LOG_LIMIT};
use crate::rpc::{body_as, Reply, RpcResult};
use crate::state::AppState;

/// 导出用户数据备份（JSON）。不含凭据：凭据只存系统钥匙串。
pub async fn export_backup(state: &Arc<AppState>) -> RpcResult {
    let backup = vmusic_store::backup::export(&state.db)
        .await
        .map_err(store_err)?;
    Ok(Reply::ok(
        serde_json::to_value(&backup).map_err(|e| internal(e.to_string()))?,
    ))
}

/// 恢复备份：格式校验失败 400，单事务写入，幂等。
pub async fn restore_backup(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: vmusic_store::backup::BackupFile = body_as(body)?;
    let report = vmusic_store::backup::restore(&state.db, &request)
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    Ok(Reply::ok(
        serde_json::to_value(&report).map_err(|e| internal(e.to_string()))?,
    ))
}

/// 开发者选项状态：开关 + 日志落在哪个文件、有多大。路径必须回显给用户——
/// 「把日志发给开发者」这一步不能要求用户先去翻数据目录。
pub async fn get_diagnostics() -> RpcResult {
    Ok(Reply::ok(diagnostics_json()))
}

/// 开关播放诊断日志：settings 落库 + 运行态即时切换，不要求重启服务。
///
/// 这条单独走接口而不是 `PUT /v1/settings`，因为那条路只写库、不会让运行中的
/// 服务改变行为。
pub async fn set_diagnostics(state: &Arc<AppState>, body: &Value) -> RpcResult {
    let request: DiagnosticsUpdate = body_as(body)?;
    vmusic_store::settings::set(&state.db, crate::diag::SETTING_KEY, &json!(request.enabled))
        .await
        .map_err(store_err)?;
    // 开启会建目录并写一条会话头，关闭也写一行收尾——都是小文件操作，但确实是
    // 同步 IO，放阻塞线程池里，别占着 worker。
    let on = request.enabled;
    tokio::task::spawn_blocking(move || crate::diag::set_enabled(on))
        .await
        .map_err(|e| internal(e.to_string()))?;
    Ok(Reply::ok(diagnostics_json()))
}

pub async fn download_log() -> RpcResult {
    let (text, skipped) = tokio::task::spawn_blocking(|| crate::diag::read(DIAG_LOG_LIMIT))
        .await
        .map_err(|e| internal(e.to_string()))?
        .map_err(|e| internal(format!("读取诊断日志失败: {e}")))?;
    // 只给了后半段时把这件事写进文本本身，否则开发者会以为这就是全部。
    let body = if skipped > 0 {
        format!("[导出时省略了最旧的 {skipped} 字节]\n{text}")
    } else {
        text
    };
    Ok(Reply::ok(Value::String(body)))
}

/// 清空日志。开关保持原样——用户的下一步通常是「清一次，再复现一遍」。
pub async fn clear_log() -> RpcResult {
    tokio::task::spawn_blocking(crate::diag::clear)
        .await
        .map_err(|e| internal(e.to_string()))?
        .map_err(|e| internal(format!("清空诊断日志失败: {e}")))?;
    Ok(Reply::ok(json!({ "ok": true })))
}
