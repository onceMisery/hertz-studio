// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! AI 受限能力面：grants、认证与受限调用（技术路线 R2-G）。
//!
//! 两条入口、两组认证，最终走同一应用服务：
//!
//! - **官方本机管理**（`/v1/ai/grants*`，全权 token 后面）：创建/轮换/撤销
//!   grant，只拿安全摘要。明文凭据由服务端写进 DataDir 下固定子目录的
//!   凭据文件，应答与日志都不回显秘密。
//! - **受限门面**（`/v1/ai/capabilities/*`，独立路由组 + 专用
//!   `Authorization: Bearer`）：凭据换成 `GrantContext` 后执行登记过的
//!   能力。受限凭据够不到 `/v1/player/*`、`/v1/settings` 或管理端点——
//!   [`capability::execute`] 是最终执行点，scope 不对即拒绝，不依赖中间件
//!   一层防线。
//!
//! 变更类能力统一经 [`crate::idempotency`]，principal 绑定 grantId；完成
//! 事实（applied/no_op/superseded）原样透传，不在这里二次粉饰。
//!
//! 尚未在本模块、按路线图属于后续任务包的部分：`ai-discovery.json` 与
//! AI runner 锁（消费方是 R2-M 适配器与 R4 AiService）、Windows ACL 与
//! 路径别名实测（§13 留待 R2-G/R4-J）、并发槽位（§8.3）。

pub(crate) mod capability;
pub(crate) mod facade;
pub mod lock;
pub mod mcp;
