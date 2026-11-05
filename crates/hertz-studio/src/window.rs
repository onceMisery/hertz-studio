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
//   4. 双实例握手 = 通道端口（服务端口+1），第二实例发 "focus" 聚焦既有窗口；
//   5. DPI = 读数与 ScaleFactorChanged 日志（三档对照为真机人工项）。
// 语义红线（设计 §2.2）：关闭窗口只隐藏，绝不触碰播放与服务；**退出仅显式命令**
// （托盘菜单「退出」或页面退出钮），并轨服务的优雅停机通道（exiting watch），
// 服务线程结束即进程退出。

use anyhow::Context as _;
use std::io::{Read as _, Write as _};
use std::sync::mpsc::channel;
use std::time::Duration;
use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::WebContext;

use hertz_studio::desktop_tray::{self, HostState};

use super::Args;

/// 服务线程就绪后回传给窗口线程的事实。
#[derive(Debug)]
pub enum WindowStart {
    /// HTTP 已在实际端口监听；bind_ip 用于推导握手通道地址（仅回环有意义）。
    Listening {
        bind_ip: std::net::IpAddr,
        port: u16,
        entry_url: String,
    },
    /// 服务线程失败（bootstrap 或端口绑定），message 供窗口线程区分双实例情形。
    Failed { message: String, port: u16 },
}

#[derive(Debug)]
enum UserEvent {
    /// wry IPC：页面里 window.ipc.postMessage 的 JSON 消息。
    Ipc(String),
    /// 握手通道收到 "focus" 或托盘「打开主窗口」：前置/恢复主窗口。
    FocusWindow,
    /// 托盘「退出 hertz-studio」：显式退出命令（§2.2），并轨服务优雅停机。
    QuitRequested,
    /// 托盘探针发现桌面组件状态变化：菜单文案与可用性在主线程跟随。
    DesktopHostState(HostState),
    /// 服务线程结束（None=优雅退出，Some=错误摘要）。
    ServerExited { error: Option<String> },
}

/// 握手通道端口 = 服务实际端口 + 1（仅回环；设计 §2.1 的单用途 socket）。
fn handshake_addr(bind_ip: std::net::IpAddr, port: u16) -> std::net::SocketAddr {
    let ip = if bind_ip.is_loopback() {
        bind_ip
    } else {
        std::net::IpAddr::from([127, 0, 0, 1])
    };
    std::net::SocketAddr::new(ip, port + 1)
}

/// 与 SVG / ICO 同源的 64px 图标：H 字母与声波共用一组笔画。
const BRAND_ICON: &[u8] = include_bytes!("../assets/hertz-studio-64.rgba");

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
    window.set_inner_size(LogicalSize::new(364.0, 76.0));
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
        window.set_outer_position(PhysicalPosition::new(
            origin.x + (screen.width as i32 - (388.0 * scale).round() as i32).max(0),
            origin.y + (screen.height as i32 - (156.0 * scale).round() as i32).max(0),
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

/// 显式退出的执行体（§2.2）：并轨服务的优雅停机通道——与页面退出钮
/// （POST /v1/system/shutdown）和 Ctrl-C 走同一条 `exiting` watch，
/// 不另开任何第二条停机路径。
fn request_graceful_shutdown(port: u16, token: &str) -> anyhow::Result<()> {
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))
        .context("连接服务失败（退出命令未送达）")?;
    let request = format!(
        "POST /v1/system/shutdown HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Authorization: Bearer {token}\r\n\
         Content-Length: 0\r\n\
         Connection: close\r\n\
         \r\n"
    );
    stream.write_all(request.as_bytes())?;
    stream.flush()?;
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    Ok(())
}

/// 注入已经就绪的窗口能力；标题栏和按钮由系统提供。
/// 页面不再追加控制条或占用客户区高度，避免和原生标题栏重复。
const HOST_SCRIPT: &str = r#"
(function () {
  function post(kind, extra) {
    if (window.ipc) window.ipc.postMessage(JSON.stringify(extra ? Object.assign({ kind: kind }, extra) : { kind: kind }));
  }
  function setup() {
    try {
      window.__hertzWindowHost = {
        kind: 'window-host',
        close: function () { post('close'); },
        minimize: function () { post('minimize'); },
        maximizeToggle: function () { post('maximize-toggle'); },
        drag: function () { post('drag'); },
        capsule: function (minimized) { post(minimized ? 'capsule-enter' : 'capsule-exit'); },
      };
      document.documentElement.dataset.hertzWindowHost = '1';
      document.documentElement.dataset.hertzWindowChrome = 'native';
      // 与页面共用底色，保留原生标题栏的拖动、贴靠和系统按钮。
      function syncAppearance() {
        var style = getComputedStyle(document.documentElement);
        post('appearance', { background: style.getPropertyValue('--bg').trim(), foreground: style.getPropertyValue('--text').trim() });
      }
      new MutationObserver(syncAppearance).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      syncAppearance();
      post('host-ready');
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
    proxy: &tao::event_loop::EventLoopProxy<UserEvent>,
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
    proxy: &tao::event_loop::EventLoopProxy<UserEvent>,
    shared: &std::sync::Mutex<Option<HostState>>,
) {
    for _ in 0..8 {
        std::thread::sleep(Duration::from_millis(350));
        publish_host_state(proxy, shared);
    }
}

/// `--window` 入口：服务线程 + 主线程窗口 + 托盘。调用前 args.window 必为 true。
pub fn run_window(mut args: Args) -> anyhow::Result<()> {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // 解析 bind/port（与 run() 同一优先级：CLI 覆盖 config；config 读 env）。
    let data_dir = hertz_studio::bootstrap::absolute_data_dir(
        args.data_dir
            .clone()
            .unwrap_or_else(hertz_studio::config::default_data_dir)
            .as_path(),
    )?;
    let config = hertz_studio::config::Config::load(&data_dir)
        .context("读取配置失败（--window 需要有效数据目录）")?;
    let port = args.port.unwrap_or(config.server.port);

    // 第二实例判定：已有 --window 实例在跑时，它的握手通道端口会应答。
    if std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::new(std::net::IpAddr::from([127, 0, 0, 1]), port + 1),
        Duration::from_millis(400),
    )
    .is_ok()
    {
        let mut stream = std::net::TcpStream::connect(std::net::SocketAddr::new(
            std::net::IpAddr::from([127, 0, 0, 1]),
            port + 1,
        ))
        .context("连接既有主窗口握手通道失败")?;
        stream.write_all(b"focus\n")?;
        stream.flush()?;
        println!("hertz-studio 已在运行：已请求前置既有主窗口（端口 {port}）");
        return Ok(());
    }

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
                port,
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
            }) => {
                break (bind_ip, port, entry_url);
            }
            Ok(WindowStart::Failed { message, port }) => {
                // 端口被占：按设计 §2.1 区分「既有窗口实例」（握手应答）与
                // 「无窗口实例」（报错退出）。给仍在建立窗口的第一实例 3 秒重试。
                let handshake = handshake_addr(std::net::IpAddr::from([127, 0, 0, 1]), port);
                let mut focused = false;
                for _ in 0..10 {
                    if let Ok(mut stream) = std::net::TcpStream::connect(handshake) {
                        let _ = stream.write_all(b"focus\n");
                        let _ = stream.flush();
                        focused = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(300));
                }
                if focused {
                    println!("hertz-studio 已在运行：已请求前置既有主窗口（端口 {port}）");
                    let _ = server_thread.join();
                    return Ok(());
                }
                let detail = if message.is_empty() {
                    String::new()
                } else {
                    format!("：{message}")
                };
                anyhow::bail!("端口 {port} 被无窗口实例占用，握手通道无应答{detail}");
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
    let (bind_ip, port, entry_url) = started;
    println!("  window   http://{bind_ip}:{port}/  （原生主窗口形态；关闭窗口=隐藏到托盘）");

    // 握手通道：仅回环单用途 socket（设计 §2.1），承接后续实例的聚焦请求。
    let handshake_listener = std::net::TcpListener::bind(handshake_addr(bind_ip, port))
        .with_context(|| format!("握手通道绑定失败（{}）——双实例聚焦不可用", port + 1))?;
    let proxy_for_handshake = proxy.clone();
    std::thread::Builder::new()
        .name("hertz-studio-handshake".into())
        .spawn(move || {
            for stream in handshake_listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 32];
                // 读到即视为聚焦请求；协议只有一个动词，内容不作解析分支。
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"ok\n");
                let _ = proxy_for_handshake.send_event(UserEvent::FocusWindow);
            }
        })
        .context("启动握手监听线程失败")?;

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
    let tray_wallpaper_toggle = tray_icon::menu::MenuItem::with_id(
        "hz-wallpaper-toggle",
        "显示/隐藏桌面壁纸",
        false,
        None,
    );
    let tray_wallpaper_settings = tray_icon::menu::MenuItem::with_id(
        "hz-wallpaper-settings",
        "桌面歌词与壁纸设置",
        false,
        None,
    );
    let tray_quit = tray_icon::menu::MenuItem::with_id("hz-quit", "退出 hertz-studio", true, None);
    tray_menu
        .append_items(&[
            &tray_open,
            &tray_icon::menu::PredefinedMenuItem::separator(),
            &tray_desktop_mode,
            &tray_lyrics_locate,
            &tray_wallpaper_toggle,
            &tray_wallpaper_settings,
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
            for event in receiver.iter() {
                match event.id().as_ref() {
                    "hz-open" => {
                        let _ = proxy_for_tray.send_event(UserEvent::FocusWindow);
                    }
                    "hz-desktop-mode" => {
                        // 按探针事实切换：运行中→退出组件；未运行→普通模式启动
                        // （歌词/壁纸按组件自身配置自启）。
                        let outcome = match *host_state.lock().expect("托盘桌面组件状态锁") {
                            Some(HostState::Running) => desktop_tray::command("quit"),
                            Some(HostState::Missing) => Err("桌面歌词组件缺失".to_string()),
                            // 首拍尚未发布与「组件未运行」同义：普通模式启动。
                            None | Some(HostState::Stopped) => {
                                desktop_tray::spawn(&data_dir_for_tray)
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
                    "hz-wallpaper-toggle" => {
                        if let Err(error) = desktop_tray::command("wallpaper-toggle") {
                            eprintln!("[tray] 壁纸显隐切换失败：{error}");
                        }
                    }
                    "hz-wallpaper-settings" => {
                        if let Err(error) = desktop_tray::command("wallpaper-settings") {
                            eprintln!("[tray] 打开桌面歌词与壁纸设置失败：{error}");
                        }
                    }
                    "hz-quit" => {
                        let _ = proxy_for_tray.send_event(UserEvent::QuitRequested);
                    }
                    _ => {}
                }
            }
        })
        .context("启动托盘事件线程失败")?;
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
        .with_inner_size(LogicalSize::new(1280.0, 800.0))
        .with_min_inner_size(LogicalSize::new(720.0, 480.0));
    #[cfg(target_os = "windows")]
    let window_builder = {
        use tao::platform::windows::WindowBuilderExtWindows;
        window_builder.with_taskbar_icon(Some(window_icon))
    };
    let window = window_builder.build(&event_loop)?;
    println!("  display  scale_factor={}", window.scale_factor());

    // WebView 用户数据目录：<data_dir>/webview/main/（§2.3，与桌面组件互斥隔离）。
    let mut web_context = WebContext::new(Some(data_dir.join("webview").join("main")));
    let proxy_for_ipc = proxy.clone();
    let webview = wry::WebViewBuilder::new_with_web_context(&mut web_context)
        .with_url(&entry_url)
        .with_initialization_script(HOST_SCRIPT)
        .with_ipc_handler(move |request| {
            let body = request.body();
            if body.len() <= 256 {
                let _ = proxy_for_ipc.send_event(UserEvent::Ipc(body.clone()));
            }
        })
        .build(&window)
        .map_err(|error| {
            anyhow::anyhow!("创建 WebView2 失败：{error}（请确认 WebView2 Runtime 已安装）")
        })?;
    let mut main_placement: Option<MainWindowPlacement> = None;

    println!(
        "  webview  数据目录 {}",
        data_dir.join("webview").join("main").display()
    );
    println!(
        "  tray     打开主窗口 / 桌面歌词模式开关 / 退出 hertz-studio"
    );

    // 退出命令所需的凭据：data-dir 的长期 token（本进程自持，不进地址栏）。
    let exit_token = std::fs::read_to_string(data_dir.join("token"))
        .unwrap_or_default()
        .trim()
        .to_string();
    let exit_port = port;

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                println!("  display  event loop 就绪");
            }
            Event::UserEvent(UserEvent::Ipc(body)) => {
                eprintln!("[window] ipc: {body}");
                match body.as_str() {
                    "{\"kind\":\"drag\"}" => {
                        let _ = window.drag_window();
                    }
                    "{\"kind\":\"minimize\"}" => window.set_minimized(true),
                    "{\"kind\":\"maximize-toggle\"}" => {
                        if window.is_maximized() {
                            window.set_maximized(false);
                        } else {
                            window.set_maximized(true);
                        }
                    }
                    "{\"kind\":\"close\"}" => {
                        // §2.2：关闭窗口只隐藏，不触碰播放与服务。
                        window.set_visible(false);
                    }
                    "{\"kind\":\"capsule-enter\"}" => {
                        if main_placement.is_none() {
                            main_placement = Some(enter_native_capsule(&window));
                        }
                    }
                    "{\"kind\":\"capsule-exit\"}" => {
                        if let Some(placement) = main_placement.take() {
                            restore_main_window(&window, placement);
                        }
                    }
                    "{\"kind\":\"host-ready\"}" => {
                        // Reloading a capsule page starts from a full interface.
                        if let Some(placement) = main_placement.take() {
                            restore_main_window(&window, placement);
                        }
                    }
                    _ =>
                    {
                        #[cfg(target_os = "windows")]
                        if let Ok(message) = serde_json::from_str::<serde_json::Value>(&body) {
                            if message.get("kind").and_then(serde_json::Value::as_str)
                                == Some("appearance")
                            {
                                sync_window_appearance(&window, &message);
                            }
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::FocusWindow) => {
                if let Some(placement) = main_placement.take() {
                    let _ = webview.evaluate_script(
                        "window.dispatchEvent(new Event('hertz-native-capsule-restore'));",
                    );
                    restore_main_window(&window, placement);
                }
                window.set_minimized(false);
                window.set_visible(true);
                window.set_focus();
            }
            Event::UserEvent(UserEvent::DesktopHostState(state)) => {
                // muda 菜单只能在创建它的线程（这里）变更：文案与可用性跟随探测事实。
                let (label, mode_enabled, actions_enabled) = match state {
                    HostState::Running => ("退出桌面歌词", true, true),
                    HostState::Stopped => ("切换成桌面歌词模式", true, false),
                    HostState::Missing => ("桌面歌词组件缺失", false, false),
                };
                tray_desktop_mode.set_text(label);
                tray_desktop_mode.set_enabled(mode_enabled);
                tray_lyrics_locate.set_enabled(actions_enabled);
                tray_wallpaper_toggle.set_enabled(actions_enabled);
                tray_wallpaper_settings.set_enabled(actions_enabled);
            }
            Event::UserEvent(UserEvent::QuitRequested) => {
                // §2.2：唯一的窗口侧显式退出命令——并轨服务优雅停机通道后，
                // ServerExited 事件会关闭事件循环。这里不做任何直接 kill。
                let token = exit_token.clone();
                let proxy_for_quit = proxy.clone();
                std::thread::Builder::new()
                    .name("hertz-studio-quit".into())
                    .spawn(move || {
                        if let Err(error) = request_graceful_shutdown(exit_port, &token) {
                            // 送达失败绝不静默改 kill：如实回事件循环并在窗口侧
                            // 报告（服务仍在放音，用户可重试或用 Ctrl-C）。
                            let _ = proxy_for_quit.send_event(UserEvent::ServerExited {
                                error: Some(format!("退出命令送达失败：{error}（服务仍在运行）")),
                            });
                        }
                    })
                    .ok();
            }
            Event::UserEvent(UserEvent::ServerExited { error }) => {
                // 服务生命周期=进程生命周期（§2.1）：服务线程结束即退出事件循环。
                if let Some(message) = error {
                    eprintln!("hertz-studio 服务已退出：{message}");
                }
                *control_flow = ControlFlow::Exit;
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested { .. },
                ..
            } => {
                // 原生 × / Alt+F4：与页内关闭键同语义——隐藏（§2.2 默认）。
                window.set_visible(false);
            }
            Event::WindowEvent {
                event: WindowEvent::ScaleFactorChanged { scale_factor, .. },
                ..
            } => {
                println!("  display  scale_factor={scale_factor}");
            }
            Event::LoopDestroyed => {}
            _ => {}
        }
    })
}

#[cfg(test)]
mod tray_state_tests {
    use super::{next_host_state, HostState};

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
            next_host_state(Some(HostState::Stopped), HostState::Running),
            Some(HostState::Running)
        );
    }
}
