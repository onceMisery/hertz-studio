// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 桌面歌词宿主：窗口、托盘、来源线程与可见性策略。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Deserialize;
use tao::dpi::{PhysicalPosition, PhysicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
use tao::window::{Window, WindowBuilder};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE};
use wry::WebViewBuilder;

use crate::config::{self, Config, Layout, Profile, Secondary};
use crate::feed::{Document, Feed, Snapshot};
use crate::native::{self, NativeEvent};
use crate::wallpaper_feed::{Feed as WallpaperFeed, FeedError, Snapshot as WallpaperSnapshot};

const POLL_IDLE: Duration = Duration::from_millis(500);
const POLL_ERROR: Duration = Duration::from_secs(1);
const SAVE_DEBOUNCE: Duration = Duration::from_millis(400);
const STALE_AFTER: Duration = Duration::from_secs(3);

static LOG_SEQ: AtomicU64 = AtomicU64::new(0);

pub(crate) enum UserEvent {
    Feed(Box<Result<crate::feed::FeedUpdate, String>>),
    WallpaperFeed(Box<Result<WallpaperSnapshot, FeedError>>),
    WallpaperPage(String),
    Tick,
    Page(String),
    Tray(TrayIconEvent),
    Menu(MenuEvent),
    Native(NativeEvent),
    Pipe(crate::pipe::PipeRequest),
    Quit,
}

struct Policy {
    locked: bool,
    user_hidden: bool,
    fullscreen: bool,
    session_unavailable: bool,
    display_off: bool,
    no_content: bool,
}

impl Policy {
    fn visible(&self) -> bool {
        !self.user_hidden
            && !self.fullscreen
            && !self.session_unavailable
            && !self.display_off
            && !(self.locked && self.no_content)
    }

    fn renderable(&self) -> bool {
        !self.fullscreen && !self.session_unavailable && !self.display_off
    }
}

struct WallpaperSurface {
    _window: Window,
    webview: wry::WebView,
}

impl WallpaperSurface {
    fn eval(&self, script: &str) {
        if let Err(error) = self.webview.evaluate_script(script) {
            log(&format!("wallpaper evaluate_script failed: {error}"));
        }
    }

    fn apply_feed(&self, snapshot: &WallpaperSnapshot) {
        if let Ok(payload) = serde_json::to_string(snapshot) {
            self.eval(&format!(
                "window.hertzWallpaper && window.hertzWallpaper.applyFeed({payload});"
            ));
        }
    }

    fn clear_feed(&self) {
        self.eval("window.hertzWallpaper && window.hertzWallpaper.applyFeed(null);");
    }

    fn set_visible(&self, visible: bool) {
        if let Err(error) = self.webview.set_visible(visible) {
            log(&format!("wallpaper set_visible({visible}) failed: {error}"));
        }
    }

    fn start(&self, fps: u8) {
        self.set_visible(true);
        self.eval(&format!(
            "window.hertzWallpaper && window.hertzWallpaper.start({fps});"
        ));
    }

    fn stop(&self) {
        self.eval("window.hertzWallpaper && window.hertzWallpaper.stop();");
        self.set_visible(false);
    }
}

struct TrayActions {
    toggle: CheckMenuItem,
    autostart: CheckMenuItem,
    wallpaper_toggle: Option<CheckMenuItem>,
    toggle_id: String,
    locate_id: String,
    autostart_id: String,
    wallpaper_toggle_id: Option<String>,
    quit_id: String,
}

struct App {
    window: Window,
    webview: wry::WebView,
    tray: Option<TrayIcon>,
    tray_actions: Option<TrayActions>,
    config: Config,
    profile: Profile,
    policy: Policy,
    last_snapshot: Option<Snapshot>,
    last_update: Instant,
    current_track: Option<String>,
    current_document_key: Option<String>,
    current_document: Option<Document>,
    page_ready: bool,
    visible: bool,
    placing: bool,
    save_due: Option<Instant>,
    last_check: Instant,
    last_power_check: Instant,
    last_raise: Instant,
    frame_cap: u8,
    last_feed_error: Option<String>,
    last_warning: Option<String>,
    source_state: &'static str,
    source_message: Option<String>,
    wallpaper: Option<WallpaperSurface>,
    wallpaper_page_ready: bool,
    wallpaper_last: Option<WallpaperSnapshot>,
    wallpaper_feed_logged: bool,
    wallpaper_visible: bool,
    wallpaper_hidden: bool,
    wallpaper_forced: bool,
    proxy: EventLoopProxy<UserEvent>,
}

impl App {
    fn hwnd(&self) -> HWND {
        self.window.hwnd() as HWND
    }

    fn eval(&self, script: &str) {
        if !self.page_ready {
            return;
        }
        if let Err(error) = self.webview.evaluate_script(script) {
            log(&format!("evaluate_script failed: {error}"));
        }
    }

    fn send_config(&self) {
        let lyrics = &self.config.lyrics;
        let payload = serde_json::json!({
            "layout": lyrics.layout,
            "secondary": lyrics.secondary,
            "fontFamily": lyrics.font_family,
            "fontSize": lyrics.font_size,
            "fontWeight": lyrics.font_weight,
            "sungColor": lyrics.sung_color,
            "unsungColor": lyrics.unsung_color,
            "outlineColor": lyrics.outline_color,
            "outlineWidth": lyrics.outline_width,
            "opacity": lyrics.opacity,
            "locked": lyrics.locked,
            "frameCap": self.frame_cap,
        });
        self.eval(&format!(
            "window.hertzLyrics && window.hertzLyrics.applyConfig({payload});"
        ));
    }

    fn send_source(&self) {
        let payload = serde_json::json!({
            "state": self.source_state,
            "message": self.source_message,
        });
        self.eval(&format!(
            "window.hertzLyrics && window.hertzLyrics.setSource({payload});"
        ));
    }

    fn send_snapshot(&self) {
        let Some(snapshot) = self.last_snapshot.as_ref() else {
            self.eval("window.hertzLyrics && window.hertzLyrics.applySnapshot(null);");
            return;
        };
        let payload = serde_json::to_string(snapshot).unwrap_or_else(|_| "null".into());
        self.eval(&format!(
            "window.hertzLyrics && window.hertzLyrics.applySnapshot({payload});"
        ));
    }

    fn send_document(&self) {
        let Some(document) = self.current_document.as_ref() else {
            self.eval("window.hertzLyrics && window.hertzLyrics.applyDocument(null);");
            return;
        };
        let payload = serde_json::to_string(document).unwrap_or_else(|_| "null".into());
        self.eval(&format!(
            "window.hertzLyrics && window.hertzLyrics.applyDocument({payload});"
        ));
    }

    fn send_all(&self) {
        self.send_config();
        self.send_source();
        self.send_snapshot();
        self.send_document();
        self.eval(&format!(
            "window.hertzLyrics && window.hertzLyrics.setLocked({});",
            self.config.lyrics.locked
        ));
        self.eval(&format!(
            "window.hertzLyrics && window.hertzLyrics.setActive({});",
            self.visible
        ));
    }

    fn handle_update(&mut self, update: crate::feed::FeedUpdate) {
        self.last_update = Instant::now();
        self.last_feed_error = None;
        let track_id = update.snapshot.track.as_ref().map(|track| track.id.clone());
        let track_changed = track_id != self.current_track;
        if track_changed {
            self.current_track = track_id;
        }
        let snapshot_key = update.snapshot.lyrics.document_key.clone();
        let incoming_key = update
            .document
            .as_ref()
            .and_then(|document| document.document_key.clone())
            .or_else(|| snapshot_key.clone());
        let mut document_changed = false;
        if track_changed || incoming_key != self.current_document_key {
            self.current_document = None;
            self.current_document_key = None;
            document_changed = true;
        }
        if let Some(document) = update.document {
            self.current_document_key = document.document_key.clone().or(snapshot_key);
            self.current_document = Some(document);
            document_changed = true;
        }
        if update.snapshot.lyrics.status != "ready" && self.current_document.take().is_some() {
            self.current_document_key = None;
            document_changed = true;
        }
        self.policy.no_content = update.snapshot.track.is_none()
            || update.snapshot.lyrics.status != "ready"
            || self.current_document.is_none();
        if self.source_state != "ok" || self.source_message.is_some() {
            self.source_state = "ok";
            self.source_message = None;
            self.send_source();
        }
        // 先快照后文档：页面用新快照的 documentKey 校验文档，顺序反了会把同一拍
        // 刚取回的文档当成旧文档丢掉。
        self.last_snapshot = Some(update.snapshot);
        self.send_snapshot();
        if document_changed {
            self.send_document();
        }
        self.recompute_visibility();
        if let Some(warning) = update.warning {
            if self.last_warning.as_deref() != Some(&warning) {
                log(&warning);
                self.last_warning = Some(warning);
            }
        }
    }

    fn handle_feed_error(&mut self, message: String) {
        if self.last_feed_error.as_deref() != Some(&message) {
            log(&format!("source error: {message}"));
            self.last_feed_error = Some(message.clone());
        }
        let waiting = message.contains("未找到") || message.contains("未启动");
        self.source_state = if waiting { "waiting" } else { "error" };
        self.source_message = Some(message);
        self.last_snapshot = None;
        self.current_track = None;
        self.current_document = None;
        self.current_document_key = None;
        self.policy.no_content = true;
        self.send_document();
        self.send_snapshot();
        self.send_source();
        self.recompute_visibility();
    }

    fn recompute_visibility(&mut self) {
        let visible = self.config.lyrics.enabled && self.policy.visible();
        if visible == self.visible {
            return;
        }
        self.visible = visible;
        if visible {
            native::show_no_activate(self.hwnd());
        } else {
            native::hide(self.hwnd());
        }
        self.eval(&format!(
            "window.hertzLyrics && window.hertzLyrics.setActive({visible});"
        ));
    }

    fn recompute_wallpaper(&mut self) {
        let Some(surface) = self.wallpaper.as_ref() else {
            return;
        };
        // 页面就绪前不能把 WebView2 隐藏：隐藏会让页面不加载，dom_ready 永远不来。
        if !self.wallpaper_page_ready {
            return;
        }
        let visible = (self.config.wallpaper.enabled || self.wallpaper_forced)
            && self.config.wallpaper.fps > 0
            && !self.wallpaper_hidden
            && self.policy.renderable();
        self.wallpaper_visible = visible;
        if visible {
            surface.start(self.config.wallpaper.fps);
        } else {
            surface.stop();
        }
    }

    fn handle_wallpaper_feed(&mut self, result: Result<WallpaperSnapshot, FeedError>) {
        match result {
            Ok(snapshot) => {
                if !self.wallpaper_feed_logged {
                    log(&format!(
                        "wallpaper feed ok seq={} session={}",
                        snapshot.seq, snapshot.server.session
                    ));
                    self.wallpaper_feed_logged = true;
                }
                self.wallpaper_last = Some(snapshot.clone());
                if let Some(surface) = self.wallpaper.as_ref() {
                    if self.config.wallpaper.music_response && self.wallpaper_page_ready {
                        surface.apply_feed(&snapshot);
                    } else if !self.config.wallpaper.music_response {
                        surface.clear_feed();
                    }
                }
            }
            Err(error) => {
                log(&format!("wallpaper feed {error}"));
                self.wallpaper_feed_logged = false;
                self.wallpaper_last = None;
                if let Some(surface) = self.wallpaper.as_ref() {
                    surface.clear_feed();
                }
            }
        }
        self.recompute_wallpaper();
    }

    fn handle_wallpaper_page(&mut self, event: &str) {
        match event {
            "wallpaper_dom_ready" => {
                log("wallpaper page dom ready");
                self.wallpaper_page_ready = true;
            }
            "wallpaper_ready" => {
                log("wallpaper page mounted");
                self.wallpaper_page_ready = true;
            }
            "wallpaper_mount_failed" => {
                log("wallpaper page mount failed");
                self.wallpaper_page_ready = false;
            }
            other => log(&format!("unknown wallpaper page event: {other}")),
        }
        if self.wallpaper_page_ready {
            if let Some(snapshot) = self.wallpaper_last.as_ref() {
                if let Some(surface) = self.wallpaper.as_ref() {
                    if self.config.wallpaper.music_response {
                        surface.apply_feed(snapshot);
                    }
                }
            }
        }
        self.recompute_wallpaper();
    }

    fn set_locked(&mut self, locked: bool) {
        if locked && self.tray.is_none() {
            self.source_state = "error";
            self.source_message = Some("托盘未就绪，暂时不能锁定".into());
            self.send_source();
            log("refuse lock: tray unavailable");
            return;
        }
        self.config.lyrics.locked = locked;
        self.policy.locked = locked;
        native::set_locked(self.hwnd(), locked);
        self.eval(&format!(
            "window.hertzLyrics && window.hertzLyrics.setLocked({locked});"
        ));
        self.schedule_save();
        self.recompute_visibility();
        self.sync_tray();
    }

    fn locate(&mut self) {
        self.config.lyrics.enabled = true;
        self.policy.user_hidden = false;
        if self.config.lyrics.locked {
            self.config.lyrics.locked = false;
            self.policy.locked = false;
            native::set_locked(self.hwnd(), false);
            self.eval("window.hertzLyrics && window.hertzLyrics.setLocked(false);");
            self.schedule_save();
        }
        self.place(true);
        native::show_no_activate(self.hwnd());
        native::focus(self.hwnd());
        self.recompute_visibility();
        self.send_config();
        self.send_source();
        self.send_document();
        self.send_snapshot();
        self.sync_tray();
    }

    fn schedule_save(&mut self) {
        self.save_due = Some(Instant::now() + SAVE_DEBOUNCE);
    }

    fn flush_save(&mut self) {
        if self.save_due.is_none_or(|due| due > Instant::now()) {
            return;
        }
        self.save_due = None;
        self.config.revision = self.config.revision.saturating_add(1);
        if let Err(error) = config::save(&self.config) {
            log(&format!("save config failed: {error:#}"));
        }
    }

    fn sync_tray(&self) {
        if let Some(actions) = self.tray_actions.as_ref() {
            actions.toggle.set_checked(!self.policy.user_hidden);
            actions.autostart.set_checked(self.config.launch_at_login);
            if let Some(toggle) = actions.wallpaper_toggle.as_ref() {
                toggle.set_checked(!self.wallpaper_hidden);
            }
        }
    }

    fn page_command(&mut self, body: &str) {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Command {
            cmd: String,
            #[serde(default)]
            value: Option<f64>,
            #[serde(default)]
            text: Option<String>,
        }
        let Ok(command) = serde_json::from_str::<Command>(body) else {
            log("ignore malformed page command");
            return;
        };
        match command.cmd.as_str() {
            "ready" => {
                self.page_ready = true;
                self.send_all();
            }
            "lock" => self.set_locked(true),
            "hide" => {
                self.policy.user_hidden = true;
                self.recompute_visibility();
                self.sync_tray();
            }
            "locate" => self.locate(),
            "drag" => {
                let _ = self.window.drag_window();
            }
            "layout" => {
                self.config.lyrics.layout = match self.config.lyrics.layout {
                    Layout::Double => Layout::Single,
                    Layout::Single => Layout::Double,
                };
                self.send_config();
                self.place(true);
                self.schedule_save();
            }
            "secondary" => {
                self.config.lyrics.secondary = match self.config.lyrics.secondary {
                    Secondary::Next => Secondary::Translation,
                    Secondary::Translation => Secondary::Romanization,
                    Secondary::Romanization => Secondary::Next,
                };
                self.send_config();
                self.schedule_save();
            }
            "font" => {
                if let Some(delta) = command.value {
                    self.config.lyrics.font_size =
                        (self.config.lyrics.font_size + delta).clamp(18.0, 72.0);
                    self.send_config();
                    self.place(true);
                    self.schedule_save();
                }
            }
            "opacity" => {
                if let Some(delta) = command.value {
                    self.config.lyrics.opacity =
                        (self.config.lyrics.opacity + delta).clamp(0.25, 1.0);
                    self.send_config();
                    self.schedule_save();
                }
            }
            "width" => {
                if let Some(delta) = command.value {
                    self.config.lyrics.width =
                        (self.config.lyrics.width + delta).clamp(240.0, 2400.0);
                    self.place(true);
                    self.schedule_save();
                }
            }
            "quit" => {
                log("quit from page");
                self.flush_save();
                let _ = self.proxy.send_event(UserEvent::Quit);
            }
            "log" => {
                if let Some(text) = command.text {
                    log(&format!("page: {text}"));
                }
            }
            other => log(&format!("unknown page command: {other}")),
        }
    }

    fn handle_menu(&mut self, id: &str) {
        let Some(actions) = self.tray_actions.as_ref() else {
            return;
        };
        if id == actions.toggle_id {
            self.policy.user_hidden = !self.policy.user_hidden;
            self.recompute_visibility();
            self.sync_tray();
        } else if id == actions.locate_id {
            self.locate();
        } else if id == actions.autostart_id {
            let enable = !self.config.launch_at_login;
            match native::set_autostart(enable) {
                Ok(()) => {
                    self.config.launch_at_login = enable;
                    log(&format!("autostart={enable}"));
                    self.schedule_save();
                }
                Err(error) => {
                    log(&format!("autostart failed: {error:#}"));
                    self.source_state = "error";
                    self.source_message = Some(format!("开机启动设置失败：{error}"));
                    self.send_source();
                }
            }
            self.sync_tray();
        } else if actions
            .wallpaper_toggle_id
            .as_deref()
            .is_some_and(|toggle| toggle == id)
        {
            self.wallpaper_hidden = !self.wallpaper_hidden;
            log(&format!("wallpaper_hidden={}", self.wallpaper_hidden));
            self.recompute_wallpaper();
            self.sync_tray();
        } else if id == actions.quit_id {
            log("quit from tray");
            self.flush_save();
            let _ = self.proxy.send_event(UserEvent::Quit);
        }
    }

    fn handle_tray(&mut self, event: TrayIconEvent) {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            self.locate();
        }
    }

    fn handle_pipe_request(&mut self, request: &serde_json::Value) -> serde_json::Value {
        let command = request
            .get("command")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let value = request.get("value");
        match command {
            "status" => {}
            "lock" => {
                if self.tray.is_none() {
                    return pipe_error("tray_unavailable");
                }
                self.set_locked(true);
            }
            "unlock" => self.set_locked(false),
            "show" => {
                self.config.lyrics.enabled = true;
                self.policy.user_hidden = false;
                self.recompute_visibility();
                native::raise(self.hwnd());
            }
            "hide" => {
                self.policy.user_hidden = true;
                self.recompute_visibility();
            }
            "locate" => self.locate(),
            "layout" => {
                let layout = match value.and_then(|value| value.as_str()) {
                    Some("single") => Layout::Single,
                    Some("double") => Layout::Double,
                    _ => return pipe_error("invalid_value"),
                };
                self.config.lyrics.layout = layout;
                self.send_config();
                self.place(true);
                self.schedule_save();
            }
            "secondary" => {
                let secondary = match value.and_then(|value| value.as_str()) {
                    Some("next") => Secondary::Next,
                    Some("translation") => Secondary::Translation,
                    Some("romanization") => Secondary::Romanization,
                    _ => return pipe_error("invalid_value"),
                };
                self.config.lyrics.secondary = secondary;
                self.send_config();
                self.schedule_save();
            }
            "font" => {
                let Some(size) = value.and_then(|value| value.as_f64()) else {
                    return pipe_error("invalid_value");
                };
                self.config.lyrics.font_size = size.clamp(18.0, 72.0);
                self.send_config();
                self.place(true);
                self.schedule_save();
            }
            "opacity" => {
                let Some(opacity) = value.and_then(|value| value.as_f64()) else {
                    return pipe_error("invalid_value");
                };
                self.config.lyrics.opacity = opacity.clamp(0.25, 1.0);
                self.send_config();
                self.schedule_save();
            }
            "quit" => {
                self.flush_save();
                let proxy = self.proxy.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(150));
                    let _ = proxy.send_event(UserEvent::Quit);
                });
            }
            _ => return pipe_error("unsupported_command"),
        }
        self.status_json()
    }

    fn status_json(&self) -> serde_json::Value {
        serde_json::json!({
            "ok": true,
            "revision": self.config.revision,
            "locked": self.config.lyrics.locked,
            "enabled": self.config.lyrics.enabled,
            "userHidden": self.policy.user_hidden,
            "visible": self.visible,
            "source": self.source_state,
            "policy": {
                "fullscreen": self.policy.fullscreen,
                "sessionUnavailable": self.policy.session_unavailable,
                "displayOff": self.policy.display_off,
                "noContent": self.policy.no_content,
            },
            "profile": {
                "dataDir": self.profile.data_dir.to_string_lossy(),
                "edition": self.profile.edition,
            },
            "wallpaper": {
                "enabled": self.config.wallpaper.enabled || self.wallpaper_forced,
                "visible": self.wallpaper_visible,
                "pageReady": self.wallpaper_page_ready,
                "hidden": self.wallpaper_hidden,
            },
        })
    }

    fn handle_native(&mut self, event: NativeEvent) {
        match event {
            NativeEvent::TaskbarCreated => {
                log("explorer restarted; rebuilding tray");
                self.policy.user_hidden = true;
                if self.config.lyrics.locked {
                    self.config.lyrics.locked = false;
                    self.policy.locked = false;
                    native::set_locked(self.hwnd(), false);
                    self.schedule_save();
                }
                self.recompute_visibility();
                self.rebuild_tray();
            }
            NativeEvent::SessionUnavailable(unavailable) => {
                if self.policy.session_unavailable != unavailable {
                    log(&format!("session_unavailable={unavailable}"));
                    self.policy.session_unavailable = unavailable;
                    self.recompute_visibility();
                    self.recompute_wallpaper();
                }
            }
            NativeEvent::DisplayOff(off) => {
                if self.policy.display_off != off {
                    log(&format!("display_off={off}"));
                    self.policy.display_off = off;
                    self.recompute_visibility();
                    self.recompute_wallpaper();
                }
            }
        }
    }

    fn tick(&mut self) {
        self.flush_save();
        let now = Instant::now();
        if now.duration_since(self.last_check) >= Duration::from_secs(1) {
            self.last_check = now;
            let fullscreen = native::target_fullscreen(self.hwnd());
            if fullscreen != self.policy.fullscreen {
                self.policy.fullscreen = fullscreen;
                log(&format!("fullscreen={fullscreen}"));
                self.recompute_visibility();
                self.recompute_wallpaper();
            }
            self.ensure_on_screen();
            if now.duration_since(self.last_update) > STALE_AFTER && self.last_snapshot.is_some() {
                self.last_snapshot = None;
                self.current_document = None;
                self.current_document_key = None;
                self.policy.no_content = true;
                self.source_state = "waiting";
                self.source_message = Some("等待 Hertz 服务的新快照".into());
                self.send_document();
                self.send_snapshot();
                self.send_source();
                self.recompute_visibility();
                self.last_update = now;
            }
        }
        if self.visible && now.duration_since(self.last_raise) >= Duration::from_secs(2) {
            self.last_raise = now;
            native::raise(self.hwnd());
        }
        if now.duration_since(self.last_power_check) >= Duration::from_secs(60) {
            self.last_power_check = now;
            let cap = if native::on_ac_power() { 30 } else { 15 };
            if cap != self.frame_cap {
                self.frame_cap = cap;
                self.send_config();
            }
        }
    }

    fn ensure_on_screen(&mut self) {
        let hwnd = self.hwnd();
        let Some(rect) = native::window_rect(hwnd) else {
            return;
        };
        let center = windows_sys::Win32::Foundation::POINT {
            x: (rect.left + rect.right) / 2,
            y: (rect.top + rect.bottom) / 2,
        };
        let areas = native::monitors();
        if areas
            .iter()
            .any(|area| native::point_in_work_area(center, area))
        {
            return;
        }
        log("lyrics window left every monitor; moving to primary");
        self.config.lyrics.monitor = None;
        self.config.lyrics.anchor_x = 0.5;
        self.config.lyrics.anchor_y = 0.84;
        self.place(true);
        self.schedule_save();
    }

    fn target_area(&self) -> Option<native::WorkArea> {
        self.config
            .lyrics
            .monitor
            .as_deref()
            .and_then(native::work_area_by_name)
            .or_else(|| native::work_area_for_window(self.hwnd()))
            .or_else(native::primary_work_area)
    }

    fn height_dip(&self) -> f64 {
        let lyrics = &self.config.lyrics;
        let lines = match lyrics.layout {
            Layout::Double => 2.0,
            Layout::Single => 1.0,
        };
        let toolbar = if lyrics.locked { 0.0 } else { 30.0 };
        (lyrics.font_size * 1.55 * lines + 60.0 + toolbar).clamp(96.0, 360.0)
    }

    fn place(&mut self, keep_anchor: bool) {
        let Some(area) = self.target_area() else {
            return;
        };
        let scale = area.scale();
        let max_width = (f64::from(area.width()) / scale * 0.9).max(240.0);
        let width_dip = self.config.lyrics.width.min(max_width);
        let height_dip = self.height_dip();
        let width = (width_dip * scale).round() as i32;
        let height = (height_dip * scale).round() as i32;
        let (anchor_x, anchor_y) = if keep_anchor {
            (self.config.lyrics.anchor_x, self.config.lyrics.anchor_y)
        } else {
            (0.5, 0.84)
        };
        let available_x = (area.width() - width).max(0);
        let available_y = (area.height() - height).max(0);
        let x = area.left + (f64::from(available_x) * anchor_x).round() as i32;
        let y = area.top + (f64::from(available_y) * anchor_y).round() as i32;
        self.placing = true;
        unsafe {
            SetWindowPos(
                self.hwnd(),
                HWND_TOPMOST,
                x,
                y,
                width,
                height,
                SWP_NOACTIVATE,
            );
        }
        self.placing = false;
        self.window.set_always_on_top(true);
        self.sync_webview_bounds(width_dip, height_dip);
        let rect = native::window_rect(self.hwnd()).map(|rect| {
            format!(
                "{},{} {}x{}",
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top
            )
        });
        log(&format!(
            "place area={}x{} dpi={} scale={:.2} size={}x{} at={},{} rect={}",
            area.width(),
            area.height(),
            area.dpi,
            scale,
            width,
            height,
            x,
            y,
            rect.unwrap_or_else(|| "?".into())
        ));
    }

    /// wry 与 tao 在高 DPI 下的窗口尺寸语义并不总是一致：每次几何变化后
    /// 用逻辑尺寸显式校准 WebView 边界，避免页面比父窗口更高而被裁掉。
    fn sync_webview_bounds(&self, width_dip: f64, height_dip: f64) {
        let bounds = wry::Rect {
            position: wry::dpi::LogicalPosition::new(0.0, 0.0).into(),
            size: wry::dpi::LogicalSize::new(width_dip, height_dip).into(),
        };
        if let Err(error) = self.webview.set_bounds(bounds) {
            log(&format!("set webview bounds failed: {error}"));
        }
    }

    fn on_moved(&mut self) {
        if self.placing {
            return;
        }
        let hwnd = self.hwnd();
        let Some(rect) = native::window_rect(hwnd) else {
            return;
        };
        let Some(area) = native::work_area_for_window(hwnd) else {
            return;
        };
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if area.width() <= width || area.height() <= height {
            return;
        }
        self.config.lyrics.anchor_x =
            f64::from(rect.left - area.left) / f64::from(area.width() - width);
        self.config.lyrics.anchor_y =
            f64::from(rect.top - area.top) / f64::from(area.height() - height);
        self.config.lyrics.anchor_x = self.config.lyrics.anchor_x.clamp(0.0, 1.0);
        self.config.lyrics.anchor_y = self.config.lyrics.anchor_y.clamp(0.0, 1.0);
        if self.config.lyrics.monitor.as_deref() != Some(area.name.as_str()) {
            self.config.lyrics.monitor = Some(area.name);
        }
        self.schedule_save();
    }

    fn rebuild_tray(&mut self) {
        self.tray = None;
        self.tray_actions = None;
        match self.build_tray() {
            Ok((tray, actions)) => {
                self.tray = Some(tray);
                self.tray_actions = Some(actions);
                self.sync_tray();
                log("tray rebuilt");
            }
            Err(error) => {
                log(&format!("tray rebuild failed: {error:#}"));
            }
        }
    }

    fn build_tray(&self) -> Result<(TrayIcon, TrayActions)> {
        let menu = Menu::new();
        let toggle = CheckMenuItem::new("显示歌词", true, !self.policy.user_hidden, None);
        let locate = MenuItem::new("解锁并定位", true, None);
        let autostart = CheckMenuItem::new("开机启动", true, self.config.launch_at_login, None);
        let wallpaper_toggle = self
            .wallpaper
            .as_ref()
            .map(|_| CheckMenuItem::new("显示壁纸", true, !self.wallpaper_hidden, None));
        let quit = MenuItem::new("退出桌面歌词", true, None);
        let separator_after_toggle = PredefinedMenuItem::separator();
        let separator_before_wallpaper = PredefinedMenuItem::separator();
        let separator_before_quit = PredefinedMenuItem::separator();
        menu.append_items(&[&toggle, &separator_after_toggle, &locate, &autostart])?;
        if let Some(wallpaper) = wallpaper_toggle.as_ref() {
            menu.append(&separator_before_wallpaper)?;
            menu.append(wallpaper)?;
        }
        menu.append(&separator_before_quit)?;
        menu.append(&quit)?;
        let actions = TrayActions {
            toggle_id: toggle.id().0.clone(),
            autostart_id: autostart.id().0.clone(),
            wallpaper_toggle_id: wallpaper_toggle.as_ref().map(|item| item.id().0.clone()),
            locate_id: locate.id().0.clone(),
            quit_id: quit.id().0.clone(),
            toggle,
            autostart,
            wallpaper_toggle,
        };
        let tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("Hertz 桌面歌词")
            .with_icon(tray_icon_image()?)
            .build()?;
        Ok((tray, actions))
    }
}

pub(crate) fn run() -> Result<()> {
    let mut args = Args::parse()?;
    let locate_on_start = args.locate;
    init_log();
    if args.wallpaper_feed_test {
        let config = config::load()?;
        let profile = args
            .data_dir
            .take()
            .map(|data_dir| Profile {
                data_dir,
                edition: "custom".into(),
            })
            .or_else(|| config.active_profile.clone())
            .or_else(config::detect_profile)
            .unwrap_or_else(default_profile);
        return run_wallpaper_feed_test(profile);
    }
    log(&format!(
        "starting hertz-desktop {} pid={}",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    ));
    let Some(_instance) = native::acquire_single_instance() else {
        log("another hertz-desktop instance is running; exiting");
        return Ok(());
    };
    let mut config = config::load()?;
    config.sanitize();
    let profile = args
        .data_dir
        .take()
        .map(|data_dir| Profile {
            data_dir,
            edition: "custom".into(),
        })
        .or_else(|| config.active_profile.clone())
        .or_else(config::detect_profile)
        .unwrap_or_else(default_profile);
    if config.active_profile.as_ref() != Some(&profile) {
        config.active_profile = Some(profile.clone());
        if let Err(error) = config::save(&config) {
            log(&format!("save initial profile failed: {error:#}"));
        }
    }
    let wallpaper_forced = args.wallpaper;
    log(&format!(
        "profile={} edition={} discovery={}",
        profile.data_dir.display(),
        profile.edition,
        profile.data_dir.join("vmusicd.json").display()
    ));

    std::fs::create_dir_all(config::webview_dir()).ok();
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", config::webview_dir());

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    install_global_handlers(proxy.clone());

    let window = WindowBuilder::new()
        .with_title("Hertz 桌面歌词")
        .with_inner_size(tao::dpi::LogicalSize::new(
            config.lyrics.width.max(240.0),
            160.0,
        ))
        .with_position(tao::dpi::LogicalPosition::new(80.0, 80.0))
        .with_decorations(false)
        .with_transparent(true)
        .with_resizable(false)
        .with_visible(false)
        .with_focused(false)
        .with_always_on_top(true)
        .with_skip_taskbar(true)
        .with_undecorated_shadow(false)
        .build(&event_loop)?;
    let hwnd = window.hwnd() as HWND;
    native::strip_title_bar(hwnd);
    native::make_tool_window(hwnd);
    native::install_hit_test_subclass(hwnd);

    let page_proxy = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_transparent(true)
        .with_html(page_html())
        .with_ipc_handler(move |request| {
            let body = request.body();
            if body.len() <= 4096 {
                let _ = page_proxy.send_event(UserEvent::Page(body.clone()));
            }
        })
        .build(&window)
        .map_err(|error| {
            native::dialog_error(
                "无法创建 WebView2 歌词窗口。\n请安装 Microsoft Edge WebView2 Runtime 后重试。",
            );
            anyhow::anyhow!("创建 WebView2 失败：{error}")
        })?;

    let wallpaper = if config.wallpaper.enabled || wallpaper_forced {
        match create_wallpaper(&event_loop, proxy.clone()) {
            Ok(surface) => Some(surface),
            Err(error) => {
                log(&format!("wallpaper unavailable: {error:#}"));
                None
            }
        }
    } else {
        None
    };

    let mut app = App {
        window,
        webview,
        tray: None,
        tray_actions: None,
        config,
        profile,
        policy: Policy {
            locked: false,
            user_hidden: false,
            fullscreen: false,
            session_unavailable: false,
            display_off: false,
            no_content: true,
        },
        last_snapshot: None,
        last_update: Instant::now(),
        current_track: None,
        current_document_key: None,
        current_document: None,
        page_ready: false,
        visible: false,
        placing: false,
        save_due: None,
        last_check: Instant::now(),
        last_power_check: Instant::now() - Duration::from_secs(60),
        last_raise: Instant::now() - Duration::from_secs(10),
        frame_cap: if native::on_ac_power() { 30 } else { 15 },
        last_feed_error: None,
        last_warning: None,
        source_state: "waiting",
        source_message: Some("正在连接 Hertz 服务".into()),
        wallpaper,
        wallpaper_page_ready: false,
        wallpaper_last: None,
        wallpaper_feed_logged: false,
        wallpaper_visible: false,
        wallpaper_hidden: false,
        wallpaper_forced,
        proxy: proxy.clone(),
    };
    app.policy.locked = app.config.lyrics.locked;
    match app.build_tray() {
        Ok((tray, actions)) => {
            app.tray = Some(tray);
            app.tray_actions = Some(actions);
        }
        Err(error) => {
            log(&format!("tray unavailable: {error:#}"));
            app.config.lyrics.locked = false;
            app.policy.locked = false;
            app.schedule_save();
        }
    }
    native::set_locked(app.hwnd(), app.config.lyrics.locked);
    app.place(true);
    app.recompute_visibility();
    app.recompute_wallpaper();
    if locate_on_start {
        app.locate();
    }

    if app.config.wallpaper.enabled || app.wallpaper_forced {
        spawn_wallpaper_feed(app.profile.clone(), proxy.clone());
    }
    spawn_feed(app.profile.clone(), proxy.clone());
    spawn_ticker(proxy.clone());
    let pipe_proxy = proxy.clone();
    if let Err(error) = crate::pipe::start(move |request| {
        let _ = pipe_proxy.send_event(UserEvent::Pipe(request));
    }) {
        log(&format!("control pipe unavailable: {error:#}"));
    }
    let message_proxy = proxy.clone();
    if let Err(error) = native::install_message_window(move |event| {
        let _ = message_proxy.send_event(UserEvent::Native(event));
    }) {
        log(&format!("message window unavailable: {error:#}"));
    }

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Feed(result)) => match *result {
                Ok(update) => app.handle_update(update),
                Err(message) => app.handle_feed_error(message),
            },
            Event::UserEvent(UserEvent::WallpaperFeed(result)) => {
                app.handle_wallpaper_feed(*result)
            }
            Event::UserEvent(UserEvent::WallpaperPage(body)) => app.handle_wallpaper_page(&body),
            Event::UserEvent(UserEvent::Tick) => app.tick(),
            Event::UserEvent(UserEvent::Page(body)) => app.page_command(&body),
            Event::UserEvent(UserEvent::Tray(event)) => app.handle_tray(event),
            Event::UserEvent(UserEvent::Menu(event)) => app.handle_menu(&event.id.0),
            Event::UserEvent(UserEvent::Native(event)) => app.handle_native(event),
            Event::UserEvent(UserEvent::Pipe(request)) => {
                let response = app.handle_pipe_request(&request.body);
                let _ = request.reply.send(response);
            }
            Event::UserEvent(UserEvent::Quit) => *control_flow = ControlFlow::Exit,
            Event::WindowEvent {
                window_id, event, ..
            } => {
                if window_id == app.window.id() {
                    match event {
                        WindowEvent::CloseRequested => *control_flow = ControlFlow::Exit,
                        WindowEvent::Moved(_) => app.on_moved(),
                        WindowEvent::ScaleFactorChanged { .. } => app.place(true),
                        _ => {}
                    }
                }
            }
            Event::LoopDestroyed => {
                log("event loop destroyed");
            }
            _ => {}
        }
    });
}

fn pipe_error(code: &str) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": code })
}

fn install_global_handlers(proxy: EventLoopProxy<UserEvent>) {
    let tray_proxy = proxy.clone();
    TrayIconEvent::set_event_handler(Some(move |event| {
        let _ = tray_proxy.send_event(UserEvent::Tray(event));
    }));
    let menu_proxy = proxy;
    MenuEvent::set_event_handler(Some(move |event| {
        let _ = menu_proxy.send_event(UserEvent::Menu(event));
    }));
}

fn spawn_feed(profile: Profile, proxy: EventLoopProxy<UserEvent>) {
    std::thread::Builder::new()
        .name("hertz-desktop-feed".into())
        .spawn(move || {
            let mut feed = match Feed::new(profile) {
                Ok(feed) => feed,
                Err(error) => {
                    let _ = proxy.send_event(UserEvent::Feed(Box::new(Err(format!("{error:#}")))));
                    return;
                }
            };
            loop {
                let update = feed.poll().map_err(|error| format!("{error:#}"));
                let failed = update.is_err();
                if proxy.send_event(UserEvent::Feed(Box::new(update))).is_err() {
                    break;
                }
                std::thread::sleep(if failed { POLL_ERROR } else { POLL_IDLE });
            }
        })
        .ok();
}

fn create_wallpaper(
    event_loop: &EventLoop<UserEvent>,
    proxy: EventLoopProxy<UserEvent>,
) -> Result<WallpaperSurface> {
    let (width, height) = native::primary_screen_size();
    let window = WindowBuilder::new()
        .with_title("Hertz wallpaper")
        .with_inner_size(PhysicalSize::new(width.max(1) as u32, height.max(1) as u32))
        .with_position(PhysicalPosition::new(0, 0))
        .with_decorations(false)
        .with_resizable(false)
        .with_visible(false)
        .with_focused(false)
        .with_skip_taskbar(true)
        .with_undecorated_shadow(false)
        .build(event_loop)?;
    let hwnd = window.hwnd() as HWND;
    native::mount_wallpaper(hwnd)?;
    let page_proxy = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_html(wallpaper_html())
        .with_background_color((3, 4, 5, 255))
        .with_ipc_handler(move |request| {
            let body = request.body();
            if body.starts_with("wallpaper") {
                let _ = page_proxy.send_event(UserEvent::WallpaperPage(body.clone()));
            }
        })
        .build(&window)
        .map_err(|error| anyhow::anyhow!("创建壁纸 WebView 失败：{error}"))?;
    Ok(WallpaperSurface {
        _window: window,
        webview,
    })
}

fn wallpaper_html() -> String {
    include_str!("../assets/wallpaper-scene.html")
        .replace(
            "__RUNTIME__",
            include_str!("../../../plugin/ui/vendor/stage-runtime.js"),
        )
        .replace(
            "__SHIM__",
            include_str!("../../../plugin/ui/vendor/zodiac-stage.js"),
        )
        .replace("__SCENE__", include_str!("../assets/wallpaper-scene.js"))
}

fn spawn_wallpaper_feed(profile: Profile, proxy: EventLoopProxy<UserEvent>) {
    std::thread::Builder::new()
        .name("hertz-wallpaper-feed".into())
        .spawn(move || {
            let mut feed = match WallpaperFeed::new(profile) {
                Ok(feed) => feed,
                Err(error) => {
                    log(&format!("wallpaper feed init failed: {error:#}"));
                    return;
                }
            };
            loop {
                let result = feed.poll();
                let failed = result.is_err();
                if proxy
                    .send_event(UserEvent::WallpaperFeed(Box::new(result)))
                    .is_err()
                {
                    break;
                }
                std::thread::sleep(if failed { POLL_ERROR } else { POLL_IDLE });
            }
        })
        .ok();
}

fn spawn_ticker(proxy: EventLoopProxy<UserEvent>) {
    std::thread::Builder::new()
        .name("hertz-desktop-tick".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(500));
            if proxy.send_event(UserEvent::Tick).is_err() {
                break;
            }
        })
        .ok();
}

fn default_profile() -> Profile {
    let dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("hertz-studio");
    Profile {
        data_dir: dir,
        edition: "full".into(),
    }
}

fn page_html() -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<style>{}</style></head><body class=\"unlocked\">{}</body>\
<script>{}</script></html>",
        include_str!("../assets/desktop-lyrics.css"),
        include_str!("../assets/desktop-lyrics.html"),
        include_str!("../assets/desktop-lyrics.js")
    )
}

fn tray_icon_image() -> Result<Icon> {
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

fn run_wallpaper_feed_test(profile: Profile) -> Result<()> {
    let mut feed = crate::wallpaper_feed::Feed::new(profile)?;
    for _ in 0..5 {
        match feed.poll() {
            Ok(snapshot) => {
                let peak = snapshot
                    .effective_bands(0)
                    .into_iter()
                    .fold(0.0f32, f32::max);
                log(&format!(
                    "wallpaper feed seq={} session={} playing={} position_ms={} interpolated={:?} energy={:.3} peak={:.3} age_ms={:?}",
                    snapshot.seq,
                    snapshot.server.session,
                    snapshot.playing,
                    snapshot.position_ms,
                    snapshot.interpolated_position_ms(0),
                    snapshot.spectrum.energy,
                    peak,
                    snapshot.spectrum.age_ms
                ));
            }
            Err(error) => log(&format!("wallpaper feed {error}")),
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(())
}

struct Args {
    data_dir: Option<PathBuf>,
    locate: bool,
    wallpaper_feed_test: bool,
    wallpaper: bool,
}

impl Args {
    fn parse() -> Result<Self> {
        let mut data_dir = None;
        let mut locate = false;
        let mut wallpaper_feed_test = false;
        let mut wallpaper = false;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--data-dir" => {
                    data_dir = Some(PathBuf::from(
                        args.next().context("--data-dir 需要一个路径")?,
                    ));
                }
                "--locate" => locate = true,
                "--wallpaper-feed-test" => wallpaper_feed_test = true,
                "--wallpaper" => wallpaper = true,
                "--help" | "-h" => {
                    println!(
                        "hertz-desktop [--data-dir <path>] [--locate] [--wallpaper] [--wallpaper-feed-test]"
                    );
                    println!("桌面歌词宿主；配置位于 %LOCALAPPDATA%\\Hertz\\Desktop\\config.json");
                    std::process::exit(0);
                }
                "--version" | "-V" => {
                    println!("hertz-desktop {}", env!("CARGO_PKG_VERSION"));
                    std::process::exit(0);
                }
                other => anyhow::bail!("未知参数：{other}"),
            }
        }
        Ok(Self {
            data_dir,
            locate,
            wallpaper_feed_test,
            wallpaper,
        })
    }
}

pub(crate) fn log(message: &str) {
    let seq = LOG_SEQ.fetch_add(1, Ordering::Relaxed);
    let line = format!("[{}] {message}", chrono_like_now(seq));
    println!("{line}");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(config::log_path())
    {
        use std::io::Write;
        let _ = writeln!(file, "{line}");
    }
}

/// 不引入时间库：日志只需要可排序的本地时刻与序号。
fn chrono_like_now(seq: u64) -> String {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{}.{:03} #{seq}",
        elapsed.as_secs(),
        elapsed.subsec_millis()
    )
}

fn init_log() {
    let _ = std::fs::create_dir_all(config::base_dir());
    let path = config::log_path();
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > 1024 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
}
