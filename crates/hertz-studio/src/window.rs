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
//   4. 双实例握手 = 数据目录内 OS 锁 + 临时回环端口，认证后聚焦匹配窗口；
//   5. DPI = 读数与 ScaleFactorChanged 日志（三档对照为真机人工项）。
// 语义红线（设计 §2.2）：关闭窗口只隐藏，绝不触碰播放与服务；**退出仅显式命令**
// （托盘菜单「退出」或页面退出钮），并轨服务的优雅停机通道（exiting watch），
// 服务线程结束即进程退出。

use anyhow::Context as _;
use std::time::Duration;
use tao::dpi::LogicalSize;
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::WebContext;

use super::Args;

mod instance;
mod lifecycle;

/// 服务线程就绪后回传给窗口线程的事实。
pub enum WindowStart {
    /// HTTP 已在实际端口监听；退出句柄仅请求既有 exiting watch 收尾。
    Listening {
        bind_ip: std::net::IpAddr,
        port: u16,
        entry_url: String,
        exit_request: hertz_studio::state::ExitRequest,
    },
}

pub struct WindowNotifier(EventLoopProxy<UserEvent>);

impl WindowNotifier {
    pub fn send(&self, started: WindowStart) {
        if let Err(error) = self.0.send_event(UserEvent::ServiceStarted(started)) {
            let UserEvent::ServiceStarted(WindowStart::Listening { exit_request, .. }) = error.0
            else {
                unreachable!()
            };
            exit_request.request();
        }
    }
}

enum UserEvent {
    ServiceStarted(WindowStart),
    /// wry IPC：页面里 window.ipc.postMessage 的 JSON 消息。
    Ipc(String),
    /// 握手通道收到 "focus" 或托盘「打开主窗口」：前置/恢复主窗口。
    FocusWindow,
    /// 托盘「退出 hertz-studio」：显式退出命令（§2.2），并轨服务优雅停机。
    QuitRequested,
    /// 服务线程结束（None=优雅退出，Some=错误摘要）。
    ServerExited {
        error: Option<String>,
    },
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
    // Resolve exactly once, before taking the lock; boot uses these frozen
    // values even if configuration changes while the UI is being constructed.
    hertz_studio::config::migrate_legacy_data_dir();
    let data_dir = hertz_studio::bootstrap::absolute_data_dir(
        &args
            .data_dir
            .clone()
            .unwrap_or_else(hertz_studio::config::default_data_dir),
    )?;
    let config = hertz_studio::config::Config::load(&data_dir)
        .context("读取配置失败（--window 需要有效数据目录）")?;
    let port = args.port.unwrap_or(config.server.port);
    let bind = args.bind.as_deref().unwrap_or(&config.server.bind);
    let instance = instance::Instance::new(&data_dir, hertz_studio::edition::NAME, bind, port)?;
    let Some(mut owner) = instance.try_claim()? else {
        match instance.focus_existing()? {
            instance::FocusOutcome::Focused => {
                println!("hertz-studio 已在运行：已请求前置匹配的主窗口")
            }
            instance::FocusOutcome::Starting => println!("hertz-studio 主窗口正在启动，请稍候"),
        }
        return Ok(());
    };
    args.data_dir = Some(instance.data_dir.clone());
    args.bind = Some(instance.bind.clone());
    args.port = Some(port);
    let data_dir = instance.data_dir;

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let proxy_for_handshake = proxy.clone();
    owner.publish(move || {
        proxy_for_handshake
            .send_event(UserEvent::FocusWindow)
            .is_ok()
    })?;

    // All fallible native setup precedes service bootstrap. A WebView/tray error
    // drops the owner (listener + discovery + lock), with no service to orphan.
    let proxy_for_tray = proxy.clone();
    tray_icon::menu::MenuEvent::set_event_handler(Some(
        move |event: tray_icon::menu::MenuEvent| {
            let event = match event.id().as_ref() {
                "hz-open" => UserEvent::FocusWindow,
                "hz-quit" => UserEvent::QuitRequested,
                _ => return,
            };
            let _ = proxy_for_tray.send_event(event);
        },
    ));
    let tray_menu = tray_icon::menu::Menu::new();
    let tray_open = tray_icon::menu::MenuItem::with_id("hz-open", "打开主窗口", true, None);
    let tray_quit = tray_icon::menu::MenuItem::with_id("hz-quit", "退出 hertz-studio", true, None);
    tray_menu
        .append_items(&[&tray_open, &tray_quit])
        .context("构建托盘菜单失败")?;
    let tray = tray_icon::TrayIconBuilder::new()
        .with_id("hertz-studio")
        .with_menu(Box::new(tray_menu))
        .with_menu_on_left_click(false)
        .with_tooltip("hertz-studio（原生主窗口）")
        .with_icon(tray_icon::Icon::from_rgba(tray_icon_rgba(), 32, 32)?)
        .build()
        .context("创建托盘图标失败")?;
    let window = WindowBuilder::new()
        .with_title("hertz-studio — 正在启动")
        .with_inner_size(LogicalSize::new(1280.0, 800.0))
        .with_min_inner_size(LogicalSize::new(720.0, 480.0))
        .build(&event_loop)?;
    println!("  display  scale_factor={}", window.scale_factor());
    let mut web_context = WebContext::new(Some(data_dir.join("webview").join("main")));
    let proxy_for_ipc = proxy.clone();
    let webview = wry::WebViewBuilder::new_with_web_context(&mut web_context)
        .with_url("about:blank")
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

    args.notify = Some(WindowNotifier(proxy.clone()));
    let proxy_for_server = proxy.clone();
    let server_thread = std::thread::Builder::new()
        .name("hertz-studio-server".into())
        .spawn(move || {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                match tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => {
                        let result = runtime.block_on(super::run(args));
                        runtime.shutdown_timeout(Duration::from_secs(3));
                        result.err().map(|error| error.to_string())
                    }
                    Err(error) => Some(error.to_string()),
                }
            }))
            .unwrap_or_else(|_| Some("服务线程发生 panic（详见日志）".into()));
            // This is the only producer of the service-completion fact.
            let _ = proxy_for_server.send_event(UserEvent::ServerExited { error: outcome });
        })
        .context("启动服务线程失败")?;

    println!(
        "  webview  数据目录 {}",
        data_dir.join("webview").join("main").display()
    );
    println!("  tray     打开主窗口 / 退出 hertz-studio");
    let mut lifecycle = lifecycle::Lifecycle::default();
    let mut owner = Some(owner);
    let mut tray = Some(tray);
    let mut server_thread = Some(server_thread);
    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => println!("  display  event loop 就绪"),
            Event::UserEvent(UserEvent::ServiceStarted(WindowStart::Listening {
                bind_ip,
                port,
                entry_url,
                exit_request,
            })) => {
                *control_flow =
                    lifecycle.handle(lifecycle::ServiceEvent::Ready(Box::new(move || {
                        exit_request.request()
                    })));
                if let Err(error) = webview.load_url(&entry_url) {
                    eprintln!("加载主窗口失败：{error}");
                    // Initialization failures use the same service shutdown
                    // path; the event loop still waits for actual completion.
                    *control_flow = lifecycle.handle(lifecycle::ServiceEvent::Quit);
                } else {
                    window.set_title("hertz-studio");
                    if let Some(owner) = &owner {
                        owner.ready();
                    }
                    println!(
                        "  window   http://{}/  （关闭窗口=隐藏到托盘）",
                        super::host_port(bind_ip, port)
                    );
                }
            }
            Event::UserEvent(UserEvent::Ipc(body)) => {
                eprintln!("[window] ipc: {body}");
                match body.as_str() {
                    "{\"kind\":\"drag\"}" => {
                        let _ = window.drag_window();
                    }
                    "{\"kind\":\"minimize\"}" => window.set_minimized(true),
                    "{\"kind\":\"maximize-toggle\"}" => {
                        window.set_maximized(!window.is_maximized())
                    }
                    "{\"kind\":\"close\"}" => window.set_visible(false),
                    _ => {}
                }
            }
            Event::UserEvent(UserEvent::FocusWindow) => {
                window.set_minimized(false);
                window.set_visible(true);
                window.set_focus();
            }
            Event::UserEvent(UserEvent::QuitRequested) => {
                *control_flow = lifecycle.handle(lifecycle::ServiceEvent::Quit);
            }
            Event::UserEvent(UserEvent::ServerExited { error }) => {
                if let Some(thread) = server_thread.take() {
                    let _ = thread.join();
                }
                if let Some(message) = error {
                    eprintln!("hertz-studio 服务已退出：{message}");
                }
                *control_flow = lifecycle.handle(lifecycle::ServiceEvent::Exited);
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested { .. },
                ..
            } => {
                // Native close and page close both hide, preserving service.
                window.set_visible(false);
            }
            Event::WindowEvent {
                event: WindowEvent::ScaleFactorChanged { scale_factor, .. },
                ..
            } => {
                println!("  display  scale_factor={scale_factor}");
            }
            Event::LoopDestroyed => {
                // Tao may terminate the process after this callback instead of
                // dropping captures. Explicitly retire the endpoint and tray.
                owner.take();
                tray.take();
            }
            _ => {}
        }
    })
}
