// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
// R5 原生主窗口原型（`--window`，feature = native-window）。
//
// 设计与门禁：docs/aegis/specs/2026-11-04-r5-native-main-window-design.md。
// 本文件对应 §3 原型清单的代码面：
//   1. Tao event loop 留主线程，整条既有服务 bootstrap + HTTP 原样跑在派生线程；
//   2. WebView 用户数据目录 = <data_dir>/webview/main/，首跳凭据消费服务端的
//      一次性票据 URL（token 不进地址栏）；
//   3. 拖动 = 页内 6px 顶条经 IPC 触发 drag_window，原生边框/系统菜单/贴靠保留；
//   4. 双实例握手 = 通道端口（服务端口+1），第二实例发 "focus" 聚焦既有窗口；
//   5. DPI = 读数与 ScaleFactorChanged 日志（三档对照为真机人工项）。
// 语义红线（设计 §2.2）：关闭窗口只隐藏，绝不触碰播放与服务；退出仅走服务的
// 显式退出通道（页面退出钮 / Ctrl-C），服务线程结束即进程退出。

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
    /// 握手通道收到 "focus"：前置/恢复主窗口。
    FocusWindow,
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

/// 顶条注入脚本：窗口宿主能力 + 拖动条（§2.5：能力就绪才注入，页面不得自实现退出）。
const HOST_SCRIPT: &str = r#"
(function () {
  var post = function (kind) {
    if (window.ipc) window.ipc.postMessage(JSON.stringify({ kind: kind }));
  };
  window.__hertzWindowHost = {
    close: function () { post('close'); },
    minimize: function () { post('minimize'); },
    maximizeToggle: function () { post('maximize-toggle'); },
    drag: function () { post('drag'); },
  };
  var strip = document.createElement('div');
  strip.id = 'hertz-window-dragstrip';
  strip.style.cssText = 'position:fixed;top:0;left:0;right:0;height:6px;z-index:2147483647;';
  strip.addEventListener('mousedown', function (event) {
    if (event.button === 0) post('drag');
  });
  document.documentElement.appendChild(strip);
  var style = document.createElement('style');
  style.textContent = 'html { box-sizing: border-box; padding-top: 6px; }';
  document.head.appendChild(style);
})();
"#;

/// `--window` 原型入口：服务线程 + 主线程窗口。调用前 args.window 必为 true。
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
        .context("读取配置失败（--window 原型需要有效数据目录）")?;
    let port = args.port.unwrap_or(config.server.port);
    eprintln!("[window] stage: config resolved port={port}");

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

    eprintln!("[window] stage: handshake probe done");
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

    eprintln!("[window] stage: server thread spawned, waiting");
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
    eprintln!("[window] stage: started received");
    let (bind_ip, port, entry_url) = started;
    println!("  window   http://{bind_ip}:{port}/  （原生主窗口形态；关闭窗口=隐藏）");

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

    // 主线程窗口：保留原生装饰（设计 §2.5 红线——不用 OVERLAY_FRAME_STYLES）。
    let window = WindowBuilder::new()
        .with_title("hertz-studio")
        .with_inner_size(LogicalSize::new(1280.0, 800.0))
        .with_min_inner_size(LogicalSize::new(720.0, 480.0))
        .build(&event_loop)?;
    println!("  display  scale_factor={}", window.scale_factor());

    // WebView 用户数据目录：<data_dir>/webview/main/（§2.3，与桌面组件互斥隔离）。
    let mut web_context = WebContext::new(Some(data_dir.join("webview").join("main")));
    let webview = wry::WebViewBuilder::new_with_web_context(&mut web_context)
        .with_url(&entry_url)
        .with_initialization_script(HOST_SCRIPT)
        .with_ipc_handler(move |request| {
            let body = request.body();
            if body.len() <= 256 {
                let _ = proxy.send_event(UserEvent::Ipc(body.clone()));
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

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => {
                println!("  display  event loop 就绪");
            }
            Event::UserEvent(UserEvent::Ipc(body)) => match body.as_str() {
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
            },
            Event::UserEvent(UserEvent::FocusWindow) => {
                window.set_minimized(false);
                window.set_visible(true);
                window.set_focus();
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
