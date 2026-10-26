// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Win32 细节：透明/穿透、托盘重建消息、会话与电源、工作区与全屏判定。

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::OnceLock;

use anyhow::{bail, Result};
use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, RedrawWindow, HDC, HMONITOR,
    MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST, RDW_ALLCHILDREN, RDW_FRAME,
    RDW_INVALIDATE, RDW_UPDATENOW,
};
use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::{
    GetSystemPowerStatus, RegisterPowerSettingNotification, POWERBROADCAST_SETTING,
    SYSTEM_POWER_STATUS,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ,
};
use windows_sys::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows_sys::Win32::System::SystemServices::GUID_CONSOLE_DISPLAY_STATE;
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI};
use windows_sys::Win32::UI::Shell::{
    SHQueryUserNotificationState, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, CreateWindowExW, DefWindowProcW, DispatchMessageW, EnumChildWindows,
    FindWindowExW, FindWindowW, GetClassNameW, GetForegroundWindow, GetMessageW, GetParent,
    GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsWindow,
    IsZoomed, RegisterClassW, RegisterWindowMessageW, SendMessageTimeoutW, SetForegroundWindow,
    SetLayeredWindowAttributes, SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    TranslateMessage, HWND_BOTTOM, HWND_TOPMOST, LWA_ALPHA, MSG, PBT_APMRESUMEAUTOMATIC,
    PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, PBT_POWERSETTINGCHANGE, SMTO_NORMAL, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_SHOW,
    SW_SHOWNOACTIVATE, WM_NCHITTEST, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WNDCLASSW, WNDPROC,
    WS_CAPTION, WS_CHILD, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU,
    WS_THICKFRAME, WTS_SESSION_LOCK, WTS_SESSION_LOGOFF, WTS_SESSION_LOGON, WTS_SESSION_UNLOCK,
};

static CLICK_THROUGH: AtomicBool = AtomicBool::new(false);
static ORIGINAL_WNDPROC: AtomicIsize = AtomicIsize::new(0);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
static DISPLAY_STATE_SEEN: AtomicBool = AtomicBool::new(false);
type Sink = Box<dyn Fn(NativeEvent) + Send>;
static SINK: OnceLock<std::sync::Mutex<Sink>> = OnceLock::new();

#[derive(Clone, Copy, Debug)]
pub(crate) enum NativeEvent {
    TaskbarCreated,
    SessionUnavailable(bool),
    DisplayOff(bool),
}

#[derive(Clone, Debug)]
pub(crate) struct WorkArea {
    pub(crate) name: String,
    pub(crate) left: i32,
    pub(crate) top: i32,
    pub(crate) right: i32,
    pub(crate) bottom: i32,
    pub(crate) dpi: u32,
    pub(crate) primary: bool,
}

impl WorkArea {
    pub(crate) fn width(&self) -> i32 {
        self.right - self.left
    }

    pub(crate) fn height(&self) -> i32 {
        self.bottom - self.top
    }

    pub(crate) fn scale(&self) -> f64 {
        f64::from(self.dpi) / 96.0
    }
}

pub(crate) fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

pub(crate) fn replace_file(from: &Path, to: &Path) -> Result<()> {
    let from = to_wide(&from.to_string_lossy());
    let to = to_wide(&to.to_string_lossy());
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) };
    if ok == 0 {
        bail!("MoveFileExW 失败");
    }
    Ok(())
}

pub(crate) fn strip_title_bar(hwnd: HWND) {
    let old =
        unsafe { GetWindowLongPtrW(hwnd, windows_sys::Win32::UI::WindowsAndMessaging::GWL_STYLE) }
            as u32;
    let next = old & !(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            windows_sys::Win32::UI::WindowsAndMessaging::GWL_STYLE,
            next as isize,
        );
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

/// 置顶、无激活、工具窗口，并从任务栏隐藏。
pub(crate) fn make_tool_window(hwnd: HWND) {
    let old = ex_style(hwnd);
    let next = (old | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST) & !WS_EX_APPWINDOW;
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE,
            next as isize,
        );
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
}

pub(crate) fn install_hit_test_subclass(hwnd: HWND) {
    let original = unsafe {
        GetWindowLongPtrW(
            hwnd,
            windows_sys::Win32::UI::WindowsAndMessaging::GWLP_WNDPROC,
        )
    };
    ORIGINAL_WNDPROC.store(original, Ordering::SeqCst);
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            windows_sys::Win32::UI::WindowsAndMessaging::GWLP_WNDPROC,
            overlay_wndproc as *const () as isize,
        );
    }
}

unsafe extern "system" fn overlay_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCHITTEST && CLICK_THROUGH.load(Ordering::SeqCst) {
        return windows_sys::Win32::UI::WindowsAndMessaging::HTTRANSPARENT as isize;
    }
    let original = ORIGINAL_WNDPROC.load(Ordering::SeqCst);
    if original == 0 {
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    }
    let procedure: WNDPROC = unsafe { std::mem::transmute(original) };
    unsafe { CallWindowProcW(procedure, hwnd, msg, wparam, lparam) }
}

/// 锁定后整个 HWND 与自有子窗口都不接鼠标；解锁恢复。
pub(crate) fn set_locked(hwnd: HWND, locked: bool) {
    let old = ex_style(hwnd);
    let next = if locked {
        old | WS_EX_TRANSPARENT | WS_EX_LAYERED
    } else {
        old & !(WS_EX_TRANSPARENT | WS_EX_LAYERED)
    };
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE,
            next as isize,
        );
        windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow(hwnd, 1);
        if locked {
            SetWindowLongPtrW(
                hwnd,
                windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE,
                next as isize,
            );
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
    set_descendants_transparent(hwnd, locked);
    CLICK_THROUGH.store(locked, Ordering::SeqCst);
}

fn set_descendants_transparent(hwnd: HWND, locked: bool) {
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
    let mut self_pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, &mut self_pid) };
    for child in children {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(child, &mut pid) };
        if pid != self_pid {
            continue;
        }
        let old = ex_style(child);
        let next = if locked {
            old | WS_EX_TRANSPARENT
        } else {
            old & !WS_EX_TRANSPARENT
        };
        unsafe {
            SetWindowLongPtrW(
                child,
                windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE,
                next as isize,
            )
        };
    }
}

pub(crate) fn ex_style(hwnd: HWND) -> u32 {
    unsafe {
        GetWindowLongPtrW(
            hwnd,
            windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE,
        ) as u32
    }
}

pub(crate) fn show_no_activate(hwnd: HWND) {
    unsafe {
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
}

pub(crate) fn hide(hwnd: HWND) {
    unsafe { ShowWindow(hwnd, SW_HIDE) };
}

/// 保持在顶层但绝不激活。活跃的其它置顶窗口（例如播放器宿主页）会重新压上来，
/// 所以存活期间低频重申一次；这不会抢焦点。
pub(crate) fn raise(hwnd: HWND) {
    unsafe {
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
}

pub(crate) fn focus(hwnd: HWND) {
    unsafe { SetForegroundWindow(hwnd) };
}

pub(crate) fn monitors() -> Vec<WorkArea> {
    unsafe extern "system" fn callback(
        monitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> i32 {
        let output = &mut *(data as *mut Vec<WorkArea>);
        if let Some(area) = area_from_monitor(monitor) {
            output.push(area);
        }
        1
    }
    let mut output = Vec::new();
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(callback),
            &mut output as *mut Vec<WorkArea> as LPARAM,
        )
    };
    output
}

#[derive(Clone, Debug)]
pub(crate) struct WallpaperMonitor {
    pub(crate) name: String,
    pub(crate) left: i32,
    pub(crate) top: i32,
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) dpi: u32,
    pub(crate) primary: bool,
}

pub(crate) fn wallpaper_monitors() -> Vec<WallpaperMonitor> {
    unsafe extern "system" fn callback(
        monitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> i32 {
        let output = &mut *(data as *mut Vec<WallpaperMonitor>);
        if let Some(monitor) = wallpaper_monitor_from_monitor(monitor) {
            output.push(monitor);
        }
        1
    }
    let mut output = Vec::new();
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(callback),
            &mut output as *mut Vec<WallpaperMonitor> as LPARAM,
        )
    };
    output
}

fn wallpaper_monitor_from_monitor(monitor: HMONITOR) -> Option<WallpaperMonitor> {
    if monitor.is_null() {
        return None;
    }
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    let ok = unsafe {
        GetMonitorInfoW(
            monitor,
            &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
        )
    };
    if ok == 0 {
        return None;
    }
    let end = info
        .szDevice
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(info.szDevice.len());
    let name = String::from_utf16_lossy(&info.szDevice[..end]);
    let mut dpi_x = 96u32;
    let mut dpi_y = 96u32;
    let dpi_ok = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
    let dpi = if dpi_ok >= 0 { dpi_x } else { 96 };
    let rect = info.monitorInfo.rcMonitor;
    Some(WallpaperMonitor {
        name,
        left: rect.left,
        top: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        dpi,
        primary: info.monitorInfo.dwFlags & 1 != 0,
    })
}

pub(crate) fn window_dpi(hwnd: HWND) -> u32 {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        96
    } else {
        dpi
    }
}

fn area_from_monitor(monitor: HMONITOR) -> Option<WorkArea> {
    if monitor.is_null() {
        return None;
    }
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    let ok = unsafe {
        GetMonitorInfoW(
            monitor,
            &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
        )
    };
    if ok == 0 {
        return None;
    }
    let end = info
        .szDevice
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(info.szDevice.len());
    let name = String::from_utf16_lossy(&info.szDevice[..end]);
    let mut dpi_x = 96u32;
    let mut dpi_y = 96u32;
    let dpi_ok = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
    let dpi = if dpi_ok >= 0 { dpi_x } else { 96 };
    let work = info.monitorInfo.rcWork;
    Some(WorkArea {
        name,
        left: work.left,
        top: work.top,
        right: work.right,
        bottom: work.bottom,
        dpi,
        primary: info.monitorInfo.dwFlags & 1 != 0,
    })
}

pub(crate) fn work_area_for_window(hwnd: HWND) -> Option<WorkArea> {
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    area_from_monitor(monitor)
}

pub(crate) fn work_area_by_name(name: &str) -> Option<WorkArea> {
    monitors().into_iter().find(|area| area.name == name)
}

pub(crate) fn primary_work_area() -> Option<WorkArea> {
    monitors()
        .into_iter()
        .find(|area| area.primary)
        .or_else(|| monitors().into_iter().next())
}

pub(crate) fn window_rect(hwnd: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    let ok = unsafe { GetWindowRect(hwnd, &mut rect) };
    (ok != 0).then_some(rect)
}

pub(crate) fn parent_window_rect(hwnd: HWND) -> Option<RECT> {
    let parent = unsafe { GetParent(hwnd) };
    if parent.is_null() {
        None
    } else {
        window_rect(parent)
    }
}

pub(crate) fn target_fullscreen(hwnd: HWND) -> bool {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_null() || foreground == hwnd {
        return false;
    }
    let foreground_monitor = unsafe { MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST) };
    let our_monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if foreground_monitor != our_monitor {
        return false;
    }
    let mut state = -1;
    if unsafe { SHQueryUserNotificationState(&mut state) } >= 0
        && matches!(state, QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
    {
        return true;
    }
    // 最大化窗口会在部分应用里覆盖整块显示器（无边框自绘标题栏），
    // 但它不是全屏应用；日志与工作区语义都该按「普通窗口」处理。
    if unsafe { IsZoomed(foreground) } != 0 {
        return false;
    }
    let class = class_name(foreground);
    if matches!(
        class.as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    ) {
        return false;
    }
    let Some(window) = window_rect(foreground) else {
        return false;
    };
    let Some(area) = area_from_monitor(foreground_monitor) else {
        return false;
    };
    let monitor = RECT {
        left: area.left,
        top: area.top,
        right: area.right,
        bottom: area.bottom,
    };
    covers(window, monitor)
}

fn covers(window: RECT, monitor: RECT) -> bool {
    const TOLERANCE: i32 = 2;
    window.left <= monitor.left + TOLERANCE
        && window.top <= monitor.top + TOLERANCE
        && window.right >= monitor.right - TOLERANCE
        && window.bottom >= monitor.bottom - TOLERANCE
}

fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if len <= 0 {
        String::new()
    } else {
        String::from_utf16_lossy(&buffer[..len as usize])
    }
}

/// 交流电供电返回 true；读不到时按交流电处理（不额外降帧）。
pub(crate) fn on_ac_power() -> bool {
    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
        return true;
    }
    status.ACLineStatus != 0
}

pub(crate) fn autostart_enabled() -> Result<bool> {
    let subkey = to_wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let mut key = std::ptr::null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut key,
        )
    };
    if status == 2 {
        return Ok(false);
    }
    if status != 0 {
        bail!("读取开机启动项失败（{status}）");
    }
    let name = to_wide("HertzDesktop");
    let mut kind = 0;
    let mut bytes = 0;
    let status = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            std::ptr::null_mut(),
            &mut bytes,
        )
    };
    unsafe { RegCloseKey(key) };
    if status == 2 {
        return Ok(false);
    }
    if status != 0 {
        bail!("读取开机启动项失败（{status}）");
    }
    Ok(kind == REG_SZ && bytes > 2)
}

pub(crate) fn set_autostart(enabled: bool) -> Result<()> {
    let subkey = to_wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let mut key = std::ptr::null_mut();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_SET_VALUE,
            &mut key,
        )
    };
    if status != 0 {
        bail!("打开开机启动注册表项失败（{status}）");
    }
    let name = to_wide("HertzDesktop");
    if enabled {
        let exe = std::env::current_exe()?;
        let value = to_wide(&format!("\"{}\"", exe.display()));
        let status = unsafe {
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr() as *const u8,
                (value.len() * std::mem::size_of::<u16>()) as u32,
            )
        };
        unsafe { RegCloseKey(key) };
        if status != 0 {
            bail!("写入开机启动项失败（{status}）");
        }
    } else {
        let status = unsafe { RegDeleteValueW(key, name.as_ptr()) };
        unsafe { RegCloseKey(key) };
        // 值不存在不算失败。
        if status != 0 && status != 2 {
            bail!("删除开机启动项失败（{status}）");
        }
    }
    Ok(())
}

/// 托盘、会话与电源通知的消息窗口。独立线程的消息循环。
pub(crate) fn install_message_window(sink: impl Fn(NativeEvent) + Send + 'static) -> Result<()> {
    SINK.set(std::sync::Mutex::new(Box::new(sink)))
        .map_err(|_| anyhow::anyhow!("消息窗口已安装"))?;
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("hertz-desktop-messages".into())
        .spawn(move || {
            let result = unsafe { create_message_window() };
            let ok = result.is_ok();
            let _ = ready_tx.send(result);
            if !ok {
                return;
            }
            let mut message = MSG::default();
            unsafe {
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        })?;
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| anyhow::anyhow!("消息窗口启动超时"))?
}

unsafe fn create_message_window() -> Result<()> {
    let class = to_wide("HertzDesktopMessages");
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    if instance.is_null() {
        bail!("GetModuleHandleW 失败");
    }
    let window_class = WNDCLASSW {
        style: 0,
        lpfnWndProc: Some(message_wndproc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: instance,
        hIcon: std::ptr::null_mut(),
        hCursor: std::ptr::null_mut(),
        hbrBackground: std::ptr::null_mut(),
        lpszMenuName: std::ptr::null(),
        lpszClassName: class.as_ptr(),
    };
    let atom = unsafe { RegisterClassW(&window_class) };
    if atom == 0 {
        bail!("RegisterClassW 失败");
    }
    let title = to_wide("HertzDesktopMessages");
    let hwnd = unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            title.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        )
    };
    if hwnd.is_null() {
        bail!("CreateWindowExW(HWND_MESSAGE) 失败");
    }
    TASKBAR_CREATED.store(
        unsafe { RegisterWindowMessageW(to_wide("TaskbarCreated").as_ptr()) },
        Ordering::SeqCst,
    );
    unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) };
    let guid: windows_sys::core::GUID = GUID_CONSOLE_DISPLAY_STATE;
    unsafe {
        RegisterPowerSettingNotification(
            hwnd,
            &guid,
            windows_sys::Win32::UI::WindowsAndMessaging::DEVICE_NOTIFY_WINDOW_HANDLE,
        )
    };
    crate::app::log("message window ready");
    Ok(())
}

unsafe extern "system" fn message_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let taskbar = TASKBAR_CREATED.load(Ordering::SeqCst);
    if taskbar != 0 && msg == taskbar {
        emit(NativeEvent::TaskbarCreated);
        return 0;
    }
    match msg {
        WM_WTSSESSION_CHANGE => match wparam as u32 {
            // WTS_SESSION_CONNECT / DISCONNECT 在 windows-sys 里没有常量。
            2 | WTS_SESSION_LOCK | WTS_SESSION_LOGOFF => {
                emit(NativeEvent::SessionUnavailable(true));
            }
            1 | WTS_SESSION_UNLOCK | WTS_SESSION_LOGON => {
                emit(NativeEvent::SessionUnavailable(false));
            }
            _ => {}
        },
        WM_POWERBROADCAST => match wparam as u32 {
            PBT_APMSUSPEND => emit(NativeEvent::SessionUnavailable(true)),
            PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => {
                emit(NativeEvent::SessionUnavailable(false))
            }
            PBT_POWERSETTINGCHANGE if lparam != 0 => {
                let setting = unsafe { &*(lparam as *const POWERBROADCAST_SETTING) };
                let display_guid = GUID_CONSOLE_DISPLAY_STATE;
                let power = &setting.PowerSetting;
                if display_guid.data1 == power.data1
                    && display_guid.data2 == power.data2
                    && display_guid.data3 == power.data3
                    && display_guid.data4 == power.data4
                    && setting.DataLength >= 4
                {
                    let state = unsafe {
                        std::slice::from_raw_parts(
                            setting.Data.as_ptr(),
                            setting.DataLength as usize,
                        )
                    };
                    let state = u32::from_le_bytes([state[0], state[1], state[2], state[3]]);
                    // 注册通知时系统会立刻回一帧当前状态；它偶尔是 0（off），
                    // 但桌面明明可见。忽略第一帧，只跟随之后的真实变化。
                    if DISPLAY_STATE_SEEN.swap(true, Ordering::SeqCst) {
                        emit(NativeEvent::DisplayOff(state == 0));
                    } else {
                        crate::app::log(&format!("display_state_initial={state} (ignored)"));
                    }
                }
            }
            _ => {}
        },
        _ => {}
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn emit(event: NativeEvent) {
    if let Some(sink) = SINK.get() {
        if let Ok(sink) = sink.lock() {
            sink(event);
        }
    }
}

/// 单实例互斥量。返回 None 表示已有宿主在跑。
pub(crate) fn acquire_single_instance() -> Option<HANDLE> {
    use windows_sys::Win32::Foundation::ERROR_ALREADY_EXISTS;
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let name = to_wide("Local\\HertzDesktop.Singleton");
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return None;
    }
    let conflict =
        unsafe { windows_sys::Win32::Foundation::GetLastError() } == ERROR_ALREADY_EXISTS;
    if conflict {
        unsafe { CloseHandle(handle) };
        None
    } else {
        Some(handle)
    }
}

/// 把窗口挂到 Explorer 的 WorkerW 图标层之后，并放到指定显示器的完整矩形。
pub(crate) fn mount_wallpaper(hwnd: HWND, monitor: &WallpaperMonitor) -> Result<()> {
    const REQUEST_WORKERW: u32 = 0x052C;
    let class = to_wide("Progman");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let progman = loop {
        let progman = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
        if !progman.is_null() {
            break progman;
        }
        if std::time::Instant::now() >= deadline {
            bail!("找不到 Progman");
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    let mut result = 0usize;
    unsafe {
        SendMessageTimeoutW(
            progman,
            REQUEST_WORKERW,
            0,
            0,
            SMTO_NORMAL,
            1000,
            &mut result,
        );
    }
    let workerw = loop {
        if let Some(workerw) = find_wallpaper_workerw(progman) {
            break workerw;
        }
        if std::time::Instant::now() >= deadline {
            bail!("找不到 WorkerW 壁纸层");
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    let vx =
        unsafe { GetSystemMetrics(windows_sys::Win32::UI::WindowsAndMessaging::SM_XVIRTUALSCREEN) };
    let vy =
        unsafe { GetSystemMetrics(windows_sys::Win32::UI::WindowsAndMessaging::SM_YVIRTUALSCREEN) };
    let vw = unsafe {
        GetSystemMetrics(windows_sys::Win32::UI::WindowsAndMessaging::SM_CXVIRTUALSCREEN)
    };
    let vh = unsafe {
        GetSystemMetrics(windows_sys::Win32::UI::WindowsAndMessaging::SM_CYVIRTUALSCREEN)
    };
    // WorkerW 是 Progman 的子窗：SetWindowPos 用的是父窗口坐标。负虚拟屏
    // 原点（显示器在上方/左侧）时必须减去 Progman 的屏幕原点，否则整层会
    // 再偏移一屏。
    let progman_rect =
        window_rect(progman).ok_or_else(|| anyhow::anyhow!("读取 Progman 矩形失败"))?;
    let worker_x = vx - progman_rect.left;
    let worker_y = vy - progman_rect.top;
    unsafe {
        SetWindowPos(
            workerw,
            HWND_BOTTOM,
            worker_x,
            worker_y,
            vw,
            vh,
            SWP_NOACTIVATE,
        );
        strip_title_bar(hwnd);
        install_wallpaper_style(hwnd);
        SetParent(hwnd, workerw);
        SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            monitor.left - vx,
            monitor.top - vy,
            monitor.width,
            monitor.height,
            SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED,
        );
        ShowWindow(hwnd, SW_SHOW);
    }
    Ok(())
}

/// Explorer 重启后 WorkerW/子窗口会一起消失；恢复前先核对窗口仍挂在 WorkerW 下。
pub(crate) fn wallpaper_alive(hwnd: HWND) -> bool {
    if unsafe { IsWindow(hwnd) } == 0 {
        return false;
    }
    let parent = unsafe { GetParent(hwnd) };
    !parent.is_null() && class_name(parent) == "WorkerW"
}

fn find_wallpaper_workerw(progman: HWND) -> Option<HWND> {
    let class = to_wide("WorkerW");
    let defview = to_wide("SHELLDLL_DefView");
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
    (unsafe { IsWindow(candidate) } != 0).then_some(candidate)
}

fn install_wallpaper_style(hwnd: HWND) {
    let style =
        unsafe { GetWindowLongPtrW(hwnd, windows_sys::Win32::UI::WindowsAndMessaging::GWL_STYLE) }
            as u32;
    let next = (style
        & !(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX))
        | WS_CHILD;
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            windows_sys::Win32::UI::WindowsAndMessaging::GWL_STYLE,
            next as isize,
        );
    }
    let ex = ex_style(hwnd);
    let next_ex = (ex | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) & !WS_EX_APPWINDOW;
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE,
            next_ex as isize,
        );
    }
}

pub(crate) fn point_in_work_area(point: POINT, area: &WorkArea) -> bool {
    point.x >= area.left && point.x < area.right && point.y >= area.top && point.y < area.bottom
}

pub(crate) fn dialog_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let text = to_wide(message);
    let title = to_wide("Hertz 桌面歌词");
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        )
    };
}
