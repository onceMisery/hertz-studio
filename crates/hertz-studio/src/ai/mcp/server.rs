// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! rmcp 之上的 stdio 适配器服务（技术路线 §5.3 / R2-M）。
//!
//! SDK 选型结论（实施前验证，记录在此）：rmcp 3.5.1，Apache-2.0（与
//! 仓库 MIT 兼容，NOTICE 已列），MSRV 1.88 与工作区一致，tokio 1.x 兼容，
//! stdio transport 与 tools 能力齐备——依赖锁定在 Cargo.lock。协议基线
//! `2025-11-25`（`ProtocolVersion::V_2025_11_25`，SDK 的 default 是更新的
//! 版本，这里显式声明基线，不跟随 SDK 升级静默前移）。
//!
//! 会话即凭据：一个适配进程绑定一份 grant。`tools/list` 按会话 scope
//! 过滤导出；`tools/call` 每次转发到受限门面，由门面再次认证授权（撤权
//! 即时生效，工具目录不会在会话中静默扩展）。首期不声明 resources、
//! prompts、sampling、elicitation、tasks 或 listChanged。stdout 专属
//! transport，日志全部走 stderr（tracing 默认 writer）。
//!
//! 未连接时：握手照常，`tools/list` 为空，`tools/call` 返回工具级错误
//! `not_connected`——不自动启动第二个播放器实例，不伪造结果。

use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, Implementation, ListToolsResult,
    PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig,
};
use rmcp::service::{RequestContext, RoleServer, ServiceExt};
use rmcp::transport::stdio;
use rmcp::ErrorData as McpError;

use super::adapter::{self, AdapterConfig, Session};
use crate::ai::capability::find;

pub(crate) struct FacadeServer {
    session: Session,
    client: reqwest::Client,
}

impl ServerHandler for FacadeServer {
    fn get_info(&self) -> ServerConfig {
        let mut implementation = Implementation::from_build_env();
        implementation.name = "hertz-studio-ai".into();
        implementation.version = env!("CARGO_PKG_VERSION").into();
        implementation.title = Some("Hertz Studio 受限能力门面".into());
        let mut info = ServerConfig::new(ServerCapabilities::builder().enable_tools().build());
        info.protocol_version = ProtocolVersion::V_2025_11_25;
        info.server_info = implementation;
        info.instructions = Some(
            "受限播控门面：工具目录来自会话授权的 scope；变更命令带 \
             clientOperationId 可获得幂等保护（同键同输入窗口内只执行一次）。"
                .into(),
        );
        info
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let tools = match &self.session {
            Session::Connected { scopes, .. } => adapter::tools_for(scopes),
            Session::NotConnected => Vec::new(),
        };
        Ok(ListToolsResult {
            tools,
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        // 未登记的工具名是协议级错误（§12.1 MCP 反例：未知工具 → 标准错误）；
        // 已登记的工具失败走工具级错误，机器码原样透传给调用方。
        if find(&request.name).is_none() {
            return Err(McpError::invalid_params(
                format!("未知工具: {}", request.name),
                None,
            ));
        }
        let result = adapter::call_tool(
            &self.client,
            &self.session,
            &request.name,
            request.arguments.as_ref(),
        )
        .await;
        Ok(result.into())
    }
}

/// 适配进程入口：解析会话（发现 + 凭据 + context 认证）后，在 stdin/stdout
/// 上跑 rmcp 服务直到传输关闭。退出不关闭播放器——播放器是另一个进程。
pub async fn run_stdio(cfg: AdapterConfig) -> anyhow::Result<()> {
    let client = adapter::http_client().map_err(anyhow::Error::msg)?;
    let session = match adapter::open_session(&client, &cfg).await {
        Ok(session) => session,
        Err(e) => {
            eprintln!("hertz-studio-ai: {e}");
            anyhow::bail!("{e}");
        }
    };
    match &session {
        Session::Connected {
            server_instance_id, ..
        } => {
            eprintln!("hertz-studio-ai: connected (serverInstanceId {server_instance_id})");
        }
        Session::NotConnected => {
            eprintln!("hertz-studio-ai: not connected; serving handshake only");
        }
    }
    let server = FacadeServer { session, client };
    let (stdin, stdout) = stdio();
    let running = server.serve((stdin, stdout)).await?;
    running.waiting().await?;
    Ok(())
}
