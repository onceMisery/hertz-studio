// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! DESK-W0 原生探针：WorkerW 桌面挂载、图标层输入、策略停绘与视觉时钟。
//! 这是隔离实验入口，不是生产宿主；证据写入 `--out` 指定目录。

#[cfg(not(windows))]
fn main() {
    eprintln!("wallpaper-probe only runs on Windows");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    if let Err(error) = wallpaper::run() {
        eprintln!("wallpaper-probe failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod wallpaper {
    use std::error::Error;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};
    use std::sync::{Arc, OnceLock};
    use std::time::{Duration, Instant};

    use tao::dpi::PhysicalSize;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
    use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
    use tao::window::{Window, WindowBuilder};
    use tray_icon::menu::{Menu, MenuEvent, MenuItem};
    use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};
    use windows_sys::Win32::Foundation::{
        CloseHandle, FILETIME, HWND, INVALID_HANDLE_VALUE, LPARAM, POINT, RECT,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        RedrawWindow, RDW_ALLCHILDREN, RDW_FRAME, RDW_INVALIDATE, RDW_UPDATENOW,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Power::{
        RegisterPowerSettingNotification, RegisterSuspendResumeNotification, POWERBROADCAST_SETTING,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::SystemServices::GUID_MONITOR_POWER_ON;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEINPUT,
    };
    use windows_sys::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUERY_USER_NOTIFICATION_STATE, QUNS_BUSY, QUNS_NOT_PRESENT,
        QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, EnumWindows, FindWindowExW, GetAncestor, GetClassNameW,
        GetCursorPos, GetParent, GetSystemMetrics, GetWindow, GetWindowLongPtrW, GetWindowRect,
        IsWindow, IsWindowVisible, PostMessageW, SendMessageTimeoutW, SetCursorPos, SetParent,
        SetWindowLongPtrW, SetWindowPos, ShowWindow, WindowFromPoint, DEVICE_NOTIFY_WINDOW_HANDLE,
        GA_ROOT, GWLP_WNDPROC, GWL_EXSTYLE, GWL_STYLE, GW_CHILD, GW_HWNDNEXT, HWND_BOTTOM,
        PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, PBT_POWERSETTINGCHANGE,
        SMTO_NORMAL, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        SWP_SHOWWINDOW, SW_SHOW, WM_POWERBROADCAST, WNDPROC, WS_CAPTION, WS_CHILD, WS_EX_APPWINDOW,
        WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU,
        WS_THICKFRAME,
    };
    use wry::{WebViewBuilder, WebViewExtWindows};

    const PAGE: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;overflow:hidden;background:#08101f}
canvas{display:block;width:100vw;height:100vh}
</style></head><body><canvas id="field"></canvas>
<script>
const canvas = document.getElementById('field');
const ctx = canvas.getContext('2d');
const stars = Array.from({length: 140}, () => ({
  x: Math.random(), y: Math.random(), z: Math.random() * 0.8 + 0.2, phase: Math.random() * 6.28
}));
let motion = { raf: 0, frames: 0, draws: 0, started: 0, cap: 30, lastDraw: 0, lastReport: 0, sceneTime: 0, songPosition: 0, lastTick: 0, paused: false, pauseStarted: 0 };
function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();
function draw(now) {
  const w = innerWidth, h = innerHeight;
  const t = motion.sceneTime / 1000;
  ctx.fillStyle = '#08101f';
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w * 0.3, h * 0.25, 0, w * 0.3, h * 0.25, Math.max(w, h) * 0.8);
  glow.addColorStop(0, 'rgba(54,116,190,.30)');
  glow.addColorStop(1, 'rgba(8,16,31,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  for (const star of stars) {
    const x = (star.x + t * 0.006 * star.z) % 1;
    const y = star.y + Math.sin(t * 0.15 + star.phase) * 0.004;
    const r = 0.5 + star.z * 1.7;
    ctx.fillStyle = 'rgba(210,232,255,' + (0.25 + star.z * 0.65) + ')';
    ctx.beginPath(); ctx.arc(x * w, y * h, r, 0, 6.283); ctx.fill();
  }
  ctx.fillStyle = 'rgba(215,227,247,.72)';
  ctx.font = '600 16px Segoe UI, sans-serif';
  ctx.fillText('Hertz DESK-W0 · sceneTime ' + (motion.sceneTime / 1000).toFixed(1) + 's', w - 420, h - 120);
}
function report(now) {
  if (window.ipc) window.ipc.postMessage(JSON.stringify({
    kind: 'frame', raf: motion.frames, draws: motion.draws, cap: motion.cap,
    sceneTime: Math.round(motion.sceneTime), songPosition: motion.songPosition,
    hidden: document.hidden, visibility: document.visibilityState,
    dpr: devicePixelRatio, size: [innerWidth, innerHeight], paused: motion.paused
  }));
}
function loop(now) {
  motion.raf = requestAnimationFrame(loop);
  motion.frames++;
  if (motion.lastTick === 0) motion.lastTick = now;
  const dt = Math.min(100, now - motion.lastTick);
  motion.lastTick = now;
  if (!motion.paused) motion.sceneTime += dt;
  if (!motion.cap || now - motion.lastDraw >= (1000 / motion.cap) - 0.5) {
    motion.lastDraw = now;
    motion.draws++;
    draw(now);
  }
  if (now - motion.lastReport >= 1000) {
    motion.lastReport = now;
    report(now);
  }
}
window.startMotion = function (fps) {
  motion.cap = fps;
  motion.started = performance.now();
  motion.lastReport = 0;
  motion.lastTick = 0;
  motion.paused = false;
  if (!motion.raf) motion.raf = requestAnimationFrame(loop);
};
window.stopMotion = function () {
  if (motion.raf) cancelAnimationFrame(motion.raf);
  motion.raf = 0;
  if (window.ipc) window.ipc.postMessage(JSON.stringify({kind: 'stopped', sceneTime: Math.round(motion.sceneTime), draws: motion.draws}));
};
window.watchVisibility = function () {
  if (window.visibilityTimer) return;
  window.visibilityTimer = setInterval(function () {
    if (window.ipc) window.ipc.postMessage(JSON.stringify({
      kind: 'visibility', hidden: document.hidden, visibility: document.visibilityState,
      paused: motion.paused, sceneTime: Math.round(motion.sceneTime), draws: motion.draws
    }));
  }, 1000);
};
window.stopWatch = function () {
  if (window.visibilityTimer) { clearInterval(window.visibilityTimer); window.visibilityTimer = 0; }
};
window.pauseScene = function () {
  if (!motion.paused) { motion.paused = true; motion.pauseStarted = performance.now(); }
};
window.resumeScene = function () {
  if (motion.paused) { motion.paused = false; motion.lastTick = 0; }
};
window.seekSong = function (ms) {
  motion.songPosition = ms;
  if (window.ipc) window.ipc.postMessage(JSON.stringify({kind: 'seek', songPosition: ms, sceneTime: Math.round(motion.sceneTime)}));
};
document.addEventListener('mousedown', function () { if (window.ipc) window.ipc.postMessage('click'); });
</script></body></html>"#;

    enum UserEvent {
        Tick(u8),
        Check,
        EnvChange { reason: u8, on: bool },
        Tray(TrayIconEvent),
        Menu(MenuEvent),
    }

    const REASON_MANUAL: u8 = 1 << 0;
    const REASON_FULLSCREEN: u8 = 1 << 1;
    const REASON_SESSION: u8 = 1 << 2;
    const REASON_DISPLAY_OFF: u8 = 1 << 3;
    const REASON_SLEEP: u8 = 1 << 4;

    static ORIGINAL_WNDPROC: AtomicIsize = AtomicIsize::new(0);
    static EVENT_PROXY: OnceLock<EventLoopProxy<UserEvent>> = OnceLock::new();

    #[derive(Clone)]
    struct TreeSample {
        cpu_100ns: u64,
        working_set: u64,
        processes: usize,
        webview_processes: usize,
        pids: Vec<u32>,
        per_process: Vec<(u32, String, u64)>,
    }

    struct Recovery {
        attempts: Vec<Instant>,
        terminal: bool,
    }

    impl Recovery {
        fn new() -> Self {
            Self {
                attempts: Vec::new(),
                terminal: false,
            }
        }

        fn begin(&mut self) -> bool {
            let now = Instant::now();
            self.attempts
                .retain(|attempt| now.duration_since(*attempt) < Duration::from_secs(120));
            if self.attempts.len() >= 3 {
                self.terminal = true;
                return false;
            }
            self.attempts.push(now);
            true
        }
    }

    #[derive(Clone)]
    struct Evidence {
        dir: PathBuf,
    }

    impl Evidence {
        fn new(dir: PathBuf) -> std::io::Result<Self> {
            fs::create_dir_all(&dir)?;
            Ok(Self { dir })
        }

        fn log(&self, line: impl AsRef<str>) {
            let line = line.as_ref();
            println!("{line}");
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.dir.join("probe.log"))
            {
                let _ = writeln!(file, "{line}");
            }
        }

        fn marker(&self, name: &str) {
            let _ = fs::write(self.dir.join(format!("{name}.ready")), b"");
        }
    }

    struct Probe {
        window: Window,
        view: wry::WebView,
        evidence: Evidence,
        workerw: HWND,
        clicks: Arc<AtomicUsize>,
        #[allow(dead_code)]
        tray: TrayIcon,
        quit_id: String,
        retry_id: String,
        screen_w: i32,
        screen_h: i32,
        current_fps: u32,
        stopping: bool,
        recovery: Recovery,
        policy_reasons: u8,
        policy_hidden: bool,
        fullscreen_state: Option<QUERY_USER_NOTIFICATION_STATE>,
        restart_test: bool,
        cpu_mark: Option<(String, Instant, TreeSample)>,
    }

    impl Probe {
        fn hwnd(&self) -> HWND {
            self.window.hwnd() as HWND
        }

        fn eval(&self, tag: &str, script: &str) {
            match self.view.evaluate_script(script) {
                Ok(()) => self.evidence.log(format!("eval tag={tag} ok")),
                Err(error) => self.evidence.log(format!("eval tag={tag} error={error}")),
            }
        }

        fn state(&self, tag: &str) {
            let hwnd = self.hwnd();
            let workerw = self.workerw;
            let alive = unsafe { IsWindow(hwnd) } != 0;
            let parent = if alive {
                unsafe { GetParent(hwnd) }
            } else {
                std::ptr::null_mut()
            };
            self.evidence.log(format!(
                "state tag={tag} hwnd={} workerw={} parent={} parent_is_workerw={} alive={} visible={} workerw_alive={}",
                fmt_hwnd(hwnd),
                fmt_hwnd(workerw),
                fmt_hwnd(parent),
                parent == workerw,
                alive,
                alive && unsafe { IsWindowVisible(hwnd) } != 0,
                unsafe { IsWindow(workerw) } != 0
            ));
        }

        fn probe_input(&self, tag: &str) {
            let point = POINT { x: 1500, y: 360 };
            let raw = unsafe { WindowFromPoint(point) };
            let root = if raw.is_null() {
                raw
            } else {
                unsafe { GetAncestor(raw, GA_ROOT) }
            };
            let before = self.clicks.load(Ordering::SeqCst);
            let mut saved = POINT::default();
            unsafe { GetCursorPos(&mut saved) };
            let inserted = unsafe {
                SetCursorPos(point.x, point.y);
                std::thread::sleep(Duration::from_millis(120));
                let inserted = send_click(point.x, point.y);
                std::thread::sleep(Duration::from_millis(500));
                SetCursorPos(saved.x, saved.y);
                inserted
            };
            let after = self.clicks.load(Ordering::SeqCst);
            self.evidence.log(format!(
                "input tag={tag} raw={} raw_class={} root={} root_class={} overlay_clicked={} page_clicks={before}->{after} send_input={inserted}",
                fmt_hwnd(raw),
                class_name(raw),
                fmt_hwnd(root),
                class_name(root),
                root == self.hwnd()
            ));
        }

        fn check_health(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
            if self.stopping || self.recovery.terminal {
                return;
            }
            let hwnd = self.hwnd();
            let alive = unsafe { IsWindow(hwnd) } != 0;
            let parent = if alive {
                unsafe { GetParent(hwnd) }
            } else {
                std::ptr::null_mut()
            };
            let workerw_alive = unsafe { IsWindow(self.workerw) } != 0;
            if alive && parent == self.workerw && workerw_alive {
                return;
            }
            self.evidence.log(format!(
                "health_lost hwnd={} alive={alive} parent={} workerw={} workerw_alive={workerw_alive}",
                fmt_hwnd(hwnd),
                fmt_hwnd(parent),
                fmt_hwnd(self.workerw)
            ));
            self.recover(target);
        }

        fn set_reason(&mut self, reason: u8, on: bool, tag: &str) {
            let before = self.policy_reasons;
            if on {
                self.policy_reasons |= reason;
            } else {
                self.policy_reasons &= !reason;
            }
            let hidden = self.policy_reasons != 0;
            if hidden == self.policy_hidden {
                self.evidence.log(format!(
                    "policy_reason tag={tag} reasons={:#04x} before={before:#04x} hidden={hidden}",
                    self.policy_reasons
                ));
                return;
            }
            self.policy_hidden = hidden;
            if hidden {
                let result = unsafe { self.view.controller().SetIsVisible(false) };
                self.eval("policy-stop", "window.stopMotion()");
                self.evidence.log(format!(
                    "policy_change tag={tag} reasons={:#04x} hidden=true controller={result:?}",
                    self.policy_reasons
                ));
            } else {
                let result = unsafe { self.view.controller().SetIsVisible(true) };
                self.eval(
                    "policy-start",
                    &format!("window.startMotion({})", self.current_fps),
                );
                self.evidence.log(format!(
                    "policy_change tag={tag} reasons={:#04x} hidden=false controller={result:?}",
                    self.policy_reasons
                ));
            }
        }

        fn check_fullscreen(&mut self) {
            let state = query_notification_state();
            let active = is_fullscreen_state(state);
            let session = state == QUNS_NOT_PRESENT;
            if self.fullscreen_state == Some(state) {
                return;
            }
            self.fullscreen_state = Some(state);
            self.evidence.log(format!(
                "notification_state state={state} fullscreen={active} session_absent={session}"
            ));
            self.set_reason(REASON_FULLSCREEN, active, "fullscreen");
            self.set_reason(REASON_SESSION, session, "session-absent");
        }

        fn start_cpu(&mut self, tag: &str) {
            let sample = sample_process_tree();
            self.evidence.log(format!(
                "cpu_mark tag={tag} processes={} webview_processes={} pids={:?} cpu_ms={} working_set_mb={:.1}",
                sample.processes,
                sample.webview_processes,
                sample.pids,
                sample.cpu_100ns / 10_000,
                sample.working_set as f64 / (1024.0 * 1024.0)
            ));
            self.cpu_mark = Some((tag.to_string(), Instant::now(), sample));
        }

        fn finish_cpu(&mut self, tag: &str) {
            let Some((prev_tag, started, prev)) = self.cpu_mark.take() else {
                return;
            };
            let now = sample_process_tree();
            let elapsed_ms = started.elapsed().as_millis().max(1);
            let delta_ms = now.cpu_100ns.saturating_sub(prev.cpu_100ns) as f64 / 10_000.0;
            let mut deltas: Vec<(u32, String, f64)> = now
                .per_process
                .iter()
                .map(|(pid, name, cpu)| {
                    let before = prev
                        .per_process
                        .iter()
                        .find(|(previous_pid, _, _)| previous_pid == pid)
                        .map(|(_, _, previous_cpu)| *previous_cpu)
                        .unwrap_or(0);
                    (
                        *pid,
                        name.clone(),
                        cpu.saturating_sub(before) as f64 / 10_000.0,
                    )
                })
                .filter(|(_, _, delta)| *delta >= 1.0)
                .collect();
            deltas.sort_by(|left, right| right.2.total_cmp(&left.2));
            let top = deltas
                .iter()
                .take(5)
                .map(|(pid, name, delta)| format!("{name}:{pid}:{delta:.0}ms"))
                .collect::<Vec<_>>()
                .join(",");
            self.evidence.log(format!(
                "cpu tag={tag} from={prev_tag} elapsed_ms={elapsed_ms} delta_ms={delta_ms:.0} single_core_percent={:.1} working_set_mb={:.1} processes={} webview_processes={} top=[{top}]",
                delta_ms * 100.0 / elapsed_ms as f64,
                now.working_set as f64 / (1024.0 * 1024.0),
                now.processes,
                now.webview_processes
            ));
        }

        fn retry(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
            self.evidence.log("retry_requested");
            let alive = unsafe { IsWindow(self.hwnd()) } != 0;
            if !self.recovery.terminal && alive {
                self.evidence.log("retry_ignored healthy");
                return;
            }
            self.recovery.attempts.clear();
            self.recovery.terminal = false;
            self.recover(target);
            self.evidence.marker("retry");
        }

        fn recover(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
            if self.recovery.terminal {
                return;
            }
            if !self.recovery.begin() {
                self.evidence
                    .log("recovery_terminal attempts>=3 window=120s");
                return;
            }
            let attempt = self.recovery.attempts.len();
            self.evidence
                .log(format!("recovery_begin attempt={attempt}"));
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut progman = find_progman();
            while progman.is_null() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(200));
                progman = find_progman();
            }
            if progman.is_null() {
                self.evidence.log("recovery_fail reason=progman");
                return;
            }
            let mut workerw = find_wallpaper_workerw(progman);
            if workerw.is_null() {
                request_workerw(progman);
                let worker_deadline = Instant::now() + Duration::from_secs(2);
                while workerw.is_null() && Instant::now() < worker_deadline {
                    std::thread::sleep(Duration::from_millis(200));
                    workerw = find_wallpaper_workerw(progman);
                }
            }
            if workerw.is_null() {
                self.evidence.log("recovery_fail reason=workerw");
                return;
            }
            let old_hwnd = self.hwnd();
            let old_workerw = self.workerw;
            let new_window = match WindowBuilder::new()
                .with_title("Hertz DESK-W0 wallpaper probe")
                .with_inner_size(PhysicalSize::new(
                    self.screen_w as u32,
                    self.screen_h as u32,
                ))
                .with_position(tao::dpi::PhysicalPosition::new(0, 0))
                .with_decorations(false)
                .with_resizable(false)
                .with_visible(false)
                .with_focused(false)
                .with_skip_taskbar(true)
                .with_undecorated_shadow(false)
                .build(target)
            {
                Ok(window) => window,
                Err(error) => {
                    self.evidence
                        .log(format!("recovery_fail reason=window error={error}"));
                    return;
                }
            };
            let hwnd = new_window.hwnd() as HWND;
            strip_styles(hwnd);
            install_wallpaper_style(hwnd);
            install_power_hook(hwnd, &self.evidence);
            let previous_parent = unsafe { SetParent(hwnd, workerw) };
            unsafe {
                SetWindowPos(
                    workerw,
                    HWND_BOTTOM,
                    0,
                    0,
                    self.screen_w,
                    self.screen_h,
                    SWP_NOACTIVATE,
                );
                SetWindowPos(
                    hwnd,
                    HWND_BOTTOM,
                    0,
                    0,
                    self.screen_w,
                    self.screen_h,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED,
                );
                ShowWindow(hwnd, SW_SHOW);
            }
            let clicks = self.clicks.clone();
            let evidence = self.evidence.clone();
            let new_view = match WebViewBuilder::new()
                .with_html(PAGE)
                .with_background_color((8, 16, 31, 255))
                .with_ipc_handler(move |request| {
                    let body = request.body();
                    if body == "click" {
                        clicks.fetch_add(1, Ordering::SeqCst);
                    } else {
                        evidence.log(format!("js {body}"));
                    }
                })
                .build(&new_window)
            {
                Ok(view) => view,
                Err(error) => {
                    self.evidence
                        .log(format!("recovery_fail reason=webview error={error}"));
                    return;
                }
            };
            let old_window = std::mem::replace(&mut self.window, new_window);
            let old_view = std::mem::replace(&mut self.view, new_view);
            std::mem::forget(old_window);
            std::mem::forget(old_view);
            self.workerw = workerw;
            if self.policy_hidden {
                let result = unsafe { self.view.controller().SetIsVisible(false) };
                self.eval("recover-policy-stop", "window.stopMotion()");
                self.evidence
                    .log(format!("recovery_policy hidden=true controller={result:?}"));
            } else {
                let result = unsafe { self.view.controller().SetIsVisible(true) };
                self.eval(
                    "recover-motion",
                    &format!("window.startMotion({})", self.current_fps),
                );
                self.evidence.log(format!(
                    "recovery_policy hidden=false controller={result:?}"
                ));
            }
            self.evidence.log(format!(
                "recovery_success attempt={attempt} old_hwnd={} old_workerw={} new_hwnd={} new_workerw={} previous_parent={} progman_children={}",
                fmt_hwnd(old_hwnd),
                fmt_hwnd(old_workerw),
                fmt_hwnd(hwnd),
                fmt_hwnd(workerw),
                fmt_hwnd(previous_parent),
                progman_children(progman)
            ));
        }

        fn tick(&mut self, n: u8) -> bool {
            if self.restart_test && n == 2 {
                self.stopping = true;
                self.state("done");
                self.eval("final", "window.stopMotion()");
                self.evidence.marker("done");
                return true;
            }
            match n {
                0 => {
                    self.state("mounted");
                    self.evidence.log(format!(
                        "mount workerw={} workerw_rect={} screen={}x{} dpi={} parent_chain={}",
                        fmt_hwnd(self.workerw),
                        rect_string(self.workerw),
                        unsafe { GetSystemMetrics(0) },
                        unsafe { GetSystemMetrics(1) },
                        unsafe { GetDpiForWindow(self.hwnd()) },
                        parent_chain(self.hwnd())
                    ));
                    self.eval("motion30", "window.startMotion(30)");
                    if !self.restart_test {
                        self.start_cpu("startup");
                    }
                    self.evidence.marker("mounted");
                }
                1 => {
                    if !self.restart_test {
                        self.finish_cpu("startup");
                        self.start_cpu("fps30");
                    }
                    self.state("running");
                    self.probe_input("desktop-point");
                    self.evidence.marker("input-tested");
                }
                2 => {
                    self.finish_cpu("fps30");
                    self.start_cpu("manual-paused");
                    self.state("before-policy-pause");
                    self.eval("watch-visibility", "window.watchVisibility()");
                    self.set_reason(REASON_MANUAL, true, "manual-pause");
                    self.evidence.marker("policy-paused");
                }
                3 => {
                    self.finish_cpu("manual-paused");
                    self.start_cpu("fps30-resume");
                    self.state("policy-paused");
                    self.set_reason(REASON_MANUAL, false, "manual-resume");
                    self.eval("stop-watch", "window.stopWatch()");
                    self.eval("seek-song", "window.seekSong(60000)");
                    self.evidence.marker("policy-resumed");
                }
                4 => {
                    self.finish_cpu("fps30-resume");
                    self.start_cpu("fps15");
                    self.state("running-15");
                    self.current_fps = 15;
                    self.eval("motion15", "window.startMotion(15)");
                    self.evidence.marker("motion15");
                }
                5 => {
                    self.finish_cpu("fps15");
                    self.start_cpu("fps60");
                    self.state("running-60");
                    self.current_fps = 60;
                    self.eval("motion60", "window.startMotion(60)");
                    self.evidence.marker("motion60");
                }
                6 => {
                    self.finish_cpu("fps60");
                    self.stopping = true;
                    self.state("done");
                    self.eval("final", "window.stopMotion()");
                    self.evidence.marker("done");
                }
                _ => {}
            }
            n == 6
        }
    }

    pub fn run() -> Result<(), Box<dyn Error>> {
        let mut out = PathBuf::from("wallpaper-probe-out");
        let mut source = String::from("unknown");
        let mut restart_test = false;
        let mut duration_ms = 40_000u64;
        let mut power_selftest = false;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--out" => out = PathBuf::from(args.next().ok_or("--out needs a path")?),
                "--source" => source = args.next().ok_or("--source needs a revision")?,
                "--restart-test" => restart_test = true,
                "--power-selftest" => power_selftest = true,
                "--duration-ms" => {
                    duration_ms = args.next().ok_or("--duration-ms needs a value")?.parse()?;
                }
                other => return Err(format!("unknown argument: {other}").into()),
            }
        }
        let evidence = Evidence::new(out.clone())?;
        let mutex = acquire_single_instance(&evidence);
        let _mutex = match mutex {
            Some(handle) => handle,
            None => std::process::exit(3),
        };
        evidence.log(format!(
            "probe=desk-w0 source={source} pid={} restart_test={restart_test} duration_ms={duration_ms} power_selftest={power_selftest} webview2_user_data={}",
            std::process::id(),
            out.join("webview2").display()
        ));
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", out.join("webview2"));

        let progman = find_progman();
        evidence.log(format!(
            "progman={} class={}",
            fmt_hwnd(progman),
            class_name(progman)
        ));
        if progman.is_null() {
            return Err("Progman not found".into());
        }
        let mut workerw = find_wallpaper_workerw(progman);
        if workerw.is_null() {
            request_workerw(progman);
            std::thread::sleep(Duration::from_millis(500));
            workerw = find_wallpaper_workerw(progman);
        }
        evidence.log(format!(
            "wallpaper_workerw={} rect={} child_workerw_list={}",
            fmt_hwnd(workerw),
            rect_string(workerw),
            workerw_candidates(progman)
        ));
        if workerw.is_null() {
            return Err("WorkerW not found".into());
        }

        let mut event_loop_builder = EventLoopBuilder::<UserEvent>::with_user_event();
        let event_loop = event_loop_builder.build();
        let proxy = event_loop.create_proxy();
        let _ = EVENT_PROXY.set(proxy.clone());
        let tray_proxy = proxy.clone();
        TrayIconEvent::set_event_handler(Some(move |event| {
            let _ = tray_proxy.send_event(UserEvent::Tray(event));
        }));
        let menu_proxy = proxy.clone();
        MenuEvent::set_event_handler(Some(move |event| {
            let _ = menu_proxy.send_event(UserEvent::Menu(event));
        }));

        let screen_w = unsafe { GetSystemMetrics(0) };
        let screen_h = unsafe { GetSystemMetrics(1) };
        let window = WindowBuilder::new()
            .with_title("Hertz DESK-W0 wallpaper probe")
            .with_inner_size(PhysicalSize::new(screen_w as u32, screen_h as u32))
            .with_position(tao::dpi::PhysicalPosition::new(0, 0))
            .with_decorations(false)
            .with_resizable(false)
            .with_visible(false)
            .with_focused(false)
            .with_skip_taskbar(true)
            .with_undecorated_shadow(false)
            .build(&event_loop)?;
        let hwnd = window.hwnd() as HWND;
        strip_styles(hwnd);
        install_wallpaper_style(hwnd);
        install_power_hook(hwnd, &evidence);
        let previous_parent = unsafe { SetParent(hwnd, workerw) };
        evidence.log(format!(
            "progman_children_before={}",
            progman_children(progman)
        ));
        unsafe {
            SetWindowPos(
                workerw,
                HWND_BOTTOM,
                0,
                0,
                screen_w,
                screen_h,
                SWP_NOACTIVATE,
            );
            SetWindowPos(
                hwnd,
                HWND_BOTTOM,
                0,
                0,
                screen_w,
                screen_h,
                SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED,
            );
            ShowWindow(hwnd, SW_SHOW);
        }
        evidence.log(format!(
            "progman_children_after={}",
            progman_children(progman)
        ));
        evidence.log(format!(
            "attach hwnd={} workerw={} previous_parent={} parent_now={} styles after={:#x} rect={}",
            fmt_hwnd(hwnd),
            fmt_hwnd(workerw),
            fmt_hwnd(previous_parent),
            fmt_hwnd(unsafe { GetParent(hwnd) }),
            window_style(hwnd),
            rect_string(hwnd)
        ));

        let clicks = Arc::new(AtomicUsize::new(0));
        let clicks_view = clicks.clone();
        let evidence_view = evidence.clone();
        let view = WebViewBuilder::new()
            .with_html(PAGE)
            .with_background_color((8, 16, 31, 255))
            .with_ipc_handler(move |request| {
                let body = request.body();
                if body == "click" {
                    clicks_view.fetch_add(1, Ordering::SeqCst);
                } else {
                    evidence_view.log(format!("js {body}"));
                }
            })
            .build(&window)?;

        if power_selftest {
            let hwnd_selftest = hwnd as usize;
            let evidence_selftest = evidence.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                evidence_selftest.log("selftest_post_suspend");
                unsafe {
                    PostMessageW(
                        hwnd_selftest as HWND,
                        WM_POWERBROADCAST,
                        PBT_APMSUSPEND as usize,
                        0,
                    )
                };
                std::thread::sleep(Duration::from_secs(2));
                evidence_selftest.log("selftest_post_resume");
                unsafe {
                    PostMessageW(
                        hwnd_selftest as HWND,
                        WM_POWERBROADCAST,
                        PBT_APMRESUMEAUTOMATIC as usize,
                        0,
                    )
                };
            });
        }

        let menu = Menu::new();
        let retry_item = MenuItem::new("Retry / 重新挂载", true, None);
        let quit_item = MenuItem::new("Quit / 退出 W0 探针", true, None);
        menu.append(&retry_item)?;
        menu.append(&quit_item)?;
        let retry_id = retry_item.id().0.clone();
        let quit_id = quit_item.id().0.clone();
        let tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_menu_on_left_click(false)
            .with_tooltip("Hertz DESK-W0 probe")
            .with_icon(probe_icon()?)
            .build()?;

        let mut probe = Probe {
            window,
            view,
            evidence,
            workerw,
            clicks,
            tray,
            quit_id,
            retry_id,
            screen_w,
            screen_h,
            current_fps: 30,
            stopping: false,
            recovery: Recovery::new(),
            policy_reasons: 0,
            policy_hidden: false,
            fullscreen_state: None,
            restart_test,
            cpu_mark: None,
        };

        let _ticker = {
            let proxy = proxy.clone();
            let schedule: Vec<u64> = if restart_test {
                vec![0, 3_000, duration_ms]
            } else {
                vec![0, 3_000, 15_000, 25_000, 30_000, 35_000, 40_000]
            };
            std::thread::spawn(move || {
                let start = Instant::now();
                for (index, at_ms) in schedule.into_iter().enumerate() {
                    std::thread::sleep(
                        Duration::from_millis(at_ms).saturating_sub(start.elapsed()),
                    );
                    if proxy.send_event(UserEvent::Tick(index as u8)).is_err() {
                        break;
                    }
                }
            })
        };

        let _watcher = {
            let proxy = proxy.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(500));
                if proxy.send_event(UserEvent::Check).is_err() {
                    break;
                }
            })
        };

        event_loop.run(move |event, event_loop_target, control_flow| {
            *control_flow = ControlFlow::Wait;
            match event {
                Event::UserEvent(UserEvent::Tick(n)) => {
                    if probe.tick(n) {
                        *control_flow = ControlFlow::Exit;
                    }
                }
                Event::UserEvent(UserEvent::Check) => {
                    probe.check_health(event_loop_target);
                    if !probe.recovery.terminal {
                        probe.check_fullscreen();
                    }
                }
                Event::UserEvent(UserEvent::EnvChange { reason, on }) => {
                    let tag = match reason {
                        REASON_DISPLAY_OFF => "display-off",
                        REASON_SLEEP => "sleep",
                        _ => "environment",
                    };
                    probe.set_reason(reason, on, tag);
                }
                Event::UserEvent(UserEvent::Tray(event)) => {
                    probe.evidence.log(format!("tray_event={event:?}"));
                }
                Event::UserEvent(UserEvent::Menu(event)) => {
                    let id = event.id.0.clone();
                    probe.evidence.log(format!("menu_event={id}"));
                    if id == probe.retry_id {
                        probe.retry(event_loop_target);
                    } else if id == probe.quit_id {
                        probe.stopping = true;
                        *control_flow = ControlFlow::Exit;
                    }
                }
                Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    ..
                } => {
                    probe.stopping = true;
                    *control_flow = ControlFlow::Exit;
                }
                _ => {}
            }
        })
    }

    fn acquire_single_instance(
        evidence: &Evidence,
    ) -> Option<windows_sys::Win32::Foundation::HANDLE> {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
        use windows_sys::Win32::System::Threading::CreateMutexW;
        let name: Vec<u16> = "Local\\Hertz.DesktopWallpaperProbe.Singleton\0"
            .encode_utf16()
            .collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            evidence.log("single_instance=error");
            return None;
        }
        let conflict = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        evidence.log(format!(
            "single_instance={}",
            if conflict { "conflict" } else { "acquired" }
        ));
        if conflict {
            unsafe { CloseHandle(handle) };
            None
        } else {
            Some(handle)
        }
    }

    fn find_progman() -> HWND {
        let mut found: HWND = std::ptr::null_mut();
        unsafe {
            EnumWindows(Some(enum_progman), &mut found as *mut HWND as LPARAM);
        }
        found
    }

    unsafe extern "system" fn enum_progman(hwnd: HWND, lparam: LPARAM) -> i32 {
        if class_name(hwnd) == "Progman" {
            *(lparam as *mut HWND) = hwnd;
            return 0;
        }
        1
    }

    fn request_workerw(progman: HWND) {
        let mut result = 0usize;
        unsafe {
            SendMessageTimeoutW(progman, 0x052C, 0, 0, SMTO_NORMAL, 1000, &mut result);
        }
    }

    fn find_wallpaper_workerw(progman: HWND) -> HWND {
        let class = wide("WorkerW");
        let defview = wide("SHELLDLL_DefView");
        let mut candidate: HWND = std::ptr::null_mut();
        let mut after: HWND = std::ptr::null_mut();
        loop {
            let child = unsafe { FindWindowExW(progman, after, class.as_ptr(), std::ptr::null()) };
            if child.is_null() {
                break;
            }
            let has_defview = unsafe {
                !FindWindowExW(
                    child,
                    std::ptr::null_mut(),
                    defview.as_ptr(),
                    std::ptr::null(),
                )
                .is_null()
            };
            if !has_defview {
                candidate = child;
            }
            after = child;
        }
        candidate
    }

    fn progman_children(progman: HWND) -> String {
        let mut names = Vec::new();
        let mut current = unsafe { GetWindow(progman, GW_CHILD) };
        let mut index = 0;
        while !current.is_null() && index < 16 {
            names.push(format!(
                "[{index}]{}:{}",
                fmt_hwnd(current),
                class_name(current)
            ));
            current = unsafe { GetWindow(current, GW_HWNDNEXT) };
            index += 1;
        }
        names.join(",")
    }

    fn workerw_candidates(progman: HWND) -> String {
        let class = wide("WorkerW");
        let defview = wide("SHELLDLL_DefView");
        let mut names = Vec::new();
        let mut after: HWND = std::ptr::null_mut();
        loop {
            let child = unsafe { FindWindowExW(progman, after, class.as_ptr(), std::ptr::null()) };
            if child.is_null() {
                break;
            }
            let has_defview = unsafe {
                !FindWindowExW(
                    child,
                    std::ptr::null_mut(),
                    defview.as_ptr(),
                    std::ptr::null(),
                )
                .is_null()
            };
            names.push(format!(
                "{}:visible={}:defview={}",
                fmt_hwnd(child),
                unsafe { IsWindowVisible(child) },
                has_defview
            ));
            after = child;
        }
        names.join(",")
    }

    fn install_wallpaper_style(hwnd: HWND) {
        let style = window_style(hwnd);
        let next = (style
            & !(WS_POPUP
                | WS_CAPTION
                | WS_THICKFRAME
                | WS_SYSMENU
                | WS_MINIMIZEBOX
                | WS_MAXIMIZEBOX))
            | WS_CHILD;
        unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, next as isize) };
        let ex = ex_style(hwnd);
        let next_ex = (ex | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) & !WS_EX_APPWINDOW;
        unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next_ex as isize) };
    }

    fn strip_styles(hwnd: HWND) {
        let style = window_style(hwnd);
        let next =
            style & !(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
        unsafe {
            SetWindowLongPtrW(hwnd, GWL_STYLE, next as isize);
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            RedrawWindow(
                hwnd,
                std::ptr::null(),
                std::ptr::null_mut(),
                RDW_INVALIDATE | RDW_FRAME | RDW_UPDATENOW | RDW_ALLCHILDREN,
            );
        }
    }

    fn window_style(hwnd: HWND) -> u32 {
        unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 }
    }

    fn ex_style(hwnd: HWND) -> u32 {
        unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 }
    }

    fn parent_chain(hwnd: HWND) -> String {
        let mut names = Vec::new();
        let mut current = hwnd;
        for _ in 0..6 {
            if current.is_null() {
                break;
            }
            names.push(format!("{}:{}", fmt_hwnd(current), class_name(current)));
            current = unsafe { GetParent(current) };
        }
        names.join(">")
    }

    fn class_name(hwnd: HWND) -> String {
        if hwnd.is_null() {
            return "null".into();
        }
        let mut buffer = [0u16; 256];
        let len = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if len <= 0 {
            return "?".into();
        }
        String::from_utf16_lossy(&buffer[..len as usize])
    }

    fn fmt_hwnd(hwnd: HWND) -> String {
        format!("{hwnd:p}")
    }

    fn rect_string(hwnd: HWND) -> String {
        let mut rect = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut rect) };
        format!("{},{},{},{}", rect.left, rect.top, rect.right, rect.bottom)
    }

    fn sample_process_tree() -> TreeSample {
        let processes = process_snapshot();
        let root = unsafe { GetCurrentProcessId() };
        let pids = descendants(&processes, root);
        let mut cpu_100ns = 0u64;
        let mut working_set = 0u64;
        let mut webview_processes = 0usize;
        let mut per_process = Vec::new();
        for (pid, _, name) in &processes {
            if !pids.contains(pid) {
                continue;
            }
            if name.eq_ignore_ascii_case("msedgewebview2.exe") {
                webview_processes += 1;
            }
            unsafe {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, *pid);
                if handle.is_null() {
                    continue;
                }
                let mut creation = FILETIME::default();
                let mut exit = FILETIME::default();
                let mut kernel = FILETIME::default();
                let mut user = FILETIME::default();
                if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0 {
                    let cpu = filetime_to_u64(kernel) + filetime_to_u64(user);
                    cpu_100ns += cpu;
                    per_process.push((*pid, name.clone(), cpu));
                }
                let mut counters = PROCESS_MEMORY_COUNTERS {
                    cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                    ..Default::default()
                };
                if GetProcessMemoryInfo(handle, &mut counters, counters.cb) != 0 {
                    working_set += counters.WorkingSetSize as u64;
                }
                CloseHandle(handle);
            }
        }
        TreeSample {
            cpu_100ns,
            working_set,
            processes: pids.len(),
            webview_processes,
            pids,
            per_process,
        }
    }

    fn process_snapshot() -> Vec<(u32, u32, String)> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Vec::new();
        }
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut processes = Vec::new();
        unsafe {
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    let end = entry
                        .szExeFile
                        .iter()
                        .position(|value| *value == 0)
                        .unwrap_or(entry.szExeFile.len());
                    processes.push((
                        entry.th32ProcessID,
                        entry.th32ParentProcessID,
                        String::from_utf16_lossy(&entry.szExeFile[..end]),
                    ));
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
        }
        processes
    }

    fn descendants(processes: &[(u32, u32, String)], root: u32) -> Vec<u32> {
        let mut pids = vec![root];
        let mut index = 0;
        while index < pids.len() {
            let parent = pids[index];
            index += 1;
            for (pid, parent_pid, _) in processes {
                if *parent_pid == parent && !pids.contains(pid) {
                    pids.push(*pid);
                }
            }
        }
        pids
    }

    fn filetime_to_u64(time: FILETIME) -> u64 {
        ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64
    }

    fn install_power_hook(hwnd: HWND, evidence: &Evidence) {
        let original = unsafe { GetWindowLongPtrW(hwnd, GWLP_WNDPROC) };
        ORIGINAL_WNDPROC.store(original, Ordering::SeqCst);
        unsafe {
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, hook_wndproc as *const () as isize);
            let monitor = RegisterPowerSettingNotification(
                hwnd as _,
                &GUID_MONITOR_POWER_ON,
                DEVICE_NOTIFY_WINDOW_HANDLE,
            );
            let suspend = RegisterSuspendResumeNotification(hwnd as _, DEVICE_NOTIFY_WINDOW_HANDLE);
            evidence.log(format!(
                "register_power monitor_handle={monitor} suspend_resume_handle={suspend}"
            ));
        }
    }

    fn send_env_change(reason: u8, on: bool) {
        if let Some(proxy) = EVENT_PROXY.get() {
            let _ = proxy.send_event(UserEvent::EnvChange { reason, on });
        }
    }

    unsafe extern "system" fn hook_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        if msg == WM_POWERBROADCAST {
            match wparam as u32 {
                PBT_APMSUSPEND => send_env_change(REASON_SLEEP, true),
                PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => {
                    send_env_change(REASON_SLEEP, false)
                }
                PBT_POWERSETTINGCHANGE => {
                    let setting = &*(lparam as *const POWERBROADCAST_SETTING);
                    let expected = &GUID_MONITOR_POWER_ON;
                    let actual = &setting.PowerSetting;
                    if actual.data1 == expected.data1
                        && actual.data2 == expected.data2
                        && actual.data3 == expected.data3
                        && actual.data4 == expected.data4
                    {
                        let value = *(setting.Data.as_ptr() as *const u32);
                        send_env_change(REASON_DISPLAY_OFF, value == 0);
                    }
                }
                _ => {}
            }
        }
        let original = ORIGINAL_WNDPROC.load(Ordering::SeqCst);
        if original == 0 {
            return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
        }
        let procedure: WNDPROC = unsafe { std::mem::transmute(original) };
        unsafe { CallWindowProcW(procedure, hwnd, msg, wparam, lparam) }
    }

    fn query_notification_state() -> QUERY_USER_NOTIFICATION_STATE {
        let mut state: QUERY_USER_NOTIFICATION_STATE = -1;
        let result = unsafe { SHQueryUserNotificationState(&mut state) };
        if result < 0 {
            -1
        } else {
            state
        }
    }

    fn is_fullscreen_state(state: QUERY_USER_NOTIFICATION_STATE) -> bool {
        matches!(
            state,
            QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE
        )
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn send_click(x: i32, y: i32) -> u32 {
        let screen_x = unsafe { GetSystemMetrics(0) }.max(1) as i64;
        let screen_y = unsafe { GetSystemMetrics(1) }.max(1) as i64;
        let nx = (x as i64 * 65_535 / (screen_x - 1).max(1)) as i32;
        let ny = (y as i64 * 65_535 / (screen_y - 1).max(1)) as i32;
        let mut inputs = [INPUT::default(); 3];
        inputs[0].r#type = INPUT_MOUSE;
        inputs[0].Anonymous.mi = MOUSEINPUT {
            dx: nx,
            dy: ny,
            mouseData: 0,
            dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
            time: 0,
            dwExtraInfo: 0,
        };
        inputs[1].r#type = INPUT_MOUSE;
        inputs[1].Anonymous.mi = MOUSEINPUT {
            dx: 0,
            dy: 0,
            mouseData: 0,
            dwFlags: MOUSEEVENTF_LEFTDOWN,
            time: 0,
            dwExtraInfo: 0,
        };
        inputs[2].r#type = INPUT_MOUSE;
        inputs[2].Anonymous.mi = MOUSEINPUT {
            dx: 0,
            dy: 0,
            mouseData: 0,
            dwFlags: MOUSEEVENTF_LEFTUP,
            time: 0,
            dwExtraInfo: 0,
        };
        unsafe { SendInput(3, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) }
    }

    fn probe_icon() -> Result<Icon, Box<dyn Error>> {
        const SIZE: u32 = 32;
        let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
        for y in 0..SIZE {
            for x in 0..SIZE {
                let index = ((y * SIZE + x) * 4) as usize;
                let dx = x as i32 - 16;
                let dy = y as i32 - 16;
                let in_disc = dx * dx + dy * dy <= 15 * 15;
                let color = if in_disc {
                    [40, 120, 220, 255]
                } else {
                    [0, 0, 0, 0]
                };
                rgba[index..index + 4].copy_from_slice(&color);
            }
        }
        Ok(Icon::from_rgba(rgba, SIZE, SIZE)?)
    }
}
