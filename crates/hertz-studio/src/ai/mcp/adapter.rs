// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 适配进程的会话与转发层（技术路线 §5.3）。
//!
//! `--mcp-stdio` 进程只读两样东西：显式 DataDir 里的发现文件与专用 grant
//! 凭据文件。它不执行迁移、不打开业务数据库、不获取 AI runner 锁、不启动
//! 播放器或浏览器；所有业务副作用都在**已运行的独立服务**里发生——这里
//! 只是把认证后的受限调用转发过去。
//!
//! 会话三种结局：
//! - `Connected`：发现可达 + 唯一可用凭据 + `capabilities/context` 认证通过，
//!   `tools/list` 按 context 里的 scope 过滤导出；
//! - `NotConnected`：发现缺失/陈旧、没有凭据文件或认证/网络失败——协议
//!   握手照常完成，但不公布任何业务工具，调用如实回 `not_connected`；
//! - `AmbiguousGrants`：多个凭据文件又没指定 `--grant`——硬错误退出，
//!   不替用户猜。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use rmcp::model::{CallToolResult, Tool, ToolAnnotations};
use serde_json::{json, Value};
use vmusic_core::PROTOCOL_VERSION;

use super::discovery::{self, DiscoveryDoc};
use crate::ai::capability::{find, Effect, CAPABILITIES, CAPABILITY_VERSION};

/// 观察者总等待上限（§8.3）：适配进程对门面的每次调用（含认证与排队）
/// 都在这个期限内给出结果或错误。
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

#[derive(Debug, Clone)]
pub struct AdapterConfig {
    pub data_dir: PathBuf,
    pub grant_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) enum Session {
    Connected {
        base_url: String,
        credential: String,
        scopes: BTreeSet<String>,
        server_instance_id: String,
    },
    NotConnected,
}

#[derive(Debug)]
pub(crate) enum SessionError {
    /// 多个凭据文件又没有 `--grant`：不猜，要求用户显式选择。
    AmbiguousGrants(Vec<String>),
    /// 显式指定的 grant 没有对应凭据文件。
    GrantNotFound(String),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::AmbiguousGrants(ids) => write!(
                f,
                "找到 {} 个凭据文件（{}），请用 --grant <grantId> 显式选择",
                ids.len(),
                ids.join(", ")
            ),
            SessionError::GrantNotFound(id) => {
                write!(f, "指定的 grant 没有凭据文件: {id}")
            }
        }
    }
}

fn grants_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("ai").join("grants")
}

/// 现存的凭据文件（已撤销的 grant 在撤销时已删文件，所以剩下的就是可用的）。
fn grant_files(data_dir: &Path) -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(grants_dir(data_dir))
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.strip_suffix(".key").map(str::to_string)
        })
        .filter(|id| id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
        .collect();
    ids.sort();
    ids
}

/// 受限门面的 HTTP 客户端：禁环境代理、禁重定向、固定 8 秒总期限（§5.5：
/// 适配器只连 `127.0.0.1`，禁止环境代理与任意 baseUrl）。
pub(crate) fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(CALL_TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败: {e}"))
}

async fn authorized_get(
    client: &reqwest::Client,
    base_url: &str,
    path: &str,
    credential: &str,
    server_instance_id: &str,
) -> Result<(u16, Value), String> {
    let url = format!("{base_url}{path}");
    let response = client
        .get(url)
        .bearer_auth(credential)
        // 实例绑定（§5.5）：每个调用附会话建立时看到的实例身份。
        .header("x-server-instance-id", server_instance_id)
        .send()
        .await
        .map_err(|e| format!("受限服务不可达: {e}"))?;
    let status = response.status().as_u16();
    let body = response
        .json::<Value>()
        .await
        .map_err(|e| format!("受限服务应答不是合法 JSON: {e}"))?;
    Ok((status, body))
}

/// 打开会话。发现不可达/无凭据/认证失败都不算错误——那正是「未连接」
/// 的定义，适配进程仍要能完成协议握手。
pub(crate) async fn open_session(
    client: &reqwest::Client,
    cfg: &AdapterConfig,
) -> Result<Session, SessionError> {
    let doc: DiscoveryDoc = match discovery::read(&cfg.data_dir) {
        Ok(doc) => doc,
        Err(_) => return Ok(Session::NotConnected),
    };
    let ids = grant_files(&cfg.data_dir);
    let grant_id = match (&cfg.grant_id, ids.as_slice()) {
        (Some(id), _) => {
            let path = grants_dir(&cfg.data_dir).join(format!("{id}.key"));
            if !path.exists() {
                return Err(SessionError::GrantNotFound(id.clone()));
            }
            id.clone()
        }
        (None, []) => return Ok(Session::NotConnected),
        (None, [only]) => only.clone(),
        (None, many) => return Err(SessionError::AmbiguousGrants(many.to_vec())),
    };
    let credential =
        match std::fs::read_to_string(grants_dir(&cfg.data_dir).join(format!("{grant_id}.key"))) {
            Ok(secret) => secret.trim().to_string(),
            Err(_) => return Ok(Session::NotConnected),
        };
    // 用 context 核对身份：401/403/不可达都归入「未连接」。context 里的
    // scope 是服务端查询出来的事实，tools/list 只信它，不信本地猜测。
    let (status, body) = match authorized_get(
        client,
        &format!("http://127.0.0.1:{}", doc.port),
        "/v1/ai/capabilities/context",
        &credential,
        &doc.server_instance_id,
    )
    .await
    {
        Ok(pair) => pair,
        Err(_) => return Ok(Session::NotConnected),
    };
    if status != 200 {
        return Ok(Session::NotConnected);
    }
    let scopes: BTreeSet<String> = body["scopes"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(Session::Connected {
        base_url: format!("http://127.0.0.1:{}", doc.port),
        credential,
        scopes,
        server_instance_id: body["instance"]["serverInstanceId"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    })
}

/// 工具入参 schema：登记表里每条能力的输入形状。与 `capability::execute`
/// 的 `deny_unknown_fields` DTO 逐字对应。
fn input_schema(operation: &str) -> rmcp::model::JsonObject {
    let schema = match operation {
        "playback.seek" => json!({
            "type": "object",
            "properties": { "positionMs": { "type": "integer", "minimum": 0 } },
            "required": ["positionMs"],
            "additionalProperties": false,
        }),
        "playback.volume_set" => json!({
            "type": "object",
            "properties": { "value": { "type": "number", "minimum": 0, "maximum": 1 } },
            "required": ["value"],
            "additionalProperties": false,
        }),
        _ => json!({ "type": "object", "properties": {}, "additionalProperties": false }),
    };
    schema.as_object().expect("schema 是 object").clone()
}

/// 从能力表导出工具定义（技术路线 §5.1/§5.3）：只导出该会话 scope 覆盖的
/// 能力，不声明 resources/prompts/listChanged。annotations 是提示不是权限：
/// 只读能力标 readOnlyHint；变更能力保守不标幂等，客户端不应自动重试。
pub(crate) fn tools_for(scopes: &BTreeSet<String>) -> Vec<Tool> {
    CAPABILITIES
        .iter()
        .filter(|cap| scopes.contains(cap.scope))
        .map(|cap| {
            let mut annotations = ToolAnnotations::default();
            annotations.read_only_hint = Some(cap.effect == Effect::ReadOnly);
            let mut tool = Tool::new(cap.operation, cap.description, input_schema(cap.operation));
            tool.annotations = Some(annotations);
            tool
        })
        .collect()
}

/// 把一次 `tools/call` 转发到受限门面。这里只有两种本地结论：未连接
/// （工具级错误 `not_connected`）与门面应答的透传——成功是结构化事实，
/// 失败保留门面的稳定机器码，调用方看得见、可分支。
pub(crate) async fn call_tool(
    client: &reqwest::Client,
    session: &Session,
    name: &str,
    arguments: Option<&rmcp::model::JsonObject>,
) -> CallToolResult {
    let Session::Connected {
        base_url,
        credential,
        server_instance_id,
        ..
    } = session
    else {
        return not_connected_result();
    };
    // 未登记的能力在 server.rs 已被拦下；防御到底再查一次。
    if find(name).is_none() {
        return error_result(json!({
            "code": "capability_unsupported",
            "message": format!("未登记的能力: {name}"),
        }));
    }
    let arguments = arguments.cloned().unwrap_or_default();
    // clientOperationId 是适配层的调用身份（§5.2：每个新动作新键）；调用方
    // 不带就每次生成，绝不静默复用上一个键。
    let client_operation_id = arguments
        .get("clientOperationId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let input = arguments
        .into_iter()
        .filter(|(k, _)| k != "clientOperationId")
        .collect::<Value>();
    let url = format!("{base_url}/v1/ai/capabilities/call");
    let response = client
        .post(url)
        .bearer_auth(credential)
        .header("x-server-instance-id", server_instance_id)
        .json(&json!({
            "operation": name,
            "clientOperationId": client_operation_id,
            "input": input,
        }))
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(e) => {
            return error_result(json!({ "code": "not_connected", "message": e.to_string() }))
        }
    };
    let status = response.status().as_u16();
    let body: Value = match response.json().await {
        Ok(body) => body,
        Err(e) => return error_result(json!({ "code": "bad_reply", "message": e.to_string() })),
    };
    if status == 200 {
        return CallToolResult::structured(body);
    }
    // 门面错误体是 {"error":{code,message,...}}；工具级错误保留机器码。
    let detail = &body["error"];
    error_result(json!({
        "code": detail["code"].as_str().unwrap_or("upstream_error"),
        "message": detail["message"].as_str().unwrap_or("受限调用失败"),
        "status": status,
    }))
}

fn not_connected_result() -> CallToolResult {
    CallToolResult::structured_error(json!({
        "code": "not_connected",
        "message": "受限服务未连接：启动 hertz-studio 并确认凭据文件存在",
        "protocolVersion": PROTOCOL_VERSION,
        "capabilityVersion": CAPABILITY_VERSION,
    }))
}

fn error_result(detail: Value) -> CallToolResult {
    CallToolResult::structured_error(detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;

    fn temp_data_dir() -> PathBuf {
        std::env::temp_dir().join(format!("vmusic-mcp-{}", uuid::Uuid::new_v4()))
    }

    fn write_discovery(dir: &Path, port: u16, server_instance_id: &str) {
        discovery::publish(
            dir,
            &DiscoveryDoc {
                version: discovery::DISCOVERY_VERSION,
                pid: 1,
                port,
                protocol_version: "1".into(),
                owner_instance_id: "owner".into(),
                server_instance_id: server_instance_id.to_string(),
                edition: "standard".into(),
            },
        )
        .unwrap();
    }

    #[tokio::test]
    async fn missing_discovery_means_not_connected_not_error() {
        let dir = temp_data_dir();
        let client = http_client().unwrap();
        let session = open_session(
            &client,
            &AdapterConfig {
                data_dir: dir,
                grant_id: None,
            },
        )
        .await
        .unwrap();
        assert!(matches!(session, Session::NotConnected));
        assert!(tools_for(&BTreeSet::new()).is_empty());
    }

    #[tokio::test]
    async fn two_grants_without_choice_is_an_error_and_one_grant_connects() {
        let dir = temp_data_dir();
        write_discovery(&dir, 1, "server");
        let grants = grants_dir(&dir);
        std::fs::create_dir_all(&grants).unwrap();
        std::fs::write(grants.join("grant-a.key"), "secret-a").unwrap();
        std::fs::write(grants.join("grant-b.key"), "secret-b").unwrap();
        let client = http_client().unwrap();
        let ambiguous = open_session(
            &client,
            &AdapterConfig {
                data_dir: dir.clone(),
                grant_id: None,
            },
        )
        .await;
        assert!(matches!(ambiguous, Err(SessionError::AmbiguousGrants(_))));
        // 显式选择 + 服务不可达（端口 1 没人听）→ 未连接而不是错误。
        let session = open_session(
            &client,
            &AdapterConfig {
                data_dir: dir.clone(),
                grant_id: Some("grant-a".into()),
            },
        )
        .await
        .unwrap();
        assert!(matches!(session, Session::NotConnected));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端：起真实路由（require_grant → 能力表 → 短写幂等 → 播控），
    /// 适配进程按发现文件对接并转发 tools/call。
    async fn e2e_setup() -> (Arc<AppState>, std::thread::JoinHandle<()>, String) {
        let dir = temp_data_dir();
        let db = vmusic_store::open(&dir).await.unwrap();
        let (mut state, handle) = crate::state::tests::playback_state_with_db(db).await;
        state.data_dir = dir.clone();
        // 测试进程模拟「持锁 + 回环绑定」的独立服务：两组门禁都打开。
        state
            .ai_runner_held
            .store(true, std::sync::atomic::Ordering::Relaxed);
        state
            .ai_external_ready
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let state = Arc::new(state);
        let app = crate::routes::router(state.clone()).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        write_discovery(&dir, port, &state.server_instance_id().to_string());
        let summary = crate::ai::facade::create_grant(
            &state,
            "e2e",
            &["playback:control".to_string(), "playback:read".to_string()],
        )
        .await
        .unwrap();
        let credential = std::fs::read_to_string(&summary.credential_path).unwrap();
        (state, handle, credential)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn adapter_forwards_calls_to_the_real_facade() {
        let (state, handle, credential) = e2e_setup().await;
        let _ = &credential;
        let dir = state.data_dir.clone();
        let client = http_client().unwrap();
        let session = open_session(
            &client,
            &AdapterConfig {
                data_dir: dir.clone(),
                grant_id: None,
            },
        )
        .await
        .unwrap();
        let Session::Connected { scopes, .. } = &session else {
            panic!("发现 + 唯一凭据 + 在线门面必须连接成功");
        };
        assert!(scopes.contains("playback:control"));
        let ctx_snapshot = crate::ai::facade::authenticate(&state, &credential)
            .await
            .unwrap();
        let _ = ctx_snapshot;

        // tools/call 走完整链路：require_grant → capability → short_write。
        // 真实队列上的同键 next：第二次是回放，游标只前进一格——
        // 空队列上的两次 no-op 无法证明「只执行一次」。
        vmusic_store::upsert_track(
            &state.db,
            &vmusic_core::Track {
                id: "second".into(),
                path: "second.wav".into(),
                source: vmusic_core::TrackSource::Local,
                title: "second".into(),
                artist: None,
                album: None,
                duration_ms: None,
                bitrate: None,
                sample_rate: None,
                channels: None,
                has_cover: false,
                file_mtime: None,
                file_size: None,
                added_at: 0,
            },
        )
        .await
        .unwrap();
        state
            .set_queue(vec!["first".into(), "second".into()], Some(0))
            .await;
        state
            .audio
            .load("first.wav", Some("first".into()))
            .await
            .unwrap();
        let next_args = json!({ "clientOperationId": "mcp-next-1" })
            .as_object()
            .cloned();
        let first_next = call_tool(&client, &session, "playback.next", next_args.as_ref()).await;
        let second_next = call_tool(&client, &session, "playback.next", next_args.as_ref()).await;
        let first_next = serde_json::to_value(&first_next).unwrap();
        let second_next = serde_json::to_value(&second_next).unwrap();
        assert_eq!(
            first_next["structuredContent"],
            second_next["structuredContent"]
        );
        assert_eq!(state.current_index().await, Some(1), "同键 next 只执行一次");

        let result = call_tool(&client, &session, "playback.pause", None).await;
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["structuredContent"]["outcome"], "applied");
        assert_eq!(value["isError"], json!(false));
        assert_ne!(value["structuredContent"]["generation"], json!(null));

        // clientOperationId 进了幂等键：同键两次只执行一次（回放同代际）。
        let args = json!({ "clientOperationId": "mcp-op-1" })
            .as_object()
            .cloned();
        let first = call_tool(&client, &session, "playback.next", args.as_ref()).await;
        let second = call_tool(&client, &session, "playback.next", args.as_ref()).await;
        let first = serde_json::to_value(&first).unwrap();
        let second = serde_json::to_value(&second).unwrap();
        assert_eq!(first["structuredContent"], second["structuredContent"]);

        // 适配进程只登记能力表内的工具；未知名字在转发前被拦下。
        let result = call_tool(&client, &session, "playback.replace_queue", None).await;
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["structuredContent"]["code"], "capability_unsupported");
        assert_eq!(value["isError"], json!(true));

        // 门面侧的稳定机器码原样透传（越界音量 → bad_request）。
        let args = json!({ "value": 1.5 }).as_object().cloned();
        let result = call_tool(&client, &session, "playback.volume_set", args.as_ref()).await;
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["structuredContent"]["code"], "bad_request");
        assert_eq!(value["isError"], json!(true));
        state.audio.shutdown();
        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stale_credential_degrades_to_not_connected() {
        let (state, handle, _credential) = e2e_setup().await;
        let dir = state.data_dir.clone();
        // 把凭据文件换成错的秘密：context 认证失败 → 未连接，握手仍可用。
        let grant_path = dir.join("ai").join("grants");
        let grant_id = std::fs::read_dir(&grant_path)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .file_name()
            .to_string_lossy()
            .into_owned();
        std::fs::write(grant_path.join(&grant_id), "wrong-secret").unwrap();
        let client = http_client().unwrap();
        let session = open_session(
            &client,
            &AdapterConfig {
                data_dir: dir.clone(),
                grant_id: None,
            },
        )
        .await
        .unwrap();
        assert!(matches!(session, Session::NotConnected));
        // 未连接也能拿到（空的）工具目录与明确的 not_connected 调用结论。
        assert!(tools_for(&BTreeSet::new()).is_empty());
        let result = call_tool(&client, &session, "playback.pause", None).await;
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["structuredContent"]["code"], "not_connected");
        state.audio.shutdown();
        handle.join().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tools_are_filtered_by_session_scopes_and_annotated() {
        let mut read_only = BTreeSet::new();
        read_only.insert("playback:read".to_string());
        let tools = tools_for(&read_only);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "playback.snapshot_get");
        assert_eq!(
            tools[0].annotations.as_ref().unwrap().read_only_hint,
            Some(true)
        );

        let mut control = BTreeSet::new();
        control.insert("playback:control".to_string());
        let tools = tools_for(&control);
        assert_eq!(tools.len(), 6);
        assert!(tools
            .iter()
            .all(|t| t.annotations.as_ref().unwrap().read_only_hint == Some(false)));
        // 变更工具的入参 schema 有 additionalProperties:false（投影纪律）。
        let seek = tools.iter().find(|t| t.name == "playback.seek").unwrap();
        assert_eq!(
            seek.input_schema.get("additionalProperties"),
            Some(&json!(false))
        );
    }
}
