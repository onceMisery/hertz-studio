// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! mmusic-studio 的服务端逻辑。
//!
//! 这个 crate 同时产出两个可执行入口：
//! - `hertz-studio`（`src/main.rs`）：独立形态，axum HTTP + WebSocket，自带内嵌界面；
//! - `plugin/backend`：DBX 插件形态，stdio JSON-RPC sidecar。
//!
//! 两者共用这里的全部业务逻辑。传输相关的东西只有三处：`routes`（REST 路由表）、
//! `ws`（WebSocket 事件下发）、`main`（独立进程装配）。`rpc` 是与传输无关的 JSON
//! 门面，DBX 插件走它。
//!
//! 拆 lib 的约束：`state::AppState` 有一批 `pub(crate)` 字段（`radio`、`online_meta`、
//! `downloads`、`quality`、`keep`、`protected` 等），插件的 dispatcher 必须留在本 crate
//! 内部才碰得到，所以 `rpc` 在这里而不在 `plugin/backend`。

pub mod bootstrap;
pub mod config;
pub mod daily;
pub mod diag;
pub mod error;
pub mod history;
pub mod online;
pub mod persist;
pub mod radio;
pub mod remote;
pub mod routes;
pub mod rpc;
pub mod scan;
pub mod secrets;
pub mod stage_beats;
pub mod state;
pub mod ws;
