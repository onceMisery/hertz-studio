// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! MCP stdio 传输适配层（技术路线 §5.3 / R2-M）。
//!
//! 一个可执行文件、两种身份：常规启动是独立播放器服务；`--mcp-stdio`
//! 启动是薄适配进程——在数据迁移、bootstrap、数据库、音频与 HTTP 监听
//! **之前**分流，只读显式 DataDir 里的 [`discovery`] 发现文件与专用 grant
//! 凭据文件，认证后把受限调用转发给已运行的独立服务。它不获取 runner
//! 锁、不执行迁移、不打开业务数据库、不启动播放器或浏览器；stdout 专属
//! SDK transport，日志与横幅一律去 stderr。
//!
//! SDK 选型（rmcp 3.5.1，Apache-2.0，MSRV 1.88）的验证记录在 [`server`]
//! 模块头。协议基线 `2025-11-25`；`tools/list` 从能力表按会话 scope 导出，
//! `tools/call` 每次由门面重新认证授权。

pub mod adapter;
pub mod discovery;
pub mod server;
