// SPDX-License-Identifier: MIT
//! Exercises the external real PluginRegistry + PluginHost, rather than an SDK-only stdio stub.
use dbx_plugin_runtime::plugins::{PluginHost, PluginRegistry};
use hertz_desktop_ipc::windows::{read_private_bounded, write_private_atomic, Identity};
use serde_json::{json, Value};
use std::{
    io,
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_TERMINATE,
    },
};

const ID: &str = "io.github.hertz.desktop-probe";
fn error(message: impl ToString) -> io::Error {
    io::Error::other(message.to_string())
}
struct ObservedProcess(OwnedHandle);
impl ObservedProcess {
    fn open(pid: u32) -> io::Result<Self> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | 0x00100000,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle) }))
    }
    fn alive(&self) -> bool {
        // Treat a failed wait conservatively as still alive, never as successful cleanup.
        unsafe { WaitForSingleObject(self.0.as_raw_handle(), 0) != WAIT_OBJECT_0 }
    }
    fn stop(&self) -> io::Result<()> {
        if self.alive() && unsafe { TerminateProcess(self.0.as_raw_handle(), 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        match unsafe { WaitForSingleObject(self.0.as_raw_handle(), 2000) } {
            WAIT_OBJECT_0 => (),
            WAIT_TIMEOUT => return Err(error("probe process cleanup deadline")),
            _ => return Err(io::Error::last_os_error()),
        }
        Ok(())
    }
}
impl Drop for ObservedProcess {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
struct IndependentChild(Child);
impl Drop for IndependentChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        // std::process::Child::wait has no deadline. Wait on its retained Windows handle.
        unsafe {
            WaitForSingleObject(self.0.as_raw_handle(), 2000);
        }
    }
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let root = PathBuf::from(
        args.get(1)
            .ok_or_else(|| error("missing output directory"))?,
    )
    .canonicalize()?;
    let version = args
        .get(2)
        .ok_or_else(|| error("missing runtime app version"))?;
    let commit = args
        .get(3)
        .ok_or_else(|| error("missing runtime revision"))?;
    let mut evidence = json!({"schemaVersion":1,"dbxCommit":commit,"dbxVersion":version,"platform":"windows-x64","identity":Identity::current()?,"realRuntime":"dbx_plugin_runtime::plugins::PluginHost","checks":{},"unavailable":[{"check":"different-user-negative-test","status":"skipped","reason":"no disposable second-user credentials/session provided"},{"check":"different-session-negative-test","status":"skipped","reason":"no disposable second interactive session provided"},{"check":"DBX-WebView-workbench-close","status":"skipped","reason":"headless real runtime harness; desktop DBX UI native acceptance remains required"}]});
    let result = run(&root, version, &mut evidence).await;
    evidence["passed"] = json!(result.is_ok());
    if let Err(error) = &result {
        evidence["error"] = json!(error.to_string());
    }
    std::fs::write(
        root.join("evidence.json"),
        serde_json::to_vec_pretty(&evidence)?,
    )?;
    println!("{}", serde_json::to_string(&evidence)?);
    result
}

async fn run(root: &Path, version: &str, evidence: &mut Value) -> io::Result<()> {
    let plugin_dir = root.join("plugins").join(ID);
    std::fs::create_dir_all(&plugin_dir)?;
    let binary_dir = std::env::current_exe()?.parent().unwrap().to_path_buf();
    std::fs::copy(
        binary_dir.join("probe-sidecar.exe"),
        plugin_dir.join("probe-sidecar.exe"),
    )?;
    std::fs::copy(
        binary_dir.join("probe-component.exe"),
        plugin_dir.join("probe-component.exe"),
    )?;
    let manifest = json!({"manifest_version":1,"id":ID,"name":"Hertz disposable desktop feasibility probe","version":"0.1.0","publisher":"Hertz local probe","engines":{"dbx":">=0.6.35","host_api":"^1.0"},"entrypoints":{"backend":{"executable":"probe-sidecar.exe","transport":"stdio-jsonl","protocol_versions":[1]}}});
    std::fs::write(
        plugin_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    let host = PluginHost::new(PluginRegistry::new_with_app_version(
        root.join("plugins"),
        version,
    ));
    let result = async {
        let info: Value = tokio::time::timeout(Duration::from_secs(10), host.invoke(ID, "probe/info", json!({}), None, Some(Duration::from_secs(5)))).await.map_err(error)?.map_err(error)?;
        let sidecar_pid = info["pid"].as_u64().ok_or_else(|| error("sidecar did not report PID"))? as u32;
        let descendant_pid = info["descendantPid"].as_u64().ok_or_else(|| error("sidecar did not report descendant PID"))? as u32;
        let sidecar = ObservedProcess::open(sidecar_pid)?;
        let descendant = ObservedProcess::open(descendant_pid)?;
        evidence["checks"]["activation"] = json!({"pass":true,"sidecarPid":sidecar_pid,"descendantPid":descendant_pid,"runtimeDataDir":info["dataDir"]});
        let source_path = root.join("probe-source.json");
        write_private_atomic(&source_path, &serde_json::to_vec(&info)?,65_536)?;
        let component_result = root.join("component-result.json");
        let independent = IndependentChild(Command::new(binary_dir.join("probe-component.exe")).arg(&source_path).arg(&component_result).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(0x08000000).spawn()?);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !component_result.exists() {
            if tokio::time::Instant::now() >= deadline { return Err(error("independent component IPC deadline")); }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let ipc: Value = serde_json::from_slice(&read_private_bounded(&component_result,65_536)?)?;
        evidence["checks"]["privateAtomicFiles"] = json!({"pass":true});
        let external_pid = independent.0.id();
        let observed_pid = ipc["response"]["body"]["observedClient"]["pid"].as_u64().unwrap_or_default() as u32;
        if ipc["ok"] != true || observed_pid != external_pid || ipc["response"]["body"]["serverPid"] != sidecar_pid { return Err(error(format!("real-runtime external IPC/peer identity failed: {ipc}"))); }
        evidence["checks"]["externalProcessPipe"] = json!({"pass":true,"independentPid":external_pid,"result":ipc});
        let independent_process = ObservedProcess::open(external_pid)?;
        // Cancel an actual overlapped client read while a real-host sidecar projection waits.
        let mut slow_request: hertz_desktop_ipc::Request = serde_json::from_value(info["request"].clone())?;
        slow_request.op = "document".into();
        slow_request.params = json!({"key":"hold"});
        let cancel = hertz_desktop_ipc::windows::Cancellation::new();
        let signal = cancel.clone();
        let pipe_name = info["pipe"].as_str().ok_or_else(|| error("missing pipe"))?.to_owned();
        let started = std::time::Instant::now();
        let cancel_task = tokio::spawn(async move {
            hertz_desktop_ipc::windows::request(&pipe_name, sidecar_pid, &slow_request, &signal).await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.cancel();
        let cancellation_result = tokio::time::timeout(Duration::from_millis(500), cancel_task).await.map_err(error)?.map_err(error)?;
        let cancelled = cancellation_result.as_ref().is_err_and(|error| error.kind() == io::ErrorKind::Interrupted);
        evidence["checks"]["actualClientCancellation"] = json!({"pass":cancelled,"elapsedMs":started.elapsed().as_millis()});
        if !cancelled { return Err(error("actual client read did not cancel")); }
        // A five-second handler must be dropped by the single two-second server deadline.
        let deadline = tokio::time::Instant::now() + Duration::from_millis(2500);
        let stats = loop {
            let stats: Value = host.invoke(ID,"probe/stats",json!({}),None,Some(Duration::from_secs(1))).await.map_err(error)?;
            if stats["activeConnections"] == 0 && stats["timedOutConnections"].as_u64().unwrap_or_default() >= 1 { break stats; }
            if tokio::time::Instant::now() >= deadline { return Err(error(format!("real server deadline did not reclaim work: {stats}"))); }
            tokio::time::sleep(Duration::from_millis(25)).await;
        };
        evidence["checks"]["actualServerDeadline"] = json!({"pass":true,"elapsedMs":started.elapsed().as_millis(),"stats":stats});
        let stop_started = std::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(12), host.stop(ID)).await.map_err(error)?.map_err(error)?;
        let stop_ms = stop_started.elapsed().as_millis();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while (sidecar.alive() || descendant.alive()) && tokio::time::Instant::now() < deadline { tokio::time::sleep(Duration::from_millis(10)).await; }
        let sidecar_stopped = !sidecar.alive();
        let descendant_stopped = !descendant.alive();
        let independent_survives = independent_process.alive();
        evidence["checks"]["hostStop"] = json!({"pass":sidecar_stopped && descendant_stopped && independent_survives,"elapsedMs":stop_ms,"sidecarStopped":sidecar_stopped,"descendantStopped":descendant_stopped,"independentSurvives":independent_survives});
        evidence["launchModeRecommendation"] = json!("manual");
        evidence["launchModeReason"] = json!(if descendant_stopped { "Real host stop terminates sidecar descendants through the private Windows Job; the separately launched component survives." } else { "This runtime leaves descendants alive, but current supported DBX kills the Job tree; use the common manual independent-start contract." });
        // All disposable processes have retained handles, so cleanup never races PID reuse.
        descendant.stop()?;
        independent_process.stop()?;
        sidecar.stop()?;
        let pipe_name = info["pipe"].as_str().ok_or_else(|| error("missing pipe"))?;
        let reclaimed = hertz_desktop_ipc::windows::create_server(pipe_name, true)?;
        drop(reclaimed);
        evidence["checks"]["pipeReclaimed"] = json!({"pass":true});
        evidence["checks"]["explicitCleanup"] = json!({"pass":!sidecar.alive() && !descendant.alive() && !independent_process.alive()});
        if !sidecar_stopped || !descendant_stopped || !independent_survives { return Err(error("host lifecycle mandatory proof failed")); }
        Ok(())
    }.await;
    let stop_all = tokio::time::timeout(Duration::from_secs(12), host.stop_all())
        .await
        .map_err(error)?
        .map_err(error);
    evidence["checks"]["stopAll"] = json!({"pass":stop_all.is_ok()});
    result.and(stop_all)
}
