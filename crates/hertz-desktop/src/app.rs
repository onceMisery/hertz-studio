// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 桌面歌词宿主：窗口、托盘、来源线程与可见性策略。

use std::path::PathBuf;
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
use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE};
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

static LOG_SEQ: AtomicU64 = AtomicU64::new(0);

pub(crate) enum UserEvent {
    Feed(u64, Box<Result<crate::feed::FeedUpdate, String>>),
    WallpaperFeed(u64, Box<Result<WallpaperSnapshot, FeedError>>),
    WallpaperPage(u64, String),
    SettingsPage(String),
    PreviewPage(String),
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
}

impl WallpaperSurface {
    fn hwnd(&self) -> HWND {
        self.window.hwnd() as HWND
    }

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
    webview: wry::WebView,
}

impl SettingsSurface {
    fn eval(&self, script: &str) {
        if let Err(error) = self.webview.evaluate_script(script) {
            log(&format!("settings evaluate_script failed: {error}"));
        }
    }
}

struct PreviewSurface {
    window: Window,
    webview: wry::WebView,
    fps: u8,
    music_response: bool,
    ready: bool,
    lease_until: Instant,
}

impl PreviewSurface {
    fn eval(&self, script: &str) {
        if let Err(error) = self.webview.evaluate_script(script) {
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
    preview: Option<PreviewSurface>,
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
                if let Some(preview) = self.preview.as_ref() {
                    if preview.ready {
                        if preview.music_response {
                            preview.apply_feed(&snapshot);
                        } else {
                            preview.clear_feed();
                        }
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
            },
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
            self.send_settings_status(None, None);
            return;
        }
        match create_settings(target, self.proxy.clone()) {
            Ok(settings) => {
                log("wallpaper settings opened");
                self.settings = Some(settings);
                self.send_settings_status(None, None);
            }
            Err(error) => {
                log(&format!("wallpaper settings failed: {error:#}"));
                native::dialog_error(&format!("无法打开壁纸设置：{error}"));
            }
        }
    }

    fn close_settings(&mut self) {
        self.close_preview();
        self.settings = None;
        self.settings_candidate = None;
    }

    fn close_preview(&mut self) {
        if self.preview.take().is_some() {
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
            preview.lease_until = Instant::now() + PREVIEW_LEASE;
            preview.start();
            let ready = preview.ready;
            if ready {
                if preview.music_response {
                    if let Some(snapshot) = self.wallpaper_last.as_ref() {
                        preview.apply_feed(snapshot);
                    }
                } else {
                    preview.clear_feed();
                }
            }
            return Ok(());
        }
        match create_preview(
            target,
            self.proxy.clone(),
            candidate.fps,
            candidate.music_response,
        ) {
            Ok(preview) => {
                log("wallpaper preview opened");
                self.preview = Some(preview);
                Ok(())
            }
            Err(error) => {
                log(&format!("wallpaper preview failed: {error:#}"));
                Err(format!("预览失败：{error}"))
            }
        }
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
    }

    fn switch_source(
        &mut self,
        profile: Profile,
        expected_revision: u64,
        target: &EventLoopWindowTarget<UserEvent>,
    ) -> Result<(), String> {
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
    ) -> Result<(), String> {
        if let Err(error) = validate_candidate(candidate) {
            return Err(error.to_string());
        }
        if expected_revision != self.config.revision {
            return Err("设置已变化，请重新打开设置后重试".into());
        }
        let previous = self.config.clone();
        self.config.wallpaper.enabled = candidate.enabled;
        self.config.wallpaper.fps = candidate.fps;
        self.config.wallpaper.music_response = candidate.music_response;
        self.config.wallpaper.monitor = candidate.monitor.clone();
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
                if self.wallpaper_page_ready {
                    if candidate.music_response {
                        if let Some(snapshot) = self.wallpaper_last.as_ref() {
                            surface.apply_feed(snapshot);
                        }
                    } else {
                        surface.clear_feed();
                    }
                }
            }
        } else {
            self.drop_wallpaper_surface();
        }
        self.close_preview();
        self.recompute_wallpaper();
        self.rebuild_tray();
        Ok(())
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
        }
        let Ok(command) = serde_json::from_str::<Command>(body) else {
            self.send_settings_status(Some("设置请求格式无效"), None);
            return;
        };
        match command.cmd.as_str() {
            "ready" | "status" => self.send_settings_status(None, None),
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
                match self.apply_wallpaper_settings(&candidate, expected_revision, target) {
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
        if event == "wallpaper_mount_failed" {
            log("wallpaper preview page mount failed");
            self.close_preview();
            return;
        }
        let Some(preview) = self.preview.as_mut() else {
            return;
        };
        match event {
            "wallpaper_dom_ready" | "wallpaper_ready" => {
                preview.ready = true;
                preview.start();
                if preview.music_response {
                    if let Some(snapshot) = self.wallpaper_last.as_ref() {
                        preview.apply_feed(snapshot);
                    }
                } else {
                    preview.clear_feed();
                }
            }
            other => log(&format!("unknown preview page event: {other}")),
        }
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

    fn handle_menu(&mut self, id: &str, target: &EventLoopWindowTarget<UserEvent>) {
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
        match command {
            "status" | "wallpaper-status" => {}
            "wallpaper-settings" => {
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
                if let Err(error) =
                    self.apply_wallpaper_settings(&apply.config, apply.expected_revision, target)
                {
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
                "revision": self.config.revision,
                "fps": self.config.wallpaper.fps,
                "musicResponse": self.config.wallpaper.music_response,
                "monitor": self.config.wallpaper.monitor,
                "settingsOpen": self.settings.is_some(),
                "previewActive": self.preview.is_some(),
                "monitorMissing": self.wallpaper_monitor_missing,
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
        if self.settings.is_some() {
            if let Some(preview) = self.preview.as_mut() {
                preview.lease_until = now + PREVIEW_LEASE;
            }
        }
        if self
            .preview
            .as_ref()
            .is_some_and(|preview| now >= preview.lease_until)
        {
            self.close_preview();
        }
        if now.duration_since(self.last_check) >= Duration::from_secs(1) {
            self.last_check = now;
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
        let wallpaper_enabled =
            self.wallpaper.is_some() || self.config.wallpaper.enabled || self.wallpaper_forced;
        let wallpaper_toggle = self
            .wallpaper
            .as_ref()
            .map(|_| CheckMenuItem::new("显示壁纸", true, !self.wallpaper_hidden, None));
        let wallpaper_retry = wallpaper_enabled.then(|| MenuItem::new("重新挂载壁纸", true, None));
        let settings = MenuItem::new("壁纸设置", true, None);
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
        preview: None,
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
            Event::UserEvent(UserEvent::PreviewPage(body)) => app.handle_preview_page(&body),
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
                    app.close_settings();
                } else if app
                    .preview
                    .as_ref()
                    .is_some_and(|preview| preview.window.id() == window_id)
                    && matches!(&event, WindowEvent::CloseRequested)
                {
                    app.close_preview();
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
        .with_url("about:blank")
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
    webview
        .load_html(&wallpaper_html())
        .map_err(|error| anyhow::anyhow!("加载壁纸页面失败：{error}"))?;
    log(&format!(
        "wallpaper target name={} rect={},{} {}x{} dpi={} window_dpi={window_dpi} zoom={zoom:.3} child={child_rect:?} parent={parent_rect:?}",
        monitor.name, monitor.left, monitor.top, monitor.width, monitor.height, monitor.dpi
    ));
    Ok(WallpaperSurface {
        window,
        webview,
        monitor,
        zoom,
    })
}

fn create_settings(
    target: &EventLoopWindowTarget<UserEvent>,
    proxy: EventLoopProxy<UserEvent>,
) -> Result<SettingsSurface> {
    let window = WindowBuilder::new()
        .with_title("Hertz 壁纸设置")
        .with_inner_size(PhysicalSize::new(520, 520))
        .with_resizable(false)
        .with_visible(true)
        .build(target)?;
    let page_proxy = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_html(settings_html())
        .with_background_color((11, 17, 26, 255))
        .with_ipc_handler(move |request| {
            let body = request.body();
            if body.len() <= 8192 {
                let _ = page_proxy.send_event(UserEvent::SettingsPage(body.clone()));
            }
        })
        .build(&window)
        .map_err(|error| anyhow::anyhow!("创建设置 WebView 失败：{error}"))?;
    Ok(SettingsSurface { window, webview })
}

fn create_preview(
    target: &EventLoopWindowTarget<UserEvent>,
    proxy: EventLoopProxy<UserEvent>,
    fps: u8,
    music_response: bool,
) -> Result<PreviewSurface> {
    let window = WindowBuilder::new()
        .with_title("Hertz 壁纸预览")
        .with_inner_size(PhysicalSize::new(960, 540))
        .with_resizable(true)
        .with_visible(true)
        .build(target)?;
    let page_proxy = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_html(wallpaper_html())
        .with_background_color((3, 4, 5, 255))
        .with_ipc_handler(move |request| {
            let body = request.body();
            if body.starts_with("wallpaper") {
                let _ = page_proxy.send_event(UserEvent::PreviewPage(body.clone()));
            }
        })
        .build(&window)
        .map_err(|error| anyhow::anyhow!("创建预览 WebView 失败：{error}"))?;
    Ok(PreviewSurface {
        window,
        webview,
        fps,
        music_response,
        ready: false,
        lease_until: Instant::now() + PREVIEW_LEASE,
    })
}

fn settings_html() -> String {
    include_str!("../assets/wallpaper-settings.html").replace(
        "__SETTINGS__",
        include_str!("../assets/wallpaper-settings.js"),
    )
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
}
