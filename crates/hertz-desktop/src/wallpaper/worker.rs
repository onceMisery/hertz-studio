// SPDX-License-Identifier: MIT
//! G3-S qualification entry. Product Web selection remains disabled until all three gates pass.
#[path = "worker_protocol.rs"]
pub(crate) mod protocol;
#[path = "worker_sandbox.rs"]
pub(crate) mod sandbox;
#[path = "worker_webview.rs"]
mod webview;

use anyhow::{bail, Context, Result};
use protocol::*;
use sandbox::{Handle, Launch, VerifiedWorker};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
static ACTIVE: Mutex<()> = Mutex::new(());
struct ControlWriter {
    sender: Option<mpsc::SyncSender<ParentControl>>,
    completed: mpsc::Receiver<Result<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
    native_thread: Handle,
}
impl ControlWriter {
    fn new(mut file: File) -> Result<Self> {
        let (sender, commands) = mpsc::sync_channel::<ParentControl>(CONTROL_QUEUE_FRAMES);
        let (done, completed) = mpsc::sync_channel(CONTROL_QUEUE_FRAMES);
        let (identity_tx, identity_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let identity = sandbox::own_thread_handle();
            let failed = identity.is_err();
            let _ = identity_tx.send(identity);
            if failed {
                return;
            }
            while let Ok(command) = commands.recv() {
                let result = write_json(&mut file, &command).map_err(anyhow::Error::from);
                let failed = result.is_err();
                if done.try_send(result).is_err() || failed {
                    break;
                }
            }
        });
        let native_thread = identity_rx.recv_timeout(Duration::from_secs(2))??;
        Ok(Self {
            sender: Some(sender),
            completed,
            thread: Some(thread),
            native_thread,
        })
    }
    fn send(&self, command: ParentControl) -> Result<()> {
        self.sender
            .as_ref()
            .context("control writer closed")?
            .try_send(command)
            .map_err(|_| anyhow::anyhow!("control writer queue unavailable"))?;
        self.completed
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| anyhow::anyhow!("private control write deadline"))??;
        Ok(())
    }
    fn close(&mut self) {
        self.sender.take();
        unsafe {
            windows_sys::Win32::System::IO::CancelSynchronousIo(self.native_thread.0);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
impl Drop for ControlWriter {
    fn drop(&mut self) {
        self.close();
    }
}

const PROBE_HTML:&str="<!doctype html><html><head><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"probe.css\"><script src=\"probe.js\" defer></script></head><body><canvas id=\"probe\"></canvas></body></html>";
const PROBE_CSS:&str="html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#173f35}canvas{display:block;width:100%;height:100%}";
const PROBE_JS:&str="'use strict';const c=document.getElementById('probe');c.width=innerWidth;c.height=innerHeight;const x=c.getContext('2d');x.fillStyle='#173f35';x.fillRect(0,0,c.width,c.height);x.fillStyle='#e5bd63';x.fillRect(c.width/4,c.height/4,c.width/2,c.height/2);requestAnimationFrame(()=>requestAnimationFrame(()=>window.chrome.webview.postMessage(JSON.stringify({type:'probeReady',width:innerWidth,height:innerHeight,marker:'hertz-g3s-fixed-probe-v1'}))));";
fn package_hash() -> String {
    let mut digest = Sha256::new();
    for (path, _, bytes) in assets() {
        digest.update(path);
        digest.update([0]);
        digest.update(bytes);
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}
fn assets() -> [(&'static str, &'static str, &'static [u8]); 3] {
    [
        (
            "index.html",
            "text/html; charset=utf-8",
            PROBE_HTML.as_bytes(),
        ),
        (
            "probe.js",
            "application/javascript; charset=utf-8",
            PROBE_JS.as_bytes(),
        ),
        ("probe.css", "text/css; charset=utf-8", PROBE_CSS.as_bytes()),
    ]
}

/// This is the first standalone dispatch, before any ordinary CLI, log, config or singleton work.
pub(crate) fn entry(args: &[String]) -> Option<Result<()>> {
    if !args.iter().any(|arg| arg == "--wallpaper-worker") {
        return None;
    }
    Some((|| {
        // Direct invocation by a normal token fails before touching any private pipe or UI.
        sandbox::inspect_token(unsafe {
            windows_sys::Win32::System::Threading::GetCurrentProcess()
        })?;
        if args.len() != 6 || args[0] != "--wallpaper-worker" {
            bail!("invalid internal worker invocation");
        }
        let values = args[1..]
            .iter()
            .map(|value| value.parse::<usize>().context("private handle number"))
            .collect::<Result<Vec<_>>>()?;
        let mut files = sandbox::validate_private_handles(&values)?;
        let parent = Handle::new(values[4] as _, "private parent handle")?;
        sandbox::win(
            unsafe {
                windows_sys::Win32::Foundation::SetHandleInformation(
                    parent.0,
                    windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT,
                    0,
                )
            },
            "clear parent handle inheritance",
        )?;
        let resource_write = files.pop().unwrap();
        let resource_read = files.pop().unwrap();
        let control_write = files.pop().unwrap();
        let control_read = files.pop().unwrap();
        webview::run(
            control_read,
            control_write,
            resource_read,
            resource_write,
            parent,
        )
    })())
}
pub(crate) fn probe_entry(args: &[String]) -> Option<Result<String>> {
    if !args.iter().any(|arg| arg == "--wallpaper-sandbox-probe") {
        return None;
    }
    Some((|| {
        if !matches!(args.len(), 7 | 9)
            || args[0] != "--wallpaper-sandbox-probe"
            || args[1] != "--worker-exe"
            || args[3] != "--worker-sha256"
            || args[5] != "--output-dir"
            || (args.len() == 9 && args[7] != "--probe-mode")
        {
            bail!("usage: --wallpaper-sandbox-probe --worker-exe PATH --worker-sha256 HASH --output-dir PATH [--probe-mode FIXED_MODE]");
        }
        let mode = if args.len() == 9 {
            ProbeMode::from_cli(&args[8])?
        } else {
            ProbeMode::Startup
        };
        let output = PathBuf::from(&args[6]);
        if !output.is_absolute() {
            bail!("probe output directory must be absolute");
        }
        std::fs::create_dir_all(&output)?;
        let report =
            WorkerManager::new(PathBuf::from(&args[2]), args[4].clone())?.probe(&output, mode);
        let report = match report {
            Ok(value) => value,
            Err(error) => {
                serde_json::json!({"schemaVersion":1,"gate":"G3-S-offline-partial","probeMode":mode,"passed":false,"webEnabled":false,"g3sQualified":false,"error":format!("{error:#}"),"desktopBuildId":crate::component::BUILD_ID})
            }
        };
        let bytes = serde_json::to_vec_pretty(&report)?;
        std::fs::write(output.join("startup-report.json"), &bytes)?;
        Ok(String::from_utf8(bytes)?)
    })())
}
/// The same manager accepts a paired executable from the standalone or embedded component owner.
/// The owner must supply its manifest hash; qualification CLI supplies an explicitly pinned candidate.
pub(crate) struct WorkerManager {
    executable: PathBuf,
    sha256: String,
}
impl WorkerManager {
    pub(crate) fn new(executable: PathBuf, sha256: String) -> Result<Self> {
        if !executable.is_absolute()
            || sha256.len() != 64
            || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            bail!("verified paired worker identity required");
        }
        let held = VerifiedWorker::open(&executable, Some(&sha256))?;
        let describe = std::process::Command::new(&executable)
            .arg("--describe")
            .output()
            .context("paired worker component description")?;
        if !describe.status.success() || describe.stdout.len() > 8192 {
            bail!("paired worker description unavailable");
        }
        let identity: serde_json::Value = serde_json::from_slice(&describe.stdout)?;
        if identity.get("desktopBuildId").and_then(|v| v.as_str())
            != Some(crate::component::BUILD_ID)
            || identity.get("componentProtocol").and_then(|v| v.as_u64()) != Some(1)
        {
            bail!("paired worker component build mismatch");
        }
        drop(held);
        Ok(Self { executable, sha256 })
    }
    fn probe(&self, output: &Path, mode: ProbeMode) -> Result<serde_json::Value> {
        let _active = ACTIVE
            .try_lock()
            .map_err(|_| anyhow::anyhow!("only one Web Worker may be active"))?;
        webview::initialize_owned_geometry_context()?;
        let version = wry::webview_version().context("installed WebView2 runtime version")?;
        let folder = runtime_folder(&version)?;
        let parent_binary = VerifiedWorker::open(&std::env::current_exe()?, None)?;
        let runtime_binary = VerifiedWorker::open(&folder.join("msedgewebview2.exe"), None)?;
        let monitor = crate::native::wallpaper_monitors()
            .into_iter()
            .next()
            .context("native wallpaper monitor unavailable")?;
        let mut launch = if mode == ProbeMode::OsBoundaries {
            Launch::suspended_probe(&self.executable, Some(&self.sha256), output, true)?
        } else {
            Launch::suspended(&self.executable, Some(&self.sha256), output)?
        };
        launch.job.install_runtime_pin(&runtime_binary)?;
        let bootstrap = Bootstrap {
            worker_protocol: PROTOCOL,
            identity: Identity {
                session_id: uuid::Uuid::new_v4().to_string(),
                generation: 1,
                package_hash: package_hash(),
            },
            entry: "index.html".into(),
            viewport: Viewport {
                left: monitor.left,
                top: monitor.top,
                width: monitor.width as u32,
                height: monitor.height as u32,
            },
            budget: launch.job.budget.clone(),
            desktop_build_id: crate::component::BUILD_ID.into(),
            worker_sha256: self.sha256.clone(),
            app_container_sid: launch.profile.sid_text.clone(),
            parent_pid: unsafe { GetCurrentProcessId() },
            parent_created: sandbox::created(launch.parent_identity.0)?,
            runtime_folder: folder.to_string_lossy().into(),
            runtime_version: version.clone(),
            user_data_folder: launch.profile.udf.to_string_lossy().into(),
            probe_mode: mode,
            boundary_probe: launch
                .boundary_fixture
                .as_ref()
                .map(|fixture| fixture.request()),
        };
        bootstrap.validate()?;
        let mut evidence = serde_json::json!({"schemaVersion":1,"gate":"G3-S-stop-1","passed":false,"webEnabled":false,"desktopBuildId":crate::component::BUILD_ID,"workerProtocol":PROTOCOL,"parent":{"pid":bootstrap.parent_pid,"created":bootstrap.parent_created},"worker":launch.worker,"sourceBinary":launch.source.identity,"stagedBinary":launch.staged.as_ref().unwrap().identity,"token":launch.token,"job":launch.job.evidence()?,"runtime":{"version":version,"folder":folder},"bootstrap":bootstrap,"events":[]});
        evidence["probeMode"] = serde_json::to_value(mode)?;
        evidence["g3sQualified"] = serde_json::json!(false);
        evidence["fixedWorkloadLimits"] = serde_json::json!({"busyMilliseconds":PROBE_BUSY_MS,
            "touchedAllocationBytes":PROBE_MEMORY_BYTES,"pageFloodFrames":192,"suspendDeadlineMilliseconds":2000});
        if mode != ProbeMode::Startup {
            evidence["gate"] = serde_json::json!("G3-S-offline-partial");
        }
        evidence["scope"] = serde_json::json!(match mode {
            ProbeMode::Startup => "restricted WebView2/WorkerW startup and natural whole-tree exit",
            ProbeMode::OsBoundaries => "native sibling canary read/write/create, excluded inherited file, parent harmful handle access, IPv4 loopback TCP/UDP; full browser/network matrix remains unqualified",
            ProbeMode::BusySuspend => "fixed 8s JS loop, native TrySuspend attempt and independent 2s owned-Job termination; callback alone never proves suspension",
            ProbeMode::BoundedMemory => "fixed 64MiB touched JS allocation, native Job peak commit growth and owned-Job termination; 512MiB limit enforcement and GPU pressure remain unqualified",
            ProbeMode::MessageFlood => "fixed 192 valid page frames exceed native page rate bucket and terminate owned Job; private pipe fuzz matrix remains separate",
        });
        evidence["parentBinary"] = serde_json::to_value(&parent_binary.identity)?;
        evidence["runtimeBinary"] = serde_json::to_value(&runtime_binary.identity)?;
        // Save native facts before resuming, including failures after this point.
        std::fs::write(
            output.join("launch-evidence.json"),
            serde_json::to_vec_pretty(&evidence)?,
        )?;
        let read = launch.control_read.take().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let reader_cancel = cancel.clone();
        let (events, receiver) = mpsc::sync_channel::<Result<WorkerControl>>(CONTROL_QUEUE_FRAMES);
        let control_thread = std::thread::spawn(move || {
            let mut read = sandbox::CancellableReader::new(read, reader_cancel);
            let mut rate = InboundRate::new();
            loop {
                let result = read_json::<WorkerControl>(&mut read).map_err(anyhow::Error::from);
                let failed = result.is_err();
                if !rate.admit() {
                    let _ = events.try_send(Err(anyhow::anyhow!("control flood rate exceeded")));
                    break;
                }
                if events.try_send(result).is_err() || failed {
                    break;
                }
            }
        });
        let resources = broker(
            launch.resource_read.take().unwrap(),
            launch.resource_write.take().unwrap(),
            bootstrap.identity.clone(),
            cancel.clone(),
        );
        let mut writer = ControlWriter::new(launch.control_write.take().unwrap())?;
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let deadline_guard = launch.job.deadline(deadline)?;
        // Resume only after native admission, before writing to an initially suspended reader.
        // The worker blocks on this private bootstrap and cannot initialize any ordinary owner.
        launch.resume()?;
        evidence["resumed"] = serde_json::json!(true);
        std::fs::write(
            output.join("launch-evidence.json"),
            serde_json::to_vec_pretty(&evidence)?,
        )?;
        writer.send(ParentControl::Bootstrap {
            bootstrap: Box::new(bootstrap.clone()),
        })?;
        evidence["bootstrapWritten"] = serde_json::json!(true);
        std::fs::write(
            output.join("launch-evidence.json"),
            serde_json::to_vec_pretty(&evidence)?,
        )?;
        let mut mounted = false;
        let mut mounted_hwnd = std::ptr::null_mut();
        let mut frame = false;
        let mut closed = false;
        let mut boundaries = false;
        let mut workload_started = None::<Instant>;
        let mut workload_dispatched = None::<Instant>;
        let mut suspend_at = None::<Instant>;
        let mut suspend_guard = None;
        let mut suspend_requested = false;
        let mut expected_termination = false;
        let result = (|| -> Result<()> {
            loop {
                launch.job.observation_health()?;
                if Instant::now() > deadline {
                    bail!("restricted worker startup/close deadline");
                }
                if mode == ProbeMode::BusySuspend
                    && suspend_at.is_none()
                    && workload_started
                        .is_some_and(|started| started.elapsed() >= Duration::from_secs(1))
                {
                    let sample = launch.job.workload_sample()?;
                    let before = evidence["workloadStarted"]["totalUserTime100ns"]
                        .as_i64()
                        .context("missing native workload start CPU sample")?;
                    let after = sample["totalUserTime100ns"]
                        .as_i64()
                        .context("missing native busy CPU sample")?;
                    let dispatched =
                        workload_dispatched.context("missing fixed workload dispatch")?;
                    if !busy_window_valid(dispatched.elapsed(), before, after) {
                        bail!("busy workload proof missing current CPU growth or within-loop pause window");
                    }
                    evidence["busyNativeSample"] = sample;
                    evidence["busyDispatchToSuspendMs"] =
                        serde_json::json!(dispatched.elapsed().as_millis());
                    let now = Instant::now();
                    suspend_at = Some(now);
                    // A separate owned-Job deadline survives a stalled COM callback/control writer.
                    suspend_guard = Some(launch.job.deadline(now + Duration::from_secs(2))?);
                    writer.send(ParentControl::SuspendProbe {
                        identity: bootstrap.identity.clone(),
                    })?;
                }
                let received = receiver.recv_timeout(Duration::from_millis(25));
                if suspend_at.is_some_and(|started| started.elapsed() >= Duration::from_secs(2)) {
                    launch.job.terminate()?;
                    expected_termination = true;
                    evidence["suspendTerminationElapsedMs"] =
                        serde_json::json!(suspend_at.unwrap().elapsed().as_millis());
                    break;
                }
                match received {
                    Ok(message) => {
                        let message = message?;
                        message.validate(&bootstrap.identity)?;
                        // Record receipt before synchronous native work. The
                        // last event then identifies the operation in flight.
                        evidence["events"]
                            .as_array_mut()
                            .unwrap()
                            .push(serde_json::to_value(&message)?);
                        std::fs::write(
                            output.join("launch-evidence.json"),
                            serde_json::to_vec_pretty(&evidence)?,
                        )?;
                        match &message {
                            WorkerControl::Boundaries { receipt, .. } => {
                                if mode != ProbeMode::OsBoundaries || boundaries {
                                    bail!("unexpected boundary receipt");
                                }
                                evidence["boundaryReceipt"] = serde_json::to_value(receipt)?;
                                // Preserve independent listener/canary facts even when the
                                // restricted worker reports an unexpectedly successful call.
                                evidence["boundaryParentControl"] = launch
                                    .boundary_fixture
                                    .as_ref()
                                    .context("missing native boundary fixture")?
                                    .verify()?;
                                if !receipt.passed() {
                                    bail!("OS boundary probe did not receive exact access-denied results");
                                }
                                if evidence["boundaryParentControl"]["passed"] != true {
                                    bail!("native boundary canary or loopback listener changed");
                                }
                                boundaries = true;
                            }
                            WorkerControl::ProbeStarted { mode: actual, .. } => {
                                if !frame || *actual != mode || workload_started.is_some() {
                                    bail!("unexpected workload receipt");
                                }
                                workload_started = Some(Instant::now());
                                evidence["workloadStarted"] = launch.job.workload_sample()?;
                                if mode == ProbeMode::BoundedMemory {
                                    let before = evidence["workloadBefore"]["peakJobMemoryBytes"]
                                        .as_u64()
                                        .unwrap_or(u64::MAX);
                                    let after = evidence["workloadStarted"]["peakJobMemoryBytes"]
                                        .as_u64()
                                        .unwrap_or(0);
                                    evidence["nativePeakCommitIncrease"] =
                                        serde_json::json!(after.saturating_sub(before));
                                    if after.saturating_sub(before) < PROBE_MEMORY_BYTES / 2 {
                                        bail!("bounded allocation lacked native commit growth");
                                    }
                                    launch.job.terminate()?;
                                    expected_termination = true;
                                }
                            }
                            WorkerControl::SuspendRequested { .. } => {
                                if mode != ProbeMode::BusySuspend
                                    || suspend_at.is_none()
                                    || suspend_requested
                                {
                                    bail!("unexpected suspension receipt");
                                }
                                suspend_requested = true;
                            }
                            WorkerControl::SuspendResult { .. } => {
                                if !suspend_requested {
                                    bail!("suspend callback preceded native request");
                                }
                                // Diagnostic only. The independent parent deadline still closes the Job.
                            }
                            WorkerControl::ProbeRejected { reason, .. } => {
                                if mode != ProbeMode::MessageFlood
                                    || workload_started.is_none()
                                    || reason != "worker page protocol limit"
                                {
                                    bail!("unexpected workload rejection");
                                }
                                launch.job.terminate()?;
                                expected_termination = true;
                            }
                            WorkerControl::Stage { .. } => {}
                            WorkerControl::Window {
                                hwnd, pid, created, ..
                            } => {
                                if mounted
                                    || *pid != launch.worker.pid
                                    || *created != launch.worker.created
                                {
                                    bail!("worker HWND process identity mismatch");
                                }
                                let hwnd = *hwnd as windows_sys::Win32::Foundation::HWND;
                                // Validate ownership before changing even opacity on an untrusted HWND value.
                                let mut actual_pid = 0;
                                let thread = unsafe {
                                    windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd,&mut actual_pid)
                                };
                                if thread == 0 || actual_pid != launch.worker.pid {
                                    bail!("reported HWND is not owned by the held worker process");
                                }
                                let mut class = [0u16; 128];
                                let length = unsafe {
                                    windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW(
                                        hwnd,
                                        class.as_mut_ptr(),
                                        class.len() as i32,
                                    )
                                };
                                if length <= 0
                                    || String::from_utf16(&class[..length as usize])?
                                        != "HertzIsolatedWallpaperWorkerV1"
                                {
                                    bail!("reported HWND class differs from fixed worker class");
                                }
                                crate::native::wallpaper_opacity(hwnd, 0)?;
                                evidence["mount"] =
                                    crate::native::mount_wallpaper_checked(hwnd, *pid, &monitor)?;
                                writer.send(ParentControl::Mounted {
                                    identity: bootstrap.identity.clone(),
                                    hwnd: hwnd as u64,
                                })?;
                                mounted = true;
                                mounted_hwnd = hwnd;
                            }
                            WorkerControl::Environment {
                                runtime_version,
                                browser_pid,
                                processes,
                                muted,
                                required_interfaces,
                                ..
                            } => {
                                if !mounted
                                    || runtime_version != &bootstrap.runtime_version
                                    || !*muted
                                    || !*required_interfaces
                                    || !processes.iter().any(|p| p.pid == *browser_pid)
                                {
                                    bail!("isolated environment evidence mismatch");
                                }
                                launch.job.verify_environment(processes)?;
                                evidence["environmentProcesses"] = serde_json::to_value(processes)?;
                            }
                            WorkerControl::FirstFrame {
                                capture_sha256,
                                capture_png,
                                ..
                            } => {
                                if !mounted || launch.job.observed_runtime_count()? == 0 || frame {
                                    bail!("first frame preceded verified mount/environment");
                                }
                                let path = launch.profile.udf.join("first-frame.png");
                                if Path::new(capture_png) != path {
                                    bail!("capture path outside own UDF");
                                }
                                validate_capture(&path, capture_sha256, &bootstrap.viewport)?;
                                std::fs::copy(&path, output.join("first-frame.png"))?;
                                // Open the native presentation gate only after verifying real pixels.
                                if !crate::native::wallpaper_alive(mounted_hwnd) {
                                    bail!("WorkerW attachment vanished before presentation");
                                }
                                crate::native::wallpaper_opacity(mounted_hwnd, 255)?;
                                let mut alpha = 0;
                                let mut flags = 0;
                                sandbox::win(
                                    unsafe {
                                        windows_sys::Win32::UI::WindowsAndMessaging::GetLayeredWindowAttributes(mounted_hwnd,std::ptr::null_mut(),&mut alpha,&mut flags)
                                    },
                                    "read native presentation opacity",
                                )?;
                                if alpha != 255
                                    || unsafe {
                                        windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible(
                                            mounted_hwnd,
                                        )
                                    } == 0
                                {
                                    bail!("native presentation gate did not become visible");
                                }
                                evidence["presentation"] = serde_json::json!({"hwnd":mounted_hwnd as u64,"visible":true,"alpha":alpha,"flags":flags,"afterVerifiedCapture":true});
                                std::thread::sleep(Duration::from_millis(250));
                                frame = true;
                                if mode.expects_termination() {
                                    evidence["workloadBefore"] = launch.job.workload_sample()?;
                                    workload_dispatched = Some(Instant::now());
                                    writer.send(ParentControl::RunProbe {
                                        identity: bootstrap.identity.clone(),
                                    })?;
                                } else {
                                    if mode == ProbeMode::OsBoundaries {
                                        if !boundaries {
                                            bail!("missing OS boundary receipt");
                                        }
                                        let receipt = launch
                                            .boundary_fixture
                                            .as_ref()
                                            .context("missing native boundary fixture")?
                                            .verify()?;
                                        let passed = receipt["passed"] == true;
                                        evidence["boundaryParentFinalControl"] = receipt;
                                        if !passed {
                                            bail!("native boundary canary or loopback listener changed");
                                        }
                                    }
                                    writer.send(ParentControl::Stop {
                                        identity: bootstrap.identity.clone(),
                                    })?;
                                }
                            }
                            WorkerControl::Closed {
                                controller_closed,
                                hwnd_destroyed,
                                ..
                            } => {
                                if !*controller_closed || !*hwnd_destroyed {
                                    bail!("worker close barrier incomplete");
                                }
                                closed = true;
                            }
                            WorkerControl::Failed { stage, message, .. } => {
                                bail!("{stage}: {message}")
                            }
                        }
                        std::fs::write(
                            output.join("launch-evidence.json"),
                            serde_json::to_vec_pretty(&evidence)?,
                        )?;
                        if closed || expected_termination {
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if unsafe {
                            windows_sys::Win32::System::Threading::WaitForSingleObject(
                                launch.process.0,
                                0,
                            )
                        } == windows_sys::Win32::Foundation::WAIT_OBJECT_0
                        {
                            bail!("worker tree exited before close receipt");
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        bail!("private worker control disconnected")
                    }
                }
            }
            if !mounted
                || !frame
                || (mode.expects_termination()
                    && (!expected_termination || workload_started.is_none()))
                || (!mode.expects_termination() && !closed)
                || (mode == ProbeMode::BusySuspend && !suspend_requested)
            {
                bail!("missing native startup facts");
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = writer.send(ParentControl::Stop {
                identity: bootstrap.identity.clone(),
            });
            // Invalid or unresponsive startup never depends on another worker ACK.
            launch.job.terminate()?;
        }
        evidence["nativeCloseStarted"] = serde_json::json!(true);
        std::fs::write(
            output.join("launch-evidence.json"),
            serde_json::to_vec_pretty(&evidence)?,
        )?;
        let exit = launch.close();
        cancel.store(true, Ordering::Release);
        writer.close();
        let _ = control_thread.join();
        let _ = resources.join();
        evidence["deadlineTerminatedJob"] = serde_json::json!(deadline_guard.finish()?);
        if let Some(guard) = suspend_guard {
            evidence["suspendDeadlineTerminatedJob"] = serde_json::json!(guard.finish()?);
        }
        evidence["exit"] = match exit {
            Ok(value) => value,
            Err(error) => {
                serde_json::json!({"error":format!("{error:#}"),"activeProcesses":launch.job.active().ok()})
            }
        };
        evidence["processLifecycle"] = launch.job.observation_evidence().unwrap_or_else(
            |error| serde_json::json!({"error":format!("{error:#}"),"observationIncomplete":true}),
        );
        evidence["nativeQualificationClean"] = serde_json::json!(launch.job.qualification_clean());
        evidence["expectedProbeTermination"] = serde_json::json!(expected_termination);
        let close_passed = probe_close_passed(mode, expected_termination, &evidence);
        evidence["passed"] = serde_json::json!(
            result.is_ok()
                && close_passed
                && evidence["exit"]["activeProcesses"] == 0
                && evidence["deadlineTerminatedJob"] == false
        );
        if let Err(error) = result {
            evidence["error"] = serde_json::json!(format!("{error:#}"));
        } else if evidence["passed"] != true {
            evidence["error"] = serde_json::json!(probe_failure_reason(&evidence));
        }
        Ok(evidence)
    }
}
fn probe_failure_reason(evidence: &serde_json::Value) -> String {
    if let Some(error) = evidence["exit"]["error"].as_str() {
        return error.to_owned();
    }
    if evidence["deadlineTerminatedJob"] == true {
        return "original startup deadline terminated the Job".into();
    }
    if evidence["processLifecycle"]["fatalObserved"] == true {
        return "original Job observer reported a fatal lifecycle event".into();
    }
    if evidence["exit"]["completionMessagesComplete"] != true {
        return "original Job completion EXIT receipts incomplete; physical exit alone does not qualify this probe".into();
    }
    if evidence["exit"]["observerPhysicalExitConfirmed"] != true
        || evidence["exit"]["activeProcesses"] != 0
    {
        return "original Job physical exit barrier incomplete".into();
    }
    "native probe close policy did not pass".into()
}
fn busy_window_valid(dispatch_elapsed: Duration, cpu_before: i64, cpu_after: i64) -> bool {
    // Leave the full 2s stop deadline plus 2s margin inside the fixed 8s loop.
    dispatch_elapsed < Duration::from_millis(PROBE_BUSY_MS - 4_000)
        && cpu_before >= 0
        && cpu_after.saturating_sub(cpu_before) > 100_000
}
fn probe_close_passed(
    mode: ProbeMode,
    expected_termination: bool,
    evidence: &serde_json::Value,
) -> bool {
    if evidence["exit"]["activeProcesses"] != 0
        || evidence["exit"]["completionMessagesComplete"] != true
        || evidence["exit"]["observerPhysicalExitConfirmed"] != true
        || evidence["processLifecycle"]["fatalObserved"] != false
    {
        return false;
    }
    if mode.expects_termination() {
        expected_termination && evidence["exit"]["jobTerminated"] == true
    } else {
        !expected_termination
            && evidence["exit"]["gracefulTreeExit"] == true
            && evidence["nativeQualificationClean"] == true
    }
}
fn broker(
    read: File,
    mut write: File,
    identity: Identity,
    cancel: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut read = sandbox::CancellableReader::new(read, cancel);
        let mut rate = InboundRate::new();
        while let Ok(request) = read_json::<ResourceRequest>(&mut read) {
            if !rate.admit() || request.validate(&identity).is_err() {
                break;
            }
            let Some((_, mime, body)) = assets()
                .into_iter()
                .find(|(path, _, _)| *path == request.path)
            else {
                break;
            };
            let bytes = if request.method == "HEAD" {
                &[][..]
            } else {
                body
            };
            let response = ResourceResponse {
                identity: identity.clone(),
                request_id: request.request_id,
                status: 200,
                mime: mime.into(),
                body_bytes: bytes.len() as u32,
            };
            if write_json(&mut write, &response)
                .and_then(|_| write_body(&mut write, bytes))
                .is_err()
            {
                break;
            }
        }
    })
}
fn runtime_folder(version: &str) -> Result<PathBuf> {
    if version.is_empty()
        || version.len() > 128
        || !version.bytes().all(|b| b.is_ascii_digit() || b == b'.')
    {
        bail!("invalid installed runtime version");
    }
    for variable in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(variable) {
            let path = PathBuf::from(base)
                .join("Microsoft/EdgeWebView/Application")
                .join(version);
            if path.join("msedgewebview2.exe").is_file() {
                return path
                    .canonicalize()
                    .context("canonical bound runtime folder");
            }
        }
    }
    bail!("exact installed WebView2 runtime folder unavailable")
}
fn validate_capture(path: &Path, expected: &str, viewport: &Viewport) -> Result<()> {
    let metadata = std::fs::metadata(path)?;
    if metadata.len() == 0 || metadata.len() > 8 * 1024 * 1024 {
        bail!("capture size out of bounds");
    }
    let bytes = std::fs::read(path)?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected {
        bail!("native capture hash mismatch");
    }
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)?.to_rgba8();
    if image.width() != viewport.width || image.height() != viewport.height {
        bail!("native capture dimensions differ from mounted viewport");
    }
    let outside = image.get_pixel(viewport.width / 8, viewport.height / 8).0;
    let center = image.get_pixel(viewport.width / 2, viewport.height / 2).0;
    let close = |actual: [u8; 4], expected: [u8; 3]| {
        actual[..3]
            .iter()
            .zip(expected)
            .all(|(a, b)| a.abs_diff(b) <= 3)
            && actual[3] > 250
    };
    if !close(outside, [0x17, 0x3f, 0x35]) || !close(center, [0xe5, 0xbd, 0x63]) {
        bail!("native capture did not contain rendered fixed probe colors");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resource_identity_cannot_cross_package_or_generation() {
        let identity = Identity {
            session_id: uuid::Uuid::new_v4().to_string(),
            generation: 1,
            package_hash: package_hash(),
        };
        let mut request = ResourceRequest {
            identity: identity.clone(),
            request_id: 1,
            method: "GET".into(),
            path: "probe.js".into(),
        };
        assert!(request.validate(&identity).is_ok());
        request.identity.generation = 2;
        assert!(request.validate(&identity).is_err());
        request.identity = identity.clone();
        request.path = "../config.json".into();
        assert!(request.validate(&identity).is_err());
    }
    #[test]
    fn adversarial_probe_exit_requires_complete_owned_physical_receipts() {
        let mut evidence = serde_json::json!({"exit":{"jobTerminated":true,"activeProcesses":0,
            "completionMessagesComplete":true,"observerPhysicalExitConfirmed":true,"gracefulTreeExit":false},
            "processLifecycle":{"fatalObserved":false},"nativeQualificationClean":false});
        assert!(probe_close_passed(ProbeMode::BusySuspend, true, &evidence));
        assert!(!probe_close_passed(
            ProbeMode::BusySuspend,
            false,
            &evidence
        ));
        assert!(!probe_close_passed(ProbeMode::Startup, true, &evidence));
        evidence["exit"]["completionMessagesComplete"] = serde_json::json!(false);
        assert!(!probe_close_passed(
            ProbeMode::MessageFlood,
            true,
            &evidence
        ));
        evidence["exit"]["completionMessagesComplete"] = serde_json::json!(true);
        evidence["processLifecycle"]["fatalObserved"] = serde_json::json!(true);
        assert!(!probe_close_passed(
            ProbeMode::BoundedMemory,
            true,
            &evidence
        ));
        assert!(!probe_close_passed(
            ProbeMode::BusySuspend,
            true,
            &serde_json::json!({})
        ));
    }
    #[test]
    fn busy_suspend_rejects_delayed_receipts_and_historical_cpu() {
        assert!(busy_window_valid(Duration::from_secs(1), 200_000, 400_001));
        assert!(!busy_window_valid(Duration::from_secs(8), 200_000, 400_001));
        assert!(!busy_window_valid(Duration::from_secs(4), 200_000, 400_001));
        assert!(!busy_window_valid(Duration::from_secs(1), 400_001, 400_001));
        assert!(!busy_window_valid(Duration::from_secs(1), 400_001, 200_000));
    }
    #[test]
    fn native_probe_failure_reports_close_errors_and_missing_exit_receipts() {
        let failed_close =
            serde_json::json!({"exit":{"error":"held GPU process did not signal before deadline"}});
        assert_eq!(
            probe_failure_reason(&failed_close),
            "held GPU process did not signal before deadline"
        );
        let lost_exit = serde_json::json!({"exit":{"completionMessagesComplete":false,"activeProcesses":0,"observerPhysicalExitConfirmed":true}});
        assert!(probe_failure_reason(&lost_exit).contains("completion EXIT receipts incomplete"));
    }
}
