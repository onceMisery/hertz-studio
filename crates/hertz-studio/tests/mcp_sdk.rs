// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Official rmcp client against the actual standalone and stdio executables.
//! Run locally with --target-dir target/mcp-sdk-check to keep a running debug
//! player untouched. This is SDK interoperability, not target-app acceptance.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{ensure, Context, Result};
use reqwest::Method;
use rmcp::model::{
    CallToolRequest, CallToolRequestParams, CallToolResult, ClientConfig, ErrorCode,
    ProtocolVersion,
};
use rmcp::service::{PeerRequestOptions, RoleClient, RunningService, ServiceError, ServiceExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::{sleep, timeout};
use vmusic_core::{Track, TrackSource};

type Client = RunningService<RoleClient, ClientConfig>;
const BINARY: &str = env!("CARGO_BIN_EXE_hertz-studio");

async fn fixture_request(
    socket: tokio::net::TcpStream,
) -> Result<(BufReader<tokio::net::TcpStream>, String)> {
    let mut socket = BufReader::new(socket);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        ensure!(
            socket.read_line(&mut line).await? > 0,
            "HTTP request truncated"
        );
        ensure!(
            headers.len() + line.len() <= 16 * 1024,
            "HTTP fixture header bound"
        );
        if line == "\r\n" {
            break;
        }
        headers.push_str(&line);
    }
    let length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    ensure!(length <= 16 * 1024, "HTTP fixture body bound");
    let mut body = vec![0; length];
    socket.read_exact(&mut body).await?;
    if length > 0 {
        ensure!(
            serde_json::from_slice::<Value>(&body)?["operation"] == "playback_pause",
            "unexpected forwarded tool"
        );
    }
    Ok((socket, headers))
}

/// Real SDK + actual adapter process + deliberately stalled loopback facade.
/// Socket EOF proves only local HTTP wait cancellation, not remote rollback.
#[tokio::test]
async fn official_sdk_cancel_timeout_and_disconnect_drop_the_http_wait() -> Result<()> {
    use hertz_studio::ai::mcp::discovery::{publish, DiscoveryDoc, DISCOVERY_VERSION};
    let mut fixture = Fixture::new()?;
    let result = timeout(Duration::from_secs(50), async {
        for mode in ["cancel", "timeout", "disconnect"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let port = listener.local_addr()?.port();
            let dir = fixture.root.join(mode);
            std::fs::create_dir_all(dir.join("ai/grants"))?;
            std::fs::write(
                dir.join("ai/grants/fixture.key"),
                "isolated-fixture-credential",
            )?;
            publish(
                &dir,
                &DiscoveryDoc {
                    version: DISCOVERY_VERSION,
                    pid: std::process::id(),
                    port,
                    protocol_version: "1".into(),
                    owner_instance_id: "fixture-owner".into(),
                    server_instance_id: "fixture-server".into(),
                    edition: "standard".into(),
                },
            )
            .map_err(anyhow::Error::msg)?;
            let (arrived_tx, arrived) = tokio::sync::oneshot::channel();
            let mut server = tokio::spawn(async move {
                let (socket, _) = listener.accept().await?;
                let (mut context, headers) = fixture_request(socket).await?;
                ensure!(
                    headers.starts_with("GET /v1/ai/capabilities/context "),
                    "context route"
                );
                ensure!(
                    headers
                        .to_ascii_lowercase()
                        .contains("authorization: bearer isolated-fixture-credential"),
                    "fixture auth missing"
                );
                let body = json!({"protocolVersion": "1", "principal": {"kind": "grant", "grantId": "fixture"},
                    "scopes": ["playback:pause"], "policyRevision": 1, "stageIntentToolsEnabled": false,
                    "instance": {"ownerInstanceId": "fixture-owner", "serverInstanceId": "fixture-server",
                        "edition": "standard", "transport": "http"},
                    "capabilities": [{"operation": "playback.pause", "mcpName": "playback_pause",
                        "capabilityVersion": "1"}]})
                .to_string();
                context
                    .get_mut()
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                        .as_bytes(),
                    )
                    .await?;
                context.get_mut().shutdown().await?;
                drop(context);
                let (socket, _) = listener.accept().await?;
                let (mut socket, headers) = fixture_request(socket).await?;
                ensure!(
                    headers.starts_with("POST /v1/ai/capabilities/call "),
                    "capability route"
                );
                let _ = arrived_tx.send(());
                let mut byte = [0];
                ensure!(
                    socket.read(&mut byte).await? == 0,
                    "adapter did not close stalled request"
                );
                Ok::<_, anyhow::Error>(())
            });
            let scenario = async {
                let client = fixture
                    .connect(&dir, Some("fixture"), ClientConfig::default())
                    .await?;
                let mut request = client
                    .send_cancellable_request(
                        CallToolRequest::new(CallToolRequestParams::new("playback_pause")).into(),
                        PeerRequestOptions::no_options(),
                    )
                    .await?;
                timeout(Duration::from_secs(3), arrived)
                    .await
                    .context("forwarded HTTP did not arrive")??;
                match mode {
                    "cancel" => {
                        request.cancel(Some("user stopped waiting".into())).await?;
                        timeout(Duration::from_secs(2), &mut server)
                            .await
                            .context("cancel kept HTTP wait alive")???;
                        ensure!(
                            client.list_all_tools().await?.len() == 1,
                            "request cancellation ended the session"
                        );
                        client.cancel().await?;
                    }
                    "timeout" => {
                        request.options.timeout = Some(Duration::from_millis(100));
                        ensure!(
                            matches!(
                                request.await_response().await,
                                Err(ServiceError::Timeout { .. })
                            ),
                            "SDK deadline did not cancel request"
                        );
                        timeout(Duration::from_secs(2), &mut server)
                            .await
                            .context("SDK timeout kept HTTP wait alive")???;
                        client.cancel().await?;
                    }
                    _ => {
                        client.cancel().await?;
                        drop(request);
                        timeout(Duration::from_secs(2), &mut server)
                            .await
                            .context("stdin EOF kept HTTP wait alive")???;
                    }
                }
                exited_cleanly(fixture.children.last_mut().context("adapter")?).await?;
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if !server.is_finished() {
                server.abort();
                let _ = server.await;
            }
            scenario?;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("SDK cancellation scenarios deadline")
    .and_then(|result| result);
    let cleanup = fixture.cleanup().await;
    result?;
    cleanup
}

#[tokio::test]
async fn actual_stdio_limits_oversized_input_and_a_client_that_never_reads() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let result = timeout(Duration::from_secs(45), async {
        for mode in ["oversized-input", "unread-output"] {
            let absent = fixture.root.join(mode);
            let mut command = fixture.command(&absent);
            command.arg("--mcp-stdio").stdin(Stdio::piped()).stdout(Stdio::piped());
            fixture.children.push(command.spawn()?);
            let child = fixture.children.last_mut().context("raw stdio adapter")?;
            let mut input = child.stdin.take().context("stdin")?;
            let mut output = BufReader::new(child.stdout.take().context("stdout")?);
            input.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"bounded-io-check\",\"version\":\"1\"}}}\n").await?;
            let mut line = String::new();
            timeout(Duration::from_secs(5), output.read_line(&mut line)).await??;
            ensure!(serde_json::from_str::<Value>(&line)?["result"]["protocolVersion"] == "2025-11-25", "raw client initialize");
            input.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n").await?;
            if mode == "oversized-input" {
                // No delimiter or stdin EOF: reject as the bound is crossed.
                let sent = timeout(Duration::from_secs(5), input.write_all(&vec![b'x'; 300 * 1024])).await?;
                if let Err(error) = sent {
                    ensure!(matches!(error.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset), "unexpected input write error");
                }
            } else {
                // Unknown names produce large protocol error frames without an
                // owner or HTTP fixture. Keep stdout open but stop consuming it.
                // Stay inside the eight-request admission budget so this
                // scenario proves slow-output exit, not overload shutdown.
                for id in 2..10 {
                    let frame = json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
                        "params": {"name": "x".repeat(32 * 1024), "arguments": {}}}).to_string() + "\n";
                    timeout(Duration::from_secs(5), input.write_all(frame.as_bytes())).await??;
                }
            }
            // Hold both pipes open: closure must come from the adapter's limits.
            let status = timeout(Duration::from_secs(16), child.wait()).await.context("bounded adapter did not exit")??;
            ensure!(status.success(), "bounded adapter exited with {status}");
            ensure!(!absent.exists(), "IO failure bootstrapped the player");
            drop(input);
            drop(output);
        }
        Ok::<_, anyhow::Error>(())
    }).await.context("raw stdio bounds deadline").and_then(|result| result);
    let cleanup = fixture.cleanup().await;
    result?;
    cleanup
}

async fn reply_context(listener: &tokio::net::TcpListener) -> Result<()> {
    let (socket, _) = listener.accept().await?;
    let (mut socket, headers) = fixture_request(socket).await?;
    ensure!(
        headers.starts_with("GET /v1/ai/capabilities/context "),
        "context route"
    );
    let body = json!({"protocolVersion":"1","principal":{"kind":"grant","grantId":"fixture"},
        "scopes":["playback:pause"],"policyRevision":1,"stageIntentToolsEnabled":false,
        "instance":{"ownerInstanceId":"fixture-owner","serverInstanceId":"fixture-server",
            "edition":"standard","transport":"http"},
        "capabilities":[{"operation":"playback.pause","mcpName":"playback_pause","capabilityVersion":"1"}]})
    .to_string();
    socket
        .get_mut()
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        )
        .await?;
    socket.get_mut().shutdown().await?;
    Ok(())
}

fn publish_slow_facade(dir: &Path, port: u16) -> Result<()> {
    use hertz_studio::ai::mcp::discovery::{publish, DiscoveryDoc, DISCOVERY_VERSION};
    std::fs::create_dir_all(dir.join("ai/grants"))?;
    std::fs::write(
        dir.join("ai/grants/fixture.key"),
        "isolated-fixture-credential",
    )?;
    publish(
        dir,
        &DiscoveryDoc {
            version: DISCOVERY_VERSION,
            pid: std::process::id(),
            port,
            protocol_version: "1".into(),
            owner_instance_id: "fixture-owner".into(),
            server_instance_id: "fixture-server".into(),
            edition: "standard".into(),
        },
    )
    .map_err(anyhow::Error::msg)
}

#[tokio::test]
async fn actual_stdio_overload_and_duplicate_ids_close_without_forwarding_the_extra_call(
) -> Result<()> {
    let mut fixture = Fixture::new()?;
    let result = timeout(Duration::from_secs(35), async {
        for (mode, capacity) in [("overload",8), ("duplicate",1)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
            let dir = fixture.root.join(mode);
            publish_slow_facade(&dir, listener.local_addr()?.port())?;
            let (arrived_tx, arrived) = tokio::sync::oneshot::channel();
            let mut server = tokio::spawn(async move {
                reply_context(&listener).await?;
                let mut sockets = Vec::new();
                for _ in 0..capacity {
                    let (socket, _) = listener.accept().await?;
                    let (socket, headers) = fixture_request(socket).await?;
                    ensure!(headers.starts_with("POST /v1/ai/capabilities/call "), "tool route");
                    sockets.push(socket);
                }
                let _ = arrived_tx.send(());
                for mut socket in sockets {
                    let mut byte = [0];
                    ensure!(socket.read(&mut byte).await? == 0, "overload kept the HTTP wait alive");
                }
                ensure!(timeout(Duration::from_millis(200), listener.accept()).await.is_err(), "extra call was forwarded");
                Ok::<_,anyhow::Error>(())
            });
            let scenario = async {
                let mut command = fixture.command(&dir);
                command.args(["--mcp-stdio","--grant","fixture"]).stdin(Stdio::piped()).stdout(Stdio::piped());
                fixture.children.push(command.spawn()?);
                let child = fixture.children.last_mut().context("bounded adapter")?;
                let mut input = child.stdin.take().context("stdin")?;
                let mut output = BufReader::new(child.stdout.take().context("stdout")?);
                input.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"overload-check\",\"version\":\"1\"}}}\n").await?;
                let mut line = String::new();
                timeout(Duration::from_secs(5),output.read_line(&mut line)).await??;
                ensure!(serde_json::from_str::<Value>(&line)?["id"]==1,"initialize reply");
                input.write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n").await?;
                for id in 2..(capacity+2) {
                    input.write_all((json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"playback_pause","arguments":{}}}).to_string()+"\n").as_bytes()).await?;
                }
                timeout(Duration::from_secs(3),arrived).await.context("admitted HTTP calls missing")??;
                let id = if mode == "duplicate" { 2 } else { capacity + 2 };
                input.write_all((json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"playback_pause","arguments":{}}}).to_string()+"\n").as_bytes()).await?;
                timeout(Duration::from_secs(2),&mut server).await.context("overload did not drop local HTTP waits")???;
                let status=timeout(Duration::from_secs(8),child.wait()).await.context("overloaded adapter did not exit")??;
                ensure!(status.success(),"adapter status: {status}");
                ensure!(!dir.join("vmusic.db").exists(),"adapter bootstrapped a database");
                Ok::<_,anyhow::Error>(())
            }.await;
            if !server.is_finished() {server.abort();let _=server.await;}
            scenario?;
        }
        Ok::<_,anyhow::Error>(())
    }).await.context("overload scenarios deadline").and_then(|result|result);
    let cleanup = fixture.cleanup().await;
    result?;
    cleanup
}

#[tokio::test]
async fn official_sdk_repeated_cancellation_reuses_capacity_and_keeps_the_session_usable(
) -> Result<()> {
    let mut fixture = Fixture::new()?;
    let result = timeout(Duration::from_secs(40), async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let dir = fixture.root.join("repeated-cancel");
        publish_slow_facade(&dir, listener.local_addr()?.port())?;
        let (arrived_tx, mut arrived) = tokio::sync::mpsc::channel(1);
        let (ended_tx, mut ended) = tokio::sync::mpsc::channel(1);
        let mut server = tokio::spawn(async move {
            reply_context(&listener).await?;
            for _ in 0..24 {
                let (socket, _) = listener.accept().await?;
                let (mut socket, _) = fixture_request(socket).await?;
                arrived_tx.send(()).await?;
                let mut byte = [0];
                ensure!(
                    socket.read(&mut byte).await? == 0,
                    "cancel did not close local wait"
                );
                ended_tx.send(()).await?;
            }
            Ok::<_, anyhow::Error>(())
        });
        let scenario = async {
            let client = fixture
                .connect(&dir, Some("fixture"), ClientConfig::default())
                .await?;
            for _ in 0..24 {
                let request = client
                    .send_cancellable_request(
                        CallToolRequest::new(CallToolRequestParams::new("playback_pause")).into(),
                        PeerRequestOptions::no_options(),
                    )
                    .await?;
                timeout(Duration::from_secs(2), arrived.recv())
                    .await?
                    .context("request not forwarded")?;
                request.cancel(Some("fixture cancel".into())).await?;
                timeout(Duration::from_secs(2), ended.recv())
                    .await?
                    .context("HTTP wait did not stop")?;
                ensure!(
                    client.list_all_tools().await?.len() == 1,
                    "cancel leaked capacity or broke session"
                );
            }
            timeout(Duration::from_secs(2), &mut server).await???;
            // Keep the same SDK/process session alive across 1024 completed
            // requests at the exact admission width. No reconnect resets a leak.
            for _ in 0..128 {
                let replies =
                    futures::future::try_join_all((0..8).map(|_| client.list_all_tools())).await?;
                ensure!(
                    replies.iter().all(|tools| tools.len() == 1),
                    "sustained directory replies"
                );
            }
            client.cancel().await?;
            exited_cleanly(fixture.children.last_mut().context("adapter")?).await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if !server.is_finished() {
            server.abort();
            let _ = server.await;
        }
        scenario
    })
    .await
    .context("repeated cancellation deadline")
    .and_then(|result| result);
    let cleanup = fixture.cleanup().await;
    result?;
    cleanup
}

#[tokio::test]
async fn official_sdk_gets_a_bounded_error_for_oversized_success_and_failure_replies() -> Result<()>
{
    let mut fixture = Fixture::new()?;
    let result = timeout(Duration::from_secs(25), async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let dir = fixture.root.join("large-output");
        publish_slow_facade(&dir, listener.local_addr()?.port())?;
        let mut server = tokio::spawn(async move {
            reply_context(&listener).await?;
            for status in ["200 OK", "400 Bad Request"] {
                let (socket, _) = listener.accept().await?;
                let (mut socket, _) = fixture_request(socket).await?;
                let payload = "x".repeat(150 * 1024);
                let body = if status.starts_with("200") { json!({ "fixture": payload }) }
                    else { json!({ "error": { "code": "fixture", "message": payload } }) }.to_string();
                // HTTP fits; the MCP SDK's text + structured representation
                // exceeds 256 KiB. Neither form may be partially written.
                ensure!(body.len() < 256 * 1024, "HTTP fixture should fit");
                socket.get_mut().write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await?;
                socket.get_mut().shutdown().await?;
            }
            Ok::<_, anyhow::Error>(())
        });
        let scenario = async {
            let client = fixture.connect(&dir, Some("fixture"), ClientConfig::default()).await?;
            for _ in 0..2 {
                let result = client.call_tool(CallToolRequestParams::new("playback_pause")).await;
                let Err(ServiceError::McpError(error)) = result else { anyhow::bail!("oversized reply was not a protocol error"); };
                ensure!(error.data.as_ref().context("error data")?["code"] == "mcp_response_too_large", "oversized error code");
                ensure!(error.message.len() < 256, "error leaked oversized body");
                ensure!(client.list_all_tools().await?.len() == 1, "bounded replacement broke the session");
            }
            timeout(Duration::from_secs(2), &mut server).await???;
            client.cancel().await?;
            exited_cleanly(fixture.children.last_mut().context("adapter")?).await?;
            Ok::<_, anyhow::Error>(())
        }.await;
        if !server.is_finished() { server.abort(); let _ = server.await; }
        scenario
    }).await.context("oversized output deadline").and_then(|result| result);
    let cleanup = fixture.cleanup().await;
    result?;
    cleanup
}

struct Fixture {
    root: PathBuf,
    children: Vec<Child>,
}

impl Fixture {
    fn new() -> Result<Self> {
        let root = std::env::temp_dir().join(format!("hertz-mcp-sdk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        Ok(Self {
            root,
            children: Vec::new(),
        })
    }

    fn command(&self, data_dir: &Path) -> Command {
        let mut command = Command::new(BINARY);
        command
            .arg("--data-dir")
            .arg(data_dir)
            .env("VMUSIC_BACKEND", "null")
            .env("VMUSIC_SECRETS", "memory")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
    }

    async fn start_owner(&mut self) -> Result<Owner> {
        let dir = self.root.join("player");
        self.children.push(
            self.command(&dir)
                .args(["--bind", "127.0.0.1", "--port", "0"])
                .spawn()?,
        );
        let child = self.children.last_mut().context("owner child")?;
        let discovery: Value = timeout(Duration::from_secs(20), async {
            loop {
                ensure!(
                    child.try_wait()?.is_none(),
                    "standalone exited during startup"
                );
                if let Ok(bytes) = std::fs::read(dir.join("ai/ai-discovery.json")) {
                    return Ok::<_, anyhow::Error>(serde_json::from_slice(&bytes)?);
                }
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .context("standalone discovery timeout")??;
        let port = discovery["port"].as_u64().context("discovery port")?;
        ensure!((1..=65_535).contains(&port), "invalid discovery port");
        Ok(Owner {
            base: format!("http://127.0.0.1:{port}"),
            token: std::fs::read_to_string(dir.join("token"))?
                .trim()
                .to_owned(),
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()?,
        })
    }

    async fn connect(
        &mut self,
        data_dir: &Path,
        grant: Option<&str>,
        config: ClientConfig,
    ) -> Result<Client> {
        let mut command = self.command(data_dir);
        command
            .arg("--mcp-stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if let Some(grant) = grant {
            command.args(["--grant", grant]);
        }
        self.children.push(command.spawn()?);
        let child = self.children.last_mut().context("adapter child")?;
        let stdout = child.stdout.take().context("adapter stdout")?;
        let stdin = child.stdin.take().context("adapter stdin")?;
        let client = timeout(Duration::from_secs(12), config.serve((stdout, stdin)))
            .await
            .context("SDK initialize timeout")??;
        let peer = client.peer_info().context("SDK peer information")?;
        ensure!(
            peer.protocol_version == ProtocolVersion::V_2025_11_25,
            "adapter negotiated beyond its declared baseline"
        );
        ensure!(
            peer.server_info.as_ref().map(|info| info.name.as_str()) == Some("hertz-studio-ai"),
            "unexpected server identity"
        );
        ensure!(
            serde_json::to_value(&peer.capabilities)? == json!({"tools": {}}),
            "adapter advertises unimplemented capabilities"
        );
        Ok(client)
    }

    async fn cleanup(mut self) -> Result<()> {
        // Reap adapters first, then the player, before deleting Windows DB handles.
        let mut error = None;
        for child in self.children.iter_mut().rev() {
            let result: Result<()> = async {
                if child.try_wait()?.is_none() {
                    child.start_kill()?;
                }
                timeout(Duration::from_secs(5), child.wait())
                    .await
                    .context("child cleanup timeout")??;
                Ok(())
            }
            .await;
            if let Err(failure) = result {
                error = Some(failure);
            }
        }
        if let Some(error) = error {
            return Err(error);
        }
        std::fs::remove_dir_all(&self.root).context("fixture cleanup")
    }
}

struct Owner {
    base: String,
    token: String,
    http: reqwest::Client,
}

impl Owner {
    async fn request(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await?;
        ensure!(
            response.status().is_success(),
            "management {path}: {}",
            response.status()
        );
        Ok(response.json().await?)
    }

    async fn grant(&self, scopes: &[&str]) -> Result<String> {
        let created = self
            .request(
                Method::POST,
                "/v1/ai/grants",
                Some(json!({"label": "official-sdk-check", "scopes": scopes})),
            )
            .await?;
        Ok(created["grant_id"].as_str().context("grant ID")?.to_owned())
    }

    async fn stage_tools(&self, enabled: bool) -> Result<()> {
        self.request(
            Method::PUT,
            "/v1/settings",
            Some(json!({"ai_stage_intent_tools": enabled})),
        )
        .await?;
        Ok(())
    }
}

async fn call(client: &Client, name: &str, arguments: Value) -> Result<CallToolResult> {
    let arguments = arguments
        .as_object()
        .context("tool arguments must be an object")?
        .clone();
    Ok(client
        .call_tool(CallToolRequestParams::new(name.to_owned()).with_arguments(arguments))
        .await?)
}

async fn exited_cleanly(child: &mut Child) -> Result<()> {
    let status = timeout(Duration::from_secs(5), child.wait())
        .await
        .context("adapter did not exit after SDK transport closed")??;
    ensure!(status.success(), "adapter exited with {status}");
    Ok(())
}

fn success(result: &CallToolResult) -> Result<&Value> {
    ensure!(
        result.is_error != Some(true),
        "unexpected tool error: {:?}",
        result.structured_content
    );
    let structured = result
        .structured_content
        .as_ref()
        .context("missing structuredContent")?;
    // Structured results must also be usable by text-only clients.
    let wire = serde_json::to_value(result)?;
    let text: Value = serde_json::from_str(
        wire["content"][0]["text"]
            .as_str()
            .context("text content")?,
    )?;
    ensure!(
        &text == structured,
        "text and structured tool results differ"
    );
    Ok(structured)
}

fn tool_error(result: &CallToolResult, code: &str) -> Result<()> {
    ensure!(
        result.is_error == Some(true),
        "failure must be a tool-level error"
    );
    let actual = &result
        .structured_content
        .as_ref()
        .context("missing structured error")?["code"];
    ensure!(
        actual == code,
        "unexpected tool error code: expected {code}, got {actual}"
    );
    Ok(())
}

async fn seed_tracks(dir: &Path) -> Result<()> {
    let db = vmusic_store::open(dir).await?;
    let result: Result<()> = async {
        // Real local files and persisted metadata make projection checks meaningful.
        let data = vec![0u8; 8_000 * 2 * 30];
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
        wav.extend_from_slice(&8_000u32.to_le_bytes());
        wav.extend_from_slice(&16_000u32.to_le_bytes());
        wav.extend_from_slice(b"\x02\0\x10\0data");
        wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&data);
        for i in 0..3 {
            let path = dir.join(format!("private-track-{i}.wav"));
            std::fs::write(&path, &wav)?;
            vmusic_store::upsert_track(
                &db,
                &Track {
                    id: format!("sdk-track-{i}"),
                    path: path.to_string_lossy().into_owned(),
                    source: TrackSource::Local,
                    title: format!("Private SDK Song {i}"),
                    artist: Some("Private SDK Artist".into()),
                    album: Some("Private SDK Album".into()),
                    duration_ms: Some(30_000),
                    bitrate: Some(128_000),
                    sample_rate: Some(8_000),
                    channels: Some(1),
                    has_cover: false,
                    file_mtime: None,
                    file_size: Some(wav.len() as i64),
                    added_at: i,
                },
            )
            .await?;
        }
        Ok(())
    }
    .await;
    db.close().await;
    result
}

#[tokio::test]
async fn official_sdk_disconnected_handshake_has_no_bootstrap_side_effects() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let result = timeout(Duration::from_secs(40), async {
        let absent = fixture.root.join("never-started");
        let client = fixture
            .connect(&absent, None, ClientConfig::default())
            .await?;
        ensure!(
            client.list_all_tools().await?.is_empty(),
            "disconnected tool directory"
        );
        tool_error(
            &call(&client, "playback_pause", json!({})).await?,
            "not_connected",
        )?;
        client.cancel().await?;
        exited_cleanly(&mut fixture.children[0]).await?;
        ensure!(
            !absent.exists(),
            "adapter created a DataDir, DB or runner before connection"
        );
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("disconnected scenario deadline")
    .and_then(|result| result);
    let cleanup = fixture.cleanup().await;
    result?;
    cleanup
}

#[tokio::test]
async fn official_sdk_authorization_idempotency_and_stage_contract() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let result = timeout(Duration::from_secs(60), async {
        let data_dir = fixture.root.join("player");
        seed_tracks(&data_dir).await?;
        let owner = fixture.start_owner().await?;
        owner
            .request(Method::POST, "/v1/player/load", Some(json!({
                "track_id": "sdk-track-0", "queue": ["sdk-track-0", "sdk-track-1", "sdk-track-2"]
            })))
            .await?;
        let grant = owner.grant(&[
            "playback:control", "playback:read", "library:read",
            "stage:capabilities_read", "stage:intent_validate",
        ]).await?;
        let config = ClientConfig::default().with_protocol_version(ProtocolVersion::V_2025_11_25);
        let client = fixture.connect(&data_dir, Some(&grant), config).await?;
        ensure!(client.list_all_tools().await?.len() == 8, "stage tools must default off");
        // 关闭时远端不会公布舞台能力，适配器在本地就拦下；只有会话曾拿到、
        // 之后被 owner 关掉的情况才会转发并得到 stage_tools_disabled。
        tool_error(
            &call(&client, "stage_capabilities_get", json!({})).await?,
            "capability_unsupported",
        )?;
        owner.stage_tools(true).await?;
        ensure!(client.list_all_tools().await?.len() == 8, "directory expanded mid-session");
        client.cancel().await?;
        let client = fixture.connect(&data_dir, Some(&grant), ClientConfig::default()).await?;
        let tools = client.list_all_tools().await?;
        ensure!(tools.len() == 10, "full scoped tool directory");
        for tool in &tools {
            let mutating = tool.name.starts_with("playback_") && tool.name != "playback_snapshot_get";
            ensure!(tool.input_schema["type"] == "object", "tool schema must be an object");
            ensure!(tool.input_schema["additionalProperties"] == false, "unknown tool arguments allowed");
            ensure!(
                tool.annotations.as_ref().and_then(|a| a.read_only_hint) == Some(!mutating),
                "incorrect readOnlyHint"
            );
            let identity = &tool.input_schema["properties"]["clientOperationId"];
            ensure!(identity.is_object() == mutating, "idempotency argument missing from schema");
            if mutating {
                ensure!(identity["type"] == "string" && identity["minLength"] == 1, "identity schema");
            }
        }

        let args = json!({"clientOperationId": "sdk-next"});
        let first = call(&client, "playback_next", args.clone()).await?;
        ensure!(success(&first)?["outcome"] == "applied", "next did not execute");
        let second = call(&client, "playback_next", args.clone()).await?;
        ensure!(success(&first)? == success(&second)?, "idempotency did not replay the same result");
        let queue = owner.request(Method::GET, "/v1/player/queue", None).await?;
        ensure!(queue["index"] == 1, "duplicate next advanced the queue twice");

        // A malformed identity must fail rather than become an unprotected new action.
        for invalid in [json!(42), Value::Null, json!(" "), json!("x".repeat(129)), json!("界".repeat(43))] {
            tool_error(
                &call(&client, "playback_next", json!({"clientOperationId": invalid})).await?,
                "bad_request",
            )?;
        }
        ensure!(owner.request(Method::GET, "/v1/player/queue", None).await?["index"] == 1,
            "invalid identity caused a playback side effect");

        let snapshot = call(&client, "playback_snapshot_get", json!({})).await?;
        let snapshot = success(&snapshot)?;
        ensure!(snapshot["data"]["trackId"] == "sdk-track-1", "snapshot lacks loaded track");
        let snapshot_text = snapshot.to_string();
        ensure!(!snapshot_text.contains("Private SDK") && !snapshot_text.contains("private-track"),
            "snapshot leaked track metadata or path");
        tool_error(&call(&client, "playback_snapshot_get", json!({"clientOperationId": "unexpected"})).await?, "bad_request")?;
        let library = call(&client, "library_search", json!({"q": "Private SDK", "limit": 2})).await?;
        let library = success(&library)?;
        let tracks = library["data"]["tracks"].as_array().context("library tracks")?;
        ensure!(tracks.len() == 2 && tracks[0]["title"].as_str().is_some(), "library projection fixture");
        ensure!(tracks.iter().all(|t| t.get("path").is_none()), "library leaked file path");
        ensure!(!library.to_string().contains("private-track"), "library leaked private filename");

        let page = call(&client, "stage_capabilities_get", json!({"limit": 2})).await?;
        let page = success(&page)?;
        ensure!(page["scenes"].as_array().context("scene list")?.len() == 2 && page["nextOffset"] == 2,
            "stage pagination");
        let scene = page["scenes"][0]["id"].as_str().context("scene ID")?;
        let artifact = json!({"artifactVersion": 1, "mode": "create",
            "intent": {"version": 1, "scene": scene, "patch": {}},
            "schemaVersion": page["schemaVersion"], "schemaHash": page["schemaHash"],
            "basePresetHash": page["basePresetHashes"][scene]});
        let valid = call(&client, "stage_intent_validate", artifact.clone()).await?;
        let valid = success(&valid)?;
        ensure!(valid["validationStage"] == "intent" && valid["persisted"] == false && valid["applied"] == false,
            "stage validation claimed a side effect");
        let mut stale = artifact;
        stale["basePresetHash"] = json!("stale");
        tool_error(&call(&client, "stage_intent_validate", stale).await?, "stage_artifact_invalid")?;
        owner.stage_tools(false).await?;
        tool_error(&call(&client, "stage_capabilities_get", json!({})).await?, "stage_tools_disabled")?;

        let unknown = client.call_tool(CallToolRequestParams::new("no_such_tool")).await;
        ensure!(matches!(unknown, Err(ServiceError::McpError(ref error)) if error.code == ErrorCode::INVALID_PARAMS),
            "unknown tool must be a protocol-level invalid-params error");

        let pause_grant = owner.grant(&["playback:pause"]).await?;
        let pause = fixture.connect(&data_dir, Some(&pause_grant), ClientConfig::default()).await?;
        let pause_tools = pause.list_all_tools().await?;
        ensure!(pause_tools.len() == 1 && pause_tools[0].name == "playback_pause", "pause-only scope directory");
        success(&call(&pause, "playback_pause", json!({})).await?)?;
        tool_error(&call(&pause, "playback_next", json!({})).await?, "scope_required")?;
        pause.cancel().await?;
        ensure!(owner.request(Method::GET, "/v1/player/queue", None).await?["index"] == 1,
            "scope denial changed the queue");

        owner.request(Method::DELETE, &format!("/v1/ai/grants/{grant}"), None).await?;
        // Authorization must be checked before replaying an otherwise valid cached action.
        tool_error(&call(&client, "playback_next", args).await?, "grant_revoked")?;
        tool_error(&call(&client, "playback_snapshot_get", json!({})).await?, "grant_revoked")?;
        client.cancel().await?;
        for child in fixture.children.iter_mut().skip(1) {
            exited_cleanly(child).await?;
        }
        ensure!(fixture.children[0].try_wait()?.is_none(), "adapter exit stopped the standalone");
        owner.request(Method::GET, "/v1/health", None).await?;
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("connected SDK scenario deadline")
    .and_then(|result| result);
    let cleanup = fixture.cleanup().await;
    result?;
    cleanup
}
