// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! DESK-L0 原生探针：透明 WebView2 歌词窗口、非激活置顶、整窗穿透与托盘恢复。
//! 这是隔离实验入口，不是生产宿主；证据写入 `--out` 指定目录。

#[cfg(not(windows))]
fn main() {
    eprintln!("desktop-probe only runs on Windows");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    if let Err(error) = probe::run() {
        eprintln!("desktop-probe failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
mod probe {
    use std::error::Error;
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU8, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use tao::dpi::{LogicalPosition, LogicalSize};
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
    use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
    use tao::window::{Window, WindowBuilder};
    use tray_icon::menu::{Menu, MenuEvent, MenuItem};
    use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, FILETIME, HANDLE, HWND,
        INVALID_HANDLE_VALUE, LPARAM, POINT, RECT,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        RedrawWindow, RDW_ALLCHILDREN, RDW_FRAME, RDW_INVALIDATE, RDW_UPDATENOW,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        CreateMutexW, GetCurrentProcessId, GetProcessTimes, OpenProcess,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        EnableWindow, IsWindowEnabled, SendInput, INPUT, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE,
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEINPUT,
    };
    use windows_sys::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUERY_USER_NOTIFICATION_STATE, QUNS_BUSY,
        QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, EnumChildWindows, GetAncestor, GetClassNameW,
        GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowLongPtrW, GetWindowRect,
        GetWindowThreadProcessId, IsWindowVisible, SetCursorPos, SetForegroundWindow,
        SetLayeredWindowAttributes, SetWindowLongPtrW, SetWindowPos, ShowWindow, WindowFromPoint,
        GA_ROOT, GWLP_WNDPROC, GWL_EXSTYLE, GWL_STYLE, HTTRANSPARENT, HWND_TOPMOST, LWA_ALPHA,
        SM_CMONITORS, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        SW_HIDE, SW_SHOW, SW_SHOWNOACTIVATE, WM_NCHITTEST, WNDPROC, WS_CAPTION, WS_EX_APPWINDOW,
        WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
        WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_SYSMENU, WS_THICKFRAME,
    };
    use wry::WebViewBuilder;

    static ORIGINAL_WNDPROC: AtomicIsize = AtomicIsize::new(0);
    static CLICK_THROUGH: AtomicBool = AtomicBool::new(false);
    static LOCK_MODE: AtomicU8 = AtomicU8::new(2);

    const BACKDROP_HTML: &str = r#"<!doctype html>
<html><body style="margin:0;overflow:hidden;font-family:'Segoe UI',sans-serif">
<div id="bg" style="position:fixed;inset:0;background:repeating-conic-gradient(#f7f7f7 0% 25%, #c9d1d9 0% 50%) 0 0/56px 56px"></div>
<div id="title" style="position:absolute;left:28px;top:26px;font-size:42px;font-weight:700;color:#0b4f9c">BACKDROP · 背景对照</div>
<div id="hint" style="position:absolute;left:28px;bottom:22px;font-size:20px;color:#22313f">透明区域应能看到棋盘格；文字像素不应带整块底色</div>
<script>
document.addEventListener('mousedown', function () { if (window.ipc) window.ipc.postMessage('click'); });
window.setDark = function (dark) {
  document.getElementById('bg').style.background = dark
    ? 'radial-gradient(circle at 30% 25%, #1d3557, #05070d 72%)'
    : 'repeating-conic-gradient(#f7f7f7 0% 25%, #c9d1d9 0% 50%) 0 0/56px 56px';
  document.getElementById('title').style.color = dark ? '#8fd6ff' : '#0b4f9c';
  document.getElementById('hint').style.color = dark ? '#d7e3f4' : '#22313f';
};
</script></body></html>"#;

    const OVERLAY_HTML: &str = r#"<!doctype html>
<html><body style="margin:0;background:transparent;overflow:hidden">
<div style="padding:18px 26px">
  <div id="line" style="font-family:'Segoe UI',sans-serif;font-size:44px;font-weight:600;letter-spacing:.5px;color:#0b1220;text-shadow:0 2px 10px rgba(255,255,255,.9)">夜航星 · 穿过无声的云层</div>
  <div id="sub" style="margin-top:8px;font-family:'Segoe UI',sans-serif;font-size:18px;color:#243447;text-shadow:0 1px 6px rgba(255,255,255,.9)">Hertz DESK-L0 透明歌词探针 / click-through probe</div>
</div>
<script>
document.addEventListener('mousedown', function () { if (window.ipc) window.ipc.postMessage('click'); });
window.setInk = function (dark) {
  document.getElementById('line').style.color = dark ? 'rgba(255,255,255,.97)' : '#0b1220';
  document.getElementById('line').style.textShadow = dark
    ? '0 3px 14px rgba(0,0,0,.72)' : '0 2px 10px rgba(255,255,255,.9)';
  document.getElementById('sub').style.color = dark ? 'rgba(255,255,255,.85)' : '#243447';
  document.getElementById('sub').style.textShadow = dark
    ? '0 2px 9px rgba(0,0,0,.72)' : '0 1px 6px rgba(255,255,255,.9)';
};
let motion = { raf: 0, frames: 0, updates: 0, started: 0, cap: 0, lastPaint: 0, lastReport: 0, paintMs: 0, maxPaintMs: 0 };
window.startMotion = function (fps) {
  if (motion.raf) cancelAnimationFrame(motion.raf);
  motion = { raf: 0, frames: 0, updates: 0, started: performance.now(), cap: fps, lastPaint: 0, lastReport: 0, paintMs: 0, maxPaintMs: 0 };
  const line = document.getElementById('line');
  function loop(now) {
    motion.raf = requestAnimationFrame(loop);
    motion.frames++;
    if (!motion.cap || now - motion.lastPaint >= (1000 / motion.cap) - 0.5) {
      motion.lastPaint = now;
      const paintStart = performance.now();
      motion.updates++;
      line.textContent = '夜航星 · 穿过无声的云层 · ' + motion.updates + ' · Hertz DESK-L0';
      const paintMs = performance.now() - paintStart;
      motion.paintMs += paintMs;
      if (paintMs > motion.maxPaintMs) motion.maxPaintMs = paintMs;
    }
    if (now - motion.lastReport >= 1000) {
      motion.lastReport = now;
      if (window.ipc) window.ipc.postMessage(JSON.stringify({
        kind: 'motion', cap: motion.cap, frames: motion.frames, updates: motion.updates,
        ms: Math.max(0, Math.round(now - motion.started)),
        paintAvgMs: +(motion.paintMs / Math.max(1, motion.updates)).toFixed(3),
        paintMaxMs: +motion.maxPaintMs.toFixed(3),
        dpr: devicePixelRatio, size: [innerWidth, innerHeight]
      }));
    }
  }
  motion.raf = requestAnimationFrame(loop);
};
window.stopMotion = function () {
  if (motion.raf) cancelAnimationFrame(motion.raf);
  motion.raf = 0;
  if (window.ipc) window.ipc.postMessage(JSON.stringify({
    kind: 'stopped', cap: motion.cap, frames: motion.frames, updates: motion.updates,
    ms: Math.max(0, Math.round(performance.now() - motion.started))
  }));
};
window.restoreText = function () {
  document.getElementById('line').textContent = '夜航星 · 穿过无声的云层';
};
</script></body></html>"#;

    enum UserEvent {
        Tick(u8),
        Tray(TrayIconEvent),
        Menu(MenuEvent),
        ClickChecked {
            tag: ClickTag,
            backdrop_before: usize,
            overlay_before: usize,
            inserted: u32,
        },
    }

    #[derive(Clone, Copy, Debug)]
    enum ClickTag {
        Locked,
        Unlocked,
        BackdropVisible,
    }

    const REASON_USER_HIDDEN: u8 = 1 << 0;
    const REASON_FULLSCREEN: u8 = 1 << 1;
    const REASON_LOCK_SIMULATED: u8 = 1 << 2;

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
            let path = self.dir.join("probe.log");
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(file, "{line}");
            }
        }

        fn marker(&self, name: &str) {
            let _ = fs::write(self.dir.join(format!("{name}.ready")), b"");
        }
    }

    #[derive(Clone)]
    struct TreeSample {
        cpu_100ns: u64,
        working_set: u64,
        processes: usize,
        webview_processes: usize,
        pids: Vec<u32>,
        per_process: Vec<(u32, String, u64)>,
    }

    struct Probe {
        backdrop: Window,
        overlay: Window,
        backdrop_view: wry::WebView,
        overlay_view: wry::WebView,
        #[allow(dead_code)]
        tray: TrayIcon,
        evidence: Evidence,
        restore_id: String,
        quit_id: String,
        no_activate_pass: Option<bool>,
        locked_hit_pass: Option<bool>,
        locked_click_pass: Option<bool>,
        unlocked_click_blocked: Option<bool>,
        backdrop_click_pass: Option<bool>,
        backdrop_clicks: Arc<AtomicUsize>,
        overlay_clicks: Arc<AtomicUsize>,
        proxy: EventLoopProxy<UserEvent>,
        env_reasons: u8,
        policy_pass: Option<bool>,
        focus_after_restore_pass: Option<bool>,
        fullscreen_state: Option<QUERY_USER_NOTIFICATION_STATE>,
        cpu_mark: Option<(String, Instant, TreeSample)>,
        tray_wait_ms: u64,
        tray_events: usize,
        tray_click_pass: Option<bool>,
    }

    impl Probe {
        fn backdrop_hwnd(&self) -> HWND {
            self.backdrop.hwnd() as HWND
        }

        fn overlay_hwnd(&self) -> HWND {
            self.overlay.hwnd() as HWND
        }

        fn set_locked(&self, locked: bool) {
            let hwnd = self.overlay_hwnd();
            let mode = LOCK_MODE.load(Ordering::SeqCst);
            let old = ex_style(hwnd);
            let mut next = if locked {
                old | WS_EX_TRANSPARENT
            } else {
                old & !WS_EX_TRANSPARENT
            };
            if mode == 2 && locked {
                next |= WS_EX_LAYERED;
            }
            if mode == 2 && !locked {
                next &= !WS_EX_LAYERED;
            }
            unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize) };
            CLICK_THROUGH.store(locked, Ordering::SeqCst);
            let was_enabled =
                unsafe { EnableWindow(hwnd, if mode == 1 && locked { 0 } else { 1 }) };
            if mode == 2 && locked {
                unsafe {
                    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);
                    SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
                    SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                    );
                }
            }
            let children = set_descendants_transparent(hwnd, locked);
            self.evidence.log(format!(
                "click_through locked={locked} mode={mode} layered={} top_applied=true enable_window_was_enabled={was_enabled} disabled_now={} children={children}",
                ex_style(hwnd) & WS_EX_LAYERED != 0,
                unsafe { IsWindowEnabled(hwnd) } == 0
            ));
        }

        fn synthetic_click(&self, hwnd: HWND, tag: ClickTag) {
            let mut rect = RECT::default();
            unsafe { GetWindowRect(hwnd, &mut rect) };
            let center = POINT {
                x: (rect.left + rect.right) / 2,
                y: (rect.top + rect.bottom) / 2,
            };
            let mut saved = POINT::default();
            unsafe { GetCursorPos(&mut saved) };
            let backdrop_before = self.backdrop_clicks.load(Ordering::SeqCst);
            let overlay_before = self.overlay_clicks.load(Ordering::SeqCst);
            let proxy = self.proxy.clone();
            std::thread::spawn(move || {
                unsafe {
                    SetCursorPos(center.x, center.y);
                    std::thread::sleep(Duration::from_millis(120));
                }
                let inserted = send_absolute_click(center.x, center.y);
                std::thread::sleep(Duration::from_millis(900));
                unsafe { SetCursorPos(saved.x, saved.y) };
                let _ = proxy.send_event(UserEvent::ClickChecked {
                    tag,
                    backdrop_before,
                    overlay_before,
                    inserted,
                });
            });
        }

        fn evaluate_click(
            &mut self,
            tag: ClickTag,
            backdrop_before: usize,
            overlay_before: usize,
            inserted: u32,
        ) {
            let backdrop_after = self.backdrop_clicks.load(Ordering::SeqCst);
            let overlay_after = self.overlay_clicks.load(Ordering::SeqCst);
            self.evidence.log(format!(
                "click_result tag={tag:?} send_input_inserted={inserted} backdrop_clicks={backdrop_before}->{backdrop_after} overlay_clicks={overlay_before}->{overlay_after} foreground={}",
                fmt_hwnd(foreground_root())
            ));
            match tag {
                ClickTag::Locked => {
                    self.locked_click_pass =
                        Some(backdrop_after > backdrop_before && overlay_after == overlay_before);
                }
                ClickTag::Unlocked => {
                    self.unlocked_click_blocked =
                        Some(overlay_after > overlay_before && backdrop_after == backdrop_before);
                }
                ClickTag::BackdropVisible => {
                    self.backdrop_click_pass =
                        Some(backdrop_after > backdrop_before && overlay_after == overlay_before);
                }
            }
        }

        fn show_overlay(&self) {
            unsafe {
                SetWindowPos(
                    self.overlay_hwnd(),
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                ShowWindow(self.overlay_hwnd(), SW_SHOWNOACTIVATE);
            }
        }

        fn hide_overlay(&self) {
            unsafe { ShowWindow(self.overlay_hwnd(), SW_HIDE) };
        }

        fn set_env_reason(&mut self, reason: u8, on: bool, tag: &str) -> bool {
            if on {
                self.env_reasons |= reason;
            } else {
                self.env_reasons &= !reason;
            }
            if self.env_reasons == 0 {
                self.show_overlay();
            } else {
                self.hide_overlay();
            }
            let visible = unsafe { IsWindowVisible(self.overlay_hwnd()) } != 0;
            self.evidence.log(format!(
                "policy tag={tag} reasons={:#04x} user_hidden={} fullscreen={} lock_simulated={} visible={visible}",
                self.env_reasons,
                self.env_reasons & REASON_USER_HIDDEN != 0,
                self.env_reasons & REASON_FULLSCREEN != 0,
                self.env_reasons & REASON_LOCK_SIMULATED != 0
            ));
            visible
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

        fn fullscreen_policy(&mut self) {
            self.restore("policy-reset");
            self.set_env_reason(REASON_USER_HIDDEN, true, "user-hide");
            let mut original = RECT::default();
            unsafe { GetWindowRect(self.backdrop_hwnd(), &mut original) };
            let previous_foreground = foreground_root();
            unsafe {
                SetWindowPos(
                    self.backdrop_hwnd(),
                    HWND_TOPMOST,
                    0,
                    0,
                    GetSystemMetrics(0),
                    GetSystemMetrics(1),
                    SWP_NOACTIVATE,
                );
                ShowWindow(self.backdrop_hwnd(), SW_SHOW);
                SetForegroundWindow(self.backdrop_hwnd());
            }
            std::thread::sleep(Duration::from_millis(700));
            let state = query_notification_state();
            self.fullscreen_state = Some(state);
            let detected = is_fullscreen_state(state);
            self.evidence.log(format!(
                "fullscreen_env state={state} detected={detected} foreground={}",
                fmt_hwnd(foreground_root())
            ));

            if detected {
                self.set_env_reason(REASON_FULLSCREEN, true, "fullscreen-detected");
                self.set_env_reason(REASON_USER_HIDDEN, false, "user-unhide-under-fullscreen");
                let hidden = unsafe { IsWindowVisible(self.overlay_hwnd()) } == 0;
                unsafe {
                    SetWindowPos(
                        self.backdrop_hwnd(),
                        HWND_TOPMOST,
                        original.left,
                        original.top,
                        original.right - original.left,
                        original.bottom - original.top,
                        SWP_NOACTIVATE,
                    );
                    ShowWindow(self.backdrop_hwnd(), SW_HIDE);
                }
                std::thread::sleep(Duration::from_millis(700));
                let after = query_notification_state();
                self.evidence.log(format!(
                    "fullscreen_exit state={after} detected={}",
                    is_fullscreen_state(after)
                ));
                self.set_env_reason(REASON_FULLSCREEN, false, "fullscreen-cleared");
                let visible = unsafe { IsWindowVisible(self.overlay_hwnd()) } != 0;
                self.policy_pass = Some(hidden && visible);
            } else {
                self.set_env_reason(REASON_LOCK_SIMULATED, true, "lock-simulated");
                self.set_env_reason(REASON_USER_HIDDEN, false, "user-unhide-under-lock");
                let hidden = unsafe { IsWindowVisible(self.overlay_hwnd()) } == 0;
                self.set_env_reason(REASON_LOCK_SIMULATED, false, "lock-cleared");
                let visible = unsafe { IsWindowVisible(self.overlay_hwnd()) } != 0;
                self.policy_pass = Some(hidden && visible);
                unsafe {
                    SetWindowPos(
                        self.backdrop_hwnd(),
                        HWND_TOPMOST,
                        original.left,
                        original.top,
                        original.right - original.left,
                        original.bottom - original.top,
                        SWP_NOACTIVATE,
                    );
                    ShowWindow(self.backdrop_hwnd(), SW_HIDE);
                }
            }

            let foreground = foreground_root();
            let focus_pass = foreground != self.overlay_hwnd();
            self.focus_after_restore_pass = Some(focus_pass);
            self.evidence.log(format!(
                "policy_restore foreground={} overlay={} no_focus_steal={focus_pass}",
                fmt_hwnd(foreground),
                fmt_hwnd(self.overlay_hwnd())
            ));
            if !previous_foreground.is_null() && previous_foreground != foreground {
                unsafe { SetForegroundWindow(previous_foreground) };
            }
        }

        fn restore(&self, source: &str) {
            self.set_locked(false);
            self.show_overlay();
            self.evidence
                .log(format!("restore source={source} visible=true locked=false"));
        }

        fn record_styles(&self, tag: &str) {
            self.evidence.log(format!(
                "styles tag={tag} overlay[{}] backdrop[{}]",
                style_summary(ex_style(self.overlay_hwnd())),
                style_summary(ex_style(self.backdrop_hwnd()))
            ));
        }

        fn hit(&self, tag: &str) -> (HWND, HWND) {
            let overlay = self.overlay_hwnd();
            let backdrop = self.backdrop_hwnd();
            let (raw, root) = hit_test(overlay);
            self.evidence.log(format!(
                "hit tag={tag} raw={} root={} overlay={} backdrop={} root_class={} raw_class={}",
                fmt_hwnd(raw),
                fmt_hwnd(root),
                fmt_hwnd(overlay),
                fmt_hwnd(backdrop),
                class_name(root),
                class_name(raw)
            ));
            (raw, root)
        }

        fn tick(&mut self, n: u8) -> bool {
            match n {
                0 => {
                    strip_title_bar(self.overlay_hwnd());
                    strip_title_bar(self.backdrop_hwnd());
                    unsafe {
                        ShowWindow(self.backdrop_hwnd(), SW_SHOW);
                        SetWindowPos(
                            self.backdrop_hwnd(),
                            HWND_TOPMOST,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                        );
                    }
                    let foreground_before = foreground_root();
                    self.show_overlay();
                    let foreground_after = foreground_root();
                    let overlay = self.overlay_hwnd();
                    let pass = foreground_after != overlay;
                    self.no_activate_pass = Some(pass);
                    self.evidence.log(format!(
                        "focus foreground_before={} foreground_after={} overlay={} kept_other_foreground={}",
                        fmt_hwnd(foreground_before),
                        fmt_hwnd(foreground_after),
                        fmt_hwnd(overlay),
                        pass
                    ));
                    self.record_styles("shown");
                    self.evidence.log(format!(
                        "env dpi_overlay={} dpi_backdrop={} monitors={} screen={}x{}",
                        unsafe { GetDpiForWindow(overlay) },
                        unsafe { GetDpiForWindow(self.backdrop_hwnd()) },
                        unsafe { GetSystemMetrics(SM_CMONITORS) },
                        unsafe { GetSystemMetrics(0) },
                        unsafe { GetSystemMetrics(1) }
                    ));
                    self.evidence.log(format!(
                        "tree overlay_children=[{}] backdrop_children=[{}]",
                        child_classes(overlay),
                        child_classes(self.backdrop_hwnd())
                    ));
                    self.evidence.marker("shown");
                }
                1 => {
                    self.set_locked(true);
                    let _ = self.overlay_view.evaluate_script("window.setInk(false)");
                    self.record_styles("locked-light");
                    let (_, root) = self.hit("locked-light");
                    self.locked_hit_pass = Some(root == self.backdrop_hwnd());
                    self.synthetic_click(self.overlay_hwnd(), ClickTag::Locked);
                    self.evidence.marker("light-ready");
                }
                2 => {
                    let _ = self.backdrop_view.evaluate_script("window.setDark(true)");
                    let _ = self.overlay_view.evaluate_script("window.setInk(true)");
                    self.evidence.log("phase=dark-ready");
                    self.evidence.marker("dark-ready");
                }
                3 => {
                    self.hide_overlay();
                    self.evidence.log(format!(
                        "hidden visible={} overlay={}",
                        unsafe { IsWindowVisible(self.overlay_hwnd()) },
                        fmt_hwnd(self.overlay_hwnd())
                    ));
                    self.synthetic_click(self.backdrop_hwnd(), ClickTag::BackdropVisible);
                    self.evidence.marker("hidden");
                }
                4 => {
                    self.restore("synthetic-unlock");
                    self.record_styles("restored");
                    let (_, root) = self.hit("restored-unlocked");
                    self.evidence.log(format!(
                        "hit_unlocked_root_is_overlay={}",
                        root == self.overlay_hwnd()
                    ));
                    self.synthetic_click(self.overlay_hwnd(), ClickTag::Unlocked);
                    self.evidence.marker("restored");
                }
                5 => {
                    self.set_locked(true);
                    self.record_styles("locked-final");
                    let (_, root) = self.hit("locked-final");
                    let pass = root == self.backdrop_hwnd();
                    self.locked_hit_pass = Some(self.locked_hit_pass.unwrap_or(true) && pass);
                    self.evidence.log(format!(
                        "tray built=ok restore_id={} quit_id={}",
                        self.restore_id, self.quit_id
                    ));
                    self.evidence.marker("locked-final");
                }
                6 => {
                    for _ in 0..50 {
                        self.set_locked(true);
                        self.set_locked(false);
                        self.hide_overlay();
                        self.show_overlay();
                    }
                    let children = child_classes(self.overlay_hwnd());
                    self.evidence.log(format!(
                        "lifecycle_50 cycles=50 visible={} overlay_children={}",
                        unsafe { IsWindowVisible(self.overlay_hwnd()) },
                        children
                            .split(',')
                            .filter(|value| !value.is_empty())
                            .count()
                    ));
                    self.evidence.marker("lifecycle");
                    if self.tray_wait_ms > 0 {
                        self.set_env_reason(REASON_USER_HIDDEN, true, "tray-wait-hide");
                        self.evidence.log(format!(
                            "tray_wait begin wait_ms={} awaiting real tray click",
                            self.tray_wait_ms
                        ));
                        self.evidence.marker("tray-wait");
                    }
                }
                7 => {
                    if self.tray_wait_ms > 0 {
                        let visible = unsafe { IsWindowVisible(self.overlay_hwnd()) } != 0;
                        let pass = self.tray_events > 0 && visible && self.env_reasons == 0;
                        self.tray_click_pass = Some(pass);
                        self.evidence.log(format!(
                            "tray_wait_result events={} reasons={:#04x} visible={visible} l0_2_tray_real_click={}",
                            self.tray_events,
                            self.env_reasons,
                            verdict(pass)
                        ));
                        self.set_env_reason(REASON_USER_HIDDEN, false, "tray-wait-cleanup");
                    } else {
                        self.evidence
                            .log("tray_wait_result skipped (--tray-wait-ms 0)");
                    }
                    self.fullscreen_policy();
                    self.evidence.marker("policy");
                }
                8 => {
                    self.set_locked(true);
                    self.start_cpu("motion30");
                    let _ = self.overlay_view.evaluate_script("window.startMotion(30)");
                    self.evidence.marker("motion30");
                }
                9 => {
                    let _ = self.overlay_view.evaluate_script("window.stopMotion()");
                    self.finish_cpu("motion30");
                    self.start_cpu("motion15");
                    let _ = self.overlay_view.evaluate_script("window.startMotion(15)");
                    self.evidence.marker("motion15");
                }
                10 => {
                    let _ = self.overlay_view.evaluate_script("window.stopMotion()");
                    self.finish_cpu("motion15");
                    self.start_cpu("static");
                    let _ = self.overlay_view.evaluate_script("window.restoreText()");
                    self.evidence.marker("static");
                }
                11 => {
                    self.finish_cpu("static");
                    self.start_cpu("idle10");
                    self.evidence.marker("idle10");
                }
                12 => {
                    self.finish_cpu("idle10");
                    let tree = sample_process_tree();
                    self.evidence.log(format!(
                        "tree_before_exit processes={} webview_processes={} pids={:?}",
                        tree.processes, tree.webview_processes, tree.pids
                    ));
                    let l0_1 = self.no_activate_pass == Some(true);
                    self.evidence.log(format!(
                        "RESULT l0_1_no_activate_show={} l0_1_styles={} l0_2_window_from_point={} control_click_backdrop_visible={} l0_2_synthetic_click_through={} l0_2_synthetic_click_blocked_unlocked={} l0_2_tray_real_click={} tray_built=true l0_3_policy_reasons={} l0_3_no_focus_steal={} l0_5_lifecycle_50=true l0_6_raw_metrics=see_cpu_and_js_lines",
                        verdict(l0_1),
                        verdict(self.no_activate_pass == Some(true)),
                        verdict(self.locked_hit_pass == Some(true)),
                        verdict(self.backdrop_click_pass == Some(true)),
                        verdict(self.locked_click_pass == Some(true)),
                        verdict(self.unlocked_click_blocked == Some(true)),
                        optional_verdict(self.tray_click_pass),
                        verdict(self.policy_pass == Some(true)),
                        verdict(self.focus_after_restore_pass == Some(true))
                    ));
                    self.evidence.log(format!(
                        "click_counts backdrop={} overlay={}",
                        self.backdrop_clicks.load(Ordering::SeqCst),
                        self.overlay_clicks.load(Ordering::SeqCst)
                    ));
                    if let Some(state) = self.fullscreen_state {
                        self.evidence.log(format!(
                            "fullscreen_state_final={state} detected={}",
                            is_fullscreen_state(state)
                        ));
                    }
                    self.evidence.log(
                        "NOT_RUN lockscreen/display-sleep/hibernate, mixed-DPI topology, tray rebuild/menu loss, controller failure, 8h stable, real lyrics sync",
                    );
                    self.evidence.marker("done");
                }
                _ => {}
            }
            n == 12
        }
    }

    pub fn run() -> Result<(), Box<dyn Error>> {
        let mut out = PathBuf::from("desktop-probe-out");
        let mut source = String::from("unknown");
        let mut lock_mode = String::from("layered");
        let mut tray_wait_ms = 0u64;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--out" => out = PathBuf::from(args.next().ok_or("--out needs a path")?),
                "--source" => source = args.next().ok_or("--source needs a revision")?,
                "--lock-mode" => lock_mode = args.next().ok_or("--lock-mode needs a value")?,
                "--tray-wait-ms" => {
                    tray_wait_ms = args.next().ok_or("--tray-wait-ms needs a value")?.parse()?;
                }
                other => return Err(format!("unknown argument: {other}").into()),
            }
        }
        let mode = match lock_mode.as_str() {
            "style" => 0,
            "disable" => 1,
            "layered" => 2,
            other => return Err(format!("unknown lock mode: {other}").into()),
        };
        LOCK_MODE.store(mode, Ordering::SeqCst);
        let evidence = Evidence::new(out.clone())?;
        let _mutex = match acquire_single_instance(&evidence) {
            Some(handle) => handle,
            None => std::process::exit(3),
        };
        evidence.log(format!(
            "probe=desk-l0 source={source} lock_mode={lock_mode} tray_wait_ms={tray_wait_ms} pid={} webview2_user_data={}",
            std::process::id(),
            out.join("webview2").display()
        ));
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", out.join("webview2"));

        let mut event_loop_builder = EventLoopBuilder::<UserEvent>::with_user_event();
        let event_loop = event_loop_builder.build();
        let proxy = event_loop.create_proxy();
        let tray_proxy = proxy.clone();
        TrayIconEvent::set_event_handler(Some(move |event| {
            let _ = tray_proxy.send_event(UserEvent::Tray(event));
        }));
        let menu_proxy = proxy.clone();
        MenuEvent::set_event_handler(Some(move |event| {
            let _ = menu_proxy.send_event(UserEvent::Menu(event));
        }));

        let backdrop = WindowBuilder::new()
            .with_title("Hertz DESK-L0 backdrop")
            .with_inner_size(LogicalSize::new(820.0, 330.0))
            .with_position(LogicalPosition::new(140.0, 130.0))
            .with_decorations(false)
            .with_resizable(false)
            .with_visible(false)
            .with_focused(false)
            .with_skip_taskbar(true)
            .with_undecorated_shadow(false)
            .build(&event_loop)?;
        let overlay = WindowBuilder::new()
            .with_title("Hertz DESK-L0 overlay")
            .with_inner_size(LogicalSize::new(720.0, 150.0))
            .with_position(LogicalPosition::new(180.0, 260.0))
            .with_decorations(false)
            .with_transparent(true)
            .with_resizable(false)
            .with_visible(false)
            .with_focused(false)
            .with_always_on_top(true)
            .with_skip_taskbar(true)
            .with_undecorated_shadow(false)
            .build(&event_loop)?;

        let backdrop_clicks = Arc::new(AtomicUsize::new(0));
        let overlay_clicks = Arc::new(AtomicUsize::new(0));
        let backdrop_clicks_view = backdrop_clicks.clone();
        let overlay_hwnd = overlay.hwnd() as HWND;
        let style_before = window_style(overlay_hwnd);
        strip_title_bar(overlay_hwnd);
        let style_after = window_style(overlay_hwnd);
        evidence.log(format!(
            "window_style overlay before={style_before:#x} after={style_after:#x} caption_after={} thick_after={} sysmenu_after={}",
            style_after & WS_CAPTION != 0,
            style_after & WS_THICKFRAME != 0,
            style_after & WS_SYSMENU != 0
        ));
        strip_title_bar(backdrop.hwnd() as HWND);

        let backdrop_view = WebViewBuilder::new()
            .with_html(BACKDROP_HTML)
            .with_ipc_handler(move |request| {
                if request.body() == "click" {
                    backdrop_clicks_view.fetch_add(1, Ordering::SeqCst);
                }
            })
            .build(&backdrop)?;
        let overlay_clicks_view = overlay_clicks.clone();
        let overlay_evidence = evidence.clone();
        let overlay_view = WebViewBuilder::new()
            .with_transparent(true)
            .with_html(OVERLAY_HTML)
            .with_ipc_handler(move |request| {
                if request.body() == "click" {
                    overlay_clicks_view.fetch_add(1, Ordering::SeqCst);
                } else {
                    overlay_evidence.log(format!("js {}", request.body()));
                }
            })
            .build(&overlay)?;

        install_hit_test_subclass(overlay.hwnd() as HWND);
        let hwnd = overlay.hwnd() as HWND;
        let old = ex_style(hwnd);
        let next = (old | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
        unsafe {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);
            SetWindowPos(
                hwnd,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }

        let menu = Menu::new();
        let restore_item = MenuItem::new("Restore / 解锁", true, None);
        let quit_item = MenuItem::new("Quit / 退出探针", true, None);
        menu.append(&restore_item)?;
        menu.append(&quit_item)?;
        let restore_id = restore_item.id().0.clone();
        let quit_id = quit_item.id().0.clone();
        let tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("Hertz DESK-L0 probe")
            .with_icon(probe_icon()?)
            .build()?;

        let mut probe = Probe {
            backdrop,
            overlay,
            backdrop_view,
            overlay_view,
            tray,
            evidence,
            restore_id,
            quit_id,
            no_activate_pass: None,
            locked_hit_pass: None,
            locked_click_pass: None,
            unlocked_click_blocked: None,
            backdrop_click_pass: None,
            backdrop_clicks,
            overlay_clicks,
            proxy: proxy.clone(),
            env_reasons: 0,
            policy_pass: None,
            focus_after_restore_pass: None,
            fullscreen_state: None,
            cpu_mark: None,
            tray_wait_ms,
            tray_events: 0,
            tray_click_pass: None,
        };

        let mut schedule = vec![
            0u64, 1_200, 3_200, 5_200, 6_200, 7_600, 9_200, 11_000, 13_000, 18_000, 23_000, 28_000,
            39_500,
        ];
        if tray_wait_ms > 0 {
            for at_ms in schedule.iter_mut().skip(7) {
                *at_ms += tray_wait_ms;
            }
        }

        let _ticker = {
            let proxy = proxy.clone();
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

        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;
            match event {
                Event::UserEvent(UserEvent::Tick(n)) => {
                    if probe.tick(n) {
                        *control_flow = ControlFlow::Exit;
                    }
                }
                Event::UserEvent(UserEvent::ClickChecked {
                    tag,
                    backdrop_before,
                    overlay_before,
                    inserted,
                }) => probe.evaluate_click(tag, backdrop_before, overlay_before, inserted),
                Event::UserEvent(UserEvent::Tray(event)) => {
                    probe.tray_events += 1;
                    probe
                        .evidence
                        .log(format!("tray_event={event:?} -> restore"));
                    probe.set_env_reason(REASON_USER_HIDDEN, false, "tray-restore");
                    probe.restore("tray-event");
                }
                Event::UserEvent(UserEvent::Menu(event)) => {
                    let id = event.id.0.clone();
                    probe.evidence.log(format!("menu_event={id}"));
                    if id == probe.restore_id {
                        probe.restore("tray-menu");
                    } else if id == probe.quit_id {
                        probe.evidence.log("quit source=tray-menu");
                        *control_flow = ControlFlow::Exit;
                    }
                }
                Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    ..
                } => *control_flow = ControlFlow::Exit,
                _ => {}
            }
        })
    }

    fn acquire_single_instance(evidence: &Evidence) -> Option<HANDLE> {
        let name: Vec<u16> = "Local\\Hertz.DesktopProbe.Singleton\0"
            .encode_utf16()
            .collect();
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            evidence.log("single_instance=error");
            return None;
        }
        let conflict = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        evidence.log(format!(
            "single_instance={} name=Local\\\\Hertz.DesktopProbe.Singleton pid={}",
            if conflict { "conflict" } else { "acquired" },
            unsafe { GetCurrentProcessId() }
        ));
        if conflict {
            unsafe { CloseHandle(handle) };
            None
        } else {
            Some(handle)
        }
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

    fn send_absolute_click(x: i32, y: i32) -> u32 {
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

    fn ex_style(hwnd: HWND) -> u32 {
        unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 }
    }

    fn window_style(hwnd: HWND) -> u32 {
        unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 }
    }

    fn install_hit_test_subclass(hwnd: HWND) {
        let original = unsafe { GetWindowLongPtrW(hwnd, GWLP_WNDPROC) };
        ORIGINAL_WNDPROC.store(original, Ordering::SeqCst);
        unsafe {
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, overlay_wndproc as *const () as isize);
        }
    }

    unsafe extern "system" fn overlay_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        if msg == WM_NCHITTEST && CLICK_THROUGH.load(Ordering::SeqCst) {
            return HTTRANSPARENT as isize;
        }
        let original = ORIGINAL_WNDPROC.load(Ordering::SeqCst);
        if original == 0 {
            return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
        }
        let procedure: WNDPROC = unsafe { std::mem::transmute(original) };
        unsafe { CallWindowProcW(procedure, hwnd, msg, wparam, lparam) }
    }

    fn strip_title_bar(hwnd: HWND) {
        let old = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 };
        let next =
            old & !(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
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

    fn set_descendants_transparent(hwnd: HWND, locked: bool) -> String {
        unsafe extern "system" fn collect(child: HWND, lparam: LPARAM) -> i32 {
            let children = &mut *(lparam as *mut Vec<HWND>);
            children.push(child);
            1
        }
        let mut children = Vec::new();
        unsafe {
            EnumChildWindows(
                hwnd,
                Some(collect),
                &mut children as *mut Vec<HWND> as LPARAM,
            )
        };
        let mut applied = 0usize;
        let mut self_pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut self_pid) };
        let mut details = Vec::new();
        for child in &children {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(*child, &mut pid) };
            let owned = pid == self_pid;
            if owned {
                let old = ex_style(*child);
                let next = if locked {
                    old | WS_EX_TRANSPARENT
                } else {
                    old & !WS_EX_TRANSPARENT
                };
                unsafe { SetWindowLongPtrW(*child, GWL_EXSTYLE, next as isize) };
                if (ex_style(*child) & WS_EX_TRANSPARENT != 0) == locked {
                    applied += 1;
                }
            }
            details.push(format!(
                "{}:pid={}:{}{}",
                class_name(*child),
                pid,
                if owned { "self" } else { "external" },
                if ex_style(*child) & WS_EX_TRANSPARENT != 0 {
                    ":T"
                } else {
                    ""
                }
            ));
        }
        format!(
            "total={} self_pid={} applied={} [{}]",
            children.len(),
            self_pid,
            applied,
            details.join(",")
        )
    }

    fn style_summary(style: u32) -> String {
        format!(
            "topmost={} noactivate={} toolwindow={} appwindow={} transparent={}",
            style & WS_EX_TOPMOST != 0,
            style & WS_EX_NOACTIVATE != 0,
            style & WS_EX_TOOLWINDOW != 0,
            style & WS_EX_APPWINDOW != 0,
            style & WS_EX_TRANSPARENT != 0
        )
    }

    fn foreground_root() -> HWND {
        let foreground = unsafe { GetForegroundWindow() };
        if foreground.is_null() {
            foreground
        } else {
            unsafe { GetAncestor(foreground, GA_ROOT) }
        }
    }

    fn hit_test(hwnd: HWND) -> (HWND, HWND) {
        let mut rect = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut rect) };
        let point = POINT {
            x: (rect.left + rect.right) / 2,
            y: (rect.top + rect.bottom) / 2,
        };
        let raw = unsafe { WindowFromPoint(point) };
        let root = if raw.is_null() {
            raw
        } else {
            unsafe { GetAncestor(raw, GA_ROOT) }
        };
        (raw, root)
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

    fn child_classes(hwnd: HWND) -> String {
        unsafe extern "system" fn callback(child: HWND, lparam: LPARAM) -> i32 {
            let names = &mut *(lparam as *mut Vec<String>);
            names.push(class_name(child));
            1
        }
        let mut names = Vec::new();
        unsafe {
            EnumChildWindows(
                hwnd,
                Some(callback),
                &mut names as *mut Vec<String> as LPARAM,
            )
        };
        names.join(",")
    }

    fn fmt_hwnd(hwnd: HWND) -> String {
        format!("{hwnd:p}")
    }

    fn verdict(pass: bool) -> &'static str {
        if pass {
            "pass"
        } else {
            "fail"
        }
    }

    fn optional_verdict(pass: Option<bool>) -> &'static str {
        match pass {
            Some(true) => "pass",
            Some(false) => "fail",
            None => "not-run",
        }
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
                let in_h = (9..=12).contains(&x) && (9..=22).contains(&y)
                    || (19..=22).contains(&x) && (9..=22).contains(&y)
                    || (12..=19).contains(&x) && (14..=17).contains(&y);
                let color = if in_h {
                    [245, 250, 255, 255]
                } else if in_disc {
                    [20, 170, 245, 255]
                } else {
                    [0, 0, 0, 0]
                };
                rgba[index..index + 4].copy_from_slice(&color);
            }
        }
        Ok(Icon::from_rgba(rgba, SIZE, SIZE)?)
    }
}
