// SPDX-License-Identifier: MIT
//! Restricted native WebView2 owner. No host initialization, trusted resource bridge or IPC.
use super::protocol::*;
use super::sandbox::{self, Handle};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::{Duration, Instant};
use webview2_com::{Microsoft::Web::WebView2::Win32::*, *};
use windows::core::{Interface, BOOL, HSTRING, PWSTR};
use windows::Win32::Foundation::RECT;
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, IStream, COINIT_APARTMENTTHREADED, STGM_CREATE, STGM_READWRITE,
    STGM_SHARE_EXCLUSIVE,
};
use windows::Win32::UI::Shell::{SHCreateMemStream, SHCreateStreamOnFileEx};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

pub const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; media-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
struct Apartment;
fn bounded_string(value: PWSTR, limit: usize) -> windows::core::Result<String> {
    if value.is_null() {
        return Err(windows::core::Error::from(
            windows::Win32::Foundation::E_INVALIDARG,
        ));
    }
    let mut length = 0;
    unsafe {
        while length <= limit && *value.0.add(length) != 0 {
            length += 1;
        }
    }
    if length > limit {
        unsafe {
            windows::Win32::System::Com::CoTaskMemFree(Some(value.0.cast()));
        }
        return Err(windows::core::Error::from(
            windows::Win32::Foundation::E_INVALIDARG,
        ));
    }
    Ok(take_pwstr(value))
}
impl Apartment {
    fn new() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
struct ControllerAdmission {
    controller: ICoreWebView2Controller,
    armed: bool,
}
impl Drop for ControllerAdmission {
    fn drop(&mut self) {
        if self.armed {
            let _ = unsafe { self.controller.Close() };
        }
    }
}
pub struct Window {
    pub hwnd: HWND,
}
impl Window {
    pub fn new(viewport: &Viewport, mut progress: impl FnMut(&str) -> Result<()>) -> Result<Self> {
        let name = sandbox::wide("HertzIsolatedWallpaperWorkerV1");
        let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(DefWindowProcW),
            hInstance: instance,
            lpszClassName: name.as_ptr(),
            ..Default::default()
        };
        progress("beforeRegisterWindowClass")?;
        let atom = unsafe { RegisterClassExW(&class) };
        if atom == 0 {
            bail!("register worker HWND: {}", std::io::Error::last_os_error());
        }
        progress("windowClassRegistered")?;
        progress("beforeCreateWindowEx")?;
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                name.as_ptr(),
                sandbox::wide("Hertz isolated wallpaper probe").as_ptr(),
                WS_POPUP,
                viewport.left,
                viewport.top,
                viewport.width as i32,
                viewport.height as i32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            )
        };
        if hwnd.is_null() {
            bail!(
                "create hidden worker HWND: {}",
                std::io::Error::last_os_error()
            );
        }
        Ok(Self { hwnd })
    }
    pub fn destroy(&mut self) -> Result<()> {
        if !self.hwnd.is_null() {
            sandbox::win(
                unsafe { DestroyWindow(self.hwnd) },
                "destroy own worker HWND",
            )?;
            self.hwnd = std::ptr::null_mut();
        }
        Ok(())
    }
}
impl Drop for Window {
    fn drop(&mut self) {
        let _ = self.destroy();
    }
}
fn pump() {
    let mut message = MSG::default();
    unsafe {
        while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}
fn wait<T>(receiver: &Receiver<T>, deadline: Instant) -> Result<T> {
    loop {
        if let Ok(value) = receiver.try_recv() {
            return Ok(value);
        }
        if Instant::now() >= deadline {
            bail!("WebView2 asynchronous startup deadline");
        }
        pump();
        std::thread::sleep(Duration::from_millis(5));
    }
}
struct Pending {
    args: ICoreWebView2WebResourceRequestedEventArgs,
    deferral: ICoreWebView2Deferral,
}
struct ResourceReply {
    id: u64,
    response: ResourceResponse,
    bytes: Vec<u8>,
}
fn resource_thread(
    mut read: File,
    mut write: File,
    identity: Identity,
) -> (
    SyncSender<ResourceRequest>,
    Receiver<Result<ResourceReply>>,
    std::thread::JoinHandle<()>,
) {
    let (tx, requests) = mpsc::sync_channel::<ResourceRequest>(RESOURCE_CONCURRENCY);
    let (replies, rx) = mpsc::sync_channel(RESOURCE_CONCURRENCY);
    let handle = std::thread::spawn(move || {
        while let Ok(request) = requests.recv() {
            let result = (|| -> Result<_> {
                request.validate(&identity)?;
                write_json(&mut write, &request)?;
                let response: ResourceResponse = read_json(&mut read)?;
                if response.identity != identity
                    || response.request_id != request.request_id
                    || !matches!(response.status, 200 | 403 | 404)
                    || response.mime.len() > 128
                    || response.body_bytes as usize > RESOURCE_STREAM_LIMIT
                {
                    bail!("invalid private broker response");
                }
                let bytes = read_body(&mut read, response.body_bytes)?;
                Ok(ResourceReply {
                    id: request.request_id,
                    response,
                    bytes,
                })
            })();
            let failed = result.is_err();
            if replies.send(result).is_err() || failed {
                break;
            }
        }
    });
    (tx, rx, handle)
}
unsafe fn respond(
    environment: &ICoreWebView2Environment,
    args: &ICoreWebView2WebResourceRequestedEventArgs,
    status: i32,
    mime: &str,
    bytes: &[u8],
) -> windows::core::Result<()> {
    let body =
        unsafe { SHCreateMemStream(Some(bytes)) }.ok_or_else(windows::core::Error::from_thread)?;
    let headers=HSTRING::from(format!("Content-Type: {mime}\r\nContent-Length: {}\r\nContent-Security-Policy: {CSP}\r\nPermissions-Policy: camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), display-capture=()\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\n",bytes.len()));
    let response = unsafe {
        environment.CreateWebResourceResponse(
            &body,
            status,
            &HSTRING::from(if status == 200 { "OK" } else { "Denied" }),
            &headers,
        )
    }?;
    unsafe { args.SetResponse(&response) }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeReady {
    #[serde(rename = "type")]
    kind: String,
    width: u32,
    height: u32,
    marker: String,
}
pub struct RestrictedView {
    _apartment: Apartment,
    controller: ICoreWebView2Controller,
    core: ICoreWebView2,
    pub environment: ICoreWebView2Environment,
    pending: Rc<RefCell<HashMap<u64, Pending>>>,
    request_tx: Option<SyncSender<ResourceRequest>>,
    reply_rx: Receiver<Result<ResourceReply>>,
    resource_thread: Option<std::thread::JoinHandle<()>>,
    ready: Rc<RefCell<bool>>,
    navigation: Rc<RefCell<bool>>,
    fatal: Rc<RefCell<Option<String>>>,
    closed: bool,
}
impl RestrictedView {
    pub fn create(
        window: &Window,
        bootstrap: &Bootstrap,
        resource_read: File,
        resource_write: File,
    ) -> Result<Self> {
        let apartment = Apartment::new()?;
        // Factory options are controlled here. Environment variables are not accepted as options.
        for (key, _) in std::env::vars_os() {
            let key = key.to_string_lossy().to_ascii_uppercase();
            if key.starts_with("WEBVIEW2_") || key.contains("PROXY") {
                bail!("forbidden inherited browser environment");
            }
        }
        let options: ICoreWebView2EnvironmentOptions =
            CoreWebView2EnvironmentOptions::default().into();
        unsafe {
            options.SetAdditionalBrowserArguments(&HSTRING::from(""))?;
            options.SetAllowSingleSignOnUsingOSPrimaryAccount(false)?;
            options
                .cast::<ICoreWebView2EnvironmentOptions2>()?
                .SetExclusiveUserDataFolderAccess(true)?;
            options
                .cast::<ICoreWebView2EnvironmentOptions6>()?
                .SetAreBrowserExtensionsEnabled(false)?;
        }
        let (tx, rx) = mpsc::channel();
        let complete = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
            move |result, environment| {
                let _ = tx.send(
                    result.and_then(|_| environment.ok_or_else(windows::core::Error::from_thread)),
                );
                Ok(())
            },
        ));
        unsafe {
            CreateCoreWebView2EnvironmentWithOptions(
                &HSTRING::from(&bootstrap.runtime_folder),
                &HSTRING::from(&bootstrap.user_data_folder),
                &options,
                &complete,
            )
        }
        .context("create isolated bound WebView2 environment")?;
        let environment = wait(&rx, Instant::now() + STARTUP_TIMEOUT)??;
        environment
            .cast::<ICoreWebView2Environment8>()
            .context("required Environment8 unavailable")?;
        let mut version = PWSTR::null();
        unsafe { environment.BrowserVersionString(&mut version) }?;
        let version = bounded_string(version, 128)?;
        if version != bootstrap.runtime_version {
            bail!("actual WebView2 runtime differs from bound runtime: {version}");
        }
        let (tx, rx) = mpsc::channel();
        let complete = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
            move |result, controller| {
                let _ = tx.send(
                    result.and_then(|_| controller.ok_or_else(windows::core::Error::from_thread)),
                );
                Ok(())
            },
        ));
        unsafe {
            environment.CreateCoreWebView2Controller(
                windows::Win32::Foundation::HWND(window.hwnd),
                &complete,
            )
        }
        .context("create isolated controller")?;
        let controller = wait(&rx, Instant::now() + STARTUP_TIMEOUT)??;
        let mut admission = ControllerAdmission {
            controller: controller.clone(),
            armed: true,
        };
        let core = unsafe { controller.CoreWebView2() }?;
        core.cast::<ICoreWebView2_3>()
            .context("required Core3 unavailable")?;
        let core8 = core
            .cast::<ICoreWebView2_8>()
            .context("required Core8 unavailable")?;
        let core22 = core
            .cast::<ICoreWebView2_22>()
            .context("required Core22 unavailable")?;
        unsafe {
            core8.SetIsMuted(true)?;
            let mut muted = BOOL::default();
            core8.IsMuted(&mut muted)?;
            if !muted.as_bool() {
                bail!("IsMuted readback failed");
            }
            let settings = core.Settings()?;
            settings.SetAreDefaultContextMenusEnabled(false)?;
            settings.SetAreDevToolsEnabled(false)?;
            settings.SetAreHostObjectsAllowed(false)?;
            settings.SetIsStatusBarEnabled(false)?;
            core22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                &HSTRING::from("*"),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
            )?;
            controller.SetBounds(RECT {
                left: 0,
                top: 0,
                right: bootstrap.viewport.width as i32,
                bottom: bootstrap.viewport.height as i32,
            })?;
            controller.SetIsVisible(true)?;
        }
        let (request_tx, reply_rx, resource_thread) =
            resource_thread(resource_read, resource_write, bootstrap.identity.clone());
        let pending = Rc::new(RefCell::new(HashMap::<u64, Pending>::new()));
        let ready = Rc::new(RefCell::new(false));
        let navigation = Rc::new(RefCell::new(false));
        let fatal = Rc::new(RefCell::new(None));
        let mut token = 0;
        let identity = bootstrap.identity.clone();
        let origin = bootstrap.origin();
        let send = request_tx.clone();
        let requests = pending.clone();
        let env = environment.clone();
        let mut next = 1u64;
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            // Default denial precedes parsing, including any subsequent COM or length failure.
            unsafe { respond(&env, &args, 403, "text/plain", b"") }?;
            let request = unsafe { args.Request() }?;
            let mut uri = PWSTR::null();
            unsafe { request.Uri(&mut uri) }?;
            let uri = bounded_string(uri, CONTROL_LIMIT)?;
            let mut method = PWSTR::null();
            unsafe { request.Method(&mut method) }?;
            let method = bounded_string(method, 16)?;
            let path = uri
                .strip_prefix(&format!("{origin}/files/"))
                .unwrap_or("")
                .to_string();
            let request = ResourceRequest {
                identity: identity.clone(),
                request_id: next,
                method,
                path,
            };
            next = next.checked_add(1).unwrap_or(0);
            if request.validate(&identity).is_err()
                || requests.borrow().len() >= RESOURCE_CONCURRENCY
            {
                unsafe { respond(&env, &args, 403, "text/plain", b"") }?;
                return Ok(());
            }
            let deferral = unsafe { args.GetDeferral() }?;
            match send.try_send(request) {
                Ok(()) => {
                    requests
                        .borrow_mut()
                        .insert(next - 1, Pending { args, deferral });
                }
                Err(_) => {
                    unsafe { respond(&env, &args, 403, "text/plain", b"") }?;
                    unsafe { deferral.Complete() }?;
                }
            }
            Ok(())
        }));
        unsafe { core.add_WebResourceRequested(&handler, &mut token) }?;
        let entry = bootstrap.entry_url();
        let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                unsafe { args.SetCancel(true) }?;
                let mut uri = PWSTR::null();
                unsafe { args.Uri(&mut uri) }?;
                let uri = bounded_string(uri, CONTROL_LIMIT)?;
                if uri == entry {
                    unsafe { args.SetCancel(false) }?;
                }
            }
            Ok(())
        }));
        unsafe { core.add_NavigationStarting(&handler, &mut token) }?;
        let handler = NewWindowRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                unsafe { args.SetHandled(true) }?;
            }
            Ok(())
        }));
        unsafe { core.add_NewWindowRequested(&handler, &mut token) }?;
        let handler = LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                unsafe { args.SetCancel(true) }?;
            }
            Ok(())
        }));
        unsafe {
            core.cast::<ICoreWebView2_18>()?
                .add_LaunchingExternalUriScheme(&handler, &mut token)
        }?;
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY) }?;
            }
            Ok(())
        }));
        unsafe { core.add_PermissionRequested(&handler, &mut token) }?;
        let handler = DownloadStartingEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                unsafe {
                    args.SetCancel(true)?;
                    args.SetHandled(true)?;
                }
            }
            Ok(())
        }));
        unsafe {
            core.cast::<ICoreWebView2_4>()?
                .add_DownloadStarting(&handler, &mut token)
        }?;
        let gate = navigation.clone();
        let failure = fatal.clone();
        let handler = NavigationCompletedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut success = BOOL::default();
                unsafe { args.IsSuccess(&mut success) }?;
                if success.as_bool() {
                    *gate.borrow_mut() = true;
                } else {
                    *failure.borrow_mut() = Some("fixed probe navigation failed".into());
                }
            }
            Ok(())
        }));
        unsafe { core.add_NavigationCompleted(&handler, &mut token) }?;
        let gate = ready.clone();
        let failure = fatal.clone();
        let mut rate = InboundRate::new();
        let width = bootstrap.viewport.width;
        let height = bootstrap.viewport.height;
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut raw = PWSTR::null();
                unsafe { args.TryGetWebMessageAsString(&mut raw) }?;
                let raw = match bounded_string(raw, CONTROL_LIMIT) {
                    Ok(value) => value,
                    Err(_) => {
                        *failure.borrow_mut() = Some("oversize worker page protocol".into());
                        return Ok(());
                    }
                };
                if raw.len() > CONTROL_LIMIT || !rate.admit() {
                    *failure.borrow_mut() = Some("worker page protocol limit".into());
                    return Ok(());
                }
                match serde_json::from_str::<ProbeReady>(&raw) {
                    Ok(message)
                        if message.kind == "probeReady"
                            && message.marker == "hertz-g3s-fixed-probe-v1"
                            && message.width == width
                            && message.height == height =>
                    {
                        *gate.borrow_mut() = true;
                    }
                    _ => {
                        *failure.borrow_mut() = Some("invalid fixed probe handshake".into());
                    }
                }
            }
            Ok(())
        }));
        unsafe { core.add_WebMessageReceived(&handler, &mut token) }?;
        // No host object, trusted initialization script, management handler or passthrough.
        unsafe { core.Navigate(&HSTRING::from(bootstrap.entry_url())) }?;
        admission.armed = false;
        Ok(Self {
            _apartment: apartment,
            controller,
            core,
            environment,
            pending,
            request_tx: Some(request_tx),
            reply_rx,
            resource_thread: Some(resource_thread),
            ready,
            navigation,
            fatal,
            closed: false,
        })
    }
    pub fn tick(&self) -> Result<()> {
        pump();
        while let Ok(reply) = self.reply_rx.try_recv() {
            let reply = reply?;
            let pending = self
                .pending
                .borrow_mut()
                .remove(&reply.id)
                .context("unknown resource response")?;
            let result = unsafe {
                respond(
                    &self.environment,
                    &pending.args,
                    reply.response.status as i32,
                    &reply.response.mime,
                    &reply.bytes,
                )
            };
            unsafe { pending.deferral.Complete() }?;
            result?;
        }
        if let Some(failure) = self.fatal.borrow_mut().take() {
            bail!("{failure}");
        }
        Ok(())
    }
    pub fn ready(&self) -> bool {
        *self.ready.borrow() && *self.navigation.borrow()
    }
    pub fn processes(&self) -> Result<(u32, Vec<ProcessIdentity>)> {
        let mut browser = 0;
        unsafe { self.core.BrowserProcessId(&mut browser) }?;
        let collection = unsafe {
            self.environment
                .cast::<ICoreWebView2Environment8>()?
                .GetProcessInfos()
        }?;
        let mut count = 0;
        unsafe { collection.Count(&mut count) }?;
        if count == 0 || count > 32 {
            bail!("invalid actual WebView2 environment process count");
        }
        let mut processes = Vec::with_capacity(count as usize);
        for index in 0..count {
            let info = unsafe { collection.GetValueAtIndex(index) }?;
            let mut pid = 0;
            let mut kind = COREWEBVIEW2_PROCESS_KIND_BROWSER;
            unsafe {
                info.ProcessId(&mut pid)?;
                info.Kind(&mut kind)?;
            }
            let pid = u32::try_from(pid)?;
            let handle = Handle::new(
                unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) },
                "worker holds actual environment process",
            )?;
            processes.push(ProcessIdentity {
                pid,
                created: sandbox::created(handle.0)?,
                kind: kind.0,
            });
        }
        if !processes.iter().any(|process| process.pid == browser) {
            bail!("browser missing from actual environment process collection");
        }
        Ok((browser, processes))
    }
    pub fn capture(&self, bootstrap: &Bootstrap) -> Result<(String, String)> {
        let path = std::path::Path::new(&bootstrap.user_data_folder).join("first-frame.png");
        let stream: IStream = unsafe {
            SHCreateStreamOnFileEx(
                &HSTRING::from(path.to_string_lossy().as_ref()),
                (STGM_CREATE | STGM_READWRITE | STGM_SHARE_EXCLUSIVE).0,
                0,
                true,
                None,
            )
        }?;
        let (tx, rx) = mpsc::channel();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
            let _ = tx.send(result);
            Ok(())
        }));
        unsafe {
            self.core.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &handler,
            )
        }?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let result = loop {
            if let Ok(value) = rx.try_recv() {
                break value;
            }
            self.tick()?;
            if Instant::now() > deadline {
                bail!("native CapturePreview deadline");
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        result?;
        drop(stream);
        let metadata = std::fs::metadata(&path)?;
        if metadata.len() == 0 || metadata.len() > 8 * 1024 * 1024 {
            bail!("native capture size outside evidence budget");
        }
        let bytes = std::fs::read(&path)?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        Ok((path.to_string_lossy().into(), hash))
    }
    pub fn close(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        unsafe {
            self.controller.SetIsVisible(false)?;
            self.controller.Close()?;
        }
        for (_, pending) in self.pending.borrow_mut().drain() {
            unsafe { pending.deferral.Complete() }?;
        }
        self.request_tx.take();
        // The resource thread's private pipe closes when this process exits. Never block Close on it.
        self.resource_thread.take();
        self.closed = true;
        Ok(())
    }
}
impl Drop for RestrictedView {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
pub fn run(
    mut control_read: File,
    mut control_write: File,
    resource_read: File,
    resource_write: File,
    parent: Handle,
) -> Result<()> {
    let first: ParentControl = read_json(&mut control_read)?;
    let bootstrap = match first {
        ParentControl::Bootstrap { bootstrap } => bootstrap,
        _ => bail!("first private frame must be bootstrap"),
    };
    write_json(
        &mut control_write,
        &WorkerControl::Stage {
            identity: bootstrap.identity.clone(),
            stage: "bootstrapRead".into(),
        },
    )?;
    sandbox::validate_bootstrap(&bootstrap, parent.0)?;
    write_json(
        &mut control_write,
        &WorkerControl::Stage {
            identity: bootstrap.identity.clone(),
            stage: "bootstrapValidated".into(),
        },
    )?;
    let result = (|| -> Result<()> {
        write_json(
            &mut control_write,
            &WorkerControl::Stage {
                identity: bootstrap.identity.clone(),
                stage: "beforeWindowCreate".into(),
            },
        )?;
        let mut window = Window::new(&bootstrap.viewport, |stage| {
            write_json(
                &mut control_write,
                &WorkerControl::Stage {
                    identity: bootstrap.identity.clone(),
                    stage: stage.into(),
                },
            )
            .map_err(Into::into)
        })?;
        write_json(
            &mut control_write,
            &WorkerControl::Window {
                identity: bootstrap.identity.clone(),
                hwnd: window.hwnd as u64,
                pid: unsafe { GetCurrentProcessId() },
                created: sandbox::created(unsafe { GetCurrentProcess() })?,
            },
        )?;
        // Once a HWND exists, its owner must keep dispatching messages while
        // the parent installs styles and mounts it. Those cross-process APIs
        // synchronously call this window procedure before sending Mounted.
        let (control_tx, control_rx) = mpsc::sync_channel(CONTROL_QUEUE_FRAMES);
        std::thread::spawn(move || {
            let mut rate = InboundRate::new();
            loop {
                let message = read_json::<ParentControl>(&mut control_read);
                let failed = message.is_err();
                if !rate.admit() || control_tx.try_send(message).is_err() || failed {
                    break;
                }
            }
        });
        let mounted = wait(&control_rx, Instant::now() + STARTUP_TIMEOUT)??;
        match mounted {
            ParentControl::Mounted { identity, hwnd }
                if identity == bootstrap.identity && hwnd == window.hwnd as u64 => {}
            _ => bail!("parent did not confirm owned WorkerW attachment"),
        }
        let mut view = RestrictedView::create(&window, &bootstrap, resource_read, resource_write)?;
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let mut frame = false;
        let mut last_processes = Instant::now() - Duration::from_secs(1);
        loop {
            if let Ok(message) = control_rx.try_recv() {
                match message? {
                    ParentControl::Stop { identity } if identity == bootstrap.identity => break,
                    _ => bail!("unexpected or stale parent frame"),
                }
            }
            view.tick()?;
            if last_processes.elapsed() >= Duration::from_millis(500) {
                let (browser, processes) = view.processes()?;
                write_json(
                    &mut control_write,
                    &WorkerControl::Environment {
                        identity: bootstrap.identity.clone(),
                        runtime_version: bootstrap.runtime_version.clone(),
                        browser_pid: browser,
                        processes,
                        muted: true,
                        required_interfaces: true,
                    },
                )?;
                last_processes = Instant::now();
            }
            if !frame && view.ready() {
                let (path, hash) = view.capture(&bootstrap)?;
                // Bind the process set at the capture, rather than an earlier periodic snapshot.
                let (browser, processes) = view.processes()?;
                write_json(
                    &mut control_write,
                    &WorkerControl::Environment {
                        identity: bootstrap.identity.clone(),
                        runtime_version: bootstrap.runtime_version.clone(),
                        browser_pid: browser,
                        processes,
                        muted: true,
                        required_interfaces: true,
                    },
                )?;
                write_json(
                    &mut control_write,
                    &WorkerControl::FirstFrame {
                        identity: bootstrap.identity.clone(),
                        width: bootstrap.viewport.width,
                        height: bootstrap.viewport.height,
                        capture_sha256: hash,
                        capture_png: path,
                    },
                )?;
                frame = true;
            }
            if !frame && Instant::now() > deadline {
                bail!("fixed probe first frame deadline");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        view.close()?;
        window.destroy()?;
        write_json(
            &mut control_write,
            &WorkerControl::Closed {
                identity: bootstrap.identity.clone(),
                controller_closed: true,
                hwnd_destroyed: true,
            },
        )?;
        control_write.flush()?;
        Ok(())
    })();
    if let Err(error) = &result {
        let message = format!("{error:#}").chars().take(1024).collect();
        let _ = write_json(
            &mut control_write,
            &WorkerControl::Failed {
                identity: bootstrap.identity,
                stage: "restrictedWebViewStartup".into(),
                message,
            },
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_mount_wait_dispatches_cross_thread_window_messages() {
        let viewport = Viewport {
            left: 0,
            top: 0,
            width: 32,
            height: 32,
        };
        let window = Window::new(&viewport, |_| Ok(())).unwrap();
        let hwnd = window.hwnd as usize;
        let (sender, receiver) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let mut result = 0;
            let delivered = unsafe {
                SendMessageTimeoutW(
                    hwnd as HWND,
                    WM_NULL,
                    0,
                    0,
                    SMTO_ABORTIFHUNG,
                    1000,
                    &mut result,
                )
            };
            sender.send(delivered != 0).unwrap();
        });
        assert!(wait(&receiver, Instant::now() + Duration::from_secs(2)).unwrap());
        thread.join().unwrap();
    }
}
