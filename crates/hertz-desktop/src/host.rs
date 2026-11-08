// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
//
//! 播放器进程内宿主：把桌面歌词/设置窗口当作本进程的一个模块直接调用。
//!
//! 与独立 exe 的唯一区别是「谁来持有窗口与生命周期」：这里不 fork 任何进程、
//! 不开管理命名管道，命令经 `mpsc` 送进宿主的 tao 事件循环，由同一个
//! `App::handle_pipe_command` 分派，业务行为与独立形态逐字一致。

use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// 播放器调用 `start_embedded` 时给出的进程内运行参数。
#[derive(Clone, Debug)]
pub struct HostOptions {
    /// 与播放器共用的数据目录（发现文件、钥匙串、配置的唯一来源）。
    pub data_dir: PathBuf,
    /// 播放器自己已有托盘（原生主窗口形态）：宿主不建第二个托盘图标，
    /// 也不抢占进程级的菜单/托盘事件处理器。
    pub player_tray: bool,
    /// 开机启动项要登记的命令：指向播放器 exe，而不是已退役的桌面组件。
    pub autostart_command: Option<String>,
    /// 启动时直接打开的设置页签（`lyrics` / `wallpaper` / `runtime`）。
    pub settings_tab: Option<String>,
    /// 启动即定位歌词（对应原 `--locate`）。
    pub locate: bool,
}

/// 一次进程内宿主动作：管理命令，或播放器托盘代收的原生菜单点击。
pub(crate) enum HostAction {
    Command {
        body: Value,
        reply: mpsc::SyncSender<Value>,
    },
    /// `mini-context-*` 等宿主自建菜单：播放器有托盘时由它转发回来。
    Menu(String),
}

/// 命令通道：宿主事件循环专用线程把请求转成 `UserEvent::Host`。
pub(crate) type CommandReceiver = mpsc::Receiver<HostAction>;
/// 启动就绪回执；`run_with` 在事件循环开跑前发 `Ok(())`，提前失败发 `Err`。
pub(crate) type ReadySender = mpsc::SyncSender<Result<(), String>>;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const START_TIMEOUT: Duration = Duration::from_secs(30);
static EMBEDDED_ACTIVE: AtomicBool = AtomicBool::new(false);

struct HostLifetime(Arc<AtomicBool>);

impl Drop for HostLifetime {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
        EMBEDDED_ACTIVE.store(false, Ordering::Release);
    }
}

trait CommandSink: Send + Sync {
    fn dispatch(&self, body: Value) -> Result<Value, String>;
}

struct ChannelSink {
    sender: Mutex<mpsc::Sender<HostAction>>,
}

impl CommandSink for ChannelSink {
    fn dispatch(&self, body: Value) -> Result<Value, String> {
        let (reply, wait) = mpsc::sync_channel(1);
        let sender = self
            .sender
            .lock()
            .map_err(|_| "桌面歌词命令通道不可用".to_string())?
            .clone();
        sender
            .send(HostAction::Command { body, reply })
            .map_err(|_| "桌面歌词未运行".to_string())?;
        wait.recv_timeout(COMMAND_TIMEOUT)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => "桌面命令处理超时，请稍后重试".to_string(),
                mpsc::RecvTimeoutError::Disconnected => "桌面歌词未运行".to_string(),
            })
    }
}

/// 内嵌宿主的句柄。播放器全局只持有一份；`Arc` 让命令不必占着全局锁等待应答。
pub struct HostHandle {
    sink: Arc<dyn CommandSink>,
    alive: Arc<AtomicBool>,
    menus: Mutex<mpsc::Sender<HostAction>>,
}

impl HostHandle {
    /// 宿主事件循环是否仍在运行（用户从托盘退出歌词后会被置为 false）。
    pub fn is_running(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    /// 直接下发一条管理命令，走与管道完全相同的业务分派，但不出本进程。
    pub fn command(&self, name: &str, value: Option<Value>) -> Result<Value, String> {
        if !self.is_running() {
            return Err("桌面歌词未运行".to_string());
        }
        let mut body = serde_json::json!({ "command": name });
        if let Some(value) = value {
            body["value"] = value;
        }
        self.sink.dispatch(body)
    }

    /// 播放器托盘代收的宿主菜单点击，转回宿主的 `handle_menu`。
    pub fn menu_event(&self, id: &str) -> Result<(), String> {
        if !self.is_running() {
            return Err("桌面歌词未运行".to_string());
        }
        self.menus
            .lock()
            .map_err(|_| "桌面歌词菜单通道不可用".to_string())?
            .send(HostAction::Menu(id.to_string()))
            .map_err(|_| "桌面歌词未运行".to_string())
    }

    /// 等待宿主自己走完收尾（保存配置、销毁窗口）；不 kill 线程。
    pub fn wait_stopped(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while self.is_running() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        !self.is_running()
    }
}

/// 在**当前进程**启动桌面宿主。返回的句柄由播放器统一持有。
///
/// 初始化失败时返回明确错误；超时则排队退出，并在收尾前阻止重复启动。
pub fn start_embedded(options: HostOptions) -> Result<HostHandle, String> {
    if EMBEDDED_ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("桌面宿主正在运行或等待启动收尾，请稍后重试".into());
    }
    let (command_sender, command_receiver) = mpsc::channel();
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let alive = Arc::new(AtomicBool::new(true));
    let lifetime = HostLifetime(Arc::clone(&alive));

    let args = crate::app::Args {
        data_dir: Some(options.data_dir),
        locate: options.locate,
        wallpaper_feed_test: false,
        wallpaper: false,
        settings: options.settings_tab.is_some(),
        settings_tab: options.settings_tab,
        preview: false,
    };
    if let Some(command) = &options.autostart_command {
        crate::native::set_autostart_command(command.clone());
    }
    let config = crate::app::RunConfig {
        args,
        embedded: true,
        host_tray: !options.player_tray,
        commands: Some(command_receiver),
        ready: Some(ready_sender),
    };

    std::thread::Builder::new()
        .name("hertz-desktop-embedded".into())
        .spawn(move || {
            let _lifetime = lifetime;
            if let Err(error) = crate::app::run_with(config) {
                crate::app::log(&format!("embedded desktop host failed: {error:#}"));
            }
        })
        .map_err(|error| format!("启动进程内桌面宿主失败：{error}"))?;

    match ready_receiver.recv_timeout(START_TIMEOUT) {
        Ok(Ok(())) => Ok(HostHandle {
            sink: Arc::new(ChannelSink {
                sender: Mutex::new(command_sender.clone()),
            }),
            alive,
            menus: Mutex::new(command_sender),
        }),
        Ok(Err(message)) => Err(message),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            // 初始化可能迟到完成；先排队退出，不能留下无句柄的窗口或重复启动。
            let (reply, _) = mpsc::sync_channel(1);
            let _ = command_sender.send(HostAction::Command {
                body: serde_json::json!({ "command": "quit" }),
                reply,
            });
            Err("桌面宿主启动超时，正在等待初始化收尾，请稍后重试".into())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("桌面宿主初始化失败".into()),
    }
}
