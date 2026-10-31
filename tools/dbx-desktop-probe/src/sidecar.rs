// SPDX-License-Identifier: MIT
use hertz_desktop_ipc::{
    windows::{accept, create_server, pipe_name, Cancellation},
    Profile, Request, Response, Scope, BRIDGE_PROTOCOL,
};
use serde_json::{json, Value};
use std::{
    io::{self, Write},
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, BufReader};

const ID: &str = "io.github.hertz.desktop-probe";

#[tokio::main]
async fn main() -> io::Result<()> {
    let directory = PathBuf::from(
        std::env::var_os("DBX_PLUGIN_DATA_DIR")
            .ok_or_else(|| io::Error::other("runtime did not provide DBX_PLUGIN_DATA_DIR"))?,
    );
    std::fs::create_dir_all(&directory)?;
    let profile = Profile::Dbx {
        edition: "standard".into(),
        data_dir: directory.to_string_lossy().into_owned(),
        plugin_id: hertz_desktop_ipc::profile::STANDARD_PLUGIN_ID.into(),
    }
    .normalized()?;
    let session = uuid::Uuid::new_v4().to_string();
    let pipe = pipe_name(&profile, &session, Scope::Lyrics)?;
    let first = create_server(&pipe, true)?;
    let component = std::env::current_exe()?.with_file_name("probe-component.exe");
    let child = Command::new(component)
        .arg("--descendant")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()?;
    let child_pid = child.id();
    // Deliberately do not kill this child on a graceful stdio exit: this measures DBX ownership.
    drop(child);
    let listener_pipe = pipe.clone();
    let listener_session = session.clone();
    let active = Arc::new(AtomicUsize::new(0));
    let timed_out = Arc::new(AtomicUsize::new(0));
    let listener_active = active.clone();
    let listener_timeouts = timed_out.clone();
    tokio::spawn(async move {
        let cancel = Cancellation::new();
        let quota = Arc::new(tokio::sync::Semaphore::new(2));
        let mut pending = first;
        loop {
            let connection = match accept(pending, &cancel).await {
                Ok(connection) => connection,
                Err(_) => break,
            };
            pending = match create_server(&listener_pipe, false) {
                Ok(pipe) => pipe,
                Err(_) => break,
            };
            let Ok(permit) = quota.clone().try_acquire_owned() else {
                drop(connection);
                continue;
            };
            let session = listener_session.clone();
            let cancel = cancel.clone();
            let active = listener_active.clone();
            let timed_out = listener_timeouts.clone();
            active.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let _permit = permit;
                let result = connection.serve(&cancel, move |identity, request: Request| async move {
                    request.validate(Scope::Lyrics, &session)?;
                    if request.key != "probe-only-disposable-key" { return Err(io::Error::new(io::ErrorKind::PermissionDenied, "probe authorization")); }
                    if request.op == "document" && request.params["key"] == "hold" { tokio::time::sleep(Duration::from_secs(5)).await; }
                    Ok(Response { bridge_protocol: BRIDGE_PROTOCOL, request_id: request.request_id, server_instance_id: session, status: 200, body: json!({"observedClient":identity,"serverPid":std::process::id(),"probe":true}) })
                }).await;
                if result
                    .as_ref()
                    .is_err_and(|error| error.kind() == io::ErrorKind::TimedOut)
                {
                    timed_out.fetch_add(1, Ordering::SeqCst);
                }
                active.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let message: Value = serde_json::from_str(&line)?;
        let Some(id) = message.get("id") else {
            continue;
        };
        let result = match message["method"].as_str().unwrap_or("") {
            "plugin/initialize" => {
                json!({"protocolVersion":1,"capabilities":[],"plugin":{"id":ID,"version":"0.1.0"}})
            }
            "probe/info" => {
                json!({"pipe":pipe,"pid":std::process::id(),"descendantPid":child_pid,"dataDir":directory,"request":{"bridgeProtocol":1,"requestId":"probe-1","serverInstanceId":session,"scope":"lyrics","key":"probe-only-disposable-key","op":"snapshot","params":{}}})
            }
            "probe/stats" => {
                json!({"activeConnections":active.load(Ordering::SeqCst),"timedOutConnections":timed_out.load(Ordering::SeqCst)})
            }
            _ => json!({"unsupported":true}),
        };
        let response = json!({"jsonrpc":"2.0","id":id,"result":result});
        let mut stdout = io::stdout().lock();
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    // Stdio closure is intentionally ordinary process exit, so descendants expose host policy.
    tokio::time::sleep(Duration::from_millis(10)).await;
    Ok(())
}
