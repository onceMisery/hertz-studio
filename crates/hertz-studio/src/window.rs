// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// R5 原生主窗口（`--window`，feature = native-window）。
//
// 设计与门禁：docs/aegis/specs/2026-11-04-r5-native-main-window-design.md。
// §3 原型清单的代码面：
//   1. Tao event loop 留主线程，整条既有服务 bootstrap + HTTP 原样跑在派生线程；
//   2. WebView 用户数据目录 = <data_dir>/webview/main/，首跳凭据消费服务端的
//      一次性票据 URL（token 不进地址栏）；
//   3. 标题栏、按钮与拖动由系统负责，原生边框/系统菜单/贴靠保留；
//   4. 双实例以 DataDir 内核锁裁决，经鉴权 HTTP 与实例身份聚焦既有窗口；
//   5. DPI = 读数与 ScaleFactorChanged 日志（三档对照为真机人工项）。
// 关闭默认隐藏；用户保存的退出偏好与显式退出统一经原生确认所有者。

use anyhow::Context as _;
use hertz_studio::window_lifecycle::{
    CloseBehavior, Event as LifecycleEvent, Phase, QuitSource, Snapshot, WindowLifecycle,
};
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, StartCause, WindowEvent};
#[cfg(not(windows))]
use tao::event_loop::EventLoopProxy;
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::WebContext;

#[cfg(windows)]
mod file_import;
mod obs_preview;
mod placement;

#[cfg(windows)]
use hertz_desktop::native_events::{self, EventLoopProxy};
use hertz_studio::desktop_tray::{self, HostState};

use super::Args;

/// 服务线程就绪后回传给窗口线程的事实。
pub enum WindowStart {
    /// HTTP 已在实际端口监听。
    Listening {
        bind_ip: std::net::IpAddr,
        port: u16,
        entry_url: String,
        overlay_key: String,
        lifecycle: Arc<WindowLifecycle>,
        importer: hertz_studio::scan::FileImporter,
    },
    /// 服务线程失败（bootstrap 或端口绑定），message 供窗口线程区分双实例情形。
    Failed {
        message: String,
    },
    Focused,
}

#[derive(Debug)]
enum UserEvent {
    /// wry IPC：页面里 window.ipc.postMessage 的 JSON 消息。
    Ipc(String),
    /// 握手通道收到 "focus" 或托盘「打开主窗口」：前置/恢复主窗口。
    FocusWindow,
    /// 托盘歌词设置在已有主窗口内编辑。
    OpenLyricsSettings,
    /// 托盘「退出 hertz-studio」：显式退出命令（§2.2），并轨服务优雅停机。
    QuitRequested,
    Lifecycle(LifecycleEvent),
    NavigationStarted,
    DocumentVerified {
        id: String,
        observed: Option<String>,
        epoch: u64,
    },
    #[cfg(windows)]
    FileImport(file_import::Request),
    #[cfg(windows)]
    FileImportBusy(file_import::Request),
    #[cfg(windows)]
    FileImportReceipt(file_import::Request, Result<(), String>),
    DownloadReceipt {
        url: String,
        status: DownloadStatus,
    },
    /// 托盘探针发现桌面组件状态变化：菜单文案与可用性在主线程跟随。
    DesktopHostState(HostState),
    /// 服务线程结束（None=优雅退出，Some=错误摘要）。
    ServerExited {
        error: Option<String>,
    },
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum DownloadStatus {
    Saved,
    Cancelled,
    Failed,
}

/// 与 SVG / ICO 同源的 64px 图标：H 字母与声波共用一组笔画。
const BRAND_ICON: &[u8] = include_bytes!("../assets/hertz-studio-64.rgba");

/// 桌面胶囊窗口的逻辑尺寸与落点留白（DIP）。原先 364×76 读起来偏大，收成 320×64。
/// 页面排版按同一组数字算（plugin/ui/native-capsule.css）：改这里必须同步改那边，
/// 否则封面、三行文字与传输三键会挤在一起。留白是距屏幕右边 / 底边的距离，
/// 底部多留的一截给系统任务栏。
const CAPSULE_WIDTH: f64 = 320.0;
const CAPSULE_HEIGHT: f64 = 64.0;
const CAPSULE_MARGIN_X: f64 = 24.0;
const CAPSULE_MARGIN_BOTTOM: f64 = 80.0;

struct MainWindowPlacement {
    position: Option<PhysicalPosition<i32>>,
    size: PhysicalSize<u32>,
    maximized: bool,
    #[cfg(target_os = "windows")]
    native: Option<windows_sys::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT>,
}

#[cfg(target_os = "windows")]
fn native_window_placement(
    window: &tao::window::Window,
) -> Option<windows_sys::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT> {
    use tao::platform::windows::WindowExtWindows;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, WINDOWPLACEMENT};
    let mut placement: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
    placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
    (unsafe { GetWindowPlacement(window.hwnd() as _, &mut placement) } != 0).then_some(placement)
}

/// 同一 WebView 缩为桌面胶囊，播放与页面状态不重建。
fn enter_native_capsule(window: &tao::window::Window) -> MainWindowPlacement {
    let placement = MainWindowPlacement {
        position: window.outer_position().ok(),
        size: window.inner_size(),
        maximized: window.is_maximized(),
        #[cfg(target_os = "windows")]
        native: native_window_placement(window),
    };
    let monitor = window.current_monitor();
    window.set_visible(false);
    window.set_maximized(false);
    window.set_decorations(false);
    window.set_min_inner_size(None::<LogicalSize<f64>>);
    window.set_resizable(false);
    window.set_inner_size(LogicalSize::new(CAPSULE_WIDTH, CAPSULE_HEIGHT));
    window.set_always_on_top(true);
    #[cfg(target_os = "windows")]
    {
        use tao::platform::windows::WindowExtWindows;
        use windows_sys::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
        };
        let corner = DWMWCP_ROUND;
        unsafe {
            let _ = DwmSetWindowAttribute(
                window.hwnd() as _,
                DWMWA_WINDOW_CORNER_PREFERENCE as _,
                &corner as *const _ as _,
                std::mem::size_of_val(&corner) as _,
            );
        }
    }
    if let Some(monitor) = monitor {
        let origin = monitor.position();
        let screen = monitor.size();
        let scale = monitor.scale_factor();
        // 为系统任务栏预留空间；原生拖动之后可自由越过原主窗口的边界。
        // 落点 = 尺寸 + 留白，窗口收窄后右边与底边的空隙保持不变。
        window.set_outer_position(PhysicalPosition::new(
            origin.x
                + (screen.width as i32
                    - ((CAPSULE_WIDTH + CAPSULE_MARGIN_X) * scale).round() as i32)
                    .max(0),
            origin.y
                + (screen.height as i32
                    - ((CAPSULE_HEIGHT + CAPSULE_MARGIN_BOTTOM) * scale).round() as i32)
                    .max(0),
        ));
    }
    window.set_visible(true);
    window.set_focus();
    placement
}

fn restore_main_window(window: &tao::window::Window, placement: MainWindowPlacement) {
    window.set_visible(false);
    window.set_always_on_top(false);
    window.set_decorations(true);
    window.set_resizable(true);
    window.set_min_inner_size(Some(LogicalSize::new(720.0, 480.0)));
    window.set_inner_size(placement.size);
    if let Some(position) = placement.position {
        window.set_outer_position(position);
    }
    window.set_maximized(placement.maximized);
    #[cfg(target_os = "windows")]
    if let Some(native) = placement.native {
        use tao::platform::windows::WindowExtWindows;
        // SetWindowPlacement also restores rcNormalPosition. Merely resizing a
        // maximized window leaves the capsule rectangle as its next restore size.
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SetWindowPlacement(
                window.hwnd() as _,
                &native,
            );
        }
    }
    window.set_visible(true);
    window.set_focus();
}

/// Hidden/minimized frames may have transient system geometry. Restore the
/// native owner's last normal snapshot before focus or quit presentation can
/// make that geometry visible and eligible for capture again.
fn prepare_main_recovery(window: &tao::window::Window, lifecycle: &WindowLifecycle) {
    let saved = if !window.is_visible() || window.is_minimized() {
        lifecycle.saved_placement()
    } else {
        None
    };
    window.set_minimized(false);
    if let Some(saved) = saved {
        placement::apply(window, saved);
    } else {
        placement::revalidate(window, false);
    }
}

/// 注入已经就绪的窗口能力；标题栏和按钮由系统提供。
/// 页面不再追加控制条或占用客户区高度，避免和原生标题栏重复。
const HOST_SCRIPT: &str = r#"
(function () {
  var downloads = new Map();
  window.addEventListener('hertz-native-download-result', function (event) {
    var receipt = event.detail;
    var pending = receipt && downloads.get(receipt.url);
    if (!pending) return;
    downloads.delete(receipt.url);
    URL.revokeObjectURL(receipt.url);
    if (receipt.status === 'saved' || receipt.status === 'cancelled') pending.resolve({ status: receipt.status });
    else pending.reject(new Error('文件保存失败，请更换保存位置后重试'));
  });
  function saveTextFile(fileName, contentType, text) {
    if (typeof fileName !== 'string' || !fileName || fileName.length > 255 || /[\/\\\x00]/.test(fileName)
        || typeof contentType !== 'string' || typeof text !== 'string') {
      return Promise.reject(new Error('导出文件参数无效'));
    }
    if (downloads.size >= 4) return Promise.reject(new Error('请先完成正在保存的文件'));
    var url = URL.createObjectURL(new Blob([text], { type: contentType }));
    return new Promise(function (resolve, reject) {
      downloads.set(url, { resolve: resolve, reject: reject });
      var link = document.createElement('a');
      link.href = url; link.download = fileName;
      document.body.appendChild(link);
      try { link.click(); }
      catch (error) { downloads.delete(url); URL.revokeObjectURL(url); reject(error); }
      finally { link.remove(); }
    });
  }
  var documentBytes = crypto.getRandomValues(new Uint8Array(16));
  documentBytes[6] = (documentBytes[6] & 15) | 64; documentBytes[8] = (documentBytes[8] & 63) | 128;
  var documentHex = Array.from(documentBytes, function (value) { return value.toString(16).padStart(2, '0'); }).join('');
  var documentId = documentHex.slice(0,8) + '-' + documentHex.slice(8,12) + '-' + documentHex.slice(12,16) + '-' + documentHex.slice(16,20) + '-' + documentHex.slice(20);
  function post(kind, extra) {
    if (window.ipc) window.ipc.postMessage(JSON.stringify(Object.assign({ kind: kind }, extra || {}, { documentId: documentId })));
  }
  var lifecycleReadyRequested = false;
  window.addEventListener('hertz-native-host-confirmed', function (event) {
    if (event.detail && event.detail.documentId === documentId) {
      if (window.__hertzWindowHost) window.__hertzWindowHost.fileImportReady = true;
      if (lifecycleReadyRequested) post('lifecycle-ready');
    }
  });
  var previewRequest = null;
  window.addEventListener('hertz-native-obs-preview-result', function (event) {
    var receipt = event.detail;
    if (!previewRequest || !receipt || receipt.documentId !== documentId || receipt.requestId !== previewRequest.id) return;
    var pending = previewRequest;
    previewRequest = null;
    clearTimeout(pending.timer);
    if (receipt.status === 'opened') pending.resolve();
    else pending.reject(new Error('歌词预览未能打开，请重试'));
  });
  function openObsPreview(url) {
    if (typeof url !== 'string' || url.length > 384 || !window.ipc) return Promise.reject(new Error('歌词预览地址无效'));
    if (previewRequest) return Promise.reject(new Error('正在打开歌词预览，请稍候'));
    return new Promise(function (resolve, reject) {
      var id = crypto.randomUUID();
      var timer = setTimeout(function () {
        if (!previewRequest || previewRequest.id !== id) return;
        previewRequest = null;
        reject(new Error('歌词预览打开超时，请重试'));
      }, 15000);
      previewRequest = { id: id, resolve: resolve, reject: reject, timer: timer };
      try { post('obs-preview', { requestId: id, url: url }); }
      catch (error) { clearTimeout(timer); previewRequest = null; reject(error); }
    });
  }
  var importRequest = null;
  var fileImportSupported = typeof window.chrome?.webview?.postMessageWithAdditionalObjects === 'function';
  window.addEventListener('hertz-native-import-result', function (event) {
    var receipt = event.detail;
    if (!importRequest || !receipt || receipt.documentId !== documentId || receipt.requestId !== importRequest.id) return;
    var pending = importRequest;
    importRequest = null; clearTimeout(pending.timer);
    if (receipt.status === 'accepted') pending.resolve(receipt);
    else pending.reject(new Error(receipt.error || '音乐导入未能开始，请重试'));
  });
  function importFiles(files) {
    if (!fileImportSupported) return Promise.reject(new Error('当前系统不支持文件拖入，请使用添加目录'));
    var selected = Array.from(files || []);
    if (!selected.length || selected.length > 256 || selected.some(function (file) { return !(file instanceof File); })) {
      return Promise.reject(new Error('请选择 1 至 256 个文件或目录'));
    }
    if (importRequest) return Promise.reject(new Error('正在处理上次导入，请稍候'));
    return new Promise(function (resolve, reject) {
      var id = crypto.randomUUID();
      var timer = setTimeout(function () {
        if (!importRequest || importRequest.id !== id) return;
        importRequest = null; reject(new Error('导入请求响应超时，请查看扫描状态后重试'));
      }, 20000);
      importRequest = { id: id, resolve: resolve, reject: reject, timer: timer };
      try {
        window.chrome.webview.postMessageWithAdditionalObjects(JSON.stringify({ kind: 'import-files', documentId: documentId, requestId: id }), selected);
      } catch (error) { clearTimeout(timer); importRequest = null; reject(error); }
    });
  }
  function setup() {
    try {
      var presentationHidden = true;
      window.__hertzWindowHost = {
        kind: 'window-host',
        documentId: documentId,
        lifecycleVersion: 1,
        presentationVersion: 1,
        get presentationHidden() { return presentationHidden; },
        presentationChanged: function (visible) {
          if (typeof visible !== 'boolean' || presentationHidden === !visible) return;
          presentationHidden = !visible;
          window.dispatchEvent(new CustomEvent('hertz-native-presentation', { detail: { documentId: documentId, hidden: presentationHidden } }));
          document.dispatchEvent(new Event('visibilitychange'));
        },
        downloadVersion: 1,
        obsPreviewVersion: 1,
        fileImportVersion: fileImportSupported ? 1 : 0,
        fileImportReady: false,
        saveTextFile: saveTextFile,
        openObsPreview: openObsPreview,
        importFiles: importFiles,
        lifecycleReady: function () { lifecycleReadyRequested = true; post('lifecycle-ready'); },
        requestQuit: function () { post('quit'); },
        acknowledgeQuit: function (requestId, presentation) { post('quit-presented', { requestId: requestId, presentation: presentation }); },
        confirmQuit: function (requestId, presentation, approve, explicit) { post('quit-decision', { requestId: requestId, presentation: presentation, approve: approve, explicit: explicit === true }); },
        close: function () { post('close'); },
        minimize: function () { post('minimize'); },
        maximizeToggle: function () { post('maximize-toggle'); },
        drag: function () { post('drag'); },
        capsule: function (minimized) { post(minimized ? 'capsule-enter' : 'capsule-exit'); },
      };
      document.documentElement.dataset.hertzWindowHost = '1';
      document.documentElement.dataset.hertzWindowChrome = 'native';
      post('host-ready');
      // 与页面共用底色，保留原生标题栏的拖动、贴靠和系统按钮。
      function syncAppearance() {
        var style = getComputedStyle(document.documentElement);
        post('appearance', { background: style.getPropertyValue('--bg').trim(), foreground: style.getPropertyValue('--text').trim() });
      }
      new MutationObserver(syncAppearance).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      syncAppearance();
      window.dispatchEvent(new Event('hertz-native-host-ready'));
    } catch (error) {
      post('host-error', { message: String(error && error.message || error) });
    }
  }
  // document-created 阶段页面尚未解析：就绪后标记宿主能力。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
"#;

fn service_origin(url: &str) -> Option<String> {
    let parsed: axum::http::Uri = url.parse().ok()?;
    if parsed.scheme_str()? != "http" {
        return None;
    }
    Some(format!("http://{}", parsed.authority()?))
}

fn download_is_trusted(url: &str, origin: &str) -> bool {
    let source = url.strip_prefix("blob:").unwrap_or(url);
    service_origin(source).as_deref() == Some(origin)
}

#[cfg(windows)]
fn pick_download_destination(
    window: &tao::window::Window,
    file_name: &str,
) -> windows::core::Result<Option<std::path::PathBuf>> {
    use std::os::windows::ffi::OsStringExt;
    use tao::platform::windows::WindowExtWindows;
    use windows::core::{HRESULT, HSTRING};
    use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::{
        FileSaveDialog, IFileSaveDialog, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_OVERWRITEPROMPT,
        FOS_PATHMUSTEXIST, SIGDN_FILESYSPATH,
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).ok()?;
        let _apartment = Apartment;
        let dialog: IFileSaveDialog =
            CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(
            dialog.GetOptions()?
                | FOS_FORCEFILESYSTEM
                | FOS_NOCHANGEDIR
                | FOS_OVERWRITEPROMPT
                | FOS_PATHMUSTEXIST,
        )?;
        dialog.SetTitle(&HSTRING::from("保存导出文件"))?;
        dialog.SetFileName(&HSTRING::from(file_name))?;
        match dialog.Show(Some(HWND(window.hwnd() as _))) {
            Ok(()) => {}
            Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => {
                return Ok(None)
            }
            Err(error) => return Err(error),
        }
        let path = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
        let selected = std::ffi::OsString::from_wide(path.as_wide());
        CoTaskMemFree(Some(path.0.cast()));
        Ok(Some(std::path::PathBuf::from(selected)))
    }
}

#[derive(Default)]
struct QuitPresentation {
    navigation_epoch: u64,
    document_id: Option<String>,
    ready: bool,
    request_id: Option<String>,
    presentation: Option<String>,
    deadline: Option<Instant>,
    acknowledged: bool,
    activity_shown: bool,
}

impl QuitPresentation {
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
    fn invalidate_presentation(&mut self) {
        self.presentation = None;
        self.deadline = None;
        self.acknowledged = false;
        self.activity_shown = false;
        self.request_id = None;
    }
    fn reload(&mut self) {
        self.navigation_epoch = self.navigation_epoch.wrapping_add(1);
        self.document_id = None;
        self.ready = false;
        self.invalidate_presentation();
    }
    fn document(&mut self, id: &str) {
        if self.document_id.as_deref() != Some(id) {
            self.reload();
            self.document_id = Some(id.into());
        }
    }
    fn verify_document(&mut self, id: &str, observed: Option<&str>, epoch: u64) -> bool {
        if epoch != self.navigation_epoch || observed != Some(id) {
            return false;
        }
        self.document(id);
        true
    }
    fn arm(&mut self, snapshot: &Snapshot) {
        if snapshot.phase != Phase::Pending {
            return;
        }
        if self.request_id != snapshot.request_id {
            self.invalidate_presentation();
            self.request_id = snapshot.request_id.clone();
            self.deadline = Some(Instant::now() + Duration::from_secs(8));
        }
    }
    fn present(&mut self, webview: &wry::WebView, snapshot: &Snapshot) {
        self.arm(snapshot);
        if snapshot.phase != Phase::Pending || !self.ready || self.presentation.is_some() {
            return;
        }
        let presentation = uuid::Uuid::new_v4().to_string();
        let payload = serde_json::json!({"snapshot":snapshot,"presentation":presentation});
        self.presentation = Some(presentation);
        self.activity_shown = snapshot.needs_confirmation;
        if webview.evaluate_script(&format!("window.dispatchEvent(new CustomEvent('hertz-native-exit-request',{{detail:{payload}}}));")).is_err() {
            self.deadline = Some(Instant::now());
        }
    }
    fn matches(&self, message: &serde_json::Value) -> bool {
        self.document_id.is_some()
            && self.request_id.is_some()
            && self.presentation.is_some()
            && message["documentId"].as_str() == self.document_id.as_deref()
            && message["requestId"].as_str() == self.request_id.as_deref()
            && message["presentation"].as_str() == self.presentation.as_deref()
    }
    fn acknowledge(&mut self, message: &serde_json::Value) {
        if self.matches(message) {
            self.acknowledged = true;
            self.deadline = None;
        }
    }
    fn accepts(&self, message: &serde_json::Value) -> bool {
        self.acknowledged && self.matches(message)
    }
}

fn close_main_window(window: &tao::window::Window, lifecycle: &WindowLifecycle) {
    if lifecycle.snapshot().phase == Phase::Pending {
        return;
    }
    if lifecycle.close_behavior() == CloseBehavior::Hide {
        window.set_visible(false);
    } else {
        lifecycle.request_exit(QuitSource::WindowClose);
    }
}

fn fallback_quit(window: &tao::window::Window) -> Option<bool> {
    let message = "无法确认当前页面的保存状态。退出会停止音乐、结束一起听，并可能中断录制或丢失未保存的修改。\n\n仍然退出 Hertz Studio？";
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowExtWindows;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, IDNO, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_YESNO,
        };
        let text: Vec<_> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<_> = "退出 Hertz Studio".encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            MessageBoxW(
                window.hwnd() as _,
                text.as_ptr(),
                title.as_ptr(),
                MB_YESNO | MB_DEFBUTTON2 | MB_ICONWARNING,
            )
        };
        match result {
            IDYES => Some(true),
            IDNO => Some(false),
            _ => None,
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        Some(
            rfd::MessageDialog::new()
                .set_title("退出 Hertz Studio")
                .set_description(message)
                .set_buttons(rfd::MessageButtons::YesNo)
                .show()
                == rfd::MessageDialogResult::Yes,
        )
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (window, message);
        None
    }
}

/// 标题栏只同步颜色，系统继续拥有窗口尺寸、按钮和命中测试。
#[cfg(target_os = "windows")]
fn sync_window_appearance(window: &tao::window::Window, message: &serde_json::Value) {
    use tao::platform::windows::WindowExtWindows;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
    };
    fn color(value: Option<&serde_json::Value>) -> Option<u32> {
        let hex = value?.as_str()?.strip_prefix('#')?;
        if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let rgb = u32::from_str_radix(hex, 16).ok()?;
        Some(((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff))
    }
    let (Some(background), Some(foreground)) = (
        color(message.get("background")),
        color(message.get("foreground")),
    ) else {
        return;
    };
    let bright = (background & 0xff) * 213
        + ((background >> 8) & 0xff) * 715
        + ((background >> 16) & 0xff) * 72;
    window.set_theme(Some(if bright < 150_000 {
        tao::window::Theme::Dark
    } else {
        tao::window::Theme::Light
    }));
    // Windows 11 支持自定义标题栏颜色；旧系统沿用上面的深浅外观。
    for (attribute, value) in [
        (DWMWA_CAPTION_COLOR, background),
        (DWMWA_TEXT_COLOR, foreground),
        (DWMWA_BORDER_COLOR, background),
    ] {
        unsafe {
            let _ = DwmSetWindowAttribute(
                window.hwnd() as _,
                attribute as _,
                &value as *const u32 as _,
                std::mem::size_of::<u32>() as _,
            );
        }
    }
}

/// 是否要把这次探测结果发布给菜单。None = 尚未发布过：菜单此刻仍是构建时的
/// 初始文案与置灰态，所以首拍必须无条件落地一次；否则组件恰好未运行时
/// 「切换成桌面歌词模式」会永远点不到（初值与事实相同 → 判成无变化）。
fn next_host_state(last: Option<HostState>, current: HostState) -> Option<HostState> {
    (last != Some(current)).then_some(current)
}

/// 把探测结果并入共享事实；状态变化时经事件送达主线程（菜单只能在主线程改）。
fn publish_host_state(
    proxy: &EventLoopProxy<UserEvent>,
    shared: &std::sync::Mutex<Option<HostState>>,
) {
    let current = desktop_tray::probe();
    let changed = {
        let mut guard = shared.lock().expect("托盘桌面组件状态锁");
        match next_host_state(*guard, current) {
            Some(next) => {
                *guard = Some(next);
                true
            }
            None => false,
        }
    };
    if changed {
        let _ = proxy.send_event(UserEvent::DesktopHostState(current));
    }
}

/// 动作后的快速复探：组件启停有秒级时差，不等 2 秒周期再刷新菜单。
fn reprobe_desktop_host(
    proxy: &EventLoopProxy<UserEvent>,
    shared: &std::sync::Mutex<Option<HostState>>,
) {
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(350));
        publish_host_state(proxy, shared);
    }
}

/// `--window` 入口：服务线程 + 主线程窗口 + 托盘。调用前 args.window 必为 true。
pub fn run_window(mut args: Args) -> anyhow::Result<()> {
    // 托盘由本进程统一持有：进程内桌面宿主不再另建托盘图标，也不用抢占
    // 进程级的菜单/托盘事件处理器。
    hertz_studio::desktop_host::set_player_tray(true);
    // Win32 类回调在进程内共享；与桌面宿主保持同一个 Tao 类型。
    #[cfg(windows)]
    let display_changed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    #[cfg(windows)]
    let event_loop = {
        use tao::platform::windows::EventLoopBuilderExtWindows;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MSG, WM_DISPLAYCHANGE, WM_SETTINGCHANGE,
        };
        let changed = Arc::clone(&display_changed);
        let mut builder = EventLoopBuilder::<()>::new();
        builder.with_msg_hook(move |message| {
            let message = unsafe { &*(message as *const MSG) };
            if matches!(message.message, WM_DISPLAYCHANGE | WM_SETTINGCHANGE) {
                changed.store(true, std::sync::atomic::Ordering::Release);
            }
            false
        });
        builder.build()
    };
    #[cfg(windows)]
    let (proxy, events) = native_events::channel(event_loop.create_proxy());
    #[cfg(not(windows))]
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    #[cfg(not(windows))]
    let proxy = event_loop.create_proxy();

    // Configuration is loaded only by prepare after acquiring the DataDir lock.
    let data_dir = hertz_studio::bootstrap::absolute_data_dir(
        args.data_dir
            .clone()
            .unwrap_or_else(hertz_studio::config::default_data_dir)
            .as_path(),
    )?;

    // 服务线程：整条 bootstrap（数据库迁移、音频初始化、HTTP）原样跑在派生线程。
    let (start_tx, start_rx) = channel::<WindowStart>();
    args.notify = Some(start_tx.clone());
    let proxy_for_server = proxy.clone();
    let server_thread = std::thread::Builder::new()
        .name("hertz-studio-server".into())
        .spawn(move || {
            let outcome = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => {
                    let result = runtime.block_on(super::run(args));
                    runtime.shutdown_timeout(Duration::from_secs(3));
                    result.err().map(|error| error.to_string())
                }
                Err(error) => Some(error.to_string()),
            };
            let _ = start_tx.send(WindowStart::Failed {
                message: outcome.clone().unwrap_or_default(),
            });
            let _ = proxy_for_server.send_event(UserEvent::ServerExited { error: outcome });
        })
        .context("启动服务线程失败")?;

    // 等待服务就绪（bootstrap 含迁移与音频初始化；上限 90 秒）。
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    let started = loop {
        match start_rx.try_recv() {
            Ok(WindowStart::Listening {
                bind_ip,
                port,
                entry_url,
                overlay_key,
                lifecycle,
                importer,
            }) => {
                break (bind_ip, port, entry_url, overlay_key, lifecycle, importer);
            }
            Ok(WindowStart::Focused) => {
                let _ = server_thread.join();
                println!("hertz-studio 已在运行：已恢复此资料目录的原生主窗口");
                return Ok(());
            }
            Ok(WindowStart::Failed { message }) => {
                anyhow::bail!("启动播放器失败：{message}");
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                if server_thread.is_finished() {
                    anyhow::bail!("服务线程在就绪前退出（详见日志）");
                }
                if std::time::Instant::now() > deadline {
                    anyhow::bail!("等待服务就绪超时（90 秒）");
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                anyhow::bail!("服务线程意外终止（详见日志）");
            }
        }
    };
    let (bind_ip, port, entry_url, overlay_key, lifecycle, importer) = started;
    #[cfg(not(windows))]
    let _ = importer;
    println!("  window   http://{bind_ip}:{port}/  （原生主窗口形态；关闭窗口=隐藏到托盘）");

    // 托盘（设计 §2.2）：左键开菜单之外，「打开主窗口」承担隐藏后的恢复入口，
    // 「退出 hertz-studio」是唯一由窗口侧发起的显式退出命令。
    // 桌面组件段：模式开关（切换成桌面歌词模式 ⇄ 退出桌面歌词）+ 常用动作，
    // 全部走 lib 侧 desktop_tray 控制面；文案与可用性由探针线程经
    // DesktopHostState 事件驱动，在事件循环（主线程）里落菜单。
    let tray_menu = tray_icon::menu::Menu::new();
    let tray_open = tray_icon::menu::MenuItem::with_id("hz-open", "打开主窗口", true, None);
    let tray_desktop_mode =
        tray_icon::menu::MenuItem::with_id("hz-desktop-mode", "切换成桌面歌词模式", false, None);
    let tray_lyrics_locate =
        tray_icon::menu::MenuItem::with_id("hz-lyrics-locate", "解锁并定位歌词", false, None);
    let tray_lyrics_show =
        tray_icon::menu::MenuItem::with_id("hz-lyrics-show", "显示/隐藏桌面歌词", false, None);
    let tray_wallpaper_toggle =
        tray_icon::menu::MenuItem::with_id("hz-wallpaper-toggle", "显示/隐藏桌面壁纸", false, None);
    let tray_wallpaper_retry =
        tray_icon::menu::MenuItem::with_id("hz-wallpaper-retry", "重新挂载桌面壁纸", false, None);
    let tray_wallpaper_exit =
        tray_icon::menu::MenuItem::with_id("hz-wallpaper-exit", "退出桌面壁纸", false, None);
    let tray_desktop_exit =
        tray_icon::menu::MenuItem::with_id("hz-desktop-exit", "退出桌面组件", false, None);
    let tray_mini_toggle =
        tray_icon::menu::MenuItem::with_id("hz-mini-toggle", "小窗播放（桌面宠物）", false, None);
    let tray_lyrics_settings =
        tray_icon::menu::MenuItem::with_id("hz-lyrics-settings", "桌面歌词设置", true, None);
    let tray_wallpaper_settings =
        tray_icon::menu::MenuItem::with_id("hz-wallpaper-settings", "桌面壁纸设置", false, None);
    let tray_quit = tray_icon::menu::MenuItem::with_id("hz-quit", "退出 hertz-studio", true, None);
    tray_menu
        .append_items(&[
            &tray_open,
            &tray_icon::menu::PredefinedMenuItem::separator(),
            &tray_desktop_mode,
            &tray_lyrics_locate,
            &tray_lyrics_show,
            &tray_lyrics_settings,
            &tray_wallpaper_toggle,
            &tray_wallpaper_retry,
            &tray_wallpaper_exit,
            &tray_mini_toggle,
            &tray_wallpaper_settings,
            &tray_desktop_exit,
            &tray_icon::menu::PredefinedMenuItem::separator(),
            &tray_quit,
        ])
        .context("构建托盘菜单失败")?;
    let _tray = tray_icon::TrayIconBuilder::new()
        .with_id("hertz-studio")
        .with_menu(Box::new(tray_menu))
        .with_menu_on_left_click(false)
        .with_tooltip("hertz-studio（原生主窗口）")
        .with_icon(tray_icon::Icon::from_rgba(BRAND_ICON.to_vec(), 64, 64)?)
        .build()
        .context("创建托盘图标失败")?;
    let proxy_for_tray = proxy.clone();
    let host_state = std::sync::Arc::new(std::sync::Mutex::new(None));
    let host_state_for_probe = host_state.clone();
    let data_dir_for_tray = data_dir.clone();
    std::thread::Builder::new()
        .name("hertz-studio-tray".into())
        .spawn(move || {
            let receiver = tray_icon::menu::MenuEvent::receiver();
            // 歌词显隐是托盘本地的二态开关；宿主自己也接受同样的 show/hide 动词。
            let mut lyrics_hidden = false;
            for event in receiver.iter() {
                match event.id().as_ref() {
                    "hz-open" => {
                        let _ = proxy_for_tray.send_event(UserEvent::FocusWindow);
                    }
                    "hz-desktop-mode" => {
                        // 按探针事实切换：运行中→退出宿主；未运行→在同一进程
                        // 拉起宿主（歌词/壁纸按宿主自身配置自启）。
                        let outcome = match *host_state.lock().expect("托盘桌面组件状态锁")
                        {
                            Some(HostState::Running { lyrics: true, .. }) => {
                                desktop_tray::command("lyrics-exit")
                            }
                            Some(HostState::Running { lyrics: false, .. })
                            | Some(HostState::Stopped) => desktop_tray::spawn(&data_dir_for_tray),
                            None | Some(HostState::Unavailable) => {
                                Err("桌面状态暂不可用，请稍后重试".into())
                            }
                        };
                        if let Err(error) = outcome {
                            eprintln!("[tray] 桌面歌词模式切换失败：{error}");
                        }
                        reprobe_desktop_host(&proxy_for_tray, &host_state);
                    }
                    "hz-lyrics-locate" => {
                        // 先解锁（退出鼠标穿透），再把歌词窗带回可视区。
                        let _ = desktop_tray::command("unlock");
                        if let Err(error) = desktop_tray::command("locate") {
                            eprintln!("[tray] 解锁并定位歌词失败：{error}");
                        }
                    }
                    "hz-lyrics-show" => {
                        let name = if lyrics_hidden { "show" } else { "hide" };
                        if let Err(error) = desktop_tray::command(name) {
                            eprintln!("[tray] 歌词显隐切换失败：{error}");
                        } else {
                            lyrics_hidden = !lyrics_hidden;
                        }
                    }
                    "hz-wallpaper-toggle" => {
                        if let Err(error) = desktop_tray::command("wallpaper-toggle") {
                            eprintln!("[tray] 壁纸显隐切换失败：{error}");
                        }
                    }
                    "hz-wallpaper-retry" => {
                        if let Err(error) = desktop_tray::command("wallpaper-retry") {
                            eprintln!("[tray] 重新挂载壁纸失败：{error}");
                        }
                    }
                    "hz-wallpaper-exit" | "hz-desktop-exit" => {
                        let name = if event.id.0 == "hz-wallpaper-exit" {
                            "wallpaper-exit"
                        } else {
                            "quit"
                        };
                        if let Err(error) = desktop_tray::command(name) {
                            eprintln!("[tray] 桌面退出失败：{error}");
                        }
                        reprobe_desktop_host(&proxy_for_tray, &host_state);
                    }
                    "hz-mini-toggle" => {
                        if let Err(error) = desktop_tray::command("mini-toggle") {
                            eprintln!("[tray] 小窗播放切换失败：{error}");
                        }
                    }
                    "hz-lyrics-settings" => {
                        let _ = proxy_for_tray.send_event(UserEvent::OpenLyricsSettings);
                    }
                    "hz-wallpaper-settings" => {
                        if let Err(error) = desktop_tray::command("wallpaper-settings") {
                            eprintln!("[tray] 打开桌面歌词与壁纸设置失败：{error}");
                        }
                    }
                    "hz-quit" => {
                        let _ = proxy_for_tray.send_event(UserEvent::QuitRequested);
                    }
                    // 宿主的小窗右键菜单也走这个全局菜单通道；播放器有托盘时
                    // 宿主不安装自己的处理器，这里原样转回进程内宿主。
                    _ => {
                        let id = event.id().as_ref();
                        if id.starts_with("mini-context-") {
                            if let Err(error) = hertz_studio::desktop_host::menu_event(id) {
                                eprintln!("[tray] 小窗菜单转发失败：{error:#}");
                            }
                        }
                    }
                }
            }
        })
        .context("启动托盘事件线程失败")?;
    // 托盘图标左键：窗口最小化 / 隐藏到托盘之后，单击图标就该把主窗口带回来。
    // 菜单点击走 MenuEvent 全局通道，图标点击走 TrayIconEvent 全局通道，两条
    // 互不相干；只接前者就是「点图标没反应，只能右键再点『打开主窗口』」。
    // with_menu_on_left_click(false) 是有意的：左键专用于恢复窗口，右键才弹菜单。
    // 进程内宿主在 player_tray=true 时不安装自己的全局 handler（见
    // desktop_host::set_player_tray），所以这里能收到同一进程的托盘点击事件。
    let proxy_for_tray_click = proxy.clone();
    std::thread::Builder::new()
        .name("hertz-studio-tray-click".into())
        .spawn(move || {
            for event in tray_icon::TrayIconEvent::receiver().iter() {
                if let tray_icon::TrayIconEvent::Click {
                    button: tray_icon::MouseButton::Left,
                    button_state: tray_icon::MouseButtonState::Up,
                    ..
                } = event
                {
                    let _ = proxy_for_tray_click.send_event(UserEvent::FocusWindow);
                }
            }
        })
        .context("启动托盘点击线程失败")?;
    // 探针线程：周期把桌面组件事实送到菜单；首拍立即执行，菜单从一开始就正确。
    let proxy_for_probe = proxy.clone();
    std::thread::Builder::new()
        .name("hertz-studio-tray-probe".into())
        .spawn(move || loop {
            publish_host_state(&proxy_for_probe, &host_state_for_probe);
            std::thread::sleep(Duration::from_secs(2));
        })
        .context("启动托盘探针线程失败")?;

    // 主线程窗口：保留原生装饰（设计 §2.5 红线——不用 OVERLAY_FRAME_STYLES）。
    let window_icon = tao::window::Icon::from_rgba(BRAND_ICON.to_vec(), 64, 64)?;
    let window_builder = WindowBuilder::new()
        .with_title("HertzStudio Music Player")
        .with_window_icon(Some(window_icon.clone()))
        .with_visible(false)
        .with_inner_size(LogicalSize::new(1280.0, 800.0));
    #[cfg(target_os = "windows")]
    let window_builder = {
        use tao::platform::windows::WindowBuilderExtWindows;
        window_builder.with_taskbar_icon(Some(window_icon))
    };
    let window = Arc::new(window_builder.build(&event_loop)?);
    if let Some(saved) = lifecycle
        .saved_placement()
        .or_else(|| placement::capture(&window, true))
    {
        placement::apply(&window, saved);
    }
    println!("  display  scale_factor={}", window.scale_factor());

    // WebView 用户数据目录：<data_dir>/webview/main/（§2.3，与桌面组件互斥隔离）。
    let mut web_context = WebContext::new(Some(data_dir.join("webview").join("main")));
    let proxy_for_ipc = proxy.clone();
    let origin = service_origin(&entry_url).context("原生窗口服务地址无效")?;
    let ipc_origin = origin.clone();
    let download_origin = origin.clone();
    let navigation_origin = origin.clone();
    let proxy_for_navigation = proxy.clone();
    let window_for_download = window.clone();
    let proxy_for_download_start = proxy.clone();
    let proxy_for_download_complete = proxy.clone();
    let webview = wry::WebViewBuilder::new_with_web_context(&mut web_context)
        .with_url(&entry_url)
        .with_initialization_script(HOST_SCRIPT)
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_navigation_handler(move |url| {
            let allowed = service_origin(&url).as_ref() == Some(&navigation_origin);
            if allowed {
                let _ = proxy_for_navigation.send_event(UserEvent::NavigationStarted);
            }
            allowed
        })
        .with_ipc_handler(move |request| {
            let body = request.body();
            if body.len() <= 512
                && service_origin(&request.uri().to_string()).as_ref() == Some(&ipc_origin)
            {
                let _ = proxy_for_ipc.send_event(UserEvent::Ipc(body.clone()));
            }
        })
        .with_download_started_handler(move |url, destination| {
            if !download_is_trusted(&url, &download_origin) {
                let _ = proxy_for_download_start.send_event(UserEvent::DownloadReceipt {
                    url,
                    status: DownloadStatus::Failed,
                });
                return false;
            }
            #[cfg(any(windows, target_os = "macos"))]
            {
                let file_name = destination
                    .file_name()
                    .and_then(|name| name.to_str())
                    .filter(|name| !name.is_empty())
                    .unwrap_or("export.txt");
                #[cfg(windows)]
                let selection = pick_download_destination(window_for_download.as_ref(), file_name);
                #[cfg(target_os = "macos")]
                let selection: Result<
                    Option<std::path::PathBuf>,
                    std::convert::Infallible,
                > = Ok(rfd::FileDialog::new()
                    .set_parent(window_for_download.as_ref())
                    .set_title("保存导出文件")
                    .set_file_name(file_name)
                    .save_file());
                let status = match selection {
                    Ok(Some(selected)) => {
                        *destination = selected;
                        return true;
                    }
                    Ok(None) => DownloadStatus::Cancelled,
                    Err(error) => {
                        tracing::warn!(%error, "打开导出保存对话框失败");
                        DownloadStatus::Failed
                    }
                };
                let _ =
                    proxy_for_download_start.send_event(UserEvent::DownloadReceipt { url, status });
                false
            }
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                let _ = (&window_for_download, destination);
                let _ = proxy_for_download_start.send_event(UserEvent::DownloadReceipt {
                    url,
                    status: DownloadStatus::Failed,
                });
                false
            }
        })
        .with_download_completed_handler(move |url, _, success| {
            let _ = proxy_for_download_complete.send_event(UserEvent::DownloadReceipt {
                url,
                status: if success {
                    DownloadStatus::Saved
                } else {
                    DownloadStatus::Failed
                },
            });
        })
        .build(window.as_ref())
        .map_err(|error| {
            anyhow::anyhow!("创建 WebView2 失败：{error}（请确认 WebView2 Runtime 已安装）")
        })?;
    #[cfg(windows)]
    let file_import_handler = file_import::install(&webview, &origin, proxy.clone())?;
    let mut main_placement: Option<MainWindowPlacement> = None;
    #[cfg(windows)]
    let mut dpi_changed = false;
    let mut quit_ui = QuitPresentation::default();
    let mut obs_preview = None;
    #[cfg(windows)]
    let mut import_pending = false;
    let mut owner = Some(lifecycle.attach_host().map_err(anyhow::Error::msg)?);
    #[cfg(windows)]
    {
        use tao::platform::windows::WindowExtWindows;
        lifecycle.start_system_media(window.hwnd());
    }
    let lifecycle_proxy = proxy.clone();
    lifecycle.set_sink(Box::new(move |event| {
        let event = match event {
            LifecycleEvent::FocusRequested => UserEvent::FocusWindow,
            event => UserEvent::Lifecycle(event),
        };
        let _ = lifecycle_proxy.send_event(event);
    }));
    window.set_visible(true);
    let mut main_webview_visible = true;
    let mut main_presentation_state: Option<(String, bool)> = None;
    placement::record(&window, owner.as_ref(), false);

    println!(
        "  webview  数据目录 {}",
        data_dir.join("webview").join("main").display()
    );
    println!("  tray     打开主窗口 / 桌面歌词模式开关 / 退出 hertz-studio");

    // 开机启动偏好现在登记的是播放器自己。播放器启动后由它决定是否在
    // 本进程拉起桌面宿主，不再有一个外部 exe 在登录时悄悄开另一个窗口。
    // 放在主窗口 WebView 之后：宿主自己的 WebView 数据目录不会污染主窗口。
    #[cfg(windows)]
    if hertz_desktop::autostart_enabled() {
        let data_dir_for_host = data_dir.clone();
        std::thread::Builder::new()
            .name("hertz-studio-desktop-autostart".into())
            .spawn(move || {
                if let Err(error) = hertz_studio::desktop_host::ensure_started(&data_dir_for_host) {
                    eprintln!("[window] 开机启动桌面歌词失败：{error:#}");
                }
            })
            .ok();
    }

    event_loop.run(move |event, _target, control_flow| {
        let _owner = &owner;
        *control_flow = quit_ui.deadline().map_or(ControlFlow::Wait, ControlFlow::WaitUntil);
        #[cfg(windows)]
        let Some(event) = events.map_event(event) else { return; };
        let update_presentation = matches!(&event, Event::MainEventsCleared);
        match event {
            Event::NewEvents(StartCause::Init) => {
                println!("  display  event loop 就绪");
            }
            Event::NewEvents(StartCause::ResumeTimeReached { .. }) => {
                if quit_ui.deadline().is_some_and(|deadline| Instant::now() >= deadline) {
                    let snapshot = lifecycle.snapshot();
                    quit_ui.invalidate_presentation();
                    if snapshot.phase == Phase::Pending {
                        if let Some(id) = snapshot.request_id {
                            match fallback_quit(&window) {
                                Some(approve) => { lifecycle.confirm_presented(&id, approve, true); }
                                None => { lifecycle.fail_pending(&id, "native dialog unavailable"); }
                            }
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::Ipc(body)) => {
                let Ok(message) = serde_json::from_str::<serde_json::Value>(&body) else { return; };
                let kind = message.get("kind").and_then(serde_json::Value::as_str).unwrap_or_default();
                let document_id = message.get("documentId").and_then(serde_json::Value::as_str).filter(|id| uuid::Uuid::parse_str(id).is_ok());
                if kind == "host-ready" {
                    if let Some(id) = document_id {
                        let id = id.to_owned();
                        let epoch = quit_ui.navigation_epoch;
                        let confirmed_proxy = proxy.clone();
                        let _ = webview.evaluate_script_with_callback("(window.__hertzWindowHost || {}).documentId", move |value| {
                            let observed = serde_json::from_str::<Option<String>>(&value).ok().flatten();
                            let _ = confirmed_proxy.send_event(UserEvent::DocumentVerified { id: id.clone(), observed, epoch });
                        });
                    }
                    return;
                }
                if document_id.is_none() || document_id != quit_ui.document_id.as_deref() { return; }
                match kind {
                    "obs-preview" => {
                        let Some(request_id) = message.get("requestId").and_then(serde_json::Value::as_str)
                            .filter(|id| uuid::Uuid::parse_str(id).is_ok()) else { return; };
                        let result = if !lifecycle.background_playback_active()
                            || matches!(lifecycle.snapshot().phase, Phase::Pending | Phase::Exiting) {
                            Err("main window is quitting")
                        } else {
                            obs_preview::ObsPreview::open(&mut obs_preview, _target, &data_dir,
                                message.get("url").and_then(serde_json::Value::as_str).unwrap_or_default(),
                                &origin, &overlay_key)
                        };
                        if let Err(error) = result { tracing::warn!(error, "native OBS preview request failed"); }
                        let receipt = serde_json::json!({ "documentId": document_id, "requestId": request_id,
                            "status": if result.is_ok() { "opened" } else { "failed" } });
                        let _ = webview.evaluate_script(&format!(
                            "window.dispatchEvent(new CustomEvent('hertz-native-obs-preview-result',{{detail:{receipt}}}));"
                        ));
                    }
                    "drag" => {
                        let _ = window.drag_window();
                    }
                    "minimize" => window.set_minimized(true),
                    "maximize-toggle" => {
                        if window.is_maximized() {
                            window.set_maximized(false);
                        } else {
                            window.set_maximized(true);
                        }
                    }
                    "close" => {
                        placement::record(&window, owner.as_ref(), main_placement.is_some());
                        close_main_window(&window, &lifecycle);
                    }
                    "quit" => { lifecycle.request_exit(QuitSource::Toolbar); }
                    "lifecycle-ready" => {
                        quit_ui.ready = true;
                        quit_ui.present(&webview, &lifecycle.snapshot());
                    }
                    "quit-presented" => { quit_ui.acknowledge(&message); }
                    "quit-decision" => {
                        if quit_ui.accepts(&message) {
                            if let Some(approve) = message.get("approve").and_then(serde_json::Value::as_bool) {
                                let request_id = quit_ui.request_id.clone().expect("presented request");
                                let activity_shown = quit_ui.activity_shown;
                                quit_ui.invalidate_presentation();
                                if approve && message["explicit"].as_bool() != Some(true) {
                                    lifecycle.confirm_idle(&request_id);
                                } else {
                                    lifecycle.confirm_presented(&request_id, approve, activity_shown);
                                }
                            }
                        }
                    }
                    "capsule-enter" => {
                        if main_placement.is_none() {
                            placement::record(&window, owner.as_ref(), false);
                            main_placement = Some(enter_native_capsule(&window));
                        }
                    }
                    "capsule-exit" => {
                        if let Some(placement) = main_placement.take() {
                            restore_main_window(&window, placement);
                            placement::revalidate(&window, false);
                            placement::record(&window, owner.as_ref(), false);
                        }
                    }
                    _ =>
                    {
                        #[cfg(target_os = "windows")]
                        if kind == "appearance" {
                            sync_window_appearance(&window, &message);
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::DownloadReceipt { url, status }) => {
                let receipt = serde_json::json!({ "url": url, "status": status });
                let _ = webview.evaluate_script(&format!(
                    "window.dispatchEvent(new CustomEvent('hertz-native-download-result', {{detail:{receipt}}}));"
                ));
            }
            #[cfg(windows)]
            Event::UserEvent(UserEvent::FileImportBusy(request)) => {
                if quit_ui.document_id.as_deref() == Some(&request.document_id) {
                    file_import::receipt(&webview, &request, Err("正在处理上次导入，请稍候".into()));
                }
            }
            #[cfg(windows)]
            Event::UserEvent(UserEvent::FileImport(request)) => {
                let Some(objects) = file_import_handler.take(&request) else { return; };
                if quit_ui.document_id.as_deref() != Some(&request.document_id) { return; }
                let error = if import_pending { Some("正在处理上次导入，请稍候") }
                    else if !lifecycle.background_playback_active()
                        || matches!(lifecycle.snapshot().phase, Phase::Pending | Phase::Exiting) {
                        Some("播放器正在退出，请取消退出后重试")
                    } else { None };
                if let Some(error) = error {
                    file_import::receipt(&webview, &request, Err(error.into()));
                } else {
                    match file_import::extract_paths(&objects) {
                        Err(error) => file_import::receipt(&webview, &request, Err(error)),
                        Ok(paths) => {
                            import_pending = true;
                            let completion_proxy = proxy.clone();
                            importer.start(paths, move |result| {
                                let _ = completion_proxy.send_event(UserEvent::FileImportReceipt(request, result));
                            });
                        }
                    }
                }
            }
            #[cfg(windows)]
            Event::UserEvent(UserEvent::FileImportReceipt(request, result)) => {
                import_pending = false;
                if quit_ui.document_id.as_deref() == Some(&request.document_id) {
                    file_import::receipt(&webview, &request, result);
                }
            }
            Event::UserEvent(UserEvent::NavigationStarted) => {
                quit_ui.reload();
                quit_ui.arm(&lifecycle.snapshot());
            }
            Event::UserEvent(UserEvent::DocumentVerified { id, observed, epoch }) => {
                if !quit_ui.verify_document(&id, observed.as_deref(), epoch) { return; }
                quit_ui.arm(&lifecycle.snapshot());
                if let Some(placement) = main_placement.take() {
                    restore_main_window(&window, placement);
                    placement::revalidate(&window, false);
                    placement::record(&window, owner.as_ref(), false);
                }
                let payload = serde_json::json!({"documentId":id});
                let _ = webview.evaluate_script(&format!(
                    "window.dispatchEvent(new CustomEvent('hertz-native-host-confirmed',{{detail:{payload}}}));"
                ));
            }
            Event::UserEvent(UserEvent::Lifecycle(LifecycleEvent::FlushPlacement(complete))) => {
                placement::record(&window, owner.as_ref(), main_placement.is_some());
                if let Some(owner) = owner.as_ref() { owner.seal_placement(); }
                if let Some(complete) = complete.lock().unwrap_or_else(|error| error.into_inner()).take() {
                    let _ = complete.send(());
                }
            }
            Event::UserEvent(UserEvent::Lifecycle(_event)) => {
                let snapshot = lifecycle.snapshot();
                if snapshot.phase == Phase::Pending {
                    if let Some(placement) = main_placement.take() {
                        let _ = webview.evaluate_script("window.dispatchEvent(new Event('hertz-native-capsule-restore'));");
                        restore_main_window(&window, placement);
                    }
                    prepare_main_recovery(&window, &lifecycle);
                    window.set_visible(true); window.set_focus();
                    quit_ui.present(&webview, &snapshot);
                } else {
                    quit_ui.invalidate_presentation();
                    let payload = serde_json::to_string(&snapshot).expect("lifecycle snapshot");
                    let _ = webview.evaluate_script(&format!("window.dispatchEvent(new CustomEvent('hertz-native-exit-state',{{detail:{payload}}}));"));
                }
            }
            Event::UserEvent(action @ (UserEvent::FocusWindow | UserEvent::OpenLyricsSettings)) => {
                let open_lyrics = matches!(action, UserEvent::OpenLyricsSettings);
                if let Some(placement) = main_placement.take() {
                    let _ = webview.evaluate_script(
                        "window.dispatchEvent(new Event('hertz-native-capsule-restore'));",
                    );
                    restore_main_window(&window, placement);
                }
                prepare_main_recovery(&window, &lifecycle);
                window.set_visible(true);
                window.set_focus();
                placement::record(&window, owner.as_ref(), false);
                if open_lyrics {
                    let _ = webview.evaluate_script(
                        "window.dispatchEvent(new Event('hertz-open-desktop-lyrics-settings'));",
                    );
                }
            }
            Event::UserEvent(UserEvent::DesktopHostState(state)) => {
                // muda 菜单只能在创建它的线程（这里）变更：文案与可用性跟随探测事实。
                let (label, mode_enabled, actions_enabled, lyrics_enabled, wallpaper_enabled) = match state {
                    HostState::Running { lyrics, wallpaper } => (
                        if lyrics { "退出桌面歌词" } else { "切换成桌面歌词模式" },
                        true, true, lyrics, wallpaper,
                    ),
                    HostState::Stopped => ("切换成桌面歌词模式", true, false, false, false),
                    HostState::Unavailable => ("桌面歌词状态暂不可用", false, true, false, false),
                };
                tray_desktop_mode.set_text(label);
                tray_desktop_mode.set_enabled(mode_enabled);
                tray_lyrics_locate.set_enabled(actions_enabled);
                tray_lyrics_show.set_enabled(lyrics_enabled);
                tray_wallpaper_toggle.set_enabled(wallpaper_enabled);
                tray_wallpaper_retry.set_enabled(wallpaper_enabled);
                tray_wallpaper_exit.set_enabled(wallpaper_enabled);
                tray_desktop_exit.set_enabled(actions_enabled);
                tray_mini_toggle.set_enabled(actions_enabled);
                tray_wallpaper_settings.set_enabled(actions_enabled);
            }
            Event::UserEvent(UserEvent::QuitRequested) => {
                lifecycle.request_exit(QuitSource::Tray);
            }
            Event::UserEvent(UserEvent::ServerExited { error }) => {
                obs_preview.take();
                // 服务生命周期=进程生命周期（§2.1）：服务线程结束即退出事件循环。
                if let Some(message) = error {
                    eprintln!("hertz-studio 服务已退出：{message}");
                }
                *control_flow = ControlFlow::Exit;
            }
            Event::WindowEvent {
                window_id,
                event: WindowEvent::CloseRequested { .. },
                ..
            } if window_id == window.id() => {
                placement::record(&window, owner.as_ref(), main_placement.is_some());
                close_main_window(&window, &lifecycle);
            }
            Event::WindowEvent { window_id, event: WindowEvent::CloseRequested { .. }, .. }
                if obs_preview.as_ref().is_some_and(|preview| preview.id() == window_id) => {
                obs_preview.take();
            }
            Event::WindowEvent {
                window_id,
                event: WindowEvent::ScaleFactorChanged { scale_factor, .. },
                ..
            } if window_id == window.id() => {
                println!("  display  scale_factor={scale_factor}");
                #[cfg(windows)]
                { dpi_changed = true; }
            }
            Event::WindowEvent { window_id, event: WindowEvent::Focused(true), .. } if window_id == window.id() => {
                placement::revalidate(&window, main_placement.is_some());
                placement::record(&window, owner.as_ref(), main_placement.is_some());
            }
            Event::WindowEvent { window_id, event: WindowEvent::Moved(_) | WindowEvent::Resized(_), .. } if window_id == window.id() => {
                #[cfg(windows)]
                if !dpi_changed && !display_changed.load(std::sync::atomic::Ordering::Acquire) {
                    placement::record(&window, owner.as_ref(), main_placement.is_some());
                }
                #[cfg(not(windows))]
                placement::record(&window, owner.as_ref(), main_placement.is_some());
            }
            #[cfg(windows)]
            Event::MainEventsCleared => {
                let topology_changed = display_changed.swap(false, std::sync::atomic::Ordering::AcqRel);
                if topology_changed && main_placement.is_none() && !window.is_minimized() {
                    if let Some(saved) = lifecycle.saved_placement().or_else(|| placement::capture(&window, true)) {
                        placement::apply(&window, saved);
                        placement::record(&window, owner.as_ref(), false);
                    }
                } else if dpi_changed {
                    // Tao commits WM_DPICHANGED's suggested client bounds after
                    // the borrowed event returns. Capture the current target
                    // monitor geometry so a cross-DPI drag cannot jump back to
                    // the previous monitor's saved rectangle.
                    placement::revalidate(&window, main_placement.is_some());
                    placement::record(&window, owner.as_ref(), main_placement.is_some());
                }
                dpi_changed = false;
            }
            Event::LoopDestroyed => { obs_preview.take(); owner.take(); }
            _ => {}
        }
        if update_presentation {
            // WebView2 can stop rAF while leaving document.hidden false.
            // Native visibility belongs to this window and verified document.
            let visible = window.is_visible() && !window.is_minimized();
            if let Some(id) = quit_ui.document_id.as_deref() {
                let state = (id.to_owned(), visible);
                if main_presentation_state.as_ref() != Some(&state) {
                    let payload = serde_json::json!({ "documentId": id, "visible": visible });
                    let script = format!("(function(p){{var h=window.__hertzWindowHost;if(h&&h.documentId===p.documentId&&h.presentationVersion===1)h.presentationChanged(p.visible);}})({payload});");
                    match webview.evaluate_script(&script) {
                        Ok(()) => main_presentation_state = Some(state),
                        Err(error) => tracing::warn!(%error, "同步主窗口呈现状态失败"),
                    }
                }
            }
            if visible != main_webview_visible {
                match webview.set_visible(visible) {
                    Ok(()) => main_webview_visible = visible,
                    Err(error) => tracing::warn!(%error, "同步主窗口 WebView 可见性失败"),
                }
            }
        }
        if !matches!(*control_flow, ControlFlow::Exit) {
            *control_flow = quit_ui.deadline().map_or(ControlFlow::Wait, ControlFlow::WaitUntil);
        }
    })
}

#[cfg(test)]
mod tray_state_tests {
    use super::{next_host_state, HostState};

    #[test]
    fn document_confirmation_observes_live_document_and_navigation_epoch() {
        let mut gate = super::QuitPresentation::default();
        gate.reload();
        let prior_epoch = gate.navigation_epoch;
        assert!(gate.verify_document("new", Some("new"), prior_epoch));
        let confirmed_epoch = gate.navigation_epoch;
        assert!(!gate.verify_document("old", Some("new"), confirmed_epoch));
        assert_eq!(gate.document_id.as_deref(), Some("new"));
        gate.reload();
        assert!(!gate.verify_document("new", Some("new"), confirmed_epoch));
        assert_eq!(gate.document_id, None);
        let current_epoch = gate.navigation_epoch;
        assert!(gate.verify_document("latest", Some("latest"), current_epoch));
        assert!(!gate.verify_document("old", Some("old"), prior_epoch));
        assert_eq!(gate.document_id.as_deref(), Some("latest"));
    }

    #[test]
    fn quit_presentation_requires_current_document_request_and_visible_ack() {
        let mut presentation = super::QuitPresentation::default();
        presentation.document("document-one");
        presentation.request_id = Some("request-one".into());
        presentation.presentation = Some("presentation-one".into());
        let message = serde_json::json!({"documentId":"document-one","requestId":"request-one","presentation":"presentation-one"});
        assert!(!presentation.accepts(&message));
        presentation.acknowledge(&message);
        assert!(presentation.accepts(&message));
        for key in ["documentId", "requestId", "presentation"] {
            let mut stale = message.clone();
            stale[key] = "old".into();
            assert!(!presentation.accepts(&stale));
        }
        presentation.reload();
        assert!(!presentation.accepts(&message));
        presentation.document("document-two");
        assert!(!presentation.accepts(&message));
    }

    #[test]
    fn native_origin_is_exact_service_http_authority() {
        assert_eq!(
            super::service_origin("http://127.0.0.1:1234/?ticket=hidden"),
            Some("http://127.0.0.1:1234".into())
        );
        assert_ne!(
            super::service_origin("http://127.0.0.1:1235/"),
            super::service_origin("http://127.0.0.1:1234/")
        );
        for url in [
            "https://example.com",
            "file:///C:/index.html",
            "data:text/html,hello",
            "/relative",
        ] {
            assert!(super::service_origin(url).is_none());
        }
    }

    #[test]
    fn downloads_accept_only_service_and_its_blob_origin() {
        let origin = "http://127.0.0.1:1234";
        for url in [
            "http://127.0.0.1:1234/v1/backup",
            "blob:http://127.0.0.1:1234/owned-document",
        ] {
            assert!(super::download_is_trusted(url, origin));
        }
        for url in [
            "blob:http://127.0.0.1:1235/other-profile",
            "http://127.0.0.1:1234@elsewhere.example/export",
            "https://127.0.0.1:1234/export",
            "blob:null/opaque",
            "data:text/plain,content",
            "file:///C:/private.txt",
            "javascript:alert(1)",
            "/v1/backup",
        ] {
            assert!(!super::download_is_trusted(url, origin));
        }
    }

    #[test]
    fn first_probe_always_reaches_the_menu_even_when_the_host_is_stopped() {
        assert_eq!(
            next_host_state(None, HostState::Stopped),
            Some(HostState::Stopped)
        );
        assert_eq!(
            next_host_state(Some(HostState::Stopped), HostState::Stopped),
            None
        );
        assert_eq!(
            next_host_state(
                Some(HostState::Stopped),
                HostState::Running {
                    lyrics: true,
                    wallpaper: false
                }
            ),
            Some(HostState::Running {
                lyrics: true,
                wallpaper: false
            })
        );
    }
}
