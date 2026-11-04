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
//   3. 拖动 = 页内窗口控制条经 IPC 触发 drag_window，原生边框/系统菜单/贴靠保留；
//   4. 双实例握手 = 通道端口（服务端口+1），第二实例发 "focus" 聚焦既有窗口；
//   5. DPI = 读数与 ScaleFactorChanged 日志（三档对照为真机人工项）。
// 语义红线（设计 §2.2）：关闭窗口只隐藏，绝不触碰播放与服务；**退出仅显式命令**
// （托盘菜单「退出」或页面退出钮），并轨服务的优雅停机通道（exiting watch），
// 服务线程结束即进程退出。

use anyhow::Context as _;
use std::io::{Read as _, Write as _};
use std::sync::mpsc::channel;
use std::time::Duration;
use tao::dpi::LogicalSize;
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::WebContext;

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

/// 原型托盘图标：32×32 RGBA，暗底 + 品牌青方块（正式图标随实施评审定稿）。
fn tray_icon_rgba() -> Vec<u8> {
    let mut rgba = Vec::with_capacity(32 * 32 * 4);
    for y in 0..32i32 {
        for x in 0..32i32 {
            if (x - 16).abs() <= 9 && (y - 16).abs() <= 9 {
                rgba.extend_from_slice(&[0x00, 0xF5, 0xD4, 0xFF]);
            } else {
                rgba.extend_from_slice(&[0x0A, 0x0A, 0x0A, 0x00]);
            }
        }
    }
    rgba
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

/// 窗口控制条注入脚本（设计 §5.1 的窗口控制区落地，§2.5：能力就绪才注入，
/// 页面不得自实现退出）。
///
/// 40px 控制条占据窗口顶部：左侧拖动区（含双击最大化切换），右侧
/// 最小化 / 最大化切换 / 关闭按钮簇；页面内容整体下移（html padding-top）。
/// 颜色全部取页面已有的设计令牌；关闭键 hover 用 --danger。
/// `documentElement.dataset.hertzWindowHost = "1"` 供外壳/样式按能力分支。
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
      };
      document.documentElement.dataset.hertzWindowHost = '1';
      var bar = document.createElement('div');
      bar.id = 'hertz-window-chrome';
      bar.innerHTML = '<style>' +
        'html { box-sizing: border-box; padding-top: 40px; }' +
        '#hertz-window-chrome { position: fixed; top: 0; left: 0; right: 0; height: 40px;' +
        '  z-index: 2147483647; display: flex; align-items: stretch; user-select: none;' +
        '  background: color-mix(in srgb, var(--glass-bg-strong) 88%, transparent);' +
        '  border-bottom: 1px solid var(--glass-line); }' +
        '#hertz-window-chrome .hzwc-drag { flex: 1; min-width: 0; }' +
        '#hertz-window-chrome .hzwc-buttons { display: flex; align-items: stretch; }' +
        '#hertz-window-chrome .hzwc-buttons button { width: 46px; padding: 0; border: 0;' +
        '  background: transparent; color: var(--text); cursor: pointer;' +
        '  display: grid; place-items: center; }' +
        '#hertz-window-chrome .hzwc-buttons button:hover { background: var(--hover); }' +
        '#hertz-window-chrome .hzwc-buttons button.hzwc-close:hover { background: var(--danger); color: #0A0A0A; }' +
        '#hertz-window-chrome svg { width: 14px; height: 14px; }' +
        '</style>' +
        '<div class="hzwc-drag" aria-hidden="true"></div>' +
        '<div class="hzwc-buttons">' +
        '<button type="button" data-hzwc="minimize" aria-label="最小化" title="最小化">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>' +
        '<button type="button" data-hzwc="maximize-toggle" aria-label="最大化或还原" title="最大化/还原">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>' +
        '<button type="button" data-hzwc="close" class="hzwc-close" aria-label="关闭窗口" title="关闭窗口（隐藏到托盘）">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>' +
        '</div>';
      bar.addEventListener('mousedown', function (event) {
        if (event.button !== 0) return;
        if (event.target.closest && event.target.closest('[data-hzwc]')) return;
        post('drag');
      });
      bar.addEventListener('dblclick', function (event) {
        if (event.target.closest && event.target.closest('[data-hzwc]')) return;
        post('maximize-toggle');
      });
      bar.addEventListener('click', function (event) {
        var button = event.target.closest && event.target.closest('[data-hzwc]');
        if (button) post(button.getAttribute('data-hzwc'));
      });
      document.body.appendChild(bar);
      post('chrome-ready');
    } catch (error) {
      post('chrome-error', { message: String(error && error.message || error) });
    }
  }
  // document-created 阶段 head/body 尚未解析：就绪后再装控制条。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
"#;

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
    let tray_menu = tray_icon::menu::Menu::new();
    let tray_open = tray_icon::menu::MenuItem::with_id("hz-open", "打开主窗口", true, None);
    let tray_quit = tray_icon::menu::MenuItem::with_id("hz-quit", "退出 hertz-studio", true, None);
    tray_menu
        .append_items(&[&tray_open, &tray_quit])
        .context("构建托盘菜单失败")?;
    let _tray = tray_icon::TrayIconBuilder::new()
        .with_id("hertz-studio")
        .with_menu(Box::new(tray_menu))
        .with_menu_on_left_click(false)
        .with_tooltip("hertz-studio（原生主窗口）")
        .with_icon(tray_icon::Icon::from_rgba(tray_icon_rgba(), 32, 32)?)
        .build()
        .context("创建托盘图标失败")?;
    let proxy_for_tray = proxy.clone();
    std::thread::Builder::new()
        .name("hertz-studio-tray".into())
        .spawn(move || {
            let receiver = tray_icon::menu::MenuEvent::receiver();
            for event in receiver.iter() {
                match event.id().as_ref() {
                    "hz-open" => {
                        let _ = proxy_for_tray.send_event(UserEvent::FocusWindow);
                    }
                    "hz-quit" => {
                        let _ = proxy_for_tray.send_event(UserEvent::QuitRequested);
                    }
                    _ => {}
                }
            }
        })
        .context("启动托盘事件线程失败")?;

    // 主线程窗口：保留原生装饰（设计 §2.5 红线——不用 OVERLAY_FRAME_STYLES）。
    let window = WindowBuilder::new()
        .with_title("hertz-studio")
        .with_inner_size(LogicalSize::new(1280.0, 800.0))
        .with_min_inner_size(LogicalSize::new(720.0, 480.0))
        .build(&event_loop)?;
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
    let _ = webview;

    println!(
        "  webview  数据目录 {}",
        data_dir.join("webview").join("main").display()
    );
    println!("  tray     打开主窗口 / 退出 hertz-studio");

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
                    _ => {}
                }
            }
            Event::UserEvent(UserEvent::FocusWindow) => {
                window.set_minimized(false);
                window.set_visible(true);
                window.set_focus();
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
