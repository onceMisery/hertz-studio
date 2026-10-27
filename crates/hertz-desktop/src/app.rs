// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 桌面歌词宿主：窗口、托盘、来源线程与可见性策略。

use std::borrow::Cow;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::Deserialize;
use tao::dpi::{PhysicalPosition, PhysicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::platform::windows::{WindowBuilderExtWindows, WindowExtWindows};
use tao::window::{Window, WindowBuilder};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOSIZE,
};
use wry::http::{header, Request, Response};
use wry::WebViewBuilder;

use crate::config::{self, Config, Layout, Profile, Secondary};
use crate::feed::{Document, Feed, Snapshot};
use crate::native::{self, NativeEvent};
use crate::wallpaper_feed::{
    Feed as WallpaperFeed, FeedError, Snapshot as WallpaperSnapshot, ERR_EVENTS_UNAVAILABLE,
};

const POLL_IDLE: Duration = Duration::from_millis(500);
const POLL_ERROR: Duration = Duration::from_secs(1);
const SAVE_DEBOUNCE: Duration = Duration::from_millis(400);
const STALE_AFTER: Duration = Duration::from_secs(3);
const PREVIEW_LEASE: Duration = Duration::from_secs(15);
/// 页面每 2 s 心跳；可见状态下超过这个时间没有有效心跳就按渲染停摆重建。
const HEARTBEAT_STALE: Duration = Duration::from_secs(10);

static LOG_SEQ: AtomicU64 = AtomicU64::new(0);

pub(crate) enum UserEvent {
    Feed(u64, Box<Result<crate::feed::FeedUpdate, String>>),
    WallpaperFeed(u64, Box<Result<WallpaperSnapshot, FeedError>>),
    WallpaperPage(u64, String),
    SettingsPage(String),
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
    window: Window,
    webview: wry::WebView,
    monitor: native::WallpaperMonitor,
    zoom: f64,
    eval_failures: AtomicU64,
}

impl WallpaperSurface {
    fn hwnd(&self) -> HWND {
        self.window.hwnd() as HWND
    }

    fn eval(&self, script: &str) {
        match self.webview.evaluate_script(script) {
            Ok(()) => self.eval_failures.store(0, Ordering::Relaxed),
            Err(error) => {
                self.eval_failures.fetch_add(1, Ordering::Relaxed);
                log(&format!("wallpaper evaluate_script failed: {error}"));
            }
        }
    }

    fn eval_failures(&self) -> u64 {
        self.eval_failures.load(Ordering::Relaxed)
    }

    fn reset_eval_failures(&self) {
        self.eval_failures.store(0, Ordering::Relaxed);
    }

    fn apply_feed(&self, snapshot: &WallpaperSnapshot) {
        if let Ok(payload) = serde_json::to_string(snapshot) {
            self.eval(&format!(
                "window.hertzWallpaper && window.hertzWallpaper.applyFeed({payload});"
            ));
        }
    }

    fn apply_config(&self, source: &str, scene: &str, music_response: bool) {
        if let Ok(payload) = serde_json::to_string(&serde_json::json!({
            "source": source,
            "scene": scene,
            "musicResponse": music_response,
            "allowed": config::WALLPAPER_SCENES
                .iter()
                .map(|(id, _)| *id)
                .collect::<Vec<_>>(),
        })) {
            self.eval(&format!(
                "window.hertzWallpaper && window.hertzWallpaper.applyConfig({payload});"
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

    fn apply_zoom(&mut self, target_dpi: u32) -> Result<()> {
        let window_dpi = native::window_dpi(self.hwnd()).max(1);
        let zoom = f64::from(target_dpi) / f64::from(window_dpi);
        if (zoom - self.zoom).abs() > 0.001 {
            self.webview
                .zoom(zoom)
                .map_err(|error| anyhow::anyhow!("应用壁纸 DPI 缩放失败：{error}"))?;
            self.zoom = zoom;
        }
        Ok(())
    }

    /// 拓扑变化后原地重挂到新的显示器矩形。WorkerW 是 Progman 的子窗，
    /// mount_wallpaper 会按新的虚拟屏原点重算父层与子窗位置。
    fn reflow(&mut self, monitor: native::WallpaperMonitor) -> Result<()> {
        native::mount_wallpaper(self.hwnd(), &monitor)?;
        self.apply_zoom(monitor.dpi)?;
        let child_rect = native::window_rect(self.hwnd())
            .map(|rect| (rect.left, rect.top, rect.right, rect.bottom));
        let parent_rect = native::parent_window_rect(self.hwnd())
            .map(|rect| (rect.left, rect.top, rect.right, rect.bottom));
        log(&format!(
            "wallpaper reflow name={} rect={},{} {}x{} dpi={} zoom={:.3} child={child_rect:?} parent={parent_rect:?}",
            monitor.name,
            monitor.left,
            monitor.top,
            monitor.width,
            monitor.height,
            monitor.dpi,
            self.zoom
        ));
        self.monitor = monitor;
        Ok(())
    }
}

struct SettingsSurface {
    window: Window,
    webview: Rc<wry::WebView>,
}

impl SettingsSurface {
    fn eval(&self, script: &str) {
        if let Err(error) = self.webview.evaluate_script(script) {
            log(&format!("settings evaluate_script failed: {error}"));
        }
    }
}

struct PreviewSurface {
    webview: Rc<wry::WebView>,
    fps: u8,
    music_response: bool,
    source: String,
    scene: String,
    ready: bool,
    lease_until: Instant,
}

struct PositionEdit {
    lyrics: config::LyricsConfig,
    user_hidden: bool,
}

impl PreviewSurface {
    fn eval(&self, script: &str) {
        let script = serde_json::to_string(script).unwrap_or_default();
        if let Err(error) = self.webview.evaluate_script(&format!(
            "window.hertzWallpaperSettings && window.hertzWallpaperSettings.evalPreview({script});"
        )) {
            log(&format!("preview evaluate_script failed: {error}"));
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

    fn apply_config(&self) {
        if let Ok(payload) = serde_json::to_string(&serde_json::json!({
            "source": self.source,
            "scene": self.scene,
            "musicResponse": self.music_response,
            "allowed": config::WALLPAPER_SCENES
                .iter()
                .map(|(id, _)| *id)
                .collect::<Vec<_>>(),
        })) {
            self.eval(&format!(
                "window.hertzWallpaper && window.hertzWallpaper.applyConfig({payload});"
            ));
        }
    }

    fn start(&self) {
        self.eval(&format!(
            "window.hertzWallpaper && window.hertzWallpaper.start({});",
            self.fps
        ));
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WallpaperCandidate {
    enabled: bool,
    fps: u8,
    music_response: bool,
    #[serde(default)]
    monitor: Option<String>,
    #[serde(default = "config::default_wallpaper_source")]
    source: String,
    #[serde(default = "config::default_wallpaper_scene")]
    scene: String,
}

struct TrayActions {
    toggle: CheckMenuItem,
    autostart: CheckMenuItem,
    wallpaper_toggle: Option<CheckMenuItem>,
    toggle_id: String,
    locate_id: String,
    autostart_id: String,
    settings_id: String,
    wallpaper_toggle_id: Option<String>,
    wallpaper_retry_id: Option<String>,
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
    wallpaper_heartbeat_at: Option<Instant>,
    wallpaper_heartbeat_ticks: u64,
    wallpaper_heartbeat_draws: u64,
    wallpaper_fps_sample: Option<(Instant, u64)>,
    wallpaper_measured_fps: Option<f64>,
    wallpaper_visible: bool,
    wallpaper_hidden: bool,
    wallpaper_forced: bool,
    source_generation: u64,
    lyrics_feed_stop: Arc<AtomicBool>,
    wallpaper_feed_stop: Option<Arc<AtomicBool>>,
    wallpaper_generation: u64,
    wallpaper_recovery_attempts: Vec<Instant>,
    wallpaper_recovery_terminal: bool,
    wallpaper_monitor_missing: bool,
    settings: Option<SettingsSurface>,
    settings_candidate: Option<Profile>,
    settings_tab: String,
    settings_navigation: u64,
    preview: Option<PreviewSurface>,
    position_edit: Option<PositionEdit>,
    placed_position: Option<(i32, i32)>,
    /// 页面样式条高度（DIP）；展开时窗口向下长高，歌词区域保持原高度。
    panel_height: f64,
    /// 样式条展开期间的窗口顶边（物理像素），关掉面板后回到锚点定位。
    panel_top: Option<i32>,
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

    fn reset_wallpaper_heartbeat(&mut self) {
        self.wallpaper_heartbeat_at = None;
        self.wallpaper_fps_sample = None;
        self.wallpaper_measured_fps = None;
    }

    fn reset_wallpaper_page_stats(&mut self) {
        self.wallpaper_heartbeat_ticks = 0;
        self.wallpaper_heartbeat_draws = 0;
        self.reset_wallpaper_heartbeat();
    }

    fn sample_wallpaper_fps(&mut self, now: Instant, draws: u64) {
        let Some((at, last)) = self.wallpaper_fps_sample else {
            self.wallpaper_fps_sample = Some((now, draws));
            return;
        };
        if draws < last {
            self.wallpaper_fps_sample = Some((now, draws));
            self.wallpaper_measured_fps = None;
            return;
        }
        if let Some(fps) = fps_from_draws(draws - last, now.duration_since(at)) {
            self.wallpaper_measured_fps = Some(fps);
            self.wallpaper_fps_sample = Some((now, draws));
        }
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
        if !native::wallpaper_alive(surface.hwnd()) {
            return;
        }
        if !native::wallpaper_monitors()
            .iter()
            .any(|monitor| monitor.name == surface.monitor.name)
        {
            if !self.wallpaper_monitor_missing {
                log(&format!(
                    "wallpaper target monitor missing; stop name={}",
                    surface.monitor.name
                ));
                self.wallpaper_monitor_missing = true;
            }
            surface.stop();
            self.wallpaper_visible = false;
            return;
        }
        if self.wallpaper_monitor_missing {
            log("wallpaper target monitor returned");
            self.wallpaper_monitor_missing = false;
        }
        // 页面就绪前不能把 WebView2 隐藏：隐藏会让页面不加载，dom_ready 永远不来。
        if !self.wallpaper_page_ready {
            return;
        }
        let visible = (self.config.wallpaper.enabled || self.wallpaper_forced)
            && self.config.wallpaper.fps > 0
            && !self.wallpaper_hidden
            && self.policy.renderable();
        let was_visible = self.wallpaper_visible;
        self.wallpaper_visible = visible;
        if visible {
            surface.start(self.config.wallpaper.fps);
            // 只在重新变为可见时给宽限；feed 每 250 ms 调本函数，不能把心跳
            // 时间一直刷新，否则页面停摆永远不会被判超时。
            if !was_visible {
                self.wallpaper_heartbeat_at = Some(Instant::now());
                self.wallpaper_fps_sample = Some((Instant::now(), self.wallpaper_heartbeat_draws));
                self.wallpaper_measured_fps = None;
            }
        } else {
            surface.stop();
            if was_visible {
                self.reset_wallpaper_heartbeat();
            }
        }
    }

    fn handle_wallpaper_feed(&mut self, result: Result<WallpaperSnapshot, FeedError>) {
        let previous_space = self
            .wallpaper_last
            .as_ref()
            .and_then(|snapshot| snapshot.space.as_ref())
            .map(|space| space.scene.clone());
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
                    if self.wallpaper_page_ready {
                        surface.apply_feed(&snapshot);
                    }
                }
                if let Some(preview) = self.preview.as_ref() {
                    if preview.ready {
                        preview.apply_feed(&snapshot);
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
                if let Some(preview) = self.preview.as_ref() {
                    preview.clear_feed();
                }
            }
        }
        let next_space = self
            .wallpaper_last
            .as_ref()
            .and_then(|snapshot| snapshot.space.as_ref())
            .map(|space| space.scene.clone());
        if self.settings.is_some() && previous_space != next_space {
            self.send_settings_status(None, None);
        }
        self.recompute_wallpaper();
    }

    fn handle_wallpaper_page(&mut self, generation: u64, event: &str) {
        if generation != self.wallpaper_generation {
            log(&format!(
                "ignore stale wallpaper page generation={generation} current={}",
                self.wallpaper_generation
            ));
            return;
        }
        if let Some((ticks, draws, mounted, lost)) = parse_wallpaper_heartbeat(event) {
            if mounted && !lost {
                let now = Instant::now();
                self.wallpaper_heartbeat_at = Some(now);
                self.wallpaper_heartbeat_ticks = ticks;
                self.wallpaper_heartbeat_draws = draws;
                self.sample_wallpaper_fps(now, draws);
            }
            return;
        }
        match event {
            "wallpaper_dom_ready" => {
                log("wallpaper page dom ready");
                self.wallpaper_page_ready = true;
                let now = Instant::now();
                self.wallpaper_heartbeat_ticks = 0;
                self.wallpaper_heartbeat_draws = 0;
                self.wallpaper_heartbeat_at = Some(now);
                self.wallpaper_fps_sample = Some((now, 0));
                self.wallpaper_measured_fps = None;
                if let Some(surface) = self.wallpaper.as_ref() {
                    surface.reset_eval_failures();
                }
            }
            "wallpaper_ready" => {
                log("wallpaper page mounted");
                self.wallpaper_page_ready = true;
                let now = Instant::now();
                self.wallpaper_heartbeat_ticks = 0;
                self.wallpaper_heartbeat_draws = 0;
                self.wallpaper_heartbeat_at = Some(now);
                self.wallpaper_fps_sample = Some((now, 0));
                self.wallpaper_measured_fps = None;
                if let Some(surface) = self.wallpaper.as_ref() {
                    surface.reset_eval_failures();
                }
            }
            "wallpaper_mount_failed" => {
                log("wallpaper page mount failed");
                self.wallpaper_page_ready = false;
                self.reset_wallpaper_page_stats();
            }
            other => log(&format!("unknown wallpaper page event: {other}")),
        }
        if self.wallpaper_page_ready {
            if let Some(surface) = self.wallpaper.as_ref() {
                surface.apply_config(
                    &self.config.wallpaper.source,
                    &self.config.wallpaper.scene,
                    self.config.wallpaper.music_response,
                );
            }
            if let Some(snapshot) = self.wallpaper_last.as_ref() {
                if let Some(surface) = self.wallpaper.as_ref() {
                    surface.apply_feed(snapshot);
                }
            }
        }
        self.recompute_wallpaper();
    }

    fn recover_wallpaper(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
        if !(self.config.wallpaper.enabled || self.wallpaper_forced) {
            return;
        }
        if self
            .wallpaper
            .as_ref()
            .is_some_and(|surface| native::wallpaper_alive(surface.hwnd()))
        {
            return;
        }
        let now = Instant::now();
        self.wallpaper_recovery_attempts
            .retain(|attempt| now.duration_since(*attempt) < Duration::from_secs(120));
        if self.wallpaper_recovery_terminal {
            log("wallpaper recovery terminal; waiting for explicit retry");
            return;
        }
        if self.wallpaper_recovery_attempts.len() >= 3 {
            self.wallpaper_recovery_terminal = true;
            log("wallpaper recovery terminal attempts>=3 window=120s");
            self.send_settings_status(Some("壁纸挂载失败，请从托盘重新挂载"), None);
            return;
        }
        self.wallpaper_recovery_attempts.push(now);
        let attempt = self.wallpaper_recovery_attempts.len();
        log(&format!("wallpaper recovery begin attempt={attempt}"));
        self.wallpaper = None;
        self.wallpaper_page_ready = false;
        self.wallpaper_visible = false;
        self.reset_wallpaper_page_stats();
        self.wallpaper_generation = self.wallpaper_generation.wrapping_add(1);
        match create_wallpaper(
            target,
            self.proxy.clone(),
            self.wallpaper_generation,
            self.config.wallpaper.monitor.as_deref(),
        ) {
            Ok(surface) => {
                self.wallpaper = Some(surface);
                log(&format!("wallpaper recovery success attempt={attempt}"));
            }
            Err(error) => {
                log(&format!(
                    "wallpaper recovery fail attempt={attempt} error={error:#}"
                ));
                self.send_settings_status(Some(&format!("壁纸挂载失败：{error}")), None);
            }
        }
        self.rebuild_tray();
    }

    fn retry_wallpaper(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
        log("wallpaper retry requested");
        self.wallpaper_recovery_terminal = false;
        self.wallpaper_recovery_attempts.clear();
        self.recover_wallpaper(target);
    }

    fn current_wallpaper_candidate(&self) -> WallpaperCandidate {
        WallpaperCandidate {
            enabled: self.config.wallpaper.enabled,
            fps: self.config.wallpaper.fps,
            music_response: self.config.wallpaper.music_response,
            monitor: self.config.wallpaper.monitor.clone(),
            source: self.config.wallpaper.source.clone(),
            scene: self.config.wallpaper.scene.clone(),
        }
    }

    fn send_settings_status(&self, error: Option<&str>, message: Option<&str>) {
        let Some(settings) = self.settings.as_ref() else {
            return;
        };
        let monitors: Vec<serde_json::Value> = native::wallpaper_monitors()
            .into_iter()
            .map(|monitor| {
                let label = format!(
                    "{} · {}×{} · {} DPI{}",
                    monitor.name.trim_start_matches("\\\\.\\"),
                    monitor.width,
                    monitor.height,
                    monitor.dpi,
                    if monitor.primary { " · 主屏" } else { "" }
                );
                serde_json::json!({
                    "name": monitor.name,
                    "label": label,
                    "primary": monitor.primary,
                    "left": monitor.left,
                    "top": monitor.top,
                    "width": monitor.width,
                    "height": monitor.height,
                    "dpi": monitor.dpi,
                })
            })
            .collect();
        let payload = serde_json::json!({
            "revision": self.config.revision,
            "config": {
                "enabled": self.config.wallpaper.enabled,
                "fps": self.config.wallpaper.fps,
                "musicResponse": self.config.wallpaper.music_response,
                "monitor": self.config.wallpaper.monitor,
                "source": self.config.wallpaper.source,
                "scene": self.config.wallpaper.scene,
            },
            "scenes": config::WALLPAPER_SCENES
                .iter()
                .map(|(id, label)| serde_json::json!({ "id": id, "label": label }))
                .collect::<Vec<_>>(),
            "spaceScene": self
                .wallpaper_last
                .as_ref()
                .and_then(|snapshot| snapshot.space.as_ref())
                .map(|space| space.scene.clone()),
            "profile": {
                "dataDir": self.profile.data_dir.to_string_lossy(),
                "edition": self.profile.edition,
            },
            "profiles": profile_options(
                &self.profile,
                &self.config,
                self.settings_candidate.as_ref(),
            ),
            "monitors": monitors,
            "previewActive": self.preview.is_some(),
            "lyricsConfig": self.position_edit.as_ref().map(|edit| &edit.lyrics).unwrap_or(&self.config.lyrics),
            "runtime": self.status_json(),
            "launchAtLogin": native::autostart_enabled().ok(),
            "positionEditing": self.position_edit.is_some(),
            "sourceMessage": self.source_message,
            "navigationRequest": { "id": self.settings_navigation, "tab": self.settings_tab },
            "error": error,
            "message": message,
        });
        settings.eval(&format!(
            "window.hertzWallpaperSettings && window.hertzWallpaperSettings.applyStatus({payload});"
        ));
    }

    fn open_settings(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
        if let Some(settings) = self.settings.as_ref() {
            native::raise(settings.window.hwnd() as HWND);
            native::focus(settings.window.hwnd() as HWND);
            self.sync_settings_feed();
            self.send_settings_status(None, None);
            return;
        }
        match create_settings(target, self.proxy.clone()) {
            Ok(settings) => {
                log("wallpaper settings opened");
                self.settings = Some(settings);
                self.sync_settings_feed();
                self.send_settings_status(None, None);
            }
            Err(error) => {
                log(&format!("wallpaper settings failed: {error:#}"));
                native::dialog_error(&format!("无法打开壁纸设置：{error}"));
            }
        }
    }

    fn close_settings(&mut self) {
        let _ = self.finish_position_edit(false);
        self.close_preview();
        self.settings = None;
        self.settings_candidate = None;
        self.sync_settings_feed();
    }

    fn close_preview(&mut self) {
        if self.preview.take().is_some() {
            if let Some(settings) = self.settings.as_ref() {
                settings.eval("window.hertzWallpaperSettings && window.hertzWallpaperSettings.unmountPreview();");
            }
            log("wallpaper preview closed");
            self.send_settings_status(None, Some("预览已关闭"));
        }
    }

    fn open_preview(
        &mut self,
        target: &EventLoopWindowTarget<UserEvent>,
        candidate: &WallpaperCandidate,
    ) -> Result<(), String> {
        if let Some(preview) = self.preview.as_mut() {
            preview.fps = candidate.fps;
            preview.music_response = candidate.music_response;
            preview.source = candidate.source.clone();
            preview.scene = candidate.scene.clone();
            preview.lease_until = Instant::now() + PREVIEW_LEASE;
            if preview.ready {
                preview.apply_config();
                if let Some(snapshot) = self.wallpaper_last.as_ref() {
                    preview.apply_feed(snapshot);
                } else {
                    preview.clear_feed();
                }
                preview.start();
            }
            return Ok(());
        }
        self.open_settings(target);
        let settings = self.settings.as_ref().ok_or("无法打开桌面设置")?;
        self.preview = Some(PreviewSurface {
            webview: settings.webview.clone(),
            fps: candidate.fps,
            music_response: candidate.music_response,
            source: candidate.source.clone(),
            scene: candidate.scene.clone(),
            ready: false,
            lease_until: Instant::now() + PREVIEW_LEASE,
        });
        settings
            .eval("window.hertzWallpaperSettings && window.hertzWallpaperSettings.mountPreview();");
        Ok(())
    }

    fn renew_preview(&mut self) {
        let Some(preview) = self.preview.as_mut() else {
            self.send_settings_status(Some("没有活动预览"), None);
            return;
        };
        preview.lease_until = Instant::now() + PREVIEW_LEASE;
        self.send_settings_status(None, None);
    }

    fn ensure_wallpaper_feed(&mut self) {
        if self.wallpaper_feed_stop.is_some() {
            return;
        }
        let stop = Arc::new(AtomicBool::new(false));
        spawn_wallpaper_feed(
            self.profile.clone(),
            self.proxy.clone(),
            self.source_generation,
            stop.clone(),
        );
        self.wallpaper_feed_stop = Some(stop);
    }

    fn stop_wallpaper_feed(&mut self) {
        if let Some(stop) = self.wallpaper_feed_stop.take() {
            stop.store(true, Ordering::Relaxed);
        }
    }

    fn sync_settings_feed(&mut self) {
        if self.settings.is_some() || self.config.wallpaper.enabled || self.wallpaper_forced {
            self.ensure_wallpaper_feed();
        } else {
            self.stop_wallpaper_feed();
        }
    }

    fn ensure_wallpaper_surface(
        &mut self,
        target: &EventLoopWindowTarget<UserEvent>,
        monitor: Option<&str>,
    ) -> Result<()> {
        let monitors = native::wallpaper_monitors();
        let resolved_name = monitor.map(str::to_string).or_else(|| {
            monitors
                .iter()
                .find(|monitor| monitor.primary)
                .map(|monitor| monitor.name.clone())
        });
        let monitor_changed = self
            .wallpaper
            .as_ref()
            .is_some_and(|surface| Some(surface.monitor.name.as_str()) != resolved_name.as_deref());
        if monitor_changed
            || self
                .wallpaper
                .as_ref()
                .is_some_and(|surface| !native::wallpaper_alive(surface.hwnd()))
        {
            self.wallpaper = None;
            self.wallpaper_page_ready = false;
        }
        if self.wallpaper.is_none() {
            self.wallpaper_generation = self.wallpaper_generation.wrapping_add(1);
            let surface = create_wallpaper(
                target,
                self.proxy.clone(),
                self.wallpaper_generation,
                monitor,
            )?;
            self.wallpaper = Some(surface);
        }
        Ok(())
    }

    fn drop_wallpaper_surface(&mut self) {
        self.stop_wallpaper_feed();
        self.wallpaper = None;
        self.wallpaper_generation = self.wallpaper_generation.wrapping_add(1);
        self.wallpaper_page_ready = false;
        self.wallpaper_visible = false;
        self.reset_wallpaper_page_stats();
    }

    fn switch_source(
        &mut self,
        profile: Profile,
        expected_revision: u64,
        target: &EventLoopWindowTarget<UserEvent>,
    ) -> Result<(), String> {
        if self.position_edit.is_some() {
            return Err("请先完成或取消位置调整".into());
        }
        if expected_revision != self.config.revision {
            return Err("设置已变化，请重新打开设置后重试".into());
        }
        let profile = config::normalize_profile(profile).map_err(|error| format!("{error:#}"))?;
        if config::same_profile(&self.profile, &profile) {
            return Err("已经是当前来源".into());
        }
        let mut next = self.config.clone();
        next.activate_profile(profile.clone())
            .map_err(|error| format!("{error:#}"))?;
        next.revision = self.config.revision.saturating_add(1);
        config::save(&next).map_err(|error| format!("保存设置失败：{error:#}"))?;
        self.config = next;
        self.close_preview();
        self.profile = profile;
        self.source_generation = self.source_generation.wrapping_add(1);
        self.lyrics_feed_stop.store(true, Ordering::Relaxed);
        self.lyrics_feed_stop = Arc::new(AtomicBool::new(false));
        spawn_feed(
            self.profile.clone(),
            self.proxy.clone(),
            self.source_generation,
            self.lyrics_feed_stop.clone(),
        );
        self.stop_wallpaper_feed();
        self.wallpaper_last = None;
        self.wallpaper_feed_logged = false;
        if let Some(surface) = self.wallpaper.as_ref() {
            surface.clear_feed();
        }
        if let Some(preview) = self.preview.as_ref() {
            preview.clear_feed();
        }
        self.last_update = Instant::now();
        self.last_feed_error = None;
        self.last_warning = None;
        self.last_snapshot = None;
        self.current_track = None;
        self.current_document_key = None;
        self.current_document = None;
        self.policy.no_content = true;
        self.source_state = "waiting";
        self.source_message = Some(format!("正在连接 Hertz {} 服务", self.profile.edition));
        self.send_document();
        self.send_snapshot();
        self.send_source();
        self.policy.locked = self.config.lyrics.locked;
        native::set_locked(self.hwnd(), self.policy.locked);
        self.send_config();
        self.eval(&format!(
            "window.hertzLyrics && window.hertzLyrics.setLocked({});",
            self.config.lyrics.locked
        ));
        self.place(true);
        self.recompute_visibility();
        self.sync_tray();
        let mut surface_error = None;
        if self.config.wallpaper.enabled || self.wallpaper_forced {
            let monitor = self.config.wallpaper.monitor.clone();
            if let Err(error) = self.ensure_wallpaper_surface(target, monitor.as_deref()) {
                log(&format!(
                    "wallpaper enable after source switch failed: {error:#}"
                ));
                surface_error = Some(format!("来源已保存，但壁纸挂载失败：{error}"));
            }
            self.ensure_wallpaper_feed();
        } else {
            self.drop_wallpaper_surface();
        }
        self.sync_settings_feed();
        self.wallpaper_recovery_terminal = false;
        self.wallpaper_recovery_attempts.clear();
        self.recompute_wallpaper();
        self.rebuild_tray();
        log(&format!(
            "source switched edition={} data_dir={}",
            self.profile.edition,
            self.profile.data_dir.display()
        ));
        self.send_settings_status(surface_error.as_deref(), Some("已切换来源"));
        Ok(())
    }

    fn apply_wallpaper_settings(
        &mut self,
        candidate: &WallpaperCandidate,
        expected_revision: u64,
        target: &EventLoopWindowTarget<UserEvent>,
        lyrics: Option<config::LyricsConfig>,
    ) -> Result<(), String> {
        if self.position_edit.is_some() {
            return Err("请先完成或取消位置调整".into());
        }
        if let Err(error) = validate_candidate(candidate) {
            return Err(error.to_string());
        }
        if self.save_due.is_some() || expected_revision != self.config.revision {
            return Err("设置已在其他位置变化；草稿已保留，请放弃修改后重新读取".into());
        }
        let previous = self.config.clone();
        if let Some(lyrics) = lyrics {
            if lyrics.locked && self.tray.is_none() {
                return Err("托盘不可用，暂时无法锁定歌词".into());
            }
            self.config.lyrics = lyrics;
            self.config.sanitize();
        }
        self.config.wallpaper.enabled = candidate.enabled;
        self.config.wallpaper.fps = candidate.fps;
        self.config.wallpaper.music_response = candidate.music_response;
        self.config.wallpaper.monitor = candidate.monitor.clone();
        self.config.wallpaper.source = candidate.source.clone();
        self.config.wallpaper.scene = candidate.scene.clone();
        self.config.revision = previous.revision.saturating_add(1);
        if let Err(error) = config::save(&self.config) {
            self.config = previous;
            return Err(format!("保存设置失败：{error:#}"));
        }
        self.wallpaper_forced = false;
        self.wallpaper_recovery_terminal = false;
        self.wallpaper_recovery_attempts.clear();
        if candidate.enabled {
            if let Err(error) = self.ensure_wallpaper_surface(target, candidate.monitor.as_deref())
            {
                log(&format!("wallpaper enable failed: {error:#}"));
                self.config = previous;
                let _ = config::save(&self.config);
                return Err(format!("启用壁纸失败：{error}"));
            }
            self.ensure_wallpaper_feed();
            if let Some(surface) = self.wallpaper.as_ref() {
                surface.apply_config(
                    &self.config.wallpaper.source,
                    &self.config.wallpaper.scene,
                    self.config.wallpaper.music_response,
                );
                if self.wallpaper_page_ready {
                    if let Some(snapshot) = self.wallpaper_last.as_ref() {
                        surface.apply_feed(snapshot);
                    } else {
                        surface.clear_feed();
                    }
                }
            }
        } else {
            self.drop_wallpaper_surface();
        }
        self.close_preview();
        self.sync_settings_feed();
        self.recompute_wallpaper();
        self.policy.locked = self.config.lyrics.locked;
        native::set_locked(self.hwnd(), self.policy.locked);
        self.send_config();
        self.place(true);
        self.recompute_visibility();
        self.rebuild_tray();
        Ok(())
    }

    fn begin_position_edit(&mut self) -> Result<(), String> {
        if self.position_edit.is_some() {
            return Ok(());
        }
        if self.save_due.is_some() {
            self.save_due = Some(Instant::now());
            self.flush_save();
        }
        self.position_edit = Some(PositionEdit {
            lyrics: self.config.lyrics.clone(),
            user_hidden: self.policy.user_hidden,
        });
        self.config.lyrics.enabled = true;
        self.config.lyrics.locked = false;
        self.policy.locked = false;
        self.policy.user_hidden = false;
        native::set_locked(self.hwnd(), false);
        self.panel_height = 0.0;
        self.panel_top = None;
        self.eval("window.hertzLyrics && window.hertzLyrics.setOptions(false);");
        self.send_config();
        self.place(true);
        self.recompute_visibility();
        native::focus(self.hwnd());
        self.sync_tray();
        Ok(())
    }

    fn finish_position_edit(&mut self, commit: bool) -> Result<(), String> {
        let Some(edit) = self.position_edit.take() else {
            return Ok(());
        };
        let moved = self.config.lyrics.clone();
        self.config.lyrics = edit.lyrics;
        self.policy.user_hidden = edit.user_hidden;
        let previous = self.config.clone();
        if commit {
            self.config.lyrics.anchor_x = moved.anchor_x;
            self.config.lyrics.anchor_y = moved.anchor_y;
            self.config.lyrics.monitor = moved.monitor;
            self.config.revision = self.config.revision.saturating_add(1);
        }
        let result = if commit {
            config::save(&self.config).map_err(|error| format!("保存位置失败：{error:#}"))
        } else {
            Ok(())
        };
        if result.is_err() {
            self.config = previous;
        }
        self.policy.locked = self.config.lyrics.locked;
        native::set_locked(self.hwnd(), self.policy.locked);
        self.send_config();
        self.panel_top = None;
        self.place(true);
        self.recompute_visibility();
        self.sync_tray();
        result
    }

    fn handle_settings_page(&mut self, body: &str, target: &EventLoopWindowTarget<UserEvent>) {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Command {
            cmd: String,
            #[serde(default)]
            config: Option<WallpaperCandidate>,
            #[serde(default)]
            expected_revision: Option<u64>,
            #[serde(default)]
            profile: Option<Profile>,
            #[serde(default)]
            lyrics: Option<config::LyricsConfig>,
            #[serde(default)]
            event: Option<String>,
            #[serde(default)]
            enabled: Option<bool>,
        }
        let Ok(command) = serde_json::from_str::<Command>(body) else {
            self.send_settings_status(Some("设置请求格式无效"), None);
            return;
        };
        if self.position_edit.is_some()
            && !matches!(
                command.cmd.as_str(),
                "ready"
                    | "status"
                    | "preview-event"
                    | "preview-renew"
                    | "preview-close"
                    | "position-begin"
                    | "position-done"
                    | "position-cancel"
                    | "close"
            )
        {
            self.send_settings_status(Some("请先完成或取消位置调整"), None);
            return;
        }
        match command.cmd.as_str() {
            "ready" | "status" => self.send_settings_status(None, None),
            "preview-event" => {
                if let Some(event) = command.event {
                    self.handle_preview_page(&event);
                }
            }
            "preview-close" => self.close_preview(),
            "position-begin" => {
                let result = self.begin_position_edit();
                self.send_settings_status(
                    result.as_ref().err().map(String::as_str),
                    Some("拖动桌面歌词后，返回此处完成或取消"),
                );
            }
            "position-done" | "position-cancel" => {
                let result = self.finish_position_edit(command.cmd == "position-done");
                self.send_settings_status(
                    result.as_ref().err().map(String::as_str),
                    Some("位置调整已结束"),
                );
            }
            "autostart" => {
                let enable = command.enabled.unwrap_or(false);
                let previous = self.config.clone();
                let previous_native =
                    native::autostart_enabled().unwrap_or(previous.launch_at_login);
                let result = native::set_autostart(enable).and_then(|_| {
                    self.config.launch_at_login = enable;
                    self.config.revision = self.config.revision.saturating_add(1);
                    config::save(&self.config)
                });
                if result.is_err() {
                    self.config = previous;
                    let _ = native::set_autostart(previous_native);
                }
                self.sync_tray();
                let error = result
                    .err()
                    .map(|error| format!("开机启动设置失败：{error:#}"));
                self.send_settings_status(error.as_deref(), None);
            }
            "wallpaper-retry" => {
                self.retry_wallpaper(target);
                self.send_settings_status(None, None);
            }
            "wallpaper-show" => {
                self.wallpaper_hidden = false;
                self.recompute_wallpaper();
                self.sync_tray();
                self.send_settings_status(None, None);
            }
            "lyrics-show" => {
                self.policy.user_hidden = false;
                self.recompute_visibility();
                self.sync_tray();
                self.send_settings_status(None, None);
            }
            "preview" => {
                let candidate = command
                    .config
                    .unwrap_or_else(|| self.current_wallpaper_candidate());
                if let Err(error) = validate_candidate(&candidate) {
                    self.send_settings_status(Some(error), None);
                    return;
                }
                match self.open_preview(target, &candidate) {
                    Ok(()) => self.send_settings_status(None, Some("预览已打开")),
                    Err(error) => self.send_settings_status(Some(&error), None),
                }
            }
            "preview-renew" => self.renew_preview(),
            "apply" => {
                let Some(candidate) = command.config else {
                    self.send_settings_status(Some("缺少壁纸配置"), None);
                    return;
                };
                let Some(expected_revision) = command.expected_revision else {
                    self.send_settings_status(Some("缺少设置修订号"), None);
                    return;
                };
                match self.apply_wallpaper_settings(
                    &candidate,
                    expected_revision,
                    target,
                    command.lyrics,
                ) {
                    Ok(()) => self.send_settings_status(None, Some("已应用")),
                    Err(error) => self.send_settings_status(Some(&error), None),
                }
            }
            "switch-source" => {
                let Some(profile) = command.profile else {
                    self.send_settings_status(Some("缺少目标来源"), None);
                    return;
                };
                let Some(expected_revision) = command.expected_revision else {
                    self.send_settings_status(Some("缺少设置修订号"), None);
                    return;
                };
                if let Err(error) = self.switch_source(profile, expected_revision, target) {
                    self.send_settings_status(Some(&error), None);
                }
            }
            "close" => self.close_settings(),
            other => self.send_settings_status(Some(&format!("未知设置命令：{other}")), None),
        }
    }

    fn handle_preview_page(&mut self, event: &str) {
        if event.starts_with("wallpaper_heartbeat ") {
            return;
        }
        if event == "wallpaper_mount_failed" {
            log("wallpaper preview page mount failed");
            self.close_preview();
            self.send_settings_status(Some("场景预览加载失败，请重试或选择其他场景"), None);
            return;
        }
        let Some(preview) = self.preview.as_mut() else {
            return;
        };
        match event {
            "wallpaper_dom_ready" | "wallpaper_ready" => {
                preview.ready = true;
                preview.apply_config();
                if let Some(snapshot) = self.wallpaper_last.as_ref() {
                    preview.apply_feed(snapshot);
                } else {
                    preview.clear_feed();
                }
                preview.start();
            }
            other => log(&format!("unknown preview page event: {other}")),
        }
    }

    fn set_locked(&mut self, locked: bool) {
        if locked && self.tray.is_none() {
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
        self.panel_top = None;
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
        if self.position_edit.is_some() {
            return;
        }
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
        self.send_settings_status(None, None);
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
            #[serde(default)]
            target: Option<String>,
        }
        let Ok(command) = serde_json::from_str::<Command>(body) else {
            log("ignore malformed page command");
            return;
        };
        if self.position_edit.is_some() && !matches!(command.cmd.as_str(), "ready" | "drag" | "log")
        {
            return;
        }
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
                let Some(layout) =
                    layout_choice(command.text.as_deref(), self.config.lyrics.layout)
                else {
                    log(&format!("ignore unknown layout: {:?}", command.text));
                    return;
                };
                if layout != self.config.lyrics.layout {
                    self.config.lyrics.layout = layout;
                    self.send_config();
                    self.place(true);
                    self.schedule_save();
                }
            }
            "secondary" => {
                let Some(secondary) =
                    secondary_choice(command.text.as_deref(), self.config.lyrics.secondary)
                else {
                    log(&format!("ignore unknown secondary: {:?}", command.text));
                    return;
                };
                if secondary != self.config.lyrics.secondary {
                    self.config.lyrics.secondary = secondary;
                    self.send_config();
                    self.schedule_save();
                }
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
            "color" => {
                let (Some(target), Some(color)) = (command.target, command.text) else {
                    return;
                };
                if !config::valid_color(&color) {
                    log(&format!("ignore invalid color: {target}={color}"));
                    return;
                }
                let color = color.to_ascii_lowercase();
                let slot = match target.as_str() {
                    "sung" => &mut self.config.lyrics.sung_color,
                    "unsung" => &mut self.config.lyrics.unsung_color,
                    other => {
                        log(&format!("ignore unknown color target: {other}"));
                        return;
                    }
                };
                if *slot != color {
                    *slot = color;
                    self.send_config();
                    self.schedule_save();
                }
            }
            "panel" => {
                if let Some(height) = command.value {
                    self.set_panel_height(height);
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

    fn handle_menu(&mut self, id: &str, target: &EventLoopWindowTarget<UserEvent>) {
        let Some(actions) = self.tray_actions.as_ref() else {
            return;
        };
        if self.position_edit.is_some()
            && id != actions.settings_id
            && id != actions.locate_id
            && id != actions.quit_id
        {
            return;
        }
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
        } else if id == actions.settings_id {
            self.open_settings(target);
        } else if actions
            .wallpaper_toggle_id
            .as_deref()
            .is_some_and(|toggle| toggle == id)
        {
            self.wallpaper_hidden = !self.wallpaper_hidden;
            log(&format!("wallpaper_hidden={}", self.wallpaper_hidden));
            self.recompute_wallpaper();
            self.sync_tray();
        } else if actions
            .wallpaper_retry_id
            .as_deref()
            .is_some_and(|retry| retry == id)
        {
            self.retry_wallpaper(target);
        } else if id == actions.quit_id {
            log("quit from tray");
            let _ = self.finish_position_edit(false);
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

    fn handle_pipe_request(
        &mut self,
        request: &serde_json::Value,
        target: &EventLoopWindowTarget<UserEvent>,
    ) -> serde_json::Value {
        let command = request
            .get("command")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        log(&format!("control command={command}"));
        let value = request.get("value");
        if self.position_edit.is_some()
            && !matches!(
                command,
                "status" | "wallpaper-status" | "wallpaper-settings" | "quit"
            )
        {
            return pipe_error_detail(
                "position_edit_active",
                "请在桌面歌词与壁纸设置中完成或取消位置调整",
            );
        }
        match command {
            "status" | "wallpaper-status" => {}
            "wallpaper-settings" => {
                if let Some(tab) = value
                    .and_then(|value| value.get("tab"))
                    .and_then(|tab| tab.as_str())
                    .filter(|tab| matches!(*tab, "wallpaper" | "lyrics" | "runtime"))
                {
                    self.settings_tab = tab.to_string();
                    self.settings_navigation = self.settings_navigation.wrapping_add(1);
                }
                if let Some(profile) = value
                    .and_then(|value| value.get("profile"))
                    .and_then(|value| serde_json::from_value::<Profile>(value.clone()).ok())
                    .and_then(|profile| config::normalize_profile(profile).ok())
                {
                    self.settings_candidate = Some(profile);
                }
                self.open_settings(target);
            }
            "wallpaper-toggle" => {
                self.wallpaper_hidden = !self.wallpaper_hidden;
                log(&format!("wallpaper_hidden={}", self.wallpaper_hidden));
                self.recompute_wallpaper();
                self.sync_tray();
            }
            "wallpaper-show" => {
                self.wallpaper_hidden = false;
                self.recompute_wallpaper();
                self.sync_tray();
            }
            "wallpaper-hide" => {
                self.wallpaper_hidden = true;
                self.recompute_wallpaper();
                self.sync_tray();
            }
            "wallpaper-retry" => self.retry_wallpaper(target),
            "wallpaper-preview-close" => self.close_preview(),
            "wallpaper-preview-renew" => self.renew_preview(),
            "wallpaper-preview" => {
                let candidate = match serde_json::from_value::<WallpaperCandidate>(
                    value.cloned().unwrap_or(serde_json::Value::Null),
                ) {
                    Ok(candidate) => candidate,
                    Err(_) => return pipe_error("invalid_value"),
                };
                if let Err(error) = validate_candidate(&candidate) {
                    return pipe_error_detail("invalid_value", error);
                }
                if let Err(error) = self.open_preview(target, &candidate) {
                    return pipe_error_detail("wallpaper_preview_failed", error);
                }
            }
            "wallpaper-apply" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct ApplyRequest {
                    expected_revision: u64,
                    config: WallpaperCandidate,
                }
                let apply = match serde_json::from_value::<ApplyRequest>(
                    value.cloned().unwrap_or(serde_json::Value::Null),
                ) {
                    Ok(apply) => apply,
                    Err(_) => return pipe_error("invalid_value"),
                };
                if let Err(error) = self.apply_wallpaper_settings(
                    &apply.config,
                    apply.expected_revision,
                    target,
                    None,
                ) {
                    return pipe_error_detail("wallpaper_apply_failed", error);
                }
            }
            "profile-switch" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct SwitchRequest {
                    expected_revision: u64,
                    profile: Profile,
                }
                let switch = match serde_json::from_value::<SwitchRequest>(
                    value.cloned().unwrap_or(serde_json::Value::Null),
                ) {
                    Ok(switch) => switch,
                    Err(_) => return pipe_error("invalid_value"),
                };
                if let Err(error) =
                    self.switch_source(switch.profile, switch.expected_revision, target)
                {
                    return pipe_error_detail("profile_switch_failed", error);
                }
            }
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
                let _ = self.finish_position_edit(false);
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
            "positionEditing": self.position_edit.is_some(),
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
                "pageTicks": self.wallpaper_heartbeat_ticks,
                "heartbeatAgeMs": self
                    .wallpaper_heartbeat_at
                    .map(|at| at.elapsed().as_millis() as u64),
                "hidden": self.wallpaper_hidden,
                "revision": self.config.revision,
                "fps": self.config.wallpaper.fps,
                "musicResponse": self.config.wallpaper.music_response,
                "monitor": self.config.wallpaper.monitor,
                "source": self.config.wallpaper.source,
                "scene": self.config.wallpaper.scene,
                "settingsOpen": self.settings.is_some(),
                "previewActive": self.preview.is_some(),
                "monitorMissing": self.wallpaper_monitor_missing,
            },
            "diagnostics": {
                "pauseReasons": wallpaper_pause_reasons(
                    self.config.wallpaper.enabled || self.wallpaper_forced,
                    self.wallpaper_hidden,
                    self.wallpaper_monitor_missing,
                    self.wallpaper.is_some(),
                    self.wallpaper_page_ready,
                    &self.policy,
                ),
                "fps": {
                    "configured": self.config.wallpaper.fps,
                    "effective": if self.wallpaper_visible { self.config.wallpaper.fps } else { 0 },
                    "measured": if self.wallpaper_visible
                        && self
                            .wallpaper_heartbeat_at
                            .is_some_and(|at| at.elapsed() < Duration::from_secs(5))
                    {
                        self.wallpaper_measured_fps
                    } else {
                        None
                    },
                },
                "page": {
                    "ready": self.wallpaper_page_ready,
                    "ticks": self.wallpaper_heartbeat_ticks,
                    "draws": self.wallpaper_heartbeat_draws,
                    "heartbeatAgeMs": self
                        .wallpaper_heartbeat_at
                        .map(|at| at.elapsed().as_millis() as u64),
                    "evalFailures": self
                        .wallpaper
                        .as_ref()
                        .map(|surface| surface.eval_failures())
                        .unwrap_or(0),
                    "zoom": self.wallpaper.as_ref().map(|surface| surface.zoom),
                },
                "monitor": self.wallpaper.as_ref().map(|surface| {
                    serde_json::json!({
                        "name": surface.monitor.name,
                        "left": surface.monitor.left,
                        "top": surface.monitor.top,
                        "width": surface.monitor.width,
                        "height": surface.monitor.height,
                        "dpi": surface.monitor.dpi,
                    })
                }),
                "recovery": {
                    "attempts": self.wallpaper_recovery_attempts.len(),
                    "terminal": self.wallpaper_recovery_terminal,
                },
                "feed": {
                    "hasSnapshot": self.wallpaper_last.is_some(),
                    "lastSeq": self.wallpaper_last.as_ref().map(|snapshot| snapshot.seq),
                },
            },
        })
    }

    fn handle_native(&mut self, event: NativeEvent, target: &EventLoopWindowTarget<UserEvent>) {
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
                self.recover_wallpaper(target);
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

    fn tick(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
        self.flush_save();
        let now = Instant::now();
        if self
            .preview
            .as_ref()
            .is_some_and(|preview| now >= preview.lease_until)
        {
            self.close_preview();
        }
        if now.duration_since(self.last_check) >= Duration::from_secs(1) {
            self.last_check = now;
            self.send_settings_status(None, None);
            let fullscreen = native::target_fullscreen(self.hwnd());
            if fullscreen != self.policy.fullscreen {
                self.policy.fullscreen = fullscreen;
                log(&format!("fullscreen={fullscreen}"));
                self.recompute_visibility();
                self.recompute_wallpaper();
            }
            if self
                .wallpaper
                .as_ref()
                .is_some_and(|surface| !native::wallpaper_alive(surface.hwnd()))
            {
                log("wallpaper surface lost; recovering");
                self.recover_wallpaper(target);
            } else {
                self.reconcile_wallpaper_geometry(target);
            }
            if self.wallpaper_visible && self.wallpaper_page_ready {
                let stalled = self
                    .wallpaper_heartbeat_at
                    .is_some_and(|at| at.elapsed() > HEARTBEAT_STALE);
                let eval_failed = self
                    .wallpaper
                    .as_ref()
                    .is_some_and(|surface| surface.eval_failures() >= 3);
                if stalled || eval_failed {
                    log(if stalled {
                        "wallpaper page heartbeat stalled; recovering"
                    } else {
                        "wallpaper WebView eval failed repeatedly; recovering"
                    });
                    self.reset_wallpaper_page_stats();
                    self.wallpaper = None;
                    self.wallpaper_page_ready = false;
                    self.wallpaper_visible = false;
                    self.wallpaper_generation = self.wallpaper_generation.wrapping_add(1);
                    self.recover_wallpaper(target);
                }
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

    fn reconcile_wallpaper_geometry(&mut self, target: &EventLoopWindowTarget<UserEvent>) {
        let Some(surface) = self.wallpaper.as_ref() else {
            return;
        };
        let name = surface.monitor.name.clone();
        let Some(monitor) = native::wallpaper_monitors()
            .into_iter()
            .find(|monitor| monitor.name == name)
        else {
            if !self.wallpaper_monitor_missing {
                self.wallpaper_monitor_missing = true;
                log("wallpaper target monitor missing");
                self.recompute_wallpaper();
            }
            return;
        };
        if self.wallpaper_monitor_missing {
            self.wallpaper_monitor_missing = false;
            log("wallpaper target monitor returned");
        }
        let geometry_changed = monitor_geometry_changed(&surface.monitor, &monitor);
        let window_dpi = native::window_dpi(surface.hwnd()).max(1);
        let desired_zoom = f64::from(monitor.dpi) / f64::from(window_dpi);
        let zoom_changed = (desired_zoom - surface.zoom).abs() > 0.001;
        if !geometry_changed && !zoom_changed {
            return;
        }
        if geometry_changed {
            log(&format!(
                "wallpaper monitor geometry changed name={} rect={},{} {}x{} dpi={}",
                monitor.name, monitor.left, monitor.top, monitor.width, monitor.height, monitor.dpi
            ));
            let Some(surface) = self.wallpaper.as_mut() else {
                return;
            };
            if let Err(error) = surface.reflow(monitor) {
                log(&format!("wallpaper reflow failed: {error:#}"));
                self.wallpaper = None;
                self.wallpaper_page_ready = false;
                self.wallpaper_visible = false;
                self.reset_wallpaper_page_stats();
                self.wallpaper_generation = self.wallpaper_generation.wrapping_add(1);
                self.recover_wallpaper(target);
                return;
            }
        } else if let Some(surface) = self.wallpaper.as_mut() {
            if let Err(error) = surface.apply_zoom(monitor.dpi) {
                log(&format!("wallpaper zoom sync failed: {error:#}"));
            }
        }
        self.recompute_wallpaper();
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

    fn base_height_dip(&self) -> f64 {
        let lyrics = &self.config.lyrics;
        let lines = match lyrics.layout {
            Layout::Double => 2.0,
            Layout::Single => 1.0,
        };
        let toolbar = if lyrics.locked { 0.0 } else { 30.0 };
        (lyrics.font_size * 1.55 * lines + 60.0 + toolbar).clamp(96.0, 360.0)
    }

    fn height_dip(&self) -> f64 {
        (self.base_height_dip() + self.panel_height).clamp(96.0, 620.0)
    }

    /// 顶部不动的窗口高度调整：样式条只往下长，歌词不跳。
    fn set_panel_height(&mut self, height: f64) {
        let height = height.clamp(0.0, 480.0);
        if (height - self.panel_height).abs() < 0.5 {
            return;
        }
        if self.panel_height <= 0.0 && height > 0.0 {
            self.panel_top = native::window_rect(self.hwnd()).map(|rect| rect.top);
        }
        self.panel_height = height;
        if height <= 0.0 {
            self.panel_top = None;
        }
        self.place(true);
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
        let mut x = area.left + (f64::from(available_x) * anchor_x).round() as i32;
        let mut y = area.top + (f64::from(available_y) * anchor_y).round() as i32;
        if let Some(top) = self.panel_top {
            y = top.clamp(area.top, (area.top + available_y).max(area.top));
        }
        if self.position_edit.is_some() {
            (x, y) = bounded_lyrics_position(x, y, width, height, &area);
            self.config.lyrics.anchor_x = f64::from(x - area.left) / f64::from(available_x.max(1));
            self.config.lyrics.anchor_y = f64::from(y - area.top) / f64::from(available_y.max(1));
        }
        // WM_MOVE is delivered after SetWindowPos returns; the synchronous
        // `placing` flag alone cannot distinguish our own placement from a drag.
        self.placed_position = Some((x, y));
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
        if self.panel_height > 0.0 {
            self.panel_top = Some(y);
        }
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
        let Some(mut rect) = native::window_rect(hwnd) else {
            return;
        };
        if self.placed_position == Some((rect.left, rect.top)) {
            return;
        }
        let Some(area) = native::work_area_for_window(hwnd) else {
            return;
        };
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if self.position_edit.is_some() {
            let (x, y) = bounded_lyrics_position(rect.left, rect.top, width, height, &area);
            if (x, y) != (rect.left, rect.top) {
                self.placed_position = Some((x, y));
                unsafe {
                    SetWindowPos(hwnd, HWND_TOPMOST, x, y, 0, 0, SWP_NOACTIVATE | SWP_NOSIZE);
                }
                rect.left = x;
                rect.top = y;
            }
        }
        // 样式条占用的高度不属于持久位置：锚点仍按收起时的窗口高度换算。
        let anchor_height = if self.panel_height > 0.0 {
            (self.base_height_dip() * area.scale()).round() as i32
        } else {
            height
        };
        if self.panel_height > 0.0 {
            self.panel_top = Some(rect.top);
        }
        if area.width() <= width || area.height() <= anchor_height {
            return;
        }
        self.config.lyrics.anchor_x =
            f64::from(rect.left - area.left) / f64::from(area.width() - width);
        self.config.lyrics.anchor_y =
            f64::from(rect.top - area.top) / f64::from(area.height() - anchor_height);
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
        let wallpaper_enabled =
            self.wallpaper.is_some() || self.config.wallpaper.enabled || self.wallpaper_forced;
        let wallpaper_toggle = self
            .wallpaper
            .as_ref()
            .map(|_| CheckMenuItem::new("显示壁纸", true, !self.wallpaper_hidden, None));
        let wallpaper_retry = wallpaper_enabled.then(|| MenuItem::new("重新挂载壁纸", true, None));
        let settings = MenuItem::new("桌面歌词与壁纸", true, None);
        let quit = MenuItem::new("退出桌面歌词", true, None);
        let separator_after_toggle = PredefinedMenuItem::separator();
        let separator_before_settings = PredefinedMenuItem::separator();
        let separator_before_wallpaper = PredefinedMenuItem::separator();
        let separator_before_quit = PredefinedMenuItem::separator();
        menu.append_items(&[&toggle, &separator_after_toggle, &locate, &autostart])?;
        menu.append(&separator_before_settings)?;
        menu.append(&settings)?;
        if let Some(wallpaper) = wallpaper_toggle.as_ref() {
            menu.append(&separator_before_wallpaper)?;
            menu.append(wallpaper)?;
        }
        if let Some(retry) = wallpaper_retry.as_ref() {
            menu.append(retry)?;
        }
        menu.append(&separator_before_quit)?;
        menu.append(&quit)?;
        let actions = TrayActions {
            toggle_id: toggle.id().0.clone(),
            autostart_id: autostart.id().0.clone(),
            settings_id: settings.id().0.clone(),
            wallpaper_toggle_id: wallpaper_toggle.as_ref().map(|item| item.id().0.clone()),
            wallpaper_retry_id: wallpaper_retry.as_ref().map(|item| item.id().0.clone()),
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
    let mut profile = args
        .data_dir
        .take()
        .map(|data_dir| Profile {
            data_dir,
            edition: "custom".into(),
        })
        .or_else(|| config.active_profile.clone())
        .or_else(config::detect_profile)
        .unwrap_or_else(default_profile);
    match config.activate_profile(profile.clone()) {
        Ok(true) => {
            if let Err(error) = config::save(&config) {
                log(&format!("save initial profile failed: {error:#}"));
            }
        }
        Ok(false) => {}
        Err(error) => {
            log(&format!("activate initial profile failed: {error:#}"));
            if let Some(active) = config.active_profile.clone() {
                profile = active;
            }
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

    let icon = window_icon()?;
    let window = WindowBuilder::new()
        .with_title("Hertz 桌面歌词")
        .with_window_icon(Some(icon.clone()))
        .with_taskbar_icon(Some(icon))
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
        match create_wallpaper(
            &event_loop,
            proxy.clone(),
            1,
            config.wallpaper.monitor.as_deref(),
        ) {
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
        wallpaper_heartbeat_at: None,
        wallpaper_heartbeat_ticks: 0,
        wallpaper_heartbeat_draws: 0,
        wallpaper_fps_sample: None,
        wallpaper_measured_fps: None,
        wallpaper_visible: false,
        wallpaper_hidden: false,
        wallpaper_forced,
        source_generation: 1,
        lyrics_feed_stop: Arc::new(AtomicBool::new(false)),
        wallpaper_feed_stop: None,
        wallpaper_generation: 1,
        wallpaper_recovery_attempts: Vec::new(),
        wallpaper_recovery_terminal: false,
        wallpaper_monitor_missing: false,
        settings: None,
        settings_candidate: None,
        settings_tab: "wallpaper".into(),
        settings_navigation: 0,
        preview: None,
        position_edit: None,
        placed_position: None,
        panel_height: 0.0,
        panel_top: None,
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
    if args.settings {
        app.open_settings(&event_loop);
    }
    if args.preview {
        let candidate = app.current_wallpaper_candidate();
        if let Err(error) = app.open_preview(&event_loop, &candidate) {
            log(&format!("wallpaper preview start failed: {error}"));
        }
    }

    if app.config.wallpaper.enabled || app.wallpaper_forced {
        app.ensure_wallpaper_feed();
    }
    spawn_feed(
        app.profile.clone(),
        proxy.clone(),
        app.source_generation,
        app.lyrics_feed_stop.clone(),
    );
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

    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Feed(generation, result)) => {
                if generation == app.source_generation {
                    match *result {
                        Ok(update) => app.handle_update(update),
                        Err(message) => app.handle_feed_error(message),
                    }
                } else {
                    log(&format!(
                        "ignore stale lyrics feed generation={generation} current={}",
                        app.source_generation
                    ));
                }
            }
            Event::UserEvent(UserEvent::WallpaperFeed(generation, result)) => {
                if generation == app.source_generation {
                    app.handle_wallpaper_feed(*result);
                } else {
                    log(&format!(
                        "ignore stale wallpaper feed generation={generation} current={}",
                        app.source_generation
                    ));
                }
            }
            Event::UserEvent(UserEvent::WallpaperPage(generation, body)) => {
                app.handle_wallpaper_page(generation, &body)
            }
            Event::UserEvent(UserEvent::SettingsPage(body)) => {
                app.handle_settings_page(&body, target)
            }
            Event::UserEvent(UserEvent::Tick) => app.tick(target),
            Event::UserEvent(UserEvent::Page(body)) => app.page_command(&body),
            Event::UserEvent(UserEvent::Tray(event)) => app.handle_tray(event),
            Event::UserEvent(UserEvent::Menu(event)) => app.handle_menu(&event.id.0, target),
            Event::UserEvent(UserEvent::Native(event)) => app.handle_native(event, target),
            Event::UserEvent(UserEvent::Pipe(request)) => {
                let response = app.handle_pipe_request(&request.body, target);
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
                } else if app
                    .settings
                    .as_ref()
                    .is_some_and(|settings| settings.window.id() == window_id)
                    && matches!(&event, WindowEvent::CloseRequested)
                {
                    if let Some(settings) = app.settings.as_ref() {
                        settings.eval("window.hertzWallpaperSettings && window.hertzWallpaperSettings.requestClose();");
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

fn pipe_error_detail(code: &str, message: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "ok": false, "error": code, "message": message.into() })
}

fn layout_choice(text: Option<&str>, current: Layout) -> Option<Layout> {
    match text {
        Some("single") => Some(Layout::Single),
        Some("double") => Some(Layout::Double),
        None => Some(match current {
            Layout::Double => Layout::Single,
            Layout::Single => Layout::Double,
        }),
        Some(_) => None,
    }
}

fn secondary_choice(text: Option<&str>, current: Secondary) -> Option<Secondary> {
    match text {
        Some("next") => Some(Secondary::Next),
        Some("translation") => Some(Secondary::Translation),
        Some("romanization") => Some(Secondary::Romanization),
        None => Some(match current {
            Secondary::Next => Secondary::Translation,
            Secondary::Translation => Secondary::Romanization,
            Secondary::Romanization => Secondary::Next,
        }),
        Some(_) => None,
    }
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

fn spawn_feed(
    profile: Profile,
    proxy: EventLoopProxy<UserEvent>,
    generation: u64,
    stop: Arc<AtomicBool>,
) {
    std::thread::Builder::new()
        .name("hertz-desktop-feed".into())
        .spawn(move || {
            let mut feed = match Feed::new(profile) {
                Ok(feed) => feed,
                Err(error) => {
                    let _ = proxy.send_event(UserEvent::Feed(
                        generation,
                        Box::new(Err(format!("{error:#}"))),
                    ));
                    return;
                }
            };
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let update = feed.poll().map_err(|error| format!("{error:#}"));
                let failed = update.is_err();
                if proxy
                    .send_event(UserEvent::Feed(generation, Box::new(update)))
                    .is_err()
                {
                    break;
                }
                std::thread::sleep(if failed { POLL_ERROR } else { POLL_IDLE });
            }
        })
        .ok();
}

fn bounded_lyrics_position(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    area: &native::WorkArea,
) -> (i32, i32) {
    let inset = (16.0 * area.scale()).round() as i32;
    fn snap(value: i32, min: i32, max: i32, distance: i32) -> i32 {
        if value <= min + distance {
            min
        } else if value >= max - distance {
            max
        } else {
            value.clamp(min, max)
        }
    }
    let left = area.left + inset;
    let top = area.top + inset;
    (
        snap(x, left, (area.right - width - inset).max(left), inset),
        snap(y, top, (area.bottom - height - inset).max(top), inset),
    )
}

fn parse_wallpaper_heartbeat(event: &str) -> Option<(u64, u64, bool, bool)> {
    let mut parts = event
        .strip_prefix("wallpaper_heartbeat ")?
        .split_whitespace();
    let ticks = parts.next()?.parse().ok()?;
    let draws = parts.next()?.parse().ok()?;
    let mounted = parts.next()? == "1";
    let lost = parts.next()? == "1";
    Some((ticks, draws, mounted, lost))
}

fn fps_from_draws(draws_delta: u64, elapsed: Duration) -> Option<f64> {
    let millis = elapsed.as_millis();
    if draws_delta == 0 || millis < 1000 {
        return None;
    }
    Some(draws_delta as f64 * 1000.0 / millis as f64)
}

fn wallpaper_pause_reasons(
    enabled: bool,
    hidden: bool,
    monitor_missing: bool,
    has_surface: bool,
    page_ready: bool,
    policy: &Policy,
) -> Vec<&'static str> {
    let mut reasons = Vec::new();
    if !enabled {
        reasons.push("disabled");
    }
    if hidden {
        reasons.push("hidden");
    }
    if monitor_missing {
        reasons.push("monitorMissing");
    }
    if enabled && !has_surface {
        reasons.push("noSurface");
    }
    if has_surface && !page_ready {
        reasons.push("pageNotReady");
    }
    if policy.fullscreen {
        reasons.push("fullscreen");
    }
    if policy.session_unavailable {
        reasons.push("sessionUnavailable");
    }
    if policy.display_off {
        reasons.push("displayOff");
    }
    reasons
}

fn monitor_geometry_changed(
    left: &native::WallpaperMonitor,
    right: &native::WallpaperMonitor,
) -> bool {
    left.left != right.left
        || left.top != right.top
        || left.width != right.width
        || left.height != right.height
        || left.dpi != right.dpi
}

fn profile_options(
    current: &Profile,
    config: &Config,
    candidate: Option<&Profile>,
) -> Vec<serde_json::Value> {
    let mut profiles = vec![current.clone()];
    for profile in config
        .known_profiles()
        .into_iter()
        .chain(config::detect_profiles())
        .chain(candidate.cloned())
    {
        if !profiles
            .iter()
            .any(|known| config::same_profile(known, &profile))
        {
            profiles.push(profile);
        }
    }
    profiles
        .into_iter()
        .map(|profile| {
            serde_json::json!({
                "dataDir": profile.data_dir.to_string_lossy(),
                "edition": profile.edition,
            })
        })
        .collect()
}

fn validate_candidate(candidate: &WallpaperCandidate) -> Result<(), &'static str> {
    if !matches!(candidate.fps, 15 | 30 | 60) {
        return Err("帧率只能是 15/30/60");
    }
    if !matches!(candidate.source.as_str(), "follow" | "fixed") {
        return Err("壁纸来源只能是跟随三维空间或固定场景");
    }
    if !config::wallpaper_scene_allowed(&candidate.scene) {
        return Err("不支持的壁纸场景");
    }
    Ok(())
}

fn create_wallpaper(
    target: &EventLoopWindowTarget<UserEvent>,
    proxy: EventLoopProxy<UserEvent>,
    generation: u64,
    monitor_name: Option<&str>,
) -> Result<WallpaperSurface> {
    let monitors = native::wallpaper_monitors();
    let monitor = if let Some(name) = monitor_name {
        monitors
            .into_iter()
            .find(|monitor| monitor.name == name)
            .ok_or_else(|| anyhow::anyhow!("目标显示器不存在：{name}"))?
    } else {
        monitors
            .iter()
            .find(|monitor| monitor.primary)
            .cloned()
            .or_else(|| monitors.first().cloned())
            .ok_or_else(|| anyhow::anyhow!("没有可用显示器"))?
    };
    let page: Arc<[u8]> = Arc::from(wallpaper_html().into_bytes());
    let page_bytes = page.len();
    let window = WindowBuilder::new()
        .with_title("Hertz wallpaper")
        .with_inner_size(PhysicalSize::new(
            monitor.width.max(1) as u32,
            monitor.height.max(1) as u32,
        ))
        .with_position(PhysicalPosition::new(monitor.left, monitor.top))
        .with_decorations(false)
        .with_resizable(false)
        .with_visible(false)
        .with_focused(false)
        .with_skip_taskbar(true)
        .with_undecorated_shadow(false)
        .build(target)?;
    let hwnd = window.hwnd() as HWND;
    native::mount_wallpaper(hwnd, &monitor)?;
    let child_rect =
        native::window_rect(hwnd).map(|rect| (rect.left, rect.top, rect.right, rect.bottom));
    let parent_rect =
        native::parent_window_rect(hwnd).map(|rect| (rect.left, rect.top, rect.right, rect.bottom));
    let window_dpi = native::window_dpi(hwnd);
    let zoom = f64::from(monitor.dpi) / f64::from(window_dpi.max(1));
    let page_proxy = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_custom_protocol(
            WALLPAPER_PROTOCOL.to_string(),
            wallpaper_page_response(page),
        )
        .with_url(WALLPAPER_PAGE_URL)
        .with_background_color((3, 4, 5, 255))
        .with_ipc_handler(move |request| {
            let body = request.body();
            if body.starts_with("wallpaper") {
                let _ = page_proxy.send_event(UserEvent::WallpaperPage(generation, body.clone()));
            }
        })
        .build(&window)
        .map_err(|error| anyhow::anyhow!("创建壁纸 WebView 失败：{error}"))?;
    if (zoom - 1.0).abs() > 0.001 {
        webview
            .zoom(zoom)
            .map_err(|error| anyhow::anyhow!("应用壁纸 DPI 缩放失败：{error}"))?;
    }
    log(&format!(
        "wallpaper target name={} rect={},{} {}x{} dpi={} window_dpi={window_dpi} zoom={zoom:.3} page_bytes={page_bytes} child={child_rect:?} parent={parent_rect:?}",
        monitor.name, monitor.left, monitor.top, monitor.width, monitor.height, monitor.dpi
    ));
    Ok(WallpaperSurface {
        window,
        webview,
        monitor,
        zoom,
        eval_failures: AtomicU64::new(0),
    })
}

fn create_settings(
    target: &EventLoopWindowTarget<UserEvent>,
    proxy: EventLoopProxy<UserEvent>,
) -> Result<SettingsSurface> {
    let area = native::primary_work_area();
    let (width, height) = area
        .map(|area| {
            (
                (f64::from(area.width()) / area.scale() - 48.0).clamp(320.0, 1120.0),
                (f64::from(area.height()) / area.scale() - 64.0).clamp(420.0, 740.0),
            )
        })
        .unwrap_or((1120.0, 740.0));
    let icon = window_icon()?;
    let window = WindowBuilder::new()
        .with_title("桌面歌词与壁纸")
        .with_window_icon(Some(icon.clone()))
        .with_taskbar_icon(Some(icon))
        .with_inner_size(tao::dpi::LogicalSize::new(width, height))
        .with_min_inner_size(tao::dpi::LogicalSize::new(320.0, 420.0))
        .with_resizable(true)
        .with_visible(true)
        .build(target)?;
    let page_proxy = proxy.clone();
    let settings_page = settings_html().into_bytes();
    let wallpaper_page = wallpaper_html().into_bytes();
    let webview = WebViewBuilder::new()
        .with_custom_protocol(WALLPAPER_PROTOCOL.to_string(), move |_id, request| {
            if let Some(file) = request.uri().path().strip_prefix("/scene-thumbnails/") {
                let image = scene_thumbnail(file);
                return Response::builder()
                    .status(if image.is_some() { 200 } else { 404 })
                    .header(header::CONTENT_TYPE, "image/jpeg")
                    .body(Cow::Borrowed(image.unwrap_or_default()))
                    .unwrap();
            }
            let page = match request.uri().path() {
                "/settings.html" => Some(&settings_page),
                WALLPAPER_PAGE_PATH => Some(&wallpaper_page),
                _ => None,
            };
            Response::builder()
                .status(if page.is_some() { 200 } else { 404 })
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .body(Cow::Owned(page.cloned().unwrap_or_default()))
                .unwrap()
        })
        .with_url("hertz://localhost/settings.html")
        .with_background_color((20, 20, 19, 255))
        .with_ipc_handler(move |request| {
            let body = request.body();
            if body.len() <= 8192 {
                let _ = page_proxy.send_event(UserEvent::SettingsPage(body.clone()));
            }
        })
        .build(&window)
        .map_err(|error| anyhow::anyhow!("创建设置 WebView 失败：{error}"))?;
    Ok(SettingsSurface {
        window,
        webview: Rc::new(webview),
    })
}

fn scene_thumbnail(file: &str) -> Option<&'static [u8]> {
    match file {
        "zodiac.jpg" => Some(include_bytes!("../assets/scene-thumbnails/zodiac.jpg")),
        "coast.jpg" => Some(include_bytes!("../assets/scene-thumbnails/coast.jpg")),
        "butterfly-vortex.jpg" => Some(include_bytes!(
            "../assets/scene-thumbnails/butterfly-vortex.jpg"
        )),
        "phoenix-vortex.jpg" => Some(include_bytes!(
            "../assets/scene-thumbnails/phoenix-vortex.jpg"
        )),
        "reactor.jpg" => Some(include_bytes!("../assets/scene-thumbnails/reactor.jpg")),
        "particle-silk.jpg" => Some(include_bytes!(
            "../assets/scene-thumbnails/particle-silk.jpg"
        )),
        "gravity-sphere.jpg" => Some(include_bytes!(
            "../assets/scene-thumbnails/gravity-sphere.jpg"
        )),
        "warp-tunnel.jpg" => Some(include_bytes!("../assets/scene-thumbnails/warp-tunnel.jpg")),
        "prism-galaxy.jpg" => Some(include_bytes!(
            "../assets/scene-thumbnails/prism-galaxy.jpg"
        )),
        _ => None,
    }
}

fn settings_html() -> String {
    include_str!("../assets/wallpaper-settings.html").replace(
        "__SETTINGS__",
        include_str!("../assets/wallpaper-settings.js"),
    )
}

/// 壁纸页内联的舞台运行时是 MB 级：NavigateToString 有 ~2 MB 上限，file:// 又收不到
/// window.ipc，所以整页走自定义协议（wry 会映射到 http://hertz.localhost/）。
const WALLPAPER_PROTOCOL: &str = "hertz";
const WALLPAPER_PAGE_PATH: &str = "/wallpaper.html";
const WALLPAPER_PAGE_URL: &str = "hertz://localhost/wallpaper.html";

fn wallpaper_page_response(
    page: Arc<[u8]>,
) -> impl Fn(&str, Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> + Send + Sync + 'static {
    move |_id, request| {
        // 该 origin 只提供壁纸页本身，其他路径不给内容，避免变成通用文件服务。
        let page_here = request.uri().path() == WALLPAPER_PAGE_PATH;
        let mut response = Response::new(if page_here {
            Cow::Owned(page.to_vec())
        } else {
            Cow::Borrowed(&[] as &[u8])
        });
        if !page_here {
            *response.status_mut() = wry::http::StatusCode::NOT_FOUND;
        }
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static("text/html; charset=utf-8"),
        );
        response
    }
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

fn spawn_wallpaper_feed(
    profile: Profile,
    proxy: EventLoopProxy<UserEvent>,
    generation: u64,
    stop: Arc<AtomicBool>,
) {
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
            let mut backoff = Duration::from_secs(1);
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let mut received = false;
                let result = feed.subscribe(|snapshot| {
                    if !received {
                        log(&format!("wallpaper events connected seq={}", snapshot.seq));
                    }
                    received = true;
                    proxy
                        .send_event(UserEvent::WallpaperFeed(generation, Box::new(Ok(snapshot))))
                        .is_ok()
                        && !stop.load(Ordering::Relaxed)
                });
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                match result {
                    Ok(()) => break,
                    Err(error) if error.code == ERR_EVENTS_UNAVAILABLE => {
                        log("wallpaper events unavailable; falling back to snapshot polling");
                        poll_wallpaper_feed(&mut feed, &proxy, generation, &stop);
                        break;
                    }
                    Err(error) => {
                        log(&format!("wallpaper events {error}"));
                        let _ = proxy
                            .send_event(UserEvent::WallpaperFeed(generation, Box::new(Err(error))));
                    }
                }
                if received {
                    backoff = Duration::from_secs(1);
                }
                if !sleep_interruptible(backoff, &stop) {
                    break;
                }
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        })
        .ok();
}

fn poll_wallpaper_feed(
    feed: &mut WallpaperFeed,
    proxy: &EventLoopProxy<UserEvent>,
    generation: u64,
    stop: &AtomicBool,
) {
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let result = feed.poll();
        let failed = result.is_err();
        if proxy
            .send_event(UserEvent::WallpaperFeed(generation, Box::new(result)))
            .is_err()
        {
            break;
        }
        if !sleep_interruptible(if failed { POLL_ERROR } else { POLL_IDLE }, stop) {
            break;
        }
    }
}

fn sleep_interruptible(duration: Duration, stop: &AtomicBool) -> bool {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(100));
        std::thread::sleep(remaining);
    }
    !stop.load(Ordering::Relaxed)
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
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>Hertz 桌面歌词</title>\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<style>{}</style></head><body class=\"unlocked\">{}</body>\
<script>{}</script></html>",
        include_str!("../assets/desktop-lyrics.css"),
        include_str!("../assets/desktop-lyrics.html"),
        include_str!("../assets/desktop-lyrics.js")
    )
}

/// 托盘与窗口共用的一枚图标：蓝色圆盘上写白色 H；几何值按 32 px 设计稿等比缩放。
fn hertz_icon_pixels(size: u32) -> Vec<u8> {
    let scale = f64::from(size) / 32.0;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        for x in 0..size {
            let index = ((y * size + x) * 4) as usize;
            let px = f64::from(x) / scale;
            let py = f64::from(y) / scale;
            let dx = px - 16.0;
            let dy = py - 16.0;
            let in_disc = dx * dx + dy * dy <= 15.0 * 15.0;
            let in_h = (9.0..13.0).contains(&px) && (9.0..23.0).contains(&py)
                || (19.0..23.0).contains(&px) && (9.0..23.0).contains(&py)
                || (12.0..20.0).contains(&px) && (14.0..18.0).contains(&py);
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
    rgba
}

fn tray_icon_image() -> Result<Icon> {
    Ok(Icon::from_rgba(hertz_icon_pixels(32), 32, 32)?)
}

/// 任务栏/切换器按 150% 显示 48 px，用 64 px 源图缩放更干净。
fn window_icon() -> Result<tao::window::Icon> {
    tao::window::Icon::from_rgba(hertz_icon_pixels(64), 64, 64)
        .map_err(|error| anyhow::anyhow!("生成窗口图标失败：{error}"))
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
    settings: bool,
    preview: bool,
}

impl Args {
    fn parse() -> Result<Self> {
        let mut data_dir = None;
        let mut locate = false;
        let mut wallpaper_feed_test = false;
        let mut wallpaper = false;
        let mut settings = false;
        let mut preview = false;
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
                "--settings" => settings = true,
                "--preview" => preview = true,
                "--help" | "-h" => {
                    println!(
                        "hertz-desktop [--data-dir <path>] [--locate] [--wallpaper] [--settings] [--preview] [--wallpaper-feed-test]"
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
            settings,
            preview,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(dir: &str) -> Profile {
        Profile {
            data_dir: PathBuf::from(dir),
            edition: "full".into(),
        }
    }

    fn monitor() -> native::WallpaperMonitor {
        native::WallpaperMonitor {
            name: r"\\.\DISPLAY1".into(),
            left: 0,
            top: 0,
            width: 2560,
            height: 1600,
            dpi: 144,
            primary: true,
        }
    }

    #[test]
    fn position_edit_boundary_uses_monitor_dpi_and_snaps_inside_work_area() {
        let area = native::WorkArea {
            name: "left".into(),
            left: -1920,
            top: 0,
            right: 0,
            bottom: 1080,
            dpi: 144,
            primary: false,
        };
        assert_eq!(
            bounded_lyrics_position(-5000, -100, 900, 200, &area),
            (-1896, 24)
        );
        assert_eq!(
            bounded_lyrics_position(1000, 2000, 900, 200, &area),
            (-924, 856)
        );
        assert_eq!(
            bounded_lyrics_position(-1400, 300, 900, 200, &area),
            (-1400, 300)
        );
        assert_eq!(
            bounded_lyrics_position(-1880, 40, 900, 200, &area),
            (-1896, 24)
        );
    }

    #[test]
    fn all_wallpaper_scenes_have_a_bundled_static_reference() {
        for (id, _) in config::WALLPAPER_SCENES {
            let image = scene_thumbnail(&format!("{id}.jpg")).expect("scene thumbnail");
            assert!(image.starts_with(&[0xff, 0xd8, 0xff]));
            assert!(image.len() > 1000);
        }
        assert!(scene_thumbnail("../config.json").is_none());
    }

    #[test]
    fn heartbeat_parses_render_progress() {
        assert_eq!(
            parse_wallpaper_heartbeat("wallpaper_heartbeat 42 30 1 0"),
            Some((42, 30, true, false))
        );
        assert_eq!(
            parse_wallpaper_heartbeat("wallpaper_heartbeat 42 30 0 0"),
            Some((42, 30, false, false))
        );
        assert_eq!(
            parse_wallpaper_heartbeat("wallpaper_heartbeat 42 30 1 1"),
            Some((42, 30, true, true))
        );
        assert_eq!(parse_wallpaper_heartbeat("wallpaper_dom_ready"), None);
        assert_eq!(
            parse_wallpaper_heartbeat("wallpaper_heartbeat x 30 1 0"),
            None
        );
    }

    #[test]
    fn measured_fps_uses_draw_deltas() {
        assert_eq!(fps_from_draws(60, Duration::from_secs(2)), Some(30.0));
        assert_eq!(fps_from_draws(0, Duration::from_secs(2)), None);
        assert_eq!(fps_from_draws(10, Duration::from_millis(500)), None);
    }

    fn running_policy() -> Policy {
        Policy {
            locked: false,
            user_hidden: false,
            fullscreen: false,
            session_unavailable: false,
            display_off: false,
            no_content: false,
        }
    }

    #[test]
    fn pause_reasons_report_each_gate() {
        let running = running_policy();
        assert!(wallpaper_pause_reasons(true, false, false, true, true, &running).is_empty());
        assert_eq!(
            wallpaper_pause_reasons(false, false, false, false, false, &running),
            vec!["disabled"]
        );
        assert_eq!(
            wallpaper_pause_reasons(true, true, false, true, true, &running),
            vec!["hidden"]
        );
        assert_eq!(
            wallpaper_pause_reasons(true, false, true, false, false, &running),
            vec!["monitorMissing", "noSurface"]
        );
        assert_eq!(
            wallpaper_pause_reasons(true, false, false, false, false, &running),
            vec!["noSurface"]
        );
        assert_eq!(
            wallpaper_pause_reasons(true, false, false, true, false, &running),
            vec!["pageNotReady"]
        );
        let mut paused = running_policy();
        paused.fullscreen = true;
        paused.session_unavailable = true;
        paused.display_off = true;
        assert_eq!(
            wallpaper_pause_reasons(true, false, false, true, true, &paused),
            vec!["fullscreen", "sessionUnavailable", "displayOff"]
        );
    }

    #[test]
    fn monitor_geometry_changes_trigger_reflow() {
        let base = monitor();
        assert!(!monitor_geometry_changed(&base, &base.clone()));
        let mut resized = base.clone();
        resized.width = 1920;
        resized.height = 1080;
        assert!(monitor_geometry_changed(&base, &resized));
        let mut moved = base.clone();
        moved.left = -1920;
        assert!(monitor_geometry_changed(&base, &moved));
        let mut dpi = base.clone();
        dpi.dpi = 96;
        assert!(monitor_geometry_changed(&base, &dpi));
    }

    #[test]
    fn profile_options_include_saved_and_candidate_sources() {
        let current = profile(r"C:\profiles\a");
        let saved = profile(r"C:\profiles\b");
        let candidate = Profile {
            data_dir: PathBuf::from(r"C:\profiles\c"),
            edition: "standard".into(),
        };
        let mut config = config::Config::default();
        config.activate_profile(saved).unwrap();
        let options = profile_options(&current, &config, Some(&candidate));
        let dirs: Vec<String> = options
            .iter()
            .map(|option| option["dataDir"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(dirs[0], r"C:\profiles\a");
        assert!(dirs.contains(&r"C:\profiles\b".to_string()));
        assert!(dirs.contains(&r"C:\profiles\c".to_string()));
        let deduped = profile_options(&current, &config, Some(&current));
        assert_eq!(
            deduped
                .iter()
                .filter(|option| option["dataDir"] == r"C:\profiles\a")
                .count(),
            1
        );
    }

    #[test]
    fn inlined_pages_stay_inside_the_navigate_to_string_limit() {
        // 只有这两个页面还整页走 NavigateToString（WebView2 上限约 2 MB，壁纸页已改走自定义协议）；
        // 谁把 MB 级资源内联进来就会在这里失败，而不是让 surface 静默挂不上。
        for (name, page) in [("lyrics", page_html()), ("settings", settings_html())] {
            assert!(
                page.len() < 256 * 1024,
                "{name} 页面 {} 字节，逼近 NavigateToString 上限",
                page.len()
            );
        }
    }

    #[test]
    fn lyric_layout_commands_accept_explicit_values_and_keep_toggle_fallback() {
        assert_eq!(
            layout_choice(Some("single"), Layout::Double),
            Some(Layout::Single)
        );
        assert_eq!(
            layout_choice(Some("double"), Layout::Single),
            Some(Layout::Double)
        );
        assert_eq!(layout_choice(None, Layout::Double), Some(Layout::Single));
        assert_eq!(layout_choice(None, Layout::Single), Some(Layout::Double));
        assert_eq!(layout_choice(Some("triple"), Layout::Double), None);
    }

    #[test]
    fn lyric_secondary_commands_accept_explicit_values_and_keep_toggle_fallback() {
        assert_eq!(
            secondary_choice(Some("translation"), Secondary::Next),
            Some(Secondary::Translation)
        );
        assert_eq!(
            secondary_choice(Some("romanization"), Secondary::Translation),
            Some(Secondary::Romanization)
        );
        assert_eq!(
            secondary_choice(None, Secondary::Next),
            Some(Secondary::Translation)
        );
        assert_eq!(
            secondary_choice(None, Secondary::Romanization),
            Some(Secondary::Next)
        );
        assert_eq!(secondary_choice(Some("unknown"), Secondary::Next), None);
    }
}
