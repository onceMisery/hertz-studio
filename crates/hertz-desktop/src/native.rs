// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Win32 细节：透明/穿透、托盘重建消息、会话与电源、工作区与全屏判定。

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::OnceLock;

use anyhow::{bail, Result};
use windows_sys::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
    DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, EnumDisplaySettingsExW, GetMonitorInfoW, MonitorFromWindow, RedrawWindow,
    DEVMODEW, ENUM_CURRENT_SETTINGS, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
    MONITOR_DEFAULTTONEAREST, RDW_ALLCHILDREN, RDW_FRAME, RDW_INVALIDATE, RDW_UPDATENOW,
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
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI};
use windows_sys::Win32::UI::Shell::{
    SHQueryUserNotificationState, ShellExecuteW, QUNS_PRESENTATION_MODE,
    QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, CreateWindowExW, DefWindowProcW, DispatchMessageW, EnumChildWindows,
    EnumWindows, FindWindowExW, FindWindowW, GetClassNameW, GetForegroundWindow, GetMessageW,
    GetParent, GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed, RegisterClassW,
    RegisterWindowMessageW, SendMessageTimeoutW, SetForegroundWindow, SetLayeredWindowAttributes,
    SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage, GWL_STYLE,
    HWND_BOTTOM, HWND_TOPMOST, LWA_ALPHA, MSG, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND,
    PBT_APMSUSPEND, PBT_POWERSETTINGCHANGE, SMTO_NORMAL, STYLESTRUCT, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, SW_RESTORE,
    SW_SHOW, SW_SHOWNOACTIVATE, WM_HOTKEY, WM_NCACTIVATE, WM_NCCALCSIZE, WM_NCHITTEST, WM_NCPAINT,
    WM_POWERBROADCAST, WM_STYLECHANGING, WM_WTSSESSION_CHANGE, WNDCLASSW, WNDPROC, WS_CAPTION,
    WS_CHILD, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME,
    WTS_SESSION_LOCK, WTS_SESSION_LOGOFF, WTS_SESSION_LOGON, WTS_SESSION_UNLOCK,
};

static CLICK_THROUGH: AtomicBool = AtomicBool::new(false);
static ORIGINAL_WNDPROC: AtomicIsize = AtomicIsize::new(0);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
static DISPLAY_STATE_SEEN: AtomicBool = AtomicBool::new(false);
const OVERLAY_FRAME_STYLES: u32 =
    WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
type Sink = Box<dyn Fn(NativeEvent) + Send>;
/// 进程内宿主可反复启停：消息窗口是本进程单例，每次启动只换事件接收方。
/// 独立 exe 形态一个进程只有一份，语义不变。
static SINK: std::sync::Mutex<Option<Sink>> = std::sync::Mutex::new(None);
static MESSAGE_THREAD: OnceLock<()> = OnceLock::new();
/// RegisterClassW 注册的类是进程级资源；第二次启动不能再注册同名类。
static MESSAGE_WINDOW_CLASS: OnceLock<Result<(), String>> = OnceLock::new();
static HOTKEY_WINDOW_CLASS: OnceLock<Result<(), String>> = OnceLock::new();

#[derive(Clone, Copy, Debug)]
pub(crate) enum NativeEvent {
    TaskbarCreated,
    SessionUnavailable(bool),
    DisplayOff(bool),
    /// WM_HOTKEY 命中；载荷是 RegisterHotKey 的窗口局部 id（设计 §5.1）。
    HotkeyFired(i32),
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
    let ok = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING
                | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        bail!("MoveFileExW 失败");
    }
    Ok(())
}

pub(crate) fn strip_title_bar(hwnd: HWND) {
    let old = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32;
    let next = old & !OVERLAY_FRAME_STYLES;
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
    // The transparent overlay has no non-client area, including during the nested
    // resize/activation messages sent when WebView2 expands the settings panel.
    // Style filtering alone does not suppress a cached native caption repaint.
    if msg == WM_NCCALCSIZE || msg == WM_NCPAINT {
        return 0;
    }
    // Tao can rebuild GWL_STYLE after startup, restoring WS_CAPTION even for an
    // undecorated window. Filter the proposed style before Windows paints it.
    if msg == WM_STYLECHANGING && wparam as i32 == GWL_STYLE {
        let styles = unsafe { &mut *(lparam as *mut STYLESTRUCT) };
        styles.styleNew &= !OVERLAY_FRAME_STYLES;
    }
    if msg == WM_NCHITTEST && CLICK_THROUGH.load(Ordering::SeqCst) {
        return windows_sys::Win32::UI::WindowsAndMessaging::HTTRANSPARENT as isize;
    }
    // Keep Tao's activation/focus bookkeeping, but tell DefWindowProc not to paint
    // the native frame. -1 is WM_NCACTIVATE's documented no-repaint lParam.
    let lparam = if msg == WM_NCACTIVATE { -1 } else { lparam };
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

fn browser_title_matches(title: &str, text: &str) -> bool {
    text == title
        || text.strip_prefix(title).is_some_and(|suffix| {
            suffix.starts_with(" - ") || suffix.starts_with(" — ") || suffix.starts_with(" – ")
        })
}

fn main_browser_matches(hwnd: HWND, title: &str) -> bool {
    if title.is_empty() || !title.to_ascii_lowercase().contains("hertz-studio") {
        return false;
    }
    let mut class = [0u16; 128];
    let mut text = [0u16; 1024];
    unsafe {
        let class_len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
        let text_len = GetWindowTextW(hwnd, text.as_mut_ptr(), text.len() as i32);
        let class = String::from_utf16_lossy(&class[..class_len.max(0) as usize]);
        let text = String::from_utf16_lossy(&text[..text_len.max(0) as usize]);
        matches!(class.as_str(), "Chrome_WidgetWin_1" | "MozillaWindowClass")
            && browser_title_matches(title, &text)
    }
}

pub(crate) fn main_browser_is_foreground(title: &str) -> bool {
    main_browser_matches(unsafe { GetForegroundWindow() }, title)
}

/// Restore only a uniquely identified main browser window.
pub(crate) fn restore_main_browser(title: &str) -> bool {
    struct Search<'a> {
        title: &'a str,
        windows: Vec<HWND>,
    }
    unsafe extern "system" fn callback(hwnd: HWND, data: LPARAM) -> i32 {
        let search = &mut *(data as *mut Search<'_>);
        if main_browser_matches(hwnd, search.title) {
            search.windows.push(hwnd);
        }
        1
    }
    let mut search = Search {
        title,
        windows: Vec::new(),
    };
    unsafe {
        EnumWindows(Some(callback), &mut search as *mut _ as LPARAM);
    }
    if search.windows.len() != 1 {
        return false;
    }
    let hwnd = search.windows[0];
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd);
    }
    main_browser_is_foreground(title)
}

pub(crate) fn open_url(url: &str) -> Result<()> {
    let verb = to_wide("open");
    let url = to_wide(url);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOW,
        )
    };
    if result as isize <= 32 {
        bail!("Cannot open main window ({})", result as isize);
    }
    Ok(())
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
    /// 当前刷新率（Hz）。ADR-0006 整数分频用；读不到按 60。
    pub(crate) refresh_hz: u32,
    /// DisplayConfig 的 monitorDevicePath；查询失败为 None。
    pub(crate) device_path: Option<String>,
    /// EDID 派生身份摘要（厂商/产品码/连接器实例的 FNV-1a 64）。
    pub(crate) edid_digest: Option<String>,
}

impl WallpaperMonitor {
    /// 稳定显示器身份（设计 §2.2-9/§4.1）：devicePath + EDID 摘要。
    /// 任一成分缺失时降级为 GDI 名（仅当前枚举有效，不跨拓扑持久）。
    pub(crate) fn display_id(&self) -> String {
        match (&self.device_path, &self.edid_digest) {
            (Some(path), Some(digest)) => format!("{path}#{digest}"),
            (Some(path), None) => path.clone(),
            _ => self.name.clone(),
        }
    }
}

/// FNV-1a 64：仅用于把 EDID 身份字节压成稳定摘要，不承担安全哈希职责。
pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
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

/// 读取显示器当前模式刷新率；异常值（0/1 或超常）按 60 兜底。
fn refresh_rate_hz(device: &[u16]) -> u32 {
    let mut mode = DEVMODEW {
        dmSize: std::mem::size_of::<DEVMODEW>() as u16,
        ..Default::default()
    };
    let ok =
        unsafe { EnumDisplaySettingsExW(device.as_ptr(), ENUM_CURRENT_SETTINGS, &mut mode, 0) };
    if ok == 0 {
        return 60;
    }
    let hz = mode.dmDisplayFrequency;
    if (5..=500).contains(&hz) {
        hz
    } else {
        60
    }
}

/// 在 DisplayConfig 活动路径里找 GDI 设备名对应的源/目标，取 monitorDevicePath
/// 与 EDID 身份（设计 §2.2-9：GDI 名只作当前枚举映射）。
fn display_identity(device: &str) -> (Option<String>, Option<String>) {
    let mut num_paths = 0u32;
    let mut num_modes = 0u32;
    let result = unsafe {
        GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut num_paths, &mut num_modes)
    };
    if result != 0 || num_paths == 0 || num_paths > 128 {
        return (None, None);
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); num_paths as usize];
    let mut modes = vec![
        windows_sys::Win32::Devices::Display::DISPLAYCONFIG_MODE_INFO::default();
        num_modes as usize
    ];
    let mut topology = 0i32;
    let result = unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut num_paths,
            paths.as_mut_ptr(),
            &mut num_modes,
            modes.as_mut_ptr(),
            &mut topology,
        )
    };
    if result != 0 {
        return (None, None);
    }
    paths.truncate(num_paths as usize);
    for path in &paths {
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                adapterId: path.sourceInfo.adapterId,
                id: path.sourceInfo.id,
            },
            viewGdiDeviceName: [0; 32],
        };
        if unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } != 0 {
            continue;
        }
        let gdi = from_wide(&source.viewGdiDeviceName);
        if gdi != device {
            continue;
        }
        let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                size: std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                adapterId: path.targetInfo.adapterId,
                id: path.targetInfo.id,
            },
            flags: windows_sys::Win32::Devices::Display::DISPLAYCONFIG_TARGET_DEVICE_NAME_FLAGS::default(),
            outputTechnology: 0,
            edidManufactureId: 0,
            edidProductCodeId: 0,
            connectorInstance: 0,
            monitorFriendlyDeviceName: [0; 64],
            monitorDevicePath: [0; 128],
        };
        if unsafe { DisplayConfigGetDeviceInfo(&mut target.header) } != 0 {
            return (None, None);
        }
        let device_path = from_wide(&target.monitorDevicePath);
        let edid_bytes = format!(
            "{:04x}{:04x}{:08x}",
            target.edidManufactureId, target.edidProductCodeId, target.connectorInstance
        )
        .into_bytes();
        let digest = format!("fnv{:016x}", fnv1a64(&edid_bytes));
        return (Some(device_path), Some(digest));
    }
    (None, None)
}

fn from_wide(buffer: &[u16]) -> String {
    let end = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
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
    let refresh_hz = refresh_rate_hz(&to_wide(&name));
    let (device_path, edid_digest) = display_identity(&name);
    let rect = info.monitorInfo.rcMonitor;
    Some(WallpaperMonitor {
        name,
        left: rect.left,
        top: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        dpi,
        primary: info.monitorInfo.dwFlags & 1 != 0,
        refresh_hz,
        device_path,
        edid_digest,
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

/// 一次拓扑巡检只采集一次前台窗口。显示组通过纯投影复用这个快照，避免
/// 同一轮里不同屏幕读到不同的前台应用，亦不反复打开同一个进程。
#[derive(Clone, Debug)]
pub(crate) struct WallpaperForeground {
    monitor: [i32; 4],
    fullscreen: bool,
    maximized: bool,
    executable: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct WallpaperWindowState<'a> {
    pub(crate) fullscreen: bool,
    pub(crate) maximized: bool,
    pub(crate) executable: Option<&'a str>,
}

pub(crate) fn wallpaper_foreground() -> Option<WallpaperForeground> {
    // 必须先排除桌面壳/本组件/不可见窗口，再读取 shell 的全屏信号。
    let (foreground, pid) = eligible_foreground()?;
    let monitor_handle = unsafe { MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST) };
    let monitor = monitor_rect(monitor_handle)?;
    let maximized = unsafe { IsZoomed(foreground) } != 0;
    Some(WallpaperForeground {
        monitor: [monitor.left, monitor.top, monitor.right, monitor.bottom],
        fullscreen: foreground_fullscreen(foreground, monitor, maximized),
        maximized,
        // 权限不足或路径过长只影响应用规则，不丢弃窗口全屏/最大化事实。
        executable: process_executable(pid),
    })
}

/// 单屏/镜像仅投影到前台所在屏；跨屏的任一成员命中就作用于整个目标。
pub(crate) fn wallpaper_window_state<'a>(
    foreground: Option<&'a WallpaperForeground>,
    members: &[WallpaperMonitor],
) -> WallpaperWindowState<'a> {
    let Some(foreground) = foreground else {
        return WallpaperWindowState::default();
    };
    let [left, top, right, bottom] = foreground.monitor;
    let affects_target = members.iter().any(|member| {
        member.left == left
            && member.top == top
            && i64::from(member.left) + i64::from(member.width) == i64::from(right)
            && i64::from(member.top) + i64::from(member.height) == i64::from(bottom)
    });
    if !affects_target {
        return WallpaperWindowState::default();
    }
    WallpaperWindowState {
        fullscreen: foreground.fullscreen,
        maximized: foreground.maximized,
        executable: foreground.executable.as_deref(),
    }
}

fn eligible_foreground() -> Option<(HWND, u32)> {
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.is_null()
        || unsafe { IsIconic(foreground) } != 0
        || unsafe { IsWindowVisible(foreground) } == 0
    {
        return None;
    }
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(foreground, &mut pid) };
    if pid == 0 || pid == std::process::id() || desktop_shell_class(&class_name(foreground)) {
        return None;
    }
    Some((foreground, pid))
}

fn desktop_shell_class(class: &str) -> bool {
    matches!(
        class,
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    )
}

fn monitor_rect(monitor: HMONITOR) -> Option<RECT> {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if monitor.is_null() || unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return None;
    }
    Some(info.rcMonitor)
}

fn foreground_fullscreen(foreground: HWND, monitor: RECT, maximized: bool) -> bool {
    let mut state = -1;
    let shell_fullscreen = unsafe { SHQueryUserNotificationState(&mut state) } >= 0
        && matches!(state, QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE);
    fullscreen_from_facts(
        shell_fullscreen,
        maximized,
        window_rect(foreground),
        monitor,
    )
}

fn fullscreen_from_facts(
    shell_fullscreen: bool,
    maximized: bool,
    window: Option<RECT>,
    monitor: RECT,
) -> bool {
    // 无边框最大化可能覆盖整屏，仍属于独立的最大化策略。Shell 明确报告
    // D3D 全屏/演示状态时保留该信号，不依赖能否读取窗口矩形。
    shell_fullscreen || (!maximized && window.is_some_and(|window| covers(window, monitor)))
}

fn process_executable(pid: u32) -> Option<String> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    // 固定上限 + 一次查询：不能匹配超出配置合同的路径，也不重试增大缓冲。
    let mut buffer = [0u16; crate::wallpaper::config::MAX_EXECUTABLE_PATH_CHARS + 1];
    let mut length = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) };
    unsafe { CloseHandle(process) };
    if ok == 0 || length == 0 || length as usize >= buffer.len() {
        return None;
    }
    let path = String::from_utf16(&buffer[..length as usize]).ok()?;
    crate::wallpaper::config::normalize_executable_path(&path).ok()
}

fn covers(window: RECT, monitor: RECT) -> bool {
    const TOLERANCE: i32 = 2;
    window.left <= monitor.left + TOLERANCE
        && window.top <= monitor.top + TOLERANCE
        && window.right >= monitor.right - TOLERANCE
        && window.bottom >= monitor.bottom - TOLERANCE
}

pub(crate) fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if len <= 0 {
        String::new()
    } else {
        String::from_utf16_lossy(&buffer[..len as usize])
    }
}

/// 电源三态（设计 §13.2）：未知按停绘处理；歌词降帧路径继续用 on_ac_power 兜底。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PowerState {
    Ac,
    Battery,
    Unknown,
}

pub(crate) fn power_state() -> PowerState {
    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
        return PowerState::Unknown;
    }
    // ACLineStatus: 0=离线 1=在线 255=未知。
    match status.ACLineStatus {
        1 => PowerState::Ac,
        0 => PowerState::Battery,
        _ => PowerState::Unknown,
    }
}

/// 交流电供电返回 true；读不到时按交流电处理（歌词降帧路径不额外降帧）。
pub(crate) fn on_ac_power() -> bool {
    power_state() == PowerState::Ac
}

/// 播放器内嵌形态登记的开机启动命令：指向播放器 exe（含 `--window` 与数据目录）。
/// 独立 exe 不设置，沿用 `current_exe()`；进程内只有一个宿主，设置一次即可。
static AUTOSTART_COMMAND: OnceLock<String> = OnceLock::new();
pub(crate) fn set_autostart_command(command: String) {
    let _ = AUTOSTART_COMMAND.set(command);
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
        let command = match AUTOSTART_COMMAND.get() {
            Some(command) => command.clone(),
            None => format!("\"{}\"", std::env::current_exe()?.display()),
        };
        let value = to_wide(&command);
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
    *SINK
        .lock()
        .map_err(|_| anyhow::anyhow!("消息窗口事件槽不可用"))? = Some(Box::new(sink));
    // 进程内宿主可以反复启停：消息窗口线程是本进程单例，重启只换接收方，
    // 既不重复注册窗口类，也不会留下两个会话/电源通知窗口。
    if MESSAGE_THREAD.get().is_some() {
        return Ok(());
    }
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
        .map_err(|_| anyhow::anyhow!("消息窗口启动超时"))??;
    let _ = MESSAGE_THREAD.set(());
    Ok(())
}

/// 宿主退出后清空接收方：会话/电源通知不会再打进已销毁的事件循环。
pub(crate) fn clear_message_sink() {
    if let Ok(mut guard) = SINK.lock() {
        *guard = None;
    }
}

/// 窗口类是进程级资源，同名类重复注册会失败；进程内只注册一次。
unsafe fn ensure_window_class(
    class: &[u16],
    wndproc: WNDPROC,
    cache: &'static OnceLock<Result<(), String>>,
) -> Result<()> {
    cache
        .get_or_init(|| {
            let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
            if instance.is_null() {
                return Err("GetModuleHandleW 失败".into());
            }
            let window_class = WNDCLASSW {
                style: 0,
                lpfnWndProc: wndproc,
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
                Err(format!("RegisterClassW 失败（{}）", unsafe {
                    windows_sys::Win32::Foundation::GetLastError()
                }))
            } else {
                Ok(())
            }
        })
        .as_ref()
        .map_err(|message| anyhow::anyhow!("{message}"))
        .copied()
}

unsafe fn create_message_window() -> Result<()> {
    let class = to_wide("HertzDesktopMessages");
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    if instance.is_null() {
        bail!("GetModuleHandleW 失败");
    }
    ensure_window_class(&class, Some(message_wndproc), &MESSAGE_WINDOW_CLASS)?;
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

/// 全局恢复快捷键的隐藏宿主窗口。RegisterHotKey/WM_HOTKEY 都绑定创建线程；
/// 在主事件循环线程创建，hotkey::Manager 也必须在同一线程调用。
pub(crate) fn install_hotkey_window() -> Result<HWND> {
    let class = to_wide("HertzDesktopHotkey");
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    if instance.is_null() {
        bail!("GetModuleHandleW 失败");
    }
    unsafe { ensure_window_class(&class, Some(hotkey_wndproc), &HOTKEY_WINDOW_CLASS) }?;
    let title = to_wide("HertzDesktopHotkey");
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
        bail!("创建快捷键窗口失败");
    }
    crate::app::log("hotkey window ready");
    Ok(hwnd)
}

unsafe extern "system" fn hotkey_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_HOTKEY {
        emit(NativeEvent::HotkeyFired(wparam as i32));
        return 0;
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
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
    if let Ok(guard) = SINK.lock() {
        if let Some(sink) = guard.as_ref() {
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

/// Keep a candidate composited but unobtrusive until its native first-frame gate opens.
pub(crate) fn wallpaper_opacity(hwnd: HWND, alpha: u8) -> Result<()> {
    unsafe {
        let style = windows_sys::Win32::UI::WindowsAndMessaging::GWL_EXSTYLE;
        let old = GetWindowLongPtrW(hwnd, style) as u32;
        SetWindowLongPtrW(hwnd, style, (old | WS_EX_LAYERED) as isize);
        if SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA) == 0 {
            bail!(
                "设置壁纸候选透明度失败：{}",
                std::io::Error::last_os_error()
            );
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn policy_monitor(name: &str, bounds: [i32; 4]) -> WallpaperMonitor {
        WallpaperMonitor {
            name: name.into(),
            left: bounds[0],
            top: bounds[1],
            width: bounds[2] - bounds[0],
            height: bounds[3] - bounds[1],
            dpi: 96,
            primary: bounds[0] == 0,
            refresh_hz: 60,
            device_path: None,
            edid_digest: None,
        }
    }

    #[test]
    fn foreground_snapshot_only_affects_its_single_or_mirror_monitor() {
        let first = policy_monitor("first", [0, 0, 1920, 1080]);
        let second = policy_monitor("second", [-1440, -200, 0, 2360]);
        let foreground = WallpaperForeground {
            monitor: [-1440, -200, 0, 2360],
            fullscreen: true,
            maximized: true,
            executable: Some(r"c:\apps\player.exe".into()),
        };
        assert_eq!(
            wallpaper_window_state(Some(&foreground), std::slice::from_ref(&first)),
            WallpaperWindowState::default()
        );
        assert_eq!(
            wallpaper_window_state(Some(&foreground), std::slice::from_ref(&second)),
            WallpaperWindowState {
                fullscreen: true,
                maximized: true,
                executable: Some(r"c:\apps\player.exe"),
            }
        );
        assert_eq!(
            wallpaper_window_state(None, &[first, second]),
            WallpaperWindowState::default()
        );
        assert_eq!(
            wallpaper_window_state(Some(&foreground), &[]),
            WallpaperWindowState::default()
        );
    }

    #[test]
    fn span_snapshot_matches_any_member_without_using_the_union_rectangle() {
        let first = policy_monitor("first", [0, 0, 1920, 1080]);
        let second = policy_monitor("second", [1920, 0, 3840, 1080]);
        let foreground = WallpaperForeground {
            monitor: [1920, 0, 3840, 1080],
            fullscreen: false,
            maximized: true,
            executable: Some(r"c:\apps\player.exe".into()),
        };
        let span = wallpaper_window_state(Some(&foreground), &[first, second]);
        assert!(span.maximized);
        assert_eq!(span.executable, Some(r"c:\apps\player.exe"));
        let unrelated = policy_monitor("third", [3840, 0, 5760, 1080]);
        assert_eq!(
            wallpaper_window_state(Some(&foreground), &[unrelated]),
            WallpaperWindowState::default()
        );
    }

    #[test]
    fn unavailable_process_path_preserves_window_state() {
        let monitor = policy_monitor("first", [0, 0, 1920, 1080]);
        let foreground = WallpaperForeground {
            monitor: [0, 0, 1920, 1080],
            fullscreen: true,
            maximized: false,
            executable: None,
        };
        assert_eq!(
            wallpaper_window_state(Some(&foreground), &[monitor]),
            WallpaperWindowState {
                fullscreen: true,
                maximized: false,
                executable: None,
            }
        );
    }

    #[test]
    fn ordinary_maximize_is_independent_of_fullscreen_and_uses_full_monitor_bounds() {
        let monitor = RECT {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
        let work_area = RECT {
            bottom: 1040,
            ..monitor
        };
        assert!(fullscreen_from_facts(false, false, Some(monitor), monitor));
        assert!(!fullscreen_from_facts(false, true, Some(monitor), monitor));
        assert!(!fullscreen_from_facts(
            false,
            false,
            Some(work_area),
            monitor
        ));
        assert!(!fullscreen_from_facts(false, false, None, monitor));
        assert!(fullscreen_from_facts(true, true, Some(monitor), monitor));
        assert!(fullscreen_from_facts(true, false, None, monitor));
        for class in [
            "Progman",
            "WorkerW",
            "Shell_TrayWnd",
            "Shell_SecondaryTrayWnd",
        ] {
            assert!(desktop_shell_class(class));
        }
        assert!(!desktop_shell_class("Chrome_WidgetWin_1"));
    }

    #[test]
    fn fnv1a64_is_stable_and_order_sensitive() {
        assert_eq!(fnv1a64(b""), 0xcbf29ce484222325);
        assert_eq!(fnv1a64(b"a"), 0xaf63dc4c8601ec8c);
        assert_ne!(fnv1a64(b"ab"), fnv1a64(b"ba"));
        assert_eq!(fnv1a64(b"abc"), fnv1a64(b"abc"));
    }

    #[test]
    fn display_id_prefers_device_path_and_edid_digest() {
        let mut monitor = WallpaperMonitor {
            name: r"\.\DISPLAY1".into(),
            left: 0,
            top: 0,
            width: 2560,
            height: 1600,
            dpi: 144,
            primary: true,
            refresh_hz: 144,
            device_path: Some(r"\?\DISPLAY#DEL4026#5&abc#UID4353".into()),
            edid_digest: Some("fnv0164deadbeef".into()),
        };
        assert_eq!(
            monitor.display_id(),
            r"\?\DISPLAY#DEL4026#5&abc#UID4353#fnv0164deadbeef"
        );
        monitor.edid_digest = None;
        assert_eq!(monitor.display_id(), r"\?\DISPLAY#DEL4026#5&abc#UID4353");
        // 查询失败降级为 GDI 名：仅当前枚举有效，不会跨拓扑伪装成稳定身份。
        monitor.device_path = None;
        assert_eq!(monitor.display_id(), r"\.\DISPLAY1");
    }

    #[test]
    fn wide_conversion_round_trips_and_terminates() {
        let wide = to_wide(r"\.\DISPLAY1");
        assert_eq!(wide.last(), Some(&0));
        assert_eq!(from_wide(&wide), r"\.\DISPLAY1");
        assert_eq!(from_wide(&[]), "");
        assert_eq!(from_wide(&[0x4e16, 0]), "世");
    }

    #[test]
    fn browser_title_identity_requires_a_whole_page_title() {
        let title = "山海之间 · hertz-studio";
        assert!(browser_title_matches(title, title));
        assert!(browser_title_matches(
            title,
            &format!("{title} - Google Chrome")
        ));
        assert!(browser_title_matches(
            title,
            &format!("{title} — Mozilla Firefox")
        ));
        assert!(!browser_title_matches(
            title,
            "另一首 · hertz-studio - Google Chrome"
        ));
        assert!(!browser_title_matches(
            title,
            &format!("{title} extra - Google Chrome")
        ));
        assert!(!browser_title_matches(title, "Google Chrome"));
    }
}
