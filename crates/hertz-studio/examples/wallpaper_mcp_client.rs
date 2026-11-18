// SPDX-License-Identifier: MIT
//! Test driver: official SDK over the actual adapter process, controlled by NDJSON.
use anyhow::{ensure, Context, Result};
use rmcp::{
    model::{CallToolRequestParams, ClientConfig},
    ServiceExt,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::timeout,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Call {
    name: String,
    arguments: serde_json::Map<String, Value>,
}

async fn emit(value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value)?;
    bytes.push(b'\n');
    let mut output = tokio::io::stdout();
    output.write_all(&bytes).await?;
    output.flush().await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    ensure!(
        args.len() == 3,
        "usage: wallpaper_mcp_client <service exe> <data dir> <grant id>"
    );
    let mut command = Command::new(&args[0]);
    command
        .arg("--mcp-stdio")
        .arg("--data-dir")
        .arg(&args[1])
        .arg("--grant")
        .arg(&args[2])
        .env("VMUSIC_BACKEND", "null")
        .env("VMUSIC_SECRETS", "memory")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().context("actual stdio adapter")?;
    let client = timeout(
        Duration::from_secs(12),
        ClientConfig::default().serve((
            child.stdout.take().context("adapter stdout")?,
            child.stdin.take().context("adapter stdin")?,
        )),
    )
    .await
    .context("SDK handshake timeout")??;
    let result = async {
        let tools = client.list_tools(Default::default()).await?;
        emit(json!({"ready":true,"tools":tools,"peer":client.peer_info()})).await?;
        let mut input = BufReader::new(tokio::io::stdin());
        loop {
            let mut bytes = Vec::new();
            loop {
                let available = input.fill_buf().await?;
                if available.is_empty() {
                    break;
                }
                let count = available
                    .iter()
                    .position(|byte| *byte == b'\n')
                    .map_or(available.len(), |index| index + 1);
                ensure!(
                    bytes.len() + count <= 16 * 1024,
                    "test command exceeds bound"
                );
                bytes.extend_from_slice(&available[..count]);
                let complete = available[count - 1] == b'\n';
                input.consume(count);
                if complete {
                    break;
                }
            }
            if bytes.is_empty() {
                break;
            }
            let call: Call = serde_json::from_slice(&bytes)?;
            let response = timeout(
                Duration::from_secs(12),
                client.call_tool(
                    CallToolRequestParams::new(call.name).with_arguments(call.arguments),
                ),
            )
            .await
            .context("SDK call timeout")??;
            emit(serde_json::to_value(response)?).await?;
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    let closed = client.cancel().await;
    let status = timeout(Duration::from_secs(5), child.wait()).await;
    if status.is_err() {
        child.start_kill()?;
        child.wait().await?;
    }
    result?;
    closed?;
    ensure!(
        status.context("adapter exit timeout")??.success(),
        "adapter did not exit cleanly"
    );
    Ok(())
}
